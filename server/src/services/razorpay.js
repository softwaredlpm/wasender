const crypto = require('crypto');
const https = require('https');

class RazorpayService {
    constructor() {
        this.keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock_key_id';
        this.keySecret = process.env.RAZORPAY_KEY_SECRET || 'mock_secret_key_1234567890';
        this.webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'mock_webhook_secret_1234567890';
    }

    isConfigured() {
        return Boolean(
            process.env.RAZORPAY_KEY_ID &&
            !process.env.RAZORPAY_KEY_ID.includes('your_key') &&
            process.env.RAZORPAY_KEY_SECRET &&
            !process.env.RAZORPAY_KEY_SECRET.includes('your_razorpay')
        );
    }

    /**
     * Creates an order via Razorpay API or local sandbox mock
     */
    async createOrder(options) {
        const { amount, currency = 'INR', receipt, notes = {} } = options;

        if (!amount || amount <= 0) {
            throw new Error('Order amount must be greater than zero.');
        }

        // Amount in paise (1 INR = 100 paise)
        const amountInPaise = Math.round(amount * 100);

        if (!this.isConfigured()) {
            // Local Sandbox / Test Mock Order
            return {
                id: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
                entity: 'order',
                amount: amountInPaise,
                amount_paid: 0,
                amount_due: amountInPaise,
                currency,
                receipt: receipt || `rcpt_${Date.now()}`,
                status: 'created',
                attempts: 0,
                notes,
                created_at: Math.floor(Date.now() / 1000)
            };
        }

        // Live Razorpay API call
        return new Promise((resolve, reject) => {
            const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
            const payload = JSON.stringify({
                amount: amountInPaise,
                currency,
                receipt: receipt || `rcpt_${Date.now()}`,
                notes
            });

            const req = https.request({
                hostname: 'api.razorpay.com',
                port: 443,
                path: '/v1/orders',
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            reject(new Error(parsed.error?.description || 'Razorpay Order Creation Failed'));
                        }
                    } catch (e) {
                        reject(new Error('Invalid response from Razorpay: ' + data));
                    }
                });
            });

            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    /**
     * Verifies payment signature (razorpay_order_id + '|' + razorpay_payment_id)
     */
    verifyPaymentSignature(orderId, paymentId, signature) {
        if (!orderId || !paymentId || !signature) return false;

        const body = `${orderId}|${paymentId}`;
        const expectedSignature = crypto
            .createHmac('sha256', this.keySecret)
            .update(body)
            .digest('hex');

        // Timing safe comparison
        try {
            return crypto.timingSafeEqual(
                Buffer.from(expectedSignature, 'utf8'),
                Buffer.from(signature, 'utf8')
            );
        } catch (_) {
            return false;
        }
    }

    /**
     * Verifies incoming webhook HMAC signature
     */
    verifyWebhookSignature(rawBody, signature) {
        if (!rawBody || !signature) return false;

        const expectedSignature = crypto
            .createHmac('sha256', this.webhookSecret)
            .update(rawBody)
            .digest('hex');

        try {
            return crypto.timingSafeEqual(
                Buffer.from(expectedSignature, 'utf8'),
                Buffer.from(signature, 'utf8')
            );
        } catch (_) {
            return false;
        }
    }
}

module.exports = new RazorpayService();
