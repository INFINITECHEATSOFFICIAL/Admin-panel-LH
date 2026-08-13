'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const activeToday = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE last_active >= datetime('now', '-1 day')`)
    .get().n;
  const totalCourses = db.prepare('SELECT COUNT(*) AS n FROM courses WHERE active = 1').get().n;
  const premiumUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_premium = 1').get().n;
  const blockedUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_blocked = 1').get().n;

  const config = db.prepare('SELECT app_status FROM config WHERE id = 1').get();

  const recentLogs = db
    .prepare('SELECT action, details, timestamp FROM admin_logs ORDER BY timestamp DESC LIMIT 15')
    .all();

  res.json({
    data: {
      totalUsers,
      activeToday,
      totalCourses,
      premiumUsers,
      blockedUsers,
      appStatus: config.app_status,
      recentActivity: recentLogs,
    },
  });
});

// GET /api/admin/stats/growth?days=30
router.get('/growth', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
  const rows = db
    .prepare(
      `SELECT date(registered_at) AS day, COUNT(*) AS count
       FROM users
       WHERE registered_at >= datetime('now', ?)
       GROUP BY day ORDER BY day ASC`
    )
    .all(`-${days} days`);
  res.json({ data: rows });
});

router.get('/courses', (req, res) => {
  // "Views" aren't tracked without an event pipeline; this reports what
  // the DB can actually answer today — enrollment counts derived from
  // per-user JSON, and lesson counts per course.
  const users = db.prepare('SELECT enrolled_courses FROM users').all();
  const enrollCounts = {};
  for (const u of users) {
    try {
      const list = JSON.parse(u.enrolled_courses || '[]');
      for (const title of list) enrollCounts[title] = (enrollCounts[title] || 0) + 1;
    } catch (_) { /* skip malformed rows */ }
  }

  const courses = db.prepare('SELECT id, title, premium FROM courses').all();
  const lessonCounts = db
    .prepare('SELECT course_id, COUNT(*) AS n FROM lessons GROUP BY course_id')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.course_id]: r.n }), {});

  const data = courses
    .map((c) => ({
      id: c.id,
      title: c.title,
      premium: !!c.premium,
      lessonCount: lessonCounts[c.id] || 0,
      enrollments: enrollCounts[c.title] || 0,
    }))
    .sort((a, b) => b.enrollments - a.enrollments);

  res.json({ data });
});

router.get('/premium', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const premiumUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_premium = 1').get().n;
  const conversionRate = totalUsers > 0 ? +((premiumUsers / totalUsers) * 100).toFixed(2) : 0;

  res.json({ data: { totalUsers, premiumUsers, conversionRate } });
});

module.exports = router;
