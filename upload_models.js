// upload_models.js
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID;
const MODELS_ROOT = './Ozon';

const bot = new TelegramBot(BOT_TOKEN);
const db = new sqlite3.Database('./bot.db');

function getOfferIdFromFolder(folderName) {
  // Папка вида "000000001 какой-то текст" → "000000001"
  return folderName.split(/[- ]/)[0];
}

async function uploadAll() {
  const folders = fs.readdirSync(MODELS_ROOT);
  for (const folder of folders) {
    const folderPath = path.join(MODELS_ROOT, folder);
    if (!fs.statSync(folderPath).isDirectory()) continue;
    const offerId = getOfferIdFromFolder(folder);
    const files = fs.readdirSync(folderPath).filter(f => !f.startsWith('.'));
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const stats = fs.statSync(filePath);
      if (stats.size > 50 * 1024 * 1024) {
        console.log(`Пропуск ${filePath} — превышает 50 МБ`);
        continue;
      }
      const msg = await bot.sendDocument(MODELS_CHAT_ID, filePath, {
        caption: `offer_id: ${offerId}\nФайл: ${file}`
      });
      const fileId = msg.document.file_id;
      db.run(
        `INSERT INTO product_models (offer_id, file_id, file_name, file_size, uploaded_at)
                 VALUES (?, ?, ?, ?, ?)`,
        [offerId, fileId, file, stats.size, Date.now()]
      );
      console.log(`✓ ${offerId}/${file}`);
    }
  }
  db.close();
}

uploadAll();