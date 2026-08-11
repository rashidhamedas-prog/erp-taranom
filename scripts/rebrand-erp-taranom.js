/**
 * Rebrand display names: CRM ترنم / CRM Taranom / crm-taranom → ERP equivalents.
 * Does NOT touch: java package paths, DB filenames, wipe section keys, git remotes.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const files = [
  'server/public/index.html',
  'server/public/sw.js',
  'server/public/brochure.html',
  'server/public/demo.html',
  'brochure.html',
  'demo.html',
  'server/package.json',
  'server/ecosystem.config.js',
  'desktop/package.json',
  'android/app/src/main/res/values/strings.xml',
  'android/settings.gradle',
  'android/app/src/main/java/ir/taranom/crm/MainActivity.java',
  'android/app/src/main/assets/nodejs-project/package.json',
  'android/app/src/main/assets/nodejs-project/main.js',
  'android/app/src/main/assets/nodejs-project/package-lock.json',
  'CLAUDE.md',
  'crm-demo-plan.md',
  'docs/CHANGE-LOG.md',
  'docs/BUSINESS-PLAN.md',
  'docs/ACCOUNTING-MODULE-SPEC-ADAPTED.md',
  'docs/DESKTOP-UPDATE.md',
  'docs/MAHAK-IMPORT.md',
  'desktop/BUILD-WINDOWS.md',
  'android/BUILD.md',
  'scripts/deploy-production.sh',
  'scripts/setup-erp-domain.sh',
  'scripts/setup-erp-https-selfsigned.sh',
];

const pairs = [
  // Order matters: longer / more specific first
  ['CRM-Taranom', 'ERP-Taranom'],
  ['crm-taranom-desktop', 'erp-taranom-desktop'],
  ['crm-taranom-android', 'erp-taranom-android'],
  ['crm-taranom-v49', 'erp-taranom-v50'],
  ['crm-taranom-v', 'erp-taranom-v'],
  ['crm-taranom', 'erp-taranom'],
  ['CRM Taranom', 'ERP Taranom'],
  ['CRM ترنم', 'ERP ترنم'],
  ['سیستم CRM ترنم', 'سیستم ERP ترنم'],
  ['سامانه مدیریت مشتریان پوشاک ترنم', 'سامانه یکپارچه ERP پوشاک ترنم'],
  ['بازگشت به CRM', 'بازگشت به ERP'],
  ['داشبورد اصلی CRM', 'داشبورد اصلی ERP'],
  ['بخش CRM', 'بخش ERP'],
  ['صفحه CRM', 'صفحه ERP'],
  ['مسیر CRM', 'مسیر ERP'],
  ['در CRM ', 'در ERP '],
  ['به CRM،', 'به ERP،'],
  ['از CRM ', 'از ERP '],
  ['CRM محصولات', 'ERP محصولات'],
  ['مشاهده در CRM', 'مشاهده در ERP'],
  ['CRM: view-only', 'ERP: view-only'],
  ['CRM Pipeline', 'ERP Pipeline'],
  ['Deploy CRM ترنم', 'Deploy ERP ترنم'],
  ['نرم‌افزار مدیریت مشتریان', 'نرم‌افزار ERP یکپارچه'],
];

let changedFiles = 0;
for (const rel of files) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) continue;
  let text = fs.readFileSync(fp, 'utf8');
  const orig = text;
  for (const [from, to] of pairs) {
    if (text.includes(from)) text = text.split(from).join(to);
  }
  // Keep filesystem paths that still exist on disk
  text = text.split('/home/taranom-admin/erp-taranom').join('/home/taranom-admin/crm-taranom');
  text = text.split('/home/taranom/erp-taranom').join('/home/taranom/crm-taranom');
  // Keep APP_ROOT default folder name matching actual clone dir
  text = text.split("APP_ROOT:-$HOME/erp-taranom").join("APP_ROOT:-$HOME/crm-taranom");
  if (text !== orig) {
    fs.writeFileSync(fp, text);
    changedFiles++;
    console.log('updated', rel);
  }
}
console.log('done, files changed:', changedFiles);
