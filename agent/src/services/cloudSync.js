const axios = require('axios');
const os = require('os');
const agentConfig = require('../config');

class CloudSyncService {
    constructor() {
        this.heartbeatTimer = null;
        this.isHeartbeatRunning = false;
    }

    /**
     * Registers this Windows PC with the Cloud SaaS using a one-time pairing code.
     */
    async registerWithPairingCode(pairingCode, customDeviceName = null) {
        const config = agentConfig.get();
        const deviceName = customDeviceName || os.hostname() || 'Windows Workstation';

        const payload = {
            pairingCode: pairingCode.trim().toUpperCase(),
            deviceName,
            agentVersion: config.agentVersion,
            systemInfo: {
                hostname: os.hostname(),
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                cpus: os.cpus().length,
                totalMemMB: Math.round(os.totalmem() / (1024 * 1024))
            }
        };

        try {
            console.log(`📡 Connecting to Cloud API: ${config.cloudApiUrl}/api/v1/agent/register...`);
            const response = await axios.post(`${config.cloudApiUrl}/api/v1/agent/register`, payload, {
                timeout: 15000
            });

            if (response.data && response.data.success) {
                const { deviceId, tenantId, deviceToken } = response.data.data;

                // Save permanently in local agent.config.json
                agentConfig.save({
                    deviceId,
                    tenantId,
                    deviceToken,
                    deviceName,
                    isPaired: true,
                    pairedAt: new Date().toISOString()
                });

                console.log(`✅ Registration successful! Device ID: ${deviceId}`);
                return { success: true, deviceId, tenantId };
            } else {
                throw new Error(response.data?.error || 'Registration failed');
            }
        } catch (err) {
            const errorMsg = err.response?.data?.error || err.message;
            console.error(`❌ Registration error: ${errorMsg}`);
            throw new Error(errorMsg);
        }
    }

    /**
     * Sends a single heartbeat ping to the Cloud server.
     */
    async sendHeartbeatOnce() {
        const config = agentConfig.get();

        if (!config.deviceId || !config.deviceToken) {
            throw new Error('Agent is not paired. Run registration first.');
        }

        const payload = {
            status: 'ONLINE',
            systemInfo: {
                uptimeSeconds: Math.round(process.uptime()),
                freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
                nodeVersion: process.version
            }
        };

        try {
            const response = await axios.post(`${config.cloudApiUrl}/api/v1/agent/heartbeat`, payload, {
                headers: {
                    'X-Device-Id': config.deviceId,
                    'X-Device-Token': config.deviceToken
                },
                timeout: 10000
            });

            return response.data;
        } catch (err) {
            const errorMsg = err.response?.data?.error || err.message;
            console.warn(`⚠️ Heartbeat failed: ${errorMsg}`);
            throw new Error(errorMsg);
        }
    }

    /**
     * Starts continuous periodic background heartbeat.
     */
    startHeartbeat(intervalMs = 30000) {
        if (this.isHeartbeatRunning) return;
        this.isHeartbeatRunning = true;

        console.log(`💓 Starting cloud heartbeat service (interval: ${intervalMs / 1000}s)...`);

        // Send immediately on start
        this.sendHeartbeatOnce().catch(() => {});

        this.heartbeatTimer = setInterval(async () => {
            try {
                await this.sendHeartbeatOnce();
            } catch (e) {
                // Heartbeat error logged inside sendHeartbeatOnce, retry automatically next tick
            }
        }, intervalMs);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.isHeartbeatRunning = false;
        console.log('🛑 Cloud heartbeat service stopped.');
    }
}

module.exports = new CloudSyncService();
