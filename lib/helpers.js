const jwt = require('jsonwebtoken');
const CONFIG = require('./config');
const { db } = require('./db');

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

function resolveTenantId(req) {
  const subdomain = req.query.tenant || (req.hostname || '').split('.')[0];
  if (!subdomain || subdomain === 'demo-2-pkbp' || subdomain === 'localhost' || subdomain === 'www') return 1;
  const row = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(subdomain);
  return row ? row.id : 1;
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

module.exports = { isValidDate, isValidHour, isValidPhone, isValidSubdomain, authMiddleware, washerAuth, studioAuth, resolveTenantId, rateLimit };
