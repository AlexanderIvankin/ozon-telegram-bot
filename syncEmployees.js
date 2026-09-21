const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('path');
const {
    colToLetter,
    getVersionedFileName,
    formatPhonePretty,
    parseEmail,
    parseTgUserId,
    parseCapacity,
    parseEarningsFactor,
    escapeHtml,
} = require('./utils');
const debugMode = require('./debugMode');

async function syncEmployeesFromExcel(db, bot = null) {
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
    // Все поля проходят парсинг/валидацию:
    //   • tg_user_id — обязателен, только цифры;
    //   • email      — опционален, латиница/цифры/._%+- ;
    //   • phone      — '+7 (999) 123-45-67' / '79991234567' / '89991234567' /
    //                  '9991234567' (10 цифр) → единый красивый формат;
    //   • capacity   — целое >= 1;
    //   • factor     — положительное число, максимум 2 знака ('99,99' / '99.99').
    // Некорректные значения заменяются дефолтами (tg_user_id — строка
    // пропускается; email/phone — ''; capacity — 1; factor — 1.0), а проблемы
    // уходят одним сообщением модератору в конце синхронизации.
    const employeesData = [];
    const problemRows = []; // { name, problems: [{ field, raw, note }] }
    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 6) continue; // минимум A–F

        const name = row[0] ? String(row[0]).trim() : '';
        if (!name) continue;

        const emailRaw = row[1] ? String(row[1]).trim() : '';
        const tgRaw = row[2] ? String(row[2]).trim() : '';
        const phoneRaw = row[3] ? String(row[3]).trim() : '';
        const capacityRaw = row[4];
        const factorRaw = row[5];

        const email = parseEmail(emailRaw);          // null, если пусто/невалидно
        const tgUserId = parseTgUserId(tgRaw);       // только цифры
        const phonePretty = phoneRaw ? formatPhonePretty(phoneRaw) : '';
        const capacity = parseCapacity(capacityRaw);
        const earningsFactor = parseEarningsFactor(factorRaw);
        const hasCapacityValue = String(capacityRaw ?? '').trim() !== '';
        const hasFactorValue = String(factorRaw ?? '').trim() !== '';

        // Основной идентификатор в боте — tg_user_id. Без него строку пропускаем.
        if (!tgUserId) {
            problemRows.push({
                name,
                problems: [{
                    field: 'tg_user_id',
                    raw: tgRaw,
                    note: 'обязательный Telegram ID не распознан (ожидается последовательность цифр) — строка пропущена',
                }],
            });
            continue;
        }

        const rowProblems = [];
        if (emailRaw && !email) {
            rowProblems.push({
                field: 'email',
                raw: emailRaw,
                note: 'не распознан (кириллица/пробелы/неверный формат) — email очищен',
            });
        }
        if (phoneRaw && !phonePretty) {
            rowProblems.push({
                field: 'phone',
                raw: phoneRaw,
                note: 'не распознан (нужно 11 цифр: +7/7/8… или 10 цифр без кода страны) — телефон очищен',
            });
        }
        if (hasCapacityValue && capacity === null) {
            rowProblems.push({
                field: 'capacity',
                raw: String(capacityRaw).trim(),
                note: 'ожидается целое число >= 1 — заменено на 1',
            });
        }
        if (hasFactorValue && earningsFactor === null) {
            rowProblems.push({
                field: 'earnings_factor',
                raw: String(factorRaw).trim(),
                note: 'ожидается положительное число с максимум 2 знаками после запятой (99,99 или 99.99) — заменено на 1.0',
            });
        }

        // Собираем склады
        const employeeWarehouses = [];
        for (const colInfo of warehouseColumns) {
            const val = row[colInfo.colIndex];
            if (val === '+' || val === '➕' || val === '✔') {
                employeeWarehouses.push(colInfo.warehouseId);
            }
        }

        employeesData.push({
            tgUserId,
            name,
            email: email || '',           // опционально
            phone: phonePretty || '',      // канонический или ''
            capacity: capacity ?? 1,
            earningsFactor: earningsFactor ?? 1.0,
            warehouses: employeeWarehouses,
        });

        if (rowProblems.length) problemRows.push({ name, problems: rowProblems });
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

        // --- Оповещение модератора о проблемных данных в Excel ---
        if (problemRows.length && bot) {
            const moderatorId = process.env.MODERATOR_ID;
            if (moderatorId) {
                const flat = problemRows.flatMap((p) =>
                    p.problems.map((pr) => ({ name: p.name, field: pr.field, raw: pr.raw, note: pr.note }))
                );
                console.warn(`[SYNC] В Excel найдено проблемных значений: ${flat.length}`);
                for (const pr of flat) {
                    console.warn(`[SYNC]   • ${pr.name || '(без имени)'}: ${pr.field} «${pr.raw}» — ${pr.note}`);
                }

                // Группируем по сотруднику для читаемости в Telegram
                let msg = `⚠️ <b>Синхронизация team-info.xlsx: проблемы в данных</b>\n\n`;
                msg += `Всего проблем: <b>${flat.length}</b>\n\n`;

                const byName = new Map();
                for (const pr of flat) {
                    if (!byName.has(pr.name)) byName.set(pr.name, []);
                    byName.get(pr.name).push(pr);
                }
                let shown = 0;
                for (const [name, list] of byName) {
                    if (shown >= 20) {
                        msg += `\n…и ещё ${byName.size - shown} сотрудник(ов) — см. логи.`;
                        break;
                    }
                    msg += `<b>${escapeHtml(name || '(без имени)')}</b>\n`;
                    for (const pr of list) {
                        msg += `  • <code>${escapeHtml(pr.field)}</code>: «${escapeHtml(pr.raw || '—')}» — ${escapeHtml(pr.note)}\n`;
                    }
                    msg += `\n`;
                    shown++;
                }

                try {
                    await bot.sendMessage(moderatorId, msg, { parse_mode: 'HTML' });
                } catch (err) {
                    console.error('[SYNC] Не удалось отправить сообщение модератору:', err.message);
                }
            }
        }
    } catch (err) {
        await dbConn.run('ROLLBACK');
        console.error('[SYNC] Ошибка синхронизации:', err);
        throw err;
    }
}

/**
 * Синхронизирует tg_username у сотрудников через Telegram Bot API.
 * @param {Object} db
 * @param {Object} bot
 * @param {Object} [options]
 * @param {boolean} [options.includeFired=true] - включать уволенных
 * @param {boolean} [options.onlyMissing=false] - только те, у кого tg_username пуст
 * @param {number}  [options.delayMs=100]      - пауза между запросами
 * @returns {Promise<{total, updated, unchanged, failed, failedIds}>}
 */
async function syncTgUsernames(db, bot, options = {}) {
    const {
        includeFired = true,
        onlyMissing = false,
        delayMs = 100,
    } = options;

    const employees = await db.getEmployeesForTgUsernameSync({ includeFired, onlyMissing });
    console.log(`[SYNC_USERNAMES] Найдено сотрудников для проверки: ${employees.length}`);

    let updated = 0, unchanged = 0, failed = 0;
    const failedIds = [];

    for (const emp of employees) {
        try {
            const chat = await bot.getChat(emp.tg_user_id);
            const username = chat && chat.username ? chat.username : null;

            if (username && username !== emp.tg_username) {
                await db.updateEmployeeTgUsername(emp.tg_user_id, username);
                updated++;
                console.log(`[SYNC_USERNAMES] Обновлён: ${emp.name} → @${username}`);
            } else {
                unchanged++;
            }
        } catch (err) {
            // Бот никогда не взаимодействовал с пользователем — это норма
            failed++;
            failedIds.push({ tg_user_id: emp.tg_user_id, name: emp.name, reason: err.message });
        }

        await new Promise(r => setTimeout(r, delayMs));
    }

    console.log(`[SYNC_USERNAMES] Готово: обновлено ${updated}, без изменений ${unchanged}, ошибок ${failed}`);
    return { total: employees.length, updated, unchanged, failed, failedIds };
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
            formatPhonePretty(emp.phone) || emp.phone || '',
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

module.exports = { syncEmployeesFromExcel, syncTgUsernames, exportTeamInfoXlsx, exportTeamInfoXlsxAll };