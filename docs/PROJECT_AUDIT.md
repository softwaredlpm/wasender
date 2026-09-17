# WASENDER Project Audit & Codebase Inspection

## 1. Inventory of Files & Source Artifacts

| Path / File | Type | Lines / Size | Primary Responsibility | Reusability in SaaS |
| :--- | :--- | :--- | :--- | :--- |
| `server.js` | Node.js (CommonJS) | 3,655 lines (~145 KB) | Monolithic backend: Express HTTP server, multi-account `whatsapp-web.js` manager, local JSON queue worker, logging, BUSY routing, and licensing. | **High (Split)**: WhatsApp core & BUSY routes move into Windows Agent; Cloud routes move into VPS API. |
| `server.cjs` | Node.js (CommonJS) | 2,956 lines (~117 KB) | esbuild-bundled single file version of `server.js` + `busy_service.js` created for packaging with `pkg`. | **Obsolete Artifact**: Do not edit directly; build output artifact. |
| `busy_service.js` | Node.js (CommonJS) | 1,462 lines (~66 KB) | BUSY integration business logic: account hierarchy traversal, aging schedules, bulk balance queries, PDC reminders, and Puppeteer PDF ledger generation. | **100% Reusable**: Must remain entirely within the Windows Agent. |
| `busy_db_bridge.ps1` | PowerShell 5.1 / Core | 850 lines (~43 KB) | Low-level database bridge using ADO/OLEDB to query MS Access (`.mdb`) and Microsoft SQL Server (`System.Data.SqlClient`). | **100% Reusable**: Essential for local Windows on-premise BUSY connectivity. |
| `busy_config.json` | JSON Config | 75 lines (~2.1 KB) | Local configuration of connected firms: DB paths, SQL server names, passwords, target groups, PDC settings, and UPI payment details. | **Reusable**: Becomes local agent firm storage; metadata synced to Supabase `busy_companies`. |
| `busy_config.md` | Markdown Docs | 60 lines (~2.6 KB) | Setup guide for BUSY "SMS/WhatsApp Configuration" utility. Explains localhost port mappings and `<PDFPATH>` parameters. | **Retained**: User documentation for customer onboarding. |
| `config.json` | JSON Config | 5 lines (232 B) | Legacy license config containing license email, Google Apps Script URL, and plain text admin password. | **Deprecate**: Replaced by Supabase Auth + secure Agent token. |
| `users.json` | JSON Data | 7 lines (259 B) | Local admin credentials with salt and PBKDF2 hash. | **Deprecate**: Replaced by Supabase Auth / JWT. |
| `queue.json` | JSON Data | Dynamic (~2 B empty) | Local file-based message queue for single-machine deployment. | **Transform**: Becomes local offline cache queue on Agent; main queue moves to Supabase `message_queue`. |
| `logs.json` | JSON Data | Dynamic (~144 KB) | Local disk log history array (capped at last 1000 items). | **Transform**: Agent forwards logs via WSS to Supabase `message_logs`. |
| `client_names.json` | JSON Data | Dynamic (34 B) | Key-value store mapping `clientId` -> Human-friendly account name. | **Migrate**: Becomes Supabase `whatsapp_accounts` table. |
| `client_ports.json` | JSON Data | Dynamic (21 B) | Key-value store mapping `clientId` -> Local TCP port (5000, 5001, etc.). | **Retained in Agent**: Used for local multi-terminal BUSY webhooks. |
| `public/index.html` | HTML5 SPA | 1,930 lines (~101 KB) | Legacy single-page admin dashboard for localhost control. | **Reference**: Cloud web dashboard on Vercel replaces this with modern SaaS UI. |
| `public/app.js` | JavaScript | 1,510 lines (~65 KB) | Frontend DOM manipulation, polling, QR rendering, account switching, and Excel parsing. | **Reference**: Converted into modern modular React/Next.js components. |
| `public/style.css` | CSS | 884 lines (~16 KB) | Dark/Light CSS styling for legacy localhost dashboard. | **Reference**: Design tokens used in new responsive SaaS frontend. |
| `build-exe.bat` | Windows Batch | 130 lines (~3.4 KB) | Packages Node.js app into standalone `dist/WASender.exe` using `pkg`. | **Reusable**: Adapt to package the new `WASENDER-Agent.exe`. |
| `start_server.bat` / `.vbs` | Batch / VBScript | ~20 lines | Starts `node server.js` in foreground or background windowless mode. | **Reusable**: Agent service launcher. |
| `stop_server.bat` / `.vbs` | Batch / VBScript | ~20 lines | Kills orphaned Node.js and Chrome processes on ports 5000-5001. | **Reusable**: Cleanup utility for Agent installer. |
| `restart_server.bat` | Windows Batch | 16 lines | Sequential stop and restart script with file lock cleanup. | **Reusable**: Agent maintenance tool. |
| `open_firewall_ports.bat` | Windows Batch | 122 lines (~3.2 KB) | Opens Windows Firewall inbound/outbound rules for TCP ports 5000-5010. | **Reusable**: Retained for local LAN multi-workstation BUSY setups. |
| `package.json` | npm Manifest | 47 lines (~1 KB) | Defines runtime dependencies (`whatsapp-web.js`, `express`, `mssql`, `puppeteer`, etc.). | **Split**: Divided into `agent/package.json` and `server/package.json`. |

---

## 2. Core Functional Deep Dive

### 2.1 WhatsApp Engine (`server.js` lines 260–1200)
- **Session Architecture**: Uses `whatsapp-web.js` with `LocalAuth({ clientId, dataPath: '.wwebjs_auth' })`. Each linked account gets a dedicated folder (`session-default`, `session-client_xxxxxx`).
- **Multi-Account Port Allocation**: Default account runs on port `5000`. Extra accounts receive consecutive local ports (`5001`, `5002`, up to `5010`). Each port runs an isolated Express sub-app with `/send`, `/status`, and `/qr` endpoints.
- **Anti-Ban Protections (CRITICAL TO PRESERVE)**:
  - **Zero-Width Randomization**: `randomizeText()` injects invisible `\u200B` characters at random string positions, ensuring every WhatsApp payload has a unique checksum to defeat automated hash detection.
  - **Human Simulation Typing**: Before sending, the client invokes `chat.sendStateTyping()` with an authentic delay (3,000 ms to 6,000 ms).
  - **LID Resolution**: Automatically resolves internal WhatsApp `LID` (Linked Device) identifiers to prevent the common `Lid is missing in chat table` error.
- **Self-Healing Supervisor**:
  - A 60-second watchdog evaluates `client.getState()`. If the Puppeteer browser hangs or state diverges from `CONNECTED`, it terminates orphaned Chrome instances using PowerShell CimInstance queries and performs clean re-initialization.
- **Offline Network Detection**:
  - Active DNS loop tests `google.com`. When internet drops, the queue halts automatically; when DNS resolves, it waits 5 seconds for WhatsApp websocket reconnect before resuming.

### 2.2 BUSY Accounting Automation (`busy_service.js` & `busy_db_bridge.ps1`)
- **Database Support**: Dual-mode support for MS Access (`COMPxxxx` folders with Jet/ACE OLEDB) and MS SQL Server (`BusyCompxxxx_db12025` with `System.Data.SqlClient`).
- **Group Hierarchy Traversal**: Recursively traverses BUSY master groups (e.g., `Sundry Debtors` -> Regional Subgroups -> Party Ledgers) caching node structures in memory to avoid PowerShell spawn lag.
- **Aging & Bill-by-Bill Breakdown**: Evaluates outstanding bills, calculating age based on bill date or credit due date, factoring in Post-Dated Cheques (PDCs) and on-account receipts.
- **Puppeteer Ledger PDF Generation**: Spawns local headless Chromium to render print-quality statement PDFs with company logo, bank details, and dynamic UPI QR codes.
- **Post-Dated Cheque (PDC) Watchdog**: Scans BUSY database for maturing cheques and issues proactive WhatsApp alerts (due in 2 days, tomorrow, today, or overdue).
- **Interactive WhatsApp Bot**: Listens for customer incoming messages (`STOCK`, `#STOCK`, `CATALOG`) and auto-responds with live inventory figures or stock PDF reports.

### 2.3 Queue & Dispatch Pipeline (`server.js` lines 1300–1650)
- **Storage**: In-memory array mirrored synchronously to `queue.json`.
- **Batching Parameters**:
  - `BATCH_SIZE = 10` messages.
  - `BATCH_DELAY = 20,000 ms` between batches.
  - Random intra-batch jitter of `8,000 ms – 10,000 ms` per message.
- **Retry Mechanism**: Up to 100 automatic retries for transient network failures; terminal failure for unregistered numbers or missing files.
- **Deduplication**: 10-second sliding cache window based on `hash(phone + message)`.

### 2.4 Existing Licensing Mechanism (`server.js` lines 158–258)
- Queries a remote Google Apps Script web app (`script.google.com`) passing `email` and `machineId` (derived from hardware GUIDs via `node-machine-id`).
- Supports an offline grace period if network check fails.

---

## 3. What Must Be Preserved vs What Must Change

### Preserved (Keep 100% Untouched In Logic)
1. `busy_db_bridge.ps1`: All 15 PowerShell database actions (accounts, balances, bills, contacts, PDC, stock).
2. `busy_service.js`: Accounting calculations, aging logic, balance parsing, and Puppeteer PDF templates.
3. WhatsApp anti-ban suite: `randomizeText()`, `sendStateTyping()`, and contact resolution.
4. Multi-client LocalAuth folder structure and session persistence.
5. `open_firewall_ports.bat` and Windows background execution scripts.
6. Local HTTP webhook `http://localhost:5000/api/v1/send` for direct BUSY software compatibility.

### Modified / Refactored
1. **Queue Management**: Local `queue.json` shifts from primary source of truth to an **offline fallback buffer**. Primary queue moves to Supabase `message_queue` managed by VPS.
2. **Configuration**: Hardcoded passwords and Google Sheets license checks removed. Replaced by Supabase JWT and cryptographically verified device tokens.
3. **Control Interface**: Monolithic local HTML UI deprecated in favor of a modern SaaS Web Application hosted on Vercel.
4. **Agent-Cloud Communication**: Addition of a lightweight secure WebSocket client in the Agent that connects to the VPS.

### Obsolete / Removed
1. `server.cjs`: Standalone esbuild bundle will be replaced with clean modular packaging in Phase 16.
2. Direct Google Apps Script license verification: Replaced by Supabase `subscriptions` + Razorpay.
3. `users.json`: Replaced by Supabase `auth.users` and `tenant_users`.

---

## 4. Architectural Risk Analysis

| Risk | Severity | Root Cause | SaaS Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **Cross-Tenant Message Leakage** | **CRITICAL** | Faulty queue dispatch targeting wrong device | Strict multi-tenant schema with Foreign Keys, Supabase RLS, and explicit `(tenant_id, device_id)` WebSocket targeting. |
| **Duplicate Message Dispatch** | **HIGH** | Network reconnect causing double replay | Distributed idempotency keys: `(tenant_id, client_message_id)` enforced with database unique constraints. |
| **WhatsApp Session Disconnection** | **HIGH** | WhatsApp Web protocol updates or phone logout | Persistent `LocalAuth`, automated watchdog auto-restart, and instant cloud notification of `DISCONNECTED` state. |
| **BUSY Database File Locks** | **MEDIUM** | Simultaneous Access `.mdb` queries | Connection timeouts, Read-Only OleDb connection strings, and cached memory maps for account structures. |
| **Disk Space Exhaustion** | **MEDIUM** | Accumulation of exported invoice PDFs | Strict temporary file policy: Local invoice PDFs deleted immediately post-dispatch; automated 24-hour cleanup cron. |
