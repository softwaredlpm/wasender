const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { error } = require('../utils/response');
const { enforceTenantIsolation } = require('./tenantIsolation');

/**
 * Tenant Isolation Context Middleware
 * Enforces that every tenant-scoped request resolves to a verified tenant membership.
 * Never trusts tenant_id from frontend without DB-level membership verification.
 */
async function requireTenantContext(req, res, next) {
    try {
        if (!req.user || !req.user.id) {
            return error(res, 'User authentication required prior to tenant resolution.', 401);
        }

        let tenantId = req.headers['x-tenant-id'] || req.query.tenantId || req.body?.tenantId;

        // Offline / Test mock support
        if (!isConfigured() && req.token?.startsWith('mock-')) {
            let userAuthorizedTenant = null;
            let role = 'ADMIN';

            if (req.token.includes('superadmin') || req.token === 'mock-jwt-user' || req.token === 'mock-jwt-token') {
                role = 'SUPER_ADMIN';
            }

            if (req.token.includes('tenant-a')) {
                userAuthorizedTenant = '11111111-1111-1111-1111-111111111111';
            } else if (req.token.includes('tenant-b')) {
                userAuthorizedTenant = '22222222-2222-2222-2222-222222222222';
            } else if (req.token.includes('tenant-c')) {
                userAuthorizedTenant = '33333333-3333-3333-3333-333333333333';
            }

            // If token has a specific bound tenant, enforce that boundary
            if (userAuthorizedTenant) {
                if (tenantId && tenantId !== userAuthorizedTenant && role !== 'SUPER_ADMIN') {
                    return error(res, 'Access denied: You are not authorized to access this tenant organization.', 403);
                }
                tenantId = userAuthorizedTenant;
            } else {
                // Default generic mock user: adopts requested tenantId or default test tenant
                tenantId = tenantId || '11111111-2222-3333-4444-555555555555';
            }

            req.tenant = {
                id: tenantId,
                role: role,
                info: { name: `Test Company (${tenantId})`, status: 'ACTIVE' }
            };
            return enforceTenantIsolation(req, res, next);
        }

        // If no explicit tenant ID header provided, check user's default or primary tenant
        if (!tenantId) {
            const { data: userTenants, error: listError } = await supabaseAdmin
                .from('tenant_users')
                .select('tenant_id, role, tenants(id, name, status)')
                .eq('user_id', req.user.id)
                .limit(1);

            if (listError || !userTenants || userTenants.length === 0) {
                return error(res, 'No tenant organization found for this user. Please create or join an organization.', 403);
            }

            tenantId = userTenants[0].tenant_id;
            req.tenant = {
                id: tenantId,
                role: userTenants[0].role,
                info: userTenants[0].tenants
            };
            return next();
        }

        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(tenantId)) {
            return error(res, 'Invalid tenant identifier format.', 400);
        }

        // Verify user membership and role in this specific tenant
        const { data: membership, error: memberError } = await supabaseAdmin
            .from('tenant_users')
            .select('role, tenants(id, name, status)')
            .eq('tenant_id', tenantId)
            .eq('user_id', req.user.id)
            .single();

        if (memberError || !membership) {
            return error(res, 'Access denied: You are not authorized to access this tenant organization.', 403);
        }

        if (membership.tenants && membership.tenants.status !== 'ACTIVE') {
            return error(res, `Tenant organization is currently ${membership.tenants.status.toLowerCase()}.`, 403);
        }

        req.tenant = {
            id: tenantId,
            role: membership.role,
            info: membership.tenants
        };

        return enforceTenantIsolation(req, res, next);
    } catch (err) {
        console.error('Tenant context error:', err);
        return error(res, 'Internal error verifying tenant authorization.', 500);
    }
}

/**
 * Role-Based Access Control (RBAC) Middleware
 * Checks if user's role in the current tenant satisfies the required role.
 * @param {string[]} allowedRoles - e.g. ['SUPER_ADMIN', 'ADMIN']
 */
function requireRole(allowedRoles = []) {
    return (req, res, next) => {
        if (!req.tenant || !req.tenant.role) {
            return error(res, 'Tenant context missing for role verification.', 403);
        }

        if (!allowedRoles.includes(req.tenant.role)) {
            return error(res, `Access denied: Requires ${allowedRoles.join(' or ')} privileges.`, 403);
        }

        next();
    };
}

module.exports = {
    requireTenantContext,
    requireRole
};
