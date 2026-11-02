#!/usr/bin/env node
'use strict';
/**
 * P8 — گزارش ترکیبی قبل/بعد: «قبل» = اعداد زندهٔ دیتابیس (readonly) یا snapshot ذخیره‌شده؛
 * «بعد» = قبل + دلتاهای P8b (+ دلتاهای P8a اگر فایلش موجود باشد).
 *
 * Usage:
 *   # روی سرور (فقط خواندنی) → snapshot
 *   node p8-combined-report.js --db=/path/crm.db --snapshot-out=p8-before.json
 *   # ادغام (هر زمان دوباره قابل اجرا)
 *   node server/scripts/p8-combined-report.js --before=reports/prodcycle-p8/p8-before.json \
 *        [--p8a=reports/prodcycle-p8/p8a-deltas.csv] [--labor-option=A|B] [--out=reports/prodcycle-p8]
 *
 * قرارداد دلتا (ستون‌های مشترک CSV): ردیفی که account_code و debit/credit عددی دارد و action آن
 * با info/row_update/subledger شروع نمی‌شود، دلتای دفتر کل است؛ action شامل void/revers/cancel/undo
 * با علامت منفی جمع می‌شود. دلتای کاردکس: target_table=inventory_ledger و account_code=WH<id>
 * (یا «WH<id>» در note) با debit=ورود ارزش، credit=خروج ارزش.
 */
const fs = require('fs');
const path = require('path');

const REPORTS = path.join(__dirname, '..', '..', 'reports', 'prodcycle-p8');
const WAREHOUSES = [33, 37, 34, 35];
const GL_CODES = ['1110', '1111', '1104'];
const JE_ALIVE = "COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void','draft')";
const LEDGER_LIVE = `l.status='posted' AND l.reversed_of IS NULL
  AND COALESCE(l.event_type,'') <> 'reversal' AND COALESCE(l.event_type,'') NOT GLOB '*_reversal'`;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function openReadonly(dbPath) {
  let Database;
  const srvDir = process.env.P8_SERVER_DIR;
  try { Database = require(srvDir ? path.join(srvDir, 'node_modules', 'better-sqlite3') : 'better-sqlite3'); }
  catch (_) { Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3')); }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function snapshot(db) {
  const gl = {};
  for (const code of GL_CODES) {
    const rows = db.prepare(`
      SELECT jl.account_code code, COALESCE(SUM(jl.debit_rial),0) d, COALESCE(SUM(jl.credit_rial),0) c
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE (jl.account_code=? OR jl.account_code LIKE ?) AND ${JE_ALIVE}
      GROUP BY jl.account_code
    `).all(code, `${code}%`);
    gl[code] = {
      net_rial: rows.reduce((s, r) => s + Math.round(r.d - r.c), 0),
      debit_rial: rows.reduce((s, r) => s + Math.round(r.d), 0),
      credit_rial: rows.reduce((s, r) => s + Math.round(r.c), 0),
      by_code: rows.map((r) => ({ code: r.code, net_rial: Math.round(r.d - r.c) })),
    };
  }
  const kardex = {};
  for (const wh of WAREHOUSES) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(l.qty_in,0)-COALESCE(l.qty_out,0)),0) q,
        COALESCE(SUM(CASE WHEN COALESCE(l.qty_in,0)>0 THEN ROUND(COALESCE(l.amount_rial,0))
          WHEN COALESCE(l.qty_out,0)>0 THEN -ROUND(COALESCE(l.amount_rial,0))
          ELSE ROUND(COALESCE(l.amount_rial,0)) END),0) v
      FROM inventory_ledger l WHERE ${LEDGER_LIVE} AND l.warehouse_id=?
    `).get(wh);
    const w = db.prepare('SELECT id, code, name FROM warehouses WHERE id=?').get(wh) || {};
    kardex[wh] = { value_rial: Math.round(r.v), qty: Math.round(r.q * 1000) / 1000, code: w.code, name: w.name };
  }
  const tb = db.prepare(`
    SELECT COALESCE(SUM(jl.debit_rial),0) d, COALESCE(SUM(jl.credit_rial),0) c, COUNT(*) n
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${JE_ALIVE}
  `).get();
  const unbalanced = db.prepare(`
    SELECT je.id, SUM(jl.debit_rial) d, SUM(jl.credit_rial) c
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${JE_ALIVE}
    GROUP BY je.id HAVING ABS(SUM(jl.debit_rial)-SUM(jl.credit_rial))>0
  `).all();
  const extra = {};
  for (const code of ['110301000015', '210101000006', '110601000124', '210101000009', '5221']) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(jl.debit_rial),0) d, COALESCE(SUM(jl.credit_rial),0) c
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE jl.account_code=? AND ${JE_ALIVE}
    `).get(code);
    extra[code] = Math.round(r.d - r.c);
  }
  return {
    taken_at: new Date().toISOString(),
    max_je_id: db.prepare('SELECT MAX(id) m FROM journal_entries').get().m,
    gl, kardex, extra,
    trial_balance: { debit_rial: Math.round(tb.d), credit_rial: Math.round(tb.c), lines: tb.n, unbalanced_entries: unbalanced },
  };
}

function parseCsv(text) {
  const rows = [];
  let i = 0; let field = ''; let row = []; let q = false;
  const s = text.replace(/^\uFEFF/, '');
  while (i < s.length) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])));
}

function deltasFrom(rows, { laborOption = 'A', source }) {
  const gl = new Map();
  const kardex = new Map();
  const warnings = [];
  for (const r of rows) {
    const action = String(r.action || '');
    if (/^(info|row_update|subledger|non_gl)/i.test(action)) continue;
    const item = String(r.item || '');
    const m = /^P8b-1-([AB])$/.exec(item);
    if (m && m[1] !== laborOption) continue;
    const d = Math.round(Number(r.debit_rial) || 0);
    const c = Math.round(Number(r.credit_rial) || 0);
    if (!d && !c) continue;
    const sign = /void|revers|cancel|undo/i.test(action) ? -1 : 1;
    const table = String(r.target_table || '');
    if (/inventory_ledger|kardex/i.test(table)) {
      const wm = /WH-?(\d+)/i.exec(String(r.account_code || '')) || /WH-?(\d+)/i.exec(String(r.note || ''));
      if (!wm) { warnings.push(`${source}: ردیف کاردکس بدون انبار — ${JSON.stringify(r).slice(0, 160)}`); continue; }
      const wh = Number(wm[1]);
      kardex.set(wh, (kardex.get(wh) || 0) + sign * (d - c));
      continue;
    }
    const code = String(r.account_code || '').trim();
    if (!code) { warnings.push(`${source}: ردیف بدون account_code — ${JSON.stringify(r).slice(0, 160)}`); continue; }
    const cur = gl.get(code) || { d: 0, c: 0 };
    cur.d += sign * d; cur.c += sign * c;
    gl.set(code, cur);
  }
  return { gl, kardex, warnings };
}

function sumPrefix(map, prefix) {
  let net = 0;
  for (const [code, v] of map) if (code === prefix || code.startsWith(prefix)) net += v.d - v.c;
  return net;
}
function sumTurnover(map) {
  let d = 0; let c = 0;
  for (const v of map.values()) { d += v.d; c += v.c; }
  return { d, c };
}

function readCsvIf(file) {
  if (!file || !fs.existsSync(file)) return null;
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.db) {
    const db = openReadonly(args.db);
    const snap = snapshot(db);
    db.close();
    const out = args['snapshot-out'] || path.join(REPORTS, 'p8-before.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(snap, null, 2));
    console.log(`snapshot → ${out}`);
    if (!args.before) args.before = out;
  }
  const outDir = args.out ? path.resolve(args.out) : REPORTS;
  const beforeFile = args.before || path.join(REPORTS, 'p8-before.json');
  if (!fs.existsSync(beforeFile)) { console.error(`snapshot «قبل» یافت نشد: ${beforeFile}`); process.exit(2); }
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
  const laborOption = String(args['labor-option'] || 'A').toUpperCase();

  const p8bFiles = (args.p8b ? String(args.p8b).split(',') : [
    'p8b-1-labor-reclass.csv', 'p8b-2-shared-waste.csv', 'p8b-3-misc-fabric-payable.csv',
  ].map((f) => path.join(REPORTS, f)));
  const p8bRows = [];
  for (const f of p8bFiles) { const r = readCsvIf(f); if (r) p8bRows.push(...r); }
  const p8aFile = args.p8a || path.join(REPORTS, 'p8a-deltas.csv');
  const p8aRows = readCsvIf(p8aFile);
  const B = deltasFrom(p8bRows, { laborOption, source: 'p8b' });
  const A = p8aRows ? deltasFrom(p8aRows, { laborOption, source: 'p8a' }) : { gl: new Map(), kardex: new Map(), warnings: [] };
  const p8aNote = p8aRows ? `P8a: ${path.basename(p8aFile)} (${p8aRows.length} ردیف)` : 'P8a: فایل دلتا در دسترس نبود — «بعد» فقط با دلتای P8b';

  const out = [];
  const push = (metric, b, db, da, note) => out.push({
    metric, before_rial: b, p8b_delta_rial: db, p8a_delta_rial: p8aRows ? da : '', after_rial: b + db + (p8aRows ? da : 0), note,
  });
  const pairs = [['1110', 33], ['1111', 37], ['1104', 34]];
  for (const [code, wh] of pairs) {
    const g = before.gl[code].net_rial;
    push(`GL ${code}`, g, sumPrefix(B.gl, code), sumPrefix(A.gl, code), before.gl[code].by_code.map((x) => `${x.code}=${x.net_rial}`).join(' '));
    const whs = code === '1104' ? [34, 35] : [wh];
    let kv = 0; let kb = 0; let ka = 0;
    for (const w of whs) { kv += before.kardex[w].value_rial; kb += B.kardex.get(w) || 0; ka += A.kardex.get(w) || 0; }
    push(`کاردکس WH${whs.join('+')}`, kv, kb, ka, whs.map((w) => `${before.kardex[w].code || w} ${before.kardex[w].name || ''}`).join(' + '));
    const gAfter = g + sumPrefix(B.gl, code) + (p8aRows ? sumPrefix(A.gl, code) : 0);
    const kAfter = kv + kb + (p8aRows ? ka : 0);
    out.push({ metric: `اختلاف GL ${code} − کاردکس WH${whs.join('+')}`, before_rial: g - kv, p8b_delta_rial: '', p8a_delta_rial: '',
      after_rial: gAfter - kAfter, note: 'صفر = هم‌خوان' });
  }
  for (const [code, label] of [['110301000015', 'دارایی مهدیه ابراهیمی'], ['210101000006', 'پرداختنی مهدیه ابراهیمی'],
    ['110601000124', 'متفرقه (شخص)'], ['210101000009', 'متفرقه طاقه (تأمین‌کننده)'], ['5221', 'ضایعات غیرعادی']]) {
    if (before.extra && before.extra[code] != null) {
      const net = (m) => { const v = m.get(code); return v ? v.d - v.c : 0; };
      push(`GL ${code}`, before.extra[code], net(B.gl), net(A.gl), label);
    }
  }
  const tb = before.trial_balance;
  const tB = sumTurnover(B.gl); const tA = sumTurnover(A.gl);
  push('تراز آزمایشی — جمع بدهکار', tb.debit_rial, tB.d, tA.d, `${tb.lines} سطر زنده`);
  push('تراز آزمایشی — جمع بستانکار', tb.credit_rial, tB.c, tA.c, `اسناد ناتراز قبل: ${tb.unbalanced_entries.length}`);
  out.push({ metric: 'تراز آزمایشی — بدهکار − بستانکار', before_rial: tb.debit_rial - tb.credit_rial,
    p8b_delta_rial: tB.d - tB.c, p8a_delta_rial: p8aRows ? tA.d - tA.c : '',
    after_rial: (tb.debit_rial + tB.d + (p8aRows ? tA.d : 0)) - (tb.credit_rial + tB.c + (p8aRows ? tA.c : 0)), note: 'باید صفر بماند' });

  fs.mkdirSync(outDir, { recursive: true });
  const cols = ['metric', 'before_rial', 'p8b_delta_rial', 'p8a_delta_rial', 'after_rial', 'note'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const file = path.join(outDir, laborOption === 'A' ? 'before-after.csv' : `before-after-${laborOption}.csv`);
  fs.writeFileSync(file, '\uFEFF' + [cols.join(','), ...out.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n', 'utf8');
  const warnings = [...B.warnings, ...A.warnings];
  console.log(`# P8 before/after — snapshot ${before.taken_at} (max JE ${before.max_je_id}) — گزینهٔ دستمزد ${laborOption}`);
  console.log(`# ${p8aNote}`);
  const f = (n) => (n === '' ? '—' : Number(n).toLocaleString('en-US'));
  console.log('| شاخص | قبل | دلتای P8b | دلتای P8a | بعد |');
  console.log('|---|---:|---:|---:|---:|');
  for (const r of out) console.log(`| ${r.metric} | ${f(r.before_rial)} | ${f(r.p8b_delta_rial)} | ${f(r.p8a_delta_rial)} | ${f(r.after_rial)} |`);
  if (warnings.length) { console.log('\nهشدارها:'); warnings.forEach((w) => console.log('- ' + w)); }
  console.log(`\n→ ${file}`);
}

if (require.main === module) main();

module.exports = { snapshot, parseCsv, deltasFrom };
