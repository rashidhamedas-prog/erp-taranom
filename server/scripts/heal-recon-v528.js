'use strict';
/**
 * v528 — ترمیم مغایرت‌های تأییدشدهٔ مالک (پاسخ Q1–Q10 + دو اصلاح کم‌ریسک).
 *
 * پیش‌فرض: dry-run (گزارش). اجرا: --apply
 * گزینه‌ها:
 *   --skip-opening / --skip-align / --skip-mat-reclass / --skip-cogs
 *   --skip-labor / --skip-phantom / --skip-loan / --skip-fa / --skip-dup-pay
 *   --skip-q3   (مواد ~۵۷ میلیون تومان — فقط گزارش؛ بدون سند تا تأیید جدا)
 *
 * تاریخ اسناد موجودی: ۱۴۰۵/۰۶/۳۱ — یک سند به ازای هر کالا.
 */
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const skip = (k) => args.includes(`--skip-${k}`);

process.chdir(path.join(__dirname, '..'));
const { getDB } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { retirePersonLedgerByRef, retireSupplierLedgerByRef } = require('../lib/party-ledger-retire');

const DATE_OPEN = '1405/06/31';
const LIVE_JE = `COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')`;
const LIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;
const D = 'COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)';
const C = 'COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)';

const db = getDB();
const report = { dryRun: !APPLY, steps: [], errors: [] };

function acct(code) {
  const r = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(code);
  if (!r) throw new Error(`حساب ${code} یافت نشد`);
  return r;
}

function already(refType, refId) {
  return db.prepare(`
    SELECT id FROM journal_entries WHERE ref_type=? AND ref_id=? AND ${LIVE_JE} LIMIT 1
  `).get(refType, refId);
}

function pname(id) {
  return db.prepare('SELECT id,code,name FROM products WHERE id=?').get(id);
}

function postPair({ sourceType, sourceId, date, description, debitCode, creditCode, amountRial, skipCcPolicy }) {
  const amt = Math.round(Number(amountRial) || 0);
  if (amt <= 0) return null;
  const deb = acct(debitCode);
  const cre = acct(creditCode);
  if (!APPLY) {
    return { dry: true, sourceType, sourceId, date, description, amountRial: amt, debit: deb.code, credit: cre.code };
  }
  const id = postToLedger(db, {
    sourceType, sourceId, date, description, createdBy: 1,
    skipCcPolicy: !!skipCcPolicy,
    lines: [
      { code: deb.code, name: deb.name, debit: rialToLedger(amt), credit: 0 },
      { code: cre.code, name: cre.name, debit: 0, credit: rialToLedger(amt) },
    ],
  });
  return { jeId: id, sourceType, sourceId, amountRial: amt };
}

// ── 1+2 Opening FG + Align → 3102 ──────────────────────────────────────────
function stepOpeningAndAlign() {
  if (skip('opening') && skip('align')) return;

  // Value-only opening JEs already on 1104 (exclude material openings 220/221/223/385 — those reclass to 1110).
  // Strategy: post full per-product kardex openings, then one offset Dr 3102/Cr 1104 for FG value-JE total
  // so net = A − A′ without fragile name matching.
  const MAT_JE_IDS = new Set([220, 221, 223, 385]);
  const valueJes = db.prepare(`
    SELECT je.id, je.description, ${D} AS dr
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    WHERE ${LIVE} AND je.ref_type='opening_inventory' AND jl.account_code LIKE '1104%'
  `).all().filter((j) => !MAT_JE_IDS.has(j.id));
  const valueJeFgTotal = valueJes.reduce((s, j) => s + Math.round(Number(j.dr) || 0), 0);

  const openings = db.prepare(`
    SELECT product_id, warehouse_id,
      ROUND(SUM(amount_rial)) AS amt, ROUND(SUM(qty_in-qty_out),4) AS qty,
      GROUP_CONCAT(id) AS ids
    FROM inventory_ledger
    WHERE warehouse_id IN (34,35) AND status='posted' AND reversed_of IS NULL
      AND source_type='opening_inventory' AND je_id IS NULL
    GROUP BY product_id, warehouse_id
    ORDER BY product_id, warehouse_id
  `).all();

  // Aggregate by product for "جدا برای هر کالا"
  const byProduct = new Map();
  for (const r of openings) {
    const cur = byProduct.get(r.product_id) || { product_id: r.product_id, amt: 0, qty: 0, rows: [] };
    cur.amt += Number(r.amt) || 0;
    cur.qty += Number(r.qty) || 0;
    cur.rows.push(r);
    byProduct.set(r.product_id, cur);
  }

  const openPosted = [];
  let openTotal = 0;
  if (!skip('opening')) {
    for (const [pid, row] of byProduct) {
      const p = pname(pid);
      const net = Math.round(row.amt);
      if (net <= 0) {
        openPosted.push({ product_id: pid, code: p && p.code, name: p && p.name, skipped: 'zero', gross: row.amt });
        continue;
      }
      if (already('opening_inventory_recon_v528', pid)) {
        openPosted.push({ product_id: pid, skipped: 'idempotent' });
        continue;
      }
      const desc = `افتتاحیه کالای ساخته‌شده (v528) — ${p ? p.code : pid} ${p ? p.name : ''}`.trim();
      const out = postPair({
        sourceType: 'opening_inventory_recon_v528', sourceId: pid, date: DATE_OPEN,
        description: desc, debitCode: '1104', creditCode: '3102', amountRial: net,
      });
      if (APPLY && out && out.jeId) {
        for (const r of row.rows) {
          for (const id of String(r.ids || '').split(',').filter(Boolean)) {
            db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id=? AND je_id IS NULL').run(out.jeId, Number(id));
          }
        }
      }
      openTotal += net;
      openPosted.push({ product_id: pid, code: p && p.code, name: p && p.name, gross: row.amt, net, ...out });
    }

    // Offset prior value-only opening JEs so we do not double-count A′
    let offsetOut = null;
    if (valueJeFgTotal > 0) {
      if (already('opening_inventory_value_offset_v528', 1)) {
        offsetOut = { skipped: 'idempotent', amountRial: valueJeFgTotal };
      } else {
        offsetOut = postPair({
          sourceType: 'opening_inventory_value_offset_v528', sourceId: 1, date: DATE_OPEN,
          description: `تهاتر بهای اولیه موجودی قبلی (v528) — جلوگیری از دوباره‌شماری ${valueJes.length} سند`,
          debitCode: '3102', creditCode: '1104', amountRial: valueJeFgTotal,
        });
      }
    }
    report._openOffset = { valueJeFgTotal, valueJeCount: valueJes.length, offsetOut, netOpenAfterOffset: openTotal - valueJeFgTotal };
  }

  const aligns = db.prepare(`
    SELECT product_id,
      ROUND(SUM(CASE WHEN qty_in>0 THEN amount_rial WHEN qty_out>0 THEN -amount_rial ELSE amount_rial END)) AS amt,
      GROUP_CONCAT(id) AS ids
    FROM inventory_ledger
    WHERE warehouse_id IN (34,35) AND status='posted' AND reversed_of IS NULL
      AND (source_type='stock_reconcile' OR IFNULL(note,'') LIKE '%هم‌ترازی%')
    GROUP BY product_id
    ORDER BY product_id
  `).all();

  const alignPosted = [];
  let alignTotal = 0;
  if (!skip('align')) {
    for (const r of aligns) {
      const amt = Math.round(Number(r.amt) || 0);
      // Align reductions are negative on inventory → Dr 3102 / Cr 1104 for |amt|
      if (amt >= 0) {
        alignPosted.push({ product_id: r.product_id, skipped: 'non_negative_align', amt });
        continue;
      }
      const abs = -amt;
      const p = pname(r.product_id);
      if (already('stock_align_recon_v528', r.product_id)) {
        alignPosted.push({ product_id: r.product_id, skipped: 'idempotent' });
        continue;
      }
      const desc = `هم‌ترازی افتتاحیه کالا (v528) — ${p ? p.code : r.product_id} ${p ? p.name : ''}`.trim();
      const out = postPair({
        sourceType: 'stock_align_recon_v528', sourceId: r.product_id, date: DATE_OPEN,
        description: desc, debitCode: '3102', creditCode: '1104', amountRial: abs,
      });
      if (APPLY && out && out.jeId) {
        for (const id of String(r.ids || '').split(',').filter(Boolean)) {
          db.prepare('UPDATE inventory_ledger SET je_id=COALESCE(je_id,?) WHERE id=?').run(out.jeId, Number(id));
        }
      }
      alignTotal += abs;
      alignPosted.push({ product_id: r.product_id, code: p && p.code, name: p && p.name, amt, abs, ...out });
    }
  }

  report.steps.push({
    step: 'opening_align',
    openProducts: openPosted.length, openTotalRial: openTotal,
    valueOffset: report._openOffset || null,
    netOpenAfterOffset: openTotal - ((report._openOffset && report._openOffset.valueJeFgTotal) || 0),
    alignProducts: alignPosted.length, alignTotalRial: alignTotal,
    sampleOpen: openPosted.filter((x) => x.net).slice(0, 5),
    sampleAlign: alignPosted.filter((x) => x.abs).slice(0, 5),
  });
  delete report._openOffset;
}

// ── Low-risk الف: material opening 1104 → 1110 ─────────────────────────────
function stepMatReclass() {
  if (skip('mat-reclass')) return;
  const ids = [220, 221, 223, 385];
  const a1110 = acct('1110');
  const done = [];
  for (const id of ids) {
    const je = db.prepare(`SELECT id, description, status, deleted_at FROM journal_entries WHERE id=?`).get(id);
    if (!je || Number(je.deleted_at) > 0 || ['reversed', 'void'].includes(je.status)) {
      done.push({ id, skipped: 'dead' });
      continue;
    }
    const lines = db.prepare(`
      SELECT id, account_code FROM journal_lines WHERE entry_id=? ORDER BY line_no, id
    `).all(id);
    const has1104 = lines.some((l) => String(l.account_code).startsWith('1104'));
    const already1110 = lines.some((l) => String(l.account_code).startsWith('1110'));
    if (already1110 && !has1104) {
      done.push({ id, skipped: 'already_1110' });
      continue;
    }
    if (!has1104) {
      done.push({ id, skipped: 'no_1104' });
      continue;
    }
    if (APPLY) {
      db.prepare(`
        UPDATE journal_lines SET account_code=?, account_name=?
        WHERE entry_id=? AND account_code LIKE '1104%'
      `).run(a1110.code, a1110.name, id);
    }
    done.push({ id, action: 'rewrite_1104_to_1110', lines: lines.filter((l) => String(l.account_code).startsWith('1104')).length });
  }
  report.steps.push({ step: 'mat_reclass', jes: done });
}

// ── Low-risk ب: COGS T-0001..3 ─────────────────────────────────────────────
function stepCogs() {
  if (skip('cogs')) return;
  const invs = db.prepare(`SELECT id, num, date FROM invoices WHERE num IN ('T-0001','T-0002','T-0003')`).all();
  const out = [];
  for (const inv of invs) {
    if (already('invoice_cogs_fix', inv.id) || already('invoice_cogs', inv.id)) {
      out.push({ num: inv.num, skipped: 'idempotent' });
      continue;
    }
    const cogs = Number(db.prepare(`
      SELECT ROUND(SUM(amount_rial)) v FROM inventory_ledger
      WHERE source_type='invoice' AND source_id=? AND status='posted' AND reversed_of IS NULL
        AND (event_type='sale' OR qty_out>0)
    `).get(inv.id).v) || 0;
    if (cogs <= 0) {
      out.push({ num: inv.num, skipped: 'no_kardex_cogs' });
      continue;
    }
    const posted = postPair({
      sourceType: 'invoice_cogs_fix', sourceId: inv.id, date: inv.date || DATE_OPEN,
      description: `بهای تمام‌شده فاکتور ${inv.num} (v528)`,
      debitCode: '5101', creditCode: '1104', amountRial: cogs,
    });
    out.push({ num: inv.num, cogs, ...posted });
  }
  report.steps.push({ step: 'cogs', items: out });
}

// ── 7 Labor: Dr 5201 / Cr 6104 ─────────────────────────────────────────────
function stepLabor() {
  if (skip('labor')) return;
  if (already('cutter_labor_reclass_v528', 1)) {
    report.steps.push({ step: 'labor', skipped: 'idempotent' });
    return;
  }
  const amt = 28444416 + 10074064;
  const out = postPair({
    sourceType: 'cutter_labor_reclass_v528', sourceId: 1, date: '1405/07/30',
    description: 'جذب دستمزد برش تولید از هزینه حقوق (v528) — PO-0014/0015',
    debitCode: '5201', creditCode: '6104', amountRial: amt, skipCcPolicy: true,
  });
  report.steps.push({ step: 'labor', amountRial: amt, ...out });
}

// ── Phantom PO-0006 returns 442–445 (no JE) ────────────────────────────────
function stepPhantom() {
  if (skip('phantom')) return;
  const rows = db.prepare(`
    SELECT id, product_id, amount_rial, status FROM inventory_ledger WHERE id BETWEEN 442 AND 445
  `).all();
  const out = [];
  for (const r of rows) {
    if (r.status !== 'posted') {
      out.push({ id: r.id, skipped: r.status });
      continue;
    }
    if (APPLY) {
      db.prepare(`
        UPDATE inventory_ledger SET status='reversed',
          note=TRIM(COALESCE(note,'') || ' [v528 ابطال برگشت فانتوم PO-0006]')
        WHERE id=? AND status='posted'
      `).run(r.id);
    }
    out.push({ id: r.id, product_id: r.product_id, amount_rial: r.amount_rial, action: 'reverse_kardex' });
  }
  report.steps.push({ step: 'phantom_po0006', items: out });
}

// ── 5 Loan: retire person_ledger payroll_loan (keep GL 1119) ───────────────
function stepLoan() {
  if (skip('loan')) return;
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='payroll_loans'`).get();
  if (!has) {
    report.steps.push({ step: 'loan', skipped: 'no_table' });
    return;
  }
  const loan = db.prepare(`SELECT * FROM payroll_loans WHERE id=1`).get();
  if (!loan) {
    report.steps.push({ step: 'loan', skipped: 'no_loan' });
    return;
  }
  const live = db.prepare(`
    SELECT id FROM person_ledger
    WHERE person_id=? AND ref_type='payroll_loan' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).all(loan.person_id, loan.id);
  if (!live.length) {
    report.steps.push({ step: 'loan', skipped: 'already_retired', person_id: loan.person_id });
    return;
  }
  if (APPLY) {
    retirePersonLedgerByRef(db, {
      refTypes: ['payroll_loan'],
      refId: loan.id,
      personId: loan.person_id,
    });
  }
  report.steps.push({
    step: 'loan',
    action: 'retire_person_ledger_payroll_loan',
    person_id: loan.person_id,
    principal_rial: loan.principal_rial,
    rows: live.map((r) => r.id),
  });
}

// ── 8 FA warehouse 36 → fixed_assets (cost 0) ──────────────────────────────
function stepFa() {
  if (skip('fa')) return;
  const hasFa = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fixed_assets'`).get();
  if (!hasFa) {
    report.steps.push({ step: 'fa', skipped: 'no_table' });
    return;
  }
  const wh = db.prepare(`SELECT id,name FROM warehouses WHERE id=36`).get();
  if (!wh) {
    report.steps.push({ step: 'fa', skipped: 'no_wh36' });
    return;
  }
  const items = db.prepare(`
    SELECT p.id, p.code, p.name, ws.qty
    FROM warehouse_stock ws JOIN products p ON p.id=ws.product_id
    WHERE ws.warehouse_id=? AND ABS(ws.qty)>1e-9
    ORDER BY p.name
  `).all(wh.id);
  let created = 0;
  let cleared = 0;
  const sample = [];
  for (const it of items) {
    const exists = db.prepare(`
      SELECT id FROM fixed_assets WHERE notes LIKE ? OR code=? LIMIT 1
    `).get(`%product_id=${it.id}%`, `FA-P${it.id}`);
    if (!exists && APPLY) {
      const code = `FA-P${it.id}`;
      const faCols = new Set(db.prepare('PRAGMA table_info(fixed_assets)').all().map((c) => c.name));
      const notes = `انتقال از انبار دارایی ثابت (v528) product_id=${it.id} qty=${it.qty}`;
      if (faCols.has('acq_funding')) {
        db.prepare(`
          INSERT INTO fixed_assets (code,name,category,purchase_date,cost_rial,salvage_rial,useful_life_months,location,notes,coa_asset_code,status,acq_funding)
          VALUES (?,?,?,?,0,0,60,?,?,?,'active','none')
        `).run(code, it.name, 'اثاثه/تجهیزات', DATE_OPEN, wh.name, notes, '1201');
      } else {
        db.prepare(`
          INSERT INTO fixed_assets (code,name,category,purchase_date,cost_rial,salvage_rial,useful_life_months,location,notes,coa_asset_code,status)
          VALUES (?,?,?,?,0,0,60,?,?,?,'active')
        `).run(code, it.name, 'اثاثه/تجهیزات', DATE_OPEN, wh.name, notes, '1201');
      }
      created++;
    } else if (!exists) {
      created++;
    }
    if (APPLY) {
      db.prepare(`UPDATE warehouse_stock SET qty=0 WHERE warehouse_id=? AND product_id=?`).run(wh.id, it.id);
      // Reverse any posted kardex still showing qty in WH36 (value expected 0)
      const ledgers = db.prepare(`
        SELECT id FROM inventory_ledger
        WHERE warehouse_id=? AND product_id=? AND status='posted' AND reversed_of IS NULL
      `).all(wh.id, it.id);
      for (const l of ledgers) {
        db.prepare(`
          UPDATE inventory_ledger SET status='reversed',
            note=TRIM(COALESCE(note,'') || ' [v528 انتقال به دفتر دارایی ثابت]')
          WHERE id=?
        `).run(l.id);
      }
      cleared++;
    } else {
      cleared++;
    }
    if (sample.length < 8) sample.push({ code: it.code, name: it.name, qty: it.qty });
  }
  report.steps.push({
    step: 'fa',
    items: items.length, wouldCreateOrCreated: created, clearedStock: cleared, sample,
    note: 'بهای صفر — فقط کارت دارایی؛ بدون سند تحصیل',
  });
}

// ── 9 Void duplicate supplier payment #5 ───────────────────────────────────
function stepDupPay() {
  if (skip('dup-pay')) return;
  const row = db.prepare(`SELECT * FROM supplier_payments WHERE id=5`).get();
  if (!row) {
    report.steps.push({ step: 'dup_pay', skipped: 'missing' });
    return;
  }
  if (row.status === 'reversed') {
    report.steps.push({ step: 'dup_pay', skipped: 'already_reversed', id: 5 });
    return;
  }
  // Prefer voiding #5 (no invoice link); keep #9 linked to PO-0003
  if (APPLY) {
    retireSupplierLedgerByRef(db, {
      refTypes: ['supplier_payment'],
      refId: row.id,
      supplierId: row.supplier_id,
    });
    // soft-void original JE (no paired reverse voucher)
    postToLedger(db, {
      sourceType: 'supplier_payment_reversal', sourceId: row.id,
      date: row.date || DATE_OPEN,
      description: `ابطال پرداخت تکراری تأمین‌کننده #${row.id} (v528)`,
      createdBy: 1,
      lines: [],
    });
    db.prepare(`
      UPDATE supplier_payments SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=1
      WHERE id=?
    `).run(row.id);
  }
  report.steps.push({
    step: 'dup_pay',
    action: 'void_payment_5',
    amount: row.amount,
    supplier_id: row.supplier_id,
    keep_payment_9: true,
  });
}

// ── Q3 report only ─────────────────────────────────────────────────────────
function stepQ3Report() {
  if (skip('q3')) return;
  const matOpen = 829419000;
  const phantom = Number(db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) v FROM inventory_ledger
    WHERE id BETWEEN 442 AND 445 AND status='posted'
  `).get().v) || 0;
  const gl1110 = Number(db.prepare(`
    SELECT COALESCE(SUM(${D}),0)-COALESCE(SUM(${C}),0) v
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE ${LIVE} AND jl.account_code LIKE '1110%'
  `).get().v) || 0;
  const kardex = Number(db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN qty_in>0 THEN amount_rial WHEN qty_out>0 THEN -amount_rial ELSE amount_rial END),0) v
    FROM inventory_ledger WHERE warehouse_id=33 AND status='posted' AND reversed_of IS NULL
  `).get().v) || 0;
  const projectedGl = gl1110 + matOpen;
  const projectedKardex = kardex - phantom;
  const gap = projectedGl - projectedKardex;
  const aligns = db.prepare(`
    SELECT p.code, p.name, product_id,
      ROUND(SUM(CASE WHEN qty_in>0 THEN amount_rial WHEN qty_out>0 THEN -amount_rial ELSE amount_rial END)) a
    FROM inventory_ledger l JOIN products p ON p.id=l.product_id
    WHERE l.warehouse_id=33 AND l.status='posted' AND l.reversed_of IS NULL
      AND (l.source_type='stock_reconcile' OR IFNULL(l.note,'') LIKE '%هم‌ترازی%')
    GROUP BY l.product_id ORDER BY ABS(SUM(CASE WHEN l.qty_in>0 THEN l.amount_rial WHEN l.qty_out>0 THEN -l.amount_rial ELSE l.amount_rial END)) DESC
  `).all();
  report.steps.push({
    step: 'q3_materials_list_only',
    projected_gap_rial: gap,
    projected_gap_toman: Math.round(gap / 10),
    note: 'پس از جابه‌جایی افتتاحیه مواد به ۱۱۱۰ و ابطال فانتوم PO-0006 — بدون سند تعدیل تا تأیید شما',
    align_drivers: aligns,
    phantom_rows: [442, 443, 444, 445],
  });
}

function main() {
  const run = () => {
    stepQ3Report();
    stepOpeningAndAlign();
    stepMatReclass();
    stepCogs();
    stepLabor();
    stepPhantom();
    stepLoan();
    stepFa();
    stepDupPay();
  };
  if (APPLY) {
    db.transaction(run)();
  } else {
    run();
  }
  const outPath = path.join(__dirname, '..', '..', '_heal-recon-v528-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, apply: APPLY, outPath, steps: report.steps.map((s) => s.step) }, null, 2));
  console.log('---REPORT---');
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (e) {
  console.error('FATAL', e);
  process.exit(1);
}
