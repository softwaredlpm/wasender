/**
 * Request Input Sanitizer & Security Filtering Middleware
 * Protects against:
 * 1. Prototype Pollution (strips __proto__, constructor, prototype)
 * 2. Null Byte Injection (\0, %00)
 * 3. Cross-Site Scripting (XSS / Script Tag injection)
 * 4. HTTP Parameter Pollution (HPP - normalizes query arrays to single scalar)
 */

// Forbidden keys for prototype pollution defense
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Regex patterns for script and dangerous HTML tags/events
const DANGEROUS_TAGS_REGEX = /<\s*(script|iframe|object|embed|applet|meta|link|base)[^>]*>.*?<\s*\/\s*\1\s*>|<\s*(script|iframe|object|embed|applet|meta|link|base)[^>]*\/?>/gis;
const DANGEROUS_ATTRS_REGEX = /\s*(on\w+|formaction)\s*=\s*(['"][^'"]*['"]|[^\s>]+)/gi;
const JAVASCRIPT_URI_REGEX = /javascript\s*:\s*[^"'\s>]+/gi;
const NULL_BYTE_REGEX = /\0|%00/g;

/**
 * Sanitizes a single string value
 * @param {string} val
 * @returns {string}
 */
function sanitizeString(val) {
    if (typeof val !== 'string') return val;

    // 1. Remove null bytes
    let cleaned = val.replace(NULL_BYTE_REGEX, '');

    // 2. Remove dangerous executable tags (<script>, <iframe>, etc.)
    cleaned = cleaned.replace(DANGEROUS_TAGS_REGEX, '');

    // 3. Remove inline event handlers like onload=, onerror=, onclick=
    cleaned = cleaned.replace(DANGEROUS_ATTRS_REGEX, '');

    // 4. Remove javascript: pseudo-protocols
    cleaned = cleaned.replace(JAVASCRIPT_URI_REGEX, '');

    return cleaned;
}

/**
 * Deeply cleanses an object or array against prototype pollution and malicious strings
 * @param {any} target
 * @returns {any}
 */
function deepSanitize(target) {
    if (target === null || target === undefined) return target;

    if (typeof target === 'string') {
        return sanitizeString(target);
    }

    if (Array.isArray(target)) {
        return target.map(item => deepSanitize(item));
    }

    if (typeof target === 'object' && target.constructor === Object) {
        const cleaned = {};
        for (const [key, value] of Object.entries(target)) {
            // Check prototype pollution keys
            if (FORBIDDEN_KEYS.has(key)) {
                continue; // Drop dangerous property entirely
            }

            // Sanitize key itself in case of null bytes
            const safeKey = sanitizeString(key);
            cleaned[safeKey] = deepSanitize(value);
        }
        return cleaned;
    }

    return target;
}

/**
 * Normalizes query parameters to prevent HTTP Parameter Pollution (HPP)
 * If an attacker sends duplicate keys (?page=1&page=2), selects the last value.
 * Preserves tags or array fields if explicitly intended.
 */
function normalizeQueryParams(query) {
    if (!query || typeof query !== 'object') return query;

    const normalized = {};
    for (const [key, value] of Object.entries(query)) {
        if (FORBIDDEN_KEYS.has(key)) continue;

        if (Array.isArray(value)) {
            // If field is known array like 'tags', keep array sanitized; otherwise pick last item
            if (key === 'tags' || key === 'status') {
                normalized[key] = value.map(v => typeof v === 'string' ? sanitizeString(v) : v);
            } else {
                const lastVal = value[value.length - 1];
                normalized[key] = typeof lastVal === 'string' ? sanitizeString(lastVal) : lastVal;
            }
        } else if (typeof value === 'string') {
            normalized[key] = sanitizeString(value);
        } else {
            normalized[key] = value;
        }
    }
    return normalized;
}

/**
 * Express middleware for global request input sanitization
 */
function requestSanitizer(req, res, next) {
    try {
        if (req.body && typeof req.body === 'object') {
            req.body = deepSanitize(req.body);
        }

        if (req.query && typeof req.query === 'object') {
            req.query = normalizeQueryParams(req.query);
        }

        if (req.params && typeof req.params === 'object') {
            req.params = deepSanitize(req.params);
        }

        next();
    } catch (err) {
        console.error('Request sanitization error:', err);
        return res.status(400).json({
            success: false,
            error: 'Malformed request content or invalid encoding.'
        });
    }
}

module.exports = {
    requestSanitizer,
    sanitizeString,
    deepSanitize,
    normalizeQueryParams
};
