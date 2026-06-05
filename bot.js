require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const ozon = require('./ozon');

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
    return tgUserId === ADMIN_USER_ID;
}

// Инициализация БД и запуск бота
(async () => {
    await db.initDB();

    // --- "/start" Команда с доп. информацией для админа ---
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const isAdministrator = (userId === ADMIN_USER_ID);

        const employee = await db.getEmployee(userId);

        if (employee) {
            const statusText = employee.is_busy ? 'занят' : 'свободен';
            await bot.sendMessage(chatId, `С возвращением, ${employee.name}! Вы ${statusText}. Используйте /next для нового заказа или /done для завершения текущего.`);
            if (isAdministrator) {
                await bot.sendMessage(chatId, `🔧 *Администраторский режим*\nДоступны команды:\n/status_all — статус всех сотрудников\n/active_orders — активные заказы\n/clear_assignments — сброс зависших заданий\n/help_admin — справка`, { parse_mode: 'Markdown' });
            }
        } else {
            if (isAdministrator) {
                await bot.sendMessage(chatId, `👋 Привет, Администратор! Вы ещё не добавлены в БД. Хотите добавить себя? Отправьте /add_self`);
            } else {
                await bot.sendMessage(chatId, '🤖 Здравствуйте! Этот бот для сотрудников склада. Если вы здесь по работе, обратитесь к администратору для получения доступа.');
            }
        }
    });

    // --- "/add_self" Команда для администратора: добавить самого себя ---
    bot.onText(/\/add_self/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        if (userId !== ADMIN_USER_ID) {
            await bot.sendMessage(chatId, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        const existing = await db.getEmployee(userId);
        if (existing) {
            await bot.sendMessage(chatId, `Вы уже в БД как ${existing.name}`);
            return;
        }
        await db.addEmployee(userId, 'Admin');
        await bot.sendMessage(chatId, '✅ Администратор добавлен в БД. Теперь вы можете использовать /next и другие команды.');
    });

    // --- "/status_all" Команда для администратора: статус всех сотрудников ---
    bot.onText(/\/status_all/, async (msg) => {
        const userId = msg.from.id.toString();
        if (userId !== ADMIN_USER_ID) {
            await bot.sendMessage(msg.chat.id, '⛔ Нет прав.');
            return;
        }
        const employees = await db.db.all('SELECT tg_user_id, name, is_busy FROM employees');
        if (employees.length === 0) {
            await bot.sendMessage(msg.chat.id, 'Нет сотрудников в базе.');
            return;
        }
        let reply = '*Статус сотрудников:*\n';
        for (const emp of employees) {
            const busyIcon = emp.is_busy ? '🔴 занят' : '🟢 свободен';
            reply += `• ${emp.name} (${emp.tg_user_id}) — ${busyIcon}\n`;
        }
        await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
    });

    // --- "/active_orders" Команда для администратора: список активных (взятых) заказов ---
    bot.onText(/\/active_orders/, async (msg) => {
        const userId = msg.from.id.toString();
        if (userId !== ADMIN_USER_ID) return;
        const assignments = await db.db.all(`
        SELECT a.order_id, e.name as employee_name 
        FROM assignments a 
        JOIN employees e ON a.employee_id = e.id 
        WHERE a.status = 'taken'
    `);
        if (assignments.length === 0) {
            await bot.sendMessage(msg.chat.id, 'Нет активных назначенных заказов.');
            return;
        }
        let reply = '*Активные заказы:*\n';
        for (const a of assignments) {
            reply += `• Заказ ${a.order_id} — обрабатывает ${a.employee_name}\n`;
        }
        await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
    });

    // --- "/clear_assignments" Команда для администратора: сброс всех назначений (при зависании) ---
    bot.onText(/\/clear_assignments/, async (msg) => {
        const userId = msg.from.id.toString();
        if (userId !== ADMIN_USER_ID) return;
        await db.db.run('DELETE FROM assignments');
        await db.db.run('UPDATE employees SET is_busy = 0');
        await bot.sendMessage(msg.chat.id, '✅ Все назначения сброшены, сотрудники освобождены.');
    });

    // --- "/help_admin" Команда для администратора: список всех команд администратора ---
    bot.onText(/\/help_admin/, async (msg) => {
        const userId = msg.from.id.toString();
        if (userId !== ADMIN_USER_ID) return;
        const helpText = `
*Административные команды:*
/status_all — показать всех сотрудников и их занятость
/active_orders — показать текущие взятые заказы
/clear_assignments — сбросить все активные задания (при сбоях)
/add_user_by_id <id> — добавить сотрудника по Telegram ID
/remove_user <id> — удалить сотрудника
/set_employee_name <id> <имя> — изменить имя
/logs — показать последние логи (если сохраняете в файл)
    `;
        await bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    });

    // --- "/add_user_by_id" Команда для администратора: добавления пользователя по его ID ---
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

    // --- "/remove_user" Команда для удаления сотрудника ---
    bot.onText(/\/remove_user (\d+)/, async (msg, match) => {
        const userId = msg.from.id.toString();
        if (userId !== ADMIN_USER_ID) return;
        const targetId = match[1];
        await db.db.run('DELETE FROM employees WHERE tg_user_id = ?', targetId);
        await db.db.run('DELETE FROM assignments WHERE employee_id IN (SELECT id FROM employees WHERE tg_user_id = ?)', targetId);
        await bot.sendMessage(msg.chat.id, `Пользователь ${targetId} удалён.`);
    });

    // --- "/set_employee_name" Команда для смены имени сотрудника ---
    bot.onText(/\/set_employee_name (\d+) (.+)/, async (msg, match) => {
        const userId = msg.from.id.toString();
        if (userId !== ADMIN_USER_ID) return;
        const targetId = match[1];
        const newName = match[2];
        await db.db.run('UPDATE employees SET name = ? WHERE tg_user_id = ?', newName, targetId);
        await bot.sendMessage(msg.chat.id, `Имя сотрудника ${targetId} изменено на ${newName}.`);
    });


    // --- "/next" Команда Взять следующий доступный заказ с проверкой доступа ---
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

    // --- "/done" Завершить текущий заказ ---
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