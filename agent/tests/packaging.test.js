/**
 * Phase 16 Automated Test Suite: Windows Agent Packaging & Deployment
 * Verifies:
 * 1. Config resolution & AppData/portable paths
 * 2. Asset bundling & busy_db_bridge.ps1 extraction
 * 3. CLI argument execution (--help, --status, --unpair)
 * 4. Package.json pkg metadata & axios ESM compatibility invariant
 * 5. Windows service automation scripts (.bat) integrity
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
    console.log('📦 Starting Phase 16 Test Suite: Windows Agent Packaging & Deployment\n');
    const state = { passed: 0, failed: 0 };
    const agentDir = path.join(__dirname, '..');

    try {
        // --- 1. CONFIG RESOLUTION & PERSISTENCE ---
        console.log('--- 1. Testing Config Resolution & Portability ---');
        const agentConfig = require('../src/config');
        const { resolveConfigFile } = require('../src/config');

        const initialConfig = agentConfig.get();
        assert(Boolean(initialConfig), 'AgentConfigManager loads initial config object', state);
        assert(typeof agentConfig.getConfigFilePath() === 'string', 'getConfigFilePath returns string path', state);

        // Test resolveConfigFile in dev mode
        const devPath = resolveConfigFile();
        assert(devPath.endsWith('agent.config.json'), 'Dev config path resolves to agent.config.json', state);

        // Test resolveConfigFile in simulated pkg mode
        const originalPkg = process.pkg;
        process.pkg = true;
        const originalExecPath = process.execPath;
        process.execPath = path.join(agentDir, 'dist', 'WASENDER-Agent.exe');

        try {
            const pkgResolved = resolveConfigFile();
            assert(pkgResolved.endsWith('agent.config.json'), 'Packaged resolveConfigFile produces valid path', state);
        } finally {
            process.pkg = originalPkg;
            process.execPath = originalExecPath;
        }

        // Test unpair()
        agentConfig.unpair();
        assert(agentConfig.isPaired() === false, 'unpair() sets isPaired to false', state);
        assert(agentConfig.get().deviceId === null, 'unpair() clears deviceId', state);

        // --- 2. ASSET RESOLUTION & SCRIPT EXTRACTION ---
        console.log('\n--- 2. Testing Asset Resolution & BUSY Bridge Extraction ---');
        const busyBridge = require('../src/busy/busyBridge');

        assert(fs.existsSync(busyBridge.psBridgePath), 'busy_db_bridge.ps1 exists and is resolved', state);
        assert(busyBridge.psBridgePath.endsWith('busy_db_bridge.ps1'), 'Bridge path points to PowerShell script', state);
        assert(fs.existsSync(busyBridge.configPath), 'busy_config.json exists and is resolved', state);

        const firms = busyBridge.listFirms();
        assert(Array.isArray(firms), 'listFirms returns an array without crashing', state);

        // Verify script content contains ADODB COM object
        const psContent = fs.readFileSync(busyBridge.psBridgePath, 'utf8');
        assert(psContent.includes('ADODB.Connection'), 'busy_db_bridge.ps1 contains ADODB connection logic', state);
        assert(psContent.includes('param('), 'busy_db_bridge.ps1 declares standard parameter block', state);

        // --- 3. CLI ARGUMENT PROCESSING ---
        console.log('\n--- 3. Testing CLI Arguments (--help, --status) ---');

        // Test --help
        const helpRun = spawnSync(process.execPath, [path.join(agentDir, 'src', 'index.js'), '--help'], {
            encoding: 'utf8'
        });
        assert(helpRun.status === 0, 'node src/index.js --help exits with code 0', state);
        assert(helpRun.stdout.includes('Usage: WASENDER-Agent.exe'), 'Help output shows usage instructions', state);
        assert(helpRun.stdout.includes('--pair'), 'Help output mentions --pair flag', state);
        assert(helpRun.stdout.includes('--status'), 'Help output mentions --status flag', state);

        // Test --status
        const statusRun = spawnSync(process.execPath, [path.join(agentDir, 'src', 'index.js'), '--status'], {
            encoding: 'utf8'
        });
        assert(statusRun.status === 0, 'node src/index.js --status exits with code 0', state);
        assert(statusRun.stdout.includes('Agent Configuration & Diagnostics:'), 'Status output includes diagnostics header', state);
        assert(statusRun.stdout.includes('BUSY Bridge:'), 'Status output displays BUSY Bridge path', state);

        // --- 4. PACKAGE METADATA & AXIOS INVARIANT ---
        console.log('\n--- 4. Testing Package Configuration & Dependency Invariant ---');
        const pkgJson = JSON.parse(fs.readFileSync(path.join(agentDir, 'package.json'), 'utf8'));

        assert(pkgJson.bin === 'src/index.js', 'package.json specifies bin: src/index.js', state);
        assert(Boolean(pkgJson.pkg), 'package.json declares pkg configuration block', state);
        assert(pkgJson.pkg.targets?.includes('node18-win-x64'), 'pkg target is configured for node18-win-x64', state);
        assert(pkgJson.pkg.assets?.includes('busy_db_bridge.ps1'), 'pkg assets includes busy_db_bridge.ps1', state);
        assert(pkgJson.pkg.assets?.includes('busy_config.json'), 'pkg assets includes busy_config.json', state);

        // CRITICAL INVARIANT: axios MUST be 0.27.2 to avoid ESM/pkg breakages
        assert(pkgJson.dependencies?.axios === '0.27.2', 'CRITICAL: axios is pinned to 0.27.2 for pkg ESM compatibility', state);

        // --- 5. WINDOWS BATCH SCRIPTS INTEGRITY ---
        console.log('\n--- 5. Testing Windows Batch Scripts Integrity ---');
        const scriptsDir = path.join(agentDir, 'scripts');

        const batFiles = ['start-agent.bat', 'install-service.bat', 'uninstall-service.bat', 'pair-agent.bat'];
        for (const f of batFiles) {
            const p = path.join(scriptsDir, f);
            assert(fs.existsSync(p), `Script scripts/${f} exists`, state);
            const content = fs.readFileSync(p, 'utf8');
            assert(content.length > 50, `Script scripts/${f} has valid content (${content.length} bytes)`, state);
        }

        const installContent = fs.readFileSync(path.join(scriptsDir, 'install-service.bat'), 'utf8');
        assert(installContent.includes('schtasks /create'), 'install-service.bat utilizes Windows Task Scheduler (schtasks)', state);
        assert(installContent.includes('WASENDER-Agent'), 'install-service.bat specifies WASENDER-Agent task name', state);

        // --- 6. STANDALONE EXECUTABLE VERIFICATION ---
        console.log('\n--- 6. Testing Packaged WASENDER-Agent.exe Executable Directly ---');
        const exePath = path.join(agentDir, 'dist', 'WASENDER-Agent.exe');

        if (fs.existsSync(exePath)) {
            const stats = fs.statSync(exePath);
            assert(stats.size > 20 * 1024 * 1024, `Executable size is valid (${Math.round(stats.size / 1024 / 1024)}MB self-contained binary)`, state);

            const exeHelp = spawnSync(exePath, ['--help'], { encoding: 'utf8' });
            assert(exeHelp.status === 0, 'WASENDER-Agent.exe --help runs natively with code 0', state);
            assert(exeHelp.stdout.includes('Usage: WASENDER-Agent.exe'), 'Packaged binary output contains CLI usage guide', state);

            const exeStatus = spawnSync(exePath, ['--status'], { encoding: 'utf8' });
            assert(exeStatus.status === 0, 'WASENDER-Agent.exe --status executes natively with code 0', state);
            assert(exeStatus.stdout.includes('Agent Configuration & Diagnostics:'), 'Packaged binary outputs configuration and BUSY diagnostics', state);
        } else {
            console.log('  ⚠️ Packaged executable not found at dist/WASENDER-Agent.exe (skipping direct binary test)');
        }

    } catch (err) {
        console.error('💥 Test execution error:', err);
        state.failed++;
    }

    console.log('\n========================================');
    console.log(`Test Results: ${state.passed} Passed, ${state.failed} Failed`);
    console.log('========================================\n');

    if (state.failed > 0) {
        process.exit(1);
    } else {
        console.log('🎉 ALL PACKAGING TESTS PASSED!');
        process.exit(0);
    }
}

if (require.main === module) {
    runTests();
}

module.exports = { runTests };
