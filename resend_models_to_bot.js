require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID.trim();
const BOT_USERNAME = process.env.BOT_USERNAME.trim();
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

  const botPeer = await client.getInputEntity(BOT_USERNAME);
  console.log('🤖 Бот найден');

  // Получаем сущность канала
  const chatEntity = await client.getInputEntity(MODELS_CHAT_ID);

  let offsetId = 0;
  let totalProcessed = 0;
  let totalForwarded = 0;
  let hasMore = true;

  console.log('📥 Начинаем чтение истории канала...');

  while (hasMore) {
    const messages = await client.getMessages(chatEntity, {
      limit: 100,
      offsetId: offsetId,
      reverse: false // от новых к старым
    });

    if (!messages || messages.length === 0) {
      hasMore = false;
      break;
    }

    console.log(`📄 Обработано сообщений: ${messages.length}, последний ID: ${messages[messages.length - 1]?.id || 'нет'}`);

    for (const msg of messages) {
      totalProcessed++;
      // Пропускаем, если нет документа
      if (!msg.document) {
        continue;
      }

      // Можно также проверить, есть ли в caption offer_id (необязательно, бот сам отфильтрует)
      // if (!msg.caption || !msg.caption.includes('offer_id')) continue;

      try {
        await client.forwardMessages(botPeer, {
          messages: [msg.id],
          fromPeer: chatEntity,
        });
        totalForwarded++;
        console.log(`✅ Переслано сообщение ${msg.id}`);
        logFile.write(`[OK] Переслано ${msg.id}\n`);
        // Небольшая задержка, чтобы не превысить лимиты
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.error(`❌ Ошибка пересылки ${msg.id}:`, err.message);
        logFile.write(`[ERROR] ${msg.id}: ${err.message}\n`);
      }
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.id) {
      offsetId = lastMsg.id;
    } else {
      hasMore = false;
    }

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