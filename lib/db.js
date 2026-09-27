const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database(path.join(__dirname, '..', 'app.db'));

let platformDb = null;
const platformFile = path.join(__dirname, '..', 'platform.db');
if (fs.existsSync(platformFile)) {
  platformDb = new Database(platformFile);
}

module.exports = { db, platformDb };
