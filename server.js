/*
Express backend + SQLite for the booking system.
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
const app = express();
app.set('trust proxy', true);
app.use(CONFIG.allowedOrigin ? cors({ origin: CONFIG.allowedOrigin }) : cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function rub(n) { return n.toLocaleString('ru-RU') + ' ₽'; }

function sendTelegram(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
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

app.get('/api/vertical', (req, res) => {
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services ORDER BY vehicle_class, id').all();
  const classes = db.prepare('SELECT id,name FROM classes ORDER BY id').all();
  const capacityRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('capacity');
  const nameRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('business_name');
  const cityRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('city');
  res.json({
    services, classes,
    capacity: capacityRow ? parseInt(capacityRow.value, 10) : 2,
    businessName: nameRow ? nameRow.value : '',
    city: cityRow ? cityRow.value : ''
  });
});

app.get('/api/slots', (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required (YYYY-MM-DD)' });
  const capacityRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('capacity');
  const capacity = capacityRow ? parseInt(capacityRow.value, 10) : 2;
  const counts = {};
  const rows = db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? GROUP BY hour').all(date, 'confirmed');
  rows.forEach(r => counts[r.hour] = r.cnt);
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, capacity - used) }); }
  res.json({ date, capacity, slots });
});

app.post('/api/bookings', bookingLimiter, (req, res) => {
  const { name, phone, vehicle_class_id, service_ids, date, hour } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'invalid name' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid phone' });
  if (!Number.isInteger(vehicle_class_id)) return res.status(400).json({ error: 'invalid vehicle_class_id' });
  if (!Array.isArray(service_ids) || service_ids.length === 0 || !service_ids.every(Number.isInteger)) return res.status(400).json({ error: 'invalid service_ids' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
  if (!isValidHour(hour)) return res.status(400).json({ error: 'invalid hour' });

  try {
    const result = db.transaction(() => {
      const capacity = parseInt((db.prepare('SELECT value FROM kv WHERE key=?').get('capacity') || {}).value || 2, 10);
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=?').get(date, hour, 'confirmed');
      if (countRow.cnt >= capacity) { const err = new Error('slot_full'); err.code = 'slot_full'; throw err; }

      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + service_ids.map(() => '?').join(',') + ') AND vehicle_class = ?');
      const svcRows = svcStmt.all(...service_ids, vehicle_class_id);
      if (svcRows.length !== service_ids.length) { const err = new Error('invalid_services'); err.code = 'invalid_services'; throw err; }
      const total = svcRows.reduce((s, r) => s + r.price, 0);

      const bookingCode = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      const insert = db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      insert.run(bookingCode, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString());
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(bookingCode);
      const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(vehicle_class_id);
      return { rec, cls, svcRows };
    })();

    const { rec, cls, svcRows } = result;
    const svcNames = svcRows.map(r => r.name).join(', ');
    const msg = `🆕 <b>Новая запись</b>\n№ ${rec.booking_code}\n${rec.name}, ${rec.phone}\nКласс: ${cls ? cls.name : ''}\nУслуги: ${svcNames}\nКогда: ${date}, ${String(hour).padStart(2, '0')}:00\nИтого: ${rub(rec.total)}`;
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
  const phone = req.query.phone;
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'valid phone required' });
  const rows = db.prepare('SELECT * FROM bookings WHERE phone = ? ORDER BY created_at DESC').all(phone);
  res.json({ bookings: rows });
});

app.delete('/api/bookings/:code', (req, res) => {
  const code = req.params.code; const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'phone required in body' });
  const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND phone = ?').get(code, phone);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), rec.id);
  const msg = `❌ <b>Запись отменена</b>\n№ ${rec.booking_code} · ${rec.name}, ${rec.phone}`;
  sendTelegram(msg);
  res.json({ ok: true });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token });
});

app.get('/api/admin/bookings', authMiddleware, (req, res) => {
  const date = req.query.date;
  let rows;
  if (date) { rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? ORDER BY b.hour').all(date); }
  else { rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id ORDER BY b.created_at DESC LIMIT 200').all(); }
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

app.get('/api/admin/washers', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM washers').all(); res.json({ washers: rows });
});

app.post('/api/admin/fines', authMiddleware, (req, res) => {
  const { washer_id, amount, reason } = req.body || {};
  if (!washer_id || amount === undefined) return res.status(400).json({ error: 'missing' });
  db.prepare('INSERT INTO fines(washer_id, amount, reason, created_at) VALUES(?,?,?,?)').run(washer_id, amount, reason || '', new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/admin/fines', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT f.*, w.name as washer_name FROM fines f LEFT JOIN washers w ON w.id = f.washer_id ORDER BY f.created_at DESC LIMIT 200').all();
  res.json({ fines: rows });
});

app.get('/api/admin/reports/daily', authMiddleware, (req, res) => {
  const date = req.query.date; if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare(`
    SELECT w.id as washer_id, w.name as washer_name, w.commission,
           COUNT(b.id) as bookings_count, COALESCE(SUM(b.total),0) as total_sum
    FROM washers w
    LEFT JOIN bookings b ON b.assigned_washer_id = w.id AND b.date = ? AND b.status = ?
    GROUP BY w.id
  `).all(date, 'confirmed');
  const finesRows = db.prepare(`
    SELECT washer_id, COALESCE(SUM(amount),0) as fines_sum
    FROM fines WHERE date(created_at) = ? GROUP BY washer_id
  `).all(date);
  const finesByWasher = Object.fromEntries(finesRows.map(f => [f.washer_id, f.fines_sum]));
  const withFines = rows.map(r => ({
    ...r,
    fines_sum: finesByWasher[r.washer_id] || 0,
    payout: Math.round(r.total_sum * r.commission - (finesByWasher[r.washer_id] || 0))
  }));
  res.json({ date, rows: withFines });
});

app.get('/api/admin/export/bookings', authMiddleware, (req, res) => {
  const date = req.query.date; if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.booking_code, b.name, b.phone, c.name AS class_name, b.services_json, b.total, b.hour, b.status FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ?').all(date);
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = ['code;name;phone;class;services;total;hour;status']
    .concat(rows.map(r => [r.booking_code, esc(r.name), r.phone, r.class_name, esc(r.services_json), r.total, r.hour, r.status].join(';')))
    .join('\n');
  res.setHeader('Content-disposition', `attachment; filename=bookings_${date}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));/*
Express backend + SQLite for the booking system.
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
const app = express();
app.set('trust proxy', true);
app.use(CONFIG.allowedOrigin ? cors({ origin: CONFIG.allowedOrigin }) : cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function rub(n) { return n.toLocaleString('ru-RU') + ' ₽'; }

function sendTelegram(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
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

app.get('/api/vertical', (req, res) => {
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services ORDER BY vehicle_class, id').all();
  const classes = db.prepare('SELECT id,name FROM classes ORDER BY id').all();
  const capacityRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('capacity');
  const nameRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('business_name');
  const cityRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('city');
  res.json({
    services, classes,
    capacity: capacityRow ? parseInt(capacityRow.value, 10) : 2,
    businessName: nameRow ? nameRow.value : '',
    city: cityRow ? cityRow.value : ''
  });
});

app.get('/api/slots', (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required (YYYY-MM-DD)' });
  const capacityRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('capacity');
  const capacity = capacityRow ? parseInt(capacityRow.value, 10) : 2;
  const counts = {};
  const rows = db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? GROUP BY hour').all(date, 'confirmed');
  rows.forEach(r => counts[r.hour] = r.cnt);
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, capacity - used) }); }
  res.json({ date, capacity, slots });
});

app.post('/api/bookings', bookingLimiter, (req, res) => {
  const { name, phone, vehicle_class_id, service_ids, date, hour } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'invalid name' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid phone' });
  if (!Number.isInteger(vehicle_class_id)) return res.status(400).json({ error: 'invalid vehicle_class_id' });
  if (!Array.isArray(service_ids) || service_ids.length === 0 || !service_ids.every(Number.isInteger)) return res.status(400).json({ error: 'invalid service_ids' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
  if (!isValidHour(hour)) return res.status(400).json({ error: 'invalid hour' });

  try {
    const result = db.transaction(() => {
      const capacity = parseInt((db.prepare('SELECT value FROM kv WHERE key=?').get('capacity') || {}).value || 2, 10);
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=?').get(date, hour, 'confirmed');
      if (countRow.cnt >= capacity) { const err = new Error('slot_full'); err.code = 'slot_full'; throw err; }

      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + service_ids.map(() => '?').join(',') + ') AND vehicle_class = ?');
      const svcRows = svcStmt.all(...service_ids, vehicle_class_id);
      if (svcRows.length !== service_ids.length) { const err = new Error('invalid_services'); err.code = 'invalid_services'; throw err; }
      const total = svcRows.reduce((s, r) => s + r.price, 0);

      const bookingCode = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      const insert = db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      insert.run(bookingCode, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString());
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(bookingCode);
      const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(vehicle_class_id);
      return { rec, cls, svcRows };
    })();

    const { rec, cls, svcRows } = result;
    const svcNames = svcRows.map(r => r.name).join(', ');
    const msg = `🆕 <b>Новая запись</b>\n№ ${rec.booking_code}\n${rec.name}, ${rec.phone}\nКласс: ${cls ? cls.name : ''}\nУслуги: ${svcNames}\nКогда: ${date}, ${String(hour).padStart(2, '0')}:00\nИтого: ${rub(rec.total)}`;
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
  const phone = req.query.phone;
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'valid phone required' });
  const rows = db.prepare('SELECT * FROM bookings WHERE phone = ? ORDER BY created_at DESC').all(phone);
  res.json({ bookings: rows });
});

app.delete('/api/bookings/:code', (req, res) => {
  const code = req.params.code; const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'phone required in body' });
  const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND phone = ?').get(code, phone);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), rec.id);
  const msg = `❌ <b>Запись отменена</b>\n№ ${rec.booking_code} · ${rec.name}, ${rec.phone}`;
  sendTelegram(msg);
  res.json({ ok: true });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token });
});

app.get('/api/admin/bookings', authMiddleware, (req, res) => {
  const date = req.query.date;
  let rows;
  if (date) { rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? ORDER BY b.hour').all(date); }
  else { rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id ORDER BY b.created_at DESC LIMIT 200').all(); }
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

app.get('/api/admin/washers', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM washers').all(); res.json({ washers: rows });
});

app.post('/api/admin/fines', authMiddleware, (req, res) => {
  const { washer_id, amount, reason } = req.body || {};
  if (!washer_id || amount === undefined) return res.status(400).json({ error: 'missing' });
  db.prepare('INSERT INTO fines(washer_id, amount, reason, created_at) VALUES(?,?,?,?)').run(washer_id, amount, reason || '', new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/admin/fines', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT f.*, w.name as washer_name FROM fines f LEFT JOIN washers w ON w.id = f.washer_id ORDER BY f.created_at DESC LIMIT 200').all();
  res.json({ fines: rows });
});

app.get('/api/admin/reports/daily', authMiddleware, (req, res) => {
  const date = req.query.date; if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare(`
    SELECT w.id as washer_id, w.name as washer_name, w.commission,
           COUNT(b.id) as bookings_count, COALESCE(SUM(b.total),0) as total_sum
    FROM washers w
    LEFT JOIN bookings b ON b.assigned_washer_id = w.id AND b.date = ? AND b.status = ?
    GROUP BY w.id
  `).all(date, 'confirmed');
  const finesRows = db.prepare(`
    SELECT washer_id, COALESCE(SUM(amount),0) as fines_sum
    FROM fines WHERE date(created_at) = ? GROUP BY washer_id
  `).all(date);
  const finesByWasher = Object.fromEntries(finesRows.map(f => [f.washer_id, f.fines_sum]));
  const withFines = rows.map(r => ({
    ...r,
    fines_sum: finesByWasher[r.washer_id] || 0,
    payout: Math.round(r.total_sum * r.commission - (finesByWasher[r.washer_id] || 0))
  }));
  res.json({ date, rows: withFines });
});

app.get('/api/admin/export/bookings', authMiddleware, (req, res) => {
  const date = req.query.date; if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.booking_code, b.name, b.phone, c.name AS class_name, b.services_json, b.total, b.hour, b.status FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ?').all(date);
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const csv = ['code;name;phone;class;services;total;hour;status']
    .concat(rows.map(r => [r.booking_code, esc(r.name), r.phone, r.class_name, esc(r.services_json), r.total, r.hour, r.status].join(';')))
    .join('\n');
  res.setHeader('Content-disposition', `attachment; filename=bookings_${date}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
