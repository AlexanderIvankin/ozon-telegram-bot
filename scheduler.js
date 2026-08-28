const { exportMonthlyEarnings, cleanCooldowns } = require('./commands');
const { createDbBackup } = require('./db');
const { getLocalTime, getLocalDate } = require('./utils');
const debugMode = require('./debugMode');

let warehouseSyncInterval = null;
let isWarehouseSyncRunning = false;

/**
 * Запускает периодическую синхронизацию складов из Ozon.
 * @param {Object} ozon - модуль ozon
 * @param {Object} db - модуль базы данных
 * @param {Object} bot - экземпляр бота для уведомлений
 * @param {number} intervalHours - интервал в часах (по умолчанию 24)
 */
function startWarehouseSyncChecker(ozon, db, bot = null, intervalHours = 24) {
    if (warehouseSyncInterval) {
        clearInterval(warehouseSyncInterval);
        warehouseSyncInterval = null;
    }

    // Конвертируем часы в миллисекунды
    const intervalMs = intervalHours * 60 * 60 * 1000;

    warehouseSyncInterval = setInterval(async () => {
        if (isWarehouseSyncRunning) {
            console.log('[SCHEDULER] Синхронизация складов уже выполняется, пропускаем');
            return;
        }

        isWarehouseSyncRunning = true;
        try {
            console.log('[SCHEDULER] Запуск плановой синхронизации складов...');
            const warehouses = await ozon.fetchWarehousesFromOzon();
            if (warehouses.length) {
                await db.syncWarehouses(warehouses);
                console.log(`[SCHEDULER] Синхронизация складов завершена, обновлено ${warehouses.length} складов`);
                if (bot) {
                    const moderatorId = process.env.MODERATOR_ID;
                    if (moderatorId) {
                        await bot.sendMessage(moderatorId, `🏭 Синхронизация складов выполнена. Обновлено <b>${warehouses.length}</b> складов.`, { parse_mode: 'HTML' });
                    }
                }
            } else {
                console.warn('[SCHEDULER] Синхронизация складов: получен пустой список');
            }
        } catch (err) {
            console.error('[SCHEDULER] Ошибка при синхронизации складов:', err);
            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;
                if (moderatorId) {
                    await bot.sendMessage(moderatorId, `❌ Ошибка синхронизации складов: ${err.message}`);
                }
            }
        } finally {
            isWarehouseSyncRunning = false;
        }
    }, intervalMs);

    console.log(`[SCHEDULER] Плановая синхронизация складов запланирована каждые ${intervalHours} час(ов)`);
}

function stopWarehouseSyncChecker() {
    if (warehouseSyncInterval) {
        clearInterval(warehouseSyncInterval);
        warehouseSyncInterval = null;
    }
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
let lastBackupDate = null;

function startDailyBackupChecker(bot = null) {
    if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
    }

    backupInterval = setInterval(async () => {
        try {
            const now = getLocalDate(); // возвращает объект Date с локальным временем
            const hours = now.getHours();
            const minutes = now.getMinutes();

            if (hours !== 0 || minutes !== 0) {
                return;
            }

            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const today = `${year}-${month}-${day}`;

            if (lastBackupDate === today) {
                return;
            }

            lastBackupDate = today;

            console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');

            const backupPath = await createDbBackup();

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;
                if (moderatorId) {
                    const message = backupPath
                        ? `🗄️ Ежедневный бэкап БД создан: <code>${path.basename(backupPath)}</code>`
                        : '🗄️ Ежедневный бэкап БД создан.';
                    await bot.sendMessage(moderatorId, message, { parse_mode: 'HTML' });
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
                            `✅ Ежедневная очистка акций завершена.\nОбработано акций: <b>${result.actionsProcessed}</b>\nУдалено товаров: <b>${result.totalProductsRemoved}</b>`,
                            { parse_mode: 'HTML' }
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
                        `📊 Автоматический экспорт за <b>${monthStr}</b> выполнен.`,
                        { parse_mode: 'HTML' }
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

function stopAll() {
    stopWarehouseSyncChecker();
    stopOrderChecker();
    stopCooldownCleaner();
    stopDailyBackupChecker();
    stopDailyPromotionCleaner();
    stopMonthlyExportChecker();
    // остановка других, если есть
    console.log('[SCHEDULER] Все планировщики остановлены');
}

module.exports = {
    startWarehouseSyncChecker,
    stopWarehouseSyncChecker,
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
    stopAll,
};