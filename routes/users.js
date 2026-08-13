'use strict';

const express = require('express');
const db = require('../db');
const { logAction } = require('../db/audit');

const router = express.Router();

function serializeUser(row) {
  return {
    ...row,
    is_premium: !!row.is_premium,
    is_blocked: !!row.is_blocked,
    enrolled_courses: safeParse(row.enrolled_courses, []),
    progress: safeParse(row.progress, {}),
  };
}

function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch (_) {
    return fallback;
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/admin/users?search=&status=premium|free|active|inactive|blocked&page=&pageSize=
router.get('/', (req, res) => {
  const { search = '', status, page = '1', pageSize = '25' } = req.query;

  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(device_id LIKE @search OR device_name LIKE @search)');
    params.search = `%${search}%`;
  }
  if (status === 'premium') clauses.push('is_premium = 1');
  if (status === 'free') clauses.push('is_premium = 0');
  if (status === 'blocked') clauses.push('is_blocked = 1');
  if (status === 'active') clauses.push(`last_active >= datetime('now', '-7 days')`);
  if (status === 'inactive') clauses.push(`last_active < datetime('now', '-7 days')`);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pageNum - 1) * size;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(params).n;
  const rows = db
    .prepare(`SELECT * FROM users ${where} ORDER BY last_active DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({
    data: rows.map(serializeUser),
    pagination: { page: pageNum, pageSize: size, total, totalPages: Math.ceil(total / size) },
  });
});

router.get('/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY registered_at DESC').all();
  const header = 'id,device_id,device_name,android_version,app_version,registered_at,last_active,is_premium,is_blocked\n';
  const body = rows
    .map((r) =>
      [r.id, r.device_id, r.device_name, r.android_version, r.app_version, r.registered_at, r.last_active, r.is_premium, r.is_blocked]
        .map(csvEscape)
        .join(',')
    )
    .join('\n');

  logAction(req, 'users_exported', { count: rows.length });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send(header + body);
});

router.get('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ data: serializeUser(user) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const { device_name } = req.body || {};
  if (device_name !== undefined) {
    db.prepare('UPDATE users SET device_name = ? WHERE id = ?').run(String(device_name).slice(0, 200), existing.id);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  logAction(req, 'user_updated', { id: updated.id });
  res.json({ data: serializeUser(updated) });
});

router.post('/:id/block', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET is_blocked = 1 WHERE id = ?').run(existing.id);
  logAction(req, 'user_blocked', { id: existing.id, device_id: existing.device_id });
  res.json({ ok: true });
});

router.post('/:id/unblock', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET is_blocked = 0 WHERE id = ?').run(existing.id);
  logAction(req, 'user_unblocked', { id: existing.id, device_id: existing.device_id });
  res.json({ ok: true });
});

module.exports = router;
