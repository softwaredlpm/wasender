const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext, requireRole } = require('../middleware/tenant');
const { generatePairingCode } = require('../utils/pairingCodeManager');
const { success, error } = require('../utils/response');

// All device management routes require user authentication & tenant context
router.use(authenticateUser);
router.use(requireTenantContext);

/**
 * GET /api/v1/devices
 * Lists all registered Windows devices for the active tenant.
 */
router.get('/', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        const { data: devices, error: dbErr } = await supabaseAdmin
            .from('devices')
            .select(`
                id,
                device_name,
                agent_version,
                status,
                system_info,
                last_seen,
                created_at,
                whatsapp_accounts(id, account_name, phone_number, status, last_seen),
                busy_connections(id, status, last_seen)
            `)
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false });

        if (dbErr) {
            return error(res, dbErr.message, 500);
        }

        // Compute online indicator based on last_seen within 90 seconds
        const now = Date.now();
        const formatted = (devices || []).map(d => {
            const lastSeenMs = d.last_seen ? new Date(d.last_seen).getTime() : 0;
            const isLive = d.status === 'ONLINE' && (now - lastSeenMs < 90000);

            return {
                id: d.id,
                name: d.device_name,
                version: d.agent_version,
                status: d.status === 'REVOKED' ? 'REVOKED' : (isLive ? 'ONLINE' : 'OFFLINE'),
                lastSeen: d.last_seen,
                systemInfo: d.system_info,
                createdAt: d.created_at,
                whatsappAccounts: d.whatsapp_accounts || [],
                busyStatus: d.busy_connections?.[0]?.status || 'DISCONNECTED'
            };
        });

        return success(res, { devices: formatted });

    } catch (err) {
        console.error('List devices error:', err);
        return error(res, 'Failed to fetch devices.', 500);
    }
});

/**
 * POST /api/v1/devices/pairing-code
 * Generates a one-time 15-minute pairing code for connecting a new Windows PC.
 */
router.post('/pairing-code', requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { deviceName = 'Windows PC' } = req.body;

        const pairing = generatePairingCode(tenantId, deviceName);

        return success(res, {
            pairingCode: pairing.code,
            deviceName: pairing.deviceName,
            expiresAt: new Date(pairing.expiresAt).toISOString(),
            expiresInSeconds: Math.round((pairing.expiresAt - Date.now()) / 1000)
        }, 'Pairing code generated. Enter this code on the Windows Agent installer.', 201);

    } catch (err) {
        console.error('Generate pairing code error:', err);
        return error(res, 'Failed to generate device pairing code.', 500);
    }
});

/**
 * PATCH /api/v1/devices/:deviceId
 * Renames a device.
 */
router.patch('/:deviceId', requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const deviceId = req.params.deviceId;
        const { deviceName } = req.body;

        if (!deviceName) {
            return error(res, 'Device name is required.', 400);
        }

        const { data, error: updateErr } = await supabaseAdmin
            .from('devices')
            .update({ device_name: deviceName })
            .eq('id', deviceId)
            .eq('tenant_id', tenantId)
            .select()
            .single();

        if (updateErr) {
            return error(res, updateErr.message, 400);
        }

        return success(res, { device: data }, 'Device renamed successfully.');

    } catch (err) {
        console.error('Rename device error:', err);
        return error(res, 'Failed to update device.', 500);
    }
});

/**
 * POST /api/v1/devices/:deviceId/revoke
 * Revokes device access. The Agent will be instantly barred from making further API or WebSocket calls.
 */
router.post('/:deviceId/revoke', requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const deviceId = req.params.deviceId;

        const { data, error: revokeErr } = await supabaseAdmin
            .from('devices')
            .update({ status: 'REVOKED' })
            .eq('id', deviceId)
            .eq('tenant_id', tenantId)
            .select()
            .single();

        if (revokeErr) {
            return error(res, revokeErr.message, 400);
        }

        // Audit Log
        await supabaseAdmin.from('audit_logs').insert({
            tenant_id: tenantId,
            user_id: req.user.id,
            action: 'DEVICE_REVOKED',
            resource: 'devices',
            details: { deviceId }
        });

        return success(res, { device: data }, 'Device access revoked successfully.');

    } catch (err) {
        console.error('Revoke device error:', err);
        return error(res, 'Failed to revoke device.', 500);
    }
});

/**
 * DELETE /api/v1/devices/:deviceId
 * Permanently deletes a device and unlinks associated WhatsApp accounts.
 */
router.delete('/:deviceId', requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const deviceId = req.params.deviceId;

        const { error: delErr } = await supabaseAdmin
            .from('devices')
            .delete()
            .eq('id', deviceId)
            .eq('tenant_id', tenantId);

        if (delErr) {
            return error(res, delErr.message, 500);
        }

        return success(res, {}, 'Device removed permanently.');

    } catch (err) {
        console.error('Delete device error:', err);
        return error(res, 'Failed to delete device.', 500);
    }
});

module.exports = router;
