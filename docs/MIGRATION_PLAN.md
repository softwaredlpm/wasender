# WASENDER Incremental SaaS Migration Plan

## 1. Guiding Principles & Non-Negotiable Rules

1. **Zero Downtime for Local Users**: The working local Windows application (`server.js` / `busy_service.js`) must remain functional and testable at every intermediate milestone.
2. **Local Execution Invariant**: Neither BUSY database access nor `whatsapp-web.js` browser sessions may ever be shifted into the cloud. Both stay local on the customer's Windows machine.
3. **Strict Multi-Tenant Isolation**: Every database table, API route, queue entry, and WebSocket transmission must be hard-scoped by `tenant_id`.
4. **Temporary Artifact Discipline**: BUSY invoice PDFs generated on the customer's PC are strictly temporary files; they are transmitted and immediately purged from disk. They are never retained in cloud storage.
5. **Phase Gate Approval**: No subsequent phase shall be started until the current phase is fully implemented, verified, and approved.

---

## 2. Phase-by-Phase Roadmap

### Phase 1: Project Audit & Architecture Documentation *(CURRENT PHASE — COMPLETE)*
- [x] Full source code inspection of `server.js`, `server.cjs`, `busy_service.js`, `busy_db_bridge.ps1`, JSON data files, and batch scripts.
- [x] Production of `/docs/ARCHITECTURE.md`, `/docs/PROJECT_AUDIT.md`, `/docs/API_MAP.md`, and `/docs/MIGRATION_PLAN.md`.
- [x] Establish boundary models between Cloud (Vercel/VPS/Supabase) and Edge (Windows PC).

---

### Phase 2: Supabase Schema, Migrations & Row Level Security (RLS)
- **Goal**: Create the relational foundation with enterprise-grade multi-tenant isolation.
- **Deliverables**:
  - Migration script: `/supabase/migrations/20260918000001_initial_saas_schema.sql`
  - Tables: `profiles`, `tenants`, `tenant_users`, `devices`, `whatsapp_accounts`, `contacts`, `message_templates`, `message_queue`, `messages`, `message_logs`, `busy_companies`, `busy_connections`, `licenses`, `plans`, `subscriptions`, `usage_daily`, `settings`, `audit_logs`.
  - Postgres RLS policies for all tables referencing `tenant_id`.
  - Automated tenant provisioning trigger on user signup (`handle_new_user`).
- **Verification**: Run SQL unit tests verifying that User A from Tenant 1 cannot select or insert records into Tenant 2.

---

### Phase 3: Cloud Authentication & Tenant Management
- **Goal**: Setup auth and multi-tenant user access controls on VPS API and Vercel.
- **Deliverables**:
  - Express middleware: `authenticateUser` verifying Supabase JWT.
  - Context extractor: Resolves `(user_id, tenant_id, role)`.
  - Endpoints for user profile, tenant settings, and invite team members.
  - Role hierarchy: `SUPER_ADMIN`, `ADMIN`, `USER`.
- **Verification**: Postman / automated test suite ensuring valid JWTs access appropriate tenant scopes and invalid JWTs are rejected (401/403).

---

### Phase 4: Windows Agent Authentication & Device Registration
- **Goal**: Establish cryptographically secure pairing between a customer's Windows PC and their Cloud tenant.
- **Deliverables**:
  - Local Agent package structure in `/agent/`.
  - Cloud pairing flow: Customer generates an Agent Registration Token in Web UI.
  - Agent initial registration command: exchanges one-time token for permanent device token.
  - Agent stores token hash locally in encrypted `agent.config.json`.
  - Cloud table `devices` stores `agent_token_hash` with `last_seen` tracking.
- **Verification**: Agent connects, verifies handshake with Cloud API, and reports device name/version.

---

### Phase 5: Cloud ↔ Agent Real-Time WebSocket Infrastructure
- **Goal**: Bi-directional, real-time communication channel between VPS API and Windows Agent.
- **Deliverables**:
  - VPS WebSocket server (`ws` or `socket.io`) listening on `wss://api.wasender.com/agent`.
  - Agent WebSocket client with exponential backoff auto-reconnect.
  - Handshake authentication via `X-Device-Token`.
  - Core event channels: `agent:heartbeat`, `agent:status`, `whatsapp:request_qr`, `whatsapp:qr`, `whatsapp:ready`, `queue:dispatch`, `queue:status`.
- **Verification**: Agent connects over WebSocket; VPS dashboard reflects online status within 1 second; simulated disconnect triggers auto-reconnect.

---

### Phase 6: WhatsApp Integration & Cloud Remote Control
- **Goal**: Wrap existing `whatsapp-web.js` logic in the Agent to accept commands from WebSocket.
- **Deliverables**:
  - Port existing session manager from `server.js` into `/agent/src/whatsapp/session_manager.js`.
  - Support multi-account LocalAuth persistence in `%AppData%/WASENDER/.wwebjs_auth`.
  - Preserve anti-ban algorithms: zero-width space randomization (`randomizeText`), human typing simulation (`sendStateTyping`), and contact resolution.
  - Cloud triggers: Initialize client, clear session, restart client.
- **Verification**: Cloud sends command to Agent; Agent initializes WhatsApp client locally and reports state transitions (`authenticating` -> `ready`).

---

### Phase 7: Online WhatsApp QR Display
- **Goal**: Display live QR code in the cloud browser without storing QR images on disk or database.
- **Deliverables**:
  - Agent captures `client.on('qr', qrCodeBase64)` and streams base64 payload over WebSocket.
  - VPS routes payload strictly to the tenant's active browser socket.
  - Vercel Web UI renders QR code with a 20-second refresh countdown.
  - Support for 8-digit phone pairing codes as alternative to QR.
- **Verification**: User scans QR on phone; Agent completes authentication; Web UI automatically transitions from QR modal to "WhatsApp Connected" badge.

---

### Phase 8: Cloud Message Queue & Dispatch Engine
- **Goal**: Centralized message scheduling and execution pipeline.
- **Deliverables**:
  - Cloud queues jobs in Supabase `message_queue` with statuses: `PENDING`, `PROCESSING`, `SENT`, `FAILED`, `RETRY`.
  - VPS message dispatcher pulls tenant jobs and routes them over WebSocket to the designated Agent.
  - Agent executes jobs using local `whatsapp-web.js` and reports delivery receipts (`true_919876543210@c.us_...`).
  - Idempotency guarantees: Database unique constraints prevent duplicate submissions.
- **Verification**: Enqueue 100 sample messages from Web UI; observe disciplined batching (10 at a time, 20s gap, 8-10s jitter) on the Windows Agent.

---

### Phase 9: Contacts, Templates & File Attachments
- **Goal**: Full-featured contact book, template variables, and campaign management.
- **Deliverables**:
  - Contact management with tags and CSV/Excel import in Web UI.
  - Message template engine with mustache interpolation: `{{customer_name}}`, `{{amount}}`, `{{invoice_no}}`.
  - Attachment pipeline for marketing materials: Cloudflare R2 temporary storage for broadcast media (PDF, JPG, PNG, DOCX).
- **Verification**: Import CSV with 50 contacts; send personalized bulk messages with an attached flyer; verify receipt across numbers.

---

### Phase 10: BUSY On-Premise Connection & Management
- **Goal**: Interface Cloud UI with local BUSY installations securely.
- **Deliverables**:
  - Adapt `busy_service.js` and `busy_db_bridge.ps1` to run as Agent modules.
  - Agent syncs company names (`busy_companies`) to Cloud metadata.
  - Cloud UI allows selecting active firm, viewing account groups, and verifying DB path connectivity via Agent WebSocket RPC.
- **Verification**: Cloud UI displays list of BUSY firms configured on the local machine without cloud possessing direct database credentials.

---

### Phase 11: BUSY Invoice & Voucher Automation
- **Goal**: Real-time invoice dispatch and scheduled payment reminders.
- **Deliverables**:
  - Keep local webhook active: `http://localhost:5000/api/v1/send` for direct BUSY software configuration.
  - When BUSY generates invoice, Agent catches it, creates temporary PDF, queues WhatsApp message, and syncs log metadata to Cloud.
  - Agent deletes temporary PDF immediately upon confirmation of WhatsApp delivery.
  - Support scheduled outstanding balance reminders and PDC cheque alerts.
- **Verification**: Trigger a test invoice in BUSY; observe immediate WhatsApp dispatch to recipient with invoice PDF attached, followed by immediate local PDF deletion.

---

### Phase 12: Logs, Analytics & Usage Metering
- **Goal**: Real-time auditing and delivery tracking for tenants.
- **Deliverables**:
  - Agent streams delivery logs to VPS, which writes to Supabase `message_logs`.
  - Cloud UI provides searchable, filterable logs with status badges (`SENT`, `FAILED`, `PENDING`).
  - Daily usage aggregation (`usage_daily`) tracking sent/failed counts per tenant.
- **Verification**: Audit logs update in real-time in the Web UI as messages are processed by the Agent.

---

### Phase 13: Licensing, Plans & Razorpay Subscriptions
- **Goal**: Monetization, quota enforcement, and automated billing.
- **Deliverables**:
  - Tiered plans in Supabase: Basic, Pro, Enterprise with message and device limits.
  - Razorpay checkout integration on Vercel frontend.
  - Razorpay webhook handler on VPS API updating `subscriptions` table.
  - Quota enforcement middleware blocking queue insertions if tenant limits are exceeded.
- **Verification**: Complete test transaction in Razorpay sandbox; confirm tenant subscription flips to `ACTIVE` and quotas update.

---

### Phase 14: Admin & Tenant Dashboards
- **Goal**: Modern, responsive interfaces for both SaaS operators and end customers.
- **Deliverables**:
  - Customer Dashboard: WhatsApp status, BUSY connection status, message counters, quick send, active queue.
  - Super Admin Dashboard: Total tenants, active MRR, total messages sent, online devices, and platform health.
- **Verification**: Responsive testing across Desktop, Tablet, and Mobile viewport sizes.

---

### Phase 15: Security Hardening & Penetration Defense
- **Goal**: Comprehensive security audit.
- **Deliverables**:
  - Rate limiting with Redis / in-memory tokens.
  - Strict CORS policy and helmet protection.
  - Sanitize all inputs against SQL injection and XSS.
  - Verification that no secrets exist in Git or client bundles.
- **Verification**: Automated security scanner run against API endpoints.

---

### Phase 16: Windows Agent Packaging (`WASENDER-Agent.exe`)
- **Goal**: Single-click installer / executable for the Windows Agent.
- **Deliverables**:
  - Standalone executable packaged using `pkg`.
  - Windows System Tray icon displaying connection status (Cloud: Connected, WhatsApp: Online, BUSY: Active).
  - Background service option using NSSM or Windows Task Scheduler.
- **Verification**: Fresh install on a clean Windows machine without Node.js installed; verify successful execution.

---

### Phase 17: Production Deployment
- **Goal**: Go live on production infrastructure.
- **Deliverables**:
  - Frontend deployed on Vercel (`app.wasender.com`).
  - API & WebSocket deployed on Ubuntu VPS via PM2 with SSL (Let's Encrypt).
  - Production Supabase instance configured with automated backups.
- **Verification**: End-to-end smoke test on production URLs.

---

### Phase 18: Progressive Scalability & Load Testing
- **Goal**: Validate architecture under growing tenant load.
- **Steps**:
  - 1 Tenant (Baseline sanity).
  - 5 Tenants (Multi-account concurrency).
  - 10 Tenants (WebSocket connection stability).
  - 25 Tenants (Queue throughput under burst load).
  - 50 Tenants (Database connection pooling and RLS efficiency).
  - 100 Tenants (Simultaneous bulk campaign stress test).

---

## 3. Data Migration Strategy (`migrate-json-to-supabase.js`)

Existing customer data stored in local JSON files will be migrated using an automated CLI script:
1. **`users.json`**:
   - The primary admin account is migrated into Supabase `auth.users` and linked to an initial tenant.
2. **`busy_config.json`**:
   - Company records are inserted into `busy_companies` (name, GST, address) for cloud visibility. Sensitive database connection strings remain locally in `agent.config.json`.
3. **`client_names.json`**:
   - Linked accounts are inserted into `whatsapp_accounts` with status `DISCONNECTED` pending agent reconnection.

---

## 4. Phase 1 Completion Summary

Phase 1 has established the complete technical blueprints, boundaries, API contracts, and risk mitigations required to incrementally transform WASENDER into a multi-tenant SaaS.

**Next Immediate Step**: Proceed with **Phase 2: Supabase Schema, Migrations & Row Level Security (RLS)** upon user approval.
