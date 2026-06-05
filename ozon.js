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

/**
 * Получает список складов продавца через API Ozon.
 * @returns {Promise<Array>} - Массив объектов складов.
 */
async function fetchWarehousesFromOzon() {
    if (MOCK_MODE) {
        console.log('[Ozon MOCK] Возвращаем тестовый список складов');
        return [
            { warehouse_id: "1234567890", name: "Склад 'Северный' (FBS)", address: "г. Москва, ул. Северная, д.1", is_rfbs: false },
            { warehouse_id: "9876543210", name: "Склад 'Южный' (realFBS)", address: "г. Подольск, ул. Южная, д.10", is_rfbs: true }
        ];
    }

    try {
        console.log('[Ozon] Запрос списка складов...');
        const response = await apiClient.post('/v2/warehouse/list');
        // Ожидаемая структура ответа: { result: [ { warehouse_id, name, address, is_rfbs, ... } ] }
        const warehouses = response.data.result || [];
        console.log(`[Ozon] Успешно получено ${warehouses.length} складов.`);
        return warehouses;
    } catch (error) {
        console.error('[Ozon] Ошибка при получении списка складов:',
            error.response?.data || error.message);
        return [];
    }
}

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
        const filter = { statuses: ['awaiting_packaging'] };
        if (warehouseId) {
            filter.warehouse_id = [warehouseId];
        }
        const requestBody = {
            filter,
            limit: 20
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

module.exports = { fetchAwaitingOrders, getOrderDetails, fetchWarehousesFromOzon };