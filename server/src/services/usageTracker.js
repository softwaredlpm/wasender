const { supabaseAdmin, isConfigured } = require('../config/supabase');

// In-memory mock store for unit testing & sandbox offline mode
// Key: `${tenantId}:${dateString}` -> { tenant_id, usage_date, messages_sent, messages_failed }
const mockUsageStore = new Map();

class UsageTracker {
    /**
     * Records a message dispatch in the daily usage counter.
     */
    async recordUsage(tenantId, count = 1, isSuccess = true) {
        if (!tenantId) return;

        const today = new Date().toISOString().split('T')[0];

        if (isConfigured()) {
            try {
                // Upsert daily usage
                const { data: existing } = await supabaseAdmin
                    .from('usage_daily')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('usage_date', today)
                    .maybeSingle();

                if (existing) {
                    await supabaseAdmin
                        .from('usage_daily')
                        .update({
                            messages_sent: isSuccess ? existing.messages_sent + count : existing.messages_sent,
                            messages_failed: !isSuccess ? existing.messages_failed + count : existing.messages_failed
                        })
                        .eq('id', existing.id);
                } else {
                    await supabaseAdmin
                        .from('usage_daily')
                        .insert({
                            tenant_id: tenantId,
                            usage_date: today,
                            messages_sent: isSuccess ? count : 0,
                            messages_failed: !isSuccess ? count : 0
                        });
                }
            } catch (err) {
                console.error('[UsageTracker] Error updating database:', err.message);
            }
        }

        // Always maintain in-memory mock store for fast tests and offline operation
        const key = `${tenantId}:${today}`;
        const current = mockUsageStore.get(key) || {
            tenant_id: tenantId,
            usage_date: today,
            messages_sent: 0,
            messages_failed: 0
        };

        if (isSuccess) {
            current.messages_sent += count;
        } else {
            current.messages_failed += count;
        }
        mockUsageStore.set(key, current);
    }

    /**
     * Returns daily usage for a tenant across the past N days.
     */
    async getTenantUsage(tenantId, days = 30) {
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - days);
        const sinceStr = sinceDate.toISOString().split('T')[0];

        if (isConfigured()) {
            const { data, error } = await supabaseAdmin
                .from('usage_daily')
                .select('*')
                .eq('tenant_id', tenantId)
                .gte('usage_date', sinceStr)
                .order('usage_date', { ascending: true });

            if (!error && data && data.length > 0) {
                let totalSent = 0;
                let totalFailed = 0;
                data.forEach(d => {
                    totalSent += d.messages_sent || 0;
                    totalFailed += d.messages_failed || 0;
                });

                return {
                    daily: data,
                    totalSent,
                    totalFailed,
                    deliveryRate: totalSent + totalFailed > 0 ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(1) : 100.0
                };
            }
        }

        // Mock Store Lookup
        const daily = [];
        let totalSent = 0;
        let totalFailed = 0;

        for (const [key, item] of mockUsageStore.entries()) {
            if (item.tenant_id === tenantId && item.usage_date >= sinceStr) {
                daily.push(item);
                totalSent += item.messages_sent;
                totalFailed += item.messages_failed;
            }
        }

        daily.sort((a, b) => a.usage_date.localeCompare(b.usage_date));

        return {
            daily,
            totalSent,
            totalFailed,
            deliveryRate: totalSent + totalFailed > 0 ? Number(((totalSent / (totalSent + totalFailed)) * 100).toFixed(1)) : 100.0
        };
    }

    /**
     * Checks if tenant has remaining quota capacity for the current month.
     */
    async checkQuotaHeadroom(tenantId, requestedCount = 1) {
        let planLimit = 1000; // Default Standard Trial
        let planName = 'Trial Plan';

        if (isConfigured()) {
            try {
                const { data: sub } = await supabaseAdmin
                    .from('subscriptions')
                    .select('*, plans(*)')
                    .eq('tenant_id', tenantId)
                    .eq('status', 'ACTIVE')
                    .maybeSingle();

                if (sub && sub.plans) {
                    planLimit = sub.plans.message_limit || 1000;
                    planName = sub.plans.name;
                }
            } catch (_) {}
        }

        const currentMonthUsage = await this.getTenantUsage(tenantId, 30);
        const usedThisMonth = currentMonthUsage.totalSent;
        const remaining = Math.max(0, planLimit - usedThisMonth);
        const allowed = (usedThisMonth + requestedCount) <= planLimit;

        return {
            allowed,
            planName,
            planLimit,
            usedThisMonth,
            remaining,
            percentUsed: Number(((usedThisMonth / planLimit) * 100).toFixed(1))
        };
    }
}

module.exports = {
    usageTracker: new UsageTracker(),
    mockUsageStore
};
