const antiBan = require('../src/whatsapp/antiBan');

console.log('🧪 Starting WhatsApp Anti-Ban Algorithm Tests...\n');

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
    // Test 1: Zero-width space randomization
    const sampleText = 'Dear Customer, your invoice is ready.';
    const randomized1 = antiBan.randomizeText(sampleText);
    const randomized2 = antiBan.randomizeText(sampleText);

    assert(randomized1.includes('\u200B'), 'randomizeText successfully injects zero-width space (\\u200B)');
    assert(randomized1.replace(/\u200B/g, '') === sampleText, 'Visible text content is 100% preserved without character distortion');
    assert(randomized1.length === sampleText.length + 1, 'Injected exactly one zero-width space');

    // Test 2: Mobile number formatting
    assert(antiBan.formatMobileNumber('9876543210') === '919876543210', '10-digit phone automatically prepended with country code 91');
    assert(antiBan.formatMobileNumber('919876543210') === '919876543210', '12-digit phone starting with 91 preserved');
    assert(antiBan.formatMobileNumber('+91 98765-43210') === '919876543210', 'Strips spaces, dashes, and plus signs correctly');
    assert(antiBan.formatMobileNumber('123') === null, 'Invalid short number rejected (returns null)');
    assert(antiBan.formatMobileNumber('') === null, 'Empty string rejected (returns null)');

    // Test 3: Jitter delay
    const delay = antiBan.getJitterDelay(8000, 10000);
    assert(delay >= 8000 && delay <= 10000, `getJitterDelay returns value within safe window: ${delay}ms`);

    console.log('\n========================================');
    if (failed === 0) {
        console.log(`🎉 ALL ${passed} ANTI-BAN TESTS PASSED!`);
        process.exit(0);
    } else {
        console.error(`❌ ${failed} test(s) failed.`);
        process.exit(1);
    }
} catch (err) {
    console.error('Test error:', err);
    process.exit(1);
}
