// db.js - SQLite via Node built-in node:sqlite (no native build, no Python needed)
// Tables: users, events, attendance, qr_history (Stage-2: rotating QR token log)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
require('dotenv').config();

const dbFile = process.env.DB_FILE || path.join(__dirname, 'qr-att.db');
const db = new DatabaseSync(dbFile);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','teacher','admin')),
  section TEXT DEFAULT '',
  program TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  venue TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qr_token TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','late')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(event_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_att_event ON attendance(event_id);
CREATE INDEX IF NOT EXISTS idx_att_student ON attendance(student_id);
-- Stage-2: rotating-QR support (grace window) + full token history (offline validation)
CREATE TABLE IF NOT EXISTS qr_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_hist ON qr_history(event_id, created_at);
`);

try { db.exec(`ALTER TABLE events ADD COLUMN qr_prev_token TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE events ADD COLUMN qr_rotated_at INTEGER DEFAULT 0`); } catch {}

// tiny compat shim: db.prepare(sql).get/.all/.run + info.lastInsertRowid (better-sqlite3 style code keeps working)
const rawPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const st = rawPrepare(sql);
  return {
    get: (...p) => st.get(...p),
    all: (...p) => st.all(...p),
    run: (...p) => st.run(...p),
  };
};

// Backfill: log current event tokens that predate qr_history (Stage-2 migration)
try {
  const evs = db.prepare('SELECT id, qr_token FROM events').all();
  const nowS = Math.floor(Date.now() / 1000);
  for (const e of evs) {
    const has = db.prepare('SELECT id FROM qr_history WHERE event_id=? AND token=?').get(e.id, e.qr_token);
    if (!has) db.prepare('INSERT INTO qr_history (event_id, token, created_at) VALUES (?,?,?)').run(e.id, e.qr_token, nowS);
  }
} catch {}

module.exports = db;
