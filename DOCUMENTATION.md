# QR-ATT — Technical Documentation
*(Required output per PDF Section 17: overview, architecture, database, features, security, testing, presentation)*

## 1. System Overview
QR-ATT is a web-based School Event Attendance Management System. A teacher creates an
event, the system generates a QR code, a student scans it with a camera or pastes the
QR payload, the server validates (event open, token fresh, no duplicate) and records
attendance with automatic present/late detection. Three roles: **student**, **teacher**,
**admin**. Runs locally with `npm start` → `http://localhost:3000`. No cloud dependency.

## 2. Architecture
```
Browser SPA (public/index.html + app.js + styles.css)
  │  fetch() JSON + Authorization: Bearer <JWT>   EventSource (SSE) for live counts
  ▼                                               │
Express API (server.js) ─── SQLite file (qr-att.db via db.js, node:sqlite)
  ├── POST /api/auth/register, /api/auth/login, GET /api/auth/me
  ├── GET|POST /api/events, PUT /api/events/:id, POST /:id/close|reopen|rotate, GET /:id/qr
  ├── POST /api/attendance/scan, GET /mine, GET /event/:id, DELETE /:id
  ├── GET /api/attendance/event/:id/stream (SSE), GET /api/admin/overview(/stream), /users
  └── serves static frontend + SPA fallback
```
Event-driven everywhere: every user action is Event → Handler → Action → Result
(see README §3 for the 9 mapped events).

## 3. Database Design
| Table | Key columns | Relationships |
|---|---|---|
| users | id, name, email UNIQUE, password_hash, role, section, program | 1 user → N events (created_by), N attendance |
| events | id, title, date, time, venue, description, status open/closed, created_by FK, qr_token, qr_prev_token, qr_rotated_at | N attendance, N qr_history |
| attendance | id, event_id FK, student_id FK, date, time, status present/late, UNIQUE(event_id, student_id) | duplicate prevention at DB level |
| qr_history | id, event_id FK, token, created_at (epoch) | proves which token was live at any scan time (offline validation) |

File: `qr-att.db` (auto-created). Secrets/credentials are never stored in code — only
`JWT_SECRET` in local `.env` (git-ignored).

## 4. Major Features
- Auth: register (student/teacher only), login, logout, 12h JWT session, hashed passwords.
- Event CRUD + close/reopen; owner-or-admin rule on edit/close/rotate.
- QR: payload `{eventId, token, ts}` as image (qrcode lib) + raw JSON fallback; camera scan
  via html5-qrcode CDN + manual paste.
- Stage-2 innovations: (1) rotating QR every 15s w/ 30s grace + 60s timestamp expiry
  (anti-screenshot/reuse); (2) offline queue in localStorage with auto-sync on `online`
  event, server checks token-valid-at-queue-time; (3) real-time dashboard via SSE
  (3s push) with polling fallback — counts rise with no page refresh.
- Admin: user list/delete, campus overview stats, attendance correction (delete record).

## 5. Security Implementation
- bcryptjs password hashing (salt rounds 10); plain passwords never stored.
- JWT signed with server-only `JWT_SECRET` from `.env`; 12h expiry; verified per request.
- Role middleware `requireRole()` on every protected route; admin cannot self-register;
  users cannot delete themselves; teachers only see/edit their own events' attendance.
- Input validation (email regex, password ≥ 6, required fields, status whitelist).
- Duplicate blocked twice: app check + `UNIQUE(event_id, student_id)` constraint.
- `.gitignore` excludes `.env`, `*.db*`, `node_modules` (Rule 7 compliant — verified by scan).

## 6. Testing Results (all executed live on localhost:3000)
| Test | Expected | Result |
|---|---|---|
| Admin login | role=admin + token | PASS |
| Teacher create event + QR | id + QR dataURL + expiresIn=15 | PASS |
| Student register + scan fresh QR | present/late confirmed, history=1 | PASS |
| Rescan same event | 409 duplicate | PASS |
| Scan after close | 410 closed | PASS |
| Scan garbage token | 400 invalid | PASS |
| Stale timestamp (ts=1) | 400 expired | PASS |
| Previous-rotation token | accepted within 30s grace | PASS |
| Offline queuedAt token | accepted via history window | PASS |
| SSE stream | `data: {total, present, late}` every 3s | PASS |
| Frontend `/` + `/app.js` | HTTP 200 | PASS |
| `createEvent` browser bug | renamed `createNewEvent`, Console clean | PASS (user-verified UI) |

## 7. Presentation Guide (PDF §9 + §18)
1. Problem (2 min): manual attendance is slow, faked, hard to monitor.
2. Solution (2 min): QR scan → validated record → live dashboard.
3. Demo (5–10 min): README §5 script — create, scan, duplicate-block, close-block, live count.
4. Technical (3 min): this document §§2–5 — Express + SQLite, JWT+bcrypt, 4 tables.
5. Innovation (3 min): rotating QR, offline queue, realtime SSE.
6. Q&A prep: "How is duplicate prevented?" (UNIQUE + app check) · "How do you stop
   screenshot reuse?" (15s rotation + 60s ts expiry) · "How does offline work?"
   (localStorage queue + history-window validation) · "Where is the secret?"
   (`.env`, never committed) · "Show me an event flow" (README §3).
