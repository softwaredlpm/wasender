const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { error } = require('../utils/response');

// In-memory device store for isolated unit tests when database is mock/offline
const mockDeviceStore = new Map();

/**
 * Agent Authentication Middleware
 * Authenticates requests coming from customer Windows Agents using device ID and device token.
 */
async function authenticateAgent(req, res, next) {
    try {
        const deviceId = req.headers['x-device-id'] || req.body?.deviceId;
        const deviceToken = req.headers['x-device-token'] || req.headers.authorization?.replace('Bearer ', '').trim();

        if (!deviceId || !deviceToken) {
            return error(res, 'Agent credentials missing. Provide X-Device-Id and X-Device-Token.', 401);
        }

        // Validate deviceId UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(deviceId)) {
            return error(res, 'Invalid device identifier format.', 400);
        }

        let device;

        // Check mock store first if in test mode
        if (mockDeviceStore.has(deviceId)) {
            device = mockDeviceStore.get(deviceId);
        } else if (isConfigured()) {
            // Fetch device from Supabase
            const { data, error: dbErr } = await supabaseAdmin
                .from('devices')
                .select('id, tenant_id, device_name, agent_token_hash, status, last_seen')
                .eq('id', deviceId)
                .single();

            if (dbErr || !data) {
                return error(res, 'Device not found or not registered.', 401);
            }
            device = data;
        } else {
            return error(res, 'Device not found or not registered.', 401);
        }

        if (device.status === 'REVOKED') {
            return error(res, 'Device access has been revoked by tenant administrator.', 403);
        }

        // Hash incoming token and verify against stored hash
        const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');

        if (tokenHash !== device.agent_token_hash) {
            return error(res, 'Invalid agent authentication token.', 401);
        }

        // Update last_seen and status
        if (mockDeviceStore.has(deviceId)) {
            device.last_seen = new Date().toISOString();
            device.status = 'ONLINE';
        } else if (isConfigured()) {
            supabaseAdmin
                .from('devices')
                .update({
                    last_seen: new Date().toISOString(),
                    status: 'ONLINE'
                })
                .eq('id', deviceId)
                .then(() => {})
                .catch(() => {});
        }

        req.device = {
            id: device.id,
            tenant_id: device.tenant_id,
            name: device.device_name
        };

        next();
    } catch (err) {
        console.error('Agent authentication error:', err);
        return error(res, 'Internal error verifying agent authentication.', 500);
    }
}

module.exports = {
    authenticateAgent,
    mockDeviceStore
};
