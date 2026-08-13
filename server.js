'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// Fail fast on missing critical secrets rather than booting insecurely.
const REQUIRED_ENV = ['JWT_SECRET', 'PUBLIC_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key] || process.env[key].startsWith('replace_with_')) {
    // eslint-disable-next-line no-console
    console.error(`❌ Missing/placeholder required env var: ${key}. Set it in .env before starting.`);
    process.exit(1);
  }
}

require('./db'); // initializes schema + bootstrap admin as a side effect

const { requireAdminAuth, requireApiKey } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const courseRoutes = require('./routes/courses');
const lessonRoutes = require('./routes/lessons');
const userRoutes = require('./routes/users');
const premiumRoutes = require('./routes/premium');
const noticeRoutes = require('./routes/notices');
const configRoutes = require('./routes/config');
const statsRoutes = require('./routes/stats');
const publicRoutes = require('./routes/public');

const app = express();

app.set('trust proxy', 1); // needed for correct IPs / rate limiting behind a reverse proxy

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Same-origin panel requests and non-browser clients (no Origin header,
    // e.g. the Android app) are always allowed; the API-key check on
    // /api/public/* is the real gate for those.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Global API rate limit — generous ceiling, tightened per-route where it matters
// (see routes/auth.js login limiter and routes/public.js per-device limiter).
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Static admin panel ─────────────────────────────────────────────────────
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// ── API routes ──────────────────────────────────────────────────────────────
app.use('/api/admin/auth', authRoutes);
app.use('/api/admin/courses', requireAdminAuth, courseRoutes);
app.use('/api/admin/lessons', requireAdminAuth, lessonRoutes);
app.use('/api/admin/users', requireAdminAuth, userRoutes);
app.use('/api/admin/premium', requireAdminAuth, premiumRoutes);
app.use('/api/admin/notices', requireAdminAuth, noticeRoutes);
app.use('/api/admin/config', requireAdminAuth, configRoutes);
app.use('/api/admin/stats', requireAdminAuth, statsRoutes);

app.use('/api/public', requireApiKey, publicRoutes);

app.get('/', (req, res) => res.redirect('/admin'));
app.get('/health', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Centralized error handler — never leak stack traces to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`🚀 Learning Hub Admin running on port ${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`   Panel:  http://localhost:${PORT}/admin`);
  // eslint-disable-next-line no-console
  console.log(`   Health: http://localhost:${PORT}/health`);
});

module.exports = app;
