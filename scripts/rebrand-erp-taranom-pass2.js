const fs = require('fs');
const files = [
  'desktop/main.js',
  'desktop/package-lock.json',
  'docs/OFFLINE-SYNC.md',
  'docs/PROJECT-HANDOFF.md',
  'docs/SECURITY-HARDENING.md',
  'docs/MAHAK-MIGRATION.md',
  'docs/Production/cursor-prompt.md',
];
const pairs = [
  ['CRM-Taranom', 'ERP-Taranom'],
  ['crm-taranom-desktop', 'erp-taranom-desktop'],
  ['CRM Taranom', 'ERP Taranom'],
  ['CRM ترنم', 'ERP ترنم'],
  ['pm2 restart crm-taranom', 'pm2 restart erp-taranom'],
  ['pm2 stop crm-taranom', 'pm2 stop erp-taranom'],
  ['pm2 logs crm-taranom', 'pm2 logs erp-taranom'],
  ['PM2: crm-taranom', 'PM2: erp-taranom'],
  ['process name `crm-taranom`', 'process name `erp-taranom`'],
  ['· PM2: `crm-taranom`', '· PM2: `erp-taranom`'],
];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let t = fs.readFileSync(f, 'utf8');
  const o = t;
  for (const [a, b] of pairs) t = t.split(a).join(b);
  // keep real disk paths
  t = t.split('/home/taranom/erp-taranom').join('/home/taranom/crm-taranom');
  t = t.split('/home/taranom-admin/erp-taranom').join('/home/taranom-admin/crm-taranom');
  t = t.split('~/erp-taranom').join('~/crm-taranom');
  if (t !== o) {
    fs.writeFileSync(f, t);
    console.log('updated', f);
  }
}
console.log('done');
