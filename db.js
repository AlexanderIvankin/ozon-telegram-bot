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
            is_busy INTEGER DEFAULT 0
        )
    `);

    // Таблица назначенных заказов
    await database.exec(`
        CREATE TABLE IF NOT EXISTS assignments (
            order_id TEXT PRIMARY KEY,
            employee_id INTEGER NOT NULL,
            assigned_at INTEGER NOT NULL,
            status TEXT DEFAULT 'taken',
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
            'INSERT INTO employees (tg_user_id, name, warehouse, is_busy) VALUES (?, ?, ?, 0)',
            tgUserId, name, warehouse
        );
    }
}

// Получить сотрудника по tg_user_id
async function getEmployee(tgUserId) {
    return database.get('SELECT * FROM employees WHERE tg_user_id = ?', tgUserId);
}

// Сменить статус занятости
async function setEmployeeBusy(tgUserId, isBusy) {
    await database.run('UPDATE employees SET is_busy = ? WHERE tg_user_id = ?', isBusy ? 1 : 0, tgUserId);
}

// Назначить заказ сотруднику
async function assignOrder(orderId, employeeId) {
    await database.run(
        'INSERT OR REPLACE INTO assignments (order_id, employee_id, assigned_at, status) VALUES (?, ?, ?, ?)',
        orderId, employeeId, Date.now(), 'taken'
    );
}

// Освободить заказ (по сотруднику или по order_id)
async function releaseOrder(orderId) {
    await database.run('DELETE FROM assignments WHERE order_id = ?', orderId);
}
// Получить все активные order_id
async function getActiveOrderIds() {
    const rows = await database.all('SELECT order_id FROM assignments WHERE status = "taken"');
    return rows.map(row => row.order_id);
}

// Проверить, взят ли уже заказ
async function isOrderTaken(orderId) {
    const row = await database.get('SELECT 1 FROM assignments WHERE order_id = ? AND status = "taken"', orderId);
    return !!row;
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
    const now = Date.now();
    for (const wh of warehouses) {
        await database.run(
            `INSERT OR REPLACE INTO warehouses (warehouse_id, name, address, is_rfbs, last_synced_at)
     VALUES (?, ?, ?, ?, ?)`,
            wh.warehouse_id,
            wh.name,
            wh.address ? wh.address : null,
            wh.is_rfbs ? 1 : 0,
            now
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
    getEmployee,
    setEmployeeBusy,
    assignOrder,
    releaseOrder,
    getActiveOrderIds,
    isOrderTaken,
    setEmployeeWarehouse,
    syncWarehouses,
    getAllWarehouses,
    getWarehouseNameById,
};

// Геттер для доступа к database через .db (для обратной совместимости с bot.js)
Object.defineProperty(module.exports, 'db', {
    get: () => database
});