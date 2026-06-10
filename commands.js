module.exports = function registerCommands(
  bot, db, ozon, bwipjs, scheduler, debugMode,
  isAuthorizedUser, isModerator, isAdmin,
  showOrderMenu, checkAndOfferNewOrders, processNextOrder,
  pendingNewOrders, currentOrderProcessing,
  deleteLastOrderMessages, updateModeratorActivity,
  startInactivityTimer, stopInactivityTimer
) {

  // ---------------------- ОБРАБОТЧИК CALLBACK_QUERY (единый) ----------------------
  bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id.toString();

    // ---------------------- КОМАНДЫ СОТРУДНИКОВ ----------------------

    // Проверяем, что пользователь – авторизованный сотрудник
    if (!(await isAuthorizedUser(userId))) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы не авторизованы как сотрудник.' });
      return;
    }

    // Подтверждение отмены заказа сотрудником
    if (data.startsWith('confirm_cancel_')) {
      const orderId = data.substring(15);
      const employee = await db.getEmployee(userId);
      if (!employee) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Сотрудник не найден' });
        return;
      }
      try {
        await db.cancelOrder(orderId, employee.id);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Заказ отменён' });
        await bot.editMessageText(`✅ Заказ ${orderId} отменён.`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        // Обновляем очередь, чтобы заказ снова стал доступным
        await checkAndOfferNewOrders();
      } catch (err) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: err.message });
      }
      return;
    }
    if (data.startsWith('cancel_cancel_')) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отмена отклонена' });
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      return;
    }

    // ---------------------- ОСТАЛЬНЫЕ КОМАНДЫ (для админов/модераторов) ----------------------

    const adminId = userId;

    if (!isAdmin(adminId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Нет прав' });
      return;
    }

    if (isModerator(adminId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    if (debugMode.isDebugMode()) console.log(`[CALLBACK] admin ${adminId} вызвал ${data}`);

    // 1. Пропуск заказа
    if (data.startsWith('skip_')) {
      if (!isModerator(adminId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только модератор' });
        return;
      }
      console.log(`[SKIP] Получен пропуск заказа ${data.substring(5)} от модератора ${adminId}`);
      const orderId = data.substring(5);
      // Удаляем этот заказ из глобальной очереди, если он там есть
      const index = pendingNewOrders.findIndex(o => o.posting_number === orderId);
      if (index !== -1) pendingNewOrders.splice(index, 1);
      // Сбрасываем текущий обрабатываемый заказ
      if (currentOrderProcessing && currentOrderProcessing.order.posting_number === orderId) {
        currentOrderProcessing = null;
      }
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Заказ пропущен' });
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      if (typeof processNextOrder === 'function') processNextOrder();
      return;
    }

    // 2. Показать приоритетных сотрудников
    if (data.startsWith('priority_')) {
      if (!isModerator(adminId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только модератор' });
        return;
      }
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

    // 3. Показать всех сотрудников
    if (data.startsWith('others_')) {
      if (!isModerator(adminId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только модератор' });
        return;
      }
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

    // 4. Назначение заказа
    if (data.startsWith('assign_')) {
      if (!isModerator(adminId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только модератор' });
        return;
      }
      console.log(`[ASSIGN] Получено назначение заказа для сотрудника ${data.split('_')[2]} от модератора ${adminId}`);
      const parts = data.split('_');
      const orderId = parts[1];
      const employeeId = parseInt(parts[2]);
      try {
        await db.assignOrderToEmployee(orderId, employeeId);
        const employee = await db.getEmployeeById(employeeId);
        const orderDetails = await ozon.getOrderDetails(orderId);
        // Проверяем, может ли бот писать сотруднику
        try {
          await bot.sendChatAction(employee.tg_user_id, 'typing');
        } catch (err) {
          console.error(`Сотрудник ${employee.name} (${employee.tg_user_id}) не найден:`, err.message);
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сотрудник не начал диалог с ботом. Попросите его написать /start.' });
          return;
        }
        let detailsText = '';
        let skuList = [];
        if (orderDetails && orderDetails.products) {
          const items = orderDetails.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
          detailsText = `\nСостав:\n${items}`;
          skuList = orderDetails.products.map(p => p.sku).filter(Boolean);
        }

        let caption = `✅ Вам назначен заказ №: ${orderId}${detailsText}\n\nКогда упакуете, выполните команду:\n /finish_order ${orderId}`;
        try {
          const barcodeBuffer = await bwipjs.toBuffer({
            bcid: 'code128',
            text: orderId,
            scale: 3,
            height: 10,
            includetext: true,
            textxalign: 'center'
          });
          await bot.sendPhoto(employee.tg_user_id, barcodeBuffer, { caption });
        } catch (barcodeError) {
          console.error('Ошибка генерации штрихкода:', barcodeError);
          await bot.sendMessage(employee.tg_user_id, `✅ Вам назначен заказ №: ${orderId}${detailsText}\n\n(Штрихкод не сгенерирован)`);
        }

        // Отправляем фото товаров сотруднику
        if (skuList.length) {
          try {
            const imageMap = await ozon.fetchProductsImages(skuList);
            for (const p of orderDetails.products) {
              const imgUrl = imageMap[p.sku];
              if (imgUrl && imgUrl.startsWith('http')) {
                const imageBuffer = await ozon.downloadImage(imgUrl);
                if (imageBuffer) {
                  await bot.sendPhoto(employee.tg_user_id, imageBuffer, {
                    caption: `Фото к заказу ${orderId}: ${p.name}`
                  });
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
              }
            }
          } catch (photoError) {
            console.error(`Ошибка отправки фото сотруднику для заказа ${orderId}:`, photoError.message);
          }
        }

        // Удаляем заказ из очереди
        const idx = pendingNewOrders.findIndex(o => o.posting_number === orderId);
        if (idx !== -1) pendingNewOrders.splice(idx, 1);
        if (currentOrderProcessing && currentOrderProcessing.order.posting_number === orderId) {
          currentOrderProcessing = null;
        }

        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Заказ назначен' });
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        if (typeof processNextOrder === 'function') processNextOrder();
      } catch (err) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: err.message });
      }
      return;
    }

    // 5. Кнопка "Назад"
    if (data.startsWith('back_')) {
      const orderId = data.substring(5);
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id);
      const order = await ozon.fetchAwaitingOrdersById(orderId);
      if (order && typeof showOrderMenu === 'function') {
        await showOrderMenu(order);
      }
      return;
    }

    // 6. Сброс всех назначений (подтверждение)
    if (data === 'confirm_clear_all') {
      await db.db.run('DELETE FROM assignments WHERE status = "assigned"');
      await bot.editMessageText('✅ Все активные назначения сброшены.', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сброс выполнен' });
      return;
    }
    if (data === 'cancel_clear_all') {
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сброс отменён' });
      return;
    }

    // 7. Снятие заказа администратором (подтверждение)
    if (data.startsWith('admin_cancel_confirm_')) {
      const orderId = data.substring(21);
      // Удаляем назначение
      await db.db.run('DELETE FROM assignments WHERE order_id = ? AND status = "assigned"', orderId);
      console.log(`[ADMIN] Снят заказ ${orderId} с сотрудника`);

      // Если этот заказ сейчас в обработке у админа – сбрасываем currentOrderProcessing
      const idx = pendingNewOrders.findIndex(o => o.posting_number === orderId);
      if (idx !== -1) pendingNewOrders.splice(idx, 1);
      if (currentOrderProcessing && currentOrderProcessing.order.posting_number === orderId) {
        currentOrderProcessing = null;
        console.log(`[ADMIN] Сброшен текущий обрабатываемый заказ ${orderId}`);
      }

      // Обновляем сообщение у админа
      await bot.editMessageText(`✅ Заказ ${orderId} снят с сотрудника и возвращён в очередь.`, {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Заказ снят' });

      // Принудительно обновляем очередь заказов из API
      await checkAndOfferNewOrders();

      // Если после обновления нет активного заказа, но есть новые – отправляем следующий
      if (!currentOrderProcessing && pendingNewOrders.length) {
        await processNextOrder();
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

    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

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
      adminMessage += `/warehouses — список складов Ozon\n`;
      adminMessage += `/employee_warehouses <id> — показать склады сотрудника\n`;
      adminMessage += `/employee_stats <id> — статистика сотрудника (заказы, сумма)\n`;
      adminMessage += `/orders [warehouse_id] — показать очередь заказов из API\n`;
      adminMessage += `/employee_orders <id> — показать активные заказы сотрудника\n`;
      adminMessage += `/order_details <posting_number> — показать детали заказа\n`;
      adminMessage += `/admin_cancel_order <id> — снять заказ с сотрудника\n`;
      adminMessage += `/clear_assignments — сброс ВСЕХ назначений на заказы\n`;
      adminMessage += `/reload_queue — Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов\n`;
      adminMessage += `/pause — приостановить авто-проверку очереди заказов\n`;
      adminMessage += `/resume — возобновить авто-проверку очереди заказов\n`;
      if (debugMode.isDebugMode()) adminMessage += `/debug_clear — сбросить отладочные назначения\n`;

      await bot.sendMessage(chatId, adminMessage);
      return;
    }

    // --- Обычный сотрудник (есть в БД) ---
    if (employee) {
      const activeCount = await db.getEmployeeActiveOrdersCount(employee.id);
      let msgText = `С возвращением, ${employee.name}!\n Новые заказы назначает модератор.\n У вас активно заказов: ${activeCount}. \n\n`;
      msgText += `Доступные команды:\n`;
      msgText += `/my_orders — показать мои активные заказы\n`;
      msgText += `/finish_order <номер_заказа> — завершить заказ (получить этикетку)\n`;
      msgText += `/cancel_order <номер_заказа> — отменить заказ (если не можете выполнить)\n`;
      msgText += `/help — эта справка\n`;
      await bot.sendMessage(chatId, msgText);
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
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
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
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
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
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
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

  // --- "/clear_assignments" Команда для администратора: сброс всех назначений (с подтверждением) при зависании ---
  bot.onText(/\/clear_assignments/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
    const confirmKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚠️ Да, сбросить ВСЕ назначения', callback_data: 'confirm_clear_all' },
            { text: '❌ Отмена', callback_data: 'cancel_clear_all' }
          ]
        ]
      }
    };
    await bot.sendMessage(msg.chat.id, '⚠️ Вы уверены, что хотите сбросить ВСЕ активные назначения? Это действие необратимо.', confirmKeyboard);
  });

  // --- "/warehouses" Команда для администратора: показать список всех складов ---
  bot.onText(/\/warehouses/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
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
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
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
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
    const employeeId = parseInt(match[1]);
    const orders = await db.getEmployeeActiveOrders(employeeId);
    const emp = await db.getEmployeeById(employeeId);
    let reply = `Активные заказы сотрудника ${emp.name}:\n`;
    orders.forEach(o => { reply += `- ${o.order_id} (назначен ${new Date(o.assigned_at).toLocaleString()})\n`; });
    await bot.sendMessage(msg.chat.id, reply || 'Нет активных заказов');
  });

  // --- "/admin_cancel_order" Команда для администратора: снять заказ с сотрудника (с подтверждением) ---
  bot.onText(/\/admin_cancel_order (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
    const postingNumber = match[1];
    // Находим активное назначение
    const assignment = await db.db.get(
      'SELECT a.*, e.name as employee_name FROM assignments a JOIN employees e ON a.employee_id = e.id WHERE a.order_id = ? AND a.status = "assigned"',
      postingNumber
    );
    if (!assignment) {
      return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не находится в активном назначении.`);
    }
    // Запрашиваем подтверждение
    const confirmKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Да, снять заказ', callback_data: `admin_cancel_confirm_${postingNumber}` },
            { text: '❌ Нет', callback_data: `admin_cancel_abort_${postingNumber}` }
          ]
        ]
      }
    };
    await bot.sendMessage(msg.chat.id, `⚠️ Снять заказ ${postingNumber} с сотрудника ${assignment.employee_name}? Заказ вернётся в очередь.`, confirmKeyboard);
  });

  // --- "/reload_queue" Команда для администратора: Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов ---
  bot.onText(/\/reload_queue/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    // 1. Удаляем старое сообщение и фото
    if (typeof deleteLastOrderMessages === 'function') {
      await deleteLastOrderMessages();
    }
    // 2. Сбрасываем состояние (очищаем массив, не пересоздавая)
    pendingNewOrders.length = 0;
    currentOrderProcessing = null;
    // 3. Перезагружаем очередь из API
    await checkAndOfferNewOrders();
    // 4. Если после обновления есть заказы – отправляем первый
    if (pendingNewOrders.length) {
      // Убедимся, что нет активного заказа
      currentOrderProcessing = null;
      await processNextOrder();
      bot.sendMessage(msg.chat.id, `✅ Перезагрузка выполнена. Отправлен первый заказ. Осталось: ${pendingNewOrders.length}`);
    } else {
      bot.sendMessage(msg.chat.id, '✅ Перезагрузка выполнена. Новых заказов нет.');
    }
  });

  // --- "/orders" Команда для администратора: просмотр списка заказов из API (отладка) ---
  bot.onText(/\/orders(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
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
      // Добавляем подсказку: если нужны детали, можно использовать /order_details <posting_number>
      reply += `\n_Для просмотра деталей заказа используйте /order_details <posting_number>_`;
      await bot.sendMessage(msg.chat.id, reply); // без parse_mode
    } catch (err) {
      console.error('Ошибка в /orders:', err);
      bot.sendMessage(msg.chat.id, '❌ Ошибка при получении списка заказов. Проверьте логи.');
    }
  });

  // --- "/order_details" Команда для администратора: просмотр деталей конкретного заказа ---
  bot.onText(/\/order_details (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
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
      console.error('Ошибка в /order_details:', err);
      bot.sendMessage(msg.chat.id, '❌ Ошибка получения деталей заказа.');
    }
  });

  // --- "/employee_stats" Команда для администратора: статистика сотрудника ---
  bot.onText(/\/employee_stats (\d+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
    const employeeId = parseInt(match[1]);
    const emp = await db.getEmployeeById(employeeId);
    if (!emp) return bot.sendMessage(msg.chat.id, 'Сотрудник не найден.');
    const stats = await db.getEmployeeStats(employeeId);
    const reply = `📊 *Статистика сотрудника ${emp.name}*\n\n` +
      `✅ Завершённых заказов: ${stats.total_orders}\n` +
      `❌ Отменённых заказов: ${stats.canceled_orders || 0}\n` +
      `💰 Общая сумма: ${stats.total_amount.toFixed(2)} ₽`;
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
  });

  // --- "/pause" Команда для администратора: Пауза работы бота ---
  bot.onText(/\/pause/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    scheduler.pauseChecker();
    stopInactivityTimer();
    bot.sendMessage(msg.chat.id, '⏸ Автоматическая проверка заказов приостановлена.');
  });

  // --- "/resume" Команда для администратора: Возобновление работы бота ---
  bot.onText(/\/resume/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    scheduler.resumeChecker();
    startInactivityTimer();
    bot.sendMessage(msg.chat.id, '▶️ Автоматическая проверка заказов возобновлена.');
  });

  // --- "/debug_clear" Команда для администратора: очистить все отладочные данные ---
  bot.onText(/\/debug_clear/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
    if (!debugMode.isDebugMode()) {
      return bot.sendMessage(msg.chat.id, 'Эта команда доступна только в отладочном режиме (DEBUG_ORDERS_MODE=true).');
    }
    debugMode.clearAssignments();
    bot.sendMessage(msg.chat.id, '✅ Все отладочные назначения сброшены.');
  });

  // ---------------------- КОМАНДЫ СОТРУДНИКОВ ----------------------

  // --- "/my_orders" – список активных заказов сотрудника ---
  bot.onText(/\/my_orders/, async (msg) => {
    const userId = msg.from.id.toString();
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }
    const orders = await db.getEmployeeActiveOrders(employee.id);
    if (!orders.length) {
      return bot.sendMessage(msg.chat.id, '✅ У вас нет активных заказов.');
    }
    let reply = '📋 *Ваши активные заказы:*\n';
    for (const o of orders) {
      reply += `• \`${o.order_id}\` (назначен ${new Date(o.assigned_at).toLocaleString()})\n`;
    }
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
  });

  // Функция для безопасной эмуляции (только для отладки)
  async function safeDebugFinish(orderId, employeeId, employeeName, chatId, postingNumber) {
    if (debugMode.isDebugMode()) {
      console.log(`[DEBUG] Эмуляция подтверждения сборки заказа ${postingNumber}`);
      await db.updateEmployeeStats(employeeId, 1000); // фиктивная сумма
      const labelBuffer = await ozon.getPackageLabel(postingNumber);
      await db.completeOrder(postingNumber);
      if (labelBuffer) {
        await bot.sendDocument(chatId, labelBuffer, {
          caption: `✅ [ТЕСТ] Заказ ${postingNumber} успешно собран.\nЭтикетка прилагается.`,
          filename: `label_${postingNumber}.pdf`
        });
      } else {
        await bot.sendMessage(chatId, `✅ [ТЕСТ] Заказ ${postingNumber} подтверждён. Этикетка не получена.`);
      }
      const adminChatId = process.env.ADMIN_USER_ID;
      if (adminChatId) {
        await bot.sendMessage(adminChatId, `📦 [ТЕСТ] Сотрудник ${employeeName} завершил заказ ${postingNumber}.`);
      }
      return true;
    }
    return false;
  }

  // --- "/finish_order" – подтверждение сборки заказа ---
  bot.onText(/\/finish_order (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const postingNumber = match[1];
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }
    const assignment = await db.db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "assigned"',
      postingNumber, employee.id
    );
    if (!assignment) {
      return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не найден среди ваших активных заказов.`);
    }
    const isDebugFinished = await safeDebugFinish(
      assignment.order_id, employee.id, employee.name, msg.chat.id, postingNumber
    );
    if (isDebugFinished) return;
    try {
      // Получаем сумму заказа
      const orderAmount = await ozon.getOrderTotalAmount(postingNumber);
      await db.updateEmployeeStats(employee.id, orderAmount);

      await ozon.confirmPostingShip(postingNumber);
      const labelBuffer = await ozon.getPackageLabel(postingNumber);
      await db.completeOrder(postingNumber);
      if (labelBuffer) {
        await bot.sendDocument(msg.chat.id, labelBuffer, {
          caption: `✅ Заказ ${postingNumber} успешно собран.\nЭтикетка для наклеивания:`,
          filename: `label_${postingNumber}.pdf`
        });
      } else {
        await bot.sendMessage(msg.chat.id, `✅ Заказ ${postingNumber} подтверждён. Этикетку можно скачать в личном кабинете Ozon.`);
      }
      const adminId = process.env.ADMIN_USER_ID;
      if (adminId) {
        await bot.sendMessage(adminId, `📦 Сотрудник ${employee.name} завершил заказ ${postingNumber}.`);
      }
    } catch (err) {
      console.error('Ошибка завершения заказа:', err);
      bot.sendMessage(msg.chat.id, `❌ Не удалось подтвердить сборку заказа ${postingNumber}: ${err.message}`);
    }
  });

  // --- "/cancel_order" – отмена заказа сотрудником (с подтверждением) ---
  bot.onText(/\/cancel_order (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const postingNumber = match[1];
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }
    // Проверяем, что заказ назначен этому сотруднику и активен
    const assignment = await db.db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "assigned"',
      postingNumber, employee.id
    );
    if (!assignment) {
      return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не найден среди ваших активных заказов.`);
    }
    // Клавиатура подтверждения
    const confirmKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Да, отменить', callback_data: `confirm_cancel_${postingNumber}` },
            { text: '❌ Нет', callback_data: `cancel_cancel_${postingNumber}` }
          ]
        ]
      }
    };
    await bot.sendMessage(msg.chat.id, `⚠️ Вы уверены, что хотите отменить заказ ${postingNumber}?`, confirmKeyboard);
  });

  // ---------------------- СПРАВОЧНЫЕ КОМАНДЫ ----------------------
  bot.onText(/\/help/, async (msg) => {
    const userId = msg.from.id.toString();
    const isAdministrator = isAdmin(userId);
    const employee = await db.getEmployee(userId);
    if (isAdministrator) {
      let helpText = `👋 Помощь администратора\n\n`;
      helpText += `/status_all — статус всех сотрудников\n`;
      helpText += `/active_orders — список активных заказов\n`;
      helpText += `/warehouses — список складов Ozon\n`;
      helpText += `/employee_warehouses <id> — склады сотрудника\n`;
      helpText += `/employee_stats <id> — статистика сотрудника (заказы, сумма)\n`;
      helpText += `/orders [warehouse_id] — показать очередь заказов из API\n`;
      helpText += `/employee_orders <id> — активные заказы сотрудника\n`;
      helpText += `/order_details <номер> — показать детали заказа\n`;
      helpText += `/admin_cancel_order <id> — снять заказ с сотрудника\n`;
      helpText += `/clear_assignments — сброс ВСЕХ назначений на заказы\n`;
      helpText += `/reload_queue — Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов\n`;
      helpText += `/pause — приостановить авто-проверку очереди заказов\n`;
      helpText += `/resume — возобновить авто-проверку очереди заказов\n`;
      if (debugMode.isDebugMode()) helpText += `/debug_clear — сброс отладочных данных\n`;
      await bot.sendMessage(msg.chat.id, helpText);
      return;
    }
    if (employee) {
      let helpText = `👋 Помощь сотрудника\n\n`;
      helpText += `/my_orders — показать мои активные заказы\n`;
      helpText += `/finish_order <номер_заказа> — завершить заказ (получить этикетку)\n`;
      helpText += `/cancel_order <номер_заказа> — отменить заказ (если не можете выполнить)\n`;
      helpText += `/start — перезапустить бота\n`;
      helpText += `/help — эта справка\n\n`;
      helpText += `Внимание: Новые заказы вам назначает администратор.`;
      await bot.sendMessage(msg.chat.id, helpText);
      return;
    }
    // Неавторизованный пользователь
    await bot.sendMessage(msg.chat.id, '🤖 Этот бот для сотрудников склада. Если вы здесь по работе, обратитесь к администратору для получения доступа.');
  });

  console.log('Команды зарегистрированы');
};