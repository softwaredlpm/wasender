const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateAgent, mockDeviceStore } = require('../middleware/agentAuth');
const { consumePairingCode } = require('../utils/pairingCodeManager');
const { success, error } = require('../utils/response');

/**
 * POST /api/v1/agent/register
 * One-time handshake for a new Windows Agent installation using a pairing code.
 * Exchanges pairing code for a permanent, cryptographically secure deviceToken.
 */
router.post('/register', async (req, res) => {
    try {
        const { pairingCode, deviceName, agentVersion, systemInfo } = req.body;

        if (!pairingCode) {
            return error(res, 'Pairing code is required to register device.', 400);
        }

        // Validate and consume one-time pairing code
        const pairing = consumePairingCode(pairingCode);
        if (!pairing) {
            return error(res, 'Invalid or expired pairing code. Please generate a new code from the web dashboard.', 400);
        }

        const effectiveDeviceName = deviceName || pairing.deviceName || 'Windows Workstation';

        // Generate 64-character hex device token
        const deviceToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
        const deviceId = crypto.randomUUID();

        // If in mock/offline test mode, use mock store
        if (!isConfigured()) {
            mockDeviceStore.set(deviceId, {
                id: deviceId,
                tenant_id: pairing.tenantId,
                device_name: effectiveDeviceName,
                agent_version: agentVersion || '1.0.0',
                agent_token_hash: tokenHash,
                status: 'ONLINE',
                system_info: systemInfo || {},
                last_seen: new Date().toISOString()
            });

            return success(res, {
                deviceId,
                tenantId: pairing.tenantId,
                deviceToken,
                deviceName: effectiveDeviceName
            }, 'Device registered successfully (Test Mode).', 201);
        }

        // Production: Create Device in Supabase Database
        const { data: device, error: dbErr } = await supabaseAdmin
            .from('devices')
            .insert({
                id: deviceId,
                tenant_id: pairing.tenantId,
                device_name: effectiveDeviceName,
                agent_version: agentVersion || '1.0.0',
                agent_token_hash: tokenHash,
                status: 'ONLINE',
                system_info: systemInfo || {},
                last_seen: new Date().toISOString()
            })
            .select()
            .single();

        if (dbErr) {
            console.error('Database error registering device:', dbErr);
            return error(res, 'Failed to register device in database.', 500);
        }

        // Audit Log
        await supabaseAdmin.from('audit_logs').insert({
            tenant_id: pairing.tenantId,
            action: 'DEVICE_REGISTERED',
            resource: 'devices',
            details: {
                deviceId: device.id,
                deviceName: effectiveDeviceName,
                agentVersion: agentVersion || '1.0.0'
            }
        });

        console.log(`💻 Device registered: [${effectiveDeviceName}] ID: ${device.id} for Tenant: ${pairing.tenantId}`);

        return success(res, {
            deviceId: device.id,
            tenantId: pairing.tenantId,
            deviceToken: deviceToken, // Sent ONLY ONCE to the agent during registration!
            deviceName: effectiveDeviceName
        }, 'Device registered successfully. Store deviceToken securely in agent.config.json.', 201);

    } catch (err) {
        console.error('Agent registration error:', err);
        return error(res, 'Internal server error during agent registration.', 500);
    }
});

/**
 * POST /api/v1/agent/heartbeat
 * Periodic keepalive ping from the Windows Agent.
 * Reports agent status, WhatsApp connection health, and system resource load.
 */
router.post('/heartbeat', authenticateAgent, async (req, res) => {
    try {
        const { status, systemInfo } = req.body;

        const updates = {
            last_seen: new Date().toISOString(),
            status: status === 'OFFLINE' ? 'OFFLINE' : 'ONLINE'
        };

        if (systemInfo) {
            updates.system_info = systemInfo;
        }

        // If in mock store mode
        if (mockDeviceStore.has(req.device.id)) {
            const dev = mockDeviceStore.get(req.device.id);
            Object.assign(dev, updates);
        } else if (isConfigured()) {
            await supabaseAdmin
                .from('devices')
                .update(updates)
                .eq('id', req.device.id);
        }

        return success(res, {
            acknowledged: true,
            deviceId: req.device.id,
            serverTime: new Date().toISOString()
        }, 'Heartbeat acknowledged.');

    } catch (err) {
        console.error('Heartbeat error:', err);
        return error(res, 'Failed to process agent heartbeat.', 500);
    }
});

/**
 * POST /api/v1/agent/status
 * Detailed diagnostic telemetry sent by the Agent.
 */
router.post('/status', authenticateAgent, async (req, res) => {
    try {
        const { metrics } = req.body;

        if (isConfigured()) {
            await supabaseAdmin
                .from('devices')
                .update({
                    system_info: metrics || {},
                    last_seen: new Date().toISOString()
                })
                .eq('id', req.device.id);
        }

        return success(res, { status: 'recorded' });
    } catch (err) {
        return error(res, 'Failed to record agent telemetry.', 500);
    }
});

module.exports = router;
