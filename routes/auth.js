'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { logAction } = require('../db/audit');
const { requireAdminAuth } = require('../middleware/auth');

const router = express.Router();

// Aggressive limiter on login specifically — this is the highest-value
// brute-force target in the whole system.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);

  // Constant-shape response whether the user exists or not, to avoid
  // username enumeration via timing/response differences.
  const dummyHash = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5.aE.C.j3q.QoTGwB.f5v3q3q3q3q3q';
  const hashToCheck = admin ? admin.password_hash : dummyHash;
  const valid = bcrypt.compareSync(password, hashToCheck);

  if (!admin || !valid) {
    logAction(req, 'login_failed', { username });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { sub: admin.id, username: admin.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  db.prepare('UPDATE admins SET last_login = datetime(\'now\') WHERE id = ?').run(admin.id);
  logAction(req, 'login_success', { username });

  res.json({ token, expiresIn: process.env.JWT_EXPIRES_IN || '8h', admin: { id: admin.id, username: admin.username } });
});

// Stateless JWTs aren't server-side revocable without a blacklist table;
// logout here is a client-side token discard. The endpoint exists so the
// panel has a consistent place to call and audit-log the event.
router.post('/logout', requireAdminAuth, (req, res) => {
  logAction(req, 'logout', { username: req.admin.username });
  res.json({ ok: true });
});

router.post('/change-password', requireAdminAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ error: 'newPassword must be at least 10 characters' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(newHash, admin.id);
  logAction(req, 'password_changed', { username: admin.username });

  res.json({ ok: true });
});

router.get('/me', requireAdminAuth, (req, res) => {
  res.json({ admin: req.admin });
});

module.exports = router;
