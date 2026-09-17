const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext, requireRole } = require('../middleware/tenant');
const { queueDispatcher, mockQueue } = require('../services/queueDispatcher');
const { success, error } = require('../utils/response');

router.use(authenticateUser);
router.use(requireTenantContext);

/**
 * Variable interpolation helper (Mustache-style {{variable}})
 */
function interpolateTemplate(template, vars = {}) {
    if (!template) return '';
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
        return vars[key] !== undefined ? vars[key] : (vars[key.toLowerCase()] !== undefined ? vars[key.toLowerCase()] : match);
    });
}

/**
 * POST /api/v1/messages/bulk-send
 * Enqueues a campaign of single or bulk messages with template variable substitution.
 */
router.post('/bulk-send', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const {
            deviceId,
            whatsappAccountId,
            recipients = [],
            messageTemplate,
            attachmentUrl,
            scheduledAt,
            idempotencyKey
        } = req.body;

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return error(res, 'At least one recipient is required.', 400);
        }

        if (!messageTemplate && !attachmentUrl) {
            return error(res, 'Either messageTemplate or attachmentUrl is required.', 400);
        }

        // Idempotency Check: prevent double-clicks or replay
        const effectiveIdempotencyKey = idempotencyKey || `batch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const jobsToInsert = [];
        const nowIso = new Date().toISOString();
        const dispatchTime = scheduledAt ? new Date(scheduledAt).toISOString() : nowIso;

        for (let i = 0; i < recipients.length; i++) {
            const r = recipients[i];
            const recipientPhone = r.phone || r.number || r.mobile;
            if (!recipientPhone) continue;

            const variables = {
                customer_name: r.name || 'Customer',
                name: r.name || 'Customer',
                phone: recipientPhone,
                ...(r.variables || {})
            };

            const interpolatedMessage = interpolateTemplate(messageTemplate, variables);
            const itemKey = `${effectiveIdempotencyKey}_${i}`;

            jobsToInsert.push({
                id: crypto.randomUUID(),
                tenant_id: tenantId,
                device_id: deviceId || null,
                whatsapp_account_id: whatsappAccountId || null,
                phone: String(recipientPhone).replace(/\D/g, ''),
                message: interpolatedMessage,
                attachment_url: attachmentUrl || null,
                status: 'PENDING',
                attempts: 0,
                max_attempts: 5,
                idempotency_key: itemKey,
                scheduled_at: dispatchTime,
                created_at: nowIso,
                updated_at: nowIso
            });
        }

        if (jobsToInsert.length === 0) {
            return error(res, 'No valid recipients found with phone numbers.', 400);
        }

        // Production Mode: Insert into Supabase
        if (isConfigured()) {
            const { data, error: insertErr } = await supabaseAdmin
                .from('message_queue')
                .insert(jobsToInsert)
                .select('id, phone, status, scheduled_at');

            if (insertErr) {
                // If idempotency key conflict occurred, query existing batch
                if (insertErr.code === '23505') {
                    return error(res, 'Duplicate submission: This campaign has already been queued (Idempotency Key Conflict).', 409);
                }
                return error(res, insertErr.message, 500);
            }

            // Trigger immediate dispatch
            setTimeout(() => queueDispatcher.pollAndDispatch(), 100);

            return success(res, {
                queuedCount: data.length,
                batchKey: effectiveIdempotencyKey,
                scheduledAt: dispatchTime
            }, `Successfully queued ${data.length} messages.`, 201);
        }

        // Mock / Unit Test Mode
        jobsToInsert.forEach(j => mockQueue.push(j));
        setTimeout(() => queueDispatcher.pollAndDispatch(), 50);

        return success(res, {
            queuedCount: jobsToInsert.length,
            batchKey: effectiveIdempotencyKey,
            scheduledAt: dispatchTime
        }, `Successfully queued ${jobsToInsert.length} messages (Test Mode).`, 201);

    } catch (err) {
        console.error('Bulk send error:', err);
        return error(res, 'Failed to enqueue messages.', 500);
    }
});

/**
 * GET /api/v1/messages/queue
 * Returns queue metrics and recent queue items for the tenant.
 */
router.get('/queue', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        if (isConfigured()) {
            const [queueRes, countsRes] = await Promise.all([
                supabaseAdmin
                    .from('message_queue')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .order('created_at', { ascending: false })
                    .limit(100),
                supabaseAdmin
                    .from('message_queue')
                    .select('status')
                    .eq('tenant_id', tenantId)
            ]);

            const allStatuses = countsRes.data || [];
            const summary = {
                total: allStatuses.length,
                pending: allStatuses.filter(s => s.status === 'PENDING').length,
                processing: allStatuses.filter(s => s.status === 'PROCESSING').length,
                sent: allStatuses.filter(s => s.status === 'SENT').length,
                failed: allStatuses.filter(s => s.status === 'FAILED').length,
                isPaused: queueDispatcher.isTenantPaused(tenantId)
            };

            return success(res, {
                summary,
                items: queueRes.data || []
            });
        }

        // Mock Mode
        const tenantJobs = mockQueue.filter(j => j.tenant_id === tenantId);
        return success(res, {
            summary: {
                total: tenantJobs.length,
                pending: tenantJobs.filter(s => s.status === 'PENDING').length,
                processing: tenantJobs.filter(s => s.status === 'PROCESSING').length,
                sent: tenantJobs.filter(s => s.status === 'SENT').length,
                failed: tenantJobs.filter(s => s.status === 'FAILED').length,
                isPaused: queueDispatcher.isTenantPaused(tenantId)
            },
            items: tenantJobs
        });

    } catch (err) {
        return error(res, 'Failed to retrieve queue.', 500);
    }
});

/**
 * POST /api/v1/messages/queue/pause
 * Pauses message queue consumption for this tenant.
 */
router.post('/queue/pause', (req, res) => {
    const tenantId = req.tenant.id;
    queueDispatcher.pauseTenant(tenantId);
    return success(res, { isPaused: true }, 'Queue dispatch paused.');
});

/**
 * POST /api/v1/messages/queue/resume
 * Resumes message queue consumption for this tenant.
 */
router.post('/queue/resume', (req, res) => {
    const tenantId = req.tenant.id;
    queueDispatcher.resumeTenant(tenantId);
    queueDispatcher.pollAndDispatch();
    return success(res, { isPaused: false }, 'Queue dispatch resumed.');
});

/**
 * POST /api/v1/messages/queue/retry-failed
 * Resets failed messages back to PENDING.
 */
router.post('/queue/retry-failed', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        if (isConfigured()) {
            const { data, error: updateErr } = await supabaseAdmin
                .from('message_queue')
                .update({ status: 'PENDING', attempts: 0, error: null })
                .eq('tenant_id', tenantId)
                .eq('status', 'FAILED')
                .select();

            if (updateErr) return error(res, updateErr.message, 500);
            queueDispatcher.pollAndDispatch();
            return success(res, { retriedCount: data?.length || 0 }, 'Failed messages queued for retry.');
        }

        // Mock Mode
        let count = 0;
        mockQueue.forEach(j => {
            if (j.tenant_id === tenantId && j.status === 'FAILED') {
                j.status = 'PENDING';
                j.attempts = 0;
                j.error = null;
                count++;
            }
        });
        queueDispatcher.pollAndDispatch();
        return success(res, { retriedCount: count }, 'Failed messages queued for retry (Test Mode).');

    } catch (err) {
        return error(res, 'Failed to retry messages.', 500);
    }
});

/**
 * POST /api/v1/messages/queue/clear
 * Purges or cancels pending queue records.
 */
router.post('/queue/clear', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { type = 'pending' } = req.body; // 'pending' | 'failed' | 'all'

        if (isConfigured()) {
            let query = supabaseAdmin.from('message_queue').delete().eq('tenant_id', tenantId);
            if (type === 'pending') query = query.eq('status', 'PENDING');
            if (type === 'failed') query = query.eq('status', 'FAILED');

            const { error: delErr } = await query;
            if (delErr) return error(res, delErr.message, 500);
            return success(res, {}, 'Queue cleared successfully.');
        }

        // Mock Mode
        const initialLen = mockQueue.length;
        for (let i = mockQueue.length - 1; i >= 0; i--) {
            const j = mockQueue[i];
            if (j.tenant_id === tenantId) {
                if (type === 'all' || j.status.toLowerCase() === type.toLowerCase()) {
                    mockQueue.splice(i, 1);
                }
            }
        }
        return success(res, { cleared: initialLen - mockQueue.length }, 'Queue cleared.');

    } catch (err) {
        return error(res, 'Failed to clear queue.', 500);
    }
});

module.exports = router;
