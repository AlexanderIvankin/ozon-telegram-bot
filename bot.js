require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const ozon = require('./ozon');
const scheduler = require('./scheduler');
const { syncEmployeesFromExcel } = require('./syncEmployees');
const { registerCommands, restorePendingForms, clearOrderState, escapeHtml } = require('./commands');
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
        { command: 'my_monthly_earnings', description: 'Заработок за месяц (указать YYYY-MM)' },
        { command: 'my_active_earnings', description: 'Полный активный заработок (до расчёта)' },
        { command: 'my_orders', description: 'Мои активные заказы' },
        { command: 'finish_order', description: 'Завершить заказ (указать номер)' },
        { command: 'cancel_order', description: 'Отменить заказ (указать номер)' },
        { command: 'send_label', description: 'Получить этикетку заказа (указать номер)' },
        { command: 'send_all_labels', description: 'Получить этикетки всех завершённых заказов (1 раз в час)' },
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
let currentOrderProcessing = null;      // { order, processingMessageId? }
let pendingNewOrders = [];              // массив заказов, ожидающих обработки

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
        if (!currentOrderProcessing) return;
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
            if (pendingNewOrders.length === 0) {
                currentOrderProcessing = null;
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
        const currentOrderId = currentOrderProcessing?.order?.posting_number;
        if (currentOrderId && !newOrders.some(o => o.posting_number === currentOrderId)) {
            // Текущий заказ уже не в статусе awaiting_packaging — сбрасываем
            console.log(`[CHECK] Текущий заказ ${currentOrderId} больше не в статусе awaiting_packaging, сбрасываем`);
            currentOrderProcessing = null;
        }

        // Заменяем очередь новыми заказами (но если текущий заказ ещё актуален, он уже в newOrders)
        pendingNewOrders.length = 0;
        pendingNewOrders.push(...newOrders);

        // Если нет активного заказа и есть заказы – отправляем первый
        if (!currentOrderProcessing && pendingNewOrders.length) {
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
    // activeOrderIds — множество posting_number из свежего списка
    const activeSet = new Set(activeOrderIds);

    // Получаем все активные назначения
    const assignments = await db.db.all(
        'SELECT a.order_id, a.employee_id, e.tg_user_id, e.name as employee_name ' +
        'FROM assignments a JOIN employees e ON a.employee_id = e.id ' +
        'WHERE a.status = "assigned"'
    );

    for (const assignment of assignments) {
        const orderId = assignment.order_id;
        if (!activeSet.has(orderId)) {
            console.log(`[CLEAN] Заказ ${orderId} больше не в awaiting_packaging, отменяем назначение у ${assignment.employee_name}`);

            // Отменяем назначение (обновляем статус в БД) - БЕЗ увеличения счётчика
            await db.autoCancelOrder(orderId, assignment.employee_id);

            await clearOrderState(bot, orderId, assignment.tg_user_id);

            // Если заказ был в очереди — удаляем
            const idx = pendingNewOrders.findIndex(o => o.posting_number === orderId);
            if (idx !== -1) pendingNewOrders.splice(idx, 1);
            if (currentOrderProcessing && currentOrderProcessing.order.posting_number === orderId) {
                currentOrderProcessing = null;
            }

            // Уведомляем сотрудника
            try {
                await bot.sendMessage(
                    assignment.tg_user_id,
                    `❌ Заказ ${orderId} был отменён (или более не актуален). Он снят с вас.`
                );
            } catch (e) { /* игнорируем, если не можем отправить */ }

            // Уведомляем модератора
            const moderatorId = process.env.MODERATOR_ID;
            if (moderatorId) {
                await bot.sendMessage(
                    moderatorId,
                    `🔄 Заказ ${orderId} автоматически снят с сотрудника ${assignment.employee_name}, так как он больше не в статусе awaiting_packaging.`
                );
            }
        }
    }
}

// Функция для отображения меню выбора для конкретного заказа
async function showOrderMenu(order) {
    const debug = debugMode.isDebugMode();
    if (debug) console.log(`[MENU] Отображение заказа ${order.posting_number} – начало`);
    const details = await ozon.getOrderDetails(order.posting_number);

    let warehouseDisplay = order.analytics_data?.warehouse || (order.warehouse_id ? `ID: ${order.warehouse_id}` : 'не указан');

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
            let articleDisplay = article ? `<b>${article}</b>` : '—';

            let price = parseFloat(p.price) || 0;
            let currencyCode = p.currency_code || 'RUB';
            if (currencyCode && currency === 'RUB') currency = currencyCode;
            let priceDisplay = price > 0 ? `${price.toFixed(2)} ${currencyCode}` : '—';

            let dims = p.dimensions || {};
            let length = dims.length ? `${dims.length} см` : '—';
            let width = dims.width ? `${dims.width} см` : '—';
            let height = dims.height ? `${dims.height} см` : '—';
            let weightVal = dims.weight ? parseFloat(dims.weight) : (p.weight_max ? parseFloat(p.weight_max) * 1000 : 0);
            let weightDisplay = weightVal > 0 ? `${weightVal.toFixed(0)} г` : '—';
            let dimsDisplay = `📏 ${length} × ${width} × ${height}, ⚖️ ${weightDisplay}`;

            let statsDisplay = '';
            if (p.offer_id) {
                const stats = await db.getProductStats(p.offer_id);
                if (stats) {
                    statsDisplay = `   Материал: ${stats.material}\n   Цвет: ${stats.color}\n`;
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

        let totalDisplay = totalAmount > 0 ? `${totalAmount.toFixed(2)} ${currency}` : '—';
        productsInfo += `\n<b>Общая сумма заказа:</b> ${totalDisplay}`;
    }

    const adminChatId = MODERATOR_ID.toString();
    const messageText = `🆕 <b>Новый заказ!</b>\nНомер: ${order.posting_number}\nСклад: ${warehouseDisplay}${createdAtDisplay}${productsInfo}\n\nВыберите действие:`;

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
                                caption: `Фото к заказу ${order.posting_number}: ${p.name}`
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
        if (!pendingNewOrders.length) {
            currentOrderProcessing = null;
            return;
        }
        console.log(`[NEXT] Вызов processNextOrder, pendingNewOrders.length = ${pendingNewOrders.length}, currentOrderProcessing = ${currentOrderProcessing ? currentOrderProcessing.order.posting_number : 'null'}`);
        let attempts = 0;
        while (pendingNewOrders.length && attempts < 3) {
            const order = pendingNewOrders.shift();
            try {
                await showOrderMenu(order);
                currentOrderProcessing = { order, timestamp: Date.now() };
                return;
            } catch (err) {
                attempts++;
                console.error(`Ошибка при отправке заказа ${order.posting_number}, попытка ${attempts}`);
                if (attempts >= 3) {
                    console.error(`Заказ ${order.posting_number} пропущен из-за повторяющихся ошибок`);
                } else {
                    pendingNewOrders.unshift(order);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        currentOrderProcessing = null;
    } catch (err) {
        console.error('[ERROR] processNextOrder:', err);
        currentOrderProcessing = null;
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
    currentOrderProcessing = null;
    pendingNewOrders.length = 0;
    try {
        await safeCheckAndOfferNewOrders();
        if (!currentOrderProcessing && pendingNewOrders.length) {
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
    console.log('1. Инициализация БД...');
    await db.initDB();
    console.log('2. БД инициализирована');
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
        showOrderMenu, safeCheckAndOfferNewOrders, safeProcessNextOrder,
        pendingNewOrders, currentOrderProcessing,
        deleteLastOrderMessages, updateModeratorActivity,
        startInactivityTimer, stopInactivityTimer
    );
    setTimeout(() => {
        checkAndOfferNewOrders();
        restorePendingForms(db, ozon, bot);
    }, 5000);
    // Eжемесячный экспорт статистики заработков в Excel
    scheduler.startMonthlyExportChecker(db, bot);
    console.log('Бот запущен...');
})();