/**
 * Phase 17 Automated Test Suite: Production Deployment Setup
 * Validates:
 * 1. Vercel deployment configuration & security headers
 * 2. Containerized Dockerfile & docker-compose orchestration
 * 3. PM2 production ecosystem clustering & memory limits
 * 4. Linux systemd service unit definition
 * 5. Nginx reverse proxy configuration & persistent WebSocket upgrades
 * 6. Pre-flight environment diagnostics script
 * 7. Supabase migration runner & schema validation
 */

const fs = require('fs');
const path = require('path');

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
    console.log('🚀 Starting Phase 17 Test Suite: Production Deployment Setup\n');
    const state = { passed: 0, failed: 0 };
    const rootDir = path.join(__dirname, '..', '..');
    const serverDir = path.join(__dirname, '..');

    try {
        // --- 1. VERCEL FRONTEND DEPLOYMENT CONFIGURATION ---
        console.log('--- 1. Testing Vercel Frontend Deployment (vercel.json) ---');
        const vercelPath = path.join(rootDir, 'vercel.json');
        assert(fs.existsSync(vercelPath), 'vercel.json exists at project root', state);

        const vercelJson = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
        assert(vercelJson.outputDirectory === 'server/public', 'outputDirectory targets server/public static assets', state);
        assert(vercelJson.cleanUrls === true, 'cleanUrls enabled for modern SEO URLs', state);

        const securityHeaderEntry = vercelJson.headers?.find(h => h.source === '/(.*)');
        assert(Boolean(securityHeaderEntry), 'Global security headers declared in vercel.json', state);

        const headerMap = new Map((securityHeaderEntry?.headers || []).map(h => [h.key.toLowerCase(), h.value]));
        assert(headerMap.get('x-frame-options') === 'DENY', 'X-Frame-Options set to DENY', state);
        assert(headerMap.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options set to nosniff', state);
        assert(headerMap.get('strict-transport-security')?.includes('max-age=31536000'), 'HSTS header configured for 1 year', state);

        const dashboardRewrite = vercelJson.rewrites?.find(r => r.source === '/dashboard');
        assert(dashboardRewrite?.destination === '/index.html', 'Rewrites map /dashboard to /index.html', state);

        // --- 2. CONTAINERIZED DEPLOYMENT (DOCKER) ---
        console.log('\n--- 2. Testing Containerized Docker Deployment ---');
        const dockerfilePath = path.join(serverDir, 'Dockerfile');
        assert(fs.existsSync(dockerfilePath), 'server/Dockerfile exists', state);

        const dockerContent = fs.readFileSync(dockerfilePath, 'utf8');
        assert(dockerContent.includes('FROM node:20-alpine'), 'Dockerfile utilizes secure node:20-alpine base image', state);
        assert(dockerContent.includes('ENV NODE_ENV=production'), 'Dockerfile explicitly enforces NODE_ENV=production', state);
        assert(dockerContent.includes('USER node'), 'Runs container as non-root user (node)', state);
        assert(dockerContent.includes('HEALTHCHECK'), 'Dockerfile defines container HEALTHCHECK directive', state);
        assert(dockerContent.includes('EXPOSE 5001'), 'Exposes port 5001 for VPS Cloud API', state);
        assert(dockerContent.includes('npm ci --omit=dev'), 'Installs strictly production dependencies', state);

        const composePath = path.join(rootDir, 'docker-compose.yml');
        assert(fs.existsSync(composePath), 'docker-compose.yml exists at project root', state);

        const composeContent = fs.readFileSync(composePath, 'utf8');
        assert(composeContent.includes('wasender-api:'), 'docker-compose declares wasender-api service', state);
        assert(composeContent.includes('"5001:5001"'), 'Port 5001 mapped to host', state);
        assert(composeContent.includes('restart: always'), 'Configures restart: always policy', state);
        assert(composeContent.includes('max-size: "50m"'), 'Log rotation configured with 50MB max-size', state);

        // --- 3. PROCESS MANAGER (PM2 CLUSTERING) ---
        console.log('\n--- 3. Testing PM2 Process Manager Configuration ---');
        const pm2ConfigPath = path.join(serverDir, 'ecosystem.config.js');
        assert(fs.existsSync(pm2ConfigPath), 'server/ecosystem.config.js exists', state);

        const pm2Config = require(pm2ConfigPath);
        const mainApp = pm2Config.apps?.[0];
        assert(mainApp?.name === 'wasender-api', 'PM2 config defines wasender-api app', state);
        assert(mainApp?.exec_mode === 'cluster', 'exec_mode is cluster for multi-core scaling', state);
        assert(mainApp?.max_memory_restart === '500M', 'Automatic restart threshold set at 500MB', state);
        assert(mainApp?.env_production?.NODE_ENV === 'production', 'env_production sets NODE_ENV=production', state);
        assert(mainApp?.env_production?.PORT === 5001, 'env_production specifies PORT=5001', state);

        // --- 4. SYSTEMD SERVICE CONFIGURATION ---
        console.log('\n--- 4. Testing Systemd Linux Service Unit ---');
        const servicePath = path.join(serverDir, 'deploy', 'wasender-api.service');
        assert(fs.existsSync(servicePath), 'server/deploy/wasender-api.service exists', state);

        const serviceContent = fs.readFileSync(servicePath, 'utf8');
        assert(serviceContent.includes('[Unit]') && serviceContent.includes('[Service]') && serviceContent.includes('[Install]'), 'Systemd file has standard INI structure', state);
        assert(serviceContent.includes('ExecStart=/usr/bin/node src/index.js'), 'ExecStart launches Node with src/index.js', state);
        assert(serviceContent.includes('Restart=always'), 'Restart=always configured for fault-tolerance', state);
        assert(serviceContent.includes('ProtectSystem=full'), 'Security sandbox ProtectSystem=full enabled', state);
        assert(serviceContent.includes('LimitNOFILE=65535'), 'Open file descriptors limit raised for WebSocket concurrency', state);

        // --- 5. NGINX REVERSE PROXY & WEBSOCKET UPGRADES ---
        console.log('\n--- 5. Testing Nginx Reverse Proxy Configuration ---');
        const nginxPath = path.join(serverDir, 'deploy', 'nginx.conf');
        assert(fs.existsSync(nginxPath), 'server/deploy/nginx.conf exists', state);

        const nginxContent = fs.readFileSync(nginxPath, 'utf8');
        assert(nginxContent.includes('upstream wasender_backend'), 'Nginx defines upstream backend pool', state);
        assert(nginxContent.includes('127.0.0.1:5001'), 'Upstream directs to local port 5001', state);
        assert(nginxContent.includes('return 301 https://$host$request_uri;'), 'Enforces HTTP to HTTPS 301 redirection', state);
        assert(nginxContent.includes('client_max_body_size 50M;'), 'client_max_body_size configured to 50MB for attachments', state);

        // Verify WebSocket upgrade blocks
        assert(nginxContent.includes('location /agent/ws'), 'Nginx declares /agent/ws location block', state);
        assert(nginxContent.includes('location /browser/ws'), 'Nginx declares /browser/ws location block', state);
        assert(nginxContent.includes('proxy_set_header Upgrade $http_upgrade;'), 'WebSocket Upgrade header forwarding configured', state);
        assert(nginxContent.includes('proxy_read_timeout 86400s;'), 'Long-lived timeout (86400s / 24h) set for Windows Agent WebSocket', state);

        // --- 6. PRE-FLIGHT ENVIRONMENT DIAGNOSTICS ---
        console.log('\n--- 6. Testing Pre-Flight Environment Validator ---');
        const { validateEnv } = require(path.join(rootDir, 'scripts', 'verify-production-env'));

        // Test 6A: Missing environment variables
        const emptyCheck = validateEnv({});
        assert(emptyCheck.valid === false, 'validateEnv detects empty environment as invalid', state);
        assert(emptyCheck.errors.length >= 6, 'Detects all missing mandatory variables', state);

        // Test 6B: Invalid format
        const badFormatCheck = validateEnv({
            SUPABASE_URL: 'not-a-valid-url',
            SUPABASE_SERVICE_ROLE_KEY: 'short',
            PORT: '999999',
            JWT_SECRET: 'short',
            RAZORPAY_KEY_ID: 'invalid_prefix',
            RAZORPAY_KEY_SECRET: 'short'
        });
        assert(badFormatCheck.valid === false, 'validateEnv detects invalid formats', state);

        // Test 6C: Complete valid production configuration
        const validCheck = validateEnv({
            SUPABASE_URL: 'https://xyzcompany.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-long-valid-service-key-12345678',
            PORT: '5001',
            JWT_SECRET: 'super-secure-production-jwt-secret-32-chars-long',
            RAZORPAY_KEY_ID: 'rzp_live_abc123def456',
            RAZORPAY_KEY_SECRET: 'secret_key_123456'
        });
        assert(validCheck.valid === true, 'validateEnv confirms valid production configuration', state);
        assert(validCheck.errors.length === 0, 'Zero errors reported for valid configuration', state);

        // --- 7. PRODUCTION MIGRATIONS VERIFICATION ---
        console.log('\n--- 7. Testing Supabase Production Migration Runner ---');
        const { loadMigrations, validateMigrationSchema } = require(path.join(rootDir, 'scripts', 'run-production-migrations'));

        const migrations = loadMigrations();
        assert(migrations.length >= 1, `loadMigrations finds ${migrations.length} migration file(s)`, state);

        const schemaResult = validateMigrationSchema(migrations);
        assert(schemaResult.foundTables.length === 18, `All 18 core SaaS tables confirmed (${schemaResult.foundTables.length}/18)`, state);
        assert(schemaResult.missingTables.length === 0, 'No missing tables in production schema', state);
        assert(schemaResult.rlsCount === 18, 'RLS enabled on all 18 tables', state);
        assert(schemaResult.hasDefinerFunction === true, 'Zero-recursion security definer helper functions present', state);
        assert(schemaResult.hasSeedPlans === true, 'Seeded subscription plans present in migration', state);
        assert(schemaResult.isValid === true, 'Overall production schema migration is 100% valid', state);

    } catch (err) {
        console.error('💥 Test suite fatal error:', err);
        state.failed++;
    }

    console.log('\n========================================');
    console.log(`Test Results: ${state.passed} Passed, ${state.failed} Failed`);
    console.log('========================================\n');

    if (state.failed > 0) {
        process.exit(1);
    } else {
        console.log('🎉 ALL PRODUCTION DEPLOYMENT TESTS PASSED!');
        process.exit(0);
    }
}

if (require.main === module) {
    runTests();
}

module.exports = { runTests };
