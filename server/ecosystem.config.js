/**
 * PM2 Production Ecosystem Configuration
 * Enables zero-downtime reloads, automatic clustering, and log rotation.
 * Run with: pm2 start ecosystem.config.js --env production
 */

module.exports = {
  apps: [
    {
      name: 'wasender-api',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 'max',
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 5000,
      listen_timeout: 8000,
      error_file: 'logs/pm2-err.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'development',
        PORT: 5001
      },
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 5001
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5001
      }
    }
  ]
};
