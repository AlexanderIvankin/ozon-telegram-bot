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

// Установка команд меню Telegram (глобальное меню для всех пользователей)
bot.setMyCommands([
    { command: 'start', description: 'Запустить бота' },
    { command: 'help', description: 'Помощь' },
    { command: 'my_orders', description: 'Мои активные заказы' },
    { command: 'finish_order', description: 'Завершить заказ (указать номер)' },
    { command: 'cancel_order', description: 'Отменить заказ (указать номер)' }
]).then(() => console.log('✅ Меню команд Telegram установлено')).catch(err => console.error('Ошибка установки меню:', err));


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

        // 4. Обновляем глобальную очередь, исключая текущий обрабатываемый заказ
        let filteredNewOrders = newOrders;
        if (currentOrderProcessing && currentOrderProcessing.order) {
            filteredNewOrders = newOrders.filter(order => order.posting_number !== currentOrderProcessing.order.posting_number);
        }
        pendingNewOrders = filteredNewOrders;

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
    const debug = debugMode.isDebugMode();
    if (debug) console.log(`[MENU] Отображение заказа ${order.posting_number} – начало`);
    const details = await ozon.getOrderDetails(order.posting_number);

    let warehouseDisplay = order.analytics_data?.warehouse || (order.warehouse_id ? `ID: ${order.warehouse_id}` : 'не указан');

    let productsInfo = '';
    let skuList = [];
    if (details?.products?.length) {
        productsInfo = '\n\n*Состав:*\n';
        for (const p of details.products) {
            // Берём артикул: offer_id или первый barcode
            let article = p.offer_id || (p.barcodes?.[0]);
            if (article) {
                productsInfo += `• ${p.name} — ${p.quantity} шт. (Артикул: ${article})\n`;
            } else {
                productsInfo += `• ${p.name} — ${p.quantity} шт. (SKU: ${p.sku})\n`;
            }
            if (p.sku) skuList.push(p.sku);
        }
    }

    const adminChatId = ADMIN_USER_ID.toString();
    const messageText = `🆕 *Новый заказ!*\nНомер: ${order.posting_number}\nСклад: ${warehouseDisplay}${productsInfo}\n\nВыберите действие:`;
    const keyboard = [
        [{ text: '👑 Приоритетные', callback_data: `priority_${order.posting_number}` }],
        [{ text: '👥 Другие сотрудники', callback_data: `others_${order.posting_number}` }],
        [{ text: '⏩ Пропустить (на 30 мин)', callback_data: `skip_${order.posting_number}` }]
    ];
    await bot.sendMessage(adminChatId, messageText, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
    });

    if (skuList.length) {
        try {
            const imageMap = await ozon.fetchProductsImages(skuList);
            for (const p of details.products) {
                try {
                    const imgUrl = imageMap[p.sku];
                    if (imgUrl && imgUrl.startsWith('http')) {
                        const imageBuffer = await ozon.downloadImage(imgUrl);
                        if (imageBuffer) {
                            await bot.sendPhoto(adminChatId, imageBuffer, {
                                caption: `Фото к заказу ${order.posting_number}: ${p.name}`
                            });
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

    if (debug) console.log(`[MENU] Заказ ${order.posting_number} – успешно обработан`);
}

// Функция для обработки следующего заказа из очереди
async function processNextOrder() {
    try {
        if (!pendingNewOrders.length) {
            currentOrderProcessing = null;
            return;
        }
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
                    // можно записать в отдельную таблицу problematic_orders
                } else {
                    pendingNewOrders.unshift(order); // вернуть в начало очереди
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        currentOrderProcessing = null;
        if (debugMode.isDebugMode()) {
            console.log(`[CHECK] Отправлен заказ ${order.posting_number} админу. Осталось в очереди: ${pendingNewOrders.length}`);
        }
    } catch (err) {
        console.error('[ERROR] processNextOrder:', err);
        currentOrderProcessing = null;
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
        processNextOrder, showOrderMenu,
        pendingNewOrders, currentOrderProcessing
    );
    setTimeout(() => checkAndOfferNewOrders(), 5000);
    console.log('Бот запущен...');
})();