const ozon = require('ozon-seller-api-extended');
require('dotenv').config();

ozon.useApi(process.env.OZON_API_KEY);
ozon.useClientId(process.env.OZON_CLIENT_ID);

// Флаг для тестов: если true, возвращаем тестовые данные, не обращаясь к реальному API
const MOCK_MODE = true;

// Тестовые заказы
const mockOrders = [
    { posting_number: "12345", products: [{ name: "Товар А", quantity: 2 }] },
    { posting_number: "67890", products: [{ name: "Товар Б", quantity: 1 }] }
];

// Получить список заказов FBS со статусом "awaiting_packaging" (ожидает упаковки)
// Документация: метод /v3/posting/fbs/list
async function fetchAwaitingOrders() {
    console.log('[Ozon] Запрос списка заказов...');
    if (MOCK_MODE) {
        console.log('[Ozon] Используется MOCK_MODE, возвращаем тестовые заказы');
        return mockOrders;
    }
    try {
        // Уточните реальный метод и параметры у библиотеки ozon-seller-api-extended
        const response = await ozon.getSupplyOrderList({
            status: 'awaiting_packaging',
            limit: 20
        });
        console.log(`[Ozon] Получено заказов: ${response.result?.postings?.length || 0}`);
        return response.result.postings || [];
    } catch (error) {
        console.error('[Ozon] Ошибка при получении заказов:', error.response?.data || error.message);
        return [];
    }
}

// Получить детали одного заказа (если нужно показать состав)
async function getOrderDetails(orderId) {
    if (MOCK_MODE) {
        const mock = mockOrders.find(o => o.posting_number === orderId);
        return mock || { posting_number: orderId, products: [] };
    }
    try {
        const details = await ozon.getSupplyOrderInfo(orderId);
        return details;
    } catch (error) {
        console.error(`Ошибка получения деталей заказа ${orderId}:`, error);
        return null;
    }
}

module.exports = { fetchAwaitingOrders, getOrderDetails };