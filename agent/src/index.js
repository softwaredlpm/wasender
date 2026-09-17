const agentConfig = require('./config');
const cloudSync = require('./services/cloudSync');
const wsClient = require('./services/wsClient');
const sessionManager = require('./whatsapp/sessionManager');
const queueConsumer = require('./services/queueConsumer');

console.log(`
=====================================================
    WASENDER Windows Agent - Enterprise SaaS v1.0
    Local BUSY Accounting & WhatsApp Automation
=====================================================
`);

async function main() {
    const args = process.argv.slice(2);

    // 0. Handle Help
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage: WASENDER-Agent.exe [options]

Options:
  --pair <CODE>      Pair this Windows Agent with your SaaS organization using an 8-character pairing code
  --status           Display agent status, configuration path, pairing info, and exit
  --unpair           Disconnect this agent and clear stored organization credentials
  --port <PORT>      Specify custom port for the local BUSY invoice webhook (default: 5000)
  --help, -h         Show this help message and exit

Examples:
  WASENDER-Agent.exe --pair WAS-A1B2C3D4
  WASENDER-Agent.exe --status
  WASENDER-Agent.exe --port 5050
        `);
        process.exit(0);
    }

    // 0.1 Handle Unpair
    if (args.includes('--unpair')) {
        console.log('Clearing agent pairing credentials...');
        agentConfig.unpair();
        console.log('✅ Device successfully unpaired. You can now pair with a new code.');
        process.exit(0);
    }

    // 0.2 Handle Status Inspection
    if (args.includes('--status')) {
        const config = agentConfig.get();
        const busyBridge = require('./busy/busyBridge');
        console.log(`Agent Configuration & Diagnostics:`);
        console.log(`  Config File:      ${agentConfig.getConfigFilePath()}`);
        console.log(`  Paired:           ${agentConfig.isPaired() ? 'YES' : 'NO'}`);
        console.log(`  Device Name:      ${config.deviceName}`);
        console.log(`  Cloud Server:     ${config.cloudApiUrl}`);
        console.log(`  Tenant ID:        ${config.tenantId || 'None'}`);
        console.log(`  Device ID:        ${config.deviceId || 'None'}`);
        console.log(`  BUSY Bridge:      ${busyBridge.psBridgePath}`);
        console.log(`  BUSY Config:      ${busyBridge.configPath}`);
        console.log(`  Firms Configured: ${busyBridge.listFirms().length}`);
        process.exit(0);
    }

    // 0.3 Handle Custom Port Option
    const portArgIndex = args.indexOf('--port');
    if (portArgIndex !== -1 && args[portArgIndex + 1]) {
        process.env.BUSY_WEBHOOK_PORT = args[portArgIndex + 1];
    }

    // 1. Handle command-line pairing: node src/index.js --pair WAS-XXXX
    const pairArgIndex = args.indexOf('--pair');
    if (pairArgIndex !== -1 && args[pairArgIndex + 1]) {
        const pairingCode = args[pairArgIndex + 1];
        console.log(`🔗 Pairing device with code: ${pairingCode}...`);
        try {
            await cloudSync.registerWithPairingCode(pairingCode);
            console.log('🎉 Device successfully paired and configured!');
        } catch (err) {
            console.error('❌ Pairing failed:', err.message);
            process.exit(1);
        }
    }

    // 2. Check pairing status
    const config = agentConfig.get();
    if (!agentConfig.isPaired()) {
        console.log(`
⚠️  This Windows Agent is NOT yet paired with a SaaS Organization.

To pair this device:
1. Log in to your WASENDER Web Dashboard: ${config.cloudApiUrl}
2. Go to "Devices" -> Click "Add Device"
3. Copy the 8-character Pairing Code (e.g. WAS-XXXX9999)
4. Run:
      WASENDER-Agent.exe --pair YOUR-CODE

Waiting for configuration...
        `);
        return;
    }

    console.log(`💻 Device Name:   ${config.deviceName}`);
    console.log(`🏢 Tenant ID:     ${config.tenantId}`);
    console.log(`📱 Device ID:     ${config.deviceId}`);
    console.log(`🌐 Cloud Server:  ${config.cloudApiUrl}`);
    console.log(`📅 Paired Since:  ${config.pairedAt}`);
    console.log('-----------------------------------------------------');

    // 3. Connect Real-time WebSocket
    wsClient.connect();

    // 4. Initialize Local Queue Consumer
    queueConsumer.init();

    // 5. Bind Cloud Remote Control Events to Local WhatsApp Engine
    wsClient.on('agent:connected', (data) => {
        console.log(`🌟 Cloud server confirmed connection: ${data.serverTime}`);
        sessionManager.getOrCreateClient('default', 'Primary Account');
    });

    // 5.1 BUSY Cloud Remote RPC Handlers
    const busyBridge = require('./busy/busyBridge');

    wsClient.on('busy:test_connection', async (data, correlationId) => {
        console.log(`📥 [Cloud RPC] Testing BUSY connection for driver: ${data?.dbType || 'Access'}`);
        const result = await busyBridge.testConnection(data || {});
        wsClient.send('busy:test_connection:result', result, correlationId);
    });

    wsClient.on('busy:get_companies', async (data, correlationId) => {
        console.log(`📥 [Cloud RPC] Listing local BUSY firms`);
        const firms = busyBridge.listFirms();
        wsClient.send('busy:get_companies:result', { companies: firms }, correlationId);
    });

    wsClient.on('busy:get_accounts', async (data, correlationId) => {
        console.log(`📥 [Cloud RPC] Fetching accounts for firm`);
        try {
            const accounts = await busyBridge.getAccounts(data || {});
            wsClient.send('busy:get_accounts:result', { accounts }, correlationId);
        } catch (err) {
            wsClient.send('busy:get_accounts:result', { error: err.message, accounts: [] }, correlationId);
        }
    });

    wsClient.on('whatsapp:init', (data) => {
        const clientId = data?.clientId || 'default';
        const accountName = data?.accountName || 'Primary Account';
        console.log(`📥 [Cloud Command] Initializing WhatsApp account: ${accountName} (${clientId})`);
        sessionManager.getOrCreateClient(clientId, accountName);
    });

    wsClient.on('whatsapp:request_qr', (data) => {
        const clientId = data?.clientId || 'default';
        console.log(`📥 [Cloud Command] Requesting fresh QR for client: ${clientId}`);
        const info = sessionManager.clients.get(clientId);
        if (info && info.qrCodeBase64) {
            wsClient.send('whatsapp:qr', {
                clientId,
                qrCodeBase64: info.qrCodeBase64
            });
        } else {
            sessionManager.restartClient(clientId);
        }
    });

    wsClient.on('whatsapp:request_pairing_code', async (data) => {
        const { clientId = 'default', phoneNumber } = data || {};
        console.log(`📥 [Cloud Command] Requesting pairing code for +${phoneNumber}`);
        try {
            await sessionManager.requestPairingCode(clientId, phoneNumber);
        } catch (err) {
            wsClient.send('whatsapp:error', { clientId, error: err.message });
        }
    });

    wsClient.on('whatsapp:clear_session', async (data) => {
        const clientId = data?.clientId || 'default';
        console.log(`📥 [Cloud Command] Clearing WhatsApp session for: ${clientId}`);
        await sessionManager.clearSession(clientId);
    });

    wsClient.on('whatsapp:send', async (data, correlationId) => {
        try {
            const result = await sessionManager.sendMessage(data);
            wsClient.send('whatsapp:sent', result, correlationId);
        } catch (err) {
            wsClient.send('whatsapp:failed', {
                to: data.to,
                error: err.message,
                timestamp: new Date().toISOString()
            }, correlationId);
        }
    });

    // 6. Start Watchdog Supervisor (60s check)
    sessionManager.startWatchdog();

    // 7. Start Fallback HTTP Heartbeat Service
    cloudSync.startHeartbeat(30000);

    // 8. Start Local Invoice Webhook Server (Default port 5000 or custom)
    const invoiceWebhook = require('./services/invoiceWebhook');
    const webhookPort = parseInt(process.env.BUSY_WEBHOOK_PORT || '5000');
    invoiceWebhook.start(webhookPort).catch(err => {
        console.warn(`[Agent] Notice: Local invoice webhook on port ${webhookPort} did not start: ${err.message}`);
    });

    // 9. Graceful Shutdown
    process.on('SIGINT', () => {
        console.log('\nGracefully shutting down WASENDER Agent...');
        sessionManager.stopWatchdog();
        invoiceWebhook.stop();
        wsClient.disconnect();
        cloudSync.stopHeartbeat();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal agent error:', err);
    process.exit(1);
});
