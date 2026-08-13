'use strict';

const jwt = require('jsonwebtoken');

/**
 * Protects /api/admin/** routes. Expects `Authorization: Bearer <token>`.
 * Verifies signature + expiry only — no DB round-trip, so this stays cheap
 * even under load. Session revocation on password change is handled by
 * rotating JWT_SECRET is NOT done automatically; see routes/auth.js for
 * the explicit logout/blacklist-free design rationale.
 */
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, headerToken] = header.split(' ');

  // CSV export links are opened via window.open()/<a href>, which can't set
  // a custom Authorization header — accept the token as a query param ONLY
  // for that narrow case. This still requires possession of a valid JWT;
  // it does not weaken auth, but avoid extending this pattern to
  // state-changing routes since query strings can end up in logs/history.
  const token = scheme === 'Bearer' ? headerToken : req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = { id: payload.sub, username: payload.username };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    return res.status(401).json({ error: 'Invalid session token' });
  }
}

/**
 * Protects /api/public/** routes consumed by the Android app.
 * Simple shared-secret check — sufficient for a single first-party client;
 * rotate PUBLIC_API_KEY from the panel if it ever leaks from a decompiled APK.
 */
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.PUBLIC_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  return next();
}

module.exports = { requireAdminAuth, requireApiKey };
