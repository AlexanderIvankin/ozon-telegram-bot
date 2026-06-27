const XLSX = require('xlsx');
const path = require('path');
const debugMode = require('./debugMode');

/**
 * Синхронизирует список сотрудников из Excel-файла с БД.
 * @param {Object} db - объект базы данных (с методами)
 */
async function syncEmployeesFromExcel(db) {
    const filePath = path.join(__dirname, 'team-info.xlsx');
    console.log('[SYNC] Загрузка сотрудников из', filePath);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows || rows.length < 3) {
        console.error('[SYNC] Файл слишком короткий или пустой');
        return;
    }

    // --- Парсим заголовки складов (вторая строка, столбцы G-Q) ---
    // Столбцы: G=6, H=7, I=8, J=9, K=10, L=11, M=12, N=13, O=14, P=15, Q=16
    const warehouseHeaderRow = rows[1];
    const warehouseIds = [];
    for (let col = 6; col <= 16; col++) {
        const cellValue = warehouseHeaderRow[col];
        if (cellValue && typeof cellValue === 'string') {
            const match = cellValue.match(/ID:\s*(\d+)/i);
            if (match) {
                warehouseIds.push(match[1]);
            } else {
                warehouseIds.push(null);
            }
        } else {
            warehouseIds.push(null);
        }
    }

    // --- Парсим сотрудников, начиная с третьей строки (индекс 2) ---
    const employeesData = [];
    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 5) continue; // как минимум A-E

        let name = row[0] ? String(row[0]).trim() : '';
        if (!name) continue;

        let tgUserId = row[1] ? String(row[1]).trim() : '';
        if (!tgUserId) continue;

        let phone = row[2] ? String(row[2]).trim() : ''; // не используется, но читаем
        let capacity = row[3] ? parseInt(row[3]) : 1;
        if (isNaN(capacity)) capacity = 1;

        // Столбец E: коэффициент заработка (по умолчанию 1.0)
        let earningsFactor = parseFloat(row[4]);
        if (isNaN(earningsFactor) || earningsFactor <= 0) earningsFactor = 1.0;

        // Столбцы G-Q (индексы 6-16): склады (символ "+")
        const employeeWarehouses = [];
        for (let col = 6; col <= 16; col++) {
            const val = row[col];
            if (val === '+' || val === '➕' || val === '✔') {
                const warehouseId = warehouseIds[col - 6];
                if (warehouseId) {
                    employeeWarehouses.push(warehouseId);
                }
            }
        }

        employeesData.push({
            tgUserId,
            name,
            phone,
            capacity,
            earningsFactor,
            warehouses: employeeWarehouses
        });
    }

    console.log(`[SYNC] Найдено сотрудников: ${employeesData.length}`);

    const dbConn = db.db;
    await dbConn.run('BEGIN TRANSACTION');

    try {
        const currentEmployees = await dbConn.all('SELECT id, tg_user_id FROM employees');
        const currentMap = new Map(currentEmployees.map(emp => [emp.tg_user_id, emp.id]));

        for (const emp of employeesData) {
            // Проверяем, есть ли запись с таким tg_user_id (включая уволенных)
            const existing = await dbConn.get('SELECT id FROM employees WHERE tg_user_id = ?', emp.tgUserId);
            if (existing) {
                // Обновляем существующую запись (восстанавливаем)
                await dbConn.run(
                    `UPDATE employees SET name = ?, capacity = ?, earnings_factor = ?, is_fired = 0 WHERE id = ?`,
                    emp.name, emp.capacity, emp.earningsFactor, existing.id
                );
            } else {
                // Вставляем нового
                await dbConn.run(
                    `INSERT INTO employees (tg_user_id, name, capacity, earnings_factor, is_fired) VALUES (?, ?, ?, ?, 0)`,
                    emp.tgUserId, emp.name, emp.capacity, emp.earningsFactor
                );
            }
        }

        // Удаляем сотрудников, которых нет в файле (теперь помечаем уволенными)
        const newTgIds = new Set(employeesData.map(e => e.tgUserId));
        for (const [tgId, empId] of currentMap.entries()) {
            if (!newTgIds.has(tgId)) {
                // Помечаем как уволенного вместо удаления
                await dbConn.run('UPDATE employees SET is_fired = 1 WHERE id = ?', empId);
                // Также нужно снять все активные назначения (если они есть)
                await dbConn.run('DELETE FROM assignments WHERE employee_id = ? AND status = "assigned"', empId);
            }
        }

        // Обновляем employee_warehouses
        await dbConn.run('DELETE FROM employee_warehouses');
        for (const emp of employeesData) {
            const employeeRecord = await dbConn.get('SELECT id FROM employees WHERE tg_user_id = ?', emp.tgUserId);
            if (employeeRecord) {
                for (const whId of emp.warehouses) {
                    await dbConn.run(
                        `INSERT INTO employee_warehouses (employee_id, warehouse_id) VALUES (?, ?)`,
                        employeeRecord.id, whId
                    );
                }
            }
        }

        await dbConn.run('COMMIT');
        console.log('[SYNC] Синхронизация сотрудников завершена');
    } catch (err) {
        await dbConn.run('ROLLBACK');
        console.error('[SYNC] Ошибка синхронизации:', err);
        throw err;
    }
}

module.exports = { syncEmployeesFromExcel };