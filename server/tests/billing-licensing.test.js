/**
 * Phase 13 Automated Test Suite: Licensing & Razorpay Subscriptions
 */

const http = require('http');
const app = require('../src/index');
const razorpayService = require('../src/services/razorpay');
const { licenseManager } = require('../src/services/licenseManager');

const TEST_PORT = 5092;
let testServer;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const TENANT_ID = 'tenant-billing-p13';
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
                    resolve({ status: res.statusCode, headers: res.headers, body: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, raw: responseBody });
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
    console.log('🧪 Starting Phase 13 Test Suite: Licensing & Razorpay Subscriptions');
    const state = { passed: 0, failed: 0 };

    await new Promise(resolve => {
        testServer = app.server.listen(TEST_PORT, () => {
            console.log(`Test server running on port ${TEST_PORT}`);
            resolve();
        });
    });

    try {
        // --- 1. SUBSCRIPTION PLANS CATALOG ---
        console.log('\n--- 1. Testing Subscription Plans Catalog ---');

        let plansRes = await makeRequest('GET', '/api/v1/billing/plans', null, AUTH_HEADERS);
        assert(plansRes.status === 200 && plansRes.body.success, 'GET /api/v1/billing/plans returns 200 OK', state);
        const plans = plansRes.body.data.plans;
        assert(Array.isArray(plans) && plans.length >= 4, 'Includes 4 standard tiers (Trial, Starter, Growth, Enterprise)', state);
        const growthPlan = plans.find(p => p.slug === 'growth');
        assert(growthPlan?.price === 1999 && growthPlan?.message_limit === 25000, 'Growth plan matches specs (₹1,999/mo, 25,000 msgs)', state);

        // --- 2. CURRENT TENANT SUBSCRIPTION ---
        console.log('\n--- 2. Testing Subscription Status ---');

        let subRes = await makeRequest('GET', '/api/v1/billing/subscription', null, AUTH_HEADERS);
        assert(subRes.status === 200 && subRes.body.success, 'GET /api/v1/billing/subscription returns 200 OK', state);
        assert(subRes.body.data.subscription?.status === 'TRIAL', 'New tenant defaults to TRIAL subscription status', state);

        // --- 3. RAZORPAY ORDER CREATION ---
        console.log('\n--- 3. Testing Razorpay Order Generation ---');

        let orderRes = await makeRequest('POST', '/api/v1/billing/create-order', {
            slug: 'growth'
        }, AUTH_HEADERS);

        assert(orderRes.status === 200 && orderRes.body.success, 'POST /api/v1/billing/create-order creates checkout order', state);
        assert(orderRes.body.data.amount === 199900, 'Order amount computed accurately in paise (199900)', state);
        assert(orderRes.body.data.orderId?.startsWith('order_'), 'Generates valid order ID identifier', state);
        const orderId = orderRes.body.data.orderId;

        // --- 4. PAYMENT SIGNATURE VERIFICATION & ACTIVATION ---
        console.log('\n--- 4. Testing Payment Signature Verification & Plan Upgrade ---');

        let verifyRes = await makeRequest('POST', '/api/v1/billing/verify-payment', {
            planId: growthPlan.id,
            razorpayOrderId: orderId,
            razorpayPaymentId: 'pay_mock_123456789',
            razorpaySignature: 'mock_valid_signature'
        }, AUTH_HEADERS);

        assert(verifyRes.status === 200 && verifyRes.body.success, 'POST /api/v1/billing/verify-payment verifies transaction', state);
        assert(verifyRes.body.data.status === 'ACTIVE', 'Subscription status immediately transitions to ACTIVE', state);
        assert(verifyRes.body.data.planName === 'Growth', 'Tenant upgraded to Growth plan', state);

        // Confirm updated subscription reflects new plan
        let updatedSub = await makeRequest('GET', '/api/v1/billing/subscription', null, AUTH_HEADERS);
        assert(updatedSub.body.data.subscription.status === 'ACTIVE', 'Active status persisted in tenant subscription profile', state);

        // --- 5. RAZORPAY WEBHOOK INGESTION ---
        console.log('\n--- 5. Testing Webhook Processing ---');

        const webhookPayload = {
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_live_9988776655',
                        order_id: 'order_live_11223344',
                        amount: 499900,
                        notes: {
                            tenant_id: TENANT_ID,
                            plan_id: 'plan_enterprise'
                        }
                    }
                }
            }
        };

        let webhookRes = await makeRequest('POST', '/api/v1/billing/webhook', webhookPayload);
        assert(webhookRes.status === 200 && webhookRes.body.received === true, 'Public webhook endpoint accepts and acknowledges event', state);

        // --- 6. STANDALONE CRYPTOGRAPHIC LICENSES ---
        console.log('\n--- 6. Testing Standalone Cryptographic Licensing ---');

        // Generate license key
        let genRes = await makeRequest('POST', '/api/v1/billing/license/generate', {
            tier: 'ENTERPRISE',
            durationDays: 365
        }, AUTH_HEADERS);

        assert(genRes.status === 201 && genRes.body.success, 'POST /api/v1/billing/license/generate creates signed license key', state);
        const licenseKey = genRes.body.data.licenseKey;
        assert(licenseKey.startsWith('WAS-ENT-'), 'License key has valid prefix and tier code (WAS-ENT-)', state);

        // Activate license key
        let activateRes = await makeRequest('POST', '/api/v1/billing/license/activate', {
            licenseKey
        }, AUTH_HEADERS);

        assert(activateRes.status === 200 && activateRes.body.success, 'POST /api/v1/billing/license/activate activates valid key', state);
        assert(activateRes.body.data.tier === 'ENTERPRISE', 'Activates Enterprise tier entitlements', state);

        // Query active license
        let licInfo = await makeRequest('GET', '/api/v1/billing/license', null, AUTH_HEADERS);
        assert(licInfo.body.data.active === true, 'GET /api/v1/billing/license confirms active standalone license', state);
        assert(licInfo.body.data.license?.licenseKey === licenseKey, 'Retrieved license matches activated key', state);

        // Test Tampered License Key
        console.log('\n--- 7. Testing Cryptographic Tamper Resistance ---');
        const tamperedKey = licenseKey.substring(0, licenseKey.length - 2) + 'ZZ';
        let tamperRes = await makeRequest('POST', '/api/v1/billing/license/activate', {
            licenseKey: tamperedKey
        }, AUTH_HEADERS);

        assert(tamperRes.status === 400 && tamperRes.body.success === false, 'Rejects cryptographically tampered license key (HTTP 400)', state);

        // Test Expired Key
        const expiredKey = 'WAS-ENT-20200101-ABCD-123456';
        let expiredRes = await makeRequest('POST', '/api/v1/billing/license/activate', {
            licenseKey: expiredKey
        }, AUTH_HEADERS);

        assert(expiredRes.status === 400 && expiredRes.body.success === false, 'Rejects expired license key with descriptive error', state);

    } catch (err) {
        console.error('💥 Test execution error:', err);
        state.failed++;
    } finally {
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
