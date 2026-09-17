/**
 * Phase 14 Automated Test Suite: Admin & Customer Web Dashboards Frontend
 */

const http = require('http');
const app = require('../src/index');

const TEST_PORT = 5091;
let testServer;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makeGetRequest(reqPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(reqPath, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            headers
        };

        const req = http.request(options, (res) => {
            let responseBody = '';
            res.on('data', chunk => responseBody += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: responseBody
                });
            });
        });

        req.on('error', reject);
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
    console.log('🧪 Starting Phase 14 Test Suite: Web Dashboards & Frontend Assets');
    const state = { passed: 0, failed: 0 };

    await new Promise(resolve => {
        testServer = app.server.listen(TEST_PORT, () => {
            console.log(`Test server running on port ${TEST_PORT}`);
            resolve();
        });
    });

    try {
        // --- 1. DASHBOARD HTML ROUTE ---
        console.log('\n--- 1. Testing Dashboard HTML Delivery ---');

        let dashRes = await makeGetRequest('/dashboard');
        assert(dashRes.status === 200, 'GET /dashboard returns HTTP 200 OK', state);
        assert(dashRes.headers['content-type']?.includes('text/html'), 'Serves text/html content type', state);
        assert(dashRes.body.includes('<title>WASENDER'), 'Contains descriptive title tag', state);
        assert(dashRes.body.includes('WASENDER Windows Agent'), 'References on-premise Windows Agent components', state);

        // --- 2. ROOT BROWSER VIEW ---
        console.log('\n--- 2. Testing Root Route Browser Content Negotiation ---');

        let rootBrowserRes = await makeGetRequest('/', { 'Accept': 'text/html,application/xhtml+xml' });
        assert(rootBrowserRes.status === 200, 'GET / with Accept: text/html serves Web Dashboard directly', state);
        assert(rootBrowserRes.body.includes('id="app-sidebar"'), 'Contains application sidebar layout', state);

        let rootApiRes = await makeGetRequest('/', { 'Accept': 'application/json' });
        assert(rootApiRes.status === 200, 'GET / with Accept: application/json serves API JSON envelope', state);
        assert(rootApiRes.headers['content-type']?.includes('application/json'), 'API endpoint returns application/json', state);

        // --- 3. STATIC CSS DESIGN SYSTEM ASSET ---
        console.log('\n--- 3. Testing CSS Stylesheet Asset ---');

        let cssRes = await makeGetRequest('/css/dashboard.css');
        assert(cssRes.status === 200, 'GET /css/dashboard.css returns HTTP 200 OK', state);
        assert(cssRes.headers['content-type']?.includes('text/css'), 'Serves correct text/css MIME type', state);
        assert(cssRes.body.includes('--brand-primary: #10b981'), 'Includes rich dark-mode emerald theme tokens', state);
        assert(cssRes.body.includes('backdrop-filter: blur'), 'Includes modern glassmorphism utility styles', state);

        // --- 4. STATIC JS CLIENT CONTROLLER ASSET ---
        console.log('\n--- 4. Testing Client-Side JavaScript Controller Asset ---');

        let jsRes = await makeGetRequest('/js/app.js');
        assert(jsRes.status === 200, 'GET /js/app.js returns HTTP 200 OK', state);
        assert(jsRes.headers['content-type']?.includes('javascript'), 'Serves correct JavaScript MIME type', state);
        assert(jsRes.body.includes('class WasenderApp'), 'Contains WasenderApp client controller class', state);
        assert(jsRes.body.includes('whatsapp:qr'), 'Contains live QR code streaming event handler', state);
        assert(jsRes.body.includes('busy:invoice_dispatched'), 'Contains real-time invoice dispatch listener', state);

        // --- 5. VERIFY REQUIRED DASHBOARD VIEWS AND UNIQUE IDS ---
        console.log('\n--- 5. Verifying Semantic Structure & Interactive View IDs ---');

        const requiredViewIds = [
            'view-dashboard',
            'view-whatsapp',
            'view-devices',
            'view-busy',
            'view-campaigns',
            'view-contacts',
            'view-templates',
            'view-reports',
            'view-billing',
            'view-admin'
        ];

        for (const viewId of requiredViewIds) {
            assert(dashRes.body.includes(`id="${viewId}"`), `Dashboard includes section container #${viewId}`, state);
        }

        const requiredControlIds = [
            'btn-quick-sync-busy',
            'btn-request-qr',
            'btn-clear-session',
            'btn-submit-campaign',
            'btn-admin-generate-key',
            'ws-status-badge',
            'qr-progress-bar'
        ];

        for (const ctrlId of requiredControlIds) {
            assert(dashRes.body.includes(`id="${ctrlId}"`), `Interactive control element #${ctrlId} present`, state);
        }

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
