const axios = require('axios');
require('dotenv').config();
const debugMode = require('./debugMode');

// --- Конфигурация ---
const API_URL = 'https://api-seller.ozon.ru';
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
const MOCK_MODE = process.env.OZON_MOCK_MODE === 'true';

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
        console.log('[Ozon] Запрос списка складов...');
        return [
            { warehouse_id: "1234567890", name: "Склад 'Северный' (FBS)", address: "г. Москва, ул. Северная, д.1", is_rfbs: false },
            { warehouse_id: "9876543210", name: "Склад 'Южный' (realFBS)", address: "г. Подольск, ул. Южная, д.10", is_rfbs: true }
        ];
    }

    try {
        if (debugMode.isDebugMode()) console.log('[Ozon] Запрос списка складов...');
        // Для получения всех складов можно отправить пустой объект или limit: 100
        const response = await apiClient.post('/v2/warehouse/list', {
            limit: 100   // Запрашиваем до 100 складов за раз
        });

        // В реальном ответе данные находятся в поле warehouses
        const warehousesRaw = response.data.warehouses || [];

        // Приводим к единому формату (warehouse_id как строка)
        const warehouses = warehousesRaw.map(wh => ({
            warehouse_id: String(wh.warehouse_id),          // преобразуем число в строку
            name: wh.name,
            address: wh.address_info?.address || null,     // адрес может быть вложенным
            is_rfbs: wh.is_rfbs || false
        }));

        if (debugMode.isDebugMode()) console.log(`[Ozon] Успешно получено ${warehouses.length} складов.`);
        return warehouses;
    } catch (error) {
        console.error('[Ozon] Ошибка при получении списка складов:',
            error.response?.data || error.message);
        // Детальный вывод для диагностики
        console.error('[Ozon] Детали ошибки:', JSON.stringify(error.response?.data, null, 2));
        return [];
    }
}

// Получить список заказов FBS со статусом "awaiting_packaging" (ожидает упаковки)
// Документация: метод /v4/posting/fbs/list
async function fetchAwaitingOrders(warehouseId = null) {
    if (debugMode.isDebugMode()) console.log('[Ozon] Запрос списка заказов...');
    if (MOCK_MODE) {
        console.log('[Ozon MOCK] Возвращаем тестовые заказы');
        if (warehouseId) {
            return mockOrders.filter(order => order.warehouse_id === warehouseId);
        }
        return mockOrders;
    }

    try {
        // Диапазон дат: от 90 дней назад до сегодня
        const since = new Date();
        since.setDate(since.getDate() - 90);
        const to = new Date();

        const filter = {
            statuses: ['awaiting_packaging'],
            since: since.toISOString(),
            to: to.toISOString()
        };

        if (warehouseId) {
            filter.warehouse_id = [warehouseId];
        }

        const requestBody = {
            filter,
            limit: 20,
            with: {
                analytics_data: true
            }
        };

        const response = await apiClient.post('/v4/posting/fbs/list', requestBody);
        const orders = response.data.postings || [];   // Исправлено: данные напрямую в поле postings
        if (debugMode.isDebugMode()) console.log(`[Ozon] Успешно получено ${orders.length} заказов.`);
        return orders;
    } catch (error) {
        console.error('[Ozon] Ошибка при получении заказов:', error.response?.data || error.message);
        return [];
    }
}

async function fetchAwaitingOrdersById(orderId) {
    const allOrders = await fetchAwaitingOrders();
    return allOrders.find(order => order.posting_number === orderId);
}

// Получить детали заказа (состав, адрес и т.д.)
async function getOrderDetails(orderId) {
    if (debugMode.isDebugMode()) console.log(`[Ozon] Запрос деталей заказа ${orderId}`);
    if (MOCK_MODE) {
        const mock = mockOrders.find(o => o.posting_number === orderId);
        return mock || { posting_number: orderId, products: [] };
    }
    try {
        const response = await apiClient.post('/v3/posting/fbs/get', {
            posting_number: orderId,
            with: { financial_data: true }
        });
        if (debugMode.isDebugMode()) console.log(`[Ozon] Детали заказа ${orderId} получены`);
        return response.data.result;
    } catch (error) {
        console.error(`[Ozon] Ошибка получения деталей заказа ${orderId}:`,
            error.response?.data || error.message);
        return null;
    }
}

// Получить фотографии товара по SKU
async function fetchProductsImages(skuList) {
    if (!skuList.length) return {};
    try {
        const response = await apiClient.post('/v3/product/info/list', {
            sku: skuList.map(s => String(s))
        });
        if (debugMode.isDebugMode()) {
            console.log('[DEBUG] Полный ответ от /v3/product/info/list:');
            console.log(JSON.stringify(response.data, null, 2));
        }
        const items = response.data.items || [];
        const imageMap = {};
        for (const item of items) {
            const img = item.primary_image?.[0] || item.images?.[0];
            if (img) imageMap[item.sku] = img;
        }
        return imageMap;
    } catch (err) {
        console.error('Ошибка получения фото:', err.message);
        return {};
    }
}

async function downloadImage(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return Buffer.from(response.data, 'binary');
    } catch (err) {
        console.error('Ошибка загрузки изображения:', err.message);
        return null;
    }
}

// Подтвердить сборку заказа (POST /v4/posting/fbs/ship)
async function confirmPostingShip(postingNumber) {
    if (debugMode.isDebugMode()) {
        console.log(`[DEBUG] Эмуляция подтверждения сборки заказа ${postingNumber}`);
        return { result: [postingNumber] };
    }

    console.log(`[SHIP] Начинаем подтверждение сборки заказа ${postingNumber}`);
    const details = await getOrderDetails(postingNumber);
    if (!details || !details.products) throw new Error('Нет состава заказа');
    const packages = [{
        products: details.products.map(p => ({
            product_id: p.product_id || p.sku,
            quantity: p.quantity
        }))
    }];
    console.log(`[SHIP] packages:`, JSON.stringify(packages, null, 2));
    const response = await apiClient.post('/v4/posting/fbs/ship', {
        packages,
        posting_number: postingNumber,
        with: { additional_data: true }
    });
    console.log(`[SHIP] Успешно подтверждён заказ ${postingNumber}`, response.data);
    return response.data;
}

// Получить PDF этикетку для заказа (POST /v2/posting/fbs/package-label)
async function getPackageLabel(postingNumber) {
    if (debugMode.isDebugMode()) {
        console.log(`[DEBUG] Эмуляция получения этикетки для ${postingNumber}`);
        // Возвращаем заглушку (пустой PDF) – достаточно для тестирования
        const dummyPdf = Buffer.from('%PDF-1.4\n%EOF', 'binary');
        return dummyPdf;
    }

    try {
        const response = await apiClient.post('/v2/posting/fbs/package-label', {
            posting_number: [postingNumber]   // массив строк
        });
        console.log(`[LABEL] Ответ:`, response.data);
        if (response.data.file_content && response.data.content_type === 'application/pdf') {
            return Buffer.from(response.data.file_content, 'base64');
        }
        return null;
    } catch (err) {
        console.error('Ошибка этикетки:', err.response?.data || err.message);
        return null;
    }
}

// Получить общую сумму заказа из финансовых данных
async function getOrderTotalAmount(orderId) {
    const details = await getOrderDetails(orderId);
    if (!details || !details.financial_data || !details.financial_data.products) return 0;
    let total = 0;
    for (const p of details.financial_data.products) {
        const price = parseFloat(p.price) || 0;
        total += price * p.quantity;
    }
    return total;
}

module.exports = {
    fetchAwaitingOrders, fetchAwaitingOrdersById, getOrderDetails, fetchWarehousesFromOzon, fetchProductsImages, downloadImage, confirmPostingShip,
    getPackageLabel, getOrderTotalAmount
};