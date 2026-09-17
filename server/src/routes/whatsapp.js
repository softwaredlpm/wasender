const express = require('express');
const router = express.Router();
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext, requireRole } = require('../middleware/tenant');
const wsHub = require('../websocket/hub');
const { success, error } = require('../utils/response');

router.use(authenticateUser);
router.use(requireTenantContext);

/**
 * GET /api/v1/whatsapp/accounts
 * Lists all WhatsApp accounts associated with the active tenant.
 */
router.get('/accounts', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        if (isConfigured()) {
            const { data, error: dbErr } = await supabaseAdmin
                .from('whatsapp_accounts')
                .select('*, devices(device_name, status, last_seen)')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (dbErr) return error(res, dbErr.message, 500);
            return success(res, { accounts: data || [] });
        }

        return success(res, { accounts: [] });
    } catch (err) {
        return error(res, 'Failed to list WhatsApp accounts.', 500);
    }
});

/**
 * GET /api/v1/whatsapp/qr-stream
 * Fetches the current live ephemeral QR code from memory for this device and client.
 * Ephemeral ONLY: Reads from RAM, never from Supabase disk tables.
 */
router.get('/qr-stream', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { deviceId, clientId = 'default' } = req.query;

        if (!deviceId) {
            return error(res, 'deviceId is required.', 400);
        }

        const isOnline = wsHub.isDeviceOnline(tenantId, deviceId);
        const qrData = wsHub.getEphemeralQr(tenantId, deviceId, clientId);

        if (!qrData) {
            return success(res, {
                status: isOnline ? 'WAITING_FOR_QR' : 'DEVICE_OFFLINE',
                isAgentOnline: isOnline,
                qrCodeBase64: null,
                message: isOnline
                    ? 'QR not yet received or expired. Click "Request QR".'
                    : 'The Windows Agent is currently OFFLINE.'
            });
        }

        return success(res, {
            status: 'QR_READY',
            isAgentOnline: true,
            qrCodeBase64: qrData.qrCodeBase64,
            expiresInSeconds: qrData.expiresInSeconds,
            timestamp: qrData.timestamp
        });

    } catch (err) {
        console.error('QR stream fetch error:', err);
        return error(res, 'Failed to fetch QR stream.', 500);
    }
});

/**
 * POST /api/v1/whatsapp/request-qr
 * Instructs a customer's Windows Agent to generate a fresh QR code for connection.
 */
router.post('/request-qr', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { deviceId, clientId = 'default' } = req.body;

        if (!deviceId) {
            return error(res, 'Target deviceId is required.', 400);
        }

        // Check if device is connected via WebSocket
        if (!wsHub.isDeviceOnline(tenantId, deviceId)) {
            return error(res, 'The selected Windows Agent is currently OFFLINE. Please start the WASENDER Agent on your PC.', 400);
        }

        // Send remote control command to Agent
        const dispatched = wsHub.sendToDevice(tenantId, deviceId, 'whatsapp:request_qr', { clientId });

        if (!dispatched) {
            return error(res, 'Failed to dispatch command to Agent.', 500);
        }

        return success(res, {
            deviceId,
            clientId,
            status: 'REQUESTED'
        }, 'QR generation requested from Agent.');

    } catch (err) {
        console.error('Request QR error:', err);
        return error(res, 'Failed to request QR generation.', 500);
    }
});

/**
 * POST /api/v1/whatsapp/pair-phone
 * Requests an 8-character phone pairing code instead of scanning QR code.
 */
router.post('/pair-phone', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { deviceId, phoneNumber, clientId = 'default' } = req.body;

        if (!deviceId || !phoneNumber) {
            return error(res, 'deviceId and phoneNumber are required.', 400);
        }

        if (!wsHub.isDeviceOnline(tenantId, deviceId)) {
            return error(res, 'The selected Windows Agent is currently OFFLINE.', 400);
        }

        const dispatched = wsHub.sendToDevice(tenantId, deviceId, 'whatsapp:request_pairing_code', {
            clientId,
            phoneNumber
        });

        if (!dispatched) {
            return error(res, 'Failed to send pairing command to Agent.', 500);
        }

        return success(res, {
            deviceId,
            phoneNumber,
            status: 'PAIRING_REQUESTED'
        }, 'Pairing code requested. Check the WhatsApp notification on your phone.');

    } catch (err) {
        return error(res, 'Failed to request phone pairing code.', 500);
    }
});

/**
 * POST /api/v1/whatsapp/disconnect
 * Instructs the Agent to log out and clear WhatsApp session for a specific account.
 */
router.post('/disconnect', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { deviceId, clientId = 'default' } = req.body;

        if (!deviceId) {
            return error(res, 'deviceId is required.', 400);
        }

        if (wsHub.isDeviceOnline(tenantId, deviceId)) {
            wsHub.sendToDevice(tenantId, deviceId, 'whatsapp:clear_session', { clientId });
        }

        // Update DB record
        if (isConfigured()) {
            await supabaseAdmin
                .from('whatsapp_accounts')
                .update({ status: 'DISCONNECTED', last_seen: new Date().toISOString() })
                .eq('tenant_id', tenantId)
                .eq('device_id', deviceId)
                .eq('client_id', clientId);
        }

        return success(res, {}, 'Disconnection command sent to Agent.');
    } catch (err) {
        return error(res, 'Failed to disconnect WhatsApp session.', 500);
    }
});

module.exports = router;
