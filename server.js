const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// ফাইল আপলোডের জন্য Multer কনফিগারেশন
const upload = multer({ dest: 'uploads/' });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// সক্রিয় হোয়াটসঅ্যাপ সেশন জমা রাখার অবজেক্ট
const activeSessions = {};

// সেশন ডিরেক্টরি নিশ্চিতকরণ
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ==================== আইসোলেটেড সেশন ইনিশিয়ালাইজার ====================
async function initSession(phone) {
  if (activeSessions[phone]) return activeSessions[phone];

  // প্রতিটি অ্যাকাউন্টের জন্য একদম আলাদা আইসোলেটেড ডিরেক্টরি
  const sessionDir = path.join(SESSIONS_DIR, `acc_${phone}`);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // ব্রাউজার ফিঙ্গারপ্রিন্ট আইসোলেশন (হোয়াটসঅ্যাপ এটিকে আলাদা অ্যান্ড্রয়েড ডিভাইস হিসেব করবে)
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu Admin Engine', 'Chrome', `App-ID-${phone.slice(-4)}`],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(`[Isolated Session Connected] WhatsApp Account: +${phone}`);
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
        io.emit('session-updated', { phone, status: 'disconnected' });
      } else {
        // রিকানেকশন ট্রাই (অটোমেটিক রিজুম)
        console.log(`[Reconnecting] Account: +${phone}`);
        setTimeout(() => initSession(phone), 3000);
      }
    }
  });

  // ইনকামিং মেসেজ লিসেনার
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type === 'notify') {
      const msg = messages[0];
      io.emit('new-message', {
        senderPhone: phone,
        fromJid: msg.key.remoteJid,
        messageKey: msg.key,
        fromMe: msg.key.fromMe,
        text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Media Message',
        timestamp: msg.messageTimestamp
      });
    }
  });

  activeSessions[phone] = sock;
  return sock;
}

// সার্ভার স্টার্ট বা রিস্টার্ট হলে আগে থেকে সেভ থাকা সেশনগুলো আইসোলেটেড ভাবে অটো লোড হবে
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

// ==================== API ENDPOINTS ====================

// ১. পেয়ারিং কোড জেনারেট করার এপিআই
app.post('/api/request-pairing', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  try {
    const sock = await initSession(phone);

    // কোড রিকোয়েস্ট করার জন্য সামান্য ডিলে
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        res.json({ code });
      } catch (err) {
        res.status(500).json({ error: 'Failed to request pairing code' });
      }
    }, 3000);

  } catch (error) {
    res.status(500).json({ error: 'Server initialization error' });
  }
});

// ২. কানেক্টেড একাউন্টগুলোর তালিকা পাওয়ার এপিআই
app.get('/api/admin/numbers', (req, res) => {
  res.json({ numbers: Object.keys(activeSessions) });
});

// ৩. টেক্সট মেসেজ পাঠানোর এপিআই
app.post('/api/admin/send-message', async (req, res) => {
  const { senderPhone, recipientJid, text } = req.body;
  const sock = activeSessions[senderPhone];

  if (!sock) return res.status(400).json({ error: 'Sender session is inactive' });

  try {
    const formattedJid = recipientJid.includes('@s.whatsapp.net') ? recipientJid : `${recipientJid}@s.whatsapp.net`;
    const sentMsg = await sock.sendMessage(formattedJid, { text });
    res.json({ success: true, key: sentMsg.key });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ৪. মিডিয়া ফাইল (ছবি, ডকুমেন্ট, অডিও) পাঠানোর এপিআই
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
    
    // টেম্পোরারি ফাইল রিমুভ
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    res.json({ success: true, key: sentMsg.key });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send media file' });
  }
});

// ৫. মেসেজ এডিট করার এপিআই
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

// ৬. মেসেজ ডিলিট করার এপিআই
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
