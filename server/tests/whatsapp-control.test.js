/**
 * Phase 6 Automated Test Suite: Cloud Remote Control over WhatsApp Engine
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const app = require('../src/index');
const wsHub = require('../src/websocket/hub');
const { mockDeviceStore } = require('../src/middleware/agentAuth');

const TEST_PORT = 5096;
let testServer;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makeRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
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
    console.log('🧪 Starting Phase 6 WhatsApp Cloud Remote Control Test Suite...\n');
    const state = { passed: 0, failed: 0 };

    testServer = http.createServer(app);
    wsHub.init(testServer, '/agent/ws');
    await new Promise(resolve => testServer.listen(TEST_PORT, resolve));

    // Prepare mock device
    const testDeviceId = crypto.randomUUID();
    const testTenantId = crypto.randomUUID();
    const testToken = crypto.randomBytes(32).toString('hex');
    const testTokenHash = crypto.createHash('sha256').update(testToken).digest('hex');

    mockDeviceStore.set(testDeviceId, {
        id: testDeviceId,
        tenant_id: testTenantId,
        device_name: 'Store Billing PC',
        agent_token_hash: testTokenHash,
        status: 'ONLINE'
    });

    try {
        // Test 1: Cloud API rejects unauthenticated calls to /api/v1/whatsapp/*
        const unauthReq = await makeRequest('GET', '/api/v1/whatsapp/accounts');
        assert(unauthReq.status === 401, 'GET /api/v1/whatsapp/accounts rejects unauthenticated call (401)', state);

        // Test 2: Mock an authenticated user/tenant request
        // To test route logic directly, we can test wsHub dispatching when device is offline vs online
        assert(wsHub.isDeviceOnline(testTenantId, testDeviceId) === false, 'Device initially recognized as offline in WebSocket Hub', state);

        // Test 3: Connect Agent to WebSocket Hub
        let receivedEvents = [];
        const agentWs = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/agent/ws?deviceId=${testDeviceId}&deviceToken=${testToken}`);
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                receivedEvents.push(msg);
                if (msg.event === 'agent:connected') resolve(ws);
            });
            ws.on('error', reject);
        });

        assert(wsHub.isDeviceOnline(testTenantId, testDeviceId) === true, 'Device now recognized as ONLINE in WebSocket Hub', state);

        // Test 4: Cloud sends 'whatsapp:request_qr' command to Agent
        const dispatchedQr = wsHub.sendToDevice(testTenantId, testDeviceId, 'whatsapp:request_qr', { clientId: 'default' });
        assert(dispatchedQr === true, 'Cloud sends whatsapp:request_qr command to online Agent socket', state);

        await new Promise(r => setTimeout(r, 50));
        const qrEvent = receivedEvents.find(e => e.event === 'whatsapp:request_qr');
        assert(qrEvent !== undefined && qrEvent.data.clientId === 'default', 'Agent receives whatsapp:request_qr event over WebSocket', state);

        // Test 5: Cloud sends 'whatsapp:request_pairing_code' command
        const dispatchedPair = wsHub.sendToDevice(testTenantId, testDeviceId, 'whatsapp:request_pairing_code', {
            clientId: 'default',
            phoneNumber: '919876543210'
        });
        assert(dispatchedPair === true, 'Cloud sends whatsapp:request_pairing_code command', state);

        await new Promise(r => setTimeout(r, 50));
        const pairEvent = receivedEvents.find(e => e.event === 'whatsapp:request_pairing_code');
        assert(pairEvent !== undefined && pairEvent.data.phoneNumber === '919876543210', 'Agent receives whatsapp:request_pairing_code with target phone', state);

        // Test 6: Cloud sends 'whatsapp:clear_session' command
        const dispatchedClear = wsHub.sendToDevice(testTenantId, testDeviceId, 'whatsapp:clear_session', { clientId: 'default' });
        assert(dispatchedClear === true, 'Cloud sends whatsapp:clear_session command', state);

        await new Promise(r => setTimeout(r, 50));
        const clearEvent = receivedEvents.find(e => e.event === 'whatsapp:clear_session');
        assert(clearEvent !== undefined && clearEvent.data.clientId === 'default', 'Agent receives whatsapp:clear_session event', state);

        // Test 7: Disconnect Agent
        agentWs.close();
        await new Promise(r => setTimeout(r, 50));
        assert(wsHub.isDeviceOnline(testTenantId, testDeviceId) === false, 'Device marked offline upon socket closure', state);

        console.log('\n========================================');
        if (state.failed === 0) {
            console.log(`🎉 ALL ${state.passed} WHATSAPP CLOUD CONTROL TESTS PASSED!`);
            process.exit(0);
        } else {
            console.error(`❌ ${state.failed} test(s) failed.`);
            process.exit(1);
        }

    } catch (err) {
        console.error('Test execution error:', err);
        process.exit(1);
    } finally {
        testServer.close();
    }
}

runTests();
