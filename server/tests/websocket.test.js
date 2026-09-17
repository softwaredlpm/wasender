/**
 * Phase 5 Automated Test Suite: Cloud <-> Agent Real-Time WebSocket Infrastructure
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const app = require('../src/index');
const wsHub = require('../src/websocket/hub');
const { mockDeviceStore } = require('../src/middleware/agentAuth');

const TEST_PORT = 5097;
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
    console.log('🧪 Starting Phase 5 WebSocket Infrastructure Test Suite...\n');
    const state = { passed: 0, failed: 0 };

    testServer = http.createServer(app);
    wsHub.init(testServer, '/agent/ws');

    await new Promise(resolve => testServer.listen(TEST_PORT, resolve));

    // Register a mock device for testing
    const testDeviceId = crypto.randomUUID();
    const testTenantId = crypto.randomUUID();
    const testToken = crypto.randomBytes(32).toString('hex');
    const testTokenHash = crypto.createHash('sha256').update(testToken).digest('hex');

    mockDeviceStore.set(testDeviceId, {
        id: testDeviceId,
        tenant_id: testTenantId,
        device_name: 'Test Agent Workstation',
        agent_token_hash: testTokenHash,
        status: 'ONLINE'
    });

    try {
        // Test 1: Reject unauthenticated connection
        await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/agent/ws`);
            ws.on('close', (code) => {
                assert(code === 4001, 'Unauthenticated WebSocket connection rejected with code 4001', state);
                resolve();
            });
            ws.on('error', () => {});
        });

        // Test 2: Reject invalid token
        await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/agent/ws?deviceId=${testDeviceId}&deviceToken=wrong-token`);
            ws.on('close', (code) => {
                assert(code === 4001, 'Invalid device token rejected with code 4001', state);
                resolve();
            });
            ws.on('error', () => {});
        });

        // Test 3: Successful connection with valid credentials
        const agentWs = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/agent/ws?deviceId=${testDeviceId}&deviceToken=${testToken}`);
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'agent:connected') {
                    assert(msg.data.deviceId === testDeviceId && msg.data.tenantId === testTenantId,
                        'Agent successfully connects and receives agent:connected with tenant scope', state);
                    resolve(ws);
                }
            });
            ws.on('error', reject);
        });

        // Test 4: Device registered in hub
        assert(wsHub.isDeviceOnline(testTenantId, testDeviceId) === true, 'wsHub.isDeviceOnline returns true for connected device', state);

        // Test 5: Bi-directional event exchange (Agent ping -> Server pong)
        await new Promise((resolve) => {
            agentWs.on('message', function onMessage(raw) {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'echo:pong') {
                    assert(msg.data.original.msg === 'hello_cloud', 'Bi-directional messaging exchange (echo:ping -> echo:pong) verified', state);
                    agentWs.removeListener('message', onMessage);
                    resolve();
                }
            });

            agentWs.send(JSON.stringify({
                event: 'echo:ping',
                data: { msg: 'hello_cloud' }
            }));
        });

        // Test 6: Cloud-to-Agent targeted dispatch
        await new Promise((resolve) => {
            agentWs.on('message', function onMessage(raw) {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'cloud:command') {
                    assert(msg.data.action === 'run_diagnostics', 'Server dispatches targeted command to specific device (cloud:command)', state);
                    agentWs.removeListener('message', onMessage);
                    resolve();
                }
            });

            const sent = wsHub.sendToDevice(testTenantId, testDeviceId, 'cloud:command', { action: 'run_diagnostics' });
            assert(sent === true, 'wsHub.sendToDevice returns true for active connection', state);
        });

        // Test 7: Multi-Tenant Isolation Guarantee
        const foreignTenantId = crypto.randomUUID();
        const isolationCheck = wsHub.sendToDevice(foreignTenantId, testDeviceId, 'leak:test', { secret: 123 });
        assert(isolationCheck === false, 'Tenant isolation enforced: Cannot send message to device via foreign tenantId', state);

        // Test 8: Clean Disconnect & Status Update
        await new Promise((resolve) => {
            agentWs.on('close', () => {
                setTimeout(() => {
                    assert(wsHub.isDeviceOnline(testTenantId, testDeviceId) === false,
                        'Device marked offline and removed from socket registry upon disconnection', state);
                    resolve();
                }, 50);
            });
            agentWs.close();
        });

        console.log('\n========================================');
        if (state.failed === 0) {
            console.log(`🎉 ALL ${state.passed} WEBSOCKET TESTS PASSED! Phase 5 Real-Time Infrastructure verified successfully.`);
            process.exit(0);
        } else {
            console.error(`❌ ${state.failed} test(s) failed out of ${state.passed + state.failed}.`);
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
