'use strict';
const fs = require('fs');
const path = require('path');
const {
  parseListQuery,
  listResponse,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} = require('../lib/pagination');

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

console.log('W1-PAGE test-list-pagination');
const d1 = parseListQuery({});
ok('defaults page=1', d1.page === 1);
ok('defaults pageSize=50', d1.pageSize === DEFAULT_PAGE_SIZE);
ok('defaults offset=0', d1.offset === 0);
const d2 = parseListQuery({ page: '2', limit: '10' });
ok('limit alias', d2.pageSize === 10 && d2.page === 2 && d2.offset === 10);
const d3 = parseListQuery({ pageSize: '999' });
ok('caps pageSize', d3.pageSize === MAX_PAGE_SIZE);
const d4 = parseListQuery({ filters: '{"city":"Mashhad"}' });
ok('filters json', d4.filters && d4.filters.city === 'Mashhad');

const legacy = listResponse([], { page: 1, pageSize: 50, total: 0 }, {});
ok('legacy empty array', Array.isArray(legacy) && legacy.length === 0);
const env = listResponse([], { page: 1, pageSize: 50, total: 0 }, { page: '1' });
ok('envelope when page set', env.success === true && env.pagination.total === 0);

const routesDir = path.join(__dirname, '..', 'routes');
for (const f of ['customers.js', 'orders.js', 'followups.js', 'suppliers.js', 'persons.js']) {
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  ok(`${f} imports pagination`, /require\(['"]\.\.\/lib\/pagination['"]\)/.test(src));
  ok(`${f} uses parseListQuery`, /parseListQuery\(/.test(src));
  ok(`${f} uses listResponse`, /listResponse\(/.test(src));
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
