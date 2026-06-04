const ozon = require('ozon-seller-api-extended');
require('dotenv').config();

ozon.useApi(process.env.OZON_API_KEY);
ozon.useClientId(process.env.OZON_CLIENT_ID);

// Получить список заказов FBS со статусом "awaiting_packaging" (ожидает упаковки)
// Документация: метод /v3/posting/fbs/list
async function fetchAwaitingOrders() {
    try {
        // Указываем фильтр по статусу. Уточните нужные статусы в документации Ozon.
        const filter = {
            status: 'awaiting_packaging',
            limit: 20
        };
        const response = await ozon.getSupplyOrderList(filter);
        // response.result.postings — массив заказов. Каждый содержит posting_number (ID заказа)
        return response.result.postings || [];
    } catch (error) {
        console.error('Ошибка получения заказов из Ozon:', error);
        return [];
    }
}

// Получить детали одного заказа (если нужно показать состав)
async function getOrderDetails(orderId) {
    try {
        const details = await ozon.getSupplyOrderInfo(orderId);
        return details;
    } catch (error) {
        console.error(`Ошибка получения деталей заказа ${orderId}:`, error);
        return null;
    }
}

module.exports = { fetchAwaitingOrders, getOrderDetails };