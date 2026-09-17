const { supabaseAdmin, isConfigured } = require('../config/supabase');
const wsHub = require('../websocket/hub');
const { usageTracker } = require('./usageTracker');

// In-memory queue fallback for testing/offline mode
const mockQueue = [];
const pausedTenants = new Set();

class QueueDispatcher {
    constructor() {
        this.pollInterval = null;
        this.isPolling = false;
        this.BATCH_SIZE = 10;
    }

    start(intervalMs = 3000) {
        if (this.pollInterval) return;
        this.pollInterval = setInterval(() => this.pollAndDispatch(), intervalMs);
        console.log(`🚀 Cloud Message Queue Dispatcher started (polling every ${intervalMs / 1000}s)`);
    }

    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    pauseTenant(tenantId) {
        pausedTenants.add(tenantId);
    }

    resumeTenant(tenantId) {
        pausedTenants.delete(tenantId);
    }

    isTenantPaused(tenantId) {
        return pausedTenants.has(tenantId);
    }

    /**
     * Core Dispatch Loop: Pulls PENDING messages from Supabase and routes to online customer agents.
     */
    async pollAndDispatch() {
        if (this.isPolling) return;
        this.isPolling = true;

        try {
            if (!isConfigured()) {
                // Mock / test mode queue processor
                await this.processMockQueue();
                return;
            }

            // 1. Fetch pending messages scheduled for dispatch
            const nowIso = new Date().toISOString();
            const { data: pendingJobs, error: fetchErr } = await supabaseAdmin
                .from('message_queue')
                .select('*')
                .in('status', ['PENDING', 'RETRY'])
                .lte('scheduled_at', nowIso)
                .order('is_priority', { ascending: false })
                .order('created_at', { ascending: true })
                .limit(50);

            if (fetchErr || !pendingJobs || pendingJobs.length === 0) {
                return;
            }

            // Group jobs by (tenant_id, device_id)
            const grouped = new Map();
            for (const job of pendingJobs) {
                if (pausedTenants.has(job.tenant_id)) continue;

                const key = `${job.tenant_id}:${job.device_id}`;
                if (!grouped.has(key)) grouped.set(key, []);
                if (grouped.get(key).length < this.BATCH_SIZE) {
                    grouped.get(key).push(job);
                }
            }

            for (const [key, jobs] of grouped.entries()) {
                const [tenantId, deviceId] = key.split(':');

                if (!deviceId || deviceId === 'null') {
                    // No specific device assigned, skip or find active device
                    continue;
                }

                // Check if target customer agent is currently online via WebSocket
                if (!wsHub.isDeviceOnline(tenantId, deviceId)) {
                    continue; // Skip until device comes online
                }

                const jobIds = jobs.map(j => j.id);

                // 2. Mark jobs as PROCESSING in Supabase
                await supabaseAdmin
                    .from('message_queue')
                    .update({
                        status: 'PROCESSING',
                        updated_at: new Date().toISOString()
                    })
                    .in('id', jobIds);

                // 3. Dispatch batch to customer Agent over WebSocket
                const dispatched = wsHub.sendToDevice(tenantId, deviceId, 'queue:dispatch', {
                    batchId: `batch_${Date.now()}`,
                    items: jobs.map(j => ({
                        id: j.id,
                        phone: j.phone,
                        message: j.message,
                        attachmentPath: j.attachment_path,
                        attachmentUrl: j.attachment_url,
                        whatsappAccountId: j.whatsapp_account_id
                    }))
                });

                if (!dispatched) {
                    // Revert back to PENDING if dispatch failed
                    await supabaseAdmin
                        .from('message_queue')
                        .update({ status: 'PENDING' })
                        .in('id', jobIds);
                }
            }

        } catch (err) {
            console.error('Queue dispatcher error:', err.message);
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Handles item delivery result reported back by Windows Agent.
     */
    async handleItemResult(result) {
        const { queueId, status, messageId, error, tenantId, deviceId } = result;

        console.log(`📥 [Queue Result] Job ${queueId} -> ${status}${messageId ? ` (ID: ${messageId})` : ''}`);

        // Handle in Mock Store
        const mockIdx = mockQueue.findIndex(j => j.id === queueId);
        if (mockIdx !== -1) {
            mockQueue[mockIdx].status = status;
            mockQueue[mockIdx].messageId = messageId;
            mockQueue[mockIdx].error = error;
            if (tenantId || mockQueue[mockIdx].tenant_id) {
                usageTracker.recordUsage(tenantId || mockQueue[mockIdx].tenant_id, 1, status === 'SENT');
            }
            return;
        }

        if (tenantId) {
            usageTracker.recordUsage(tenantId, 1, status === 'SENT');
        }

        if (!isConfigured()) return;

        try {
            // Update queue record
            const updates = {
                status,
                updated_at: new Date().toISOString()
            };

            if (status === 'SENT') {
                updates.sent_at = new Date().toISOString();
                updates.error = null;
            } else if (status === 'FAILED') {
                updates.error = error || 'Unknown delivery failure';
            }

            const { data: updatedJob } = await supabaseAdmin
                .from('message_queue')
                .update(updates)
                .eq('id', queueId)
                .select()
                .single();

            // Insert into message_logs
            if (updatedJob) {
                await supabaseAdmin.from('message_logs').insert({
                    tenant_id: updatedJob.tenant_id,
                    queue_id: updatedJob.id,
                    status: status,
                    error: error || null,
                    details: { messageId, deviceId }
                });

                // If sent, archive in messages table
                if (status === 'SENT') {
                    await supabaseAdmin.from('messages').insert({
                        tenant_id: updatedJob.tenant_id,
                        whatsapp_account_id: updatedJob.whatsapp_account_id,
                        phone: updatedJob.phone,
                        message: updatedJob.message,
                        status: 'SENT',
                        message_id: messageId
                    });
                }
            }

            // Notify Web Dashboards of queue progress
            if (tenantId) {
                wsHub.broadcastToTenantBrowsers(tenantId, 'queue:update', {
                    queueId,
                    status,
                    messageId
                });
            }

        } catch (err) {
            console.error('Error handling item result in DB:', err.message);
        }
    }

    async processMockQueue() {
        for (const job of mockQueue) {
            if (job.status !== 'PENDING') continue;
            if (pausedTenants.has(job.tenant_id)) continue;

            if (wsHub.isDeviceOnline(job.tenant_id, job.device_id)) {
                job.status = 'PROCESSING';
                wsHub.sendToDevice(job.tenant_id, job.device_id, 'queue:dispatch', {
                    batchId: `batch_${Date.now()}`,
                    items: [{
                        id: job.id,
                        phone: job.phone,
                        message: job.message,
                        attachmentPath: job.attachment_path,
                        attachmentUrl: job.attachment_url
                    }]
                });
            }
        }
    }
}

module.exports = {
    queueDispatcher: new QueueDispatcher(),
    mockQueue,
    pausedTenants
};
