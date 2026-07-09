module.exports = {
  apps: [{
    name: 'crm-taranom',
    script: 'server.js',
    cwd: '/home/taranom-admin/crm-taranom/server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // ⚠️ قبل از deploy نسخهٔ امنیتی: JWT_SECRET باید ≥۳۲ کاراکتر باشد (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
      JWT_SECRET: 'taranom-crm-secret-2024-change-this'
    }
  }]
};
