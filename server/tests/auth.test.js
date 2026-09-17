/**
 * Phase 3 Automated Test Suite: Authentication & Tenant RBAC
 */

const http = require('http');
const app = require('../src/index');

let server;
const TEST_PORT = 5099;
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
    console.log('🧪 Starting Phase 3 Authentication & Tenant Management Test Suite...\n');
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
        // Test 1: Health check
        const health = await makeRequest('GET', '/health');
        assert(health.status === 200 && health.body.data.status === 'UP', 'GET /health returns 200 UP');

        // Test 2: Register validation - missing email/password
        const regEmpty = await makeRequest('POST', '/api/v1/auth/register', {});
        assert(regEmpty.status === 400 && regEmpty.body.error.includes('required'), 'POST /api/v1/auth/register rejects missing credentials (400)');

        // Test 3: Register validation - password too short
        const regShort = await makeRequest('POST', '/api/v1/auth/register', { email: 'test@example.com', password: '123' });
        assert(regShort.status === 400 && regShort.body.error.includes('6 characters'), 'POST /api/v1/auth/register rejects short password (400)');

        // Test 4: Login validation - missing fields
        const loginEmpty = await makeRequest('POST', '/api/v1/auth/login', {});
        assert(loginEmpty.status === 400 && loginEmpty.body.error.includes('required'), 'POST /api/v1/auth/login rejects empty body (400)');

        // Test 5: Protected route rejection without token
        const meNoAuth = await makeRequest('GET', '/api/v1/auth/me');
        assert(meNoAuth.status === 401 && meNoAuth.body.error.includes('token missing'), 'GET /api/v1/auth/me rejects missing Bearer token (401)');

        // Test 6: Protected route rejection with malformed token
        const meBadToken = await makeRequest('GET', '/api/v1/auth/me', null, { Authorization: 'Bearer invalid-token-sample' });
        assert(meBadToken.status === 401, 'GET /api/v1/auth/me rejects invalid JWT token (401)');

        // Test 7: Tenant route rejection without token
        const tenantNoAuth = await makeRequest('GET', '/api/v1/tenants');
        assert(tenantNoAuth.status === 401, 'GET /api/v1/tenants rejects unauthenticated access (401)');

        // Test 8: 404 Route handling
        const notFound = await makeRequest('GET', '/api/v1/non-existent-route');
        assert(notFound.status === 404 && notFound.body.success === false, 'Non-existent route returns standard 404 error envelope');

        console.log('\n========================================');
        if (failed === 0) {
            console.log(`🎉 ALL ${passed} TESTS PASSED! Phase 3 Auth & Tenant Security verified successfully.`);
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
