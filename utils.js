require('dotenv').config();

const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

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
  // Формируем строку в локальном времени и парсим обратно в Date
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
  const getPart = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
  const year = getPart('year');
  const month = getPart('month') - 1; // месяцы в JS 0-11
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

// Функция для формирования вывода в HTML parse mode
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  formatLocalTimestamp,
  formatDateDDMMYYYY,
  getLocalDate,
  getLocalTime,
  getLocalTimestamp,
  escapeHtml,
};