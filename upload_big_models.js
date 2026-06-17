require('dotenv').config();

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID.trim();
const BOT_USERNAME = process.env.BOT_USERNAME.trim();

const SESSION_FILE = 'session.txt';

function findFolderByPrefix(baseDir, offerId) {
    if (!fs.existsSync(baseDir)) return null;

    const items = fs.readdirSync(baseDir);

    for (const item of items) {
        const itemPath = path.join(baseDir, item);

        if (
            fs.statSync(itemPath).isDirectory() &&
            item.startsWith(offerId)
        ) {
            return item;
        }
    }

    return null;
}

async function run() {

    if (!apiId || !apiHash || !MODELS_CHAT_ID || !BOT_USERNAME) {
        throw new Error('Не все переменные окружения заданы в .env');
    }

    if (!fs.existsSync(SESSION_FILE)) {
        throw new Error(
            `Не найден ${SESSION_FILE}. Сначала создай сессию через QR.`
        );
    }

    const sessionString = fs
        .readFileSync(SESSION_FILE, 'utf8')
        .trim();

    const client = new TelegramClient(
        new StringSession(sessionString),
        apiId,
        apiHash,
        {
            connectionRetries: 5,
            timeout: 120,
        }
    );

    console.log('🔌 Подключаемся...');

    await client.connect();

    const authorized = await client.isUserAuthorized();

    if (!authorized) {
        throw new Error(
            'Сессия недействительна. Пересоздай session.txt через QR.'
        );
    }

    const me = await client.getMe();

    console.log(
        `✅ Авторизован как: ${me.username || me.firstName}`
    );

    const botPeer = await client.getInputEntity(
        BOT_USERNAME
    );

    console.log('🤖 Бот найден');

    const logPath = './skipped_models.log';

    if (!fs.existsSync(logPath)) {
        throw new Error(
            'Файл skipped_models.log не найден'
        );
    }

    const lines = fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(line => line.trim());

    const entries = [];

    for (const line of lines) {
        const match = line.match(
            /^\[SKIP\]\s+(.+?)\/(.+?)\s+[—\-]\s+(\d+\.\d+)\s+MB/
        );

        if (!match) {
            console.warn(`⚠️ Не удалось разобрать строку: ${line}`);
            continue;
        }

        const fullFolder = match[1];
        const fileName = match[2];
        const size = parseFloat(match[3]);

        const offerId =
            fullFolder.split(/\s/)[0] || fullFolder;

        entries.push({
            offerId,
            fileName,
            size,
        });
    }

    if (!entries.length) {
        console.log(
            '📭 Нет файлов для загрузки.'
        );

        await client.disconnect();
        return;
    }

    console.log(
        `📦 Найдено файлов: ${entries.length}`
    );

    let success = 0;
    let failed = 0;

    for (const entry of entries) {
        try {
            const foundFolder = findFolderByPrefix(
                './Ozon',
                entry.offerId
            );

            if (!foundFolder) {
                console.log(
                    `⚠️ Папка не найдена: ${entry.offerId}`
                );

                failed++;
                continue;
            }

            const filePath = path.join(
                './Ozon',
                foundFolder,
                entry.fileName
            );

            if (!fs.existsSync(filePath)) {
                console.log(
                    `⚠️ Файл не найден: ${filePath}`
                );

                failed++;
                continue;
            }

            console.log(
                `📤 ${entry.fileName} (${entry.size} MB)`
            );

            const msg = await client.sendFile(
                MODELS_CHAT_ID,
                {
                    file: filePath,
                    caption: `offer_id: ${entry.offerId}\nФайл: ${entry.fileName}`,
                    forceDocument: true,
                    chunkSize: 1024 * 1024, // 1 МБ
                    progressCallback: (downloaded, total) => {
                        const percent = (downloaded / total * 100).toFixed(1);
                        console.log(`⏳ Загрузка ${entry.fileName}: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`);
                    }
                }
            );

            console.log(
                `✅ Загружен: message_id=${msg.id}`
            );

            await client.forwardMessages(
                botPeer,
                {
                    messages: [msg.id],
                    fromPeer: MODELS_CHAT_ID,
                }
            );

            console.log(
                `✅ Переслано боту`
            );

            success++;

            await new Promise(resolve =>
                setTimeout(resolve, 5000)
            );
        } catch (err) {
            failed++;

            console.error(
                `❌ Ошибка: ${entry.fileName}`
            );

            console.error(err);
        }
    }

    console.log('');
    console.log('====================');
    console.log(`✅ Успешно: ${success}`);
    console.log(`❌ Ошибок: ${failed}`);
    console.log('====================');

    await client.disconnect();

    console.log('🔌 Отключено');
}

run().catch(err => {
    console.error('💥 Фатальная ошибка:');
    console.error(err);
});