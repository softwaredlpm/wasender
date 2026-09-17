const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext } = require('../middleware/tenant');
const wsHub = require('../websocket/hub');
const { success, error } = require('../utils/response');

router.use(authenticateUser);
router.use(requireTenantContext);

// In-memory mock store for unit testing & sandbox mode
const mockBusyCompaniesStore = new Map(); // tenantId -> Map<companyId, company>
const mockBusyConnectionsStore = new Map(); // `${tenantId}:${deviceId}` -> connection

/**
 * GET /api/v1/busy/status
 * Returns BUSY bridge connection status across the tenant's devices
 */
router.get('/status', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        if (isConfigured()) {
            const { data: devices } = await supabaseAdmin
                .from('devices')
                .select('id, device_name, status, last_seen')
                .eq('tenant_id', tenantId);

            const { data: connections } = await supabaseAdmin
                .from('busy_connections')
                .select('*')
                .eq('tenant_id', tenantId);

            const connectionMap = new Map((connections || []).map(c => [c.device_id, c]));

            const deviceStatuses = (devices || []).map(dev => {
                const isOnline = wsHub.isDeviceOnline(tenantId, dev.id);
                const conn = connectionMap.get(dev.id);

                return {
                    deviceId: dev.id,
                    deviceName: dev.device_name,
                    agentOnline: isOnline,
                    busyStatus: isOnline ? (conn?.status || 'CONNECTED') : 'DISCONNECTED',
                    lastSeen: conn?.last_seen || dev.last_seen,
                    dbType: conn?.agent_url ? 'Configured' : 'Unknown'
                };
            });

            return success(res, {
                tenantId,
                totalDevices: deviceStatuses.length,
                devices: deviceStatuses
            });
        }

        // Mock / Sandbox Mode
        const tenantDevices = wsHub.tenants.get(tenantId);
        const deviceList = [];

        if (tenantDevices) {
            for (const [devId, sockets] of tenantDevices.entries()) {
                const isOnline = sockets.size > 0;
                const connKey = `${tenantId}:${devId}`;
                const conn = mockBusyConnectionsStore.get(connKey);

                deviceList.push({
                    deviceId: devId,
                    deviceName: 'Windows Agent PC',
                    agentOnline: isOnline,
                    busyStatus: isOnline ? (conn?.status || 'CONNECTED') : 'DISCONNECTED',
                    lastSeen: new Date().toISOString()
                });
            }
        }

        return success(res, {
            tenantId,
            totalDevices: deviceList.length,
            devices: deviceList
        });

    } catch (err) {
        console.error('Fetch BUSY status error:', err);
        return error(res, 'Failed to fetch BUSY status.', 500);
    }
});

/**
 * POST /api/v1/busy/test
 * Dispatches a test connection RPC to the customer's on-premise Windows Agent
 */
router.post('/test', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { deviceId, dbPath, dbPassword, dbType = 'Access', dbServer, dbUser } = req.body;

        if (!deviceId) {
            return error(res, 'deviceId is required to test BUSY connection.', 400);
        }

        const isOnline = wsHub.isDeviceOnline(tenantId, deviceId);
        if (!isOnline) {
            return error(res, `Agent device ${deviceId} is currently offline. Please start the Windows Agent.`, 503);
        }

        // Send RPC over WebSocket bridge to on-premise agent
        let testResult;
        try {
            testResult = await wsHub.requestDevice(tenantId, deviceId, 'busy:test_connection', {
                dbPath,
                dbPassword,
                dbType,
                dbServer,
                dbUser
            }, 15000);
        } catch (rpcErr) {
            return error(res, `BUSY Test Connection failed: ${rpcErr.message}`, 504);
        }

        // Record connection status
        if (isConfigured()) {
            await supabaseAdmin
                .from('busy_connections')
                .upsert({
                    tenant_id: tenantId,
                    device_id: deviceId,
                    status: testResult.connected ? 'CONNECTED' : 'ERROR',
                    last_seen: new Date().toISOString()
                }, { onConflict: 'tenant_id,device_id' });
        } else {
            mockBusyConnectionsStore.set(`${tenantId}:${deviceId}`, {
                status: testResult.connected ? 'CONNECTED' : 'ERROR',
                last_seen: new Date().toISOString()
            });
        }

        return success(res, testResult, testResult.connected ? 'BUSY database connected successfully.' : 'BUSY connection test failed.');

    } catch (err) {
        console.error('Test BUSY connection error:', err);
        return error(res, 'Error testing BUSY connection.', 500);
    }
});

/**
 * GET /api/v1/busy/companies
 * Lists configured BUSY companies/firms for the tenant
 */
router.get('/companies', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        if (isConfigured()) {
            const { data, error: dbErr } = await supabaseAdmin
                .from('busy_companies')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('company_name', { ascending: true });

            if (dbErr) return error(res, dbErr.message, 500);
            return success(res, { companies: data || [] });
        }

        const tenantMap = mockBusyCompaniesStore.get(tenantId) || new Map();
        return success(res, { companies: Array.from(tenantMap.values()) });

    } catch (err) {
        return error(res, 'Failed to fetch companies.', 500);
    }
});

/**
 * POST /api/v1/busy/companies
 * Manually adds a BUSY company
 */
router.post('/companies', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { companyName, company_name, companyAddress, company_address, companyGst, company_gst, firmCode, firm_code } = req.body;

        const name = companyName || company_name;
        if (!name) {
            return error(res, 'Company name is required.', 400);
        }

        const companyData = {
            tenant_id: tenantId,
            company_name: name,
            company_address: companyAddress || company_address || null,
            company_gst: companyGst || company_gst || null,
            firm_code: firmCode || firm_code || null,
            status: 'ACTIVE'
        };

        if (isConfigured()) {
            const { data, error: insErr } = await supabaseAdmin
                .from('busy_companies')
                .insert(companyData)
                .select()
                .single();

            if (insErr) return error(res, insErr.message, 500);
            return success(res, { company: data, ...data }, 'BUSY company added successfully.', 201);
        }

        if (!mockBusyCompaniesStore.has(tenantId)) {
            mockBusyCompaniesStore.set(tenantId, new Map());
        }
        const tenantMap = mockBusyCompaniesStore.get(tenantId);
        const newComp = {
            id: crypto.randomUUID(),
            ...companyData,
            created_at: new Date().toISOString()
        };
        tenantMap.set(newComp.id, newComp);

        return success(res, { id: newComp.id, company: newComp, ...newComp }, 'BUSY company added (Test Mode).', 201);

    } catch (err) {
        return error(res, 'Failed to add company.', 500);
    }
});

/**
 * PUT /api/v1/busy/companies/:companyId
 * Updates a company record
 */
router.put('/companies/:companyId', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const companyId = req.params.companyId;
        const { companyName, company_name, companyAddress, company_address, companyGst, company_gst, firmCode, firm_code, status } = req.body;

        const updates = { updated_at: new Date().toISOString() };
        if (companyName || company_name) updates.company_name = companyName || company_name;
        if (companyAddress !== undefined || company_address !== undefined) updates.company_address = companyAddress || company_address;
        if (companyGst !== undefined || company_gst !== undefined) updates.company_gst = companyGst || company_gst;
        if (firmCode !== undefined || firm_code !== undefined) updates.firm_code = firmCode || firm_code;
        if (status) updates.status = status;

        if (isConfigured()) {
            const { data, error: updErr } = await supabaseAdmin
                .from('busy_companies')
                .update(updates)
                .eq('tenant_id', tenantId)
                .eq('id', companyId)
                .select()
                .single();

            if (updErr) return error(res, updErr.message, 500);
            return success(res, { company: data, ...data }, 'Company updated successfully.');
        }

        const tenantMap = mockBusyCompaniesStore.get(tenantId);
        if (!tenantMap || !tenantMap.has(companyId)) {
            return error(res, 'Company not found.', 404);
        }
        const existing = tenantMap.get(companyId);
        Object.assign(existing, updates);

        return success(res, { company: existing, ...existing }, 'Company updated.');

    } catch (err) {
        return error(res, 'Failed to update company.', 500);
    }
});

/**
 * DELETE /api/v1/busy/companies/:companyId
 * Removes a company record
 */
router.delete('/companies/:companyId', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const companyId = req.params.companyId;

        if (isConfigured()) {
            const { error: delErr } = await supabaseAdmin
                .from('busy_companies')
                .delete()
                .eq('tenant_id', tenantId)
                .eq('id', companyId);

            if (delErr) return error(res, delErr.message, 500);
            return success(res, {}, 'Company deleted successfully.');
        }

        const tenantMap = mockBusyCompaniesStore.get(tenantId);
        if (tenantMap) tenantMap.delete(companyId);
        return success(res, {}, 'Company deleted.');

    } catch (err) {
        return error(res, 'Failed to delete company.', 500);
    }
});

/**
 * POST /api/v1/busy/sync-companies
 * Dispatches RPC to connected Windows Agent to query local busy_config.json/detected firms
 * and syncs them automatically into the Cloud database.
 */
router.post('/sync-companies', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { deviceId } = req.body;

        if (!deviceId) {
            return error(res, 'deviceId is required to sync BUSY companies.', 400);
        }

        if (!wsHub.isDeviceOnline(tenantId, deviceId)) {
            return error(res, `Agent device ${deviceId} is offline.`, 503);
        }

        const agentResponse = await wsHub.requestDevice(tenantId, deviceId, 'busy:get_companies', {}, 15000);
        const firms = agentResponse.companies || [];

        if (firms.length === 0) {
            return success(res, { syncedCount: 0, companies: [] }, 'No BUSY firms detected on device.');
        }

        const upsertPayload = firms.map(f => ({
            tenant_id: tenantId,
            company_name: f.companyName || f.name,
            company_address: f.companyAddress || null,
            company_gst: f.companyGst || null,
            firm_code: f.firmCode || null,
            status: 'ACTIVE'
        }));

        if (isConfigured()) {
            const { data, error: syncErr } = await supabaseAdmin
                .from('busy_companies')
                .upsert(upsertPayload, { onConflict: 'tenant_id,company_name' })
                .select();

            if (syncErr) return error(res, syncErr.message, 500);
            return success(res, { syncedCount: data.length, companies: data }, `Successfully synced ${data.length} companies from Agent.`);
        }

        // Mock Mode
        if (!mockBusyCompaniesStore.has(tenantId)) {
            mockBusyCompaniesStore.set(tenantId, new Map());
        }
        const tenantMap = mockBusyCompaniesStore.get(tenantId);

        const saved = [];
        for (const item of upsertPayload) {
            let existingId = null;
            for (const [id, c] of tenantMap.entries()) {
                if (c.company_name === item.company_name) {
                    existingId = id;
                    break;
                }
            }
            const id = existingId || crypto.randomUUID();
            const record = { id, ...item, created_at: new Date().toISOString() };
            tenantMap.set(id, record);
            saved.push(record);
        }

        return success(res, { syncedCount: saved.length, companies: saved }, `Synced ${saved.length} BUSY companies from Windows Agent.`);

    } catch (err) {
        console.error('Sync companies error:', err);
        return error(res, 'Failed to sync BUSY companies: ' + err.message, 500);
    }
});

/**
 * GET /api/v1/busy/invoices/recent
 * Returns recently dispatched BUSY invoices for this tenant
 */
router.get('/invoices/recent', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const liveBuffer = wsHub.recentInvoices.get(tenantId) || [];

        if (isConfigured() && liveBuffer.length === 0) {
            const { data } = await supabaseAdmin
                .from('messages')
                .select('*')
                .eq('tenant_id', tenantId)
                .ilike('message', '%[BUSY Invoice]%')
                .order('created_at', { ascending: false })
                .limit(20);

            return success(res, { invoices: data || [] });
        }

        return success(res, { invoices: liveBuffer });

    } catch (err) {
        return error(res, 'Failed to fetch recent invoices: ' + err.message, 500);
    }
});

module.exports = router;
