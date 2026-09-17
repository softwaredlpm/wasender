const express = require('express');
const fs = require('fs');
const path = require('path');
const sessionManager = require('../whatsapp/sessionManager');
const wsClient = require('./wsClient');
const agentConfig = require('../config');

class InvoiceWebhookServer {
    constructor() {
        this.app = express();
        this.server = null;
        this.port = 5000;
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    }

    setupRoutes() {
        // Health check for BUSY integration
        this.app.get('/api/v1/health', (req, res) => {
            res.json({ status: 'UP', service: 'WASENDER Local BUSY Invoice Dispatcher' });
        });

        // Common handler for BUSY invoice triggers
        const dispatchInvoiceHandler = async (req, res) => {
            let tempPdfPath = null;
            let purgeOnFinish = true;

            try {
                const {
                    phone,
                    mobile,
                    number,
                    message = 'Dear Customer, please find attached your invoice.',
                    pdfPath,
                    pdfBase64,
                    invoiceNo,
                    voucherNo,
                    amount,
                    firmId,
                    clientId = 'default'
                } = req.body;

                const rawPhone = phone || mobile || number;
                if (!rawPhone) {
                    return res.status(400).json({
                        success: false,
                        error: 'Recipient phone number is required (field: phone, mobile, or number).'
                    });
                }

                // Phone sanitization with 91 formatting
                const cleanPhone = String(rawPhone).replace(/\D/g, '');
                const formattedPhone = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;

                const invIdentifier = invoiceNo || voucherNo || `INV-${Date.now()}`;

                // Handle local PDF path or base64 PDF
                if (pdfPath) {
                    tempPdfPath = pdfPath;
                } else if (pdfBase64) {
                    // If sent as raw base64, save to a temporary scratch path
                    const tempDir = path.join(__dirname, '..', '..', 'scratch');
                    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                    tempPdfPath = path.join(tempDir, `temp_voucher_${Date.now()}.pdf`);
                    fs.writeFileSync(tempPdfPath, Buffer.from(pdfBase64, 'base64'));
                }

                // Check file existence if attachment provided
                let hasAttachment = false;
                if (tempPdfPath && fs.existsSync(tempPdfPath)) {
                    hasAttachment = true;
                }

                console.log(`🧾 [BUSY Invoice] Dispatching voucher ${invIdentifier} to +${formattedPhone} (Attachment: ${hasAttachment ? 'YES' : 'NO'})`);

                // Dispatch via WhatsApp session manager
                let dispatchResult;
                try {
                    dispatchResult = await sessionManager.sendMessage({
                        clientId,
                        to: formattedPhone,
                        message: message || `Invoice #${invIdentifier}`,
                        mediaPath: hasAttachment ? tempPdfPath : null,
                        caption: message
                    });
                } catch (sendErr) {
                    console.error(`[BUSY Invoice] WhatsApp dispatch error:`, sendErr.message);
                    dispatchResult = {
                        success: false,
                        error: sendErr.message,
                        simulated: process.env.NODE_ENV === 'test'
                    };
                }

                // --- CRITICAL ARCHITECTURAL INVARIANT ---
                // Post-dispatch immediate purge of temporary invoice PDF
                if (tempPdfPath && fs.existsSync(tempPdfPath) && purgeOnFinish) {
                    try {
                        fs.unlinkSync(tempPdfPath);
                        console.log(`🧹 [BUSY Privacy] Purged temporary invoice PDF immediately post-dispatch: ${path.basename(tempPdfPath)}`);
                    } catch (unlinkErr) {
                        console.warn(`[BUSY Privacy] Notice: Could not unlink ${tempPdfPath}: ${unlinkErr.message}`);
                    }
                }

                // Telemetry payload to notify Cloud SaaS
                const telemetryPayload = {
                    phone: formattedPhone,
                    invoiceNo: invIdentifier,
                    amount: amount || null,
                    firmId: firmId || null,
                    status: dispatchResult?.success !== false ? 'SENT' : 'FAILED',
                    hasAttachment,
                    whatsappMessageId: dispatchResult?.messageId || null,
                    dispatchedAt: new Date().toISOString()
                };

                // Dispatch telemetry over real-time WebSocket to Cloud VPS
                if (wsClient && wsClient.isConnected) {
                    wsClient.send('busy:invoice_dispatched', telemetryPayload);
                }

                return res.json({
                    success: true,
                    message: 'Invoice processed successfully and temporary documents purged.',
                    data: {
                        invoiceNo: invIdentifier,
                        phone: formattedPhone,
                        status: telemetryPayload.status,
                        purged: hasAttachment
                    }
                });

            } catch (err) {
                // Failsafe purge even on unexpected failure
                if (tempPdfPath && fs.existsSync(tempPdfPath)) {
                    try { fs.unlinkSync(tempPdfPath); } catch (_) {}
                }

                console.error('[BUSY Invoice Webhook] Unexpected error:', err);
                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }
        };

        // Mount legacy and modern endpoints for maximum compatibility
        this.app.post('/api/v1/send', dispatchInvoiceHandler);
        this.app.post('/api/v1/invoice', dispatchInvoiceHandler);
        this.app.post('/api/busy/send', dispatchInvoiceHandler);
    }

    start(port = 5000) {
        this.port = port;
        return new Promise((resolve, reject) => {
            try {
                this.server = this.app.listen(this.port, () => {
                    console.log(`🧾 [BUSY Webhook] Local invoice dispatch webhook listening on http://localhost:${this.port}/api/v1/send`);
                    resolve(this.server);
                });
                this.server.on('error', (err) => {
                    if (err.code === 'EADDRINUSE') {
                        console.warn(`⚠️ [BUSY Webhook] Port ${this.port} in use. Legacy server or another agent may be running.`);
                    }
                    reject(err);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
}

module.exports = new InvoiceWebhookServer();
