const express = require('express');
const { db } = require('../lib/db');
const { sendTelegram, rub } = require('../lib/telegram');
const { isValidDate, isValidHour, isValidPhone, resolveTenantId, rateLimit } = require('../lib/helpers');

const router = express.Router();
const bookingLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

router.get('/vertical', (req, res) => {
  const tid = resolveTenantId(req);
  const services = db.prepare('SELECT id,name,price,duration,vehicle_class FROM services WHERE tenant_id = ? ORDER BY vehicle_class, id').all(tid);
  const classes = db.prepare('SELECT id,name FROM classes WHERE tenant_id = ? ORDER BY id').all(tid);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  res.json({ services, classes, capacity: 2, businessName: tenant ? tenant.business_name : '', city: '', tenant_id: tid, vertical_code: tenant ? tenant.vertical_code : 'wash' });
});

router.get('/slots', (req, res) => {
  const tid = resolveTenantId(req);
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const counts = {};
  db.prepare('SELECT hour, COUNT(*) as cnt FROM bookings WHERE date = ? AND status = ? AND tenant_id = ? GROUP BY hour').all(date, 'confirmed', tid).forEach(r => counts[r.hour] = r.cnt);
  const slots = [];
  for (let h = 0; h < 24; h++) { const used = counts[h] || 0; slots.push({ hour: h, remaining: Math.max(0, 2 - used) }); }
  res.json({ date, capacity: 2, slots });
});

router.post('/bookings', bookingLimiter, (req, res) => {
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
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM bookings WHERE date=? AND hour=? AND status=? AND tenant_id=?').get(date, hour, 'confirmed', tid);
      if (countRow.cnt >= 2) { const err = new Error('slot_full'); err.code = 'slot_full'; throw err; }
      const svcStmt = db.prepare('SELECT id, name, price FROM services WHERE id IN (' + service_ids.map(() => '?').join(',') + ') AND vehicle_class = ? AND tenant_id = ?');
      const svcRows = svcStmt.all(...service_ids, vehicle_class_id, tid);
      if (svcRows.length !== service_ids.length) { const err = new Error('invalid_services'); err.code = 'invalid_services'; throw err; }
      const total = svcRows.reduce((s, r) => s + r.price, 0);
      const bookingCode = (Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase());
      db.prepare('INSERT INTO bookings(booking_code, name, phone, vehicle_class_id, services_json, total, date, hour, status, created_at, tenant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(bookingCode, name.trim(), phone.trim(), vehicle_class_id, JSON.stringify(service_ids), total, date, hour, 'confirmed', new Date().toISOString(), tid);
      const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(bookingCode);
      const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(vehicle_class_id);
      return { rec, cls, svcRows };
    })();
    const { rec, cls, svcRows } = result;
    const svcNames = svcRows.map(r => r.name).join(', ');
    sendTelegram('🆕 <b>Новая запись</b>\n№ ' + rec.booking_code + '\n' + rec.name + ', ' + rec.phone + '\nКласс: ' + (cls ? cls.name : '') + '\nУслуги: ' + svcNames + '\nКогда: ' + date + ', ' + String(hour).padStart(2, '0') + ':00\nИтого: ' + rub(rec.total));
    res.json({ ok: true, booking: rec });
  } catch (e) {
    if (e.code === 'slot_full') return res.status(409).json({ error: 'slot_full' });
    if (e.code === 'invalid_services') return res.status(400).json({ error: 'invalid_services' });
    res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/bookings', (req, res) => {
  const tid = resolveTenantId(req);
  const phone = req.query.phone;
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'valid phone required' });
  res.json({ bookings: db.prepare('SELECT * FROM bookings WHERE phone = ? AND tenant_id = ? ORDER BY created_at DESC').all(phone, tid) });
});

router.delete('/bookings/:code', (req, res) => {
  const tid = resolveTenantId(req);
  const code = req.params.code; const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'phone required in body' });
  const rec = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND phone = ? AND tenant_id = ?').get(code, phone, tid);
  if (!rec) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), rec.id);
  sendTelegram('❌ <b>Запись отменена</b>\n№ ' + rec.booking_code + ' · ' + rec.name + ', ' + rec.phone);
  res.json({ ok: true });
});

module.exports = router;
