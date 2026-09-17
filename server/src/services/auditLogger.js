const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');

// In-memory mock store for unit testing & sandbox offline mode
const mockAuditStore = new Map(); // tenantId -> Array<auditLog>

class AuditLogger {
    /**
     * Records a security action or tenant operation in audit_logs.
     */
    async logAction(options) {
        const {
            tenantId,
            userId = null,
            action,
            resource = null,
            details = {},
            ipAddress = null
        } = options;

        if (!tenantId || !action) return;

        const logEntry = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            user_id: userId,
            action,
            resource,
            details,
            ip_address: ipAddress,
            created_at: new Date().toISOString()
        };

        if (isConfigured()) {
            supabaseAdmin
                .from('audit_logs')
                .insert({
                    tenant_id: tenantId,
                    user_id: userId,
                    action,
                    resource,
                    details,
                    ip_address: ipAddress
                })
                .then(() => {})
                .catch(err => console.error('[AuditLogger] DB insert error:', err.message));
        }

        if (!mockAuditStore.has(tenantId)) {
            mockAuditStore.set(tenantId, []);
        }
        const list = mockAuditStore.get(tenantId);
        list.unshift(logEntry);
        if (list.length > 500) list.pop();

        return logEntry;
    }

    /**
     * Retrieves paginated audit logs for a tenant.
     */
    async getLogs(tenantId, options = {}) {
        const { action, page = 1, limit = 50 } = options;
        const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

        if (isConfigured()) {
            let query = supabaseAdmin
                .from('audit_logs')
                .select('*', { count: 'exact' })
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false })
                .range(offset, offset + parseInt(limit) - 1);

            if (action) {
                query = query.eq('action', action);
            }

            const { data, count, error } = await query;
            if (!error) {
                return {
                    logs: data || [],
                    pagination: {
                        total: count || 0,
                        page: parseInt(page),
                        limit: parseInt(limit),
                        totalPages: Math.ceil((count || 0) / parseInt(limit))
                    }
                };
            }
        }

        const list = mockAuditStore.get(tenantId) || [];
        let filtered = list;
        if (action) {
            filtered = filtered.filter(l => l.action === action);
        }

        const total = filtered.length;
        const paged = filtered.slice(offset, offset + parseInt(limit));

        return {
            logs: paged,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        };
    }
}

module.exports = {
    auditLogger: new AuditLogger(),
    mockAuditStore
};
