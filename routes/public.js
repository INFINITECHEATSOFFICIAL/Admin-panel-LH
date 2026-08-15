'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();

const perDeviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60, // generous — this covers polling + normal navigation
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-api-key'] + ':' + (req.body?.device_id || req.query?.device_id || req.ip),
});
router.use(perDeviceLimiter);

function touchLastActive(deviceId) {
  db.prepare(`UPDATE users SET last_active = datetime('now') WHERE device_id = ?`).run(deviceId);
}

// GET /api/public/config — single round-trip: kill-switch, notice, version gate.
// Mirrors what the AndLua client's fetchRemoteConfig() expects, minus any
// covert per-device tracking payload.
router.get('/config', (req, res) => {
  const cfg = db.prepare('SELECT * FROM config WHERE id = 1').get();
  res.json({
    app_status: cfg.app_status,
    app_message: cfg.app_message,
    current_version: cfg.current_version,
    force_update: !!cfg.force_update,
    notice: cfg.notice_enabled ? cfg.notice : '',
    notice_enabled: !!cfg.notice_enabled,
  });
});

// GET /api/public/notices?device_id=... — active notices filtered for the
// calling device's current entitlement. This does not expose admin-only data.
router.get('/notices', (req, res) => {
  const deviceId = typeof req.query.device_id === 'string' ? req.query.device_id.slice(0, 256) : '';
  const today = new Date().toISOString().slice(0, 10);
  const user = deviceId ? db.prepare('SELECT is_premium FROM users WHERE device_id = ?').get(deviceId) : null;
  const premiumGrant = deviceId
    ? db.prepare(
      `SELECT 1 FROM premium_users
       WHERE device_id = ? AND (expiry_date IS NULL OR expiry_date = '' OR expiry_date >= ?)
       LIMIT 1`
    ).get(deviceId, today)
    : null;
  const audience = user?.is_premium || premiumGrant ? 'premium' : 'free';

  if (user && deviceId) touchLastActive(deviceId);

  const rows = db.prepare(
    `SELECT id, title, message, target, created_at, expires_at
     FROM notices
     WHERE is_active = 1
       AND (expires_at IS NULL OR expires_at = '' OR expires_at > datetime('now'))
       AND (target = 'all' OR target = ?)
     ORDER BY datetime(created_at) DESC, id DESC`
  ).all(audience);

  res.json({ data: rows, audience });
});

// GET /api/public/courses — active courses with their published lessons.
router.get('/courses', (req, res) => {
  const courses = db.prepare('SELECT * FROM courses WHERE active = 1 ORDER BY order_index ASC').all();
  const lessonStmt = db.prepare(
    `SELECT title, video_url AS video, thumb_url AS thumb, file_url AS file, duration, folder_id,
       (SELECT title FROM folders WHERE folders.id = lessons.folder_id) AS folder_title
     FROM lessons WHERE course_id = ? AND status = 'published' ORDER BY order_index ASC`
  );
  const folderStmt = db.prepare(`
    SELECT f.id, f.title, f.description, f.order_index,
      (SELECT json_group_array(json_object('title', l.title, 'video', l.video_url, 'thumb', l.thumb_url, 'file', l.file_url, 'duration', l.duration))
       FROM lessons l WHERE l.folder_id = f.id AND l.status = 'published' ORDER BY l.order_index ASC) AS lessons_json
    FROM folders f WHERE f.course_id = ? AND f.active = 1 ORDER BY f.order_index ASC, f.id ASC
  `);

  const data = courses.map((c) => {
    const folders = folderStmt.all(c.id).map((folder) => ({ ...folder, lessons: JSON.parse(folder.lessons_json || '[]') }));
    return {
    title: c.title,
    icon: c.icon,
    level: c.level,
    color: c.color,
    desc: c.description,
    premium: !!c.premium,
    lessons: lessonStmt.all(c.id),
    folders,
  }; });

  res.json({ courses: data });
});

// GET /api/public/premium/check/:deviceId
router.get('/premium/check/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const today = new Date().toISOString().slice(0, 10);

  const record = db
    .prepare(
      `SELECT * FROM premium_users
       WHERE device_id = ? AND (expiry_date IS NULL OR expiry_date = '' OR expiry_date >= ?)
       ORDER BY (expiry_date IS NULL) DESC, expiry_date DESC LIMIT 1`
    )
    .get(deviceId, today);

  res.json({ is_premium: !!record, expiry_date: record ? record.expiry_date || null : null });
});

// POST /api/public/users/register  { device_id, device_name, android_version, app_version }
router.post('/users/register', (req, res) => {
  const { device_id, device_name, android_version, app_version } = req.body || {};
  if (!device_id || typeof device_id !== 'string') {
    return res.status(400).json({ error: 'device_id is required' });
  }

  const existing = db.prepare('SELECT * FROM users WHERE device_id = ?').get(device_id);
  if (existing) {
    if (existing.is_blocked) return res.status(403).json({ error: 'This device is blocked' });
    db.prepare(
      `UPDATE users SET device_name = COALESCE(?, device_name), android_version = COALESCE(?, android_version),
       app_version = COALESCE(?, app_version), last_active = datetime('now') WHERE device_id = ?`
    ).run(device_name || null, android_version || null, app_version || null, device_id);
    return res.json({ ok: true, data: { registered: false, is_premium: !!existing.is_premium } });
  }

  db.prepare(
    `INSERT INTO users (device_id, device_name, android_version, app_version) VALUES (?, ?, ?, ?)`
  ).run(device_id, device_name || null, android_version || null, app_version || null);

  res.status(201).json({ ok: true, data: { registered: true, is_premium: false } });
});

// POST /api/public/users/progress  { device_id, course_title, lesson_index }
router.post('/users/progress', (req, res) => {
  const { device_id, course_title, lesson_index } = req.body || {};
  if (!device_id || !course_title || !Number.isInteger(lesson_index)) {
    return res.status(400).json({ error: 'device_id, course_title, and lesson_index (integer) are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE device_id = ?').get(device_id);
  if (!user) return res.status(404).json({ error: 'Unknown device_id — call /users/register first' });
  if (user.is_blocked) return res.status(403).json({ error: 'This device is blocked' });

  let progress = {};
  let enrolled = [];
  try { progress = JSON.parse(user.progress || '{}'); } catch (_) { /* reset on corrupt data */ }
  try { enrolled = JSON.parse(user.enrolled_courses || '[]'); } catch (_) { /* reset on corrupt data */ }

  const current = progress[course_title] || 0;
  progress[course_title] = Math.max(current, lesson_index);
  if (!enrolled.includes(course_title)) enrolled.push(course_title);

  db.prepare(
    `UPDATE users SET progress = ?, enrolled_courses = ?, last_active = datetime('now') WHERE device_id = ?`
  ).run(JSON.stringify(progress), JSON.stringify(enrolled), device_id);

  res.json({ ok: true });
});

module.exports = router;
