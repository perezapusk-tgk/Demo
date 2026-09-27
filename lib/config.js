const path = require('path');
const fs = require('fs');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const DEFAULT_JWT_SECRET = 'replace-with-secure-secret';

let CONFIG = {
  jwtSecret: DEFAULT_JWT_SECRET,
  telegramBotToken: '',
  telegramChatId: '',
  allowedOrigin: null
};

if (fs.existsSync(CONFIG_FILE)) {
  try { CONFIG = Object.assign(CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE))); }
  catch (e) { console.warn('Failed to read config.json', e); }
}

module.exports = CONFIG;
