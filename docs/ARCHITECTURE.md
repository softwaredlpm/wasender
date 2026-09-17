# WASENDER SaaS Architecture Specification

## 1. Executive Summary

**WASENDER** is evolving from a standalone single-machine Windows utility into an enterprise-grade, multi-tenant Software-as-a-Service (SaaS) platform supporting 100+ concurrent businesses/tenants. 

The core architectural invariant is that **BUSY Accounting Software and WhatsApp sessions (`whatsapp-web.js`) MUST remain on the customer's local Windows PC**. The Cloud infrastructure coordinates, queues, monitors, and interfaces with customer agents over secure, real-time encrypted channels without exposing internal customer network credentials or hosting WhatsApp browser sessions in cloud environments.

---

## 2. High-Level Architecture Overview

```
                          ┌─────────────────────────────────────────┐
                          │               CLOUD LAYER               │
                          │                                         │
                          │   ┌─────────────────────────────────┐   │
                          │   │         Vercel Frontend         │   │
                          │   │  - Modern Multi-Tenant Web UI   │   │
                          │   │  - Online WhatsApp Control & QR │   │
                          │   │  - Bulk Messaging & Contacts    │   │
                          │   │  - Analytics & Audit Logs       │   │
                          │   └────────────────┬────────────────┘   │
                          │                    │ HTTPS / WSS        │
                          │                    ▼                    │
                          │   ┌─────────────────────────────────┐   │
                          │   │         VPS Backend API         │   │
                          │   │  - Node.js + Express (REST v1)  │   │
                          │   │  - Secure WebSocket Server      │   │
                          │   │  - Razorpay Webhooks & Billing  │   │
                          │   │  - Cloud Message Dispatcher     │   │
                          │   └─────────┬──────────────┬────────┘   │
                          │             │              │            │
                          │             ▼              ▼            │
                          │     ┌───────────────┐ ┌───────────────┐ │
                          │     │   Supabase    │ │ Cloudflare R2 │ │
                          │     │  PostgreSQL   │ │  (Temporary   │ │
                          │     │   Auth + RLS  │ │  Bulk Assets) │ │
                          │     └───────────────┘ └───────────────┘ │
                          └─────────────────────┼───────────────────┘
                                                │ Secure WebSocket (WSS)
                                                │ Device-Authenticated Heartbeats
                                                ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           CUSTOMER ON-PREMISE ENVIRONMENT                        │
│                               (Windows PC / Server)                              │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │                         WASENDER Windows Agent                           │   │
│   │                                                                          │   │
│   │  ┌───────────────────────┐                    ┌───────────────────────┐  │   │
│   │  │   Cloud Sync Client   │                    │ Local API Server      │  │   │
│   │  │  - WSS Secure Channel │                    │ - localhost:5000      │  │   │
│   │  │  - Heartbeat / Status │                    │ - BUSY Webhook Hook   │  │   │
│   │  │  - Remote Queue Exec  │                    │ - Port Registry       │  │   │
│   │  │  - Offline Cache Sync │                    └───────────▲───────────┘  │   │
│   │  └──────────┬────────────┘                                │              │   │
│   │             │                                             │ HTTP         │   │
│   │             ▼                                             │              │   │
│   │  ┌───────────────────────┐                    ┌───────────┴───────────┐  │   │
│   │  │    whatsapp-web.js    │                    │    BUSY Automation    │  │   │
│   │  │  - Chromium Headless  │                    │  - busy_service.js    │  │   │
│   │  │  - LocalAuth Sessions │                    │  - busy_db_bridge.ps1 │  │   │
│   │  │  - Anti-Ban Typing    │                    │  - MSSQL / Access     │  │   │
│   │  │  - Stream QR base64   │                    │  - PDC Cheque Alerts  │  │   │
│   │  └───────────────────────┘                    └───────────┬───────────┘  │   │
│   └───────────────────────────────────────────────────────────┼──────────────┘   │
│                                                               │                  │
│                                                               ▼                  │
│                                                   ┌───────────────────────┐      │
│                                                   │    BUSY Accounting    │      │
│                                                   │  (MS SQL / Access DB) │      │
│                                                   └───────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Component Boundaries

### 3.1 Cloud Layer (Vercel + VPS + Supabase)
1. **Frontend (Vercel)**:
   - Next.js / Vite Single Page Application for customer & admin dashboards.
   - Real-time QR display via WebSocket listener (ephemeral stream, never persisted).
   - Contact book management, tag allocation, Excel/CSV bulk import.
   - Message template builder with mustache variable interpolation (`{{customer_name}}`, `{{amount}}`, `{{invoice_no}}`).
   - Subscription checkout via Razorpay Checkout SDK.

2. **Backend API & WebSocket Server (VPS - Node.js/Express)**:
   - Central point of control exposed over HTTPS/WSS.
   - Terminates Agent connections via authenticated WebSocket handshake (`X-Device-Token`, `X-Tenant-Id`).
   - Dispatches queued messages from Supabase to targeted Agent instances.
   - Processes Razorpay webhooks for plan upgrade, downgrade, and renewal.
   - Rate limiting, IP throttling, and audit log generation.

3. **Database & Auth (Supabase PostgreSQL)**:
   - Stores profiles, tenants, devices, accounts, contact lists, templates, message logs, and subscriptions.
   - Enforces strict **Row Level Security (RLS)** on all tables based on the authenticated user's `tenant_id`.

4. **Object Storage (Cloudflare R2)**:
   - Stores permanent media assets (e.g., promotional flyers, broadcast image catalogs) used in bulk campaigns.
   - **Strict exclusion**: BUSY invoice PDFs are **NEVER** stored in R2.

---

### 3.2 Customer On-Premise Layer (Windows Agent)
1. **Windows Service / System Tray Agent (`WASENDER-Agent.exe`)**:
   - Runs on the customer's machine where BUSY Accounting is installed.
   - Stores local state in encrypted `agent.config.json` (device ID, tenant ID, hashed device token).
   - Connects outbound to `wss://api.wasender.com/agent` (no inbound firewall port forwarding required for cloud control!).

2. **Local WhatsApp Engine (`whatsapp-web.js`)**:
   - Manages Puppeteer/Chromium instances with `LocalAuth` sessions persisted in `%AppData%/WASENDER/.wwebjs_auth`.
   - Generates QR codes and phone pairing codes; pipes them via WSS to VPS for browser display.
   - Emulates human typing behavior (`chat.sendStateTyping`), jitter delays, and zero-width text randomization to protect accounts from WhatsApp spam detection.

3. **BUSY Database Bridge & Automation**:
   - Executes local queries against MS Access (`.mdb`) or Microsoft SQL Server (`BUSYCompxxxx_db12025`) using PowerShell ADO/OLEDB (`busy_db_bridge.ps1`).
   - Computes ledger balances, bill-by-bill aging schedules, and Post-Dated Cheque (PDC) maturities.
   - Generates customized balance and stock PDF reports locally via Puppeteer.
   - Accepts real-time invoice dispatch webhooks from BUSY via `http://localhost:5000/api/v1/send`.

---

## 4. Multi-Tenant Isolation Model

Data separation is enforced at three distinct layers:

```
[User JWT] ──> [Tenant Context (tenant_id)] ──> [Supabase RLS Policies] ──> [Agent Scoping]
```

1. **Database Schema Level**:
   - Every multi-tenant table has a non-nullable `tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE`.
   - Primary and composite foreign keys ensure devices, WhatsApp accounts, contacts, and queues cannot cross boundaries.
2. **Supabase Row Level Security (RLS)**:
   ```sql
   CREATE POLICY "Tenant Isolation Policy" ON contacts
   FOR ALL USING (
       tenant_id IN (
           SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()
       )
   );
   ```
3. **Application & WebSocket Level**:
   - The VPS maintains an in-memory socket routing table:
     ```js
     Map<tenant_id, Map<device_id, WebSocketConnection>>
     ```
   - When a user on the Vercel dashboard triggers a message or requests a QR code, the VPS routes the command exclusively to the socket registered for that `(tenant_id, device_id)`. Broadcast across tenants is physically impossible.

---

## 5. Security & Credential Architecture

| Asset / Credential | Storage Location | Exposure Risk Mitigation |
| :--- | :--- | :--- |
| **Supabase Service Role Key** | VPS Backend `.env` only | Never sent to Vercel frontend or Windows Agent. |
| **Agent Authentication Token** | Generated on cloud, stored in Agent config | Stored as bcrypt/SHA-256 hash in `devices.agent_token_hash`. Handshake uses signed nonces. |
| **BUSY DB Passwords** | Local Windows Agent `busy_config.json` | Stored locally using Windows DPAPI (Data Protection API) or AES-256 local key. Never leaves the customer PC. |
| **WhatsApp Sessions** | Local `%AppData%/WASENDER/.wwebjs_auth` | Puppeteer browser cookies and authentication tokens stay entirely on customer machine. |
| **Temporary Invoices** | Local `%TEMP%/WASENDER/invoices/` | Deleted immediately following WhatsApp transmission confirmation or after 24 hours. |
| **QR Codes** | RAM / WebSocket pipeline | Streamed as ephemeral base64 payloads; never written to Supabase tables. |

---

## 6. Offline Mode & Idempotency Guarantee

When the customer's internet connection drops:
1. **Local Queue Persistence**:
   - The Agent writes outgoing BUSY trigger requests to an encrypted local queue (`agent_queue.db` / SQLite or structured JSON).
   - BUSY continues generating and queuing invoices locally without failing business workflows.
2. **Connectivity Recovery & Idempotent Sync**:
   - The Agent continually tests DNS connectivity (`google.com`).
   - Upon network restoration, the Agent initiates an idempotency handshake:
     ```
     POST /api/v1/agent/sync-status
     Body: [{ local_job_id, hash, mobile, timestamp }]
     ```
   - The cloud responds with job states to prevent duplicate transmissions (`SENT`, `FAILED`, `PENDING`).
3. **Deduplication Window**:
   - An in-memory and database 15-minute deduplication window `(tenant_id, phone, message_digest)` guarantees no duplicate message is sent over WhatsApp.

---

## 7. Operational Lifecycles

### 7.1 Online WhatsApp QR Flow
```
User clicks "Connect" on Vercel Dashboard
    │
    ▼ HTTPS
VPS API receives request, validates tenant session
    │
    ▼ WebSocket Event: "whatsapp:request_qr"
Customer Agent receives event, calls whatsapp-web.js client.initialize()
    │
    ▼ Event: "qr" (base64 string)
Agent emits "agent:qr_generated" to VPS over WSS
    │
    ▼ WebSocket Event to Vercel client
User scans QR in mobile WhatsApp app
    │
    ▼ Event: "ready"
Agent notifies VPS: "agent:whatsapp_ready" with phone number and pushname
    │
    ▼ DB Update
Supabase updates whatsapp_accounts: status = 'CONNECTED', last_seen = NOW()
```

### 7.2 BUSY Invoice Automation Flow
```
BUSY Accounting emits voucher/invoice (via SMS/WhatsApp config)
    │
    ▼ HTTP POST http://localhost:5000/api/v1/send?Mobile=...&pdfPath=...
Agent receives request, validates file existence
    │
    ▼ Generate unique voucher hash + Job ID
Agent queues message locally and pushes metadata event to Cloud:
    "tenant_id", "device_id", "phone", "invoice_no", "amount", "status: PROCESSING"
    │
    ▼ whatsapp-web.js sends media + text caption to customer
whatsapp-web.js confirms delivery message ID: (e.g. true_919876543210@c.us_...)
    │
    ▼ Local Cleanup
Agent securely unlinks (deletes) temporary PDF from disk
    │
    ▼ Final Cloud Sync
Supabase updates message_logs: status = 'SENT', sent_at = NOW()
```
