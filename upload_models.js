require('dotenv').config();
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID;
const MODELS_ROOT = './Ozon';

const bot = new TelegramBot(BOT_TOKEN);

// Лог-файлы
const uploadedLog = fs.createWriteStream('uploaded_models.log', { flags: 'a' });
const skippedLog = fs.createWriteStream('skipped_models.log', { flags: 'a' });

function getOfferIdFromFolder(folderName) {
  return folderName.split(/[- ]/)[0];
}

// Функция отправки с повторными попытками при 429
async function sendWithRetry(chatId, filePath, caption, retryAfter = null) {
  if (retryAfter) {
    console.log(`⏳ Ожидание ${retryAfter} сек перед повтором...`);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
  }
  try {
    return await bot.sendDocument(chatId, filePath, { caption });
  } catch (err) {
    if (err.response?.body?.error_code === 429) {
      const retry = err.response.body.parameters?.retry_after || 5;
      console.log(`⚠️ 429 Too Many Requests, повтор через ${retry} сек`);
      return sendWithRetry(chatId, filePath, caption, retry);
    }
    throw err;
  }
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
        const msg = `[SKIP] ${offerId}/${file} — ${sizeMB.toFixed(2)} MB (превышает 50 МБ)\n`;
        skippedLog.write(msg);
        console.log(msg);
        continue;
      }

      try {
        // Отправляем с повторными попытками при 429
        const msg = await sendWithRetry(MODELS_CHAT_ID, filePath, `offer_id: ${offerId}\nФайл: ${file}`);
        const fileId = msg.document.file_id;
        await db.addProductModel(offerId, fileId, file, stats.size);
        const logMsg = `[UPLOADED] ${offerId}/${file} — ${sizeMB.toFixed(2)} MB, file_id: ${fileId}\n`;
        uploadedLog.write(logMsg);
        console.log(`✓ ${offerId}/${file}`);

        // Задержка между файлами (2 секунды), чтобы не нагружать API
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        const errMsg = `[ERROR] ${offerId}/${file} — ${err.message}\n`;
        skippedLog.write(errMsg);
        console.error(`✗ Ошибка загрузки ${offerId}/${file}:`, err.message);
      }
    }
  }
  console.log('✅ Заливка завершена');
  uploadedLog.end();
  skippedLog.end();
}

uploadAll();