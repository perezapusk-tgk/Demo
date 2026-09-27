// setup-demo.js — создаёт config.json, app.db, platform.db и демо-данные
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const root = __dirname;
const configPath = path.join(root, 'config.json');

// 1. config.json
if (!fs.existsSync(configPath)) {
  const demo = {
    jwtSecret: process.env.JWT_SECRET || ('DEMO_' + crypto.randomBytes(32).toString('hex')),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    allowedOrigin: null
  };
  fs.writeFileSync(configPath, JSON.stringify(demo, null, 2));
  console.log('✓ config.json создан');
  if (demo.telegramBotToken) console.log('✓ Telegram-бот подключён');
}

// 2. Тенант-БД (app.db) — текущая мойка
console.log('\n→ Запускаю migrate.js (тенант-БД)');
execSync('node migrate.js', { stdio: 'inherit', cwd: root });

console.log('\n→ Запускаю migrate-tenants.js (мультитенантность)');
execSync('node migrate-tenants.js', { stdio: 'inherit', cwd: root });

// 3. Платформенная БД (platform.db)
if (!fs.existsSync(path.join(root, 'platform.db'))) {
  console.log('\n→ Запускаю migrate-platform.js (платформа)');
  execSync('node migrate-platform.js', { stdio: 'inherit', cwd: root });
} else {
  console.log('\n• platform.db уже существует — пропускаю');
}

// 4. Демо-записи для первого тенанта
console.log('\n→ Наполняю демо-данными (тенант)');
const Database = require('better-sqlite3');
const db = new Database(path.join(root, 'app.db'));

const iso = (d) => d.toISOString().slice(0, 10);
const today = iso(new Date());
const tomorrow = iso(new Date(Date.now() + 86400000));

const svcAll = db.prepare('SELECT id, vehicle_class, name, price FROM services').all();
const findSvc = (cls, part) => svcAll.find(s => s.vehicle_class === cls && s.name.indexOf(part) !== -1);

const raw = [
  ['DEMO-001', 'Алексей',  '+79991112233', 2, ['Экспресс', 'Комплекс'],  today,    10, 'confirmed', 1],
  ['DEMO-002', 'Мария',    '+79994445566', 3, ['Экспресс', 'Комплекс'],  today,    10, 'confirmed', 2],
  ['DEMO-003', 'Игорь',    '+79997778899', 4, ['Экспресс'],               today,    14, 'confirmed', 1],
  ['DEMO-004', 'Светлана', '+79990001122', 2, ['Химчистка'],              today,    16, 'confirmed', null],
  ['DEMO-005', 'Дмитрий',  '+79993334455', 1, ['Мойка квадроцикла'],      tomorrow, 12, 'confirmed', null],
  ['DEMO-006', 'Ольга',    '+79996667788', 6, ['Мойка прицепа'],          tomorrow, 11, 'cancelled', null]
];

const insert = db.prepare('INSERT INTO bookings (booking_code,name,phone,vehicle_class_id,services_json,total,date,hour,status,assigned_washer_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
const existing = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;

if (existing === 0) {
  for (const row of raw) {
    const code = row[0], name = row[1], phone = row[2], cls = row[3], svcNames = row[4];
    const date = row[5], hour = row[6], status = row[7], wid = row[8];
    const svcRows = svcNames.map(n => findSvc(cls, n)).filter(Boolean);
    const svcIds = svcRows.map(s => s.id);
    const total = svcRows.reduce((s, x) => s + x.price, 0);
    insert.run(code, name, phone, cls, JSON.stringify(svcIds), total, date, hour, status, wid, new Date().toISOString());
  }
  console.log('✓ Добавлено ' + raw.length + ' демо-записей');
}

const finesCount = db.prepare('SELECT COUNT(*) c FROM fines').get().c;
if (finesCount === 0) {
  db.prepare('INSERT INTO fines(washer_id,amount,reason,created_at) VALUES(?,?,?,?)')
    .run(1, 300, 'Опоздание (демо)', new Date().toISOString());
  console.log('✓ Демо-штраф добавлен');
}

db.close();
console.log('\n════════════════════════════════════════════════');
console.log('  ГОТОВО. Запускайте: npm start');
console.log('  Клиент:    http://localhost:3000/');
console.log('  Админка:   http://localhost:3000/admin.html');
console.log('  Мойщик:    http://localhost:3000/washer.html');
console.log('════════════════════════════════════════════════\n');
