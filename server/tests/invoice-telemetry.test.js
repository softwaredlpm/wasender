/**
 * Phase 11 Server Test Suite: BUSY Invoice Telemetry & Dashboard Broadcasting
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const app = require('../src/index');
const wsHub = require('../src/websocket/hub');
const { mockDeviceStore } = require('../src/middleware/agentAuth');

const TEST_PORT = 5097;
let testServer;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const TENANT_ID = 'tenant-telemetry-p11';
const DEVICE_ID = 'device-telemetry-p11';
const RAW_DEVICE_TOKEN = 'mock-agent-secret-token-p11';
const TOKEN_HASH = crypto.createHash('sha256').update(RAW_DEVICE_TOKEN).digest('hex');

const AUTH_HEADERS = {
    'Authorization': 'Bearer mock-user-token',
    'x-tenant-id': TENANT_ID
};

function makeRequest(method, reqPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(reqPath, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = http.request(options, (res) => {
            let responseBody = '';
            res.on('data', chunk => responseBody += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseBody);
                    resolve({ status: res.statusCode, body: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, raw: responseBody });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function assert(condition, description, state) {
    if (condition) {
        console.log(`  ✅ PASS: ${description}`);
        state.passed++;
    } else {
        console.error(`  ❌ FAIL: ${description}`);
        state.failed++;
    }
}

async function runTests() {
    console.log('🧪 Starting Phase 11 Test Suite: BUSY Invoice Telemetry & Real-Time Broadcast');
    const state = { passed: 0, failed: 0 };

    mockDeviceStore.set(DEVICE_ID, {
        id: DEVICE_ID,
        tenant_id: TENANT_ID,
        device_name: 'Billing PC - Warehouse',
        agent_token_hash: TOKEN_HASH,
        status: 'OFFLINE'
    });

    await new Promise(resolve => {
        testServer = app.server.listen(TEST_PORT, () => {
            console.log(`Test server running on port ${TEST_PORT}`);
            resolve();
        });
    });

    let mockAgentWs = null;
    let mockBrowserWs = null;

    try {
        // --- 1. CONNECT BROWSER CLIENT OVER WEBSOCKET ---
        console.log('\n--- 1. Connecting Web Dashboard WebSocket Client ---');

        const browserWsUrl = `ws://127.0.0.1:${TEST_PORT}/browser/ws?token=mock-user-token&tenantId=${TENANT_ID}`;
        mockBrowserWs = new WebSocket(browserWsUrl);

        await new Promise((resolve, reject) => {
            mockBrowserWs.on('open', resolve);
            mockBrowserWs.on('error', reject);
        });

        assert(mockBrowserWs.readyState === WebSocket.OPEN, 'Browser WebSocket channel connected for real-time dashboard updates', state);

        const receivedBrowserEvents = [];
        mockBrowserWs.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                receivedBrowserEvents.push(msg);
            } catch (_) {}
        });

        // --- 2. CONNECT AGENT OVER WEBSOCKET ---
        console.log('\n--- 2. Connecting Windows Agent WebSocket ---');

        const agentWsUrl = `ws://127.0.0.1:${TEST_PORT}/agent/ws?deviceId=${DEVICE_ID}&deviceToken=${RAW_DEVICE_TOKEN}`;
        mockAgentWs = new WebSocket(agentWsUrl);

        await new Promise((resolve, reject) => {
            mockAgentWs.on('open', resolve);
            mockAgentWs.on('error', reject);
        });

        assert(wsHub.isDeviceOnline(TENANT_ID, DEVICE_ID), 'Agent device authenticated and online in Hub', state);

        // --- 3. DISPATCH INVOICE TELEMETRY FROM AGENT ---
        console.log('\n--- 3. Ingesting Invoice Telemetry Payload ---');

        const telemetryMsg = {
            event: 'busy:invoice_dispatched',
            id: crypto.randomUUID(),
            data: {
                phone: '919876543210',
                invoiceNo: 'BUSY-VCH-2026-089',
                amount: 32500.50,
                firmId: 'firm_1769673861339',
                status: 'SENT',
                hasAttachment: true,
                whatsappMessageId: 'true_919876543210@c.us_3EB0AA112233',
                dispatchedAt: new Date().toISOString()
            }
        };

        mockAgentWs.send(JSON.stringify(telemetryMsg));

        // Wait a short moment for WebSocket broadcast delivery
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify browser client received the event
        const invoiceEvent = receivedBrowserEvents.find(e => e.event === 'busy:invoice_dispatched');
        assert(Boolean(invoiceEvent), 'Browser client received real-time busy:invoice_dispatched event', state);
        assert(invoiceEvent?.data?.invoiceNo === 'BUSY-VCH-2026-089', 'Broadcast payload retains invoice voucher number', state);
        assert(invoiceEvent?.data?.hasAttachment === true, 'Broadcast confirms attachment was processed', state);

        // --- 4. QUERY RECENT INVOICES ENDPOINT ---
        console.log('\n--- 4. Testing Recent Invoices REST API ---');

        let recentRes = await makeRequest('GET', '/api/v1/busy/invoices/recent', null, AUTH_HEADERS);
        assert(recentRes.status === 200 && recentRes.body.success, 'GET /api/v1/busy/invoices/recent returns 200 OK', state);
        assert(Array.isArray(recentRes.body.data.invoices) && recentRes.body.data.invoices.length >= 1, 'Recent invoices list populated with dispatched invoice', state);
        const topInvoice = recentRes.body.data.invoices[0];
        assert(topInvoice.invoiceNo === 'BUSY-VCH-2026-089', 'Top invoice record matches dispatched voucher', state);
        assert(topInvoice.amount === 32500.50, 'Voucher amount correctly captured in telemetry', state);

    } catch (err) {
        console.error('💥 Test execution error:', err);
        state.failed++;
    } finally {
        if (mockAgentWs) mockAgentWs.close();
        if (mockBrowserWs) mockBrowserWs.close();
        if (app.queueDispatcher) app.queueDispatcher.stop();
        testServer.close();
    }

    console.log(`\n========================================`);
    console.log(`Test Results: ${state.passed} Passed, ${state.failed} Failed`);
    console.log(`========================================\n`);

    if (state.failed > 0) process.exit(1);
    process.exit(0);
}

runTests();
