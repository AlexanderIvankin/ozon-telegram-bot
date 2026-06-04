require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const ozon = require('./ozon');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const ADMIN_USER_ID = 762451011; // <<-- Administrator's Telegram ID

// Функция-посредник для проверки доступа
async function isAuthorizedUser(tgUserId) {
    const employee = await db.getEmployee(tgUserId);
    // Пользователь считается авторизованным, если он есть в БД.
    return employee !== undefined;
}

// Функция для проверки прав администратора
function isAdmin(tgUserId) {
    return tgUserId === ADMIN_USER_ID;
}

// Инициализация БД и запуск бота
(async () => {
    await db.initDB();

    // "/add_user_by_id" администратор добавляет пользователя по его ID
    bot.onText(/\/add_user_by_id (\d+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const fromUserId = msg.from.id.toString();

        if (!isAdmin(fromUserId)) {
            bot.sendMessage(chatId, '⛔ Нет прав.');
            return;
        }

        const newUserId = match[1];
        const newUserName = 'Новый сотрудник'; // Имя можно будет потом обновить по /start

        await db.addEmployee(newUserId, newUserName);
        bot.sendMessage(chatId, `✅ Пользователь с ID ${newUserId} добавлен! Теперь он может использовать бота.`);
        // Отправляем новому сотруднику приветственное сообщение
        try {
            await bot.sendMessage(newUserId, '🎉 Вас добавили в список сотрудников! Теперь вы можете использовать команду /start.');
        } catch (error) {
            console.error('Не удалось отправить сообщение новому сотруднику:', error);
        }
    });

    // "/start" только приветствие и информация о статусе
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();

        const employee = await db.getEmployee(userId);
        if (employee) {
            const statusText = employee.is_busy ? 'занят' : 'свободен';
            bot.sendMessage(chatId, `С возвращением, ${employee.name}! Вы ${statusText}. Используйте /next для нового заказа или /done для завершения текущего.`);
        } else {
            // Если пользователь не авторизован, то просто показываем общее сообщение
            bot.sendMessage(chatId, '🤖 Здравствуйте! Этот бот для сотрудников склада. Если вы здесь по работе, обратитесь к администратору для получения доступа.');
        }
    });

    // "/next" Взять следующий доступный заказ с проверкой доступа
    bot.onText(/\/next/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();

        // --- ПРОВЕРКА ДОСТУПА ---
        if (!(await isAuthorizedUser(userId))) {
            bot.sendMessage(chatId, '⛔ У вас нет доступа к этому боту. Обратитесь к администратору.');
            return;
        }

        const employee = await db.getEmployee(userId);
        if (!employee) {
            bot.sendMessage(chatId, 'Сначала используй /start для регистрации.');
            return;
        }
        if (employee.is_busy) {
            bot.sendMessage(chatId, 'У тебя уже есть активный заказ. Заверши его командой /done.');
            return;
        }

        // Получаем актуальные заказы из Ozon
        let orders = await ozon.fetchAwaitingOrders();
        if (!orders.length) {
            bot.sendMessage(chatId, 'Нет заказов, ожидающих обработки.');
            return;
        }

        // Получаем список уже взятых order_id из БД
        const takenOrderIds = await db.getActiveOrderIds();
        const availableOrders = orders.filter(order => !takenOrderIds.includes(order.posting_number));

        if (availableOrders.length === 0) {
            bot.sendMessage(chatId, 'Все доступные заказы уже назначены другим сотрудникам.');
            return;
        }

        // Берём первый доступный заказ
        const chosenOrder = availableOrders[0];
        const orderId = chosenOrder.posting_number;

        // Помечаем сотрудника занятым и сохраняем назначение
        await db.setEmployeeBusy(userId, true);
        await db.assignOrder(orderId, employee.id);

        // (Опционально) получить детали заказа: состав, адрес и т.п.
        const details = await ozon.getOrderDetails(orderId);
        let detailsText = '';
        if (details && details.products) {
            const items = details.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
            detailsText = `\nСостав:\n${items}`;
        }

        bot.sendMessage(chatId, `✅ Ты взял заказ №${orderId}${detailsText}\n\nКогда упакуешь, нажми /done`);
    });

    // "/done" Завершить текущий заказ
    bot.onText(/\/done/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();

        // --- ПРОВЕРКА ДОСТУПА ---
        if (!(await isAuthorizedUser(userId))) {
            bot.sendMessage(chatId, '⛔ У вас нет доступа к этому боту. Обратитесь к администратору.');
            return;
        }

        const employee = await db.getEmployee(userId);
        if (!employee) {
            bot.sendMessage(chatId, 'Сначала используй /start.');
            return;
        }
        if (!employee.is_busy) {
            bot.sendMessage(chatId, 'У тебя нет активного заказа.');
            return;
        }

        // Находим назначенный заказ
        const assignment = await db.db.get('SELECT order_id FROM assignments WHERE employee_id = ? AND status = "taken"', employee.id);
        if (!assignment) {
            // странный случай — освободим сотрудника вручную
            await db.setEmployeeBusy(userId, false);
            bot.sendMessage(chatId, 'Активный заказ не найден, но я освободил тебя.');
            return;
        }

        const orderId = assignment.order_id;

        // Здесь можно вызвать API Ozon для смены статуса заказа (если нужно)
        // Например, ozon.actPosting(orderId) — чтобы подтвердить сборку.
        // Пока просто удаляем из наших таблиц.

        await db.releaseOrder(orderId);
        await db.setEmployeeBusy(userId, false);

        bot.sendMessage(chatId, `✅ Заказ ${orderId} завершён. Теперь ты свободен. Используй /next для нового заказа.`);
    });

    console.log('Бот запущен...');
})();