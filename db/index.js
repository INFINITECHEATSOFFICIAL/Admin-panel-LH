'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// Railway deployments have an ephemeral filesystem. When a Railway Volume is
// attached, its mount path is provided at runtime and must hold the SQLite file
// so courses, users, notices, and settings survive every redeploy. DB_PATH
// remains an explicit override for local development or a custom mount path.
const volumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_PATH = process.env.DB_PATH
  || (volumeMountPath ? path.join(volumeMountPath, 'learning_hub.db') : './data/learning_hub.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  icon TEXT DEFAULT '📘',
  level TEXT DEFAULT 'Beginner',
  color TEXT DEFAULT '#6C63FF',
  description TEXT DEFAULT '',
  premium INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  thumbnail_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  order_index INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  video_url TEXT DEFAULT '',
  thumb_url TEXT DEFAULT '',
  file_url TEXT DEFAULT '',
  duration TEXT DEFAULT '',
  order_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','draft')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT UNIQUE NOT NULL,
  device_name TEXT,
  android_version TEXT,
  app_version TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active TEXT NOT NULL DEFAULT (datetime('now')),
  is_premium INTEGER NOT NULL DEFAULT 0,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  firebase_installation_id TEXT,
  enrolled_courses TEXT NOT NULL DEFAULT '[]',
  progress TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS premium_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  expiry_date TEXT,              -- NULL/'' = lifetime
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'all' CHECK (target IN ('all','premium','free')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_status TEXT NOT NULL DEFAULT 'ALIVE' CHECK (app_status IN ('ALIVE','MAINTENANCE','KILLED')),
  app_message TEXT DEFAULT '',
  current_version TEXT DEFAULT '1.0.0',
  force_update INTEGER NOT NULL DEFAULT 0,
  notice TEXT DEFAULT '',
  notice_enabled INTEGER NOT NULL DEFAULT 0,
  -- Analytics is OFF by default and must be explicitly enabled here.
  -- When on, the app is expected to disclose this to the user per your
  -- own privacy policy — this backend does not silently collect anything.
  analytics_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id);
CREATE INDEX IF NOT EXISTS idx_folders_course ON folders(course_id);
CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_id);
CREATE INDEX IF NOT EXISTS idx_premium_device ON premium_users(device_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON admin_logs(timestamp);
`);

// Backward-compatible migration for databases created before folders existed.
const lessonColumns = db.pragma('table_info(lessons)');
if (!lessonColumns.some((column) => column.name === 'folder_id')) {
  db.exec('ALTER TABLE lessons ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_lessons_folder ON lessons(folder_id)');

// Backward-compatible migration for Firebase Cloud Messaging installation IDs.
const userColumns = db.pragma('table_info(users)');
if (!userColumns.some((column) => column.name === 'firebase_installation_id')) {
  db.exec('ALTER TABLE users ADD COLUMN firebase_installation_id TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_users_firebase_installation ON users(firebase_installation_id)');

// Seed the singleton config row.
db.prepare(`INSERT OR IGNORE INTO config (id) VALUES (1)`).run();

// Bootstrap the first admin account from env vars, once.
const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
if (adminCount === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password === 'change_me_now_please') {
    // eslint-disable-next-line no-console
    console.warn(
      '\n⚠️  WARNING: ADMIN_PASSWORD is unset or still the placeholder value.\n' +
      '   Set a strong ADMIN_PASSWORD in .env before exposing this server publicly.\n'
    );
  }
  const hash = bcrypt.hashSync(password || 'change_me_now_please', 12);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  // eslint-disable-next-line no-console
  console.log(`✅ Bootstrap admin created: ${username}`);
}

module.exports = db;
