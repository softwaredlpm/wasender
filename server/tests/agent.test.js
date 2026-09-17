/**
 * Phase 4 Automated Test Suite: Windows Agent Authentication & Device Registration
 */

const http = require('http');
const app = require('../src/index');
const { generatePairingCode } = require('../src/utils/pairingCodeManager');

let server;
const TEST_PORT = 5098;
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

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function runTests() {
    console.log('🧪 Starting Phase 4 Windows Agent Registration & Device Management Test Suite...\n');
    let passed = 0;
    let failed = 0;

    const assert = (condition, description) => {
        if (condition) {
            console.log(`  ✅ PASS: ${description}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${description}`);
            failed++;
        }
    };

    // Start test server
    await new Promise(resolve => {
        server = app.listen(TEST_PORT, resolve);
    });

    try {
        // Test 1: Register with missing pairing code
        const regEmpty = await makeRequest('POST', '/api/v1/agent/register', {});
        assert(regEmpty.status === 400 && regEmpty.body.error.includes('Pairing code is required'), 'POST /api/v1/agent/register rejects missing pairing code (400)');

        // Test 2: Register with invalid pairing code
        const regBadCode = await makeRequest('POST', '/api/v1/agent/register', { pairingCode: 'WAS-INVALID-9999' });
        assert(regBadCode.status === 400 && regBadCode.body.error.includes('Invalid or expired'), 'POST /api/v1/agent/register rejects invalid pairing code (400)');

        // Test 3: Generate valid pairing code
        const testTenantId = '11111111-2222-3333-4444-555555555555';
        const pairing = generatePairingCode(testTenantId, 'Accounting Workstation');
        assert(pairing && pairing.code.startsWith('WAS-'), `Pairing code generated: ${pairing.code}`);

        // Test 4: Register with valid pairing code
        const regValid = await makeRequest('POST', '/api/v1/agent/register', {
            pairingCode: pairing.code,
            deviceName: 'Test Windows Agent',
            agentVersion: '1.0.0',
            systemInfo: { platform: 'win32', hostname: 'DESKTOP-TEST' }
        });

        assert(regValid.status === 201 && regValid.body.data.deviceToken, 'POST /api/v1/agent/register succeeds and generates deviceToken (201)');
        const { deviceId, deviceToken } = regValid.body.data;
        assert(deviceId && deviceToken.length === 64, 'deviceToken is a secure 64-character SHA-256 hex string');

        // Test 5: Re-register with consumed pairing code should be rejected (one-time use)
        const regReused = await makeRequest('POST', '/api/v1/agent/register', {
            pairingCode: pairing.code,
            deviceName: 'Second Attempt'
        });
        assert(regReused.status === 400 && regReused.body.error.includes('Invalid or expired'), 'Pairing code cannot be reused (one-time use enforced)');

        // Test 6: Heartbeat without credentials rejected
        const hbNoAuth = await makeRequest('POST', '/api/v1/agent/heartbeat', {});
        assert(hbNoAuth.status === 401 && hbNoAuth.body.error.includes('credentials missing'), 'POST /api/v1/agent/heartbeat rejects missing credentials (401)');

        // Test 7: Heartbeat with invalid token rejected
        const hbBadToken = await makeRequest('POST', '/api/v1/agent/heartbeat', {}, {
            'X-Device-Id': deviceId,
            'X-Device-Token': 'wrong-token-value'
        });
        assert(hbBadToken.status === 401, 'POST /api/v1/agent/heartbeat rejects invalid token (401)');

        // Test 8: Heartbeat with valid credentials succeeds
        const hbValid = await makeRequest('POST', '/api/v1/agent/heartbeat', {
            status: 'ONLINE',
            systemInfo: { uptime: 120, memoryMB: 4096 }
        }, {
            'X-Device-Id': deviceId,
            'X-Device-Token': deviceToken
        });
        assert(hbValid.status === 200 && hbValid.body.data.acknowledged === true, 'POST /api/v1/agent/heartbeat acknowledges valid credentials (200)');

        // Test 9: Malformed deviceId UUID rejected
        const hbBadId = await makeRequest('POST', '/api/v1/agent/heartbeat', {}, {
            'X-Device-Id': 'not-a-uuid',
            'X-Device-Token': deviceToken
        });
        assert(hbBadId.status === 400, 'POST /api/v1/agent/heartbeat rejects malformed device UUID (400)');

        console.log('\n========================================');
        if (failed === 0) {
            console.log(`🎉 ALL ${passed} TESTS PASSED! Phase 4 Windows Agent Authentication verified successfully.`);
        } else {
            console.error(`❌ ${failed} test(s) failed out of ${passed + failed}.`);
            process.exitCode = 1;
        }

    } catch (err) {
        console.error('Unexpected test error:', err);
        process.exitCode = 1;
    } finally {
        server.close();
    }
}

runTests();
