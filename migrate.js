// Migration script: creates app.db and seeds it.
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const fs = require('fs');
const dbFile = 'app.db';
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
const db = new Database(dbFile);

function exec(sql) { db.exec(sql); }

exec(`
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, role TEXT);
CREATE TABLE washers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, commission REAL DEFAULT 0.5);
CREATE TABLE classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, duration INTEGER, vehicle_class INTEGER);
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_code TEXT, name TEXT, phone TEXT, vehicle_class_id INTEGER,
  services_json TEXT, total INTEGER, date TEXT, hour INTEGER, status TEXT,
  assigned_washer_id INTEGER, created_at TEXT, updated_at TEXT
);
CREATE TABLE fines (id INTEGER PRIMARY KEY AUTOINCREMENT, washer_id INTEGER, amount INTEGER, reason TEXT, created_at TEXT);
CREATE INDEX idx_bookings_date_hour ON bookings(date, hour, status);
CREATE INDEX idx_bookings_phone ON bookings(phone);
`);

const classNames = ['Мотоцикл/скутер', 'Квадроцикл', 'Легковой', 'Кроссовер', 'Внедорожник/пикап', 'Минивэн/микроавтобус', 'Прицеп'];
const classIns = db.prepare('INSERT INTO classes(name) VALUES(?)');
classNames.forEach(n => classIns.run(n));

const catalog = {
  0: { 'Мойка мотоцикла': [400, 25], 'Полировка пластика': [1500, 40], 'Чернение резины': [250, 10] },
  1: { 'Мойка квадроцикла': [600, 30], 'Мойка двигателя': [500, 20], 'Полировка пластика': [1800, 40] },
  2: {
    'Экспресс-мойка кузова': [450, 30],
    'Комплекс (кузов, салон, коврики)': [1300, 90],
    'Мойка двигателя': [600, 20],
    'Химчистка салона': [8500, 180],
    'Полировка кузова': [8500, 180],
    'Чернение резины': [350, 10],
    'Нанокерамика, базовый слой': [15000, 240]
  },
  3: {
    'Экспресс-мойка кузова': [550, 35],
    'Комплекс (кузов, салон, коврики)': [1600, 100],
    'Мойка двигателя': [700, 25],
    'Химчистка салона': [9800, 200],
    'Полировка кузова': [9500, 200],
    'Чернение резины': [400, 10],
    'Нанокерамика, базовый слой': [17000, 260]
  },
  4: {
    'Экспресс-мойка кузова': [650, 40],
    'Комплекс (кузов, салон, коврики)': [1900, 110],
    'Мойка двигателя': [850, 30],
    'Химчистка салона': [11500, 220],
    'Полировка кузова': [10500, 220],
    'Чернение резины': [500, 15],
    'Нанокерамика, базовый слой': [20000, 280]
  },
  5: {
    'Экспресс-мойка кузова': [800, 45],
    'Комплекс (кузов, салон, коврики)': [2300, 120],
    'Мойка двигателя': [1000, 30],
    'Химчистка салона': [13500, 240],
    'Полировка кузова': [12500, 240],
    'Чернение резины': [600, 15],
    'Нанокерамика, базовый слой': [24000, 300]
  },
  6: { 'Мойка прицепа': [350, 20], 'Антикоррозийная обработка рамы': [2500, 60] }
};

const svcIns = db.prepare('INSERT INTO services(name,price,duration,vehicle_class) VALUES(?,?,?,?)');
Object.entries(catalog).forEach(([classId, services]) => {
  Object.entries(services).forEach(([name, [price, duration]]) => {
    svcIns.run(name, price, duration, parseInt(classId, 10));
  });
});

const washerIns = db.prepare('INSERT INTO washers(name,phone,commission) VALUES(?,?,?)');
washerIns.run('Иван Петров', '+79990001111', 0.5);
washerIns.run('Пётр Сидоров', '+79990002222', 0.45);

const kvIns = db.prepare('INSERT INTO kv(key,value) VALUES(?,?)');
kvIns.run('capacity', '2');
kvIns.run('business_name', 'ПЕНА24');
kvIns.run('city', 'Ярославль');

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const pw = bcrypt.hashSync(adminPassword, 10);
db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(adminUsername, pw, 'admin');

console.log('Migration complete.');
