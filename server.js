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

// Security & State Stores
const activeAdminTokens = new Set();
const notifiedSessions = new Set();
let isInitialLoadComplete = false;

// Initialize Firebase Admin SDK cleanly
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: DATABASE_URL
  });
}

const db = admin.database();
console.log("[FIREBASE] Admin initialized");

// Verify Telegram Configuration on Startup
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  console.log("[TELEGRAM] Configuration detected");
} else {
  console.warn("[TELEGRAM] Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in environment variables.");
}

// Telegram Notification Helper with Safe Error Logging
async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
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
      console.error("[TELEGRAM] Notification failed:", result.description || "Unknown API error");
    } else {
      console.log("[TELEGRAM] Notification sent successfully");
    }
  } catch (err) {
    console.error("[TELEGRAM] Notification failed:", err.message);
  }
}

// ==========================================
// 24×7 SERVER-SIDE FIREBASE SESSION MONITOR
// ==========================================
function startServerSideFirebaseMonitor() {
  const sessionsRef = db.ref('sessions');

  // Load existing historical sessions once so they don't trigger duplicate alerts on server restart/deploy
  sessionsRef.once('value', (snapshot) => {
    const existingSessions = snapshot.val() || {};
    Object.keys(existingSessions).forEach(sessionId => {
      notifiedSessions.add(sessionId);
    });
    isInitialLoadComplete = true;
    console.log("[FIREBASE] Realtime session monitor started");
  }, (error) => {
    console.error("[FIREBASE] Initial snapshot error:", error.message);
    isInitialLoadComplete = true; // Proceed even if snapshot fails to ensure monitor attaches
  });

  // Listen for NEW sessions added in real-time independently of any browser/admin panel
  sessionsRef.on('child_added', async (snapshot) => {
    const sessionId = snapshot.key;
    const sessionData = snapshot.val() || {};

    if (!isInitialLoadComplete || notifiedSessions.has(sessionId)) {
      return;
    }

    // Mark as notified immediately to prevent duplicate triggers
    notifiedSessions.add(sessionId);
    console.log(`[FIREBASE] New session detected: ${sessionId}`);

    // Extract non-sensitive metadata only
    const userIdentifier = sessionData.username || sessionData.userId || 'N/A';
    const stage = sessionData.stage || 'N/A';
    const status = sessionData.status || 'pending';
    const time = sessionData.createdAt || sessionData.time || new Date().toISOString();

    const telegramMessage = 
      `🔔 <b>NEW REQUEST</b>\n\n` +
      `<b>Session ID:</b> <code>${sessionId}</code>\n` +
      `<b>User:</b> ${userIdentifier}\n` +
      `<b>Stage:</b> ${stage}\n` +
      `<b>Status:</b> ${status}\n` +
      `<b>Time:</b> ${time}`;

    await sendTelegramNotification(telegramMessage);
  }, (error) => {
    console.error("[FIREBASE] Listener error:", error.message);
  });
}

// Start monitor immediately
startServerSideFirebaseMonitor();


// ==========================================
// API ROUTES
// ==========================================

// Middleware for Admin Token Authentication
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token && activeAdminTokens.has(token)) {
    return next();
  }
  return res.status(401).json({ success: false, error: "Unauthorized access. Please log in." });
}

// Provide Firebase Config to Admin Panel
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

// Admin Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(sessionToken);
    return res.json({ success: true, token: sessionToken });
  }
  return res.status(401).json({ success: false, message: "Invalid Admin Credentials" });
});

// Admin Logout
app.post('/api/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    activeAdminTokens.delete(token);
  }
  res.json({ success: true });
});

// Approve / Reject Session Status Update Endpoint
app.post('/api/session/update-status', requireAuth, async (req, res) => {
  const { sessionId, status } = req.body;
  
  if (!sessionId || !['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: "Invalid parameters or status value." });
  }

  try {
    const resolvedAt = new Date().toISOString();
    await db.ref(`sessions/${sessionId}`).update({
      status: status,
      resolvedAt: resolvedAt
    });

    console.log(`[STATUS] Session ${sessionId} updated to ${status}`);
    return res.json({ success: true, sessionId, status, resolvedAt });
  } catch (err) {
    console.error(`[STATUS] Update failed for ${sessionId}:`, err.message);
    return res.status(500).json({ success: false, error: "Database update failed." });
  }
});

// Fallback to Admin Panel Frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`[SERVER] Server started on port ${PORT}`);
});
