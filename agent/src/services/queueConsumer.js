const sessionManager = require('../whatsapp/sessionManager');
const wsClient = require('./wsClient');
const antiBan = require('../whatsapp/antiBan');

class AgentQueueConsumer {
    constructor() {
        this.isProcessing = false;
        this.activeBatch = [];
    }

    init() {
        // Listen for queue dispatch from Cloud
        wsClient.on('queue:dispatch', async (data) => {
            const { batchId, items } = data || {};
            if (!items || items.length === 0) return;

            console.log(`📦 [Agent Queue] Received batch [${batchId}] with ${items.length} messages.`);
            await this.processBatch(items);
        });
    }

    async processBatch(items) {
        if (this.isProcessing) {
            console.warn('⚠️ Agent queue consumer already processing. Appending to queue.');
        }
        this.isProcessing = true;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            console.log(`🚀 [Agent Queue] Dispatching message [${i + 1}/${items.length}] to ${item.phone}...`);

            try {
                const sendResult = await sessionManager.sendMessage({
                    clientId: item.whatsappAccountId || 'default',
                    to: item.phone,
                    message: item.message,
                    filePath: item.attachmentPath || null
                });

                // Report success receipt to Cloud
                wsClient.send('queue:item_result', {
                    queueId: item.id,
                    status: 'SENT',
                    messageId: sendResult.messageId
                });

            } catch (err) {
                console.error(`❌ [Agent Queue] Delivery failed for ${item.phone}:`, err.message);

                // Report failure to Cloud
                wsClient.send('queue:item_result', {
                    queueId: item.id,
                    status: 'FAILED',
                    error: err.message
                });
            }

            // Apply safe anti-ban jitter delay between messages in the same batch
            if (i < items.length - 1) {
                const delayMs = antiBan.getJitterDelay(8000, 10000);
                console.log(`⏳ Anti-ban delay: waiting ${Math.round(delayMs / 1000)}s before next message...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        this.isProcessing = false;
        console.log(`🏁 [Agent Queue] Batch processing completed.`);
    }
}

module.exports = new AgentQueueConsumer();
