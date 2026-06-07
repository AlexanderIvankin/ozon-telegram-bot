require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const ozon = require('./ozon');
const bwipjs = require('bwip-js');
const scheduler = require('./scheduler');
const debugMode = require('./debugMode');
const registerCommands = require('./commands');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const ADMIN_USER_ID = 762451011; // <<-- Administrator's Telegram ID

// --- Функция для логирования действий администратора ---
async function logAdminAction(adminId, action, details = '') {
    const admin = await db.getEmployee(adminId);
    const adminName = admin ? admin.name : 'Unknown Admin';
    console.log(`[ADMIN ACTION] ${adminName} (${adminId}): ${action} ${details}`);
}

// Функция-посредник для проверки доступа
async function isAuthorizedUser(tgUserId) {
    const employee = await db.getEmployee(tgUserId);
    // Пользователь считается авторизованным, если он есть в БД.
    return employee !== undefined;
}

// Функция для проверки прав администратора
function isAdmin(tgUserId) {
    return tgUserId == ADMIN_USER_ID;
}

// Функция проверки новых заказов (перенесена из bot.js, но можно оставить здесь)
async function checkAndOfferNewOrders() {
    const allOrders = await ozon.fetchAwaitingOrders();
    if (!allOrders.length) return;
    const assignedOrderIds = (await db.db.all('SELECT order_id FROM assignments WHERE status = "assigned"')).map(r => r.order_id);
    const newOrders = allOrders.filter(order => !assignedOrderIds.includes(order.posting_number));
    if (!newOrders.length) return;
    const adminChatId = ADMIN_USER_ID.toString();
    for (const order of newOrders) {
        let warehouseId = order.warehouse_id || order.delivery_method?.warehouse_id;
        if (warehouseId) warehouseId = String(warehouseId);
        const priorityEmployees = await db.getAllEmployeesWithStats(warehouseId); // все сотрудники этого склада
        const otherEmployees = await db.getAllEmployeesWithStats(); // все сотрудники
        const keyboard = [];
        if (priorityEmployees.length) {
            keyboard.push([{ text: '👑 Приоритетные', callback_data: `show_priority_${order.posting_number}` }]);
        }
        if (otherEmployees.length) {
            keyboard.push([{ text: '👥 Другие сотрудники', callback_data: `show_others_${order.posting_number}` }]);
        }
        keyboard.push([{ text: '⏩ Пропустить (на 30 мин)', callback_data: `skip_${order.posting_number}` }]);
        const messageText = `🆕 Новый заказ!\nНомер: ${order.posting_number}\nСклад: ${warehouseId || 'не указан'}\nТоваров: ${order.products?.length || '?'}\n\nВыберите действие:`;
        await bot.sendMessage(adminChatId, messageText, { reply_markup: { inline_keyboard: keyboard } });
    }
}

(async () => {
    await db.initDB();
    console.log('Загрузка складов...');
    const warehouses = await ozon.fetchWarehousesFromOzon();
    if (warehouses.length) await db.syncWarehouses(warehouses);
    scheduler.startOrderChecker(30, checkAndOfferNewOrders);
    console.log(debugMode.getDebugModeStatusMessage());
    // Регистрируем все команды
    registerCommands(bot, db, ozon, bwipjs, scheduler, debugMode, isAdmin, checkAndOfferNewOrders);
    console.log('Бот запущен...');
})();