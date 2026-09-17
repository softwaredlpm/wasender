const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
require('dotenv').config(); // Also check current dir

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock-wasender.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'mock-anon-key';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-service-role-key';

// Admin client with full privileges (Runs ONLY on VPS backend)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    },
    realtime: {
        transport: ws
    }
});

// Anonymous client for user-scoped auth calls
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        autoRefreshToken: true,
        persistSession: true
    },
    realtime: {
        transport: ws
    }
});

// Helper to instantiate a user-scoped Supabase client that respects RLS
function getUserScopedClient(jwtToken) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: {
                Authorization: `Bearer ${jwtToken}`
            }
        },
        auth: {
            persistSession: false
        },
        realtime: {
            transport: ws
        }
    });
}

module.exports = {
    supabaseAdmin,
    supabaseAnon,
    getUserScopedClient,
    SUPABASE_URL,
    isConfigured: () => process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('mock')
};
