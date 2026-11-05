const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@gold-go.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://bnitinweb-default-rtdb.firebaseio.com";

const activeAdminTokens = new Set();
const notifiedSessions = new Set();
let isInitialLoadComplete = false;

// Initialize Firebase Admin cleanly without requiring secret file
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: DATABASE_URL
  });
}

const db = admin.database();
console.log("Firebase Admin initialized successfully.");

async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error("Telegram Error:", err.message);
  }
}

// 24x7 Realtime Firebase Monitor
function startServerSideFirebaseMonitor() {
  const sessionsRef = db.ref('sessions');

  sessionsRef.once('value', (snapshot) => {
    const existingSessions = snapshot.val() || {};
    Object.keys(existingSessions).forEach(id => notifiedSessions.add(id));
    isInitialLoadComplete = true;
    console.log(`Realtime session monitor started. Ignored ${notifiedSessions.size} historical sessions.`);
  });

  sessionsRef.on('child_added', async (snapshot) => {
    const sessionId = snapshot.key;
    const sessionData = snapshot.val() || {};

    if (!isInitialLoadComplete || notifiedSessions.has(sessionId)) return;
    notifiedSessions.add(sessionId);

    const user = sessionData.username || sessionData.userId || 'N/A';
    const stage = sessionData.stage || 'N/A';
    const status = sessionData.status || 'pending';
    const time = sessionData.createdAt || sessionData.time || new Date().toISOString();

    const msg = `🔔 <b>NEW GOLD-GO REQUEST</b>\n\n<b>Session ID:</b> <code>${sessionId}</code>\n<b>User:</b> ${user}\n<b>Stage:</b> ${stage}\n<b>Status:</b> ${status}\n<b>Time:</b> ${time}`;
    await sendTelegramNotification(msg);
  });
}

startServerSideFirebaseMonitor();

// API Routes
app.get('/api/config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBKEZvvUvpxCOy0dFqE0I2ytbfTf6puZ8o",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "bnitinweb.firebaseapp.com",
    databaseURL: DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID || "bnitinweb",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "bnitinweb.firebasestorage.app",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "8638948411",
    appId: process.env.FIREBASE_APP_ID || "1:8638948411:web:d75802ef8a049b1b1ae81e"
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, message: "Invalid Admin Credentials" });
});

app.post('/api/logout', (req, res) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (token) activeAdminTokens.delete(token);
  res.json({ success: true });
});

app.post('/api/session/update-status', async (req, res) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token || !activeAdminTokens.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { sessionId, status } = req.body;
  if (!sessionId || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "Invalid parameters" });
  }

  try {
    const resolvedAt = new Date().toISOString();
    await db.ref(`sessions/${sessionId}`).update({ status, resolvedAt });
    res.json({ success: true, sessionId, status, resolvedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GOLD-GO Admin Server running on port ${PORT}`);
});
