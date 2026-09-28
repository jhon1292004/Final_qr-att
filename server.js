// server.js - QR-ATT Express API + static frontend
// Run: npm install && npm start  -> http://localhost:3000
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const nowDate = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const epochSec = () => Math.floor(Date.now() / 1000);
const sign = (u) => jwt.sign({ id: u.id, role: u.role, email: u.email }, JWT_SECRET, { expiresIn: '12h' });

// Stage-2 tuning: QR rotates every 15s, prev token grace 30s, QR timestamp window 60s
const QR_ROTATE_SEC = 15, QR_GRACE_SEC = 30, QR_TS_WINDOW_SEC = 60;
const logQrHistory = (eventId, token) => {
  try { db.prepare('INSERT INTO qr_history (event_id, token, created_at) VALUES (?,?,?)').run(eventId, token, epochSec()); } catch {}
};
// Validate rotating-QR token. Returns null if OK, else error string.
// - Online (no queuedAt): token must be current, or prev within grace; ts must be fresh.
// - Offline sync (queuedAt set): token must have been valid AT queue time (history window check).
function validateQrToken(ev, token, ts, queuedAt) {
  const now = epochSec();
  if (queuedAt) { // offline-queued scan: was this token live when student scanned offline?
    if (queuedAt > now + 60 || now - queuedAt > 24 * 3600) return 'Queued scan too old (max 24h). Please re-scan online.';
    const hist = db.prepare('SELECT token, created_at FROM qr_history WHERE event_id=? ORDER BY created_at ASC').all(ev.id);
    const idx = hist.findIndex(h => h.token === token);
    if (idx === -1) { // pre-history event token: accept only if it equals original current and queued recently
      if (token === ev.qr_token || token === (ev.qr_prev_token || '')) return null;
      return 'Invalid QR code (unknown token)';
    }
    const start = hist[idx].created_at - 5;
    const end = (idx + 1 < hist.length ? hist[idx + 1].created_at : now) + QR_GRACE_SEC;
    if (queuedAt < start || queuedAt > end) return 'QR expired before you scanned offline. Please re-scan the fresh code.';
    return null;
  }
  if (ts) { // timestamped rotating QR: anti-screenshot / reuse
    if (Math.abs(now - Number(ts)) > QR_TS_WINDOW_SEC) return 'QR expired — ask teacher for the fresh code (rotates every 15s)';
  }
  if (token === ev.qr_token) return null;
  if (token === (ev.qr_prev_token || '') && now - Number(ev.qr_rotated_at || 0) <= QR_GRACE_SEC) return null;
  return ev.qr_prev_token ? 'QR expired — a new code is showing. Scan again.' : 'Invalid QR code';
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null); // ?token= for EventSource (SSE can't set headers)
  if (!token) return res.status(401).json({ error: 'Unauthorized: missing token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Unauthorized: invalid/expired session. Please login again.' }); }
}
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden: insufficient role' });
  next();
};
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

// Seed default admin if users table empty (for demo/defense)
(function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n === 0) {
    const hash = bcrypt.hashSync('Admin123!', 10);
    db.prepare(`INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)`)
      .run('Administrator', 'admin@school.edu', hash, 'admin');
    console.log('Seeded admin: admin@school.edu / Admin123!');
  }
})();

// ---------- AUTH ----------
// EVENT: User presses Register/Login/Logout
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, role, section, program } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be >= 6 chars' });
  const r = ['student', 'teacher'].includes(role) ? role : 'student'; // no open admin signup (security)
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users (name,email,password_hash,role,section,program) VALUES (?,?,?,?,?,?)`)
    .run(name.trim(), email.toLowerCase().trim(), hash, r, section || '', program || '');
  const user = db.prepare('SELECT id,name,email,role,section,program FROM users WHERE id=?').get(info.lastInsertRowid);
  res.status(201).json({ user, token: sign(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password, u.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });
  const safe = { id: u.id, name: u.name, email: u.email, role: u.role, section: u.section, program: u.program };
  res.json({ user: safe, token: sign(safe) });
});

app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,name,email,role,section,program,created_at FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(401).json({ error: 'Session user no longer exists' });
  res.json(u);
});

// ---------- EVENTS ----------
// EVENT: Event is created / edited / closed
app.get('/api/events', auth, (req, res) => {
  const rows = db.prepare(`SELECT e.*, u.name AS creator FROM events e JOIN users u ON u.id=e.created_by ORDER BY e.date DESC, e.id DESC`).all();
  res.json(rows);
});

app.post('/api/events', auth, requireRole('teacher', 'admin'), (req, res) => {
  const { title, date, time, venue, description } = req.body || {};
  if (!title || !date || !time || !venue) return res.status(400).json({ error: 'title, date, time, venue required' });
  const qr_token = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO events (title,date,time,venue,description,status,created_by,qr_token,qr_rotated_at) VALUES (?,?,?,?,?,'open',?,?,?)`)
    .run(title.trim(), date, time, venue.trim(), description || '', req.user.id, qr_token, epochSec());
  logQrHistory(info.lastInsertRowid, qr_token);
  res.status(201).json(db.prepare('SELECT * FROM events WHERE id=?').get(info.lastInsertRowid));
});

app.put('/api/events/:id', auth, requireRole('teacher', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner or admin can edit' });
  const { title, date, time, venue, description, status } = req.body || {};
  if (status && !['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE events SET title=COALESCE(?,title), date=COALESCE(?,date), time=COALESCE(?,time),
    venue=COALESCE(?,venue), description=COALESCE(?,description), status=COALESCE(?,status) WHERE id=?`)
    .run(title ?? null, date ?? null, time ?? null, venue ?? null, description ?? null, status ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id));
});

app.post('/api/events/:id/close', auth, requireRole('teacher', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner or admin' });
  db.prepare('UPDATE events SET status=? WHERE id=?').run('closed', req.params.id);
  res.json({ ok: true });
});

app.post('/api/events/:id/reopen', auth, requireRole('teacher', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner or admin' });
  db.prepare('UPDATE events SET status=? WHERE id=?').run('open', req.params.id);
  res.json({ ok: true });
});

// STEP 1 — Rotating QR: teacher polls this every 15s; prev token stays valid for 30s grace
app.post('/api/events/:id/rotate', auth, requireRole('teacher', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner or admin' });
  if (ev.status !== 'open') return res.status(410).json({ error: 'Cannot rotate QR of a closed event' });
  const fresh = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE events SET qr_prev_token=qr_token, qr_token=?, qr_rotated_at=? WHERE id=?').run(fresh, epochSec(), ev.id);
  logQrHistory(ev.id, fresh);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(ev.id));
});

// QR payload = JSON { eventId, token, ts } ; ts enables 60s expiry (anti-screenshot/reuse)
app.get('/api/events/:id/qr', auth, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const payload = JSON.stringify({ eventId: ev.id, token: ev.qr_token, ts: epochSec() });
  QRCode.toDataURL(payload, { width: 300, margin: 1 }, (err, url) => {
    if (err) return res.status(500).json({ error: 'QR generation failed' });
    res.json({ qr: url, payload, event: ev, expiresIn: QR_ROTATE_SEC, rotatedAt: ev.qr_rotated_at });
  });
});

// ---------- ATTENDANCE ----------
// EVENT: QR Scanner detects QR -> Attendance button pressed -> DB insert validated
// Accepts {eventId, token, ts, queuedAt, qr}; queuedAt = offline queue sync (Step 2)
app.post('/api/attendance/scan', auth, requireRole('student'), (req, res) => {
  let { eventId, token, ts, queuedAt, qr } = req.body || {};
  // Accept raw QR string too: {"eventId":1,"token":"...","ts":...}
  if (qr && !eventId) { try { const p = JSON.parse(qr); eventId = p.eventId; token = p.token; ts = p.ts; } catch {} }
  if (!eventId || !token) return res.status(400).json({ error: 'Invalid QR code: missing event/token' });

  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  if (!ev) return res.status(404).json({ error: 'Invalid QR code: event not found' });
  if (ev.status !== 'open') return res.status(410).json({ error: 'Attendance closed for this event' }); // closed event
  const bad = validateQrToken(ev, token, ts, queuedAt);
  if (bad) return res.status(400).json({ error: bad }); // invalid / expired rotating QR
  const dup = db.prepare('SELECT id FROM attendance WHERE event_id=? AND student_id=?').get(eventId, req.user.id);
  if (dup) return res.status(409).json({ error: 'Duplicate attendance: already recorded' });        // duplicate

  // Late detection: if now > event time+15min on same date -> late
  let status = 'present';
  try {
    const start = new Date(`${ev.date}T${ev.time}`);
    if (!isNaN(start) && Date.now() - start.getTime() > 15 * 60 * 1000) status = 'late';
  } catch {}
  const info = db.prepare(`INSERT INTO attendance (event_id,student_id,date,time,status) VALUES (?,?,?,?,?)`)
    .run(ev.id, req.user.id, nowDate(), nowTime(), status);
  res.status(201).json({ ok: true, status, record: db.prepare('SELECT * FROM attendance WHERE id=?').get(info.lastInsertRowid) });
});

app.get('/api/attendance/mine', auth, requireRole('student'), (req, res) => {
  res.json(db.prepare(`SELECT a.*, e.title, e.date AS edate, e.time AS etime, e.venue
    FROM attendance a JOIN events e ON e.id=a.event_id WHERE a.student_id=? ORDER BY a.id DESC`).all(req.user.id));
});

app.get('/api/attendance/event/:id', auth, requireRole('teacher', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner or admin' });
  const rows = db.prepare(`SELECT a.*, u.name, u.email, u.section FROM attendance a
    JOIN users u ON u.id=a.student_id WHERE a.event_id=? ORDER BY a.id DESC`).all(req.params.id);
  const present = rows.filter(r => r.status === 'present').length;
  res.json({ event: ev, total: rows.length, present, late: rows.length - present, rows });
});

// STEP 3 — Real-time stream (SSE, no extra dep): pushes counts every 3s, no page refresh needed
// Frontend: new EventSource('/api/attendance/event/ID/stream?token=JWT')
app.get('/api/attendance/event/:id/stream', auth, requireRole('teacher', 'admin'), (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (req.user.role !== 'admin' && ev.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner or admin' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const push = () => {
    try {
      const rows = db.prepare('SELECT status FROM attendance WHERE event_id=?').all(ev.id);
      const present = rows.filter(r => r.status === 'present').length;
      res.write(`data: ${JSON.stringify({ eventId: ev.id, total: rows.length, present, late: rows.length - present, at: Date.now() })}\n\n`);
    } catch {}
  };
  push();
  const t = setInterval(push, 3000);
  req.on('close', () => clearInterval(t));
});

app.get('/api/admin/overview/stream', auth, requireRole('admin'), (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const push = () => {
    try {
      res.write(`data: ${JSON.stringify({
        users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
        events: db.prepare('SELECT COUNT(*) c FROM events').get().c,
        attendance: db.prepare('SELECT COUNT(*) c FROM attendance').get().c,
        at: Date.now() })}\n\n`);
    } catch {}
  };
  push();
  const t = setInterval(push, 3000);
  req.on('close', () => clearInterval(t));
});

// Admin: all records + user management + correct/delete attendance
app.get('/api/admin/overview', auth, requireRole('admin'), (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    events: db.prepare('SELECT COUNT(*) c FROM events').get().c,
    attendance: db.prepare('SELECT COUNT(*) c FROM attendance').get().c,
    byStatus: db.prepare('SELECT status, COUNT(*) c FROM attendance GROUP BY status').all()
  });
});
app.get('/api/admin/users', auth, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT id,name,email,role,section,program,created_at FROM users ORDER BY id').all());
});
app.delete('/api/admin/users/:id', auth, requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/attendance/:id', auth, requireRole('teacher', 'admin'), (req, res) => {
  const a = db.prepare('SELECT * FROM attendance WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Record not found' });
  if (req.user.role !== 'admin') {
    const ev = db.prepare('SELECT * FROM events WHERE id=?').get(a.event_id);
    if (!ev || ev.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner or admin' });
  }
  db.prepare('DELETE FROM attendance WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`QR-ATT running on http://localhost:${PORT}`));
