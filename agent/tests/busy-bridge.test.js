/**
 * Agent Test Suite: BUSY Bridge Local Inspection & Telemetry
 */

const busyBridge = require('../src/busy/busyBridge');

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
    console.log('🧪 Starting Agent BUSY Bridge Test Suite...');
    const state = { passed: 0, failed: 0 };

    try {
        // 1. Test local firm listing from busy_config.json
        console.log('\n--- 1. Testing Local Firms Detection ---');
        const firms = busyBridge.listFirms();
        assert(Array.isArray(firms), 'listFirms returns an array of configured firms', state);
        if (firms.length > 0) {
            const first = firms[0];
            assert(Boolean(first.id && first.name), `Detected local firm: "${first.name}" (ID: ${first.id})`, state);
            assert(Boolean(first.firmCode), `Derived firm code: "${first.firmCode}"`, state);
        } else {
            console.log('  ℹ️ No local firms configured in busy_config.json (empty configuration allowed)');
        }

        // 2. Test mock database connection test
        console.log('\n--- 2. Testing Database Connection Diagnostic ---');
        const connResult = await busyBridge.testConnection({ mock: true, dbType: 'Access' });
        assert(connResult.connected === true, 'Test connection returns connected: true for valid credentials', state);
        assert(connResult.driver === 'Access', 'Preserves database driver type (Access)', state);
        assert(Boolean(connResult.company?.name), `Extracts company name: "${connResult.company?.name}"`, state);
        assert(Boolean(connResult.company?.gstNo), `Extracts company GST: "${connResult.company?.gstNo}"`, state);
        assert(typeof connResult.latencyMs === 'number', `Measures connection latency (${connResult.latencyMs}ms)`, state);

        // 3. Test mock accounts retrieval
        console.log('\n--- 3. Testing Local Accounts Inspection ---');
        const accounts = await busyBridge.getAccounts({ mock: true });
        assert(Array.isArray(accounts) && accounts.length > 0, 'Retrieves party accounts from BUSY', state);
        assert(Boolean(accounts[0].Name && accounts[0].Phone), `Account 1: ${accounts[0].Name} (${accounts[0].Phone})`, state);

        // 4. Test error handling for missing dbPath without mock
        console.log('\n--- 4. Testing Validation & Error Reporting ---');
        const failedConn = await busyBridge.testConnection({ dbPath: '', dbType: 'Access' });
        assert(failedConn.connected === false, 'Rejects connection attempt when dbPath is empty', state);
        assert(Boolean(failedConn.error), `Returns clear descriptive error message: "${failedConn.error}"`, state);

    } catch (err) {
        console.error('💥 Test execution error:', err);
        state.failed++;
    }

    console.log(`\n========================================`);
    console.log(`Test Results: ${state.passed} Passed, ${state.failed} Failed`);
    console.log(`========================================\n`);

    if (state.failed > 0) process.exit(1);
    process.exit(0);
}

runTests();
