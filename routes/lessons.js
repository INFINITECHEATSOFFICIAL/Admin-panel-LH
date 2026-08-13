'use strict';

const express = require('express');
const db = require('../db');
const { logAction } = require('../db/audit');

const router = express.Router();

function validateLessonPayload(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.course_id !== undefined) {
    const cid = Number(body.course_id);
    if (!Number.isInteger(cid)) errors.push('course_id is required and must be an integer');
    else {
      const course = db.prepare('SELECT id FROM courses WHERE id = ?').get(cid);
      if (!course) errors.push(`course_id ${cid} does not reference an existing course`);
      else out.course_id = cid;
    }
  }
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      errors.push('title is required and must be a non-empty string');
    } else out.title = body.title.trim();
  }
  if (body.video_url !== undefined) out.video_url = String(body.video_url).slice(0, 2000);
  if (body.thumb_url !== undefined) out.thumb_url = String(body.thumb_url).slice(0, 2000);
  if (body.file_url !== undefined) out.file_url = String(body.file_url).slice(0, 2000);
  if (body.duration !== undefined) out.duration = String(body.duration).slice(0, 20);
  if (body.status !== undefined) {
    if (!['published', 'draft'].includes(body.status)) errors.push('status must be "published" or "draft"');
    else out.status = body.status;
  }
  if (body.order_index !== undefined) {
    const n = Number(body.order_index);
    if (!Number.isInteger(n)) errors.push('order_index must be an integer');
    else out.order_index = n;
  }

  return { errors, data: out };
}

router.get('/course/:courseId', (req, res) => {
  const lessons = db
    .prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY order_index ASC, id ASC')
    .all(req.params.courseId);
  res.json({ data: lessons });
});

router.post('/', (req, res) => {
  const { errors, data } = validateLessonPayload(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM lessons WHERE course_id = ?')
    .get(data.course_id).m;

  const stmt = db.prepare(`
    INSERT INTO lessons (course_id, title, video_url, thumb_url, file_url, duration, status, order_index)
    VALUES (@course_id, @title, @video_url, @thumb_url, @file_url, @duration, @status, @order_index)
  `);
  const info = stmt.run({
    course_id: data.course_id,
    title: data.title,
    video_url: data.video_url ?? '',
    thumb_url: data.thumb_url ?? '',
    file_url: data.file_url ?? '',
    duration: data.duration ?? '',
    status: data.status ?? 'published',
    order_index: data.order_index ?? maxOrder + 1,
  });

  const created = db.prepare('SELECT * FROM lessons WHERE id = ?').get(info.lastInsertRowid);
  logAction(req, 'lesson_created', { id: created.id, course_id: created.course_id, title: created.title });
  res.status(201).json({ data: created });
});

// POST /api/admin/lessons/batch  { course_id, lessons: [{title, video_url, ...}, ...] }
router.post('/batch', (req, res) => {
  const { course_id, lessons } = req.body || {};
  const cid = Number(course_id);
  if (!Number.isInteger(cid) || !db.prepare('SELECT id FROM courses WHERE id = ?').get(cid)) {
    return res.status(400).json({ error: 'A valid course_id is required' });
  }
  if (!Array.isArray(lessons) || lessons.length === 0) {
    return res.status(400).json({ error: 'lessons must be a non-empty array' });
  }
  if (lessons.length > 200) {
    return res.status(400).json({ error: 'Batch limited to 200 lessons per request' });
  }

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM lessons WHERE course_id = ?')
    .get(cid).m;

  const insert = db.prepare(`
    INSERT INTO lessons (course_id, title, video_url, thumb_url, file_url, duration, status, order_index)
    VALUES (@course_id, @title, @video_url, @thumb_url, @file_url, @duration, 'published', @order_index)
  `);

  const created = [];
  const tx = db.transaction((items) => {
    items.forEach((item, idx) => {
      if (!item.title || typeof item.title !== 'string') {
        throw new Error(`lessons[${idx}].title is required`);
      }
      const info = insert.run({
        course_id: cid,
        title: item.title.trim(),
        video_url: item.video_url || '',
        thumb_url: item.thumb_url || '',
        file_url: item.file_url || '',
        duration: item.duration || '',
        order_index: maxOrder + 1 + idx,
      });
      created.push(info.lastInsertRowid);
    });
  });

  try {
    tx(lessons);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  logAction(req, 'lessons_batch_created', { course_id: cid, count: created.length });
  res.status(201).json({ data: { insertedIds: created } });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Lesson not found' });

  const { errors, data } = validateLessonPayload(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ errors });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const fields = Object.keys(data);
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE lessons SET ${setClause} WHERE id = @id`).run({ ...data, id: existing.id });

  const updated = db.prepare('SELECT * FROM lessons WHERE id = ?').get(existing.id);
  logAction(req, 'lesson_updated', { id: updated.id, fields });
  res.json({ data: updated });
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Lesson not found' });

  db.prepare('DELETE FROM lessons WHERE id = ?').run(existing.id);
  logAction(req, 'lesson_deleted', { id: existing.id, title: existing.title });
  res.json({ ok: true });
});

router.put('/reorder/batch', (req, res) => {
  const { order } = req.body || {}; // [id1, id2, ...]
  if (!Array.isArray(order) || order.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'order must be an array of lesson IDs' });
  }
  const update = db.prepare('UPDATE lessons SET order_index = ? WHERE id = ?');
  const tx = db.transaction((ids) => ids.forEach((id, idx) => update.run(idx, id)));
  tx(order);

  logAction(req, 'lessons_reordered', { order });
  res.json({ ok: true });
});

module.exports = router;
