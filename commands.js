const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const axios = require('axios');
const bwipjs = require('bwip-js');
const { syncEmployeesFromExcel, exportTeamInfoXlsx, exportTeamInfoXlsxAll } = require('./syncEmployees');
const { getAdminCommandsOnly, getAdminStartMessage, getEmployeeCommandsOnly, getEmployeeStartMessage, getUnauthorizedMessage } = require('./helpText');
const { getVersionedFileName, mergePdfs, escapeHtml, stripHtml, formatLocalTimestamp, formatDateDDMMYYYY } = require('./utils');
const { finishingOrders, pendingFinishConfirmations } = require('./state');
require('dotenv').config();

// Локальные хранилища для состояний
const processingOrders = new Set();       // orderId -> заказ сейчас назначается
const orderAssignRetries = new Map();     // orderId -> количество попыток назначения
let pendingEmployeeUpload = new Map(); // userId -> { step: 'waiting_file' }
let pendingMaterialsUpload = new Map(); // userId -> { step: 'waiting_file' }
let pendingUploadModel = new Map(); // userId -> { step: 'waiting_file' }
let pendingForms = new Map(); // key: userId_orderId, value: { orderId, offers, allCompleted }
let pendingStatsFill = new Map(); // userId -> { offerId, step, data: { material, color, weight } }
let pendingOrderMessages = new Map(); // userId -> messageId
let pendingModelAdd = new Map();    // для /add_model
let pendingFileId = new Map();      // для /get_file_id
let materialsData = null;
let specialOffers = null; // для specialOffers в materials-prices.json

let labelCooldowns = new Map(); // userId -> timestamp последнего вызова /send_label
const LABEL_COOLDOWN_MS = 60 * 1000; // 1 минута

let sendAllLabelsCooldowns = new Map(); // длинный кулдаун (1 час)
const SEND_ALL_LABELS_COOLDOWN_MS = 3600 * 1000; // 1 час
let sendAllLabelsEmptyCooldowns = new Map(); // короткий кулдаун (1 минута)
const SEND_ALL_LABELS_EMPTY_COOLDOWN_MS = 60 * 1000; // 1 минута для пустого ответа

let toggleOrdersCooldowns = new Map(); // userId -> timestamp последнего вызова /toggle_orders
const TOGGLE_ORDERS_COOLDOWN_MS = 60 * 1000; // 1 минута

let MIN_EARNINGS = 250; // значение по умолчанию, перезаписывается при загрузке

const DISABLE_MODELS = process.env.DISABLE_MODELS === 'true';

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
  const baseName = getVersionedFileName('monthly_earnings');
  const fileName = `${baseName}_${monthStr || (new Date(fromDate).toISOString().slice(0, 7))}`;
  const outputPath = path.join(__dirname, 'outputs', fileName);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  console.log(`[EXPORT] Файл сохранён: ${outputPath}`);
  return outputPath;
}

// Загружаем справочники при старте
function loadMaterials() {
  const fileName = getVersionedFileName('materials-prices', '.json');
  try {
    const raw = fs.readFileSync(path.join(__dirname, fileName), 'utf8');

    const data = JSON.parse(raw);
    materialsData = data;
    // Загружаем специальные предложения
    specialOffers = data.specialOffers || null;
    // Обновляем MIN_EARNINGS из файла, если поле есть
    if (data.minEarnings !== undefined && typeof data.minEarnings === 'number') {
      MIN_EARNINGS = data.minEarnings;
    } else {
      MIN_EARNINGS = 250; // значение по умолчанию
    }
    console.log(`✅ Конфигурация цветов материалов и цен за грамм загружена. MIN_EARNINGS = ${MIN_EARNINGS}`);
    if (specialOffers) {
      console.log(`✅ Загружено специальных предложений: ${Object.keys(specialOffers).length}`);
    }
  } catch (err) {
    console.error(`❌ Ошибка загрузки ${fileName}:`, err.message);
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
  showOrderMenu, safeCheckAndOfferNewOrders,
  safeProcessNextOrder, orderState,
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
        const fileName = getVersionedFileName('product-stats', '.xlsx');
        const outputPath = path.join(__dirname, 'exports', fileName);
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

      let earningsPerUnit = 0;
      let isSpecial = false;

      // 1. Проверяем специальное предложение
      if (specialOffers && specialOffers[offerId] !== undefined) {
        earningsPerUnit = specialOffers[offerId] * factor;
        isSpecial = true;
        // Для специальных предложений не нужна статистика
        earningsDetails.push({
          offerId,
          productName: product.name,
          material: 'Спецпредложение',
          weight: 0,
          quantity: product.quantity || 1,
          earningsPerUnit,
          totalForProduct: earningsPerUnit * (product.quantity || 1),
          isSpecial: true
        });
        totalEarnings += earningsPerUnit * (product.quantity || 1);
        continue;
      }

      // 2. Обычный расчёт по статистике
      const stats = await db.getProductStats(offerId);
      if (!stats) {
        allHaveStats = false;
        console.warn(`[EARN] Для товара ${offerId} нет статистики, пропускаем`);
        continue;
      }
      const materialPrice = materialsData.materials[stats.material] || 0;
      const weight = stats.weight_grams || 0;
      let earningsPerUnitCalc = materialPrice * weight;
      if (earningsPerUnitCalc < MIN_EARNINGS) earningsPerUnitCalc = MIN_EARNINGS;
      earningsPerUnit = earningsPerUnitCalc * factor;
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
        totalForProduct,
        isSpecial: false
      });
    }

    return { total: totalEarnings, details: earningsDetails, allHaveStats };
  }

  /**
 * Форматирует детали заказа в HTML-строку для отправки.
 * @param {Object} details - объект, возвращённый ozon.getOrderDetails()
 * @param {Object} db - объект базы данных для получения названия склада (опционально)
 * @returns {Promise<string>} - строка с HTML-разметкой
 */
  async function formatOrderDetails(details, db = null) {
    let reply = `📄 <b>Детали заказа <code>${escapeHtml(details.posting_number)}</code></b>\n\n`;

    // Основная информация
    if (details.substatus) {
      reply += `Статус: (${escapeHtml(details.substatus)})\n`;
    }
    if (details.order_number) {
      reply += `<b>Номер заказа:</b> <code>${escapeHtml(details.order_number)}</code>\n`;
    }
    if (details.delivery_method) {
      reply += `<b>Метод доставки:</b> ${escapeHtml(details.delivery_method.name || '—')}\n`;
      if (details.delivery_method.warehouse_id && db) {
        const warehouseName = await db.getWarehouseNameById(String(details.delivery_method.warehouse_id));
        reply += `<b>Склад:</b> ${escapeHtml(warehouseName)} (ID: <code>${escapeHtml(details.delivery_method.warehouse_id)}</code>)\n`;
      } else if (details.delivery_method.warehouse_id) {
        reply += `<b>Склад ID:</b> <code>${escapeHtml(details.delivery_method.warehouse_id)}</code>\n`;
      }
    }

    // Товары
    if (details.products && details.products.length) {
      reply += `\n<b>Товары:</b>\n`;
      for (let i = 0; i < details.products.length; i++) {
        const p = details.products[i];
        reply += `${i + 1}. ${escapeHtml(p.name || '—')}`;
        if (p.sku) reply += ` (<b>SKU:</b> <code>${escapeHtml(p.sku)}</code>)`;
        if (p.offer_id) reply += `, <b>offer_id:</b> <code>${escapeHtml(p.offer_id)}</code>`;
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
      if (details.customer.phone) {
        reply += `, тел: ${escapeHtml(details.customer.phone)}`;
      }
      reply += `\n`;
      if (details.customer.address) {
        const addr = details.customer.address;
        let addrStr = '';
        if (addr.address_tail) addrStr += addr.address_tail;
        if (addr.city) addrStr += (addrStr ? ', ' : '') + addr.city;
        if (addr.region) addrStr += (addrStr ? ', ' : '') + addr.region;
        if (addr.zip_code) addrStr += (addrStr ? ', ' : '') + addr.zip_code;
        if (addrStr) {
          reply += `<b>Адрес:</b> ${escapeHtml(addrStr)}\n`;
        }
      }
    }

    // Дополнительно
    if (details.tracking_number) {
      reply += `\n<b>Трек-номер:</b> ${escapeHtml(details.tracking_number)}\n`;
    }
    if (details.in_process_at) {
      const date = new Date(details.in_process_at).toLocaleString();
      reply += `\n<b>Дата создания:</b> ${escapeHtml(date)}\n`;
    }

    return reply;
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

  // ======================================================================================================
  // ---------------------- ЕДИНЫЙ ОБРАБОТЧИК CALLBACK_QUERY (с немедленным ответом) ---------------------- 
  // ======================================================================================================
  bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id.toString();

    // 1. НЕМЕДЛЕННЫЙ ОТВЕТ TELEGRAM (для всех callback)
    try {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: '⏳ Обрабатываю запрос...',
        show_alert: false
      });
    } catch (err) {
      // Если callback уже протух – просто логируем, но не прерываем работу
      console.warn(`[CALLBACK] Не удалось ответить на callback ${callbackQuery.id}:`, err.message);
    }

    // 2. ОСНОВНАЯ ЛОГИКА (теперь можно выполнять долгие операции)
    try {
      // ---------------------- ПРОВЕРКА АВТОРИЗАЦИИ (сотрудник) ----------------------
      const isAuthorized = await isAuthorizedUser(userId);
      if (!isAuthorized) {
        await bot.sendMessage(
          msg.chat.id,
          '⛔ Вы не авторизованы как сотрудник.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      // ---------------------- КОМАНДЫ СОТРУДНИКОВ ----------------------

      // Подтверждение завершения заказа сотрудником
      if (data.startsWith('finish_order_')) {
        const orderId = data.substring(13);
        const employee = await db.getEmployee(userId);
        if (!employee) {
          await bot.sendMessage(msg.chat.id, '❌ Вы не зарегистрированы как сотрудник.', { parse_mode: 'HTML' });
          return;
        }
        const assignment = await db.db.get(
          'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "assigned"',
          orderId, employee.id
        );
        if (!assignment) {
          await bot.sendMessage(msg.chat.id, `❌ Заказ <code>${escapeHtml(orderId)}</code> не найден или не ваш.`, { parse_mode: 'HTML' });
          return;
        }

        // Проверка статистики
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
              await bot.sendMessage(msg.chat.id, `❌ Отсутствует статистика для: ${missingList}`, { parse_mode: 'HTML' });
              return;
            }
          }
        } catch (err) {
          console.error('Ошибка проверки статистики в callback:', err);
          await bot.sendMessage(msg.chat.id, '❌ Ошибка проверки статистики', { parse_mode: 'HTML' });
          return;
        }

        // Проверка состояния pendingForms
        const key = `${userId}_${orderId}`;
        const state = pendingForms.get(key);
        if (state && state.orderId === orderId && !state.allCompleted) {
          await bot.sendMessage(msg.chat.id, '❌ Сначала заполните статистику для всех товаров.', { parse_mode: 'HTML' });
          return;
        }

        // Сохраняем состояние для подтверждения
        pendingFinishConfirmations.set(orderId, {
          originalChatId: callbackQuery.message.chat.id,
          originalMessageId: callbackQuery.message.message_id,
          startedAt: Date.now()
        });

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
        await bot.sendMessage(msg.chat.id, `⚠️ Вы действительно хотите завершить заказ <code>${escapeHtml(orderId)}</code>?`, {
          parse_mode: 'HTML',
          ...confirmKeyboard
        });
        return;
      }

      // Подтверждение завершения (confirm_finish_)
      if (data.startsWith('confirm_finish_')) {
        const orderId = data.substring(15);
        const employee = await db.getEmployee(userId);
        if (!employee) {
          await bot.sendMessage(msg.chat.id, '❌ Сотрудник не найден.', { parse_mode: 'HTML' });
          return;
        }

        if (finishingOrders.has(orderId)) {
          await bot.sendMessage(msg.chat.id, '⏳ Заказ уже завершается, подождите...', { parse_mode: 'HTML' });
          return;
        }
        finishingOrders.set(orderId, { startedAt: Date.now(), userId });

        try {
          await finishOrder(msg.chat.id, orderId, employee);

          const original = pendingFinishConfirmations.get(orderId);
          if (original) {
            try {
              await bot.deleteMessage(original.originalChatId, original.originalMessageId);
            } catch (err) { /* ignore */ }
            pendingFinishConfirmations.delete(orderId);
          }
          try {
            await bot.deleteMessage(msg.chat.id, msg.message_id);
          } catch (err) { /* ignore */ }

          // Уведомление уже отправлено внутри finishOrder, но можно добавить ещё
          await bot.sendMessage(msg.chat.id, `✅ Заказ <code>${escapeHtml(orderId)}</code> завершён.`, { parse_mode: 'HTML' });
        } catch (err) {
          console.error('Ошибка завершения заказа из callback:', err);
          await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
        } finally {
          finishingOrders.delete(orderId);
        }
        return;
      }

      // Отмена завершения (cancel_finish_)
      if (data.startsWith('cancel_finish_')) {
        const orderId = data.substring(14);
        try {
          await bot.deleteMessage(msg.chat.id, msg.message_id);
        } catch (err) { /* ignore */ }
        pendingFinishConfirmations.delete(orderId);
        await bot.sendMessage(msg.chat.id, '✅ Отменено', { parse_mode: 'HTML' });
        return;
      }

      // --- Заполнение материала ---
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
        } else {
          await bot.sendMessage(msg.chat.id, '❌ Ошибка: состояние не найдено', { parse_mode: 'HTML' });
        }
        return;
      }

      // --- Заполнение цвета ---
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
        } else {
          await bot.sendMessage(msg.chat.id, '❌ Ошибка: состояние не найдено', { parse_mode: 'HTML' });
        }
        return;
      }

      // --- Заполнить статистику (параллельный опрос) ---
      if (data.startsWith('fill_stats_')) {
        const parts = data.split('_');
        const orderId = parts[2];
        const offerId = parts[3];
        const key = `${userId}_${orderId}`;
        const state = pendingForms.get(key);
        if (!state) {
          await bot.sendMessage(msg.chat.id, '❌ Ошибка: состояние не найдено.', { parse_mode: 'HTML' });
          return;
        }
        const offerState = state.offers[offerId];
        if (!offerState) {
          await bot.sendMessage(msg.chat.id, '❌ Ошибка: товар не найден.', { parse_mode: 'HTML' });
          return;
        }

        const existingStats = await db.getProductStats(offerId);
        if (existingStats) {
          await bot.sendMessage(msg.chat.id, `⚠️ Статистика для товара <code>${escapeHtml(offerId)}</code> уже существует.`, { parse_mode: 'HTML' });

          if (offerState.stepMessageId) {
            try { await bot.deleteMessage(userId, offerState.stepMessageId); } catch (e) { }
          }
          if (offerState.messageId) {
            try { await bot.deleteMessage(userId, offerState.messageId); } catch (e) { }
          }
          // msg.message_id — сообщение с callback-кнопкой
          try { await bot.deleteMessage(userId, msg.message_id); } catch (e) { }

          // Статистика уже существует — считаем товар завершённым
          offerState.status = 'completed';
          offerState.waitingForWeight = false;

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
          return;
        }

        if (offerState.status === 'not_started') {
          await disableKeyboard(userId, offerState.messageId);
          await askMaterial(userId, offerId, orderId);
        } else if (offerState.status === 'material_selected') {
          await askColor(userId, offerId, orderId);
        } else if (offerState.status === 'color_selected' || offerState.status === 'weight_entered') {
          await askWeight(userId, offerId, orderId);
        } else if (offerState.status === 'completed') {
          await bot.sendMessage(msg.chat.id, '✅ Статистика уже заполнена.', { parse_mode: 'HTML' });
        } else {
          await bot.sendMessage(msg.chat.id, '❌ Неизвестный статус.', { parse_mode: 'HTML' });
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
          await bot.sendMessage(msg.chat.id, '❌ Ошибка: состояние не найдено', { parse_mode: 'HTML' });
          return;
        }
        const offerState = state.offers[offerId];
        if (!offerState) {
          await bot.sendMessage(msg.chat.id, '❌ Товар не найден', { parse_mode: 'HTML' });
          return;
        }
        if (offerState.stepMessageId) {
          try { await bot.deleteMessage(userId, offerState.stepMessageId); } catch (e) { }
          offerState.stepMessageId = null;
        }
        offerState.material = null;
        offerState.color = null;
        offerState.weight = null;
        offerState.status = 'not_started';
        offerState.waitingForWeight = false;
        await askMaterial(userId, offerId, orderId);
        await bot.sendMessage(msg.chat.id, '🔄 Опрос сброшен', { parse_mode: 'HTML' });
        return;
      }

      // Подтверждение отмены заказа сотрудником
      if (data.startsWith('confirm_cancel_')) {
        const orderId = data.substring(15);
        console.log(`[CONFIRM_CANCEL] Попытка отмены заказа ${orderId} от пользователя ${userId}`);
        const employee = await db.getEmployee(userId);
        if (!employee) {
          await bot.sendMessage(msg.chat.id, '❌ Сотрудник не найден', { parse_mode: 'HTML' });
          return;
        }
        try {
          await clearOrderState(bot, orderId, userId);
          await db.cancelOrder(orderId, employee.id);
          if (orderState.currentOrderProcessing && orderState.currentOrderProcessing.order.posting_number === orderId) {
            orderState.currentOrderProcessing = null;
          }
          await bot.editMessageText(
            `✅ Заказ <code>${escapeHtml(orderId)}</code> отменён.`,
            { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' }
          );
          await bot.sendMessage(msg.chat.id, `✅ Заказ <code>${escapeHtml(orderId)}</code> отменён.`, { parse_mode: 'HTML' });

          const moderatorId = process.env.MODERATOR_ID;
          if (moderatorId) {
            await bot.sendMessage(
              moderatorId,
              `📦 Сотрудник <b>${escapeHtml(employee.name)}</b> отменил заказ <code>${escapeHtml(orderId)}</code>. Заказ возвращён в очередь.`,
              { parse_mode: 'HTML' }
            );
          }
          await safeCheckAndOfferNewOrders();
          if (!orderState.currentOrderProcessing && orderState.pendingNewOrders.length) {
            await safeProcessNextOrder();
          }
        } catch (err) {
          console.error(`[CONFIRM_CANCEL] Ошибка:`, err.message);
          await bot.sendMessage(msg.chat.id, `❌ ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }

      // Кнопка "Нет" (отклонение отмены заказа)
      if (data.startsWith('cancel_cancel_')) {
        await safeDeleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, '✅ Отмена отклонена', { parse_mode: 'HTML' });
        return;
      }

      // ---------------------- КОМАНДЫ ДЛЯ АДМИНОВ/МОДЕРАТОРОВ ----------------------

      if (!isAdmin(userId)) {
        await bot.sendMessage(msg.chat.id, '⛔ Нет прав', { parse_mode: 'HTML' });
        return;
      }

      if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
        updateModeratorActivity();
      }

      if (debugMode.isDebugMode()) console.log(`[CALLBACK] admin ${userId} вызвал ${data}`);

      // Пропуск заказа
      if (data.startsWith('skip_')) {
        if (!isModerator(userId)) {
          await bot.sendMessage(msg.chat.id, '⛔ Только модератор', { parse_mode: 'HTML' });
          return;
        }
        console.log(`[SKIP] Получен пропуск заказа ${data.substring(5)} от модератора ${userId}`);
        const orderId = data.substring(5);
        const index = orderState.pendingNewOrders.findIndex(o => o.posting_number === orderId);
        if (index !== -1) orderState.pendingNewOrders.splice(index, 1);
        if (orderState.currentOrderProcessing && orderState.currentOrderProcessing.order.posting_number === orderId) {
          orderState.currentOrderProcessing = null;
        }
        await safeDeleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, `✅ Заказ <code>${escapeHtml(orderId)}</code> пропущен.`, { parse_mode: 'HTML' });
        if (typeof safeProcessNextOrder === 'function') safeProcessNextOrder();
        return;
      }

      // Показать приоритетных сотрудников
      if (data.startsWith('priority_')) {
        if (!isModerator(userId)) {
          await bot.sendMessage(msg.chat.id, '⛔ Только модератор', { parse_mode: 'HTML' });
          return;
        }
        const orderId = data.substring(9);
        let orderDetails;
        try {
          orderDetails = await ozon.getOrderDetails(orderId);
        } catch (err) {
          console.error(`[PRIORITY] Ошибка получения деталей заказа ${orderId}:`, err);
          await bot.sendMessage(msg.chat.id, '❌ Ошибка получения заказа', { parse_mode: 'HTML' });
          return;
        }
        if (!orderDetails || orderDetails.status !== 'awaiting_packaging') {
          await bot.sendMessage(msg.chat.id, '❌ Заказ не в статусе awaiting_packaging', { parse_mode: 'HTML' });
          return;
        }

        const warehouseId = orderDetails.delivery_method?.warehouse_id
          ? String(orderDetails.delivery_method.warehouse_id)
          : null;

        let employees = await db.getAllEmployeesWithStats(warehouseId, false, false);
        const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
        if (GOD_ID) {
          employees = employees.filter(emp => emp.tg_user_id !== GOD_ID);
        }

        const header = '👑 Приоритетные сотрудники (по складу):';
        if (!employees.length) {
          await bot.sendMessage(msg.chat.id, 'Нет доступных сотрудников', { parse_mode: 'HTML' });
          return;
        }

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
        return;
      }

      // Показать всех сотрудников
      if (data.startsWith('others_')) {
        if (!isModerator(userId)) {
          await bot.sendMessage(msg.chat.id, '⛔ Только модератор', { parse_mode: 'HTML' });
          return;
        }
        const orderId = data.substring(7);
        let orderDetails;
        try {
          orderDetails = await ozon.getOrderDetails(orderId);
        } catch (err) {
          console.error(`[OTHERS] Ошибка получения деталей заказа ${orderId}:`, err);
          await bot.sendMessage(msg.chat.id, '❌ Ошибка получения заказа', { parse_mode: 'HTML' });
          return;
        }
        if (!orderDetails || orderDetails.status !== 'awaiting_packaging') {
          await bot.sendMessage(msg.chat.id, '❌ Заказ не в статусе awaiting_packaging', { parse_mode: 'HTML' });
          return;
        }

        let employees = await db.getAllEmployeesWithStats(null, false, false);
        const GOD_ID = process.env.GOD_ID ? process.env.GOD_ID.toString() : null;
        if (GOD_ID) {
          employees = employees.filter(emp => emp.tg_user_id !== GOD_ID);
        }

        const header = '👥 Все сотрудники:';
        if (!employees.length) {
          await bot.sendMessage(msg.chat.id, 'Нет доступных сотрудников', { parse_mode: 'HTML' });
          return;
        }
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
        return;
      }

      // Назначение заказа (assign_)
      if (data.startsWith('assign_')) {
        const parts = data.split('_');
        const orderId = parts[1];
        const employeeId = parseInt(parts[2]);

        try {
          await assignOrder(orderId, employeeId, msg.chat.id);
          await safeDeleteMessage(msg.chat.id, msg.message_id);
          // Запускаем следующий заказ
          await safeProcessNextOrder();
        } catch (err) {
          console.error(`[ASSIGN] Ошибка назначения ${orderId}:`, err);
          // Ошибка уже отправлена пользователю внутри assignOrder
        }
        return;
      }

      // Кнопка "Назад"
      if (data.startsWith('back_')) {
        const orderId = data.substring(5);
        await safeDeleteMessage(msg.chat.id, msg.message_id);
        const order = await ozon.fetchAwaitingOrdersById(orderId);
        if (order && typeof showOrderMenu === 'function') {
          await showOrderMenu(order);
        }
        return;
      }

      // Сброс всех назначений (подтверждение)
      if (data === 'confirm_clear_all') {
        await db.db.run('DELETE FROM assignments WHERE status = "assigned"');
        const orderIds = Array.from(pendingForms.values()).map(state => state.orderId);
        for (const orderId of orderIds) {
          await clearOrderState(bot, orderId);
        }
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
        await bot.sendMessage(msg.chat.id, '✅ Все активные назначения сброшены.', { parse_mode: 'HTML' });
        return;
      }
      if (data === 'cancel_clear_all') {
        await safeDeleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, '✅ Сброс отменён', { parse_mode: 'HTML' });
        return;
      }

      // Снятие заказа администратором (подтверждение)
      if (data.startsWith('admin_cancel_confirm_')) {
        const orderId = data.substring(21);
        const assignment = await db.db.get('SELECT employee_id FROM assignments WHERE order_id = ? AND status = "assigned"', orderId);
        let employee = null;
        if (assignment) {
          employee = await db.getEmployeeById(assignment.employee_id);
          await clearOrderState(bot, orderId, employee.tg_user_id);
        }
        await db.db.run('DELETE FROM assignments WHERE order_id = ? AND status = "assigned"', orderId);
        console.log(`[ADMIN] Снят заказ ${orderId} с сотрудника`);

        if (employee) {
          try {
            await bot.sendMessage(
              employee.tg_user_id,
              `⛔ Заказ <code>${escapeHtml(orderId)}</code> был снят с вас администратором.`,
              { parse_mode: 'HTML' }
            );
          } catch (e) {
            console.warn(`[ADMIN_CANCEL] Не удалось уведомить сотрудника ${employee.tg_user_id}:`, e.message);
          }
        }

        const idx = orderState.pendingNewOrders.findIndex(o => o.posting_number === orderId);
        if (idx !== -1) orderState.pendingNewOrders.splice(idx, 1);
        if (orderState.currentOrderProcessing && orderState.currentOrderProcessing.order.posting_number === orderId) {
          orderState.currentOrderProcessing = null;
        }

        await bot.editMessageText(`✅ Заказ <code>${escapeHtml(orderId)}</code> снят с сотрудника и возвращён в очередь.`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: 'HTML'
        });
        await bot.sendMessage(msg.chat.id, `✅ Заказ <code>${escapeHtml(orderId)}</code> снят.`, { parse_mode: 'HTML' });

        await safeCheckAndOfferNewOrders();
        if (!orderState.currentOrderProcessing && orderState.pendingNewOrders.length) {
          await safeProcessNextOrder();
        }
        return;
      }

      if (data.startsWith('admin_cancel_abort_')) {
        await safeDeleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, '✅ Снятие заказа отменено', { parse_mode: 'HTML' });
        return;
      }

      // Обработка подтверждения расчёта сотрудника
      if (data.startsWith('confirm_settle_')) {
        const employeeId = parseInt(data.substring(16));
        await db.clearActiveEarningsForEmployee(employeeId);
        await db.clearActiveAdjustmentsForEmployee(employeeId);
        await bot.editMessageText(`✅ Расчёт с сотрудником (ID ${employeeId}) произведён. Активный заработок обнулён.`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        await bot.sendMessage(msg.chat.id, `✅ Активный заработок сотрудника (ID ${employeeId}) обнулён.`, { parse_mode: 'HTML' });
        return;
      }

      if (data.startsWith('cancel_settle_')) {
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, '✅ Отменено', { parse_mode: 'HTML' });
        return;
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
          await bot.sendMessage(msg.chat.id, '✅ Все записи о заработке удалены.', { parse_mode: 'HTML' });
        } catch (err) {
          await dbConn.run('ROLLBACK');
          console.error('[CLEAR_EARNINGS] Ошибка:', err);
          await bot.editMessageText(`❌ Ошибка: ${escapeHtml(err.message)}`, {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: 'HTML'
          });
          await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }

      if (data === 'cancel_clear_earnings') {
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, '✅ Отменено', { parse_mode: 'HTML' });
        return;
      }

      // Подтверждение удаления из акций
      if (data === 'confirm_remove_promotions') {
        if (!isAdmin(userId)) {
          await bot.sendMessage(msg.chat.id, '⛔ Нет прав', { parse_mode: 'HTML' });
          return;
        }
        await bot.editMessageText('🔄 Начинаю удаление товаров из всех акций...', {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        });
        try {
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
          await bot.sendMessage(msg.chat.id, `✅ Удаление завершено.`, { parse_mode: 'HTML' });
        } catch (err) {
          console.error('[REMOVE_PROMOTIONS] Ошибка:', err);
          await bot.editMessageText(`❌ Ошибка: ${escapeHtml(err.message)}`, {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: 'HTML'
          });
          await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }

      if (data === 'cancel_remove_promotions') {
        await bot.deleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, '✅ Операция отменена', { parse_mode: 'HTML' });
        return;
      }

      // Сброс всех данных (кроме моделей и сотрудников) и синхронизация — подтверждение
      if (data === 'confirm_full_reset_sync') {
        try {
          const dbConn = db.db;
          await dbConn.run('BEGIN TRANSACTION');
          await dbConn.run('DELETE FROM assignments');
          await dbConn.run('DELETE FROM employee_warehouses');
          await dbConn.run('DELETE FROM employee_stats');
          await dbConn.run('DELETE FROM warehouses');
          await dbConn.run("DELETE FROM sqlite_sequence WHERE name IN ('assignments', 'employee_warehouses', 'employee_stats', 'warehouses')");
          await dbConn.run('UPDATE employees SET is_fired = 1');
          await dbConn.run('COMMIT');

          orderState.pendingNewOrders.length = 0;
          orderState.currentOrderProcessing = null;
          if (typeof deleteLastOrderMessages === 'function') {
            await deleteLastOrderMessages();
          }

          const orderIds = Array.from(pendingForms.values()).map(state => state.orderId);
          for (const orderId of orderIds) {
            await clearOrderState(bot, orderId);
          }
          for (const orderId of pendingFinishConfirmations.keys()) {
            await clearOrderState(bot, orderId);
          }
          for (const orderId of finishingOrders.keys()) {
            await clearOrderState(bot, orderId);
          }

          const warehouses = await ozon.fetchWarehousesFromOzon();
          if (warehouses.length) await db.syncWarehouses(warehouses);
          await syncEmployeesFromExcel(db);
          await safeCheckAndOfferNewOrders();
          if (orderState.pendingNewOrders.length) {
            orderState.currentOrderProcessing = null;
            await safeProcessNextOrder();
          }

          await bot.editMessageText('✅ Полный сброс (кроме сотрудников и их заработка) и синхронизация выполнены. Очередь заказов обновлена.', {
            chat_id: msg.chat.id,
            message_id: msg.message_id
          });
          await bot.sendMessage(msg.chat.id, '✅ Полный сброс выполнен.', { parse_mode: 'HTML' });
        } catch (err) {
          await dbConn.run('ROLLBACK');
          console.error('[FULL_RESET_SYNC] Ошибка:', err);
          await bot.editMessageText(`❌ Ошибка: ${escapeHtml(err.message)}`, {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: 'HTML'
          });
          await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }

      if (data === 'cancel_full_reset_sync') {
        await safeDeleteMessage(msg.chat.id, msg.message_id);
        await bot.sendMessage(msg.chat.id, '✅ Отменено', { parse_mode: 'HTML' });
        return;
      }

      // --- Администратор: выбор материала ---
      if (data.startsWith('admin_mat_')) {
        const parts = data.split('_');
        const offerId = parts[2];
        const material = parts.slice(3).join('_');
        const state = pendingStatsFill.get(userId);
        if (!state) {
          await bot.sendMessage(msg.chat.id, '❌ Состояние не найдено', { parse_mode: 'HTML' });
          return;
        }
        if (state.offerId !== offerId) {
          await bot.sendMessage(msg.chat.id, '❌ Неверный артикул', { parse_mode: 'HTML' });
          return;
        }
        state.data.material = material;
        state.step = 2;
        await askAdminColor(userId, offerId);
        return;
      }

      // --- Администратор: выбор цвета ---
      if (data.startsWith('admin_color_')) {
        const parts = data.split('_');
        const offerId = parts[2];
        const color = parts.slice(3).join('_');
        const state = pendingStatsFill.get(userId);
        if (!state) {
          await bot.sendMessage(msg.chat.id, '❌ Состояние не найдено', { parse_mode: 'HTML' });
          return;
        }
        if (state.offerId !== offerId) {
          await bot.sendMessage(msg.chat.id, '❌ Неверный артикул', { parse_mode: 'HTML' });
          return;
        }
        state.data.color = color;
        state.step = 3;
        await askAdminWeight(userId, offerId);
        return;
      }

      // --- Администратор: отмена заполнения (из кнопки) ---
      if (data === 'admin_cancel_stats') {
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
          } catch (e) { /* ignore */ }
          await bot.sendMessage(msg.chat.id, '❌ Процесс заполнения статистики отменён.', { parse_mode: 'HTML' });
        } else {
          await bot.sendMessage(msg.chat.id, '❌ Нет активного процесса', { parse_mode: 'HTML' });
        }
        return;
      }

      // Если ни одно условие не сработало, просто завершаем
      console.warn(`[CALLBACK] Неизвестный callback: ${data}`);

    } catch (err) {
      // Общий обработчик ошибок
      console.error('[CALLBACK] Ошибка обработки callback:', err);
      try {
        await bot.sendMessage(
          msg.chat.id,
          `❌ Внутренняя ошибка: ${escapeHtml(err.message)}`,
          { parse_mode: 'HTML' }
        );
      } catch (e) { /* ignore */ }
    }
  });


  // =================================================================================
  // ---------------------- ОБЩАЯ ФУНКЦИЯ ДЛЯ ЗАВЕРШЕНИЯ ЗАКАЗА ----------------------
  // =================================================================================
  async function finishOrder(chatId, postingNumber, employee) {
    console.log(`[FINISH] === Начало завершения заказа ${postingNumber} сотрудником ${employee.name} (ID ${employee.id}) ===`);
    let transactionCompleted = false;
    try {
      // Проверяем, что заказ ещё активен
      const assignment = await db.db.get(
        'SELECT status FROM assignments WHERE order_id = ? AND status = "assigned"',
        postingNumber
      );
      if (!assignment) {
        console.log(`[FINISH] Заказ ${postingNumber} уже завершён или не найден`);
        await bot.sendMessage(
          chatId,
          `⚠️ Заказ <code>${escapeHtml(postingNumber)}</code> уже завершён или не найден.`,
          { parse_mode: 'HTML' }
        );
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

        transactionCompleted = true;

        console.log(`[FINISH] Транзакция успешно закоммичена для заказа ${postingNumber}`);
      } catch (txError) {
        await dbConn.run('ROLLBACK');
        console.error(`[FINISH] Ошибка в транзакции для заказа ${postingNumber}:`, txError);
        throw txError; // пробрасываем, чтобы обработать в catch внешнего блока
      }
      // ===================================

      // 4. Отправляем этикетку (после успешной транзакции)
      try {
        if (labelBuffer) {
          await bot.sendDocument(
            chatId,
            labelBuffer,
            {
              caption: `✅ Этикетка для заказа <code>${escapeHtml(postingNumber)}</code>`,
              parse_mode: 'HTML'
            },
            {
              filename: `label_${postingNumber}.pdf`,
              contentType: 'application/pdf'
            }
          );
        } else {
          await bot.sendMessage(
            chatId,
            `✅ Заказ <code>${escapeHtml(postingNumber)}</code> подтверждён. Этикетку можно скачать в личном кабинете Ozon.`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (notifyErr) {
        console.error(
          `[FINISH] Заказ ${postingNumber} завершён, ` +
          `но не удалось отправить этикетку/уведомление:`,
          notifyErr
        );
      }

      // 5. Отправляем детализацию заработка сотруднику (если есть)
      if (earningsData && earningsData.details && earningsData.details.length) {
        let msg = `💰 <b>Заработок за заказ ${escapeHtml(postingNumber)}</b>\n\n`;
        for (const item of earningsData.details) {
          msg += `• ${escapeHtml(item.productName)} (<code>${escapeHtml(item.offerId)}</code>)\n`;
          if (item.isSpecial) {
            msg += `  Специальная цена: ${escapeHtml(item.earningsPerUnit.toFixed(2))} руб./шт\n`;
          } else {
            msg += `  Материал: ${escapeHtml(item.material)}, Вес: ${escapeHtml(item.weight)} г/шт, Кол-во: ${escapeHtml(item.quantity)} шт\n`;
          }
          msg += `  Заработок за единицу: ${escapeHtml(item.earningsPerUnit.toFixed(2))} руб., Итого: ${escapeHtml(item.totalForProduct.toFixed(2))} руб.\n`;
        }
        msg += `\n<b>Итого: ${escapeHtml(earningsData.total.toFixed(2))} руб.</b>`;
        await bot.sendMessage(employee.tg_user_id, msg, { parse_mode: 'HTML' });
      }

      // 6. Уведомляем модератора
      const moderatorId = process.env.MODERATOR_ID;
      if (moderatorId) {
        await bot.sendMessage(
          moderatorId,
          `📦 Сотрудник <b>${escapeHtml(employee.name)}</b> завершил заказ <code>${escapeHtml(postingNumber)}</code>.`,
          { parse_mode: 'HTML' }
        );
      }

      console.log(`[FINISH] Заказ ${postingNumber} успешно завершён, вызываем очистку состояний`);
      await clearOrderState(bot, postingNumber, employee.tg_user_id);
      console.log(`[FINISH] === Выполнено завершение заказа ${postingNumber} ===`);
    } catch (err) {
      console.error(`[FINISH] Ошибка при завершении заказа ${postingNumber}:`, err);
      await bot.sendMessage(
        chatId,
        `❌ Не удалось подтвердить сборку заказа <code>${escapeHtml(postingNumber)}</code>: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
      // Всё равно пытаемся очистить состояние
      try {
        await clearOrderState(bot, postingNumber, employee.tg_user_id);
      } catch (clearErr) {
        console.error(`[FINISH] Ошибка при очистке состояний после ошибки:`, clearErr);
      }
    } finally {
      // ВСЕГДА удаляем флаги, даже если clearOrderState не сработал
      if (!transactionCompleted) {
        console.log(`[FINISH] Принудительно удаляем флаги для ${postingNumber}`);
        finishingOrders.delete(postingNumber);
        pendingFinishConfirmations.delete(postingNumber);
      }
      console.log(`[FINISH] Флаги для ${postingNumber} очищены (finally)`);
    }
  }


  // =================================================================================
  // ---------------------- ОБЩАЯ ФУНКЦИЯ ДЛЯ НАЗНАЧЕНИЯ ЗАКАЗА ----------------------
  // =================================================================================
  async function assignOrder(orderId, employeeId, adminChatId) {

    // 0. БЛОКИРОВКА

    if (processingOrders.has(orderId)) {
      console.log(`[ASSIGN] Заказ ${orderId} уже обрабатывается, пропускаем.`);

      if (adminChatId) {
        await bot.sendMessage(
          adminChatId,
          `⚠️ Заказ <code>${escapeHtml(orderId)}</code> уже обрабатывается, подождите.`,
          { parse_mode: 'HTML' }
        ).catch(() => { });
      }

      return {
        success: false,
        error: 'already_processing'
      };
    }

    processingOrders.add(orderId);

    console.log(
      `[ASSIGN] === Начало назначения заказа ${orderId} сотруднику ${employeeId} ===`
    );


    // 1. СОХРАНЯЕМ И УДАЛЯЕМ ЗАКАЗ ИЗ ОЧЕРЕДИ

    let queuedOrder = null;

    const queueIndex = orderState.pendingNewOrders.findIndex(
      o => o.posting_number === orderId
    );

    if (queueIndex !== -1) {
      queuedOrder = orderState.pendingNewOrders.splice(queueIndex, 1)[0];

      console.log(
        `[ASSIGN] Заказ ${orderId} удалён из pendingNewOrders`
      );
    }

    if (
      orderState.currentOrderProcessing &&
      orderState.currentOrderProcessing.order?.posting_number === orderId
    ) {
      orderState.currentOrderProcessing = null;

      console.log(
        `[ASSIGN] Сброшен currentOrderProcessing для ${orderId}`
      );
    }


    // 2. ПОДГОТОВКА

    let assignedInDb = false;
    let employee = null;
    let orderDetails = null;

    try {

      // Проверяем сотрудника
      employee = await db.getEmployeeById(employeeId);

      if (!employee) {
        throw new Error(
          `Сотрудник с ID ${employeeId} не найден.`
        );
      }

      if (employee.is_fired) {
        throw new Error(
          `Сотрудник ${employee.name} уволен и не может получать заказы.`
        );
      }


      // Проверяем возможность отправки сообщений
      try {
        await bot.sendChatAction(
          employee.tg_user_id,
          'typing'
        );
      } catch (err) {
        throw new Error(
          `Сотрудник ${employee.name} не начал диалог с ботом. ` +
          `Попросите его написать /start.`
        );
      }


      // Получаем детали заказа
      orderDetails = await ozon.getOrderDetails(orderId);

      if (!orderDetails) {
        throw new Error(
          `Не удалось получить детали заказа ${orderId}.`
        );
      }


      // Очищаем старые состояния
      await clearOrderState(bot, orderId);


      // 3. НАЗНАЧЕНИЕ В БД

      await db.assignOrderToEmployee(
        orderId,
        employeeId
      );

      assignedInDb = true;

      console.log(
        `[ASSIGN] Заказ ${orderId} записан в БД за сотрудником ${employee.name}`
      );


      // 4. ПРОВЕРКА СТАТИСТИКИ

      const missingStats = [];

      for (const product of orderDetails.products || []) {
        const offerId = product.offer_id;

        if (!offerId) continue;

        const stats = await db.getProductStats(offerId);

        if (!stats) {
          missingStats.push(offerId);
        }
      }


      // 5. ФОРМИРОВАНИЕ СООБЩЕНИЯ

      let detailsText = '';
      let statsText = '';
      const skuList = [];

      if (orderDetails.products?.length) {

        const items = orderDetails.products
          .map(p => `${p.name} — ${p.quantity} шт.`)
          .join('\n');

        detailsText = `\nСостав:\n${items}`;

        for (const product of orderDetails.products) {

          if (product.sku) {
            skuList.push(product.sku);
          }

          const offerId = product.offer_id;

          if (!offerId) continue;

          const stats = await db.getProductStats(offerId);

          if (stats) {
            statsText +=
              `\n${escapeHtml(product.name)} — ` +
              `Материал: <b>${escapeHtml(stats.material)}</b>, ` +
              `Цвет: <b>${escapeHtml(stats.color)}</b>`;
          }
        }

        if (statsText) {
          statsText =
            '\n\n<b>Статистика товаров:</b>' +
            statsText;
        }
      }


      // 6. КНОПКА ЗАВЕРШЕНИЯ

      let finishKeyboard = null;

      if (missingStats.length === 0) {
        finishKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{
                text: '✅ Завершить заказ',
                callback_data: `finish_order_${orderId}`
              }]
            ]
          }
        };
      }


      const caption =
        `✅ Вам назначен заказ №: ` +
        `<code>${escapeHtml(orderId)}</code>` +
        `${escapeHtml(detailsText)}` +
        `${statsText}` +
        `\n\nКогда упакуете, нажмите кнопку ниже ` +
        `или выполните команду:\n` +
        `/finish_order <code>${escapeHtml(orderId)}</code>`;


      // 7. ШТРИХКОД

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

          await bot.sendPhoto(
            employee.tg_user_id,
            barcodeBuffer,
            {
              caption,
              parse_mode: 'HTML',
              ...finishKeyboard
            }
          );

        } else {

          await bot.sendPhoto(
            employee.tg_user_id,
            barcodeBuffer,
            {
              caption:
                caption +
                '\n\n⚠️ Для этого заказа требуется заполнить ' +
                'данные по материалам. Следуйте инструкциям.',
              parse_mode: 'HTML'
            }
          );
        }

      } catch (barcodeError) {

        console.error(
          `[ASSIGN] Ошибка генерации штрихкода:`,
          barcodeError
        );

        if (finishKeyboard) {

          await bot.sendMessage(
            employee.tg_user_id,
            caption,
            {
              parse_mode: 'HTML',
              ...finishKeyboard
            }
          );

        } else {

          await bot.sendMessage(
            employee.tg_user_id,
            caption +
            '\n\n⚠️ Для этого заказа требуется заполнить ' +
            'данные по материалам. Следуйте инструкциям.',
            { parse_mode: 'HTML' }
          );
        }
      }


      // 8. ФОТО ТОВАРОВ

      if (skuList.length) {

        try {

          const imageMap =
            await ozon.fetchProductsImages(skuList);

          for (const product of orderDetails.products) {

            const imgUrl = imageMap[product.sku];

            if (!imgUrl || !imgUrl.startsWith('http')) {
              continue;
            }

            const imageBuffer =
              await ozon.downloadImage(imgUrl);

            if (!imageBuffer) continue;

            await bot.sendPhoto(
              employee.tg_user_id,
              imageBuffer,
              {
                caption:
                  `📷 Фото к заказу ` +
                  `<code>${escapeHtml(orderId)}</code>: ` +
                  `<b>${escapeHtml(product.name)}</b>`,
                parse_mode: 'HTML'
              }
            );

            await new Promise(
              resolve => setTimeout(resolve, 500)
            );
          }

        } catch (photoError) {

          console.error(
            `[ASSIGN] Ошибка отправки фото для ${orderId}:`,
            photoError.message
          );

          // Ошибка фото не отменяет назначение
        }
      }


      // 9. 3D-МОДЕЛИ

      if (!DISABLE_MODELS) {

        const validExtensions = [
          '.stl',
          '.3mf',
          '.step',
          '.obj',
          '.zip'
        ];

        const moderatorId = process.env.MODERATOR_ID;

        for (const product of orderDetails.products || []) {

          try {

            const originalOfferId = product.offer_id;

            if (!originalOfferId) continue;

            const offersToCheck = [originalOfferId];

            const parentOfferId =
              db.getParentOfferId(originalOfferId);

            if (parentOfferId) {
              offersToCheck.push(parentOfferId);
            }

            let models = [];
            let usedOfferId = null;
            let textFiles = [];
            let skipped = [];

            for (const offerId of offersToCheck) {

              models =
                await db.getProductModelsByExtensions(
                  offerId,
                  validExtensions
                );

              textFiles =
                await db.getTextFilesForOfferId(offerId);

              skipped =
                await db.getSkippedModels(offerId);

              if (models.length) {
                usedOfferId = offerId;
                break;
              }
            }


            if (!models.length) {

              if (textFiles.length) {

                for (const txt of textFiles) {

                  await bot.sendDocument(
                    moderatorId,
                    txt.file_id,
                    {
                      caption:
                        `📄 Текстовый файл для товара ` +
                        `<b>${escapeHtml(product.name)}</b> ` +
                        `(offer_id: <code>${escapeHtml(originalOfferId)}</code>) ` +
                        `из offer_id <code>${escapeHtml(txt.offer_id)}</code>: ` +
                        `<code>${escapeHtml(txt.file_name)}</code>\n` +
                        `Отправьте его сотруднику ` +
                        `<b>${escapeHtml(employee.name)}</b> вручную.`,
                      parse_mode: 'HTML'
                    }
                  );

                  await new Promise(
                    resolve => setTimeout(resolve, 300)
                  );
                }

                await bot.sendMessage(
                  employee.tg_user_id,
                  `ℹ️ Для товара ` +
                  `${escapeHtml(product.name)} ` +
                  `(<code>${escapeHtml(originalOfferId)}</code>) ` +
                  `нет 3D-моделей, но есть инструкция (.txt). ` +
                  `Обратитесь к модератору.`,
                  { parse_mode: 'HTML' }
                );

              } else {

                await bot.sendMessage(
                  moderatorId,
                  `⚠️ Для товара ` +
                  `<b>${escapeHtml(product.name)}</b> ` +
                  `(<code>${escapeHtml(originalOfferId)}</code>) ` +
                  `отсутствуют 3D-модели.\n` +
                  `Отправьте их сотруднику ` +
                  `<b>${escapeHtml(employee.name)}</b> вручную.`,
                  { parse_mode: 'HTML' }
                );

                await bot.sendMessage(
                  employee.tg_user_id,
                  `ℹ️ 3D-модели для товара ` +
                  `<b>${escapeHtml(product.name)}</b> ` +
                  `(<code>${escapeHtml(originalOfferId)}</code>) ` +
                  `отсутствуют. Обратитесь к модератору.`,
                  { parse_mode: 'HTML' }
                );
              }

              continue;
            }


            for (const model of models) {

              let captionModel =
                `📁 3D-модель для <b>${escapeHtml(product.name)}</b>\n` +
                `<b>offer_id:</b> <code>${escapeHtml(originalOfferId)}</code>`;

              if (usedOfferId !== originalOfferId) {
                captionModel +=
                  `\n(модель взята из offer_id: ` +
                  `<code>${escapeHtml(usedOfferId)}</code>)`;
              }

              captionModel +=
                `\n<b>Файл:</b> <code>${escapeHtml(model.file_name)}</code>`;

              await bot.sendDocument(
                employee.tg_user_id,
                model.file_id,
                {
                  caption: captionModel,
                  parse_mode: 'HTML'
                }
              );

              await db.addIssuedModel(
                employee.id,
                originalOfferId
              );

              await new Promise(
                resolve => setTimeout(resolve, 500)
              );
            }


            if (skipped.length) {

              const fileList =
                skipped.map(s => s.file_name).join(', ');

              await bot.sendMessage(
                moderatorId,
                `⚠️ Для товара ` +
                `<b>${escapeHtml(product.name)}</b> ` +
                `(<code>${escapeHtml(originalOfferId)}</code>) ` +
                `не загружены модели: ` +
                `<b>${escapeHtml(fileList)}</b>.\n` +
                `Отправьте их сотруднику ` +
                `<b>${escapeHtml(employee.name)}</b> вручную.`,
                { parse_mode: 'HTML' }
              );
            }

          } catch (err) {

            console.error(
              `[ASSIGN] Ошибка обработки товара ${product.name}:`,
              err
            );

            // Ошибка одной модели не отменяет назначение
          }
        }
      }


      // 10. ФОРМЫ СТАТИСТИКИ

      if (missingStats.length > 0) {

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

        const key =
          `${employee.tg_user_id}_${orderId}`;

        pendingForms.set(key, {
          orderId,
          offers: offersState,
          allCompleted: false
        });


        for (const offerId of missingStats) {

          const product =
            orderDetails.products.find(
              p => p.offer_id === offerId
            );

          const productName =
            product ? product.name : offerId;

          const captionStats =
            `🛍️ Товар: <b>${escapeHtml(productName)}</b>\n` +
            `Артикул: <code>${escapeHtml(offerId)}</code>\n` +
            `Для этого товара ещё нет данных ` +
            `по материалу, цвету и весу.\n` +
            `Нажмите кнопку ниже, чтобы заполнить статистику.`;

          const keyboard = {
            reply_markup: {
              inline_keyboard: [[
                {
                  text: `📝 Заполнить статистику для ${offerId}`,
                  callback_data:
                    `fill_stats_${orderId}_${offerId}`
                }
              ]]
            }
          };

          const sentMsg = await bot.sendMessage(
            employee.tg_user_id,
            captionStats,
            {
              ...keyboard,
              parse_mode: 'HTML'
            }
          );

          offersState[offerId].messageId =
            sentMsg.message_id;
        }
      }


      // 11. УСПЕШНОЕ ЗАВЕРШЕНИЕ

      if (adminChatId) {
        await bot.sendMessage(
          adminChatId,
          `✅ Заказ <code>${escapeHtml(orderId)}</code> ` +
          `назначен сотруднику ` +
          `<b>${escapeHtml(employee.name)}</b> ` +
          `(ID: <code>${employee.id}</code>).`,
          { parse_mode: 'HTML' }
        ).catch(() => { });
      }

      await new Promise(
        resolve => setTimeout(resolve, 300)
      );

      if (adminChatId && orderDetails) {
        try {
          const reply = await formatOrderDetails(orderDetails, db);
          await bot.sendMessage(adminChatId, reply, { parse_mode: 'HTML' });
        } catch (err) {
          console.error(`[ASSIGN] Не удалось отправить детали заказа ${orderId} модератору:`, err);
        }
      }

      orderAssignRetries.delete(orderId);

      console.log(
        `[ASSIGN] Заказ ${orderId} успешно назначен сотруднику ` +
        `${employee.name} (ID ${employee.id})`
      );

      console.log(`[ASSIGN] === Назначение завершено ===`);

      return {
        success: true,
        employee
      };


    } catch (err) {

      // 12. ОШИБКА

      console.error(
        `[ASSIGN] Ошибка назначения заказа ${orderId}:`,
        err
      );


      // Если БД уже получила назначение — НЕ возвращаем заказ
      // в очередь, иначе получим повторное назначение.
      if (assignedInDb) {

        console.error(
          `[ASSIGN] Заказ ${orderId} уже назначен в БД, ` +
          `в очередь не возвращаем.`
        );

        const moderatorId = process.env.MODERATOR_ID;

        if (moderatorId) {

          await bot.sendMessage(
            moderatorId,
            `⚠️ Заказ <code>${escapeHtml(orderId)}</code> ` +
            `уже назначен сотруднику ` +
            `<b>${escapeHtml(employee?.name || employeeId)}</b>, ` +
            `но при отправке данных произошла ошибка:\n` +
            `<code>${escapeHtml(err.message)}</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => { });
        }

      } else {

        // Ошибка произошла до назначения в БД —
        // можно вернуть заказ в очередь.
        let retries =
          orderAssignRetries.get(orderId) || 0;

        retries++;
        orderAssignRetries.set(orderId, retries);


        if (retries <= 3) {

          if (
            !orderState.pendingNewOrders.some(
              o => o.posting_number === orderId
            )
          ) {

            if (!queuedOrder) {

              try {
                queuedOrder =
                  await ozon.fetchAwaitingOrdersById(orderId);
              } catch (e) {
                console.warn(
                  `[ASSIGN] Не удалось получить заказ ${orderId} ` +
                  `для возврата в очередь.`
                );

                queuedOrder = {
                  posting_number: orderId,
                  products: []
                };
              }
            }

            if (queuedOrder) {

              orderState.pendingNewOrders.unshift(
                queuedOrder
              );

              console.log(
                `[ASSIGN] Заказ ${orderId} возвращён в очередь ` +
                `(попытка ${retries}/3).`
              );
            }
          }

        } else {

          console.error(
            `[ASSIGN] Заказ ${orderId} не удалось назначить ` +
            `после 3 попыток.`
          );

          const moderatorId =
            process.env.MODERATOR_ID;

          if (moderatorId) {

            await bot.sendMessage(
              moderatorId,
              `❌ Заказ <code>${escapeHtml(orderId)}</code> ` +
              `не удалось назначить после 3 попыток.\n` +
              `Ошибка: <code>${escapeHtml(err.message)}</code>\n` +
              `Заказ исключён из очереди, требуется ручное вмешательство.`,
              { parse_mode: 'HTML' }
            ).catch(() => { });
          }

          orderAssignRetries.delete(orderId);
        }
      }


      if (adminChatId) {

        await bot.sendMessage(
          adminChatId,
          `❌ Ошибка назначения заказа ` +
          `<code>${escapeHtml(orderId)}</code>:\n` +
          `<b>${escapeHtml(err.message)}</b>`,
          { parse_mode: 'HTML' }
        ).catch(() => { });
      }

      throw err;


    } finally {

      // 13. РАЗБЛОКИРОВКА

      processingOrders.delete(orderId);

      console.log(
        `[ASSIGN] Блокировка для ${orderId} снята.`
      );
    }
  }

  // ======================================================================
  // ---------------------- АДМИНИСТРАТИВНЫЕ КОМАНДЫ ----------------------
  // ======================================================================

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
      await bot.sendMessage(chatId, `Вы уже в БД как <b>${escapeHtml(existing.name)}</b>`, { parse_mode: 'HTML' });
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

    // Принудительная синхронизация складов перед показом
    try {
      await bot.sendMessage(msg.chat.id, '🔄 Синхронизация складов с Ozon...');
      const warehousesFromOzon = await ozon.fetchWarehousesFromOzon();
      if (warehousesFromOzon.length) {
        await db.syncWarehouses(warehousesFromOzon);
      }
    } catch (err) {
      console.error('[WAREHOUSES] Ошибка синхронизации:', err);
      await bot.sendMessage(msg.chat.id, `⚠️ Не удалось синхронизировать склады: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
      // Продолжаем показывать то, что есть в БД
    }

    await new Promise(resolve => setTimeout(resolve, 300));

    const warehouses = await db.getAllWarehouses();
    if (!warehouses.length) {
      return bot.sendMessage(msg.chat.id, 'Склады не найдены.', { parse_mode: 'HTML' });
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

  // --- "/sync_warehouses" Команда для администратора: принудительная синхронизация складов ---
  bot.onText(/\/sync_warehouses/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.', { parse_mode: 'HTML' });
      return;
    }

    try {
      await bot.sendMessage(msg.chat.id, '🔄 Синхронизация складов с Ozon...');
      const warehouses = await ozon.fetchWarehousesFromOzon();

      await new Promise(resolve => setTimeout(resolve, 300));

      if (!warehouses.length) {
        await bot.sendMessage(msg.chat.id, '⚠️ Не удалось получить список складов (пустой ответ).', { parse_mode: 'HTML' });
        return;
      }
      await db.syncWarehouses(warehouses);
      await bot.sendMessage(
        msg.chat.id,
        `✅ Синхронизация складов завершена. Обновлено <b>${warehouses.length}</b> складов.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[SYNC_WAREHOUSES] Ошибка:', err);
      await bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка синхронизации: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
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


  // --- "/upload_team_info" Команда для администратора: загрузить новый файл team-info.xlsx с сотрудниками (автоматически синхронизирует БД) ---
  bot.onText(/\/upload_team_info/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    pendingEmployeeUpload.set(userId, { step: 'waiting_file' });
    const fileName = getVersionedFileName('team-info', '.xlsx');
    await bot.sendMessage(msg.chat.id, `📤 Отправьте актуальный файл <b>${fileName}</b> со списком активных сотрудников и приоритетами складов.`, { parse_mode: 'HTML' });
  });

  // --- "/upload_materials_prices" Команда для администратора: загрузить новый файл materials-prices.json с ценами материалов ---
  bot.onText(/\/upload_materials_prices/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      await bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.');
      return;
    }
    pendingMaterialsUpload.set(userId, { step: 'waiting_file' });
    const fileName = getVersionedFileName('materials-prices', '.json');
    await bot.sendMessage(msg.chat.id, `📤 Отправьте актуальный файл <b>${fileName}</b> с настройками цветов материалов, цен за грамм, минимального заработка и спецпредложений.`, { parse_mode: 'HTML' });
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
      return bot.sendMessage(msg.chat.id, `❌ Заказ <code>${escapeHtml(postingNumber)}</code> не в статусе "awaiting_packaging".`, { parse_mode: 'HTML' });
    }

    if (employeeId) {
      // Назначаем сразу
      try {
        await assignOrder(postingNumber, employeeId, msg.chat.id);
        await safeProcessNextOrder();
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
        return bot.sendMessage(
          msg.chat.id,
          `❌ Не удалось получить статус заказа <code>${escapeHtml(postingNumber)}</code>.`,
          { parse_mode: 'HTML' }
        );
      }
      if (details.status !== 'awaiting_deliver') {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Заказ <code>${escapeHtml(postingNumber)}</code> не в статусе "awaiting_deliver" (текущий: <b>${escapeHtml(details.status)}</b>). Этикетка недоступна.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error(`[ADMIN_SEND_LABEL] Ошибка проверки статуса:`, err);
      return bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка проверки статуса: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
    }

    // Если не указан сотрудник – отправляем себе (администратору)
    let targetChatId = msg.chat.id;
    let targetName = 'себе';

    if (targetEmployeeId) {
      const employee = await db.getEmployeeById(targetEmployeeId);
      if (!employee) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Сотрудник с ID <code>${escapeHtml(targetEmployeeId)}</code> не найден.`,
          { parse_mode: 'HTML' }
        );
      }
      targetChatId = employee.tg_user_id;
      targetName = employee.name;
    }

    // Проверяем, может ли бот писать в целевой чат
    try {
      await bot.sendChatAction(targetChatId, 'typing');
    } catch (err) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Не удалось отправить сообщение сотруднику <b>${escapeHtml(targetName)}</b>. Возможно, он не начал диалог с ботом.`,
        { parse_mode: 'HTML' }
      );
    }

    // Таймаут между вызововами методов Ozon API
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      const labelBuffer = await ozon.getPackageLabel(postingNumber);
      if (labelBuffer) {
        await bot.sendDocument(
          targetChatId,
          labelBuffer,
          {
            caption: `✅ Этикетка для заказа <code>${escapeHtml(postingNumber)}</code>`,
            parse_mode: 'HTML'
          },
          {
            filename: `label_${postingNumber}.pdf`,
            contentType: 'application/pdf'
          }
        );
        await bot.sendMessage(
          msg.chat.id,
          `✅ Этикетка для заказа <code>${escapeHtml(postingNumber)}</code> отправлена <b>${escapeHtml(targetName)}</b>.`,
          { parse_mode: 'HTML' }
        );
      } else {
        await bot.sendMessage(
          msg.chat.id,
          `❌ Не удалось получить этикетку для заказа <code>${escapeHtml(postingNumber)}</code>.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error('Ошибка отправки этикетки:', err);
      await bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // --- "/upload_model" Команда для администратора: добавление/обновление 3D-модели ---
  bot.onText(/\/upload_model/, async (msg) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может загружать модели.');
    }
    pendingUploadModel.set(userId, { step: 'waiting_file' });
    bot.sendMessage(
      msg.chat.id,
      '📤 Отправьте файл модели. Имя файла должно содержать offer_id (например, <code>2001867564-N_avs_k1.3mf</code>).',
      { parse_mode: 'HTML' }
    );
  });

  // --- "/remove_model" Команда для администратора: удаление модели ---
  bot.onText(/\/remove_model (\S+) (.+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может удалять модели.');
    }
    const offerId = match[1];
    const fileName = match[2];
    try {
      await db.deleteProductModel(offerId, fileName);
      bot.sendMessage(
        msg.chat.id,
        `✅ Модель <code>${escapeHtml(fileName)}</code> для offer_id <code>${escapeHtml(offerId)}</code> удалена из базы.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка удаления: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // --- "/list_models" Команда для администратора: список моделей для offer_id ---
  bot.onText(/\/list_models (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может смотреть список моделей.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }
    const offerId = match[1];
    const models = await db.getAllProductModels(offerId);
    if (!models.length) {
      return bot.sendMessage(
        msg.chat.id,
        `📭 Нет моделей для offer_id <code>${escapeHtml(offerId)}</code>.`,
        { parse_mode: 'HTML' }
      );
    }
    let reply = `📋 Модели для offer_id <code>${escapeHtml(offerId)}</code>:\n`;
    for (const m of models) {
      reply += `• <code>${escapeHtml(m.file_name)}</code> (${(m.file_size / 1024 / 1024).toFixed(2)} МБ)\n`;
    }
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
  });

  // --- "/cancel_model" Команда для администратора: отмена ожидания заливки модели ---
  bot.onText(/\/cancel_model/, async (msg) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может отменить заливку модели.');
    }
    if (pendingModelAdd && pendingModelAdd.has(userId)) {
      pendingModelAdd.delete(userId);
      bot.sendMessage(
        msg.chat.id,
        '✅ Операция добавления модели отменена.'
      );
    } else {
      bot.sendMessage(
        msg.chat.id,
        'ℹ️ Нет активной операции.'
      );
    }
  });

  // --- "/add_model" Команда для администратора: добавление/обновление 3D-модели ---
  bot.onText(/\/add_model (\S+)/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может добавлять модели.');
    }
    const offerId = match[1];
    bot.sendMessage(
      msg.chat.id,
      `📤 Отправьте файл модели для offer_id <code>${escapeHtml(offerId)}</code> (до 50 МБ).`,
      { parse_mode: 'HTML' }
    );
    if (!pendingModelAdd) pendingModelAdd = new Map();
    pendingModelAdd.set(userId, { offerId, step: 'waiting_file' });
  });

  // --- "/bind_model" Команда для администратора: привязка существующего файла из канала к offer_id ---
  // Формат: /bind_model <offer_id> <file_id> [имя_файла]
  bot.onText(/\/bind_model (\S+) (\S+)(?: (.+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    const offerId = match[1];
    const fileId = match[2];
    const fileName = match[3]
      ? match[3].trim().replace(/^["']|["']$/g, '')
      : `привязанный_файл_${Date.now()}`;

    try {
      await db.upsertProductModel(offerId, fileId, fileName, 0);
      bot.sendMessage(
        msg.chat.id,
        `✅ Модель <code>${escapeHtml(fileName)}</code> для offer_id <code>${escapeHtml(offerId)}</code> успешно привязана (file_id: <code>${escapeHtml(fileId)}</code>).`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка привязки: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
    }
  });

  // --- "/get_file_id" Команда для администратора: получить file_id пересланного файла ---
  bot.onText(/\/get_file_id/, async (msg) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
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
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
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

  // --- "/send_models" Команда для администратора: отправить все модели для offer_id сотруднику (или себе) ---
  bot.onText(/\/send_models (\S+)(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from.id.toString();
    if (DISABLE_MODELS) {
      return bot.sendMessage(msg.chat.id, 'ℹ️ Работа с 3D-моделями отключена для этого магазина.');
    }
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    }
    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    const offerId = match[1];
    const targetEmployeeId = match[2] ? parseInt(match[2]) : null;

    let targetChatId = msg.chat.id;
    let targetName = 'себе';

    if (targetEmployeeId) {
      const employee = await db.getEmployeeById(targetEmployeeId);
      if (!employee) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Сотрудник с ID <code>${escapeHtml(targetEmployeeId)}</code> не найден.`,
          { parse_mode: 'HTML' }
        );
      }
      targetChatId = employee.tg_user_id;
      targetName = employee.name;
    }

    const models = await db.getAllProductModels(offerId);
    if (!models || models.length === 0) {
      return bot.sendMessage(
        msg.chat.id,
        `📭 Нет моделей для offer_id <code>${escapeHtml(offerId)}</code>.`,
        { parse_mode: 'HTML' }
      );
    }

    try {
      await bot.sendChatAction(targetChatId, 'typing');
    } catch (err) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Не удалось отправить сообщение сотруднику <b>${escapeHtml(targetName)}</b>. Возможно, он не начал диалог с ботом.`,
        { parse_mode: 'HTML' }
      );
    }

    await bot.sendMessage(
      msg.chat.id,
      `📤 Отправляю <b>${models.length}</b> моделей для offer_id <code>${escapeHtml(offerId)}</code> ${targetEmployeeId ? `сотруднику <b>${escapeHtml(targetName)}</b>` : 'себе'}...`,
      { parse_mode: 'HTML' }
    );

    let sentCount = 0;
    for (const model of models) {
      try {
        const caption = `📁 Модель для <b>offer_id:</b> <code>${escapeHtml(offerId)}</code>\n<b>Файл:</b> <code>${escapeHtml(model.file_name)}</code>`;
        await bot.sendDocument(targetChatId, model.file_id, {
          caption,
          parse_mode: 'HTML'
        });
        sentCount++;
        if (targetEmployeeId) {
          await db.addIssuedModel(targetEmployeeId, offerId);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        console.error(`Ошибка отправки модели ${model.file_name}:`, err.message);
        await bot.sendMessage(
          msg.chat.id,
          `❌ Ошибка при отправке файла <code>${escapeHtml(model.file_name)}</code>: <b>${escapeHtml(err.message)}</b>`,
          { parse_mode: 'HTML' }
        );
      }
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ Отправлено <b>${sentCount}</b> из <b>${models.length}</b> моделей для offer_id <code>${escapeHtml(offerId)}</code> ${targetEmployeeId ? `сотруднику <b>${escapeHtml(targetName)}</b>` : 'себе'}.`,
      { parse_mode: 'HTML' }
    );
  });

  // ==========================================================================
  // ---------------------- ЕДИНЫЙ ОБРАБОТЧИК ДОКУМЕНТОВ ----------------------
  // ==========================================================================
  bot.on('document', async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(
        msg.chat.id,
        '⛔ Только администратор может загружать файлы.'
      );
    }

    const file = msg.document;
    const fileName = file.file_name;

    // Приоритет 0: /upload_team_info (загрузка team-info.xlsx)
    if (pendingEmployeeUpload && pendingEmployeeUpload.has(userId)) {
      const pending = pendingEmployeeUpload.get(userId);
      if (pending.step !== 'waiting_file') return;
      const expectedFileName = getVersionedFileName('team-info', '.xlsx');
      if (fileName !== expectedFileName) {
        await bot.sendMessage(
          msg.chat.id,
          `❌ Пожалуйста, отправьте файл с именем <b>${expectedFileName}</b>.`,
          { parse_mode: 'HTML' }
        );
        pendingEmployeeUpload.delete(userId);
        return;
      }
      try {
        const fileLink = await bot.getFileLink(file.file_id);
        const tempPath = path.join(__dirname, 'temp_team_info.xlsx');
        const writer = fs.createWriteStream(tempPath);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        const targetFileName = getVersionedFileName('team-info', '.xlsx');
        const targetPath = path.join(__dirname, targetFileName);
        fs.renameSync(tempPath, targetPath);
        await syncEmployeesFromExcel(db);
        await bot.sendMessage(
          msg.chat.id,
          '✅ Список активных сотрудников и приоритеты складов успешно обновлены из загруженного файла.'
        );
      } catch (err) {
        console.error('[UPLOAD_TEAM_INFO] Ошибка:', err);
        await bot.sendMessage(
          msg.chat.id,
          `❌ Ошибка: <b>${escapeHtml(err.message)}</b>`,
          { parse_mode: 'HTML' }
        );
      }
      pendingEmployeeUpload.delete(userId);
      return;
    }

    // Приоритет 0.5: загрузка материалов (команда /upload_materials_prices)
    if (pendingMaterialsUpload && pendingMaterialsUpload.has(userId)) {
      const pending = pendingMaterialsUpload.get(userId);
      if (pending.step !== 'waiting_file') return;
      const expectedFileName = getVersionedFileName('materials-prices', '.json');
      if (fileName !== expectedFileName) {
        await bot.sendMessage(
          msg.chat.id,
          `❌ Пожалуйста, отправьте файл с именем <b>${expectedFileName}</b>.`,
          { parse_mode: 'HTML' }
        );
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
        const targetFileName = getVersionedFileName('materials-prices', '.json');;
        const targetPath = path.join(__dirname, targetFileName);
        fs.renameSync(tempPath, targetPath);
        loadMaterials();
        await bot.sendMessage(
          msg.chat.id,
          '✅ Конфигурация цветов материалов, цен за грамм, минимального заработка и спецпредложений обновлена.'
        );
      } catch (err) {
        console.error('[UPLOAD_MATERIALS_PRICES] Ошибка:', err);
        await bot.sendMessage(
          msg.chat.id,
          `❌ Ошибка: <b>${escapeHtml(err.message)}</b>`,
          { parse_mode: 'HTML' }
        );
      }
      pendingMaterialsUpload.delete(userId);
      return;
    }

    if (!DISABLE_MODELS) {
      // Приоритет 1: /upload_model
      if (pendingUploadModel && pendingUploadModel.has(userId)) {
        const pending = pendingUploadModel.get(userId);
        if (pending.step !== 'waiting_file') return;

        const file = msg.document;
        const fileName = file.file_name;
        console.log(`[UPLOAD_MODEL] Имя файла: "${fileName}"`);

        const underscoreIndex = fileName.indexOf('_');
        if (underscoreIndex === -1) {
          await bot.sendMessage(
            msg.chat.id,
            '❌ Имя файла должно содержать символ "_" после offer_id (например, <code>2001867564-N_avs.stl</code>).',
            { parse_mode: 'HTML' }
          );
          pendingUploadModel.delete(userId);
          return;
        }

        let offerId = fileName.substring(0, underscoreIndex);
        const rest = fileName.substring(underscoreIndex + 1);

        const suffixMatch = rest.match(/^([A-Z]+)(?:-|_|\.)/);
        if (!offerId.includes('-') && suffixMatch) {
          const possibleSuffix = suffixMatch[1];
          if (possibleSuffix === 'N' || possibleSuffix === 'NR' || possibleSuffix === 'NL') {
            const newOfferId = offerId + '-' + possibleSuffix;
            console.log(`[UPLOAD_MODEL] Обнаружен суффикс, восстанавливаем: "${newOfferId}"`);
            offerId = newOfferId;
          }
        }

        if (!/^[A-Z0-9-]+$/.test(offerId)) {
          await bot.sendMessage(
            msg.chat.id,
            '❌ Артикул может содержать только буквы, цифры и дефис. Проверьте имя файла.',
            { parse_mode: 'HTML' }
          );
          pendingUploadModel.delete(userId);
          return;
        }

        console.log(`[UPLOAD_MODEL] Итоговый offerId: "${offerId}"`);

        try {
          const sent = await bot.sendDocument(process.env.MODELS_CHAT_ID, file.file_id, {
            caption: `<b>offer_id:</b> <code>${escapeHtml(offerId)}</code>\n<b>Файл:</b> <code>${escapeHtml(fileName)}</code>`,
            parse_mode: 'HTML'
          });
          const newFileId = sent.document.file_id;
          await db.deleteProductModel(offerId, fileName);
          await db.upsertProductModel(offerId, newFileId, fileName, file.file_size);
          await bot.sendMessage(
            msg.chat.id,
            `✅ Модель <code>${escapeHtml(fileName)}</code> для offer_id <code>${escapeHtml(offerId)}</code> успешно загружена/обновлена.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          console.error('Ошибка загрузки модели:', err);
          await bot.sendMessage(
            msg.chat.id,
            `❌ Ошибка загрузки: <b>${escapeHtml(err.message)}</b>`,
            { parse_mode: 'HTML' }
          );
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
          await bot.sendMessage(
            msg.chat.id,
            `❌ Файл слишком большой (<b>${fileSizeMB.toFixed(2)} МБ</b>). Максимум 50 МБ.`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        const fileName = file.file_name;
        const offerId = pending.offerId;

        try {
          const sent = await bot.sendDocument(process.env.MODELS_CHAT_ID, file.file_id, {
            caption: `<b>offer_id:</b> <code>${escapeHtml(offerId)}</code>\n<b>Файл:</b> <code>${escapeHtml(fileName)}</code>`,
            parse_mode: 'HTML'
          });
          const newFileId = sent.document.file_id;
          await db.deleteProductModel(offerId, fileName);
          await db.upsertProductModel(offerId, newFileId, fileName, file.file_size);
          await bot.sendMessage(
            msg.chat.id,
            `✅ Модель <code>${escapeHtml(fileName)}</code> для offer_id <code>${escapeHtml(offerId)}</code> успешно добавлена/обновлена.`,
            { parse_mode: 'HTML' }
          );
        } catch (err) {
          console.error('Ошибка добавления модели:', err);
          await bot.sendMessage(
            msg.chat.id,
            `❌ Ошибка добавления модели: <b>${escapeHtml(err.message)}</b>`,
            { parse_mode: 'HTML' }
          );
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
          await bot.sendMessage(
            msg.chat.id,
            `✅ <b>file_id:</b> <code>${escapeHtml(fileId)}</code>\n<b>Имя:</b> <code>${escapeHtml(fileName)}</code>\n<b>Размер:</b> <b>${(fileSize / 1024 / 1024).toFixed(2)} МБ</b>\n\nИспользуйте /bind_model &lt;offer_id&gt; <code>${escapeHtml(fileId)}</code> <code>${escapeHtml(fileName)}</code>`,
            { parse_mode: 'HTML' }
          );
          pendingFileId.delete(userId);
        }
        return;
      }

      // Приоритет 4: пересылка из канала (без активного состояния)
      if (msg.forward_from_chat || msg.forward_from) {
        const caption = msg.caption || '';
        const plainCaption = stripHtml(caption);
        const offerIdMatch = plainCaption.match(/offer_id:\s*(\S+)/i);
        const fileNameMatch = plainCaption.match(/Файл:\s*(.+)/i);

        if (!offerIdMatch || !fileNameMatch) {
          return;
        }

        const offerId = offerIdMatch[1].trim();
        const fileName = fileNameMatch[1].trim();
        const fileId = msg.document.file_id;
        const fileSize = msg.document.file_size;

        await db.upsertProductModel(offerId, fileId, fileName, fileSize);
        await bot.sendMessage(
          msg.chat.id,
          `✅ Модель <code>${escapeHtml(fileName)}</code> для offer_id <code>${escapeHtml(offerId)}</code> успешно привязана/обновлена.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
    }
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
      orderState.currentOrderProcessing = null;
      orderState.pendingNewOrders.length = 0;

      // 3. Обновляем очередь заказов из API (заполняет pendingNewOrders)
      await safeCheckAndOfferNewOrders();

      // 4. Получаем все активные назначения из БД
      const activeAssignments = await db.db.all('SELECT order_id FROM assignments WHERE status = "assigned"');
      const activeOrderIds = new Set(activeAssignments.map(a => a.order_id));

      // 5. Добавляем заказы из обновлённой очереди
      const pendingOrderIds = new Set(orderState.pendingNewOrders.map(o => o.posting_number));

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
      if (orderState.pendingNewOrders.length) {
        orderState.currentOrderProcessing = null;
        await safeProcessNextOrder();
        await bot.sendMessage(msg.chat.id, `✅ Перезагрузка выполнена. Отправлен первый заказ. Осталось: ${orderState.pendingNewOrders.length}`);
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
        const emptyMessage = warehouseId
          ? `📭 Нет заказов в статусе "awaiting_packaging" для склада ${warehouseNotFound
            ? `ID: <code>${escapeHtml(warehouseId)}</code>`
            : `«<b>${escapeHtml(warehouseName)}</b>»`
          }.`
          : '📭 Нет заказов в статусе "awaiting_packaging".';

        return bot.sendMessage(msg.chat.id, emptyMessage, { parse_mode: 'HTML' });
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

          let whId = order.warehouse_id || null;
          if (order.delivery_method && order.delivery_method.warehouse_id) {
            whId = order.delivery_method.warehouse_id;
          }

          let whDisplay = `<b>не указан</b>`;
          if (whId) {
            whId = String(whId);
            try {
              const whName = await db.getWarehouseNameById(whId);
              if (whName && whName !== whId) {
                whDisplay = `<b>${escapeHtml(whName)}</b> (ID: <code>${escapeHtml(whId)}</code>)`;
              } else {
                whDisplay = `ID: <code>${escapeHtml(whId)}</code>`;
              }
            } catch (err) {
              console.error(`[ORDERS] Ошибка получения склада для ${whId}:`, err);
              whDisplay = `ID: <code>${escapeHtml(whId)}</code>`;
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
      const reply = await formatOrderDetails(details, db);
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
    const baseName = getVersionedFileName('earnings_active');
    const fileName = `${baseName}_${Date.now()}.xlsx`;
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
        `✅ Корректировка для сотрудника <b>${escapeHtml(employee.name)}</b> (ID ${employee.id}) на сумму <b>${amount > 0 ? '+' : ''}${amount.toFixed(2)}</b> руб. добавлена.`
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
      bot.sendMessage(msg.chat.id, `✅ Запись для <code>${escapeHtml(offerId)}</code> удалена.`, { parse_mode: 'HTML' });
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

  // --- "/download_materials_prices" Команда для администратора: скачать файл materials-prices.json ---
  bot.onText(/\/download_materials_prices/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    const fileName = getVersionedFileName('materials-prices', '.json');
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) return bot.sendMessage(msg.chat.id, `❌ Файл <b>${fileName}</b> не найден.`, { parse_mode: 'HTML' });
    await bot.sendDocument(msg.chat.id, filePath, {
      caption: '🧾 Актуальный файл настроек цветов материалов, цен за грамм, минимального заработка и спецпредложений.',
      filename: fileName
    });
  });

  // --- "/download_team_info" Команда для администратора: скачать файл team-info.xlsx ---
  bot.onText(/\/download_team_info/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) return bot.sendMessage(msg.chat.id, '⛔ Только администратор.');
    try {
      const filePath = await exportTeamInfoXlsx(db, ozon);
      const fileName = getVersionedFileName('team-info', '.xlsx');
      await bot.sendDocument(msg.chat.id, filePath, {
        caption: `📄 Актуальный файл со списком активных сотрудников и приоритетами складов "${fileName}".`
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
      const fileName = getVersionedFileName('product-stats', '.xlsx');
      const filePath = path.join(__dirname, 'exports', fileName);
      if (!fs.existsSync(filePath)) {
        return bot.sendMessage(msg.chat.id, '❌ Файл статистики не создан.');
      }
      const baseName = getVersionedFileName('product-stats');
      await bot.sendDocument(msg.chat.id, filePath, {
        caption: '📊 Актуальная полная выгрузка статистики по артикулам.',
        filename: `${baseName}_${Date.now()}.xlsx`
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
      const filePath = await exportTeamInfoXlsxAll(db, ozon);
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
    const fileName = getVersionedFileName('bot', '.db');
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) {
      return bot.sendMessage(msg.chat.id, `❌ Файл <b>${fileName}</b> не найден.`, { parse_mode: 'HTML' });
    }
    await bot.sendDocument(msg.chat.id, filePath, { caption: '🗃️ Актуальный файл базы данных.', filename: fileName });
  });

  // --- "/backup_db" Команда для администратора: создание бэкапа базы данных ---
  bot.onText(/\/backup_db/, async (msg) => {
    const userId = msg.from.id.toString();
    if (!isAdmin(userId)) {
      return bot.sendMessage(msg.chat.id, '⛔ Только администратор может использовать эту команду.', { parse_mode: 'HTML' });
    }

    if (isModerator(userId) && typeof updateModeratorActivity === 'function') {
      updateModeratorActivity();
    }

    try {
      await bot.sendMessage(msg.chat.id, '🔄 Создаю бэкап базы данных...');
      const backupPath = await db.createDbBackup({ includeTime: true });

      if (backupPath) {
        const fileName = path.basename(backupPath);
        await bot.sendMessage(
          msg.chat.id,
          `✅ Бэкап создан: <code>${escapeHtml(fileName)}</code>`,
          { parse_mode: 'HTML' }
        );
      } else {
        await bot.sendMessage(msg.chat.id, '❌ Не удалось создать бэкап.', { parse_mode: 'HTML' });
      }
    } catch (err) {
      console.error('[BACKUP] Ошибка:', err);
      await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
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

  // =================================================================
  // ---------------------- КОМАНДЫ СОТРУДНИКОВ ----------------------
  // =================================================================

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
      return bot.sendMessage(
        msg.chat.id,
        `❌ Заказ <code>${escapeHtml(postingNumber)}</code> не найден среди ваших активных заказов.`,
        { parse_mode: 'HTML' }
      );
    }

    // --- Проверяем наличие статистики для всех товаров в заказе ---
    try {
      const orderDetails = await ozon.getOrderDetails(postingNumber);
      if (!orderDetails || !orderDetails.products) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Не удалось получить детали заказа <code>${escapeHtml(postingNumber)}</code>.`,
          { parse_mode: 'HTML' }
        );
      }
      let missingStats = [];
      for (const product of orderDetails.products) {
        const offerId = product.offer_id;
        if (!offerId) continue;
        const stats = await db.getProductStats(offerId);
        if (!stats) missingStats.push(offerId);
      }
      if (missingStats.length > 0) {
        const missingList = missingStats.map(id => `<code>${escapeHtml(id)}</code>`).join(', ');
        return bot.sendMessage(
          msg.chat.id,
          `❌ Для заказа <code>${escapeHtml(postingNumber)}</code> отсутствует статистика для товаров: ${missingList}. Заполните статистику через /my_orders.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error('Ошибка проверки статистики:', err);
      return bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка проверки статистики: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
    }

    // --- Очищаем pendingForms и удаляем сообщения перед завершением ---
    const key = `${userId}_${postingNumber}`;
    const state = pendingForms.get(key);
    if (state) {
      // Дополнительная проверка: если состояние существует, но есть незавершённые опросы – блокируем
      const hasIncomplete = Object.values(state.offers).some(o => o.status !== 'completed');
      if (hasIncomplete || !state.allCompleted) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Сначала заполните статистику для всех товаров в заказе <code>${escapeHtml(postingNumber)}</code>. Используйте <code>/my_orders</code>, чтобы продолжить.`,
          { parse_mode: 'HTML' }
        );
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
      return bot.sendMessage(
        msg.chat.id,
        `❌ Заказ <code>${escapeHtml(postingNumber)}</code> не найден среди ваших активных заказов.`,
        { parse_mode: 'HTML' }
      );
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
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ Вы уверены, что хотите отменить заказ <code>${escapeHtml(postingNumber)}</code>?`,
      {
        parse_mode: 'HTML',
        ...confirmKeyboard
      }
    );
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
      return bot.sendMessage(
        msg.chat.id,
        `❌ Заказ <code>${escapeHtml(postingNumber)}</code> не найден среди ваших завершённых заказов.`,
        { parse_mode: 'HTML' }
      );
    }

    // 4. Проверяем статус заказа через Ozon API (должен быть awaiting_deliver)
    try {
      const details = await ozon.getOrderDetails(postingNumber);
      if (!details) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Не удалось получить статус заказа <code>${escapeHtml(postingNumber)}</code>.`,
          { parse_mode: 'HTML' }
        );
      }
      if (details.status !== 'awaiting_deliver') {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Заказ <code>${escapeHtml(postingNumber)}</code> не в статусе "awaiting_deliver" (текущий: <b>${escapeHtml(details.status)}</b>). Этикетка недоступна.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error(`[SEND_LABEL] Ошибка получения статуса:`, err);
      return bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка проверки статуса: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
    }

    // Таймаут между вызововами методов Ozon API
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 5. Получаем этикетку
    try {
      const labelBuffer = await ozon.getPackageLabel(postingNumber);
      if (!labelBuffer) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Не удалось получить этикетку для заказа <code>${escapeHtml(postingNumber)}</code>.`,
          { parse_mode: 'HTML' }
        );
      }
      // Отправляем этикетку сотруднику
      await bot.sendDocument(
        msg.chat.id,
        labelBuffer,
        {
          caption: `✅ Этикетка для заказа <code>${escapeHtml(postingNumber)}</code>`,
          parse_mode: 'HTML'
        },
        {
          filename: `label_${postingNumber}.pdf`,
          contentType: 'application/pdf'
        }
      );
      // Обновляем кулдаун
      labelCooldowns.set(userId, Date.now());
    } catch (err) {
      console.error(`[SEND_LABEL] Ошибка:`, err);
      await bot.sendMessage(
        msg.chat.id,
        `❌ Ошибка получения этикетки: <b>${escapeHtml(err.message)}</b>`,
        { parse_mode: 'HTML' }
      );
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


  // ======================================================================
  // ---------------------- ОБРАБОТЧИК TEXT (единый) ----------------------
  // ======================================================================
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
      const weightText = msg.text.trim().replace(',', '.');

      // Строгая проверка числа
      if (!/^\d+(?:\.\d+)?$/.test(weightText)) {
        await bot.sendMessage(
          userId,
          '❌ Введите корректное положительное число (например, <b>12.5</b>).',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const weight = Number(weightText);

      if (!Number.isFinite(weight) || weight <= 0) {
        await bot.sendMessage(
          userId,
          '❌ Введите корректное положительное число (например, <b>12.5</b>).',
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Найти товар, для которого ожидается вес
      const offerId = Object.keys(state.offers)
        .find(oid => state.offers[oid].waitingForWeight === true);

      if (!offerId) {
        await bot.sendMessage(
          userId,
          '❌ Не найден товар для ввода веса.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const offerState = state.offers[offerId];

      // Проверка существующей статистики
      const existingStats = await db.getProductStats(offerId);

      if (existingStats) {
        await bot.sendMessage(
          userId,
          `⚠️ Статистика для товара <code>${escapeHtml(offerId)}</code> уже существует. Запись не будет изменена.`,
          { parse_mode: 'HTML' }
        );

        // Этот товар уже имеет статистику — считаем его завершённым
        offerState.status = 'completed';
        offerState.waitingForWeight = false;

        // Удаляем сообщения опроса
        try {
          await bot.deleteMessage(userId, offerState.stepMessageId);
        } catch (e) { }

        try {
          await bot.deleteMessage(userId, offerState.messageId);
        } catch (e) { }

        // Проверяем завершение всех товаров
        const allCompleted = Object.values(state.offers)
          .every(o => o.status === 'completed');

        state.allCompleted = allCompleted;

        if (allCompleted) {
          await sendFinishButton(userId, state.orderId);
        }

        return;
      }

      // Получаем сотрудника
      const employee = await db.getEmployee(userId);

      if (!employee) {
        console.error(`[STATS] Не найден сотрудник Telegram ID ${userId}`);

        await bot.sendMessage(
          userId,
          '❌ Не удалось определить сотрудника. Попробуйте заново через /my_orders.',
          { parse_mode: 'HTML' }
        );

        return;
      }

      // Защита от повреждённого состояния
      if (!offerState.material || !offerState.color) {
        const errorMsg =
          '❌ Не удалось сохранить статистику: не выбраны материал или цвет. ' +
          'Заполните статистику заново через <code>/my_orders</code>.';

        await bot.sendMessage(
          userId,
          errorMsg,
          { parse_mode: 'HTML' }
        );

        // Уведомляем модератора
        const moderatorId = process.env.MODERATOR_ID;

        if (moderatorId) {
          await bot.sendMessage(
            moderatorId,
            `⚠️ Ошибка заполнения статистики для товара ` +
            `<code>${escapeHtml(offerId)}</code> пользователем ` +
            `<b>${escapeHtml(employee.name)}</b>: отсутствуют материал или цвет. ` +
            `Состояние заказа сброшено.`,
            { parse_mode: 'HTML' }
          ).catch(() => { });
        }

        // Полностью удаляем состояние для этого заказа.
        // /my_orders при необходимости восстановит его по данным из БД.
        pendingForms.delete(currentKey);

        // Удаляем связанные сообщения
        try {
          await bot.deleteMessage(userId, offerState.stepMessageId);
        } catch (e) { }

        try {
          await bot.deleteMessage(userId, offerState.messageId);
        } catch (e) { }

        try {
          await bot.deleteMessage(userId, msg.message_id);
        } catch (e) { }

        return;
      }

      // Сохраняем статистику
      try {
        await db.upsertProductStats(
          offerId,
          offerState.material,
          offerState.color,
          weight,
          employee.id
        );

        await exportProductStats();

        // Обновляем состояние товара
        offerState.weight = weight;
        offerState.status = 'completed';
        offerState.waitingForWeight = false;

        // Удаляем сообщения опроса
        try {
          await bot.deleteMessage(userId, offerState.stepMessageId);
        } catch (e) { }

        try {
          await bot.deleteMessage(userId, offerState.messageId);
        } catch (e) { }

        try {
          await bot.deleteMessage(userId, msg.message_id);
        } catch (e) { }

        // Подтверждение
        await bot.sendMessage(
          userId,
          `✅ Статистика для товара <code>${escapeHtml(offerId)}</code> сохранена.`,
          { parse_mode: 'HTML' }
        );

        // Проверяем завершение всех товаров
        const allCompleted = Object.values(state.offers)
          .every(o => o.status === 'completed');

        state.allCompleted = allCompleted;

        if (allCompleted) {
          await sendFinishButton(userId, state.orderId);
        } else {
          await bot.sendMessage(
            userId,
            'ℹ️ Остались товары без статистики. Используйте <code>/my_orders</code>, чтобы продолжить.',
            { parse_mode: 'HTML' }
          );
        }

      } catch (err) {
        console.error(
          `[ERROR] Ошибка сохранения статистики для ${offerId}:`,
          err
        );

        await bot.sendMessage(
          userId,
          `❌ Ошибка сохранения статистики для товара ` +
          `<code>${escapeHtml(offerId)}</code>: ` +
          `<b>${escapeHtml(err.message)}</b>`,
          { parse_mode: 'HTML' }
        );

        // Уведомляем модератора
        const moderatorId = process.env.MODERATOR_ID;

        if (moderatorId) {
          await bot.sendMessage(
            moderatorId,
            `⚠️ Ошибка сохранения статистики для товара ` +
            `<code>${escapeHtml(offerId)}</code> пользователем ` +
            `<b>${escapeHtml(employee.name)}</b>: ` +
            `${escapeHtml(err.message)}`,
            { parse_mode: 'HTML' }
          ).catch(() => { });
        }

        // При ошибке БД состояние НЕ удаляем.
        // Пользователь сможет повторить ввод или восстановить процесс через /my_orders.
        offerState.waitingForWeight = true;

        return;
      }
    }

    // --- Администраторское заполнение статистики (через /admin_fill_stats) ---
    const adminState = pendingStatsFill.get(userId);

    if (adminState) {
      // Ожидаем только ввод веса
      if (adminState.step !== 3) {
        await bot.sendMessage(
          userId,
          '❌ Сейчас ожидается выбор из списка. Используйте кнопки.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const weightText = text.trim().replace(',', '.');

      // Строгая проверка числа
      if (!/^\d+(?:\.\d+)?$/.test(weightText)) {
        await bot.sendMessage(
          userId,
          '❌ Введите корректное положительное число (например, <b>12.5</b>).',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const weight = Number(weightText);

      if (!Number.isFinite(weight) || weight <= 0) {
        await bot.sendMessage(
          userId,
          '❌ Введите корректное положительное число (например, <b>12.5</b>).',
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Проверяем обязательные данные состояния
      if (!adminState.data.material || !adminState.data.color) {
        await bot.sendMessage(
          userId,
          `❌ Не удалось сохранить статистику: не выбраны материал или цвет. Начните заново через <code>/admin_fill_stats ${escapeHtml(adminState.offerId)}</code>.`,
          { parse_mode: 'HTML' }
        );

        // Удаляем сообщение с запросом веса
        if (adminState.lastMessageId) {
          try {
            await bot.deleteMessage(userId, adminState.lastMessageId);
          } catch (e) { }
        }

        // Удаляем введённый администратором вес
        try {
          await bot.deleteMessage(userId, msg.message_id);
        } catch (e) { }

        // Сбрасываем состояние
        pendingStatsFill.delete(userId);

        return;
      }

      // Получаем сотрудника/администратора
      const employee = await db.getEmployee(userId);

      if (!employee) {
        console.error(
          `[ADMIN_FILL_STATS] Администратор ${userId} не найден в таблице employees`
        );

        await bot.sendMessage(
          userId,
          '❌ Не удалось определить администратора как сотрудника. ' +
          'Статистика не была изменена.',
          { parse_mode: 'HTML' }
        );

        // Состояние НЕ удаляем — администратор может исправить проблему
        return;
      }

      try {
        await db.upsertProductStats(
          adminState.offerId,
          adminState.data.material,
          adminState.data.color,
          weight,
          employee.id
        );

        await exportProductStats();

        // Удаляем сообщение с запросом веса
        if (adminState.lastMessageId) {
          try {
            await bot.deleteMessage(
              userId,
              adminState.lastMessageId
            );
          } catch (e) { }
        }

        // Удаляем сообщение администратора с введённым весом
        try {
          await bot.deleteMessage(userId, msg.message_id);
        } catch (e) { }

        await bot.sendMessage(
          userId,
          `✅ Статистика для offer_id ` +
          `<code>${escapeHtml(adminState.offerId)}</code> успешно сохранена/обновлена.\n` +
          `Материал: <b>${escapeHtml(adminState.data.material)}</b>\n` +
          `Цвет: <b>${escapeHtml(adminState.data.color)}</b>\n` +
          `Вес: <b>${weight}</b> г`,
          { parse_mode: 'HTML' }
        );

        // Завершаем административный процесс
        pendingStatsFill.delete(userId);

      } catch (err) {
        console.error('[ADMIN_FILL_STATS] Ошибка сохранения:', err);

        await bot.sendMessage(
          userId,
          `❌ Ошибка сохранения: <b>${escapeHtml(err.message)}</b>`,
          { parse_mode: 'HTML' }
        );

        // ВАЖНО: состояние не удаляем.
        // Администратор может повторить ввод веса.
        return;
      }

      return;
    }
  });
};

// ========================================================================================
// ---------------------- ВОССТАНОВЛЕНИЕ СОСТОЯНИЙ ПОСЛЕ ПЕРЕЗАПУСКА ----------------------
// ========================================================================================
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
        await bot.sendMessage(
          userId,
          `✅ Все данные для заказа <code>${escapeHtml(orderId)}</code> заполнены. Теперь вы можете завершить заказ.`,
          {
            parse_mode: 'HTML',
            ...finishKeyboard
          }
        );
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

// =======================================================================================
// ---------------------- ЦЕНТРАЛИЗОВАННАЯ ОЧИСТКА СОСТОЯНИЙ ЗАКАЗА ----------------------
// =======================================================================================
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

  // 2. Очищаем pendingFinishConfirmations (с защитой от ошибок)
  try {
    if (pendingFinishConfirmations.has(orderId)) {
      console.log(`[CLEAR] Удаляем pendingFinishConfirmations для ${orderId}`);
      const original = pendingFinishConfirmations.get(orderId);
      if (original) {
        try { await bot.deleteMessage(original.originalChatId, original.originalMessageId); } catch (e) { /* ignore */ }
      }
      pendingFinishConfirmations.delete(orderId);
    }
  } catch (e) {
    console.warn(`[CLEAR] Ошибка при удалении pendingFinishConfirmations:`, e);
  }

  // 3. Очищаем finishingOrders (с защитой от ошибок)
  try {
    if (finishingOrders.has(orderId)) {
      console.log(`[CLEAR] Удаляем finishingOrders для ${orderId}`);
      finishingOrders.delete(orderId);
    }
  } catch (e) {
    console.warn(`[CLEAR] Ошибка при удалении finishingOrders:`, e);
  }

  // 4. Проверяем, остались ли состояния
  const remaining = [];
  if (pendingFinishConfirmations.has(orderId)) remaining.push('pendingFinishConfirmations');
  if (finishingOrders.has(orderId)) remaining.push('finishingOrders');
  if (remaining.length) {
    console.warn(
      `[CLEAR] ⚠️ После очистки заказа ${orderId} ` +
      `остались состояния: ${remaining.join(', ')}`
    );
  } else {
    console.log(`[CLEAR] Завершена полная очистка заказа ${orderId}`);
  }
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