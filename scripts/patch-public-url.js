const fs = require('fs');
const p = process.argv[2] || '/home/taranom/crm-taranom/server/ecosystem.config.js';
let t = fs.readFileSync(p, 'utf8');
if (t.includes('PUBLIC_URL')) {
  console.log('PUBLIC_URL already present');
  process.exit(0);
}
if (!t.includes('PORT: 3000')) {
  console.error('PORT: 3000 not found');
  process.exit(1);
}
t = t.replace(
  'PORT: 3000,',
  "PORT: 3000,\n      PUBLIC_URL: process.env.PUBLIC_URL || 'https://erp.poshaktaranom.com',"
);
fs.writeFileSync(p, t);
console.log('PUBLIC_URL added');
