const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const antiBan = require('./antiBan');
const wsClient = require('../services/wsClient');

// Base directory for LocalAuth session data
const appDataDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'WASENDER') : path.join(__dirname, '..', '..');
const AUTH_BASE_PATH = path.join(appDataDir, '.wwebjs_auth');

if (!fs.existsSync(AUTH_BASE_PATH)) {
    fs.mkdirSync(AUTH_BASE_PATH, { recursive: true });
}

// Find local Chrome / Edge executable
function getChromeExecutablePath() {
    const candidates = [
        path.join(appDataDir, 'chrome-win', 'chrome.exe'),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null; // Fall back to bundled Puppeteer Chromium
}

class WhatsAppSessionManager {
    constructor() {
        // Map<clientId, { client, status, qrCodeBase64, pairingCode, number, name, isReady }>
        this.clients = new Map();
        this.isClearingSession = new Set();
        this.watchdogTimer = null;
    }

    /**
     * Retrieves or initializes a WhatsApp client by clientId (e.g. 'default', 'sales', 'billing').
     */
    getOrCreateClient(clientId = 'default', accountName = 'Primary Account') {
        if (this.clients.has(clientId)) {
            return this.clients.get(clientId);
        }

        console.log(`🤖 [WhatsApp] Initializing LocalAuth client: [${accountName}] (${clientId})...`);

        const executablePath = getChromeExecutablePath();
        if (executablePath) {
            console.log(`🧭 [WhatsApp] Using browser at: ${executablePath}`);
        }

        const clientInstance = new Client({
            authStrategy: new LocalAuth({
                clientId: clientId,
                dataPath: AUTH_BASE_PATH
            }),
            webVersionCache: {
                type: 'local'
            },
            puppeteer: {
                executablePath: executablePath || undefined,
                headless: true,
                dumpio: false,
                pipe: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-extensions',
                    '--disable-software-rasterizer',
                    '--ignore-certificate-errors',
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                ]
            }
        });

        const clientInfo = {
            clientId,
            name: accountName,
            client: clientInstance,
            status: 'DISCONNECTED', // 'DISCONNECTED', 'AUTHENTICATING', 'CONNECTED', 'PAIRING'
            isReady: false,
            qrCodeBase64: null,
            pairingCode: null,
            phoneNumber: null
        };

        this.clients.set(clientId, clientInfo);

        // Bind WhatsApp lifecycle event hooks
        this.bindClientEvents(clientInfo);

        // Start initialization
        clientInstance.initialize().catch(err => {
            console.error(`[WhatsApp] Failed to initialize client ${clientId}:`, err.message);
            clientInfo.status = 'DISCONNECTED';
            wsClient.send('whatsapp:status', { clientId, status: 'DISCONNECTED', error: err.message });
        });

        return clientInfo;
    }

    bindClientEvents(info) {
        const { client, clientId } = info;

        client.on('qr', async (qrText) => {
            info.status = 'AUTHENTICATING';
            info.isReady = false;
            try {
                const qrBase64 = await qrcode.toDataURL(qrText, { width: 300, margin: 2 });
                info.qrCodeBase64 = qrBase64;
                console.log(`🔑 [WhatsApp] New QR code generated for [${info.name}]`);

                // Stream QR to Cloud WebSocket
                wsClient.send('whatsapp:qr', {
                    clientId,
                    qrCodeBase64: qrBase64,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                console.error('[WhatsApp] Error converting QR to base64:', err.message);
            }
        });

        client.on('code', (code) => {
            info.status = 'PAIRING';
            info.pairingCode = code;
            info.qrCodeBase64 = null;
            console.log(`🔢 [WhatsApp] Phone pairing code for [${info.name}]: ${code}`);

            wsClient.send('whatsapp:pairing_code', {
                clientId,
                code,
                timestamp: new Date().toISOString()
            });
        });

        client.on('authenticated', () => {
            info.status = 'AUTHENTICATING';
            console.log(`🔐 [WhatsApp] Session authenticated for [${info.name}]`);
            wsClient.send('whatsapp:authenticated', { clientId });
        });

        client.on('ready', () => {
            info.status = 'CONNECTED';
            info.isReady = true;
            info.qrCodeBase64 = null;
            info.pairingCode = null;

            const phone = client.info?.wid?.user || 'Unknown';
            info.phoneNumber = phone;
            const pushname = client.info?.pushname || '';

            console.log(`✅ [WhatsApp] Account ready! +${phone} (${pushname})`);

            wsClient.send('whatsapp:ready', {
                clientId,
                phoneNumber: phone,
                pushname,
                name: info.name
            });
        });

        client.on('disconnected', async (reason) => {
            if (this.isClearingSession.has(clientId)) return;

            info.status = 'DISCONNECTED';
            info.isReady = false;
            info.qrCodeBase64 = null;
            console.warn(`⚠️ [WhatsApp] Account disconnected [${info.name}]: ${reason}`);

            wsClient.send('whatsapp:disconnected', { clientId, reason });

            // Auto-reconnect after 3 seconds
            setTimeout(() => {
                if (!this.isClearingSession.has(clientId)) {
                    this.restartClient(clientId);
                }
            }, 3000);
        });

        client.on('auth_failure', (msg) => {
            info.status = 'DISCONNECTED';
            info.isReady = false;
            console.error(`❌ [WhatsApp] Auth failure on [${info.name}]: ${msg}`);
            wsClient.send('whatsapp:auth_failure', { clientId, message: msg });
        });
    }

    /**
     * Request an 8-character pairing code by phone number.
     */
    async requestPairingCode(clientId, phoneNumber) {
        const info = this.clients.get(clientId);
        if (!info) throw new Error(`WhatsApp client ${clientId} not found`);

        const formatted = antiBan.formatMobileNumber(phoneNumber);
        if (!formatted) throw new Error('Invalid phone number format');

        try {
            console.log(`📱 [WhatsApp] Requesting pairing code for +${formatted}...`);
            const code = await info.client.requestPairingCode(formatted);
            info.pairingCode = code;

            wsClient.send('whatsapp:pairing_code', {
                clientId,
                phoneNumber: formatted,
                code
            });

            return code;
        } catch (err) {
            console.error('[WhatsApp] Failed to request pairing code:', err.message);
            throw err;
        }
    }

    /**
     * Sends a text message or file attachment with anti-ban protections.
     */
    async sendMessage(options) {
        const {
            clientId = 'default',
            to,
            message = '',
            filePath = null,
            caption = null
        } = options;

        const info = this.clients.get(clientId) || [...this.clients.values()].find(c => c.isReady);

        if (!info || !info.isReady) {
            throw new Error(`WhatsApp account '${clientId}' is not connected`);
        }

        const formattedNumber = antiBan.formatMobileNumber(to);
        if (!formattedNumber) {
            throw new Error(`Invalid recipient phone number: ${to}`);
        }

        const client = info.client;

        // 1. Resolve Contact Identifier (LID / JID)
        const targetChatId = await antiBan.resolveContactIdentifier(client, formattedNumber);

        // 2. Anti-Ban: Human typing simulation
        await antiBan.simulateTyping(client, targetChatId);

        // 3. Anti-Ban: Zero-width space randomization
        const safeText = antiBan.randomizeText(caption || message);

        let sendResult;

        // 4. Send Media Attachment
        if (filePath) {
            if (!fs.existsSync(filePath)) {
                throw new Error(`Attachment file not found: ${filePath}`);
            }

            console.log(`📤 [WhatsApp] Sending media file (${path.basename(filePath)}) to +${formattedNumber}...`);
            const media = MessageMedia.fromFilePath(filePath);
            sendResult = await client.sendMessage(targetChatId, media, { caption: safeText });
        } else {
            // Send Text
            console.log(`📤 [WhatsApp] Sending text to +${formattedNumber}...`);
            sendResult = await client.sendMessage(targetChatId, safeText);
        }

        const messageId = sendResult && sendResult.id ? sendResult.id._serialized : `msg_${Date.now()}`;
        console.log(`✅ [WhatsApp] Message delivered! ID: ${messageId}`);

        return {
            success: true,
            messageId,
            to: formattedNumber,
            clientId: info.clientId,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Clears local session cache and forces re-login.
     */
    async clearSession(clientId) {
        const info = this.clients.get(clientId);
        if (!info) return false;

        this.isClearingSession.add(clientId);
        info.status = 'DISCONNECTED';
        info.isReady = false;

        try {
            await info.client.logout().catch(() => {});
            await info.client.destroy().catch(() => {});
        } catch (e) {}

        // Kill orphaned Chrome instances for this session on Windows
        this.killChromeProcess(clientId);

        // Delete session directory
        const sessionPath = path.join(AUTH_BASE_PATH, `session-${clientId}`);
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🧹 Deleted session cache: ${sessionPath}`);
            } catch (err) {
                console.warn('Could not remove session directory (may be locked):', err.message);
            }
        }

        setTimeout(() => {
            this.isClearingSession.delete(clientId);
            this.getOrCreateClient(clientId, info.name);
        }, 3000);

        return true;
    }

    /**
     * Restarts a client instance safely.
     */
    async restartClient(clientId) {
        const info = this.clients.get(clientId);
        if (!info) return;

        try {
            await info.client.destroy().catch(() => {});
        } catch (e) {}

        this.killChromeProcess(clientId);

        setTimeout(() => {
            this.clients.delete(clientId);
            this.getOrCreateClient(clientId, info.name);
        }, 2000);
    }

    /**
     * Helper to force-terminate orphaned Chromium processes on Windows.
     */
    killChromeProcess(clientId) {
        try {
            spawn('powershell', [
                '-Command',
                `Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*session-${clientId}*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
            ], { windowsHide: true });
        } catch (e) {}
    }

    /**
     * Starts watchdog monitor to verify Puppeteer responsive state every 60s.
     */
    startWatchdog() {
        if (this.watchdogTimer) return;
        this.watchdogTimer = setInterval(async () => {
            for (const [clientId, info] of this.clients.entries()) {
                if (this.isClearingSession.has(clientId)) continue;

                if (info.isReady && info.status === 'CONNECTED') {
                    try {
                        const state = await Promise.race([
                            info.client.getState(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('State check timeout')), 8000))
                        ]);
                        if (state !== 'CONNECTED') {
                            console.warn(`⚠️ [WhatsApp Watchdog] Client ${clientId} lost connection (state: ${state}). Recovering...`);
                            this.restartClient(clientId);
                        }
                    } catch (err) {
                        console.error(`⚠️ [WhatsApp Watchdog] Client ${clientId} browser unresponsive:`, err.message);
                        this.restartClient(clientId);
                    }
                }
            }
        }, 60000);
    }

    stopWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }
}

module.exports = new WhatsAppSessionManager();
