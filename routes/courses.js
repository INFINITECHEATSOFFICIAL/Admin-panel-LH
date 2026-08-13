'use strict';

const express = require('express');
const db = require('../db');
const { logAction } = require('../db/audit');

const router = express.Router();

function serializeCourse(row) {
  return {
    ...row,
    premium: !!row.premium,
    active: !!row.active,
  };
}

function validateCoursePayload(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      errors.push('title is required and must be a non-empty string');
    } else if (body.title.length > 200) {
      errors.push('title must be 200 characters or fewer');
    } else {
      out.title = body.title.trim();
    }
  }
  if (body.icon !== undefined) out.icon = String(body.icon).slice(0, 16);
  if (body.level !== undefined) out.level = String(body.level).slice(0, 40);
  if (body.color !== undefined) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(body.color) && !/^0x[0-9A-Fa-f]{8}$/.test(body.color)) {
      errors.push('color must be a hex color like #6C63FF');
    } else {
      out.color = body.color;
    }
  }
  if (body.description !== undefined) out.description = String(body.description).slice(0, 5000);
  if (body.premium !== undefined) out.premium = body.premium ? 1 : 0;
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  if (body.thumbnail_url !== undefined) out.thumbnail_url = String(body.thumbnail_url).slice(0, 1000);
  if (body.order_index !== undefined) {
    const n = Number(body.order_index);
    if (!Number.isInteger(n)) errors.push('order_index must be an integer');
    else out.order_index = n;
  }

  return { errors, data: out };
}

// GET /api/admin/courses?search=&level=&premium=&active=&page=&pageSize=
router.get('/', (req, res) => {
  const { search = '', level, premium, active, page = '1', pageSize = '25' } = req.query;

  const clauses = [];
  const params = {};

  if (search) {
    clauses.push('(title LIKE @search OR description LIKE @search)');
    params.search = `%${search}%`;
  }
  if (level) {
    clauses.push('level = @level');
    params.level = level;
  }
  if (premium !== undefined) {
    clauses.push('premium = @premium');
    params.premium = premium === 'true' || premium === '1' ? 1 : 0;
  }
  if (active !== undefined) {
    clauses.push('active = @active');
    params.active = active === 'true' || active === '1' ? 1 : 0;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pageNum - 1) * size;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM courses ${where}`).get(params).n;
  const rows = db
    .prepare(`SELECT * FROM courses ${where} ORDER BY order_index ASC, id ASC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: size, offset });

  res.json({
    data: rows.map(serializeCourse),
    pagination: { page: pageNum, pageSize: size, total, totalPages: Math.ceil(total / size) },
  });
});

router.get('/:id', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const lessons = db
    .prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY order_index ASC, id ASC')
    .all(course.id);
  res.json({ data: { ...serializeCourse(course), lessons } });
});

router.post('/', (req, res) => {
  const { errors, data } = validateCoursePayload(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM courses').get().m;
  const stmt = db.prepare(`
    INSERT INTO courses (title, icon, level, color, description, premium, active, thumbnail_url, order_index)
    VALUES (@title, @icon, @level, @color, @description, @premium, @active, @thumbnail_url, @order_index)
  `);
  const info = stmt.run({
    title: data.title,
    icon: data.icon ?? '📘',
    level: data.level ?? 'Beginner',
    color: data.color ?? '#6C63FF',
    description: data.description ?? '',
    premium: data.premium ?? 0,
    active: data.active ?? 1,
    thumbnail_url: data.thumbnail_url ?? null,
    order_index: data.order_index ?? maxOrder + 1,
  });

  const created = db.prepare('SELECT * FROM courses WHERE id = ?').get(info.lastInsertRowid);
  logAction(req, 'course_created', { id: created.id, title: created.title });
  res.status(201).json({ data: serializeCourse(created) });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Course not found' });

  const { errors, data } = validateCoursePayload(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ errors });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const fields = Object.keys(data);
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE courses SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...data, id: existing.id });

  const updated = db.prepare('SELECT * FROM courses WHERE id = ?').get(existing.id);
  logAction(req, 'course_updated', { id: updated.id, fields });
  res.json({ data: serializeCourse(updated) });
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Course not found' });

  db.prepare('DELETE FROM courses WHERE id = ?').run(existing.id); // ON DELETE CASCADE removes lessons
  logAction(req, 'course_deleted', { id: existing.id, title: existing.title });
  res.json({ ok: true });
});

// PUT /api/admin/courses/reorder  { order: [id1, id2, id3, ...] }
router.put('/reorder/batch', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || order.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'order must be an array of course IDs' });
  }

  const update = db.prepare('UPDATE courses SET order_index = ? WHERE id = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => update.run(idx, id));
  });
  tx(order);

  logAction(req, 'courses_reordered', { order });
  res.json({ ok: true });
});

module.exports = router;
