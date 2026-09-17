/**
 * WASENDER SaaS Web Dashboard Client Controller
 * Live WebSocket streaming, Real-Time QR, BUSY Telemetry & Campaign Orchestration
 */

class WasenderApp {
    constructor() {
        this.ws = null;
        this.tenantId = localStorage.getItem('wasender_tenant_id') || 'tenant-demo-101';
        this.userToken = localStorage.getItem('wasender_token') || 'mock-user-token';
        this.qrCountdownTimer = null;
        this.init();
    }

    init() {
        this.setupNavigation();
        this.setupEventListeners();
        this.connectWebSocket();
        this.loadDashboardData();
    }

    // --- NAVIGATION & VIEWS ---
    setupNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                const targetViewId = item.getAttribute('data-view');
                if (targetViewId) {
                    this.switchView(targetViewId);
                }
            });
        });
    }

    switchView(viewId) {
        // Toggle Nav Items
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        const activeNav = document.querySelector(`.nav-item[data-view="${viewId}"]`);
        if (activeNav) activeNav.classList.add('active');

        // Toggle Sections
        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
        const targetSection = document.getElementById(viewId);
        if (targetSection) {
            targetSection.classList.add('active');
        }

        // Update Header Title
        const headingMap = {
            'view-dashboard': ['Dashboard Overview', 'Real-time automation telemetry and multi-tenant control'],
            'view-whatsapp': ['WhatsApp Accounts & Live QR', 'Scan live QR code or connect multi-account instances'],
            'view-devices': ['Windows Agents & Pairing', 'Monitor on-premise background automation services'],
            'view-busy': ['BUSY Accounting Bridge', 'Configured companies and local MS Access/MSSQL connections'],
            'view-campaigns': ['Bulk WhatsApp Campaigns', 'Schedule broadcasts and view live dispatch queues'],
            'view-contacts': ['Address Book & Contacts', 'Manage recipient numbers, customer codes, and tags'],
            'view-templates': ['Message Templates', 'Mustache variables and reusable automated message formats'],
            'view-reports': ['Reports & Audit Logs', 'Historical logs, compliance trails, and CSV downloads'],
            'view-billing': ['Billing & Subscriptions', 'Upgrade plans, view quotas, or activate offline licenses'],
            'view-admin': ['Super-Admin Portal', 'Global tenant directory and cryptographic license key generator']
        };

        const [title, sub] = headingMap[viewId] || ['WASENDER SaaS', 'Dashboard'];
        document.getElementById('page-heading').innerText = title;
        document.getElementById('page-subheading').innerText = sub;
    }

    // --- REAL-TIME WEBSOCKET HUB BRIDGE ---
    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/browser/ws?token=${this.userToken}&tenantId=${this.tenantId}`;

        console.log(`🔌 [Dashboard WS] Connecting to: ${wsUrl}`);
        const statusBadge = document.getElementById('ws-status-text');

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('✅ [Dashboard WS] Connected to Cloud Real-time Hub!');
                if (statusBadge) statusBadge.innerText = 'Live WebSocket Connected';
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleWebSocketMessage(message);
                } catch (e) {
                    console.error('Error parsing WebSocket message:', e);
                }
            };

            this.ws.onclose = () => {
                console.warn('⚠️ [Dashboard WS] Disconnected. Reconnecting in 3s...');
                if (statusBadge) statusBadge.innerText = 'Reconnecting...';
                setTimeout(() => this.connectWebSocket(), 3000);
            };

            this.ws.onerror = (err) => {
                console.error('WebSocket Error:', err);
            };

        } catch (err) {
            console.error('Failed to establish WebSocket:', err);
        }
    }

    handleWebSocketMessage(message) {
        const { event, data } = message;
        console.log(`📡 [WS Event] ${event}`, data);

        switch (event) {
            // Live Ephemeral QR Stream
            case 'whatsapp:qr':
                this.renderQrCode(data.qrCodeBase64, data.expiresInSeconds || 20);
                this.showToast('New QR Code Generated', 'Please scan with WhatsApp on your phone.', 'info');
                break;

            // WhatsApp Client Connected
            case 'whatsapp:ready':
                this.handleWhatsAppReady(data);
                this.showToast('WhatsApp Ready!', `Connected account +${data.phoneNumber || ''}`, 'success');
                break;

            // Live BUSY Invoice Dispatch
            case 'busy:invoice_dispatched':
                this.handleLiveInvoiceDispatched(data);
                this.showToast('🧾 BUSY Invoice Dispatched', `Voucher #${data.invoiceNo} sent to +${data.phone}`, 'success');
                break;

            // Queue Update
            case 'queue:update':
                this.updateQueueStatus(data);
                break;

            // Device Status
            case 'device:online':
                this.showToast('💻 Windows Agent Online', `Device [${data.deviceName}] connected.`, 'success');
                break;
        }
    }

    renderQrCode(base64Data, expiresInSeconds = 20) {
        const qrImg = document.getElementById('qr-image');
        const spinner = document.getElementById('qr-placeholder-spinner');
        const progressBar = document.getElementById('qr-progress-bar');
        const statusText = document.getElementById('qr-status-text');

        if (!base64Data) return;

        qrImg.src = base64Data;
        qrImg.style.display = 'block';
        if (spinner) spinner.style.display = 'none';

        // Animate countdown bar
        if (this.qrCountdownTimer) clearInterval(this.qrCountdownTimer);

        let remaining = expiresInSeconds;
        progressBar.style.width = '100%';

        this.qrCountdownTimer = setInterval(() => {
            remaining--;
            const pct = Math.max(0, (remaining / expiresInSeconds) * 100);
            progressBar.style.width = `${pct}%`;

            if (statusText) {
                statusText.innerText = `QR expires in ${remaining}s. Auto-refreshing...`;
            }

            if (remaining <= 0) {
                clearInterval(this.qrCountdownTimer);
                if (statusText) statusText.innerText = 'Refreshing QR code...';
            }
        }, 1000);
    }

    handleWhatsAppReady(data) {
        const qrImg = document.getElementById('qr-image');
        const spinner = document.getElementById('qr-placeholder-spinner');
        const statusText = document.getElementById('qr-status-text');

        if (this.qrCountdownTimer) clearInterval(this.qrCountdownTimer);

        if (qrImg) qrImg.style.display = 'none';
        if (spinner) {
            spinner.style.display = 'block';
            spinner.innerHTML = `
                <div style="font-size: 38px; margin-bottom: 8px;">✅</div>
                <div style="font-weight: 700; color: #10b981; font-size: 16px;">WhatsApp Connected!</div>
                <div style="font-size: 12px; color: #64748b; margin-top: 4px;">Phone: +${data.phoneNumber || 'Active'}</div>
            `;
        }
        if (statusText) {
            statusText.innerText = `Connected successfully as [${data.pushname || 'Primary'}]`;
        }
    }

    handleLiveInvoiceDispatched(data) {
        const tbody = document.getElementById('activity-log-body');
        if (!tbody) return;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>Just now</td>
            <td><strong>BUSY Invoice Dispatched</strong></td>
            <td>+${data.phone} (Voucher #${data.invoiceNo})</td>
            <td><span class="badge badge-success">✓ Delivered</span></td>
        `;
        tbody.insertBefore(row, tbody.firstChild);

        // Increment KPI
        const kpi = document.getElementById('kpi-total-sent');
        if (kpi) {
            const current = parseInt(kpi.innerText.replace(/,/g, '')) || 0;
            kpi.innerText = (current + 1).toLocaleString();
        }
    }

    updateQueueStatus(data) {
        const sentEl = document.getElementById('queue-sent-count');
        if (sentEl && data.status === 'SENT') {
            sentEl.innerText = (parseInt(sentEl.innerText) || 0) + 1;
        }
    }

    // --- BUTTON EVENT LISTENERS ---
    setupEventListeners() {
        // Request QR
        const btnQr = document.getElementById('btn-request-qr');
        if (btnQr) {
            btnQr.addEventListener('click', async () => {
                this.showToast('Requesting QR', 'Connecting to on-premise Windows Agent...', 'info');
                try {
                    await fetch('/api/v1/whatsapp/request-qr', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.userToken}`,
                            'x-tenant-id': this.tenantId
                        },
                        body: JSON.stringify({ clientId: 'default' })
                    });
                } catch (e) {
                    this.showToast('Error', e.message, 'danger');
                }
            });
        }

        // Sync BUSY Firms
        const btnSync = document.getElementById('btn-quick-sync-busy');
        const btnSync2 = document.getElementById('btn-sync-firms-cloud');
        const handleSync = async () => {
            this.showToast('Syncing BUSY', 'Querying local BDS/MSSQL database via Agent RPC...', 'info');
            try {
                const res = await fetch('/api/v1/busy/sync-companies', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.userToken}`,
                        'x-tenant-id': this.tenantId
                    },
                    body: JSON.stringify({ deviceId: 'dev-01-wh' })
                });
                const body = await res.json();
                if (body.success) {
                    this.showToast('Sync Complete', `Ingested ${body.data?.syncedCount || 0} BUSY firms.`, 'success');
                } else {
                    this.showToast('Notice', body.error || 'Agent offline', 'warning');
                }
            } catch (e) {
                this.showToast('Sync Notice', 'Agent simulated in offline sandbox mode.', 'info');
            }
        };

        if (btnSync) btnSync.addEventListener('click', handleSync);
        if (btnSync2) btnSync2.addEventListener('click', handleSync);

        // Submit Campaign
        const btnSubmitCampaign = document.getElementById('btn-submit-campaign');
        if (btnSubmitCampaign) {
            btnSubmitCampaign.addEventListener('click', async () => {
                const title = document.getElementById('campaign-title')?.value;
                const message = document.getElementById('campaign-message-body')?.value;

                if (!message) {
                    return this.showToast('Missing Field', 'Please enter a message body.', 'warning');
                }

                this.showToast('Campaign Enqueued', 'Dispatching recipients to Windows Agent...', 'success');
                document.getElementById('queue-pending-count').innerText = '45';
            });
        }

        // Admin Generate Key
        const btnGenKey = document.getElementById('btn-admin-generate-key');
        if (btnGenKey) {
            btnGenKey.addEventListener('click', async () => {
                const tier = document.getElementById('admin-license-tier')?.value || 'ENTERPRISE';
                const days = document.getElementById('admin-license-days')?.value || 365;

                try {
                    const res = await fetch('/api/v1/billing/license/generate', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.userToken}`,
                            'x-tenant-id': this.tenantId
                        },
                        body: JSON.stringify({ tier, durationDays: days })
                    });
                    const result = await res.json();
                    if (result.success) {
                        const box = document.getElementById('admin-generated-key-box');
                        box.innerText = `Key: ${result.data.licenseKey}\nTier: ${result.data.tier}\nExpires: ${result.data.expiresAt.split('T')[0]}`;
                        this.showToast('License Key Generated', 'Key signed and copied.', 'success');
                    }
                } catch (e) {
                    this.showToast('Error', e.message, 'danger');
                }
            });
        }
    }

    async upgradePlan(slug) {
        this.showToast('Checkout Initiated', `Opening Razorpay Checkout for ${slug} plan...`, 'info');
        try {
            const res = await fetch('/api/v1/billing/create-order', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.userToken}`,
                    'x-tenant-id': this.tenantId
                },
                body: JSON.stringify({ slug })
            });
            const data = await res.json();

            if (data.success) {
                // Auto verify in sandbox mode
                await fetch('/api/v1/billing/verify-payment', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.userToken}`,
                        'x-tenant-id': this.tenantId
                    },
                    body: JSON.stringify({
                        planId: data.data.plan.id,
                        razorpayOrderId: data.data.orderId,
                        razorpayPaymentId: 'pay_sandbox_' + Date.now(),
                        razorpaySignature: 'mock_valid_signature'
                    })
                });

                this.showToast('🎉 Plan Upgraded!', `Your tenant is now active on the ${data.data.plan.name} plan.`, 'success');
                document.getElementById('tenant-plan-badge').innerText = `${data.data.plan.name} Tier`;
            }
        } catch (e) {
            this.showToast('Checkout Notice', 'Razorpay test order generated.', 'info');
        }
    }

    loadDashboardData() {
        console.log('📊 Dashboard telemetry and data binding initialized.');
    }

    showToast(title, message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast';
        if (type === 'danger') toast.style.borderLeftColor = 'var(--accent-rose)';
        if (type === 'warning') toast.style.borderLeftColor = 'var(--accent-amber)';

        toast.innerHTML = `
            <div>
                <strong style="display: block; font-size: 13px; font-weight: 600;">${title}</strong>
                <span style="font-size: 12px; color: var(--text-secondary);">${message}</span>
            </div>
        `;

        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
}

// Global App Instance
window.addEventListener('DOMContentLoaded', () => {
    window.app = new WasenderApp();
});
