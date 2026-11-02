#!/usr/bin/env node
'use strict';
/**
 * Dry-run (پیش‌فرض، فقط‌خواندنی) — نگاشت معین‌های 61030x به کارگاه (cc1) و اتو/بسته‌بندی (cc8)
 * طبق تصمیم مالک، به‌جای دفتر توزیع (cc2).
 *
 * خروجی CSV (بخش‌ها در ستون section):
 *   current_map      نگاشت‌های فعلی 61030x
 *   account          معین‌های برگ 61030x با گردش/مانده
 *   proposed_map     نگاشت پیشنهادی (هر معین × هر مرکز نسبت)
 *   deactivate_map   نگاشت‌هایی که غیرفعال می‌شوند (حذف فیزیکی نه — R13)
 *   je_line          سند جذب پیش‌بینی‌شدهٔ دوره: بد 5202 به تفکیک مرکز / بس هر معین
 *   precheck         وضعیت SHARED_MOEIN و OH_ACTUAL_ON_CONTROL قبل/بعد
 *   posted           اسناد جذب قبلاً ثبت‌شدهٔ همان دوره
 *
 * Usage:
 *   node oh-split-maps-dryrun.js [--db PATH] [--period 1405/07] [--split '{"1":50,"8":50}']
 *        [--out file.csv] [--module /path/to/better-sqlite3]
 *   node oh-split-maps-dryrun.js --db PATH --apply --i-have-approval   (یک تراکنش + audit_log)
 */
const fs = require('fs');
const path = require('path');

const PROD_ROOT = '/home/taranom/crm-taranom/server';

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) { out[key] = next; i++; } else out.flags.add(key);
  }
  return out;
}

function loadSqlite(modulePath) {
  const candidates = [
    modulePath,
    path.join(PROD_ROOT, 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ].filter(Boolean);
  const errors = [];
  for (const c of candidates) {
    try { return require(c); } catch (e) { errors.push(`${c}: ${e.message}`); }
  }
  throw new Error(`better-sqlite3 not found:\n  ${errors.join('\n  ')}`);
}

const DR = 'COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)';
const CR = 'COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)';

function hasCol(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch (_) { return false; }
}
function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.flags.has('apply');
  if (apply && !args.flags.has('i-have-approval')) {
    console.error('--apply requires --i-have-approval (owner approval). Aborting.');
    process.exit(2);
  }
  if (apply && !args.db) {
    console.error('--apply requires an explicit --db path. Aborting.');
    process.exit(2);
  }
  const dbPath = args.db || path.join(PROD_ROOT, 'crm.db');
  const period = String(args.period || '1405/07');
  const m = period.match(/^(\d{4})\/(\d{1,2})$/);
  if (!m) { console.error('bad --period'); process.exit(2); }
  const ym = `${m[1]}/${String(Number(m[2])).padStart(2, '0')}`;
  const from = `${ym}/01`;
  const to = `${ym}/31`;
  const split = JSON.parse(args.split || '{"1":50,"8":50}');
  const splitIds = Object.keys(split).map(Number).filter((id) => Number(split[id]) > 0);
  const splitSum = splitIds.reduce((s, id) => s + Number(split[id]), 0);
  if (!splitIds.length || splitSum > 100.001) { console.error(`invalid split (sum ${splitSum})`); process.exit(2); }

  const Database = loadSqlite(args.module);
  const db = new Database(dbPath, apply ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
  const alive = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted')<>'reversed'`
    + (hasCol(db, 'journal_entries', 'status') ? ` AND COALESCE(je.status,'approved')<>'draft'` : '');

  const setting = (k, d) => { try { return db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value || d; } catch (_) { return d; } };
  const code5202 = setting('coa_overhead_control', '5202');
  const code5203 = setting('coa_overhead_applied', '5203');

  const centers = db.prepare('SELECT id, code, name, COALESCE(seq,0) AS seq, COALESCE(active,1) AS active FROM cost_centers').all();
  const ccById = new Map(centers.map((c) => [Number(c.id), c]));
  for (const id of splitIds) {
    const c = ccById.get(id);
    if (!c) { console.error(`cost center ${id} not found`); process.exit(3); }
    if (!c.active) { console.error(`cost center ${id} inactive`); process.exit(3); }
  }
  const orderedSplit = splitIds.slice().sort((a, b) => (ccById.get(a).seq - ccById.get(b).seq) || (a - b));

  const postedJe = tableExists(db, 'cc_absorb_postings')
    ? db.prepare("SELECT DISTINCT je_id FROM cc_absorb_postings WHERE period_label=? AND status='posted' AND je_id IS NOT NULL").all(ym).map((r) => Number(r.je_id))
    : [];
  const accType = (code) => db.prepare('SELECT type FROM chart_of_accounts WHERE code=?').get(code)?.type || 'expense';
  function endingBalance(code, { excludeAbsorb = true } = {}) {
    const skip = excludeAbsorb ? postedJe : [];
    const r = db.prepare(`
      SELECT COALESCE(SUM(${DR}),0) d, COALESCE(SUM(${CR}),0) c
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE jl.account_code=? AND ${alive} AND je.entry_date <= ?
      ${skip.length ? `AND je.id NOT IN (${skip.map(() => '?').join(',')})` : ''}
    `).get(code, to, ...skip);
    const t = accType(code);
    const credNormal = ['liability', 'equity', 'income', 'revenue'].includes(t);
    return Math.round(credNormal ? r.c - r.d : r.d - r.c);
  }
  function periodDebit(code) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(${DR}),0) d
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE jl.account_code=? AND ${alive}
        AND COALESCE(je.ref_type,'') <> 'production_overhead_actual_reversal'
        AND je.entry_date >= ? AND je.entry_date <= ?
    `).get(code, from, to);
    return Math.round(r.d);
  }

  const currentMaps = db.prepare(`
    SELECT m.id, m.cost_center_id, cc.code AS cc_code, cc.name AS cc_name, m.account_code,
           m.absorb_pct, m.base_type, COALESCE(m.budget_rial,0) AS budget_rial, COALESCE(m.active,1) AS active
    FROM cost_center_account_maps m LEFT JOIN cost_centers cc ON cc.id=m.cost_center_id
    WHERE m.account_code LIKE '61030%'
    ORDER BY m.account_code, m.cost_center_id
  `).all();
  const leafAccounts = db.prepare(`
    SELECT a.code, a.name FROM chart_of_accounts a
    WHERE a.code LIKE '61030%' AND COALESCE(a.is_active,1)=1
      AND NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.parent_code=a.code)
    ORDER BY a.code
  `).all();
  const accounts = leafAccounts.map((a) => {
    const activeMaps = currentMaps.filter((x) => x.account_code === a.code && x.active);
    const anyActivity = db.prepare(`
      SELECT COUNT(*) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE jl.account_code=? AND ${alive} AND je.entry_date <= ?
    `).get(a.code, to).c;
    const existingBase = activeMaps.find((x) => x.base_type && x.base_type !== 'budget')?.base_type || null;
    return {
      code: a.code,
      name: a.name,
      ending_balance_rial: endingBalance(a.code),
      period_debit_rial: periodDebit(a.code),
      line_count: Number(anyActivity) || 0,
      existing_base: existingBase,
      proposed_base: a.code === '610307' ? 'period_debit' : (existingBase || 'period_debit'),
      current_maps: activeMaps,
    };
  }).filter((a) => a.line_count > 0 || a.ending_balance_rial !== 0 || a.current_maps.length);

  const proposed = [];
  const deactivate = [];
  for (const a of accounts) {
    for (const id of orderedSplit) {
      const existing = currentMaps.find((x) => x.account_code === a.code && Number(x.cost_center_id) === id);
      proposed.push({
        account_code: a.code, account_name: a.name, cost_center_id: id,
        cc_code: ccById.get(id).code, cc_name: ccById.get(id).name,
        absorb_pct: Number(split[id]), base_type: a.proposed_base,
        action: existing ? 'update' : 'insert', map_id: existing ? existing.id : '',
      });
    }
    for (const x of a.current_maps) {
      if (!orderedSplit.includes(Number(x.cost_center_id))) deactivate.push(x);
    }
  }

  // سهم هر مرکز: جمع = round(مبنا × Σ٪)، هر مرکز round(مبنا × ٪)، باقیمانده به آخرین مرکز (seq)
  const jeShares = [];
  for (const a of accounts) {
    const baseRial = Math.max(0, a.proposed_base === 'ending_balance' ? a.ending_balance_rial : a.period_debit_rial);
    const total = Math.round(baseRial * (splitSum / 100));
    let allocated = 0;
    orderedSplit.forEach((id, i) => {
      const share = i === orderedSplit.length - 1 ? total - allocated : Math.round(baseRial * (Number(split[id]) / 100));
      allocated += share;
      jeShares.push({ account_code: a.code, account_name: a.name, cost_center_id: id, base_type: a.proposed_base, base_rial: baseRial, pct: Number(split[id]), amount_rial: share });
    });
  }
  const drByCc = orderedSplit.map((id) => ({
    cost_center_id: id, cc_name: ccById.get(id).name,
    amount_rial: jeShares.filter((s) => s.cost_center_id === id).reduce((s, x) => s + x.amount_rial, 0),
  }));
  const crByAcc = accounts.map((a) => ({
    account_code: a.code, account_name: a.name,
    amount_rial: jeShares.filter((s) => s.account_code === a.code).reduce((s, x) => s + x.amount_rial, 0),
  })).filter((x) => x.amount_rial > 0);
  const jeTotal = drByCc.reduce((s, x) => s + x.amount_rial, 0);

  const sharedBefore = db.prepare(`
    SELECT account_code, SUM(absorb_pct) pct, COUNT(*) c FROM cost_center_account_maps
    WHERE COALESCE(active,1)=1 GROUP BY account_code HAVING c > 1 AND SUM(absorb_pct) > 100.001
  `).all();
  const touched = new Set(accounts.map((a) => a.code));
  const sharedAfter = sharedBefore.filter((x) => !touched.has(x.account_code)).map((x) => x.account_code)
    .concat(splitSum > 100.001 ? [...touched] : []);
  const bal = (code) => endingBalance(code, { excludeAbsorb: false });
  const b5202 = bal(code5202);
  const b5203 = bal(code5203);
  const ohFailBefore = Math.abs(b5202) <= 5 && Math.abs(b5203) > 5;
  const ohFailAfter = Math.abs(b5202 + jeTotal) <= 5 && Math.abs(b5203) > 5;
  const posted = tableExists(db, 'cc_absorb_postings')
    ? db.prepare('SELECT doc_no, cost_center_id, map_id, account_code, amount_rial, status, je_id FROM cc_absorb_postings WHERE period_label=? ORDER BY id').all(ym)
    : [];

  const rows = [];
  const push = (section, o) => rows.push({ section, ...o });
  for (const x of currentMaps) push('current_map', { map_id: x.id, account_code: x.account_code, cost_center_id: x.cost_center_id, cc_name: x.cc_name, absorb_pct: x.absorb_pct, base_type: x.base_type, active: x.active });
  for (const a of accounts) push('account', { account_code: a.code, account_name: a.name, ending_balance_rial: a.ending_balance_rial, period_debit_rial: a.period_debit_rial, base_type: a.proposed_base, note: a.existing_base ? `existing_base=${a.existing_base}` : 'unmapped' });
  for (const p of proposed) push('proposed_map', { map_id: p.map_id, account_code: p.account_code, account_name: p.account_name, cost_center_id: p.cost_center_id, cc_name: p.cc_name, absorb_pct: p.absorb_pct, base_type: p.base_type, note: p.action });
  for (const x of deactivate) push('deactivate_map', { map_id: x.id, account_code: x.account_code, cost_center_id: x.cost_center_id, cc_name: x.cc_name, absorb_pct: x.absorb_pct, base_type: x.base_type, active: 0 });
  for (const s of jeShares) push('je_share', { account_code: s.account_code, account_name: s.account_name, cost_center_id: s.cost_center_id, cc_name: ccById.get(s.cost_center_id).name, base_type: s.base_type, base_rial: s.base_rial, absorb_pct: s.pct, amount_rial: s.amount_rial });
  for (const d of drByCc) push('je_line', { account_code: code5202, cost_center_id: d.cost_center_id, cc_name: d.cc_name, debit_rial: d.amount_rial, credit_rial: 0, period: ym });
  for (const c of crByAcc) push('je_line', { account_code: c.account_code, account_name: c.account_name, debit_rial: 0, credit_rial: c.amount_rial, period: ym });
  push('precheck', { note: 'SHARED_MOEIN', status_before: sharedBefore.length ? 'fail' : 'pass', status_after: sharedAfter.length ? 'fail' : 'pass' });
  push('precheck', { note: 'OH_ACTUAL_ON_CONTROL', status_before: ohFailBefore ? 'fail' : 'pass', status_after: ohFailAfter ? 'fail' : 'pass', debit_rial: b5202, credit_rial: b5203, amount_rial: jeTotal });
  for (const p of posted) push('posted', { note: p.doc_no, cost_center_id: p.cost_center_id, map_id: p.map_id, account_code: p.account_code, amount_rial: p.amount_rial, active: p.status });

  const cols = ['section', 'map_id', 'account_code', 'account_name', 'cost_center_id', 'cc_name', 'absorb_pct', 'base_type',
    'active', 'base_rial', 'ending_balance_rial', 'period_debit_rial', 'amount_rial', 'debit_rial', 'credit_rial',
    'period', 'status_before', 'status_after', 'note'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
  if (args.out) fs.writeFileSync(args.out, csv, 'utf8');
  else process.stdout.write(csv);

  const summary = {
    mode: apply ? 'APPLY' : 'DRY-RUN (readonly)',
    db: dbPath, period: ym, split, centers: orderedSplit.map((id) => `${id}=${ccById.get(id).code} ${ccById.get(id).name}`),
    accounts: accounts.map((a) => `${a.code} base=${a.proposed_base} end=${a.ending_balance_rial} pdebit=${a.period_debit_rial}`),
    proposed_maps: proposed.length, deactivate_maps: deactivate.length,
    je: { debit_by_cc: drByCc, credit_by_account: crByAcc, total_rial: jeTotal },
    precheck: {
      SHARED_MOEIN: { before: sharedBefore.length ? 'fail' : 'pass', after: sharedAfter.length ? 'fail' : 'pass' },
      OH_ACTUAL_ON_CONTROL: { before: ohFailBefore ? 'fail' : 'pass', after_projected_absorb: ohFailAfter ? 'fail' : 'pass', bal_5202: b5202, bal_5203: b5203 },
    },
    already_posted_rows: posted.filter((p) => p.status === 'posted').length,
  };
  console.error(JSON.stringify(summary, null, 2));

  if (!apply) { db.close(); return; }

  const tx = db.transaction(() => {
    const up = db.prepare(`
      INSERT INTO cost_center_account_maps (cost_center_id, account_code, absorb_pct, base_type, budget_rial, active, note)
      VALUES (?,?,?,?,0,1,'تسهیم سربار واقعی (oh-split-maps-dryrun)')
      ON CONFLICT(cost_center_id, account_code) DO UPDATE SET
        absorb_pct=excluded.absorb_pct, base_type=excluded.base_type, active=1, note=excluded.note
    `);
    const off = db.prepare('UPDATE cost_center_account_maps SET active=0 WHERE id=?');
    for (const x of deactivate) off.run(x.id);
    for (const p of proposed) up.run(p.cost_center_id, p.account_code, p.absorb_pct, p.base_type);
    db.prepare(`INSERT INTO settings (key,value) VALUES ('oh_actual_split', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(split));
    const over = db.prepare(`
      SELECT account_code, SUM(absorb_pct) pct FROM cost_center_account_maps
      WHERE COALESCE(active,1)=1 AND account_code LIKE '61030%' GROUP BY account_code HAVING SUM(absorb_pct) > 100.001
    `).all();
    if (over.length) throw new Error(`absorb_pct > 100% after apply: ${JSON.stringify(over)}`);
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (NULL, ?, ?, NULL, ?)').run(
      'update', 'oh_actual_split', JSON.stringify({
        source: 'scripts/oh-split-maps-dryrun.js', split,
        before: currentMaps, deactivated: deactivate.map((x) => x.id),
        proposed: proposed.map((p) => ({ cost_center_id: p.cost_center_id, account_code: p.account_code, absorb_pct: p.absorb_pct, base_type: p.base_type })),
      }));
  });
  tx();
  console.error(`APPLIED: ${proposed.length} maps upserted, ${deactivate.length} deactivated, setting oh_actual_split saved.`);
  db.close();
}

main();
