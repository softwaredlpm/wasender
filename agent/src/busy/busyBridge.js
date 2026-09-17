const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class BusyBridge {
    constructor() {
        this.appDir = this.resolveAppDir();
        this.configPath = this.resolveConfigPath();
        this.psBridgePath = this.resolveBridgeScriptPath();
    }

    resolveAppDir() {
        if (process.pkg) {
            // Priority: AppData folder for installed service, or executable directory for portable
            const appDataDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'WASENDER') : null;
            if (appDataDir && fs.existsSync(path.join(appDataDir, 'busy_config.json'))) {
                return appDataDir;
            }
            return path.dirname(process.execPath);
        }
        // If running from within agent/src/busy/, check agent root or repo root
        const agentRoot = path.join(__dirname, '..', '..');
        if (fs.existsSync(path.join(agentRoot, 'busy_db_bridge.ps1'))) {
            return agentRoot;
        }
        const repoRoot = path.join(__dirname, '..', '..', '..');
        if (fs.existsSync(path.join(repoRoot, 'busy_db_bridge.ps1'))) {
            return repoRoot;
        }
        return process.cwd();
    }

    resolveConfigPath() {
        const candidate1 = path.join(this.appDir, 'busy_config.json');
        if (fs.existsSync(candidate1)) return candidate1;
        const candidate2 = path.join(process.cwd(), 'busy_config.json');
        if (fs.existsSync(candidate2)) return candidate2;

        const appDataDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'WASENDER') : null;
        if (appDataDir) {
            const candidate3 = path.join(appDataDir, 'busy_config.json');
            if (fs.existsSync(candidate3)) return candidate3;
        }

        // Auto-seed default template if missing
        try {
            const targetDir = this.appDir;
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            fs.writeFileSync(candidate1, JSON.stringify({ activeFirm: '', firms: [] }, null, 2));
            return candidate1;
        } catch (_) {
            return candidate1;
        }
    }

    resolveBridgeScriptPath() {
        const candidate1 = path.join(this.appDir, 'busy_db_bridge.ps1');
        if (fs.existsSync(candidate1)) return candidate1;
        const candidate2 = path.join(process.cwd(), 'busy_db_bridge.ps1');
        if (fs.existsSync(candidate2)) return candidate2;

        const appDataDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'WASENDER') : null;
        if (appDataDir) {
            const candidate3 = path.join(appDataDir, 'busy_db_bridge.ps1');
            if (fs.existsSync(candidate3)) return candidate3;
        }

        // If running packaged with pkg, extract embedded snapshot script to target directory
        try {
            const bundledCandidates = [
                path.join(__dirname, '..', '..', 'busy_db_bridge.ps1'),
                path.join(__dirname, '..', '..', '..', 'busy_db_bridge.ps1')
            ];
            for (const b of bundledCandidates) {
                if (fs.existsSync(b)) {
                    const dest = candidate1;
                    const destDir = path.dirname(dest);
                    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(b, dest);
                    return dest;
                }
            }
        } catch (_) {}

        return candidate1;
    }

    /**
     * Reads and returns configured firms from local busy_config.json
     */
    listFirms() {
        try {
            if (!fs.existsSync(this.configPath)) {
                return [];
            }
            const content = fs.readFileSync(this.configPath, 'utf8');
            const parsed = JSON.parse(content);
            const rawFirms = Array.isArray(parsed.firms) ? parsed.firms : [];

            return rawFirms.map((f, index) => {
                // Derive firm code (e.g. COMP0004 or firm_1)
                let firmCode = `FIRM_${index + 1}`;
                if (f.dbPath) {
                    const match = f.dbPath.match(/(comp\d+)/i);
                    if (match) firmCode = match[1].toUpperCase();
                }

                return {
                    id: f.id || `firm_${index + 1}`,
                    name: f.name || f.companyName || `Firm ${index + 1}`,
                    companyName: f.companyName || f.name || '',
                    companyAddress: f.companyAddress || '',
                    companyGst: f.companyGst || '',
                    firmCode: f.firmCode || firmCode,
                    dbType: f.dbType || 'Access',
                    dbPath: f.dbPath || '',
                    targetGroup: f.targetGroup || 'Sundry Debtors',
                    status: 'ACTIVE'
                };
            });
        } catch (err) {
            console.error('[BusyBridge] Error reading busy_config.json:', err.message);
            return [];
        }
    }

    /**
     * Runs PowerShell bridge command against local database
     */
    runPsBridge(action, options = {}) {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(this.psBridgePath)) {
                return reject(new Error(`busy_db_bridge.ps1 not found at: ${this.psBridgePath}`));
            }

            const {
                data = '',
                dbPath = '',
                dbPassword = 'ILoveMyINDIA',
                dbType = 'Access',
                dbServer = '',
                dbUser = ''
            } = options;

            if (!dbPath && dbType === 'Access') {
                return reject(new Error('dbPath is required for Access database connection.'));
            }

            const args = [
                '-ExecutionPolicy', 'Bypass',
                '-File', this.psBridgePath,
                '-Action', action,
                '-Data', data,
                '-DbPath', dbPath,
                '-DbPassword', dbPassword,
                '-DbType', dbType,
                '-DbServer', dbServer,
                '-DbUser', dbUser
            ];

            const startTime = Date.now();
            const ps = spawn('powershell', args, { windowsHide: true });

            let stdout = '';
            let stderr = '';

            ps.stdout.on('data', chunk => { stdout += chunk; });
            ps.stderr.on('data', chunk => { stderr += chunk; });

            ps.on('close', code => {
                const latencyMs = Date.now() - startTime;
                if (code !== 0) {
                    return reject(new Error(`PowerShell Bridge [${action}] failed with code ${code}: ${stderr || stdout}`));
                }

                try {
                    const clean = stdout.trim();
                    if (!clean) return resolve({ data: [], latencyMs });
                    const parsed = JSON.parse(clean);
                    resolve({ data: parsed, latencyMs });
                } catch (e) {
                    // Non-JSON or plain string output
                    resolve({ data: stdout.trim(), latencyMs });
                }
            });

            ps.on('error', err => {
                reject(new Error(`Failed to spawn PowerShell: ${err.message}`));
            });
        });
    }

    /**
     * Tests connection to a BUSY database
     */
    async testConnection(options = {}) {
        const startTime = Date.now();
        let targetOptions = { ...options };

        // If firmId passed, lookup firm in config
        if (options.firmId && !options.dbPath) {
            const firms = this.listFirms();
            const found = firms.find(f => f.id === options.firmId);
            if (found) {
                targetOptions = {
                    ...targetOptions,
                    dbPath: found.dbPath,
                    dbType: found.dbType,
                    dbPassword: found.dbPassword || targetOptions.dbPassword
                };
            }
        }

        // Test mode / Mock fallback when running in testing environments without live Access/MSSQL
        if (options.mock || process.env.NODE_ENV === 'test' || options.dbPath === 'MOCK_TEST') {
            return {
                connected: true,
                driver: targetOptions.dbType || 'Access',
                dbPath: targetOptions.dbPath || 'C:\\BusyWin\\DATA\\COMP0001',
                company: {
                    name: 'Demo Enterprises Pvt Ltd',
                    address: 'Plot 42, GIDC Industrial Estate, Vapi, Gujarat',
                    gstNo: '24AAACD1234E1Z5'
                },
                latencyMs: 15,
                testedAt: new Date().toISOString()
            };
        }

        try {
            const result = await this.runPsBridge('GET_COMPANY_INFO', targetOptions);
            const latencyMs = Date.now() - startTime;

            return {
                connected: true,
                driver: targetOptions.dbType || 'Access',
                dbPath: targetOptions.dbPath,
                company: result.data || {},
                latencyMs,
                testedAt: new Date().toISOString()
            };
        } catch (err) {
            return {
                connected: false,
                driver: targetOptions.dbType || 'Access',
                dbPath: targetOptions.dbPath,
                error: err.message,
                latencyMs: Date.now() - startTime,
                testedAt: new Date().toISOString()
            };
        }
    }

    /**
     * Fetches accounts / parties from BUSY
     */
    async getAccounts(options = {}) {
        if (options.mock || process.env.NODE_ENV === 'test') {
            return [
                { Code: 101, Name: 'Shree Krishna Traders', Phone: '919876543210', Balance: 45000 },
                { Code: 102, Name: 'Balaji Hardware Store', Phone: '919876543211', Balance: 12500 }
            ];
        }
        const result = await this.runPsBridge('GET_ACCOUNTS', options);
        return result.data;
    }
}

module.exports = new BusyBridge();
