const path = require('path');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

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

const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

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
  mergePdfs,
  colToLetter,
  escapeHtml,
  stripHtml,
  formatLocalTimestamp,
  formatDateDDMMYYYY,
  getLocalDate,
  getLocalTime,
  getLocalTimestamp,
};