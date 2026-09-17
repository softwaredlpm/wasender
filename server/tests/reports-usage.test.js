/**
 * Phase 12 Automated Test Suite: Logs, Reports & Usage Telemetry
 */

const http = require('http');
const app = require('../src/index');
const { usageTracker } = require('../src/services/usageTracker');
const { auditLogger } = require('../src/services/auditLogger');
const { mockMessagesArchive } = require('../src/routes/reports');

const TEST_PORT = 5099;
let testServer;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const TENANT_ID = 'tenant-reports-p12';
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
                const contentType = res.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    try {
                        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(responseBody) });
                    } catch (e) {
                        resolve({ status: res.statusCode, headers: res.headers, raw: responseBody });
                    }
                } else {
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
    console.log('🧪 Starting Phase 12 Test Suite: Logs, Reports & Usage Telemetry');
    const state = { passed: 0, failed: 0 };

    await new Promise(resolve => {
        testServer = app.server.listen(TEST_PORT, () => {
            console.log(`Test server running on port ${TEST_PORT}`);
            resolve();
        });
    });

    try {
        // --- 1. USAGE TRACKING & QUOTA ENGINE ---
        console.log('\n--- 1. Testing Usage Tracking & Quota Engine ---');

        // Record some successful dispatches and failures
        await usageTracker.recordUsage(TENANT_ID, 50, true);
        await usageTracker.recordUsage(TENANT_ID, 2, false);

        const usageData = await usageTracker.getTenantUsage(TENANT_ID, 7);
        assert(usageData.totalSent >= 50, 'Daily usage tracker accumulates successful dispatches', state);
        assert(usageData.totalFailed >= 2, 'Daily usage tracker captures failed dispatches', state);
        assert(typeof usageData.deliveryRate === 'number' || typeof usageData.deliveryRate === 'string', 'Computes delivery success rate percentage', state);

        const quotaHeadroom = await usageTracker.checkQuotaHeadroom(TENANT_ID, 100);
        assert(quotaHeadroom.allowed === true, 'Quota check permits dispatch when within plan limits', state);
        assert(quotaHeadroom.remaining === quotaHeadroom.planLimit - quotaHeadroom.usedThisMonth, 'Accurately calculates remaining plan messages', state);

        // --- 2. AUDIT LOGGING SERVICE ---
        console.log('\n--- 2. Testing Audit Trail Ingestion ---');

        await auditLogger.logAction({
            tenantId: TENANT_ID,
            action: 'DEVICE_PAIRED',
            resource: 'device-01',
            details: { name: 'Dispatch PC' },
            ipAddress: '192.168.1.100'
        });

        await auditLogger.logAction({
            tenantId: TENANT_ID,
            action: 'FIRM_SYNCED',
            resource: 'busy-firms',
            details: { count: 3 }
        });

        const auditTrail = await auditLogger.getLogs(TENANT_ID);
        assert(auditTrail.logs.length >= 2, 'Retrieves audit logs for tenant', state);
        assert(auditTrail.logs[0].action === 'FIRM_SYNCED', 'Preserves chronological order (newest first)', state);

        // --- 3. REPORTS SUMMARY API ---
        console.log('\n--- 3. Testing Reports Summary REST Endpoint ---');

        let summaryRes = await makeRequest('GET', '/api/v1/reports/summary', null, AUTH_HEADERS);
        assert(summaryRes.status === 200 && summaryRes.body.success, 'GET /api/v1/reports/summary returns 200 OK', state);
        assert(summaryRes.body.data?.kpis?.totalSent >= 50, 'Summary reflects accurate total sent KPI', state);
        assert(Boolean(summaryRes.body.data?.quota?.plan), 'Summary provides plan quota metadata', state);

        // --- 4. USAGE TELEMETRY API ---
        console.log('\n--- 4. Testing Usage Breakdown Endpoint ---');

        let usageRes = await makeRequest('GET', '/api/v1/reports/usage?days=30', null, AUTH_HEADERS);
        assert(usageRes.status === 200 && usageRes.body.success, 'GET /api/v1/reports/usage returns 200 OK', state);
        assert(Array.isArray(usageRes.body.data?.history?.daily), 'Provides daily usage timeseries breakdown', state);

        // --- 5. LOGS REST APIS ---
        console.log('\n--- 5. Testing Logs Retrieval & Creation ---');

        // Populate mock messages archive for testing
        mockMessagesArchive.push({
            id: 'msg-01',
            tenant_id: TENANT_ID,
            phone: '919876543210',
            message: 'Payment reminder for invoice 101',
            direction: 'OUTBOUND',
            status: 'SENT',
            created_at: new Date().toISOString()
        });
        mockMessagesArchive.push({
            id: 'msg-02',
            tenant_id: TENANT_ID,
            phone: '919876543211',
            message: 'Voucher 102 dispatched',
            direction: 'OUTBOUND',
            status: 'FAILED',
            created_at: new Date().toISOString()
        });

        let msgLogsRes = await makeRequest('GET', '/api/v1/logs/messages?status=SENT', null, AUTH_HEADERS);
        assert(msgLogsRes.status === 200 && msgLogsRes.body.success, 'GET /api/v1/logs/messages filters by status', state);
        assert(msgLogsRes.body.data.messages.every(m => m.status === 'SENT'), 'All returned message logs have status SENT', state);

        let auditLogsRes = await makeRequest('GET', '/api/v1/logs/audit', null, AUTH_HEADERS);
        assert(auditLogsRes.status === 200 && auditLogsRes.body.data.logs.length >= 2, 'GET /api/v1/logs/audit returns audit records', state);

        let createAudit = await makeRequest('POST', '/api/v1/logs/audit', {
            action: 'MANUAL_EXPORT',
            resource: 'reports',
            details: { type: 'csv' }
        }, AUTH_HEADERS);
        assert(createAudit.status === 201 && createAudit.body.success, 'POST /api/v1/logs/audit records frontend audit events', state);

        // --- 6. CSV DATA EXPORT ENGINE ---
        console.log('\n--- 6. Testing CSV Reporting Engine ---');

        let csvMsgRes = await makeRequest('GET', '/api/v1/reports/export/messages', null, AUTH_HEADERS);
        assert(csvMsgRes.status === 200, 'GET /api/v1/reports/export/messages returns 200', state);
        assert(csvMsgRes.headers['content-type']?.includes('text/csv'), 'Response headers declare text/csv content type', state);
        assert(csvMsgRes.headers['content-disposition']?.includes('attachment; filename='), 'Content-Disposition specifies attachment download', state);
        assert(csvMsgRes.raw.startsWith('"Message ID"'), 'CSV output contains standard columns header', state);

        let csvAuditRes = await makeRequest('GET', '/api/v1/reports/export/audit-logs', null, AUTH_HEADERS);
        assert(csvAuditRes.status === 200, 'GET /api/v1/reports/export/audit-logs returns 200', state);
        assert(csvAuditRes.raw.startsWith('"Log ID"'), 'Audit CSV contains Log ID header', state);

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
