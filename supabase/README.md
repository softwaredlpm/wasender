# WASENDER Supabase Setup & Migration Guide

## 1. Migration Overview

The migration file located at:
`supabase/migrations/20260918000001_initial_saas_schema.sql`

implements a production-ready multi-tenant PostgreSQL schema supporting 100+ isolated tenants with:
- **18 Relational Tables** covering Profiles, Tenants, Devices, WhatsApp Accounts, Contacts, Templates, Message Queue, Logs, BUSY Companies, Licenses, and Razorpay Subscriptions.
- **Strict Row Level Security (RLS)** applied across all tables.
- **Zero-Recursion Security Definer Functions** (`is_tenant_member`, `is_tenant_admin`, `get_auth_tenant_ids`) preventing recursive lockups.
- **Automated User Onboarding Trigger** (`handle_new_user`) that auto-creates the user's Profile, Default Organization (Tenant), links them as `SUPER_ADMIN`, and provisions a 14-day Free Trial subscription upon signup.
- **Optimized Indexes** on critical query paths (queue dispatch, device polling, contact lookups, telemetry).
- **Default SaaS Plans**: Free Trial, Starter (₹799/mo), Growth (₹1,999/mo), and Enterprise (₹4,999/mo).

---

## 2. How to Apply the Migration

### Option A: Using the Supabase Web Dashboard (Fastest)
1. Log into your [Supabase Dashboard](https://supabase.com/dashboard).
2. Open your project.
3. In the left navigation, click on **SQL Editor**.
4. Click **New query**.
5. Copy and paste the entire contents of:
   `supabase/migrations/20260918000001_initial_saas_schema.sql`
6. Click **Run** (or press `Ctrl+Enter`).
7. Confirm that all tables, RLS policies, functions, and seed rows are created.

### Option B: Using the Supabase CLI
If using the Supabase CLI locally:
```bash
# Link your local project to your remote Supabase project
npx supabase link --project-ref your-project-ref

# Push database migrations to remote
npx supabase db push
```

---

## 3. Schema Entity Relationship Summary

```
                       ┌────────────────┐
                       │   auth.users   │
                       └───────┬────────┘
                               │ 1:1
                               ▼
                       ┌────────────────┐
                       │    profiles    │
                       └───────┬────────┘
                               │
            ┌──────────────────┴──────────────────┐
            │ M:N via tenant_users                │
            ▼                                     ▼
     ┌─────────────┐                      ┌───────────────┐
     │   tenants   │◄─────────────────────┤ tenant_users  │
     └──────┬──────┘                      └───────────────┘
            │ 1:N
            ├──────────────────────┬──────────────────────┬──────────────────────┐
            ▼                      ▼                      ▼                      ▼
     ┌─────────────┐        ┌─────────────┐        ┌─────────────┐        ┌──────────────┐
     │   devices   │        │  contacts   │        │  templates  │        │busy_companies│
     └──────┬──────┘        └──────┬──────┘        └─────────────┘        └──────────────┘
            │ 1:N                  │
            ▼                      │
  ┌──────────────────┐             │
  │whatsapp_accounts │             │
  └─────────┬────────┘             │
            │                      │
            └──────────┬───────────┘
                       │
                       ▼
             ┌───────────────────┐
             │   message_queue   │
             └─────────┬─────────┘
                       │ 1:N
                       ▼
             ┌───────────────────┐
             │   message_logs    │
             └───────────────────┘
```

---

## 4. Verification & Testing

To test and validate the migration structure at any time, run:
```bash
node scripts/test-schema.js
```
