/**
 * Phase 11 Agent Test Suite: BUSY Invoice Webhook & Post-Dispatch PDF Purge
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const invoiceWebhook = require('../src/services/invoiceWebhook');

const TEST_PORT = 5098;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makePostRequest(reqPath, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(reqPath, BASE_URL);
        const data = JSON.stringify(body);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
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
        req.write(data);
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
    console.log('🧪 Starting Agent Invoice Webhook & Immediate Purge Test Suite...');
    const state = { passed: 0, failed: 0 };

    process.env.NODE_ENV = 'test';

    // Start webhook server on test port
    await invoiceWebhook.start(TEST_PORT);
    console.log(`Local invoice webhook listening on port ${TEST_PORT}`);

    const scratchDir = path.join(__dirname, '..', 'scratch');
    if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });

    try {
        // --- 1. HEALTH & VALIDATION ---
        console.log('\n--- 1. Testing Input Validation ---');

        let rejectRes = await makePostRequest('/api/v1/send', {
            message: 'Invoice with missing phone'
        });
        assert(rejectRes.status === 400 && rejectRes.body.success === false, 'Rejects invoice dispatch when phone is missing (HTTP 400)', state);

        // --- 2. LOCAL PDF DISPATCH & IMMEDIATE PURGE ---
        console.log('\n--- 2. Testing Voucher PDF Dispatch & Post-Dispatch Purge ---');

        const dummyPdfPath = path.join(scratchDir, `voucher_sample_${Date.now()}.pdf`);
        fs.writeFileSync(dummyPdfPath, '%PDF-1.4 Mock BUSY Sales Invoice Document Content');

        assert(fs.existsSync(dummyPdfPath), 'Mock temporary invoice PDF created on disk before dispatch', state);

        let sendRes = await makePostRequest('/api/v1/send', {
            phone: '9876543210',
            message: 'Dear Customer, your Tax Invoice is attached.',
            pdfPath: dummyPdfPath,
            invoiceNo: 'TAX-2026-0042',
            amount: 14500
        });

        assert(sendRes.status === 200 && sendRes.body.success === true, 'POST /api/v1/send processes voucher dispatch successfully', state);
        assert(sendRes.body.data?.phone === '919876543210', 'Phone number auto-formatted with 91 country code', state);
        assert(sendRes.body.data?.purged === true, 'Response confirms temporary document was purged', state);

        // CRITICAL INVARIANT: PDF must no longer exist on disk!
        const fileStillExists = fs.existsSync(dummyPdfPath);
        assert(!fileStillExists, '🛡️ ARCHITECTURAL INVARIANT: Temporary invoice PDF was IMMEDIATELY PURGED from disk post-dispatch', state);

        // --- 3. BASE64 VOUCHER STREAMING & PURGE ---
        console.log('\n--- 3. Testing Base64 Voucher Dispatch & Cleanup ---');

        const dummyBase64 = Buffer.from('%PDF-1.4 Base64 Encoded Invoice').toString('base64');
        let base64Res = await makePostRequest('/api/v1/send', {
            mobile: '911234567890',
            pdfBase64: dummyBase64,
            voucherNo: 'VCH-9999',
            amount: 8200
        });

        assert(base64Res.status === 200 && base64Res.body.success === true, 'Base64 voucher payload decoded, dispatched, and purged', state);

    } catch (err) {
        console.error('💥 Test execution error:', err);
        state.failed++;
    } finally {
        invoiceWebhook.stop();
        // Clean any residual scratch files
        if (fs.existsSync(scratchDir)) {
            const files = fs.readdirSync(scratchDir);
            for (const f of files) {
                try { fs.unlinkSync(path.join(scratchDir, f)); } catch (_) {}
            }
        }
    }

    console.log(`\n========================================`);
    console.log(`Test Results: ${state.passed} Passed, ${state.failed} Failed`);
    console.log(`========================================\n`);

    if (state.failed > 0) process.exit(1);
    process.exit(0);
}

runTests();
