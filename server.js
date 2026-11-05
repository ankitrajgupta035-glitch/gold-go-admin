const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Environment Variables from Render
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@gold-go.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://bnitinweb-default-rtdb.firebaseio.com";

// In-memory token store for secure authentication
const activeAdminTokens = new Set();

// Track sessions notified during this server lifecycle or loaded at startup to prevent duplicates
const notifiedSessions = new Set();
let isInitialLoadComplete = false;

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  // If FIREBASE_SERVICE_ACCOUNT JSON is provided as a Render env variable, use it. Otherwise, initialize with databaseURL.
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: DATABASE_URL
      });
    } catch (e) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", e.message);
      admin.initializeApp({ databaseURL: DATABASE_URL });
    }
  } else {
    admin.initializeApp({ databaseURL: DATABASE_URL });
  }
}

const db = admin.database();

console.log("Firebase Admin initialized successfully.");

// Telegram Notification Helper
async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram credentials (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) not configured. Skipping notification.");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
    const result = await response.json();
    if (!result.ok) {
      console.error("Telegram API Error:", result.description);
    } else {
      console.log("Telegram notification sent successfully.");
    }
  } catch (err) {
    console.error("Telegram Network Error:", err.message);
  }
}

// ==========================================
// 24x7 SERVER-SIDE FIREBASE SESSION MONITOR
// ==========================================
function startServerSideFirebaseMonitor() {
  const sessionsRef = db.ref('sessions');

  // First, snapshot existing sessions so we don't spam notifications for old sessions upon server restart/deploy
  sessionsRef.once('value', (snapshot) => {
    const existingSessions = snapshot.val() || {};
    Object.keys(existingSessions).forEach(sessionId => {
      notifiedSessions.add(sessionId);
    });
    isInitialLoadComplete = true;
    console.log(`Realtime session monitor started. Ignored ${notifiedSessions.size} existing historical sessions.`);
  }, (error) => {
    console.error("Firebase initial snapshot error:", error.message);
  });

  // Listen for NEW sessions added in real-time
  sessionsRef.on('child_added', async (snapshot) => {
    const sessionId = snapshot.key;
    const sessionData = snapshot.val() || {};

    // If initial load hasn't finished or session was already notified, skip
    if (!isInitialLoadComplete || notifiedSessions.has(sessionId)) {
      return;
    }

    // Mark as notified immediately to prevent race conditions / duplicate triggers
    notifiedSessions.add(sessionId);
    console.log(`New session detected: ${sessionId}`);

    // Extract safe non-sensitive metadata
    const userIdentifier = sessionData.username || sessionData.userId || 'N/A';
    const stage = sessionData.stage || 'N/A';
    const status = sessionData.status || 'pending';
    const time = sessionData.createdAt || sessionData.time || new Date().toISOString();

    // Format Telegram Message
    const telegramMessage = 
      `🔔 <b>NEW GOLD-GO REQUEST</b>\n\n` +
      `<b>Session ID:</b> <code>${sessionId}</code>\n` +
      `<b>User:</b> ${userIdentifier}\n` +
      `<b>Stage:</b> ${stage}\n` +
      `<b>Status:</b> ${status}\n` +
      `<b>Time:</b> ${time}`;

    await sendTelegramNotification(telegramMessage);
  }, (error) => {
    console.error("Firebase listener error:", error.message);
  });
}

// Start the 24x7 monitor
startServerSideFirebaseMonitor();


// ==========================================
// API ROUTES
// ==========================================

// Middleware for Admin Authentication verification
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token && activeAdminTokens.has(token)) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized access. Please log in." });
}

// 1. Provide Client Firebase Config securely (excluding private secrets)
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

// 2. Admin Login Endpoint
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(sessionToken);
    return res.json({ success: true, token: sessionToken });
  }
  return res.status(401).json({ success: false, message: "Invalid Admin Credentials" });
});

// 3. Logout Endpoint
postLogout = app.post('/api/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    activeAdminTokens.delete(token);
  }
  res.json({ success: true });
});

// 4. Status Update Endpoint (Approve / Reject)
app.post('/api/session/update-status', requireAuth, async (req, res) => {
  const { sessionId, status } = req.body;
  if (!sessionId || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "Invalid parameters or status value." });
  }

  try {
    const resolvedAt = new Date().toISOString();
    await db.ref(`sessions/${sessionId}`).update({
      status: status,
      resolvedAt: resolvedAt
    });

    console.log(`Session ${sessionId} updated to ${status} by admin.`);
    res.json({ success: true, sessionId, status, resolvedAt });
  } catch (err) {
    console.error("Database update error:", err.message);
    res.status(500).json({ error: "Failed to update session status." });
  }
});

// Fallback to Admin Panel Frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`GOLD-GO Admin Server running on port ${PORT}`);
});
