/**
 * Phase 8 Automated Test Suite: Cloud Bulk Messaging & Central Queue Dispatcher
 */

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const app = require('../src/index');
const wsHub = require('../src/websocket/hub');
const { queueDispatcher, mockQueue } = require('../src/services/queueDispatcher');
const { mockDeviceStore } = require('../src/middleware/agentAuth');

const TEST_PORT = 5094;
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
    console.log('🧪 Starting Phase 8 Cloud Bulk Messaging & Central Queue Test Suite...\n');
    const state = { passed: 0, failed: 0 };

    testServer = http.createServer(app);
    wsHub.init(testServer);
    await new Promise(resolve => testServer.listen(TEST_PORT, resolve));

    // Setup Mock Device & Tenant
    const tenantId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const deviceToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');

    mockDeviceStore.set(deviceId, {
        id: deviceId,
        tenant_id: tenantId,
        device_name: 'Warehouse Dispatch PC',
        agent_token_hash: tokenHash,
        status: 'ONLINE'
    });

    // Mock authenticated user headers for tenant
    const authHeaders = {
        'Authorization': 'Bearer mock-jwt-token',
        'X-Tenant-Id': tenantId
    };

    try {
        // Test 1: Reject unauthenticated request to /api/v1/messages/bulk-send
        const unauth = await makeRequest('POST', '/api/v1/messages/bulk-send', { recipients: [] });
        assert(unauth.status === 401, 'POST /api/v1/messages/bulk-send rejects unauthenticated request (401)', state);

        // Test 2: Validation - empty recipients rejected
        const emptyRec = await makeRequest('POST', '/api/v1/messages/bulk-send', { recipients: [] }, authHeaders);
        assert(emptyRec.status === 400 && emptyRec.body.error.includes('recipient is required'),
            'POST /api/v1/messages/bulk-send rejects empty recipients array (400)', state);

        // Test 3: Enqueue bulk campaign with mustache variable substitution
        const bulkPayload = {
            deviceId,
            recipients: [
                {
                    name: 'Ramesh Patel',
                    phone: '9876543210',
                    variables: { invoice_no: 'INV-101', amount: '2,400' }
                },
                {
                    name: 'Priya Sharma',
                    phone: '9123456789',
                    variables: { invoice_no: 'INV-102', amount: '4,850' }
                }
            ],
            messageTemplate: 'Dear {{customer_name}}, invoice {{invoice_no}} for ₹{{amount}} is ready. Thank you!',
            idempotencyKey: 'test-campaign-001'
        };

        const enqueueRes = await makeRequest('POST', '/api/v1/messages/bulk-send', bulkPayload, authHeaders);
        assert(enqueueRes.status === 201 && enqueueRes.body.data.queuedCount === 2,
            'POST /api/v1/messages/bulk-send enqueues 2 messages with 201 Created', state);

        // Test 4: Verify variable interpolation in mock queue
        const item1 = mockQueue.find(j => j.phone === '9876543210');
        const item2 = mockQueue.find(j => j.phone === '9123456789');

        assert(item1 && item1.message === 'Dear Ramesh Patel, invoice INV-101 for ₹2,400 is ready. Thank you!',
            'Mustache variable interpolation verified for recipient 1 (name, invoice_no, amount)', state);
        assert(item2 && item2.message === 'Dear Priya Sharma, invoice INV-102 for ₹4,850 is ready. Thank you!',
            'Mustache variable interpolation verified for recipient 2', state);

        // Test 5: Queue inspection endpoint
        const queueRes = await makeRequest('GET', '/api/v1/messages/queue', null, authHeaders);
        assert(queueRes.status === 200 && queueRes.body.data.summary.total >= 2,
            'GET /api/v1/messages/queue returns accurate queue count summary', state);

        // Test 6: Pause tenant queue
        const pauseRes = await makeRequest('POST', '/api/v1/messages/queue/pause', null, authHeaders);
        assert(pauseRes.status === 200 && pauseRes.body.data.isPaused === true,
            'POST /api/v1/messages/queue/pause pauses tenant queue dispatching', state);
        assert(queueDispatcher.isTenantPaused(tenantId) === true, 'queueDispatcher reflects tenant pause state', state);

        // Test 7: Resume tenant queue
        const resumeRes = await makeRequest('POST', '/api/v1/messages/queue/resume', null, authHeaders);
        assert(resumeRes.status === 200 && resumeRes.body.data.isPaused === false,
            'POST /api/v1/messages/queue/resume resumes tenant queue dispatching', state);
        assert(queueDispatcher.isTenantPaused(tenantId) === false, 'queueDispatcher reflects resumed state', state);

        // Test 8: WebSocket Agent Connects and Receives Dispatched Batch
        let dispatchedBatch = null;
        const agentWs = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/agent/ws?deviceId=${deviceId}&deviceToken=${deviceToken}`);
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.event === 'queue:dispatch') {
                    dispatchedBatch = msg.data;
                }
                if (msg.event === 'agent:connected') {
                    resolve(ws);
                }
            });
            ws.on('error', reject);
        });

        // Trigger dispatch check
        await queueDispatcher.pollAndDispatch();
        await new Promise(r => setTimeout(r, 100));

        assert(dispatchedBatch !== null && dispatchedBatch.items.length > 0,
            'Cloud Dispatcher routes pending batch over WebSocket to online Agent socket', state);

        // Test 9: Agent reports delivery receipt back over WebSocket
        const firstDispatchedItem = dispatchedBatch.items[0];
        const testReceiptId = 'true_919876543210@c.us_3EB0123456789';

        agentWs.send(JSON.stringify({
            event: 'queue:item_result',
            data: {
                queueId: firstDispatchedItem.id,
                status: 'SENT',
                messageId: testReceiptId
            }
        }));

        await new Promise(r => setTimeout(r, 100));

        const updatedItem = mockQueue.find(j => j.id === firstDispatchedItem.id);
        assert(updatedItem && updatedItem.status === 'SENT' && updatedItem.messageId === testReceiptId,
            'Agent delivery receipt acknowledged and job status updated to SENT with WhatsApp messageId', state);

        // Cleanup
        agentWs.close();

        console.log('\n========================================');
        if (state.failed === 0) {
            console.log(`🎉 ALL ${state.passed} QUEUE & BULK MESSAGING TESTS PASSED!`);
            process.exit(0);
        } else {
            console.error(`❌ ${state.failed} test(s) failed.`);
            process.exit(1);
        }

    } catch (err) {
        console.error('Test execution error:', err);
        process.exit(1);
    } finally {
        queueDispatcher.stop();
        testServer.close();
    }
}

runTests();
