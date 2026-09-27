const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const CONFIG = require('../lib/config');
const { db } = require('../lib/db');
const { sendTelegram } = require('../lib/telegram');
const { isValidDate, authMiddleware, rateLimit } = require('../lib/helpers');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'invalid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id || 1 }, CONFIG.jwtSecret, { expiresIn: '12h' });
  res.json({ token });
});

router.get('/bookings', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  let rows;
  if (date) rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ? ORDER BY b.hour').all(date, tid);
  else rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.tenant_id = ? ORDER BY b.created_at DESC LIMIT 200').all(tid);
  res.json({ bookings: rows });
});

router.patch('/bookings/:id', authMiddleware, (req, res) => {
  const id = req.params.id; const { assigned_washer_id, status } = req.body || {};
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET assigned_washer_id = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(assigned_washer_id !== undefined ? assigned_washer_id : rec.assigned_washer_id, status || rec.status, new Date().toISOString(), id);
  res.json({ ok: true });
});

router.post('/bookings/:id/complete', authMiddleware, (req, res) => {
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('completed', new Date().toISOString(), rec.id);
  sendTelegram('🚗 <b>Машина готова</b>\n№ ' + rec.booking_code + '\n' + rec.name + ', ' + rec.phone + '\nМожно забирать!');
  res.json({ ok: true });
});

router.get('/washers', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  res.json({ washers: db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(tid) });
});

router.post('/washers', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const { name, phone, commission } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO washers(name, phone, commission, tenant_id) VALUES(?,?,?,?)').run(name.trim(), (phone || '').trim(), commission !== undefined ? parseFloat(commission) : 0.5, tid);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.patch('/washers/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  const { name, phone, commission } = req.body || {};
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE washers SET name = ?, phone = ?, commission = ? WHERE id = ?').run(name !== undefined ? name : rec.name, phone !== undefined ? phone : rec.phone, commission !== undefined ? parseFloat(commission) : rec.commission, id);
  res.json({ ok: true });
});

router.delete('/washers/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  const rec = db.prepare('SELECT * FROM washers WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const assigned = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE assigned_washer_id = ?').get(id);
  if (assigned && assigned.cnt > 0) return res.status(400).json({ error: 'washer_has_bookings', count: assigned.cnt });
  db.prepare('DELETE FROM washers WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.post('/fines', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const { washer_id, amount, reason } = req.body || {};
  if (!washer_id || amount === undefined) return res.status(400).json({ error: 'missing' });
  db.prepare('INSERT INTO fines(washer_id, amount, reason, created_at, tenant_id) VALUES(?,?,?,?,?)').run(washer_id, amount, reason || '', new Date().toISOString(), tid);
  res.json({ ok: true });
});

router.get('/reports/daily', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT w.id as washer_id, w.name as washer_name, w.commission, COUNT(b.id) as bookings_count, COALESCE(SUM(b.total),0) as total_sum FROM washers w LEFT JOIN bookings b ON b.assigned_washer_id = w.id AND b.date = ? AND b.status IN (?, ?) WHERE w.tenant_id = ? GROUP BY w.id').all(date, 'confirmed', 'completed', tid);
  const finesRows = db.prepare('SELECT washer_id, COALESCE(SUM(amount),0) as fines_sum FROM fines WHERE date(created_at) = ? AND tenant_id = ? GROUP BY washer_id').all(date, tid);
  const finesByWasher = Object.fromEntries(finesRows.map(f => [f.washer_id, f.fines_sum]));
  res.json({ date, rows: rows.map(r => ({ ...r, fines_sum: finesByWasher[r.washer_id] || 0, payout: Math.round(r.total_sum * r.commission - (finesByWasher[r.washer_id] || 0)) })) });
});

router.get('/services', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  res.json({ services: db.prepare('SELECT s.*, c.name as class_name FROM services s LEFT JOIN classes c ON c.id = s.vehicle_class WHERE s.tenant_id = ? ORDER BY s.vehicle_class, s.id').all(tid) });
});

router.patch('/services/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  const { price, name, duration } = req.body || {};
  const rec = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE services SET price = ?, name = ?, duration = ? WHERE id = ?').run(price !== undefined ? parseInt(price, 10) : rec.price, name !== undefined ? name : rec.name, duration !== undefined ? parseInt(duration, 10) : rec.duration, id);
  res.json({ ok: true });
});

router.get('/export/bookings', authMiddleware, (req, res) => {
  const tid = req.user.tenant_id || 1;
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.booking_code, b.name, b.phone, c.name AS class_name, b.services_json, b.total, b.hour, b.status FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.date = ? AND b.tenant_id = ?').all(date, tid);
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = ['code;name;phone;class;services;total;hour;status'].concat(rows.map(r => [r.booking_code, esc(r.name), r.phone, r.class_name, esc(r.services_json), r.total, r.hour, r.status].join(';'))).join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=bookings_' + date + '.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + csv);
});

module.exports = router;
