const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const axios = require('axios');
const bwipjs = require('bwip-js');
const { syncEmployeesFromExcel, exportTeamInfoXlsx, exportTeamInfoXlsxAll } = require('./syncEmployees');
const { getAdminCommandsOnly, getAdminStartMessage, getEmployeeCommandsOnly, getEmployeeStartMessage, getUnauthorizedMessage } = require('./helpText');
const { mergePdfs, escapeHtml, formatLocalTimestamp, formatDateDDMMYYYY } = require('./utils');
const { finishingOrders, pendingFinishConfirmations } = require('./state');

// Локальные хранилища для состояний
let pendingEmployeeUpload = new Map(); // userId -> { step: 'waiting_file' }
let pendingMaterialsUpload = new Map(); // userId -> { step: 'waiting_file' }
let pendingUploadModel = new Map(); // userId -> { step: 'waiting_file' }
let pendingForms = new Map(); // key: userId_orderId, value: { orderId, offers, allCompleted }
let pendingStatsFill = new Map(); // userId -> { offerId, step, data: { material, color, weight } }
let pendingOrderMessages = new Map(); // userId -> messageId
let pendingModelAdd = new Map();    // для /add_model
let pendingFileId = new Map();      // для /get_file_id
let materialsData = null;

let labelCooldowns = new Map(); // userId -> timestamp последнего вызова /send_label
const LABEL_COOLDOWN_MS = 60 * 1000; // 1 минута

let sendAllLabelsCooldowns = new Map(); // длинный кулдаун (1 час)
const SEND_ALL_LABELS_COOLDOWN_MS = 3600 * 1000; // 1 час
let sendAllLabelsEmptyCooldowns = new Map(); // короткий кулдаун (1 минута)
const SEND_ALL_LABELS_EMPTY_COOLDOWN_MS = 60 * 1000; // 1 минута для пустого ответа

let toggleOrdersCooldowns = new Map(); // userId -> timestamp последнего вызова /toggle_orders
const TOGGLE_ORDERS_COOLDOWN_MS = 60 * 1000; // 1 минута

let MIN_EARNINGS = 250; // значение по умолчанию, перезаписывается при загрузке

/**
 * Экспорт заработка за месяц (исторический, без корректировок) в Excel.
 * Сохраняет файл в папку outputs.
 * @param {string} monthStr - строка в формате YYYY-MM (если null, то текущий месяц)
 * @returns {Promise<string>} - путь к созданному файлу
 */
async function exportMonthlyEarnings(db, monthStr = null) {
  let fromDate, toDate;
  if (monthStr) {
    if (!/^\d{4}-\d{2}$/.test(monthStr)) {
      throw new Error('Неверный формат. Используйте YYYY-MM');
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
    throw new Error('Нет данных о заработке за указанный период.');
  }

  // Группировка
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

  const rows = [];
  for (const [empId, emp] of employeeMap) {
    rows.push({
      'ID сотрудника': empId,
      'Сотрудник': emp.name,
      'Количество заказов': emp.orderCount,
      'Средний чек': (emp.orderCount > 0 ? (emp.totalAmount / emp.orderCount).toFixed(2) : 0),
      'Заработок': emp.totalAmount.toFixed(2),
    });
  }
  rows.sort((a, b) => parseFloat(b['Заработок']) - parseFloat(a['Заработок']));

  // Генерация Excel
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Заработок (месяц)');
  const headers = ['ID сотрудника', 'Сотрудник', 'Количество заказов', 'Средний чек', 'Заработок'];
  const headerRow = worksheet.addRow(headers);
  headerRow.eachCell(cell => {
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.font = { bold: true };
  });
  for (const rowData of rows) {
    const row = worksheet.addRow(Object.values(rowData));
    row.eachCell(cell => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  }
  const columnWidths = [15, 40, 25, 15, 20];
  worksheet.columns.forEach((col, index) => {
    col.width = columnWidths[index] || 20;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const fileName = `monthly_earnings_${monthStr || (new Date(fromDate).toISOString().slice(0, 7))}.xlsx`;
  const outputPath = path.join(__dirname, 'outputs', fileName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  console.log(`[EXPORT] Файл сохранён: ${outputPath}`);
  return outputPath;
}

// Загружаем справочники при старте
function loadMaterials() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'materials-prices.json'), 'utf8');
    const data = JSON.parse(raw);
    materialsData = data;
    // Обновляем MIN_EARNINGS из файла, если поле есть
    if (data.minEarnings !== undefined && typeof data.minEarnings === 'number') {
      MIN_EARNINGS = data.minEarnings;
    } else {
      MIN_EARNINGS = 250; // значение по умолчанию
    }
    console.log(`✅ Справочники материалов загружены. MIN_EARNINGS = ${MIN_EARNINGS}`);
  } catch (err) {
    console.error('❌ Ошибка загрузки materials-prices.json:', err.message);
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
      },
      minEarnings: 250
    };
    MIN_EARNINGS = 250;
  }
}
loadMaterials();

function registerCommands(
  bot, db, ozon, scheduler, debugMode,
  isAuthorizedUser, isModerator, isAdmin,
  showOrderMenu, safeCheckAndOfferNewOrders, safeProcessNextOrder,
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

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Статистика');

        // Заголовки
        const headers = ['Артикул', 'Материал', 'Цвет', 'Вес (г)', 'Кто заполнил', 'Дата'];
        const headerRow = worksheet.addRow(headers);
        headerRow.eachCell((cell) => {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.font = { bold: true }; // Жирный шрифт для заголовков
        });

        // Данные
        for (const s of stats) {
          const rowData = [
            s.offer_id,
            s.material,
            s.color,
            s.weight_grams,
            s.employee_name || 'Неизвестно',
            formatDateDDMMYYYY(s.updated_at)
          ];
          const row = worksheet.addRow(rowData);
          row.eachCell((cell) => {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          });
        }

        // Ширина столбцов
        const columnWidths = [20, 20, 20, 15, 40, 20];
        worksheet.columns.forEach((col, index) => {
          col.width = columnWidths[index];
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const outputPath = path.join(__dirname, 'exports', 'product-stats.xlsx');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, buffer);

        await new Promise(resolve => setTimeout(resolve, 100));
        return;
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

  function formatPhone(phone) {
    if (!phone) return '';
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11) {
      return `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
    } else if (digits.length === 10) {
      return `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
    } else {
      return phone;
    }
  }

  // Вспомогательная функция для отправки PDF
  async function sendPdf(chatId, pdfBuffer, caption, filename) {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempPath = path.join(tempDir, filename);
    fs.writeFileSync(tempPath, pdfBuffer);
    try {
      await bot.sendDocument(
        chatId,
        fs.createReadStream(tempPath),
        { caption },
        { filename, contentType: 'application/pdf' }
      );
    } finally {
      fs.unlinkSync(tempPath);
    }
  }

  // Вспомогательная функция для отправки этикеток по одной
  async function sendLabelsIndividually(chatId, pdfBuffers) {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    for (let i = 0; i < pdfBuffers.length; i++) {
      try {
        const singlePath = path.join(tempDir, `label_${Date.now()}_${i}.pdf`);
        fs.writeFileSync(singlePath, Buffer.from(pdfBuffers[i]));
        await bot.sendDocument(
          chatId,
          fs.createReadStream(singlePath),
          { caption: `✅ Этикетка ${i + 1} из ${pdfBuffers.length}` },
          { filename: `label_${Date.now()}_${i}.pdf`, contentType: 'application/pdf' }
        );
        fs.unlinkSync(singlePath);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        console.error('[SEND_ALL_LABELS] Ошибка отправки отдельной этикетки:', err);
      }
    }
  }

  async function calculateOrderEarnings(orderDetails, employee) {
    const earningsDetails = [];
    let totalEarnings = 0;
    let allHaveStats = true;
    const factor = employee.earnings_factor || 1.0;

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
      // Применяем коэффициент
      earningsPerUnit = earningsPerUnit * factor;
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

      // Блокируем повторные вызовы для этого заказа
      if (finishingOrders.has(orderId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Заказ уже завершается, подождите...' });
        return;
      }
      finishingOrders.set(orderId, true);

      // Ответить на callback сразу, чтобы избежать ошибки "query is too old"
      await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Заказ завершается...' });

      try {
        // Вызываем завершение заказа (с очисткой pendingForms)
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
      } finally {
        finishingOrders.delete(orderId); // снимаем блокировку
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
        await clearOrderState(bot, orderId, userId);

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

        await safeCheckAndOfferNewOrders();
        if (!currentOrderProcessing && pendingNewOrders.length) {
          console.log(`[CONFIRM_CANCEL] Отправляем следующий заказ, осталось: ${pendingNewOrders.length}`);
          await safeProcessNextOrder();
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

    // Пропуск заказа
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
      if (typeof safeProcessNextOrder === 'function') safeProcessNextOrder();
      return;
    }

    // Показать приоритетных сотрудников
    if (data.startsWith('priority_')) {
      if (!isModerator(adminId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только модератор' });
        return;
      }
      const orderId = data.substring(9);

      // Получаем детали заказа (один вызов API)
      let orderDetails;
      try {
        orderDetails = await ozon.getOrderDetails(orderId);
      } catch (err) {
        console.error(`[PRIORITY] Ошибка получения деталей заказа ${orderId}:`, err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка получения заказа' });
        return;
      }
      if (!orderDetails || orderDetails.status !== 'awaiting_packaging') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Заказ не в статусе awaiting_packaging' });
        return;
      }

      // Извлекаем warehouse_id из delivery_method
      const warehouseId = orderDetails.delivery_method?.warehouse_id
        ? String(orderDetails.delivery_method.warehouse_id)
        : null;

      // Получаем АКТИВНЫХ сотрудников, привязанных к этому складу (или всех, если склад не определён)
      let employees = await db.getAllEmployeesWithStats(warehouseId, false, false);

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

      // собираем offer_id для проверки выданных моделей
      const offerIds = orderDetails.products.map(p => p.offer_id).filter(Boolean);

      const kb = [];
      for (const emp of employees) {
        const issuedOfferIds = await db.getIssuedOfferIds(emp.id);
        const issuedSet = new Set(issuedOfferIds);
        const hasAll = offerIds.every(id => issuedSet.has(id));
        const hasAny = offerIds.some(id => issuedSet.has(id));
        const indicator = hasAll ? '🟢' : (hasAny ? '🟡' : '🔴');
        const modelCount = await db.getIssuedCount(emp.id);
        let label = `${indicator} ${emp.name} | 📦: ${emp.active_count} | 🖨️: ${emp.capacity} | 🗃️: ${modelCount} |`;
        kb.push([{ text: label, callback_data: `assign_${orderId}_${emp.id}` }]);
      }

      kb.push([{ text: '🔙 Назад', callback_data: `back_${orderId}` }]);

      await bot.editMessageText(header, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: kb }
      });
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }

    // Показать всех сотрудников
    if (data.startsWith('others_')) {
      if (!isModerator(adminId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только модератор' });
        return;
      }
      const orderId = data.substring(7);

      // Получаем детали заказа (один вызов API)
      let orderDetails;
      try {
        orderDetails = await ozon.getOrderDetails(orderId);
      } catch (err) {
        console.error(`[OTHERS] Ошибка получения деталей заказа ${orderId}:`, err);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка получения заказа' });
        return;
      }
      if (!orderDetails || orderDetails.status !== 'awaiting_packaging') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Заказ не в статусе awaiting_packaging' });
        return;
      }

      // Получаем список всех АКТИВНЫХ сотрудников
      let employees = await db.getAllEmployeesWithStats(null, false, false);

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
      // собираем offer_id для проверки выданных моделей
      const offerIds = orderDetails.products.map(p => p.offer_id).filter(Boolean);

      const kb = [];
      for (const emp of employees) {
        const issuedOfferIds = await db.getIssuedOfferIds(emp.id);
        const issuedSet = new Set(issuedOfferIds);
        const hasAll = offerIds.every(id => issuedSet.has(id));
        const hasAny = offerIds.some(id => issuedSet.has(id));
        const indicator = hasAll ? '🟢' : (hasAny ? '🟡' : '🔴');
        const modelCount = await db.getIssuedCount(emp.id);
        let label = `${indicator} ${emp.name} | 📦: ${emp.active_count} | 🖨️: ${emp.capacity} | 🗃️: ${modelCount} |`;
        kb.push([{ text: label, callback_data: `assign_${orderId}_${emp.id}` }]);
      }

      kb.push([{ text: '🔙 Назад', callback_data: `back_${orderId}` }]);
      await bot.editMessageText(header, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: kb }
      });
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }

    // Назначение заказа
    if (data.startsWith('assign_')) {
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

    // Кнопка отмены назначения заказа сотруднику для администратора
    if (data.startsWith('cancel_assign_')) {
      await safeDeleteMessage(msg.chat.id, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
      return;
    }

    // Кнопка "Назад"
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

    // Сброс всех назначений (подтверждение)
    if (data === 'confirm_clear_all') {
      await db.db.run('DELETE FROM assignments WHERE status = "assigned"');

      // Очистка всех состояний всех заказов
      const orderIds = Array.from(pendingForms.values()).map(state => state.orderId);
      for (const orderId of orderIds) {
        await clearOrderState(bot, orderId);
      }
      // Дополнительно очищаем pendingFinishConfirmations и finishingOrders
      for (const orderId of pendingFinishConfirmations.keys()) {
        await clearOrderState(bot, orderId);
      }
      for (const orderId of finishingOrders.keys()) {
        await clearOrderState(bot, orderId);
      }

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

    // Снятие заказа администратором (подтверждение)
    if (data.startsWith('admin_cancel_confirm_')) {
      const orderId = data.substring(21);
      // Находим сотрудника, у которого был этот заказ
      const assignment = await db.db.get('SELECT employee_id FROM assignments WHERE order_id = ? AND status = "assigned"', orderId);
      let employee = null;
      if (assignment) {
        employee = await db.getEmployeeById(assignment.employee_id);
        // Очищаем pendingForms и удаляем сообщения перед завершением
        await clearOrderState(bot, orderId, employee.tg_user_id);
      }
      // Удаляем назначение
      await db.db.run('DELETE FROM assignments WHERE order_id = ? AND status = "assigned"', orderId);
      console.log(`[ADMIN] Снят заказ ${orderId} с сотрудника`);

      // Уведомляем сотрудника о снятии заказа
      if (employee) {
        try {
          await bot.sendMessage(
            employee.tg_user_id,
            `⛔ Заказ ${orderId} был снят с вас администратором.`
          );
        } catch (e) {
          console.warn(`[ADMIN_CANCEL] Не удалось уведомить сотрудника ${employee.tg_user_id}:`, e.message);
        }
      }

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
      await safeCheckAndOfferNewOrders();

      // Если после обновления нет активного заказа, но есть новые – отправляем следующий
      if (!currentOrderProcessing && pendingNewOrders.length) {
        await safeProcessNextOrder();
      }
      return;
    }

    // Кнопка "Нет" для снятия заказа администратором
    if (data.startsWith('admin_cancel_abort_')) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Снятие заказа отменено' });
      await safeDeleteMessage(msg.chat.id, msg.message_id);
      return;
    }

    // Обработка подтверждения расчёта сотрудника
    if (data.startsWith('confirm_settle_')) {
      const employeeId = parseInt(data.substring(16));
      await db.clearActiveEarningsForEmployee(employeeId);
      await db.clearActiveAdjustmentsForEmployee(employeeId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Активный заработок обнулён' });
      await bot.editMessageText(`✅ Расчёт с сотрудником (ID ${employeeId}) произведён. Активный заработок обнулён.`, {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });
    }

    // Обработка отмены расчёта сотрудника
    if (data.startsWith('cancel_settle_')) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
      await bot.deleteMessage(msg.chat.id, msg.message_id);
    }

    // Обработка подтверждения сброса заработка
    if (data === 'confirm_clear_earnings') {
      try {
        const dbConn = db.db;
        await dbConn.run('BEGIN TRANSACTION');
        await dbConn.run('DELETE FROM employee_earnings');
        await dbConn.run('DELETE FROM employee_earnings_adjustments');
        await dbConn.run('DELETE FROM employee_earnings_active');
        await dbConn.run('DELETE FROM employee_earnings_adjustments_active');
        await dbConn.run('COMMIT');
        await bot.editMessageText('✅ Все записи о заработке и корректировках сотрудников удалены.', {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сброс выполнен' });
      } catch (err) {
        await dbConn.run('ROLLBACK');
        console.error('[CLEAR_EARNINGS] Ошибка:', err);
        await bot.editMessageText(`❌ Ошибка: ${err.message}`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка' });
      }
      return;
    }

    // Обработка отмены сброса заработка
    if (data === 'cancel_clear_earnings') {
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
      return;
    }

    // Подтверждение удаления из акций
    if (data === 'confirm_remove_promotions') {
      if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Нет прав' });
        return;
      }

      await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Начинаю обработку...' });
      await bot.editMessageText('🔄 Начинаю удаление товаров из всех акций...', {
        chat_id: msg.chat.id,
        message_id: msg.message_id
      });

      try {
        // Функция для отправки сообщений о прогрессе
        const progressCallback = async (text) => {
          await bot.sendMessage(msg.chat.id, text);
        };

        const result = await ozon.removeAllPromotions(progressCallback);
        await bot.editMessageText(
          `✅ Готово!\n\nОбработано акций: ${result.actionsProcessed}\nУдалено товаров: ${result.totalProductsRemoved}`,
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id
          }
        );
      } catch (err) {
        console.error('[REMOVE_PROMOTIONS] Ошибка:', err);
        await bot.editMessageText(`❌ Ошибка: ${err.message}`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
      }
      return;
    }

    // Отмена удаления из акций
    if (data === 'cancel_remove_promotions') {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Операция отменена' });
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      return;
    }

    // Сброс всех данных (кроме моделей и сотрудников) и синхронизация — подтверждение
    if (data === 'confirm_full_reset_sync') {
      try {
        const dbConn = db.db;
        await dbConn.run('BEGIN TRANSACTION');

        // 1. Очищаем назначения, связи со складами, статистику заказов
        await dbConn.run('DELETE FROM assignments');
        await dbConn.run('DELETE FROM employee_warehouses');
        await dbConn.run('DELETE FROM employee_stats');

        // 2. Удаляем все склады (будут пересозданы)
        await dbConn.run('DELETE FROM warehouses');

        // 3. Сбрасываем автоинкремент для таблиц, кроме employees
        await dbConn.run("DELETE FROM sqlite_sequence WHERE name IN ('assignments', 'employee_warehouses', 'employee_stats', 'warehouses')");

        // 4. НЕ удаляем сотрудников, а помечаем всех как уволенных
        await dbConn.run('UPDATE employees SET is_fired = 1');

        await dbConn.run('COMMIT');

        // Очищаем глобальные состояния
        pendingNewOrders.length = 0;
        currentOrderProcessing = null;
        if (typeof deleteLastOrderMessages === 'function') {
          await deleteLastOrderMessages();
        }

        // Очистка всех состояний всех заказов
        const orderIds = Array.from(pendingForms.values()).map(state => state.orderId);
        for (const orderId of orderIds) {
          await clearOrderState(bot, orderId);
        }
        // Дополнительно очищаем pendingFinishConfirmations и finishingOrders
        for (const orderId of pendingFinishConfirmations.keys()) {
          await clearOrderState(bot, orderId);
        }
        for (const orderId of finishingOrders.keys()) {
          await clearOrderState(bot, orderId);
        }

        // Синхронизация складов
        const warehouses = await ozon.fetchWarehousesFromOzon();
        if (warehouses.length) await db.syncWarehouses(warehouses);

        // Синхронизация сотрудников (восстановит активных, уволенные останутся помеченными)
        await syncEmployeesFromExcel(db);

        // Перезагрузка очереди заказов
        await safeCheckAndOfferNewOrders();
        if (pendingNewOrders.length) {
          currentOrderProcessing = null;
          await safeProcessNextOrder();
        }

        await bot.editMessageText('✅ Полный сброс (кроме сотрудников и их заработка) и синхронизация выполнены. Очередь заказов обновлена.', {
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
    console.log(`[FINISH] === Начало завершения заказа ${postingNumber} сотрудником ${employee.name} (ID ${employee.id}) ===`);
    try {
      // Проверяем, что заказ ещё активен
      const assignment = await db.db.get(
        'SELECT status FROM assignments WHERE order_id = ? AND status = "assigned"',
        postingNumber
      );
      if (!assignment) {
        console.log(`[FINISH] Заказ ${postingNumber} уже завершён или не найден`);
        await bot.sendMessage(chatId, `⚠️ Заказ ${postingNumber} уже завершён или не найден.`);
        return;
      }

      console.log(`[FINISH] Начинаем завершение заказа ${postingNumber}`);

      // 1. Получаем сумму заказа для статистики
      const orderAmount = await ozon.getOrderTotalAmount(postingNumber);
      console.log(`[FINISH] Сумма заказа: ${orderAmount}`);

      // 2. Рассчитываем заработок ДО транзакции (чтобы не держать блокировку БД)
      let earningsData = null;
      try {
        const orderDetails = await ozon.getOrderDetails(postingNumber);
        if (orderDetails && orderDetails.products) {
          const earnings = await calculateOrderEarnings(orderDetails, employee);
          if (earnings.allHaveStats && earnings.total > 0) {
            earningsData = earnings;
          } else if (!earnings.allHaveStats) {
            console.warn(`[FINISH] Не все товары имеют статистику для заказа ${postingNumber}`);
          }
        }
      } catch (earnErr) {
        console.error('Ошибка расчёта заработка:', earnErr);
        // Продолжаем выполнение, заработок не будет сохранён
      }

      // 3. Внешние API-вызовы (подтверждение сборки, получение этикетки) – до транзакции
      let labelBuffer = null;
      let isAlreadyConfirmed = false;

      try {
        const actResponse = await ozon.confirmPostingShip(postingNumber);
        console.log(`[FINISH] Ответ ship:`, JSON.stringify(actResponse, null, 2));
      } catch (shipError) {
        if (shipError.message && shipError.message.includes('не в статусе awaiting_packaging')) {
          console.warn(`[FINISH] Заказ ${postingNumber} уже подтверждён (статус не awaiting_packaging)`);
          isAlreadyConfirmed = true;
        } else {
          throw shipError;
        }
      }

      if (!isAlreadyConfirmed) {
        // Ожидаем 15 секунд после успешного подтверждения, чтобы Ozon успел сгенерировать этикетку
        await new Promise(resolve => setTimeout(resolve, 15000));
      }

      // Получаем этикетку (всегда по posting_number)
      labelBuffer = await ozon.getPackageLabel(postingNumber);

      // ========== ТРАНЗАКЦИЯ БД ==========
      const dbConn = db.db;
      await dbConn.run('BEGIN TRANSACTION');

      try {
        // 1. Обновляем статистику сотрудника (total_orders, total_amount)
        await db.updateEmployeeStats(employee.id, orderAmount);

        // 2. Сохраняем заработок, но только если его ещё нет (защита от дублей)
        if (earningsData) {
          const existingEarnings = await dbConn.get(
            'SELECT id FROM employee_earnings WHERE order_id = ?',
            postingNumber
          );
          if (!existingEarnings) {
            await db.saveEmployeeEarnings(employee.id, postingNumber, earningsData.total);
            await db.saveEmployeeEarningsActive(employee.id, postingNumber, earningsData.total);
            console.log(`[FINISH] Заработок сохранён: ${earningsData.total}`);
          } else {
            console.log(`[FINISH] Заработок для заказа ${postingNumber} уже существует, пропускаем`);
          }
        }

        // 3. Завершаем заказ (обновляем статус в assignments)
        await db.completeOrder(postingNumber);

        await dbConn.run('COMMIT');
        console.log(`[FINISH] Транзакция успешно закоммичена для заказа ${postingNumber}`);
      } catch (txError) {
        await dbConn.run('ROLLBACK');
        console.error(`[FINISH] Ошибка в транзакции для заказа ${postingNumber}:`, txError);
        throw txError; // пробрасываем, чтобы обработать в catch внешнего блока
      }
      // ===================================

      // 4. Отправляем этикетку (после успешной транзакции)
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

      // 5. Отправляем детализацию заработка сотруднику (если есть)
      if (earningsData && earningsData.details && earningsData.details.length) {
        let msg = `💰 <b>Заработок за заказ ${escapeHtml(postingNumber)}</b>\n\n`;
        for (const item of earningsData.details) {
          msg += `• ${escapeHtml(item.productName)} (${escapeHtml(item.offerId)})\n`;
          msg += `  Материал: ${escapeHtml(item.material)}, Вес: ${escapeHtml(item.weight)} г/шт, Кол-во: ${escapeHtml(item.quantity)} шт\n`;
          msg += `  Заработок за единицу: ${escapeHtml(item.earningsPerUnit.toFixed(2))} руб., Итого: ${escapeHtml(item.totalForProduct.toFixed(2))} руб.\n`;
        }
        msg += `\n<b>Итого: ${escapeHtml(earningsData.total.toFixed(2))} руб.</b>`;
        await bot.sendMessage(employee.tg_user_id, msg, { parse_mode: 'HTML' });
      }

      // 6. Уведомляем модератора
      const moderatorId = process.env.MODERATOR_ID;
      if (moderatorId) {
        await bot.sendMessage(moderatorId, `📦 Сотрудник ${employee.name} завершил заказ ${postingNumber}.`);
      }

      console.log(`[FINISH] Заказ ${postingNumber} успешно завершён, вызываем очистку состояний`);
      await clearOrderState(bot, postingNumber, employee.tg_user_id);
      console.log(`[FINISH] === Выполнено завершение заказа ${postingNumber} ===`);

    } catch (err) {
      console.error(`[FINISH] Ошибка при завершении заказа ${postingNumber}:`, err);
      await bot.sendMessage(chatId, `❌ Не удалось подтвердить сборку заказа ${postingNumber}: ${err.message}`);
      // Если ошибка произошла после подтверждения сборки, но до транзакции, заказ может быть уже в статусе awaiting_deliver,
      // но статус в нашей БД останется assigned. Это допустимо, так как мы не обновили БД.
      // Пользователь может повторить попытку, и тогда сработает проверка дубля заработка.
      // Всё равно пытаемся очистить состояние, если оно есть
      try {
        await clearOrderState(bot, postingNumber, employee.tg_user_id);
      } catch (clearErr) {
        console.error(`[FINISH] Ошибка при очистке состояний после ошибки:`, clearErr);
      }
    }
  }


  // ---------------------- ОБЩАЯ ФУНКЦИЯ ДЛЯ НАЗНАЧЕНИЯ ЗАКАЗА ----------------------
  async function assignOrder(orderId, employeeId, adminChatId) {
    console.log(`[ASSIGN] === Начало назначения заказа ${orderId} сотруднику ${employeeId} ===`);

    try {
      const employee = await db.getEmployeeById(employeeId);
      if (!employee) throw new Error(`Сотрудник с ID ${employeeId} не найден.`);

      if (employee.is_fired) {
        throw new Error(`Сотрудник ${employee.name} уволен и не может получать заказы.`);
      }

      const orderDetails = await ozon.getOrderDetails(orderId);
      if (!orderDetails) throw new Error(`Не удалось получить детали заказа ${orderId}.`);

      // Проверяем, может ли бот писать сотруднику
      try {
        await bot.sendChatAction(employee.tg_user_id, 'typing');
      } catch (err) {
        throw new Error(`Сотрудник ${employee.name} не начал диалог с ботом. Попросите его написать /start.`);
      }

      // Удаляем старые состояния, если заказ был ранее в очереди (например, повторное назначение)
      await clearOrderState(bot, orderId);

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
      let statsText = '';
      let skuList = [];
      if (orderDetails && orderDetails.products) {
        const items = orderDetails.products.map(p => `${p.name} — ${p.quantity} шт.`).join('\n');
        detailsText = `\nСостав:\n${items}`;
        skuList = orderDetails.products.map(p => p.sku).filter(Boolean);

        // Сбор статистики (материал, цвет)
        for (const p of orderDetails.products) {
          const offerId = p.offer_id;
          if (offerId) {
            const stats = await db.getProductStats(offerId);
            if (stats) {
              statsText += `\n${p.name} — Материал: ${stats.material}, Цвет: ${stats.color}`;
            }
          }
        }
        if (statsText) statsText = '\n\n*Статистика товаров:*' + statsText;
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

      const detailsTextEscaped = escapeHtml(detailsText);
      const statsTextEscaped = escapeHtml(statsText);
      const caption = `✅ Вам назначен заказ №: <b>${escapeHtml(orderId)}</b>${detailsTextEscaped}${statsText ? '\n\n<b>Статистика товаров:</b>' + statsTextEscaped : ''}\n\nКогда упакуете, нажмите кнопку ниже или выполните команду:\n/finish_order <code>${escapeHtml(orderId)}</code>`;

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
            parse_mode: 'HTML',
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
          await bot.sendMessage(employee.tg_user_id, caption, { parse_mode: 'HTML', ...finishKeyboard });
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
            // Записываем выдачу моделей для сотрудника к данному offerId
            await db.addIssuedModel(employee.id, originalOfferId);
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

      console.log(`[ASSIGN] Заказ ${orderId} успешно назначен сотруднику ${employee.name} (ID ${employee.id})`);

      // --- Отправляем уведомление администратору (если передан chatId) ---
      if (adminChatId) {
        await bot.sendMessage(adminChatId, `✅ Заказ ${orderId} назначен сотруднику ${employee.name} (ID сотрудника: ${employee.id}).`);
      }

      // Запускаем следующий заказ, если есть
      if (typeof safeProcessNextOrder === 'function') {
        await safeProcessNextOrder();
      }

      console.log(`[ASSIGN] === Назначение завершено ===`);
      return { success: true, employee };
    } catch (err) {
      console.error(`[ASSIGN] Ошибка назначения заказа ${orderId}:`, err);
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
      let activeCount = 0;
      if (employee) {
        activeCount = await db.getEmployeeActiveOrdersCount(employee.id);
      }
      const { welcome, adminMessagePart1, adminMessagePart2 } = getAdminStartMessage(employee, activeCount, debugMode.isDebugMode());

      // Отправляем приветствие с HTML
      await bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });

      // Небольшая задержка (300 мс) между сообщениями
      await new Promise(resolve => setTimeout(resolve, 300));

      // Отправляем первую часть
      await bot.sendMessage(chatId, adminMessagePart1);

      // Небольшая задержка (300 мс) между сообщениями
      await new Promise(resolve => setTimeout(resolve, 300));

      // Отправляем вторую часть
      await bot.sendMessage(chatId, adminMessagePart2);
      return;
    }

    // --- Обычный сотрудник (есть в БД) ---
    if (employee) {
      const activeCount = await db.getEmployeeActiveOrdersCount(employee.id);
      const { welcome, commands } = getEmployeeStartMessage(employee, activeCount);

      // Приветствие с HTML
      await bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });

      // Небольшая задержка (300 мс) между сообщениями
      await new Promise(resolve => setTimeout(resolve, 300));

      // Команды без HTML
      await bot.sendMessage(chatId, commands);
      return;
    }

    // --- Неавторизованный пользователь ---
    await bot.sendMessage(chatId, getUnauthorizedMessage());
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
  bot.onText(/\/status_all(?:\s+(.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    // Строгое совпадение с "include_fired" или "fired" после любого дефиса
    const includeFired = match && match[1] && (
      /[—–-]include_fired/.test(match[1]) ||
      /[—–-]fired/.test(match[1])
    );

    const employees = await db.getAllEmployeesWithStats(null, true, includeFired);
    if (!employees.length) {
      return bot.sendMessage(msg.chat.id, includeFired ? 'Нет сотрудников (включая уволенных).' : 'Нет активных сотрудников.');
    }

    const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
    const moderatorId = process.env.MODERATOR_ID ? process.env.MODERATOR_ID.toString() : null;

    // Приоритет роли (меньше = выше)
    const getRolePriority = (emp) => {
      const tgId = emp.tg_user_id;
      if (GOD_ID && tgId === GOD_ID) return 0;
      if (moderatorId && tgId === moderatorId) return 1;
      if (isAdmin(tgId)) return 2;
      if (emp.is_fired) return 4;
      return 3;
    };

    employees.sort((a, b) => {
      const priorityA = getRolePriority(a);
      const priorityB = getRolePriority(b);
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.id - b.id;
    });

    // Для каждого сотрудника заранее получим issuedCount, чтобы не делать await внутри цикла построения сообщения
    const employeesWithIssued = await Promise.all(employees.map(async (emp) => {
      const issuedCount = await db.getIssuedCount(emp.id);
      return { ...emp, issuedCount };
    }));

    // Функция для генерации текста для одной группы сотрудников (синхронная)
    function buildStatusMessage(empList) {
      let reply = '🪪 <b>Статус сотрудников:</b>\n\n';
      for (const emp of empList) {
        let roleEmoji = '👷';
        let roleText = 'Сотрудник';

        const tgId = emp.tg_user_id;
        if (GOD_ID && tgId === GOD_ID) {
          roleEmoji = '👻';
          roleText = 'Создатель';
        } else if (moderatorId && tgId === moderatorId) {
          roleEmoji = '🕵️';
          roleText = 'Модератор';
        } else if (isAdmin(tgId)) {
          roleEmoji = '🧑‍💻';
          roleText = 'Администратор';
        } else if (emp.is_fired) {
          roleEmoji = '👤';
          roleText = 'Уволен';
        }

        reply += `${roleEmoji} ${escapeHtml(emp.name)} — <b>${escapeHtml(roleText)}</b>\n`;
        reply += `🆔 <b>ID сотрудника:</b> <code>${escapeHtml(emp.id)}</code>\n`;
        const phoneFormatted = formatPhone(emp.phone);
        reply += `📞 Телефон: ${phoneFormatted ? escapeHtml(phoneFormatted) : '📵'}\n`;
        reply += `📦 Активных заказов: ${escapeHtml(emp.active_count)}\n`;
        if (emp.earnings_factor) reply += `📈 Коэффициент заработка: ${escapeHtml(emp.earnings_factor.toFixed(2))}\n`;
        reply += `🖨️ 3D-принтеров: ${escapeHtml(emp.capacity)}\n`;
        reply += `🗃️ Выданных моделей: ${(GOD_ID && tgId === GOD_ID) ? '♾️' : escapeHtml(emp.issuedCount)}\n`;
        reply += `📋 Приём заказов: ${(GOD_ID && tgId === GOD_ID) ? '⚜️' : (emp.taking_orders === 1 ? '✅' : '❌')}\n\n`;
      }
      return reply;
    }

    // Разбиваем сотрудников на части по 10 человек
    const chunkSize = 10;
    let totalSent = 0;
    for (let i = 0; i < employeesWithIssued.length; i += chunkSize) {
      const chunk = employeesWithIssued.slice(i, i + chunkSize);
      const message = buildStatusMessage(chunk);
      await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
      totalSent += chunk.length;
      if (i + chunkSize < employeesWithIssued.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (employeesWithIssued.length > chunkSize) {
      await bot.sendMessage(
        msg.chat.id,
        `✅ Выведено ${totalSent} сотрудников (${includeFired ? 'включая уволенных' : 'только активные'}).`
      );
    }
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

    if (!assignments.length) {
      return bot.sendMessage(msg.chat.id, 'Нет активных заказов.');
    }

    let reply = '';
    reply = `📋 <b>Активные заказы</b>\nВсего заказов: <b>${assignments.length}</b>\n\n`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

    await new Promise(resolve => setTimeout(resolve, 300));

    // Разбиваем по 50 заказов
    const CHUNK_SIZE = 50;
    let totalChunks = Math.ceil(assignments.length / CHUNK_SIZE);

    for (let i = 0; i < assignments.length; i += CHUNK_SIZE) {
      const chunk = assignments.slice(i, i + CHUNK_SIZE);
      reply = '';

      if (totalChunks > 1) reply = `📋 Активные заказы (часть <b>${Math.floor(i / CHUNK_SIZE) + 1}</b> из ${totalChunks})\n\n`;

      for (const a of chunk) {
        reply += `• Заказ <code>${escapeHtml(a.order_id)}</code> — <b>${escapeHtml(a.employee_name)}</b>\n`;
      }

      await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

      if (i + CHUNK_SIZE < assignments.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  });

  // --- "/warehouses" Команда для администратора: показать список всех складов ---
  bot.onText(/\/warehouses/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const warehouses = await db.getAllWarehouses();
    if (!warehouses.length) {
      return bot.sendMessage(msg.chat.id, 'Склады не найдены. Возможно, не удалось выполнить синхронизацию.');
    }

    let reply = '';

    reply = `📦 <b>Список складов (из Ozon)</b>\nВсего складов: <b>${warehouses.length}</b>\n\n`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

    await new Promise(resolve => setTimeout(resolve, 300));

    // Разбиваем по 15 складов
    const CHUNK_SIZE = 15;
    let totalChunks = Math.ceil(warehouses.length / CHUNK_SIZE);

    for (let i = 0; i < warehouses.length; i += CHUNK_SIZE) {
      const chunk = warehouses.slice(i, i + CHUNK_SIZE);
      reply = '';

      if (totalChunks > 1) reply = `📦 Склады (часть <b>${Math.floor(i / CHUNK_SIZE) + 1}</b> из ${totalChunks})\n\n`;

      for (const wh of chunk) {
        reply += `• <b>${escapeHtml(wh.name)}</b> (ID: <code>${escapeHtml(wh.warehouse_id)}</code>)\n`;
        reply += `   📍 ${wh.address ? escapeHtml(wh.address) : 'адрес не указан'}\n`;
        reply += `   Тип: ${wh.is_rfbs ? 'realFBS' : 'FBS'}\n\n`;
      }

      await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

      if (i + CHUNK_SIZE < warehouses.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
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

    let reply = `📦 Склады сотрудника <b>${escapeHtml(emp.name)}</b>:\n`;
    if (!warehouses.length) {
      reply += `<b>Не числится ни на одном складе.</b>`;
    } else {
      for (const wh of warehouses) {
        reply += `\n• <b>${escapeHtml(wh.name)}</b> (ID: <code>${escapeHtml(wh.warehouse_id)}</code>)\n   📍 ${wh.address ? escapeHtml(wh.address) : 'адрес не указан'}\n`;
      }
    }
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
  });

  // --- "/employee_orders" Команда для администратора: Просмотр активных заказов сотрудника ---
  bot.onText(/\/employee_orders (\d+)/, async (msg, match) => {
    const userId = msg.from.id.toString();

    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
      return;
    }

    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    try {
      const employeeId = parseInt(match[1], 10);

      const emp = await db.getEmployeeById(employeeId);

      if (!emp) {
        await bot.sendMessage(msg.chat.id, '❌ Сотрудник не найден.');
        return;
      }

      const orders = await db.getEmployeeActiveOrders(employeeId);

      if (!orders || orders.length === 0) {
        await bot.sendMessage(
          msg.chat.id,
          `У сотрудника <b>${escapeHtml(emp.name)}</b> нет активных заказов.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      let reply = `Активные заказы сотрудника <b>${escapeHtml(emp.name)}</b>:\n`;

      for (const o of orders) {
        reply += `- <code>${escapeHtml(String(o.order_id))}</code> ` +
          `(назначен ${escapeHtml(new Date(o.assigned_at).toLocaleString())})\n`;
      }

      await bot.sendMessage(msg.chat.id, reply, {
        parse_mode: 'HTML'
      });

    } catch (err) {
      console.error('[EMPLOYEE_ORDERS] Ошибка:', err);

      await bot.sendMessage(
        msg.chat.id,
        `❌ Не удалось получить активные заказы: ${escapeHtml(err.message)}`,
        { parse_mode: 'HTML' }
      );
    }
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

  // --- "/upload_materials" Команда для администратора: загрузить новый файл materials-prices.json с ценами материалов ---
  bot.onText(/\/upload_materials/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    pendingMaterialsUpload.set(userId, { step: 'waiting_file' });
    await bot.sendMessage(msg.chat.id, '📤 Отправьте файл materials-prices.json с настройками материалов.');
  });

  // --- "/admin_assign_order" Команда для администратора: назначить заказ сотруднику вручную ---
  bot.onText(/\/admin_assign_order (\S+)(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    const postingNumber = match[1];
    const employeeId = match[2] ? parseInt(match[2]) : null;

    // Получаем детали заказа (один вызов API)
    let orderDetails;
    try {
      orderDetails = await ozon.getOrderDetails(postingNumber);
    } catch (err) {
      console.error(`[ADMIN_ASSIGN] Ошибка получения деталей заказа ${postingNumber}:`, err);
      return bot.sendMessage(msg.chat.id, `❌ Ошибка получения заказа: ${err.message}`);
    }
    if (!orderDetails || orderDetails.status !== 'awaiting_packaging') {
      return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не в статусе "awaiting_packaging".`);
    }

    if (employeeId) {
      // Назначаем сразу
      try {
        await assignOrder(postingNumber, employeeId, msg.chat.id);
      } catch (err) {
        // Ошибка уже обработана внутри assignOrder
      }
    } else {
      // Показываем список ВСЕХ (НЕ УВОЛЕННЫХ) сотрудников для выбора
      const employees = await db.getAllEmployeesWithStats(null, true, false); // includeAll = true, includeFired = false
      if (!employees.length) {
        return bot.sendMessage(msg.chat.id, '❌ Сотрудники не найдены.');
      }

      // собираем offer_id для проверки выданных моделей
      const offerIds = orderDetails.products.map(p => p.offer_id).filter(Boolean);

      const kb = [];
      for (const emp of employees) {
        const issuedOfferIds = await db.getIssuedOfferIds(emp.id);
        const issuedSet = new Set(issuedOfferIds);
        const hasAll = offerIds.every(id => issuedSet.has(id));
        const hasAny = offerIds.some(id => issuedSet.has(id));
        const indicator = hasAll ? '🟢' : (hasAny ? '🟡' : '🔴');
        const modelCount = await db.getIssuedCount(emp.id);
        let label = `${indicator} ${emp.name} | 📦: ${emp.active_count} | 🖨️: ${emp.capacity} | 🗃️: ${modelCount} |`;
        if (emp.taking_orders === 0) label += ' 🚫';
        kb.push([{ text: label, callback_data: `assign_${postingNumber}_${emp.id}` }]);
      }

      kb.push([{ text: '❌ Отмена', callback_data: `cancel_assign_${postingNumber}` }]);

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

  // --- "/admin_send_label" Команда для администратора: отправить этикетку заказа сотруднику (или себе) ---
  bot.onText(/\/admin_send_label (\S+)(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    const postingNumber = match[1];
    const targetEmployeeId = match[2] ? parseInt(match[2]) : null;

    // Проверяем статус заказа через Ozon API
    try {
      const details = await ozon.getOrderDetails(postingNumber);
      if (!details) {
        return bot.sendMessage(msg.chat.id, `❌ Не удалось получить статус заказа ${postingNumber}.`);
      }
      if (details.status !== 'awaiting_deliver') {
        return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не в статусе "awaiting_deliver" (текущий: ${details.status}). Этикетка недоступна.`);
      }
    } catch (err) {
      console.error(`[ADMIN_SEND_LABEL] Ошибка проверки статуса:`, err);
      return bot.sendMessage(msg.chat.id, `❌ Ошибка проверки статуса: ${err.message}`);
    }

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

    // Таймаут между вызововами методов Ozon API
    await new Promise(resolve => setTimeout(resolve, 5000));

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
      if (fileName !== 'materials-prices.json') {
        await bot.sendMessage(msg.chat.id, '❌ Пожалуйста, отправьте файл с именем materials-prices.json.');
        pendingMaterialsUpload.delete(userId);
        return;
      }
      try {
        const fileLink = await bot.getFileLink(file.file_id);
        const tempPath = path.join(__dirname, 'temp_materials-prices.json');
        const writer = fs.createWriteStream(tempPath);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        // Заменяем основной файл
        const targetPath = path.join(__dirname, 'materials-prices.json');
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
        // Записываем выдачу моделей для сотрудника к данному offerId
        if (targetEmployeeId) {
          await db.addIssuedModel(targetEmployeeId, offerId);
        }
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

      // 2. Сбрасываем текущий обрабатываемый заказ и очередь (но не pendingForms)
      currentOrderProcessing = null;
      pendingNewOrders.length = 0;

      // 3. Обновляем очередь заказов из API (заполняет pendingNewOrders)
      await safeCheckAndOfferNewOrders();

      // 4. Получаем все активные назначения из БД
      const activeAssignments = await db.db.all('SELECT order_id FROM assignments WHERE status = "assigned"');
      const activeOrderIds = new Set(activeAssignments.map(a => a.order_id));

      // 5. Добавляем заказы из обновлённой очереди
      const pendingOrderIds = new Set(pendingNewOrders.map(o => o.posting_number));

      // 6. Удаляем состояния только для заказов, которые не являются активными
      const keysToRemove = [];
      for (const [key, state] of pendingForms) {
        const orderId = state.orderId;
        if (!activeOrderIds.has(orderId) && !pendingOrderIds.has(orderId)) {
          keysToRemove.push(key);
        }
      }

      console.log(`[RELOAD] Найдено неактивных состояний для удаления: ${keysToRemove.length}`);
      for (const key of keysToRemove) {
        const state = pendingForms.get(key);
        if (state) {
          const uid = key.split('_')[0];
          await clearOrderState(bot, state.orderId, uid);
        }
      }

      // 7. Если есть заказы в очереди – отправляем первый
      if (pendingNewOrders.length) {
        currentOrderProcessing = null;
        await safeProcessNextOrder();
        await bot.sendMessage(msg.chat.id, `✅ Перезагрузка выполнена. Отправлен первый заказ. Осталось: ${pendingNewOrders.length}`);
      } else {
        await bot.sendMessage(msg.chat.id, '✅ Перезагрузка выполнена. Новых заказов нет.');
      }
    } catch (err) {
      console.error('[RELOAD_QUEUE] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка при перезагрузке: ${err.message}`);
    }
  });

  // --- "/orders" Команда для администратора: просмотр списка заказов из API (с фильтром по складу) ---
  bot.onText(/\/orders(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const warehouseId = match[1] ? Number(match[1]) : null; // преобразуем в число

    try {
      const orders = await ozon.fetchAwaitingOrders(warehouseId); // передаём число или null

      let warehouseName = null;
      let warehouseNotFound = false;
      if (warehouseId) {
        warehouseName = await db.getWarehouseNameById(String(warehouseId));
        if (warehouseName === String(warehouseId)) {
          warehouseNotFound = true; // склад не найден в БД
        }
      }

      if (!orders || orders.length === 0) {
        let msg = warehouseId
          ? `📭 Нет заказов в статусе "awaiting_packaging" для склада ${warehouseNotFound ? `ID: <code>${escapeHtml(warehouseId)}</code>` : `«<b>${escapeHtml(warehouseName)}</b>»`}.`
          : '📭 Нет заказов в статусе "awaiting_packaging".';
        return bot.sendMessage(msg.chat.id, msg, { parse_mode: 'HTML' });
      }

      let reply = `📋 <b>Список заказов (awaiting_packaging)</b>`;
      if (warehouseId) {
        if (warehouseNotFound) {
          reply += ` для склада ID: <code>${warehouseId}</code>`;
        } else {
          reply += ` для склада «<b>${escapeHtml(warehouseName)}</b>»`;
        }
      }
      reply += `\nВсего заказов: <b>${orders.length}</b>\n\n`;

      await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Разбиваем по 25 заказов
      const CHUNK_SIZE = 25;
      let totalChunks = Math.ceil(orders.length / CHUNK_SIZE);

      for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
        const chunk = orders.slice(i, i + CHUNK_SIZE);
        reply = '';

        if (totalChunks > 1) reply += `Заказы (часть <b>${Math.floor(i / CHUNK_SIZE) + 1}</b> из ${totalChunks})\n\n`;

        for (const order of chunk) {
          const orderNumber = order.posting_number;
          const productsCount = order.products ? order.products.length : (order.products_count || '?');
          let whId = order.warehouse_id || order.delivery_method?.warehouse_id || null;
          let whDisplay = `<b>не указан</b>`;
          if (whId) {
            whId = String(whId);
            const whName = await db.getWarehouseNameById(whId);
            if (whName === whId) {
              whDisplay = `ID: <code>${escapeHtml(whId)}</code>`;
            } else {
              whDisplay = `<b>${escapeHtml(whName)}</b> (ID: <code>${escapeHtml(whId)}</code>)`;
            }
          }
          reply += `• Заказ <code>${escapeHtml(orderNumber)}</code>\n`;
          reply += `  Товаров: ${productsCount}\n`;
          reply += `  Склад: ${whDisplay}\n\n`;
        }

        await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

        // Задержка между частями
        if (i + CHUNK_SIZE < orders.length) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      reply = '';
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

      let reply = `📄 <b>Детали заказа <code>${escapeHtml(postingNumber)}</code></b>\n\n`;

      // Основная информация
      if (details.substatus) reply += ` (${escapeHtml(details.substatus)})`;
      reply += `\n`;
      if (details.order_number) reply += `<b>Номер заказа:</b> ${escapeHtml(details.order_number)}\n`;
      if (details.delivery_method) {
        reply += `<b>Метод доставки:</b> ${escapeHtml(details.delivery_method.name || '—')}\n`;
        if (details.delivery_method.warehouse_id) {
          const warehouseName = await db.getWarehouseNameById(String(details.delivery_method.warehouse_id));
          reply += `<b>Склад:</b> ${escapeHtml(warehouseName)} (ID: <code>${escapeHtml(details.delivery_method.warehouse_id)}</code>)\n`;
        }
      }

      // Товары
      if (details.products && details.products.length) {
        reply += `\n<b>Товары:</b>\n`;
        for (let i = 0; i < details.products.length; i++) {
          const p = details.products[i];
          reply += `${i + 1}. ${escapeHtml(p.name || '—')}`;
          if (p.sku) reply += ` (SKU: ${escapeHtml(p.sku)})`;
          if (p.offer_id) reply += `, offer_id: ${escapeHtml(p.offer_id)}`;
          reply += ` — ${escapeHtml(p.quantity)} шт.\n`;
          if (p.price && p.price.amount) {
            reply += `   Цена: ${escapeHtml(p.price.amount)} ${escapeHtml(p.price.currency || 'RUB')}\n`;
          }
        }
      } else {
        reply += `\n<b>Товары:</b> не указаны\n`;
      }

      // Получатель
      if (details.customer) {
        reply += `\n<b>Получатель:</b> ${escapeHtml(details.customer.name || '—')}`;
        if (details.customer.phone) reply += `, тел: ${escapeHtml(details.customer.phone)}`;
        reply += `\n`;
        if (details.customer.address) {
          const addr = details.customer.address;
          let addrStr = '';
          if (addr.address_tail) addrStr += addr.address_tail;
          if (addr.city) addrStr += (addrStr ? ', ' : '') + addr.city;
          if (addr.region) addrStr += (addrStr ? ', ' : '') + addr.region;
          if (addr.zip_code) addrStr += (addrStr ? ', ' : '') + addr.zip_code;
          if (addrStr) reply += `<b>Адрес:</b> ${escapeHtml(addrStr)}\n`;
        }
      }

      // Дополнительно
      if (details.tracking_number) reply += `\n<b>Трек-номер:</b> ${escapeHtml(details.tracking_number)}\n`;
      if (details.in_process_at) {
        const date = new Date(details.in_process_at).toLocaleString();
        reply += `\n<b>Дата создания:</b> ${escapeHtml(date)}\n`;
      }

      await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
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
        total_amount: 999999999.99
      };
    } else {
      stats = await db.getEmployeeStats(employeeId);
    }

    // Получаем количество выданных моделей для сотрудника
    const issuedCount = await db.getIssuedCount(employeeId);

    const reply = `📊 <b>Статистика сотрудника ${escapeHtml(emp.name)}</b>\n\n` +
      `✅ Завершённых заказов: ${escapeHtml(stats.total_orders)}\n` +
      `❌ Отменённых заказов: ${escapeHtml(stats.canceled_orders || 0)}\n` +
      `🗃️ Выданных моделей: ${isGod ? '♾️' : escapeHtml(issuedCount)}\n` +
      `💰 Общая сумма: ${isGod ? `<b>${escapeHtml(stats.total_amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' }))} USD</b>` : `${escapeHtml(stats.total_amount.toFixed(2))} ₽`}` +
      (isGod ? '\n\n👻 <b>Создатель!</b>' : '');

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
  });

  const ExcelJS = require('exceljs');

  // --- "/monthly_earnings" Команда для администратора: экспорт заработка сотрудников (с корректировками) за месяц ---
  bot.onText(/\/monthly_earnings(?: (.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');

    const monthStr = match[1] || null;
    try {
      const filePath = await exportMonthlyEarnings(db, monthStr);
      const monthLabel = monthStr || `${new Date().toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}`;
      await bot.sendDocument(msg.chat.id, filePath, {
        caption: `📅 Заработок за ${monthLabel}`
      });
      // Не удаляем файл, оставляем в outputs для архива
    } catch (err) {
      console.error('[MONTHLY_EARNINGS] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
  });

  // --- "/export_earnings" Команда для администратора: экспорт активного заработка сотрудников (с корректировками) ---
  bot.onText(/\/export_earnings/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');

    // Получаем все активные заработки (без фильтра по дате)
    const earningsData = await db.getAllActiveEmployeeEarningsForPeriod(0, Date.now());
    if (!earningsData.length) {
      return bot.sendMessage(msg.chat.id, '📭 Нет данных о заработке (активных).');
    }

    // Группировка по сотрудникам
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

    const rows = [];
    for (const [empId, emp] of employeeMap) {
      const adjustments = await db.getActiveAdjustmentsSum(empId, 0, Date.now());
      const baseEarnings = emp.totalAmount;
      const totalEarnings = baseEarnings + adjustments;
      rows.push({
        'ID сотрудника': empId,
        'Сотрудник': emp.name,
        'Количество заказов': emp.orderCount,
        'Заработок (базовый)': baseEarnings.toFixed(2),
        'Корректировки': adjustments.toFixed(2),
        'Заработок (итоговый)': totalEarnings.toFixed(2),
      });
    }

    rows.sort((a, b) => parseFloat(b['Заработок (итоговый)']) - parseFloat(a['Заработок (итоговый)']));

    // Генерация Excel (аналогично, но без среднего чека)
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Заработок (активный)');
    const headers = ['ID сотрудника', 'Сотрудник', 'Количество заказов', 'Заработок (базовый)', 'Корректировки', 'Заработок (итоговый)'];
    const headerRow = worksheet.addRow(headers);
    headerRow.eachCell(cell => {
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { bold: true };
    });
    for (const rowData of rows) {
      const row = worksheet.addRow(Object.values(rowData));
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
    }
    const columnWidths = [15, 40, 25, 25, 20, 25];
    worksheet.columns.forEach((col, index) => {
      col.width = columnWidths[index] || 20;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `earnings_active_${Date.now()}.xlsx`;
    const outputPath = path.join(__dirname, 'exports', fileName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
    await bot.sendDocument(msg.chat.id, outputPath, {
      caption: `🤑 Активный заработок сотрудников (с последнего расчёта)`
    });
    fs.unlinkSync(outputPath);
  });

  // --- "/settle_earnings" Команда для администратора: полный расчёт (с обнулением) активного заработка (с корректировками) сотрудника ---
  bot.onText(/\/settle_earnings (\d+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');

    const employeeId = parseInt(match[1]);
    const employee = await db.getEmployeeById(employeeId);
    if (!employee) return bot.sendMessage(msg.chat.id, '❌ Сотрудник не найден.');

    // Получаем сумму активного заработка для этого сотрудника (за всё время, т.к. without period = все записи)
    const totalActive = await db.getActiveEmployeeEarningsSum(employeeId, 0, Date.now());

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Да, обнулить', callback_data: `confirm_settle_${employeeId}` },
            { text: '❌ Отмена', callback_data: `cancel_settle_${employeeId}` }
          ]
        ]
      }
    };
    await bot.sendMessage(msg.chat.id,
      `⚠️ Вы собираетесь произвести расчёт с сотрудником <b>${escapeHtml(employee.name)}</b>.\n` +
      `Текущий активный заработок (с последнего расчёта): <b>${totalActive.toFixed(2)} руб.</b>\n` +
      `После подтверждения активный заработок и корректировки для этого сотрудника будетут обнулёны.\n\n` +
      `Продолжить?`,
      { parse_mode: 'HTML', ...keyboard }
    );
  });

  // --- "/edit_earnings" Команда для администратора: изменение заработка сотрудника <employee_id> <сумма> [причина] ---
  bot.onText(/\/edit_earnings\s+(\d+)\s+([+-]?\d+(?:\.\d+)?)(?:\s+(.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    const employeeId = parseInt(match[1]);
    const amount = parseFloat(match[2]);
    const reason = match[3] ? match[3].trim() : '';

    if (isNaN(amount)) {
      return bot.sendMessage(msg.chat.id, '❌ Некорректная сумма.');
    }

    const employee = await db.getEmployeeById(employeeId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, `❌ Сотрудник с ID ${employeeId} не найден.`);
    }

    // Добавляем корректировку
    try {
      await db.addEarningsAdjustment(employeeId, amount, reason);
      await db.saveEarningsAdjustmentActive(employeeId, amount, reason);

      // Отправляем уведомление сотруднику
      const now = new Date();
      const fromDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;

      const baseEarnings = await db.getEmployeeEarnings(employeeId, fromDate, toDate);
      const baseTotal = baseEarnings.reduce((sum, e) => sum + e.amount, 0);
      const adjustmentTotal = await db.getEmployeeAdjustments(employeeId, fromDate, toDate);
      const total = baseTotal + adjustmentTotal;

      let notifMsg = `💰 <b>Корректировка заработка</b>\n\n`;
      notifMsg += `Администратор изменил ваш заработок на <b>${amount > 0 ? '+' : ''}${amount.toFixed(2)} руб.</b>\n`;
      if (reason) notifMsg += `Причина: ${escapeHtml(reason)}\n`;
      notifMsg += `\nТекущий заработок за месяц: <b>${total.toFixed(2)} руб.</b>\n`;
      notifMsg += `(базовый: ${baseTotal.toFixed(2)} руб., корректировки: ${adjustmentTotal > 0 ? '+' : ''}${adjustmentTotal.toFixed(2)} руб.)`;

      try {
        await bot.sendMessage(employee.tg_user_id, notifMsg, { parse_mode: 'HTML' });
      } catch (err) {
        console.warn(`[EDIT_EARNINGS] Не удалось отправить уведомление сотруднику ${employee.name}:`, err.message);
        // Продолжаем, уведомление не критично
      }

      await bot.sendMessage(msg.chat.id,
        `✅ Корректировка для сотрудника ${escapeHtml(employee.name)} (ID ${employee.id}) на сумму ${amount > 0 ? '+' : ''}${amount.toFixed(2)} руб. добавлена.`
      );
    } catch (err) {
      console.error('[EDIT_EARNINGS] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
    }
  });

  // --- "/full_reset_earnings" Команда для администратора: сброс таблицы заработка (и корректировок) сотрудников (с подтверждением) ---
  bot.onText(/\/full_reset_earnings/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚠️ ДА, удалить все записи заработка', callback_data: 'confirm_clear_earnings' },
            { text: '❌ Отмена', callback_data: 'cancel_clear_earnings' }
          ]
        ]
      }
    };
    await bot.sendMessage(msg.chat.id,
      '⚠️ Вы уверены?\n\nБудут удалены ВСЕ записи из БД о заработке сотрудников и все корректировки.\nЭто действие необратимо!',
      keyboard
    );
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

  // --- "/remove_all_promotions" Команда для администратора: Удаление всех товаров из всех акций ---
  bot.onText(/\/remove_all_promotions/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }

    const confirmKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚠️ ДА, удалить все товары из всех акций', callback_data: 'confirm_remove_promotions' },
            { text: '❌ Отмена', callback_data: 'cancel_remove_promotions' }
          ]
        ]
      }
    };

    await bot.sendMessage(
      msg.chat.id,
      '⚠️ ВНИМАНИЕ! Вы собираетесь удалить ВСЕ товары из ВСЕХ акций Ozon.\n' +
      'Это действие необратимо и может занять длительное время.\n\n' +
      'Продолжить?',
      confirmKeyboard
    );
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

  // --- "/download_materials" Команда для администратора: скачать файл materials-prices.json ---
  bot.onText(/\/download_materials/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    const filePath = path.join(__dirname, 'materials-prices.json');
    if (!fs.existsSync(filePath)) return bot.sendMessage(msg.chat.id, '❌ Файл materials-prices.json не найден.');
    await bot.sendDocument(msg.chat.id, filePath, { caption: '🧾 Актуальный файл цен материалов за грамм.' });
  });

  // --- "/download_team_info" Команда для администратора: скачать файл team-info.xlsx ---
  bot.onText(/\/download_team_info/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    try {
      const filePath = await exportTeamInfoXlsx(db);
      await bot.sendDocument(msg.chat.id, filePath, {
        caption: `📄 Актуальный файл сотрудников и складов "team-info.xlsx".`
      });
      // Можно удалить файл после отправки, но оставим для дальнейшего использования
    } catch (err) {
      console.error('[DOWNLOAD_TEAM_INFO] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка генерации файла: ${err.message}`);
    }
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

  // --- "/download_employees_db" Команда для администратора: скачать файл "employees-db.xlsx" со списком ВСЕХ сотрудниками (включая уволенных) ---
  bot.onText(/\/download_employees_db/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    try {
      const filePath = await exportTeamInfoXlsxAll(db);
      await bot.sendDocument(msg.chat.id, filePath, {
        caption: `📄 Полный список ВСЕХ (включая уволенных) сотрудников.`
      });
      // Файл можно оставить на сервере или удалить после отправки
    } catch (err) {
      console.error('[EMPLOYEE_DB] Ошибка:', err);
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

    const timestamp = formatLocalTimestamp();
    const backupPath = path.join(backupDir, `bot_${timestamp}.db`);

    try {
      fs.copyFileSync(dbPath, backupPath);
      await bot.sendMessage(msg.chat.id, `✅ Бэкап создан: <code>${escapeHtml(backupPath)}</code>`, { parse_mode: 'HTML' });
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

    // Удаляем предыдущее сообщение, если оно есть
    const oldMsgId = pendingOrderMessages.get(userId);
    if (oldMsgId) {
      try { await bot.deleteMessage(msg.chat.id, oldMsgId); } catch (e) { /* ignore */ }
      pendingOrderMessages.delete(userId);
    }

    const orders = await db.getEmployeeActiveOrders(employee.id);
    if (!orders.length) {
      const sentMsg = await bot.sendMessage(msg.chat.id, '✅ У вас нет активных заказов.');
      pendingOrderMessages.set(userId, sentMsg.message_id);
      return;
    }

    let reply = '📋 <b>Ваши активные заказы:</b>\n';
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

      reply += `• Заказ <code>${escapeHtml(orderId)}</code> — ${escapeHtml(statusText)}\n`;
      if (button) {
        keyboard.push([button]);
      }
    }

    // Отправляем новое сообщение и сохраняем его ID
    const sentMsg = await bot.sendMessage(msg.chat.id, reply, {
      parse_mode: 'HTML',
      reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined
    });
    pendingOrderMessages.set(userId, sentMsg.message_id);
  });

  // --- "/toggle_orders" – переключение статуса приёма заказов ---
  bot.onText(/\/toggle_orders/, async (msg) => {
    const userId = msg.from.id.toString();
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }

    // Проверка кулдауна
    const now = Date.now();
    const lastCall = toggleOrdersCooldowns.get(userId);
    if (lastCall && (now - lastCall) < TOGGLE_ORDERS_COOLDOWN_MS) {
      const secondsLeft = Math.ceil((TOGGLE_ORDERS_COOLDOWN_MS - (now - lastCall)) / 1000);
      return bot.sendMessage(msg.chat.id, `⏳ Подождите ${secondsLeft} сек. перед повторным изменением статуса.`);
    }

    try {
      const newStatus = await db.toggleTakingOrders(employee.id);
      const statusEmoji = newStatus === 1 ? '✅' : '❌';
      const statusVerb = newStatus === 1 ? 'Принимаю' : 'Не принимаю';

      // Красивое сообщение для сотрудника
      await bot.sendMessage(
        msg.chat.id,
        `ℹ️ <b>Статус приёма заказов изменён:</b>\n\n` +
        `${statusEmoji} <b>${statusVerb}</b> заказы ${statusEmoji}`,
        { parse_mode: 'HTML' }
      );

      // Устанавливаем кулдаун после успешного изменения
      toggleOrdersCooldowns.set(userId, now);

      // Уведомляем модератора (только если сотрудник НЕ GOD_ID)
      const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
      const moderatorId = process.env.MODERATOR_ID;
      if (moderatorId && userId !== GOD_ID) {
        const actionText = newStatus === 1 ? 'возобновил' : 'остановил';
        await bot.sendMessage(
          moderatorId,
          `🔔 Сотрудник ${escapeHtml(employee.name)} <b>${actionText}</b> приём заказов.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error('[TOGGLE_ORDERS] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
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

  // --- "/send_label" – получить этикетку заказа (для сотрудников) ---
  bot.onText(/\/send_label (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const postingNumber = match[1];

    // 1. Проверка авторизации
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }

    // 2. Проверка кулдауна
    const lastCall = labelCooldowns.get(userId);
    const now = Date.now();
    if (lastCall && (now - lastCall) < LABEL_COOLDOWN_MS) {
      const secondsLeft = Math.ceil((LABEL_COOLDOWN_MS - (now - lastCall)) / 1000);
      return bot.sendMessage(msg.chat.id, `⏳ Подождите ${secondsLeft} сек. перед повторным запросом этикетки.`);
    }

    // 3. Проверяем, что заказ был назначен этому сотруднику и завершён (статус completed)
    const assignment = await db.db.get(
      'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "completed"',
      postingNumber, employee.id
    );
    if (!assignment) {
      return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не найден среди ваших завершённых заказов.`);
    }

    // 4. Проверяем статус заказа через Ozon API (должен быть awaiting_deliver)
    try {
      const details = await ozon.getOrderDetails(postingNumber);
      if (!details) {
        return bot.sendMessage(msg.chat.id, `❌ Не удалось получить статус заказа ${postingNumber}.`);
      }
      if (details.status !== 'awaiting_deliver') {
        return bot.sendMessage(msg.chat.id, `❌ Заказ ${postingNumber} не в статусе "awaiting_deliver" (текущий: ${details.status}). Этикетка недоступна.`);
      }
    } catch (err) {
      console.error(`[SEND_LABEL] Ошибка получения статуса:`, err);
      return bot.sendMessage(msg.chat.id, `❌ Ошибка проверки статуса: ${err.message}`);
    }

    // Таймаут между вызововами методов Ozon API
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 5. Получаем этикетку
    try {
      const labelBuffer = await ozon.getPackageLabel(postingNumber);
      if (!labelBuffer) {
        return bot.sendMessage(msg.chat.id, `❌ Не удалось получить этикетку для заказа ${postingNumber}.`);
      }
      // Отправляем этикетку сотруднику
      await bot.sendDocument(
        msg.chat.id,
        labelBuffer,
        { caption: `✅ Этикетка для заказа ${postingNumber}` },
        { filename: `label_${postingNumber}.pdf`, contentType: 'application/pdf' }
      );
      // Обновляем кулдаун
      labelCooldowns.set(userId, Date.now());
    } catch (err) {
      console.error(`[SEND_LABEL] Ошибка:`, err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка получения этикетки: ${err.message}`);
    }
  });

  // --- /send_all_labels – получить все этикетки к активным заказам сотрудника в статусе awaiting_deliver (с кулдаунами) ---
  bot.onText(/\/send_all_labels/, async (msg) => {
    const userId = msg.from.id.toString();
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }

    const now = Date.now();

    // 1. Проверка длинного кулдауна (после успешной отправки)
    const lastFullCall = sendAllLabelsCooldowns.get(userId);
    if (lastFullCall && (now - lastFullCall) < SEND_ALL_LABELS_COOLDOWN_MS) {
      const minutesLeft = Math.ceil((SEND_ALL_LABELS_COOLDOWN_MS - (now - lastFullCall)) / 60000);
      return bot.sendMessage(msg.chat.id, `⏳ Команда доступна раз в час. Подождите ${minutesLeft} мин.`);
    }

    // 2. Проверка короткого кулдауна (после пустого ответа или ошибки)
    const lastEmptyCall = sendAllLabelsEmptyCooldowns.get(userId);
    if (lastEmptyCall && (now - lastEmptyCall) < SEND_ALL_LABELS_EMPTY_COOLDOWN_MS) {
      const secondsLeft = Math.ceil((SEND_ALL_LABELS_EMPTY_COOLDOWN_MS - (now - lastEmptyCall)) / 1000);
      return bot.sendMessage(msg.chat.id, `⏳ Подождите ${secondsLeft} сек. перед повторным запросом.`);
    }

    // 3. Получаем ВСЕ заказы в статусе awaiting_deliver (1 вызов API)
    let allAwaitingDeliver = [];
    try {
      allAwaitingDeliver = await ozon.fetchAwaitingDeliverOrders();
    } catch (err) {
      console.error('[SEND_ALL_LABELS] Ошибка получения заказов из Ozon:', err);
      await bot.sendMessage(msg.chat.id, `❌ Не удалось получить список заказов: ${escapeHtml(err.message)}`);
      // При ошибке API устанавливаем короткий кулдаун
      sendAllLabelsEmptyCooldowns.set(userId, now);
      return;
    }

    if (!allAwaitingDeliver.length) {
      await bot.sendMessage(msg.chat.id, '📭 Нет заказов в статусе awaiting_deliver.');
      // Устанавливаем короткий кулдаун (можно будет повторить через минуту)
      sendAllLabelsEmptyCooldowns.set(userId, now);
      return;
    }

    // 4. Получаем список завершённых заказов сотрудника из БД
    const completedOrders = await db.db.all(
      'SELECT order_id FROM assignments WHERE employee_id = ? AND status = "completed"',
      employee.id
    );
    const completedIds = new Set(completedOrders.map(o => o.order_id));

    // 5. Фильтруем: только те, что есть в completedIds (максимум 100)
    const activeOrders = allAwaitingDeliver
      .filter(order => completedIds.has(order.posting_number))
      .slice(0, 100);

    if (!activeOrders.length) {
      await bot.sendMessage(msg.chat.id, '📭 Нет завершённых заказов в статусе awaiting_deliver.');
      // Устанавливаем короткий кулдаун
      sendAllLabelsEmptyCooldowns.set(userId, now);
      return;
    }

    await bot.sendMessage(msg.chat.id, `📦 Начинаю загрузку этикеток для ${activeOrders.length} активных заказов...`);

    // 6. Собираем этикетки
    const pdfBuffers = [];
    let errors = 0;
    let skipped = 0;
    const errorDetails = [];

    for (const order of activeOrders) {
      const orderId = order.posting_number;
      try {
        const currentAssignment = await db.db.get(
          'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "completed"',
          orderId, employee.id
        );
        if (!currentAssignment) {
          console.log(`[SEND_ALL_LABELS] Заказ ${orderId} больше не принадлежит сотруднику, пропускаем`);
          skipped++;
          continue;
        }

        let labelBuffer = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            labelBuffer = await ozon.getPackageLabel(orderId);
            if (labelBuffer) break;
          } catch (err) {
            console.error(`[SEND_ALL_LABELS] Ошибка получения этикетки для ${orderId}, попытка ${attempt}:`, err.message);
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        if (labelBuffer) {
          pdfBuffers.push(labelBuffer);
        } else {
          errors++;
          errorDetails.push({ orderId, reason: 'Не удалось получить этикетку после 3 попыток' });
        }
      } catch (err) {
        console.error(`[SEND_ALL_LABELS] Ошибка обработки заказа ${orderId}:`, err);
        errors++;
        errorDetails.push({ orderId, reason: err.message });
      }
    }

    // Отправляем отчёт об ошибках модератору
    const moderatorId = process.env.MODERATOR_ID;
    if (moderatorId && errorDetails.length) {
      let modMsg = `⚠️ <b>Ошибки при отправке этикеток для сотрудника ${escapeHtml(employee.name)}</b>\n`;
      modMsg += `Всего ошибок: ${errorDetails.length}\n\n`;
      const shown = errorDetails.slice(0, 5);
      for (const err of shown) {
        modMsg += `• Заказ ${escapeHtml(err.orderId)}: ${escapeHtml(err.reason)}\n`;
      }
      if (errorDetails.length > 5) {
        modMsg += `\n... и ещё ${errorDetails.length - 5} ошибок (см. логи)`;
      }
      await bot.sendMessage(moderatorId, modMsg, { parse_mode: 'HTML' });
    }

    if (!pdfBuffers.length) {
      await bot.sendMessage(msg.chat.id, '⚠️ Не удалось загрузить ни одной этикетки.');
      // Устанавливаем короткий кулдаун, так как ничего не отправлено
      sendAllLabelsEmptyCooldowns.set(userId, now);
      return;
    }

    // 7. Разбиваем на части по размеру (не более 30 МБ каждая)
    const MAX_PART_SIZE = 30 * 1024 * 1024; // 30 МБ
    const parts = [];
    let currentPart = [];
    let currentSize = 0;

    for (const buf of pdfBuffers) {
      const size = buf.length;
      if (size > MAX_PART_SIZE) {
        console.warn(`[SEND_ALL_LABELS] Этикетка слишком большая (${(size / 1024 / 1024).toFixed(2)} МБ), пропускаем`);
        skipped++;
        continue;
      }
      if (currentSize + size > MAX_PART_SIZE && currentPart.length > 0) {
        parts.push([...currentPart]);
        currentPart = [];
        currentSize = 0;
      }
      currentPart.push(buf);
      currentSize += size;
    }
    if (currentPart.length) parts.push(currentPart);

    console.log(`[SEND_ALL_LABELS] Всего буферов: ${pdfBuffers.length}, разбито на ${parts.length} частей`);

    // 8. Отправка частей
    let sentCount = 0;
    const isSinglePart = parts.length === 1;

    for (let i = 0; i < parts.length; i++) {
      const partIndex = i + 1;
      try {
        const mergedPdf = await mergePdfs(parts[i]);
        if (!mergedPdf) {
          throw new Error('Не удалось объединить PDF для части ' + partIndex);
        }

        const buffer = Buffer.from(mergedPdf);
        const sizeMB = buffer.length / (1024 * 1024);

        if (buffer.length <= 45 * 1024 * 1024) {
          // Отправляем как один файл
          const fileName = isSinglePart
            ? `all_labels_${Date.now()}.pdf`
            : `all_labels_part_${partIndex}_${Date.now()}.pdf`;
          const caption = isSinglePart
            ? `✅ Все этикетки (${pdfBuffers.length} шт.)`
            : `✅ Этикетки (часть ${partIndex} из ${parts.length})`;
          await sendPdf(msg.chat.id, buffer, caption, fileName);
          sentCount += parts[i].length;
        } else {
          // Пытаемся разбить на две половины
          await bot.sendMessage(msg.chat.id, `⚠️ Часть ${partIndex} слишком большая (${sizeMB.toFixed(2)} МБ), разбиваю...`);
          const mid = Math.floor(parts[i].length / 2);
          const subParts = [
            parts[i].slice(0, mid),
            parts[i].slice(mid)
          ];

          let subSuccess = true;
          for (let j = 0; j < subParts.length; j++) {
            const sub = subParts[j];
            if (!sub.length) continue;
            try {
              const subMerged = await mergePdfs(sub);
              if (!subMerged) throw new Error('Не удалось объединить подчасть');
              const subBuffer = Buffer.from(subMerged);
              const subName = `all_labels_part_${partIndex}_${j + 1}.pdf`;
              const subCaption = `✅ Этикетки (часть ${partIndex}.${j + 1})`;
              await sendPdf(msg.chat.id, subBuffer, subCaption, subName);
              sentCount += sub.length;
            } catch (subErr) {
              console.error(`[SEND_ALL_LABELS] Ошибка отправки подчасти ${partIndex}.${j + 1}:`, subErr);
              subSuccess = false;
              break;
            }
          }

          if (!subSuccess) {
            // Если не получилось отправить подчасти, отправляем по одной
            await bot.sendMessage(msg.chat.id, `⚠️ Не удалось отправить часть ${partIndex} целиком, отправляю по одной...`);
            await sendLabelsIndividually(msg.chat.id, parts[i]);
            sentCount += parts[i].length;
          }
        }
      } catch (err) {
        console.error(`[SEND_ALL_LABELS] Ошибка обработки части ${partIndex}:`, err);
        await bot.sendMessage(msg.chat.id, `⚠️ Ошибка при обработке части ${partIndex}, отправляю по одной...`);
        await sendLabelsIndividually(msg.chat.id, parts[i]);
        sentCount += parts[i].length;
      }

      if (i < parts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Устанавливаем ДЛИННЫЙ кулдаун, так как этикетки успешно отправлены
    sendAllLabelsCooldowns.set(userId, now);

    await bot.sendMessage(msg.chat.id, `✅ Отправлено этикеток: ${sentCount}.`);
  });

  // --- "/my_monthly_earnings" – просмотр заработка сотрудника за месяц (без корректировок) ---
  bot.onText(/\/my_monthly_earnings(?: (.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
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

    const earnings = await db.getEmployeeEarnings(employee.id, fromDate, toDate);
    if (!earnings.length) {
      return bot.sendMessage(msg.chat.id, `📭 Нет записей о заработке за указанный период.`);
    }

    let monthDisplay = monthStr || `${new Date(fromDate).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}`;
    const total = earnings.reduce((sum, e) => sum + e.amount, 0);
    const orderCount = earnings.length;

    let reply = `💰 <b>Ваш заработок за ${escapeHtml(monthDisplay)}</b>\n\n`;
    reply += `• Заказов: ${escapeHtml(orderCount)}\n`;
    reply += `• Средний чек: ${escapeHtml((total / orderCount).toFixed(2))} руб.\n`;
    reply += `• Заработок: ${escapeHtml(total.toFixed(2))} руб.\n`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
  });

  // --- "/my_active_earnings" – просмотр текущего активного заработка (с корректировками) ---
  bot.onText(/\/my_active_earnings/, async (msg) => {
    const userId = msg.from.id.toString();
    const employee = await db.getEmployee(userId);
    if (!employee) {
      return bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.');
    }

    // Получаем активные заработки (за всё время)
    const earnings = await db.getActiveEmployeeEarnings(employee.id, 0, Date.now());
    if (!earnings.length) {
      return bot.sendMessage(msg.chat.id, '📭 Нет активных заработков (расчёт ещё не проводился).');
    }

    const totalBase = earnings.reduce((sum, e) => sum + e.amount, 0);
    const orderCount = earnings.length;
    const adjustments = await db.getActiveAdjustmentsSum(employee.id, 0, Date.now());
    const totalWithAdjustments = totalBase + adjustments;

    let reply = `🏦 <b>Ваш активный заработок (с последнего расчёта)</b>\n\n`;
    reply += `• Базовый заработок: ${escapeHtml(totalBase.toFixed(2))} руб.\n`;
    reply += `• Заказов: ${escapeHtml(orderCount)}\n`;
    // Средний заработок за заказ БЕЗ КОРРЕКТИРОВОК
    reply += `• Средний заработок за заказ: ${escapeHtml((totalBase / orderCount).toFixed(2))} руб.\n`;
    if (adjustments !== 0) {
      reply += `• Корректировки: ${escapeHtml(adjustments > 0 ? '+' : '')}${escapeHtml(adjustments.toFixed(2))} руб.\n`;
    }
    // Средний заработок за заказ С КОРРЕКТИРОВКАМИ
    //    reply += `• Средний заработок за заказ: ${escapeHtml((totalWithAdjustments / orderCount).toFixed(2))} руб.\n`;
    reply += `• <b>Итого: ${escapeHtml(totalWithAdjustments.toFixed(2))} руб.</b>\n`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
  });

  // ---------------------- СПРАВОЧНЫЕ КОМАНДЫ ----------------------
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const isAdministrator = isAdmin(userId);
    const employee = await db.getEmployee(userId);

    // --- Администратор всегда получает полный доступ, даже если не в БД ---
    if (isAdministrator) {
      const { adminMessagePart1, adminMessagePart2 } = getAdminCommandsOnly(debugMode.isDebugMode());

      // Отправляем первую часть
      await bot.sendMessage(chatId, adminMessagePart1);

      // Небольшая задержка (300 мс) между сообщениями
      await new Promise(resolve => setTimeout(resolve, 300));

      // Отправляем вторую часть
      await bot.sendMessage(chatId, adminMessagePart2);
      return;
    }

    // --- Обычный сотрудник (есть в БД) ---
    if (employee) {
      const msg = getEmployeeCommandsOnly();
      await bot.sendMessage(chatId, msg);
      return;
    }

    // --- Неавторизованный пользователь ---
    await bot.sendMessage(chatId, getUnauthorizedMessage());
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

// ---------------------- ВОССТАНОВЛЕНИЕ СОСТОЯНИЙ ПОСЛЕ ПЕРЕЗАПУСКА ----------------------
async function restorePendingForms(db, ozon, bot) {
  console.log('[RESTORE] Начало восстановления состояний после перезапуска');

  try {
    const assignments = await db.db.all('SELECT order_id, employee_id FROM assignments WHERE status = "assigned"');
    console.log(`[RESTORE] Найдено активных назначений: ${assignments.length}`);
    for (const assign of assignments) {
      const employee = await db.getEmployeeById(assign.employee_id);
      if (!employee || employee.is_fired) continue;
      const userId = employee.tg_user_id;
      const orderId = assign.order_id;

      const key = `${userId}_${orderId}`;
      if (pendingForms.has(key)) continue; // уже есть состояние

      const orderDetails = await ozon.getOrderDetails(orderId);
      if (!orderDetails || !orderDetails.products) continue;

      const missingStats = [];
      for (const product of orderDetails.products) {
        const offerId = product.offer_id;
        if (!offerId) continue;
        const stats = await db.getProductStats(offerId);
        if (!stats) missingStats.push(offerId);
      }

      if (missingStats.length === 0) {
        console.log(`[RESTORE] Заказ ${orderId} пользователя ${userId} – статистика заполнена, отправляем кнопку`);
        // ВСЕ статистики заполнены – отправляем кнопку завершения
        // Создаём состояние с allCompleted: true (пустой offers)
        pendingForms.set(key, {
          orderId: orderId,
          offers: {},
          allCompleted: true
        });
        // Отправляем кнопку
        const finishKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Завершить заказ', callback_data: `finish_order_${orderId}` }]
            ]
          }
        };
        await bot.sendMessage(userId, `✅ Все данные для заказа ${orderId} заполнены. Теперь вы можете завершить заказ.`, finishKeyboard);
        console.log(`[RESTORE] Восстановлено состояние (заполнено) для заказа ${orderId} пользователя ${userId}`);
      } else {
        console.log(`[RESTORE] Заказ ${orderId} пользователя ${userId} – недостает статистики для: ${missingStats.join(', ')}`);
        // Есть недостающие статистики – создаём состояние для опроса (как раньше)
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
        pendingForms.set(key, {
          orderId: orderId,
          offers: offersState,
          allCompleted: false
        });
      }
    }
    console.log('[RESTORE] Восстановление завершено');
  } catch (err) {
    console.error('Ошибка восстановления состояний:', err);
  }
}

// ---------------------- ЦЕНТРАЛИЗОВАННАЯ ОЧИСТКА СОСТОЯНИЙ ЗАКАЗА ----------------------
async function clearOrderState(bot, orderId, userId = null) {
  console.log(`[CLEAR] Начало очистки заказа ${orderId}${userId ? ` для пользователя ${userId}` : ''}`);

  // 1. Очищаем pendingForms
  if (userId) {
    const key = `${userId}_${orderId}`;
    if (pendingForms.has(key)) {
      console.log(`[CLEAR] Удаляем состояние для ${key}`);
      const state = pendingForms.get(key);
      for (const offerId of Object.keys(state.offers)) {
        try { await bot.deleteMessage(userId, state.offers[offerId].messageId); } catch (e) { /* ignore */ }
        try { if (state.offers[offerId].stepMessageId) await bot.deleteMessage(userId, state.offers[offerId].stepMessageId); } catch (e) { /* ignore */ }
      }
      pendingForms.delete(key);
    } else {
      console.log(`[CLEAR] Состояние для ${key} не найдено`);
    }
  } else {
    // удаляем все записи для этого orderId
    let found = false;
    for (const [key, state] of pendingForms) {
      if (state.orderId === orderId) {
        console.log(`[CLEAR] Удаляем состояние для ${key}`);
        const uid = key.split('_')[0];
        for (const offerId of Object.keys(state.offers)) {
          try { await bot.deleteMessage(uid, state.offers[offerId].messageId); } catch (e) { /* ignore */ }
          try { if (state.offers[offerId].stepMessageId) await bot.deleteMessage(uid, state.offers[offerId].stepMessageId); } catch (e) { /* ignore */ }
        }
        pendingForms.delete(key);
        found = true;
        break;
      }
    }
    if (!found) console.log(`[CLEAR] Состояние для orderId ${orderId} не найдено`);
  }

  // 2. Очищаем pendingFinishConfirmations
  if (pendingFinishConfirmations.has(orderId)) {
    console.log(`[CLEAR] Удаляем pendingFinishConfirmations для ${orderId}`);
    const original = pendingFinishConfirmations.get(orderId);
    if (original) {
      try { await bot.deleteMessage(original.originalChatId, original.originalMessageId); } catch (e) { /* ignore */ }
    }
    pendingFinishConfirmations.delete(orderId);
  }

  // 3. Очищаем finishingOrders
  if (finishingOrders.has(orderId)) {
    console.log(`[CLEAR] Удаляем finishingOrders для ${orderId}`);
    finishingOrders.delete(orderId);
  }

  console.log(`[CLEAR] Завершена очистка заказа ${orderId}`);
}

/**
 * Очищает устаревшие записи из всех кулдаунов.
 * Записи старше максимального кулдауна (1 час) удаляются.
 */
function cleanCooldowns() {
  const now = Date.now();
  const maxCooldown = Math.max(
    LABEL_COOLDOWN_MS,                  // 1 минута
    SEND_ALL_LABELS_COOLDOWN_MS,        // 1 час
    SEND_ALL_LABELS_EMPTY_COOLDOWN_MS,  // 1 минута
    TOGGLE_ORDERS_COOLDOWN_MS           // 1 минута
  );

  let deleted = 0;
  for (const [key, time] of labelCooldowns) {
    if (now - time > maxCooldown) {
      labelCooldowns.delete(key);
      deleted++;
    }
  }
  for (const [key, time] of sendAllLabelsCooldowns) {
    if (now - time > maxCooldown) {
      sendAllLabelsCooldowns.delete(key);
      deleted++;
    }
  }
  for (const [key, time] of sendAllLabelsEmptyCooldowns) {
    if (now - time > maxCooldown) {
      sendAllLabelsEmptyCooldowns.delete(key);
      deleted++;
    }
  }
  for (const [key, time] of toggleOrdersCooldowns) {
    if (now - time > maxCooldown) {
      toggleOrdersCooldowns.delete(key);
      deleted++;
    }
  }
  if (deleted > 0) {
    console.log(`[COOLDOWN] Удалено ${deleted} устаревших записей кулдаунов`);
  }
}

// Экспорт
module.exports = {
  registerCommands,
  restorePendingForms,
  clearOrderState,
  escapeHtml,
  exportMonthlyEarnings,
  cleanCooldowns,
};