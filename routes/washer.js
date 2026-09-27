const express = require('express');
const jwt = require('jsonwebtoken');
const CONFIG = require('../lib/config');
const { db } = require('../lib/db');
const { sendTelegram } = require('../lib/telegram');
const { isValidDate, washerAuth, resolveTenantId, rateLimit } = require('../lib/helpers');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

router.post('/login', loginLimiter, (req, res) => {
  const { phone } = req.body || {};
  if (!phone || typeof phone !== 'string') return res.status(400).json({ error: 'phone required' });
  const tid = resolveTenantId(req);
  const normalized = phone.replace(/\D/g, '');
  const washer = db.prepare('SELECT * FROM washers WHERE tenant_id = ?').all(tid).find(w => (w.phone || '').replace(/\D/g, '') === normalized && normalized.length >= 10);
  if (!washer) return res.status(401).json({ error: 'not_found' });
  const token = jwt.sign({ washer_id: washer.id, name: washer.name, role: 'washer', tenant_id: tid }, CONFIG.jwtSecret, { expiresIn: '14h' });
  res.json({ token, washer: { id: washer.id, name: washer.name, phone: washer.phone, commission: washer.commission } });
});

router.get('/bookings', washerAuth, (req, res) => {
  const date = req.query.date;
  if (!isValidDate(date)) return res.status(400).json({ error: 'valid date required' });
  const rows = db.prepare('SELECT b.*, c.name as class_name FROM bookings b LEFT JOIN classes c ON c.id = b.vehicle_class_id WHERE b.assigned_washer_id = ? AND b.date = ? ORDER BY b.hour').all(req.washer.washer_id, date);
  const finesRow = db.prepare('SELECT COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) = ?').get(req.washer.washer_id, date);
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  const confirmedOrDone = rows.filter(r => r.status === 'confirmed' || r.status === 'completed');
  const total_sum = confirmedOrDone.reduce((s, r) => s + r.total, 0);
  const fines_sum = finesRow ? finesRow.sum : 0;
  const payout = Math.round(total_sum * (washer ? washer.commission : 0.5) - fines_sum);
  res.json({ date, bookings: rows, summary: { total_sum, fines_sum, payout, commission: washer ? washer.commission : 0.5 } });
});

router.post('/bookings/:id/status', washerAuth, (req, res) => {
  const { status } = req.body || {};
  if (status !== 'in_progress' && status !== 'completed') return res.status(400).json({ error: 'invalid status' });
  const rec = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (rec.assigned_washer_id !== req.washer.washer_id) return res.status(403).json({ error: 'not your booking' });
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), rec.id);
  if (status === 'completed') sendTelegram('🚗 <b>Машина готова</b>\n№ ' + rec.booking_code + '\n' + rec.name + ', ' + rec.phone + '\nМастер: ' + req.washer.name);
  res.json({ ok: true });
});

router.get('/earnings', washerAuth, (req, res) => {
  const washerId = req.washer.washer_id;
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(washerId);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const comm = washer.commission || 0.5;
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = iso(new Date());

  function sumForRange(fromDate, toDate) {
    const rows = db.prepare('SELECT b.date, COALESCE(SUM(b.total),0) as day_sum, COUNT(b.id) as cnt FROM bookings b WHERE b.assigned_washer_id = ? AND b.date >= ? AND b.date <= ? AND b.status IN (?, ?) GROUP BY b.date ORDER BY b.date DESC').all(washerId, fromDate, toDate, 'confirmed', 'completed');
    const finesRows = db.prepare('SELECT date(created_at) as d, COALESCE(SUM(amount),0) as sum FROM fines WHERE washer_id = ? AND date(created_at) >= ? AND date(created_at) <= ? GROUP BY date(created_at)').all(washerId, fromDate, toDate);
    const finesByDay = {};
    finesRows.forEach(f => finesByDay[f.d] = f.sum);
    let total_sum = 0, total_fines = 0, total_bookings = 0;
    const days = rows.map(r => {
      const fines = finesByDay[r.date] || 0;
      const share = Math.round(r.day_sum * comm);
      total_sum += r.day_sum; total_fines += fines; total_bookings += r.cnt;
      return { date: r.date, bookings: r.cnt, revenue: r.day_sum, share, fines, payout: share - fines };
    });
    return { total_revenue: total_sum, total_fines, total_bookings, total_share: Math.round(total_sum * comm), total_payout: Math.round(total_sum * comm) - total_fines, days };
  }

  const t = new Date();
  const weekAgo = new Date(t); weekAgo.setDate(weekAgo.getDate() - 6);
  const monthAgo = new Date(t); monthAgo.setDate(monthAgo.getDate() - 29);
  res.json({ commission: comm, washer_name: washer.name, today: sumForRange(today, today), week: sumForRange(iso(weekAgo), today), month: sumForRange(iso(monthAgo), today) });
});

router.post('/request-payout', washerAuth, (req, res) => {
  const washer = db.prepare('SELECT * FROM washers WHERE id = ?').get(req.washer.washer_id);
  if (!washer) return res.status(404).json({ error: 'not found' });
  const { amount, comment } = req.body || {};
  const amt = parseInt(amount, 10);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid amount' });
  sendTelegram('💰 <b>Запрос выплаты</b>\nМойщик: ' + washer.name + '\nТелефон: ' + (washer.phone || '—') + '\nСумма: ' + amt.toLocaleString('ru-RU') + ' ₽' + (comment ? '\nКомментарий: ' + comment : ''));
  res.json({ ok: true });
});

module.exports = router;
