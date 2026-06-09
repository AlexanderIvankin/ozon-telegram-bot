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

// --- Функция для логирования действий администратора ---
async function logAdminAction(adminId, action, details = '') {
    const admin = await db.getEmployee(adminId);
    const adminName = admin ? admin.name : 'Unknown Admin';
    console.log(`[ADMIN ACTION] ${adminName} (${adminId}): ${action} ${details}`);
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

// Функция проверки новых заказов
async function checkAndOfferNewOrders() {
    const debug = debugMode.isDebugMode();
    if (debug) console.log('[CHECK] Начало проверки новых заказов...');
    try {
        const allOrders = await ozon.fetchAwaitingOrders();
        if (debug) console.log(`[CHECK] Получено заказов из API: ${allOrders.length}`);
        if (!allOrders.length) return;

        const assignedOrderIds = (await db.db.all('SELECT order_id FROM assignments WHERE status = "assigned"')).map(r => r.order_id);
        if (debug) console.log(`[CHECK] Уже назначенных заказов: ${assignedOrderIds.length}`);

        const newOrders = allOrders.filter(order => !assignedOrderIds.includes(order.posting_number));
        if (debug) console.log(`[CHECK] Новых заказов (не назначенных): ${newOrders.length}`);
        if (!newOrders.length) {
            // Если нет новых заказов, сбрасываем очередь
            pendingNewOrders = [];
            currentOrderProcessing = null;
            return;
        }

        // Обновляем очередь
        pendingNewOrders.length = 0;
        pendingNewOrders.push(...newOrders);

        // Проверяем текущий обрабатываемый заказ
        const currentOrderId = currentOrderProcessing?.order?.posting_number;
        if (currentOrderId) {
            const stillInQueue = pendingNewOrders.some(o => o.posting_number === currentOrderId);
            if (!stillInQueue) {
                console.log(`[CHECK] Текущий заказ ${currentOrderId} больше не в очереди, сбрасываем`);
                currentOrderProcessing = null;
            }
        }

        // Если нет активного заказа и есть заказы в очереди – отправляем первый
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
            let article = p.offer_id || (p.barcodes?.[0]);
            if (article) {
                productsInfo += `• ${p.name} — ${p.quantity} шт. (Артикул: ${article})\n`;
            } else {
                productsInfo += `• ${p.name} — ${p.quantity} шт. (SKU: ${p.sku})\n`;
            }
            if (p.sku) skuList.push(p.sku);
        }
    }

    const adminChatId = MODERATOR_ID.toString();
    const messageText = `🆕 *Новый заказ!*\nНомер: ${order.posting_number}\nСклад: ${warehouseDisplay}${productsInfo}\n\nВыберите действие:`;
    const keyboard = [
        [{ text: '👑 Приоритетные', callback_data: `priority_${order.posting_number}` }],
        [{ text: '👥 Другие сотрудники', callback_data: `others_${order.posting_number}` }],
        [{ text: '⏩ Пропустить (на 30 мин)', callback_data: `skip_${order.posting_number}` }]
    ];

    // Удаляем старые сообщения
    await deleteLastOrderMessages();

    // Отправляем текст и сохраняем ID
    const sentMsg = await bot.sendMessage(adminChatId, messageText, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
    });
    lastOrderMessageId = sentMsg.message_id;

    // Отправляем фотографии
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
    // Удаляем старое сообщение
    await deleteLastOrderMessages();
    // Сбрасываем состояние
    currentOrderProcessing = null;
    pendingNewOrders.length = 0;
    // Обновляем очередь из API
    await checkAndOfferNewOrders();
    // Если появились заказы – отправляем первый
    if (!currentOrderProcessing && pendingNewOrders.length) {
        await processNextOrder();
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
    await db.initDB();
    console.log('Загрузка складов...');
    const warehouses = await ozon.fetchWarehousesFromOzon();
    if (warehouses.length) await db.syncWarehouses(warehouses);
    await syncEmployeesFromExcel(db);
    scheduler.startOrderChecker(SYNC_ORDERS_TIME, checkAndOfferNewOrders);
    startInactivityTimer();
    console.log(debugMode.getDebugModeStatusMessage());
    // Регистрируем все команды
    registerCommands(
        bot, db, ozon, bwipjs, scheduler, debugMode,
        isAuthorizedUser, isModerator, isAdmin, 
        showOrderMenu, checkAndOfferNewOrders, processNextOrder,
        pendingNewOrders, currentOrderProcessing,
        deleteLastOrderMessages, updateModeratorActivity,
        startInactivityTimer, stopInactivityTimer
    );
    setTimeout(() => checkAndOfferNewOrders(), 5000);
    console.log('Бот запущен...');
})();