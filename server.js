/*
RapidLink — backend платформы записи.
Мультитенантность через tenant_id (Вариант A).
*/
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const fs = require('fs');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_JWT_SECRET = 'replace-with-secure-secret';
let CONFIG = {
  jwtSecret: DEFAULT_JWT_SECRET,
  telegramBotToken: '',
  telegramChatId: '',
  allowedOrigin: null
};
if (fs.existsSync(CONFIG_FILE)) {
  try { CONFIG = Object.assign(CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE))); }
  catch (e) { console.warn('Failed to read config.json', e); }
}

const db = new Database(path.join(__dirname, 'app.db'));

let platformDb = null;
const platformFile = path.join(__dirname, 'platform.db');
if (fs.existsSync(platformFile)) {
  platformDb = new Database(platformFile);
}

const app = express();
app.set('trust proxy', true);
app.use(CONFIG.allowedOrigin ? cors({ origin: CONFIG.allowedOrigin }) : cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function rub(n) { return n.toLocaleString('ru-RU') + ' ₽'; }

function sendTelegram(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  const url = 'https://api.telegram.org/bot' + CONFIG.telegramBotToken + '/sendMessage';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text, parse_mode: 'HTML' })
  }).then(res => res.text()).catch(err => console.warn('tg err', err));
}

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}
const bookingLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

function isValidDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isValidHour(h) { const n = parseInt(h, 10); return Number.isInteger(n) && n >= 0 && n <= 23; }
function isValidPhone(p) { return typeof p === 'string' && p.replace(/\D/g, '').length >= 10; }
function isValidSubdomain(s) { return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s); }

function authMiddleware(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  const parts = h.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'bad auth' });
  try {
    const payload = jwt.verify(parts[1], CONFIG.jwtSecret);
    req.user = payload; next();
  } catch (e) { return res.status(401).json({ error: 'invalid token' }); }
}

function resolveTenantId(req) {
  const subdomain = req.query.tenant || (req.hostname || '').split('.')[0];
  if (!subdomain || subdomain === 'demo-2-pkbp' || subdomain === 'localhost' || subdomain === 'www') return 1;
  const row = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(subdomain);
  return row ? row.id : 1;
}

app.get('/api/vertical', (req, res) => {
  const tid = resolveTenantId(req);
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services WHERE tenant_id = ? ORDER BY vehicle_class, id').all(tid);
  const classes = db.prepare('SELECT id,name FROM classes WHERE tenant_id = ? ORDER BY id').all(tid);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  res.json({
    services, classes,
    capacity: 2,
    businessName: tenant ? tenant.business_name : '',
    city: '',
    tenant_id: tid,
    vertical_code: tenant ? tenant.vertical_code : 'wash'
  });
});

app.get('/api/slots', (req, res) => {
  const tid = resolveTenantId(req);
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required (YYYY-MM-DD)' });
  const counts = {};
  const rows = db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? AND tenant_id = ? GROUP BY hour').all(date, 'confirmed', tid);
  rows.forEach(r => counts[r.hour] = r.cnt);
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, 2 - used) }); }
  res.json({ date, capacity: 2, slots });
});

app.post('/api/bookings', bookingLimiter, (req, res) => {
  const tid = resolveTenantId(req);
  const { name, phone, vehicle_class_id, service_ids, date, hour } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'invalid name' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid phone' });
  if (!Number.isInteger(vehicle_class_id)) return res.status(400).json({ error: 'invalid vehicle_class_id' });
  if (!Array.isArray(service_ids) || service_ids.length === 0 || !service_ids.every(Number.isInteger)) return res.status(400).json({ error: 'invalid service_ids' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
  if (!isValidHour(hour)) return res.status(400).json({ error: 'invalid hour' });

  try {
    const result = db.transaction(() => {
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=? AND tenant_id=?').get(date, hour, 'confirmed', tid);
      if (countRow.cnt >= 2) { const err = new Error('slot_full'); err.code = 'slot_full'; throw err; }

      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + service_ids.map(() => '?').join(',') + ') AND vehicle_class = ? AND tenant_id = ?');
      const svcRows = svcStmt.all(...service_ids, vehicle_class_id, tid);
      if (svcRows.length !== service_ids.length) { const err = new Error('invalid_services'); err.code = 'invalid_services'; throw err; }
      const total = svcRows.reduce((s, r) => s + r.price, 0);

      const bookingCode = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      const insert = db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at, tenant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      insert.run(bookingCode, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid);
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(bookingCode);
      const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(vehicle_class_id);
      return { rec, cls, svcRows };
    })();

    const { rec, cls, svcRows } = result;
    const svcNames = svcRows.map(r => r.name).join(', ');
    const msg = '🆕 <b>Новая запись</b>\n№ ' + rec.booking_code + '\n' + rec.name + ', ' + rec.phone + '\nКласс: ' + (cls ? cls.name : '') + '\nУслуги: ' + svcNames + '\nКогда: ' + date + ', ' + String(hour).padStart(2, '0') + ':00\nИтого: ' + rub(rec.total);
    sendTelegram(msg);
    res.json({ ok: true, booking: rec });
  } catch (e) {
    if (e.code === 'slot_full') return res.status(409).json({ error: 'slot_full' });
    if (e.code === 'invalid_services') return res.status(400).json({ error: 'invalid_services' });
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/bookings', (req, res) => {
  const tid = resolveTenantId(req);
  const phone = req.query.phone;
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'valid phone required' });
  const rows = db.prepare('SELECT * FROM bookings WHERE phone = ? AND tenant_id = ? ORDER BY created_at DESC').all(phone, tid);
  res.json({ bookings: rows });
});

app.delete('/api/bookings/:code', (req, res) => {
  const tid = resolveTenantId(req);
  const code = req.params.code; const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'phone required in body' });
  const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND phone = ? AND tenant_id = ?').get(code, phone, tid);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), rec.id);
  const msg = '❌ <b>Запись отменена</b>\n№ ' + rec.booking_code + ' · ' + rec.name + ', ' + rec.phone;
  sendTelegram(msg);
  res.json({ ok: true });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id || 1 }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token });
});

app.get('/api/admin/bookings', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  let rows;
  if (date) { rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ? ORDER BY b.hour').all(date, tid); }
  else { rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.tenant_id = ? ORDER BY b.created_at DESC LIMIT 200').all(tid); }
  res.json({ bookings: rows });
});

app.patch('/api/admin/bookings/:id', authMiddleware, (req, res) => {
  const id = req.params.id; const { assigned_washer_id, status } = req.body || {};
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(assigned_washer_id !== undefined ? assigned_washer_id : rec.assigned_washer_id, status || rec.status, new Date().toISOString(), id);
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/complete', authMiddleware, (req, res) => {
  const id = req.params.id;
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('completed', new Date().toISOString(), id);
  const msg = '🚗 <b>Машина готова</b>\n№ ' + rec.booking_code + '\n' + rec.name + ', ' + rec.phone + '\nМожно забирать!';
  sendTelegram(msg);
  res.json({ ok: true });
});

app.get('/api/admin/washers', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const rows = db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(tid);
  res.json({ washers: rows });
});

app.post('/api/admin/washers', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const { name, phone, commission } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO washers(name, phone, commission, tenant_id) VALUES(?,?,?,?)').run(
    name.trim(), (phone || '').trim(), commission !== undefined ? parseFloat(commission) : 0.5, tid
  );
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.patch('/api/admin/washers/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  const { name, phone, commission } = req.body || {};
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET name = ?, phone = ?, commission = ? WHERE id = ?').run(
    name !== undefined ? name : rec.name, phone !== undefined ? phone : rec.phone,
    commission !== undefined ? parseFloat(commission) : rec.commission, id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/washers/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const assigned = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE assigned_washer_id = ?').get(id);
  if (assigned && assigned.cnt > 0) return res.status(400).json({ error: 'washer_has_bookings', count: assigned.cnt });
  db.prepare('DELETE FROM washers WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/admin/fines', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const { washer_id, amount, reason } = req.body || {};
  if (!washer_id || amount === undefined) return res.status(400).json({ error: 'missing' });
  db.prepare('INSERT INTO fines(washer_id, amount, reason, created_at, tenant_id) VALUES(?,?,?,?,?)')
    .run(washer_id, amount, reason || '', new Date().toISOString(), tid);
  res.json({ ok: true });
});

app.get('/api/admin/reports/daily', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare(
    'SELECT w.id as washer_id, w.name as washer_name, w.commission, COUNT(b.id) as bookings_count, COALESCE(SUM(b.total),0) as total_sum ' +
    'FROM washers w LEFT JOIN bookings b ON b.assigned_washer_id = w.id AND b.date = ? AND b.status IN (?, ?) ' +
    'WHERE w.tenant_id = ? GROUP BY w.id'
  ).all(date, 'confirmed', 'completed', tid);
  const finesRows = db.prepare(
    'SELECT washer_id, COALESCE(SUM(amount),0) as fines_sum FROM fines WHERE date(created_at) = ? AND tenant_id = ? GROUP BY washer_id'
  ).all(date, tid);
  const finesByWasher = Object.fromEntries(finesRows.map(f => [f.washer_id, f.fines_sum]));
  const withFines = rows.map(r => ({
    ...r,
    fines_sum: finesByWasher[r.washer_id] || 0,
    payout: Math.round(r.total_sum * r.commission - (finesByWasher[r.washer_id] || 0))
  }));
  res.json({ date, rows: withFines });
});

app.get('/api/admin/services', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const rows = db.prepare('SELECT s.*, c.name as class_name FROM services s LEFT JOIN classes c ON c.id = s.vehicle_class WHERE s.tenant_id = ? ORDER BY s.vehicle_class, s.id').all(tid);
  res.json({ services: rows });
});

app.patch('/api/admin/services/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  const { price, name, duration } = req.body || {};
  const rec = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE services SET price = ?, name = ?, duration = ? WHERE id = ?').run(
    price !== undefined ? parseInt(price, 10) : rec.price,
    name !== undefined ? name : rec.name,
    duration !== undefined ? parseInt(duration, 10) : rec.duration,
    id
  );
  res.json({ ok: true });
});

app.get('/api/admin/export/bookings', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.booking_code, b.name, b.phone, c.name AS class_name, b.services_json, b.total, b.hour, b.status FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ?').all(date, tid);
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = ['code;name;phone;class;services;total;hour;status']
    .concat(rows.map(r => [r.booking_code, esc(r.name), r.phone, r.class_name, esc(r.services_json), r.total, r.hour, r.status].join(';')))
    .join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=bookings_' + date + '.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});

app.post('/api/washer/login', loginLimiter, (req, res) => {
  const { phone } = req.body || {};
  if (!phone || typeof phone !== 'string') return res.status(400).json({ error: 'phone required' });
  const tid = resolveTenantId(req);
  const normalized = phone.replace(/\D/g, '');
  const washer = db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(tid).find(function(w) {
    return (w.phone || '').replace(/\D/g, '') === normalized && normalized.length >= 10;
  });
  if (!washer) return res.status(401).json({ error: 'not_found' });
  const token = jwt.sign({ washer_id: washer.id, name: washer.name, role: 'washer', tenant_id: tid }, CONFIG.jwtSecret, { expiresIn: '14h' });
  res.json({ token: token, washer: { id: washer.id, name: washer.name, phone: washer.phone, commission: washer.commission } });
});

function washerAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  const parts = h.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'bad auth' });
  try {
    const payload = jwt.verify(parts[1], CONFIG.jwtSecret);
    if (payload.role !== 'washer') return res.status(403).json({ error: 'not washer' });
    req.washer = payload;
    next();
  } catch (e) { return res.status(401).json({ error: 'invalid token' }); }
}

app.get('/api/washer/bookings', washerAuth, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare(
    'SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id ' +
    'WHERE b.assigned_washer_id = ? AND b.date = ? ORDER BY b.hour'
  ).all(req.washer.washer_id, date);
  const finesRow = db.prepare('SELECT COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) = ?').get(req.washer.washer_id, date);
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  const confirmedOrDone = rows.filter(function(r) { return r.status === 'confirmed' || r.status === 'completed'; });
  const total_sum = confirmedOrDone.reduce(function(s, r) { return s + r.total; }, 0);
  const fines_sum = finesRow ? finesRow.sum : 0;
  const payout = Math.round(total_sum * (washer ? washer.commission : 0.5) - fines_sum);
  res.json({ date: date, bookings: rows, summary: { total_sum: total_sum, fines_sum: fines_sum, payout: payout, commission: washer ? washer.commission : 0.5 } });
});

app.post('/api/washer/bookings/:id/status', washerAuth, (req, res) => {
  const id = req.params.id;
  const { status } = req.body || {};
  if (status !== 'in_progress' && status !== 'completed') return res.status(400).json({ error: 'invalid status' });
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (rec.assigned_washer_id !== req.washer.washer_id) return res.status(403).json({ error: 'not your booking' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
  if (status === 'completed') {
    sendTelegram('🚗 <b>Машина готова</b>\n№ ' + rec.booking_code + '\n' + rec.name + ', ' + rec.phone + '\nМастер: ' + req.washer.name);
  }
  res.json({ ok: true });
});

app.get('/api/washer/earnings', washerAuth, (req, res) => {
  const washerId = req.washer.washer_id;
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(washerId);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const comm = washer.commission || 0.5;
  const iso = function(d) { return d.toISOString().slice(0, 10); };
  const today = iso(new Date());

  function sumForRange(fromDate, toDate) {
    const rows = db.prepare(
      'SELECT b.date, COALESCE(SUM(b.total),0) as day_sum, COUNT(b.id) as cnt FROM bookings b WHERE b.assigned_washer_id = ? AND b.date >= ? AND b.date <= ? AND b.status IN (?, ?) GROUP BY b.date ORDER BY b.date DESC'
    ).all(washerId, fromDate, toDate, 'confirmed', 'completed');
    const finesRows = db.prepare('SELECT date(created_at) as d, COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) >= ? AND date(created_at) <= ? GROUP BY date(created_at)').all(washerId, fromDate, toDate);
    const finesByDay = {};
    finesRows.forEach(function(f) { finesByDay[f.d] = f.sum; });
    let total_sum = 0, total_fines = 0, total_bookings = 0;
    const days = rows.map(function(r) {
      const fines = finesByDay[r.date] || 0;
      const share = Math.round(r.day_sum * comm);
      total_sum += r.day_sum; total_fines += fines; total_bookings += r.cnt;
      return { date: r.date, bookings: r.cnt, revenue: r.day_sum, share: share, fines: fines, payout: share - fines };
    });
    return { total_revenue: total_sum, total_fines: total_fines, total_bookings: total_bookings, total_share: Math.round(total_sum * comm), total_payout: Math.round(total_sum * comm) - total_fines, days: days };
  }

  const todayDate = new Date();
  const weekAgo = new Date(todayDate); weekAgo.setDate(weekAgo.getDate() - 6);
  const monthAgo = new Date(todayDate); monthAgo.setDate(monthAgo.getDate() - 29);
  res.json({ commission: comm, washer_name: washer.name, today: sumForRange(today, today), week: sumForRange(iso(weekAgo), today), month: sumForRange(iso(monthAgo), today) });
});

app.post('/api/washer/request-payout', washerAuth, (req, res) => {
  const washerId = req.washer.washer_id;
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(washerId);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const { amount, comment } = req.body || {};
  const amt = parseInt(amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid amount' });
  const msg = '💰 <b>Запрос выплаты</b>\nМойщик: ' + washer.name + '\nТелефон: ' + (washer.phone || '—') + '\nСумма: ' + amt.toLocaleString('ru-RU') + ' ₽' + (comment ? '\nКомментарий: ' + comment : '');
  sendTelegram(msg);
  res.json({ ok: true });
});

function studioAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  const parts = h.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'bad auth' });
  try {
    const payload = jwt.verify(parts[1], CONFIG.jwtSecret);
    if (payload.role !== 'studio') return res.status(403).json({ error: 'not studio' });
    req.studio = payload;
    next();
  } catch (e) { return res.status(401).json({ error: 'invalid token' }); }
}

app.post('/api/studio/login', loginLimiter, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const { license_key } = req.body || {};
  if (!license_key || typeof license_key !== 'string') return res.status(400).json({ error: 'license_key required' });
  const key = license_key.trim().toUpperCase();

  const license = platformDb.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!license) return res.status(401).json({ error: 'invalid_license' });
  if (license.status === 'revoked') return res.status(403).json({ error: 'revoked' });

  if (license.status === 'issued') {
    platformDb.prepare('UPDATE licenses SET status = ?, activated_at = ? WHERE id = ?')
      .run('active', new Date().toISOString(), license.id);
  }

  let studio = platformDb.prepare('SELECT * FROM studios WHERE license_key = ?').get(key);
  if (!studio) {
    const info = platformDb.prepare('INSERT INTO studios (subdomain, name, tier, license_key, commission_percent, max_tenants, max_verticals, status, created_at) VALUES (?, ?, ?, ?, 3.0, ?, ?, ?, ?)')
      .run('studio-' + license.id, 'Студия #' + license.id, license.tier, key, license.max_tenants, license.max_verticals, 'active', new Date().toISOString());
    studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(info.lastInsertRowid);
  }

  const token = jwt.sign({ studio_id: studio.id, tier: studio.tier, role: 'studio' }, CONFIG.jwtSecret, { expiresIn: '30d' });
  res.json({ token: token, studio: { id: studio.id, name: studio.name, tier: studio.tier, max_tenants: studio.max_tenants, max_verticals: studio.max_verticals, commission_percent: studio.commission_percent } });
});

app.get('/api/studio/me', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(req.studio.studio_id);
  if (!studio) return res.status(404).json({ error: 'not found' });
  res.json({ studio: studio });
});

app.get('/api/studio/verticals', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const rows = platformDb.prepare('SELECT code, name, entity_label, client_icon FROM verticals WHERE is_public = 1 ORDER BY sort_order').all();
  res.json({ verticals: rows });
});

app.get('/api/studio/tenants', studioAuth, (req, res) => {
  const studioId = req.studio.studio_id;
  const rows = db.prepare('SELECT * FROM tenants WHERE studio_id = ? ORDER BY created_at DESC').all(studioId);
  res.json({ tenants: rows });
});

app.post('/api/studio/tenants', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const studioId = req.studio.studio_id;
  const studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(studioId);
  if (!studio) return res.status(404).json({ error: 'studio_not_found' });

  const { subdomain, vertical_code, business_name, contact_name, contact_phone } = req.body || {};
  if (!isValidSubdomain(subdomain)) return res.status(400).json({ error: 'invalid_subdomain' });
  if (!vertical_code || typeof vertical_code !== 'string') return res.status(400).json({ error: 'vertical_required' });
  if (!business_name || !business_name.trim()) return res.status(400).json({ error: 'business_name_required' });

  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM tenants WHERE studio_id = ?').get(studioId);
  if (studio.max_tenants > 0 && countRow.cnt >= studio.max_tenants) {
    return res.status(400).json({ error: 'tenant_limit_reached', max: studio.max_tenants });
  }

  const exists = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(subdomain);
  if (exists) return res.status(409).json({ error: 'subdomain_taken' });

  const vertical = platformDb.prepare('SELECT * FROM verticals WHERE code = ?').get(vertical_code);
  if (!vertical) return res.status(400).json({ error: 'unknown_vertical' });

  try {
    const result = db.transaction(() => {
      const info = db.prepare('INSERT INTO tenants (studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(studioId, subdomain, vertical_code, business_name.trim(), (contact_name || '').trim(), (contact_phone || '').trim(), 'active', new Date().toISOString());
      const tenantId = info.lastInsertRowid;

      const preset = JSON.parse(vertical.default_services_json);
      const classIns = db.prepare('INSERT INTO classes (name, tenant_id) VALUES (?, ?)');
      const svcIns = db.prepare('INSERT INTO services (name, price, duration, vehicle
