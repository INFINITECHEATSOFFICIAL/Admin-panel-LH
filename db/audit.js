'use strict';

const db = require('./index');

const insertLog = db.prepare(
  `INSERT INTO admin_logs (admin_id, action, details, ip_address) VALUES (?, ?, ?, ?)`
);

/**
 * Records an admin action. Never throws — audit logging must not be able
 * to fail a request that otherwise succeeded.
 */
function logAction(req, action, details) {
  try {
    const adminId = req.admin ? req.admin.id : null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    insertLog.run(adminId, action, details ? JSON.stringify(details) : null, ip);
  } catch (_) {
    /* audit logging is best-effort */
  }
}

module.exports = { logAction };
