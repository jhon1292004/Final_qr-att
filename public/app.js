// app.js - event-driven SPA. Pattern everywhere: Event -> Handler -> Action -> Result
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const t = localStorage.getItem('qratt_token');
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
};
const toast = (msg, cls = '') => {
  const el = document.createElement('div'); el.className = 'toast ' + cls; el.textContent = msg;
  $('#toast').appendChild(el); setTimeout(() => el.remove(), 4200);
};
let ME = null, TAB = 'events', scanner = null;
// Stage-2 globals
let qrTimer = null, qrCountdown = null, liveES = null, livePoll = null;
const QKEY = 'qratt_offline_queue';
const getQueue = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
const setQueue = (q) => localStorage.setItem(QKEY, JSON.stringify(q));
// EVENT: browser back online -> auto-sync offline queue (Step 2)
window.addEventListener('online', () => { if (ME && ME.role === 'student') syncQueue(true); });

// ---- EVENT 1: App load -> check session -> render by role ----
boot();
async function boot() {
  const t = localStorage.getItem('qratt_token');
  if (!t) return viewAuth();
  try { ME = await api('/api/auth/me'); viewDash(); }
  catch { localStorage.removeItem('qratt_token'); viewAuth(); }
}

function viewAuth() {
  $('#userBox').innerHTML = '';
  $('#app').innerHTML = `
  <div class="grid">
    <div class="card"><h3>Login</h3>
      <input id="li_email" placeholder="email e.g. student@school.edu">
      <input id="li_pass" type="password" placeholder="password">
      <button onclick="doLogin()">Login</button>
      <p class="mut">Demo admin: admin@school.edu / Admin123!</p></div>
    <div class="card"><h3>Register (Student / Teacher)</h3>
      <input id="rg_name" placeholder="Full name"><input id="rg_email" placeholder="email">
      <input id="rg_pass" type="password" placeholder="password (min 6)">
      <select id="rg_role"><option value="student">Student</option><option value="teacher">Teacher</option></select>
      <input id="rg_sec" placeholder="Section (optional)"><input id="rg_prog" placeholder="Program (optional)">
      <button onclick="doRegister()">Create account</button></div>
  </div>`;
}
// EVENT: Login pressed -> Handler doLogin -> Action POST /login -> Result dashboard
async function doLogin() {
  try { const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#li_email').value, password: $('#li_pass').value }) });
    localStorage.setItem('qratt_token', d.token); ME = d.user; toast('Welcome, ' + ME.name, 'ok'); viewDash(); }
  catch (e) { toast(e.message, 'err'); }
}
async function doRegister() {
  try { const d = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: $('#rg_name').value, email: $('#rg_email').value, password: $('#rg_pass').value, role: $('#rg_role').value, section: $('#rg_sec').value, program: $('#rg_prog').value }) });
    localStorage.setItem('qratt_token', d.token); ME = d.user; toast('Account created', 'ok'); viewDash(); }
  catch (e) { toast(e.message, 'err'); }
}
// EVENT: Logout pressed -> clear session -> login view
function doLogout() { stopScan(); stopQR(); stopLive(); localStorage.removeItem('qratt_token'); ME = null; toast('Logged out'); viewAuth(); }

function viewDash() {
  $('#userBox').innerHTML = `${ME.name} <span class="badge">${ME.role}</span> <button class="ghost" onclick="doLogout()">Logout</button>`;
  const tabs = ME.role === 'student' ? [['events', 'Events'], ['scan', 'Scan QR'], ['mine', 'My History'], ['profile', 'Profile']]
    : ME.role === 'teacher' ? [['events', 'Events'], ['create', '+ New Event'], ['profile', 'Profile']]
    : [['events', 'Events'], ['users', 'Users'], ['stats', 'Stats'], ['profile', 'Profile']];
  $('#app').innerHTML = `<nav class="tabs">${tabs.map(([k, l]) => `<button class="${TAB === k ? 'on' : ''}" onclick="go('${k}')">${l}</button>`).join('')}</nav><div id="body"><div class="card">Loading…</div></div>`;
  renderTab();
}
function go(t) { stopScan(); stopQR(); stopLive(); TAB = t; viewDash(); }

async function renderTab() {
  const B = $('#body');
  try {
    if (TAB === 'events') {
      const evs = await api('/api/events');
      if (!evs.length) { B.innerHTML = `<div class="card">No events yet. ${ME.role !== 'student' ? 'Create one from + New Event.' : ''}</div>`; return; }
      B.innerHTML = `<div class="grid">` + evs.map(e => `<div class="card"><h3>${esc(e.title)}</h3>
        <span class="badge ${e.status}">${e.status}</span>
        <p class="mut">${e.date} ${e.time} · ${esc(e.venue)}<br>${esc(e.description || '')}<br>by ${esc(e.creator || '')}</p>
        <div class="row">${ME.role === 'student' ? `<button class="blue" onclick="go('scan')">Scan to attend</button>` : `
          <button onclick="showQR(${e.id})">QR Code</button>
          <button class="blue" onclick="showAtt(${e.id})">Attendance</button>
          <button class="ghost" onclick="editEvent(${e.id})">Edit</button>
          ${e.status === 'open' ? `<button class="red" onclick="setStatus(${e.id},'close')">Close</button>` : `<button onclick="setStatus(${e.id},'reopen')">Reopen</button>`}`}</div>
        <div id="att-${e.id}"></div></div>`).join('') + `</div>`;
    }
    if (TAB === 'create') {
      B.innerHTML = `<div class="card"><h3>Create Event</h3>
        <input id="ev_t" placeholder="Event name"><div class="row"><input id="ev_d" type="date"><input id="ev_time" type="time"></div>
        <input id="ev_v" placeholder="Venue"><textarea id="ev_desc" placeholder="Description"></textarea>
        <button onclick="createNewEvent()">Create + Generate QR</button></div>`;
    }
    if (TAB === 'scan') {
      const q = getQueue();
      B.innerHTML = `<div class="card"><h3>Scan Event QR</h3>
        <div id="reader" style="max-width:400px"></div>
        <div class="row"><button onclick="startScan()">Start camera</button><button class="ghost" onclick="stopScan()">Stop</button></div>
        <p class="mut">No camera? Paste QR JSON manually:</p>
        <input id="manual_qr" placeholder='{"eventId":1,"token":"...","ts":...}'>
        <button class="blue" onclick="submitQR($('#manual_qr').value)">Submit attendance</button>
        <div id="scanRes"></div></div>
      <div class="card"><h3>Offline Queue ${navigator.onLine ? '<span class="badge present">online</span>' : '<span class="badge late">offline</span>'}</h3>
        <p class="mut">Offline? Scans are saved in this browser and auto-sync when you are back online.</p>
        <div id="qList">${q.length ? q.map((x, i) => `<p>Event ${x.eventId} · queued ${new Date(x.queuedAt * 1000).toLocaleTimeString()} <button class="ghost" onclick="dropQueued(${i})">Remove</button></p>`).join('') : '<p class="mut">Queue empty.</p>'}</div>
        <div class="row"><button class="blue" onclick="syncQueue()">Sync now (${q.length})</button></div></div>`;
      if (q.length && navigator.onLine) syncQueue(true);
    }
    if (TAB === 'mine') {
      const rows = await api('/api/attendance/mine');
      B.innerHTML = rows.length ? `<div class="card"><h3>My Attendance (${rows.length})</h3><table><tr><th>Event</th><th>Date</th><th>Status</th></tr>${rows.map(r => `<tr><td>${esc(r.title)}</td><td>${r.date} ${r.time}</td><td><span class="badge ${r.status}">${r.status}</span></td></tr>`).join('')}</table></div>`
        : `<div class="card">Empty: no attendance yet. Go to Scan QR.</div>`;
    }
    if (TAB === 'profile') {
      B.innerHTML = `<div class="card"><h3>My Profile <span class="badge">${esc(ME.role)}</span></h3>
        <p><b>Name:</b> ${esc(ME.name)}<br><b>Email:</b> ${esc(ME.email)}
        <br><b>Section:</b> ${esc(ME.section || '—')}<br><b>Program:</b> ${esc(ME.program || '—')}</p></div>`;
    }
    if (TAB === 'users') {
      const users = await api('/api/admin/users');
      B.innerHTML = `<div class="card"><h3>Users (${users.length})</h3><table><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr>${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td>${u.id !== ME.id ? `<button class="red" onclick="delUser(${u.id})">Delete</button>` : ''}</td></tr>`).join('')}</table></div>`;
    }
    if (TAB === 'stats') {
      const s = await api('/api/admin/overview');
      B.innerHTML = `<div class="card"><span class="badge present">LIVE</span> <span class="mut">auto-updates every 3s, no refresh</span></div>
      <div class="grid"><div class="card"><h3>Users</h3><h2 id="stU">${s.users}</h2></div><div class="card"><h3>Events</h3><h2 id="stE">${s.events}</h2></div><div class="card"><h3>Attendance</h3><h2 id="stA">${s.attendance}</h2></div></div>
      <div class="card mut">${(s.byStatus || []).map(x => `${x.status}: ${x.c}`).join(' · ') || 'no records'}</div>`;
      stopLive();
      const t = localStorage.getItem('qratt_token');
      try {
        liveES = new EventSource(`/api/admin/overview/stream?token=${encodeURIComponent(t)}`);
        liveES.onmessage = (ev) => { const c = JSON.parse(ev.data); if ($('#stA')) { $('#stU').textContent = c.users; $('#stE').textContent = c.events; $('#stA').textContent = c.attendance; } };
        liveES.onerror = () => { try { liveES.close(); } catch {} liveES = null; };
      } catch {}
    }
  } catch (e) { B.innerHTML = `<div class="card">Error: ${esc(e.message)}</div>`; toast(e.message, 'err'); }
}

async function createNewEvent() {
  try { const e = await api('/api/events', { method: 'POST', body: JSON.stringify({ title: $('#ev_t').value, date: $('#ev_d').value, time: $('#ev_time').value, venue: $('#ev_v').value, description: $('#ev_desc').value }) });
    toast('Event created', 'ok'); TAB = 'events'; viewDash(); showQR(e.id); }
  catch (e) { toast(e.message, 'err'); }
}
async function setStatus(id, act) {
  try { await api(`/api/events/${id}/${act}`, { method: 'POST' }); toast(act === 'close' ? 'Event closed' : 'Event reopened', 'ok'); renderTab(); }
  catch (e) { toast(e.message, 'err'); }
}
// EVENT: Edit pressed -> prefilled form -> PUT /api/events/:id -> updated card
async function editEvent(id) {
  try {
    const evs = await api('/api/events');
    const e = evs.find(x => x.id === id);
    if (!e) return toast('Event not found', 'err');
    $('#qrModal').innerHTML = `<div class="card" style="position:fixed;inset:0;background:#000c;display:flex;align-items:center;justify-content:center;z-index:40" onclick="this.remove()">
      <div class="card" style="width:min(92vw,480px)" onclick="event.stopPropagation()"><h3>Edit Event</h3>
      <input id="ed_t" value="${esc(e.title)}"><div class="row"><input id="ed_d" type="date" value="${esc(e.date)}"><input id="ed_time" type="time" value="${esc(e.time)}"></div>
      <input id="ed_v" value="${esc(e.venue)}"><textarea id="ed_desc">${esc(e.description || '')}</textarea>
      <div class="row"><button onclick="saveEvent(${id})">Save</button><button class="ghost" onclick="document.querySelector('#qrModal').innerHTML=''">Cancel</button></div></div></div>`;
  } catch (e) { toast(e.message, 'err'); }
}
async function saveEvent(id) {
  try {
    await api(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify({ title: $('#ed_t').value, date: $('#ed_d').value, time: $('#ed_time').value, venue: $('#ed_v').value, description: $('#ed_desc').value }) });
    $('#qrModal').innerHTML = ''; toast('Event updated', 'ok'); renderTab();
  } catch (e) { toast(e.message, 'err'); }
}
// STEP 1 — Rotating QR (Teacher): setInterval() re-fetches QR every 15s with fresh timestamp.
// EVENT: Teacher requests QR -> Handler showQR -> Action GET /qr every 15s -> Result fresh QR image
async function showQR(id) {
  stopQR();
  try {
    const paint = async () => {
      const d = await api(`/api/events/${id}/qr`);
      const left = d.expiresIn || 15;
      $('#qrModal').innerHTML = `<div class="card" style="position:fixed;inset:0;background:#000c;display:flex;align-items:center;justify-content:center;z-index:40" onclick="stopQR();this.remove()">
        <div class="card" onclick="event.stopPropagation()"><h3>${esc(d.event.title)} <span class="badge present">LIVE · rotates 15s</span></h3>
        <div><img src="${d.qr}" style="width:min(80vw,300px);background:#fff;padding:8px;border-radius:8px"></div>
        <p class="mut">${d.event.date} ${d.event.time} · ${esc(d.event.venue)}<br>Next rotation in <b id="qrCount">${left}s</b> · screenshots expire in 60s</p>
        <textarea readonly rows="3">${esc(d.payload)}</textarea><br>
        <div class="row"><button class="blue" onclick="rotateNow(${id})">Rotate now</button><button class="ghost" onclick="stopQR();document.querySelector('#qrModal').innerHTML=''">Close</button></div></div></div>`;
      let c = left; // countdown UI
      clearInterval(qrCountdown);
      qrCountdown = setInterval(() => { c--; const el = $('#qrCount'); if (el) el.textContent = c + 's'; if (c <= 0) clearInterval(qrCountdown); }, 1000);
    };
    await paint();
    qrTimer = setInterval(paint, 15000); // Step 1: loop nga mag-usab sa QR payload kada 15 seconds
  } catch (e) { toast(e.message, 'err'); }
}
function stopQR() { if (qrTimer) clearInterval(qrTimer); if (qrCountdown) clearInterval(qrCountdown); qrTimer = qrCountdown = null; }
async function rotateNow(id) {
  try { await api(`/api/events/${id}/rotate`, { method: 'POST' }); toast('QR rotated', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}
async function showAtt(id) {
  stopLive();
  const box = $('#att-' + id); box.innerHTML = 'Loading…';
  const paint = (d) => {
    box.innerHTML = `<p><span class="badge present">LIVE</span> <b>Present:</b> ${d.present} · <b>Late:</b> ${d.late} · <b>Total:</b> ${d.total}</p>` +
      (d.rows && d.rows.length ? `<table><tr><th>Student</th><th>Status</th><th>Time</th><th></th></tr>${d.rows.map(r => `<tr><td>${esc(r.name)}</td><td><span class="badge ${r.status}">${r.status}</span></td><td>${r.date} ${r.time}</td><td><button class="red" onclick="delAtt(${r.id},${id})">X</button></td></tr>`).join('')}</table>` : '<p class="mut">Empty: no attendance yet.</p>');
  };
  try {
    const d = await api(`/api/attendance/event/${id}`);
    paint(d);
    // STEP 3 — realtime listener: SSE pushes counts every 3s, no page refresh; polling fallback below
    const t = localStorage.getItem('qratt_token');
    try {
      liveES = new EventSource(`/api/attendance/event/${id}/stream?token=${encodeURIComponent(t)}`);
      liveES.onmessage = async (ev) => {
        const c = JSON.parse(ev.data);
        const full = await api(`/api/attendance/event/${id}`).catch(() => null);
        if (full) paint(full);
        else box.querySelector('p').innerHTML = `<span class="badge present">LIVE</span> <b>Present:</b> ${c.present} · <b>Late:</b> ${c.late} · <b>Total:</b> ${c.total}`;
      };
      liveES.onerror = () => { // fallback: poll every 3s
        try { liveES.close(); } catch {} liveES = null;
        if (!livePoll) livePoll = setInterval(async () => { const f = await api(`/api/attendance/event/${id}`).catch(() => null); if (f && $('#att-' + id)) paint(f); }, 3000);
      };
    } catch { livePoll = setInterval(async () => { const f = await api(`/api/attendance/event/${id}`).catch(() => null); if (f) paint(f); }, 3000); }
  } catch (e) { box.innerHTML = 'Error: ' + esc(e.message); }
}
function stopLive() { try { liveES && liveES.close(); } catch {} liveES = null; if (livePoll) clearInterval(livePoll); livePoll = null; }
async function delAtt(aid, eid) { try { await api('/api/attendance/' + aid, { method: 'DELETE' }); toast('Record corrected (deleted)', 'ok'); showAtt(eid); } catch (e) { toast(e.message, 'err'); } }
async function delUser(id) { try { await api('/api/admin/users/' + id, { method: 'DELETE' }); toast('User deleted', 'ok'); renderTab(); } catch (e) { toast(e.message, 'err'); } }

// STEP 2 — Offline queue (Student): navigator.onLine check; offline scans -> localStorage, auto-sync on reconnect
function startScan() {
  stopScan();
  scanner = new Html5Qrcode('reader');
  scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 250 },
    (txt) => submitQR(txt, true), () => {}).catch(e => toast('Camera failed: ' + e, 'err'));
}
function stopScan() { try { if (scanner) { scanner.stop().catch(() => {}); scanner.clear(); } } catch {} scanner = null; }
// EVENT 2/3: QR Scanner detects QR / Attendance pressed -> submitQR -> online? POST now : queue -> sync later
async function submitQR(text, auto = false) {
  if (!text) return toast('Empty QR', 'err');
  let body;
  try { const p = JSON.parse(text); body = { eventId: p.eventId, token: p.token, ts: p.ts }; }
  catch { return toast('Invalid QR code', 'err'); }
  if (!body.eventId || !body.token) return toast('Invalid QR code', 'err');
  if (!navigator.onLine) { queueScan(body, text); return; } // Step 2: i-save una ang scan data sa localStorage
  $('#scanRes') && ($('#scanRes').innerHTML = 'Recording…');
  try { const r = await api('/api/attendance/scan', { method: 'POST', body: JSON.stringify(body) });
    stopScan(); toast(`Attendance recorded: ${r.status}`, 'ok');
    $('#scanRes') && ($('#scanRes').innerHTML = `<p>Confirmed: <span class="badge ${r.status}">${r.status}</span></p>`); }
  catch (e) {
    if (String(e.message).includes('Failed to fetch') || e instanceof TypeError) { queueScan(body, text); return; } // network drop mid-scan
    if (auto) stopScan();
    toast(e.message, 'err'); $('#scanRes') && ($('#scanRes').innerHTML = `<p style="color:#F87171">${esc(e.message)}</p>`); }
}
function queueScan(body, raw) {
  const q = getQueue();
  if (q.some(x => x.eventId === body.eventId)) return toast('Already in offline queue for this event', 'err');
  q.push({ ...body, raw, queuedAt: Math.floor(Date.now() / 1000) });
  setQueue(q);
  toast(`Offline — scan queued (${q.length}). Auto-sync pag-online balik.`, 'ok');
  if ($('#qList')) $('#qList').innerHTML = q.map((x, i) => `<p>Event ${x.eventId} · queued ${new Date(x.queuedAt * 1000).toLocaleTimeString()} <button class="ghost" onclick="dropQueued(${i})">Remove</button></p>`).join('');
}
function dropQueued(i) { const q = getQueue(); q.splice(i, 1); setQueue(q); toast('Removed from queue'); renderTab(); }
// EVENT: back online / Sync pressed -> flush queue in order -> validated insert each
async function syncQueue(silent = false) {
  const q = getQueue();
  if (!q.length) { if (!silent) toast('Queue empty'); return; }
  if (!navigator.onLine) { if (!silent) toast('Still offline', 'err'); return; }
  let ok = 0, fail = 0;
  for (const item of [...q]) {
    try {
      await api('/api/attendance/scan', { method: 'POST', body: JSON.stringify({ eventId: item.eventId, token: item.token, ts: item.ts, queuedAt: item.queuedAt }) });
      setQueue(getQueue().filter(x => !(x.eventId === item.eventId && x.queuedAt === item.queuedAt))); ok++;
    } catch (e) {
      if (/Duplicate/.test(e.message)) { setQueue(getQueue().filter(x => !(x.eventId === item.eventId))); ok++; } // already recorded counts as synced
      else { fail++; if (!silent) toast(`Event ${item.eventId}: ${e.message}`, 'err'); }
    }
  }
  toast(`Sync done: ${ok} uploaded${fail ? `, ${fail} failed (expired/closed)` : ''}`, ok ? 'ok' : 'err');
  if (TAB === 'scan') renderTab();
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
