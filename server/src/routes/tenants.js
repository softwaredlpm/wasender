const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext, requireRole } = require('../middleware/tenant');
const { success, error } = require('../utils/response');

// All tenant routes require prior authentication
router.use(authenticateUser);

/**
 * GET /api/v1/tenants
 * Lists all tenant organizations the authenticated user belongs to.
 */
router.get('/', async (req, res) => {
    try {
        const { data, error: dbErr } = await supabaseAdmin
            .from('tenant_users')
            .select('role, created_at, tenants(*)')
            .eq('user_id', req.user.id);

        if (dbErr) {
            return error(res, dbErr.message, 500);
        }

        const formatted = (data || []).map(row => ({
            id: row.tenants?.id,
            name: row.tenants?.name,
            businessName: row.tenants?.business_name,
            gstin: row.tenants?.gstin,
            status: row.tenants?.status,
            myRole: row.role,
            joinedAt: row.created_at
        }));

        return success(res, { tenants: formatted });
    } catch (err) {
        console.error('List tenants error:', err);
        return error(res, 'Failed to fetch organizations.', 500);
    }
});

/**
 * POST /api/v1/tenants
 * Creates a brand new tenant organization and sets current user as SUPER_ADMIN.
 */
router.post('/', async (req, res) => {
    try {
        const { name, businessName, gstin } = req.body;

        if (!name) {
            return error(res, 'Organization name is required.', 400);
        }

        // 1. Create Tenant Record
        const { data: tenant, error: tenantErr } = await supabaseAdmin
            .from('tenants')
            .insert({
                name,
                business_name: businessName || name,
                gstin: gstin || null,
                status: 'ACTIVE'
            })
            .select()
            .single();

        if (tenantErr) {
            return error(res, tenantErr.message, 400);
        }

        // 2. Link Creator as SUPER_ADMIN
        const { error: userErr } = await supabaseAdmin
            .from('tenant_users')
            .insert({
                tenant_id: tenant.id,
                user_id: req.user.id,
                role: 'SUPER_ADMIN'
            });

        if (userErr) {
            return error(res, userErr.message, 500);
        }

        // 3. Assign 14-day trial
        const { data: trialPlan } = await supabaseAdmin
            .from('plans')
            .select('id')
            .eq('slug', 'free-trial')
            .single();

        if (trialPlan) {
            await supabaseAdmin.from('subscriptions').insert({
                tenant_id: tenant.id,
                plan_id: trialPlan.id,
                status: 'TRIAL',
                start_date: new Date().toISOString(),
                end_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
            });
        }

        return success(res, { tenant }, 'Organization created successfully.', 201);
    } catch (err) {
        console.error('Create tenant error:', err);
        return error(res, 'Failed to create organization.', 500);
    }
});

/**
 * GET /api/v1/tenants/:tenantId
 * Retrieves detailed info, subscription, and statistics for a specific tenant.
 */
router.get('/:tenantId', requireTenantContext, async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        const [tenantRes, subRes, devicesRes, accountsRes] = await Promise.all([
            supabaseAdmin.from('tenants').select('*').eq('id', tenantId).single(),
            supabaseAdmin.from('subscriptions').select('*, plans(*)').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(1).single(),
            supabaseAdmin.from('devices').select('id, status').eq('tenant_id', tenantId),
            supabaseAdmin.from('whatsapp_accounts').select('id, status').eq('tenant_id', tenantId)
        ]);

        return success(res, {
            tenant: tenantRes.data,
            myRole: req.tenant.role,
            subscription: subRes.data || null,
            stats: {
                totalDevices: devicesRes.data?.length || 0,
                onlineDevices: devicesRes.data?.filter(d => d.status === 'ONLINE').length || 0,
                whatsappAccounts: accountsRes.data?.length || 0,
                connectedWhatsApp: accountsRes.data?.filter(a => a.status === 'CONNECTED').length || 0
            }
        });
    } catch (err) {
        console.error('Get tenant detail error:', err);
        return error(res, 'Failed to retrieve organization details.', 500);
    }
});

/**
 * PATCH /api/v1/tenants/:tenantId
 * Updates organization profile. Requires ADMIN or SUPER_ADMIN role.
 */
router.patch('/:tenantId', requireTenantContext, requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { name, businessName, gstin } = req.body;

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (businessName !== undefined) updates.business_name = businessName;
        if (gstin !== undefined) updates.gstin = gstin;

        const { data, error: updateErr } = await supabaseAdmin
            .from('tenants')
            .update(updates)
            .eq('id', tenantId)
            .select()
            .single();

        if (updateErr) {
            return error(res, updateErr.message, 400);
        }

        return success(res, { tenant: data }, 'Organization updated successfully.');
    } catch (err) {
        console.error('Update tenant error:', err);
        return error(res, 'Failed to update organization.', 500);
    }
});

/**
 * GET /api/v1/tenants/:tenantId/members
 * Lists all team members of this tenant organization.
 */
router.get('/:tenantId/members', requireTenantContext, async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        const { data, error: dbErr } = await supabaseAdmin
            .from('tenant_users')
            .select('user_id, role, created_at, profiles(email, full_name, avatar_url)')
            .eq('tenant_id', tenantId);

        if (dbErr) {
            return error(res, dbErr.message, 500);
        }

        const members = (data || []).map(row => ({
            userId: row.user_id,
            email: row.profiles?.email,
            fullName: row.profiles?.full_name,
            avatarUrl: row.profiles?.avatar_url,
            role: row.role,
            joinedAt: row.created_at
        }));

        return success(res, { members });
    } catch (err) {
        console.error('List members error:', err);
        return error(res, 'Failed to retrieve organization members.', 500);
    }
});

/**
 * POST /api/v1/tenants/:tenantId/members
 * Adds / invites an existing user to this tenant organization.
 */
router.post('/:tenantId/members', requireTenantContext, requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { email, role = 'USER' } = req.body;

        if (!email) {
            return error(res, 'Member email is required.', 400);
        }

        if (!['ADMIN', 'USER'].includes(role)) {
            return error(res, 'Role must be either ADMIN or USER.', 400);
        }

        // Find user by email in profiles
        const { data: targetProfile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .select('id, email, full_name')
            .eq('email', email.trim().toLowerCase())
            .single();

        if (profileErr || !targetProfile) {
            return error(res, `No registered user found with email: ${email}. The user must register first.`, 404);
        }

        // Check if user is already a member
        const { data: existing } = await supabaseAdmin
            .from('tenant_users')
            .select('role')
            .eq('tenant_id', tenantId)
            .eq('user_id', targetProfile.id)
            .single();

        if (existing) {
            return error(res, 'This user is already a member of this organization.', 409);
        }

        // Add member
        const { error: insertErr } = await supabaseAdmin
            .from('tenant_users')
            .insert({
                tenant_id: tenantId,
                user_id: targetProfile.id,
                role: role
            });

        if (insertErr) {
            return error(res, insertErr.message, 500);
        }

        return success(res, {
            userId: targetProfile.id,
            email: targetProfile.email,
            role: role
        }, 'Member added successfully.', 201);

    } catch (err) {
        console.error('Add member error:', err);
        return error(res, 'Failed to add member.', 500);
    }
});

/**
 * DELETE /api/v1/tenants/:tenantId/members/:userId
 * Removes a member from the organization.
 */
router.delete('/:tenantId/members/:userId', requireTenantContext, requireRole(['SUPER_ADMIN', 'ADMIN']), async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const targetUserId = req.params.userId;

        // Prevent self-removal if user is last SUPER_ADMIN
        if (targetUserId === req.user.id) {
            return error(res, 'You cannot remove yourself from your own organization.', 400);
        }

        const { error: delErr } = await supabaseAdmin
            .from('tenant_users')
            .delete()
            .eq('tenant_id', tenantId)
            .eq('user_id', targetUserId);

        if (delErr) {
            return error(res, delErr.message, 500);
        }

        return success(res, {}, 'Member removed successfully.');
    } catch (err) {
        console.error('Remove member error:', err);
        return error(res, 'Failed to remove member.', 500);
    }
});

module.exports = router;
