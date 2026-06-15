// import_skipped_log.js
require('dotenv').config();
const fs = require('fs');
const db = require('./db');

async function importLog() {
    await db.initDB();
    const logPath = './skipped_models.log';
    if (!fs.existsSync(logPath)) {
        console.log('Файл skipped_models.log не найден');
        return;
    }
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (const line of lines) {
        // Формат: [SKIP] 2002216949/Centre_Console_Cup_Holder_altered_upright.STL — 79.43 MB (превышает 50 МБ)
        // или [ERROR] 2002148193/Ashtray_E92_V11.stl — ETELEGRAM: 429 Too Many Requests: retry after 41
        const skipMatch = line.match(/^\[(SKIP|ERROR)\]\s+(\d+)\/(.+?)\s+[—-]\s+(.+)$/);
        if (skipMatch) {
            const type = skipMatch[1];
            const offerId = skipMatch[2];
            const fileName = skipMatch[3];
            let reason = skipMatch[4];
            // Извлечём размер, если есть
            let sizeMb = null;
            const sizeMatch = reason.match(/(\d+(?:\.\d+)?)\s+MB/);
            if (sizeMatch) sizeMb = parseFloat(sizeMatch[1]);
            // Если тип ERROR, причина уже в строке
            await db.addSkippedModel(offerId, fileName, reason, sizeMb);
            console.log(`Импортирован пропуск: ${offerId}/${fileName}`);
        }
    }
    console.log('Импорт завершён');
    process.exit();
}
importLog();