const { exportMonthlyEarnings, cleanCooldowns } = require('./commands');
const debugMode = require('./debugMode');

let checkInterval = null;
let isPaused = false;

function startOrderChecker(intervalMinutes, callback) {
    if (checkInterval) clearInterval(checkInterval);
    checkInterval = setInterval(async () => {
        if (isPaused) return;
        console.log(`[SCHEDULER] Проверка заказов в ${new Date().toISOString()}`);
        try {
            await callback();
        } catch (err) {
            console.error('Ошибка в планировщике:', err);
        }
    }, intervalMinutes * 60 * 1000);
}

function stopOrderChecker() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
}

function pauseChecker() { isPaused = true; }
function resumeChecker() { isPaused = false; }
function isCheckerPaused() { return isPaused; }

let cooldownCleanInterval = null;

function startCooldownCleaner() {
    if (cooldownCleanInterval) clearInterval(cooldownCleanInterval);
    cooldownCleanInterval = setInterval(() => {
        try {
            cleanCooldowns();
        } catch (err) {
            console.error('[SCHEDULER] Ошибка при очистке кулдаунов:', err);
        }
    }, 60 * 60 * 1000); // раз в час
}

function stopCooldownCleaner() {
    if (cooldownCleanInterval) {
        clearInterval(cooldownCleanInterval);
        cooldownCleanInterval = null;
    }
}

let monthlyExportInterval = null;

function startMonthlyExportChecker(db, bot = null) {
    if (monthlyExportInterval) clearInterval(monthlyExportInterval);
    monthlyExportInterval = setInterval(async () => {
        try {
            const now = new Date();
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            if (now.getDate() === lastDay && now.getHours() >= 23 && now.getMinutes() < 60) {
                const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1);
                const monthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
                console.log(`[SCHEDULER] Запуск автоматического экспорта за ${monthStr}`);
                await exportMonthlyEarnings(db, monthStr);
                if (bot) {
                    const moderatorId = process.env.MODERATOR_ID;
                    if (moderatorId) {
                        await bot.sendMessage(moderatorId, `📊 Автоматический экспорт за ${monthStr} выполнен.`);
                    }
                }
            }
        } catch (err) {
            console.error('[SCHEDULER] Ошибка автоматического экспорта:', err);
        }
    }, 60 * 60 * 1000);
}

function stopMonthlyExportChecker() {
    if (monthlyExportInterval) {
        clearInterval(monthlyExportInterval);
        monthlyExportInterval = null;
    }
}

module.exports = {
    startOrderChecker,
    stopOrderChecker,
    pauseChecker,
    resumeChecker,
    isCheckerPaused,
    startCooldownCleaner,
    stopCooldownCleaner,
    startMonthlyExportChecker,
    stopMonthlyExportChecker,
};