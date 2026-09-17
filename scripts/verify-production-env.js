/**
 * Production Environment Verification & Pre-flight Diagnostics
 * Verifies that all mandatory environment variables are populated and correctly formatted
 * prior to deployment on Vercel, Docker, or Linux VPS.
 */

const REQUIRED_VARS = [
    {
        name: 'SUPABASE_URL',
        description: 'Supabase Project HTTPS URL',
        validate: (val) => Boolean(val && (val.startsWith('https://') || val.startsWith('http://')))
    },
    {
        name: 'SUPABASE_SERVICE_ROLE_KEY',
        description: 'Supabase Admin Service Role Secret Key (Server Only)',
        validate: (val) => Boolean(val && val.length > 20)
    },
    {
        name: 'PORT',
        description: 'Cloud VPS API Server Listen Port',
        validate: (val) => {
            const p = parseInt(val || '5001');
            return !isNaN(p) && p > 0 && p <= 65535;
        }
    },
    {
        name: 'JWT_SECRET',
        description: 'Session Token Signing Key',
        validate: (val) => Boolean(val && val.length >= 16)
    },
    {
        name: 'RAZORPAY_KEY_ID',
        description: 'Razorpay Payment Gateway Key ID',
        validate: (val) => Boolean(val && val.startsWith('rzp_'))
    },
    {
        name: 'RAZORPAY_KEY_SECRET',
        description: 'Razorpay Payment Gateway API Secret',
        validate: (val) => Boolean(val && val.length >= 8)
    }
];

const OPTIONAL_VARS = [
    { name: 'CORS_ORIGIN', description: 'Allowed Frontend Domains for CORS' },
    { name: 'R2_BUCKET_NAME', description: 'Cloudflare R2 Bucket for Permanent Media' },
    { name: 'R2_PUBLIC_DOMAIN', description: 'Cloudflare R2 Public CDN Domain' }
];

/**
 * Validates a map of environment variables
 * @param {Object} envMap
 * @returns {{ valid: boolean, errors: string[], warnings: string[], results: Object[] }}
 */
function validateEnv(envMap = process.env) {
    const errors = [];
    const warnings = [];
    const results = [];

    for (const item of REQUIRED_VARS) {
        const val = envMap[item.name];
        if (!val) {
            errors.push(`Missing mandatory variable: ${item.name} (${item.description})`);
            results.push({ name: item.name, status: 'MISSING', required: true });
        } else if (!item.validate(val)) {
            errors.push(`Invalid format for: ${item.name} (${item.description})`);
            results.push({ name: item.name, status: 'INVALID', required: true });
        } else {
            results.push({ name: item.name, status: 'OK', required: true });
        }
    }

    for (const item of OPTIONAL_VARS) {
        const val = envMap[item.name];
        if (!val) {
            warnings.push(`Optional variable not set: ${item.name} (${item.description})`);
            results.push({ name: item.name, status: 'UNSET', required: false });
        } else {
            results.push({ name: item.name, status: 'OK', required: false });
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        results
    };
}

function runPreflight() {
    console.log('🔍 Running WASENDER SaaS Pre-Flight Environment Verification...\n');
    const { valid, errors, warnings, results } = validateEnv(process.env);

    results.forEach(r => {
        const badge = r.status === 'OK' ? '✅' : (r.required ? '❌' : '⚠️');
        console.log(`  ${badge} [${r.status.padEnd(7)}] ${r.name}`);
    });

    console.log('\n------------------------------------------------------------');
    if (warnings.length > 0) {
        console.log(`\nNotices (${warnings.length}):`);
        warnings.forEach(w => console.log(`  ℹ️  ${w}`));
    }

    if (!valid) {
        console.error(`\n❌ Pre-flight check failed with ${errors.length} error(s):`);
        errors.forEach(e => console.error(`  - ${e}`));
        console.error('\nPlease populate your production .env or container environment before deploying.\n');
        return false;
    }

    console.log('\n🎉 Pre-flight check passed! Environment is ready for production deployment.\n');
    return true;
}

if (require.main === module) {
    const success = runPreflight();
    process.exit(success ? 0 : 1);
}

module.exports = {
    validateEnv,
    runPreflight,
    REQUIRED_VARS,
    OPTIONAL_VARS
};
