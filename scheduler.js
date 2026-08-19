const { exportMonthlyEarnings, cleanCooldowns } = require('./commands');
const { createDbBackup } = require('./db');
require('dotenv').config();
const debugMode = require('./debugMode');

function getLocalDateTime() {
    const timezone = process.env.TIMEZONE || 'Europe/Moscow';
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: timezone
    }).formatToParts(now);
    const getPart = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
    return {
        year: getPart('year'),
        month: getPart('month'),
        day: getPart('day'),
        hours: getPart('hour'),
        minutes: getPart('minute'),
        seconds: getPart('second')
    };
}

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

function startDailyBackupChecker(bot = null) {
    if (backupInterval) clearInterval(backupInterval);
    backupInterval = setInterval(async () => {
        try {
            const local = getLocalDateTime();
            if (local.hours === 0 && local.minutes === 0) {
                console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');
                await createDbBackup();
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
    }, 60 * 60 * 1000);
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
 * @param {Object} bot - экземпляр бота для уведомлений
 */
function startDailyPromotionCleaner(ozon, bot = null) {
    if (promotionCleanInterval) {
        clearInterval(promotionCleanInterval);
        promotionCleanInterval = null;
    }

    const targetHour = parseInt(process.env.PROMOTION_CLEAN_HOUR) || 3;
    const targetMinute = parseInt(process.env.PROMOTION_CLEAN_MINUTE) || 0;

    promotionCleanInterval = setInterval(async () => {
        if (isPromotionCleanRunning) {
            console.log('[SCHEDULER] Очистка акций уже выполняется, пропускаем');
            return;
        }

        const local = getLocalDateTime();

        // Проверяем, наступило ли заданное время (с учётом минут)
        if (local.hours === targetHour && local.minutes === targetMinute) {
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
            const local = getLocalDateTime();
            // Определяем последний день месяца
            const lastDay = new Date(local.year, local.month, 0).getDate(); // month у нас 1-12, поэтому month (без -1)
            if (local.day === lastDay && local.hours >= 23 && local.minutes < 60) {
                // Формируем месяц в формате YYYY-MM (предыдущий месяц)
                const prevMonth = new Date(local.year, local.month - 1, 1);
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