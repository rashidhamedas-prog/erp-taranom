'use strict';

// Secrets must be supplied by the environment or local gitignored files.
// Never paste either value into this tracked configuration.
const fs = require('fs');

let JWT_SECRET = process.env.JWT_SECRET || '';
let DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || '';

try {
  JWT_SECRET = fs.readFileSync(__dirname + '/jwt-secret.txt', 'utf8').trim() || JWT_SECRET;
} catch { /* server.js validates JWT_SECRET during production boot. */ }

try {
  DATA_ENCRYPTION_KEY = fs.readFileSync(__dirname + '/data-encryption-key.txt', 'utf8').trim() || DATA_ENCRYPTION_KEY;
} catch { /* services/crypto.js validates the data key during production boot. */ }

// Non-secret production defaults for Iran central (override via env when needed).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  || 'https://erp.poshaktaranom.com,https://poshaktaranom.com';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://erp.poshaktaranom.com';
const BACKUP_OFFSITE_DIR = process.env.BACKUP_OFFSITE_DIR || '/home/taranom/crm-offsite-backups';
// Same-VPS offsite is not true DR; keep backups alive until S3/volume exists.
const BACKUP_ALLOW_SAME_DEVICE = process.env.BACKUP_ALLOW_SAME_DEVICE || '1';

module.exports = {
  apps: [{
    name: 'erp-taranom',
    script: 'server.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    // 300M was killing the process during WAL/mmap + reports → Cloudflare 521 on login.
    max_memory_restart: '1024M',
    kill_timeout: 10000,
    listen_timeout: 25000,
    wait_ready: true,
    min_uptime: 10000,
    exp_backoff_restart_delay: 2000,
    env: {
      NODE_ENV: 'production',
      PORT: Number(process.env.PORT) || 3000,
      PUBLIC_URL,
      ALLOWED_ORIGINS,
      BACKUP_OFFSITE_DIR,
      BACKUP_ALLOW_SAME_DEVICE,
      JWT_SECRET,
      DATA_ENCRYPTION_KEY,
    },
  }],
};
