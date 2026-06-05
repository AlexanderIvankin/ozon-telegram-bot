const axios = require('axios');
require('dotenv').config();

// --- Конфигурация ---
const API_URL = 'https://api-seller.ozon.ru';  // правильный URL для продавцов
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;

// Создаём экземпляр axios с предустановленными заголовками
const apiClient = axios.create({
    baseURL: API_URL,
    headers: {
        'Client-Id': CLIENT_ID,
        'Api-Key': API_KEY,
        'Content-Type': 'application/json',
    },
});

// Флаг для тестов (MOCK-режим)
const MOCK_MODE = true;

// Тестовые заказы (включают warehouse_id для проверки фильтрации)
const mockOrders = [
    {
        posting_number: "12345-1",
        products: [{ name: "Тестовый товар А", quantity: 2 }],
        warehouse_id: "1234567890"   // ID склада, для которого предназначен заказ
    },
    {
        posting_number: "67890-2",
        products: [{ name: "Тестовый товар Б", quantity: 1 }],
        warehouse_id: "9876543210"
    }
];
// Получить список заказов FBS со статусом "awaiting_packaging" (ожидает упаковки)
// Документация: метод /v4/posting/fbs/list
async function fetchAwaitingOrders(warehouseId = null) {
    console.log('[Ozon] Запрос списка заказов...');
    if (MOCK_MODE) {
        console.log('[Ozon MOCK] Возвращаем тестовые заказы');
        // Если указан warehouseId, фильтруем мок-заказы по складу
        if (warehouseId) {
            return mockOrders.filter(order => order.warehouse_id === warehouseId);
        }
        return mockOrders;
    }

    try {
        const requestBody = {
            filter: {
                statuses: ['awaiting_packaging'],   // массив статусов, как в документации
            },
            limit: 20,
            // Если передан warehouseId, добавляем фильтр по складу
            ...(warehouseId && { filter: { warehouse_id: [warehouseId], statuses: ['awaiting_packaging'] } })
        };
        const response = await apiClient.post('/v4/posting/fbs/list', requestBody);
        const orders = response.data.result?.postings || [];
        console.log(`[Ozon] Успешно получено ${orders.length} заказов.`);
        return orders;
    } catch (error) {
        console.error('[Ozon] Ошибка при получении заказов:',
            error.response?.data || error.message);
        return [];
    }
}

// Получить детали заказа (состав, адрес и т.д.)
async function getOrderDetails(orderId) {
    if (MOCK_MODE) {
        const mock = mockOrders.find(o => o.posting_number === orderId);
        return mock || { posting_number: orderId, products: [] };
    }
    try {
        const response = await apiClient.post('/v3/posting/fbs/get', {
            posting_number: orderId,
        });
        return response.data.result;
    } catch (error) {
        console.error(`[Ozon] Ошибка получения деталей заказа ${orderId}:`,
            error.response?.data || error.message);
        return null;
    }
}

module.exports = { fetchAwaitingOrders, getOrderDetails };