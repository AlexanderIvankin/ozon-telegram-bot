const DEBUG_ORDERS_MODE = process.env.DEBUG_ORDERS_MODE === 'true';

// Хранилище для отладочного режима (в памяти)
const debugStore = {
    employeesBusy: new Map(),   // tg_user_id -> { isBusy, currentOrderId }
    takenOrderIds: new Set(),   // order_id
};

// --- Проверка, включён ли отладочный режим ---
function isDebugMode() {
    return DEBUG_ORDERS_MODE;
}

// --- Получение сообщения о статусе режима для вывода пользователю/админу ---
function getDebugModeStatusMessage() {
    return DEBUG_ORDERS_MODE ? '🔧 ОТЛАДОЧНЫЙ РЕЖИМ (назначения в памяти, статусы не меняются)' : '✅ РАБОЧИЙ РЕЖИМ (назначения в БД)';
}

// --- Функции для работы с занятостью сотрудников ---
function isEmployeeBusy(tgUserId) {
    if (!DEBUG_ORDERS_MODE) {
        throw new Error('isEmployeeBusyDebug можно использовать только в DEBUG_ORDERS_MODE');
    }
    return debugStore.employeesBusy.get(tgUserId)?.isBusy || false;
}

function setEmployeeBusy(tgUserId, busy, orderId = null) {
    if (!DEBUG_ORDERS_MODE) {
        throw new Error('setEmployeeBusyDebug можно использовать только в DEBUG_ORDERS_MODE');
    }
    debugStore.employeesBusy.set(tgUserId, { isBusy: busy, currentOrderId: orderId });
    if (busy && orderId) {
        debugStore.takenOrderIds.add(orderId);
    } else if (!busy && orderId) {
        debugStore.takenOrderIds.delete(orderId);
    }
}

function getCurrentOrder(tgUserId) {
    if (!DEBUG_ORDERS_MODE) {
        throw new Error('getCurrentOrderDebug можно использовать только в DEBUG_ORDERS_MODE');
    }
    return debugStore.employeesBusy.get(tgUserId)?.currentOrderId || null;
}

// --- Функции для работы со взятыми заказами ---
function isOrderTaken(orderId) {
    if (!DEBUG_ORDERS_MODE) {
        throw new Error('isOrderTakenDebug можно использовать только в DEBUG_ORDERS_MODE');
    }
    return debugStore.takenOrderIds.has(orderId);
}

function getAllTakenOrders() {
    if (!DEBUG_ORDERS_MODE) {
        throw new Error('getAllTakenOrdersDebug можно использовать только в DEBUG_ORDERS_MODE');
    }
    return Array.from(debugStore.takenOrderIds);
}

function clearAssignments() {
    if (!DEBUG_ORDERS_MODE) {
        throw new Error('clearAssignmentsDebug можно использовать только в DEBUG_ORDERS_MODE');
    }
    debugStore.employeesBusy.clear();
    debugStore.takenOrderIds.clear();
}

// --- Экспорт ---
module.exports = {
    isDebugMode,
    getDebugModeStatusMessage,
    isEmployeeBusy,
    setEmployeeBusy,
    getCurrentOrder,
    isOrderTaken,
    getAllTakenOrders,
    clearAssignments,
};