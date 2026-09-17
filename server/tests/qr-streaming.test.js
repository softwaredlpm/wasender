/**
 * Phase 7 Automated Test Suite: Online QR Display & Ephemeral Streaming
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const app = require('../src/index');
const wsHub = require('../src/websocket/hub');
const { mockDeviceStore } = require('../src/middleware/agentAuth');

const TEST_PORT = 5095;
let testServer;

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
    console.log('🧪 Starting Phase 7 Online QR Display & Ephemeral Streaming Test Suite...\n');
    const state = { passed: 0, failed: 0 };

    testServer = http.createServer(app);
    wsHub.init(testServer);
    await new Promise(resolve => testServer.listen(TEST_PORT, resolve));

    // Setup Mock Device in Tenant A
    const tenantA = crypto.randomUUID();
    const deviceA = crypto.randomUUID();
    const tokenA = crypto.randomBytes(32).toString('hex');
    const tokenHashA = crypto.createHash('sha256').update(tokenA).digest('hex');

    mockDeviceStore.set(deviceA, {
        id: deviceA,
        tenant_id: tenantA,
        device_name: 'Store Front PC',
        agent_token_hash: tokenHashA,
        status: 'ONLINE'
    });

    // Setup Tenant B for Isolation Testing
    const tenantB = crypto.randomUUID();

    try {
        // Test 1: Reject unauthenticated browser socket
        await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/browser/ws`);
            ws.on('close', (code) => {
                assert(code === 4001, 'Unauthenticated browser socket rejected with code 4001', state);
                resolve();
            });
            ws.on('error', () => {});
        });

        // Test 2: Authenticate browser client for Tenant A
        const browserSocketA = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/browser/ws?token=mock-jwt-user&tenantId=${tenantA}`);
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'browser:connected') {
                    assert(msg.data.tenantId === tenantA, 'Browser socket for Tenant A connected successfully', state);
                    resolve(ws);
                }
            });
            ws.on('error', reject);
        });

        // Test 3: Authenticate second browser client for Tenant B (for isolation test)
        let tenantBReceivedEvents = [];
        const browserSocketB = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/browser/ws?token=mock-jwt-user&tenantId=${tenantB}`);
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                tenantBReceivedEvents.push(msg);
                if (msg.event === 'browser:connected') resolve(ws);
            });
            ws.on('error', reject);
        });

        // Test 4: Connect Windows Agent A for Tenant A
        const agentWsA = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/agent/ws?deviceId=${deviceA}&deviceToken=${tokenA}`);
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'agent:connected') resolve(ws);
            });
            ws.on('error', reject);
        });

        // Test 5: Agent emits fresh QR code -> Browser client A receives live stream
        const mockQrBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

        const receivedQrEvent = await new Promise((resolve) => {
            browserSocketA.on('message', function onMsg(raw) {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'whatsapp:qr') {
                    browserSocketA.removeListener('message', onMsg);
                    resolve(msg);
                }
            });

            // Agent sends QR
            agentWsA.send(JSON.stringify({
                event: 'whatsapp:qr',
                data: {
                    clientId: 'default',
                    qrCodeBase64: mockQrBase64
                }
            }));
        });

        assert(receivedQrEvent.data.qrCodeBase64 === mockQrBase64, 'Browser receives live ephemeral QR code payload', state);
        assert(receivedQrEvent.data.expiresInSeconds === 20, 'QR stream includes 20-second refresh countdown', state);
        assert(receivedQrEvent.data.deviceId === deviceA, 'QR stream correctly tagged with deviceId', state);

        // Test 6: In-Memory Ephemeral Cache check
        const cachedQr = wsHub.getEphemeralQr(tenantA, deviceA, 'default');
        assert(cachedQr !== null && cachedQr.qrCodeBase64 === mockQrBase64, 'Live QR cached in RAM memory for fast query', state);

        // Test 7: Isolation verification: Tenant B browser socket NEVER received Tenant A's QR
        const leakedToB = tenantBReceivedEvents.find(e => e.event === 'whatsapp:qr');
        assert(leakedToB === undefined, 'Tenant Isolation Guaranteed: Tenant B never received Tenant A QR stream', state);

        // Test 8: Agent emits 'whatsapp:ready' (QR scanned successfully)
        const readyEvent = await new Promise((resolve) => {
            browserSocketA.on('message', function onMsg(raw) {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'whatsapp:ready') {
                    browserSocketA.removeListener('message', onMsg);
                    resolve(msg);
                }
            });

            // Agent reports WhatsApp Ready
            agentWsA.send(JSON.stringify({
                event: 'whatsapp:ready',
                data: {
                    clientId: 'default',
                    phoneNumber: '919876543210',
                    pushname: 'Store Owner',
                    name: 'Primary Account'
                }
            }));
        });

        assert(readyEvent.data.status === 'CONNECTED' && readyEvent.data.phoneNumber === '919876543210',
            'Browser client receives whatsapp:ready transition to CONNECTED status with phone number', state);

        // Test 9: Ephemeral QR purged from memory after successful login
        const purgedQr = wsHub.getEphemeralQr(tenantA, deviceA, 'default');
        assert(purgedQr === null, 'Ephemeral QR purged from memory after connection succeeded', state);

        // Cleanup sockets
        agentWsA.close();
        browserSocketA.close();
        browserSocketB.close();

        console.log('\n========================================');
        if (state.failed === 0) {
            console.log(`🎉 ALL ${state.passed} QR STREAMING TESTS PASSED! Phase 7 Online QR Display verified successfully.`);
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
