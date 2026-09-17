/**
 * Strict Cross-Tenant Isolation Middleware
 * Prevents:
 * 1. Cross-tenant IDOR (Insecure Direct Object Reference)
 * 2. Header / Query / Body tenant_id spoofing or tampering
 * 3. Cross-organization data leakage or unauthorized mutation
 */

const { error } = require('../utils/response');

/**
 * Validates that any requested tenant ID strictly matches the authenticated tenant context
 */
function enforceTenantIsolation(req, res, next) {
    if (!req.tenant || !req.tenant.id) {
        return error(res, 'Tenant context missing. Tenant isolation cannot be verified.', 403);
    }

    const authorizedTenantId = req.tenant.id;
    const isSuperAdmin = req.tenant.role === 'SUPER_ADMIN';

    // 1. Check Route Parameters (e.g., /api/v1/tenants/:tenantId)
    const routeTenantId = req.params.tenantId || req.params.tenant_id;
    if (routeTenantId && routeTenantId !== authorizedTenantId && !isSuperAdmin) {
        return error(
            res,
            'Cross-tenant access violation: Target route tenant identifier does not match your active organization context.',
            403
        );
    }

    // 2. Check Query Parameters (?tenantId=... or ?tenant_id=...)
    const queryTenantId = req.query.tenantId || req.query.tenant_id;
    if (queryTenantId && queryTenantId !== authorizedTenantId && !isSuperAdmin) {
        return error(
            res,
            'Cross-tenant access violation: Query tenant identifier does not match your active organization context.',
            403
        );
    }

    // 3. Check Header Override Attempts (x-tenant-id)
    const headerTenantId = req.headers['x-tenant-id'];
    if (headerTenantId && headerTenantId !== authorizedTenantId && !isSuperAdmin) {
        return error(
            res,
            'Cross-tenant access violation: Unauthorized tenant identifier in request headers.',
            403
        );
    }

    // 4. Sanitize and Force Invariant on Request Body for Mutating Requests
    if (req.body && typeof req.body === 'object') {
        if (req.body.tenant_id && req.body.tenant_id !== authorizedTenantId && !isSuperAdmin) {
            return error(
                res,
                'Cross-tenant access violation: Attempted to inject foreign tenant_id into request body.',
                403
            );
        }
        if (req.body.tenantId && req.body.tenantId !== authorizedTenantId && !isSuperAdmin) {
            return error(
                res,
                'Cross-tenant access violation: Attempted to inject foreign tenantId into request body.',
                403
            );
        }

        // Force overwrite with verified authorized tenantId
        req.body.tenant_id = authorizedTenantId;
        req.body.tenantId = authorizedTenantId;
    }

    // 5. Attach helper method to verify individual resource ownership against tenant
    req.assertTenantOwnership = function (resourceTenantId, resourceName = 'Resource') {
        if (resourceTenantId && resourceTenantId !== authorizedTenantId && !isSuperAdmin) {
            const err = new Error(`Access denied: ${resourceName} does not belong to your organization.`);
            err.statusCode = 403;
            throw err;
        }
        return true;
    };

    next();
}

module.exports = {
    enforceTenantIsolation
};
