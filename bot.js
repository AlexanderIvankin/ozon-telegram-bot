require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const ozon = require('./ozon');
const bwipjs = require('bwip-js');
const scheduler = require('./scheduler');
const { syncEmployeesFromExcel } = require('./syncEmployees');
const registerCommands = require('./commands');
const debugMode = require('./debugMode');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const ADMIN_USER_ID = 762451011; // <<-- Administrator's Telegram ID

// Глобальное состояние для пошаговой обработки очереди
let currentOrderProcessing = null;      // { order, processingMessageId? }
let pendingNewOrders = [];              // массив заказов, ожидающих обработки

// --- Функция для логирования действий администратора ---
async function logAdminAction(adminId, action, details = '') {
    const admin = await db.getEmployee(adminId);
    const adminName = admin ? admin.name : 'Unknown Admin';
    console.log(`[ADMIN ACTION] ${adminName} (${adminId}): ${action} ${details}`);
}

// Функция-посредник для проверки доступа
async function isAuthorizedUser(tgUserId) {
    const employee = await db.getEmployee(tgUserId); // было getEmployeeById
    return employee !== undefined;
}

// Функция для проверки прав администратора
function isAdmin(tgUserId) {
    return tgUserId == ADMIN_USER_ID;
}

// Функция проверки новых заказов (перенесена из bot.js, но можно оставить здесь)
async function checkAndOfferNewOrders() {
    const debug = debugMode.isDebugMode();
    if (debug) console.log('[CHECK] Начало проверки новых заказов...');
    try {
        // 1. Получаем все заказы из API
        const allOrders = await ozon.fetchAwaitingOrders();
        if (debug) console.log(`[CHECK] Получено заказов из API: ${allOrders.length}`);
        if (!allOrders.length) return;

        // 2. Загружаем уже назначенные заказы
        const assignedOrderIds = (await db.db.all('SELECT order_id FROM assignments WHERE status = "assigned"')).map(r => r.order_id);
        if (debug) console.log(`[CHECK] Уже назначенных заказов: ${assignedOrderIds.length}`);

        // 3. Новые заказы (не назначенные)
        const newOrders = allOrders.filter(order => !assignedOrderIds.includes(order.posting_number));
        if (debug) console.log(`[CHECK] Новых заказов (не назначенных): ${newOrders.length}`);
        if (!newOrders.length) return;

        // 4. Обновляем глобальную очередь (перезаписываем, чтобы удалить обработанные)
        pendingNewOrders = newOrders;

        // 5. Если нет активного заказа – начинаем обработку первого
        if (!currentOrderProcessing && pendingNewOrders.length) {
            await processNextOrder();
        }
    } catch (err) {
        console.error('[CHECK] Ошибка в checkAndOfferNewOrders:', err);
    }
}

// Функция для отображения меню выбора для конкретного заказа
async function showOrderMenu(order) {
    let warehouseId = order.warehouse_id || order.delivery_method?.warehouse_id;
    if (warehouseId) warehouseId = String(warehouseId);
    const details = await ozon.getOrderDetails(order.posting_number);
    let productsInfo = '';
    if (details && details.products && details.products.length) {
        productsInfo = '\n\n*Состав:*\n';
        productsInfo += details.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
    }
    const adminChatId = ADMIN_USER_ID.toString();
    const messageText = `🆕 *Новый заказ!*\nНомер: ${order.posting_number}\nСклад: ${warehouseId || 'не указан'}${productsInfo}\n\nВыберите действие:`;
    const keyboard = [
        [{ text: '👑 Приоритетные', callback_data: `priority_${order.posting_number}` }],
        [{ text: '👥 Другие сотрудники', callback_data: `others_${order.posting_number}` }],
        [{ text: '⏩ Пропустить (на 30 мин)', callback_data: `skip_${order.posting_number}` }]
    ];
    await bot.sendMessage(adminChatId, messageText, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
    });
}

// Функция для обработки следующего заказа из очереди
async function processNextOrder() {
    try {
        if (!pendingNewOrders.length) {
            currentOrderProcessing = null;
            return;
        }
        const order = pendingNewOrders.shift();
        currentOrderProcessing = { order, timestamp: Date.now() };
        await showOrderMenu(order);
        if (debugMode.isDebugMode()) {
            console.log(`[CHECK] Отправлен заказ ${order.posting_number} админу. Осталось в очереди: ${pendingNewOrders.length}`);
        }

        // Определяем склад
        let warehouseId = order.warehouse_id || order.delivery_method?.warehouse_id;
        if (warehouseId) warehouseId = String(warehouseId);

        // Получаем детали заказа для состава
        const details = await ozon.getOrderDetails(order.posting_number);
        let productsInfo = '';
        if (details && details.products && details.products.length) {
            productsInfo = '\n\n*Состав:*\n';
            productsInfo += details.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
        }

        const adminChatId = ADMIN_USER_ID.toString();
        const messageText = `🆕 *Новый заказ!*\nНомер: ${order.posting_number}\nСклад: ${warehouseId || 'не указан'}${productsInfo}\n\nВыберите действие:`;

        const keyboard = [
            [{ text: '👑 Приоритетные', callback_data: `priority_${order.posting_number}` }],
            [{ text: '👥 Другие сотрудники', callback_data: `others_${order.posting_number}` }],
            [{ text: '⏩ Пропустить (на 30 мин)', callback_data: `skip_${order.posting_number}` }]
        ];

        await bot.sendMessage(adminChatId, messageText, {
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        });

        if (debugMode.isDebugMode()) {
            console.log(`[CHECK] Отправлен заказ ${order.posting_number} админу. Осталось в очереди: ${pendingNewOrders.length}`);
        }
    } catch (err) {
        console.error('[ERROR] processNextOrder:', err);
        currentOrderProcessing = null;
        // Попробовать следующий заказ через секунду
        setTimeout(() => processNextOrder(), 1000);
    }
}

(async () => {
    await db.initDB();
    console.log('Загрузка складов...');
    const warehouses = await ozon.fetchWarehousesFromOzon();
    if (warehouses.length) await db.syncWarehouses(warehouses);
    await syncEmployeesFromExcel(db);
    scheduler.startOrderChecker(30, checkAndOfferNewOrders);
    console.log(debugMode.getDebugModeStatusMessage());
    // Регистрируем все команды
    registerCommands(
        bot, db, ozon, bwipjs, scheduler, debugMode,
        isAdmin, checkAndOfferNewOrders,
        processNextOrder, showOrderMenu  // добавили showOrderMenu
    );
    setTimeout(() => checkAndOfferNewOrders(), 5000);
    console.log('Бот запущен...');
})();