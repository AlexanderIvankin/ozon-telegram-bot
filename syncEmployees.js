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
    
    // Читаем файл
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows || rows.length < 3) {
        console.error('[SYNC] Файл слишком короткий или пустой');
        return;
    }

    // --- Парсим заголовки складов (вторая строка, столбцы F-P) ---
    // Столбцы: F=5, G=6, H=7, I=8, J=9, K=10, L=11, M=12, N=13, O=14, P=15
    const warehouseHeaderRow = rows[1]; // вторая строка (индекс 1)
    const warehouseIds = [];
    for (let col = 5; col <= 15; col++) {
        const cellValue = warehouseHeaderRow[col];
        if (cellValue && typeof cellValue === 'string') {
            // формат: "Склад 1 (ID: 12345)" или "Склад 1 (ID: xxxxx)"
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
        if (!row || row.length < 2) continue;
        
        // Столбец A: имя сотрудника (формат "Имя (@tg_username)")
        let name = row[0] ? String(row[0]).trim() : '';
        if (!name) continue;
        // Можно извлечь чистое имя, убрав часть с @, но оставим как есть
        // Например: "Иван Петров (@ivan_p)" -> оставляем "Иван Петров (@ivan_p)"
        
        // Столбец B: Telegram ID (число)
        let tgUserId = row[1] ? String(row[1]).trim() : '';
        if (!tgUserId) continue;
        
        // Столбец C: телефон (не обязательно)
        let phone = row[2] ? String(row[2]).trim() : '';
        
        // Столбец D: число принтеров (capacity)
        let capacity = row[3] ? parseInt(row[3]) : 1;
        if (isNaN(capacity)) capacity = 1;
        
        // Столбцы F-P: склады (символ "+")
        const employeeWarehouses = [];
        for (let col = 5; col <= 15; col++) {
            const val = row[col];
            if (val === '+' || val === '➕' || val === '✔') {
                const warehouseId = warehouseIds[col - 5];
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
            warehouses: employeeWarehouses
        });
    }
    
    console.log(`[SYNC] Найдено сотрудников: ${employeesData.length}`);
    
    // --- Синхронизация с БД ---
    const dbConn = db.db; // доступ к соединению
    
    // Начинаем транзакцию
    await dbConn.run('BEGIN TRANSACTION');
    
    try {
        // 1. Получаем текущих сотрудников из БД
        const currentEmployees = await dbConn.all('SELECT id, tg_user_id FROM employees');
        const currentMap = new Map(currentEmployees.map(emp => [emp.tg_user_id, emp.id]));
        
        // 2. Обновляем или вставляем сотрудников
        for (const emp of employeesData) {
            if (currentMap.has(emp.tgUserId)) {
                // Обновляем
                await dbConn.run(
                    `UPDATE employees SET name = ?, capacity = ? WHERE tg_user_id = ?`,
                    emp.name, emp.capacity, emp.tgUserId
                );
            } else {
                // Вставляем
                await dbConn.run(
                    `INSERT INTO employees (tg_user_id, name, capacity) VALUES (?, ?, ?)`,
                    emp.tgUserId, emp.name, emp.capacity
                );
            }
        }
        
        // 3. Удаляем сотрудников, которых нет в файле (по желанию)
        const newTgIds = new Set(employeesData.map(e => e.tgUserId));
        for (const [tgId, empId] of currentMap.entries()) {
            if (!newTgIds.has(tgId)) {
                // Удаляем назначения и самого сотрудника
                await dbConn.run('DELETE FROM assignments WHERE employee_id = ?', empId);
                await dbConn.run('DELETE FROM employee_warehouses WHERE employee_id = ?', empId);
                await dbConn.run('DELETE FROM employees WHERE id = ?', empId);
            }
        }
        
        // 4. Обновляем таблицу employee_warehouses
        // Сначала очистим все связи, потом вставим заново
        await dbConn.run('DELETE FROM employee_warehouses');
        for (const emp of employeesData) {
            // Получаем id сотрудника (только что вставленного или обновлённого)
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