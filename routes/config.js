'use strict';

const express = require('express');
const db = require('../db');
const { logAction } = require('../db/audit');

const router = express.Router();

function serializeConfig(row) {
  return {
    ...row,
    force_update: !!row.force_update,
    notice_enabled: !!row.notice_enabled,
    analytics_enabled: !!row.analytics_enabled,
  };
}

router.get('/', (req, res) => {
  const row = db.prepare('SELECT * FROM config WHERE id = 1').get();
  res.json({ data: serializeConfig(row) });
});

router.put('/', (req, res) => {
  const allowed = ['app_message', 'current_version', 'force_update', 'notice', 'notice_enabled', 'analytics_enabled'];
  const fields = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields[key] = typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key];
    }
  }
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(fields).map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE config SET ${setClause}, updated_at = datetime('now') WHERE id = 1`).run(fields);

  logAction(req, 'config_updated', { fields: Object.keys(fields) });
  res.json({ data: serializeConfig(db.prepare('SELECT * FROM config WHERE id = 1').get()) });
});

// POST /api/admin/config/kill  { message }
router.post('/kill', (req, res) => {
  const { message = 'This app has been temporarily disabled. Contact support.' } = req.body || {};
  db.prepare(`UPDATE config SET app_status = 'KILLED', app_message = ?, updated_at = datetime('now') WHERE id = 1`).run(message);
  logAction(req, 'kill_switch_activated', { message });
  res.json({ ok: true, data: serializeConfig(db.prepare('SELECT * FROM config WHERE id = 1').get()) });
});

// POST /api/admin/config/maintenance  { message }
router.post('/maintenance', (req, res) => {
  const { message = 'Under maintenance. Please check back soon.' } = req.body || {};
  db.prepare(`UPDATE config SET app_status = 'MAINTENANCE', app_message = ?, updated_at = datetime('now') WHERE id = 1`).run(message);
  logAction(req, 'maintenance_enabled', { message });
  res.json({ ok: true, data: serializeConfig(db.prepare('SELECT * FROM config WHERE id = 1').get()) });
});

// POST /api/admin/config/alive
router.post('/alive', (req, res) => {
  db.prepare(`UPDATE config SET app_status = 'ALIVE', app_message = '', updated_at = datetime('now') WHERE id = 1`).run();
  logAction(req, 'app_revived', {});
  res.json({ ok: true, data: serializeConfig(db.prepare('SELECT * FROM config WHERE id = 1').get()) });
});

module.exports = router;
