'use strict';

const express = require('express');
const db = require('../db');
const { logAction } = require('../db/audit');

const router = express.Router();

const DURATION_DAYS = { '3d': 3, '7d': 7, '15d': 15, '30d': 30 };

function computeExpiry(duration) {
  if (duration === 'lifetime') return null;
  const days = DURATION_DAYS[duration];
  if (!days) return undefined; // signals invalid input
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function upsertUserPremiumFlag(deviceId, isPremium) {
  db.prepare('UPDATE users SET is_premium = ? WHERE device_id = ?').run(isPremium ? 1 : 0, deviceId);
}

router.get('/', (req, res) => {
  const { search = '', page = '1', pageSize = '25', sort = 'expiry_asc' } = req.query;

  const clauses = [];
  const params = {};
  if (search) {
    clauses.push('device_id LIKE @search');
    params.search = `%${search}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const orderMap = {
    expiry_asc: `CASE WHEN expiry_date IS NULL OR expiry_date = '' THEN 1 ELSE 0 END, expiry_date ASC`,
    expiry_desc: `CASE WHEN expiry_date IS NULL OR expiry_date = '' THEN 1 ELSE 0 END, expiry_date DESC`,
    granted_desc: 'granted_at DESC',
  };
  const orderBy = orderMap[sort] || orderMap.expiry_asc;

  const size = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pageNum - 1) * size;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM premium_users ${where}`).get(params).n;
  const rows = db
    .prepare(`SELECT * FROM premium_users ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  const today = new Date().toISOString().slice(0, 10);
  const data = rows.map((r) => ({
    ...r,
    is_expired: !!(r.expiry_date && r.expiry_date < today),
    is_lifetime: !r.expiry_date,
  }));

  res.json({ data, pagination: { page: pageNum, pageSize: size, total, totalPages: Math.ceil(total / size) } });
});

router.get('/stats', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const total = db.prepare('SELECT COUNT(*) AS n FROM premium_users').get().n;
  const active = db
    .prepare(`SELECT COUNT(*) AS n FROM premium_users WHERE expiry_date IS NULL OR expiry_date = '' OR expiry_date >= ?`)
    .get(today).n;
  const expiringSoon = db
    .prepare(`SELECT COUNT(*) AS n FROM premium_users WHERE expiry_date BETWEEN ? AND date(?, '+7 days')`)
    .get(today, today).n;
  res.json({ data: { total, active, expired: total - active, expiringSoon } });
});

// POST /api/admin/premium  { device_id, duration: '3d'|'7d'|'15d'|'30d'|'lifetime', notes }
router.post('/', (req, res) => {
  const { device_id, duration, notes } = req.body || {};
  if (!device_id || typeof device_id !== 'string') {
    return res.status(400).json({ error: 'device_id is required' });
  }
  const expiry = computeExpiry(duration);
  if (expiry === undefined) {
    return res.status(400).json({ error: 'duration must be one of 3d, 7d, 15d, 30d, lifetime' });
  }

  const user = db.prepare('SELECT id FROM users WHERE device_id = ?').get(device_id);

  const info = db
    .prepare(`INSERT INTO premium_users (user_id, device_id, expiry_date, granted_by, notes)
              VALUES (?, ?, ?, ?, ?)`)
    .run(user ? user.id : null, device_id, expiry, req.admin.username, notes || null);

  upsertUserPremiumFlag(device_id, true);
  logAction(req, 'premium_granted', { device_id, duration, expiry });

  const created = db.prepare('SELECT * FROM premium_users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ data: created });
});

// POST /api/admin/premium/bulk  { device_ids: [...], duration, notes }
router.post('/bulk', (req, res) => {
  const { device_ids, duration, notes } = req.body || {};
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    return res.status(400).json({ error: 'device_ids must be a non-empty array' });
  }
  if (device_ids.length > 500) {
    return res.status(400).json({ error: 'Bulk grant limited to 500 devices per request' });
  }
  const expiry = computeExpiry(duration);
  if (expiry === undefined) {
    return res.status(400).json({ error: 'duration must be one of 3d, 7d, 15d, 30d, lifetime' });
  }

  const insert = db.prepare(`INSERT INTO premium_users (user_id, device_id, expiry_date, granted_by, notes)
                              VALUES ((SELECT id FROM users WHERE device_id = ?), ?, ?, ?, ?)`);
  const flag = db.prepare('UPDATE users SET is_premium = 1 WHERE device_id = ?');

  const tx = db.transaction((ids) => {
    ids.forEach((deviceId) => {
      insert.run(deviceId, deviceId, expiry, req.admin.username, notes || null);
      flag.run(deviceId);
    });
  });
  tx(device_ids);

  logAction(req, 'premium_bulk_granted', { count: device_ids.length, duration, expiry });
  res.status(201).json({ data: { granted: device_ids.length } });
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM premium_users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Premium record not found' });

  db.prepare('DELETE FROM premium_users WHERE id = ?').run(existing.id);

  const stillHasOther = db
    .prepare(`SELECT COUNT(*) AS n FROM premium_users WHERE device_id = ? AND (expiry_date IS NULL OR expiry_date >= date('now'))`)
    .get(existing.device_id).n;
  if (stillHasOther === 0) upsertUserPremiumFlag(existing.device_id, false);

  logAction(req, 'premium_revoked', { device_id: existing.device_id });
  res.json({ ok: true });
});

router.get('/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM premium_users ORDER BY granted_at DESC').all();
  const header = 'id,device_id,expiry_date,granted_at,granted_by,notes\n';
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => [r.id, r.device_id, r.expiry_date, r.granted_at, r.granted_by, r.notes].map(esc).join(',')).join('\n');

  logAction(req, 'premium_exported', { count: rows.length });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="premium_users.csv"');
  res.send(header + body);
});

module.exports = router;
