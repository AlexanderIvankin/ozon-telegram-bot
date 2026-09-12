const path = require('path');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

/**
 * Возвращает имя файла с суффиксом версии бота, если BOT_VERSION задан.
 * @param {string} baseName - базовое имя файла (без расширения)
 * @param {string} extension - расширение с точкой (например, '.json')
 * @returns {string} - имя файла с версией или без
 */
function getVersionedFileName(baseName, extension = '') {
  const version = process.env.BOT_VERSION;
  if (version) {
    return `${baseName}-${version}${extension}`;
  }
  return `${baseName}${extension}`;
}

/**
 * Возвращает путь к файлу с суффиксом версии бота, если BOT_VERSION задан.
 * @param {string} filePath - полный путь к файлу
 * @returns {string} - путь с версией или без
 */
function getVersionedPath(filePath) {
  const version = process.env.BOT_VERSION;
  if (!version) return filePath;
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}-${version}${parsed.ext}`);
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

// Функция для склейки PDF файлов
async function mergePdfs(pdfBuffers) {
  if (!pdfBuffers.length) return null;
  const mergedPdf = await PDFDocument.create();
  for (const buffer of pdfBuffers) {
    try {
      const pdf = await PDFDocument.load(buffer);
      const indices = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      for (const page of indices) {
        mergedPdf.addPage(page);
      }
    } catch (err) {
      console.error('Ошибка при объединении PDF:', err);
      // Пропускаем битый PDF
    }
  }
  return await mergedPdf.save();
}

// Функция для преобразования номера строки в букву
function colToLetter(col) {
  let letter = '';
  while (col > 0) {
    let rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// Функция для формирования вывода в HTML parse mode
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Функция для удаления HTML тегов из регулярных выражений
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '');
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

/**
 * Форматирует дату для имени файла: YYYY-MM-DD_HH-MM-SS в указанном часовом поясе
 */
function formatLocalTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  }).formatToParts(date);

  const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');
  const second = getPart('second');
  return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
}

/**
 * Форматирует timestamp (число мс) в DD.MM.YYYY в указанном часовом поясе
 */
function formatDateDDMMYYYY(timestamp) {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TIMEZONE
  }).formatToParts(date);
  const day = parts.find(p => p.type === 'day')?.value || '??';
  const month = parts.find(p => p.type === 'month')?.value || '??';
  const year = parts.find(p => p.type === 'year')?.value || '????';
  return `${day}.${month}.${year}`;
}

/**
 * Возвращает текущую дату и время в указанном часовом поясе как объект Date.
 * @returns {Date}
 */
function getLocalDate() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  });

  const parts = formatter.formatToParts(now);
  const getPart = (type) => parseInt(
    parts.find(p => p.type === type)?.value || '0',
    10
  );

  const year = getPart('year');
  const month = getPart('month') - 1;
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');
  const second = getPart('second');

  return new Date(year, month, day, hour, minute, second);
}

/**
 * Возвращает объект с часами и минутами локального времени.
 * @returns {{ hours: number, minutes: number }}
 */
function getLocalTime() {
  const date = getLocalDate();
  return {
    hours: date.getHours(),
    minutes: date.getMinutes()
  };
}

/**
 * Форматирует дату для логов: YYYY-MM-DD HH:MM:SS в локальном времени.
 * @returns {string}
 */
function getLocalTimestamp() {
  const date = getLocalDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = {
  getVersionedFileName,
  getVersionedPath,
  formatOrderDetails,
  mergePdfs,
  colToLetter,
  escapeHtml,
  stripHtml,
  formatPhone,
  formatLocalTimestamp,
  formatDateDDMMYYYY,
  getLocalDate,
  getLocalTime,
  getLocalTimestamp,
};