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
      console.log(`[CONFIRM_CANCEL] Попытка отмены заказа ${orderId} от пользователя ${userId}`);
      const employee = await db.getEmployee(userId);
      if (!employee) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Сотрудник не найден' });
        return;
      }
      try {
        await db.cancelOrder(orderId, employee.id);
        if (currentOrderProcessing && currentOrderProcessing.order.posting_number === orderId) {
          currentOrderProcessing = null;
          console.log(`[CONFIRM_CANCEL] Сброшен currentOrderProcessing для заказа ${orderId}`);
        }
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Заказ отменён' });
        await bot.editMessageText(`✅ Заказ ${orderId} отменён.`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });

        // Уведомляем модератора
        const moderatorId = process.env.MODERATOR_ID;
        if (moderatorId) {
          await bot.sendMessage(moderatorId, `📦 Сотрудник ${employee.name} отменил заказ ${orderId}. Заказ возвращён в очередь.`);
        }

        await checkAndOfferNewOrders();
        if (!currentOrderProcessing && pendingNewOrders.length) {
          console.log(`[CONFIRM_CANCEL] Отправляем следующий заказ, осталось: ${pendingNewOrders.length}`);
          await processNextOrder();
        }
      } catch (err) {
        console.error(`[CONFIRM_CANCEL] Ошибка:`, err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: err.message });
      }
      return;
    }

    // Кнопка "Нет" (отклонение подтверждения)
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

        // --- Отправка 3D-моделей и уведомление о пропущенных ---
        const validExtensions = ['.stl', '.3mf', '.step', '.obj'];

        for (const product of orderDetails.products) {
          const originalOfferId = product.offer_id;
          if (!originalOfferId) continue;

          // Формируем список offer_id для поиска (сначала точный, потом родительский)
          const offersToCheck = [originalOfferId];
          const parentOfferId = getParentOfferId(originalOfferId);
          if (parentOfferId) offersToCheck.push(parentOfferId);

          let models = [];
          let usedOfferId = null;
          let textFiles = [];
          let skipped = [];

          for (const oid of offersToCheck) {
            models = await db.getProductModelsByExtensions(oid, validExtensions);
            textFiles = await db.getTextFilesForOfferId(oid);
            skipped = await db.getSkippedModels(oid);
            if (models.length) {
              usedOfferId = oid;
              break;
            }
          }

          if (!models.length) {
            if (textFiles.length) {
              for (const txt of textFiles) {
                await bot.sendDocument(MODERATOR_ID, txt.file_id, {
                  caption: `📄 Текстовый файл для товара ${product.name} (${originalOfferId}) из offer_id ${txt.offer_id}: ${txt.file_name}\nОтправьте его сотруднику ${employee.tg_user_id} вручную.`
                });
              }
              await bot.sendMessage(employee.tg_user_id, `ℹ️ Для товара ${product.name} (${originalOfferId}) нет 3D-моделей, но есть инструкция (файл .txt). Обратитесь к модератору.`);
            } else {
              await bot.sendMessage(MODERATOR_ID, `⚠️ Для товара ${product.name} (${originalOfferId}) отсутствуют 3D-модели.\nОтправьте их сотруднику ${employee.tg_user_id} вручную`);
              await bot.sendMessage(employee.tg_user_id, `ℹ️ 3D-модели для товара ${product.name} (${originalOfferId}) отсутствуют. Обратитесь к модератору за выдачей.`);
            }
            continue;
          }

          for (const model of models) {
            let caption = `📁 3D-модель для ${product.name}\noffer_id: ${originalOfferId}`;
            if (usedOfferId !== originalOfferId) {
              caption += `\n(модель взята из offer_id: ${usedOfferId})`;
            }
            caption += `\nФайл: ${model.file_name}`;
            await bot.sendDocument(employee.tg_user_id, model.file_id, { caption });
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          if (skipped.length) {
            const fileList = skipped.map(s => s.file_name).join(', ');
            await bot.sendMessage(MODERATOR_ID, `⚠️ Для товара ${product.name} (${originalOfferId}) не загружены модели: ${fileList}.\nОтправьте их сотруднику ${employee.tg_user_id} вручную.`);
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

    // 8. Кнопка "Нет" для снятия заказа администратором
    if (data.startsWith('admin_cancel_abort_')) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Снятие заказа отменено' });
      await bot.deleteMessage(msg.chat.id, msg.message_id);
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
      adminMessage += `/admin_cancel_order <id> — снять заказ с сотрудника\n\n`;

      adminMessage += `📁 3D-модели:\n`;
      adminMessage += `/send_models <offer_id> [id_сотрудника] — отправить все модели для offer_id сотруднику (если ID не указан – себе)\n\n`;

      adminMessage += `/upload_model — загрузить новую модель (или обновить файл), взять Артикул из названия файла\nПример названия файла: "2001867564-N_bmw e53.stl" (отправить файл после команды)\n`;
      adminMessage += `/remove_model <offer_id> <имя_файла> — удалить модель\n`;
      adminMessage += `/list_models <offer_id> — список моделей для offer_id\n`;
      adminMessage += `/cancel_model — отменить ожидание загрузки модели\n\n`;

      adminMessage += `/add_model <offer_id> — загрузить новую модель (отправить файл после команды)\n\n`;

      adminMessage += `
      📌 Для больших файлов (>50 МБ):
1. Залейте файл в канал моделей вручную (Telegram Desktop позволяет до 2 ГБ).
2. Перешлите сообщение боту с caption:
   offer_id: НАШ_OFFER_ID
   Файл: ИМЯ_ФАЙЛА.расширение
3. Бот автоматически привяжет модель.
\n\n`;

      adminMessage += `/bind_forward — инструкция по привязке модели через пересылку из канала\n\n`;

      adminMessage += `/bind_model <offer_id> <file_id> [имя_файла] — привязать существующий файл (любого размера) к offer_id\n`;
      adminMessage += `/get_file_id — получить file_id пересланного файла (для последующей привязки)\n`;
      adminMessage += `/cancel_bind — отменить ожидание file_id\n\n`;

      adminMessage += `/clear_assignments — сброс ВСЕХ назначений на заказы\n\n`;
      adminMessage += `/reload_queue — Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов\n\n`;
      adminMessage += `/pause — приостановить авто-проверку очереди заказов\n`;
      adminMessage += `/resume — возобновить авто-проверку очереди заказов\n\n`;
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

  // Ожидание файла для /upload_model
  let pendingUploadModel = new Map(); // userId -> { step: 'waiting_file' }

  // --- "/upload_model" Команда для администратора: добавление/обновление 3D-модели ---
  bot.onText(/\/upload_model/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может загружать модели.');
    }
    pendingUploadModel.set(userId, { step: 'waiting_file' });
    bot.sendMessage(msg.chat.id, '📤 Отправьте файл модели. Имя файла должно содержать offer_id (например, 2001867564-N_avs_k1.3mf).');
  });

  // --- "/remove_model" Команда для администратора: удаление модели ---
  bot.onText(/\/remove_model (\S+) (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может удалять модели.');
    }
    const offerId = match[1];
    const fileName = match[2];
    try {
      await db.deleteProductModel(offerId, fileName);
      bot.sendMessage(msg.chat.id, `✅ Модель ${fileName} для offer_id ${offerId} удалена из базы.`);
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Ошибка удаления: ${err.message}`);
    }
  });

  // --- "/list_models" Команда для администратора: список моделей для offer_id ---
  bot.onText(/\/list_models (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может смотреть список моделей.');
    }
    const offerId = match[1];
    const models = await db.getAllProductModels(offerId);
    if (!models.length) {
      return bot.sendMessage(msg.chat.id, `📭 Нет моделей для offer_id ${offerId}.`);
    }
    let reply = `📋 Модели для ${offerId}:\n`;
    for (const m of models) {
      reply += `• ${m.file_name} (${(m.file_size / 1024 / 1024).toFixed(2)} МБ)\n`;
    }
    await bot.sendMessage(msg.chat.id, reply);
  });

  // --- "/cancel_model" Команда для администратора: отмена ожидания заливки модели ---
  bot.onText(/\/cancel_model/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может отменить заливку модели.');
    }
    if (global.pendingModelAdd && global.pendingModelAdd.has(userId)) {
      global.pendingModelAdd.delete(userId);
      bot.sendMessage(msg.chat.id, 'Операция добавления модели отменена.');
    } else {
      bot.sendMessage(msg.chat.id, 'Нет активной операции.');
    }
  });

  // --- "/add_model" Команда для администратора: добавление/обновление 3D-модели ---
  bot.onText(/\/add_model (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может добавлять модели.');
    }
    const offerId = match[1];
    // Ожидаем, что следующим сообщением администратор отправит файл
    bot.sendMessage(msg.chat.id, `Отправьте файл модели для offer_id ${offerId} (до 50 МБ).`);
    // Сохраняем состояние: ожидаем файл для этого offer_id
    // Можно использовать временное хранилище, например, Map
    if (!global.pendingModelAdd) global.pendingModelAdd = new Map();
    global.pendingModelAdd.set(userId, { offerId, step: 'waiting_file' });
  });

  // --- "/bind_model" Команда для администратора: привязка существующего файла из канала к offer_id ---
  // Формат: /bind_model <offer_id> <file_id> [имя_файла]
  bot.onText(/\/bind_model (\S+) (\S+)(?: (.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    const offerId = match[1];
    const fileId = match[2];
    const fileName = match[3] || `привязанный_файл_${Date.now()}`;

    try {
      // НЕ используем bot.getFile – привязка работает с любым размером
      // Размер неизвестен, сохраняем 0 (можно обновить позже, если потребуется)
      await db.upsertProductModel(offerId, fileId, fileName, 0);
      await bot.sendMessage(msg.chat.id, `✅ Модель "${fileName}" для offer_id ${offerId} успешно привязана (file_id: ${fileId}).`);
    } catch (err) {
      await bot.sendMessage(msg.chat.id, `❌ Ошибка привязки: ${err.message}`);
    }
  });

  // --- "/get_file_id" Команда для администратора: получить file_id пересланного файла ---
  bot.onText(/\/get_file_id/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    bot.sendMessage(msg.chat.id, '📤 Перешлите файл из канала моделей (или отправьте его).');
    // Сохраняем состояние ожидания
    if (!global.pendingFileId) global.pendingFileId = new Map();
    global.pendingFileId.set(userId, { step: 'waiting_file' });
  });

  // --- "/cancel_bind" Команда для администратора: отменить привязку файла ---
  bot.onText(/\/cancel_bind/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (global.pendingFileId && global.pendingFileId.has(userId)) {
      global.pendingFileId.delete(userId);
      bot.sendMessage(msg.chat.id, 'Операция получения file_id отменена.');
    } else {
      bot.sendMessage(msg.chat.id, 'Нет активной операции.');
    }
  });

  // ---------------------- ЕДИНЫЙ ОБРАБОТЧИК ДОКУМЕНТОВ ----------------------
  bot.on('document', async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return;

    // Приоритет 1: /upload_model
    if (pendingUploadModel && pendingUploadModel.has(userId)) {
      const pending = pendingUploadModel.get(userId);
      if (pending.step !== 'waiting_file') return;

      const file = msg.document;
      const fileName = file.file_name;
      // Извлекаем offer_id из имени файла
      let offerId = fileName;
      const underscoreIndex = fileName.indexOf('_');
      if (underscoreIndex !== -1) {
        offerId = fileName.substring(0, underscoreIndex);
      } else {
        const dotIndex = fileName.lastIndexOf('.');
        if (dotIndex !== -1) {
          offerId = fileName.substring(0, dotIndex);
        }
      }
      offerId = offerId.trim();
      if (!offerId) {
        await bot.sendMessage(msg.chat.id, '❌ Не удалось извлечь offer_id из имени файла. Убедитесь, что имя начинается с offer_id (например, 2001867564-N_...).');
        pendingUploadModel.delete(userId);
        return;
      }

      try {
        const sent = await bot.sendDocument(process.env.MODELS_CHAT_ID, file.file_id, {
          caption: `offer_id: ${offerId}\nФайл: ${fileName}`
        });
        const newFileId = sent.document.file_id;
        await db.deleteProductModel(offerId, fileName);
        await db.upsertProductModel(offerId, newFileId, fileName, file.file_size);
        await bot.sendMessage(msg.chat.id, `✅ Модель ${fileName} для offer_id ${offerId} успешно загружена/обновлена.`);
      } catch (err) {
        console.error('Ошибка загрузки модели:', err);
        await bot.sendMessage(msg.chat.id, `❌ Ошибка загрузки: ${err.message}`);
      }
      pendingUploadModel.delete(userId);
      return;
    }

    // Приоритет 2: /add_model
    if (global.pendingModelAdd && global.pendingModelAdd.has(userId)) {
      const pending = global.pendingModelAdd.get(userId);
      if (pending.step !== 'waiting_file') return;

      const file = msg.document;
      const fileSizeMB = file.file_size / (1024 * 1024);
      if (fileSizeMB > 50) {
        await bot.sendMessage(msg.chat.id, `❌ Файл слишком большой (${fileSizeMB.toFixed(2)} МБ). Максимум 50 МБ.`);
        return;
      }
      const fileName = file.file_name;
      const offerId = pending.offerId;

      try {
        const sent = await bot.sendDocument(process.env.MODELS_CHAT_ID, file.file_id, {
          caption: `offer_id: ${offerId}\nФайл: ${fileName}`
        });
        const newFileId = sent.document.file_id;
        await db.deleteProductModel(offerId, fileName);
        await db.upsertProductModel(offerId, newFileId, fileName, file.file_size);
        await bot.sendMessage(msg.chat.id, `✅ Модель ${fileName} для offer_id ${offerId} успешно добавлена/обновлена.`);
      } catch (err) {
        console.error('Ошибка добавления модели:', err);
        await bot.sendMessage(msg.chat.id, `❌ Ошибка добавления модели: ${err.message}`);
      }
      global.pendingModelAdd.delete(userId);
      return;
    }

    // Приоритет 3: /get_file_id
    if (global.pendingFileId && global.pendingFileId.has(userId)) {
      const pending = global.pendingFileId.get(userId);
      if (pending.step === 'waiting_file') {
        const file = msg.document;
        const fileId = file.file_id;
        const fileName = file.file_name;
        const fileSize = file.file_size;
        await bot.sendMessage(msg.chat.id,
          `✅ file_id: \`${fileId}\`\nИмя: ${fileName}\nРазмер: ${(fileSize / 1024 / 1024).toFixed(2)} МБ\n\nИспользуйте /bind_model <offer_id> ${fileId} "${fileName}"`);
        global.pendingFileId.delete(userId);
      }
      return;
    }

    // Приоритет 4: пересылка из канала (без активного состояния)
    if (msg.forward_from_chat || msg.forward_from) {
      const caption = msg.caption || '';
      const offerIdMatch = caption.match(/offer_id:\s*(\S+)/i);
      const fileNameMatch = caption.match(/Файл:\s*(.+)/i);

      if (!offerIdMatch || !fileNameMatch) {
        return;
      }

      const offerId = offerIdMatch[1].trim();
      const fileName = fileNameMatch[1].trim();
      const fileId = msg.document.file_id;
      const fileSize = msg.document.file_size;

      // НЕ вызываем bot.getFile
      await db.upsertProductModel(offerId, fileId, fileName, fileSize);
      await bot.sendMessage(msg.chat.id, `✅ Модель ${fileName} для offer_id ${offerId} успешно привязана/обновлена.`);
      return;
    }
  });

  // --- "/bind_forward" Команда для администратора: инструкция по привязке модели через пересылку из канала ---
  bot.onText(/\/bind_forward/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    const help = `
📤 *Привязка модели через пересылку из канала*

1. Залейте файл модели (любого размера) в канал моделей вручную.
2. Перешлите это сообщение боту.
3. В caption (подпись к файлу) укажите:
   \`offer_id: НАШ_OFFER_ID\`
   \`Файл: ИМЯ_ФАЙЛА.расширение\`

Пример:
\`\`\`
offer_id: ARD000901-NR
Файл: ARD000901-NR_ABS-H2S.3mf
\`\`\`

Бот автоматически привяжет модель к offer_id.
    `;
    await bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
  });

  // --- "/send_models" Команда для администратора: отправить все модели для offer_id сотруднику (или себе) ---
  bot.onText(/\/send_models (\S+)(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const offerId = match[1];
    const targetEmployeeId = match[2] ? parseInt(match[2]) : null;

    // Если не указан сотрудник – отправляем себе (администратору)
    let targetChatId = msg.chat.id;
    let targetName = 'себе';

    if (targetEmployeeId) {
      const employee = await db.getEmployeeById(targetEmployeeId);
      if (!employee) {
        return bot.sendMessage(msg.chat.id, `❌ Сотрудник с ID ${targetEmployeeId} не найден.`);
      }
      targetChatId = employee.tg_user_id;
      targetName = employee.name;
    }

    // Получаем все модели для данного offer_id
    const models = await db.getAllProductModels(offerId);
    if (!models || models.length === 0) {
      return bot.sendMessage(msg.chat.id, `📭 Нет моделей для offer_id ${offerId}.`);
    }

    // Проверяем, может ли бот писать в целевой чат
    try {
      await bot.sendChatAction(targetChatId, 'typing');
    } catch (err) {
      return bot.sendMessage(msg.chat.id, `❌ Не удалось отправить сообщение сотруднику ${targetName}. Возможно, он не начал диалог с ботом.`);
    }

    await bot.sendMessage(msg.chat.id, `📤 Отправляю ${models.length} моделей для offer_id ${offerId} ${targetEmployeeId ? `сотруднику ${targetName}` : 'себе'}...`);

    let sentCount = 0;
    for (const model of models) {
      try {
        const caption = `📁 Модель для offer_id: ${offerId}\nФайл: ${model.file_name}`;
        await bot.sendDocument(targetChatId, model.file_id, { caption });
        sentCount++;
        // Небольшая задержка, чтобы избежать флуда
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        console.error(`Ошибка отправки модели ${model.file_name}:`, err.message);
        await bot.sendMessage(msg.chat.id, `❌ Ошибка при отправке файла ${model.file_name}: ${err.message}`);
      }
    }

    await bot.sendMessage(msg.chat.id, `✅ Отправлено ${sentCount} из ${models.length} моделей для offer_id ${offerId} ${targetEmployeeId ? `сотруднику ${targetName}` : 'себе'}.`);
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
      console.log(`[getPackageLabel] Вызов с postingNumber = "${postingNumber}" (тип: ${typeof postingNumber})`);
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

      // Уведомляем модератора
      const moderatorId = process.env.MODERATOR_ID;
      if (moderatorId) {
        await bot.sendMessage(moderatorId, `📦 [ТЕСТ] Сотрудник ${employeeName} завершил заказ ${postingNumber}.`);
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
      const orderAmount = await ozon.getOrderTotalAmount(postingNumber);
      await db.updateEmployeeStats(employee.id, orderAmount);

      // 1. Создаём акт (формируем документы)
      const actResponse = await ozon.confirmPostingShip(postingNumber);
      const actId = actResponse?.result?.id || actResponse?.id;
      console.log(`[FINISH] Получен actId: ${actId}`);

      // Задержка 10 секунд для обработки на стороне Ozon
      await new Promise(resolve => setTimeout(resolve, 10000));

      // 2. Переводим заказ в awaiting_deliver
      const deliveryResponse = await ozon.awaitingDelivery(postingNumber);
      console.log(`[FINISH] awaiting-delivery ответ:`, deliveryResponse);

      // 3. Ждём 5 секунд для синхронизации
      await new Promise(resolve => setTimeout(resolve, 5000));

      // 4. Получаем этикетку (пробуем через actId, затем через posting_number)
      let labelBuffer = null;
      if (actId) {
        labelBuffer = await ozon.getPackageLabel(null, actId);
      }
      if (!labelBuffer) {
        labelBuffer = await ozon.getPackageLabel(postingNumber);
      }

      await db.completeOrder(postingNumber);

      if (labelBuffer) {
        await bot.sendDocument(msg.chat.id, labelBuffer, {
          caption: `✅ Заказ ${postingNumber} успешно собран.\nЭтикетка для наклеивания:`,
          filename: `label_${postingNumber}.pdf`
        });
      } else {
        await bot.sendMessage(msg.chat.id, `✅ Заказ ${postingNumber} подтверждён. Этикетку можно скачать в личном кабинете Ozon.`);
      }

      // Уведомляем модератора
      const moderatorId = process.env.MODERATOR_ID;
      if (moderatorId) {
        await bot.sendMessage(moderatorId, `📦 Сотрудник ${employee.name} завершил заказ ${postingNumber}.`);
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
    console.log(`[CANCEL_ORDER] Пользователь ${userId} пытается отменить заказ ${postingNumber}`);
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }
    const assignment = await db.db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "assigned"',
      postingNumber, employee.id
    );
    if (!assignment) {
      console.log(`[CANCEL_ORDER] Заказ ${postingNumber} не найден среди активных заказов сотрудника ${employee.id}`);
      return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не найден среди ваших активных заказов.`);
    }
    console.log(`[CANCEL_ORDER] Заказ найден, показываем подтверждение`);
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
      helpText += `/admin_cancel_order <id> — снять заказ с сотрудника\n\n`;

      helpText += `📁 3D-модели:\n`;

      helpText += `/send_models <offer_id> [id_сотрудника] — отправить все модели для offer_id сотруднику (если ID не указан – себе)\n\n`;

      helpText += `/upload_model — загрузить новую модель (или обновить файл), взять Артикул из названия файла\nПример названия файла: "2001867564-N_bmw e53.stl" (отправить файл после команды)\n`;
      helpText += `/remove_model <offer_id> <имя_файла> — удалить модель\n`;
      helpText += `/list_models <offer_id> — список моделей для offer_id\n`;
      helpText += `/cancel_model — отменить ожидание загрузки модели\n\n`;

      helpText += `/add_model <offer_id> — загрузить новую модель (отправить файл после команды)\n\n`;

      helpText += `
      📌 Для больших файлов (>50 МБ):
1. Залейте файл в канал моделей вручную (Telegram Desktop позволяет до 2 ГБ).
2. Перешлите сообщение боту с caption:
   offer_id: НАШ_OFFER_ID
   Файл: ИМЯ_ФАЙЛА.расширение
3. Бот автоматически привяжет модель.
\n\n`;

      helpText += `/bind_forward — инструкция по привязке модели через пересылку из канала\n\n`;

      helpText += `/bind_model <offer_id> <file_id> [имя_файла] — привязать существующий файл (любого размера) к offer_id\n\n`;
      helpText += `/get_file_id — получить file_id пересланного файла (для последующей привязки)\n`;
      helpText += `/cancel_bind — отменить ожидание file_id\n\n`;


      helpText += `/clear_assignments — сброс ВСЕХ назначений на заказы\n\n`;
      helpText += `/reload_queue — Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов\n\n`;
      helpText += `/pause — приостановить авто-проверку очереди заказов\n`;
      helpText += `/resume — возобновить авто-проверку очереди заказов\n\n`;
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