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
    timeout: 30000, // Устанавливаем таймаут на запросы
});

// Флаг для тестов (MOCK-режим)
const MOCK_MODE = process.env.OZON_MOCK_MODE === 'true';

// Идентификатор для /v4/posting/fbs/ship метода
const SHIP_IDENTIFIER = process.env.SHIP_IDENTIFIER || 'offer_id';

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
 * Универсальная функция для выполнения запросов с повторными попытками
 * @param {Function} requestFn - асинхронная функция, которая выполняет запрос
 * @param {Object} options - настройки
 * @param {number} options.retries - количество попыток (по умолчанию 3)
 * @param {number} options.delay - начальная задержка в мс (по умолчанию 1000)
 * @param {string} options.context - контекст для логов
 * @returns {Promise<any>} - результат запроса
 */
async function requestWithRetry(requestFn, options = {}) {
    const { retries = 3, delay = 1000, context = 'API' } = options;
    let attempt = 0;
    while (attempt < retries) {
        try {
            return await requestFn();
        } catch (error) {
            attempt++;
            const isRetryable = error.response
                ? [429, 500, 502, 503, 504].includes(error.response.status)
                : true; // сетевые ошибки тоже повторяем

            if (isRetryable && attempt < retries) {
                const backoff = delay * Math.pow(2, attempt - 1);
                console.warn(`[${context}] Ошибка (попытка ${attempt}/${retries}):`, error.message);
                console.log(`[${context}] Повтор через ${backoff} мс...`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                continue;
            }
            // Если не повторяемая или закончились попытки – выбрасываем
            console.error(`[${context}] Критическая ошибка:`, error.message);
            throw error;
        }
    }
}

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
        const response = await requestWithRetry(
            () => apiClient.post('/v2/warehouse/list', { limit: 100 }),
            { context: 'fetchWarehouses' }
        );
        const warehousesRaw = response.data.warehouses || [];
        const warehouses = warehousesRaw.map(wh => ({
            warehouse_id: String(wh.warehouse_id),
            name: wh.name,
            address: wh.address_info?.address || null,
            is_rfbs: wh.is_rfbs || false
        }));
        if (debugMode.isDebugMode()) console.log(`[Ozon] Успешно получено ${warehouses.length} складов.`);
        return warehouses;
    } catch (error) {
        console.error('[Ozon] Ошибка при получении списка складов:', error.message);
        return [];
    }
}

// Получить список заказов FBS со статусом "awaiting_packaging"
async function fetchAwaitingOrders(warehouseId = null, limit = 100) {
    if (debugMode.isDebugMode()) console.log('[Ozon] Запрос списка заказов...');
    if (MOCK_MODE) {
        console.log('[Ozon MOCK] Возвращаем тестовые заказы');
        if (warehouseId) {
            return mockOrders.filter(order => order.warehouse_id === warehouseId);
        }
        return mockOrders;
    }

    try {
        const since = new Date();
        since.setDate(since.getDate() - 90);
        const to = new Date();

        let allOrders = [];
        let lastId = null;
        let hasMore = true;

        while (hasMore) {
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
                limit,
                with: { analytics_data: true }
            };
            if (lastId) {
                requestBody.last_id = lastId;
            }

            const response = await requestWithRetry(
                () => apiClient.post('/v4/posting/fbs/list', requestBody),
                { context: 'fetchAwaitingOrders' }
            );
            const orders = response.data.postings || [];
            allOrders = allOrders.concat(orders);
            lastId = response.data.last_id;
            hasMore = !!lastId && orders.length === limit;
        }

        if (debugMode.isDebugMode()) console.log(`[Ozon] Успешно получено ${allOrders.length} заказов.`);
        return allOrders;
    } catch (error) {
        console.error('[Ozon] Ошибка при получении заказов:', error.message);
        throw new Error(`Ошибка Ozon API при получении заказов: ${error.message}`);
    }
}

async function fetchAwaitingOrdersById(orderId) {
    try {
        const allOrders = await fetchAwaitingOrders();
        return allOrders.find(order => order.posting_number === orderId);
    } catch (error) {
        console.error(`[Ozon] Ошибка получения заказа ${orderId}:`, error.message);
        return null;
    }
}

// Получить детали заказа (состав, адрес и т.д.)
async function getOrderDetails(orderId) {
    if (debugMode.isDebugMode()) console.log(`[Ozon] Запрос деталей заказа ${orderId}`);
    if (MOCK_MODE) {
        const mock = mockOrders.find(o => o.posting_number === orderId);
        return mock || { posting_number: orderId, products: [] };
    }
    try {
        const response = await requestWithRetry(
            () => apiClient.post('/v3/posting/fbs/get', {
                posting_number: orderId,
                with: { financial_data: true }
            }),
            { context: `getOrderDetails_${orderId}` }
        );
        if (debugMode.isDebugMode()) console.log(`[Ozon] Детали заказа ${orderId} получены`);
        if (response.data.result && response.data.result.products) {
            for (const p of response.data.result.products) {
                if (!p.product_id && p.product_id !== 0) {
                    console.warn(`[WARN] В товаре отсутствует product_id:`, p);
                }
            }
        }
        return response.data.result;
    } catch (error) {
        console.error(`[Ozon] Ошибка получения деталей заказа ${orderId}:`, error.message);
        return null;
    }
}

// Получить фотографии товара по SKU
async function fetchProductsImages(skuList) {
    if (!skuList.length) return {};
    try {
        const response = await requestWithRetry(
            () => apiClient.post('/v3/product/info/list', {
                sku: skuList.map(s => String(s))
            }),
            { context: 'fetchProductsImages' }
        );
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
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000 // отдельный таймаут для загрузки картинок
        });
        return Buffer.from(response.data, 'binary');
    } catch (err) {
        console.error('Ошибка загрузки изображения:', err.message);
        return null;
    }
}

// Получить mapping offer_id -> product_id
async function getProductIdsByOfferIds(offerIds) {
    if (!offerIds.length) return {};
    const uniqueOffers = [...new Set(offerIds)];
    try {
        const response = await requestWithRetry(
            () => apiClient.post('/v3/product/info/list', { offer_id: uniqueOffers }),
            { context: 'getProductIdsByOfferIds' }
        );
        const items = response.data.items || [];
        const mapping = {};
        for (const item of items) {
            if (item.offer_id && item.id) {
                mapping[item.offer_id] = Number(item.id);
            }
        }
        return mapping;
    } catch (error) {
        console.error('Ошибка получения product_id:', error.message);
        return {};
    }
}

// Получить полную информацию о товарах по их offer_id
async function getProductsFullInfo(offerIds) {
    if (!offerIds.length) return {};
    const uniqueOffers = [...new Set(offerIds)];
    try {
        const response = await requestWithRetry(
            () => apiClient.post('/v3/product/info/list', { offer_id: uniqueOffers }),
            { context: 'getProductsFullInfo' }
        );
        const items = response.data.items || [];
        const productInfo = {};
        for (const item of items) {
            productInfo[item.offer_id] = {
                product_id: Number(item.id),
                offer_id: item.offer_id,
                sku: item.sku,
                name: item.name,
                weight_gram: item.weight ? parseFloat(item.weight) : 0,
                dimensions: {
                    length: item.dimensions?.length || 0,
                    width: item.dimensions?.width || 0,
                    height: item.dimensions?.height || 0
                }
            };
        }
        return productInfo;
    } catch (error) {
        console.error('Ошибка получения полной информации о товарах:', error.message);
        return {};
    }
}

// (Альтернативно, можно передавать массив sku)
async function getProductsFullInfoBySku(skuList) {
    if (!skuList.length) return {};
    const uniqueSkus = [...new Set(skuList)];
    try {
        const response = await requestWithRetry(
            () => apiClient.post('/v3/product/info/list', { sku: uniqueSkus.map(s => String(s)) }),
            { context: 'getProductsFullInfoBySku' }
        );
        const items = response.data.items || [];
        const productInfo = {};
        for (const item of items) {
            productInfo[item.sku] = {
                product_id: Number(item.id),
                offer_id: item.offer_id,
                sku: item.sku,
                name: item.name,
                weight_gram: item.weight ? parseFloat(item.weight) : 0,
                dimensions: {
                    length: item.dimensions?.length || 0,
                    width: item.dimensions?.width || 0,
                    height: item.dimensions?.height || 0
                }
            };
        }
        return productInfo;
    } catch (error) {
        console.error('Ошибка получения информации по SKU:', error.message);
        return {};
    }
}

// Подтвердить сборку заказа (перевести в awaiting_deliver)
async function awaitingDelivery(postingNumber) {
    if (debugMode.isDebugMode()) {
        console.log(`[DEBUG] Эмуляция awaiting-delivery для ${postingNumber}`);
        return { result: true };
    }
    try {
        const response = await requestWithRetry(
            () => apiClient.post('/v2/posting/fbs/awaiting-delivery', { posting_number: [postingNumber] }),
            { context: 'awaitingDelivery' }
        );
        console.log(`[SHIP] awaiting-delivery ответ:`, response.data);
        return response.data;
    } catch (err) {
        console.error('Ошибка awaiting-delivery:', err.message);
        return { result: false };
    }
}

// Подтвердить сборку заказа через (POST /v4/posting/fbs/ship)
async function confirmPostingShip(postingNumber) {
    if (debugMode.isDebugMode()) {
        console.log(`[DEBUG] Эмуляция подтверждения сборки заказа ${postingNumber}`);
        return { result: [postingNumber] };
    }

    const details = await getOrderDetails(postingNumber);
    if (!details) throw new Error('Нет деталей заказа');
    if (details.status !== 'awaiting_packaging') {
        throw new Error(`Заказ не в статусе awaiting_packaging (текущий: ${details.status})`);
    }
    if (!details.products || !details.products.length) throw new Error('Нет состава заказа');

    const offerIds = details.products.map(p => p.offer_id).filter(Boolean);
    const productsInfo = await getProductsFullInfo(offerIds);
    console.log(`[SHIP] Полная информация о товарах:`, productsInfo);

    const identifierType = process.env.SHIP_IDENTIFIER || 'product_id';
    console.log(`[SHIP] Используем идентификатор: ${identifierType}`);

    let totalWeight = 0;
    let maxLength = 0, maxWidth = 0, maxHeight = 0;

    const products = details.products.map(p => {
        let info = productsInfo[p.offer_id];
        if (!info && p.sku) {
            info = { product_id: null, offer_id: null, sku: p.sku };
        }
        let identifier;
        switch (identifierType) {
            case 'product_id': identifier = info.product_id; break;
            case 'offer_id': identifier = info.offer_id; break;
            case 'sku': identifier = info.sku; break;
            default: identifier = info.product_id;
        }
        if (!identifier) {
            throw new Error(`Не удалось получить ${identifierType} для товара ${p.name || p.offer_id}`);
        }

        const weightGram = info.weight_gram || (parseFloat(p.weight_max) * 1000) || parseFloat(p.dimensions?.weight) || 0;
        totalWeight += weightGram * p.quantity;

        const length = info.dimensions?.length || parseFloat(p.dimensions?.length) || 0;
        const width = info.dimensions?.width || parseFloat(p.dimensions?.width) || 0;
        const height = info.dimensions?.height || parseFloat(p.dimensions?.height) || 0;
        maxLength = Math.max(maxLength, length);
        maxWidth = Math.max(maxWidth, width);
        maxHeight = Math.max(maxHeight, height);

        return { product_id: identifier, quantity: p.quantity };
    });

    if (totalWeight === 0) totalWeight = 100;
    if (maxLength === 0) maxLength = 10;
    if (maxWidth === 0) maxWidth = 10;
    if (maxHeight === 0) maxHeight = 10;

    const packages = [{
        products,
        // weight: totalWeight,
        // dimensions: {
        //     length: maxLength,
        //     width: maxWidth,
        //     height: maxHeight
        // }
    }];

    console.log(`[SHIP] packages с упаковкой:`, JSON.stringify(packages, null, 2));

    try {
        const response = await requestWithRetry(
            () => apiClient.post('/v4/posting/fbs/ship', {
                packages,
                posting_number: postingNumber,
                with: { additional_data: true }
            }),
            { context: 'confirmPostingShip' }
        );
        console.log(`[SHIP] Ответ:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error(`[SHIP] Ошибка подтверждения сборки:`, error.message);
        throw error;
    }
}

// Получить PDF этикетку
async function getPackageLabel(postingNumber, actId = null) {
    if (debugMode.isDebugMode()) {
        console.log(`[DEBUG] Эмуляция получения этикетки для ${postingNumber || actId}`);
        return Buffer.from('%PDF-1.4\n%EOF', 'binary');
    }
    try {
        if (actId) {
            const response = await requestWithRetry(
                () => apiClient.get('/v2/posting/fbs/act/get-pdf', {
                    params: { id: actId },
                    responseType: 'arraybuffer'
                }),
                { context: 'getPackageLabel_act' }
            );
            return Buffer.from(response.data);
        } else if (postingNumber) {
            const response = await requestWithRetry(
                () => apiClient.post('/v2/posting/fbs/package-label', {
                    posting_number: [postingNumber]
                }, { responseType: 'arraybuffer' }),
                { context: 'getPackageLabel_label' }
            );
            const pdfHeader = Buffer.from('%PDF');
            if (response.data.slice(0, 4).compare(pdfHeader) === 0) {
                return response.data;
            } else {
                console.warn('[LABEL] Ответ не является PDF');
                return null;
            }
        }
        return null;
    } catch (err) {
        console.error('[LABEL] Ошибка:', err.message);
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
    fetchAwaitingOrders,
    fetchAwaitingOrdersById,
    getOrderDetails,
    fetchWarehousesFromOzon,
    fetchProductsImages,
    downloadImage,
    confirmPostingShip,
    awaitingDelivery,
    getPackageLabel,
    getOrderTotalAmount
};