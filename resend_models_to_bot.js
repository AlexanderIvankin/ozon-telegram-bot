require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const db = require('./db');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID.trim();
const BOT_USERNAME = process.env.DOWNLOAD_BOT_USERNAME.trim();
const SESSION_FILE = 'session.txt';

const logFile = fs.createWriteStream('resend_models.log', { flags: 'a' });

async function run() {
  if (!apiId || !apiHash || !MODELS_CHAT_ID || !BOT_USERNAME) {
    throw new Error('Не все переменные окружения заданы в .env');
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

  await db.initDB();
  console.log('🗄️ База данных инициализирована');

  const botPeer = await client.getInputEntity(BOT_USERNAME);
  console.log('🤖 Бот найден');

  const chatEntity = await client.getInputEntity(MODELS_CHAT_ID);

  // Идём от СТАРЫХ к НОВЫМ (reverse: true)
  let offsetId = 0; // начинаем с самого первого сообщения
  let totalProcessed = 0;
  let totalForwarded = 0;
  let hasMore = true;

  console.log('📥 Начинаем чтение истории канала (от старых к новым)...');

  while (hasMore) {
    const messages = await client.getMessages(chatEntity, {
      limit: 100,
      offsetId: offsetId,
      reverse: true // ← ключевое изменение: от старых к новым
    });

    if (!messages || messages.length === 0) {
      hasMore = false;
      break;
    }

    console.log(`📄 Получено сообщений: ${messages.length}, первое ID: ${messages[0]?.id}, последнее ID: ${messages[messages.length - 1]?.id}`);

    for (const msg of messages) {
      totalProcessed++;
      if (!msg.document) {
        continue;
      }

      try {
        await client.forwardMessages(botPeer, {
          messages: [msg.id],
          fromPeer: chatEntity,
        });
        totalForwarded++;
        console.log(`✅ Переслано сообщение ${msg.id}`);
        logFile.write(`[OK] Переслано ${msg.id}\n`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.error(`❌ Ошибка пересылки ${msg.id}:`, err.message);
        logFile.write(`[ERROR] ${msg.id}: ${err.message}\n`);
      }
    }

    // Для следующей итерации берём ID последнего сообщения в текущем пакете
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.id) {
      offsetId = lastMsg.id; // теперь offsetId указывает на последнее полученное сообщение
    } else {
      hasMore = false;
    }

    // Если мы получили меньше, чем limit, значит это последняя страница
    if (messages.length < 100) {
      hasMore = false;
    }
  }

  console.log('====================');
  console.log(`📊 Всего обработано: ${totalProcessed}`);
  console.log(`✅ Успешно переслано: ${totalForwarded}`);
  console.log('====================');

  await client.disconnect();
  console.log('🔌 Отключено');
}

run().catch(err => {
  console.error('💥 Фатальная ошибка:', err);
  process.exit(1);
});