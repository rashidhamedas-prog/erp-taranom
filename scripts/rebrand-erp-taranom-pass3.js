/**
 * Pass 3 — remaining product-name rebrand (keep real disk paths & keystore filenames).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'server/public/manifest.json',
  'server/server.js',
  'server/routes/auth.js',
  'server/scripts/seed-demo.js',
  'server/scripts/recover-production-db.sh',
  'server/scripts/mahak-go-live.js',
  'server/scripts/import-mahak-journal.js',
  'scripts/bootstrap-iran-vps.sh',
  'scripts/vnc-finish-harden.sh',
  'scripts/ubuntu-harden.sh',
  'docs/Production/README.md',
  'docs/Production/cursor-prompt.md',
  'docs/Production/test-cases.md',
  'docs/Production/01-production-formulas.md',
  'android/app/src/main/java/ir/taranom/crm/MainActivity.java',
  'CLAUDE.md',
];

const PAIRS = [
  ['CRM ترنم', 'ERP ترنم'],
  ['CRM Taranom', 'ERP Taranom'],
  ['سیستم CRM', 'سیستم ERP'],
  ['نرم‌افزار CRM', 'نرم‌افزار ERP'],
  ['سامانه مدیریت ارتباط با مشتریان پوشاک ترنم', 'سامانه یکپارچه ERP پوشاک ترنم'],
  ['سامانه مدیریت مشتریان', 'سامانه ERP'],
  ['Bootstrap CRM', 'Bootstrap ERP'],
  ['Deploy CRM', 'Deploy ERP'],
  ['ورود اسناد محک به CRM', 'ورود اسناد محک به ERP'],
  ['pm2 restart crm-taranom', 'pm2 restart erp-taranom'],
  ['pm2 stop crm-taranom', 'pm2 stop erp-taranom'],
  ['pm2 start crm-taranom', 'pm2 start erp-taranom'],
  ['pm2 delete crm-taranom', 'pm2 delete erp-taranom'],
  ['pm2 logs crm-taranom', 'pm2 logs erp-taranom'],
  ['PM2: crm-taranom', 'PM2: erp-taranom'],
  ['PM2: `crm-taranom`', 'PM2: `erp-taranom`'],
  ['name: \'crm-taranom\'', "name: 'erp-taranom'"],
  ['"CRMTaranom"', '"ERPTaranom"'],
  ['CRMTaranomAndroid/', 'ERPTaranomAndroid/'],
  ['ماژول «عملیات تولید» — CRM Taranom', 'ماژول «عملیات تولید» — ERP Taranom'],
  ['مخزن: crm-taranom (Node.js', 'مخزن: erp-taranom / crm-taranom (Node.js'],
];

function restorePaths(text) {
  return text
    .split('/home/taranom/erp-taranom').join('/home/taranom/crm-taranom')
    .split('/home/taranom-admin/erp-taranom').join('/home/taranom-admin/crm-taranom')
    .split('~/erp-taranom').join('~/crm-taranom')
    .split('$HOME/erp-taranom').join('$HOME/crm-taranom')
    .split('/var/www/erp-taranom').join('/var/www/crm-taranom')
    .split('sites-available/erp-taranom').join('sites-available/crm-taranom')
    .split('sites-enabled/erp-taranom').join('sites-enabled/crm-taranom')
    .split('crm-taranom.jks').join('crm-taranom.jks') // noop keep
    .split('alias erp-taranom').join('alias crm-taranom'); // keystore alias
}

let n = 0;
for (const rel of FILES) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) continue;
  let t = fs.readFileSync(fp, 'utf8');
  const o = t;
  for (const [a, b] of PAIRS) t = t.split(a).join(b);
  t = restorePaths(t);
  if (t !== o) {
    fs.writeFileSync(fp, t);
    console.log('updated', rel);
    n++;
  }
}
console.log('done', n, 'files');
