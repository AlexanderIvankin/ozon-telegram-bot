const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let database; // внутреннее хранилище соединения

async function initDB() {
    database = await open({
        filename: path.join(__dirname, 'bot.db'),
        driver: sqlite3.Database,
        trace: process.env.NODE_ENV === 'development' ? console.log : undefined
    });

    // Таблица сотрудников
    await database.exec(`
    CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_user_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        capacity INTEGER DEFAULT 1
    )
`);

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

    // Проверяем и добавляем колонку capacity, если отсутствует
    const tableInfo = await database.all("PRAGMA table_info(employees)");
    const hasCapacity = tableInfo.some(col => col.name === 'capacity');
    if (!hasCapacity) {
        await database.run('ALTER TABLE employees ADD COLUMN capacity INTEGER DEFAULT 1');
        console.log('[DB] Добавлена колонка capacity в employees');
    }

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

    return database;
}

function getDB() {
    return database;
}

// Добавить сотрудника (если нет)
async function addEmployee(tgUserId, name) {
    const exists = await database.get('SELECT id FROM employees WHERE tg_user_id = ?', tgUserId);
    if (!exists) {
        await database.run(
            'INSERT INTO employees (tg_user_id, name, capacity) VALUES (?, ?, 1)',
            tgUserId, name
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
async function getAllEmployeesWithStats(warehouseId = null) {
    let sql = `
        SELECT e.id, e.tg_user_id, e.name, e.capacity,
               (SELECT COUNT(*) FROM assignments a WHERE a.employee_id = e.id AND a.status = 'assigned') as active_count
        FROM employees e
    `;
    const params = [];
    if (warehouseId) {
        sql += ` INNER JOIN employee_warehouses ew ON e.id = ew.employee_id WHERE ew.warehouse_id = ?`;
        params.push(warehouseId);
    }
    sql += ` ORDER BY e.name`;
    const rows = await database.all(sql, params);
    // Добавим поле warehouse для совместимости (можно вернуть список складов, но не обязательно)
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
    return database.all('SELECT * FROM product_stats ORDER BY offer_id');
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