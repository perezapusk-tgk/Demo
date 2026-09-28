/*
RapidLink — backend платформы записи. Монолитная версия.
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
let CONFIG = { jwtSecret: 'replace-me', telegramBotToken: '', telegramChatId: '', allowedOrigin: null };
if (fs.existsSync(CONFIG_FILE)) {
  try { CONFIG = Object.assign(CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE))); }
  catch (e) { console.warn('config err', e); }
}

const db = new Database(path.join(__dirname, 'app.db'));
let platformDb = null;
if (fs.existsSync(path.join(__dirname, 'platform.db'))) {
  platformDb = new Database(path.join(__dirname, 'platform.db'));
}

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

function rub(n) { return n.toLocaleString('ru-RU') + ' ₽'; }

function sendTelegram(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  fetch('https://api.telegram.org/bot' + CONFIG.telegramBotToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text, parse_mode: 'HTML' })
  }).then(r => r.text()).catch(e => console.warn('tg', e));
}

function rateLimit(opts) {
  const windowMs = opts.windowMs, max = opts.max;
  const hits = new Map();
  return function(req, res, next) {
    const k = req.ip, now = Date.now(), rec = hits.get(k);
    if (!rec || now - rec.start > windowMs) { hits.set(k, { start: now, count: 1 }); return next(); }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}
const loginLimiter = rateLimit({ windowMs: 60000, max: 10 });
const bookingLimiter = rateLimit({ windowMs: 60000, max: 10 });

function isValidDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isValidHour(h) { const n = parseInt(h, 10); return Number.isInteger(n) && n >= 0 && n <= 23; }
function isValidPhone(p) { return typeof p === 'string' && p.replace(/\D/g, '').length >= 10; }
function isValidSubdomain(s) { return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s); }

function authMiddleware(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    req.user = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}
function washerAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    if (p.role !== 'washer') return res.status(403).json({ error: 'not washer' });
    req.washer = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}
function studioAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    if (p.role !== 'studio') return res.status(403).json({ error: 'not studio' });
    req.studio = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}
function platformOwnerAuth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h) return res.status(401).json({ error: 'no auth' });
  try {
    const p = jwt.verify(h.split(' ')[1], CONFIG.jwtSecret);
    if (p.role !== 'platform_owner') return res.status(403).json({ error: 'not owner' });
    req.owner = p; next();
  } catch (e) { return res.status(401).json({ error: 'invalid' }); }
}

function resolveTenantId(req) {
  const s = req.query.tenant || (req.hostname || '').split('.')[0];
  if (!s || s === 'demo-2-pkbp' || s === 'localhost' || s === 'www') return 1;
  const row = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(s);
  return row ? row.id : 1;
}/* ============ ПУБЛИЧНЫЕ ============ */

app.get('/api/vertical', function(req, res) {
  const tid = resolveTenantId(req);
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services WHERE tenant_id = ? ORDER BY vehicle_class, id').all(tid);
  const classes = db.prepare('SELECT id,name FROM classes WHERE tenant_id = ? ORDER BY id').all(tid);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  res.json({ services, classes, capacity: 2, businessName: tenant ? tenant.business_name : '', city: '', tenant_id: tid, vertical_code: tenant ? tenant.vertical_code : 'wash' });
});

app.get('/api/slots', function(req, res) {
  const tid = resolveTenantId(req);
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const counts = {};
  db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? AND tenant_id = ? GROUP BY hour').all(date, 'confirmed', tid).forEach(function(r) { counts[r.hour] = r.cnt; });
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, 2 - used) }); }
  res.json({ date, capacity: 2, slots });
});

app.post('/api/bookings', bookingLimiter, function(req, res) {
  const tid = resolveTenantId(req);
  const body = req.body || {};
  const name = body.name, phone = body.phone, vehicle_class_id = body.vehicle_class_id;
  const service_ids = body.service_ids, date = body.date, hour = body.hour;
  if (!name || !name.trim() || name.length > 100) return res.status(400).json({ error: 'invalid name' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid phone' });
  if (!Number.isInteger(vehicle_class_id)) return res.status(400).json({ error: 'invalid vehicle_class_id' });
  if (!Array.isArray(service_ids) || !service_ids.length || !service_ids.every(Number.isInteger)) return res.status(400).json({ error: 'invalid service_ids' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
  if (!isValidHour(hour)) return res.status(400).json({ error: 'invalid hour' });
  try {
    const result = db.transaction(function() {
      const cnt = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=? AND tenant_id=?').get(date, hour, 'confirmed', tid);
      if (cnt.cnt >= 2) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }
      const placeholders = service_ids.map(function() { return '?'; }).join(',');
      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + placeholders + ') AND vehicle_class = ? AND tenant_id = ?');
      const svcRows = svcStmt.all.apply(svcStmt, service_ids.concat([vehicle_class_id, tid]));
      if (svcRows.length !== service_ids.length) { const e = new Error('invalid_services'); e.code = 'invalid_services'; throw e; }
      const total = svcRows.reduce(function(s, r) { return s + r.price; }, 0);
      const code = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at, tenant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(code, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid);
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
      const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(vehicle_class_id);
      return { rec: rec, cls: cls, svcRows: svcRows };
    })();
    const names = result.svcRows.map(function(r) { return r.name; }).join(', ');
    sendTelegram('🆕 <b>Новая запись</b>\n№ ' + result.rec.booking_code + '\n' + result.rec.name + ', ' + result.rec.phone + '\nКласс: ' + (result.cls ? result.cls.name : '') + '\nУслуги: ' + names + '\nКогда: ' + date + ', ' + String(hour).padStart(2, '0') + ':00\nИтого: ' + rub(result.rec.total));
    res.json({ ok: true, booking: result.rec });
  } catch (e) {
    if (e.code === 'slot_full') return res.status(409).json({ error: 'slot_full' });
    if (e.code === 'invalid_services') return res.status(400).json({ error: 'invalid_services' });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/bookings', function(req, res) {
  const tid = resolveTenantId(req);
  if (!isValidPhone(req.query.phone)) return res.status(400).json({ error: 'valid phone required' });
  res.json({ bookings: db.prepare('SELECT * FROM bookings WHERE phone = ? AND tenant_id = ? ORDER BY created_at DESC').all(req.query.phone, tid) });
});

app.delete('/api/bookings/:code', function(req, res) {
  const tid = resolveTenantId(req);
  const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND phone = ? AND tenant_id = ?').get(req.params.code, phone, tid);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), rec.id);
  sendTelegram('❌ <b>Отмена</b> № ' + rec.booking_code + ' · ' + rec.name);
  res.json({ ok: true });
});/* ============ АДМИН ТЕНАНТА ============ */

app.post('/api/admin/login', loginLimiter, function(req, res) {
  const body = req.body || {};
  const username = body.username, password = body.password;
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id || 1 }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token: token });
});

app.get('/api/admin/bookings', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  let rows;
  if (date) rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ? ORDER BY b.hour').all(date, tid);
  else rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.tenant_id = ? ORDER BY b.created_at DESC LIMIT 200').all(tid);
  res.json({ bookings: rows });
});

app.patch('/api/admin/bookings/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const assigned_washer_id = body.assigned_washer_id, status = body.status;
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?').run(assigned_washer_id !== undefined ? assigned_washer_id : rec.assigned_washer_id, status || rec.status, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/complete', authMiddleware, function(req, res) {
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('completed', new Date().toISOString(), rec.id);
  sendTelegram('🚗 <b>Готова</b> № ' + rec.booking_code + ' · ' + rec.name);
  res.json({ ok: true });
});

app.get('/api/admin/washers', authMiddleware, function(req, res) {
  res.json({ washers: db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(req.user.tenant_id || 1) });
});

app.post('/api/admin/washers', authMiddleware, function(req, res) {
  const body = req.body || {};
  const name = body.name, phone = body.phone, commission = body.commission;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO washers(name, phone, commission, tenant_id) VALUES(?,?,?,?)').run(name.trim(), (phone || '').trim(), commission !== undefined ? parseFloat(commission) : 0.5, req.user.tenant_id || 1);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.patch('/api/admin/washers/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const name = body.name, phone = body.phone, commission = body.commission;
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET name = ?, phone = ?, commission = ? WHERE id = ?').run(name !== undefined ? name : rec.name, phone !== undefined ? phone : rec.phone, commission !== undefined ? parseFloat(commission) : rec.commission, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/washers/:id', authMiddleware, function(req, res) {
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE assigned_washer_id = ?').get(req.params.id);
  if (cnt && cnt.c > 0) return res.status(400).json({ error: 'washer_has_bookings', count: cnt.c });
  db.prepare('DELETE FROM washers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/fines', authMiddleware, function(req, res) {
  const body = req.body || {};
  const washer_id = body.washer_id, amount = body.amount, reason = body.reason;
  if (!washer_id || amount === undefined) return res.status(400).json({ error: 'missing' });
  db.prepare('INSERT INTO fines(washer_id, amount, reason, created_at, tenant_id) VALUES(?,?,?,?,?)').run(washer_id, amount, reason || '', new Date().toISOString(), req.user.tenant_id || 1);
  res.json({ ok: true });
});

app.get('/api/admin/reports/daily', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT w.id as washer_id, w.name as washer_name, w.commission, COUNT(b.id) as bookings_count, COALESCE(SUM(b.total),0) as total_sum FROM washers w LEFT JOIN bookings b ON b.assigned_washer_id = w.id AND b.date = ? AND b.status IN (?, ?) WHERE w.tenant_id = ? GROUP BY w.id').all(date, 'confirmed', 'completed', tid);
  const finesRows = db.prepare('SELECT washer_id, COALESCE(SUM(amount),0) as fines_sum FROM fines WHERE date(created_at) = ? AND tenant_id = ? GROUP BY washer_id').all(date, tid);
  const fb = {};
  finesRows.forEach(function(f) { fb[f.washer_id] = f.fines_sum; });
  const result = rows.map(function(r) {
    const fines_sum = fb[r.washer_id] || 0;
    return { washer_id: r.washer_id, washer_name: r.washer_name, commission: r.commission, bookings_count: r.bookings_count, total_sum: r.total_sum, fines_sum: fines_sum, payout: Math.round(r.total_sum * r.commission - fines_sum) };
  });
  res.json({ date: date, rows: result });
});

app.get('/api/admin/services', authMiddleware, function(req, res) {
  res.json({ services: db.prepare('SELECT s.*, c.name as class_name FROM services s LEFT JOIN classes c ON c.id = s.vehicle_class WHERE s.tenant_id = ? ORDER BY s.vehicle_class, s.id').all(req.user.tenant_id || 1) });
});

app.patch('/api/admin/services/:id', authMiddleware, function(req, res) {
  const body = req.body || {};
  const price = body.price, name = body.name, duration = body.duration;
  const rec = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE services SET price = ?, name = ?, duration = ? WHERE id = ?').run(price !== undefined ? parseInt(price, 10) : rec.price, name !== undefined ? name : rec.name, duration !== undefined ? parseInt(duration, 10) : rec.duration, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/export/bookings', authMiddleware, function(req, res) {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.booking_code, b.name, b.phone, c.name AS class_name, b.services_json, b.total, b.hour, b.status FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ?').all(date, tid);
  const esc = function(s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
  const csv = ['code;name;phone;class;services;total;hour;status'].concat(rows.map(function(r) { return [r.booking_code, esc(r.name), r.phone, r.class_name, esc(r.services_json), r.total, r.hour, r.status].join(';'); })).join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=bookings_' + date + '.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});/* ============ КАБИНЕТ МОЙЩИКА ============ */

app.post('/api/washer/login', loginLimiter, function(req, res) {
  const body = req.body || {};
  const phone = body.phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const tid = resolveTenantId(req);
  const norm = phone.replace(/\D/g, '');
  const allWashers = db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(tid);
  const washer = allWashers.find(function(w) { return (w.phone || '').replace(/\D/g, '') === norm && norm.length >= 10; });
  if (!washer) return res.status(401).json({ error: 'not_found' });
  const token = jwt.sign({ washer_id: washer.id, name: washer.name, role: 'washer', tenant_id: tid }, CONFIG.jwtSecret, { expiresIn: '14h' });
  res.json({ token: token, washer: { id: washer.id, name: washer.name, phone: washer.phone, commission: washer.commission } });
});

app.get('/api/washer/bookings', washerAuth, function(req, res) {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.assigned_washer_id = ? AND b.date = ? ORDER BY b.hour').all(req.washer.washer_id, date);
  const finesRow = db.prepare('SELECT COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) = ?').get(req.washer.washer_id, date);
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  const ok = rows.filter(function(r) { return r.status === 'confirmed' || r.status === 'completed'; });
  const total_sum = ok.reduce(function(s, r) { return s + r.total; }, 0);
  const fines_sum = finesRow ? finesRow.sum : 0;
  const commission = washer ? washer.commission : 0.5;
  res.json({ date: date, bookings: rows, summary: { total_sum: total_sum, fines_sum: fines_sum, payout: Math.round(total_sum * commission - fines_sum), commission: commission } });
});

app.post('/api/washer/bookings/:id/status', washerAuth, function(req, res) {
  const status = (req.body || {}).status;
  if (status !== 'in_progress' && status !== 'completed') return res.status(400).json({ error: 'invalid status' });
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (rec.assigned_washer_id !== req.washer.washer_id) return res.status(403).json({ error: 'not your booking' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), rec.id);
  if (status === 'completed') sendTelegram('🚗 <b>Готова</b> № ' + rec.booking_code + ' · мастер ' + req.washer.name);
  res.json({ ok: true });
});

app.get('/api/washer/earnings', washerAuth, function(req, res) {
  const wid = req.washer.washer_id;
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(wid);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const comm = washer.commission || 0.5;
  const iso = function(d) { return d.toISOString().slice(0, 10); };
  const today = iso(new Date());
  function sumForRange(from, to) {
    const rows = db.prepare('SELECT b.date, COALESCE(SUM(b.total),0) as day_sum, COUNT(b.id) as cnt FROM bookings b WHERE b.assigned_washer_id = ? AND b.date >= ? AND b.date <= ? AND b.status IN (?, ?) GROUP BY b.date ORDER BY b.date DESC').all(wid, from, to, 'confirmed', 'completed');
    const finesRows = db.prepare('SELECT date(created_at) as d, COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) >= ? AND date(created_at) <= ? GROUP BY date(created_at)').all(wid, from, to);
    const fb = {};
    finesRows.forEach(function(f) { fb[f.d] = f.sum; });
    let ts = 0, tf = 0, tb = 0;
    const days = rows.map(function(r) {
      const fines = fb[r.date] || 0;
      const share = Math.round(r.day_sum * comm);
      ts += r.day_sum; tf += fines; tb += r.cnt;
      return { date: r.date, bookings: r.cnt, revenue: r.day_sum, share: share, fines: fines, payout: share - fines };
    });
    return { total_revenue: ts, total_fines: tf, total_bookings: tb, total_share: Math.round(ts * comm), total_payout: Math.round(ts * comm) - tf, days: days };
  }
  const t = new Date();
  const w = new Date(t); w.setDate(w.getDate() - 6);
  const m = new Date(t); m.setDate(m.getDate() - 29);
  res.json({ commission: comm, washer_name: washer.name, today: sumForRange(today, today), week: sumForRange(iso(w), today), month: sumForRange(iso(m), today) });
});

app.post('/api/washer/request-payout', washerAuth, function(req, res) {
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const amt = parseInt(body.amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid amount' });
  sendTelegram('💰 <b>Запрос выплаты</b>\n' + washer.name + '\n' + amt.toLocaleString('ru-RU') + ' ₽' + (body.comment ? '\n' + body.comment : ''));
  res.json({ ok: true });
});/* ============ СТУДИЯ ============ */

app.post('/api/studio/login', loginLimiter, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const key = (body.license_key || '').trim().toUpperCase();
  if (!key) return res.status(400).json({ error: 'license_key required' });
  const license = platformDb.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!license) return res.status(401).json({ error: 'invalid_license' });
  if (license.status === 'revoked') return res.status(403).json({ error: 'revoked' });
  if (license.status === 'issued') platformDb.prepare('UPDATE licenses SET status = ?, activated_at = ? WHERE id = ?').run('active', new Date().toISOString(), license.id);
  let studio = platformDb.prepare('SELECT * FROM studios WHERE license_key = ?').get(key);
  let isNewStudio = false;
  if (!studio) {
    const info = platformDb.prepare('INSERT INTO studios (subdomain, name, tier, license_key, commission_percent, max_tenants, max_verticals, status, created_at) VALUES (?, ?, ?, ?, 3.0, ?, ?, ?, ?)').run('studio-' + license.id, 'Студия #' + license.id, license.tier, key, license.max_tenants, license.max_verticals, 'active', new Date().toISOString());
    studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(info.lastInsertRowid);
    isNewStudio = true;
  }
  let demoTenantCreated = false;
  let demoLogin = null, demoPass = null;
  if (isNewStudio) {
    try {
      const existingDemo = db.prepare('SELECT id FROM tenants WHERE studio_id = ? AND subdomain LIKE ?').get(studio.id, 'demo-%');
      if (!existingDemo) {
        const demoSubdomainName = 'demo-' + studio.id;
        const demoVertical = platformDb.prepare('SELECT * FROM verticals WHERE code = ?').get('wash');
        if (demoVertical) {
          const demoResult = db.transaction(function() {
            const info = db.prepare('INSERT INTO tenants (studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(studio.id, demoSubdomainName, 'wash', 'Демо: Мойка на Ленина', 'Демо-владелец', '+79990000000', 'active', new Date().toISOString());
            const tenantId = info.lastInsertRowid;
            const preset = JSON.parse(demoVertical.default_services_json);
            const classIns = db.prepare('INSERT INTO classes (name, tenant_id) VALUES (?, ?)');
            const svcIns = db.prepare('INSERT INTO services (name, price, duration, vehicle_class, tenant_id) VALUES (?, ?, ?, ?, ?)');
            Object.keys(preset).forEach(function(entityName) {
              const services = preset[entityName];
              const cr = classIns.run(entityName, tenantId);
              Object.keys(services).forEach(function(svcName) {
                const arr = services[svcName];
                svcIns.run(svcName, arr[0], arr[1], cr.lastInsertRowid, tenantId);
              });
            });
            db.prepare('INSERT INTO washers (name, phone, commission, tenant_id) VALUES (?, ?, ?, ?)').run('Иван Петров', '+79001112233', 0.5, tenantId);
            db.prepare('INSERT INTO washers (name, phone, commission, tenant_id) VALUES (?, ?, ?, ?)').run('Пётр Сидоров', '+79004445566', 0.45, tenantId);
            const dl = 'demo_' + studio.id;
            const dp = 'demo' + Math.random().toString(36).slice(2, 8);
            db.prepare('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, ?)').run(dl, bcrypt.hashSync(dp, 10), 'admin', tenantId);
            const today = new Date().toISOString().slice(0, 10);
            const demoSvc = db.prepare('SELECT id, price FROM services WHERE tenant_id = ? LIMIT 2').all(tenantId);
            if (demoSvc.length > 0) {
              const total = demoSvc.reduce(function(s, x) { return s + x.price; }, 0);
              const svcIds = demoSvc.map(function(x) { return x.id; });
              const insBooking = db.prepare('INSERT INTO bookings (booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, assigned_washer_id, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
              insBooking.run('DEMO-01', 'Алексей', '+79001112233', demoSvc[0].id, JSON.stringify(svcIds), total, today, 10, 'confirmed', 1, new Date().toISOString(), tenantId);
              insBooking.run('DEMO-02', 'Мария', '+79004445566', demoSvc[0].id, JSON.stringify([svcIds[0]]), demoSvc[0].price, today, 14, 'confirmed', null, new Date().toISOString(), tenantId);
              insBooking.run('DEMO-03', 'Игорь', '+79007778899', demoSvc[0].id, JSON.stringify([svcIds[0]]), demoSvc[0].price, today, 16, 'completed', 1, new Date().toISOString(), tenantId);
            }
            return { login: dl, pass: dp };
          })();
          demoTenantCreated = true;
          demoLogin = demoResult.login;
          demoPass = demoResult.pass;
        }
      }
    } catch (e) {
      console.error('Demo tenant create error:', e);
    }
  }
  const token = jwt.sign({ studio_id: studio.id, tier: studio.tier, role: 'studio' }, CONFIG.jwtSecret, { expiresIn: '30d' });
  res.json({
    token: token,
    studio: { id: studio.id, name: studio.name, tier: studio.tier, max_tenants: studio.max_tenants, max_verticals: studio.max_verticals, commission_percent: studio.commission_percent },
    is_new: isNewStudio,
    demo_created: demoTenantCreated,
    demo_login: demoLogin,
    demo_password: demoPass
  });
});app.get('/api/studio/me', studioAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  res.json({ studio: platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(req.studio.studio_id) });
});

app.get('/api/studio/verticals', studioAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  res.json({ verticals: platformDb.prepare('SELECT code, name, entity_label, client_icon FROM verticals WHERE is_public = 1 ORDER BY sort_order').all() });
});

app.get('/api/studio/tenants', studioAuth, function(req, res) {
  res.json({ tenants: db.prepare('SELECT * FROM tenants WHERE studio_id = ? ORDER BY created_at DESC').all(req.studio.studio_id) });
});

app.post('/api/studio/tenants', studioAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const sid = req.studio.studio_id;
  const studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(sid);
  if (!studio) return res.status(404).json({ error: 'studio_not_found' });
  const body = req.body || {};
  const subdomain = body.subdomain, vertical_code = body.vertical_code, business_name = body.business_name;
  const contact_name = body.contact_name, contact_phone = body.contact_phone;
  if (!isValidSubdomain(subdomain)) return res.status(400).json({ error: 'invalid_subdomain' });
  if (!vertical_code) return res.status(400).json({ error: 'vertical_required' });
  if (!business_name || !business_name.trim()) return res.status(400).json({ error: 'business_name_required' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM tenants WHERE studio_id = ?').get(sid);
  if (studio.max_tenants > 0 && cnt.c >= studio.max_tenants) return res.status(400).json({ error: 'tenant_limit_reached', max: studio.max_tenants });
  if (db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(subdomain)) return res.status(409).json({ error: 'subdomain_taken' });
  const vertical = platformDb.prepare('SELECT * FROM verticals WHERE code = ?').get(vertical_code);
  if (!vertical) return res.status(400).json({ error: 'unknown_vertical' });
  try {
    const result = db.transaction(function() {
      const info = db.prepare('INSERT INTO tenants (studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sid, subdomain, vertical_code, business_name.trim(), (contact_name || '').trim(), (contact_phone || '').trim(), 'active', new Date().toISOString());
      const tid = info.lastInsertRowid;
      const preset = JSON.parse(vertical.default_services_json);
      const classIns = db.prepare('INSERT INTO classes (name, tenant_id) VALUES (?, ?)');
      const svcIns = db.prepare('INSERT INTO services (name, price, duration, vehicle_class, tenant_id) VALUES (?, ?, ?, ?, ?)');
      Object.keys(preset).forEach(function(entityName) {
        const services = preset[entityName];
        const cr = classIns.run(entityName, tid);
        Object.keys(services).forEach(function(svcName) {
          const arr = services[svcName];
          svcIns.run(svcName, arr[0], arr[1], cr.lastInsertRowid, tid);
        });
      });
      const login = 'admin_' + tid;
      const pass = 'rl' + Math.random().toString(36).slice(2, 10);
      db.prepare('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, ?)').run(login, bcrypt.hashSync(pass, 10), 'admin', tid);
      return { tid: tid, login: login, pass: pass };
    })();
    res.json({ ok: true, tenant_id: result.tid, admin_login: result.login, admin_password: result.pass, subdomain: subdomain });
  } catch (e) {
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});

app.delete('/api/studio/tenants/:id', studioAuth, function(req, res) {
  const rec = db.prepare('SELECT * FROM tenants WHERE id = ? AND studio_id = ?').get(req.params.id, req.studio.studio_id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run('archived', req.params.id);
  res.json({ ok: true });
});

/* ============ ВЛАДЕЛЕЦ ПЛАТФОРМЫ ============ */

app.post('/api/platform/login', loginLimiter, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const username = body.username, password = body.password;
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = platformDb.prepare('SELECT * FROM platform_admins WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: 'platform_owner' }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token: token });
});

app.get('/api/platform/summary', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const studiosCount = platformDb.prepare('SELECT COUNT(*) as c FROM studios').get().c;
  const tenantsCount = db.prepare('SELECT COUNT(*) as c FROM tenants').get().c;
  const revRow = db.prepare('SELECT COALESCE(SUM(total),0) as sum FROM bookings WHERE status IN (?, ?)').get('confirmed', 'completed');
  const totalRevenue = revRow ? revRow.sum : 0;
  res.json({ studios_count: studiosCount, tenants_count: tenantsCount, total_revenue: totalRevenue, platform_commission: Math.round(totalRevenue * 0.03) });
});

app.get('/api/platform/studios', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const studios = platformDb.prepare('SELECT * FROM studios ORDER BY created_at DESC').all();
  const enriched = studios.map(function(s) {
    const cntRow = db.prepare('SELECT COUNT(*) as c FROM tenants WHERE studio_id = ?').get(s.id);
    const revRow = db.prepare('SELECT COALESCE(SUM(total),0) as sum FROM bookings WHERE tenant_id IN (SELECT id FROM tenants WHERE studio_id = ?) AND status IN (?, ?)').get(s.id, 'confirmed', 'completed');
    const rev = revRow ? revRow.sum : 0;
    return { id: s.id, subdomain: s.subdomain, name: s.name, tier: s.tier, license_key: s.license_key, commission_percent: s.commission_percent, status: s.status, created_at: s.created_at, tenants_count: cntRow ? cntRow.c : 0, revenue: rev, commission_amount: Math.round(rev * (s.commission_percent / 100)) };
  });
  res.json({ studios: enriched });
});

app.get('/api/platform/licenses', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const licenses = platformDb.prepare('SELECT * FROM licenses ORDER BY id DESC').all();
  const enriched = licenses.map(function(l) {
    let studioName = null;
    if (l.studio_id) {
      const s = platformDb.prepare('SELECT name FROM studios WHERE id = ?').get(l.studio_id);
      if (s) studioName = s.name;
    }
    return { id: l.id, key: l.key, tier: l.tier, status: l.status, max_tenants: l.max_tenants, max_verticals: l.max_verticals, studio_id: l.studio_id, studio_name: studioName, created_at: l.created_at };
  });
  res.json({ licenses: enriched });
});app.post('/api/platform/licenses', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const tier = body.tier, count = body.count, notes = body.notes;
  if (['start', 'business', 'enterprise'].indexOf(tier) === -1) return res.status(400).json({ error: 'invalid_tier' });
  const cnt = Math.max(1, Math.min(100, parseInt(count, 10) || 1));
  const limits = { start: [10, 1], business: [100, 10], enterprise: [-1, -1] };
  const max_tenants = limits[tier][0], max_verticals = limits[tier][1];
  const prefixes = { start: 'STRT', business: 'BIZN', enterprise: 'ENTR' };
  const crypto = require('crypto');
  const generated = [];
  const ins = platformDb.prepare('INSERT INTO licenses (key, tier, max_tenants, max_verticals, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < cnt; i++) {
    const part = function() { return crypto.randomBytes(2).toString('hex').toUpperCase(); };
    const key = 'RPLK-' + prefixes[tier] + '-' + part() + '-' + part() + '-' + part();
    ins.run(key, tier, max_tenants, max_verticals, 'issued', notes || ('Пакет ' + cnt + ' шт.'), new Date().toISOString());
    generated.push(key);
  }
  res.json({ ok: true, keys: generated, tier: tier, count: cnt });
});

app.patch('/api/platform/licenses/:id', platformOwnerAuth, function(req, res) {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const body = req.body || {};
  const status = body.status;
  if (['issued', 'active', 'revoked'].indexOf(status) === -1) return res.status(400).json({ error: 'invalid_status' });
  const rec = platformDb.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  platformDb.prepare('UPDATE licenses SET status = ? WHERE id = ?').run(status, req.params.id);
  if (status === 'revoked') {
    platformDb.prepare('UPDATE studios SET status = ? WHERE license_key = ?').run('suspended', rec.key);
  }
  res.json({ ok: true });
});

/* ============ ЗАПУСК ============ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
