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

    // Проверяем и добавляем колонку capacity, если отсутствует
    const tableInfo = await database.all("PRAGMA table_info(employees)");
    const hasCapacity = tableInfo.some(col => col.name === 'capacity');
    if (!hasCapacity) {
        await database.run('ALTER TABLE employees ADD COLUMN capacity INTEGER DEFAULT 1');
        console.log('[DB] Добавлена колонка capacity в employees');
    }

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

// Получить сотрудника по tg_user_id (строковый ID)
async function getEmployee(tgUserId) {
    return database.get('SELECT * FROM employees WHERE tg_user_id = ?', tgUserId);
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

// Обновить статистику сотрудника при завершении заказа
async function updateEmployeeStats(employeeId, orderAmount = 0) {
    await database.run(
        `INSERT INTO employee_stats (employee_id, total_orders, total_amount)
         VALUES (?, 1, ?)
         ON CONFLICT(employee_id) DO UPDATE SET
         total_orders = total_orders + 1,
         total_amount = total_amount + ?`,
        employeeId, orderAmount, orderAmount
    );
}

// Получить статистику сотрудника
async function getEmployeeStats(employeeId) {
    const stats = await database.get(
        `SELECT total_orders, total_amount FROM employee_stats WHERE employee_id = ?`,
        employeeId
    );
    return stats || { total_orders: 0, total_amount: 0 };
}


module.exports = {
    initDB,
    getDB,
    addEmployee,
    getEmployee,
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
    updateEmployeeStats,
    getEmployeeStats
};

// Геттер для доступа к database через .db (для обратной совместимости с bot.js)
Object.defineProperty(module.exports, 'db', {
    get: () => database
});