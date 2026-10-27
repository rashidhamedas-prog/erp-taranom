#!/usr/bin/env node
'use strict';
/**
 * Read-only report: color/variant mismatches (no UPDATE/migration).
 * Usage: node scripts/report-color-variant-mismatch.js [path/to.db]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2]
  || process.env.DB_PATH
  || path.join(__dirname, '../data/erp.db');

if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

function rowsToCsv(rows) {
  if (!rows.length) return '(none)';
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(',')];
  for (const r of rows) {
    lines.push(keys.map((k) => {
      const v = r[k] == null ? '' : String(r[k]);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','));
  }
  return lines.join('\n');
}

section('A) Active variants missing product_style_colors');
const missingStyle = db.prepare(`
  SELECT pv.product_id, p.name AS product_name, pv.id AS variant_id, pv.sku,
         pv.color_id, pc.name AS color_name
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  LEFT JOIN product_colors pc ON pc.id = pv.color_id
  LEFT JOIN product_style_colors psc
    ON psc.product_id = pv.product_id AND psc.color_id = pv.color_id
  WHERE IFNULL(pv.active,1)=1 AND IFNULL(pv.is_default,0)=0
    AND pv.color_id IS NOT NULL
    AND psc.color_id IS NULL
  ORDER BY pv.product_id, pv.color_id
`).all();
console.log(rowsToCsv(missingStyle));
console.log('count=', missingStyle.length);

section('B) SKU that does not contain current color name');
const skuMismatch = db.prepare(`
  SELECT pv.product_id, p.name AS product_name, pv.id AS variant_id, pv.sku,
         pv.color_id, pc.name AS color_name
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  JOIN product_colors pc ON pc.id = pv.color_id
  WHERE IFNULL(pv.active,1)=1 AND IFNULL(pv.is_default,0)=0
    AND pv.sku IS NOT NULL AND TRIM(pv.sku) != ''
    AND INSTR(REPLACE(LOWER(pv.sku),'ي','ی'), REPLACE(LOWER(pc.name),'ي','ی')) = 0
  ORDER BY pv.product_id, pv.color_id
`).all();
console.log(rowsToCsv(skuMismatch));
console.log('count=', skuMismatch.length);

section('C) Style colors with zero stock in all warehouses');
const zeroEverywhere = db.prepare(`
  SELECT psc.product_id, p.name AS product_name, psc.color_id, pc.name AS color_name,
         IFNULL(SUM(IFNULL(vws.qty, pv.stock)), 0) AS total_qty
  FROM product_style_colors psc
  JOIN products p ON p.id = psc.product_id
  LEFT JOIN product_colors pc ON pc.id = psc.color_id
  LEFT JOIN product_variants pv
    ON pv.product_id = psc.product_id AND pv.color_id = psc.color_id
   AND IFNULL(pv.active,1)=1 AND IFNULL(pv.is_default,0)=0
  LEFT JOIN variant_warehouse_stock vws ON vws.variant_id = pv.id
  GROUP BY psc.product_id, psc.color_id
  HAVING ABS(IFNULL(SUM(IFNULL(vws.qty, pv.stock)), 0)) < 1e-9
  ORDER BY psc.product_id, psc.color_id
`).all();
console.log(rowsToCsv(zeroEverywhere));
console.log('count=', zeroEverywhere.length);

section('D) products.stock vs sum of variant warehouse stock');
const stockDelta = db.prepare(`
  SELECT p.id AS product_id, p.name AS product_name, p.stock AS products_stock,
         IFNULL(v.variant_sum, 0) AS variant_sum,
         ROUND(IFNULL(p.stock,0) - IFNULL(v.variant_sum,0), 3) AS delta
  FROM products p
  LEFT JOIN (
    SELECT pv.product_id,
           SUM(IFNULL(vws.qty, IFNULL(pv.stock,0))) AS variant_sum
    FROM product_variants pv
    LEFT JOIN variant_warehouse_stock vws ON vws.variant_id = pv.id
    WHERE IFNULL(pv.active,1)=1 AND IFNULL(pv.is_default,0)=0
    GROUP BY pv.product_id
  ) v ON v.product_id = p.id
  WHERE EXISTS (
    SELECT 1 FROM product_variants x
    WHERE x.product_id = p.id AND IFNULL(x.is_default,0)=0 AND IFNULL(x.active,1)=1
  )
  AND ABS(IFNULL(p.stock,0) - IFNULL(v.variant_sum,0)) > 0.001
  ORDER BY ABS(IFNULL(p.stock,0) - IFNULL(v.variant_sum,0)) DESC
`).all();
console.log(rowsToCsv(stockDelta));
console.log('count=', stockDelta.length);

console.log('\nDone. DB=', dbPath);
db.close();
