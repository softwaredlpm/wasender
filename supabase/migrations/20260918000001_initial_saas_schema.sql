-- ==============================================================================
-- WASENDER MULTI-TENANT SAAS DATABASE SCHEMA
-- Migration: 20260918000001_initial_saas_schema.sql
-- Description: Production-ready PostgreSQL schema with Row Level Security (RLS)
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 2. TABLE DEFINITIONS
-- ==============================================================================

-- 2.1 PROFILES (Linked to Supabase Auth auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.2 TENANTS (Isolated Organization / Company)
CREATE TABLE IF NOT EXISTS public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    business_name TEXT,
    gstin TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.3 TENANT_USERS (User-Tenant Membership & Role RBAC)
CREATE TABLE IF NOT EXISTS public.tenant_users (
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'USER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, user_id)
);

-- 2.4 DEVICES (Customer On-Premise Windows Agents)
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    agent_version TEXT DEFAULT '1.0.0',
    agent_token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE', 'OFFLINE', 'REVOKED')),
    system_info JSONB DEFAULT '{}'::jsonb,
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.5 WHATSAPP_ACCOUNTS (Linked WhatsApp Web Sessions on Devices)
CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    device_id UUID REFERENCES public.devices(id) ON DELETE SET NULL,
    phone_number TEXT,
    account_name TEXT NOT NULL DEFAULT 'Primary Account',
    client_id TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN ('DISCONNECTED', 'AUTHENTICATING', 'CONNECTED', 'PAIRING')),
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.6 CONTACTS (Tenant Address Book)
CREATE TABLE IF NOT EXISTS public.contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    customer_code TEXT,
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_tenant_phone UNIQUE (tenant_id, phone)
);

-- 2.7 MESSAGE_TEMPLATES (Reusable Message Templates with Variables)
CREATE TABLE IF NOT EXISTS public.message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    variables TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.8 MESSAGE_QUEUE (Central Cloud Dispatch Queue)
CREATE TABLE IF NOT EXISTS public.message_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    device_id UUID REFERENCES public.devices(id) ON DELETE SET NULL,
    whatsapp_account_id UUID REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    attachment_path TEXT,
    attachment_url TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRY', 'CANCELLED')),
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 5,
    is_priority BOOLEAN DEFAULT FALSE,
    idempotency_key TEXT,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

-- 2.9 MESSAGES (Historical Message Archive / Inbound & Outbound)
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    whatsapp_account_id UUID REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'OUTBOUND' CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    status TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED')),
    message_id TEXT,
    media_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.10 MESSAGE_LOGS (Detailed Dispatch and Error Telemetry)
CREATE TABLE IF NOT EXISTS public.message_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    queue_id UUID REFERENCES public.message_queue(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    error TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.11 BUSY_COMPANIES (Configured Firms / Branches)
CREATE TABLE IF NOT EXISTS public.busy_companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_name TEXT NOT NULL,
    company_address TEXT,
    company_gst TEXT,
    firm_code TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.12 BUSY_CONNECTIONS (Agent to Cloud Bridge Status)
CREATE TABLE IF NOT EXISTS public.busy_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    device_id UUID REFERENCES public.devices(id) ON DELETE CASCADE,
    agent_url TEXT,
    token_encrypted TEXT,
    status TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN ('CONNECTED', 'DISCONNECTED', 'ERROR')),
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.13 LICENSES (Enterprise / Standalone License Entitlements)
CREATE TABLE IF NOT EXISTS public.licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    license_key TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL DEFAULT 'STANDARD',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.14 PLANS (SaaS Pricing & Quota Definitions)
CREATE TABLE IF NOT EXISTS public.plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    price NUMERIC(10, 2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'INR',
    billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
    message_limit INT NOT NULL DEFAULT 1000,
    device_limit INT NOT NULL DEFAULT 1,
    whatsapp_limit INT NOT NULL DEFAULT 1,
    features JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.15 SUBSCRIPTIONS (Tenant Active Plan & Razorpay Tracking)
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES public.plans(id),
    razorpay_subscription_id TEXT,
    razorpay_customer_id TEXT,
    razorpay_payment_id TEXT,
    status TEXT NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED')),
    start_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.16 USAGE_DAILY (Aggregated Daily Telemetry & Rate-Limiting Quotas)
CREATE TABLE IF NOT EXISTS public.usage_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
    messages_sent INT NOT NULL DEFAULT 0,
    messages_failed INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_tenant_usage_date UNIQUE (tenant_id, usage_date)
);

-- 2.17 SETTINGS (Tenant Key-Value Configurations)
CREATE TABLE IF NOT EXISTS public.settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    setting_key TEXT NOT NULL,
    setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_tenant_setting UNIQUE (tenant_id, setting_key)
);

-- 2.18 AUDIT_LOGS (Security Compliance & Action Tracking)
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================================================================
-- 3. PERFORMANCE INDEXES
-- ==============================================================================

CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id ON public.tenant_users(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_status ON public.devices(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON public.devices(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_tenant_device ON public.whatsapp_accounts(tenant_id, device_id);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone ON public.contacts(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_message_queue_tenant_status ON public.message_queue(tenant_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_message_queue_dispatch ON public.message_queue(status, scheduled_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_messages_tenant_date ON public.messages(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_tenant_date ON public.message_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_daily_tenant_date ON public.usage_daily(tenant_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_date ON public.audit_logs(tenant_id, created_at DESC);

-- ==============================================================================
-- 4. SECURITY DEFINER HELPER FUNCTIONS (Zero-Recursion RLS)
-- ==============================================================================

-- Check if current authenticated user belongs to tenant
CREATE OR REPLACE FUNCTION public.is_tenant_member(_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.tenant_users
        WHERE tenant_id = _tenant_id AND user_id = auth.uid()
    );
$$;

-- Check if current authenticated user has ADMIN or SUPER_ADMIN in tenant
CREATE OR REPLACE FUNCTION public.is_tenant_admin(_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.tenant_users
        WHERE tenant_id = _tenant_id 
          AND user_id = auth.uid() 
          AND role IN ('ADMIN', 'SUPER_ADMIN')
    );
$$;

-- Check if current user is platform SUPER_ADMIN
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.tenant_users
        WHERE user_id = auth.uid() AND role = 'SUPER_ADMIN'
    );
$$;

-- Get all tenant IDs current user is a member of
CREATE OR REPLACE FUNCTION public.get_auth_tenant_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid();
$$;

-- ==============================================================================
-- 5. ROW LEVEL SECURITY (RLS) POLICIES
-- ==============================================================================

-- Enable RLS across all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.busy_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.busy_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 5.1 PROFILES POLICIES
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT USING (id = auth.uid() OR public.is_platform_admin());

CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE USING (id = auth.uid());

-- 5.2 TENANTS POLICIES
CREATE POLICY "Users can view member tenants" ON public.tenants
    FOR SELECT USING (public.is_tenant_member(id) OR public.is_platform_admin());

CREATE POLICY "Admins can update tenant info" ON public.tenants
    FOR UPDATE USING (public.is_tenant_admin(id) OR public.is_platform_admin());

-- 5.3 TENANT_USERS POLICIES
CREATE POLICY "Users can view members of own tenants" ON public.tenant_users
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Admins can manage members of own tenants" ON public.tenant_users
    FOR ALL USING (public.is_tenant_admin(tenant_id) OR public.is_platform_admin());

-- 5.4 DEVICES POLICIES
CREATE POLICY "Tenant members can view devices" ON public.devices
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant admins can manage devices" ON public.devices
    FOR ALL USING (public.is_tenant_admin(tenant_id) OR public.is_platform_admin());

-- 5.5 WHATSAPP_ACCOUNTS POLICIES
CREATE POLICY "Tenant members can view whatsapp accounts" ON public.whatsapp_accounts
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant members can manage whatsapp accounts" ON public.whatsapp_accounts
    FOR ALL USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.6 CONTACTS POLICIES
CREATE POLICY "Tenant members can view contacts" ON public.contacts
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant members can manage contacts" ON public.contacts
    FOR ALL USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.7 MESSAGE_TEMPLATES POLICIES
CREATE POLICY "Tenant members can view templates" ON public.message_templates
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant members can manage templates" ON public.message_templates
    FOR ALL USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.8 MESSAGE_QUEUE POLICIES
CREATE POLICY "Tenant members can view queue" ON public.message_queue
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant members can insert/manage queue" ON public.message_queue
    FOR ALL USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.9 MESSAGES POLICIES
CREATE POLICY "Tenant members can view messages" ON public.messages
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant members can manage messages" ON public.messages
    FOR ALL USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.10 MESSAGE_LOGS POLICIES
CREATE POLICY "Tenant members can view logs" ON public.message_logs
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.11 BUSY_COMPANIES POLICIES
CREATE POLICY "Tenant members can view busy companies" ON public.busy_companies
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant members can manage busy companies" ON public.busy_companies
    FOR ALL USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.12 BUSY_CONNECTIONS POLICIES
CREATE POLICY "Tenant members can view busy connections" ON public.busy_connections
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant admins can manage busy connections" ON public.busy_connections
    FOR ALL USING (public.is_tenant_admin(tenant_id) OR public.is_platform_admin());

-- 5.13 LICENSES POLICIES
CREATE POLICY "Tenant members can view licenses" ON public.licenses
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.14 PLANS POLICIES (Public read for active plans)
CREATE POLICY "Anyone can view active plans" ON public.plans
    FOR SELECT USING (is_active = TRUE OR public.is_platform_admin());

-- 5.15 SUBSCRIPTIONS POLICIES
CREATE POLICY "Tenant members can view subscriptions" ON public.subscriptions
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.16 USAGE_DAILY POLICIES
CREATE POLICY "Tenant members can view daily usage" ON public.usage_daily
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

-- 5.17 SETTINGS POLICIES
CREATE POLICY "Tenant members can view settings" ON public.settings
    FOR SELECT USING (public.is_tenant_member(tenant_id) OR public.is_platform_admin());

CREATE POLICY "Tenant admins can manage settings" ON public.settings
    FOR ALL USING (public.is_tenant_admin(tenant_id) OR public.is_platform_admin());

-- 5.18 AUDIT_LOGS POLICIES
CREATE POLICY "Tenant admins can view audit logs" ON public.audit_logs
    FOR SELECT USING (public.is_tenant_admin(tenant_id) OR public.is_platform_admin());

-- ==============================================================================
-- 6. AUTOMATED TRIGGERS (Updated Timestamps & User Onboarding)
-- ==============================================================================

-- 6.1 Generic updated_at trigger function
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to applicable tables
CREATE TRIGGER trigger_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_tenants_updated_at BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_devices_updated_at BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_whatsapp_accounts_updated_at BEFORE UPDATE ON public.whatsapp_accounts FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_message_templates_updated_at BEFORE UPDATE ON public.message_templates FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_message_queue_updated_at BEFORE UPDATE ON public.message_queue FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_busy_companies_updated_at BEFORE UPDATE ON public.busy_companies FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_busy_connections_updated_at BEFORE UPDATE ON public.busy_connections FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_settings_updated_at BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 6.2 Auto-Provision Profile, Tenant & Default Subscription on User Signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    new_tenant_id UUID;
    trial_plan_id UUID;
    business_name TEXT;
BEGIN
    -- Extract business name from metadata or default to user's name
    business_name := COALESCE(NEW.raw_user_meta_data->>'business_name', 'My Company');

    -- 1. Create Profile
    INSERT INTO public.profiles (id, email, full_name, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        NEW.raw_user_meta_data->>'avatar_url'
    );

    -- 2. Create Default Tenant
    INSERT INTO public.tenants (name, business_name, status)
    VALUES (business_name, business_name, 'ACTIVE')
    RETURNING id INTO new_tenant_id;

    -- 3. Link User to Tenant as SUPER_ADMIN
    INSERT INTO public.tenant_users (tenant_id, user_id, role)
    VALUES (new_tenant_id, NEW.id, 'SUPER_ADMIN');

    -- 4. Assign 14-Day Free Trial Subscription
    SELECT id INTO trial_plan_id FROM public.plans WHERE slug = 'free-trial' LIMIT 1;
    IF trial_plan_id IS NOT NULL THEN
        INSERT INTO public.subscriptions (
            tenant_id,
            plan_id,
            status,
            start_date,
            end_date
        ) VALUES (
            new_tenant_id,
            trial_plan_id,
            'TRIAL',
            NOW(),
            NOW() + INTERVAL '14 days'
        );
    END IF;

    -- 5. Audit Log
    INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, details)
    VALUES (new_tenant_id, NEW.id, 'USER_REGISTERED', 'auth.users', jsonb_build_object('email', NEW.email));

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger on auth.users insert
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ==============================================================================
-- 7. SEED DATA (Standard Subscription Plans)
-- ==============================================================================

INSERT INTO public.plans (name, slug, description, price, currency, billing_cycle, message_limit, device_limit, whatsapp_limit, features)
VALUES 
    (
        'Free Trial',
        'free-trial',
        '14-day free trial with basic WhatsApp & BUSY automation features.',
        0,
        'INR',
        'monthly',
        200,
        1,
        1,
        '["1 WhatsApp Account", "1 Windows Agent", "200 Messages", "Basic BUSY Reminders", "Community Support"]'::jsonb
    ),
    (
        'Starter',
        'starter',
        'Ideal for small retailers and single-workstation BUSY businesses.',
        799,
        'INR',
        'monthly',
        5000,
        1,
        2,
        '["2 WhatsApp Accounts", "1 Windows Agent", "5,000 Messages/mo", "Automated Invoice PDF", "Outstanding Reminders", "Standard Support"]'::jsonb
    ),
    (
        'Growth',
        'growth',
        'For growing businesses with multi-branch BUSY setups and bulk marketing.',
        1999,
        'INR',
        'monthly',
        25000,
        3,
        5,
        '["5 WhatsApp Accounts", "3 Windows Agents", "25,000 Messages/mo", "PDC Cheque Alerts", "Batch Stock Bot", "Bulk Campaigns", "Priority Support"]'::jsonb
    ),
    (
        'Enterprise',
        'enterprise',
        'High-volume automation for large distributors and enterprises.',
        4999,
        'INR',
        'monthly',
        100000,
        10,
        10,
        '["10 WhatsApp Accounts", "10 Windows Agents", "100,000 Messages/mo", "Custom Templates", "Multi-Firm Consolidation", "Dedicated SLA", "24/7 Phone Support"]'::jsonb
    )
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    price = EXCLUDED.price,
    message_limit = EXCLUDED.message_limit,
    device_limit = EXCLUDED.device_limit,
    whatsapp_limit = EXCLUDED.whatsapp_limit,
    features = EXCLUDED.features;
