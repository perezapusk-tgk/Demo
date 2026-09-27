const fetch = require('node-fetch');
const CONFIG = require('./config');

function sendTelegram(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;
  const url = 'https://api.telegram.org/bot' + CONFIG.telegramBotToken + '/sendMessage';
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text, parse_mode: 'HTML' })
  }).then(res => res.text()).catch(err => console.warn('tg err', err));
}

function rub(n) { return n.toLocaleString('ru-RU') + ' ₽'; }

module.exports = { sendTelegram, rub };
