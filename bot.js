require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const ozon = require('./ozon');
const bwipjs = require('bwip-js');

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

// Инициализация БД и запуск бота
(async () => {
    await db.initDB();

    // --- "/start" Команда с доп. информацией для админа ---
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const isAdministrator = isAdmin(userId);
        const employee = await db.getEmployee(userId);

        // --- Администратор всегда получает полный доступ, даже если не в БД ---
        if (isAdministrator) {
            let adminMessage = `👋 Добро пожаловать, Администратор!\n\n`;
            if (!employee) {
                adminMessage += `⚠️ Вы ещё не добавлены в базу сотрудников.\n`;
                adminMessage += `Для начала работы используйте команду /add_self — она добавит вас как администратора.\n\n`;
            } else {
                adminMessage += `Вы зарегистрированы как ${employee.name} (статус: ${employee.is_busy ? 'занят' : 'свободен'}).\n\n`;
            }
            adminMessage += `🔧 Доступные административные команды:\n`;
            adminMessage += `/status_all — статус всех сотрудников\n`;
            adminMessage += `/active_orders — активные заказы\n`;
            adminMessage += `/clear_assignments — сброс зависших заданий\n`;
            adminMessage += `/add_user_by_id <id> [warehouse_id] — добавить сотрудника\n`;
            adminMessage += `/set_warehouse <id> <warehouse_id> — назначить склад сотруднику\n`;
            adminMessage += `/remove_user <id> — удалить сотрудника\n`;
            adminMessage += `/set_employee_name <id> <имя> — изменить имя\n`;
            adminMessage += `/help_admin — полная справка\n\n`;
            adminMessage += `👤 Команды для работы с заказами:\n`;
            adminMessage += `/next — взять следующий заказ\n`;
            adminMessage += `/done — завершить текущий заказ`;

            await bot.sendMessage(chatId, adminMessage); // без parse_mode
            return;
        }

        // --- Обычный сотрудник (есть в БД) ---
        if (employee) {
            const statusText = employee.is_busy ? 'занят' : 'свободен';
            await bot.sendMessage(chatId, `С возвращением, ${employee.name}! Вы ${statusText}. Используйте /next для нового заказа или /done для завершения текущего.`);
            return;
        }

        // --- Неавторизованный пользователь ---
        await bot.sendMessage(chatId, '🤖 Здравствуйте! Этот бот для сотрудников склада. Если вы здесь по работе, обратитесь к администратору для получения доступа.');
    });

    // --- "/add_self" Команда для администратора: добавить самого себя ---
    bot.onText(/\/add_self/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        if (!isAdmin(userId)) {
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
        if (!isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        const employees = await db.db.all('SELECT tg_user_id, name, is_busy FROM employees');
        if (employees.length === 0) {
            await bot.sendMessage(msg.chat.id, 'Нет сотрудников в базе.');
            return;
        }
        let reply = 'Статус сотрудников:\n';
        for (const emp of employees) {
            const busyIcon = emp.is_busy ? '🔴 занят' : '🟢 свободен';
            reply += `• ${emp.name} (${emp.tg_user_id}) — ${busyIcon}\n`;
        }
        await bot.sendMessage(msg.chat.id, reply);
    });

    // --- "/active_orders" Команда для администратора: список активных (взятых) заказов ---
    bot.onText(/\/active_orders/, async (msg) => {
        const userId = msg.from.id.toString();
        if (!isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
            return;
        }
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
        let reply = 'Активные заказы:\n';
        for (const a of assignments) {
            reply += `• Заказ ${a.order_id} — обрабатывает ${a.employee_name}\n`;
        }
        await bot.sendMessage(msg.chat.id, reply);
    });

    // --- "/clear_assignments" Команда для администратора: сброс всех назначений (при зависании) ---
    bot.onText(/\/clear_assignments/, async (msg) => {
        const userId = msg.from.id.toString();
        if (!isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        await db.db.run('DELETE FROM assignments');
        await db.db.run('UPDATE employees SET is_busy = 0');
        await bot.sendMessage(msg.chat.id, '✅ Все назначения сброшены, сотрудники освобождены.');
    });

    // --- "/help_admin" Команда для администратора: список всех команд администратора ---
    bot.onText(/\/help_admin/, async (msg) => {
        const userId = msg.from.id.toString();
        if (!isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        const helpText = `
Административные команды:
/status_all — показать всех сотрудников и их занятость
/active_orders — показать текущие взятые заказы
/clear_assignments — сбросить все активные задания (при сбоях)
/add_user_by_id <id> — добавить сотрудника по Telegram ID
/set_warehouse <id> <warehouse_id> — назначить склад сотруднику
/remove_user <id> — удалить сотрудника
/set_employee_name <id> <имя> — изменить имя
/logs — показать последние логи (если сохраняете в файл)
    `;
        await bot.sendMessage(msg.chat.id, helpText);
    });

    // --- "/add_user_by_id" Команда для администратора: добавления пользователя по его ID ---
    bot.onText(/\/add_user_by_id (\d+)(?: (\S+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const fromUserId = msg.from.id.toString();
        if (!isAdmin(fromUserId)) {
            await bot.sendMessage(chatId, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        const newUserId = match[1];
        const warehouseId = match[2] || null;
        const newUserName = 'Новый сотрудник';
        await db.addEmployee(newUserId, newUserName, warehouseId);
        bot.sendMessage(chatId, `✅ Пользователь с ID ${newUserId} добавлен${warehouseId ? ` на склад ${warehouseId}` : ''}.`);
        try {
            await bot.sendMessage(newUserId, `🎉 Вас добавили в список сотрудников!${warehouseId ? ` Ваш склад: ${warehouseId}` : ''}\nИспользуйте /start.`);
        } catch (error) { console.error('Не удалось отправить сообщение новому сотруднику:', error); }
    });

    // --- "/set_warehouse" Команда для администратора: установить/изменить склад сотрудника ---
    bot.onText(/\/set_warehouse (\d+) (\S+)/, async (msg, match) => {
        const userId = msg.from.id.toString();
        if (!isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        const targetId = match[1];
        const warehouseId = match[2];
        await db.setEmployeeWarehouse(targetId, warehouseId);
        bot.sendMessage(msg.chat.id, `✅ Сотруднику ${targetId} назначен склад ${warehouseId}.`);
    });

    // --- "/remove_user" Команда для удаления сотрудника ---
    bot.onText(/\/remove_user (\d+)/, async (msg, match) => {
        const userId = msg.from.id.toString();
        if (!isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        const targetId = match[1];
        await db.db.run('DELETE FROM employees WHERE tg_user_id = ?', targetId);
        await db.db.run('DELETE FROM assignments WHERE employee_id IN (SELECT id FROM employees WHERE tg_user_id = ?)', targetId);
        await bot.sendMessage(msg.chat.id, `Пользователь ${targetId} удалён.`);
    });

    // --- "/set_employee_name" Команда для смены имени сотрудника ---
    bot.onText(/\/set_employee_name (\d+) (.+)/, async (msg, match) => {
        const userId = msg.from.id.toString();
        if (!isAdmin(userId)) {
            await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
            return;
        }
        const targetId = match[1];
        const newName = match[2];
        await db.db.run('UPDATE employees SET name = ? WHERE tg_user_id = ?', newName, targetId);
        await bot.sendMessage(msg.chat.id, `Имя сотрудника ${targetId} изменено на ${newName}.`);
    });


    // --- "/next" Команда Взять следующий доступный заказ с проверкой доступа ---
    bot.onText(/\/next/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();

        if (!(await isAuthorizedUser(userId))) {
            return bot.sendMessage(chatId, '⛔ У вас нет доступа. Обратитесь к администратору.');
        }

        const employee = await db.getEmployee(userId);
        if (!employee) return bot.sendMessage(chatId, 'Сначала используй /start.');
        if (employee.is_busy) return bot.sendMessage(chatId, 'У тебя уже есть активный заказ. Заверши его командой /done.');

        // Получаем заказы, отфильтрованные по складу сотрудника
        const orders = await ozon.fetchAwaitingOrders(employee.warehouse);
        if (!orders.length) {
            return bot.sendMessage(chatId, `Нет заказов, ожидающих обработки${employee.warehouse ? ` на складе ${employee.warehouse}` : ''}.`);
        }

        const takenOrderIds = await db.getActiveOrderIds();
        const availableOrders = orders.filter(order => !takenOrderIds.includes(order.posting_number));

        if (availableOrders.length === 0) {
            return bot.sendMessage(chatId, 'Все доступные заказы уже назначены другим сотрудникам.');
        }

        const chosenOrder = availableOrders[0];
        const orderId = chosenOrder.posting_number;

        // Помечаем сотрудника занятым и сохраняем назначение
        await db.setEmployeeBusy(userId, true);
        await db.assignOrder(orderId, employee.id);

        // Детали заказа (состав)
        const details = await ozon.getOrderDetails(orderId);
        let detailsText = '';
        if (details && details.products) {
            const items = details.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
            detailsText = `\nСостав:\n${items}`;
        }

        // Генерируем штрихкод (Code 128) номера заказа
        try {
            const barcodeBuffer = await bwipjs.toBuffer({
                bcid: 'code128',       // тип штрихкода
                text: orderId,
                scale: 3,             // масштаб
                height: 10,           // высота в мм (условно)
                includetext: true,    // показывать текст под штрихкодом
                textxalign: 'center',
            });
            // Отправляем картинку
            await bot.sendPhoto(chatId, barcodeBuffer, { caption: `✅ Ты взял заказ №${orderId}${detailsText}\n\nШтрихкод для сканирования:\nКогда упакуешь, нажми /done` });
        } catch (barcodeError) {
            console.error('Ошибка генерации штрихкода:', barcodeError);
            // Если не удалось сгенерировать, отправляем текст без картинки
            await bot.sendMessage(chatId, `✅ Ты взял заказ №${orderId}${detailsText}\n\n(Штрихкод не сгенерирован)\nКогда упакуешь, нажми /done`);
        }
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