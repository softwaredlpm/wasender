const agentConfig = require('../src/config');
const fs = require('fs');
const path = require('path');

console.log('🧪 Starting Windows Agent Client Unit Tests...\n');

let passed = 0;
let failed = 0;

function assert(condition, description) {
    if (condition) {
        console.log(`  ✅ PASS: ${description}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${description}`);
        failed++;
    }
}

try {
    // Test 1: Config loading
    const config = agentConfig.get();
    assert(config !== null && typeof config === 'object', 'agentConfig loads successfully');
    assert(config.agentVersion === '1.0.0', 'Default agentVersion is 1.0.0');

    // Test 2: Saving updates
    const testDeviceId = '12345678-1234-1234-1234-123456789abc';
    const testToken = 'a'.repeat(64);
    agentConfig.save({
        deviceId: testDeviceId,
        deviceToken: testToken,
        isPaired: true,
        deviceName: 'Office PC'
    });

    const updated = agentConfig.get();
    assert(updated.deviceId === testDeviceId, 'agentConfig correctly persists deviceId');
    assert(updated.deviceToken === testToken, 'agentConfig correctly persists deviceToken');
    assert(agentConfig.isPaired() === true, 'agentConfig.isPaired() returns true when credentials exist');

    // Test 3: Cleanup test config
    const testConfigPath = path.join(__dirname, '..', 'agent.config.json');
    if (fs.existsSync(testConfigPath)) {
        fs.unlinkSync(testConfigPath);
    }
    assert(!fs.existsSync(testConfigPath), 'Test agent.config.json cleaned up');

    console.log('\n========================================');
    if (failed === 0) {
        console.log(`🎉 ALL ${passed} AGENT TESTS PASSED!`);
        process.exit(0);
    } else {
        console.error(`❌ ${failed} test(s) failed.`);
        process.exit(1);
    }

} catch (err) {
    console.error('Test error:', err);
    process.exit(1);
}
