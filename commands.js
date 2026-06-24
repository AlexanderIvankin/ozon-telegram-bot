const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const axios = require('axios');
const { syncEmployeesFromExcel } = require('./syncEmployees');

// Локальные хранилища для состояний
let pendingFinishConfirmations = new Map(); // key: orderId, value: { originalChatId, originalMessageId }
let pendingEmployeeUpload = new Map(); // userId -> { step: 'waiting_file' }
let pendingMaterialsUpload = new Map(); // userId -> { step: 'waiting_file' }
let pendingUploadModel = new Map(); // userId -> { step: 'waiting_file' }
let pendingForms = new Map(); // key: userId_orderId, value: { orderId, offers, allCompleted }
let pendingStatsFill = new Map(); // userId -> { offerId, step, data: { material, color, weight } }
let pendingModelAdd = new Map();    // для /add_model
let pendingFileId = new Map();      // для /get_file_id
let materialsData = null;

const MIN_EARNINGS = 250; // минимальный заработок за заказ

// Загружаем справочники при старте
function loadMaterials() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'materials.json'), 'utf8');
    materialsData = JSON.parse(raw);
    console.log('✅ Справочники материалов загружены');
  } catch (err) {
    console.error('❌ Ошибка загрузки materials.json:', err.message);
    // Задаём дефолтные значения
    materialsData = {
      colors: ["Черный", "Белый", "Серый", "Прозрачный", "Красный", "Желтый", "Зеленый"],
      materials: {
        "Pet-G": 2.5,
        "ABS": 2.5,
        "Нейлон Pa-6": 2.5,
        "Нейлон Pa-12": 2.5,
        "НейлонАрмир": 2.5,
        "ASA": 2.5
      }
    };
  }
}
loadMaterials();

module.exports = function registerCommands(
  bot, db, ozon, bwipjs, scheduler, debugMode,
  isAuthorizedUser, isModerator, isAdmin,
  showOrderMenu, checkAndOfferNewOrders, processNextOrder,
  pendingNewOrders, currentOrderProcessing,
  deleteLastOrderMessages, updateModeratorActivity,
  startInactivityTimer, stopInactivityTimer
) {

  // Вспомогательная функция безопасного удаления сообщения
  async function safeDeleteMessage(chatId, messageId) {
    if (!chatId || !messageId) return;
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (e) {
      // Игнорируем ошибки (сообщение могло быть уже удалено)
    }
  }

  // Деактивирует клавиатуру у сообщения (убирает кнопки)
  async function disableKeyboard(chatId, messageId) {
    if (!chatId || !messageId) return;
    try {
      await bot.editMessageReplyMarkup(
        { chat_id: chatId, message_id: messageId },
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (e) {
      // Игнорируем ошибки
    }
  }

  async function exportProductStats() {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const stats = await db.getAllProductStats();
        if (!stats.length) return;
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(stats.map(s => ({
          'Артикул': s.offer_id,
          'Материал': s.material,
          'Цвет': s.color,
          'Вес (г)': s.weight_grams,
          'Кто заполнил': s.employee_name || 'Неизвестно',
          'Дата': new Date(s.updated_at).toLocaleString()
        })));
        XLSX.utils.book_append_sheet(wb, ws, 'Статистика');
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const outputPath = path.join(__dirname, 'exports', 'product-stats.xlsx');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, buffer);
        // небольшая задержка после записи
        await new Promise(resolve => setTimeout(resolve, 100));
        return; // успешно
      } catch (err) {
        console.error(`[EXPORT] Попытка ${attempt} ошибка:`, err);
        if (attempt === maxRetries) {
          console.error('[EXPORT] Не удалось сохранить статистику');
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
  }

  async function calculateOrderEarnings(orderDetails, employeeId) {
    const earningsDetails = [];
    let totalEarnings = 0;
    let allHaveStats = true;

    for (const product of orderDetails.products) {
      const offerId = product.offer_id;
      if (!offerId) continue;
      const stats = await db.getProductStats(offerId);
      if (!stats) {
        allHaveStats = false;
        console.warn(`[EARN] Для товара ${offerId} нет статистики, пропускаем`);
        continue;
      }
      const materialPrice = materialsData.materials[stats.material] || 0;
      const weight = stats.weight_grams || 0;
      let earningsPerUnit = materialPrice * weight;
      if (earningsPerUnit < MIN_EARNINGS) earningsPerUnit = MIN_EARNINGS;
      const quantity = product.quantity || 1;
      const totalForProduct = earningsPerUnit * quantity;
      totalEarnings += totalForProduct;
      earningsDetails.push({
        offerId,
        productName: product.name,
        material: stats.material,
        weight,
        quantity,
        earningsPerUnit,
        totalForProduct
      });
    }

    return { total: totalEarnings, details: earningsDetails, allHaveStats };
  }

  // --- Вспомогательные функции для административного заполнения статистики (без Markdown) ---
  async function askAdminMaterial(userId, offerId) {
    const state = pendingStatsFill.get(userId);
    if (state) {
      // Удаляем предыдущее сообщение
      if (state.lastMessageId) {
        try { await bot.deleteMessage(userId, state.lastMessageId); } catch (e) { }
        state.lastMessageId = null;
      }
    }

    const materialNames = Object.keys(materialsData.materials);
    const keyboard = [];
    for (let i = 0; i < materialNames.length; i += 2) {
      const row = [];
      row.push({ text: materialNames[i], callback_data: `admin_mat_${offerId}_${materialNames[i]}` });
      if (i + 1 < materialNames.length) {
        row.push({ text: materialNames[i + 1], callback_data: `admin_mat_${offerId}_${materialNames[i + 1]}` });
      }
      keyboard.push(row);
    }
    keyboard.push([{ text: '❌ Отмена заполнения', callback_data: 'admin_cancel_stats' }]);

    const sentMsg = await bot.sendMessage(userId,
      `🪵 Выберите материал для артикула ${offerId}:`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
    if (state) state.lastMessageId = sentMsg.message_id;
  }

  async function askAdminColor(userId, offerId) {
    const state = pendingStatsFill.get(userId);
    if (state) {
      if (state.lastMessageId) {
        try { await bot.deleteMessage(userId, state.lastMessageId); } catch (e) { }
        state.lastMessageId = null;
      }
    }

    const colors = materialsData.colors;
    const keyboard = [];
    for (let i = 0; i < colors.length; i += 2) {
      const row = [];
      row.push({ text: colors[i], callback_data: `admin_color_${offerId}_${colors[i]}` });
      if (i + 1 < colors.length) {
        row.push({ text: colors[i + 1], callback_data: `admin_color_${offerId}_${colors[i + 1]}` });
      }
      keyboard.push(row);
    }
    keyboard.push([{ text: '❌ Отмена заполнения', callback_data: 'admin_cancel_stats' }]);

    const sentMsg = await bot.sendMessage(userId,
      `🎨 Выберите цвет для артикула ${offerId}:`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
    if (state) state.lastMessageId = sentMsg.message_id;
  }

  async function askAdminWeight(userId, offerId) {
    const state = pendingStatsFill.get(userId);
    if (state) {
      if (state.lastMessageId) {
        try { await bot.deleteMessage(userId, state.lastMessageId); } catch (e) { }
        state.lastMessageId = null;
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '❌ Отмена заполнения', callback_data: 'admin_cancel_stats' }]
      ]
    };
    const sentMsg = await bot.sendMessage(userId,
      `⚖️ Введите вес в граммах (только число) для артикула ${offerId}:`,
      { reply_markup: keyboard }
    );
    if (state) state.lastMessageId = sentMsg.message_id;
  }

  async function askMaterial(employeeId, offerId, orderId) {
    // Удаляем предыдущее сообщение шага, если оно было
    const key = `${employeeId}_${orderId}`;
    const state = pendingForms.get(key);
    if (state && state.offers[offerId]) {
      // Деактивируем кнопку у исходного сообщения
      if (state.offers[offerId].messageId) {
        await disableKeyboard(employeeId, state.offers[offerId].messageId);
      }
      // Удаляем предыдущее сообщение шага
      const prevMsgId = state.offers[offerId].stepMessageId;
      if (prevMsgId) {
        try { await bot.deleteMessage(employeeId, prevMsgId); } catch (e) { }
        state.offers[offerId].stepMessageId = null;
      }
    }

    const materialNames = Object.keys(materialsData.materials);
    const keyboard = [];
    for (let i = 0; i < materialNames.length; i += 2) {
      const row = [];
      row.push({ text: materialNames[i], callback_data: `mat_${orderId}_${offerId}_${materialNames[i]}` });
      if (i + 1 < materialNames.length) {
        row.push({ text: materialNames[i + 1], callback_data: `mat_${orderId}_${offerId}_${materialNames[i + 1]}` });
      }
      keyboard.push(row);
    }
    keyboard.push([{ text: '🔄 Сбросить', callback_data: `reset_stats_${orderId}_${offerId}` }]);

    const sentMsg = await bot.sendMessage(employeeId, `🪵 Выберите материал для товара ${offerId}:`, {
      reply_markup: { inline_keyboard: keyboard }
    });

    // Сохраняем ID нового сообщения
    if (state && state.offers[offerId]) {
      state.offers[offerId].stepMessageId = sentMsg.message_id;
    }
  }

  async function askColor(employeeId, offerId, orderId) {
    const key = `${employeeId}_${orderId}`;
    const state = pendingForms.get(key);
    if (state && state.offers[offerId]) {
      // Удаляем предыдущее сообщение шага
      const prevMsgId = state.offers[offerId].stepMessageId;
      if (prevMsgId) {
        try { await bot.deleteMessage(employeeId, prevMsgId); } catch (e) { }
        state.offers[offerId].stepMessageId = null;
      }
    }

    const colors = materialsData.colors;
    const keyboard = [];
    for (let i = 0; i < colors.length; i += 2) {
      const row = [];
      row.push({ text: colors[i], callback_data: `color_${orderId}_${offerId}_${colors[i]}` });
      if (i + 1 < colors.length) {
        row.push({ text: colors[i + 1], callback_data: `color_${orderId}_${offerId}_${colors[i + 1]}` });
      }
      keyboard.push(row);
    }
    keyboard.push([{ text: '🔄 Сбросить', callback_data: `reset_stats_${orderId}_${offerId}` }]);

    const sentMsg = await bot.sendMessage(employeeId, `🎨 Выберите цвет пластика для товара ${offerId}:`, {
      reply_markup: { inline_keyboard: keyboard }
    });

    if (state && state.offers[offerId]) {
      state.offers[offerId].stepMessageId = sentMsg.message_id;
    }
  }

  async function askWeight(employeeId, offerId, orderId) {
    const key = `${employeeId}_${orderId}`;
    const state = pendingForms.get(key);
    if (state && state.offers[offerId]) {
      // Удаляем предыдущее сообщение шага
      const prevMsgId = state.offers[offerId].stepMessageId;
      if (prevMsgId) {
        try { await bot.deleteMessage(employeeId, prevMsgId); } catch (e) { }
        state.offers[offerId].stepMessageId = null;
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Сбросить', callback_data: `reset_stats_${orderId}_${offerId}` }]
      ]
    };
    const sentMsg = await bot.sendMessage(employeeId, `⚖️ Введите вес пластика в граммах (только число) для товара ${offerId}:`, {
      reply_markup: keyboard
    });

    if (state && state.offers[offerId]) {
      state.offers[offerId].waitingForWeight = true;
      state.offers[offerId].status = 'weight_entered';
      state.offers[offerId].stepMessageId = sentMsg.message_id;
    }
  }

  async function sendFinishButton(employeeId, orderId) {
    const finishKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Завершить заказ', callback_data: `finish_order_${orderId}` }]
        ]
      }
    };
    await bot.sendMessage(employeeId, `✅ Все данные для заказа ${orderId} заполнены. Теперь вы можете завершить заказ.`, finishKeyboard);
  }

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

    // Подтверждение завершения заказа сотрудником
    if (data.startsWith('finish_order_')) {
      const orderId = data.substring(13);
      const userId = callbackQuery.from.id.toString();
      const employee = await db.getEmployee(userId);
      if (!employee) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Вы не зарегистрированы как сотрудник.' });
        return;
      }
      const assignment = await db.db.get(
        'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "assigned"',
        orderId, employee.id
      );
      if (!assignment) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Заказ не найден или не ваш.' });
        return;
      }

      // --- Проверка статистики по БД ---
      try {
        const orderDetails = await ozon.getOrderDetails(orderId);
        if (orderDetails && orderDetails.products) {
          let missingStats = [];
          for (const product of orderDetails.products) {
            const offerId = product.offer_id;
            if (!offerId) continue;
            const stats = await db.getProductStats(offerId);
            if (!stats) missingStats.push(offerId);
          }
          if (missingStats.length > 0) {
            const missingList = missingStats.join(', ');
            await bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Отсутствует статистика для: ${missingList}` });
            return;
          }
        }
      } catch (err) {
        console.error('Ошибка проверки статистики в callback:', err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка проверки статистики' });
        return;
      }

      // Проверяем состояние pendingForms (если есть)
      const key = `${userId}_${orderId}`;
      const state = pendingForms.get(key);
      if (state && state.orderId === orderId && !state.allCompleted) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Сначала заполните статистику для всех товаров.' });
        return;
      }

      // Сохраняем исходное сообщение для последующего удаления при подтверждении
      pendingFinishConfirmations.set(orderId, {
        originalChatId: callbackQuery.message.chat.id,
        originalMessageId: callbackQuery.message.message_id
      });

      // Отправляем новое сообщение с подтверждением
      const confirmKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Да, завершить', callback_data: `confirm_finish_${orderId}` },
              { text: '❌ Отмена', callback_data: `cancel_finish_${orderId}` }
            ]
          ]
        }
      };
      await bot.sendMessage(callbackQuery.message.chat.id, `⚠️ Вы действительно хотите завершить заказ ${orderId}?`, confirmKeyboard);
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }

    // Подтверждение завершения заказа сотрудником
    if (data.startsWith('confirm_finish_')) {
      const orderId = data.substring(15);
      const userId = callbackQuery.from.id.toString();
      const employee = await db.getEmployee(userId);
      if (!employee) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Сотрудник не найден.' });
        return;
      }

      // Ответить на callback сразу, чтобы избежать ошибки "query is too old"
      await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Заказ завершается...' });

      try {
        // Очищаем pendingForms и удаляем сообщения перед завершением
        const key = `${userId}_${orderId}`;
        const state = pendingForms.get(key);
        if (state) {
          for (const offerId of Object.keys(state.offers)) {
            try {
              await bot.deleteMessage(userId, state.offers[offerId].messageId);
            } catch (e) { }
            try {
              if (state.offers[offerId].stepMessageId) {
                await bot.deleteMessage(userId, state.offers[offerId].stepMessageId);
              }
            } catch (e) { }
          }
          pendingForms.delete(key);
        }

        // Вызываем завершение заказа
        await finishOrder(callbackQuery.message.chat.id, orderId, employee);

        // Удаляем исходное сообщение (штрихкод), если оно сохранено
        const original = pendingFinishConfirmations.get(orderId);
        if (original) {
          try {
            await bot.deleteMessage(original.originalChatId, original.originalMessageId);
          } catch (err) {
            console.warn('Не удалось удалить исходное сообщение:', err.message);
          }
          pendingFinishConfirmations.delete(orderId);
        }

        // Удаляем сообщение-подтверждение
        try {
          await bot.deleteMessage(callbackQuery.message.chat.id, callbackQuery.message.message_id);
        } catch (err) {
          console.warn('Не удалось удалить сообщение подтверждения:', err.message);
        }

        // Дополнительное уведомление уже не нужно, так как ответили в начале
        //        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Заказ завершён' });
      } catch (err) {
        console.error('Ошибка при завершении заказа из callback:', err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка при завершении заказа' });
      }
      return;
    }

    // Отмена завершения заказа сотрудником
    if (data.startsWith('cancel_finish_')) {
      const orderId = data.substring(14);
      // Удаляем только сообщение-подтверждение, исходное оставляем
      try {
        await bot.deleteMessage(callbackQuery.message.chat.id, callbackQuery.message.message_id);
      } catch (err) {
        console.warn('Не удалось удалить сообщение подтверждения:', err.message);
      }
      // Удаляем запись из Map (если есть)
      pendingFinishConfirmations.delete(orderId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
      return;
    }

    // --- Обработка заполнения материала ---
    if (data.startsWith('mat_')) {
      const parts = data.split('_');
      const orderId = parts[1];
      const offerId = parts[2];
      const material = parts.slice(3).join('_');
      const key = `${userId}_${orderId}`;
      const state = pendingForms.get(key);
      if (state && state.offers[offerId]) {
        state.offers[offerId].material = material;
        state.offers[offerId].status = 'material_selected';
        await askColor(userId, offerId, orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка: состояние не найдено' });
      }
      return;
    }

    // --- Обработка заполнения цвета ---
    if (data.startsWith('color_')) {
      const parts = data.split('_');
      const orderId = parts[1];
      const offerId = parts[2];
      const color = parts.slice(3).join('_');
      const key = `${userId}_${orderId}`;
      const state = pendingForms.get(key);
      if (state && state.offers[offerId]) {
        state.offers[offerId].color = color;
        state.offers[offerId].status = 'color_selected';
        await askWeight(userId, offerId, orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка: состояние не найдено' });
      }
      return;
    }

    // --- Заполнить статистику (параллельный опрос) ---
    if (data.startsWith('fill_stats_')) {
      const parts = data.split('_'); // fill_stats_orderId_offerId
      const orderId = parts[2];
      const offerId = parts[3];
      const key = `${userId}_${orderId}`;
      const state = pendingForms.get(key);
      if (!state) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка: состояние не найдено.' });
        return;
      }
      const offerState = state.offers[offerId];
      if (!offerState) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка: товар не найден.' });
        return;
      }

      // Проверка дублирования
      const existingStats = await db.getProductStats(offerId);
      if (existingStats) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Статистика для этого товара уже существует.' });
        // Удаляем сообщение шага, если есть
        if (offerState.stepMessageId) {
          // Удаляем сообщение с запросом веса (stepMessageId)
          try { await bot.deleteMessage(userId, offerState.stepMessageId); } catch (e) { }
          // Удаляем исходное сообщение с кнопкой "Заполнить статистику"
          try { await bot.deleteMessage(userId, offerState.messageId); } catch (e) { }
          // Удаляем сообщение пользователя с числом
          try { await bot.deleteMessage(userId, msg.message_id); } catch (e) { }
        }

        delete state.offers[offerId];
        const allCompleted = Object.values(state.offers).every(o => o.status === 'completed');
        state.allCompleted = allCompleted;
        if (allCompleted) {
          await sendFinishButton(userId, orderId);
        }
        try {
          await bot.editMessageReplyMarkup(
            { chat_id: userId, message_id: offerState.messageId },
            { reply_markup: { inline_keyboard: [] } }
          );
        } catch (e) { }
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Начинаем или продолжаем опрос
      if (offerState.status === 'not_started') {
        // Деактивируем кнопку у исходного сообщения
        await disableKeyboard(userId, offerState.messageId);
        await askMaterial(userId, offerId, orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (offerState.status === 'material_selected') {
        await askColor(userId, offerId, orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (offerState.status === 'color_selected' || offerState.status === 'weight_entered') {
        await askWeight(userId, offerId, orderId);
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (offerState.status === 'completed') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Статистика уже заполнена.' });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Неизвестный статус.' });
      }
      return;
    }

    // --- Сброс опроса ---
    if (data.startsWith('reset_stats_')) {
      const parts = data.split('_');
      const orderId = parts[2];
      const offerId = parts[3];
      const key = `${userId}_${orderId}`;
      const state = pendingForms.get(key);
      if (!state) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка: состояние не найдено' });
        return;
      }
      const offerState = state.offers[offerId];
      if (!offerState) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Товар не найден' });
        return;
      }

      // Удаляем сообщение шага, если оно есть
      if (offerState.stepMessageId) {
        try { await bot.deleteMessage(userId, offerState.stepMessageId); } catch (e) { }
        offerState.stepMessageId = null;
      }

      offerState.material = null;
      offerState.color = null;
      offerState.weight = null;
      offerState.status = 'not_started';
      offerState.waitingForWeight = false;

      // Сбрасываем к первому шагу (материал)
      await askMaterial(userId, offerId, orderId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Опрос сброшен' });
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
        // Очищаем pendingForms и удаляем сообщения перед завершением
        const key = `${userId}_${orderId}`;
        const state = pendingForms.get(key);
        if (state) {
          for (const offerId of Object.keys(state.offers)) {
            try {
              await bot.deleteMessage(userId, state.offers[offerId].messageId);
            } catch (e) { }
            try {
              if (state.offers[offerId].stepMessageId) {
                await bot.deleteMessage(userId, state.offers[offerId].stepMessageId);
              }
            } catch (e) { }
          }
          pendingForms.delete(key);
        }

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

    // Кнопка "Нет" (отклонение отмены заказа)
    if (data.startsWith('cancel_cancel_')) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отмена отклонена' });
      await safeDeleteMessage(msg.chat.id, msg.message_id);
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
      await safeDeleteMessage(msg.chat.id, msg.message_id);
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
      let employees = await db.getAllEmployeesWithStats(warehouseId ? String(warehouseId) : null);

      // Исключаем GOD_ID, если он задан
      const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
      if (GOD_ID) {
        employees = employees.filter(emp => emp.tg_user_id !== GOD_ID);
      }

      const header = '👑 Приоритетные сотрудники (по складу):';
      if (!employees.length) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Нет доступных сотрудников' });
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
      let employees = await db.getAllEmployeesWithStats();

      // Исключаем GOD_ID, если он задан
      const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
      if (GOD_ID) {
        employees = employees.filter(emp => emp.tg_user_id !== GOD_ID);
      }

      const header = '👥 Все сотрудники:';
      if (!employees.length) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Нет доступных сотрудников' });
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
      const parts = data.split('_');
      const orderId = parts[1];
      const employeeId = parseInt(parts[2]);
      try {
        await assignOrder(orderId, employeeId, msg.chat.id);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Заказ назначен' });
        await safeDeleteMessage(msg.chat.id, msg.message_id);
      } catch (err) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: err.message });
      }
      return;
    }

    // 5. Кнопка "Назад"
    if (data.startsWith('back_')) {
      const orderId = data.substring(5);
      await safeDeleteMessage(msg.chat.id, msg.message_id);
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

      // --- Очистка всех pendingForms и удаление сообщений ---
      for (const [key, state] of pendingForms) {
        const userId = key.split('_')[0];
        for (const offerId of Object.keys(state.offers)) {
          try { await bot.deleteMessage(userId, state.offers[offerId].messageId); } catch (e) { }
          try {
            if (state.offers[offerId].stepMessageId) {
              await bot.deleteMessage(userId, state.offers[offerId].stepMessageId);
            }
          } catch (e) { }
        }
      }
      pendingForms.clear();

      await bot.editMessageText('✅ Все активные назначения сброшены.', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сброс выполнен' });
      return;
    }
    if (data === 'cancel_clear_all') {
      await safeDeleteMessage(msg.chat.id, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сброс отменён' });
      return;
    }

    // 7. Снятие заказа администратором (подтверждение)
    if (data.startsWith('admin_cancel_confirm_')) {
      const orderId = data.substring(21);
      // Находим сотрудника, у которого был этот заказ
      const assignment = await db.db.get('SELECT employee_id FROM assignments WHERE order_id = ? AND status = "assigned"', orderId);
      if (assignment) {
        const employee = await db.getEmployeeById(assignment.employee_id);
        if (employee) {
          // Очищаем pendingForms и удаляем сообщения перед завершением
          const key = `${employee.tg_user_id}_${orderId}`;
          const state = pendingForms.get(key);
          if (state) {
            for (const offerId of Object.keys(state.offers)) {
              try {
                await bot.deleteMessage(userId, state.offers[offerId].messageId);
              } catch (e) { }
              try {
                if (state.offers[offerId].stepMessageId) {
                  await bot.deleteMessage(userId, state.offers[offerId].stepMessageId);
                }
              } catch (e) { }
            }
            pendingForms.delete(key);
          }
        }
      }
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
      await safeDeleteMessage(msg.chat.id, msg.message_id);
      return;
    }

    // 9. Сброс всех данных (кроме моделей) и синхронизация — подтверждение
    if (data === 'confirm_full_reset_sync') {
      try {
        const dbConn = db.db;
        await dbConn.run('BEGIN TRANSACTION');
        await dbConn.run('DELETE FROM assignments');
        await dbConn.run('DELETE FROM employee_warehouses');
        await dbConn.run('DELETE FROM employee_stats');
        await dbConn.run('DELETE FROM employees');
        await dbConn.run('DELETE FROM warehouses');
        await dbConn.run("DELETE FROM sqlite_sequence WHERE name IN ('employees', 'assignments', 'employee_warehouses', 'employee_stats', 'warehouses')");
        await dbConn.run('COMMIT');

        // Очищаем глобальные состояния
        pendingNewOrders.length = 0;
        currentOrderProcessing = null;
        if (typeof deleteLastOrderMessages === 'function') {
          await deleteLastOrderMessages();
        }

        // Очищаем все pendingForms
        for (const [key, state] of pendingForms) {
          const userId = key.split('_')[0];
          for (const offerId of Object.keys(state.offers)) {
            try { await bot.deleteMessage(userId, state.offers[offerId].messageId); } catch (e) { }
            try {
              if (state.offers[offerId].stepMessageId) {
                await bot.deleteMessage(userId, state.offers[offerId].stepMessageId);
              }
            } catch (e) { }
          }
        }
        pendingForms.clear();

        // Синхронизация складов
        const warehouses = await ozon.fetchWarehousesFromOzon();
        if (warehouses.length) await db.syncWarehouses(warehouses);

        // Синхронизация сотрудников
        await syncEmployeesFromExcel(db);

        // Перезагрузка очереди заказов
        await checkAndOfferNewOrders();
        if (pendingNewOrders.length) {
          currentOrderProcessing = null;
          await processNextOrder();
        }

        await bot.editMessageText('✅ Полный сброс и синхронизация выполнены. Очередь заказов обновлена.', {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Выполнено' });
      } catch (err) {
        await dbConn.run('ROLLBACK');
        console.error('[FULL_RESET_SYNC] Ошибка:', err);
        await bot.editMessageText(`❌ Ошибка: ${err.message}`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка' });
      }
      return;
    }

    // Отмена полного сброса статистики
    if (data === 'cancel_full_reset_sync') {
      await safeDeleteMessage(msg.chat.id, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
      return;
    }

    // --- Администратор: выбор материала ---
    if (data.startsWith('admin_mat_')) {
      const parts = data.split('_');
      const offerId = parts[2];
      const material = parts.slice(3).join('_');
      const userId = callbackQuery.from.id.toString();
      const state = pendingStatsFill.get(userId);
      if (!state) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Состояние не найдено' });
        return;
      }
      if (state.offerId !== offerId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Неверный артикул' });
        return;
      }
      state.data.material = material;
      state.step = 2;
      await askAdminColor(userId, offerId);
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }

    // --- Администратор: выбор цвета ---
    if (data.startsWith('admin_color_')) {
      const parts = data.split('_');
      const offerId = parts[2];
      const color = parts.slice(3).join('_');
      const userId = callbackQuery.from.id.toString();
      const state = pendingStatsFill.get(userId);
      if (!state) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Состояние не найдено' });
        return;
      }
      if (state.offerId !== offerId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Неверный артикул' });
        return;
      }
      state.data.color = color;
      state.step = 3;
      await askAdminWeight(userId, offerId);
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }

    // --- Администратор: отмена заполнения (из кнопки) ---
    if (data === 'admin_cancel_stats') {
      const userId = callbackQuery.from.id.toString();
      const state = pendingStatsFill.get(userId);
      if (state) {
        if (state.lastMessageId) {
          try { await bot.deleteMessage(userId, state.lastMessageId); } catch (e) { }
        }
        pendingStatsFill.delete(userId);
        try {
          await bot.editMessageText('❌ Процесс заполнения статистики отменён.', {
            chat_id: msg.chat.id,
            message_id: msg.message_id
          });
        } catch (e) {
          // Сообщение могло быть уже удалено
        }
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Нет активного процесса' });
      }
      return;
    }
  });

  // ---------------------- ОБЩАЯ ФУНКЦИЯ ДЛЯ ЗАВЕРШЕНИЯ ЗАКАЗА ----------------------
  async function finishOrder(chatId, postingNumber, employee) {
    try {
      console.log(`[FINISH] Начинаем завершение заказа ${postingNumber}`);
      const orderAmount = await ozon.getOrderTotalAmount(postingNumber);
      console.log(`[FINISH] Сумма заказа: ${orderAmount}`);
      await db.updateEmployeeStats(employee.id, orderAmount);

      let actId = null;
      let labelBuffer = null;
      let isAlreadyConfirmed = false;

      // 1. Подтверждаем сборку (ship)
      console.log(`[FINISH] Статистика обновлена`);
      try {
        const actResponse = await ozon.confirmPostingShip(postingNumber);
        console.log(`[FINISH] Ответ ship:`, JSON.stringify(actResponse, null, 2));

        // Пытаемся извлечь actId
        actId = actResponse?.result?.id || actResponse?.id;
        if (!actId && actResponse?.additional_data) {
          for (const item of actResponse.additional_data) {
            if (item.posting_number === postingNumber && item.act_id) {
              actId = item.act_id;
              break;
            }
          }
        }
        console.log(`[FINISH] Получен actId: ${actId}`);
      } catch (shipError) {
        // Если заказ уже не в awaiting_packaging, считаем, что он уже подтверждён
        if (shipError.message && shipError.message.includes('не в статусе awaiting_packaging')) {
          console.warn(`[FINISH] Заказ ${postingNumber} уже подтверждён (статус не awaiting_packaging)`);
          isAlreadyConfirmed = true;
        } else {
          throw shipError; // другие ошибки пробрасываем
        }
      }

      // 2. Ждём 15 секунд только если заказ только что подтверждён (не уже подтверждён)
      if (!isAlreadyConfirmed) {
        await new Promise(resolve => setTimeout(resolve, 15000));
      }

      // 3. Получаем этикетку
      if (actId) {
        labelBuffer = await ozon.getPackageLabel(null, actId);
      }
      if (!labelBuffer) {
        labelBuffer = await ozon.getPackageLabel(postingNumber);
      }

      await db.completeOrder(postingNumber);
      console.log(`[FINISH] Заказ ${postingNumber} завершён в БД`);
      await new Promise(resolve => setTimeout(resolve, 500));

      if (labelBuffer) {
        await bot.sendDocument(
          chatId,
          labelBuffer,
          { caption: `✅ Этикетка для заказа ${postingNumber}` },
          { filename: `label_${postingNumber}.pdf`, contentType: 'application/pdf' }
        );
      } else {
        await bot.sendMessage(chatId, `✅ Заказ ${postingNumber} подтверждён. Этикетку можно скачать в личном кабинете Ozon.`);
      }

      // --- Расчёт заработка (без изменений) ---
      try {
        const orderDetails = await ozon.getOrderDetails(postingNumber);
        if (orderDetails && orderDetails.products) {
          const earnings = await calculateOrderEarnings(orderDetails, employee.id);
          if (earnings.allHaveStats && earnings.total > 0) {
            await db.saveEmployeeEarnings(employee.id, postingNumber, earnings.total);
            let msg = `💰 *Заработок за заказ ${postingNumber}*\n\n`;
            for (const item of earnings.details) {
              msg += `• ${item.productName} (${item.offerId})\n`;
              msg += `  Материал: ${item.material}, Вес: ${item.weight} г/шт, Кол-во: ${item.quantity} шт\n`;
              msg += `  Заработок за единицу: ${item.earningsPerUnit.toFixed(2)} руб., Итого: ${item.totalForProduct.toFixed(2)} руб.\n`;
            }
            msg += `\n*Итого: ${earnings.total.toFixed(2)} руб.*`;
            await bot.sendMessage(employee.tg_user_id, msg, { parse_mode: 'Markdown' });
            await new Promise(resolve => setTimeout(resolve, 200));
          } else if (!earnings.allHaveStats) {
            console.warn(`[FINISH] Не все товары имеют статистику для заказа ${postingNumber}`);
          }
        }
      } catch (earnErr) {
        console.error('Ошибка расчёта заработка:', earnErr);
      }

      // Уведомляем модератора
      const moderatorId = process.env.MODERATOR_ID;
      if (moderatorId) {
        await bot.sendMessage(moderatorId, `📦 Сотрудник ${employee.name} завершил заказ ${postingNumber}.`);
      }
    } catch (err) {
      console.error('Ошибка завершения заказа:', err);
      await bot.sendMessage(chatId, `❌ Не удалось подтвердить сборку заказа ${postingNumber}: ${err.message}`);
    }
  }

  // ---------------------- ОБЩАЯ ФУНКЦИЯ ДЛЯ НАЗНАЧЕНИЯ ЗАКАЗА ----------------------
  async function assignOrder(orderId, employeeId, adminChatId) {
    try {
      const employee = await db.getEmployeeById(employeeId);
      if (!employee) throw new Error(`Сотрудник с ID ${employeeId} не найден.`);

      const orderDetails = await ozon.getOrderDetails(orderId);
      if (!orderDetails) throw new Error(`Не удалось получить детали заказа ${orderId}.`);

      // Проверяем, может ли бот писать сотруднику
      try {
        await bot.sendChatAction(employee.tg_user_id, 'typing');
      } catch (err) {
        throw new Error(`Сотрудник ${employee.name} не начал диалог с ботом. Попросите его написать /start.`);
      }

      // Назначаем в БД
      await db.assignOrderToEmployee(orderId, employeeId);

      // --- Проверка наличия статистики для каждого товара ---
      const missingStats = [];
      for (const product of orderDetails.products) {
        const offerId = product.offer_id;
        if (!offerId) continue;
        const stats = await db.getProductStats(offerId);
        if (!stats) missingStats.push(offerId);
      }

      // --- Подготовка сообщения и штрихкода ---
      let detailsText = '';
      let skuList = [];
      if (orderDetails && orderDetails.products) {
        const items = orderDetails.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
        detailsText = `\nСостав:\n${items}`;
        skuList = orderDetails.products.map(p => p.sku).filter(Boolean);
      }

      // Кнопка завершения только если все данные есть
      let finishKeyboard = null;
      if (missingStats.length === 0) {
        finishKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Завершить заказ', callback_data: `finish_order_${orderId}` }]
            ]
          }
        };
      }

      let caption = `✅ Вам назначен заказ №: ${orderId}${detailsText}\n\nКогда упакуете, нажмите кнопку ниже или выполните команду:\n/finish_order ${orderId}`;

      try {
        const barcodeBuffer = await bwipjs.toBuffer({
          bcid: 'code128',
          text: orderId,
          scale: 3,
          height: 10,
          includetext: true,
          textxalign: 'center'
        });
        if (finishKeyboard) {
          await bot.sendPhoto(employee.tg_user_id, barcodeBuffer, {
            caption,
            ...finishKeyboard
          });
        } else {
          await bot.sendPhoto(employee.tg_user_id, barcodeBuffer, {
            caption: caption + '\n\n⚠️ Для этого заказа требуется заполнить данные по материалам. Следуйте инструкциям.'
          });
        }
      } catch (barcodeError) {
        console.error('Ошибка генерации штрихкода:', barcodeError);
        if (finishKeyboard) {
          await bot.sendMessage(employee.tg_user_id, caption, finishKeyboard);
        } else {
          await bot.sendMessage(employee.tg_user_id, caption + '\n\n⚠️ Для этого заказа требуется заполнить данные по материалам. Следуйте инструкциям.');
        }
      }

      // --- Отправка фото товаров ---
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
          console.error(`Ошибка отправки фото для заказа ${orderId}:`, photoError.message);
        }
      }

      // --- Отправка 3D-моделей и уведомления ---
      const validExtensions = ['.stl', '.3mf', '.step', '.obj', '.zip'];
      const moderatorId = process.env.MODERATOR_ID;

      for (const product of orderDetails.products) {
        try {
          const originalOfferId = product.offer_id;
          if (!originalOfferId) continue;

          const offersToCheck = [originalOfferId];
          const parentOfferId = db.getParentOfferId(originalOfferId);
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
                await bot.sendDocument(moderatorId, txt.file_id, {
                  caption: `📄 Текстовый файл для товара ${product.name} (${originalOfferId}) из offer_id ${txt.offer_id}: ${txt.file_name}\nОтправьте его сотруднику ${employee.name} вручную.`
                });
                await new Promise(resolve => setTimeout(resolve, 300));
              }
              await bot.sendMessage(employee.tg_user_id, `ℹ️ Для товара ${product.name} (${originalOfferId}) нет 3D-моделей, но есть инструкция (файл .txt). Обратитесь к модератору.`);
            } else {
              await bot.sendMessage(moderatorId, `⚠️ Для товара ${product.name} (${originalOfferId}) отсутствуют 3D-модели.\nОтправьте их сотруднику ${employee.name} вручную.`);
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
            await bot.sendMessage(moderatorId, `⚠️ Для товара ${product.name} (${originalOfferId}) не загружены модели: ${fileList}.\nОтправьте их сотруднику ${employee.name} вручную.`);
          }
        } catch (err) {
          console.error(`Ошибка обработки товара ${product.name}:`, err);
        }
      }

      // --- Если есть недостающие статистики, создаём параллельные опросы ---
      if (missingStats.length > 0) {
        // Инициализируем состояние для этого заказа
        const offersState = {};
        for (const offerId of missingStats) {
          offersState[offerId] = {
            material: null,
            color: null,
            weight: null,
            status: 'not_started',
            messageId: null,
            waitingForWeight: false
          };
        }
        const key = `${employee.tg_user_id}_${orderId}`;
        pendingForms.set(key, {
          orderId: orderId,
          offers: offersState,
          allCompleted: false
        });

        // Отправляем отдельное сообщение для каждого offer_id
        for (const offerId of missingStats) {
          // Найдём название товара
          const product = orderDetails.products.find(p => p.offer_id === offerId);
          const productName = product ? product.name : offerId;
          const caption = `🛍️ Товар: ${productName}\nАртикул: ${offerId}\nДля этого товара ещё нет данных по материалу, цвету и весу.\nНажмите кнопку ниже, чтобы заполнить статистику.`;
          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [{ text: `📝 Заполнить статистику для ${offerId}`, callback_data: `fill_stats_${orderId}_${offerId}` }]
              ]
            }
          };
          const sentMsg = await bot.sendMessage(employee.tg_user_id, caption, keyboard);
          // Сохраняем messageId для последующего редактирования/удаления
          offersState[offerId].messageId = sentMsg.message_id;
        }
      }

      // --- Удаляем заказ из очереди ---
      const idx = pendingNewOrders.findIndex(o => o.posting_number === orderId);
      if (idx !== -1) pendingNewOrders.splice(idx, 1);
      if (currentOrderProcessing && currentOrderProcessing.order.posting_number === orderId) {
        currentOrderProcessing = null;
      }

      // --- Отправляем уведомление администратору (если передан chatId) ---
      if (adminChatId) {
        await bot.sendMessage(adminChatId, `✅ Заказ ${orderId} назначен сотруднику ${employee.name} (ID сотрудника: ${employee.id}).`);
      }

      // Запускаем следующий заказ, если есть
      if (typeof processNextOrder === 'function') {
        await processNextOrder();
      }

      return { success: true, employee };
    } catch (err) {
      console.error('[ASSIGN] Ошибка:', err);
      if (adminChatId) {
        await bot.sendMessage(adminChatId, `❌ Ошибка назначения: ${err.message}`);
      }
      throw err;
    }
  }

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
        adminMessage += `Вы зарегистрированы как ${employee.name}\nАктивных Заказов: ${activeCount}\n3D-принтеров: ${employee.capacity}\n\n`;
      }
      adminMessage += `🔧 Доступные административные команды:\n`;
      adminMessage += `/status_all — статус всех сотрудников\n`;
      adminMessage += `/active_orders — активные заказы\n`;
      adminMessage += `/warehouses — список складов Ozon\n`;
      adminMessage += `/orders [warehouse_id] — показать очередь заказов из API (с фильтром по складу)\n`;
      adminMessage += `/order_details <номер_заказа> — показать детали заказа\n`;
      adminMessage += `/employee_warehouses <id_сотрудника> — показать склады сотрудника\n`;
      adminMessage += `/employee_stats <id_сотрудника> — статистика сотрудника (заказы, сумма)\n`;
      adminMessage += `/employee_orders <id_сотрудника> — показать активные заказы сотрудника\n\n`;

      adminMessage += `/admin_fill_stats <offer_id> — заполнить/обновить статистику товара (материал, цвет, вес)\n`;
      adminMessage += `/cancel_fill_stats — отменить активный процесс заполнения статистики\n`;
      adminMessage += `/clear_product_stats <offer_id> — удалить статистику для продукта\n\n`;

      adminMessage += `/export_earnings [YYYY-MM] — экспорт заработка всех сотрудников за месяц (по умолчанию текущий)\n\n`;

      adminMessage += `/send_label <номер_заказа> [id_сотрудника] — отправить PDF‑этикетку заказа сотруднику (если ID не указан – себе)\n\n`;

      adminMessage += `/admin_assign_order <номер_заказа> [id_сотрудника] — назначить заказ сотруднику (если ID не указан – показать список сотрудников)\n\n`;

      adminMessage += `/admin_cancel_order <номер_заказа> — снять заказ с сотрудника\n\n`;

      adminMessage += `/clear_assignments — сброс ВСЕХ назначений на заказы\n\n`;

      adminMessage += `📁 3D-модели:

/send_models <offer_id> [id_сотрудника] — отправить все модели для offer_id сотруднику (если ID не указан – себе)
/list_models <offer_id> — список моделей для offer_id
/remove_model <offer_id> <имя_файла> — удалить модель

📤 Загрузка моделей до 50 МБ (через бота):
/upload_model — загрузить модель, offer_id извлекается из имени файла (например, "2001867564-N_bmw.stl")
/add_model <offer_id> — загрузить модель для указанного offer_id (сначала команда, потом файл)
/cancel_model — отменить ожидание загрузки модели

📌 Для больших файлов (>50 МБ):
1. Залейте файл в канал моделей вручную (Telegram Desktop позволяет до 2 ГБ).
2. Перешлите сообщение боту с caption:
   offer_id: НАШ_OFFER_ID
   Файл: ИМЯ_ФАЙЛА.расширение
3. Бот автоматически привяжет модель.
Альтернативно, можно вручную привязать:
/bind_model <offer_id> <file_id> [имя_файла] — привязать существующий файл (любого размера) к offer_id
/get_file_id — получить file_id пересланного файла (для последующей привязки)
/cancel_bind — отменить ожидание file_id
\n\n`;

      adminMessage += `/reload_queue — Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов\n\n`;

      adminMessage += `/pause — приостановить авто-проверку очереди заказов\n`;
      adminMessage += `/resume — возобновить авто-проверку очереди заказов\n\n`;

      adminMessage += `/download_materials — скачать файл цен материала за грамм "materials.json"\n`;
      adminMessage += `/download_team_info — скачать файл сотрудников "team-info.xlsx"\n`;
      adminMessage += `/download_product_stats — скачать файл статистики продуктов "product-stats.xlsx" (с принудительной выгрузкой статистики из bot.db)\n`;
      adminMessage += `/download_db — скачать файл базы данных "bot.db"\n\n`;

      adminMessage += `/backup_db — создать бэкап базы данных "bot.db"\n\n`;

      adminMessage += `/upload_employees — загрузить новый файл "team-info.xlsx" с сотрудниками (автоматически синхронизирует БД)\n`;
      adminMessage += `/upload_materials — загрузить новый файл "materials.json" с ценами материалов\n\n`;

      adminMessage += `/full_reset_and_sync — сброс всех данных (сотрудники, склады, назначения, статистика), кроме 3D-моделей и синхронизация складов/сотрудников\n\n`;

      if (debugMode.isDebugMode()) adminMessage += `/debug_clear — сбросить отладочные назначения\n`;

      await bot.sendMessage(chatId, adminMessage);
      return;
    }

    // --- Обычный сотрудник (есть в БД) ---
    if (employee) {
      const activeCount = await db.getEmployeeActiveOrdersCount(employee.id);
      let msgText = `С возвращением, ${employee.name}!\n Новые заказы назначает Модератор.\n У вас активно заказов: ${activeCount}. \n\n`;
      msgText += `Доступные команды:\n`;
      msgText += `/my_orders — показать мои активные заказы\n`;
      msgText += `/my_earnings [YYYY-MM] — показать мой заработок за месяц (по умолчанию текущий)\n`;
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
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
    const employees = await db.getAllEmployeesWithStats();
    if (!employees.length) return bot.sendMessage(msg.chat.id, 'Нет сотрудников.');

    const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
    const moderatorId = process.env.MODERATOR_ID ? process.env.MODERATOR_ID.toString() : null;

    // Приоритет роли (меньше = выше)
    const getRolePriority = (tgUserId) => {
      if (GOD_ID && tgUserId === GOD_ID) return 0;
      if (moderatorId && tgUserId === moderatorId) return 1;
      if (isAdmin(tgUserId)) return 2;
      return 3;
    };

    // Сортировка: по приоритету роли, затем по имени
    employees.sort((a, b) => {
      const priorityA = getRolePriority(a.tg_user_id);
      const priorityB = getRolePriority(b.tg_user_id);
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.name.localeCompare(b.name);
    });

    let reply = '🪪 *Статус сотрудников:*\n\n';
    for (const emp of employees) {
      let roleEmoji = '👷';
      let roleText = 'Сотрудник';

      if (GOD_ID && emp.tg_user_id === GOD_ID) {
        roleEmoji = '👻';
        roleText = 'Создатель';
      } else if (moderatorId && emp.tg_user_id === moderatorId) {
        roleEmoji = '🕵️';
        roleText = 'Модератор';
      } else if (isAdmin(emp.tg_user_id)) {
        roleEmoji = '🧑‍💻';
        roleText = 'Администратор';
      }

      reply += `${roleEmoji} ${emp.name} — *${roleText}*\n`;
      reply += `🆔 *ID сотрудника:* \`${emp.id}\`\n`;
      reply += `📦 Активных заказов: ${emp.active_count}\n`;
      reply += `🖨️ 3D-принтеров: ${emp.capacity}\n\n`;
    }
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
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


  // --- "/upload_employees" Команда для администратора: загрузить новый файл team-info.xlsx с сотрудниками (автоматически синхронизирует БД) ---
  bot.onText(/\/upload_employees/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    pendingEmployeeUpload.set(userId, { step: 'waiting_file' });
    await bot.sendMessage(msg.chat.id, '📤 Отправьте файл team-info.xlsx с сотрудниками.');
  });

  // --- "/upload_materials" Команда для администратора: загрузить новый файл materials.json с ценами материалов ---
  bot.onText(/\/upload_materials/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    pendingMaterialsUpload.set(userId, { step: 'waiting_file' });
    await bot.sendMessage(msg.chat.id, '📤 Отправьте файл materials.json с настройками материалов.');
  });

  // --- "/admin_assign_order" Команда для администратора: назначить заказ сотруднику вручную ---
  bot.onText(/\/admin_assign_order (\S+)(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    const postingNumber = match[1];
    const employeeId = match[2] ? parseInt(match[2]) : null;

    // Проверяем, существует ли заказ в статусе awaiting_packaging
    const order = await ozon.fetchAwaitingOrdersById(postingNumber);
    if (!order) {
      return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не найден в статусе "awaiting_packaging".`);
    }

    if (employeeId) {
      // Назначаем сразу
      try {
        await assignOrder(postingNumber, employeeId, msg.chat.id);
      } catch (err) {
        // Ошибка уже обработана внутри assignOrder
      }
    } else {
      // Показываем список всех сотрудников для выбора
      const employees = await db.getAllEmployeesWithStats();
      if (!employees.length) {
        return bot.sendMessage(msg.chat.id, '❌ Сотрудники не найдены.');
      }
      const kb = employees.map(emp => ([{
        text: `${emp.name} (активных: ${emp.active_count}, принтеры: ${emp.capacity})`,
        callback_data: `assign_${postingNumber}_${emp.id}`
      }]));
      await bot.sendMessage(msg.chat.id, `👥 Выберите сотрудника для заказа ${postingNumber}:`, {
        reply_markup: { inline_keyboard: kb }
      });
    }
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

  // --- "/send_label" — отправить этикетку заказа сотруднику (или себе) ---
  bot.onText(/\/send_label (\S+)(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    const postingNumber = match[1];
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

    // Проверяем, может ли бот писать в целевой чат
    try {
      await bot.sendChatAction(targetChatId, 'typing');
    } catch (err) {
      return bot.sendMessage(msg.chat.id, `❌ Не удалось отправить сообщение ${targetName}. Возможно, он не начал диалог с ботом.`);
    }

    try {
      const labelBuffer = await ozon.getPackageLabel(postingNumber);
      if (labelBuffer) {
        if (labelBuffer) {
          await bot.sendDocument(
            targetChatId,
            labelBuffer,
            {
              caption: `✅ Этикетка для заказа ${postingNumber}`
            },
            {
              filename: `label_${postingNumber}.pdf`,
              contentType: 'application/pdf'
            }
          );
        }
        await bot.sendMessage(msg.chat.id, `✅ Этикетка для заказа ${postingNumber} отправлена ${targetName}.`);
      } else {
        await bot.sendMessage(msg.chat.id, `❌ Не удалось получить этикетку для заказа ${postingNumber}.`);
      }
    } catch (err) {
      console.error('Ошибка отправки этикетки:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
    }
  });

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
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
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
    if (pendingModelAdd && pendingModelAdd.has(userId)) {
      pendingModelAdd.delete(userId);
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
    if (!pendingModelAdd) pendingModelAdd = new Map();
    pendingModelAdd.set(userId, { offerId, step: 'waiting_file' });
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
    if (!pendingFileId) pendingFileId = new Map();
    pendingFileId.set(userId, { step: 'waiting_file' });
  });

  // --- "/cancel_bind" Команда для администратора: отменить привязку файла ---
  bot.onText(/\/cancel_bind/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (pendingFileId && pendingFileId.has(userId)) {
      pendingFileId.delete(userId);
      bot.sendMessage(msg.chat.id, 'Операция получения file_id отменена.');
    } else {
      bot.sendMessage(msg.chat.id, 'Нет активной операции.');
    }
  });

  // ---------------------- ЕДИНЫЙ ОБРАБОТЧИК ДОКУМЕНТОВ ----------------------
  bot.on('document', async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может загружать файлы.');
    }

    const file = msg.document;
    const fileName = file.file_name;

    // Приоритет 0: /upload_employees (загрузка team-info.xlsx)
    if (pendingEmployeeUpload && pendingEmployeeUpload.has(userId)) {
      const pending = pendingEmployeeUpload.get(userId);
      if (pending.step !== 'waiting_file') return;
      if (fileName !== 'team-info.xlsx') {
        await bot.sendMessage(msg.chat.id, '❌ Пожалуйста, отправьте файл с именем team-info.xlsx');
        pendingEmployeeUpload.delete(userId);
        return;
      }
      try {
        // Скачиваем файл
        const fileLink = await bot.getFileLink(file.file_id);
        const tempPath = path.join(__dirname, 'temp_team_info.xlsx');
        const writer = fs.createWriteStream(tempPath);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        // Заменяем основной файл
        const targetPath = path.join(__dirname, 'team-info.xlsx');
        fs.renameSync(tempPath, targetPath);
        // Синхронизация
        await syncEmployeesFromExcel(db);
        await bot.sendMessage(msg.chat.id, '✅ Сотрудники успешно обновлены из загруженного файла.');
      } catch (err) {
        console.error('[UPLOAD_EMPLOYEES] Ошибка:', err);
        await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
      }
      pendingEmployeeUpload.delete(userId);
      return;
    }

    // Приоритет 0.5: загрузка материалов (команда /upload_materials)
    if (pendingMaterialsUpload && pendingMaterialsUpload.has(userId)) {
      const pending = pendingMaterialsUpload.get(userId);
      if (pending.step !== 'waiting_file') return;
      if (fileName !== 'materials.json') {
        await bot.sendMessage(msg.chat.id, '❌ Пожалуйста, отправьте файл с именем materials.json.');
        pendingMaterialsUpload.delete(userId);
        return;
      }
      try {
        const fileLink = await bot.getFileLink(file.file_id);
        const tempPath = path.join(__dirname, 'temp_materials.json');
        const writer = fs.createWriteStream(tempPath);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        // Заменяем основной файл
        const targetPath = path.join(__dirname, 'materials.json');
        fs.renameSync(tempPath, targetPath);
        loadMaterials(); // перезагружаем в память
        await bot.sendMessage(msg.chat.id, '✅ Справочник материалов обновлён.');
      } catch (err) {
        console.error('[UPLOAD_MATERIALS] Ошибка:', err);
        await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
      }
      pendingMaterialsUpload.delete(userId);
      return;
    }

    // Приоритет 1: /upload_model
    if (pendingUploadModel && pendingUploadModel.has(userId)) {
      const pending = pendingUploadModel.get(userId);
      if (pending.step !== 'waiting_file') return;

      const file = msg.document;
      const fileName = file.file_name;
      console.log(`[UPLOAD_MODEL] Имя файла: "${fileName}"`);

      // --- Простой сплит по первому символу '_' ---
      const underscoreIndex = fileName.indexOf('_');
      if (underscoreIndex === -1) {
        await bot.sendMessage(msg.chat.id, '❌ Имя файла должно содержать символ "_" после offer_id (например, "2001867564-N_avs.stl").');
        pendingUploadModel.delete(userId);
        return;
      }

      let offerId = fileName.substring(0, underscoreIndex);
      const rest = fileName.substring(underscoreIndex + 1);

      // --- Восстановление суффикса, если он был заменён ---
      // Если offerId не содержит дефис, но в начале rest есть N, NR или NL и затем '_' или '.' 
      // (т.е. был суффикс, но его заменили на подчёркивание)
      const suffixMatch = rest.match(/^([A-Z]+)(?:-|_|\.)/);
      if (!offerId.includes('-') && suffixMatch) {
        const possibleSuffix = suffixMatch[1];
        if (possibleSuffix === 'N' || possibleSuffix === 'NR' || possibleSuffix === 'NL') {
          const newOfferId = offerId + '-' + possibleSuffix;
          console.log(`[UPLOAD_MODEL] Обнаружен суффикс, восстанавливаем: "${newOfferId}"`);
          offerId = newOfferId;
        }
      }

      // --- Проверка на допустимые символы ---
      if (!/^[A-Z0-9-]+$/.test(offerId)) {
        await bot.sendMessage(msg.chat.id, '❌ Артикул может содержать только буквы, цифры и дефис. Проверьте имя файла.');
        pendingUploadModel.delete(userId);
        return;
      }

      console.log(`[UPLOAD_MODEL] Итоговый offerId: "${offerId}"`);

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
    if (pendingModelAdd && pendingModelAdd.has(userId)) {
      const pending = pendingModelAdd.get(userId);
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
      pendingModelAdd.delete(userId);
      return;
    }

    // Приоритет 3: /get_file_id
    if (pendingFileId && pendingFileId.has(userId)) {
      const pending = pendingFileId.get(userId);
      if (pending.step === 'waiting_file') {
        const file = msg.document;
        const fileId = file.file_id;
        const fileName = file.file_name;
        const fileSize = file.file_size;
        await bot.sendMessage(msg.chat.id,
          `✅ file_id: \`${fileId}\`\nИмя: ${fileName}\nРазмер: ${(fileSize / 1024 / 1024).toFixed(2)} МБ\n\nИспользуйте /bind_model <offer_id> ${fileId} "${fileName}"`);
        pendingFileId.delete(userId);
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

    try {
      // 1. Удаляем старое сообщение и фото
      if (typeof deleteLastOrderMessages === 'function') {
        await deleteLastOrderMessages();
      }
      // 2. Сбрасываем состояние (очищаем массив, не пересоздавая)
      pendingNewOrders.length = 0;
      currentOrderProcessing = null;

      // Очистка pendingForms для заказов, которых нет в актуальной очереди
      const activeOrderIds = new Set(pendingNewOrders.map(o => o.posting_number));
      for (const [key, state] of pendingForms) {
        const userId = key.split('_')[0];
        for (const offerId of Object.keys(state.offers)) {
          try { await bot.deleteMessage(userId, state.offers[offerId].messageId); } catch (e) { }
          try {
            if (state.offers[offerId].stepMessageId) {
              await bot.deleteMessage(userId, state.offers[offerId].stepMessageId);
            }
          } catch (e) { }
        }
      }
      pendingForms.clear();

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
    } catch (err) {
      console.error('[RELOAD_QUEUE] Ошибка:', err);
      bot.sendMessage(msg.chat.id, `❌ Ошибка при перезагрузке: ${err.message}`);
    }
  });

  // --- "/orders" Команда для администратора: просмотр списка заказов из API (с фильтром по складу) ---
  bot.onText(/\/orders(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const warehouseId = match[1] || null;
    try {
      const orders = await ozon.fetchAwaitingOrders(warehouseId);

      if (!orders || orders.length === 0) {
        return bot.sendMessage(msg.chat.id,
          warehouseId
            ? `📭 Нет заказов в статусе "awaiting_packaging" для склада ${warehouseId}.`
            : '📭 Нет заказов в статусе "awaiting_packaging".'
        );
      }

      let warehouseName = null;
      if (warehouseId) {
        warehouseName = await db.getWarehouseNameById(warehouseId);
      }

      let reply = '📋 Список заказов (awaiting_packaging)';
      if (warehouseName && warehouseName !== warehouseId) {
        reply += ` для склада «${warehouseName}»`;
      } else if (warehouseId) {
        reply += ` для склада ID: ${warehouseId}`;
      }
      reply += `\nВсего: ${orders.length} заказ(ов)\n`;
      reply += '──────────────────\n\n';

      for (const order of orders) {
        const orderNumber = order.posting_number;
        const productsCount = order.products ? order.products.length : (order.products_count || '?');

        let whId = order.warehouse_id || order.delivery_method?.warehouse_id || null;
        let whDisplay = 'не указан';

        if (whId) {
          whId = String(whId); // ПРИВОДИМ К СТРОКЕ
          const whName = await db.getWarehouseNameById(whId);
          if (whName === whId) {
            console.warn(`[ORDERS] Склад с ID ${whId} не найден в БД, проверьте синхронизацию складов.`);
            whDisplay = `ID: ${whId}`;
          } else {
            whDisplay = `${whName} (ID: ${whId})`;
          }
        }

        reply += `• Заказ ${orderNumber}\n`;
        reply += `  Товаров: ${productsCount}\n`;
        reply += `  Склад: ${whDisplay}\n\n`;
      }

      reply += '──────────────────\n';
      reply += '📌 Для просмотра деталей заказа используйте:\n';
      reply += '/order_details <posting_number>';

      await bot.sendMessage(msg.chat.id, reply);
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

    // --- Пасхалка для создателя ---
    const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
    let stats;
    let isGod = false;

    if (GOD_ID && emp.tg_user_id === GOD_ID) {
      isGod = true;
      // Фейковые данные
      stats = {
        total_orders: 1337,
        canceled_orders: 666,
        total_amount: 999999999
      };
    } else {
      stats = await db.getEmployeeStats(employeeId);
    }

    const reply = `📊 *Статистика сотрудника ${emp.name}*\n\n` +
      `✅ Завершённых заказов: ${stats.total_orders}\n` +
      `❌ Отменённых заказов: ${stats.canceled_orders || 0}\n` +
      `💰 Общая сумма: ${stats.total_amount.toFixed(2)} ₽` +
      (isGod ? '\n\n👻 *Создатель!*' : '');

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
  });

  // --- "/export_earnings" Команда для администратора: экспорт заработка сотрудников за месяц ---
  bot.onText(/\/export_earnings(?: (.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    let monthStr = match[1] || null;
    let fromDate, toDate;
    if (monthStr) {
      if (!/^\d{4}-\d{2}$/.test(monthStr)) {
        return bot.sendMessage(msg.chat.id, '❌ Неверный формат. Используйте YYYY-MM');
      }
      const [year, month] = monthStr.split('-').map(Number);
      fromDate = new Date(year, month - 1, 1).getTime();
      toDate = new Date(year, month, 1).getTime() - 1;
    } else {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      fromDate = new Date(year, month, 1).getTime();
      toDate = new Date(year, month + 1, 1).getTime() - 1;
    }

    const earningsData = await db.getAllEmployeeEarningsForPeriod(fromDate, toDate);
    if (!earningsData.length) {
      return bot.sendMessage(msg.chat.id, '📭 Нет данных о заработке за указанный период.');
    }

    // Группируем по сотруднику
    const employeeMap = new Map();
    for (const row of earningsData) {
      const empId = row.id;
      if (!employeeMap.has(empId)) {
        employeeMap.set(empId, {
          name: row.name,
          totalAmount: 0,
          orderCount: 0,
        });
      }
      const emp = employeeMap.get(empId);
      emp.totalAmount += row.amount;
      emp.orderCount += 1;
    }

    // Формируем массив для Excel
    const rows = [];
    for (const [empId, emp] of employeeMap) {
      rows.push({
        'ID сотрудника': empId,
        'Сотрудник': emp.name,
        'Количество заказов': emp.orderCount,
        'Сумма заработка (руб)': emp.totalAmount.toFixed(2),
        'Средний чек (руб)': (emp.totalAmount / emp.orderCount).toFixed(2),
      });
    }

    // Сортируем по сумме
    rows.sort((a, b) => b['Сумма заработка (руб)'] - a['Сумма заработка (руб)']);

    // Создаём Excel
    try {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'Заработок');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      console.log(`[EXPORT_EARNINGS] Размер буфера: ${buffer.length} байт`);

      // Сохраняем файл на диск
      const fileName = `earnings_${monthStr || (new Date(fromDate).toISOString().slice(0, 7))}.xlsx`;
      const outputPath = path.join(__dirname, 'exports', fileName);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buffer);
      console.log(`[EXPORT_EARNINGS] Файл сохранён: ${outputPath}`);

      // Отправляем файл
      const monthLabel = monthStr || `${new Date(fromDate).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}`;
      await bot.sendDocument(msg.chat.id, outputPath, {
        caption: `🤑 Отчёт по заработку за ${monthLabel}`
      });

      // Удаляем временный файл после отправки
      try {
        fs.unlinkSync(outputPath);
        console.log(`[EXPORT_EARNINGS] Временный файл удалён: ${outputPath}`);
      } catch (unlinkErr) {
        console.warn(`[EXPORT_EARNINGS] Не удалось удалить файл: ${unlinkErr.message}`);
      }
    } catch (err) {
      console.error('[EXPORT_EARNINGS] Ошибка создания Excel:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка создания Excel: ${err.message}`);
    }
  });

  // --- "/admin_fill_stats" Команда для администратора: заполнить/обновить статистику товара (3 шага) ---
  bot.onText(/\/admin_fill_stats (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const offerId = match[1].trim();
    if (pendingStatsFill.has(userId)) {
      return bot.sendMessage(msg.chat.id, `⚠️ У вас уже активен процесс заполнения.\nЗавершите его или отмените командой /cancel_fill_stats.`);
    }

    // Сохраняем состояние
    pendingStatsFill.set(userId, {
      offerId,
      step: 1,
      data: {},
      lastMessageId: null
    });

    // Переходим к выбору материала
    await askAdminMaterial(userId, offerId);
  });

  // --- "/cancel_fill_stats" Команда для администратора: отменить активный процесс заполнения статистики ---
  bot.onText(/\/cancel_fill_stats/, async (msg) => {
    const userId = msg.from.id.toString();
    if (pendingStatsFill.has(userId)) {
      pendingStatsFill.delete(userId);
      await bot.sendMessage(msg.chat.id, '❌ Процесс заполнения статистики отменён.');
    } else {
      await bot.sendMessage(msg.chat.id, 'ℹ️ Нет активного процесса заполнения.');
    }
  });

  // --- "/clear_product_stats" Команда для администратора: очистка статистики заказа ---
  bot.onText(/\/clear_product_stats (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    const offerId = match[1];
    try {
      await db.db.run('DELETE FROM product_stats WHERE offer_id = ?', offerId);
      bot.sendMessage(msg.chat.id, `✅ Запись для ${offerId} удалена.`);
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
    }
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

  // --- "/download_materials" Команда для администратора: скачать файл materials.json ---
  bot.onText(/\/download_materials/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    const filePath = path.join(__dirname, 'materials.json');
    if (!fs.existsSync(filePath)) return bot.sendMessage(msg.chat.id, '❌ Файл materials.json не найден.');
    await bot.sendDocument(msg.chat.id, filePath, { caption: '🧾 Актуальный файл цен материалов за грамм.' });
  });

  // --- "/download_team_info" Команда для администратора: скачать файл team-info.xlsx ---
  bot.onText(/\/download_team_info/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    const filePath = path.join(__dirname, 'team-info.xlsx');
    if (!fs.existsSync(filePath)) return bot.sendMessage(msg.chat.id, '❌ Файл team-info.xlsx не найден.');
    await bot.sendDocument(msg.chat.id, filePath, { caption: '📄 Актуальный файл сотрудников.' });
  });

  // --- "/download_product_stats" Команда для администратора: скачать файл product-stats.xlsx (с принудительной выгрузкой статистики из bot.db) ---
  bot.onText(/\/download_product_stats/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    try {
      await exportProductStats(); // пересоздаёт файл
      const filePath = path.join(__dirname, 'exports', 'product-stats.xlsx');
      if (!fs.existsSync(filePath)) {
        return bot.sendMessage(msg.chat.id, '❌ Файл статистики не создан.');
      }
      await bot.sendDocument(msg.chat.id, filePath, {
        caption: '📊 Актуальная полная выгрузка статистики по артикулам.',
        filename: `product-stats_${Date.now()}.xlsx`
      });
    } catch (err) {
      console.error('[EXPORT_PRODUCT_STATS] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
    }
  });

  // --- "/download_db" Команда для администратора: скачать файл bot.db ---
  bot.onText(/\/download_db/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    const filePath = path.join(__dirname, 'bot.db');
    if (!fs.existsSync(filePath)) return bot.sendMessage(msg.chat.id, '❌ Файл базы данных bot.db не найден.');
    await bot.sendDocument(msg.chat.id, filePath, { caption: '🗃️ Актуальный файл базы данных.' });
  });

  // --- "/backup_db" Команда для администратора: создание бэкапа базы данных ---
  bot.onText(/\/backup_db/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, 'backups');

    // Создаём папку, если её нет
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const dbPath = path.join(__dirname, 'bot.db');
    if (!fs.existsSync(dbPath)) {
      return bot.sendMessage(msg.chat.id, '❌ Файл базы данных не найден.');
    }

    const now = new Date();
    const timestamp = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') + '-' +
      String(now.getMinutes()).padStart(2, '0') + '-' +
      String(now.getSeconds()).padStart(2, '0');

    const backupPath = path.join(backupDir, `bot_${timestamp}.db`);

    try {
      fs.copyFileSync(dbPath, backupPath);
      await bot.sendMessage(msg.chat.id, `✅ Бэкап создан: \`${backupPath}\``, { parse_mode: 'Markdown' });
      console.log(`[BACKUP] Создан бэкап: ${backupPath}`);
    } catch (err) {
      console.error('Ошибка создания бэкапа:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка создания бэкапа: ${err.message}`);
    }
  });

  // --- "/full_reset_and_sync" Команда для администратора: сброс всех данных, кроме 3D-моделей (с синхронизацией) ---
  bot.onText(/\/full_reset_and_sync/, async (msg) => {
    console.log('[RESET] Команда получена');
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚠️ ДА, сбросить и синхронизировать', callback_data: 'confirm_full_reset_sync' },
            { text: '❌ Отмена', callback_data: 'cancel_full_reset_sync' }
          ]
        ]
      }
    };

    try {
      await bot.sendMessage(msg.chat.id,
        '⚠️ Вы уверены?\n\nБудут удалены все сотрудники, склады, назначения и статистика.\nЗатем будет выполнена синхронизация складов и сотрудников из файла и Ozon.\nБаза 3D-моделей останется нетронутой.\n\n⚠️ Действие необратимо!',
        keyboard
      );
      console.log('[RESET] Клавиатура отправлена');
    } catch (err) {
      console.error('[RESET] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
    }
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

  // --- "/my_orders" – список активных заказов с навигацией ---
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
    const keyboard = [];
    for (const o of orders) {
      const orderId = o.order_id;
      // Ищем состояние в pendingForms
      let state = null;
      for (const [key, st] of pendingForms) {
        if (key === `${userId}_${orderId}`) {
          state = st;
          break;
        }
      }

      let statusText = '';
      let button = null;

      if (state) {
        // Есть состояние для этого заказа
        const allCompleted = state.allCompleted;
        if (allCompleted) {
          statusText = '✅ Статистика заполнена';
          button = { text: `✅ Завершить заказ ${orderId}`, callback_data: `finish_order_${orderId}` };
        } else {
          // Есть незавершённые
          statusText = '⏳ Ожидает заполнения статистики';
          const firstIncomplete = Object.values(state.offers).find(o => o.status !== 'completed');
          if (firstIncomplete) {
            const offerId = Object.keys(state.offers).find(key => state.offers[key] === firstIncomplete);
            button = { text: `📝 Заполнить статистику ${orderId} (${offerId})`, callback_data: `fill_stats_${orderId}_${offerId}` };
          } else {
            // Баг – исправляем
            state.allCompleted = true;
            statusText = '✅ Статистика заполнена';
            button = { text: `✅ Завершить заказ ${orderId}`, callback_data: `finish_order_${orderId}` };
          }
        }
      } else {
        // Нет состояния – проверяем статистику в БД
        const orderDetails = await ozon.getOrderDetails(orderId);
        if (orderDetails && orderDetails.products) {
          let allHaveStats = true;
          const missingStats = [];
          for (const product of orderDetails.products) {
            const offerId = product.offer_id;
            if (!offerId) continue;
            const stats = await db.getProductStats(offerId);
            if (!stats) {
              allHaveStats = false;
              missingStats.push(offerId);
            }
          }
          if (allHaveStats) {
            statusText = '✅ Статистика заполнена';
            button = { text: `✅ Завершить заказ ${orderId}`, callback_data: `finish_order_${orderId}` };
          } else {
            statusText = '⏳ Ожидает заполнения статистики';
            // Создаём состояние для этого заказа
            const offersState = {};
            for (const offerId of missingStats) {
              offersState[offerId] = {
                material: null,
                color: null,
                weight: null,
                status: 'not_started',
                messageId: null,
                waitingForWeight: false
              };
            }
            pendingForms.set(`${userId}_${orderId}`, {
              orderId: orderId,
              offers: offersState,
              allCompleted: false
            });
            const firstOffer = missingStats[0];
            button = { text: `📝 Заполнить статистику ${orderId} (${firstOffer})`, callback_data: `fill_stats_${orderId}_${firstOffer}` };
          }
        } else {
          statusText = '⚠️ Не удалось проверить статистику';
          // Всё равно даём кнопку завершения (на случай, если заказ уже не актуален)
          button = { text: `✅ Завершить заказ ${orderId}`, callback_data: `finish_order_${orderId}` };
        }
      }

      reply += `• Заказ \`${orderId}\` — ${statusText}\n`;
      if (button) {
        keyboard.push([button]);
      }
    }

    if (keyboard.length) {
      await bot.sendMessage(msg.chat.id, reply, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
    }
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

    // --- Проверяем наличие статистики для всех товаров в заказе ---
    try {
      const orderDetails = await ozon.getOrderDetails(postingNumber);
      if (!orderDetails || !orderDetails.products) {
        return bot.sendMessage(msg.chat.id, `❌ Не удалось получить детали заказа ${postingNumber}.`);
      }
      let missingStats = [];
      for (const product of orderDetails.products) {
        const offerId = product.offer_id;
        if (!offerId) continue;
        const stats = await db.getProductStats(offerId);
        if (!stats) missingStats.push(offerId);
      }
      if (missingStats.length > 0) {
        const missingList = missingStats.join(', ');
        return bot.sendMessage(msg.chat.id, `❌ Для заказа ${postingNumber} отсутствует статистика для товаров: ${missingList}. Заполните статистику через /my_orders.`);
      }
    } catch (err) {
      console.error('Ошибка проверки статистики:', err);
      return bot.sendMessage(msg.chat.id, `❌ Ошибка проверки статистики: ${err.message}`);
    }

    // --- Очищаем pendingForms и удаляем сообщения перед завершением ---
    const key = `${userId}_${postingNumber}`;
    const state = pendingForms.get(key);
    if (state) {
      // Дополнительная проверка: если состояние существует, но есть незавершённые опросы – блокируем
      const hasIncomplete = Object.values(state.offers).some(o => o.status !== 'completed');
      if (hasIncomplete || !state.allCompleted) {
        return bot.sendMessage(msg.chat.id, `❌ Сначала заполните статистику для всех товаров в заказе ${postingNumber}. Используйте /my_orders, чтобы продолжить.`);
      }
      // Удаляем сообщения
      for (const offerId of Object.keys(state.offers)) {
        try { await bot.deleteMessage(userId, state.offers[offerId].messageId); } catch (e) { }
        try {
          if (state.offers[offerId].stepMessageId) {
            await bot.deleteMessage(userId, state.offers[offerId].stepMessageId);
          }
        } catch (e) { }
      }
      pendingForms.delete(key);
    }

    const isDebugFinished = await safeDebugFinish(
      assignment.order_id, employee.id, employee.name, msg.chat.id, postingNumber
    );
    if (isDebugFinished) return;
    await finishOrder(msg.chat.id, postingNumber, employee);
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

  // --- "/my_earnings" – просмотр заработка сотрудника за месяц ---
  bot.onText(/\/my_earnings(?: (.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }

    // Парсим месяц (если указан)
    let monthStr = match[1] || null;
    let fromDate, toDate;
    if (monthStr) {
      // Проверяем формат YYYY-MM
      if (!/^\d{4}-\d{2}$/.test(monthStr)) {
        return bot.sendMessage(msg.chat.id, '❌ Неверный формат. Используйте YYYY-MM (например, 2025-06)');
      }
      const [year, month] = monthStr.split('-').map(Number);
      fromDate = new Date(year, month - 1, 1).getTime();
      toDate = new Date(year, month, 1).getTime() - 1;
    } else {
      // Текущий месяц
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      fromDate = new Date(year, month, 1).getTime();
      toDate = new Date(year, month + 1, 1).getTime() - 1;
    }

    const earnings = await db.getEmployeeEarnings(employee.id, fromDate, toDate);
    if (!earnings.length) {
      return bot.sendMessage(msg.chat.id, `📭 Нет записей о заработке за указанный период.`);
    }

    let total = 0;
    let orderCount = earnings.length;
    for (const e of earnings) {
      total += e.amount;
    }

    let monthDisplay = monthStr || `${new Date(fromDate).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}`;
    const reply = `💰 *Ваш заработок за ${monthDisplay}*\n\n` +
      `• Заказов: ${orderCount}\n` +
      `• Сумма: ${total.toFixed(2)} руб.\n` +
      `• Средний чек: ${(total / orderCount).toFixed(2)} руб.`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
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
      helpText += `/orders [warehouse_id] — показать очередь заказов из API (с фильтром по складу)\n`;
      helpText += `/order_details <номер_заказа> — показать детали заказа\n`;
      helpText += `/employee_warehouses <id_сотрудника> — склады сотрудника\n`;
      helpText += `/employee_stats <id_сотрудника> — статистика сотрудника (заказы, сумма)\n`;
      helpText += `/employee_orders <id_сотрудника> — активные заказы сотрудника\n\n`;

      helpText += `/admin_fill_stats <offer_id> — заполнить/обновить статистику товара (материал, цвет, вес)\n`;
      helpText += `/cancel_fill_stats — отменить активный процесс заполнения статистики\n`;
      helpText += `/clear_product_stats <offer_id> — удалить статистику для продукта\n\n`;

      helpText += `/export_earnings [YYYY-MM] — экспорт заработка всех сотрудников за месяц (по умолчанию текущий)\n\n`;

      helpText += `/send_label <номер_заказа> [id_сотрудника] — отправить PDF‑этикетку заказа сотруднику (если ID не указан – себе)\n\n`;

      helpText += `/admin_assign_order <номер_заказа> [id_сотрудника] — назначить заказ сотруднику (если ID не указан – показать список сотрудников)\n\n`;

      helpText += `/admin_cancel_order <номер_заказа> — снять заказ с сотрудника\n\n`;

      helpText += `/clear_assignments — сброс ВСЕХ назначений на заказы\n\n`;

      helpText += `📁 3D-модели:

/send_models <offer_id> [id_сотрудника] — отправить все модели для offer_id сотруднику (если ID не указан – себе)
/list_models <offer_id> — список моделей для offer_id
/remove_model <offer_id> <имя_файла> — удалить модель

📤 Загрузка моделей до 50 МБ (через бота):
/upload_model — загрузить модель, offer_id извлекается из имени файла (например, "2001867564-N_bmw.stl")
/add_model <offer_id> — загрузить модель для указанного offer_id (сначала команда, потом файл)
/cancel_model — отменить ожидание загрузки модели

📌 Для больших файлов (>50 МБ):
1. Залейте файл в канал моделей вручную (Telegram Desktop позволяет до 2 ГБ).
2. Перешлите сообщение боту с caption:
   offer_id: НАШ_OFFER_ID
   Файл: ИМЯ_ФАЙЛА.расширение
3. Бот автоматически привяжет модель.
Альтернативно, можно вручную привязать:
/bind_model <offer_id> <file_id> [имя_файла] — привязать существующий файл (любого размера) к offer_id
/get_file_id — получить file_id пересланного файла (для последующей привязки)
/cancel_bind — отменить ожидание file_id
\n\n`;

      helpText += `/reload_queue — Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов\n\n`;

      helpText += `/pause — приостановить авто-проверку очереди заказов\n`;
      helpText += `/resume — возобновить авто-проверку очереди заказов\n\n`;

      helpText += `/download_materials — скачать файл цен материала за грамм "materials.json"\n`;
      helpText += `/download_team_info — скачать файл сотрудников "team-info.xlsx"\n`;
      helpText += `/download_product_stats — скачать файл статистики продуктов "product-stats.xlsx" (с принудительной выгрузкой статистики из bot.db)\n`;
      helpText += `/download_db — скачать файл базы данных "bot.db"\n\n`;

      helpText += `/backup_db — создать бэкап базы данных "бот.db"\n\n`;

      helpText += `/upload_employees — загрузить новый файл "team-info.xlsx" с сотрудниками (автоматически синхронизирует БД)\n`;
      helpText += `/upload_materials — загрузить новый файл "materials.json" с ценами материалов\n\n`;

      helpText += `/full_reset_and_sync — сброс всех данных (сотрудники, склады, назначения, статистика), кроме 3D-моделей и синхронизация складов/сотрудников\n\n`;

      if (debugMode.isDebugMode()) helpText += `/debug_clear — сброс отладочных данных\n`;
      await bot.sendMessage(msg.chat.id, helpText);
      return;
    }
    if (employee) {
      let helpText = `👋 Помощь сотрудника\n\n`;
      helpText += `/my_orders — показать мои активные заказы\n`;
      helpText += `/my_earnings [YYYY-MM] — показать мой заработок за месяц (по умолчанию текущий)\n`;
      helpText += `/finish_order <номер_заказа> — завершить заказ (получить этикетку)\n`;
      helpText += `/cancel_order <номер_заказа> — отменить заказ (если не можете выполнить)\n`;
      helpText += `/start — перезапустить бота\n`;
      helpText += `/help — эта справка\n\n`;
      helpText += `Внимание: Новые заказы вам назначает Модератор.`;
      await bot.sendMessage(msg.chat.id, helpText);
      return;
    }
    // Неавторизованный пользователь
    await bot.sendMessage(msg.chat.id, '🤖 Этот бот для сотрудников склада. Если вы здесь по работе, обратитесь к администратору для получения доступа.');
  });

  console.log('Команды зарегистрированы');

  // ---------------------- ОБРАБОТЧИК TEXT (единый) ----------------------

  bot.on('text', async (msg) => {
    const text = msg.text;
    // Игнорируем команды (начинаются с /)
    if (text && text.startsWith('/')) {
      return;
    }

    const userId = msg.from.id.toString();
    let state = null;
    let orderId = null;
    let currentKey = null;
    for (const [key, st] of pendingForms) {
      if (key.startsWith(`${userId}_`)) {
        // Проверим, есть ли waitingForWeight === true
        for (const oid of Object.keys(st.offers)) {
          if (st.offers[oid].waitingForWeight === true) {
            state = st;
            orderId = st.orderId;
            currentKey = key;
            break;
          }
        }
        if (state) break;
      }
    }

    // Обработка заполнения веса пластика для заказа
    if (state) {
      const weight = parseFloat(msg.text.trim().replace(',', '.'));
      if (isNaN(weight) || weight <= 0) {
        await bot.sendMessage(userId, '❌ Введите корректное положительное число (например, 12.5)');
        return;
      }

      // Найти offerId, для которого ожидается вес
      const offerId = Object.keys(state.offers).find(oid => state.offers[oid].waitingForWeight === true);
      if (!offerId) {
        await bot.sendMessage(userId, '❌ Не найден товар для ввода веса.');
        return;
      }

      const offerState = state.offers[offerId];
      // Проверка дублирования
      const existingStats = await db.getProductStats(offerId);
      if (existingStats) {
        await bot.sendMessage(userId, `⚠️ Статистика для товара ${offerId} уже существует. Запись не будет изменена.`);
        // Удаляем этот товар из состояния
        delete state.offers[offerId];
        // Проверяем, все ли товары завершены
        const allCompleted = Object.values(state.offers).every(o => o.status === 'completed');
        state.allCompleted = allCompleted;
        if (allCompleted) {
          await sendFinishButton(userId, state.orderId);
          pendingForms.delete(currentKey);
        }
        // Удаляем сообщение с кнопкой
        try {
          await bot.deleteMessage(userId, offerState.messageId);
        } catch (e) { }
        state.waitingForWeight = false;
        return;
      }

      // Сохраняем данные
      const employee = await db.getEmployee(userId);
      await db.upsertProductStats(offerId, offerState.material, offerState.color, weight, employee.id);
      await exportProductStats();

      // Обновляем статус
      offerState.weight = weight;
      offerState.status = 'completed';
      offerState.waitingForWeight = false;

      // Удаляем сообщение с запросом веса (оно хранится в stepMessageId)
      try {
        await bot.deleteMessage(userId, offerState.stepMessageId);
      } catch (e) { }
      // Удаляем исходное сообщение с кнопкой "Заполнить статистику"
      try {
        await bot.deleteMessage(userId, offerState.messageId);
      } catch (e) { }
      // Удаляем сообщение пользователя с числом (текущее msg)
      try {
        await bot.deleteMessage(userId, msg.message_id);
      } catch (e) { }

      // Отправляем подтверждение
      await bot.sendMessage(userId, `✅ Статистика для товара ${offerId} сохранена.`);

      // Проверяем, все ли товары завершены
      const allCompleted = Object.values(state.offers).every(o => o.status === 'completed');
      state.allCompleted = allCompleted;
      if (allCompleted) {
        await sendFinishButton(userId, state.orderId);
        pendingForms.delete(currentKey);
      } else {
        // Если остались незавершённые, предлагаем продолжить
        const nextIncomplete = Object.keys(state.offers).find(oid => state.offers[oid].status !== 'completed');
        if (nextIncomplete) {
          // Можно предложить заполнить следующий, но лучше через /my_orders
          await bot.sendMessage(userId, `Остались товары без статистики. Используйте /my_orders, чтобы продолжить.`);
        }
      }
      return;
    }

    // --- Администраторское заполнение статистики (через /admin_fill_stats) ---
    const adminState = pendingStatsFill.get(userId);
    if (adminState) {
      // Если шаг не равен 3 (ожидание веса) – игнорируем (пользователь должен нажимать кнопки)
      if (adminState.step !== 3) {
        // Если пользователь вводит текст, когда не ожидается – напоминаем
        await bot.sendMessage(userId, '❌ Сейчас ожидается выбор из списка. Используйте кнопки.');
        return;
      }

      // Шаг 3: ввод веса
      const value = text.trim().replace(',', '.');
      const weight = parseFloat(value);
      if (isNaN(weight) || weight <= 0) {
        await bot.sendMessage(userId, '❌ Введите корректное положительное число (например, 12.5)');
        return;
      }

      // Сохраняем
      try {
        const employee = await db.getEmployee(userId);
        await db.upsertProductStats(
          adminState.offerId,
          adminState.data.material,
          adminState.data.color,
          weight,
          employee ? employee.id : null
        );
        await exportProductStats();
        // Удаляем последнее сообщение (запрос веса)
        if (adminState.lastMessageId) {
          try { await bot.deleteMessage(userId, adminState.lastMessageId); } catch (e) { }
        }
        await bot.sendMessage(userId,
          `✅ Статистика для offer_id \`${adminState.offerId}\` успешно сохранена/обновлена.\n` +
          `Материал: ${adminState.data.material}\nЦвет: ${adminState.data.color}\nВес: ${weight} г`
        );
        // Удаляем состояние
        pendingStatsFill.delete(userId);
      } catch (err) {
        console.error('[ADMIN_FILL_STATS] Ошибка сохранения:', err);
        await bot.sendMessage(userId, `❌ Ошибка сохранения: ${err.message}`);
      }
      return;
    }
  });
};