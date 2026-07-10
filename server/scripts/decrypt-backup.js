// بازگشایی فایل پشتیبان رمزنگاری‌شده (AES-256-GCM)
// استفاده:  node scripts/decrypt-backup.js <file.tar.gz.enc> [خروجی]
// رمز از متغیر محیطی BACKUP_PASSWORD یا به‌صورت تعاملی خوانده می‌شود (در آرگومان ندهید تا در history شل نماند).
const path = require('path');
const readline = require('readline');
const { decryptFile } = require('../backup');

const src = process.argv[2];
if (!src) {
  console.error('استفاده: node scripts/decrypt-backup.js <file.enc> [خروجی]');
  process.exit(1);
}
const dest = process.argv[3] || src.replace(/\.enc$/, '') || src + '.dec';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a); }));
}

(async () => {
  const password = process.env.BACKUP_PASSWORD || await ask('رمز پشتیبان: ');
  if (!password) { console.error('رمز وارد نشد'); process.exit(1); }
  try {
    decryptFile(src, dest, password);
    console.log(`✅ بازگشایی شد → ${path.resolve(dest)}`);
  } catch (e) {
    console.error('❌ خطا در بازگشایی (رمز اشتباه یا فایل خراب):', e.message);
    process.exit(1);
  }
})();
