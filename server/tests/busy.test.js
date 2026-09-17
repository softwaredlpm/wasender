/**
 * Phase 10 Automated Test Suite: BUSY Accounting Cloud Remote Control & Firm Sync
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

const TENANT_ID = 'tenant-busy-test';
const DEVICE_ID = 'device-busy-test-01';
const RAW_DEVICE_TOKEN = 'mock-agent-secret-token-busy';
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
    console.log('🧪 Starting Phase 10 Test Suite: BUSY Connection & Multi-Firm Management');
    const state = { passed: 0, failed: 0 };

    // Register mock device in store
    mockDeviceStore.set(DEVICE_ID, {
        id: DEVICE_ID,
        tenant_id: TENANT_ID,
        device_name: 'Accounts Windows PC',
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

    try {
        // --- 1. BUSY STATUS & OFFLINE DEFENSE ---
        console.log('\n--- 1. Testing Offline Device Safeguard ---');

        let statusRes = await makeRequest('GET', '/api/v1/busy/status', null, AUTH_HEADERS);
        assert(statusRes.status === 200 && statusRes.body.success, 'GET /api/v1/busy/status returns 200', state);

        // Attempting to test connection when agent is offline should return 503
        let offlineTest = await makeRequest('POST', '/api/v1/busy/test', {
            deviceId: DEVICE_ID,
            dbPath: 'C:\\BusyWin\\DATA\\COMP0001'
        }, AUTH_HEADERS);

        assert(offlineTest.status === 503, 'POST /api/v1/busy/test rejects offline agent device with HTTP 503', state);

        // --- 2. CONNECT MOCK AGENT OVER WEBSOCKET ---
        console.log('\n--- 2. Establishing Agent WebSocket RPC Bridge ---');

        const wsUrl = `ws://127.0.0.1:${TEST_PORT}/agent/ws?deviceId=${DEVICE_ID}&deviceToken=${RAW_DEVICE_TOKEN}`;
        mockAgentWs = new WebSocket(wsUrl);

        await new Promise((resolve, reject) => {
            mockAgentWs.on('open', resolve);
            mockAgentWs.on('error', reject);
        });

        assert(wsHub.isDeviceOnline(TENANT_ID, DEVICE_ID), 'Agent device is confirmed ONLINE in WebSocketHub registry', state);

        // Setup Agent RPC listener to simulate responses
        mockAgentWs.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                const { event, data, id } = msg;

                if (event === 'busy:test_connection') {
                    // Simulate local agent response
                    mockAgentWs.send(JSON.stringify({
                        event: 'busy:test_connection:result',
                        id,
                        data: {
                            connected: true,
                            driver: data.dbType || 'Access',
                            dbPath: data.dbPath,
                            company: {
                                name: 'Maharaja Steel Traders',
                                address: '100 Ring Road, Surat, Gujarat',
                                gstNo: '24AAACM1234F1Z8'
                            },
                            latencyMs: 18
                        }
                    }));
                } else if (event === 'busy:get_companies') {
                    // Simulate local agent listing firms
                    mockAgentWs.send(JSON.stringify({
                        event: 'busy:get_companies:result',
                        id,
                        data: {
                            companies: [
                                {
                                    id: 'firm_001',
                                    name: 'Maharaja Steel Traders',
                                    companyName: 'Maharaja Steel Traders',
                                    companyAddress: '100 Ring Road, Surat, Gujarat',
                                    companyGst: '24AAACM1234F1Z8',
                                    firmCode: 'COMP0001',
                                    dbType: 'Access'
                                },
                                {
                                    id: 'firm_002',
                                    name: 'Shree Sai Logistics',
                                    companyName: 'Shree Sai Logistics',
                                    companyAddress: '42 Port Highway, Kandla',
                                    companyGst: '24BBBCM9876G1Z2',
                                    firmCode: 'COMP0002',
                                    dbType: 'MSSQL'
                                }
                            ]
                        }
                    }));
                }
            } catch (_) {}
        });

        // --- 3. DISPATCH BUSY CONNECTION TEST RPC ---
        console.log('\n--- 3. Testing Real-time Cloud RPC Connection Test ---');

        let testRes = await makeRequest('POST', '/api/v1/busy/test', {
            deviceId: DEVICE_ID,
            dbPath: 'C:\\BusyWin\\DATA\\COMP0001',
            dbType: 'Access'
        }, AUTH_HEADERS);

        assert(testRes.status === 200 && testRes.body.success, 'POST /api/v1/busy/test dispatches RPC and receives result', state);
        assert(testRes.body.data?.connected === true, 'RPC response confirms connected: true', state);
        assert(testRes.body.data?.company?.name === 'Maharaja Steel Traders', 'RPC response extracts company profile from Agent', state);

        // --- 4. SYNC LOCAL BUSY FIRMS TO CLOUD ---
        console.log('\n--- 4. Testing Auto-Sync Companies from Agent ---');

        let syncRes = await makeRequest('POST', '/api/v1/busy/sync-companies', {
            deviceId: DEVICE_ID
        }, AUTH_HEADERS);

        assert(syncRes.status === 200 && syncRes.body.success, 'POST /api/v1/busy/sync-companies triggers agent query', state);
        assert(syncRes.body.data?.syncedCount === 2, 'Successfully ingested 2 firms from Windows Agent', state);

        // Verify synced companies in Cloud database
        let companiesRes = await makeRequest('GET', '/api/v1/busy/companies', null, AUTH_HEADERS);
        assert(companiesRes.status === 200 && companiesRes.body.data.companies.length >= 2, 'GET /api/v1/busy/companies lists synced firms', state);
        const hasSteel = companiesRes.body.data.companies.some(c => c.company_name === 'Maharaja Steel Traders');
        assert(hasSteel, 'Synced company "Maharaja Steel Traders" present in tenant registry', state);

        // --- 5. MANUAL COMPANY CRUD ---
        console.log('\n--- 5. Testing Manual Company CRUD ---');

        // Create
        let createRes = await makeRequest('POST', '/api/v1/busy/companies', {
            companyName: 'Kaveri Textile Mills',
            companyAddress: 'Industrial Zone, Coimbatore',
            companyGst: '33CCCCM5555H1Z3',
            firmCode: 'COMP0003'
        }, AUTH_HEADERS);

        assert(createRes.status === 201 && createRes.body.success, 'POST /api/v1/busy/companies manually adds company', state);
        const newCompId = createRes.body.data?.id;

        // Update
        let updateRes = await makeRequest('PUT', `/api/v1/busy/companies/${newCompId}`, {
            companyName: 'Kaveri Textile Mills Ltd'
        }, AUTH_HEADERS);

        assert(updateRes.body.data?.company_name === 'Kaveri Textile Mills Ltd', 'PUT /api/v1/busy/companies/:id updates company name', state);

        // Delete
        let delRes = await makeRequest('DELETE', `/api/v1/busy/companies/${newCompId}`, null, AUTH_HEADERS);
        assert(delRes.status === 200 && delRes.body.success, 'DELETE /api/v1/busy/companies/:id deletes company', state);

    } catch (err) {
        console.error('💥 Test execution error:', err);
        state.failed++;
    } finally {
        if (mockAgentWs) mockAgentWs.close();
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
