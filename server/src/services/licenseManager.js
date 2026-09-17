const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');

const LICENSE_SALT = process.env.LICENSE_SECRET_SALT || 'whatsapp-client-license-salt-2024';

// In-memory mock store for unit testing & sandbox offline mode
const mockLicenseStore = new Map(); // tenantId -> licenseObject

class LicenseManager {
    /**
     * Generates a cryptographically signed license key.
     * Format: WAS-[TIER]-[YYYYMMDD]-[SALT_HEX]-[SIG_HEX]
     */
    generateKey(options = {}) {
        const {
            tenantId = 'standalone',
            tier = 'ENTERPRISE',
            durationDays = 365
        } = options;

        const tierCode = (tier || 'STANDARD').substring(0, 3).toUpperCase();
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + durationDays);

        const yyyy = expiryDate.getFullYear();
        const mm = String(expiryDate.getMonth() + 1).padStart(2, '0');
        const dd = String(expiryDate.getDate()).padStart(2, '0');
        const expiryStr = `${yyyy}${mm}${dd}`;

        const nonce = crypto.randomBytes(2).toString('hex').toUpperCase();

        const payloadToSign = `${tierCode}:${expiryStr}:${nonce}:${tenantId}`;
        const signature = crypto
            .createHmac('sha256', LICENSE_SALT)
            .update(payloadToSign)
            .digest('hex')
            .substring(0, 6)
            .toUpperCase();

        const licenseKey = `WAS-${tierCode}-${expiryStr}-${nonce}-${signature}`;

        const licenseRecord = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            license_key: licenseKey,
            tier: tier.toUpperCase(),
            status: 'ACTIVE',
            expires_at: expiryDate.toISOString(),
            created_at: new Date().toISOString()
        };

        if (isConfigured()) {
            supabaseAdmin
                .from('licenses')
                .insert(licenseRecord)
                .then(() => {})
                .catch(err => console.error('[LicenseManager] DB insert error:', err.message));
        }

        mockLicenseStore.set(tenantId, licenseRecord);

        return {
            licenseKey,
            tier: licenseRecord.tier,
            expiresAt: licenseRecord.expires_at
        };
    }

    /**
     * Validates a license key's cryptographic signature and expiration
     */
    validateKey(licenseKey, tenantId = null) {
        if (!licenseKey || typeof licenseKey !== 'string') {
            return { valid: false, error: 'License key is missing or invalid format.' };
        }

        const parts = licenseKey.trim().split('-');
        if (parts.length !== 5 || parts[0] !== 'WAS') {
            return { valid: false, error: 'Invalid license key structure.' };
        }

        const [prefix, tierCode, expiryStr, nonce, signature] = parts;

        // Verify expiration date
        if (!/^\d{8}$/.test(expiryStr)) {
            return { valid: false, error: 'Invalid license date stamp.' };
        }

        const yyyy = parseInt(expiryStr.substring(0, 4));
        const mm = parseInt(expiryStr.substring(4, 6)) - 1;
        const dd = parseInt(expiryStr.substring(6, 8));
        const expiryDate = new Date(Date.UTC(yyyy, mm, dd, 23, 59, 59));

        if (Date.now() > expiryDate.getTime()) {
            return { valid: false, error: `License key expired on ${expiryDate.toISOString().split('T')[0]}.` };
        }

        // Verify cryptographic signature (try matching both with tenantId and 'standalone')
        const candidateTenants = tenantId ? [tenantId, 'standalone'] : ['standalone'];
        let signatureValid = false;

        for (const tId of candidateTenants) {
            const payload = `${tierCode}:${expiryStr}:${nonce}:${tId}`;
            const expectedSig = crypto
                .createHmac('sha256', LICENSE_SALT)
                .update(payload)
                .digest('hex')
                .substring(0, 6)
                .toUpperCase();

            if (expectedSig === signature.toUpperCase()) {
                signatureValid = true;
                break;
            }
        }

        if (!signatureValid) {
            return { valid: false, error: 'Cryptographic signature mismatch. Key may be invalid or tampered.' };
        }

        const tierMap = {
            'ENT': 'ENTERPRISE',
            'PRO': 'PROFESSIONAL',
            'GRO': 'GROWTH',
            'STA': 'STARTER'
        };

        return {
            valid: true,
            tier: tierMap[tierCode] || 'STANDARD',
            expiresAt: expiryDate.toISOString()
        };
    }

    /**
     * Activates a license key for a tenant
     */
    async activateLicense(tenantId, licenseKey) {
        const validation = this.validateKey(licenseKey, tenantId);
        if (!validation.valid) {
            return validation;
        }

        const record = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            license_key: licenseKey,
            tier: validation.tier,
            status: 'ACTIVE',
            expires_at: validation.expiresAt,
            created_at: new Date().toISOString()
        };

        if (isConfigured()) {
            await supabaseAdmin
                .from('licenses')
                .upsert(record, { onConflict: 'license_key' });
        }

        mockLicenseStore.set(tenantId, record);

        return {
            valid: true,
            status: 'ACTIVATED',
            tier: record.tier,
            expiresAt: record.expires_at,
            licenseKey
        };
    }

    /**
     * Retrieves active license for tenant
     */
    async getActiveLicense(tenantId) {
        if (isConfigured()) {
            const { data } = await supabaseAdmin
                .from('licenses')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('status', 'ACTIVE')
                .gt('expires_at', new Date().toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (data) return data;
        }

        const mock = mockLicenseStore.get(tenantId);
        if (mock && new Date(mock.expires_at) > new Date()) {
            return mock;
        }
        return null;
    }
}

module.exports = {
    licenseManager: new LicenseManager(),
    mockLicenseStore
};
