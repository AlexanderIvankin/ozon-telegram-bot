require('dotenv').config();

const fs = require('fs');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

const SESSION_FILE = 'session.txt';

(async () => {
    try {
        if (!fs.existsSync(SESSION_FILE)) {
            throw new Error('session.txt не найден');
        }

        const sessionString = fs
            .readFileSync(SESSION_FILE, 'utf8')
            .trim();

        console.log(
            `📄 Сессия загружена (${sessionString.length} символов)`
        );

        const client = new TelegramClient(
            new StringSession(sessionString),
            apiId,
            apiHash,
            {
                connectionRetries: 5,
            }
        );

        console.log('🔌 Подключаемся...');

        await client.connect();

        console.log('✅ Подключено');

        const authorized =
            await client.isUserAuthorized();

        console.log(
            `🔐 Авторизован: ${authorized}`
        );

        if (!authorized) {
            console.log(
                '❌ Сессия невалидна'
            );

            await client.disconnect();
            return;
        }

        const me = await client.getMe();

        console.log('\n👤 Аккаунт:');
        console.log('ID:', me.id?.toString());
        console.log('Username:', me.username);
        console.log('First name:', me.firstName);
        console.log('Last name:', me.lastName);

        await client.disconnect();

        console.log('\n✅ Всё работает');
    } catch (err) {
        console.error('\n💥 Ошибка:');
        console.error(err);
    }
})();