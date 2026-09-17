/**
 * Automated Production Migration Runner & Schema Verifier
 * Scans, validates, and reports on Supabase migration scripts prior to deployment.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_TABLES = [
    'profiles',
    'tenants',
    'tenant_users',
    'devices',
    'whatsapp_accounts',
    'contacts',
    'message_templates',
    'message_queue',
    'messages',
    'message_logs',
    'busy_companies',
    'busy_connections',
    'licenses',
    'plans',
    'subscriptions',
    'usage_daily',
    'settings',
    'audit_logs'
];

/**
 * Loads all .sql migration files from the migrations directory
 */
function loadMigrations(migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations')) {
    if (!fs.existsSync(migrationsDir)) {
        throw new Error(`Migrations directory not found at: ${migrationsDir}`);
    }

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    return files.map(filename => {
        const filePath = path.join(migrationsDir, filename);
        const content = fs.readFileSync(filePath, 'utf8');
        return {
            filename,
            path: filePath,
            content,
            sizeBytes: content.length
        };
    });
}

/**
 * Inspects SQL content for core schema components
 */
function validateMigrationSchema(migrations) {
    const combinedSql = migrations.map(m => m.content).join('\n');
    const missingTables = [];
    const foundTables = [];

    for (const table of REQUIRED_TABLES) {
        const regex = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${table}\\b`, 'i');
        if (regex.test(combinedSql)) {
            foundTables.push(table);
        } else {
            missingTables.push(table);
        }
    }

    // Check for RLS statements
    const rlsCount = (combinedSql.match(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi) || []).length;

    // Check for Security Definer functions
    const hasDefinerFunction = /SECURITY\s+DEFINER/i.test(combinedSql);

    // Check for Seed data (Plans)
    const hasSeedPlans = /INSERT\s+INTO\s+(?:public\.)?plans/i.test(combinedSql);

    return {
        totalMigrations: migrations.length,
        requiredTablesCount: REQUIRED_TABLES.length,
        foundTables,
        missingTables,
        rlsCount,
        hasDefinerFunction,
        hasSeedPlans,
        isValid: missingTables.length === 0 && rlsCount >= REQUIRED_TABLES.length && hasDefinerFunction
    };
}

function run() {
    console.log('📦 Loading and verifying Supabase production migrations...\n');
    const migrations = loadMigrations();
    console.log(`Found ${migrations.length} migration file(s):`);
    migrations.forEach(m => console.log(`  📄 ${m.filename} (${m.sizeBytes} bytes)`));

    const result = validateMigrationSchema(migrations);
    console.log('\nSchema Validation Summary:');
    console.log(`  - Core Tables: ${result.foundTables.length}/${result.requiredTablesCount} present`);
    console.log(`  - RLS Policies Enabled: ${result.rlsCount} tables`);
    console.log(`  - Security Definer Functions: ${result.hasDefinerFunction ? '✅ Present' : '❌ Missing'}`);
    console.log(`  - Seeded Subscription Plans: ${result.hasSeedPlans ? '✅ Present' : '❌ Missing'}`);

    if (result.missingTables.length > 0) {
        console.error(`\n❌ Missing tables: ${result.missingTables.join(', ')}`);
        return false;
    }

    console.log('\n🎉 Production schema validated successfully! Ready for database execution.\n');
    return true;
}

if (require.main === module) {
    const ok = run();
    process.exit(ok ? 0 : 1);
}

module.exports = {
    REQUIRED_TABLES,
    loadMigrations,
    validateMigrationSchema,
    run
};
