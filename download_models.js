require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_TOKEN = process.env.DOWNLOAD_BOT_TOKEN;
const MODELS_ROOT = './Ozon';

const bot = new TelegramBot(BOT_TOKEN);
const errorLog = fs.createWriteStream('download_models_errors.log', { flags: 'a' });

/**
 * Проверяет, существует ли файл и совпадает ли его размер.
 */
function fileExistsAndMatches(filePath, expectedSize) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size === expectedSize;
  } catch {
    return false;
  }
}

/**
 * Скачивает файл по file_id через бота.
 */
async function downloadFile(fileId, outputPath, fileSize) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = outputPath + '.tmp';
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

  try {
    // 1. Получаем ссылку на файл от Telegram Bot API
    const fileLink = await bot.getFileLink(fileId);

    // 2. Скачиваем через axios с прогрессом
    const response = await axios({
      method: 'GET',
      url: fileLink,
      responseType: 'stream',
      timeout: 600000 // 10 минут
    });

    const writer = fs.createWriteStream(tempPath);
    const totalLength = parseInt(response.headers['content-length'], 10) || fileSize;

    let downloaded = 0;
    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      const percent = (downloaded / totalLength * 100).toFixed(1);
      const mb = (downloaded / 1024 / 1024).toFixed(1);
      const totalMb = (totalLength / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r⏳ ${path.basename(outputPath)}: ${percent}% (${mb} / ${totalMb} MB)`);
    });

    await new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // 3. Проверяем размер
    const stats = fs.statSync(tempPath);
    if (stats.size !== fileSize) {
      throw new Error(`Размер скачанного файла (${stats.size}) не совпадает с ожидаемым (${fileSize})`);
    }

    // 4. Перемещаем из временного в целевой
    fs.renameSync(tempPath, outputPath);
    console.log(`\n✅ Скачан: ${path.relative(process.cwd(), outputPath)}`);
    return true;
  } catch (err) {
    console.error(`\n❌ Ошибка скачивания ${fileId}:`, err.message);
    errorLog.write(`[ERROR] ${fileId} (${outputPath}): ${err.message}\n`);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return false;
  }
}

async function run() {
  if (!BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  }

  await db.initDB();
  console.log('🗄️ База данных инициализирована');

  const models = await db.db.all(
    'SELECT offer_id, file_id, file_name, file_size FROM product_models ORDER BY offer_id, file_name'
  );
  console.log(`📦 Найдено записей в БД: ${models.length}`);

  if (!models.length) {
    console.log('📭 Нет моделей для скачивания.');
    return;
  }

  let downloaded = 0, skipped = 0, errors = 0;

  if (!fs.existsSync(MODELS_ROOT)) {
    fs.mkdirSync(MODELS_ROOT, { recursive: true });
  }

  for (const model of models) {
    const { offer_id, file_id, file_name, file_size } = model;
    const filePath = path.join(MODELS_ROOT, offer_id, file_name);

    if (fileExistsAndMatches(filePath, file_size)) {
      console.log(`⏭️ Пропуск (уже есть): ${path.relative(process.cwd(), filePath)}`);
      skipped++;
      continue;
    }

    console.log(`📥 Скачивание: ${offer_id}/${file_name} (${(file_size / 1024 / 1024).toFixed(2)} МБ)`);
    const success = await downloadFile(file_id, filePath, file_size);
    if (success) downloaded++;
    else errors++;

    // Небольшая задержка между файлами
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n====================');
  console.log(`✅ Скачано: ${downloaded}`);
  console.log(`⏭️ Пропущено (уже есть): ${skipped}`);
  console.log(`❌ Ошибок: ${errors}`);
  console.log('====================');
}

run().catch(err => {
  console.error('💥 Фатальная ошибка:', err);
  process.exit(1);
});