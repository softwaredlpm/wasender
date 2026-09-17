const WebSocket = require('ws');
const crypto = require('crypto');
const agentConfig = require('../config');

class AgentWebSocketClient {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.eventHandlers = new Map();
        this.shouldReconnect = true;
    }

    /**
     * Initializes and connects to the Cloud WebSocket Hub.
     */
    connect() {
        const config = agentConfig.get();

        if (!config.deviceId || !config.deviceToken) {
            console.warn('⚠️ Cannot connect WebSocket: Agent is not paired.');
            return;
        }

        // Derive ws/wss URL from cloudApiUrl
        const httpUrl = config.cloudApiUrl || 'http://localhost:5001';
        const wsBase = httpUrl.replace(/^http/, 'ws');
        const wsUrl = `${wsBase}/agent/ws?deviceId=${encodeURIComponent(config.deviceId)}&deviceToken=${encodeURIComponent(config.deviceToken)}`;

        console.log(`🔌 [Agent WS] Connecting to Cloud WebSocket: ${wsBase}/agent/ws...`);

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', () => {
                this.isConnected = true;
                this.isReconnecting = false;
                this.reconnectAttempts = 0;
                console.log(`✅ [Agent WS] Real-time WebSocket channel established with Cloud!`);
                this.trigger('connected', { deviceId: config.deviceId });
            });

            this.ws.on('message', (raw) => {
                try {
                    const message = JSON.parse(raw.toString());
                    const { event, data, id } = message;

                    // Trigger registered event handler
                    this.trigger(event, data, id);

                } catch (err) {
                    console.error('[Agent WS] Error parsing incoming message:', err.message);
                }
            });

            this.ws.on('close', (code, reason) => {
                this.isConnected = false;
                const reasonText = reason ? reason.toString() : 'No reason';
                console.warn(`⚠️ [Agent WS] Connection closed (Code: ${code}, Reason: ${reasonText})`);
                this.trigger('disconnected', { code, reason: reasonText });

                if (this.shouldReconnect && code !== 4001) {
                    this.scheduleReconnect();
                } else if (code === 4001) {
                    console.error('❌ [Agent WS] Authentication failed. Check device credentials or re-pair device.');
                }
            });

            this.ws.on('error', (err) => {
                console.error(`[Agent WS] Socket error:`, err.message);
            });

        } catch (err) {
            console.error('[Agent WS] Failed to initiate connection:', err.message);
            this.scheduleReconnect();
        }
    }

    /**
     * Exponential backoff reconnect engine (2s -> 4s -> 8s -> max 30s).
     */
    scheduleReconnect() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`⏳ [Agent WS] Reconnecting in ${Math.round(delay / 1000)}s (Attempt ${this.reconnectAttempts})...`);

        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    /**
     * Sends a structured event payload to the Cloud server.
     */
    send(event, data = {}, correlationId = null) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify({
                event,
                data,
                id: correlationId || crypto.randomUUID(),
                timestamp: new Date().toISOString()
            });
            this.ws.send(payload);
            return true;
        } else {
            console.warn(`[Agent WS] Cannot send '${event}': WebSocket is not open.`);
            return false;
        }
    }

    /**
     * Subscribes a callback to an event.
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event).add(handler);
    }

    /**
     * Removes an event subscription.
     */
    off(event, handler) {
        if (this.eventHandlers.has(event)) {
            this.eventHandlers.get(event).delete(handler);
        }
    }

    trigger(event, data, correlationId = null) {
        if (this.eventHandlers.has(event)) {
            for (const handler of this.eventHandlers.get(event)) {
                try {
                    handler(data, correlationId);
                } catch (e) {
                    console.error(`[Agent WS] Error in handler for '${event}':`, e);
                }
            }
        }
    }

    disconnect() {
        this.shouldReconnect = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = new AgentWebSocketClient();
