/**
 * Phase 15 Automated Test Suite: Security Hardening & Isolation
 * Verifies:
 * 1. Helmet security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, X-Powered-By removal)
 * 2. Sliding-window rate limiters (Auth, Messaging, Reset capabilities, RFC headers)
 * 3. Strict Cross-Tenant Isolation (IDOR, header spoofing, query tampering, body injection)
 * 4. Input validation & sanitization (Prototype pollution, Null bytes, XSS script stripping, HPP)
 * 5. Malformed / Tampered token rejection
 */

const http = require('http');
const app = require('../src/index');

const TEST_PORT = 5096;
let testServer;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Test Tokens & Tenant IDs
const TENANT_A_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_B_ID = '22222222-2222-2222-2222-222222222222';

const HEADERS_TENANT_A = {
    'Authorization': 'Bearer mock-tenant-a-token',
    'Content-Type': 'application/json'
};

const HEADERS_TENANT_B = {
    'Authorization': 'Bearer mock-tenant-b-token',
    'Content-Type': 'application/json'
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
                ...headers
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = data;
                }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: parsed
                });
            });
        });

        req.on('error', reject);
        if (body) {
            const payload = typeof body === 'string' ? body : JSON.stringify(body);
            req.write(payload);
        }
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
    console.log('🛡️ Starting Phase 15 Test Suite: Security Hardening & Multi-Tenant Isolation\n');
    const state = { passed: 0, failed: 0 };

    await new Promise(resolve => {
        testServer = app.server.listen(TEST_PORT, () => {
            console.log(`Test server running on port ${TEST_PORT}\n`);
            resolve();
        });
    });

    try {
        // --- 1. HELMET SECURITY HEADERS ---
        console.log('--- 1. Testing Security Headers via Helmet ---');
        const headerRes = await makeRequest('GET', '/health');

        assert(headerRes.status === 200, 'Endpoint accessible with security middleware', state);
        assert(headerRes.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options is nosniff', state);
        assert(headerRes.headers['x-frame-options'] === 'DENY', 'X-Frame-Options is DENY (Clickjacking defense)', state);
        assert(headerRes.headers['strict-transport-security']?.includes('max-age=31536000'), 'HSTS is active with 1-year max-age', state);
        assert(headerRes.headers['content-security-policy']?.includes("default-src 'self'"), 'CSP is enforced with strict defaults', state);
        assert(headerRes.headers['x-powered-by'] === undefined, 'X-Powered-By header is completely hidden', state);

        // --- 2. SLIDING WINDOW RATE LIMITING ---
        console.log('\n--- 2. Testing Sliding-Window Rate Limiting Engine ---');

        // Reset limiters for clean test state
        if (app.authLimiter?.reset) app.authLimiter.reset();
        if (app.messageSendLimiter?.reset) app.messageSendLimiter.reset();

        console.log('  Testing Auth Rate Limiter (Max 10 requests per 15 mins)...');
        let reachedLimit = false;
        let lastRes;

        // Exhaust the 10 allowed attempts
        for (let i = 1; i <= 12; i++) {
            lastRes = await makeRequest('POST', '/api/v1/auth/login', {
                email: `bruteforce_${i}@example.com`,
                password: 'wrongpassword'
            }, { 'Content-Type': 'application/json' });

            if (lastRes.status === 429) {
                reachedLimit = true;
                break;
            }
        }

        assert(reachedLimit && lastRes.status === 429, 'Auth rate limiter triggers HTTP 429 Too Many Requests', state);
        assert(lastRes.headers['ratelimit-limit'] === '10', 'RateLimit-Limit header accurately set to 10', state);
        assert(lastRes.headers['ratelimit-remaining'] === '0', 'RateLimit-Remaining is 0 on blocked request', state);
        assert(Boolean(lastRes.headers['retry-after']), 'Retry-After header present on rate-limited response', state);
        assert(lastRes.body.success === false, 'Rate limit error envelope matches standard format', state);

        // Verify limiter reset capability
        app.authLimiter.reset();
        const afterResetRes = await makeRequest('POST', '/api/v1/auth/login', {
            email: 'test@example.com'
            // Missing password will return 400 Bad Request if not blocked by 429
        }, { 'Content-Type': 'application/json' });
        assert(afterResetRes.status === 400, 'Limiter reset successfully clears block immediately', state);

        // --- 3. STRICT CROSS-TENANT ISOLATION ---
        console.log('\n--- 3. Testing Strict Cross-Tenant Isolation ---');

        // 3A: Tenant A creates a contact and template
        const createContactRes = await makeRequest('POST', '/api/v1/contacts', {
            name: 'Alice Confidential Contact',
            phone: '9876543210',
            email: 'alice@tenanta.com'
        }, HEADERS_TENANT_A);

        assert(createContactRes.status === 201, 'Tenant A successfully creates private contact', state);
        const contactAId = createContactRes.body.data?.id;

        const createTemplateRes = await makeRequest('POST', '/api/v1/templates', {
            name: 'Tenant A Confidential Billing Template',
            content: 'Hello {{customer_name}}, your secret invoice is ready.'
        }, HEADERS_TENANT_A);

        assert(createTemplateRes.status === 201, 'Tenant A successfully creates private template', state);
        const templateAId = createTemplateRes.body.data?.id;

        // 3B: Tenant B attempts to read Tenant A's contact by ID (IDOR attack)
        const idorContactRes = await makeRequest('GET', `/api/v1/contacts/${contactAId}`, null, HEADERS_TENANT_B);
        assert(idorContactRes.status === 404, 'Tenant B is blocked from reading Tenant A contact by ID (404/IDOR protected)', state);

        // 3C: Tenant B attempts to update Tenant A's contact (IDOR mutation attack)
        const idorMutateRes = await makeRequest('PUT', `/api/v1/contacts/${contactAId}`, {
            name: 'Hacked by Tenant B'
        }, HEADERS_TENANT_B);
        assert(idorMutateRes.status === 404, 'Tenant B is blocked from modifying Tenant A contact (404/IDOR mutation protected)', state);

        // 3D: Tenant B attempts to read Tenant A's message template
        const idorTemplateRes = await makeRequest('GET', `/api/v1/templates/${templateAId}`, null, HEADERS_TENANT_B);
        assert(idorTemplateRes.status === 404, 'Tenant B is blocked from reading Tenant A template (404/IDOR protected)', state);

        // 3E: Tenant A user attempts to spoof header x-tenant-id to Tenant B
        const headerSpoofRes = await makeRequest('GET', '/api/v1/contacts', null, {
            ...HEADERS_TENANT_A,
            'x-tenant-id': TENANT_B_ID
        });
        assert(headerSpoofRes.status === 403, 'Tenant header spoofing attempt is rejected with 403 Forbidden', state);

        // 3F: Tenant A user attempts to spoof query param ?tenantId=TenantB
        const querySpoofRes = await makeRequest('GET', `/api/v1/contacts?tenantId=${TENANT_B_ID}`, null, HEADERS_TENANT_A);
        assert(querySpoofRes.status === 403, 'Query parameter tenant spoofing attempt is rejected with 403 Forbidden', state);

        // 3G: Tenant A user attempts to inject Tenant B ID into creation body
        const bodyInjectRes = await makeRequest('POST', '/api/v1/contacts', {
            name: 'Injected Foreign Contact',
            phone: '918888877777',
            tenant_id: TENANT_B_ID // Malicious injection attempt
        }, HEADERS_TENANT_A);

        // Middleware either rejects injection or forces caller's tenant_id
        if (bodyInjectRes.status === 403) {
            assert(true, 'Body tenant_id injection strictly rejected with 403 Forbidden', state);
        } else {
            // Verify Tenant B still has 0 contacts with this name
            const tenantBList = await makeRequest('GET', '/api/v1/contacts?search=Injected', null, HEADERS_TENANT_B);
            assert(tenantBList.body.data?.contacts?.length === 0, 'Foreign contact injection was neutralized and isolated', state);
        }

        // --- 4. INPUT VALIDATION & ANTI-INJECTION SANITIZATION ---
        console.log('\n--- 4. Testing Input Validation & Anti-Injection Sanitization ---');

        // 4A: Prototype Pollution Protection
        const protoPollutePayload = JSON.stringify({
            "__proto__": { "polluted": true },
            "name": "Normal Contact",
            "phone": "919999900000"
        });

        const protoRes = await makeRequest('POST', '/api/v1/contacts', protoPollutePayload, HEADERS_TENANT_A);
        assert(protoRes.status === 201, 'Request with __proto__ payload accepted after automatic cleansing', state);
        assert(({}).polluted === undefined, 'Global Object prototype remains untainted (Prototype Pollution blocked)', state);

        // 4B: Null Byte Injection Protection
        const nullBytePayload = {
            name: "Audit\0Report",
            phone: "919999911111"
        };
        const nullByteRes = await makeRequest('POST', '/api/v1/contacts', nullBytePayload, HEADERS_TENANT_A);
        assert(nullByteRes.status === 201, 'Request with null bytes successfully cleansed and accepted', state);
        assert(!nullByteRes.body.data?.name?.includes('\0'), 'Null bytes stripped from stored contact name', state);

        // 4C: Cross-Site Scripting (XSS) Sanitization
        const xssPayload = {
            name: "<script>alert('XSS')</script>Robert Vance",
            phone: "919999922222"
        };
        const xssRes = await makeRequest('POST', '/api/v1/contacts', xssPayload, HEADERS_TENANT_A);
        assert(xssRes.status === 201, 'XSS script injection attempt processed safely', state);
        assert(!xssRes.body.data?.name?.includes('<script>'), 'Dangerous <script> tags removed from contact name', state);
        assert(xssRes.body.data?.name?.includes('Robert Vance'), 'Legitimate text preserved intact during sanitization', state);

        // 4D: HTTP Parameter Pollution (HPP) Normalization
        const hppRes = await makeRequest('GET', '/api/v1/contacts?page=1&page=2', null, HEADERS_TENANT_A);
        assert(hppRes.status === 200, 'HPP duplicate query parameters handled gracefully without crash', state);

        // --- 5. AUTHENTICATION TOKEN INTEGRITY ---
        console.log('\n--- 5. Testing Authentication & Token Integrity ---');

        const noTokenRes = await makeRequest('GET', '/api/v1/contacts');
        assert(noTokenRes.status === 401, 'Unauthenticated request rejected with 401', state);

        const malformedTokenRes = await makeRequest('GET', '/api/v1/contacts', null, {
            'Authorization': 'Bearer '
        });
        assert(malformedTokenRes.status === 401, 'Empty Bearer token rejected with 401', state);

    } catch (err) {
        console.error('💥 Test suite encountered fatal error:', err);
        state.failed++;
    } finally {
        if (testServer) {
            await new Promise(r => testServer.close(r));
        }
    }

    console.log('\n========================================');
    console.log(`Test Results: ${state.passed} Passed, ${state.failed} Failed`);
    console.log('========================================\n');

    if (state.failed > 0) {
        process.exit(1);
    } else {
        console.log('🎉 ALL SECURITY HARDENING TESTS PASSED!');
        process.exit(0);
    }
}

if (require.main === module) {
    runTests();
}

module.exports = { runTests };
