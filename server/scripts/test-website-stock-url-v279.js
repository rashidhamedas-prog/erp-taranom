/**
 * siteApiUrl resolution — Nest /v1 vs storefront /api/v1.
 * node server/scripts/test-website-stock-url-v279.js
 */
'use strict';

const { siteApiUrl } = require('../lib/website-stock-sync');

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('  ✓', msg);
}

console.log('website-stock-url v279');

ok(
  siteApiUrl('https://api.poshaktaranom.com', 'erp/inventory/matrix')
    === 'https://api.poshaktaranom.com/v1/erp/inventory/matrix',
  'api.poshaktaranom.com → /v1/...'
);
ok(
  siteApiUrl('https://api.poshaktaranom.com', 'erp/inventory/ping')
    === 'https://api.poshaktaranom.com/v1/erp/inventory/ping',
  'api host ping → /v1/...'
);
ok(
  siteApiUrl('https://poshaktaranom.com', 'erp/inventory/matrix')
    === 'https://poshaktaranom.com/api/v1/erp/inventory/matrix',
  'poshaktaranom.com storefront → /api/v1/...'
);
ok(
  siteApiUrl('https://poshaktaranom.ir', 'erp/inventory/ping')
    === 'https://poshaktaranom.ir/api/v1/erp/inventory/ping',
  '.ir storefront → /api/v1/...'
);
ok(
  siteApiUrl('https://api.poshaktaranom.com/v1', 'erp/inventory/matrix')
    === 'https://api.poshaktaranom.com/v1/erp/inventory/matrix',
  'base ending /v1 → append resource'
);
ok(
  siteApiUrl('https://poshaktaranom.com/api/v1', 'erp/inventory/matrix')
    === 'https://poshaktaranom.com/api/v1/erp/inventory/matrix',
  'base ending /api/v1 → append resource'
);
ok(
  siteApiUrl('http://127.0.0.1:4000', 'erp/inventory/matrix')
    === 'http://127.0.0.1:4000/v1/erp/inventory/matrix',
  'direct API port 4000 → /v1/...'
);
ok(
  siteApiUrl('https://api.poshaktaranom.com/', 'erp/inventory/matrix')
    === 'https://api.poshaktaranom.com/v1/erp/inventory/matrix',
  'trailing slash on base normalized'
);
ok(
  siteApiUrl('', 'erp/inventory/matrix') === '',
  'empty base → empty url'
);

console.log('ALL PASS');
process.exit(0);