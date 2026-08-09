'use strict';
/**
 * W1-PAGE — pagination helper + route wiring checks.
 */
const fs = require('fs');
const path = require('path');
const { parseListQuery, paginatedJson, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require('../lib/pagination');

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

const empty = paginatedJson([], { page: 1, pageSize: 50, total: 0 });
ok('empty list shape', empty.success === true && Array.isArray(empty.data) && empty.data.length === 0 && empty.pagination.total === 0);

const routesDir = path.join(__dirname, '..', 'routes');
const files = ['customers.js', 'orders.js', 'followups.js', 'suppliers.js', 'persons.js'];
for (const f of files) {
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  ok(`${f} imports pagination`, /require\(['"]\.\.\/lib\/pagination['"]\)/.test(src));
  ok(`${f} uses parseListQuery`, /parseListQuery\(/.test(src));
  ok(`${f} uses paginatedJson`, /paginatedJson\(/.test(src));
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
