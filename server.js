const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeSessions = {};
const sessionStores = {};

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

async function initSession(phone) {
  if (activeSessions[phone]) return activeSessions[phone];

  const sessionDir = path.join(SESSIONS_DIR, `acc_${phone}`);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  if (!sessionStores[phone]) {
    sessionStores[phone] = { chats: {}, messages: {} };
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: true,
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(`[Connected] WhatsApp Account: +${phone}`);
      activeSessions[phone] = sock;
      io.emit('session-updated', { phone, status: 'connected' });
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      delete activeSessions[phone];

      if (!shouldReconnect) {
        console.log(`[Logged Out] Removing session for: +${phone}`);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        delete sessionStores[phone];
        io.emit('session-updated', { phone, status: 'disconnected' });
      } else {
        console.log(`[Reconnecting] Account: +${phone}`);
        setTimeout(() => initSession(phone), 3000);
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ chats, messages }) => {
    chats.forEach(chat => {
      sessionStores[phone].chats[chat.id] = chat;
    });
    messages.forEach(msg => {
      const jid = msg.key.remoteJid;
      if (!sessionStores[phone].messages[jid]) {
        sessionStores[phone].messages[jid] = [];
      }
      sessionStores[phone].messages[jid].push(msg);
    });
    io.emit('history-synced', { phone });
  });

  sock.ev.on('chats.upsert', (chats) => {
    chats.forEach(chat => {
      sessionStores[phone].chats[chat.id] = { ...sessionStores[phone].chats[chat.id], ...chat };
    });
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    const msg = messages[0];
    if (!msg) return;

    const jid = msg.key.remoteJid;
    if (!sessionStores[phone].messages[jid]) {
      sessionStores[phone].messages[jid] = [];
    }
    sessionStores[phone].messages[jid].push(msg);

    if (type === 'notify') {
      io.emit('new-message', {
        senderPhone: phone,
        fromJid: jid,
        messageKey: msg.key,
        fromMe: msg.key.fromMe,
        text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Media Message',
        timestamp: msg.messageTimestamp
      });
    }
  });

  return sock;
}

function autoLoadExistingSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const folders = fs.readdirSync(SESSIONS_DIR);

  folders.forEach(folder => {
    if (folder.startsWith('acc_')) {
      const phone = folder.replace('acc_', '');
      console.log(`[Restoring Session] Loading +${phone}...`);
      initSession(phone).catch(err => console.error(`Error loading session +${phone}:`, err));
    }
  });
}

app.post('/api/request-pairing', async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  phone = phone.replace(/[^0-9]/g, '');

  try {
    const sessionDir = path.join(SESSIONS_DIR, `acc_${phone}`);
    
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: true,
      markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log(`[Connected] WhatsApp Account: +${phone}`);
        activeSessions[phone] = sock;
        io.emit('session-updated', { phone, status: 'connected' });
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        delete activeSessions[phone];

        if (!shouldReconnect) {
          if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }
          delete sessionStores[phone];
          io.emit('session-updated', { phone, status: 'disconnected' });
        } else {
          setTimeout(() => initSession(phone), 3000);
        }
      }
    });

    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          res.json({ code });
        } catch (err) {
          console.error(err);
          res.status(500).json({ error: 'Pairing code generation failed' });
        }
      }, 2000);
    } else {
      res.json({ message: 'Already registered' });
    }

  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/numbers', (req, res) => {
  res.json({ numbers: Object.keys(activeSessions) });
});

app.get('/api/admin/chats/:phone', (req, res) => {
  const phone = req.params.phone;
  const store = sessionStores[phone];
  if (!store) return res.json({ chats: [] });

  const chatList = Object.keys(store.chats).map(jid => ({
    jid,
    name: store.chats[jid].name || store.chats[jid].id.split('@')[0]
  }));

  res.json({ chats: chatList });
});

app.get('/api/admin/messages/:phone/:jid', (req, res) => {
  const { phone, jid } = req.params;
  const store = sessionStores[phone];
  if (!store || !store.messages[jid]) return res.json({ messages: [] });

  const msgs = store.messages[jid].map(m => ({
    text: m.message?.conversation || m.message?.extendedTextMessage?.text || 'Media Message',
    fromMe: m.key.fromMe,
    timestamp: m.messageTimestamp
  }));

  res.json({ messages: msgs });
});

app.post('/api/admin/send-message', async (req, res) => {
  const { senderPhone, recipientJid, text } = req.body;
  const sock = activeSessions[senderPhone];

  if (!sock) return res.status(400).json({ error: 'Sender session is inactive' });

  try {
    const formattedJid = recipientJid.includes('@s.whatsapp.net') ? recipientJid : `${recipientJid}@s.whatsapp.net`;
    const sentMsg = await sock.sendMessage(formattedJid, { text });
    
    if (!sessionStores[senderPhone]) sessionStores[senderPhone] = { chats: {}, messages: {} };
    if (!sessionStores[senderPhone].messages[formattedJid]) sessionStores[senderPhone].messages[formattedJid] = [];
    sessionStores[senderPhone].messages[formattedJid].push(sentMsg);

    res.json({ success: true, key: sentMsg.key });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/admin/send-media', upload.single('file'), async (req, res) => {
  const { senderPhone, recipientJid, fileType, caption } = req.body;
  const file = req.file;
  const sock = activeSessions[senderPhone];

  if (!sock || !file) return res.status(400).json({ error: 'Session or file is missing' });

  try {
    const formattedJid = recipientJid.includes('@s.whatsapp.net') ? recipientJid : `${recipientJid}@s.whatsapp.net`;
    const fileBuffer = fs.readFileSync(file.path);
    let messageContent = {};

    if (fileType === 'image') {
      messageContent = { image: fileBuffer, caption: caption || '' };
    } else if (fileType === 'document') {
      messageContent = { document: fileBuffer, mimetype: file.mimetype, fileName: file.originalname };
    } else if (fileType === 'audio') {
      messageContent = { audio: fileBuffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' };
    }

    const sentMsg = await sock.sendMessage(formattedJid, messageContent);
    
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    res.json({ success: true, key: sentMsg.key });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send media file' });
  }
});

app.post('/api/admin/edit-message', async (req, res) => {
  const { senderPhone, recipientJid, key, newText } = req.body;
  const sock = activeSessions[senderPhone];

  if (!sock) return res.status(400).json({ error: 'Session inactive' });

  try {
    const formattedJid = recipientJid.includes('@s.whatsapp.net') ? recipientJid : `${recipientJid}@s.whatsapp.net`;
    await sock.sendMessage(formattedJid, { text: newText, edit: key });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.post('/api/admin/delete-message', async (req, res) => {
  const { senderPhone, recipientJid, key } = req.body;
  const sock = activeSessions[senderPhone];

  if (!sock) return res.status(400).json({ error: 'Session inactive' });

  try {
    const formattedJid = recipientJid.includes('@s.whatsapp.net') ? recipientJid : `${recipientJid}@s.whatsapp.net`;
    await sock.sendMessage(formattedJid, { delete: key });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server Running] http://localhost:${PORT}`);
  autoLoadExistingSessions();
});
