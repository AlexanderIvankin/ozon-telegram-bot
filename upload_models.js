require('dotenv').config();
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MODELS_CHAT_ID = process.env.MODELS_CHAT_ID;
const MODELS_ROOT = './Ozon';

const bot = new TelegramBot(BOT_TOKEN);

const uploadedLog = fs.createWriteStream('uploaded_models.log', { flags: 'a' });
const skippedLog = fs.createWriteStream('skipped_models.log', { flags: 'a' });

function getOfferIdFromFolder(folderName) {
    // Если есть пробел, берём часть до него
    if (folderName.includes(' ')) {
        return folderName.split(' ')[0];
    }
    // Иначе – всё название
    return folderName;
}

// Отправка с повторными попытками (до 5 раз, нарастающая задержка)
async function sendWithRetry(chatId, filePath, caption, attempt = 1) {
    const maxAttempts = 5;
    try {
        return await bot.sendDocument(chatId, filePath, { caption });
    } catch (err) {
        // Если ошибка 429 (Too Many Requests) – используем указанное время
        if (err.response?.body?.error_code === 429) {
            const retryAfter = err.response.body.parameters?.retry_after || 5;
            console.log(`⚠️ 429 Too Many Requests, повтор через ${retryAfter} сек (попытка ${attempt}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            if (attempt < maxAttempts) {
                return sendWithRetry(chatId, filePath, caption, attempt + 1);
            }
        }
        // Другие ошибки (например, 400 Bad Request) – пробуем с нарастающей задержкой
        else if (attempt < maxAttempts) {
            const delay = attempt * 2000; // 2, 4, 6, 8 секунд
            console.log(`⚠️ Ошибка: ${err.message}. Повтор через ${delay / 1000} сек (попытка ${attempt}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return sendWithRetry(chatId, filePath, caption, attempt + 1);
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

            // ⚠️ Оставьте эту проверку, если хотите избежать гарантированных ошибок API.
            // Если вы уверены, что Telegram Bot API позволяет отправлять файлы >50 МБ (не позволяет), закомментируйте.
            if (sizeMB > 50) {
                const relativePath = path.join(folder, file);
                const msg = `[SKIP] ${relativePath} — ${sizeMB.toFixed(2)} MB (превышает 50 МБ)\n`;
                skippedLog.write(msg);
                console.log(msg);
                continue;
            }

            try {
                const msg = await sendWithRetry(MODELS_CHAT_ID, filePath, `offer_id: ${offerId}\nФайл: ${file}`);
                const fileId = msg.document.file_id;
                await db.upsertProductModel(offerId, fileId, file, stats.size);
                const logMsg = `[UPLOADED] ${offerId}/${file} — ${sizeMB.toFixed(2)} MB, file_id: ${fileId}\n`;
                uploadedLog.write(logMsg);
                console.log(`✓ ${offerId}/${file}`);

                // Задержка между файлами 3 секунды
                await new Promise(resolve => setTimeout(resolve, 3000));
            } catch (err) {
                const relativePath = path.join(folder, file);
                const errMsg = `[ERROR] ${relativePath} — ${err.message}\n`;
//                const errMsg = `[ERROR] ${offerId}/${file} — ${err.message}\n`;
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