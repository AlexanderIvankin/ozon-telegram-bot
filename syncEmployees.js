const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('path');
const { colToLetter, getVersionedFileName } = require('./utils');
const debugMode = require('./debugMode');

async function syncEmployeesFromExcel(db) {
    const fileName = getVersionedFileName('team-info', '.xlsx');
    const filePath = path.join(__dirname, fileName);
    console.log('[SYNC] Загрузка сотрудников из', filePath);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows || rows.length < 3) {
        console.error('[SYNC] Файл слишком короткий или пустой');
        return;
    }

    // --- Динамическое определение колонок складов, начиная с H (индекс 7) ---
    const warehouseHeaderRow = rows[1];
    const warehouseColumns = [];

    // Идём от индекса 7 (колонка H) до конца строки заголовков
    for (let col = 7; col < warehouseHeaderRow.length; col++) {
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

    if (!warehouseColumns.length) {
        console.warn('[SYNC] Не найдено ни одной колонки с ID склада в заголовках');
    }

    console.log(`[SYNC] Найдено ${warehouseColumns.length} колонок складов`);

    // --- Парсим сотрудников, начиная с третьей строки (индекс 2) ---
    const employeesData = [];
    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 6) continue; // как минимум A-F (name, email, tg, phone, capacity, factor)

        let name = row[0] ? String(row[0]).trim() : '';
        if (!name) continue;

        let email = row[1] ? String(row[1]).trim() : ''; // новый столбец

        let tgUserId = row[2] ? String(row[2]).trim() : '';
        if (!tgUserId) continue;

        let phone = row[3] ? String(row[3]).trim() : '';
        let capacity = row[4] ? parseInt(row[4]) : 1;
        if (isNaN(capacity)) capacity = 1;

        let earningsFactor = parseFloat(String(row[5]).replace(',', '.'));
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
            email,
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
            const existing = await dbConn.get('SELECT id FROM employees WHERE tg_user_id = ?', emp.tgUserId);
            if (existing) {
                // Обновляем существующую запись (восстанавливаем)
                await dbConn.run(
                    `UPDATE employees SET name = ?, email = ?, capacity = ?, earnings_factor = ?, phone = ?, is_fired = 0 WHERE id = ?`,
                    emp.name, emp.email, emp.capacity, emp.earningsFactor, emp.phone, existing.id
                );
            } else {
                // Вставляем нового
                await dbConn.run(
                    `INSERT INTO employees (tg_user_id, name, email, capacity, earnings_factor, phone, is_fired)
                     VALUES (?, ?, ?, ?, ?, ?, 0)`,
                    emp.tgUserId, emp.name, emp.email, emp.capacity, emp.earningsFactor, emp.phone
                );
            }
        }

        // Помечаем уволенными тех, кого нет в файле
        const newTgIds = new Set(employeesData.map(e => e.tgUserId));
        for (const [tgId, empId] of currentMap.entries()) {
            if (!newTgIds.has(tgId)) {
                await dbConn.run('UPDATE employees SET is_fired = 1 WHERE id = ?', empId);
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
 * Экспортирует список сотрудников в team-info.xlsx (активные) или employees-db.xlsx (все).
 * @param {Object} db - объект базы данных (с полем .db)
 * @param {boolean} includeFired - включать ли уволенных
 * @param {string} outputFileName - имя файла (по умолчанию team-info.xlsx)
 * @returns {Promise<string>} - путь к созданному файлу
 */
async function exportTeamInfoXlsx(db, ozon, includeFired = false, outputFileName = null) {
    if (!outputFileName) {
        outputFileName = getVersionedFileName('team-info', '.xlsx');
    }

    const dbConn = db.db;

    // 1. Получаем список сотрудников (только активных или включая уволенных)
    const firedCondition = includeFired ? '' : 'WHERE is_fired = 0';
    const employees = await dbConn.all(`
        SELECT id, tg_user_id, name, email, phone, capacity, earnings_factor, is_fired
        FROM employees
        ${firedCondition}
        ORDER BY id
    `);

    // 2. Получаем все склады

    // Синхронизируем склады перед экспортом, чтобы данные были свежими
    try {
        const warehousesFromOzon = await ozon.fetchWarehousesFromOzon();
        if (warehousesFromOzon.length) {
            await db.syncWarehouses(warehousesFromOzon);
            console.log('[EXPORT] Склады синхронизированы перед экспортом team-info');
        }
    } catch (err) {
        console.warn('[EXPORT] Не удалось синхронизировать склады перед экспортом:', err.message);
        // Продолжаем с теми, что есть в БД
    }

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

    // 5. Заголовки (новая структура: Сотрудник, E-mail, Telegram ID, Телефон, Число принтеров, Коэффициент Заработка, Разделитель, Склады)
    const headerRow1 = ['Сотрудник', 'E-mail', 'Telegram ID', 'Телефон', 'Число принтеров', 'Коэффициент Заработка', ''];
    const headerRow2 = ['', '', '', '', '', '', '']; // пустые под первые 7 колонок

    // Добавляем названия складов во вторую строку
    for (const wh of warehouses) {
        headerRow1.push('');
        headerRow2.push(`${wh.name} (ID: ${wh.warehouse_id})`);
    }

    // Добавляем строки
    const row1 = worksheet.addRow(headerRow1);
    const row2 = worksheet.addRow(headerRow2);

    // 6. Слияние для "Склады" в первой строке (начинается с 8-й колонки, индекс 7)
    if (warehouseIds.length > 0) {
        const startCol = 8; // H
        const endCol = 7 + warehouseIds.length; // последний столбец складов
        const startLetter = colToLetter(startCol);
        const endLetter = colToLetter(endCol);
        worksheet.mergeCells(`${startLetter}1:${endLetter}1`);
        row1.getCell(startCol).value = 'Склады';
    }

    // 7. Стили для строк заголовков
    [row1, row2].forEach(row => {
        row.eachCell((cell) => {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.font = { bold: true };
        });
    });

    // 8. Ширина столбцов
    const colWidths = [
        45, // A - Сотрудник
        45, // B - E-mail
        30, // C - Telegram ID
        30, // D - Телефон
        30, // E - Число принтеров
        30, // F - Коэффициент Заработка
        15, // G - разделитель
    ];
    for (let i = 0; i < colWidths.length; i++) {
        worksheet.getColumn(i + 1).width = colWidths[i];
    }
    for (let i = 0; i < warehouseIds.length; i++) {
        worksheet.getColumn(8 + i).width = 75; // склады
    }

    // 9. Данные сотрудников (начиная с 3-й строки)
    for (const emp of employees) {
        const whSet = empWhMap.get(emp.id) || new Set();
        const earningsFactor = parseFloat(emp.earnings_factor) || 1.0;
        const rowData = [
            emp.name,
            emp.email || '',
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
        dataRow.eachCell((cell, colNumber) => {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            // Колонка C (индекс 3) – Telegram ID – текстовый формат
            if (colNumber === 3) {
                cell.numFmt = '@';
                cell.value = String(cell.value);
            }
            // Колонка D (индекс 4) – Телефон – текстовый формат
            else if (colNumber === 4) {
                cell.numFmt = '@';
                cell.value = String(cell.value);
            }
            // Колонка F (индекс 6) – Коэффициент заработка – числовой формат с двумя знаками
            else if (colNumber === 6) {
                cell.numFmt = '0.00';
                if (typeof cell.value !== 'number') {
                    cell.value = parseFloat(String(cell.value).replace(',', '.')) || 0;
                }
            }
        });
    }

    // 10. Сохраняем файл
    const outputPath = path.join(__dirname, outputFileName);
    await workbook.xlsx.writeFile(outputPath);
    console.log(`[EXPORT] ${outputFileName} успешно создан с форматированием.`);
    return outputPath;
}

async function exportTeamInfoXlsxAll(db, ozon) {
    const fileName = getVersionedFileName('employees-db', '.xlsx');
    return exportTeamInfoXlsx(db, ozon, true, fileName);
}

module.exports = { syncEmployeesFromExcel, exportTeamInfoXlsx, exportTeamInfoXlsxAll };