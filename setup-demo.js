// setup-demo.js — создаёт config.json, БД и демо-данные
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const root = __dirname;
const configPath = path.join(root, 'config.json');

if (!fs.existsSync(configPath)) {
  const demo = {
    jwtSecret: 'DEMO_' + crypto.randomBytes(32).toString('hex'),
    telegramBotToken: '',
    telegramChatId: '',
    allowedOrigin: null
  };
  fs.writeFileSync(configPath, JSON.stringify(demo, null, 2));
  console.log('✓ config.json создан');
}

console.log('\n→ node migrate.js');
execSync('node migrate.js', { stdio: 'inherit', cwd: root });

console.log('\n→ наполняю демо-данными…');
const Database = require('better-sqlite3');
const db = new Database(path.join(root, 'app.db'));

const iso = (d) => d.toISOString().slice(0, 10);
const today = iso(new Date());
const tomorrow = iso(new Date(Date.now() + 86400000));

const svcAll = db.prepare('SELECT id, vehicle_class, name, price FROM services').all();
const findSvc = (cls, part) =>
  svcAll.find(s => s.vehicle_class === cls && s.name.includes(part));

const raw = [
  ['DEMO-001', 'Алексей',  '+79991112233', 2, ['Экспресс', 'Комплекс'],  today,    10, 'confirmed', 1],
  ['DEMO-002', 'Мария',    '+79994445566', 3, ['Экспресс', 'Комплекс'],  today,    10, 'confirmed', 2],
  ['DEMO-003', 'Игорь',    '+79997778899', 4, ['Экспресс'],               today,    14, 'confirmed', 1],
  ['DEMO-004', 'Светлана', '+79990001122', 2, ['Химчистка'],              today,    16, 'confirmed', null],
  ['DEMO-005', 'Дмитрий',  '+79993334455', 1, ['Мойка квадроцикла'],      tomorrow, 12, 'confirmed', null],
  ['DEMO-006', 'Ольга',    '+79996667788', 6, ['Мойка прицепа'],          tomorrow, 11, 'cancelled', null],
];

const insert = db.prepare(`INSERT INTO bookings
  (booking_code,name,phone,vehicle_class_id,services_json,total,date,hour,status,assigned_washer_id,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

const existing = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;
if (existing === 0) {
  for (const [code, name, phone, cls, svcNames, date, hour, status, wid] of raw) {
    const svcRows = svcNames.map(n => findSvc(cls, n)).filter(Boolean);
    const svcIds = svcRows.map(s => s.id);
    const total = svcRows.reduce((s, x) => s + x.price, 0);
    insert.run(code, name, phone, cls, JSON.stringify(svcIds), total, date, hour, status, wid, new Date().toISOString());
  }
  console.log(`✓ Добавлено ${raw.length} демо-записей`);
}

const finesCount = db.prepare('SELECT COUNT(*) c FROM fines').get().c;
if (finesCount === 0) {
  db.prepare('INSERT INTO fines(washer_id,amount,reason,created_at) VALUES(?,?,?,?)')
    .run(1, 300, 'Опоздание (демо)', new Date().toISOString());
  console.log('✓ Демо-штраф добавлен');
}

db.close();
console.log('\nГотово. Запускайте npm start');
