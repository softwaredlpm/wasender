const express = require('express');
const router = express.Router();
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext } = require('../middleware/tenant');
const { auditLogger } = require('../services/auditLogger');
const { mockMessagesArchive } = require('./reports');
const { success, error } = require('../utils/response');

router.use(authenticateUser);
router.use(requireTenantContext);

/**
 * GET /api/v1/logs/messages
 * Paginated and searchable message history & delivery logs
 */
router.get('/messages', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { search = '', status = '', page = 1, limit = 50 } = req.query;
        const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

        if (isConfigured()) {
            let query = supabaseAdmin
                .from('messages')
                .select('*', { count: 'exact' })
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false })
                .range(offset, offset + parseInt(limit) - 1);

            if (status) query = query.eq('status', status);
            if (search) query = query.or(`phone.ilike.%${search}%,message.ilike.%${search}%`);

            const { data, count, error: dbErr } = await query;
            if (dbErr) return error(res, dbErr.message, 500);

            return success(res, {
                messages: data || [],
                pagination: {
                    total: count || 0,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil((count || 0) / parseInt(limit))
                }
            });
        }

        // Sandbox / Mock Mode
        let list = mockMessagesArchive.filter(m => !m.tenant_id || m.tenant_id === tenantId);
        if (status) list = list.filter(m => m.status === status);
        if (search) {
            const s = search.toLowerCase();
            list = list.filter(m => m.phone?.includes(s) || m.message?.toLowerCase().includes(s));
        }

        const total = list.length;
        const paged = list.slice(offset, offset + parseInt(limit));

        return success(res, {
            messages: paged,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (err) {
        return error(res, 'Failed to fetch message logs: ' + err.message, 500);
    }
});

/**
 * GET /api/v1/logs/audit
 * Returns paginated security and operation audit logs
 */
router.get('/audit', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { action = '', page = 1, limit = 50 } = req.query;

        const result = await auditLogger.getLogs(tenantId, {
            action: action || null,
            page: parseInt(page),
            limit: parseInt(limit)
        });

        return success(res, result);

    } catch (err) {
        return error(res, 'Failed to fetch audit logs: ' + err.message, 500);
    }
});

/**
 * POST /api/v1/logs/audit
 * Allows logging an explicit tenant action from the web frontend
 */
router.post('/audit', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const userId = req.user?.id || null;
        const { action, resource, details } = req.body;

        if (!action) {
            return error(res, 'Action is required.', 400);
        }

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const entry = await auditLogger.logAction({
            tenantId,
            userId,
            action,
            resource,
            details,
            ipAddress: ip
        });

        return success(res, { log: entry }, 'Audit event logged.', 201);

    } catch (err) {
        return error(res, 'Failed to log audit event: ' + err.message, 500);
    }
});

module.exports = router;
