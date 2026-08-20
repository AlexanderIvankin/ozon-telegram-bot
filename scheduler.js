const { exportMonthlyEarnings, cleanCooldowns } = require('./commands');
const { createDbBackup } = require('./db');
const { getLocalTime, getLocalDate } = require('./utils');
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
let lastBackupDate = null;

function startDailyBackupChecker(bot = null) {
    if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
    }

    backupInterval = setInterval(async () => {
        try {
            const localTime = getLocalTime();

            if (localTime.hours !== 0 || localTime.minutes !== 0) {
                return;
            }

            const today = `${localTime.year}-${String(localTime.month).padStart(2, '0')}-${String(localTime.day).padStart(2, '0')}`;

            // Защита от повторного запуска в течение одной минуты
            if (lastBackupDate === today) {
                return;
            }

            lastBackupDate = today;

            console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');

            await createDbBackup();

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    try {
                        await bot.sendMessage(
                            moderatorId,
                            '🗄️ Ежедневный бэкап БД создан.'
                        );
                    } catch (e) {
                        console.error(
                            '[SCHEDULER] Не удалось отправить уведомление о бэкапе:',
                            e
                        );
                    }
                }
            }
        } catch (err) {
            console.error('[SCHEDULER] Ошибка автобэкапа:', err);
        }
    }, 60 * 1000);

    console.log('[SCHEDULER] Ежедневный автобэкап запланирован на 00:00');
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

        const localTime = getLocalTime();

        // Проверяем, наступило ли заданное время (с учётом минут)
        if (localTime.hours === targetHour && localTime.minutes === targetMinute) {
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
let lastExportedMonth = null;

function startMonthlyExportChecker(db, bot = null) {
    if (monthlyExportInterval) {
        clearInterval(monthlyExportInterval);
        monthlyExportInterval = null;
    }

    monthlyExportInterval = setInterval(async () => {
        try {
            const localDate = getLocalDate();

            // Запускаем экспорт в первый день нового месяца в 00:00
            if (
                localDate.getDate() !== 1 ||
                localDate.getHours() !== 0 ||
                localDate.getMinutes() !== 0
            ) {
                return;
            }

            // Формируем месяц для экспорта (предыдущий месяц)
            const prevMonth = new Date(
                localDate.getFullYear(),
                localDate.getMonth() - 1,
                1
            );

            const monthStr =
                `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

            // Защита от повторного запуска
            if (lastExportedMonth === monthStr) {
                return;
            }

            console.log(
                `[SCHEDULER] Запуск автоматического экспорта за ${monthStr}`
            );

            await exportMonthlyEarnings(db, monthStr);

            lastExportedMonth = monthStr;

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    await bot.sendMessage(
                        moderatorId,
                        `📊 Автоматический экспорт за ${monthStr} выполнен.`
                    );
                }
            }
        } catch (err) {
            console.error(
                '[SCHEDULER] Ошибка автоматического экспорта:',
                err
            );
        }
    }, 60 * 1000);

    console.log(
        '[SCHEDULER] Ежемесячный экспорт запланирован на первый день месяца в 00:00'
    );
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