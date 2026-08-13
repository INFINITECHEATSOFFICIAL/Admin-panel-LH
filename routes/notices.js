'use strict';

const express = require('express');
const db = require('../db');
const { logAction } = require('../db/audit');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM notices ORDER BY created_at DESC').all();
  res.json({ data: rows.map((r) => ({ ...r, is_active: !!r.is_active })) });
});

router.post('/', (req, res) => {
  const { title, message, target = 'all', is_active = true, expires_at = null } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
  if (!['all', 'premium', 'free'].includes(target)) {
    return res.status(400).json({ error: 'target must be one of all, premium, free' });
  }

  const info = db
    .prepare('INSERT INTO notices (title, message, target, is_active, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(title.slice(0, 200), message.slice(0, 2000), target, is_active ? 1 : 0, expires_at);

  logAction(req, 'notice_created', { id: info.lastInsertRowid, title });
  const created = db.prepare('SELECT * FROM notices WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ data: created });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Notice not found' });

  const fields = {};
  const { title, message, target, is_active, expires_at } = req.body || {};
  if (title !== undefined) fields.title = String(title).slice(0, 200);
  if (message !== undefined) fields.message = String(message).slice(0, 2000);
  if (target !== undefined) {
    if (!['all', 'premium', 'free'].includes(target)) return res.status(400).json({ error: 'Invalid target' });
    fields.target = target;
  }
  if (is_active !== undefined) fields.is_active = is_active ? 1 : 0;
  if (expires_at !== undefined) fields.expires_at = expires_at;

  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(fields).map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE notices SET ${setClause} WHERE id = @id`).run({ ...fields, id: existing.id });

  logAction(req, 'notice_updated', { id: existing.id });
  res.json({ data: db.prepare('SELECT * FROM notices WHERE id = ?').get(existing.id) });
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Notice not found' });

  db.prepare('DELETE FROM notices WHERE id = ?').run(existing.id);
  logAction(req, 'notice_deleted', { id: existing.id });
  res.json({ ok: true });
});

module.exports = router;
