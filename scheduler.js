const { exportMonthlyEarnings, cleanCooldowns } = require('./commands');
const { createDbBackup } = require('./db');
const debugMode = require('./debugMode');

let checkInterval = null;
let isPaused = false;

function startOrderChecker(intervalMinutes, callback) {
    if (checkInterval) clearInterval(checkInterval);
    checkInterval = setInterval(async () => {
        if (isPaused) return;
        console.log(`[SCHEDULER] Проверка заказов в ${new Date().toISOString()}`);
        try {
            await callback();
        } catch (err) {
            console.error('Ошибка в планировщике:', err);
        }
    }, intervalMinutes * 60 * 1000);
}

function stopOrderChecker() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
}

function pauseChecker() { isPaused = true; }
function resumeChecker() { isPaused = false; }
function isCheckerPaused() { return isPaused; }

let cooldownCleanInterval = null;

function startCooldownCleaner() {
    if (cooldownCleanInterval) clearInterval(cooldownCleanInterval);
    cooldownCleanInterval = setInterval(() => {
        try {
            cleanCooldowns();
        } catch (err) {
            console.error('[SCHEDULER] Ошибка при очистке кулдаунов:', err);
        }
    }, 60 * 60 * 1000); // раз в час
}

function stopCooldownCleaner() {
    if (cooldownCleanInterval) {
        clearInterval(cooldownCleanInterval);
        cooldownCleanInterval = null;
    }
}

let backupInterval = null;

function startDailyBackupChecker(db, bot = null) {
    if (backupInterval) clearInterval(backupInterval);
    backupInterval = setInterval(async () => {
        try {
            const now = new Date();
            if (now.getHours() === 0 && now.getMinutes() === 0) {
                console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');
                await createDbBackup(db);
                if (bot) {
                    const moderatorId = process.env.MODERATOR_ID;
                    if (moderatorId) {
                        await bot.sendMessage(moderatorId, '🗄️ Ежедневный бэкап БД создан.');
                    }
                }
            }
        } catch (err) {
            console.error('[SCHEDULER] Ошибка автобэкапа:', err);
        }
    }, 60 * 60 * 1000); // проверяем каждый час
}

function stopDailyBackupChecker() {
    if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
    }
}

let promotionCleanInterval = null;
let isPromotionCleanRunning = false;

/**
 * Запускает ежедневную очистку акций в заданное время.
 * @param {Object} ozon - модуль ozon
 * @param {Object} db - модуль базы данных (не используется, но оставлен для единообразия)
 * @param {Object} bot - экземпляр бота для уведомлений
 */
function startDailyPromotionCleaner(ozon, db = null, bot = null) {
    if (promotionCleanInterval) {
        clearInterval(promotionCleanInterval);
        promotionCleanInterval = null;
    }

    promotionCleanInterval = setInterval(async () => {
        if (isPromotionCleanRunning) {
            console.log('[SCHEDULER] Очистка акций уже выполняется, пропускаем');
            return;
        }

        const now = new Date();
        const targetHour = parseInt(process.env.PROMOTION_CLEAN_HOUR) || 3;
        const targetMinute = parseInt(process.env.PROMOTION_CLEAN_MINUTE) || 0;

        // Проверяем, наступило ли заданное время (с учётом минут)
        if (now.getHours() === targetHour && now.getMinutes() === targetMinute) {
            isPromotionCleanRunning = true;
            try {
                console.log('[SCHEDULER] Запуск ежедневной очистки акций...');
                const progressCallback = async (text) => {
                    console.log(`[PROMOTION_CLEAN] ${text}`);
                    if (bot) {
                        const moderatorId = process.env.MODERATOR_ID;
                        if (moderatorId) {
                            try {
                                await bot.sendMessage(moderatorId, `🧹 ${text}`);
                            } catch (e) { /* игнорируем ошибки отправки */ }
                        }
                    }
                };

                const result = await ozon.removeAllPromotions(progressCallback);
                console.log(`[SCHEDULER] Очистка акций завершена: ${result.actionsProcessed} акций, ${result.totalProductsRemoved} товаров`);

                if (bot) {
                    const moderatorId = process.env.MODERATOR_ID;
                    if (moderatorId) {
                        await bot.sendMessage(
                            moderatorId,
                            `✅ Ежедневная очистка акций завершена.\nОбработано акций: ${result.actionsProcessed}\nУдалено товаров: ${result.totalProductsRemoved}`
                        );
                    }
                }
            } catch (err) {
                console.error('[SCHEDULER] Ошибка ежедневной очистки акций:', err);
                if (bot) {
                    const moderatorId = process.env.MODERATOR_ID;
                    if (moderatorId) {
                        try {
                            await bot.sendMessage(moderatorId, `❌ Ошибка очистки акций: ${err.message}`);
                        } catch (e) { /* игнорируем */ }
                    }
                }
            } finally {
                isPromotionCleanRunning = false;
            }
        }
    }, 60 * 1000); // проверяем каждую минуту

    console.log(`[SCHEDULER] Ежедневная очистка акций запланирована на ${targetHour}:${String(targetMinute).padStart(2, '0')}`);
}

function stopDailyPromotionCleaner() {
    if (promotionCleanInterval) {
        clearInterval(promotionCleanInterval);
        promotionCleanInterval = null;
    }
    isPromotionCleanRunning = false;
}

let monthlyExportInterval = null;

function startMonthlyExportChecker(db, bot = null) {
    if (monthlyExportInterval) clearInterval(monthlyExportInterval);
    monthlyExportInterval = setInterval(async () => {
        try {
            const now = new Date();
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            if (now.getDate() === lastDay && now.getHours() >= 23 && now.getMinutes() < 60) {
                const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1);
                const monthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
                console.log(`[SCHEDULER] Запуск автоматического экспорта за ${monthStr}`);
                await exportMonthlyEarnings(db, monthStr);
                if (bot) {
                    const moderatorId = process.env.MODERATOR_ID;
                    if (moderatorId) {
                        await bot.sendMessage(moderatorId, `📊 Автоматический экспорт за ${monthStr} выполнен.`);
                    }
                }
            }
        } catch (err) {
            console.error('[SCHEDULER] Ошибка автоматического экспорта:', err);
        }
    }, 60 * 60 * 1000);
}

function stopMonthlyExportChecker() {
    if (monthlyExportInterval) {
        clearInterval(monthlyExportInterval);
        monthlyExportInterval = null;
    }
}

module.exports = {
    startOrderChecker,
    stopOrderChecker,
    pauseChecker,
    resumeChecker,
    isCheckerPaused,
    startCooldownCleaner,
    stopCooldownCleaner,
    startDailyBackupChecker,
    stopDailyBackupChecker,
    startDailyPromotionCleaner,
    stopDailyPromotionCleaner,
    startMonthlyExportChecker,
    stopMonthlyExportChecker,
};