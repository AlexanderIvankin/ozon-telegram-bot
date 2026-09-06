require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const db = require('./db');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const SESSION_FILE = 'session.txt';

// Корневая папка для моделей
const MODELS_ROOT = './Ozon';

// Лог ошибок
const errorLog = fs.createWriteStream('download_models_errors.log', { flags: 'a' });

/**
 * Проверяет, существует ли файл и совпадает ли его размер.
 * @param {string} filePath - полный путь к файлу
 * @param {number} expectedSize - ожидаемый размер в байтах
 * @returns {boolean} - true, если файл существует и размер совпадает
 */
function fileExistsAndMatches(filePath, expectedSize) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size === expectedSize;
  } catch (err) {
    return false;
  }
}

/**
 * Скачивает файл из Telegram.
 * @param {TelegramClient} client - экземпляр клиента
 * @param {string} fileId - file_id из БД (Bot API)
 * @param {string} outputPath - путь для сохранения
 * @param {number} fileSize - ожидаемый размер (для прогресса)
 * @returns {Promise<boolean>} - true при успехе
 */
async function downloadFile(client, fileId, outputPath, fileSize) {
  // Создаём папку, если её нет
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Временно сохраняем во временный файл, чтобы избежать повреждения при обрыве
  const tempPath = outputPath + '.tmp';

  try {
    // Удаляем старый временный файл, если есть
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    // Скачиваем файл
    await client.downloadFile(fileId, {
      outputFile: tempPath,
      progressCallback: (downloaded, total) => {
        const percent = (downloaded / total * 100).toFixed(1);
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        process.stdout.write(`\r⏳ ${path.basename(outputPath)}: ${percent}% (${mb} / ${totalMb} MB)`);
      }
    });

    // Проверяем размер скачанного файла
    const stats = fs.statSync(tempPath);
    if (stats.size !== fileSize) {
      throw new Error(`Размер скачанного файла (${stats.size} байт) не совпадает с ожидаемым (${fileSize} байт)`);
    }

    // Перемещаем временный файл в целевое место
    fs.renameSync(tempPath, outputPath);
    console.log(`\n✅ Скачан: ${path.relative(process.cwd(), outputPath)}`);
    return true;
  } catch (err) {
    console.error(`\n❌ Ошибка скачивания ${fileId}:`, err.message);
    errorLog.write(`[ERROR] ${fileId} (${outputPath}): ${err.message}\n`);
    // Удаляем временный файл в случае ошибки
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    return false;
  }
}

async function run() {
  if (!apiId || !apiHash) {
    throw new Error('Не заданы TG_API_ID или TG_API_HASH в .env');
  }

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Файл сессии ${SESSION_FILE} не найден. Сначала создайте сессию через upload_big_models.js.`);
  }

  const sessionString = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    { connectionRetries: 5, timeout: 120 }
  );

  console.log('🔌 Подключаемся к Telegram...');
  await client.connect();

  if (!await client.isUserAuthorized()) {
    throw new Error('Сессия недействительна. Пересоздайте session.txt.');
  }

  const me = await client.getMe();
  console.log(`✅ Авторизован как ${me.username || me.firstName}`);

  // Инициализируем БД
  await db.initDB();
  console.log('🗄️ База данных инициализирована');

  // Получаем все модели из БД
  const models = await db.db.all('SELECT offer_id, file_id, file_name, file_size FROM product_models ORDER BY offer_id, file_name');
  console.log(`📦 Найдено записей в БД: ${models.length}`);

  if (!models.length) {
    console.log('📭 Нет моделей для скачивания.');
    await client.disconnect();
    return;
  }

  let total = models.length;
  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  // Создаём корневую папку, если её нет
  if (!fs.existsSync(MODELS_ROOT)) {
    fs.mkdirSync(MODELS_ROOT, { recursive: true });
  }

  for (const model of models) {
    const { offer_id, file_id, file_name, file_size } = model;
    const folderPath = path.join(MODELS_ROOT, offer_id);
    const filePath = path.join(folderPath, file_name);

    // Проверяем, существует ли уже файл с правильным размером
    if (fileExistsAndMatches(filePath, file_size)) {
      console.log(`⏭️ Пропуск (уже есть): ${path.relative(process.cwd(), filePath)}`);
      skipped++;
      continue;
    }

    // Скачиваем
    console.log(`📥 Скачивание: ${offer_id}/${file_name} (${(file_size / 1024 / 1024).toFixed(2)} МБ)`);
    const success = await downloadFile(client, file_id, filePath, file_size);
    if (success) {
      downloaded++;
    } else {
      errors++;
    }

    // Небольшая задержка между скачиваниями (чтобы не перегружать API)
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n====================');
  console.log(`✅ Скачано: ${downloaded}`);
  console.log(`⏭️ Пропущено (уже есть): ${skipped}`);
  console.log(`❌ Ошибок: ${errors}`);
  console.log('====================');

  await client.disconnect();
  console.log('🔌 Отключено');
}

run().catch(err => {
  console.error('💥 Фатальная ошибка:', err);
  process.exit(1);
});