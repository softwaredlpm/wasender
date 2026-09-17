const crypto = require('crypto');

// In-memory pairing code registry with 15-minute expiration
const pendingPairings = new Map();

const PAIRING_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function generatePairingCode(tenantId, deviceName = 'Windows PC') {
    // Generate 6-character uppercase alphanumeric code: e.g. "WAS-7842"
    const randomHex = crypto.randomBytes(2).toString('hex').toUpperCase();
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const code = `WAS-${randomHex}${randomNum}`;

    const pairingData = {
        code,
        tenantId,
        deviceName,
        expiresAt: Date.now() + PAIRING_EXPIRY_MS
    };

    pendingPairings.set(code, pairingData);

    // Auto-clean after expiry
    setTimeout(() => {
        pendingPairings.delete(code);
    }, PAIRING_EXPIRY_MS);

    return pairingData;
}

function consumePairingCode(code) {
    if (!code) return null;
    const cleanCode = code.trim().toUpperCase();

    const data = pendingPairings.get(cleanCode);
    if (!data) return null;

    if (Date.now() > data.expiresAt) {
        pendingPairings.delete(cleanCode);
        return null;
    }

    // Single-use code
    pendingPairings.delete(cleanCode);
    return data;
}

module.exports = {
    generatePairingCode,
    consumePairingCode
};
