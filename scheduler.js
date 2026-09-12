const path = require('path');
const { exportMonthlyEarnings, cleanCooldowns } = require('./commands');
const { createDbBackup } = require('./db');
const { getLocalTime, getLocalDate, formatOrderDetails, escapeHtml } = require('./utils');
const debugMode = require('./debugMode');

// Синхронизация складов
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

            if (!warehouses || !warehouses.length) {
                console.warn('[SCHEDULER] Синхронизация складов: получен пустой список');
                return;
            }

            await db.syncWarehouses(warehouses);

            console.log(
                `[SCHEDULER] Синхронизация складов завершена, обновлено ${warehouses.length} складов`
            );

            // Ошибка уведомления не должна считаться ошибкой синхронизации
            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    try {
                        await bot.sendMessage(
                            moderatorId,
                            `🏭 Синхронизация складов выполнена. Обновлено <b>${warehouses.length}</b> складов.`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (err) {
                        console.error(
                            '[SCHEDULER] Не удалось отправить сообщение о синхронизации складов:',
                            err.message
                        );
                    }
                }
            }
        } catch (err) {
            console.error(
                '[SCHEDULER] Ошибка при синхронизации складов:',
                err
            );

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    try {
                        await bot.sendMessage(
                            moderatorId,
                            `❌ Ошибка синхронизации складов: ${escapeHtml(err.message || String(err))}`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (notifyErr) {
                        console.error(
                            '[SCHEDULER] Не удалось отправить сообщение об ошибке складов:',
                            notifyErr.message
                        );
                    }
                }
            }
        } finally {
            isWarehouseSyncRunning = false;
        }
    }, intervalMs);

    console.log(
        `[SCHEDULER] Плановая синхронизация складов запланирована каждые ${intervalHours} час(ов)`
    );
}

function stopWarehouseSyncChecker() {
    if (warehouseSyncInterval) {
        clearInterval(warehouseSyncInterval);
        warehouseSyncInterval = null;
    }

    isWarehouseSyncRunning = false;
}

// Проверка новых заказов
let checkInterval = null;
let isPaused = false;
let isOrderCheckerRunning = false;

function startOrderChecker(intervalMinutes, callback) {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }

    isOrderCheckerRunning = false;

    checkInterval = setInterval(async () => {
        if (isPaused) {
            return;
        }

        if (isOrderCheckerRunning) {
            console.log('[SCHEDULER] Проверка заказов уже выполняется, пропускаем');
            return;
        }

        isOrderCheckerRunning = true;

        try {
            console.log(
                `[SCHEDULER] Проверка заказов в ${new Date().toISOString()}`
            );

            await callback();
        } catch (err) {
            console.error('[SCHEDULER] Ошибка в планировщике:', err);
        } finally {
            isOrderCheckerRunning = false;
        }
    }, intervalMinutes * 60 * 1000);

    console.log(
        `[SCHEDULER] Проверка заказов запланирована каждые ${intervalMinutes} мин.`
    );
}

function stopOrderChecker() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }

    isOrderCheckerRunning = false;
}

function pauseChecker() {
    isPaused = true;
}

function resumeChecker() {
    isPaused = false;
}

function isCheckerPaused() {
    return isPaused;
}

// Очистка кулдаунов
let cooldownCleanInterval = null;
let isCooldownCleanRunning = false;

function startCooldownCleaner() {
    if (cooldownCleanInterval) {
        clearInterval(cooldownCleanInterval);
        cooldownCleanInterval = null;
    }

    isCooldownCleanRunning = false;

    cooldownCleanInterval = setInterval(() => {
        if (isCooldownCleanRunning) {
            console.log('[SCHEDULER] Очистка кулдаунов уже выполняется, пропускаем');
            return;
        }

        isCooldownCleanRunning = true;

        try {
            cleanCooldowns();
        } catch (err) {
            console.error(
                '[SCHEDULER] Ошибка при очистке кулдаунов:',
                err
            );
        } finally {
            isCooldownCleanRunning = false;
        }
    }, 60 * 60 * 1000);

    console.log('[SCHEDULER] Очистка кулдаунов запланирована каждый час');
}

function stopCooldownCleaner() {
    if (cooldownCleanInterval) {
        clearInterval(cooldownCleanInterval);
        cooldownCleanInterval = null;
    }

    isCooldownCleanRunning = false;
}

// Ежедневный автобэкап
let backupInterval = null;
let lastBackupDate = null;
let isBackupRunning = false;


function startDailyBackupChecker(bot = null) {
    if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
    }

    isBackupRunning = false;

    backupInterval = setInterval(async () => {
        if (isBackupRunning) {
            return;
        }

        try {
            const now = getLocalDate();

            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');

            const today = `${year}-${month}-${day}`;

            // Запускаем после 00:00, но только один раз за день
            if (now.getHours() !== 0) {
                return;
            }

            if (lastBackupDate === today) {
                return;
            }

            isBackupRunning = true;

            console.log('[SCHEDULER] Запуск ежедневного автобэкапа БД...');

            const backupPath = await createDbBackup();

            // Помечаем день только после успешного создания бэкапа
            lastBackupDate = today;

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    try {
                        const message = backupPath
                            ? `🗄️ Ежедневный бэкап БД создан: <code>${escapeHtml(path.basename(backupPath))}</code>`
                            : '🗄️ Ежедневный бэкап БД создан.';

                        await bot.sendMessage(
                            moderatorId,
                            message,
                            { parse_mode: 'HTML' }
                        );
                    } catch (err) {
                        console.error(
                            '[SCHEDULER] Не удалось отправить сообщение о бэкапе:',
                            err.message
                        );
                    }
                }
            }
        } catch (err) {
            console.error(
                '[SCHEDULER] Ошибка автобэкапа:',
                err
            );
        } finally {
            isBackupRunning = false;
        }
    }, 60 * 1000);

    console.log('[SCHEDULER] Ежедневный автобэкап запланирован на 00:00');
}

function stopDailyBackupChecker() {
    if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
    }

    isBackupRunning = false;
}

// Напоминания awaiting_deliver
let deliverReminderInterval = null;
let lastDeliverReminderDate = null;
let isDeliverReminderRunning = false;

/**
 * Запускает ежедневную проверку заказов в статусе awaiting_deliver.
 * Находит заказы, завершённые более DELIVER_REMINDER_DELAY_HOURS назад,
 * и отправляет напоминание сотруднику и модератору (один раз на заказ).
 *
 * @param {Object} db - модуль базы данных
 * @param {Object} ozon - модуль ozon
 * @param {Object} bot - экземпляр бота для уведомлений
 */
function startAwaitingDeliverReminderChecker(db, ozon, bot = null) {
    if (deliverReminderInterval) {
        clearInterval(deliverReminderInterval);
        deliverReminderInterval = null;
    }

    isDeliverReminderRunning = false;

    const rawHour = process.env.DELIVER_REMINDER_HOUR;
    const rawMinute = process.env.DELIVER_REMINDER_MINUTE;
    const rawDelay = process.env.DELIVER_REMINDER_DELAY_HOURS;

    const targetHour = rawHour !== undefined && rawHour !== '' ? parseInt(rawHour, 10) : 7;
    const targetMinute = rawMinute !== undefined && rawMinute !== '' ? parseInt(rawMinute, 10) : 0;
    const delayHours = rawDelay !== undefined && rawDelay !== '' ? parseInt(rawDelay, 10) : 24;

    deliverReminderInterval = setInterval(async () => {
        if (isDeliverReminderRunning) {
            return;
        }

        const localTime = getLocalTime();

        // Не запускаем раньше заданного времени.
        // Если проверка задержалась на несколько минут — всё равно запускаем.
        if (
            localTime.hours < targetHour ||
            (localTime.hours === targetHour && localTime.minutes < targetMinute)
        ) {
            return;
        }

        const localDate = getLocalDate();

        const today =
            `${localDate.getFullYear()}-` +
            `${String(localDate.getMonth() + 1).padStart(2, '0')}-` +
            `${String(localDate.getDate()).padStart(2, '0')}`;

        if (lastDeliverReminderDate === today) {
            return;
        }

        isDeliverReminderRunning = true;

        try {
            await runAwaitingDeliverReminder(
                db,
                ozon,
                bot,
                delayHours
            );

            // Только после успешного прогона
            lastDeliverReminderDate = today;
        } catch (err) {
            console.error(
                '[SCHEDULER] Ошибка напоминаний awaiting_deliver:',
                err
            );
        } finally {
            isDeliverReminderRunning = false;
        }
    }, 60 * 1000);

    console.log(
        `[SCHEDULER] Проверка awaiting_deliver запланирована на ` +
        `${targetHour}:${String(targetMinute).padStart(2, '0')}`
    );
}

/**
 * Один прогон проверки awaiting_deliver.
 */
async function runAwaitingDeliverReminder(db, ozon, bot, delayHours) {
    console.log('[REMINDER] Запуск проверки awaiting_deliver...');

    let orders;

    try {
        orders = await ozon.fetchAwaitingDeliverOrders();
    } catch (err) {
        console.error(
            '[REMINDER] Не удалось получить список заказов:',
            err.message
        );

        // Важно: сообщаем планировщику об ошибке,
        // чтобы он не считал сегодняшний запуск успешным.
        throw err;
    }

    if (!Array.isArray(orders)) {
        throw new Error('fetchAwaitingDeliverOrders() вернул не массив');
    }

    console.log(
        `[REMINDER] Получено ${orders.length} заказов в awaiting_deliver`
    );

    if (!orders.length) {
        return;
    }

    const orderIds = orders
        .map(order => order.posting_number)
        .filter(Boolean);

    if (!orderIds.length) {
        console.log('[REMINDER] В ответе нет posting_number');
        return;
    }

    const placeholders = orderIds.map(() => '?').join(',');

    const cutoff =
        Date.now() -
        delayHours * 60 * 60 * 1000;

    // Начало текущего дня
    const todayStart = getLocalDate();
    todayStart.setHours(0, 0, 0, 0);

    const todayStartMs = todayStart.getTime();

    // Ищем завершённые заказы, которые:
    // - уже достаточно старые;
    // - всё ещё awaiting_deliver;
    // - сегодня ещё не получали напоминание.
    const completedAssignments = await db.db.all(
        `SELECT
            a.order_id,
            a.employee_id,
            a.completed_at,
            e.tg_user_id,
            e.name AS employee_name,
            e.is_fired,
            COALESCE(a.deliver_reminder_count, 0) AS reminder_count
         FROM assignments a
         JOIN employees e ON a.employee_id = e.id
         WHERE a.status = 'completed'
           AND a.completed_at IS NOT NULL
           AND a.completed_at < ?
           AND (
                a.deliver_reminder_sent_at IS NULL
                OR a.deliver_reminder_sent_at < ?
           )
           AND a.order_id IN (${placeholders})`,
        [cutoff, todayStartMs, ...orderIds]
    );

    if (!completedAssignments.length) {
        console.log('[REMINDER] Нет заказов, требующих напоминания');
        return;
    }

    console.log(
        `[REMINDER] Найдено ${completedAssignments.length} заказов для напоминания`
    );

    const moderatorId = process.env.MODERATOR_ID;
    let sent = 0;

    for (const assignment of completedAssignments) {
        const {
            order_id,
            employee_id,
            completed_at,
            tg_user_id,
            employee_name,
            reminder_count: reminderCount
        } = assignment;

        // Сумма заработка
        let amount = 0;

        try {
            const earningRow = await db.db.get(
                `SELECT amount
                 FROM employee_earnings
                 WHERE order_id = ? AND employee_id = ?`,
                order_id,
                employee_id
            );

            amount = earningRow ? Number(earningRow.amount) || 0 : 0;
        } catch (err) {
            console.warn(
                `[REMINDER] Не удалось получить заработок заказа ${order_id}:`,
                err.message
            );
        }

        const daysPassed = Math.max(
            0,
            Math.floor(
                (Date.now() - Number(completed_at)) /
                (24 * 60 * 60 * 1000)
            )
        );

        // Детали заказа
        let detailsText = '';

        try {
            const details = await ozon.getOrderDetails(order_id);

            if (details) {
                const formatted = await formatOrderDetails(details, db);

                if (formatted) {
                    detailsText = '\n' + formatted;
                }
            }
        } catch (err) {
            console.warn(
                `[REMINDER] Не удалось получить детали заказа ${order_id}:`,
                err.message
            );
        }

        // Сообщение сотруднику
        let employeeMessageSent = false;

        if (bot && tg_user_id) {
            try {
                const reminderInfo = reminderCount > 0
                    ? `\n🔔 Ранее вам уже напоминали об этом заказе: <b>${reminderCount} раз(а)</b>.`
                    : '';

                const employeeMsg =
                    `⏰ <b>Напоминание: заказ не отправлен</b>\n\n` +
                    `Заказ <code>${escapeHtml(order_id)}</code> был завершён ` +
                    `<b>${daysPassed} дн. назад</b>, ` +
                    `но всё ещё находится в статусе «ожидает отправки».` +
                    reminderInfo +
                    `\n\n⚠️ Пожалуйста, отправьте заказ как можно скорее, ` +
                    `иначе заработок <b>${amount.toFixed(2)} руб.</b> может быть отменён.` +
                    detailsText;

                await bot.sendMessage(
                    tg_user_id,
                    employeeMsg,
                    { parse_mode: 'HTML' }
                );

                employeeMessageSent = true;
                sent++;
            } catch (err) {
                console.error(
                    `[REMINDER] Не удалось отправить сотруднику ` +
                    `${employee_name} (${tg_user_id}):`,
                    err.message
                );
            }
        }

        // Сообщение модератору
        if (bot && moderatorId) {
            try {
                const modMsg =
                    `⏰ <b>Напоминание: заказ не отправлен</b>\n\n` +
                    `Сотрудник <b>${escapeHtml(employee_name || 'Неизвестно')}</b> ` +
                    `(ID <code>${employee_id}</code>) ` +
                    `завершил заказ <code>${escapeHtml(order_id)}</code> ` +
                    `<b>${daysPassed} дн. назад</b>, ` +
                    `но заказ всё ещё в статусе «ожидает отправки».\n` +
                    `🔔 Напоминаний отправлено: <b>${reminderCount + 1}</b>` +
                    `\n\n💰 Заработок по заказу: ` +
                    `<b>${amount.toFixed(2)} руб.</b>` +
                    detailsText;

                await bot.sendMessage(
                    moderatorId,
                    modMsg,
                    { parse_mode: 'HTML' }
                );
            } catch (err) {
                console.error(
                    '[REMINDER] Не удалось отправить сообщение модератору:',
                    err.message
                );
            }
        }

        // Помечаем напоминание только если оно действительно было отправлено
        // хотя бы одному получателю.
        if (employeeMessageSent || (bot && moderatorId)) {
            await db.db.run(
                `UPDATE assignments
                 SET deliver_reminder_sent_at = ?,
                     deliver_reminder_count =
                         COALESCE(deliver_reminder_count, 0) + 1
                 WHERE order_id = ?`,
                Date.now(),
                order_id
            );
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(
        `[REMINDER] Отправлено напоминаний сотрудникам: ${sent}`
    );

    // Сводка модератору
    if (bot && moderatorId) {
        try {
            await bot.sendMessage(
                moderatorId,
                `📋 Ежедневная проверка «ожидает отправки» завершена.\n` +
                `Найдено проблемных заказов: <b>${completedAssignments.length}</b>\n` +
                `Напоминаний отправлено сотрудникам: <b>${sent}</b>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            console.error(
                '[REMINDER] Не удалось отправить сводку модератору:',
                err.message
            );
        }
    }
}

function stopAwaitingDeliverReminderChecker() {
    if (deliverReminderInterval) {
        clearInterval(deliverReminderInterval);
        deliverReminderInterval = null;
    }

    isDeliverReminderRunning = false;
}

// Ежедневная очистка акций
let promotionCleanInterval = null;
let isPromotionCleanRunning = false;
let lastPromotionCleanDate = null;

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

    isPromotionCleanRunning = false;

    const rawHour = process.env.PROMOTION_CLEAN_HOUR;
    const rawMinute = process.env.PROMOTION_CLEAN_MINUTE;

    const targetHour = rawHour !== undefined && rawHour !== '' ? parseInt(rawHour, 10) : 3;
    const targetMinute = rawMinute !== undefined && rawMinute !== '' ? parseInt(rawMinute, 10) : 0;

    promotionCleanInterval = setInterval(async () => {
        if (isPromotionCleanRunning) {
            console.log('[SCHEDULER] Очистка акций уже выполняется, пропускаем');
            return;
        }

        const localTime = getLocalTime();

        if (
            localTime.hours < targetHour ||
            (localTime.hours === targetHour && localTime.minutes < targetMinute)
        ) {
            return;
        }

        const localDate = getLocalDate();

        const today =
            `${localDate.getFullYear()}-` +
            `${String(localDate.getMonth() + 1).padStart(2, '0')}-` +
            `${String(localDate.getDate()).padStart(2, '0')}`;

        if (lastPromotionCleanDate === today) {
            return;
        }

        isPromotionCleanRunning = true;

        try {
            console.log('[SCHEDULER] Запуск ежедневной очистки акций...');

            const progressCallback = async (text) => {
                console.log(`[PROMOTION_CLEAN] ${text}`);

                if (!bot) {
                    return;
                }

                const moderatorId = process.env.MODERATOR_ID;

                if (!moderatorId) {
                    return;
                }

                try {
                    await bot.sendMessage(
                        moderatorId,
                        `🧹 ${text}`
                    );
                } catch (err) {
                    console.warn(
                        '[PROMOTION_CLEAN] Не удалось отправить прогресс:',
                        err.message
                    );
                }
            };

            const result = await ozon.removeAllPromotions(
                progressCallback
            );

            console.log(
                `[SCHEDULER] Очистка акций завершена: ` +
                `${result.actionsProcessed} акций, ` +
                `${result.totalProductsRemoved} товаров`
            );

            // День помечаем только после успешного выполнения
            lastPromotionCleanDate = today;

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    try {
                        await bot.sendMessage(
                            moderatorId,
                            `✅ Ежедневная очистка акций завершена.\n` +
                            `Обработано акций: <b>${result.actionsProcessed}</b>\n` +
                            `Удалено товаров: <b>${result.totalProductsRemoved}</b>`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (err) {
                        console.error(
                            '[SCHEDULER] Не удалось отправить результат очистки акций:',
                            err.message
                        );
                    }
                }
            }
        } catch (err) {
            console.error(
                '[SCHEDULER] Ошибка ежедневной очистки акций:',
                err
            );

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    try {
                        await bot.sendMessage(
                            moderatorId,
                            `❌ Ошибка очистки акций: ${escapeHtml(err.message || String(err))}`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (notifyErr) {
                        console.error(
                            '[SCHEDULER] Не удалось отправить сообщение об ошибке:',
                            notifyErr.message
                        );
                    }
                }
            }
        } finally {
            isPromotionCleanRunning = false;
        }
    }, 60 * 1000);

    console.log(
        `[SCHEDULER] Ежедневная очистка акций запланирована на ` +
        `${targetHour}:${String(targetMinute).padStart(2, '0')}`
    );
}

function stopDailyPromotionCleaner() {
    if (promotionCleanInterval) {
        clearInterval(promotionCleanInterval);
        promotionCleanInterval = null;
    }

    isPromotionCleanRunning = false;
}

// Ежемесячный экспорт
let monthlyExportInterval = null;
let lastExportedMonth = null;
let isMonthlyExportRunning = false;

function startMonthlyExportChecker(db, bot = null) {
    if (monthlyExportInterval) {
        clearInterval(monthlyExportInterval);
        monthlyExportInterval = null;
    }

    isMonthlyExportRunning = false;

    monthlyExportInterval = setInterval(async () => {
        if (isMonthlyExportRunning) {
            return;
        }

        const localDate = getLocalDate();

        // Только первый день месяца после 00:00
        if (
            localDate.getDate() !== 1 ||
            localDate.getHours() !== 0
        ) {
            return;
        }

        const prevMonth = new Date(
            localDate.getFullYear(),
            localDate.getMonth() - 1,
            1
        );

        const monthStr =
            `${prevMonth.getFullYear()}-` +
            `${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

        if (lastExportedMonth === monthStr) {
            return;
        }

        isMonthlyExportRunning = true;

        try {
            console.log(
                `[SCHEDULER] Запуск автоматического экспорта за ${monthStr}`
            );

            await exportMonthlyEarnings(
                db,
                monthStr
            );

            // Только после успешного экспорта
            lastExportedMonth = monthStr;

            if (bot) {
                const moderatorId = process.env.MODERATOR_ID;

                if (moderatorId) {
                    try {
                        await bot.sendMessage(
                            moderatorId,
                            `📊 Автоматический экспорт за <b>${monthStr}</b> выполнен.`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (err) {
                        console.error(
                            '[SCHEDULER] Не удалось отправить сообщение об экспорте:',
                            err.message
                        );
                    }
                }
            }
        } catch (err) {
            console.error(
                '[SCHEDULER] Ошибка автоматического экспорта:',
                err
            );
        } finally {
            isMonthlyExportRunning = false;
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

    isMonthlyExportRunning = false;
}

// Остановка всех планировщиков
function stopAll() {
    stopWarehouseSyncChecker();
    stopOrderChecker();
    stopCooldownCleaner();
    stopDailyBackupChecker();
    stopAwaitingDeliverReminderChecker();
    stopDailyPromotionCleaner();
    stopMonthlyExportChecker();

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

    startAwaitingDeliverReminderChecker,
    stopAwaitingDeliverReminderChecker,

    startDailyPromotionCleaner,
    stopDailyPromotionCleaner,

    startMonthlyExportChecker,
    stopMonthlyExportChecker,

    stopAll
};