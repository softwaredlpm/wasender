const WebSocket = require('ws');
const crypto = require('crypto');
const url = require('url');
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { mockDeviceStore } = require('../middleware/agentAuth');

class WebSocketHub {
    constructor() {
        this.wss = null;
        // Agent Registry: Map<tenantId, Map<deviceId, Set<WebSocket>>>
        this.tenants = new Map();
        // Browser Web Client Registry: Map<tenantId, Set<WebSocket>>
        this.browserClients = new Map();
        // Reverse lookup: Map<WebSocket, { tenantId, deviceId, deviceName, type: 'agent'|'browser', isAlive } >
        this.sockets = new Map();
        // In-memory Ephemeral QR Cache: Map<`${tenantId}:${deviceId}:${clientId}`, { qrCodeBase64, expiresAt, timestamp }>
        this.ephemeralQrCache = new Map();
        // Pending RPC requests awaiting Agent replies: Map<correlationId, { resolve, reject, timer }>
        this.pendingRpcRequests = new Map();
        // In-memory buffer of recent BUSY invoice dispatches: Map<tenantId, Array<invoice>>
        this.recentInvoices = new Map();
        this.pingInterval = null;
    }

    init(server) {
        this.wss = new WebSocket.Server({ noServer: true });

        server.on('upgrade', async (request, socket, head) => {
            const parsedUrl = url.parse(request.url, true);
            const pathname = parsedUrl.pathname;

            if (pathname === '/agent/ws') {
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.handleAgentConnection(ws, request, parsedUrl.query);
                });
            } else if (pathname === '/browser/ws') {
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.handleBrowserConnection(ws, request, parsedUrl.query);
                });
            } else {
                socket.destroy();
            }
        });

        console.log(`🔌 WebSocket Hub active for Agents (/agent/ws) and Browsers (/browser/ws)`);

        this.pingInterval = setInterval(() => {
            for (const [ws, meta] of this.sockets.entries()) {
                if (meta.isAlive === false) {
                    console.log(`⚠️ Terminating unresponsive ${meta.type} socket for: ${meta.deviceId || meta.tenantId}`);
                    ws.terminate();
                    this.removeSocket(ws);
                    continue;
                }
                meta.isAlive = false;
                ws.ping();
            }
        }, 30000);

        this.wss.on('close', () => {
            clearInterval(this.pingInterval);
        });
    }

    async handleAgentConnection(ws, req, query) {
        try {
            const deviceId = query.deviceId || req.headers['x-device-id'];
            const deviceToken = query.deviceToken || req.headers['x-device-token'] || req.headers['authorization']?.replace('Bearer ', '');

            if (!deviceId || !deviceToken) {
                console.warn('❌ WebSocket Agent rejected: Missing credentials.');
                ws.close(4001, 'Unauthorized: Missing deviceId or deviceToken');
                return;
            }

            const authResult = await this.verifyDeviceToken(deviceId, deviceToken);
            if (!authResult.valid) {
                console.warn(`❌ WebSocket Agent rejected for ${deviceId}: ${authResult.error}`);
                ws.close(4001, `Unauthorized: ${authResult.error}`);
                return;
            }

            const { tenantId, deviceName } = authResult;
            this.addAgentSocket(ws, tenantId, deviceId, deviceName);

            ws.on('pong', () => {
                const meta = this.sockets.get(ws);
                if (meta) meta.isAlive = true;
            });

            ws.on('message', (raw) => {
                this.handleAgentMessage(ws, raw);
            });

            ws.on('close', (code, reason) => {
                this.handleAgentDisconnect(ws, code, reason);
            });

            ws.on('error', (err) => {
                console.error(`WebSocket error on device ${deviceId}:`, err.message);
            });

            this.send(ws, 'agent:connected', {
                deviceId,
                tenantId,
                serverTime: new Date().toISOString(),
                status: 'CONNECTED'
            });

            console.log(`✅ [WebSocket] Agent connected: [${deviceName}] (${deviceId}) on Tenant: ${tenantId}`);
            this.updateDeviceOnlineStatus(deviceId, true);
            this.broadcastToTenantBrowsers(tenantId, 'device:online', { deviceId, deviceName });

        } catch (err) {
            console.error('Error in handleAgentConnection:', err);
            ws.close(1011, 'Internal Server Error');
        }
    }

    async handleBrowserConnection(ws, req, query) {
        try {
            const token = query.token || req.headers['sec-websocket-protocol'] || req.headers['authorization']?.replace('Bearer ', '');
            const tenantId = query.tenantId || req.headers['x-tenant-id'];

            if (!token || !tenantId) {
                console.warn('❌ WebSocket Browser rejected: Missing token or tenantId.');
                ws.close(4001, 'Unauthorized: Missing token or tenantId');
                return;
            }

            const authResult = await this.verifyUserTenant(token, tenantId);
            if (!authResult.valid) {
                console.warn(`❌ WebSocket Browser rejected for tenant ${tenantId}: ${authResult.error}`);
                ws.close(4001, `Unauthorized: ${authResult.error}`);
                return;
            }

            this.addBrowserSocket(ws, tenantId, authResult.userId);

            ws.on('pong', () => {
                const meta = this.sockets.get(ws);
                if (meta) meta.isAlive = true;
            });

            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    if (msg.event === 'whatsapp:request_qr') {
                        const { deviceId, clientId = 'default' } = msg.data || {};
                        if (deviceId) {
                            this.sendToDevice(tenantId, deviceId, 'whatsapp:request_qr', { clientId });
                        }
                    }
                } catch (e) {}
            });

            ws.on('close', () => {
                this.removeSocket(ws);
            });

            this.send(ws, 'browser:connected', {
                tenantId,
                serverTime: new Date().toISOString()
            });

            console.log(`🌐 [WebSocket] Browser client connected for Tenant: ${tenantId}`);

        } catch (err) {
            console.error('Error in handleBrowserConnection:', err);
            ws.close(1011, 'Internal Server Error');
        }
    }

    async verifyUserTenant(token, tenantId) {
        if (!isConfigured() || token.startsWith('mock-')) {
            return { valid: true, userId: 'test-user-id' };
        }

        try {
            const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
            if (error || !user) return { valid: false, error: 'Invalid user token' };

            const { data: member } = await supabaseAdmin
                .from('tenant_users')
                .select('role')
                .eq('tenant_id', tenantId)
                .eq('user_id', user.id)
                .single();

            if (!member) return { valid: false, error: 'User is not a member of this tenant' };
            return { valid: true, userId: user.id };
        } catch (e) {
            return { valid: false, error: e.message };
        }
    }

    handleAgentMessage(ws, raw) {
        const meta = this.sockets.get(ws);
        if (!meta) return;

        try {
            const payload = JSON.parse(raw.toString());
            const { event, data, id } = payload;
            const { tenantId, deviceId } = meta;

            meta.isAlive = true;

            // Resolve any pending RPC promise awaiting this correlationId
            if (id && this.pendingRpcRequests.has(id)) {
                const { resolve, timer } = this.pendingRpcRequests.get(id);
                clearTimeout(timer);
                this.pendingRpcRequests.delete(id);
                return resolve(data);
            }

            switch (event) {
                case 'agent:heartbeat':
                    this.send(ws, 'agent:heartbeat_ack', {
                        receivedAt: new Date().toISOString(),
                        deviceId
                    }, id);
                    break;

                // --- CLOUD QUEUE DISPATCH RECEIPT (PHASE 8) ---
                case 'queue:item_result': {
                    const { queueDispatcher } = require('../services/queueDispatcher');
                    queueDispatcher.handleItemResult({
                        ...data,
                        tenantId,
                        deviceId
                    });
                    break;
                }

                // --- ONLINE QR STREAMING (PHASE 7) ---
                case 'whatsapp:qr': {
                    const clientId = data?.clientId || 'default';
                    const qrCodeBase64 = data?.qrCodeBase64;
                    const cacheKey = `${tenantId}:${deviceId}:${clientId}`;

                    this.ephemeralQrCache.set(cacheKey, {
                        qrCodeBase64,
                        timestamp: Date.now(),
                        expiresAt: Date.now() + 30000
                    });

                    this.broadcastToTenantBrowsers(tenantId, 'whatsapp:qr', {
                        deviceId,
                        clientId,
                        qrCodeBase64,
                        expiresInSeconds: 20,
                        timestamp: new Date().toISOString()
                    });
                    break;
                }

                case 'whatsapp:pairing_code': {
                    const clientId = data?.clientId || 'default';
                    this.broadcastToTenantBrowsers(tenantId, 'whatsapp:pairing_code', {
                        deviceId,
                        clientId,
                        code: data.code,
                        phoneNumber: data.phoneNumber
                    });
                    break;
                }

                case 'whatsapp:ready': {
                    const clientId = data?.clientId || 'default';
                    const cacheKey = `${tenantId}:${deviceId}:${clientId}`;
                    this.ephemeralQrCache.delete(cacheKey);

                    if (isConfigured()) {
                        supabaseAdmin
                            .from('whatsapp_accounts')
                            .upsert({
                                tenant_id: tenantId,
                                device_id: deviceId,
                                client_id: clientId,
                                phone_number: data.phoneNumber,
                                account_name: data.name || 'Primary Account',
                                status: 'CONNECTED',
                                last_seen: new Date().toISOString()
                            }, { onConflict: 'tenant_id,device_id,client_id' })
                            .then(() => {})
                            .catch(err => console.error('Error updating whatsapp_accounts:', err.message));
                    }

                    this.broadcastToTenantBrowsers(tenantId, 'whatsapp:ready', {
                        deviceId,
                        clientId,
                        phoneNumber: data.phoneNumber,
                        pushname: data.pushname,
                        accountName: data.name,
                        status: 'CONNECTED'
                    });
                    break;
                }

                case 'whatsapp:disconnected': {
                    const clientId = data?.clientId || 'default';
                    if (isConfigured()) {
                        supabaseAdmin
                            .from('whatsapp_accounts')
                            .update({ status: 'DISCONNECTED', last_seen: new Date().toISOString() })
                            .eq('tenant_id', tenantId)
                            .eq('device_id', deviceId)
                            .eq('client_id', clientId)
                            .then(() => {})
                            .catch(() => {});
                    }

                    this.broadcastToTenantBrowsers(tenantId, 'whatsapp:disconnected', {
                        deviceId,
                        clientId,
                        reason: data.reason,
                        status: 'DISCONNECTED'
                    });
                    break;
                }

                case 'busy:status':
                    this.broadcastToTenantBrowsers(tenantId, 'busy:status', {
                        deviceId,
                        ...data
                    });
                    break;

                case 'busy:invoice_dispatched': {
                    const invoiceEntry = {
                        deviceId,
                        phone: data?.phone,
                        invoiceNo: data?.invoiceNo,
                        amount: data?.amount,
                        firmId: data?.firmId,
                        status: data?.status || 'SENT',
                        hasAttachment: Boolean(data?.hasAttachment),
                        whatsappMessageId: data?.whatsappMessageId,
                        dispatchedAt: data?.dispatchedAt || new Date().toISOString()
                    };

                    // In-memory tenant buffer
                    if (!this.recentInvoices.has(tenantId)) {
                        this.recentInvoices.set(tenantId, []);
                    }
                    const list = this.recentInvoices.get(tenantId);
                    list.unshift(invoiceEntry);
                    if (list.length > 50) list.pop();

                    // Database telemetry logging
                    if (isConfigured()) {
                        supabaseAdmin
                            .from('messages')
                            .insert({
                                tenant_id: tenantId,
                                phone: invoiceEntry.phone || '',
                                message: `[BUSY Invoice] Voucher #${invoiceEntry.invoiceNo || ''} dispatched`,
                                direction: 'OUTBOUND',
                                status: invoiceEntry.status === 'FAILED' ? 'FAILED' : 'SENT',
                                message_id: invoiceEntry.whatsappMessageId || null
                            })
                            .then(() => {})
                            .catch(err => console.error('Error logging invoice message:', err.message));

                        const today = new Date().toISOString().split('T')[0];
                        supabaseAdmin
                            .from('usage_daily')
                            .upsert({
                                tenant_id: tenantId,
                                usage_date: today,
                                messages_sent: 1
                            }, { onConflict: 'tenant_id,usage_date' })
                            .then(() => {}).catch(() => {});
                    }

                    // Broadcast real-time event to connected tenant web browser clients
                    this.broadcastToTenantBrowsers(tenantId, 'busy:invoice_dispatched', invoiceEntry);
                    break;
                }

                case 'echo:ping':
                    this.send(ws, 'echo:pong', { message: 'pong', original: data }, id);
                    break;
            }
        } catch (err) {
            console.error('Failed to parse WebSocket message:', err.message);
        }
    }

    broadcastToTenantBrowsers(tenantId, event, data = {}) {
        const browserSet = this.browserClients.get(tenantId);
        if (!browserSet || browserSet.size === 0) return false;

        let sentCount = 0;
        for (const ws of browserSet) {
            if (this.send(ws, event, data)) {
                sentCount++;
            }
        }
        return sentCount > 0;
    }

    getEphemeralQr(tenantId, deviceId, clientId = 'default') {
        const cacheKey = `${tenantId}:${deviceId}:${clientId}`;
        const item = this.ephemeralQrCache.get(cacheKey);

        if (!item) return null;

        if (Date.now() > item.expiresAt) {
            this.ephemeralQrCache.delete(cacheKey);
            return null;
        }

        return {
            qrCodeBase64: item.qrCodeBase64,
            expiresInSeconds: Math.max(1, Math.round((item.expiresAt - Date.now()) / 1000)),
            timestamp: new Date(item.timestamp).toISOString()
        };
    }

    async verifyDeviceToken(deviceId, token) {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        if (mockDeviceStore.has(deviceId)) {
            const dev = mockDeviceStore.get(deviceId);
            if (dev.status === 'REVOKED') return { valid: false, error: 'Device is revoked' };
            if (dev.agent_token_hash === tokenHash) {
                return { valid: true, tenantId: dev.tenant_id, deviceName: dev.device_name };
            }
            return { valid: false, error: 'Invalid token' };
        }

        if (isConfigured()) {
            const { data: device, error } = await supabaseAdmin
                .from('devices')
                .select('id, tenant_id, device_name, agent_token_hash, status')
                .eq('id', deviceId)
                .single();

            if (error || !device) return { valid: false, error: 'Device not found' };
            if (device.status === 'REVOKED') return { valid: false, error: 'Device is revoked' };
            if (device.agent_token_hash === tokenHash) {
                return { valid: true, tenantId: device.tenant_id, deviceName: device.device_name };
            }
            return { valid: false, error: 'Invalid token' };
        }

        return { valid: false, error: 'Authentication service unavailable' };
    }

    addAgentSocket(ws, tenantId, deviceId, deviceName) {
        if (!this.tenants.has(tenantId)) {
            this.tenants.set(tenantId, new Map());
        }
        const tenantDevices = this.tenants.get(tenantId);

        if (!tenantDevices.has(deviceId)) {
            tenantDevices.set(deviceId, new Set());
        }
        tenantDevices.get(deviceId).add(ws);

        this.sockets.set(ws, {
            type: 'agent',
            tenantId,
            deviceId,
            deviceName,
            isAlive: true,
            connectedAt: Date.now()
        });
    }

    addBrowserSocket(ws, tenantId, userId) {
        if (!this.browserClients.has(tenantId)) {
            this.browserClients.set(tenantId, new Set());
        }
        this.browserClients.get(tenantId).add(ws);

        this.sockets.set(ws, {
            type: 'browser',
            tenantId,
            userId,
            isAlive: true,
            connectedAt: Date.now()
        });
    }

    removeSocket(ws) {
        const meta = this.sockets.get(ws);
        if (!meta) return;

        this.sockets.delete(ws);

        if (meta.type === 'agent') {
            const { tenantId, deviceId } = meta;
            if (this.tenants.has(tenantId)) {
                const tenantDevices = this.tenants.get(tenantId);
                if (tenantDevices.has(deviceId)) {
                    tenantDevices.get(deviceId).delete(ws);
                    if (tenantDevices.get(deviceId).size === 0) {
                        tenantDevices.delete(deviceId);
                        this.updateDeviceOnlineStatus(deviceId, false);
                        this.broadcastToTenantBrowsers(tenantId, 'device:offline', { deviceId });
                    }
                }
                if (tenantDevices.size === 0) {
                    this.tenants.delete(tenantId);
                }
            }
        } else if (meta.type === 'browser') {
            const { tenantId } = meta;
            if (this.browserClients.has(tenantId)) {
                this.browserClients.get(tenantId).delete(ws);
                if (this.browserClients.get(tenantId).size === 0) {
                    this.browserClients.delete(tenantId);
                }
            }
        }
    }

    handleAgentDisconnect(ws, code, reason) {
        const meta = this.sockets.get(ws);
        if (meta) {
            console.log(`🔌 [WebSocket] Agent disconnected: [${meta.deviceName}] (${meta.deviceId}) Code: ${code}`);
        }
        this.removeSocket(ws);
    }

    send(ws, event, data = {}, correlationId = null) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                event,
                data,
                id: correlationId || crypto.randomUUID(),
                timestamp: new Date().toISOString()
            }));
            return true;
        }
        return false;
    }

    sendToDevice(tenantId, deviceId, event, data = {}, correlationId = null) {
        const tenantDevices = this.tenants.get(tenantId);
        if (!tenantDevices) return false;

        const sockets = tenantDevices.get(deviceId);
        if (!sockets || sockets.size === 0) return false;

        let sent = false;
        for (const ws of sockets) {
            if (this.send(ws, event, data, correlationId)) {
                sent = true;
            }
        }
        return sent;
    }

    /**
     * Dispatches an RPC command to an online agent and awaits response by correlationId
     */
    requestDevice(tenantId, deviceId, event, data = {}, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            if (!this.isDeviceOnline(tenantId, deviceId)) {
                return reject(new Error(`Agent device ${deviceId} is currently offline.`));
            }

            const correlationId = crypto.randomUUID();
            const timer = setTimeout(() => {
                this.pendingRpcRequests.delete(correlationId);
                reject(new Error(`Agent request '${event}' timed out after ${timeoutMs}ms.`));
            }, timeoutMs);

            this.pendingRpcRequests.set(correlationId, { resolve, reject, timer });

            const sent = this.sendToDevice(tenantId, deviceId, event, data, correlationId);
            if (!sent) {
                clearTimeout(timer);
                this.pendingRpcRequests.delete(correlationId);
                reject(new Error(`Failed to send event '${event}' to device ${deviceId}.`));
            }
        });
    }

    isDeviceOnline(tenantId, deviceId) {
        const tenantDevices = this.tenants.get(tenantId);
        if (!tenantDevices) return false;
        const sockets = tenantDevices.get(deviceId);
        return Boolean(sockets && sockets.size > 0);
    }

    updateDeviceOnlineStatus(deviceId, isOnline) {
        if (mockDeviceStore.has(deviceId)) {
            const dev = mockDeviceStore.get(deviceId);
            dev.status = isOnline ? 'ONLINE' : 'OFFLINE';
            dev.last_seen = new Date().toISOString();
        } else if (isConfigured()) {
            supabaseAdmin
                .from('devices')
                .update({
                    status: isOnline ? 'ONLINE' : 'OFFLINE',
                    last_seen: new Date().toISOString()
                })
                .eq('id', deviceId)
                .then(() => {})
                .catch(() => {});
        }
    }
}

module.exports = new WebSocketHub();
