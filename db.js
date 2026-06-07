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
        warehouse TEXT,
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

    await database.exec(`
    CREATE TABLE IF NOT EXISTS employee_stats (
        employee_id INTEGER PRIMARY KEY,
        total_orders INTEGER DEFAULT 0,
        total_amount INTEGER DEFAULT 0,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
`);

    return database;
}

function getDB() {
    return database;
}

// Добавить сотрудника (если нет)
async function addEmployee(tgUserId, name, warehouse = null) {
    const exists = await database.get('SELECT id FROM employees WHERE tg_user_id = ?', tgUserId);
    if (!exists) {
        await database.run(
            'INSERT INTO employees (tg_user_id, name, warehouse, capacity) VALUES (?, ?, ?, 1)',
            tgUserId, name, warehouse
        );
    }
}

// Получить сотрудника по tg_user_id
async function getEmployeeById(employeeId) {
    return database.get('SELECT * FROM employees WHERE id = ?', employeeId);
}

// Назначить заказ сотруднику (с проверкой лимита)
async function assignOrderToEmployee(orderId, employeeId) {
    await database.run(
        `INSERT OR REPLACE INTO assignments (order_id, employee_id, assigned_at, status)
         VALUES (?, ?, ?, ?)`,
        orderId, employeeId, Date.now(), 'assigned'
    );
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
        SELECT e.id, e.tg_user_id, e.name, e.warehouse, e.capacity,
               (SELECT COUNT(*) FROM assignments a WHERE a.employee_id = e.id AND a.status = 'assigned') as active_count
        FROM employees e
        WHERE 1=1
    `;
    const params = [];
    if (warehouseId) {
        sql += ` AND e.warehouse = ?`;
        params.push(warehouseId);
    }
    sql += ` ORDER BY e.name`;
    return database.all(sql, params);
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

// Установить склад сотрудника по tg_user_id
async function setEmployeeWarehouse(tgUserId, warehouseId) {
    await database.run('UPDATE employees SET warehouse = ? WHERE tg_user_id = ?', warehouseId, tgUserId);
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

module.exports = {
    initDB,
    getDB,
    addEmployee,
    getEmployeeById,
    assignOrderToEmployee,
    completeOrder,
    getAllEmployeesWithStats,
    getEmployeeActiveOrders,
    getEmployeeActiveOrdersCount,
    setEmployeeWarehouse,
    syncWarehouses,
    getAllWarehouses,
    getWarehouseNameById,
};

// Геттер для доступа к database через .db (для обратной совместимости с bot.js)
Object.defineProperty(module.exports, 'db', {
    get: () => database
});