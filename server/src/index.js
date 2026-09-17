const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config();

const authRoutes = require('./routes/auth');
const tenantRoutes = require('./routes/tenants');
const agentRoutes = require('./routes/agent');
const deviceRoutes = require('./routes/devices');
const whatsappRoutes = require('./routes/whatsapp');
const messageRoutes = require('./routes/messages');
const contactsRoutes = require('./routes/contacts');
const templateRoutes = require('./routes/templates');
const attachmentRoutes = require('./routes/attachments');
const busyRoutes = require('./routes/busy');
const reportsRoutes = require('./routes/reports');
const logsRoutes = require('./routes/logs');
const billingRoutes = require('./routes/billing');
const wsHub = require('./websocket/hub');
const { queueDispatcher } = require('./services/queueDispatcher');
const { error, success } = require('./utils/response');

const helmet = require('helmet');
const { requestSanitizer } = require('./middleware/sanitizer');
const {
    authLimiter,
    pairingLimiter,
    messageSendLimiter,
    generalApiLimiter
} = require('./middleware/rateLimiter');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5001; // Default to 5001 for cloud API if running locally alongside legacy port 5000

// Initialize WebSocket Hub for both Agents (/agent/ws) and Browsers (/browser/ws)
wsHub.init(server);

// Start Queue Dispatcher Polling Engine
queueDispatcher.start(3000);

// Security Headers via Helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"]
        }
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    frameguard: {
        action: 'deny'
    },
    noSniff: true,
    dnsPrefetchControl: {
        allow: false
    },
    referrerPolicy: {
        policy: 'strict-origin-when-cross-origin'
    },
    crossOriginResourcePolicy: {
        policy: 'cross-origin'
    },
    hidePoweredBy: true
}));

// CORS Configuration
app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    credentials: true
}));

// Request Body Parsing with Payload Size Limits (10MB)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Input Validation, Anti-XSS & Prototype Pollution Sanitizer
app.use(requestSanitizer);

// Rate Limiting Protection on Critical Surfaces
app.use('/api/v1/auth/login', authLimiter);
app.use('/api/v1/auth/register', authLimiter);
app.use('/api/v1/auth/refresh', authLimiter);
app.use('/api/v1/agent/pairing-code', pairingLimiter);
app.use('/api/v1/devices/pairing-code', pairingLimiter);
app.use('/api/v1/messages/bulk-send', messageSendLimiter);
app.use('/api/v1', generalApiLimiter);

// Request logging in development
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    return success(res, {
        status: 'UP',
        service: 'WASENDER Cloud VPS API & WebSocket',
        version: '1.0.0',
        websocketChannels: {
            agent: '/agent/ws',
            browser: '/browser/ws'
        },
        uptime: process.uptime()
    }, 'Service is operational.');
});

// Mount Versioned API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/tenants', tenantRoutes);
app.use('/api/v1/agent', agentRoutes);
app.use('/api/v1/devices', deviceRoutes);
app.use('/api/v1/whatsapp', whatsappRoutes);
app.use('/api/v1/messages', messageRoutes);
app.use('/api/v1/contacts', contactsRoutes);
app.use('/api/v1/templates', templateRoutes);
app.use('/api/v1/attachments', attachmentRoutes);
app.use('/api/v1/busy', busyRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use('/api/v1/logs', logsRoutes);
app.use('/api/v1/billing', billingRoutes);

// Serve Static Frontend Assets (Web Dashboard)
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath, { index: false }));

// Web Dashboard Route
app.get('/dashboard', (req, res) => {
    return res.sendFile(path.join(publicPath, 'index.html'));
});

// Root Route: Serve Dashboard to Browsers, JSON API spec to programmatic clients
app.get('/', (req, res) => {
    const acceptsHtml = req.headers['accept']?.includes('text/html');
    if (acceptsHtml && fs.existsSync(path.join(publicPath, 'index.html'))) {
        return res.sendFile(path.join(publicPath, 'index.html'));
    }

    return success(res, {
        title: 'WASENDER Multi-Tenant SaaS API',
        version: 'v1',
        dashboard: '/dashboard',
        websocket: {
            agent: '/agent/ws',
            browser: '/browser/ws'
        },
        docs: '/docs/API_MAP.md'
    });
});

// 404 Catch-All
app.use((req, res) => {
    return error(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err);
    return error(res, 'An unexpected server error occurred.', 500, err.message);
});

// Server Initialization
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`🚀 WASENDER Cloud VPS API running on port ${PORT}`);
        console.log(`📡 Agent WebSocket: ws://localhost:${PORT}/agent/ws`);
        console.log(`📡 Browser WebSocket: ws://localhost:${PORT}/browser/ws`);
        console.log(`📡 Health check: http://localhost:${PORT}/health`);
        console.log(`🔐 Auth endpoints: http://localhost:${PORT}/api/v1/auth`);
        console.log(`🏢 Tenant endpoints: http://localhost:${PORT}/api/v1/tenants`);
        console.log(`💻 Agent endpoints: http://localhost:${PORT}/api/v1/agent`);
        console.log(`📱 Device endpoints: http://localhost:${PORT}/api/v1/devices`);
        console.log(`💬 WhatsApp endpoints: http://localhost:${PORT}/api/v1/whatsapp`);
        console.log(`📤 Messaging endpoints: http://localhost:${PORT}/api/v1/messages`);
    });
}

// Backward-compatible export
app.server = server;
app.wsHub = wsHub;
app.queueDispatcher = queueDispatcher;
app.authLimiter = authLimiter;
app.pairingLimiter = pairingLimiter;
app.messageSendLimiter = messageSendLimiter;
app.generalApiLimiter = generalApiLimiter;
module.exports = app;
module.exports.app = app;
module.exports.server = server;
module.exports.wsHub = wsHub;
