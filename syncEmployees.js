const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('path');
const debugMode = require('./debugMode');

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

    // --- Динамическое определение колонок складов, начиная с G (индекс 6) ---
    const warehouseHeaderRow = rows[1];
    const warehouseColumns = [];

    // Идём от индекса 6 до конца строки заголовков
    for (let col = 6; col < warehouseHeaderRow.length; col++) {
        const cellValue = warehouseHeaderRow[col];
        if (cellValue && typeof cellValue === 'string') {
            const match = cellValue.match(/ID:\s*(\d+)/i);
            if (match) {
                warehouseColumns.push({
                    colIndex: col,
                    warehouseId: match[1]
                });
            }
        }
    }

    // Если колонки не найдены, используем пустой массив (никаких складов)
    if (!warehouseColumns.length) {
        console.warn('[SYNC] Не найдено ни одной колонки с ID склада в заголовках');
    }

    console.log(`[SYNC] Найдено ${warehouseColumns.length} колонок складов`);

    // --- Парсим сотрудников, начиная с третьей строки (индекс 2) ---
    const employeesData = [];
    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 5) continue; // как минимум A-E

        let name = row[0] ? String(row[0]).trim() : '';
        if (!name) continue;

        let tgUserId = row[1] ? String(row[1]).trim() : '';
        if (!tgUserId) continue;

        let phone = row[2] ? String(row[2]).trim() : '';
        let capacity = row[3] ? parseInt(row[3]) : 1;
        if (isNaN(capacity)) capacity = 1;

        // Столбец E: коэффициент заработка (по умолчанию 1.0)
        let earningsFactor = parseFloat(String(row[4]).replace(',', '.'));
        if (isNaN(earningsFactor) || earningsFactor <= 0) earningsFactor = 1.0;

        // Собираем склады сотрудника по динамическим колонкам
        const employeeWarehouses = [];
        for (const colInfo of warehouseColumns) {
            const col = colInfo.colIndex;
            const val = row[col];
            if (val === '+' || val === '➕' || val === '✔') {
                employeeWarehouses.push(colInfo.warehouseId);
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
                    `UPDATE employees SET name = ?, capacity = ?, earnings_factor = ?, phone = ?, is_fired = 0 WHERE id = ?`,
                    emp.name, emp.capacity, emp.earningsFactor, emp.phone, existing.id
                );
            } else {
                // Вставляем нового
                await dbConn.run(
                    `INSERT INTO employees (tg_user_id, name, capacity, earnings_factor, phone, is_fired) VALUES (?, ?, ?, ?, ?, 0)`,
                    emp.tgUserId, emp.name, emp.capacity, emp.earningsFactor, emp.phone
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

/**
 * Экспортирует текущий список сотрудников и складов в team-info.xlsx с форматированием.
 * @param {Object} db - объект базы данных (с полем .db для доступа к sqlite)
 */
async function exportTeamInfoXlsx(db) {
    const dbConn = db.db;

    // 1. Получаем всех сотрудников (включая уволенных, чтобы можно было выгрузить полный список)
    const employees = await dbConn.all(`
    SELECT id, tg_user_id, name, phone, capacity, earnings_factor, is_fired
    FROM employees
    ORDER BY id
`);

    // 2. Получаем все склады
    const warehouses = await dbConn.all('SELECT warehouse_id, name FROM warehouses ORDER BY name');
    const warehouseIds = warehouses.map(w => w.warehouse_id);

    // 3. Получаем связи сотрудник-склад
    const employeeWarehouses = await dbConn.all('SELECT employee_id, warehouse_id FROM employee_warehouses');
    const empWhMap = new Map();
    for (const ew of employeeWarehouses) {
        if (!empWhMap.has(ew.employee_id)) empWhMap.set(ew.employee_id, new Set());
        empWhMap.get(ew.employee_id).add(ew.warehouse_id);
    }

    // 4. Создаём книгу ExcelJS
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Сотрудники');

    // 5. Формируем заголовки
    // Первая строка: "Сотрудник", "Telegram ID", "Телефон", "Число принтеров", "Коэффициент Заработка", "" (пусто), "Склады" (слияние)
    const headerRow1 = ['Сотрудник', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
    // Вторая строка: заголовки складов (ID склада или имя)
    const headerRow2 = ['', '', '', '', '', '']; // пустые под первые 6 колонок

    // Добавляем названия складов во вторую строку
    for (const wh of warehouses) {
        headerRow1.push(''); // первая строка – пусто, слияние будет позже
        headerRow2.push(`${wh.name} (ID: ${wh.warehouse_id})`);
    }

    // Добавляем первую строку
    const row1 = worksheet.addRow(headerRow1);
    // Добавляем вторую строку
    const row2 = worksheet.addRow(headerRow2);

    // 6. Слияние для "Склады" в первой строке
    if (warehouseIds.length > 0) {
        // Первая строка, столбец G (индекс 6) и до конца
        const startCol = 7; // G
        const endCol = 6 + warehouseIds.length; // последний столбец складов
        worksheet.mergeCells(`G1:${String.fromCharCode(64 + endCol)}1`);
        // Записываем текст в объединённую ячейку
        row1.getCell(startCol).value = 'Склады';
    }

    // 7. Стили для строк заголовков (1 и 2)
    [row1, row2].forEach(row => {
        row.eachCell((cell) => {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.font = { bold: true };
        });
    });

    // 8. Ширина столбцов
    const colWidths = [
        40, // A
        15, // B
        15, // C
        20, // D
        25, // E
        10, // F
    ];
    // Для складов – 40
    for (let i = 0; i < 6; i++) {
        worksheet.getColumn(i + 1).width = colWidths[i];
    }
    for (let i = 0; i < warehouseIds.length; i++) {
        worksheet.getColumn(7 + i).width = 40;
    }

    // 9. Данные сотрудников (начиная с 3-й строки)
    for (const emp of employees) {
        const whSet = empWhMap.get(emp.id) || new Set();
        const earningsFactor = parseFloat(emp.earnings_factor) || 1.0;
        const rowData = [
            emp.name,
            String(emp.tg_user_id),
            emp.phone || '',
            emp.capacity,
            earningsFactor,
            '', // разделитель
        ];
        // Для каждого склада – ставим '+' если есть связь
        for (const whId of warehouseIds) {
            rowData.push(whSet.has(whId) ? '+' : '');
        }
        const dataRow = worksheet.addRow(rowData);
        // Выравнивание по центру для всех ячеек данных и установка форматов
        dataRow.eachCell((cell, colNumber) => {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            // Колонка B (индекс 2) – Telegram ID – текстовый формат
            if (colNumber === 2) {
                cell.numFmt = '@';
                cell.value = String(cell.value);
            }
            // Колонка C (индекс 3) – Телефон – текстовый формат
            else if (colNumber === 3) {
                cell.numFmt = '@';
                cell.value = String(cell.value);
            }
            // Колонка E (индекс 5) – Коэффициент заработка – числовой формат с двумя знаками
            else if (colNumber === 5) {
                cell.numFmt = '0.00';
                if (typeof cell.value !== 'number') {
                    cell.value = parseFloat(String(cell.value).replace(',', '.')) || 0;
                }
            }
        });
    }

    // 10. Сохраняем файл
    const outputPath = path.join(__dirname, 'team-info.xlsx');
    await workbook.xlsx.writeFile(outputPath);
    console.log('[EXPORT] team-info.xlsx успешно создан с форматированием.');
    return outputPath;
}

module.exports = { syncEmployeesFromExcel, exportTeamInfoXlsx };