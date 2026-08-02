const finishingOrders = new Map();      // key: orderId, value: true (заказ в процессе завершения)
const pendingFinishConfirmations = new Map(); // orderId -> { originalChatId, originalMessageId }

module.exports = {
    finishingOrders,
    pendingFinishConfirmations,
};