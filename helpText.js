const { escapeHtml } = require('./utils');

/**
 * Генерирует ТОЛЬКО список административных команд (без приветствия).
 * @param {boolean} debugMode - включен ли режим отладки
 * @returns {Object} { adminMessagePart1, adminMessagePart2 } - две части сообщения (для избежания переполнения)
 */
function getAdminCommandsOnly(debugMode) {
  // Часть 1: Основные команды
  let adminMessagePart1 = `🔧 Доступные административные команды:\n\n`;

  adminMessagePart1 += `/status_all [--include_fired] — показать всех сотрудников (опционально включить уволенных)\n`;
  adminMessagePart1 += `/active_orders — активные заказы\n`;
  adminMessagePart1 += `/warehouses — список складов Ozon\n`;
  adminMessagePart1 += `/orders [warehouse_id] — показать очередь заказов из API (с фильтром по складу)\n`;
  adminMessagePart1 += `/order_details <номер_заказа> — показать детали заказа\n`;
  adminMessagePart1 += `/employee_warehouses <id_сотрудника> — показать склады сотрудника\n`;
  adminMessagePart1 += `/employee_stats <id_сотрудника> — статистика сотрудника (заказы, сумма)\n`;
  adminMessagePart1 += `/employee_orders <id_сотрудника> — показать активные заказы сотрудника\n\n`;

  adminMessagePart1 += `/admin_assign_order <номер_заказа> [id_сотрудника] — назначить заказ сотруднику (если ID не указан – показать список сотрудников)\n`;
  adminMessagePart1 += `/admin_cancel_order <номер_заказа> — снять заказ с сотрудника\n\n`;

  adminMessagePart1 += `/admin_send_label <номер_заказа> [id_сотрудника] — отправить PDF‑этикетку заказа сотруднику (если ID не указан – себе)\n\n`;

  adminMessagePart1 += `/clear_assignments — сброс ВСЕХ назначений на заказы\n\n`;

  adminMessagePart1 += `/admin_fill_stats <offer_id> — заполнить/обновить статистику товара (материал, цвет, вес)\n`;
  adminMessagePart1 += `/cancel_fill_stats — отменить активный процесс заполнения статистики\n`;
  adminMessagePart1 += `/clear_product_stats <offer_id> — удалить статистику для продукта\n\n`;

  adminMessagePart1 += `/edit_earnings <id_сотрудника> <сумма> [причина] — изменение заработка сотрудника (опционально: причина изменения)\n`;
  adminMessagePart1 += `/export_earnings — экспорт активного заработка сотрудников (с корректировками)\n`;
  adminMessagePart1 += `/settle_earnings <id_сотрудника> — полный расчёт (с обнулением) активного заработка (с корректировками) сотрудника\n`;
  adminMessagePart1 += `/monthly_earnings [YYYY-MM] — экспорт заработка всех сотрудников за месяц (по умолчанию - текущий)\n\n`;

  adminMessagePart1 += `/full_reset_earnings — удалить ВСЕ записи из БД о заработке сотрудников и корректировках (с подтверждением)\n\n`;

  // Часть 2: 3D-модели и остальные команды
  let adminMessagePart2 = `📁 3D-модели:\n\n`;
  adminMessagePart2 += `/send_models <offer_id> [id_сотрудника] — отправить все модели для offer_id сотруднику (если ID не указан – себе)\n`;
  adminMessagePart2 += `/list_models <offer_id> — список моделей для offer_id\n`;
  adminMessagePart2 += `/remove_model <offer_id> <имя_файла> — удалить модель\n\n`;

  adminMessagePart2 += `📤 Загрузка моделей до 50 МБ (через бота):\n`;
  adminMessagePart2 += `/upload_model — загрузить модель, offer_id извлекается из имени файла (например, "2001867564-N_bmw.stl")\n`;
  adminMessagePart2 += `/add_model <offer_id> — загрузить модель для указанного offer_id (сначала команда, потом файл)\n`;
  adminMessagePart2 += `/cancel_model — отменить ожидание загрузки модели\n\n`;

  adminMessagePart2 += `📌 Для больших файлов (>50 МБ):\n`;
  adminMessagePart2 += `1. Залейте файл в канал моделей вручную (Telegram Desktop позволяет до 2 ГБ).\n`;
  adminMessagePart2 += `2. Перешлите сообщение боту с caption:\n`;
  adminMessagePart2 += `   offer_id: НАШ_OFFER_ID\n`;
  adminMessagePart2 += `   Файл: ИМЯ_ФАЙЛА.расширение\n`;
  adminMessagePart2 += `3. Бот автоматически привяжет модель.\n`;
  adminMessagePart2 += `Альтернативно, можно вручную привязать:\n`;
  adminMessagePart2 += `/bind_model <offer_id> <file_id> [имя_файла] — привязать существующий файл (любого размера) к offer_id\n`;
  adminMessagePart2 += `/get_file_id — получить file_id пересланного файла (для последующей привязки)\n`;
  adminMessagePart2 += `/cancel_bind — отменить ожидание file_id\n\n`;

  adminMessagePart2 += `/reload_queue — Принудительная инициализация синхронизации (вне таймера) и перезапуска очереди заказов\n\n`;
  adminMessagePart2 += `/pause — приостановить авто-проверку очереди заказов\n`;
  adminMessagePart2 += `/resume — возобновить авто-проверку очереди заказов\n\n`;

  adminMessagePart2 += `/download_materials — скачать файл цен материала за грамм "materials-prices.json"\n`;
  adminMessagePart2 += `/download_team_info — скачать файл сотрудников "team-info.xlsx"\n`;
  adminMessagePart2 += `/download_product_stats — скачать файл статистики продуктов "product-stats.xlsx" (с принудительной выгрузкой статистики из bot.db)\n`;
  adminMessagePart2 += `/download_employees_db — скачать файл "employees-db.xlsx" со ВСЕМИ сотрудниками (включая уволенных)\n`;
  adminMessagePart2 += `/download_db — скачать файл базы данных "bot.db"\n\n`;

  adminMessagePart2 += `/upload_employees — загрузить новый файл "team-info.xlsx" с сотрудниками (автоматически синхронизирует БД)\n`;
  adminMessagePart2 += `/upload_materials — загрузить новый файл "materials-prices.json" с ценами материалов\n\n`;

  adminMessagePart2 += `/backup_db — создать бэкап базы данных "bot.db"\n\n`;

  adminMessagePart2 += `/remove_all_promotions — удаление ВСЕХ товаров из ВСЕХ акций Ozon (с подтверждением)\n\n`;

  adminMessagePart2 += `/full_reset_and_sync — сброс ВСЕХ данных в БД (сотрудники, склады, назначения), кроме 3D-моделей, статистики товаров и заработка сотрудников, синхронизация складов/сотрудников\n\n`;

  if (debugMode) adminMessagePart2 += `/debug_clear — сбросить отладочные назначения\n`;

  return { adminMessagePart1, adminMessagePart2 };
}

/**
 * Полное приветственное сообщение для администратора (используется в /start).
 * @param {Object|null} employee - данные сотрудника или null
 * @param {number} activeCount - количество активных заказов
 * @param {boolean} debugMode - режим отладки
 * @returns {Object} { welcome, adminMessagePart1, adminMessagePart2 }
 */
function getAdminStartMessage(employee, activeCount, debugMode) {
  let welcome = `👋 Добро пожаловать, Администратор!\n\n`;
  if (!employee) {
    welcome += `⚠️ Вы ещё не добавлены в базу сотрудников.\n`;
    welcome += `Для начала работы используйте команду /add_self.\n\n`;
  } else {
    welcome += `Вы зарегистрированы как <b>${escapeHtml(employee.name)}</b>\nАктивных Заказов: ${activeCount}\n3D-принтеров: ${employee.capacity}\n\n`;
  }
  const commands = getAdminCommandsOnly(debugMode);
  return {
    welcome, // с HTML
    commandsPart1: commands.adminMessagePart1,  // без HTML
    commandsPart2: commands.adminMessagePart2   // без HTML
  };
}

/**
 * Только список команд для сотрудника (без приветствия).
 * @returns {string}
 */
function getEmployeeCommandsOnly() {
  let text = `🔧 Доступные команды:\n`;
  text += `/start — перезапустить бота\n`;
  text += `/my_orders — показать мои активные заказы\n`;
  text += `/toggle_orders — приостановить/возобновить приём заказов\n`;
  text += `/finish_order <номер_заказа> — завершить заказ (получить этикетку)\n`;
  text += `/cancel_order <номер_заказа> — отменить заказ (если не можете выполнить)\n`;
  text += `/send_label <номер_заказа> — получить этикетку завершённого заказа (не чаще 1 раза в минуту)\n`;
  text += `/send_all_labels — получить этикетки всех завершённых заказов (не чаще 1 раза в час)\n`;
  text += `/my_monthly_earnings [YYYY-MM] — показать мой заработок за ЛЮБОЙ месяц (по умолчанию - текущий)\n`;
  text += `/my_active_earnings — показать мой полный активный заработок (с момента последнего расчёта)\n`;
  text += `/help — эта справка\n`;
  return text;
}
/**
 * Полное приветствие для сотрудника (используется в /start).
 * @param {Object} employee - данные сотрудника
 * @param {number} activeCount - количество активных заказов
 * @returns {Object} { welcome, commands }
 */
function getEmployeeStartMessage(employee, activeCount) {
  let welcome = activeCount ? `С возвращением, ` : `Добро пожаловать, ` + `<b>${escapeHtml(employee.name)}</b>!\n`;
  if (activeCount) welcome += `У вас активно заказов: ${activeCount}.\n`;
  welcome += `Новые заказы назначает Модератор.\n\n`;
  return {
    welcome, // с HTML
    commands: getEmployeeCommandsOnly() // без HTML
  };
}

/**
 * Сообщение для неавторизованного пользователя.
 * @returns {string}
 */
function getUnauthorizedMessage() {
  return '🤖 Здравствуйте! Этот бот для сотрудников склада. Если вы здесь по работе, обратитесь к администратору для получения доступа.';
}

module.exports = {
  getAdminCommandsOnly,
  getAdminStartMessage,
  getEmployeeCommandsOnly,
  getEmployeeStartMessage,
  getUnauthorizedMessage,
};