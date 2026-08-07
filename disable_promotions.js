#!/usr/bin/env node

require('dotenv').config();
const axios = require('axios');

// --- Конфигурация из .env ---
const API_URL = 'https://api-seller.ozon.ru';
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;

if (!CLIENT_ID || !API_KEY) {
    console.error('❌ Ошибка: OZON_CLIENT_ID и OZON_API_KEY должны быть заданы в .env');
    process.exit(1);
}

// Создаём экземпляр axios с заголовками
const apiClient = axios.create({
    baseURL: API_URL,
    headers: {
        'Client-Id': CLIENT_ID,
        'Api-Key': API_KEY,
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

// Функция для повторных попыток при ошибках
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
                : true;
            if (isRetryable && attempt < retries) {
                const backoff = delay * Math.pow(2, attempt - 1);
                console.warn(`[${context}] Ошибка (попытка ${attempt}/${retries}):`, error.message);
                console.log(`[${context}] Повтор через ${backoff} мс...`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                continue;
            }
            console.error(`[${context}] Критическая ошибка:`, error.message);
            throw error;
        }
    }
}

/**
 * Получить список всех товаров (пагинация по 100).
 */
async function getAllProducts() {
    console.log('📦 Получение списка всех товаров...');
    let allItems = [];
    let lastId = null;
    let hasMore = true;

    while (hasMore) {
        const requestBody = {
            filter: {
                visibility: "ALL"
            },
            limit: 100
        };
        if (lastId) {
            requestBody.last_id = lastId;
        }

        try {
            const response = await requestWithRetry(
                () => apiClient.post('/v3/product/list', requestBody),
                { context: 'getAllProducts' }
            );
            const items = response.data.result?.items || [];
            allItems = allItems.concat(items);
            lastId = response.data.result?.last_id || null;
            hasMore = !!lastId && items.length === 100;
            console.log(`   Получено ${allItems.length} товаров...`);
        } catch (error) {
            console.error('❌ Ошибка получения списка товаров:', error.message);
            throw error;
        }
    }

    console.log(`✅ Всего получено товаров: ${allItems.length}`);
    return allItems;
}

/**
 * Отключить автодобавление в акции для списка product_id (батчами по 100).
 */
async function disableAutoPromotionsForProducts(productIds) {
    console.log(`🔄 Отключение автодобавления для ${productIds.length} товаров...`);

    // Разбиваем на батчи по 100
    const batches = [];
    for (let i = 0; i < productIds.length; i += 100) {
        batches.push(productIds.slice(i, i + 100));
    }

    let processed = 0;
    for (const batch of batches) {
        const prices = batch.map(product_id => ({
            product_id: product_id,
            auto_action_enabled: "DISABLED",
            auto_add_to_ozon_actions_list_enabled: "DISABLED"
        }));

        try {
            await requestWithRetry(
                () => apiClient.post('/v1/product/import/prices', { prices }),
                { context: 'disableAutoPromotions' }
            );
            processed += batch.length;
            console.log(`   Обработано ${processed} из ${productIds.length} товаров`);
        } catch (error) {
            console.error(`❌ Ошибка при обработке батча:`, error.message);
            // Можно продолжить или остановить – решаем остановить
            throw error;
        }

        // Небольшая задержка между батчами, чтобы не превысить лимиты
        if (batches.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    console.log(`✅ Готово! Для ${processed} товаров отключено автодобавление.`);
}

// -------- Главная функция --------
async function main() {
    try {
        // 1. Получаем все товары
        const products = await getAllProducts();
        if (!products.length) {
            console.log('❌ Нет товаров для обработки.');
            return;
        }

        // 2. Извлекаем product_id
        const productIds = products.map(p => p.product_id).filter(id => id);
        console.log(`📊 Найдено товаров: ${productIds.length}`);

        // 3. Отключаем автодобавление
        await disableAutoPromotionsForProducts(productIds);

        console.log('🎉 Скрипт успешно завершён.');
    } catch (error) {
        console.error('❌ Ошибка выполнения скрипта:', error.message);
        process.exit(1);
    }
}

// Запуск
main();