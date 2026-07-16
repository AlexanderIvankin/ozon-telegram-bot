const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let database; // внутреннее хранилище соединения

async function initDB() {
    console.log('[DB] Открытие базы данных...');
    database = await open({
        filename: path.join(__dirname, 'bot.db'),
        driver: sqlite3.Database,
        trace: process.env.NODE_ENV === 'development' ? console.log : undefined
    });
    console.log('[DB] База данных открыта');

    // Таблица сотрудников
    await database.exec(`
    CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_user_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        capacity INTEGER DEFAULT 1
    )
`);

    // Проверяем наличие всех необходимых колонок (phone, is_fired, earnings_factor)
    const tableInfo = await database.all("PRAGMA table_info(employees)");
    const hasPhone = tableInfo.some(col => col.name === 'phone');
    const hasIsFired = tableInfo.some(col => col.name === 'is_fired');
    const hasEarningsFactor = tableInfo.some(col => col.name === 'earnings_factor');
    const hasCapacity = tableInfo.some(col => col.name === 'capacity');

    if (!hasPhone) {
        await database.run('ALTER TABLE employees ADD COLUMN phone TEXT');
        console.log('[DB] Добавлена колонка phone в employees');
    }
    if (!hasIsFired) {
        await database.run('ALTER TABLE employees ADD COLUMN is_fired INTEGER DEFAULT 0');
        console.log('[DB] Добавлена колонка is_fired в employees');
    }
    if (!hasEarningsFactor) {
        await database.run('ALTER TABLE employees ADD COLUMN earnings_factor REAL DEFAULT 1.0');
        console.log('[DB] Добавлена колонка earnings_factor в employees');
    }
    if (!hasCapacity) {
        await database.run('ALTER TABLE employees ADD COLUMN capacity INTEGER DEFAULT 1');
        console.log('[DB] Добавлена колонка capacity в employees');
    }

    // Таблица назначенных заказов
    await database.exec(`
    CREATE TABLE IF NOT EXISTS assignments (
        order_id TEXT PRIMARY KEY,
        employee_id INTEGER NOT NULL,
        assigned_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT DEFAULT 'assigned',
        FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
`);

    // Таблица складов
    await database.exec(`
        CREATE TABLE IF NOT EXISTS warehouses (
            warehouse_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            address TEXT,
            is_rfbs INTEGER DEFAULT 0,
            last_synced_at INTEGER
        )
    `);

    // Таблица связки сотрудник-склад
    await database.exec(`
    CREATE TABLE IF NOT EXISTS employee_warehouses (
        employee_id INTEGER NOT NULL,
        warehouse_id TEXT NOT NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id),
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(warehouse_id),
        PRIMARY KEY (employee_id, warehouse_id)
    )
`);

    // Таблица статистики сотрудников
    await database.exec(`
    CREATE TABLE IF NOT EXISTS employee_stats (
        employee_id INTEGER PRIMARY KEY,
        total_orders INTEGER DEFAULT 0,
        total_amount INTEGER DEFAULT 0,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
`);

    const statsInfo = await database.all("PRAGMA table_info(employee_stats)");
    const hasCanceled = statsInfo.some(col => col.name === 'canceled_orders');
    if (!hasCanceled) {
        await database.run('ALTER TABLE employee_stats ADD COLUMN canceled_orders INTEGER DEFAULT 0');
        console.log('[DB] Добавлена колонка canceled_orders в employee_stats');
    }

    // Таблица заработка сотрудников employee_earnings ЗА ВСЁ ВРЕМЯ
    await database.exec(`
    CREATE TABLE IF NOT EXISTS employee_earnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        order_id TEXT NOT NULL,
        amount REAL NOT NULL,
        calculated_at INTEGER NOT NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
`);
    await database.exec(`CREATE INDEX IF NOT EXISTS idx_employee_earnings_employee_id ON employee_earnings(employee_id);`);

    // Таблица активного рассчёта заработка сотрудников employee_earnings_active
    await database.exec(`
    CREATE TABLE employee_earnings_active(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        order_id TEXT NOT NULL,
        amount REAL NOT NULL,
        calculated_at INTEGER NOT NULL,
        FOREIGN KEY(employee_id) REFERENCES employees(id)
    );
`);

    // Таблица истории корректировок заработка employee_earnings_adjustments
    await database.exec(`
    CREATE TABLE IF NOT EXISTS employee_earnings_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        reason TEXT,
        adjusted_at INTEGER NOT NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
`);
    await database.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_employee_id ON employee_earnings_adjustments(employee_id);`);
    await database.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_adjusted_at ON employee_earnings_adjustments(adjusted_at);`);

    // Таблица активных корректировок заработка
    await database.exec(`
    CREATE TABLE IF NOT EXISTS employee_earnings_adjustments_active (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        reason TEXT,
        adjusted_at INTEGER NOT NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
`);
    await database.exec(`CREATE INDEX IF NOT EXISTS idx_adjustments_active_employee_id ON employee_earnings_adjustments_active(employee_id);`);

    // Таблица статистики по товарам product_stats
    await database.exec(`
    CREATE TABLE IF NOT EXISTS product_stats (
        offer_id TEXT PRIMARY KEY,
        material TEXT NOT NULL,
        color TEXT NOT NULL,
        weight_grams REAL NOT NULL,
        employee_id INTEGER,
        updated_at INTEGER,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
`);

    // Таблица 3D-моделей товаров
    await database.exec(`
    CREATE TABLE IF NOT EXISTS product_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        file_name TEXT,
        file_size INTEGER,
        uploaded_at INTEGER
    )
`);
    await database.exec(`CREATE INDEX IF NOT EXISTS idx_product_models_offer_id ON product_models(offer_id);`);

    // Таблица пропущенных при заливке 3D-моделей
    await database.exec(`
    CREATE TABLE IF NOT EXISTS skipped_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        reason TEXT,
        file_size_mb REAL,
        created_at INTEGER
    )
`);
    await database.exec(`CREATE INDEX IF NOT EXISTS idx_skipped_models_offer_id ON skipped_models(offer_id);`);

    // Одноразовое копирование исторических данных в активные таблицы, если они пусты
    try {
        // Одноразовое копирование исторических данных в активные таблицы, если они пусты
        await database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`);

        // Проверяем флаг initial_copy_done
        const copyDone = await database.get("SELECT value FROM app_settings WHERE key = 'initial_copy_done'");
        if (!copyDone) {
            console.log('[DB] Начинаем одноразовое копирование заработков...');
            // Выполняем копирование
            const activeEarningsCount = await database.get('SELECT COUNT(*) as count FROM employee_earnings_active');
            if (activeEarningsCount.count === 0) {
                const historyCount = await database.get('SELECT COUNT(*) as count FROM employee_earnings');
                if (historyCount.count > 0) {
                    console.log('[DB] Копирование исторических заработков в активную таблицу...');
                    await database.run(`
                INSERT INTO employee_earnings_active (employee_id, order_id, amount, calculated_at)
                SELECT employee_id, order_id, amount, calculated_at FROM employee_earnings
            `);
                    console.log('[DB] Копирование заработков завершено');
                } else {
                    console.log('[DB] Нет исторических заработков для копирования');
                }
            }
            const activeAdjCount = await database.get('SELECT COUNT(*) as count FROM employee_earnings_adjustments_active');
            if (activeAdjCount.count === 0) {
                const historyAdjCount = await database.get('SELECT COUNT(*) as count FROM employee_earnings_adjustments');
                if (historyAdjCount.count > 0) {
                    console.log('[DB] Копирование исторических корректировок в активную таблицу...');
                    await database.run(`
                INSERT INTO employee_earnings_adjustments_active (employee_id, amount, reason, adjusted_at)
                SELECT employee_id, amount, reason, adjusted_at FROM employee_earnings_adjustments
            `);
                    console.log('[DB] Копирование корректировок завершено');
                } else {
                    console.log('[DB] Нет исторических корректировок для копирования');
                }
            }
            // Устанавливаем флаг
            await database.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('initial_copy_done', 'true')");
            console.log('[DB] Одноразовое копирование завершено');
        } else {
            console.log('[DB] Одноразовое копирование уже выполнено ранее, пропускаем');
        }
    } catch (err) {
        console.error('[DB] Ошибка при одноразовом копировании:', err);
        // В случае ошибки всё равно пытаемся установить флаг, чтобы избежать повторных попыток
        try {
            await database.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('initial_copy_done', 'true')");
            console.log('[DB] Флаг initial_copy_done установлен несмотря на ошибку');
        } catch (setErr) {
            console.error('[DB] Не удалось установить флаг initial_copy_done:', setErr);
        }
        // Не выбрасываем ошибку, чтобы бот продолжил работу
    }

    return database;
}

function getDB() {
    return database;
}

// Добавить сотрудника (если нет)
async function addEmployee(tgUserId, name, phone = '') {
    const exists = await database.get('SELECT id FROM employees WHERE tg_user_id = ?', tgUserId);
    if (!exists) {
        await database.run(
            'INSERT INTO employees (tg_user_id, name, capacity, phone) VALUES (?, ?, 1, ?)',
            tgUserId, name, phone
        );
    }
}

// Получить сотрудника по tg_user_id (строковый ID)
async function getEmployee(tgUserId) {
    return database.get('SELECT * FROM employees WHERE tg_user_id = ?', tgUserId);
}

// Получить сотрудника по tg_user_id
async function getEmployeeById(employeeId) {
    return database.get('SELECT * FROM employees WHERE id = ?', employeeId);
}

// Назначить заказ сотруднику
async function assignOrderToEmployee(orderId, employeeId) {
    await database.run(
        `INSERT OR REPLACE INTO assignments (order_id, employee_id, assigned_at, status)
         VALUES (?, ?, ?, ?)`,
        orderId, employeeId, Date.now(), 'assigned'
    );
}

// Отменить заказ (сотрудник)
async function cancelOrder(orderId, employeeId) {
    // Проверяем, что заказ принадлежит этому сотруднику и ещё не завершён
    const assignment = await database.get(
        'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "assigned"',
        orderId, employeeId
    );
    if (!assignment) throw new Error('Заказ не найден или уже завершён');

    // Удаляем назначение
    await database.run('DELETE FROM assignments WHERE order_id = ?', orderId);

    // Обновляем счётчик отменённых заказов
    const existing = await database.get('SELECT canceled_orders FROM employee_stats WHERE employee_id = ?', employeeId);
    if (existing) {
        await database.run('UPDATE employee_stats SET canceled_orders = canceled_orders + 1 WHERE employee_id = ?', employeeId);
    } else {
        await database.run('INSERT INTO employee_stats (employee_id, canceled_orders, total_orders, total_amount) VALUES (?, 1, 0, 0)', employeeId);
    }
    return true;
}

// Автоматическая отмена заказа (без увеличения счётчика отмен)
async function autoCancelOrder(orderId, employeeId) {
    // Проверяем, что заказ принадлежит этому сотруднику и ещё не завершён
    const assignment = await database.get(
        'SELECT * FROM assignments WHERE order_id = ? AND employee_id = ? AND status = "assigned"',
        orderId, employeeId
    );
    if (!assignment) throw new Error('Заказ не найден или уже завершён');
    // Удаляем назначение
    await database.run('DELETE FROM assignments WHERE order_id = ?', orderId);
    // НЕ обновляем статистику отмен
    return true;
}

// Завершить заказ
async function completeOrder(orderId) {
    await database.run(
        `UPDATE assignments SET status = 'completed', completed_at = ? WHERE order_id = ?`,
        Date.now(), orderId
    );
}

// Получить всех сотрудников со статистикой активных заказов (опицональный фильтр по приоритетным warehouse_id)
async function getAllEmployeesWithStats(warehouseId = null, includeFired = false) {
    let sql = `
        SELECT e.id, e.tg_user_id, e.name, e.phone, e.capacity, e.earnings_factor, e.is_fired,
               (SELECT COUNT(*) FROM assignments a WHERE a.employee_id = e.id AND a.status = 'assigned') as active_count
        FROM employees e
    `;
    const params = [];
    if (!includeFired) {
        sql += ` WHERE e.is_fired = 0`;
    }
    if (warehouseId) {
        if (!includeFired) {
            sql += ` AND`;
        } else {
            sql += ` WHERE`;
        }
        sql += ` EXISTS (SELECT 1 FROM employee_warehouses ew WHERE ew.employee_id = e.id AND ew.warehouse_id = ?)`;
        params.push(warehouseId);
    }
    sql += ` ORDER BY e.id`;
    const rows = await database.all(sql, params);
    return rows;
}

// Получить список активных заказов сотрудника (для админа)
async function getEmployeeActiveOrders(employeeId) {
    return database.all(
        `SELECT order_id, assigned_at FROM assignments WHERE employee_id = ? AND status = 'assigned'`,
        employeeId
    );
}

// Получить активные заказы сотрудника (количество)
async function getEmployeeActiveOrdersCount(employeeId) {
    const row = await database.get(
        'SELECT COUNT(*) as count FROM assignments WHERE employee_id = ? AND status = "assigned"',
        employeeId
    );
    return row ? row.count : 0;
}

// Сохранить заработок сотрудника в employee_earnings
async function saveEmployeeEarnings(employeeId, orderId, amount) {
    await database.run(
        `INSERT INTO employee_earnings (employee_id, order_id, amount, calculated_at)
         VALUES (?, ?, ?, ?)`,
        employeeId, orderId, amount, Date.now()
    );
}

// Получить историю заработка сотрудника за период (для экспорта)
async function getEmployeeEarnings(employeeId, fromDate, toDate) {
    // для будущего экспорта
    return database.all(
        `SELECT order_id, amount, calculated_at FROM employee_earnings
         WHERE employee_id = ? AND calculated_at >= ? AND calculated_at <= ?
         ORDER BY calculated_at`,
        employeeId, fromDate, toDate
    );
}

// Получить историю заработков всех сотрудников за период (для экспорта)
async function getAllEmployeeEarningsForPeriod(fromDate, toDate) {
    return database.all(`
        SELECT e.id, e.name, ee.order_id, ee.amount, ee.calculated_at
        FROM employee_earnings ee
        JOIN employees e ON ee.employee_id = e.id
        WHERE ee.calculated_at >= ? AND ee.calculated_at <= ?
        ORDER BY e.id, ee.calculated_at
    `, fromDate, toDate);
}

// Сохранить заработок в активную таблицу
async function saveEmployeeEarningsActive(employeeId, orderId, amount) {
    await database.run(
        `INSERT INTO employee_earnings_active (employee_id, order_id, amount, calculated_at)
         VALUES (?, ?, ?, ?)`,
        employeeId, orderId, amount, Date.now()
    );
}

// Получить активные заработки сотрудника за период (или все)
async function getActiveEmployeeEarnings(employeeId, fromDate, toDate) {
    return database.all(
        `SELECT order_id, amount, calculated_at FROM employee_earnings_active
         WHERE employee_id = ? AND calculated_at >= ? AND calculated_at <= ?
         ORDER BY calculated_at`,
        employeeId, fromDate, toDate
    );
}

// Получить все активные заработки всех сотрудников за период (для экспорта)
async function getAllActiveEmployeeEarningsForPeriod(fromDate, toDate) {
    return database.all(`
        SELECT e.id, e.name, ee.order_id, ee.amount, ee.calculated_at
        FROM employee_earnings_active ee
        JOIN employees e ON ee.employee_id = e.id
        WHERE ee.calculated_at >= ? AND ee.calculated_at <= ?
        ORDER BY e.id, ee.calculated_at
    `, fromDate, toDate);
}

// Очистить активные заработки для сотрудника (расчёт произведён)
async function clearActiveEarningsForEmployee(employeeId) {
    await database.run(
        'DELETE FROM employee_earnings_active WHERE employee_id = ?',
        employeeId
    );
}

// Получить сумму активных заработков для сотрудника за период
async function getActiveEmployeeEarningsSum(employeeId, fromDate, toDate) {
    const row = await database.get(
        `SELECT COALESCE(SUM(amount), 0) as total FROM employee_earnings_active
         WHERE employee_id = ? AND calculated_at >= ? AND calculated_at <= ?`,
        employeeId, fromDate, toDate
    );
    return row ? row.total : 0;
}

/**
 * Добавляет корректировку заработка для сотрудника
 */
async function addEarningsAdjustment(employeeId, amount, reason = '') {
    await database.run(
        `INSERT INTO employee_earnings_adjustments (employee_id, amount, reason, adjusted_at)
         VALUES (?, ?, ?, ?)`,
        employeeId, amount, reason, Date.now()
    );
}

/**
 * Получает сумму корректировок за период для сотрудника
 */
async function getEmployeeAdjustments(employeeId, fromDate, toDate) {
    const row = await database.get(
        `SELECT COALESCE(SUM(amount), 0) as total FROM employee_earnings_adjustments
         WHERE employee_id = ? AND adjusted_at >= ? AND adjusted_at <= ?`,
        employeeId, fromDate, toDate
    );
    return row ? row.total : 0;
}

/**
 * Получает все корректировки за период для всех сотрудников (для экспорта)
 */
async function getAllAdjustmentsForPeriod(fromDate, toDate) {
    return database.all(
        `SELECT e.id, e.name, a.amount, a.reason, a.adjusted_at
         FROM employee_earnings_adjustments a
         JOIN employees e ON a.employee_id = e.id
         WHERE a.adjusted_at >= ? AND a.adjusted_at <= ?
         ORDER BY e.id, a.adjusted_at`,
        fromDate, toDate
    );
}

// Сохранить корректировку в активную таблицу
async function saveEarningsAdjustmentActive(employeeId, amount, reason = '') {
    await database.run(
        `INSERT INTO employee_earnings_adjustments_active (employee_id, amount, reason, adjusted_at)
         VALUES (?, ?, ?, ?)`,
        employeeId, amount, reason, Date.now()
    );
}

// Получить сумму активных корректировок за период для сотрудника
async function getActiveAdjustmentsSum(employeeId, fromDate, toDate) {
    const row = await database.get(
        `SELECT COALESCE(SUM(amount), 0) as total FROM employee_earnings_adjustments_active
         WHERE employee_id = ? AND adjusted_at >= ? AND adjusted_at <= ?`,
        employeeId, fromDate, toDate
    );
    return row ? row.total : 0;
}

// Очистить активные корректировки для сотрудника
async function clearActiveAdjustmentsForEmployee(employeeId) {
    await database.run(
        'DELETE FROM employee_earnings_adjustments_active WHERE employee_id = ?',
        employeeId
    );
}

/**
 * Синхронизирует список складов, полученный из API, с базой данных.
 * @param {Array} warehouses - Массив складов от Ozon API.
 */
async function syncWarehouses(warehouses) {
    await database.run('DELETE FROM warehouses'); // очищаем старые
    const now = Date.now();
    for (const wh of warehouses) {
        await database.run(
            `INSERT INTO warehouses (warehouse_id, name, address, is_rfbs, last_synced_at)
             VALUES (?, ?, ?, ?, ?)`,
            wh.warehouse_id, wh.name, wh.address || null, wh.is_rfbs ? 1 : 0, now
        );
    }
    console.log(`[DB] Синхронизировано складов: ${warehouses.length}`);
}

/**
 * Получает список всех складов из базы данных.
 * @returns {Promise<Array>}
 */
async function getAllWarehouses() {
    return database.all('SELECT warehouse_id, name, address, is_rfbs FROM warehouses ORDER BY name');
}

/**
 * Получает название склада по его ID.
 * @param {string} warehouseId - ID склада.
 * @returns {Promise<string>}
 */
async function getWarehouseNameById(warehouseId) {
    const result = await database.get('SELECT name FROM warehouses WHERE warehouse_id = ?', warehouseId);
    return result ? result.name : warehouseId;
}

// Обновить статистику сотрудника при завершении заказа
async function updateEmployeeStats(employeeId, orderAmount = 0) {
    await database.run(
        `INSERT INTO employee_stats (employee_id, total_orders, total_amount, canceled_orders)
         VALUES (?, 1, ?, 0)
         ON CONFLICT(employee_id) DO UPDATE SET
         total_orders = total_orders + 1,
         total_amount = total_amount + ?,
         canceled_orders = COALESCE(canceled_orders, 0)`,
        employeeId, orderAmount, orderAmount
    );
}

// Получить статистику сотрудника
async function getEmployeeStats(employeeId) {
    const stats = await database.get(
        `SELECT total_orders, total_amount, canceled_orders FROM employee_stats WHERE employee_id = ?`,
        employeeId
    );
    return stats || { total_orders: 0, total_amount: 0, canceled_orders: 0 };
}

/**
 * Получить статистику товара по артикулу
 */
async function getProductStats(offerId) {
    return database.get('SELECT * FROM product_stats WHERE offer_id = ?', offerId);
}

/**
 * Вставить новую запись по товару (только если её нет)
 */
async function upsertProductStats(offerId, material, color, weight, employeeId) {
    // Используем INSERT OR REPLACE – если запись существует, обновим (но по заданию не нужно)
    // Вместо этого можно просто INSERT, но чтобы избежать ошибки, сделаем UPSERT
    await database.run(`
        INSERT INTO product_stats (offer_id, material, color, weight_grams, employee_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(offer_id) DO UPDATE SET
            material = excluded.material,
            color = excluded.color,
            weight_grams = excluded.weight_grams,
            employee_id = excluded.employee_id,
            updated_at = excluded.updated_at
    `, offerId, material, color, weight, employeeId, Date.now());
}

/**
 * Получить все записи для экспорта
 */
async function getAllProductStats() {
    return database.all(`
        SELECT ps.offer_id, ps.material, ps.color, ps.weight_grams, ps.employee_id, e.name as employee_name, ps.updated_at
        FROM product_stats ps
        LEFT JOIN employees e ON ps.employee_id = e.id
        ORDER BY ps.offer_id
    `);
}

// Добавить модель (при заливке)
async function addProductModel(offerId, fileId, fileName, fileSize) {
    await database.run(
        `INSERT INTO product_models (offer_id, file_id, file_name, file_size, uploaded_at)
         VALUES (?, ?, ?, ?, ?)`,
        offerId, fileId, fileName, fileSize, Date.now()
    );
}

// Получить все модели для offer_id (учитывая обрезание суффикса)
async function getProductModels(offerId) {
    // Отрезаем суффикс типа -N, -X, -NR, -NL и т.д.
    const prefix = offerId.split('-')[0];
    // Ищем модели, у которых offer_id начинается с этого префикса
    return database.all(
        `SELECT file_id, file_name, file_size FROM product_models WHERE offer_id LIKE ? ORDER BY file_name`,
        `${prefix}%`
    );
}

// Удалить все модели для offer_id с указанным именем файла
async function deleteProductModel(offerId, fileName) {
    await database.run(
        `DELETE FROM product_models WHERE offer_id = ? AND file_name = ?`,
        offerId, fileName
    );
}

// Получить все модели для offer_id (без ограничений)
async function getAllProductModels(offerId) {
    return database.all(
        `SELECT file_id, file_name, file_size FROM product_models WHERE offer_id = ? ORDER BY file_name`,
        offerId
    );
}

// Добавить или обновить модель (если уже существует запись с таким offer_id и file_name)
async function upsertProductModel(offerId, fileId, fileName, fileSize) {
    const existing = await database.get(
        'SELECT id FROM product_models WHERE offer_id = ? AND file_name = ?',
        offerId, fileName
    );
    if (existing) {
        await database.run(
            'UPDATE product_models SET file_id = ?, file_size = ?, uploaded_at = ? WHERE offer_id = ? AND file_name = ?',
            fileId, fileSize, Date.now(), offerId, fileName
        );
    } else {
        await database.run(
            'INSERT INTO product_models (offer_id, file_id, file_name, file_size, uploaded_at) VALUES (?, ?, ?, ?, ?)',
            offerId, fileId, fileName, fileSize, Date.now()
        );
    }
}

// Получить модели с расширениями из списка
async function getProductModelsByExtensions(offerId, extensions) {
    if (!extensions || !extensions.length) return [];
    // Строим условия: file_name LIKE '%ext1' OR file_name LIKE '%ext2' ...
    const conditions = extensions.map(() => 'file_name LIKE ?').join(' OR ');
    // Параметры: сначала offer_id, затем каждый extension с добавленным %
    const params = [offerId, ...extensions.map(ext => `%${ext}`)];
    return database.all(
        `SELECT file_id, file_name, file_size FROM product_models 
         WHERE offer_id = ? AND (${conditions})`,
        params
    );
}

// Возвращает родительский offer_id (без суффикса -NR / -NL) или null, если суффикса нет
function getParentOfferId(offerId) {
    if (offerId.endsWith('-NR') || offerId.endsWith('-NL')) {
        // Убираем последний символ (R или L), оставляя "-N"
        return offerId.slice(0, -1);
    }
    return null;
}

// Получить текстовые файлы (например .txt)
async function getTextFilesForOfferId(offerId) {
    return database.all(
        `SELECT file_id, file_name, file_size FROM product_models 
         WHERE offer_id = ? AND file_name LIKE '%.txt'`,
        offerId
    );
}

// Получить пропущенные модели для offer_id
async function getSkippedModels(offerId) {
    return database.all(
        `SELECT file_name, reason FROM skipped_models WHERE offer_id = ? ORDER BY file_name`,
        offerId
    );
}

// Добавить пропущенную модель (для загрузчика)
async function addSkippedModel(offerId, fileName, reason, fileSizeMb) {
    await database.run(
        `INSERT INTO skipped_models (offer_id, file_name, reason, file_size_mb, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        offerId, fileName, reason, fileSizeMb, Date.now()
    );
}



module.exports = {
    initDB,
    getDB,
    addEmployee,
    getEmployee,
    getEmployeeById,
    assignOrderToEmployee,
    cancelOrder,
    autoCancelOrder,
    completeOrder,
    getAllEmployeesWithStats,
    getEmployeeActiveOrders,
    getEmployeeActiveOrdersCount,
    saveEmployeeEarnings,
    getEmployeeEarnings,
    getAllEmployeeEarningsForPeriod,
    saveEmployeeEarningsActive,
    getActiveEmployeeEarnings,
    getAllActiveEmployeeEarningsForPeriod,
    clearActiveEarningsForEmployee,
    getActiveEmployeeEarningsSum,
    addEarningsAdjustment,
    getEmployeeAdjustments,
    getAllAdjustmentsForPeriod,
    saveEarningsAdjustmentActive,
    getActiveAdjustmentsSum,
    clearActiveAdjustmentsForEmployee,
    syncWarehouses,
    getAllWarehouses,
    getWarehouseNameById,
    updateEmployeeStats,
    getEmployeeStats,
    getProductStats,
    upsertProductStats,
    getAllProductStats,
    addProductModel,
    getProductModels,
    deleteProductModel,
    getAllProductModels,
    upsertProductModel,
    getProductModelsByExtensions,
    getParentOfferId,
    getTextFilesForOfferId,
    addSkippedModel,
    getSkippedModels,
};

// Геттер для доступа к database через .db (для обратной совместимости с bot.js)
Object.defineProperty(module.exports, 'db', {
    get: () => database
});