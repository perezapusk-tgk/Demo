const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const CONFIG = require('../lib/config');
const { db, platformDb } = require('../lib/db');
const { isValidSubdomain, studioAuth, rateLimit } = require('../lib/helpers');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

router.post('/login', loginLimiter, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const { license_key } = req.body || {};
  if (!license_key || typeof license_key !== 'string') return res.status(400).json({ error: 'license_key required' });
  const key = license_key.trim().toUpperCase();
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

router.get('/me', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  const studio = platformDb.prepare('SELECT * FROM studios WHERE id = ?').get(req.studio.studio_id);
  if (!studio) return res.status(404).json({ error: 'not found' });
  res.json({ studio });
});

router.get('/verticals', studioAuth, (req, res) => {
  if (!platformDb) return res.status(503).json({ error: 'platform_not_ready' });
  res.json({ verticals: platformDb.prepare('SELECT code, name, entity_label, client_icon FROM verticals WHERE is_public = 1 ORDER BY sort_order').all() });
});

router.get('/tenants', studioAuth, (req, res) => {
  res.json({ tenants: db.prepare('SELECT * FROM tenants WHERE studio_id = ? ORDER BY created_at DESC').all(req.studio.studio_id)
