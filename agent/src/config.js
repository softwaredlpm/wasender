const fs = require('fs');
const path = require('path');

function resolveConfigFile() {
    if (process.pkg) {
        // 1. Portable mode: beside executable
        const exeDir = path.dirname(process.execPath);
        const portableConfig = path.join(exeDir, 'agent.config.json');
        if (fs.existsSync(portableConfig)) return portableConfig;

        // 2. Standard Windows AppData directory
        const appDataDir = process.env.APPDATA
            ? path.join(process.env.APPDATA, 'WASENDER')
            : exeDir;
        if (!fs.existsSync(appDataDir)) {
            try { fs.mkdirSync(appDataDir, { recursive: true }); } catch (_) {}
        }
        return path.join(appDataDir, 'agent.config.json');
    }

    // Development mode: project root of agent
    return path.join(__dirname, '..', 'agent.config.json');
}

const CONFIG_FILE = resolveConfigFile();

const defaultConfig = {
    cloudApiUrl: process.env.VPS_API_URL || 'http://localhost:5001',
    agentVersion: '1.0.0',
    deviceName: 'Workstation PC',
    tenantId: null,
    deviceId: null,
    deviceToken: null,
    isPaired: false,
    pairedAt: null
};

class AgentConfigManager {
    constructor() {
        this.config = this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                return { ...defaultConfig, ...data };
            }
        } catch (err) {
            console.error('Error loading agent.config.json:', err.message);
        }
        return { ...defaultConfig };
    }

    save(updates = {}) {
        try {
            this.config = { ...this.config, ...updates };
            const dir = path.dirname(CONFIG_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
            return this.config;
        } catch (err) {
            console.error('Error saving agent.config.json:', err.message);
            throw err;
        }
    }

    get() {
        return this.config;
    }

    getConfigFilePath() {
        return CONFIG_FILE;
    }

    unpair() {
        return this.save({
            tenantId: null,
            deviceId: null,
            deviceToken: null,
            isPaired: false,
            pairedAt: null
        });
    }

    isPaired() {
        return Boolean(this.config.isPaired && this.config.deviceId && this.config.deviceToken);
    }
}

module.exports = new AgentConfigManager();
module.exports.AgentConfigManager = AgentConfigManager;
module.exports.resolveConfigFile = resolveConfigFile;
