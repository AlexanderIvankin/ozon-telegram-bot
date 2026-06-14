require('dotenv').config();
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const sqlite3 = require('sqlite3').verbose();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID;
const MODELS_ROOT = './Ozon';

const bot = new TelegramBot(BOT_TOKEN);
const db = new sqlite3.Database('./bot.db');

// Лог-файлы
const uploadedLog = fs.createWriteStream('uploaded_models.log', { flags: 'a' });
const skippedLog = fs.createWriteStream('skipped_models.log', { flags: 'a' });

function getOfferIdFromFolder(folderName) {
  // Папка вида "000000001 какой-то текст" → "000000001"
  return folderName.split(/[- ]/)[0];
}

async function uploadAll() {
  await db.initDB();

  const folders = fs.readdirSync(MODELS_ROOT);
  for (const folder of folders) {
    const folderPath = path.join(MODELS_ROOT, folder);
    if (!fs.statSync(folderPath).isDirectory()) continue;
    const offerId = getOfferIdFromFolder(folder);
    const files = fs.readdirSync(folderPath).filter(f => !f.startsWith('.'));
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const stats = fs.statSync(filePath);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB > 50) {
        const msg = `[SKIP] ${offerId}/${file} — ${sizeMB.toFixed(2)} MB\n`;
        skippedLog.write(msg);
        console.log(msg);
        continue;
      }

      try {
        const msg = await bot.sendDocument(MODELS_CHAT_ID, filePath, {
          caption: `offer_id: ${offerId}\nФайл: ${file}`
        });
        const fileId = msg.document.file_id;
        await db.addProductModel(offerId, fileId, file, stats.size);
        const logMsg = `[UPLOADED] ${offerId}/${file} — ${sizeMB.toFixed(2)} MB, file_id: ${fileId}\n`;
        uploadedLog.write(logMsg);
        console.log(`✓ ${offerId}/${file}`);
      } catch (err) {
        const errMsg = `[ERROR] ${offerId}/${file} — ${err.message}\n`;
        skippedLog.write(errMsg);
        console.error(`✗ Ошибка загрузки ${offerId}/${file}:`, err.message);
      }
    }
  }
  console.log('Заливка завершена');
  uploadedLog.end();
  skippedLog.end();
}

uploadAll();