require('dotenv').config();

const fs = require('fs');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

const SESSION_FILE = 'session.txt';
const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID;

(async () => {
  try {
    const sessionString = fs
      .readFileSync(SESSION_FILE, 'utf8')
      .trim();

    const client = new TelegramClient(
      new StringSession(sessionString),
      apiId,
      apiHash,
      {
        connectionRetries: 5,
      }
    );

    await client.connect();

    console.log(
      'Авторизован:',
      await client.isUserAuthorized()
    );

    const testFile = 'telegram_test.txt';

    fs.writeFileSync(
      testFile,
      `Test upload ${new Date().toISOString()}`
    );

    console.log('📤 Отправляем файл...');

    const result = await client.sendFile(
      MODELS_CHAT_ID,
      {
        file: testFile,
        caption: 'Тестовая загрузка через gramJS',
        forceDocument: true,
      }
    );

    console.log('✅ Успех');
    console.log('Message ID:', result.id);

    await client.disconnect();

    fs.unlinkSync(testFile);
  }
  catch (err) {
    console.error(err);
  }
})();