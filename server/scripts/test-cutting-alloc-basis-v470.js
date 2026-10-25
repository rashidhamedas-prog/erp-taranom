'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v470 / ADR-006 W1 — allocation_basis: pieces | fabric | manual | hybrid
 * Run: node server/scripts/test-cutting-alloc-basis-v470.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const appPath = path.join(__dirname, '../public/app.js');
const appSrc = fs.readFileSync(appPath, 'utf8');
ok(appSrc.includes('cuttingAllocBasis'), 'UI alloc basis helper');
ok(appSrc.includes('cl-alloc-basis'), 'UI select id');
ok(appSrc.includes('روش تسهیم هزینهٔ پارچه'), 'UI label');
ok(appSrc.includes('allocation_basis:cuttingAllocBasis'), 'body sends basis');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(sw, 471) || swAtLeast(sw, 470), 'SW v470+ lineage');

const adr = fs.readFileSync(path.join(__dirname, '../../docs/architecture/PROD-JOURNEY-ADR-006-cost-truth.md'), 'utf8');
ok(adr.includes('allocation_basis'), 'ADR-006 documents basis');
ok(adr.includes('قفل رسمی'), 'ADR-006 locks post-receipt cost policy');

const shared = require('../lib/production/shared-cut');
const { normalizeOutputs, normalizeAllocationBasis } = shared;

ok(normalizeAllocationBasis(undefined) === 'pieces', 'basis default pieces');
ok(normalizeAllocationBasis('hybrid') === 'hybrid', 'basis hybrid');
try {
  normalizeAllocationBasis('nope');
  ok('invalid basis throws', false);
} catch (e) {
  ok('invalid basis throws', e.code === 'E_ALLOC_BASIS');
}

const pieces = normalizeOutputs([
  { product_id: 1, size_code: 'M', pieces_per_ply: 2 },
  { product_id: 2, size_code: 'L', pieces_per_ply: 3 },
], 10, { allocation_basis: 'pieces' });
eq('pieces A%', pieces[0].weight, 40, 0.01);
eq('pieces B%', pieces[1].weight, 60, 0.01);

const fabric = normalizeOutputs([
  { product_id: 1, size_code: 'M', pieces_per_ply: 2, fabric_std_m: 1.3 },
  { product_id: 2, size_code: 'L', pieces_per_ply: 3, fabric_std_m: 1.655 },
], 10, { allocation_basis: 'fabric' });
const fabSum = fabric[0].weight + fabric[1].weight;
eq('fabric sum ~100', fabSum, 100, 0.05);
ok('fabric A < B (lower std×pcs)', fabric[0].weight < fabric[1].weight);

try {
  normalizeOutputs([
    { product_id: 1, size_code: 'M', pieces_per_ply: 2 },
    { product_id: 2, size_code: 'L', pieces_per_ply: 3 },
  ], 10, { allocation_basis: 'fabric' });
  ok('fabric without std throws', false);
} catch (e) {
  ok('fabric without std throws', e.code === 'E_ALLOC_FABRIC');
}

const manual = normalizeOutputs([
  { product_id: 1, size_code: 'M', pieces_per_ply: 2, weight: 25 },
  { product_id: 2, size_code: 'L', pieces_per_ply: 3, weight: 75 },
], 10, { allocation_basis: 'manual' });
eq('manual A%', manual[0].weight, 25, 0.01);
eq('manual B%', manual[1].weight, 75, 0.01);

const hybrid = normalizeOutputs([
  { product_id: 1, size_code: 'M', pieces_per_ply: 2, fabric_std_m: 1 },
  { product_id: 2, size_code: 'L', pieces_per_ply: 2, fabric_std_m: 3 },
], 10, { allocation_basis: 'hybrid' });
eq('hybrid sum', hybrid[0].weight + hybrid[1].weight, 100, 0.05);
ok('hybrid tilts to fabric-heavy B', hybrid[1].weight > hybrid[0].weight);

const schema = fs.readFileSync(path.join(__dirname, '../lib/production/schema.js'), 'utf8');
ok(schema.includes("allocation_basis"), 'schema ensure allocation_basis');
ok(schema.includes('fabric_std_m'), 'schema ensure fabric_std_m');

try {
  new Function(appSrc);
  ok('app.js parse', true);
} catch (e) {
  ok('app.js parse', false, e.message);
}

summary();
