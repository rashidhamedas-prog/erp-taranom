#!/usr/bin/env node
'use strict';
/**
 * P8b-3 — یافتهٔ جانبی: دریافت طاقه‌هایی که بستانکار حساب دارایی «متفرقه» (1106…) شده‌اند
 * به‌جای پرداختنی تأمین‌کننده. فقط گزارش (dry-run)؛ apply عمداً پیاده نشده چون
 * اصلاح دفتر کل قبلاً با سند دستی انجام شده است (اگر نشده بود، گزارش پیشنهاد reclass می‌دهد).
 *
 * Usage: node server/scripts/p8b-misc-fabric-payable.js --db=<crm.db> [--code=110601000124] [--out=dir]
 */
const fs = require('fs');
const path = require('path');
const C = require('./lib/p8b-common');

const ITEM = 'P8b-3';
const CSV_NAME = 'p8b-3-misc-fabric-payable.csv';

function owners(db, code) {
  const q = (sql) => { try { return db.prepare(sql).all(code); } catch (_) { return []; } };
  return {
    persons: q('SELECT id, name, coa_code, party_id FROM persons WHERE coa_code=?'),
    suppliers: q('SELECT id, name, coa_code, party_id FROM suppliers WHERE coa_code=?'),
    customers: q('SELECT id, name, coa_code, party_id FROM customers WHERE coa_code=?'),
    parties: q('SELECT id, name, coa_code FROM parties WHERE coa_code=?'),
  };
}

function bookNet(db, table, col, id) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const alive = cols.includes('deleted_at') ? 'COALESCE(deleted_at,0)=0' : '1=1';
  const r = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM ${table} WHERE ${col}=? AND ${alive}`).get(id);
  return { rows: r.n, debit: Math.round(r.d), credit: Math.round(r.c), net: Math.round(r.d - r.c) };
}

function planMiscFabric(db, { code = '110601000124' } = {}) {
  const lines = db.prepare(`
    SELECT je.id je_id, je.entry_date, je.ref_type, je.ref_id, je.voucher_number, je.voucher_type, je.description,
           jl.debit_rial, jl.credit_rial, jl.detail_account_id
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND ${C.JE_ALIVE}
    ORDER BY je.id
  `).all(String(code));
  const fabric = [];
  for (const l of lines.filter((x) => x.ref_type === 'fabric_roll' && x.credit_rial > 0)) {
    const b = db.prepare(`SELECT id, batch_no, product_id, warehouse_id, supplier_id, qty_received, unit_cost_rial, status
      FROM inventory_batches WHERE id=? OR journal_id=? ORDER BY (id=?) DESC LIMIT 1`).get(l.ref_id, l.je_id, l.ref_id);
    const s = b && b.supplier_id ? db.prepare('SELECT id, name, coa_code, party_id FROM suppliers WHERE id=?').get(b.supplier_id) : null;
    fabric.push({ ...l, batch: b || null, supplier: s || null });
  }
  const others = lines.filter((x) => !(x.ref_type === 'fabric_roll' && x.credit_rial > 0));
  const fabricTotal = fabric.reduce((a, f) => a + Math.round(f.credit_rial), 0);
  const supplierCodes = [...new Set(fabric.map((f) => f.supplier && f.supplier.coa_code).filter(Boolean))];
  const offsets = others.map((o) => {
    const peers = db.prepare(`SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=? ORDER BY line_no`).all(o.je_id);
    return { ...o, peers };
  });
  const alreadyMoved = offsets.filter((o) => o.debit_rial > 0
    && o.peers.some((p) => supplierCodes.includes(String(p.account_code)) && p.credit_rial > 0))
    .reduce((a, o) => a + Math.round(o.debit_rial), 0);
  const own = owners(db, code);
  const party = C.srv('lib/party-leaf-sync');
  const bookPlans = [];
  for (const c of [String(code), ...supplierCodes]) {
    try { bookPlans.push(party.reconcileLeaf(db, c, { insert: 'all', dryRun: true, reason: 'p8b-3 dry-run' })); }
    catch (e) { bookPlans.push({ code: c, error: e.message }); }
  }
  const supplierBooks = [...new Set(fabric.map((f) => f.supplier && f.supplier.id).filter(Boolean))]
    .map((id) => ({ supplier_id: id, ...bookNet(db, 'supplier_ledger', 'supplier_id', id) }));
  const personBooks = own.persons.map((p) => ({ person_id: p.id, name: p.name, ...bookNet(db, 'person_ledger', 'person_id', p.id) }));
  const glNet = (c) => C.glBalance(db, c).net_rial;
  const bookMatchesGl = (c) => {
    if (c === String(code)) return personBooks.every((b) => b.net === glNet(c));
    const sup = fabric.find((f) => f.supplier && f.supplier.coa_code === c);
    const sb = sup && supplierBooks.find((b) => b.supplier_id === sup.supplier.id);
    return !!sb && sb.net === glNet(c);
  };
  for (const bp of bookPlans) bp.book_matches_gl = bookMatchesGl(String(bp.code));
  return {
    code: String(code), owners: own, gl: C.glBalance(db, code),
    fabric, fabric_total_rial: fabricTotal,
    fabric_lots_333: fabric.filter((f) => f.batch && Number(f.batch.product_id) === 333),
    others: offsets, already_moved_rial: alreadyMoved,
    supplier_codes: supplierCodes,
    supplier_gl: supplierCodes.map((sc) => ({ code: sc, ...C.glBalance(db, sc) })),
    remaining_to_reclass_rial: fabricTotal - alreadyMoved,
    person_books: personBooks, supplier_books: supplierBooks,
    book_plans: bookPlans.map((b) => ({ code: b.code, books: b.books, error: b.error, book_matches_gl: b.book_matches_gl,
      inserted: b.actions ? b.actions.inserted : [], retired: b.actions ? b.actions.retired : [] })),
  };
}

function csvRows(p) {
  const rows = [];
  const base = { item: ITEM, detail_account_id: '', cost_center_id: '', person_id: '' };
  for (const f of p.fabric) {
    rows.push({ ...base, target_table: 'journal_lines', target_id: `JE ${f.je_id}`, action: 'info', account_code: p.code,
      debit_rial: f.debit_rial, credit_rial: f.credit_rial, person_id: (p.owners.persons[0] || {}).id || '',
      note: `${f.description} — تأمین‌کننده ${f.supplier ? `${f.supplier.id} «${f.supplier.name}» (${f.supplier.coa_code})` : 'نامعلوم'}${f.batch ? ` · کالا ${f.batch.product_id}` : ''}` });
  }
  for (const o of p.others) {
    rows.push({ ...base, target_table: 'journal_lines', target_id: `JE ${o.je_id}`, action: 'info', account_code: p.code,
      debit_rial: o.debit_rial, credit_rial: o.credit_rial,
      note: `${o.voucher_number || ''} ${o.entry_date} «${o.description}» طرف مقابل: ${o.peers.map((x) => `${x.account_code} ${x.debit_rial}/${x.credit_rial}`).join(' ؛ ')}` });
  }
  rows.push({ ...base, target_table: 'journal_lines', target_id: p.code, action: 'info', account_code: p.code,
    debit_rial: p.gl.debit_rial, credit_rial: p.gl.credit_rial,
    note: `ماندهٔ خالص ${p.gl.net_rial}؛ جمع طاقه ${p.fabric_total_rial}؛ قبلاً منتقل‌شده ${p.already_moved_rial}؛ باقی‌مانده برای reclass ${p.remaining_to_reclass_rial} → اصلاح دفتر کل لازم نیست` });
  for (const b of p.person_books) {
    rows.push({ ...base, target_table: 'person_ledger', target_id: `person ${b.person_id}`, action: 'subledger_finding', account_code: p.code,
      debit_rial: b.debit, credit_rial: b.credit, person_id: b.person_id,
      note: `دفتر معین «${b.name}» خالص ${b.net} ولی ماندهٔ دفتر کل ${p.gl.net_rial} — ردیف سند اصلاحی در دفتر معین نیامده` });
  }
  for (const b of p.supplier_books) {
    rows.push({ ...base, target_table: 'supplier_ledger', target_id: `supplier ${b.supplier_id}`, action: 'subledger_finding', account_code: p.supplier_codes.join('/'),
      debit_rial: b.debit, credit_rial: b.credit,
      note: `دفتر معین تأمین‌کننده خالص ${b.net}؛ ماندهٔ دفتر کل ${p.supplier_gl.map((g) => `${g.code}=${g.net_rial}`).join(',')}` });
  }
  for (const bp of p.book_plans) {
    for (const a of bp.inserted || []) {
      rows.push({ ...base, target_table: a.book === 'person' ? 'person_ledger' : `${a.book}_ledger`, target_id: `${a.book} ${a.entity_id}`,
        action: bp.book_matches_gl ? 'subledger_rejected' : 'subledger_proposal', account_code: bp.code, debit_rial: a.debit, credit_rial: a.credit,
        person_id: a.book === 'person' ? a.entity_id : '',
        note: bp.book_matches_gl
          ? `رد شده: دفتر معین همین الان با دفتر کل برابر است (ردیف‌های بومی طاقه)؛ درج JE ${a.je_id} آن را دوبار می‌شمارد`
          : `پیشنهاد (تصمیم مالک): درج ردیف دفتر معین از JE ${a.je_id} (${a.ref_type}#${a.ref_id}) تا خالص دفتر معین = دفتر کل` });
    }
    for (const a of bp.retired || []) {
      rows.push({ ...base, target_table: 'book', target_id: JSON.stringify(a).slice(0, 80), action: 'subledger_proposal', account_code: bp.code,
        debit_rial: a.debit, credit_rial: a.credit, note: 'پیشنهاد: retire ردیف بی‌سند' });
    }
  }
  return rows;
}

async function main(args) {
  const mode = C.modeOf(args);
  if (mode !== 'dry-run') {
    throw C.stop('P8b-3 فقط گزارش است: اصلاح دفتر کل قبلاً با سند دستی انجام شده؛ هم‌ترازی دفتر معین با ابزار موجود «تطبیق دفاتر معین» و تصمیم مالک');
  }
  const code = String(args.code || '110601000124');
  await C.withWorkingDb(args, mode, async (db) => {
    const plan = C.runTxn(db, 'dry-run', () => planMiscFabric(db, { code }));
    const file = C.writeCsv(path.join(C.outDir(args), CSV_NAME), csvRows(plan));
    const summary = { item: ITEM, ...plan, csv: file };
    fs.writeFileSync(path.join(C.outDir(args), 'p8b-3-misc-fabric-payable.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({
      code: plan.code, gl: plan.gl, owners: plan.owners, fabric_total_rial: plan.fabric_total_rial,
      already_moved_rial: plan.already_moved_rial, remaining_to_reclass_rial: plan.remaining_to_reclass_rial,
      supplier_codes: plan.supplier_codes, supplier_gl: plan.supplier_gl, person_books: plan.person_books,
      supplier_books: plan.supplier_books, book_plans: plan.book_plans.map((b) => ({ code: b.code, ins: (b.inserted || []).length, ret: (b.retired || []).length, book_matches_gl: b.book_matches_gl })),
      csv: file,
    }, null, 2));
  });
}

module.exports = { planMiscFabric };

if (require.main === module) C.cli(main);
