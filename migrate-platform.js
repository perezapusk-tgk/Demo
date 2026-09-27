// migrate-platform.js — создаёт platform.db с 5 вертикалями и таблицами платформы
// Запуск: node migrate-platform.js
// Создаёт отдельную БД, не трогает app.db (текущая мойка)

const Database = require('better-sqlite3');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, 'platform.db');
if (fs.existsSync(dbFile)) {
  fs.unlinkSync(dbFile);
  console.log('Старая platform.db удалена');
}
const db = new Database(dbFile);

function exec(sql) { db.exec(sql); }
function genLicense(tier) {
  const prefixes = { start: 'STRT', business: 'BIZN', enterprise: 'ENTR' };
  const p = prefixes[tier] || 'DEMO';
  const part = function() { return crypto.randomBytes(2).toString('hex').toUpperCase(); };
  return 'RPLK-' + p + '-' + part() + '-' + part() + '-' + part();
}

/* ===================== СХЕМА ===================== */
exec(`
CREATE TABLE studios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subdomain TEXT UNIQUE,              -- 'abc' -> abc.rapidlink.ru
  name TEXT,                          -- 'Web Studio ABC'
  owner_email TEXT,
  owner_phone TEXT,
  tier TEXT,                          -- 'start', 'business', 'enterprise'
  license_key TEXT UNIQUE,
  commission_percent REAL DEFAULT 3.0,
  max_tenants INTEGER DEFAULT -1,     -- -1 = без лимита
  max_verticals INTEGER DEFAULT 1,    -- сколько вертикалей доступно
  status TEXT DEFAULT 'active',       -- 'active', 'suspended', 'trial'
  paid_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE studio_tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_id INTEGER,
  subdomain TEXT UNIQUE,              -- 'mywash' -> mywash.rapidlink.ru
  vertical_code TEXT,                 -- 'wash', 'barber', 'massage', ...
  business_name TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  status TEXT DEFAULT 'active',
  db_file TEXT,                       -- путь к tenant_N.db
  created_at TEXT
);

CREATE TABLE verticals (
  code TEXT PRIMARY KEY,
  name TEXT,
  entity_label TEXT,                  -- как называть сущность в UI
  entity_placeholder TEXT,            -- placeholder для поля ввода
  client_hero_title TEXT,             -- заголовок на клиенте
  client_hero_lede TEXT,              -- подзаголовок
  client_icon TEXT,
  default_services_json TEXT,         -- JSON: { entityName: { serviceName: [price, duration] } }
  tier_required TEXT DEFAULT 'start', -- минимальный тариф
  is_public INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 100
);

CREATE TABLE licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE,
  tier TEXT,
  studio_id INTEGER,                  -- к кому привязана (NULL = не активирована)
  activated_at TEXT,
  expires_at TEXT,                    -- NULL = бессрочно
  max_tenants INTEGER,
  max_verticals INTEGER,
  status TEXT DEFAULT 'issued',       -- 'issued', 'active', 'expired', 'revoked'
  notes TEXT,
  created_at TEXT
);

CREATE TABLE billing_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_id INTEGER,
  period_start TEXT,
  period_end TEXT,
  total_revenue INTEGER DEFAULT 0,
  commission_percent REAL,
  amount_due INTEGER DEFAULT 0,
  paid INTEGER DEFAULT 0,
  paid_at TEXT,
  payment_method TEXT,
  notes TEXT,
  created_at TEXT
);

CREATE TABLE platform_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password_hash TEXT,
  role TEXT DEFAULT 'owner',
  created_at TEXT
);

CREATE INDEX idx_studios_subdomain ON studios(subdomain);
CREATE INDEX idx_studios_license ON studios(license_key);
CREATE INDEX idx_tenants_studio ON studio_tenants(studio_id);
CREATE INDEX idx_tenants_subdomain ON studio_tenants(subdomain);
CREATE INDEX idx_invoices_studio ON billing_invoices(studio_id, period_start);
CREATE INDEX idx_licenses_key ON licenses(key);
`);

/* ===================== 5 ВЕРТИКАЛЕЙ ===================== */

const verticals = [
  {
    code: 'wash',
    name: 'Автомойка',
    entity_label: 'Класс ТС',
    entity_placeholder: 'Например: Hyundai Creta, Yamaha Grizzly, прицеп МЗСА',
    client_hero_title: 'Мойка, которая сама знает цену вашего транспорта',
    client_hero_lede: 'Введите марку/модель — система определит класс ТС и предложит услуги с ценами.',
    client_icon: '🚗',
    tier_required: 'start',
    sort_order: 10,
    services: {
      'Мотоцикл/скутер': {
        'Мойка мотоцикла': [400, 25],
        'Полировка пластика': [1500, 40],
        'Чернение резины': [250, 10]
      },
      'Квадроцикл': {
        'Мойка квадроцикла': [600, 30],
        'Мойка двигателя': [500, 20],
        'Полировка пластика': [1800, 40]
      },
      'Легковой': {
        'Экспресс-мойка кузова': [450, 30],
        'Комплекс (кузов, салон, коврики)': [1300, 90],
        'Мойка двигателя': [600, 20],
        'Химчистка салона': [8500, 180],
        'Полировка кузова': [8500, 180],
        'Чернение резины': [350, 10],
        'Нанокерамика, базовый слой': [15000, 240]
      },
      'Кроссовер': {
        'Экспресс-мойка кузова': [550, 35],
        'Комплекс (кузов, салон, коврики)': [1600, 100],
        'Мойка двигателя': [700, 25],
        'Химчистка салона': [9800, 200],
        'Полировка кузова': [9500, 200],
        'Чернение резины': [400, 10],
        'Нанокерамика, базовый слой': [17000, 260]
      },
      'Внедорожник/пикап': {
        'Экспресс-мойка кузова': [650, 40],
        'Комплекс (кузов, салон, коврики)': [1900, 110],
        'Мойка двигателя': [850, 30],
        'Химчистка салона': [11500, 220],
        'Полировка кузова': [10500, 220],
        'Чернение резины': [500, 15],
        'Нанокерамика, базовый слой': [20000, 280]
      },
      'Минивэн/микроавтобус': {
        'Экспресс-мойка кузова': [800, 45],
        'Комплекс (кузов, салон, коврики)': [2300, 120],
        'Мойка двигателя': [1000, 30],
        'Химчистка салона': [13500, 240],
        'Полировка кузова': [12500, 240],
        'Чернение резины': [600, 15],
        'Нанокерамика, базовый слой': [24000, 300]
      },
      'Прицеп': {
        'Мойка прицепа': [350, 20],
        'Антикоррозийная обработка рамы': [2500, 60]
      }
    }
  },
  {
    code: 'barber',
    name: 'Барбершоп',
    entity_label: 'Категория',
    entity_placeholder: 'Мужская, Женская, Детская',
    client_hero_title: 'Стрижка, которая подходит именно вам',
    client_hero_lede: 'Выберите категорию и услугу — мастер подтвердит запись.',
    client_icon: '💈',
    tier_required: 'start',
    sort_order: 20,
    services: {
      'Мужская стрижка': {
        'Стрижка машинкой': [800, 30],
        'Стрижка ножницами': [1200, 45],
        'Стрижка + борода': [1800, 60],
        'Оформление бороды': [700, 30],
        'Королевское бритьё': [1000, 40],
        'Детская стрижка (до 10 лет)': [600, 30]
      },
      'Женская стрижка': {
        'Женская стрижка': [1800, 60],
        'Укладка': [1200, 40],
        'Окрашивание в один тон': [3500, 120],
        'Мелирование': [5000, 150],
        'Уход / SPA-восстановление': [2500, 60]
      },
      'Детская стрижка': {
        'Детская стрижка (до 5 лет)': [500, 25],
        'Детская стрижка (5-12 лет)': [700, 30],
        'Детская стрижка + укладка': [900, 40]
      }
    }
  },
  {
    code: 'massage',
    name: 'Массаж',
    entity_label: 'Тип массажа',
    entity_placeholder: 'Классический, спортивный, лимфодренаж',
    client_hero_title: 'Массаж, который снимает усталость',
    client_hero_lede: 'Выберите тип массажа и удобное время.',
    client_icon: '💆',
    tier_required: 'start',
    sort_order: 30,
    services: {
      'Классический': {
        'Классический массаж (60 мин)': [2500, 60],
        'Классический массаж (90 мин)': [3500, 90],
        'Массаж спины': [1500, 40],
        'Массаж шеи и плеч': [1200, 30]
      },
      'Спортивный': {
        'Спортивный массаж': [3000, 60],
        'Массаж перед тренировкой': [2000, 40],
        'Восстановительный массаж': [3200, 75]
      },
      'Лимфодренажный': {
        'Лимфодренажный массаж': [3500, 60],
        'Антицеллюлитный массаж': [3000, 60],
        'Прессотерапия': [1800, 40]
      },
      'Расслабляющий': {
        'Расслабляющий массаж всего тела': [3800, 90],
        'Массаж головы': [1000, 30],
        'Тайский массаж': [4500, 90]
      },
      'Лечебный': {
        'Лечебный массаж спины': [2800, 60],
        'Массаж при остеохондрозе': [3000, 60],
        'Реабилитационный массаж': [3500, 75]
      }
    }
  },
  {
    code: 'detailing',
    name: 'Детейлинг',
    entity_label: 'Пакет',
    entity_placeholder: 'Базовый, средний, премиум',
    client_hero_title: 'Детейлинг, который возвращает автомобиль к жизни',
    client_hero_lede: 'Выберите пакет и услуги — мастер подтвердит запись.',
    client_icon: '✨',
    tier_required: 'start',
    sort_order: 40,
    services: {
      'Базовый': {
        'Экспресс-полировка кузова': [8000, 180],
        'Химчистка салона': [8500, 240],
        'Мойка двигателя': [2500, 60],
        'Чернение резины': [800, 30]
      },
      'Средний': {
        'Полировка кузова (2 этапа)': [15000, 360],
        'Глубокая химчистка салона': [15000, 300],
        'Керамика (2 слоя)': [25000, 480],
        'Обработка кожи': [5000, 120],
        'Антидождь на стёкла': [3000, 60]
      },
      'Премиум': {
        'Полировка кузова (3 этапа)': [25000, 600],
        'Керамика (5 слоёв)': [60000, 1440],
        'Химчистка + озонирование': [20000, 480],
        'Бронирование плёнкой (фронт)': [45000, 720],
        'Реставрация фар': [8000, 180],
        'Обработка дисков': [6000, 120]
      }
    }
  },
  {
    code: 'tire',
    name: 'Шиномонтаж',
    entity_label: 'Радиус',
    entity_placeholder: 'R13, R16, R20',
    client_hero_title: 'Шиномонтаж без очередей',
    client_hero_lede: 'Выберите радиус колёс — система покажет цену.',
    client_icon: '🛞',
    tier_required: 'start',
    sort_order: 50,
    services: {
      'R13': { 'Шиномонтаж R13': [1000, 30], 'Балансировка R13': [500, 20] },
      'R14': { 'Шиномонтаж R14': [1100, 30], 'Балансировка R14': [550, 20] },
      'R15': { 'Шиномонтаж R15': [1200, 35], 'Балансировка R15': [600, 20] },
      'R16': { 'Шиномонтаж R16': [1400, 40], 'Балансировка R16': [700, 25] },
      'R17': { 'Шиномонтаж R17': [1600, 40], 'Балансировка R17': [800, 25] },
      'R18': { 'Шиномонтаж R18': [1800, 45], 'Балансировка R18': [900, 30] },
      'R19': { 'Шиномонтаж R19': [2000, 50], 'Балансировка R19': [1000, 30] },
      'R20': { 'Шиномонтаж R20': [2400, 55], 'Балансировка R20': [1200, 35] },
      'R21': { 'Шиномонтаж R21': [2800, 60], 'Балансировка R21': [1400, 40] },
      'R22': { 'Шиномонтаж R22': [3200, 65], 'Балансировка R22': [1600, 45] }
    }
  }
];

const insertVertical = db.prepare(`
  INSERT INTO verticals
  (code, name, entity_label, entity_placeholder, client_hero_title, client_hero_lede, client_icon, default_services_json, tier_required, is_public, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
`);

verticals.forEach(function(v) {
  insertVertical.run(
    v.code, v.name, v.entity_label, v.entity_placeholder,
    v.client_hero_title, v.client_hero_lede, v.client_icon,
    JSON.stringify(v.services), v.tier_required, v.sort_order
  );
  console.log('  + вертикаль: ' + v.name + ' (' + Object.keys(v.services).length + ' ' + v.entity_label.toLowerCase() + ')');
});

/* ===================== ДЕМО-ЛИЦЕНЗИИ ===================== */

const insertLicense = db.prepare(`
  INSERT INTO licenses (key, tier, max_tenants, max_verticals, status, notes, created_at)
  VALUES (?, ?, ?, ?, 'issued', ?, ?)
`);

const demoLicenses = [
  ['start', 10, 1, 'Демо-лицензия Start'],
  ['business', 100, 10, 'Демо-лицензия Business'],
  ['enterprise', -1, -1, 'Демо-лицензия Enterprise']
];

demoLicenses.forEach(function(row) {
  const tier = row[0], tenants = row[1], verticalsLimit = row[2], note = row[3];
  const key = genLicense(tier);
  insertLicense.run(key, tier, tenants, verticalsLimit, note, new Date().toISOString());
  console.log('  + лицензия ' + tier + ': ' + key);
});

/* ===================== ВЛАДЕЛЕЦ ПЛАТФОРМЫ ===================== */

const adminUser = process.env.PLATFORM_ADMIN || 'owner';
const adminPass = process.env.PLATFORM_PASSWORD || 'rapidlink2026';
const pwHash = bcrypt.hashSync(adminPass, 10);
db.prepare('INSERT INTO platform_admins (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
  .run(adminUser, pwHash, 'owner', new Date().toISOString());

console.log('  + владелец платформы: ' + adminUser + ' (пароль ' + adminPass + ')');

db.close();

console.log('\n══════════════════════════════════════════════════════');
console.log('  platform.db создана');
console.log('  Вертикалей:   ' + verticals.length);
console.log('  Лицензий:     ' + demoLicenses.length);
console.log('  Владелец:     ' + adminUser + ' / ' + adminPass);
console.log('');
console.log('  ⚠️  Смените пароль перед продакшеном через переменные окружения:');
console.log('     PLATFORM_ADMIN=you PLATFORM_PASSWORD="strong" node migrate-platform.js');
console.log('══════════════════════════════════════════════════════\n');
