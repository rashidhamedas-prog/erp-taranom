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

module.exports = {
  apps: [{
    name: 'erp-taranom',
    script: 'server.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      PUBLIC_URL: process.env.PUBLIC_URL || 'https://erp.poshaktaranom.com',
      JWT_SECRET,
      DATA_ENCRYPTION_KEY,
    },
  }],
};
