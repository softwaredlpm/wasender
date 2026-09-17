# WASENDER Multi-Tenant SaaS: Complete Production Deployment Guide

This step-by-step guide walks you through deploying the complete WASENDER SaaS ecosystem:
1. **Database Layer**: Supabase PostgreSQL with 18 multi-tenant tables, Row-Level Security (RLS), and functions.
2. **Backend API & WebSocket Server**: Ubuntu/Debian Linux VPS running Node.js on port 5001 with Nginx SSL reverse proxy.
3. **Frontend Dashboard**: Vercel Edge CDN (or served directly from the VPS).
4. **Customer Windows Agent**: `WASENDER-Agent.exe` running on customer Windows PCs with BUSY accounting & WhatsApp.

---

## Prerequisites & Architecture Checklist

| Component | Recommended Service | Example Domain | Purpose |
| :--- | :--- | :--- | :--- |
| **Database** | Supabase Cloud | `xyzcompany.supabase.co` | Multi-tenant PostgreSQL, Auth, RLS |
| **Cloud VPS** | Hetzner / DigitalOcean / AWS EC2 | `api.wasender.com` (IP: `203.0.113.10`) | Express API & WebSocket Hub (`/agent/ws`, `/browser/ws`) |
| **Frontend** | Vercel | `app.wasender.com` | Responsive dark-mode dashboard |
| **DNS Manager**| Cloudflare / Namecheap / GoDaddy | `wasender.com` | A & CNAME records with SSL |
| **Payment Gateway**| Razorpay | Dashboard credentials | Tiered subscription billing & webhooks |
| **Windows PC** | Local Customer Machine | `localhost:5000` | BUSY Database & local WhatsApp Web sessions |

---

## Step 1: Set Up Supabase Database

1. Log in to [Supabase](https://supabase.com/) and click **New Project**.
2. Set your **Database Password** and select the region closest to your customers (e.g. `ap-south-1` Mumbai / India).
3. Once provisioned, go to **Project Settings** -> **API**:
   - Copy **Project URL** (e.g. `https://your-project.supabase.co`).
   - Copy **anon public** key (e.g. `eyJhbGciOi...`).
   - Copy **service_role secret** key (Keep this strictly private; only used on your backend VPS API).
4. Go to **SQL Editor** in Supabase:
   - Open [`supabase/migrations/20260918000001_initial_saas_schema.sql`](file:///d:/WASENDER/supabase/migrations/20260918000001_initial_saas_schema.sql) in your editor.
   - Copy the entire SQL content, paste it into the Supabase SQL Editor, and click **Run**.
   - Verify that all 18 tables are created with Row Level Security (RLS) enabled.
   - Alternatively, execute the automated migration runner:
     ```bash
     node scripts/run-production-migrations.js
     ```

---

## Step 2: Configure Domain DNS Records

In your DNS manager (e.g., Cloudflare, Namecheap):

| Type | Name | Target / Value | TTL | Proxy Status |
| :--- | :--- | :--- | :--- | :--- |
| **A** | `api` | `YOUR_VPS_IP_ADDRESS` | Auto | DNS only (Grey Cloud if using WebSocket directly) |
| **CNAME** | `app` | `cname.vercel-dns.com` | Auto | Proxied (Orange Cloud) |

> [!IMPORTANT]
> When using Cloudflare with WebSocket endpoints (`/agent/ws` and `/browser/ws`), make sure **WebSockets** are enabled under **Network** settings in your Cloudflare dashboard, or set the DNS record for `api.wasender.com` to **DNS only** to let Nginx handle SSL termination directly.

---

## Step 3: Deploy Backend API on Ubuntu/Debian VPS

Connect to your VPS via SSH:
```bash
ssh root@YOUR_VPS_IP
```

### 3.1 Initial VPS Setup
```bash
# Update package registry
apt update && apt upgrade -y

# Install essential packages
apt install -y git curl wget ufw nginx certbot python3-certbot-nginx

# Configure UFW Firewall
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw --force enable
```

### 3.2 Deploy Application Code
```bash
# Clone the repository to /opt/wasender
git clone https://github.com/your-org/wasender.git /opt/wasender
cd /opt/wasender

# Create your production .env file
cp .env.example .env
nano .env
```

Populate `.env` with your production values:
```ini
NODE_ENV=production
PORT=5001

# Supabase Credentials
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# VPS Public Endpoints
VPS_API_URL=https://api.wasender.com
WSS_SERVER_URL=wss://api.wasender.com/agent
JWT_SECRET=super-strong-production-random-secret-key-at-least-32-chars
CORS_ORIGIN=https://app.wasender.com,https://api.wasender.com

# Razorpay Production Keys
RAZORPAY_KEY_ID=rzp_live_your_actual_key_id
RAZORPAY_KEY_SECRET=your_actual_razorpay_secret
RAZORPAY_WEBHOOK_SECRET=your_actual_webhook_secret
```

### 3.3 Validate Environment
Run the pre-flight verification script to ensure all mandatory keys are populated:
```bash
node scripts/verify-production-env.js
```
*(Must output: `🎉 Pre-flight check passed! Environment is ready for production deployment.`)*

---

### 3.4 Choose Deployment Method: Docker (Recommended) or PM2

#### Option A: Docker & Docker Compose (Recommended)

```bash
# Install Docker and Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh

# Start container in detached mode
cd /opt/wasender
docker-compose up -d --build

# Verify container is running and healthy
docker-compose ps
curl http://localhost:5001/health
```

#### Option B: Native Node.js with PM2 Cluster

```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2

# Install production dependencies
cd /opt/wasender/server
npm ci --omit=dev

# Start in cluster mode (multi-core zero-downtime)
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

---

### 3.5 Configure Nginx & Obtain SSL Certificate (Let's Encrypt)

1. Copy the production Nginx configuration:
```bash
cp /opt/wasender/server/deploy/nginx.conf /etc/nginx/sites-available/wasender.conf
ln -s /etc/nginx/sites-available/wasender.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
```

2. Obtain free SSL certificate via Certbot:
```bash
certbot --nginx -d api.wasender.com
```

3. Test and reload Nginx:
```bash
nginx -t
systemctl reload nginx
```

4. Verify your Cloud VPS API over HTTPS:
```bash
curl https://api.wasender.com/health
```
*(Should return `{"success":true,"data":{"status":"UP",...}}`)*

---

## Step 4: Deploy Web Dashboard on Vercel

1. Install Vercel CLI locally or connect your GitHub repository on [Vercel](https://vercel.com/):
   ```bash
   cd d:\WASENDER
   npm install -g vercel
   vercel --prod
   ```
2. In the Vercel Project Dashboard:
   - **Root Directory**: `./`
   - **Framework Preset**: Other
   - **Build Command**: Leave default (defined in [`vercel.json`](file:///d:/WASENDER/vercel.json))
   - **Output Directory**: `server/public`
3. Add Custom Domain:
   - Go to **Project Settings** -> **Domains**.
   - Add `app.wasender.com`.
   - Ensure DNS points to `cname.vercel-dns.com`.
4. Your Web Dashboard is now live at `https://app.wasender.com/dashboard`!

---

## Step 5: Customer Windows PC Agent Deployment

For every customer using BUSY Accounting and WhatsApp automation:

1. **Deliver the Standalone Executable**:
   - Provide the customer with [`agent/dist/WASENDER-Agent.exe`](file:///d:/WASENDER/agent/dist/WASENDER-Agent.exe) (or generate a fresh one via `cd agent && npm run build:win`).
   - Copy `WASENDER-Agent.exe` and `agent/scripts/` to the customer's PC:
     `C:\Program Files\WASENDER\` (or `C:\WASENDER\`).

2. **Install Background Service (Auto-Start on Boot)**:
   - Right-click `scripts\install-service.bat` and select **Run as Administrator**.
   - This registers `WASENDER-Agent` in the **Windows Task Scheduler** to start automatically on Windows boot.

3. **Pair the Device**:
   - Have the customer (or admin) log in to the Web Dashboard at `https://app.wasender.com/dashboard`.
   - Navigate to **Devices** -> Click **+ Add New Device**.
   - Note the 8-character Pairing Code (e.g. `WAS-7F3A9B2C`).
   - On the customer's Windows PC, run:
     ```cmd
     WASENDER-Agent.exe --pair WAS-7F3A9B2C
     ```
     *(Or double-click `scripts\pair-agent.bat` and paste the code).*

4. **Verify Live Connection**:
   - In the Web Dashboard, the device badge will turn **ONLINE (Live)**.
   - The WhatsApp QR code will appear live on the web screen.
   - Scan the QR code once with WhatsApp on the business phone.
   - The status changes to **WhatsApp: Ready**.
   - Local BUSY webhook is listening on `http://localhost:5000/api/v1/send`.

---

## Step 6: Configure BUSY Accounting Software

In the customer's BUSY Accounting installation on their Windows PC:

1. Open BUSY -> Go to **Administration** -> **Configuration** -> **Voucher Configuration** -> **Sales**.
2. Select your invoice series -> Click **Voucher Event / Webhook Trigger**.
3. Set Webhook URL:
   ```text
   http://localhost:5000/api/v1/send
   ```
4. HTTP Method: `POST`
5. Format: `JSON`
6. Payload Fields:
   ```json
   {
     "phone": "<<PartyMobileNo>>",
     "partyName": "<<PartyName>>",
     "invoiceNo": "<<VchNo>>",
     "amount": <<VchAmount>>,
     "pdfPath": "<<PrintPDFPath>>"
   }
   ```
7. Click **Save**.

Whenever a sales voucher or bill is printed/saved in BUSY:
1. BUSY triggers the local agent webhook (`localhost:5000`).
2. `WASENDER-Agent.exe` catches the payload, attaches the invoice PDF, and dispatches it over WhatsApp.
3. The temporary PDF is **immediately purged from local disk** (`fs.unlinkSync`).
4. Dispatch telemetry is broadcasted in real-time to the Cloud Web Dashboard over the secure WebSocket tunnel.

---

## Step 7: Post-Deployment Verification & Smoke Test

Run the full end-to-end verification test suite:

```bash
cd /opt/wasender/server
# 1. Test Auth & Tenant isolation
node tests/auth.test.js

# 2. Test Security Headers & Rate Limiters
node tests/security-hardening.test.js

# 3. Test Production Deployment Configurations
node tests/production-deployment.test.js

# 4. Test 100-Tenant Scale & Concurrency
node tests/scale-load.test.js
```

All tests will pass with `0 Failed`, confirming a rock-solid, production-grade deployment!
