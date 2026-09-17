# WASENDER Complete API Specification & Route Map

## 1. Existing Legacy API Endpoints (server.js & Sub-Servers)

### 1.1 WhatsApp & Client Session Management
| Method | Route | Parameters | Description / Purpose | Existing Auth |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/status` | None | Returns global status of default WhatsApp client, queue metrics, and license info. | None |
| `GET` | `/api/v1/qr` | None | Returns base64 QR code string for default client or connection status. | None |
| `GET` | `/api/v1/clients` | None | Lists all active WhatsApp clients, port assignments, and ready statuses. | None |
| `POST` | `/api/v1/clients/add` | `{ name }` | Registers a new WhatsApp client instance, allocates port, and initializes LocalAuth. | None |
| `POST` | `/api/v1/clients/rename`| `{ clientId, name }` | Updates the human-readable display name for a client. | None |
| `POST` | `/api/v1/clients/delete`| `{ clientId }` | Destroys client, releases port, and wipes session folder `.wwebjs_auth/session-<id>`. | None |
| `POST` | `/api/v1/clients/pairing-code` | `{ phoneNumber, clientId }` | Requests an 8-digit WhatsApp phone pairing code instead of scanning a QR code. | None |
| `POST` | `/api/v1/clear-session`| `{ clientId }` | Logs out client from WhatsApp and purges auth cache without deleting port config. | None |
| `GET` | `/api/v1/debug-screenshot` | None | Captures raw Puppeteer screenshot for visual debugging during connection failures. | None |

---

### 1.2 Messaging & Bulk Dispatch
| Method | Route | Parameters | Description / Purpose | Existing Auth |
| :--- | :--- | :--- | :--- | :--- |
| `ALL` | `/api/v1/send` | Query/Body: `Mobile`, `Message`, `pdfPath`, `whatsappClientId` OR `multipart/form-data` | **Primary Unified Send Endpoint**. Accepts single text or media message. Queues at head of queue for instant delivery. Supports BUSY `<PDFPATH>`. | None |
| `ALL` | `/send` | Same as `/api/v1/send` | Alias for backward compatibility with external integrations. | None |
| `POST` | `/api/v1/bulk-upload` | Multipart file: `file` (Excel/CSV), form fields: `messageTemplate`, `whatsappClientId` | Parses spreadsheet, extracts numbers & template variables, and enqueues bulk jobs with batch spacing. | None |
| `GET` | `/api/v1/download-sample-excel` | None | Generates and streams sample `.xlsx` template file for bulk campaign imports. | None |

---

### 1.3 Queue Management
| Method | Route | Parameters | Description / Purpose | Existing Auth |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/queue` | None | Returns total queue length, pending count, failed count, and message list. | None |
| `POST` | `/api/v1/queue/pause` | None | Pauses in-flight queue consumer loop. | None |
| `POST` | `/api/v1/queue/resume` | None | Resumes queue processing loop and processes pending jobs. | None |
| `POST` | `/api/v1/queue/clear` | `{ type: 'all' \| 'failed' \| 'pending' }` | Clears specified messages from memory and `queue.json`. | None |
| `POST` | `/api/v1/resend` | `{ id }` or `{ number }` | Resets a specific failed job to `pending` and pushes to queue. | None |
| `POST` | `/api/v1/resend-all` | None | Resets all failed jobs in queue to `pending` with retry counter reset. | None |

---

### 1.4 BUSY Accounting Automation Endpoints
| Method | Route | Parameters | Description / Purpose | Existing Auth |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/busy/firms` | None | Returns list of configured firms from `busy_config.json`. | None |
| `POST` | `/api/busy/firms/add` | Firm Object | Creates a new firm configuration entry. | None |
| `POST` | `/api/busy/firms/update` | `{ id, ...firmData }` | Updates an existing firm's database path, credentials, and settings. | None |
| `POST` | `/api/busy/firms/delete` | `{ id }` | Deletes a firm configuration entry. | None |
| `GET` | `/api/busy/config` | None | Returns complete `busy_config.json`. | None |
| `POST` | `/api/busy/config` | Config Object | Writes updated configuration to `busy_config.json`. | None |
| `GET` | `/api/busy/resolve-path` | Query: `firmId` | Executes PowerShell test to verify BUSY database folder and permissions. | None |
| `GET` | `/api/busy/company-info` | Query: `firmId` | Queries BUSY DB for legal company name, GSTIN, and registered address. | None |
| `POST` | `/api/busy/hierarchy` | `{ firmId, parent }` | Returns subgroups and direct child accounts under a group (e.g. Sundry Debtors). | None |
| `POST` | `/api/busy/accounts` | `{ firmId }` | Returns target debtor accounts matching configured group. | None |
| `GET` | `/api/busy/scan` | Query: `firmId` | Scans all accounts in group, returns balance, Dr/Cr status, and phone numbers. | None |
| `POST` | `/api/busy/trigger` | `{ firmId, specificParties }` | Runs bulk reminder automation: computes aging, generates PDF, queues messages. | None |
| `POST` | `/api/busy/trigger-pdc` | `{ firmId }` | Scans Post-Dated Cheques in BUSY and queues reminders for cheques due in 2 days. | None |
| `GET` | `/api/busy/closing-stock`| Query: `firmId`, `search` | Queries BUSY for item closing stock quantities. | None |
| `GET` | `/api/busy/batch-closing-stock` | Query: `firmId`, `search` | Queries batch-wise closing stock breakdown. | Bearer PBKDF2 Token |
| `POST` | `/api/busy/material-centers` | `{ firmId }` | Returns all material centers / warehouses configured in BUSY. | None |
| `POST` | `/api/busy/batch-stock-pdf` | `{ firmId, items }` | Generates a formatted stock status PDF using headless Puppeteer. | None |

---

### 1.5 System, Logs, Payment & Licensing
| Method | Route | Parameters | Description / Purpose | Existing Auth |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/logs` | None | Returns last 1,000 log entries from `logs.json`. | None |
| `POST` | `/api/v1/logs/clear` | None | Flushes all log entries. | None |
| `GET` | `/api/v1/config` | None | Returns `config.json` (license email, etc.). | None |
| `POST` | `/api/v1/config` | Config Object | Updates `config.json`. | None |
| `GET` | `/api/v1/license/info` | None | Queries remote Google Sheets endpoint and returns expiration & tier. | None |
| `GET` | `/api/payment-config` | None | Fetches bank account and UPI details for invoice QR generation. | None |
| `POST` | `/api/payment-config` | Multipart form | Saves payment details and generates dynamic UPI QR image code. | None |

---

### 1.6 Dedicated Per-Account Sub-Servers (Ports 5001–5010)
Each secondary WhatsApp client executes on an independent port:
- `GET http://localhost:500X/status` -> Returns account status, ready state, phone number.
- `GET http://localhost:500X/qr` -> Returns account QR code base64.
- `ALL http://localhost:500X/send` -> Routes message specifically via account `500X`.
- `ALL http://localhost:500X/api/v1/send` -> BUSY compatibility route for account `500X`.
- `POST http://localhost:500X/pairing-code` -> Initiates phone pairing for account `500X`.

---

## 2. Target SaaS API Architecture (REST v1)

In the multi-tenant SaaS architecture, endpoints are split between the **Cloud VPS API Server** (publicly accessible, tenant-authenticated) and the **Customer Windows Agent** (local/outbound WebSocket).

```
                      ┌─────────────────────────────────────────┐
                      │             VPS API SERVER              │
                      │          https://api.wasender.com       │
                      └────┬───────────────────────────────┬────┘
                           │                               │
            Tenant JWT     │                               │ Agent Token Hash
            (Vercel App)   │                               │ (Windows PC)
                           ▼                               ▼
               ┌───────────────────────┐       ┌───────────────────────┐
               │    Cloud Endpoints    │       │    Agent Endpoints    │
               │   /api/v1/auth/*      │       │   /api/v1/agent/*     │
               │   /api/v1/messages/*  │       └───────────────────────┘
               │   /api/v1/contacts/*  │
               │   /api/v1/devices/*   │
               │   /api/v1/busy/*      │
               └───────────────────────┘
```

### 2.1 Cloud API Endpoints (Accessed by Vercel Web Dashboard)
All Cloud API endpoints require: `Authorization: Bearer <Supabase_JWT>`. The user's `tenant_id` is extracted strictly from the validated JWT claims.

#### Authentication & Profile (`/api/v1/auth/*`)
- `POST /api/v1/auth/login` -> Authenticates user via Supabase Auth.
- `POST /api/v1/auth/register` -> Creates user profile and initializes default tenant.
- `GET  /api/v1/auth/me` -> Fetches user details, tenant role, and active subscription.

#### Device & Agent Management (`/api/v1/devices/*`)
- `GET    /api/v1/devices` -> Lists registered customer Windows devices and online/offline status.
- `POST   /api/v1/devices/generate-token` -> Generates a one-time connection token for Agent setup.
- `PATCH  /api/v1/devices/:id` -> Renames device or modifies settings.
- `DELETE /api/v1/devices/:id` -> Revokes device authorization and closes active WebSocket.

#### WhatsApp Control (`/api/v1/whatsapp/*`)
- `GET  /api/v1/whatsapp/accounts` -> Lists linked WhatsApp accounts across all tenant devices.
- `POST /api/v1/whatsapp/request-qr` -> Emits WebSocket event to target Agent to generate a fresh QR.
- `POST /api/v1/whatsapp/pair-phone` -> Requests 8-character pairing code from Agent.
- `POST /api/v1/whatsapp/disconnect` -> Instructs Agent to log out account and destroy session.

#### Contacts & Templates (`/api/v1/contacts/*` & `/api/v1/templates/*`)
- `GET    /api/v1/contacts` -> Paginated contact list with tag filtering and search.
- `POST   /api/v1/contacts` -> Adds or updates contacts.
- `POST   /api/v1/contacts/import-csv` -> Parses and bulk inserts contacts into Supabase.
- `GET    /api/v1/templates` -> Lists saved message templates.
- `POST   /api/v1/templates` -> Creates a reusable message template with variables.

#### Cloud Queue & Bulk Messaging (`/api/v1/messages/*`)
- `POST /api/v1/messages/bulk-send` -> Creates batch records in `message_queue`.
- `GET  /api/v1/messages/queue` -> Returns tenant queue status, pending, and failures.
- `POST /api/v1/messages/queue/pause` -> Sets tenant queue state to paused.
- `POST /api/v1/messages/queue/resume` -> Resumes queue dispatch.
- `POST /api/v1/messages/queue/retry-failed` -> Re-enqueues failed items.

#### Subscriptions & Billing (`/api/v1/subscriptions/*`)
- `GET  /api/v1/subscriptions/plans` -> Available subscription tiers and feature limits.
- `POST /api/v1/subscriptions/create-order` -> Creates Razorpay order.
- `POST /api/v1/subscriptions/webhook` -> Razorpay payment confirmation webhook.

---

### 2.2 Agent Cloud-Facing Endpoints (`/api/v1/agent/*`)
Accessed by the Windows Agent using `X-Device-Token` header:
- `POST /api/v1/agent/register` -> First-time handshake; exchanges one-time setup code for persistent device token.
- `POST /api/v1/agent/heartbeat` -> Transmits device metrics, CPU load, and connected WhatsApp statuses.
- `GET  /api/v1/agent/queue` -> Pulls pending queue items assigned to this `(tenant_id, device_id)`.
- `POST /api/v1/agent/message-status` -> Reports final delivery outcome (`SENT` with message ID or `FAILED` with reason).
- `POST /api/v1/agent/sync-offline` -> Replays messages processed while offline for ledger synchronization.

---

## 3. Legacy-to-SaaS Endpoint Transition Matrix

| Existing Endpoint | Destination in SaaS Architecture | Protocol | Notes |
| :--- | :--- | :--- | :--- |
| `ALL /api/v1/send` | **PRESERVED IN AGENT** (`localhost:5000`) | HTTP | **Never remove**. BUSY software sends directly to localhost. Agent intercepts, generates local hash, and syncs metadata to Cloud. |
| `POST /api/v1/bulk-upload` | Cloud API: `POST /api/v1/messages/bulk-send` | HTTPS | File uploaded to Cloud; jobs created in Supabase `message_queue`; dispatched to Agent via WebSocket. |
| `GET /api/v1/qr` | WebSocket Stream: `whatsapp:qr` | WSS | Ephemeral streaming via WebSocket from Agent -> VPS -> Vercel UI. Never saved in database. |
| `GET /api/v1/status` | Cloud API: `GET /api/v1/devices` & WebSocket status | HTTPS / WSS | Device and WhatsApp connectivity reported via live heartbeat. |
| `POST /api/v1/clients/add` | Cloud API: `POST /api/v1/whatsapp/request-qr` | HTTPS -> WSS | User initiates on Web; Cloud asks Agent to initialize a new `LocalAuth` client. |
| `GET /api/v1/queue` | Cloud API: `GET /api/v1/messages/queue` | HTTPS | Read directly from Supabase `message_queue` with RLS. |
| `POST /api/v1/queue/clear` | Cloud API: `POST /api/v1/messages/queue/clear` | HTTPS | Cloud deletes records in Supabase; sends event to Agent to flush local queue. |
| `GET /api/busy/firms` | Cloud API: `GET /api/v1/busy/companies` + Local Cache | HTTPS / Local | Firm metadata mirrored to Supabase `busy_companies`; credentials stored locally on PC. |
| `POST /api/busy/trigger` | Cloud UI -> WSS -> Agent `busy_service.runBulkReminders` | WSS | Web UI triggers action; Agent executes local queries and queues messages. |
| `GET /api/v1/license/info` | Cloud API: `GET /api/v1/subscriptions/me` | HTTPS | Backed by Supabase PostgreSQL `subscriptions` + Razorpay (Google Sheets fully deprecated). |
