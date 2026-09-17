const express = require('express');
const router = express.Router();
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext } = require('../middleware/tenant');
const { usageTracker, mockUsageStore } = require('../services/usageTracker');
const { auditLogger, mockAuditStore } = require('../services/auditLogger');
const wsHub = require('../websocket/hub');
const { success, error } = require('../utils/response');

router.use(authenticateUser);
router.use(requireTenantContext);

// Mock messages store for offline sandbox test runs
const mockMessagesArchive = [];

/**
 * GET /api/v1/reports/summary
 * Aggregates high-level KPIs, delivery rates, queue health, and quota headroom
 */
router.get('/summary', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { days = 7 } = req.query;

        // 1. Quota and usage telemetry
        const quota = await usageTracker.checkQuotaHeadroom(tenantId);
        const usage = await usageTracker.getTenantUsage(tenantId, parseInt(days));

        // 2. Count active devices online
        const tenantDevices = wsHub.tenants.get(tenantId);
        let onlineDevicesCount = 0;
        if (tenantDevices) {
            for (const sockets of tenantDevices.values()) {
                if (sockets.size > 0) onlineDevicesCount++;
            }
        }

        // 3. Queue counts
        let pendingQueueCount = 0;
        if (isConfigured()) {
            const { count } = await supabaseAdmin
                .from('message_queue')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .eq('status', 'PENDING');
            pendingQueueCount = count || 0;
        }

        return success(res, {
            kpis: {
                totalSent: usage.totalSent,
                totalFailed: usage.totalFailed,
                deliveryRate: usage.deliveryRate,
                pendingQueue: pendingQueueCount,
                onlineDevices: onlineDevicesCount
            },
            quota: {
                plan: quota.planName,
                limit: quota.planLimit,
                used: quota.usedThisMonth,
                remaining: quota.remaining,
                percentUsed: quota.percentUsed
            },
            timeline: usage.daily
        });

    } catch (err) {
        console.error('Reports summary error:', err);
        return error(res, 'Failed to generate reports summary: ' + err.message, 500);
    }
});

/**
 * GET /api/v1/reports/usage
 * Detailed usage telemetry and daily breakdown
 */
router.get('/usage', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { days = 30 } = req.query;

        const usage = await usageTracker.getTenantUsage(tenantId, parseInt(days));
        const quota = await usageTracker.checkQuotaHeadroom(tenantId);

        return success(res, {
            quota,
            history: usage
        });

    } catch (err) {
        return error(res, 'Failed to fetch usage reports: ' + err.message, 500);
    }
});

/**
 * Helper to escape CSV fields
 */
function escapeCsv(field) {
    if (field === null || field === undefined) return '""';
    const str = String(field).replace(/"/g, '""');
    return `"${str}"`;
}

/**
 * GET /api/v1/reports/export/messages
 * Generates and streams a downloadable CSV report of sent messages
 */
router.get('/export/messages', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { status = '' } = req.query;

        let messages = [];

        if (isConfigured()) {
            let query = supabaseAdmin
                .from('messages')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false })
                .limit(5000);

            if (status) query = query.eq('status', status);

            const { data } = await query;
            messages = data || [];
        } else {
            messages = mockMessagesArchive.filter(m => !m.tenant_id || m.tenant_id === tenantId);
        }

        // CSV Header
        const headers = ['Message ID', 'Phone', 'Direction', 'Status', 'Message Text', 'Media URL', 'Dispatched At'];
        const csvRows = [headers.map(escapeCsv).join(',')];

        for (const m of messages) {
            csvRows.push([
                escapeCsv(m.message_id || m.id),
                escapeCsv(m.phone),
                escapeCsv(m.direction || 'OUTBOUND'),
                escapeCsv(m.status),
                escapeCsv(m.message),
                escapeCsv(m.media_url || ''),
                escapeCsv(m.created_at)
            ].join(','));
        }

        const csvContent = csvRows.join('\r\n');
        const filename = `wasender-messages-${new Date().toISOString().split('T')[0]}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(csvContent);

    } catch (err) {
        console.error('Export messages error:', err);
        return error(res, 'Failed to export messages: ' + err.message, 500);
    }
});

/**
 * GET /api/v1/reports/export/audit-logs
 * Generates and streams a downloadable CSV of security and operational audit logs
 */
router.get('/export/audit-logs', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { logs } = await auditLogger.getLogs(tenantId, { limit: 5000 });

        const headers = ['Log ID', 'Timestamp', 'User ID', 'Action', 'Resource', 'IP Address', 'Details'];
        const csvRows = [headers.map(escapeCsv).join(',')];

        for (const l of logs) {
            csvRows.push([
                escapeCsv(l.id),
                escapeCsv(l.created_at),
                escapeCsv(l.user_id || 'SYSTEM'),
                escapeCsv(l.action),
                escapeCsv(l.resource || ''),
                escapeCsv(l.ip_address || ''),
                escapeCsv(JSON.stringify(l.details || {}))
            ].join(','));
        }

        const csvContent = csvRows.join('\r\n');
        const filename = `wasender-audit-logs-${new Date().toISOString().split('T')[0]}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(csvContent);

    } catch (err) {
        return error(res, 'Failed to export audit logs: ' + err.message, 500);
    }
});

module.exports = router;
module.exports.mockMessagesArchive = mockMessagesArchive;
