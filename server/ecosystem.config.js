// رمز JWT هرگز اینجا (داخل گیت) نوشته نشود.
// از فایل server/jwt-secret.txt (خارج از گیت — در .gitignore) یا متغیر محیطی JWT_SECRET خوانده می‌شود:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > jwt-secret.txt
//   chmod 600 jwt-secret.txt
const fs = require('fs');
let JWT_SECRET = process.env.JWT_SECRET || '';
try {
  JWT_SECRET = fs.readFileSync(__dirname + '/jwt-secret.txt', 'utf8').trim() || JWT_SECRET;
} catch { /* فایل هنوز ساخته نشده — server.js در production بدون JWT_SECRET بالا نمی‌آید */ }

module.exports = {
  apps: [{
    name: 'crm-taranom',
    script: 'server.js',
    cwd: __dirname,
    exec_mode: 'fork', // cluster + Express listen() → EADDRINUSE on port 3000
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      JWT_SECRET
    }
  }]
};
