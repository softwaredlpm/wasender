/**
 * Sliding Window Rate Limiter Middleware
 * Protects APIs against brute force, credential stuffing, scraping, and DoS attacks.
 * Features standard RFC / IETF RateLimit headers and deterministic test reset capability.
 */

const { error } = require('../utils/response');

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = forwarded.split(',')[0].trim();
        if (first) return first;
    }
    return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Creates a sliding-window rate limiter middleware
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 * @param {number} options.max - Maximum allowed requests in the time window (default: 100)
 * @param {string} [options.message] - Custom error message
 * @param {Function} [options.keyGenerator] - Custom key extraction function (req) => string
 * @param {number} [options.statusCode] - HTTP status code on limit (default: 429)
 */
function createRateLimiter(options = {}) {
    const windowMs = options.windowMs || 60 * 1000;
    const max = options.max || 100;
    const statusCode = options.statusCode || 429;
    const defaultMsg = options.message || 'Too many requests from this client. Please slow down and try again later.';
    const keyGen = options.keyGenerator || ((req) => getClientIp(req));

    // Map: key -> Array<number> (timestamps in ms)
    const hitsStore = new Map();

    // Auto-cleanup stale entries to prevent memory accumulation
    const cleanupInterval = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [key, timestamps] of hitsStore.entries()) {
            const valid = timestamps.filter(t => t > cutoff);
            if (valid.length === 0) {
                hitsStore.delete(key);
            } else {
                hitsStore.set(key, valid);
            }
        }
    }, Math.max(30000, Math.floor(windowMs / 2)));

    // Ensure timer does not keep the Node event loop alive
    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }

    const limiter = function (req, res, next) {
        const key = keyGen(req);
        const now = Date.now();
        const cutoff = now - windowMs;

        const timestamps = (hitsStore.get(key) || []).filter(t => t > cutoff);

        if (timestamps.length >= max) {
            // Limit exceeded
            const oldest = timestamps[0];
            const retryAfterMs = Math.max(1000, (oldest + windowMs) - now);
            const retryAfterSec = Math.ceil(retryAfterMs / 1000);

            res.setHeader('RateLimit-Limit', String(max));
            res.setHeader('RateLimit-Remaining', '0');
            res.setHeader('RateLimit-Reset', String(retryAfterSec));
            res.setHeader('Retry-After', String(retryAfterSec));

            return res.status(statusCode).json({
                success: false,
                error: defaultMsg,
                retryAfter: retryAfterSec
            });
        }

        // Record current hit
        timestamps.push(now);
        hitsStore.set(key, timestamps);

        const remaining = Math.max(0, max - timestamps.length);
        const resetSec = Math.ceil(windowMs / 1000);

        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(remaining));
        res.setHeader('RateLimit-Reset', String(resetSec));

        next();
    };

    // Helper for automated testing & administrative resets
    limiter.reset = function () {
        hitsStore.clear();
    };

    limiter.getKeyHits = function (key) {
        const cutoff = Date.now() - windowMs;
        return (hitsStore.get(key) || []).filter(t => t > cutoff).length;
    };

    return limiter;
}

// Pre-configured limiters for critical application surfaces

// 1. Auth Limiter: Protects login, registration, password resets from brute force
const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per 15 mins per IP
    message: 'Too many authentication attempts. Please try again after 15 minutes.'
});

// 2. Pairing Limiter: Protects device pairing endpoints
const pairingLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 attempts per 15 mins
    message: 'Too many device pairing requests. Please try again later.'
});

// 3. Message Send Limiter: Protects WhatsApp outbound dispatch & queue submission
const messageSendLimiter = createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 bulk dispatch submissions per minute per tenant/IP
    keyGenerator: (req) => {
        const tenantId = req.tenant?.id || req.user?.id || 'anon';
        return `msg_${tenantId}_${getClientIp(req)}`;
    },
    message: 'Outbound messaging dispatch rate limit exceeded. Please throttle your campaign batches.'
});

// 4. General API Limiter: General defense against scraping and flood attacks
const generalApiLimiter = createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 300, // 300 requests per minute per IP
    message: 'API rate limit exceeded. Please reduce request frequency.'
});

module.exports = {
    createRateLimiter,
    authLimiter,
    pairingLimiter,
    messageSendLimiter,
    generalApiLimiter,
    getClientIp
};
