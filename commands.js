const debugMode = require('./debugMode');

module.exports = function registerCommands(
  bot, db, ozon, bwipjs, scheduler, debugMode,
  isAdmin, checkAndOfferNewOrders,
  processNextOrder, showOrderMenu
) {

  // ---------------------- ОБРАБОТЧИК CALLBACK_QUERY (единый) ----------------------
  bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const adminId = callbackQuery.from.id.toString();

    if (!isAdmin(adminId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Нет прав' });
      return;
    }

    if (debugMode.isDebugMode()) console.log(`[CALLBACK] admin ${adminId} вызвал ${data}`);

    // Обработка пропуска заказа
    if (data.startsWith('skip_')) {
      const orderId = data.substring(5);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Заказ пропущен до следующей проверки' });
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      if (typeof processNextOrder === 'function') processNextOrder();
      return;
    }

    // Обработка показа приоритетных сотрудников
    if (data.startsWith('priority_')) {
      const orderId = data.substring(9);
      const order = await ozon.fetchAwaitingOrdersById(orderId);
      const warehouseId = order?.warehouse_id || order?.delivery_method?.warehouse_id;
      const employees = await db.getAllEmployeesWithStats(warehouseId ? String(warehouseId) : null);
      const header = '👑 Приоритетные сотрудники (по складу):';

      if (!employees.length) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Нет сотрудников' });
        return;
      }

      const kb = employees.map(emp => ([{
        text: `${emp.name} (активных: ${emp.active_count}, принтеры: ${emp.capacity})`,
        callback_data: `assign_${orderId}_${emp.id}`
      }]));
      kb.push([{ text: '🔙 Назад', callback_data: `back_${orderId}` }]);

      await bot.editMessageText(header, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: kb }
      });
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }

    // Обработка показа всех сотрудников
    if (data.startsWith('others_')) {
      const orderId = data.substring(7);
      const employees = await db.getAllEmployeesWithStats();
      const header = '👥 Все сотрудники:';

      if (!employees.length) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Нет сотрудников' });
        return;
      }

      const kb = employees.map(emp => ([{
        text: `${emp.name} (активных: ${emp.active_count}, принтеры: ${emp.capacity})`,
        callback_data: `assign_${orderId}_${emp.id}`
      }]));
      kb.push([{ text: '🔙 Назад', callback_data: `back_${orderId}` }]);

      await bot.editMessageText(header, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: kb }
      });
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }

    // Обработка назначения заказа
    if (data.startsWith('assign_')) {
      const parts = data.split('_');
      const orderId = parts[1];
      const employeeId = parseInt(parts[2]);
      try {
        await db.assignOrderToEmployee(orderId, employeeId);
        const employee = await db.getEmployeeById(employeeId);
        const orderDetails = await ozon.getOrderDetails(orderId);

        let detailsText = '';
        if (orderDetails && orderDetails.products) {
          const items = orderDetails.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
          detailsText = `\nСостав:\n${items}`;
        }

        let caption = `✅ Вам назначен заказ №${orderId}${detailsText}\n\nШтрихкод для сканирования:\nКогда упакуете, сообщите администратору.`;
        try {
          const barcodeBuffer = await bwipjs.toBuffer({
            bcid: 'code128',
            text: orderId,
            scale: 3,
            height: 10,
            includetext: true,
            textxalign: 'center',
          });
          await bot.sendPhoto(employee.tg_user_id, barcodeBuffer, { caption });
        } catch (barcodeError) {
          console.error('Ошибка генерации штрихкода:', barcodeError);
          await bot.sendMessage(employee.tg_user_id, `✅ Вам назначен заказ №${orderId}${detailsText}\n\n(Штрихкод не сгенерирован)`);
        }

        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Заказ назначен' });
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        if (typeof processNextOrder === 'function') processNextOrder();
      } catch (err) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: err.message });
      }
      return;
    }

    // Обработка кнопки "Назад"
    if (data.startsWith('back_')) {
      const orderId = data.substring(5);
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id);
      // Получить заказ заново (можно из кеша, но лучше через API)
      const order = await ozon.fetchAwaitingOrdersById(orderId);
      if (order && typeof showOrderMenu === 'function') {
        await showOrderMenu(order);
      }
      return;
    }
  });

  // ---------------------- АДМИНИСТРАТИВНЫЕ КОМАНДЫ ----------------------

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
        adminMessage += `Для начала работы используйте команду /add_self.\n\n`;
      } else {
        const activeCount = await db.getEmployeeActiveOrdersCount(employee.id);
        adminMessage += `Вы зарегистрированы как ${employee.name} (активных заказов: ${activeCount}, capacity: ${employee.capacity}).\n\n`;
      }
      adminMessage += `🔧 Доступные административные команды:\n`;
      adminMessage += `/status_all — статус всех сотрудников\n`;
      adminMessage += `/active_orders — активные заказы\n`;
      adminMessage += `/clear_assignments — сброс зависших заданий\n`;
      adminMessage += `/employee_orders <id> — показать активные заказы сотрудника\n`;
      adminMessage += `/employee_warehouses <id> — показать склады сотрудника\n`;
      adminMessage += `/warehouses — список складов из Ozon\n`;
      adminMessage += `/debug_orders [warehouse_id] — показать заказы из API (отладка)\n`;
      adminMessage += `/debug_order_details <posting_number> — детали заказа (отладка)\n`;
      if (debugMode.isDebugMode()) adminMessage += `/debug_clear — сбросить отладочные назначения\n`;
      adminMessage += `/force_check — Принудительная инициализация проверки очереди заказов (вне таймера)\n`;
      adminMessage += `/pause — приостановить авто-проверку заказов\n`;
      adminMessage += `/resume — возобновить авто-проверку\n`;
      adminMessage += `/help_admin — полная справка\n\n`;
      await bot.sendMessage(chatId, adminMessage);
      return;
    }

    // --- Обычный сотрудник (есть в БД) ---
    if (employee) {
      const activeCount = await db.getEmployeeActiveOrdersCount(employee.id);
      await bot.sendMessage(chatId, `С возвращением, ${employee.name}! У вас активно заказов: ${activeCount}. Новые заказы назначает администратор.`);
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
    await bot.sendMessage(chatId, '✅ Администратор добавлен в БД.');
  });

  // --- "/status_all" Команда для администратора: статус всех сотрудников ---
  bot.onText(/\/status_all/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    const employees = await db.getAllEmployeesWithStats();
    if (!employees.length) return bot.sendMessage(msg.chat.id, 'Нет сотрудников.');
    let reply = 'Статус сотрудников:\n';
    for (const emp of employees) {
      reply += `• ${emp.name} (ID: ${emp.id}) — активных: ${emp.active_count}, принтеры: ${emp.capacity}\n`;
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
            WHERE a.status = 'assigned'
        `);
    if (!assignments.length) return bot.sendMessage(msg.chat.id, 'Нет активных заказов.');
    let reply = 'Активные заказы:\n';
    for (const a of assignments) reply += `• Заказ ${a.order_id} — ${a.employee_name}\n`;
    await bot.sendMessage(msg.chat.id, reply);
  });

  // --- "/clear_assignments" Команда для администратора: сброс всех назначений (при зависании) ---
  bot.onText(/\/clear_assignments/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    await db.db.run('DELETE FROM assignments WHERE status = "assigned"');
    bot.sendMessage(msg.chat.id, '✅ Все активные назначения сброшены.');
  });

  // --- "/warehouses" Команда для администратора: показать список всех складов ---
  bot.onText(/\/warehouses/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }

    const warehouses = await db.getAllWarehouses();
    if (!warehouses.length) {
      return bot.sendMessage(msg.chat.id, 'Склады не найдены. Возможно, не удалось выполнить синхронизацию.');
    }
    let reply = '📦 Список складов (из Ozon):\n';
    for (const wh of warehouses) {
      reply += `\n• ${wh.name} (ID: ${wh.warehouse_id})\n   📍 ${wh.address || 'адрес не указан'}\n   Тип: ${wh.is_rfbs ? 'realFBS' : 'FBS'}\n`;
    }
    await bot.sendMessage(msg.chat.id, reply);
  });

  // --- "/employee_warehouses" Команда для администратора: показать склады, где числится сотрудник ---
  bot.onText(/\/employee_warehouses (\d+)/, async (msg, match) => {
    const adminId = msg.from.id.toString();
    if (!isAdmin(adminId)) return;
    const employeeId = parseInt(match[1]);
    const emp = await db.getEmployeeById(employeeId);
    if (!emp) return bot.sendMessage(msg.chat.id, 'Сотрудник не найден.');

    const warehouses = await db.db.all(`
        SELECT w.warehouse_id, w.name, w.address
        FROM employee_warehouses ew
        JOIN warehouses w ON ew.warehouse_id = w.warehouse_id
        WHERE ew.employee_id = ?
    `, employeeId);

    let reply = `📦 Склады сотрудника ${emp.name}:\n`;
    if (!warehouses.length) {
      reply += 'Не числится ни на одном складе.';
    } else {
      for (const wh of warehouses) {
        reply += `\n• ${wh.name} (ID: ${wh.warehouse_id})\n   📍 ${wh.address || 'адрес не указан'}`;
      }
    }
    await bot.sendMessage(msg.chat.id, reply);
  });

  // --- "/employee_orders" Команда для администратора: Просмотр активных заказов сотрудника ---
  bot.onText(/\/employee_orders (\d+)/, async (msg, match) => {
    const adminId = msg.from.id.toString();
    if (!isAdmin(adminId)) return;
    const employeeId = parseInt(match[1]);
    const orders = await db.getEmployeeActiveOrders(employeeId);
    const emp = await db.getEmployeeById(employeeId);
    let reply = `Активные заказы сотрудника ${emp.name}:\n`;
    orders.forEach(o => { reply += `- ${o.order_id} (назначен ${new Date(o.assigned_at).toLocaleString()})\n`; });
    await bot.sendMessage(msg.chat.id, reply || 'Нет активных заказов');
  });

  // --- "/force_check" Команда для администратора: Принудительная инициализация проверки очереди заказов (вне таймера) ---
  bot.onText(/\/force_check/, async (msg) => {
    if (!isAdmin(msg.from.id.toString())) return;
    await checkAndOfferNewOrders();
    bot.sendMessage(msg.chat.id, '✅ Принудительная проверка выполнена.');
  });

  // --- "/pause" Команда для администратора: Пауза работы бота ---
  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg.from.id.toString())) return;
    scheduler.pauseChecker();
    bot.sendMessage(msg.chat.id, '⏸ Автоматическая проверка заказов приостановлена.');
  });

  // --- "/resume" Команда для администратора: Возобновление работы бота ---
  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg.from.id.toString())) return;
    scheduler.resumeChecker();
    bot.sendMessage(msg.chat.id, '▶️ Автоматическая проверка заказов возобновлена.');
  });

  // --- "/debug_orders" Команда для администратора: просмотр списка заказов из API (отладка) ---
  bot.onText(/\/debug_orders(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
    }

    const warehouseId = match[1] || null; // если передан ID склада, используем его
    try {
      // Используем ту же функцию, что и для выдачи заказов сотрудникам
      const orders = await ozon.fetchAwaitingOrders(warehouseId);

      if (!orders || orders.length === 0) {
        return bot.sendMessage(msg.chat.id,
          warehouseId
            ? `📭 Нет заказов в статусе "awaiting_packaging" для склада ${warehouseId}.`
            : '📭 Нет заказов в статусе "awaiting_packaging".'
        );
      }

      let reply = `📋 *Список заказов (awaiting_packaging)*${warehouseId ? ` для склада ${warehouseId}` : ''}:\n\n`;
      for (const order of orders) {
        const orderNumber = order.posting_number;
        const productsCount = order.products ? order.products.length : (order.products_count || '?');
        // Если в объекте есть информация о складе (может быть warehouse_id или warehouse)
        const whInfo = order.warehouse_id || order.delivery_method?.warehouse_id || 'не указан';
        reply += `• Заказ \`${orderNumber}\` — товаров: ${productsCount}, склад: ${whInfo}\n`;
      }
      // Добавляем подсказку: если нужны детали, можно использовать /debug_order_details <posting_number>
      reply += `\n_Для просмотра деталей заказа используйте /debug_order_details <posting_number>_`;
      await bot.sendMessage(msg.chat.id, reply); // без parse_mode
    } catch (err) {
      console.error('Ошибка в /debug_orders:', err);
      bot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка заказов. Проверьте логи.');
    }
  });

  // --- "/debug_order_details" Команда для администратора: просмотр деталей конкретного заказа ---
  bot.onText(/\/debug_order_details (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    const postingNumber = match[1];
    try {
      const details = await ozon.getOrderDetails(postingNumber);
      if (!details) {
        return bot.sendMessage(msg.chat.id, `❌ Не удалось получить детали заказа ${postingNumber}.`);
      }

      let reply = `📄 *Детали заказа ${postingNumber}*\n\n`;

      // Основная информация
      reply += `*Статус:* ${details.status || 'неизвестен'}`;
      if (details.substatus) reply += ` (${details.substatus})`;
      reply += `\n`;
      if (details.order_number) reply += `*Номер заказа:* ${details.order_number}\n`;
      if (details.delivery_method) {
        reply += `*Метод доставки:* ${details.delivery_method.name || '—'}\n`;
        if (details.delivery_method.warehouse_id) {
          const warehouseName = await db.getWarehouseNameById(String(details.delivery_method.warehouse_id));
          reply += `*Склад:* ${warehouseName} (ID: ${details.delivery_method.warehouse_id})\n`;
        }
      }

      // Товары
      if (details.products && details.products.length) {
        reply += `\n*Товары:*\n`;
        for (let i = 0; i < details.products.length; i++) {
          const p = details.products[i];
          reply += `${i + 1}. ${p.name || '—'}`;
          if (p.sku) reply += ` (SKU: ${p.sku})`;
          if (p.offer_id) reply += `, offer_id: ${p.offer_id}`;
          reply += ` — ${p.quantity} шт.\n`;
          if (p.price && p.price.amount) {
            reply += `   Цена: ${p.price.amount} ${p.price.currency || 'RUB'}\n`;
          }
        }
      } else {
        reply += `\n*Товары:* не указаны\n`;
      }

      // Получатель
      if (details.customer) {
        reply += `\n*Получатель:* ${details.customer.name || '—'}`;
        if (details.customer.phone) reply += `, тел: ${details.customer.phone}`;
        reply += `\n`;
        if (details.customer.address) {
          const addr = details.customer.address;
          let addrStr = '';
          if (addr.address_tail) addrStr += addr.address_tail;
          if (addr.city) addrStr += (addrStr ? ', ' : '') + addr.city;
          if (addr.region) addrStr += (addrStr ? ', ' : '') + addr.region;
          if (addr.zip_code) addrStr += (addrStr ? ', ' : '') + addr.zip_code;
          if (addrStr) reply += `*Адрес:* ${addrStr}\n`;
        }
      }

      // Дополнительно
      if (details.tracking_number) reply += `\n*Трек-номер:* ${details.tracking_number}\n`;
      if (details.in_process_at) {
        const date = new Date(details.in_process_at).toLocaleString();
        reply += `\n*Дата создания:* ${date}\n`;
      }

      await bot.sendMessage(msg.chat.id, reply); // без parse_mode
    } catch (err) {
      console.error('Ошибка в /debug_order_details:', err);
      bot.sendMessage(msg.chat.id, '❌ Ошибка получения деталей заказа.');
    }
  });

  // --- "/debug_clear" Команда для администратора: очистить все отладочные данные ---
  bot.onText(/\/debug_clear/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    if (!debugMode.isDebugMode()) {
      return bot.sendMessage(msg.chat.id, 'Эта команда доступна только в отладочном режиме (DEBUG_ORDERS_MODE=true).');
    }
    debugMode.clearAssignments();
    bot.sendMessage(msg.chat.id, '✅ Все отладочные назначения сброшены.');
  });

  // --- "/help_admin" Команда для администратора: список всех команд администратора ---
  bot.onText(/\/help_admin/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    let help = `Административные команды:
/status_all — статус всех сотрудников (активные заказы / число принтеров)
/active_orders — список активных назначенных заказов
/clear_assignments — сбросить все активные назначения
/employee_orders <id> — показать активные заказы сотрудника
/employee_warehouses <id> — показать склады сотрудника
/warehouses — список складов
/force_check — Принудительная инициализация проверки очереди заказов (вне таймера)
/pause — приостановить авто-проверку
/resume — возобновить
/debug_orders [warehouse_id] — показать заказы из API
/debug_order_details <posting_number> — детали заказа
`;
    if (debugMode.isDebugMode()) help += `/debug_clear — сбросить отладочные назначения\n`;
    await bot.sendMessage(msg.chat.id, help);
  });

  console.log('Команды зарегистрированы');
};