# QR-ATT — Smart School Event Attendance Management System
Individual Final Project (Event-Driven Programming) — Stage 1. Hackathon-ready Stage 2 base.

## 1. Run it (2 minutes)
```powershell
cd qr-att
npm install
copy .env.example .env   # then edit JWT_SECRET
npm start
# open http://localhost:3000
```
Seeded admin on first run: `admin@school.edu` / `Admin123!`
Register students/teachers from the UI. Admin role is never self-registered (security).

## 2. What was built (spec coverage)
| Spec | Implementation |
|---|---|
| Auth: login/register/logout/session/password | bcryptjs hash + JWT (12h) in `Authorization: Bearer`, `GET /api/auth/me`, logout clears token |
| 3 roles | `users.role` = student/teacher/admin, `requireRole()` middleware on every route |
| Event CRUD + close/reopen | `POST/PUT /api/events`, `POST /:id/close`, `POST /:id/reopen`, owner-or-admin check |
| QR generate/scan/record/confirm | `GET /events/:id/qr` (qrcode lib, payload `{eventId,token}`), `html5-qrcode` camera + manual paste, `POST /attendance/scan` |
| Validation | invalid QR (404/400), closed (410), duplicate UNIQUE(event,student) (409), unauthorized (401/403) — all with UI toasts |
| Records | `attendance(event_id,student_id,date,time,status)`; student `/mine`, teacher `/attendance/event/:id` with present/late counts |
| DB | SQLite (`qr-att.db`): users 1—N events, events 1—N attendance, users 1—N attendance |
| Security | hashed passwords, no admin self-signup, JWT expiry, input validation, `.env` secret (never commit), `.gitignore` covers `*.db`/`.env` |
| UI | Responsive vanilla CSS, loading/success/error/empty/invalid/duplicate/closed/unauthorized feedback |

## 3. Event-driven map (for defense — say Event → Handler → Action → Result)
1. Login pressed → `doLogin()` → POST /auth/login → dashboard by role
2. Camera detects QR → `Html5Qrcode` callback → `submitQR()` → POST /attendance/scan → toast + history
3. Attendance submit → `submitQR()` → server validates token/status/dup → INSERT → `{present|late}`
4. Event created → `createEvent()` → POST /events (random qr_token) → QR modal
5. Event closed → `setStatus()` → POST /close → further scans get 410
6. Invalid QR → JSON parse/token mismatch → 400 toast "Invalid QR code"
7. Duplicate → UNIQUE check → 409 toast "already recorded"
8. Logout → `doLogout()` → token cleared → auth view
9. Data refresh → `renderTab()` after every mutation

## 4. API quick reference
```
POST /api/auth/register {name,email,password,role,section,program}
POST /api/auth/login {email,password} -> {user,token}
GET  /api/auth/me
GET  /api/events | POST /api/events (teacher/admin) | PUT /api/events/:id
POST /api/events/:id/close | POST /api/events/:id/reopen | POST /api/events/:id/rotate (new QR)
GET  /api/events/:id/qr -> {qr:dataURL, payload:{eventId,token,ts}, expiresIn:15}
POST /api/attendance/scan {eventId,token,ts,queuedAt?} (student; queuedAt = offline sync)
GET  /api/attendance/mine (student)
GET  /api/attendance/event/:id (teacher/admin)
GET  /api/attendance/event/:id/stream?token=JWT (SSE live counts every 3s)
GET  /api/admin/overview | GET /api/admin/overview/stream?token=JWT (SSE) | GET /api/admin/users | DELETE /api/admin/users/:id (admin)
DELETE /api/attendance/:id (teacher owner / admin — record correction)
```

## 5. Defense demo script (7 min)
1. Register student + teacher, login as teacher, create event, show QR.
2. Login as student (second browser/incognito), Scan → paste QR JSON → "present/late confirmed".
3. Rescan → show duplicate blocked. Close event → show closed blocked. Scan garbage → invalid.
4. Teacher: Attendance table + counts. Admin: Users + Stats + delete/correct.
5. Explain DB (open `db.js`), point to 5 events above, show JWT + bcrypt + role middleware in `server.js`.

## 6. Hackathon Stage-2 — IMPLEMENTED (all 3)
**Step 1 Rotating QR (Teacher):** `showQR()` runs `setInterval(paint, 15000)`; payload now `{eventId,token,ts}`.
`POST /events/:id/rotate` shifts `qr_token -> qr_prev_token` (+`qr_rotated_at`, `qr_history` log).
Server accepts current token, or prev token within 30s grace; `|now-ts|>60s` → "QR expired" (anti-screenshot/reuse).
Demo: open QR modal, watch countdown + auto-refresh; `Rotate now` button; scan old screenshot → expired message.
**Step 2 Offline Queue (Student):** `submitQR()` checks `navigator.onLine`; offline → saved to `localStorage['qratt_offline_queue']` with `queuedAt`.
`window 'online'` event + `Sync now` button flush via `syncQueue()` sending `{...,queuedAt}`.
Server validates token was live AT queue time via `qr_history` window (works across rotations, max 24h).
Demo: DevTools → Network → Offline → scan → queued → go online → auto-sync toast.
**Step 3 Real-Time Dashboard:** `GET /attendance/event/:id/stream` + `/admin/overview/stream` (SSE, no extra dep; `?token=` because EventSource can't set headers).
Teacher `showAtt()` opens `EventSource`, repaints counts live; 3s-poll fallback if SSE errors. Admin Stats tab same.
Demo: teacher opens Attendance (LIVE badge), student scans on another browser, count rises with no refresh.
- Notifications (upcoming events list + toast reminders)
- Offline queue (localStorage pending scans, sync on reconnect)

## 7. Files
```
qr-att/server.js      Express API + static host
qr-att/db.js          SQLite schema (node:sqlite, zero native build)
qr-att/public/index.html | styles.css | app.js   Role-based SPA + scanner
```
