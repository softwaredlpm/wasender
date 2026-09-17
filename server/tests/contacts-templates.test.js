/**
 * Phase 9 Automated Test Suite: Contacts, Templates & Campaign Attachments
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const app = require('../src/index');

const TEST_PORT = 5095;
let testServer;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const AUTH_HEADERS = {
    'Authorization': 'Bearer mock-user-token',
    'x-tenant-id': 'tenant-test-p9'
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

function makeMultipartRequest(reqPath, filename, mimeType, fileContent, headers = {}) {
    return new Promise((resolve, reject) => {
        const boundary = '----WASenderTestBoundary' + Math.random().toString(16).slice(2);
        const contentBuf = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);

        const headerBuf = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
        );
        const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
        const payload = Buffer.concat([headerBuf, contentBuf, footerBuf]);

        const url = new URL(reqPath, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': payload.length,
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
        req.write(payload);
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
    console.log('🧪 Starting Phase 9 Test Suite: Contacts, Templates & Attachments');
    const state = { passed: 0, failed: 0 };

    await new Promise(resolve => {
        testServer = app.server.listen(TEST_PORT, () => {
            console.log(`Test server running on port ${TEST_PORT}`);
            resolve();
        });
    });

    try {
        // --- 1. CONTACTS CRUD & SEARCH ---
        console.log('\n--- 1. Testing Contacts API ---');

        // Create contact
        let contactRes = await makeRequest('POST', '/api/v1/contacts', {
            name: 'John Doe',
            phone: '9876543210',
            email: 'john@example.com',
            customer_code: 'CUST-001',
            tags: ['VIP', 'Wholesale'],
            metadata: { city: 'Mumbai' }
        }, AUTH_HEADERS);

        assert(contactRes.status === 201 && contactRes.body.success, 'Create contact with formatted phone 919876543210', state);
        const contactId = contactRes.body.data?.id;
        assert(contactRes.body.data?.phone === '919876543210', 'Phone auto-formatted with country code 91', state);

        // Create second contact for filtering
        await makeRequest('POST', '/api/v1/contacts', {
            name: 'Jane Smith',
            phone: '911234567890',
            email: 'jane@example.com',
            tags: ['Retail']
        }, AUTH_HEADERS);

        // List contacts
        let listRes = await makeRequest('GET', '/api/v1/contacts', null, AUTH_HEADERS);
        assert(listRes.status === 200 && listRes.body.data.contacts.length >= 2, 'List tenant contacts', state);

        // Search contact by name
        let searchRes = await makeRequest('GET', '/api/v1/contacts?search=John', null, AUTH_HEADERS);
        assert(searchRes.body.data.contacts.length === 1 && searchRes.body.data.contacts[0].name === 'John Doe', 'Search contacts by query', state);

        // Filter contact by tag
        let tagRes = await makeRequest('GET', '/api/v1/contacts?tag=Retail', null, AUTH_HEADERS);
        assert(tagRes.body.data.contacts.length === 1 && tagRes.body.data.contacts[0].name === 'Jane Smith', 'Filter contacts by tag', state);

        // Get unique tags
        let tagsRes = await makeRequest('GET', '/api/v1/contacts/tags', null, AUTH_HEADERS);
        assert(tagsRes.body.data.tags.includes('VIP') && tagsRes.body.data.tags.includes('Retail'), 'Get distinct tenant tags', state);

        // Update contact
        let updateRes = await makeRequest('PUT', `/api/v1/contacts/${contactId}`, {
            name: 'Johnathan Doe'
        }, AUTH_HEADERS);
        assert(updateRes.body.data.name === 'Johnathan Doe', 'Update contact name', state);

        // Import CSV contacts
        const csvContent = "name,phone,email,customer_code,tags\nAlice Brown,9876500001,alice@corp.com,C001,VIP\nBob Green,9876500002,bob@corp.com,C002,Wholesale\n";
        let csvRes = await makeRequest('POST', '/api/v1/contacts/import-csv', { csv: csvContent }, AUTH_HEADERS);
        assert(csvRes.status === 200 && csvRes.body.data.imported === 2, 'Import contacts from CSV with parsing and formatting', state);

        // --- 2. TEMPLATES CRUD & MUSTACHE EXTRACTION ---
        console.log('\n--- 2. Testing Message Templates API ---');

        // Create template with {{variables}}
        let tplRes = await makeRequest('POST', '/api/v1/templates', {
            name: 'Payment Reminder',
            category: 'billing',
            content: 'Dear {{customer_name}}, your outstanding invoice {{invoice_no}} of amount {{amount}} is due on {{due_date}}.'
        }, AUTH_HEADERS);

        assert(tplRes.status === 201 && tplRes.body.success, 'Create template with variable extraction', state);
        const tplId = tplRes.body.data?.id;
        const extractedVars = tplRes.body.data?.variables || [];
        const hasAllVars = ['customer_name', 'invoice_no', 'amount', 'due_date'].every(v => extractedVars.includes(v));
        assert(hasAllVars, `Auto-extracted mustache variables: [${extractedVars.join(', ')}]`, state);

        // List templates
        let tplList = await makeRequest('GET', '/api/v1/templates?category=billing', null, AUTH_HEADERS);
        assert(tplList.body.data.templates.length >= 1, 'Filter templates by category', state);

        // Update template
        let tplUpdate = await makeRequest('PUT', `/api/v1/templates/${tplId}`, {
            content: 'Hello {{customer_name}}, thank you for your payment!'
        }, AUTH_HEADERS);
        assert(tplUpdate.body.data.variables.length === 1 && tplUpdate.body.data.variables[0] === 'customer_name', 'Update template recalculates variables', state);

        // --- 3. ATTACHMENT UPLOAD & TENANT ISOLATION ---
        console.log('\n--- 3. Testing Campaign Attachments API ---');

        // Upload PDF attachment
        const samplePdf = '%PDF-1.4 Mock PDF Content for Campaign';
        let uploadRes = await makeMultipartRequest(
            '/api/v1/attachments/upload',
            'promo-brochure.pdf',
            'application/pdf',
            samplePdf,
            AUTH_HEADERS
        );

        assert(uploadRes.status === 201 && uploadRes.body.success, 'Upload campaign attachment via busboy multipart stream', state);
        const uploadedFilename = uploadRes.body.data?.filename;
        assert(uploadRes.body.data?.mimeType === 'application/pdf', 'Uploaded attachment preserves MIME type', state);

        // List attachments
        let attachList = await makeRequest('GET', '/api/v1/attachments', null, AUTH_HEADERS);
        assert(attachList.body.data.attachments.some(a => a.filename === uploadedFilename), 'List tenant uploaded attachments', state);

        // Retrieve attachment
        let getAttach = await makeRequest('GET', `/api/v1/attachments/${uploadedFilename}`, null, AUTH_HEADERS);
        assert(getAttach.status === 200, 'Serve attachment file securely', state);

        // Reject invalid MIME type
        let invalidUpload = await makeMultipartRequest(
            '/api/v1/attachments/upload',
            'malicious.exe',
            'application/x-msdownload',
            'MZ.....',
            AUTH_HEADERS
        );
        assert(invalidUpload.status === 400, 'Reject prohibited executable file types', state);

        // Delete attachment
        let delAttach = await makeRequest('DELETE', `/api/v1/attachments/${uploadedFilename}`, null, AUTH_HEADERS);
        assert(delAttach.status === 200 && delAttach.body.data.deleted, 'Delete attachment from disk', state);

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
