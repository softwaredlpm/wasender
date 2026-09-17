const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { error } = require('../utils/response');

/**
 * Authentication Middleware
 * Validates Supabase JWT and attaches user context to the request.
 */
async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return error(res, 'Authentication token missing. Please provide Bearer token.', 401);
        }

        const token = authHeader.replace('Bearer ', '').trim();

        if (!token) {
            return error(res, 'Invalid authorization format.', 401);
        }

        // Offline / Test mock support
        if (!isConfigured() && token.startsWith('mock-')) {
            req.user = {
                id: 'test-user-id',
                email: 'test@wasender.local',
                profile: { full_name: 'Test Administrator' }
            };
            req.token = token;
            return next();
        }

        // Verify token with Supabase Auth
        let user;
        try {
            const { data, error: authError } = await supabaseAdmin.auth.getUser(token);
            if (authError || !data?.user) {
                return error(res, authError ? authError.message : 'Invalid or expired authentication token.', 401);
            }
            user = data.user;
        } catch (fetchErr) {
            return error(res, 'Authentication service unavailable or invalid token.', 401);
        }

        // Fetch user profile
        try {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            req.user = {
                id: user.id,
                email: user.email,
                profile: profile || { full_name: user.user_metadata?.full_name || user.email }
            };
        } catch (profileErr) {
            req.user = {
                id: user.id,
                email: user.email,
                profile: { full_name: user.user_metadata?.full_name || user.email }
            };
        }

        req.token = token;
        next();
    } catch (err) {
        console.error('Authentication middleware error:', err.message);
        return error(res, 'Internal authentication verification error.', 500);
    }
}

module.exports = {
    authenticateUser
};
