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
app.use(express.static(path.join(__dirname, 'public')));

function rub(n) { return n.toLocaleString('ru-RU') + ' ₽'; }

function sendTelegram(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  fetch('https://api.telegram.org/bot' + CONFIG.telegramBotToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text, parse_mode: 'HTML' })
  }).then(r => r.text()).catch(e => console.warn('tg', e));
}

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
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

function resolveTenantId(req) {
  const s = req.query.tenant || (req.hostname || '').split('.')[0];
  if (!s || s === 'demo-2-pkbp' || s === 'localhost' || s === 'www') return 1;
  const row = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(s);
  return row ? row.id : 1;
              }
/* ============ ПУБЛИЧНЫЕ ============ */

app.get('/api/vertical', (req, res) => {
  const tid = resolveTenantId(req);
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services WHERE tenant_id = ? ORDER BY vehicle_class, id').all(tid);
  const classes = db.prepare('SELECT id,name FROM classes WHERE tenant_id = ? ORDER BY id').all(tid);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  res.json({ services, classes, capacity: 2, businessName: tenant ? tenant.business_name : '', city: '', tenant_id: tid, vertical_code: tenant ? tenant.vertical_code : 'wash' });
});

app.get('/api/slots', (req, res) => {
  const tid = resolveTenantId(req);
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const counts = {};
  db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? AND tenant_id = ? GROUP BY hour').all(date, 'confirmed', tid).forEach(r => counts[r.hour] = r.cnt);
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, 2 - used) }); }
  res.json({ date, capacity: 2, slots });
});

app.post('/api/bookings', bookingLimiter, (req, res) => {
  const tid = resolveTenantId(req);
  const { name, phone, vehicle_class_id, service_ids, date, hour } = req.body || {};
  if (!name || !name.trim() || name.length > 100) return res.status(400).json({ error: 'invalid name' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'invalid phone' });
  if (!Number.isInteger(vehicle_class_id)) return res.status(400).json({ error: 'invalid vehicle_class_id' });
  if (!Array.isArray(service_ids) || !service_ids.length || !service_ids.every(Number.isInteger)) return res.status(400).json({ error: 'invalid service_ids' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
  if (!isValidHour(hour)) return res.status(400).json({ error: 'invalid hour' });
  try {
    const result = db.transaction(() => {
      const cnt = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=? AND tenant_id=?').get(date, hour, 'confirmed', tid);
      if (cnt.cnt >= 2) { const e = new Error('slot_full'); e.code = 'slot_full'; throw e; }
      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + service_ids.map(() => '?').join(',') + ') AND vehicle_class = ? AND tenant_id = ?');
      const svcRows = svcStmt.all(...service_ids, vehicle_class_id, tid);
      if (svcRows.length !== service_ids.length) { const e = new Error('invalid_services'); e.code = 'invalid_services'; throw e; }
      const total = svcRows.reduce((s, r) => s + r.price, 0);
      const code = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at, tenant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(code, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid);
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
      const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(vehicle_class_id);
      return { rec, cls, svcRows };
    })();
    const { rec, cls, svcRows } = result;
    const names = svcRows.map(r => r.name).join(', ');
    sendTelegram('🆕 <b>Новая запись</b>\n№ ' + rec.booking_code + '\n' + rec.name + ', ' + rec.phone + '\nКласс: ' + (cls ? cls.name : '') + '\nУслуги: ' + names + '\nКогда: ' + date + ', ' + String(hour).padStart(2, '0') + ':00\nИтого: ' + rub(rec.total));
    res.json({ ok: true, booking: rec });
  } catch (e) {
    if (e.code === 'slot_full') return res.status(409).json({ error: 'slot_full' });
    if (e.code === 'invalid_services') return res.status(400).json({ error: 'invalid_services' });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/bookings', (req, res) => {
  const tid = resolveTenantId(req);
  if (!isValidPhone(req.query.phone)) return res.status(400).json({ error: 'valid phone required' });
  res.json({ bookings: db.prepare('SELECT * FROM bookings WHERE phone = ? AND tenant_id = ? ORDER BY created_at DESC').all(req.query.phone, tid) });
});

app.delete('/api/bookings/:code', (req, res) => {
  const tid = resolveTenantId(req);
  const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND phone = ? AND tenant_id = ?').get(req.params.code, phone, tid);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), rec.id);
  sendTelegram('❌ <b>Отмена</b> № ' + rec.booking_code + ' · ' + rec.name);
  res.json({ ok: true });
});

/* ============ АДМИН ТЕНАНТА ============ */

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
  if (date) rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ? ORDER BY b.hour').all(date, tid);
  else rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.tenant_id = ? ORDER BY b.created_at DESC LIMIT 200').all(tid);
  res.json({ bookings: rows });
});

app.patch('/api/admin/bookings/:id', authMiddleware, (req, res) => {
  const { assigned_washer_id, status } = req.body || {};
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?').run(assigned_washer_id !== undefined ? assigned_washer_id : rec.assigned_washer_id, status || rec.status, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/bookings/:id/complete', authMiddleware, (req, res) => {
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('completed', new Date().toISOString(), rec.id);
  sendTelegram('🚗 <b>Готова</b> № ' + rec.booking_code + ' · ' + rec.name);
  res.json({ ok: true });
});

app.get('/api/admin/washers', authMiddleware, (req, res) => {
  res.json({ washers: db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(req.user.tenant_id || 1) });
});

app.post('/api/admin/washers', authMiddleware, (req, res) => {
  const { name, phone, commission } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO washers(name, phone, commission, tenant_id) VALUES(?,?,?,?)').run(name.trim(), (phone || '').trim(), commission !== undefined ? parseFloat(commission) : 0.5, req.user.tenant_id || 1);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.patch('/api/admin/washers/:id', authMiddleware, (req, res) => {
  const { name, phone, commission } = req.body || {};
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET name = ?, phone = ?, commission = ? WHERE id = ?').run(name !== undefined ? name : rec.name, phone !== undefined ? phone : rec.phone, commission !== undefined ? parseFloat(commission) : rec.commission, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/washers/:id', authMiddleware, (req, res) => {
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE assigned_washer_id = ?').get(req.params.id);
  if (cnt && cnt.c > 0) return res.status(400).json({ error: 'washer_has_bookings', count: cnt.c });
  db.prepare('DELETE FROM washers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/fines', authMiddleware, (req, res) => {
  const { washer_id, amount, reason } = req.body || {};
  if (!washer_id || amount === undefined) return res.status(400).json({ error: 'missing' });
  db.prepare('INSERT INTO fines(washer_id, amount, reason, created_at, tenant_id) VALUES(?,?,?,?,?)').run(washer_id, amount, reason || '', new Date().toISOString(), req.user.tenant_id || 1);
  res.json({ ok: true });
});

app.get('/api/admin/reports/daily', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT w.id as washer_id, w.name as washer_name, w.commission, COUNT(b.id) as bookings_count, COALESCE(SUM(b.total),0) as total_sum FROM washers w LEFT JOIN bookings b ON b.assigned_washer_id = w.id AND b.date = ? AND b.status IN (?, ?) WHERE w.tenant_id = ? GROUP BY w.id').all(date, 'confirmed', 'completed', tid);
  const finesRows = db.prepare('SELECT washer_id, COALESCE(SUM(amount),0) as fines_sum FROM fines WHERE date(created_at) = ? AND tenant_id = ? GROUP BY washer_id').all(date, tid);
  const fb = {};
  finesRows.forEach(f => fb[f.washer_id] = f.fines_sum);
  res.json({ date, rows: rows.map(r => ({ ...r, fines_sum: fb[r.washer_id] || 0, payout: Math.round(r.total_sum * r.commission - (fb[r.washer_id] || 0)) })) });
});

app.get('/api/admin/services', authMiddleware, (req, res) => {
  res.json({ services: db.prepare('SELECT s.*, c.name as class_name FROM services s LEFT JOIN classes c ON c.id = s.vehicle_class WHERE s.tenant_id = ? ORDER BY s.vehicle_class, s.id').all(req.user.tenant_id || 1) });
});

app.patch('/api/admin/services/:id', authMiddleware, (req, res) => {
  const { price, name, duration } = req.body || {};
  const rec = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE services SET price = ?, name = ?, duration = ? WHERE id = ?').run(price !== undefined ? parseInt(price, 10) : rec.price, name !== undefined ? name : rec.name, duration !== undefined ? parseInt(duration, 10) : rec.duration, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/export/bookings', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.booking_code, b.name, b.phone, c.name AS class_name, b.services_json, b.total, b.hour, b.status FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ?').all(date, tid);
  const esc = s => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = ['code;name;phone;class;services;total;hour;status'].concat(rows.map(r => [r.booking_code, esc(r.name), r.phone, r.class_name, esc(r.services_json), r.total, r.hour, r.status].join(';'))).join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=bookings_' + date + '.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});
/* ============ КАБИНЕТ МОЙЩИКА ============ */

app.post('/api/washer/login', loginLimiter, (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const tid = resolveTenantId(req);
  const norm = phone.replace(/\D/g, '');
  const washer = db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(tid).find(w => (w.phone || '').replace(/\D/g, '') === norm && norm.length >= 10);
  if (!washer) return res.status(401).json({ error: 'not_found' });
  const token = jwt.sign({ washer_id: washer.id, name: washer.name, role: 'washer', tenant_id: tid }, CONFIG.jwtSecret, { expiresIn: '14h' });
  res.json({ token, washer: { id: washer.id, name: washer.name, phone: washer.phone, commission: washer.commission } });
});

app.get('/api/washer/bookings', washerAuth, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.assigned_washer_id = ? AND b.date = ? ORDER BY b.hour').all(req.washer.washer_id, date);
  const finesRow = db.prepare('SELECT COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) = ?').get(req.washer.washer_id, date);
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  const ok = rows.filter(r => r.status === 'confirmed' || r.status === 'completed');
  const total_sum = ok.reduce((s, r) => s + r.total, 0);
  const fines_sum = finesRow ? finesRow.sum : 0;
  const commission = washer ? washer.commission : 0.5;
  res.json({ date, bookings: rows, summary: { total_sum, fines_sum, payout: Math.round(total_sum * commission - fines_sum), commission } });
});

app.post('/api/washer/bookings/:id/status', washerAuth, (req, res) => {
  const { status } = req.body || {};
  if (status !== 'in_progress' && status !== 'completed') return res.status(400).json({ error: 'invalid status' });
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (rec.assigned_washer_id !== req.washer.washer_id) return res.status(403).json({ error: 'not your booking' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), rec.id);
  if (status === 'completed') sendTelegram('🚗 <b>Готова</b> № ' + rec.booking_code + ' · мастер ' + req.washer.name);
  res.json({ ok: true });
});

app.get('/api/washer/earnings', washerAuth, (req, res) => {
  const wid = req.washer.washer_id;
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(wid);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const comm = washer.commission || 0.5;
  const iso = d => d.toISOString().slice(0, 10);
  const today = iso(new Date());
  function sumForRange(from, to) {
    const rows = db.prepare('SELECT b.date, COALESCE(SUM(b.total),0) as day_sum, COUNT(b.id) as cnt FROM bookings b WHERE b.assigned_washer_id = ? AND b.date >= ? AND b.date <= ? AND b.status IN (?, ?) GROUP BY b.date ORDER BY b.date DESC').all(wid, from, to, 'confirmed', 'completed');
    const finesRows = db.prepare('SELECT date(created_at) as d, COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) >= ? AND date(created_at) <= ? GROUP BY date(created_at)').all(wid, from, to);
    const fb = {}; finesRows.forEach(f => fb[f.d] = f.sum);
    let ts = 0, tf = 0, tb = 0;
    const days = rows.map(r => {
      const fines = fb[r.date] || 0;
      const share = Math.round(r.day_sum * comm);
      ts += r.day_sum; tf += fines; tb += r.cnt;
      return { date: r.date, bookings: r.cnt, revenue: r.day_sum, share, fines, payout: share - fines };
    });
    return { total_revenue: ts, total_fines: tf, total_bookings: tb, total_share: Math.round(ts * comm), total_payout: Math.round(ts * comm) - tf, days };
  }
  const t = new Date();
  const w = new Date(t); w.setDate(w.getDate() - 6);
  const m = new Date(t); m.setDate(m.getDate() - 29);
  res.json({ commission: comm, washer_name: washer.name, today: sumForRange(today, today), week: sumForRange(iso(w), today), month: sumForRange(iso(m), today) });
});

app.post('/api/washer/request-payout', washerAuth, (req, res) => {
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const amt = parseInt((req.body || {}).amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid amount' });
  sendTelegram('💰 <b>Запрос выплаты</b>\n' + washer.name + '\n' + amt.toLocaleString('ru-RU') + ' ₽' + ((req.body || {}).comment ? '\n' + req.body.comment : ''));
  res.json({ ok: true });
});
/* ============ СТУДИЯ ============ */

app.post('/api/studio/login', loginLimiter, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const key = ((req.body || {}).license_key || '').trim().toUpperCase();
  if (!key) return res.status(400).json({ error: 'license_key required' });
  const license = platformDb.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!license) return res.status(401).json({ error: 'invalid_license' });
  if (license.status === 'revoked') return res.status(403).json({ error: 'revoked' });
  if (license.status === 'issued') platformDb.prepare('UPDATE licenses SET status = ?, activated_at = ? WHERE id = ?').run('active', new Date().toISOString(), license.id);
  let studio = platformDb.prepare('SELECT * FROM studios WHERE license_key = ?').get(key);
  if (!studio) {
    const info = platformDb.prepare('INSERT INTO studios (subdomain, name, tier, license_key, commission_percent, max_tenants, max_verticals, status, created_at) VALUES (?, ?, ?, ?, 3.0, ?, ?, ?, ?)').run('studio-' + license.id, 'Студия #' + license.id, license.tier, key, license.max_tenants, license.max_verticals, 'active', new Date().toISOString());
    studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(info.lastInsertRowid);
  }
  const token = jwt.sign({ studio_id: studio.id, tier: studio.tier, role: 'studio' }, CONFIG.jwtSecret, { expiresIn: '30d' });
  res.json({ token, studio: { id: studio.id, name: studio.name, tier: studio.tier, max_tenants: studio.max_tenants, max_verticals: studio.max_verticals, commission_percent: studio.commission_percent } });
});

app.get('/api/studio/me', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  res.json({ studio: platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(req.studio.studio_id) });
});

app.get('/api/studio/verticals', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  res.json({ verticals: platformDb.prepare('SELECT code, name, entity_label, client_icon FROM verticals WHERE is_public = 1 ORDER BY sort_order').all() });
});

app.get('/api/studio/tenants', studioAuth, (req, res) => {
  res.json({ tenants: db.prepare('SELECT * FROM tenants WHERE studio_id = ? ORDER BY created_at DESC').all(req.studio.studio_id) });
});

app.post('/api/studio/tenants', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const sid = req.studio.studio_id;
  const studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(sid);
  if (!studio) return res.status(404).json({ error: 'studio_not_found' });
  const { subdomain, vertical_code, business_name, contact_name, contact_phone } = req.body || {};
  if (!isValidSubdomain(subdomain)) return res.status(400).json({ error: 'invalid_subdomain' });
  if (!vertical_code) return res.status(400).json({ error: 'vertical_required' });
  if (!business_name || !business_name.trim()) return res.status(400).json({ error: 'business_name_required' });
  const cnt = db.prepare('SELECT COUNT(*) as c FROM tenants WHERE studio_id = ?').get(sid);
  if (studio.max_tenants > 0 && cnt.c >= studio.max_tenants) return res.status(400).json({ error: 'tenant_limit_reached', max: studio.max_tenants });
  if (db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(subdomain)) return res.status(409).json({ error: 'subdomain_taken' });
  const vertical = platformDb.prepare('SELECT * FROM verticals WHERE code = ?').get(vertical_code);
  if (!vertical) return res.status(400).json({ error: 'unknown_vertical' });
  try {
    const result = db.transaction(() => {
      const info = db.prepare('INSERT INTO tenants (studio_id, subdomain, vertical_code, business_name, contact_name, contact_phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sid, subdomain, vertical_code, business_name.trim(), (contact_name || '').trim(), (contact_phone || '').trim(), 'active', new Date().toISOString());
      const tid = info.lastInsertRowid;
      const preset = JSON.parse(vertical.default_services_json);
      const classIns = db.prepare('INSERT INTO classes (name, tenant_id) VALUES (?, ?)');
      const svcIns = db.prepare('INSERT INTO services (name, price, duration, vehicle_class, tenant_id) VALUES (?, ?, ?, ?, ?)');
      Object.entries(preset).forEach(([ent, svcs]) => {
        const cr = classIns.run(ent, tid);
        Object.entries(svcs).forEach(([nm, [pr, du]]) => svcIns.run(nm, pr, du, cr.lastInsertRowid, tid));
      });
      const login = 'admin_' + tid;
      const pass = 'rl' + Math.random().toString(36).slice(2, 10);
      db.prepare('INSERT INTO users (username, password_hash, role, tenant_id) VALUES (?, ?, ?, ?)').run(login, bcrypt.hashSync(pass, 10), 'admin', tid);
      return { tid, login, pass };
    })();
    res.json({ ok: true, tenant_id: result.tid, admin_login: result.login, admin_password: result.pass, subdomain });
  } catch (e) { res.status(500).json({ error: 'internal_error', message: e.message }); }
});

app.delete('/api/studio/tenants/:
