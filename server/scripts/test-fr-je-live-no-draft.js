'use strict';
/**
 * FR-RECON — balances ignore status='draft' JEs + reverse of a recon fix needs reason + confirm.
 * Run: node server/scripts/test-fr-je-live-no-draft.js
 *
 * Isolated temp DB. Covers:
 *  - approved + posted counted, draft ignored, reversed (soft-void) still excluded on the same accounts:
 *    trial balance, general ledger, account dashboard, balance sheet, gl-metrics, account ledger (ledgers.js),
 *    treasury glBalanceOnCode (guards + dashboard), POS glBalanceRial/AsOf, party-books glSignedForCoa,
 *    subledger-recon glBalance / inventory_vs_gl / reverse-preview gap.
 *  - P9 agent commission voucher stays status='draft' and moves no balance.
 *  - POST /api/accounting/subledger-recon/fixes/:id/reverse: missing/short reason or missing confirm → 400 with
 *    code, total_changes() unchanged; {reason, confirm:true} → 200, reason stored on fix + audit_log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ FR-RECON — JE live excludes draft + reverse confirm ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-je-live-'));
process.env.DB_PATH = path.join(dir, 'fr.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'fr-je-live-no-draft-test-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

const authMw = require('../middleware/auth');
const ADMIN = db.prepare("SELECT id, role, name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || { id: 1, role: 'admin', name: 'admin' };
authMw.auth = (req, _res, next) => { req.user = { id: ADMIN.id, role: 'admin', name: ADMIN.name }; next(); };

const recon = require('../lib/subledger-recon');
recon.ensureReconSchema(db);
const { todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');

const colsCache = new Map();
const cols = (t) => {
  if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
  return colsCache.get(t);
};
function insert(table, obj) {
  const c = cols(table);
  const keys = Object.keys(obj).filter((k) => c.has(k));
  return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid);
}
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const changes = () => q1('SELECT total_changes() AS n').n;

function insertJe({ date, status, deleted, refType, refId, lines, description }) {
  const id = insert('journal_entries', {
    entry_date: date, description: description || 'FR test', ref_type: refType || 'manual_test', ref_id: refId || 0,
    created_by: ADMIN.id, status, deleted_at: deleted ? Math.floor(Date.now() / 1000) : 0,
  });
  let n = 1;
  for (const l of lines) {
    insert('journal_lines', {
      entry_id: id, account_code: l.code, account_name: l.code,
      debit: (l.dr || 0) / 10, credit: (l.cr || 0) / 10, debit_rial: l.dr || 0, credit_rial: l.cr || 0, line_no: n++,
    });
  }
  return id;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/accounting/subledger-recon', require('../routes/subledger-recon'));
app.use('/api/accounting', require('../routes/accounting'));

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };

  const today = todayJalali();
  const A = '1199';
  const E = '3199';
  insert('chart_of_accounts', { code: A, name: 'دارایی تست FR', type: 'asset', level: 3, is_active: 1 });
  insert('chart_of_accounts', { code: E, name: 'سرمایه تست FR', type: 'equity', level: 3, is_active: 1 });

  try {
    console.log('— same accounts: approved + posted + draft + reversed —');
    insertJe({ date: today, status: 'approved', lines: [{ code: A, dr: 1000000 }, { code: E, cr: 1000000 }] });
    insertJe({ date: today, status: 'posted', lines: [{ code: A, dr: 20000 }, { code: E, cr: 20000 }] });
    const draftId = insertJe({ date: today, status: 'draft', lines: [{ code: A, dr: 777000 }, { code: E, cr: 777000 }] });
    insertJe({ date: today, status: 'reversed', deleted: true, lines: [{ code: A, dr: 50000 }, { code: E, cr: 50000 }] });
    const EXPECT = 1020000;
    ok(q1('SELECT status FROM journal_entries WHERE id=?', draftId).status === 'draft', 'draft JE stored as draft');

    const tb = await call('GET', '/api/accounting/trial-balance');
    const tbA = (tb.body.rows || []).find((r) => r.account_code === A);
    ok(tb.status === 200 && tbA && tbA.total_debit === EXPECT && tbA.debit_balance === EXPECT, 'trial balance: approved+posted only', tbA);
    ok(tb.body.balanced === true, 'trial balance still balanced', tb.body.unbalanced_count);

    const gl = await call('GET', `/api/accounting/general-ledger/${A}`);
    ok(gl.status === 200 && gl.body.closing_rial === EXPECT && gl.body.lines.length === 2, 'general ledger closing ignores draft/reversed', { c: gl.body.closing_rial, n: gl.body.lines && gl.body.lines.length });

    const dash = await call('GET', `/api/accounting/account-dashboard/${A}`);
    ok(dash.status === 200 && dash.body.period.balance === EXPECT, 'account dashboard balance ignores draft', dash.body.period);

    const bs = await call('GET', '/api/accounting/balance-sheet');
    const bsA = (bs.body.assets || []).find((x) => x.code === A);
    ok(bs.status === 200 && bsA && bsA.balance === EXPECT, 'balance sheet ignores draft', bsA);

    const glm = require('../lib/gl-metrics');
    ok(glm.glControlGrossByLeaf(db, A, { debitNormal: true }).net === EXPECT, 'gl-metrics glControlGrossByLeaf ignores draft');
    ok(glm.unbalancedEntryCount(db) === 0, 'gl-metrics unbalancedEntryCount 0');

    const led = require('../lib/ledgers').buildAccountLedger(db, q1('SELECT * FROM chart_of_accounts WHERE code=?', A));
    ok(led.closing_rial === EXPECT, 'ledgers.buildAccountLedger ignores draft', led.closing_rial);

    ok(require('../lib/treasury-guards').glBalanceOnCode(db, A) === EXPECT, 'treasury-guards glBalanceOnCode ignores draft');
    ok(require('../lib/treasury-dashboard').glBalanceOnCode(db, A) === EXPECT, 'treasury-dashboard glBalanceOnCode ignores draft');
    const pos = require('../lib/pos');
    ok(Math.round(pos.glBalanceAsOf(db, A, '')) === EXPECT, 'pos glBalanceAsOf ignores draft');
    ok(Math.round(pos.glBalanceRial(db, A)) === EXPECT, 'pos glBalanceRial ignores draft');
    ok(require('../lib/party-books').glSignedForCoa(db, A) === EXPECT, 'party-books glSignedForCoa ignores draft');
    ok(recon.glBalance(db, [A]) === EXPECT, 'subledger-recon glBalance (JE_LIVE) ignores draft', recon.glBalance(db, [A]));

    console.log('— subledger-recon inventory gap —');
    let invCode = '';
    try { invCode = String(acct(db, 'coa_inventory').code); } catch (_) { invCode = '1104'; }
    const invRow = () => (recon.runRecon(db, { checks: ['inventory_vs_gl'], persist: false }).checks[0]);
    const r0 = invRow();
    const glInv0 = recon.glBalance(db, [invCode]);
    insertJe({ date: today, status: 'draft', lines: [{ code: invCode, dr: 3330000 }, { code: E, cr: 3330000 }] });
    const r1 = invRow();
    ok(recon.glBalance(db, [invCode]) === glInv0 && r1.gl_rial === r0.gl_rial && r1.diff_rial === r0.diff_rial,
      'inventory_vs_gl GL/diff unchanged by draft', { before: r0.gl_rial, after: r1.gl_rial });

    // a recon fix (Dr E / Cr inventory 500,000) to drive preview + reverse
    const fixId = Number(db.prepare(`
      INSERT INTO subledger_recon_fixes (code, target, amount_rial, reason, detail_json, created_by)
      VALUES ('inventory_vs_gl', ?, -500000, 'fixture', '{}', ?)
    `).run(invCode, ADMIN.id).lastInsertRowid);
    const fixJe = insertJe({
      date: today, status: 'approved', refType: 'inventory_recon_adjust', refId: fixId,
      description: 'تعدیل تطبیق موجودی (تست FR)', lines: [{ code: E, dr: 500000 }, { code: invCode, cr: 500000 }],
    });
    db.prepare('UPDATE subledger_recon_fixes SET je_id=? WHERE id=?').run(fixJe, fixId);
    const pv0 = (await call('GET', `/api/accounting/subledger-recon/fixes/${fixId}/reverse-preview`)).body;
    insertJe({ date: today, status: 'draft', lines: [{ code: invCode, cr: 99000 }, { code: E, dr: 99000 }] });
    const pv1 = (await call('GET', `/api/accounting/subledger-recon/fixes/${fixId}/reverse-preview`)).body;
    ok(pv0 && pv1 && pv1.target_subtree.balance_before_rial === pv0.target_subtree.balance_before_rial
      && pv1.gap.before_rial === pv0.gap.before_rial && pv1.gap.after_rial === pv0.gap.after_rial
      && pv1.target_subtree.balance_after_rial === pv0.target_subtree.balance_before_rial + 500000,
    'reverse-preview subtree/gap ignore draft', { pv0: pv0 && pv0.target_subtree, pv1: pv1 && pv1.target_subtree });

    console.log('— P9 agent commission JE stays draft and is excluded —');
    const CM = require('../lib/commissions-multi');
    const agent = insert('persons', { name: 'بازاریاب آزاد FR', active: 1 });
    const cust = insert('customers', { user_id: ADMIN.id, name: 'مشتری FR', biz: 'مشتری FR', phone: '0915', city: 'مشهد', status: 'active' });
    const prod = insert('products', { user_id: ADMIN.id, name: 'کالای FR', code: 'FR-1', price: 100000, cost: 0, stock: 0 });
    const inv = insert('invoices', {
      user_id: ADMIN.id, cust_id: cust, num: 'FR-INV-1', type: 'final', date: '1405/07/05', approved: 1,
      rows: JSON.stringify([{ product_id: prod, qty: 10, price: 100000, disc: 0, disc_amt: 0, sum: 1000000 }]),
      subtotal: 1000000, disc: 0, disc_amt: 0, final: 1000000,
    });
    CM.createRule(db, { person_id: agent, role: 'seller', scope: 'invoice', pct: 4 }, ADMIN.id);
    CM.setInvoiceParties(db, inv, [{ person_id: agent, role: 'seller', share_pct: 100 }], ADMIN.id);
    const expCode = acct(db, 'coa_rep_commission_expense').code;
    const expBefore = recon.glBalance(db, [expCode]);
    const tbExp0 = ((await call('GET', '/api/accounting/trial-balance')).body.rows || []).find((r) => r.account_code === expCode);
    const t = CM.createTransfer(db, { person_id: agent, from: '1405/07/01', to: '1405/07/30' }, ADMIN.id);
    const cje = t && t.je_id ? q1('SELECT * FROM journal_entries WHERE id=?', t.je_id) : null;
    ok(t && t.target === 'voucher' && t.amount_rial === 40000, 'agent → voucher transfer 40,000', t);
    ok(cje && cje.status === 'draft', 'P9 agent commission JE remains draft', cje && cje.status);
    const tbExp1 = ((await call('GET', '/api/accounting/trial-balance')).body.rows || []).find((r) => r.account_code === expCode);
    ok(recon.glBalance(db, [expCode]) === expBefore, 'commission expense GL balance unchanged by draft');
    ok(JSON.stringify(tbExp0 || null) === JSON.stringify(tbExp1 || null), 'trial balance unchanged by commission draft', { tbExp0, tbExp1 });
    const crCodes = db.prepare('SELECT account_code FROM journal_lines WHERE entry_id=? AND credit_rial>0').all(t.je_id).map((r) => r.account_code);
    ok(crCodes.length > 0 && crCodes.every((c) => (require('../lib/party-books').glSignedForCoa(db, c) || 0) === 0),
      'commission payable/person leaf: party GL balance excludes draft', crCodes);
    // once approved, it counts (approved still counted)
    db.prepare("UPDATE journal_entries SET status='approved' WHERE id=?").run(t.je_id);
    ok(recon.glBalance(db, [expCode]) === expBefore + 40000, 'same JE counted after approval');
    db.prepare("UPDATE journal_entries SET status='draft' WHERE id=?").run(t.je_id);

    console.log('— reverse fix: reason + confirm contract —');
    const audits = () => q1("SELECT COUNT(*) c FROM audit_log WHERE action='recon_fix_reverse'").c;
    const url = `/api/accounting/subledger-recon/fixes/${fixId}/reverse`;
    const cases = [
      [{}, 'E_RECON_REVERSE_REASON_REQUIRED', 'empty body'],
      [{ confirm: true }, 'E_RECON_REVERSE_REASON_REQUIRED', 'confirm without reason'],
      [{ reason: '   ', confirm: true }, 'E_RECON_REVERSE_REASON_REQUIRED', 'whitespace reason'],
      [{ reason: 'abcd', confirm: true }, 'E_RECON_REVERSE_REASON_REQUIRED', 'reason < 5 chars'],
      [{ reason: 'علت معتبر ابطال' }, 'E_RECON_REVERSE_CONFIRM_REQUIRED', 'reason without confirm'],
      [{ reason: 'علت معتبر ابطال', confirm: false }, 'E_RECON_REVERSE_CONFIRM_REQUIRED', 'confirm=false'],
      [{ reason: 'علت معتبر ابطال', confirm: 'yes' }, 'E_RECON_REVERSE_CONFIRM_REQUIRED', 'confirm="yes"'],
    ];
    for (const [body, code, label] of cases) {
      const c0 = changes();
      const a0 = audits();
      const r = await call('POST', url, body);
      ok(r.status === 400 && r.body && r.body.code === code && /[\u0600-\u06FF]/.test(r.body.error || '') && changes() === c0 && audits() === a0,
        `400 ${code} (${label}), nothing written`, { status: r.status, body: r.body, d: changes() - c0 });
    }
    let threw = null;
    const c1 = changes();
    try { recon.reverseFix(db, fixId, { user: { id: ADMIN.id }, reason: 'علت معتبر ابطال' }); } catch (e) { threw = e; }
    ok(threw && threw.status === 400 && threw.code === 'E_RECON_REVERSE_CONFIRM_REQUIRED' && changes() === c1, 'lib reverseFix enforces confirm too (no writes)', threw && threw.code);
    ok(q1('SELECT status FROM subledger_recon_fixes WHERE id=?', fixId).status === 'posted'
      && q1('SELECT status FROM journal_entries WHERE id=?', fixJe).status === 'approved', 'fix + JE untouched after 400s');

    const jeCount0 = q1('SELECT COUNT(*) c FROM journal_entries').c;
    const ok200 = await call('POST', url, { reason: '  برگشت تست FR-RECON  ', confirm: true });
    ok(ok200.status === 200 && ok200.body.fix.status === 'reversed' && ok200.body.fix.reverse_reason === 'برگشت تست FR-RECON',
      'confirm + reason → 200, reason stored (trimmed) on fix', ok200.body);
    const aud = q1("SELECT detail FROM audit_log WHERE action='recon_fix_reverse' AND entity='subledger_recon_fix' AND entity_id=? ORDER BY id DESC", fixId);
    ok(aud && JSON.parse(aud.detail).reason === 'برگشت تست FR-RECON' && JSON.parse(aud.detail).je_id === fixJe, 'audit_log carries reason + je_id', aud);
    const jeAfter = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', fixJe);
    ok(jeAfter.status === 'reversed' && Number(jeAfter.deleted_at) > 0, 'fix JE soft-voided', jeAfter);
    ok(q1('SELECT COUNT(*) c FROM journal_entries').c === jeCount0, 'no physical delete (JE row count same)');
    ok(recon.glBalance(db, [invCode]) === glInv0, 'reversed fix JE excluded again (inventory GL back to baseline)');
    const again = await call('POST', url, { reason: 'برگشت دوباره', confirm: true });
    ok(again.status === 409 && again.body.code === 'E_RECON_FIX_REVERSED', 'double reverse → 409', again.body);
    const tbEnd = await call('GET', '/api/accounting/trial-balance');
    ok(((tbEnd.body.rows || []).find((r) => r.account_code === A) || {}).total_debit === EXPECT && tbEnd.body.balanced === true,
      'trial balance after all: still approved/posted only and balanced');
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { dbMods.closeDB(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
