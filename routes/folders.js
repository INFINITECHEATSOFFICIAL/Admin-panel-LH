'use strict';

const express = require('express');
const db = require('../db');
const { logAction } = require('../db/audit');

const router = express.Router();

function serializeFolder(row) {
  return { ...row, active: !!row.active };
}

function folderPayload(body, { partial = false } = {}) {
  const errors = [];
  const data = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) errors.push('title is required and must be a non-empty string');
    else data.title = body.title.trim().slice(0, 200);
  }
  if (body.description !== undefined) data.description = String(body.description).slice(0, 5000);
  if (body.active !== undefined) data.active = body.active ? 1 : 0;
  if (body.order_index !== undefined) {
    const order = Number(body.order_index);
    if (!Number.isInteger(order)) errors.push('order_index must be an integer');
    else data.order_index = order;
  }
  return { errors, data };
}

router.get('/course/:courseId', (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, COUNT(l.id) AS video_count
    FROM folders f LEFT JOIN lessons l ON l.folder_id = f.id
    WHERE f.course_id = ? GROUP BY f.id ORDER BY f.order_index ASC, f.id ASC
  `).all(req.params.courseId);
  res.json({ data: rows.map(serializeFolder) });
});

router.get('/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const videos = db.prepare('SELECT * FROM lessons WHERE folder_id = ? ORDER BY order_index ASC, id ASC').all(folder.id);
  res.json({ data: { ...serializeFolder(folder), lessons: videos } });
});

router.post('/', (req, res) => {
  const courseId = Number(req.body?.course_id);
  if (!Number.isInteger(courseId) || !db.prepare('SELECT id FROM courses WHERE id = ?').get(courseId)) {
    return res.status(400).json({ error: 'A valid course_id is required' });
  }
  const { errors, data } = folderPayload(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM folders WHERE course_id = ?').get(courseId).m;
  const info = db.prepare(`
    INSERT INTO folders (course_id, title, description, order_index, active)
    VALUES (@course_id, @title, @description, @order_index, @active)
  `).run({ course_id: courseId, title: data.title, description: data.description || '', order_index: data.order_index ?? maxOrder + 1, active: data.active ?? 1 });
  const created = db.prepare('SELECT * FROM folders WHERE id = ?').get(info.lastInsertRowid);
  logAction(req, 'folder_created', { id: created.id, course_id: courseId, title: created.title });
  res.status(201).json({ data: serializeFolder(created) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Folder not found' });
  const { errors, data } = folderPayload(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ errors });
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields to update' });
  const fields = Object.keys(data);
  db.prepare(`UPDATE folders SET ${fields.map((field) => `${field} = @${field}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...data, id: existing.id });
  const updated = db.prepare('SELECT * FROM folders WHERE id = ?').get(existing.id);
  logAction(req, 'folder_updated', { id: updated.id, fields });
  res.json({ data: serializeFolder(updated) });
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Folder not found' });
  db.prepare('UPDATE lessons SET folder_id = NULL WHERE folder_id = ?').run(existing.id);
  db.prepare('DELETE FROM folders WHERE id = ?').run(existing.id);
  logAction(req, 'folder_deleted', { id: existing.id, title: existing.title });
  res.json({ ok: true });
});

module.exports = router;
