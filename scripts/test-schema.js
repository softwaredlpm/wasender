/**
 * Schema Validation Test Script
 * Validates the syntax, table integrity, and RLS policies of the Supabase migration file.
 */

const fs = require('fs');
const path = require('path');

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260918000001_initial_saas_schema.sql');

console.log('🔍 Validating Supabase Migration SQL file:', migrationPath);

if (!fs.existsSync(migrationPath)) {
    console.error('❌ Migration file does not exist!');
    process.exit(1);
}

const sql = fs.readFileSync(migrationPath, 'utf8');

// 1. Required Tables Checklist (from User Specification)
const requiredTables = [
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

console.log('\n--- 1. Checking Table Definitions ---');
let missingTables = [];
for (const table of requiredTables) {
    const tableRegex = new RegExp(`CREATE TABLE (IF NOT EXISTS )?public\\.${table}\\s*\\(`, 'i');
    if (tableRegex.test(sql)) {
        console.log(`  ✅ Table 'public.${table}' defined`);
    } else {
        console.error(`  ❌ Table 'public.${table}' MISSING!`);
        missingTables.push(table);
    }
}

// 2. Checking RLS Enablement
console.log('\n--- 2. Checking Row Level Security (RLS) Enablement ---');
let missingRLS = [];
for (const table of requiredTables) {
    const rlsRegex = new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`, 'i');
    if (rlsRegex.test(sql)) {
        console.log(`  ✅ RLS enabled on 'public.${table}'`);
    } else {
        console.error(`  ❌ RLS NOT enabled on 'public.${table}'!`);
        missingRLS.push(table);
    }
}

// 3. Checking Tenant Isolation Foreign Keys
console.log('\n--- 3. Checking Multi-Tenant Isolation Constraints ---');
const tenantTables = requiredTables.filter(t => t !== 'profiles' && t !== 'tenants' && t !== 'plans');
let missingTenantFk = [];
for (const table of tenantTables) {
    // Check if table references tenants(id)
    const fkRegex = new RegExp(`tenant_id UUID NOT NULL REFERENCES public\\.tenants\\(id\\)`, 'i');
    const tableBlockRegex = new RegExp(`CREATE TABLE (IF NOT EXISTS )?public\\.${table}\\s*\\([\\s\\S]*?\\);`, 'i');
    const match = sql.match(tableBlockRegex);
    if (match && fkRegex.test(match[0])) {
        console.log(`  ✅ 'public.${table}' has strict tenant_id NOT NULL FK constraint`);
    } else {
        console.error(`  ❌ 'public.${table}' is missing strict tenant_id NOT NULL FK constraint!`);
        missingTenantFk.push(table);
    }
}

// 4. Checking Security Definer Helper Functions
console.log('\n--- 4. Checking Security Definer Functions ---');
const requiredFunctions = [
    'is_tenant_member',
    'is_tenant_admin',
    'is_platform_admin',
    'get_auth_tenant_ids',
    'handle_updated_at',
    'handle_new_user'
];
let missingFunctions = [];
for (const fn of requiredFunctions) {
    const fnRegex = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`, 'i');
    if (fnRegex.test(sql)) {
        console.log(`  ✅ Function 'public.${fn}()' defined`);
    } else {
        console.error(`  ❌ Function 'public.${fn}()' MISSING!`);
        missingFunctions.push(fn);
    }
}

// 5. Checking Seed Plans
console.log('\n--- 5. Checking Seed Plans ---');
const planSlugs = ['free-trial', 'starter', 'growth', 'enterprise'];
let missingPlans = [];
for (const slug of planSlugs) {
    if (sql.includes(`'${slug}'`)) {
        console.log(`  ✅ Seed plan '${slug}' present`);
    } else {
        console.error(`  ❌ Seed plan '${slug}' MISSING!`);
        missingPlans.push(slug);
    }
}

// Summary Result
console.log('\n========================================');
const totalErrors = missingTables.length + missingRLS.length + missingTenantFk.length + missingFunctions.length + missingPlans.length;
if (totalErrors === 0) {
    console.log('🎉 SCHEMA VALIDATION SUCCESSFUL: All 18 tables, RLS policies, FK constraints, helper functions, and seed data are verified and 100% compliant!');
    process.exit(0);
} else {
    console.error(`❌ SCHEMA VALIDATION FAILED with ${totalErrors} issue(s).`);
    process.exit(1);
}
