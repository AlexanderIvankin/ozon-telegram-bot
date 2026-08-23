require('dotenv').config();
const { getLocalTimestamp } = require('./utils');

// ============================================================
//  ДОБАВЛЕНИЕ ВРЕМЕННЫХ МЕТОК КО ВСЕМ ЛОГАМ
// ============================================================
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function withTimestamp(originalFn) {
    return function (...args) {
        const timestamp = getLocalTimestamp();
        originalFn(`[${timestamp}]`, ...args);
    };
}

console.log = withTimestamp(originalLog);
console.error = withTimestamp(originalError);
console.warn = withTimestamp(originalWarn);

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const ozon = require('./ozon');
const scheduler = require('./scheduler');
const { syncEmployeesFromExcel } = require('./syncEmployees');
const { finishingOrders, pendingFinishConfirmations } = require('./state');
const { registerCommands, restorePendingForms, clearOrderState } = require('./commands');
const { escapeHtml } = require('./utils');
const debugMode = require('./debugMode');


const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // По возможности отправьте уведомление администратору
    const moderatorId = process.env.MODERATOR_ID;
    if (moderatorId) {
        try {
            bot.sendMessage(moderatorId, `⚠️ Критическая ошибка: ${reason}`);
        } catch (e) { }
    }
});

// --- Функция установки команд с повторами ---
async function setCommandsWithRetry(retries = 3, delay = 5000) {
    const commands = [
        { command: 'start', description: 'Запустить бота' },
        { command: 'my_orders', description: 'Мои активные заказы' },
        { command: 'toggle_orders', description: 'Приостановить/Возобновить приём заказов' },
        { command: 'finish_order', description: 'Завершить заказ (указать номер)' },
        { command: 'cancel_order', description: 'Отменить заказ (указать номер)' },
        { command: 'send_label', description: 'Получить этикетку заказа (указать номер)' },
        { command: 'send_all_labels', description: 'Получить этикетки всех завершённых заказов (1 раз в час)' },
        { command: 'my_monthly_earnings', description: 'Посмотреть заработок за ЛЮБОЙ (указать YYYY-MM) месяц (по умолчанию - текущий)' },
        { command: 'my_active_earnings', description: 'Полный активный заработок (с момента последнего расчёта)' },
        { command: 'help', description: 'Помощь' },
    ];

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await bot.setMyCommands(commands);
            console.log('✅ Меню команд Telegram установлено');
            return;
        } catch (err) {
            if (attempt < retries) {
                console.warn(`⚠️ Ошибка установки меню (попытка ${attempt}/${retries}): ${err.message}`);
                console.log(`⏳ Повтор через ${delay / 1000}с...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error('❌ Не удалось установить меню команд после нескольких попыток, продолжаем работу.');
            }
        }
    }
}

setCommandsWithRetry(3, 5000);


const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : []; // <<-- Administrator's Telegram IDS from .env
const MODERATOR_ID = process.env.MODERATOR_ID;  // <<-- Moderator's Telegram ID from .env

// Добавляем модератора в список администраторов, если его там нет
if (MODERATOR_ID && !ADMIN_IDS.includes(MODERATOR_ID)) {
    ADMIN_IDS.push(MODERATOR_ID);
}

const SYNC_ORDERS_TIME = 60; // время проверки новых заказов в минутах
const AUTO_SKIP_MINUTES = 15; // минут без ответа заказ пропускается автоматически

// Глобальные переменные для удаления старых сообщений
let lastOrderMessageId = null;
let lastOrderPhotoIds = []; // если фотографии отправляются отдельными сообщениями

// Глобальное состояние для отслеживания активности модератора
let lastModeratorActivity = Date.now();
let autoSkipped = false; // флаг того, что автоматический пропуск уже выполнен

let inactivityInterval = null; // таймер проверки неактивности

// Глобальное состояние для пошаговой обработки очереди
const orderState = {
    currentOrderProcessing: null, // { order, processingMessageId? }
    pendingNewOrders: []          // массив заказов, ожидающих обработки
};

// Функция обновления активности модератора
function updateModeratorActivity() {
    lastModeratorActivity = Date.now();
    autoSkipped = false;
}

// Функция для проверки прав администратора
function isAdmin(tgUserId) {
    return ADMIN_IDS.includes(tgUserId) || tgUserId == MODERATOR_ID;
}

// Функция для проверки прав модератора
function isModerator(tgUserId) {
    return tgUserId == MODERATOR_ID;
}

// Функция-посредник для проверки доступа
async function isAuthorizedUser(tgUserId) {
    const employee = await db.getEmployee(tgUserId);
    return employee !== undefined;
}


// Функция логирования действий
async function logActions(userId, action, details = '') {
    // Определяем роль пользователя
    let role = 'Пользователь';
    if (isModerator(userId)) {
        role = 'Модератор';
    } else if (isAdmin(userId)) {
        role = 'Администратор';
    }

    // Пытаемся получить имя из БД
    const user = await db.getEmployee(userId);
    const userName = user ? user.name : (role === 'Пользователь' ? 'Неавторизованный' : 'Unknown');

    console.log(`[${role} ACTION] ${userName} (${userId}): ${action} ${details}`);
}

// Функция отслеживания таймера неактивности админа
function startInactivityTimer() {
    if (inactivityInterval) clearInterval(inactivityInterval);
    inactivityInterval = setInterval(() => {
        if (scheduler.isCheckerPaused()) return;
        if (!orderState.currentOrderProcessing) return;
        const minutesSinceLastActivity = (Date.now() - lastModeratorActivity) / (60 * 1000);
        if (!autoSkipped && minutesSinceLastActivity >= AUTO_SKIP_MINUTES) {
            console.log(`[INACTIVITY] Модератор неактивен ${minutesSinceLastActivity.toFixed(1)} мин, принудительная перезагрузка очереди`);
            autoSkipped = true;
            forceReloadQueue();
        }
    }, 30000);
}

function stopInactivityTimer() {
    if (inactivityInterval) {
        clearInterval(inactivityInterval);
        inactivityInterval = null;
    }
}

let queueProcessing = false;

// Обёртка для processNextOrder с блокировкой
async function safeProcessNextOrder() {
    if (queueProcessing) {
        console.log('[QUEUE] Уже обрабатывается, пропускаем processNextOrder');
        return;
    }
    queueProcessing = true;
    try {
        await processNextOrder();
    } finally {
        queueProcessing = false;
    }
}

// Обёртка для checkAndOfferNewOrders с блокировкой
async function safeCheckAndOfferNewOrders() {
    if (queueProcessing) {
        console.log('[QUEUE] Уже обрабатывается, пропускаем checkAndOfferNewOrders');
        return;
    }
    queueProcessing = true;
    try {
        await checkAndOfferNewOrders();
    } finally {
        queueProcessing = false;
    }
}

// Функция проверки новых заказов
async function checkAndOfferNewOrders() {
    const debug = debugMode.isDebugMode();
    if (debug) console.log('[CHECK] Начало проверки новых заказов...');
    try {
        const allOrders = await ozon.fetchAwaitingOrders();
        if (debug) console.log(`[CHECK] Получено заказов из API: ${allOrders.length}`);

        // Очистка устаревших назначений
        const activeOrderIds = allOrders.map(o => o.posting_number);
        await cleanExpiredAssignments(activeOrderIds);

        // Если API вернул пустой массив — значит, заказов действительно нет
        if (!allOrders.length) {
            // НЕ сбрасываем очередь, если в ней уже есть заказы
            // Если очередь пуста, можно сбросить currentOrderProcessing
            if (orderState.pendingNewOrders.length === 0) {
                orderState.currentOrderProcessing = null;
            }
            return;
        }

        const assignedOrderIds = (await db.db.all('SELECT order_id FROM assignments WHERE status = "assigned"')).map(r => r.order_id);
        if (debug) console.log(`[CHECK] Уже назначенных заказов: ${assignedOrderIds.length}`);

        const newOrders = allOrders.filter(order => !assignedOrderIds.includes(order.posting_number));
        if (debug) console.log(`[CHECK] Новых заказов (не назначенных): ${newOrders.length}`);

        if (!newOrders.length) {
            // Новых заказов нет, но текущие оставляем
            return;
        }

        // Сохраняем текущий обрабатываемый заказ, если он ещё есть в новом списке
        const currentOrderId = orderState.currentOrderProcessing?.order?.posting_number;
        if (currentOrderId && !newOrders.some(o => o.posting_number === currentOrderId)) {
            // Текущий заказ уже не в статусе awaiting_packaging — сбрасываем
            console.log(`[CHECK] Текущий заказ ${currentOrderId} больше не в статусе awaiting_packaging, сбрасываем`);
            orderState.currentOrderProcessing = null;
        }

        // Заменяем очередь новыми заказами (но если текущий заказ ещё актуален, он уже в newOrders)
        orderState.pendingNewOrders.length = 0;
        orderState.pendingNewOrders.push(...newOrders);

        // Если нет активного заказа и есть заказы – отправляем первый
        if (!orderState.currentOrderProcessing && orderState.pendingNewOrders.length) {
            await processNextOrder();
        }
    } catch (err) {
        console.error('[CHECK] Ошибка в checkAndOfferNewOrders:', err);
        // При ошибке НЕ сбрасываем очередь, чтобы не потерять уже имеющиеся заказы
        // Можно отправить уведомление администратору
        try {
            const moderatorId = process.env.MODERATOR_ID;
            if (moderatorId) {
                await bot.sendMessage(moderatorId, `⚠️ Ошибка синхронизации заказов: ${err.message}`);
            }
        } catch (e) { /* игнорируем */ }
    }
}

// Функция для очистки устаревших назначений
async function cleanExpiredAssignments(activeOrderIds) {
    const activeSet = new Set(activeOrderIds);

    // LEFT JOIN — чтобы видеть назначения на отсутствующих сотрудников
    const assignments = await db.db.all(
        'SELECT a.order_id, a.employee_id, e.tg_user_id, e.name as employee_name, ' +
        'e.is_fired, a.status as local_status ' +
        'FROM assignments a LEFT JOIN employees e ON a.employee_id = e.id ' +
        'WHERE a.status = "assigned"'
    );

    for (const assignment of assignments) {
        const orderId = assignment.order_id;

        // === 1. Проверка зависших состояний завершения ===
        const finishState = finishingOrders.get(orderId);
        if (finishState) {
            const elapsed = Date.now() - finishState.startedAt;
            if (elapsed < 10 * 60 * 1000) {
                console.log(
                    `[CLEAN] Заказ ${orderId} в процессе завершения ` +
                    `(${Math.round(elapsed / 1000)} сек.), пропускаем`
                );
                continue;
            }
            console.warn(
                `[CLEAN] Заказ ${orderId} завис в finishingOrders ` +
                `на ${Math.round(elapsed / 60000)} мин. Принудительно удаляем.`
            );
            finishingOrders.delete(orderId);
            pendingFinishConfirmations.delete(orderId);
        }

        const confirmState = pendingFinishConfirmations.get(orderId);
        if (confirmState) {
            if (!confirmState.startedAt) {
                console.warn(
                    `[CLEAN] Заказ ${orderId} имеет pendingFinishConfirmations без startedAt. ` +
                    `Удаляем зависшее состояние.`
                );
                pendingFinishConfirmations.delete(orderId);
            } else {
                const elapsed = Date.now() - confirmState.startedAt;
                if (elapsed > 10 * 60 * 1000) {
                    console.warn(
                        `[CLEAN] Заказ ${orderId} имеет зависшее pendingFinishConfirmations ` +
                        `(${Math.round(elapsed / 60000)} мин), удаляем.`
                    );
                    pendingFinishConfirmations.delete(orderId);
                } else {
                    console.log(
                        `[CLEAN] Заказ ${orderId} ожидает подтверждения, пропускаем`
                    );
                    continue;
                }
            }
        }

        // === 2. Если заказ всё ещё в awaiting_packaging — пропускаем ===
        if (activeSet.has(orderId)) {
            continue;
        }

        // === 3. Если заказ уже завершён в БД — пропускаем ===
        if (assignment.local_status === 'completed') {
            console.log(`[CLEAN] Заказ ${orderId} уже завершён (status=completed), пропускаем`);
            continue;
        }

        const freshStatus = await db.db.get(
            'SELECT status FROM assignments WHERE order_id = ?',
            orderId
        );
        if (freshStatus && freshStatus.status === 'completed') {
            console.log(`[CLEAN] Заказ ${orderId} уже завершён (повторная проверка), пропускаем`);
            continue;
        }

        // === 4. Если сотрудник отсутствует или уволен — снимаем заказ ===
        if (!assignment.employee_name || assignment.is_fired === 1) {
            console.warn(
                `[CLEAN] Заказ ${orderId} назначен на некорректного сотрудника ` +
                `(employee_id=${assignment.employee_id}), снимаем`
            );

            await db.autoCancelOrder(orderId, assignment.employee_id);
            await clearOrderState(bot, orderId, assignment.tg_user_id || null);

            // Удаляем из очереди
            const idx = orderState.pendingNewOrders.findIndex(o => o.posting_number === orderId);
            if (idx !== -1) orderState.pendingNewOrders.splice(idx, 1);
            if (orderState.currentOrderProcessing && orderState.currentOrderProcessing.order?.posting_number === orderId) {
                orderState.currentOrderProcessing = null;
            }

            // Уведомляем сотрудника, если он есть
            if (assignment.tg_user_id) {
                try {
                    await bot.sendMessage(
                        assignment.tg_user_id,
                        `❌ Заказ <code>${escapeHtml(orderId)}</code> был снят с вас ` +
                        `(сотрудник отсутствует или уволен).`,
                        { parse_mode: 'HTML' }
                    );
                } catch (e) {
                    console.warn(`[CLEAN] Не удалось уведомить сотрудника по заказу ${orderId}:`, e.message);
                }
            }

            // Всегда уведомляем модератора
            const moderatorId = process.env.MODERATOR_ID;
            if (moderatorId) {
                await bot.sendMessage(
                    moderatorId,
                    `🔄 Заказ <code>${escapeHtml(orderId)}</code> автоматически снят с сотрудника ` +
                    `<b>${escapeHtml(assignment.employee_name || 'не найден')}</b> ` +
                    `(сотрудник отсутствует или уволен).`,
                    { parse_mode: 'HTML' }
                );
            }
            continue;
        }

        // === 5. Стандартное удаление: заказ больше не в awaiting_packaging ===
        console.log(
            `[CLEAN] Заказ ${orderId} больше не в awaiting_packaging, отменяем назначение у ${assignment.employee_name}`
        );

        await db.autoCancelOrder(orderId, assignment.employee_id);
        await clearOrderState(bot, orderId, assignment.tg_user_id);

        // Удаляем из очереди
        const idx = orderState.pendingNewOrders.findIndex(o => o.posting_number === orderId);
        if (idx !== -1) orderState.pendingNewOrders.splice(idx, 1);
        if (orderState.currentOrderProcessing && orderState.currentOrderProcessing.order?.posting_number === orderId) {
            orderState.currentOrderProcessing = null;
        }

        // Уведомляем сотрудника
        try {
            await bot.sendMessage(
                assignment.tg_user_id,
                `❌ Заказ <code>${escapeHtml(orderId)}</code> был отменён (или более не актуален). Он снят с вас.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) { }

        // Уведомляем модератора
        const moderatorId = process.env.MODERATOR_ID;
        if (moderatorId) {
            await bot.sendMessage(
                moderatorId,
                `🔄 Заказ <code>${escapeHtml(orderId)}</code> автоматически снят с сотрудника ` +
                `<b>${escapeHtml(assignment.employee_name)}</b>, так как он больше не в статусе awaiting_packaging.`,
                { parse_mode: 'HTML' }
            );
        }
    }
}

// Функция для отображения меню выбора для конкретного заказа
async function showOrderMenu(order) {
    const debug = debugMode.isDebugMode();
    if (debug) console.log(`[MENU] Отображение заказа ${order.posting_number} – начало`);
    const details = await ozon.getOrderDetails(order.posting_number);

    let warehouseDisplay = order.analytics_data?.warehouse
        ? `<b>${escapeHtml(order.analytics_data.warehouse)}</b>`
        : (order.warehouse_id ? `ID: <code>${escapeHtml(order.warehouse_id)}</code>` : 'не указан');

    let createdAtDisplay = '';
    if (details.in_process_at) {
        const date = new Date(details.in_process_at);
        const dateStr = date.toLocaleDateString('ru-RU');
        const timeStr = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        createdAtDisplay = `\nЗаказ создан: ${dateStr}, ${timeStr}`;
    }

    let productsInfo = '';
    let skuList = [];
    let totalAmount = 0;
    let currency = 'RUB';

    if (details?.products?.length) {
        productsInfo = '\n\n<b>Состав:</b>\n';
        for (const p of details.products) {
            let article = p.offer_id || (p.barcodes?.[0]);
            let articleDisplay = article ? `<code>${escapeHtml(article)}</code>` : '—';

            let price = parseFloat(p.price) || 0;
            let currencyCode = p.currency_code || 'RUB';
            if (currencyCode && currency === 'RUB') currency = currencyCode;
            let priceDisplay = price > 0 ? `<b>${price.toFixed(2)}</b> ${currencyCode}` : '—';

            let dims = p.dimensions || {};
            let length = dims.length ? `${dims.length} см` : '—';
            let width = dims.width ? `${dims.width} см` : '—';
            let height = dims.height ? `${dims.height} см` : '—';
            let weightVal = dims.weight ? parseFloat(dims.weight) : (p.weight_max ? parseFloat(p.weight_max) * 1000 : 0);
            let weightDisplay = weightVal > 0 ? `${weightVal.toFixed(0)} г` : '—';
            let dimsDisplay = `📏 <b>${length}</b> × <b>${width}</b> × <b>${height}</b>, ⚖️ <b>${weightDisplay}</b>`;

            let statsDisplay = '';
            if (p.offer_id) {
                const stats = await db.getProductStats(p.offer_id);
                if (stats) {
                    statsDisplay = `   Материал: <b>${escapeHtml(stats.material)}</b>\n   Цвет: <b>${escapeHtml(stats.color)}</b>\n`;
                }
            }

            productsInfo += `• ${escapeHtml(p.name)} — ${p.quantity} шт.\n`;
            productsInfo += `   Артикул: ${articleDisplay}\n`;
            productsInfo += `   Цена: ${priceDisplay}\n`;
            productsInfo += `   Размеры: ${dimsDisplay}\n`;
            if (statsDisplay) productsInfo += statsDisplay;

            totalAmount += price * p.quantity;
            if (p.sku) skuList.push(p.sku);
        }

        let totalDisplay = totalAmount > 0 ? `<b>${totalAmount.toFixed(2)}</b> ${currency}` : '—';
        productsInfo += `\n<b>Общая сумма заказа:</b> ${totalDisplay}`;
    }

    const adminChatId = MODERATOR_ID.toString();
    const messageText = `🆕 <b>Новый заказ!</b>\nНомер: <code>${escapeHtml(order.posting_number)}</code>\nСклад: ${warehouseDisplay}${createdAtDisplay}${productsInfo}\n\nВыберите действие:`;

    const keyboard = [
        [{ text: '👑 Приоритетные', callback_data: `priority_${order.posting_number}` }],
        [{ text: '👥 Другие сотрудники', callback_data: `others_${order.posting_number}` }],
        [{ text: `⏩ Пропустить (на ${SYNC_ORDERS_TIME} мин)`, callback_data: `skip_${order.posting_number}` }]
    ];

    await deleteLastOrderMessages();

    const sentMsg = await bot.sendMessage(adminChatId, messageText, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'HTML'
    });
    lastOrderMessageId = sentMsg.message_id;

    if (skuList.length) {
        try {
            const imageMap = await ozon.fetchProductsImages(skuList);
            for (const p of details.products) {
                try {
                    const imgUrl = imageMap[p.sku];
                    if (imgUrl && imgUrl.startsWith('http')) {
                        const imageBuffer = await ozon.downloadImage(imgUrl);
                        if (imageBuffer) {
                            const sentPhoto = await bot.sendPhoto(adminChatId, imageBuffer, {
                                caption: `📷 Фото к заказу <code>${escapeHtml(order.posting_number)}</code>: <b>${escapeHtml(p.name)}</b>`,
                                parse_mode: 'HTML'
                            });
                            lastOrderPhotoIds.push(sentPhoto.message_id);
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                } catch (photoError) {
                    console.error(`Ошибка отправки фото для ${p.name}:`, photoError.message);
                }
            }
        } catch (error) {
            console.error(`Ошибка получения фото для заказа ${order.posting_number}:`, error.message);
        }
    }

    autoSkipped = true;

    if (debug) console.log(`[MENU] Заказ ${order.posting_number} – успешно обработан`);
}

// Функция для обработки следующего заказа из очереди
async function processNextOrder() {
    try {
        if (!orderState.pendingNewOrders.length) {
            orderState.currentOrderProcessing = null;
            return;
        }
        console.log(`[NEXT] Вызов processNextOrder, pendingNewOrders.length = ${orderState.pendingNewOrders.length}, currentOrderProcessing = ${orderState.currentOrderProcessing ? orderState.currentOrderProcessing.order.posting_number : 'null'}`);
        let attempts = 0;
        while (orderState.pendingNewOrders.length && attempts < 3) {
            const order = orderState.pendingNewOrders.shift();
            try {
                await showOrderMenu(order);
                orderState.currentOrderProcessing = { order, timestamp: Date.now() };
                return;
            } catch (err) {
                attempts++;
                console.error(`Ошибка при отправке заказа ${order.posting_number}, попытка ${attempts}`);
                if (attempts >= 3) {
                    console.error(`Заказ ${order.posting_number} пропущен из-за повторяющихся ошибок`);
                } else {
                    orderState.pendingNewOrders.unshift(order);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        orderState.currentOrderProcessing = null;
    } catch (err) {
        console.error('[ERROR] processNextOrder:', err);
        orderState.currentOrderProcessing = null;
        setTimeout(() => processNextOrder(), 1000);
    }
}

// Функция для удаления сообщений с последнего заказа
async function deleteLastOrderMessages() {
    const adminChatId = MODERATOR_ID.toString();
    if (lastOrderMessageId) {
        try {
            await bot.deleteMessage(adminChatId, lastOrderMessageId);
        } catch (err) { /* ignore */ }
        lastOrderMessageId = null;
    }
    for (const photoId of lastOrderPhotoIds) {
        try {
            await bot.deleteMessage(adminChatId, photoId);
        } catch (err) { /* ignore */ }
    }
    lastOrderPhotoIds = [];
}

async function forceReloadQueue() {
    await deleteLastOrderMessages();
    orderState.currentOrderProcessing = null;
    orderState.pendingNewOrders.length = 0;
    try {
        await safeCheckAndOfferNewOrders();
        if (!orderState.currentOrderProcessing && orderState.pendingNewOrders.length) {
            await safeProcessNextOrder();
        }
    } catch (err) {
        console.error('❌ Ошибка при принудительной перезагрузке:', err);
        await bot.sendMessage(MODERATOR_ID, `❌ Ошибка перезагрузки: ${err.message}`);
    }
}

async function gracefulShutdown() {
    console.log('Получен сигнал завершения, удаляем последнее сообщение...');
    await deleteLastOrderMessages();
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

(async () => {
    console.log('Инициализация БД...');
    await db.initDB();
    console.log('БД инициализирована');
    const warehouses = await ozon.fetchWarehousesFromOzon();
    if (warehouses.length) {
        await db.syncWarehouses(warehouses);
    }
    await syncEmployeesFromExcel(db);
    scheduler.startOrderChecker(SYNC_ORDERS_TIME, safeCheckAndOfferNewOrders);
    startInactivityTimer();
    console.log(debugMode.getDebugModeStatusMessage());
    // Регистрируем все команды
    registerCommands(
        bot, db, ozon, scheduler, debugMode,
        isAuthorizedUser, isModerator, isAdmin,
        showOrderMenu, safeCheckAndOfferNewOrders,
        safeProcessNextOrder, orderState,
        deleteLastOrderMessages, updateModeratorActivity,
        startInactivityTimer, stopInactivityTimer
    );
    setTimeout(async () => {
        // Восстанавливаем состояния для активных заказов
        try {
            await restorePendingForms(db, ozon, bot);
        } catch (err) {
            console.error('[STARTUP] Ошибка restorePendingForms:', err);
        }
        // Проверяем новые заказы из API (внутри вызовет cleanExpiredAssignments)
        try {
            await checkAndOfferNewOrders();
        } catch (err) {
            console.error('[STARTUP] Ошибка checkAndOfferNewOrders:', err);
        }
    }, 5000);
    scheduler.startCooldownCleaner();
    // Ежедневный бэкап базы данных bot.db
    scheduler.startDailyBackupChecker(bot);
    // Ежедневная очистка акций (по умолчанию в 3:00)
    scheduler.startDailyPromotionCleaner(ozon, bot);
    // Eжемесячный экспорт статистики заработков в Excel
    scheduler.startMonthlyExportChecker(db, bot);

    console.log('Бот запущен...');
})();