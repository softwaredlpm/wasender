const express = require('express');
const router = express.Router();
const { supabaseAdmin, supabaseAnon } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { success, error } = require('../utils/response');

/**
 * POST /api/v1/auth/register
 * Creates a new user in Supabase Auth and auto-provisions their tenant organization.
 */
router.post('/register', async (req, res) => {
    try {
        const { email, password, fullName, businessName } = req.body;

        if (!email || !password) {
            return error(res, 'Email and password are required.', 400);
        }

        if (password.length < 6) {
            return error(res, 'Password must be at least 6 characters.', 400);
        }

        const effectiveBusinessName = businessName || `${fullName || email.split('@')[0]}'s Company`;

        // 1. Register with Supabase Auth
        const { data: authData, error: authErr } = await supabaseAdmin.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: fullName || '',
                    business_name: effectiveBusinessName
                }
            }
        });

        if (authErr) {
            return error(res, authErr.message, 400);
        }

        const user = authData.user;
        if (!user) {
            return error(res, 'Failed to create user account.', 500);
        }

        // 2. Fetch or guarantee tenant organization (in case DB trigger hasn't fired or is manual)
        let { data: memberships } = await supabaseAdmin
            .from('tenant_users')
            .select('tenant_id, role, tenants(*)')
            .eq('user_id', user.id);

        // Fallback: If DB trigger is not active, provision tenant manually
        if (!memberships || memberships.length === 0) {
            // Create Profile
            await supabaseAdmin.from('profiles').upsert({
                id: user.id,
                email: user.email,
                full_name: fullName || ''
            });

            // Create Tenant
            const { data: newTenant } = await supabaseAdmin.from('tenants').insert({
                name: effectiveBusinessName,
                business_name: effectiveBusinessName,
                status: 'ACTIVE'
            }).select().single();

            if (newTenant) {
                // Link User to Tenant
                await supabaseAdmin.from('tenant_users').insert({
                    tenant_id: newTenant.id,
                    user_id: user.id,
                    role: 'SUPER_ADMIN'
                });

                memberships = [{
                    tenant_id: newTenant.id,
                    role: 'SUPER_ADMIN',
                    tenants: newTenant
                }];
            }
        }

        return success(res, {
            user: {
                id: user.id,
                email: user.email,
                fullName: fullName || '',
                confirmedAt: user.email_confirmed_at
            },
            session: authData.session,
            tenants: memberships || []
        }, 'Registration successful. Account and organization provisioned.', 201);

    } catch (err) {
        console.error('Registration route error:', err);
        return error(res, 'Internal server error during registration.', 500);
    }
});

/**
 * POST /api/v1/auth/login
 * Authenticates user credentials via Supabase Auth and returns session tokens with tenant access.
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return error(res, 'Email and password are required.', 400);
        }

        // 1. Sign in with Supabase
        const { data: authData, error: authErr } = await supabaseAnon.auth.signInWithPassword({
            email,
            password
        });

        if (authErr) {
            return error(res, authErr.message, 401);
        }

        const user = authData.user;
        const session = authData.session;

        // 2. Fetch User Profile and Associated Tenants
        const [{ data: profile }, { data: memberships }] = await Promise.all([
            supabaseAdmin.from('profiles').select('*').eq('id', user.id).single(),
            supabaseAdmin.from('tenant_users').select('tenant_id, role, tenants(*)').eq('user_id', user.id)
        ]);

        return success(res, {
            user: {
                id: user.id,
                email: user.email,
                profile: profile || {}
            },
            session: {
                accessToken: session.access_token,
                refreshToken: session.refresh_token,
                expiresIn: session.expires_in,
                expiresAt: session.expires_at
            },
            tenants: (memberships || []).map(m => ({
                id: m.tenant_id,
                role: m.role,
                name: m.tenants?.name || 'My Company',
                status: m.tenants?.status || 'ACTIVE'
            }))
        }, 'Login successful.');

    } catch (err) {
        console.error('Login route error:', err);
        return error(res, 'Internal server error during login.', 500);
    }
});

/**
 * POST /api/v1/auth/refresh
 * Refreshes an expired access token using a valid refresh token.
 */
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return error(res, 'Refresh token is required.', 400);
        }

        const { data, error: refreshErr } = await supabaseAnon.auth.refreshSession({
            refresh_token: refreshToken
        });

        if (refreshErr) {
            return error(res, refreshErr.message, 401);
        }

        return success(res, {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresIn: data.session.expires_in,
            expiresAt: data.session.expires_at
        }, 'Token refreshed successfully.');

    } catch (err) {
        console.error('Refresh token error:', err);
        return error(res, 'Failed to refresh authentication session.', 500);
    }
});

/**
 * POST /api/v1/auth/logout
 * Terminates user session.
 */
router.post('/logout', authenticateUser, async (req, res) => {
    try {
        await supabaseAdmin.auth.admin.signOut(req.token);
        return success(res, {}, 'Logged out successfully.');
    } catch (err) {
        console.error('Logout error:', err);
        return success(res, {}, 'Logged out successfully.');
    }
});

/**
 * POST /api/v1/auth/forgot-password
 * Triggers a password reset email from Supabase Auth.
 */
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return error(res, 'Email address is required.', 400);
        }

        const { error: resetErr } = await supabaseAnon.auth.resetPasswordForEmail(email);

        if (resetErr) {
            return error(res, resetErr.message, 400);
        }

        return success(res, {}, 'Password reset instructions sent to your email.');

    } catch (err) {
        console.error('Forgot password error:', err);
        return error(res, 'Failed to initiate password reset.', 500);
    }
});

/**
 * GET /api/v1/auth/me
 * Returns authenticated user details, tenant memberships, and current active subscription.
 */
router.get('/me', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;

        const [profileRes, tenantsRes] = await Promise.all([
            supabaseAdmin.from('profiles').select('*').eq('id', userId).single(),
            supabaseAdmin.from('tenant_users').select('tenant_id, role, tenants(*)').eq('user_id', userId)
        ]);

        return success(res, {
            user: {
                id: userId,
                email: req.user.email,
                profile: profileRes.data || req.user.profile
            },
            tenants: (tenantsRes.data || []).map(m => ({
                id: m.tenant_id,
                role: m.role,
                ...m.tenants
            }))
        });

    } catch (err) {
        console.error('Auth /me error:', err);
        return error(res, 'Failed to fetch user profile.', 500);
    }
});

module.exports = router;
