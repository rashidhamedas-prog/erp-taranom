#!/usr/bin/env node
'use strict';
/**
 * P8b-1 — دستمزد قطعه‌ای پیمانکار که بستانکار حساب دارایی شخص (1103/1106) شده
 * → انتقال به حساب پرداختنی همان شخص (resolver فاز P5).
 *
 *   گزینهٔ A: فقط دستمزدها   Dr <دارایی شخص> / Cr <پرداختنی شخص>
 *   گزینهٔ B: A + پرداخت‌های «پرداخت به شخص» (doc_type=person_payment) که بدهکار دارایی شده‌اند
 *             Dr <پرداختنی> / Cr <دارایی>
 *
 * سند اصلی دست نمی‌خورد؛ یک سند اصلاحی با postToLedger (شمارهٔ JV از allocateNumber).
 * person_ledger دست نمی‌خورد (کنترل می‌شود). ابطال (R13) = soft-void همان سند اصلاحی.
 *
 * Usage:
 *   node server/scripts/p8b-labor-payable-reclass.js --db=<crm.db> [--person=132] [--out=dir]
 *   … --apply  --option=A|B --i-have-approval --reason="…" [--date=1405/08/11] [--user=1]
 *   … --reverse --i-have-approval --reason="…" [--user=1]
 */
const path = require('path');
const C = require('./lib/p8b-common');

const ITEM = 'P8b-1';
const REF_TYPE = 'p8b_labor_payable_reclass';
const CSV_NAME = 'p8b-1-labor-reclass.csv';

function loadPerson(db, personId) {
  const p = db.prepare('SELECT * FROM persons WHERE id=?').get(Number(personId));
  if (!p) throw C.stop(`شخص ${personId} یافت نشد`);
  return p;
}

function categoryOf(row) {
  const rt = String(row.ref_type || '');
  if (rt === 'opening_balance' || rt === 'opening') return 'opening';
  if (rt === 'production_labor') return 'production_labor';
  if (rt === 'invoice') return 'invoice';
  if (String(row.doc_type || '') === 'person_payment') return 'person_payment';
  if (rt === REF_TYPE) return 'p8b_reclass';
  return 'other';
}

function accountMovement(db, code) {
  const rows = db.prepare(`
    SELECT je.id je_id, je.entry_date, je.ref_type, je.ref_id, je.doc_type, je.description,
           jl.id line_id, jl.debit_rial, jl.credit_rial, jl.cost_center_id, jl.detail_account_id
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND ${C.JE_ALIVE}
    ORDER BY je.id, jl.id
  `).all(String(code));
  const byCat = {};
  for (const r of rows) {
    const k = categoryOf(r);
    byCat[k] = byCat[k] || { debit_rial: 0, credit_rial: 0, je_ids: [] };
    byCat[k].debit_rial += Math.round(Number(r.debit_rial) || 0);
    byCat[k].credit_rial += Math.round(Number(r.credit_rial) || 0);
    if (!byCat[k].je_ids.includes(r.je_id)) byCat[k].je_ids.push(r.je_id);
  }
  return { rows, byCat, balance: C.glBalance(db, code) };
}

function personLedgerNet(db, personId) {
  const cols = db.prepare('PRAGMA table_info(person_ledger)').all().map((c) => c.name);
  const alive = cols.includes('deleted_at') ? 'COALESCE(deleted_at,0)=0' : '1=1';
  const r = db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c
    FROM person_ledger WHERE person_id=? AND ${alive}
  `).get(Number(personId));
  return { rows: r.n, debit_rial: Math.round(r.d), credit_rial: Math.round(r.c), net_rial: Math.round(r.d - r.c) };
}

function bookCounts(db) {
  const n = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (_) { return -1; } };
  return { person_ledger: n('person_ledger'), supplier_ledger: n('supplier_ledger'), customer_ledger: n('customer_ledger') };
}

function planLaborReclass(db, { personId = 132, payableCode = null } = {}) {
  const PA = C.srv('lib/payroll/person-account');
  const person = loadPerson(db, personId);
  const asset = PA.loadCoa(db, person.coa_code);
  if (!asset || PA.wageAccountClass(asset) !== 'asset') {
    throw C.stop(`حساب شخص ${person.coa_code || '-'} دارایی نیست — اصلاحی لازم نیست`);
  }
  const role = PA.classifyLaborPersonRole(db, person);
  let resolved = null;
  try { resolved = PA.resolveLaborPayableForPerson(db, person, { allocate: false }); }
  catch (e) { resolved = { error: e.code || e.message }; }
  const payCode = payableCode || (resolved && resolved.account_code);
  const payable = PA.loadCoa(db, payCode);
  if (!payable || PA.wageAccountClass(payable) !== 'payable') {
    throw C.stop(`حساب پرداختنی معتبر نیست: ${payCode || '-'} (${JSON.stringify(resolved)})`);
  }

  const labor = db.prepare(`
    SELECT ple.id labor_id, ple.doc_no, ple.order_id, ple.stage_id, ple.amount_rial,
           je.id je_id, je.entry_date, je.voucher_number,
           jl.id line_id, jl.credit_rial, jl.cost_center_id, jl.detail_account_id
    FROM production_labor_entries ple
    JOIN journal_entries je ON je.id=ple.je_id
    JOIN journal_lines jl ON jl.entry_id=je.id
    WHERE ple.person_id=? AND ple.status='posted' AND ${C.JE_ALIVE}
      AND jl.account_code=? AND COALESCE(jl.credit_rial,0)>0
    ORDER BY je.id, jl.id
  `).all(person.id, asset.code);

  const payments = db.prepare(`
    SELECT je.id je_id, je.entry_date, je.voucher_number, je.description,
           jl.id line_id, jl.debit_rial, jl.cost_center_id, jl.detail_account_id
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    WHERE jl.account_code=? AND COALESCE(jl.debit_rial,0)>0 AND ${C.JE_ALIVE}
      AND je.doc_type='person_payment'
    ORDER BY je.id, jl.id
  `).all(asset.code);

  const laborTotal = labor.reduce((s, r) => s + Math.round(r.credit_rial), 0);
  const payTotal = payments.reduce((s, r) => s + Math.round(r.debit_rial), 0);
  const assetMove = accountMovement(db, asset.code);
  const payMove = accountMovement(db, payable.code);
  const project = (opt) => {
    const moveA = laborTotal;
    const moveB = opt === 'B' ? payTotal : 0;
    return {
      asset_net_rial: assetMove.balance.net_rial + moveA - moveB,
      payable_net_rial: payMove.balance.net_rial - moveA + moveB,
    };
  };
  return {
    person: { id: person.id, name: person.name, coa_code: person.coa_code, party_id: person.party_id },
    role,
    resolver: resolved,
    asset: { code: asset.code, name: asset.name },
    payable: { code: payable.code, name: payable.name },
    labor,
    payments,
    labor_total_rial: laborTotal,
    payments_total_rial: payTotal,
    asset_movement: { byCat: assetMove.byCat, balance: assetMove.balance },
    payable_movement: { byCat: payMove.byCat, balance: payMove.balance },
    after: { A: project('A'), B: project('B') },
    person_ledger: personLedgerNet(db, person.id),
  };
}

function buildLines(plan, option) {
  const lines = [];
  const dsc = (r, what) => `اصلاح P8b — ${what} JE#${r.je_id}${r.voucher_number ? ' (' + r.voucher_number + ')' : ''}`;
  for (const r of plan.labor) {
    const amt = Math.round(r.credit_rial);
    lines.push({ code: plan.asset.code, name: plan.asset.name, debit: amt / 10, credit: 0,
      cost_center_id: r.cost_center_id || null, detail_account_id: r.detail_account_id || null,
      description: dsc(r, `دستمزد ${r.doc_no || ''}`.trim()) });
    lines.push({ code: plan.payable.code, name: plan.payable.name, debit: 0, credit: amt / 10,
      cost_center_id: r.cost_center_id || null, detail_account_id: r.detail_account_id || null,
      description: dsc(r, `دستمزد ${r.doc_no || ''}`.trim()) });
  }
  if (option === 'B') {
    for (const r of plan.payments) {
      const amt = Math.round(r.debit_rial);
      lines.push({ code: plan.payable.code, name: plan.payable.name, debit: amt / 10, credit: 0,
        cost_center_id: r.cost_center_id || null, detail_account_id: r.detail_account_id || null,
        description: dsc(r, 'پرداخت به شخص') });
      lines.push({ code: plan.asset.code, name: plan.asset.name, debit: 0, credit: amt / 10,
        cost_center_id: r.cost_center_id || null, detail_account_id: r.detail_account_id || null,
        description: dsc(r, 'پرداخت به شخص') });
    }
  }
  return lines;
}

function liveCorrection(db, personId) {
  return db.prepare(`
    SELECT je.* FROM journal_entries je
    WHERE je.ref_type=? AND je.ref_id=? AND ${C.JE_ALIVE}
    ORDER BY je.id DESC LIMIT 1
  `).get(REF_TYPE, Number(personId)) || null;
}

function applyLaborReclass(db, { personId = 132, option, date, reason, userId = null, payableCode = null } = {}) {
  const opt = String(option || '').toUpperCase();
  if (!['A', 'B'].includes(opt)) throw C.stop('--option=A یا B لازم است (تصمیم مالک)');
  if (liveCorrection(db, personId)) throw C.stop(`سند اصلاحی ${REF_TYPE} برای شخص ${personId} قبلاً ثبت شده`);
  const plan = planLaborReclass(db, { personId, payableCode });
  if (!plan.labor.length) throw C.stop('دستمزد زنده‌ای روی حساب دارایی شخص نیست');
  const books0 = bookCounts(db);
  const pl0 = personLedgerNet(db, personId);
  const { postToLedger } = C.srv('lib/ledger');
  const jeId = postToLedger(db, {
    sourceType: REF_TYPE,
    sourceId: Number(personId),
    date: date || C.todayJalali(),
    description: `اصلاح P8b-1 (گزینه ${opt}) — انتقال دستمزد قطعه‌ای ${plan.person.name} از ${plan.asset.code} به پرداختنی ${plan.payable.code}`,
    createdBy: userId,
    lines: buildLines(plan, opt),
    voucherType: 'auto',
    status: 'approved',
    skipCcPolicy: true,
  });
  const exp = plan.after[opt];
  const a1 = C.glBalance(db, plan.asset.code).net_rial;
  const p1 = C.glBalance(db, plan.payable.code).net_rial;
  if (a1 !== exp.asset_net_rial || p1 !== exp.payable_net_rial) {
    throw C.stop(`STOP: ماندهٔ پس از اصلاح با پیش‌بینی نمی‌خواند (${a1}/${exp.asset_net_rial}, ${p1}/${exp.payable_net_rial})`);
  }
  const books1 = bookCounts(db);
  const pl1 = personLedgerNet(db, personId);
  if (JSON.stringify(books0) !== JSON.stringify(books1) || JSON.stringify(pl0) !== JSON.stringify(pl1)) {
    throw C.stop(`STOP: دفاتر معین تغییر کرد (${JSON.stringify(books0)} → ${JSON.stringify(books1)})`);
  }
  insertAuditApply(db, { userId, jeId, opt, reason, plan });
  return { je_id: jeId, option: opt, plan, lines: C.jeLines(db, jeId), head: db.prepare('SELECT * FROM journal_entries WHERE id=?').get(jeId) };
}

function insertAuditApply(db, { userId, jeId, opt, reason, plan }) {
  C.insertAudit(db, {
    userId, action: 'p8b_apply', entity: REF_TYPE, entityId: jeId,
    detail: {
      reason, option: opt, person_id: plan.person.id, asset: plan.asset.code, payable: plan.payable.code,
      labor_je_ids: plan.labor.map((r) => r.je_id), payment_je_ids: opt === 'B' ? plan.payments.map((r) => r.je_id) : [],
      labor_total_rial: plan.labor_total_rial, payments_total_rial: opt === 'B' ? plan.payments_total_rial : 0,
    },
  });
}

function reverseLaborReclass(db, { personId = 132, reason, userId = null } = {}) {
  const je = liveCorrection(db, personId);
  if (!je) throw C.stop(`سند اصلاحی زنده‌ای برای شخص ${personId} نیست`);
  C.assertNoPurgeCollateral(db, je.id);
  const { reverseJournalEntry } = C.srv('lib/void-journal');
  reverseJournalEntry(db, je.id, { userId, reason: `ابطال P8b-1 — ${reason}`, sourceType: REF_TYPE });
  if (C.liveJe(db, je.id)) throw C.stop('STOP: سند اصلاحی ابطال نشد');
  C.insertAudit(db, { userId, action: 'p8b_reverse', entity: REF_TYPE, entityId: je.id, detail: { reason, person_id: Number(personId) } });
  return { reversed_je_id: je.id };
}

function csvRows(plan, applied) {
  const rows = [];
  const pid = plan.person.id;
  for (const [opt, res] of Object.entries(applied)) {
    for (const l of res.lines) {
      rows.push({
        item: `${ITEM}-${opt}`, target_table: 'journal_lines', target_id: `new JE (${res.head.voucher_number || 'JV-?'})`,
        action: 'gl_delta', account_code: l.account_code, detail_account_id: l.detail_account_id,
        cost_center_id: l.cost_center_id, debit_rial: l.debit_rial, credit_rial: l.credit_rial,
        person_id: pid, note: l.description,
      });
    }
  }
  const info = (target, note, d, c) => rows.push({
    item: ITEM, target_table: 'journal_lines', target_id: target, action: 'info', account_code: target,
    detail_account_id: '', cost_center_id: '', debit_rial: d, credit_rial: c, person_id: pid, note,
  });
  for (const [k, v] of Object.entries(plan.asset_movement.byCat)) {
    info(plan.asset.code, `گردش زندهٔ ${k} — JE ${v.je_ids.join('/')}`, v.debit_rial, v.credit_rial);
  }
  const ab = plan.asset_movement.balance;
  info(plan.asset.code, `ماندهٔ فعلی (خالص ${ab.net_rial}) · بعد A: ${plan.after.A.asset_net_rial} · بعد B: ${plan.after.B.asset_net_rial}`, ab.debit_rial, ab.credit_rial);
  const pb = plan.payable_movement.balance;
  info(plan.payable.code, `ماندهٔ فعلی (خالص ${pb.net_rial}) · بعد A: ${plan.after.A.payable_net_rial} · بعد B: ${plan.after.B.payable_net_rial}`, pb.debit_rial, pb.credit_rial);
  const pl = plan.person_ledger;
  rows.push({
    item: ITEM, target_table: 'person_ledger', target_id: `person ${pid}`, action: 'info_unchanged',
    account_code: '', detail_account_id: '', cost_center_id: '', debit_rial: pl.debit_rial, credit_rial: pl.credit_rial,
    person_id: pid, note: `دفتر معین شخص بدون تغییر (${pl.rows} ردیف، خالص ${pl.net_rial}) = گردش اسنادِ هر دو حساب شخص`,
  });
  return rows;
}

async function main(args) {
  const mode = C.modeOf(args);
  const personId = parseInt(args.person, 10) || 132;
  const userId = C.userIdArg(args);
  await C.withWorkingDb(args, mode, async (db) => {
    if (mode === 'reverse') {
      const r = C.runTxn(db, mode, () => reverseLaborReclass(db, { personId, reason: args.reason, userId }));
      console.log(`✅ ابطال شد: JE #${r.reversed_je_id}`);
      return;
    }
    if (mode === 'apply') {
      const r = C.runTxn(db, mode, () => applyLaborReclass(db, {
        personId, option: args.option, date: args.date, reason: args.reason, userId, payableCode: args.payable || null,
      }));
      const file = C.writeCsv(path.join(C.outDir(args), `p8b-1-labor-reclass-applied-${r.je_id}.csv`), csvRows(r.plan, { [r.option]: r }));
      console.log(`✅ ثبت شد: JE #${r.je_id} (${r.head.voucher_number}) · ${file}`);
      return;
    }
    const plan = C.runTxn(db, 'dry-run', () => planLaborReclass(db, { personId, payableCode: args.payable || null }));
    const applied = {};
    for (const opt of ['A', 'B']) {
      applied[opt] = C.runTxn(db, 'dry-run', () => applyLaborReclass(db, {
        personId, option: opt, date: args.date, reason: 'dry-run', userId, payableCode: args.payable || null,
      }));
    }
    const file = C.writeCsv(path.join(C.outDir(args), CSV_NAME), csvRows(plan, applied));
    const summary = {
      item: ITEM, person: plan.person, role: plan.role, resolver: plan.resolver,
      asset: plan.asset, payable: plan.payable,
      labor: plan.labor.map((r) => ({ je_id: r.je_id, doc_no: r.doc_no, order_id: r.order_id, credit_rial: r.credit_rial })),
      payments: plan.payments.map((r) => ({ je_id: r.je_id, debit_rial: r.debit_rial })),
      labor_total_rial: plan.labor_total_rial, payments_total_rial: plan.payments_total_rial,
      asset_movement: plan.asset_movement, payable_movement: plan.payable_movement,
      after: plan.after, person_ledger: plan.person_ledger, csv: file,
    };
    require('fs').writeFileSync(path.join(C.outDir(args), 'p8b-1-labor-reclass.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  });
}

module.exports = { planLaborReclass, applyLaborReclass, reverseLaborReclass, REF_TYPE };

if (require.main === module) C.cli(main);
