const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext, requireRole } = require('../middleware/tenant');
const razorpayService = require('../services/razorpay');
const { licenseManager, mockLicenseStore } = require('../services/licenseManager');
const { auditLogger } = require('../services/auditLogger');
const { success, error } = require('../utils/response');

// Default Seed Plans (Mock Fallback)
const DEFAULT_PLANS = [
    {
        id: 'plan_free_trial',
        name: 'Free Trial',
        slug: 'free-trial',
        description: '14-day free trial with basic WhatsApp & BUSY automation features.',
        price: 0,
        currency: 'INR',
        billing_cycle: 'monthly',
        message_limit: 200,
        device_limit: 1,
        whatsapp_limit: 1,
        features: ['1 WhatsApp Account', '1 Windows Agent', '200 Messages', 'Basic BUSY Reminders', 'Community Support']
    },
    {
        id: 'plan_starter',
        name: 'Starter',
        slug: 'starter',
        description: 'Ideal for small retailers and single-workstation BUSY businesses.',
        price: 799,
        currency: 'INR',
        billing_cycle: 'monthly',
        message_limit: 5000,
        device_limit: 1,
        whatsapp_limit: 2,
        features: ['2 WhatsApp Accounts', '1 Windows Agent', '5,000 Messages/mo', 'Automated Invoice PDF', 'Standard Support']
    },
    {
        id: 'plan_growth',
        name: 'Growth',
        slug: 'growth',
        description: 'For growing businesses with multi-branch BUSY setups and bulk marketing.',
        price: 1999,
        currency: 'INR',
        billing_cycle: 'monthly',
        message_limit: 25000,
        device_limit: 3,
        whatsapp_limit: 5,
        features: ['5 WhatsApp Accounts', '3 Windows Agents', '25,000 Messages/mo', 'PDC Cheque Alerts', 'Batch Stock Bot', 'Priority Support']
    },
    {
        id: 'plan_enterprise',
        name: 'Enterprise',
        slug: 'enterprise',
        description: 'High-volume automation for large distributors and enterprises.',
        price: 4999,
        currency: 'INR',
        billing_cycle: 'monthly',
        message_limit: 100000,
        device_limit: 10,
        whatsapp_limit: 10,
        features: ['10 WhatsApp Accounts', '10 Windows Agents', '100,000 Messages/mo', 'Custom Templates', 'Dedicated SLA', '24/7 Phone Support']
    }
];

// In-memory mock subscription store: tenantId -> subscription
const mockSubscriptionStore = new Map();

/**
 * PUBLIC WEBHOOK (No JWT auth required, uses Razorpay HMAC signature)
 * POST /api/v1/billing/webhook
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

        // Verify webhook authenticity
        const isValid = razorpayService.verifyWebhookSignature(rawBody, signature);
        if (!isValid && razorpayService.isConfigured()) {
            return res.status(400).json({ error: 'Invalid webhook signature.' });
        }

        const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const eventType = event.event;
        console.log(`💳 [Razorpay Webhook] Received event: ${eventType}`);

        // Handle event types
        if (eventType === 'payment.captured' || eventType === 'order.paid') {
            const payment = event.payload?.payment?.entity;
            const orderId = payment?.order_id;
            const tenantId = payment?.notes?.tenant_id;
            const planId = payment?.notes?.plan_id;

            if (tenantId && planId) {
                console.log(`✅ [Razorpay Webhook] Auto-activating subscription for Tenant: ${tenantId}, Plan: ${planId}`);
                if (isConfigured()) {
                    await supabaseAdmin
                        .from('subscriptions')
                        .upsert({
                            tenant_id: tenantId,
                            plan_id: planId,
                            razorpay_payment_id: payment?.id,
                            status: 'ACTIVE',
                            start_date: new Date().toISOString(),
                            end_date: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
                        }, { onConflict: 'tenant_id' });
                }
            }
        }

        return res.json({ status: 'ok', received: true });

    } catch (err) {
        console.error('Webhook error:', err);
        return res.status(500).json({ error: err.message });
    }
});

// Authenticated Routes
router.use(authenticateUser);
router.use(requireTenantContext);

/**
 * GET /api/v1/billing/plans
 * Lists all active SaaS subscription plans
 */
router.get('/plans', async (req, res) => {
    try {
        if (isConfigured()) {
            const { data, error: dbErr } = await supabaseAdmin
                .from('plans')
                .select('*')
                .eq('is_active', true)
                .order('price', { ascending: true });

            if (!dbErr && data && data.length > 0) {
                return success(res, { plans: data });
            }
        }

        return success(res, { plans: DEFAULT_PLANS });
    } catch (err) {
        return error(res, 'Failed to fetch subscription plans.', 500);
    }
});

/**
 * GET /api/v1/billing/subscription
 * Retrieves tenant's current active subscription & entitlements
 */
router.get('/subscription', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        if (isConfigured()) {
            const { data, error: dbErr } = await supabaseAdmin
                .from('subscriptions')
                .select('*, plans(*)')
                .eq('tenant_id', tenantId)
                .maybeSingle();

            if (data) {
                return success(res, { subscription: data });
            }
        }

        // Mock store lookup or default Trial
        let sub = mockSubscriptionStore.get(tenantId);
        if (!sub) {
            sub = {
                id: `sub_trial_${tenantId.substring(0, 8)}`,
                tenant_id: tenantId,
                status: 'TRIAL',
                plan: DEFAULT_PLANS[0],
                start_date: new Date().toISOString(),
                end_date: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()
            };
            mockSubscriptionStore.set(tenantId, sub);
        }

        return success(res, { subscription: sub });

    } catch (err) {
        return error(res, 'Failed to fetch subscription details.', 500);
    }
});

/**
 * POST /api/v1/billing/create-order
 * Generates Razorpay Order ID for checkout
 */
router.post('/create-order', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { planId, slug } = req.body;

        // Find plan
        let plan = null;
        if (isConfigured()) {
            const query = supabaseAdmin.from('plans').select('*');
            if (planId) query.eq('id', planId);
            else if (slug) query.eq('slug', slug);
            const { data } = await query.single();
            plan = data;
        }

        if (!plan) {
            plan = DEFAULT_PLANS.find(p => p.id === planId || p.slug === slug) || DEFAULT_PLANS[1];
        }

        if (plan.price <= 0) {
            return error(res, 'Cannot create payment order for free plan.', 400);
        }

        const receipt = `rcpt_${tenantId.substring(0, 8)}_${Date.now()}`;
        const order = await razorpayService.createOrder({
            amount: plan.price,
            currency: plan.currency || 'INR',
            receipt,
            notes: {
                tenant_id: tenantId,
                plan_id: plan.id,
                plan_name: plan.name
            }
        });

        return success(res, {
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: razorpayService.keyId,
            plan: {
                id: plan.id,
                name: plan.name,
                price: plan.price,
                slug: plan.slug
            }
        }, 'Payment order created.');

    } catch (err) {
        console.error('Create payment order error:', err);
        return error(res, 'Failed to create payment order: ' + err.message, 500);
    }
});

/**
 * POST /api/v1/billing/verify-payment
 * Validates checkout signature and activates subscription
 */
router.post('/verify-payment', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { planId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

        if (!razorpayOrderId || !razorpayPaymentId) {
            return error(res, 'razorpayOrderId and razorpayPaymentId are required.', 400);
        }

        // Validate signature
        let isValid = false;
        if (razorpayOrderId.startsWith('order_mock_')) {
            // Local sandbox mock order auto-validates
            isValid = true;
        } else {
            isValid = razorpayService.verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
        }

        if (!isValid) {
            return error(res, 'Payment signature verification failed. Transaction rejected.', 400);
        }

        // Find target plan
        const plan = DEFAULT_PLANS.find(p => p.id === planId) || DEFAULT_PLANS[1];

        const subscriptionRecord = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            plan_id: plan.id,
            razorpay_payment_id: razorpayPaymentId,
            status: 'ACTIVE',
            start_date: new Date().toISOString(),
            end_date: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
            updated_at: new Date().toISOString()
        };

        if (isConfigured()) {
            await supabaseAdmin
                .from('subscriptions')
                .upsert(subscriptionRecord, { onConflict: 'tenant_id' });
        }

        mockSubscriptionStore.set(tenantId, {
            ...subscriptionRecord,
            plan
        });

        // Record audit event
        await auditLogger.logAction({
            tenantId,
            userId: req.user?.id,
            action: 'PLAN_UPGRADED',
            resource: plan.name,
            details: { paymentId: razorpayPaymentId, price: plan.price }
        });

        return success(res, {
            activated: true,
            planName: plan.name,
            status: 'ACTIVE',
            expiresAt: subscriptionRecord.end_date
        }, 'Subscription activated successfully!');

    } catch (err) {
        console.error('Verify payment error:', err);
        return error(res, 'Payment verification failed: ' + err.message, 500);
    }
});

/**
 * GET /api/v1/billing/license
 * Retrieves standalone license for the tenant
 */
router.get('/license', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const license = await licenseManager.getActiveLicense(tenantId);

        if (!license) {
            return success(res, { active: false, license: null });
        }

        return success(res, {
            active: true,
            license: {
                licenseKey: license.license_key,
                tier: license.tier,
                status: license.status,
                expiresAt: license.expires_at
            }
        });

    } catch (err) {
        return error(res, 'Failed to fetch license info.', 500);
    }
});

/**
 * POST /api/v1/billing/license/activate
 * Activates a standalone cryptographic license key
 */
router.post('/license/activate', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { licenseKey } = req.body;

        if (!licenseKey) {
            return error(res, 'licenseKey is required.', 400);
        }

        const result = await licenseManager.activateLicense(tenantId, licenseKey);
        if (!result.valid) {
            return error(res, result.error, 400);
        }

        await auditLogger.logAction({
            tenantId,
            userId: req.user?.id,
            action: 'LICENSE_ACTIVATED',
            resource: result.tier,
            details: { licenseKey: result.licenseKey }
        });

        return success(res, result, 'License key activated successfully!');

    } catch (err) {
        return error(res, 'Failed to activate license: ' + err.message, 500);
    }
});

/**
 * POST /api/v1/billing/license/generate
 * Admin endpoint to generate signed license keys
 */
router.post('/license/generate', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { tier = 'ENTERPRISE', durationDays = 365, targetTenantId } = req.body;

        const generated = licenseManager.generateKey({
            tenantId: targetTenantId || tenantId,
            tier,
            durationDays: parseInt(durationDays)
        });

        return success(res, generated, 'License key generated successfully.', 201);

    } catch (err) {
        return error(res, 'Failed to generate license key: ' + err.message, 500);
    }
});

module.exports = router;
