const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let db;

async function initDB() {
    db = await open({
        filename: path.join(__dirname, 'bot.db'),
        driver: sqlite3.Database,
        trace: process.env.NODE_ENV === 'development' ? console.log : undefined
    });

    // Таблица сотрудников
    await db.exec(`
        CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_user_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            warehouse TEXT,
            is_busy INTEGER DEFAULT 0
        )
    `);

    // Таблица назначенных заказов
    await db.exec(`
        CREATE TABLE IF NOT EXISTS assignments (
            order_id TEXT PRIMARY KEY,
            employee_id INTEGER NOT NULL,
            assigned_at INTEGER NOT NULL,
            status TEXT DEFAULT 'taken',
            FOREIGN KEY (employee_id) REFERENCES employees(id)
        )
    `);

    return db;
}

// Добавить сотрудника (если нет)
async function addEmployee(tgUserId, name, warehouse = null) {
    const exists = await db.get('SELECT id FROM employees WHERE tg_user_id = ?', tgUserId);
    if (!exists) {
        await db.run(
            'INSERT INTO employees (tg_user_id, name, warehouse, is_busy) VALUES (?, ?, ?, 0)',
            tgUserId, name, warehouse
        );
    }
}

// Получить сотрудника по tg_user_id
async function getEmployee(tgUserId) {
    return db.get('SELECT * FROM employees WHERE tg_user_id = ?', tgUserId);
}

// Сменить статус занятости
async function setEmployeeBusy(tgUserId, isBusy) {
    await db.run('UPDATE employees SET is_busy = ? WHERE tg_user_id = ?', isBusy ? 1 : 0, tgUserId);
}

// Назначить заказ сотруднику
async function assignOrder(orderId, employeeId) {
    await db.run(
        'INSERT OR REPLACE INTO assignments (order_id, employee_id, assigned_at, status) VALUES (?, ?, ?, ?)',
        orderId, employeeId, Date.now(), 'taken'
    );
}

// Освободить заказ (по сотруднику или по order_id)
async function releaseOrder(orderId) {
    await db.run('DELETE FROM assignments WHERE order_id = ?', orderId);
}

// Получить все активные order_id
async function getActiveOrderIds() {
    const rows = await db.all('SELECT order_id FROM assignments WHERE status = "taken"');
    return rows.map(row => row.order_id);
}

// Проверить, взят ли уже заказ
async function isOrderTaken(orderId) {
    const row = await db.get('SELECT 1 FROM assignments WHERE order_id = ? AND status = "taken"', orderId);
    return !!row;
}

module.exports = {
    initDB,
    addEmployee,
    getEmployee,
    setEmployeeBusy,
    assignOrder,
    releaseOrder,
    getActiveOrderIds,
    isOrderTaken
};