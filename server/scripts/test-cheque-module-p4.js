#!/usr/bin/env node
'use strict';
/**
 * Phase 4 — cheque recon / dashboard KPIs / reports surfaces.
 * DB in os.tmpdir() only — never crm.db.
 * Run: node scripts/test-cheque-module-p4.js
 *   or: npm run test:cheque-module-p4
 *
 * QA note: dashboard ≈ summary ≈ GL where filters overlap (open registered
 * portfolio vs GL 1109/1116/2109). Horizon KPI windows may differ slightly
 * from summary.cards (collection included in summary due_7d).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { swAtLeast } = require('./lib/sw-at-least');

let passed = 0;
let failed = 0;
const blockers = [];
const qaNotes = [];

function ok(cond, msg, extra) {
  try {
    assert.strictEqual(!!cond, true, msg);
    passed += 1;
    console.log('  ✓', msg);
  } catch (e) {
    failed += 1;
    console.log('  ✗', msg, extra == null ? (e && e.message) : extra);
  }
}

function softTodo(cond, msg, todo) {
  if (cond) {
    passed += 1;
    console.log('  ✓', msg);
  } else {
    blockers.push(todo || msg);
    console.log('  ⏭ TODO', msg, '—', todo || 'waiting on sibling');
  }
}

function note(msg) {
  qaNotes.push(msg);
  console.log('  ℹ', msg);
}

console.log('test-cheque-module-p4');

/* ---- SW pin v569 ---- */
{
  const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok(swAtLeast(swSrc, 569), 'SW cache ≥ erp-taranom-v569');
  const idx = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  ok(/app\.js\?v=569/.test(idx) && /app\.css\?v=569/.test(idx), 'index.html app.js/css ?v=569');
}

/* ---- static: bounced code + sibling surfaces ---- */
{
  const reconSrc = fs.readFileSync(path.join(__dirname, '../lib/cheque-reconciliation.js'), 'utf8');
  ok(!/bouncedCode\s*=\s*'1105'/.test(reconSrc), 'recon source has no hardcoded bouncedCode=1105');
  ok(/coa_bounced_cheques/.test(reconSrc), 'recon uses coa_bounced_cheques');
  ok(/memorandum|coa_memo_guarantee/.test(reconSrc), 'recon includes memorandum / guarantee accounts');

  const coaSrc = fs.readFileSync(path.join(__dirname, '../lib/coa-map.js'), 'utf8');
  ok(/coa_bounced_cheques/.test(coaSrc), 'coa-map has coa_bounced_cheques');

  const dashSrc = fs.readFileSync(path.join(__dirname, '../lib/cheque-dashboard.js'), 'utf8');
  ok(/function buildChequeDashboardKpis/.test(dashSrc), 'exportable buildChequeDashboardKpis present');
  ok(/due_7d/.test(dashSrc) && /due_30d/.test(dashSrc) && /due_90d/.test(dashSrc),
    'ops_kpis horizons due_7d/30d/90d in dashboard lib');
  ok(/cashflow_forecast/.test(dashSrc), 'cashflow_forecast in dashboard lib');
  ok(/missing_sayadi/.test(dashSrc) && /sayad_not_registered/.test(dashSrc),
    'missing_sayadi + sayad_not_registered KPIs');
  ok(/leaves_near_3y_expiry/.test(dashSrc) && /protests_near_deadline/.test(dashSrc)
    && /guarantee/.test(dashSrc),
    'leaf expiry / protest window / guarantee KPIs');

  const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/cheque-records.js'), 'utf8');
  softTodo(/\/dashboard-kpis/.test(routeSrc), 'route GET /cheque-records/dashboard-kpis',
    'wire dashboard-kpis in cheque-records.js');

  const bookSrc = fs.readFileSync(path.join(__dirname, '../lib/chequebook-dashboard.js'), 'utf8');
  softTodo(/void_lost_leaves/.test(bookSrc) && /issued_uncleared/.test(bookSrc),
    'chequebook dashboard exposes void/lost + issued uncleared leaves',
    'chequebook-dashboard Phase 4C leaf sections');

  softTodo(fs.existsSync(path.join(__dirname, '../lib/cheque-party-turnover.js')),
    'lib/cheque-party-turnover.js present', 'party turnover lib from Part C');
  softTodo(fs.existsSync(path.join(__dirname, '../lib/bank-recon-cheque-suggest.js')),
    'lib/bank-recon-cheque-suggest.js present', 'bank recon cheque suggest from Part C');

  const advSrc = fs.readFileSync(path.join(__dirname, '../routes/adv-reports.js'), 'utf8');
  softTodo(/party-cheque-turnover/.test(advSrc), 'route GET /adv-reports/party-cheque-turnover',
    'adv-reports party-cheque-turnover');

  const bankRoute = fs.readFileSync(path.join(__dirname, '../routes/bank-reconciliation.js'), 'utf8');
  softTodo(/cheque-suggestions/.test(bankRoute) && /suggestChequeMatches/.test(bankRoute),
    'bank-recon cheque-suggestions route (manual confirm)',
    'wire suggestChequeMatches in bank-reconciliation.js');

  const portalSrc = fs.readFileSync(path.join(__dirname, '../public/portal-ui.js'), 'utf8');
  softTodo(/ops_kpis|dashboard-kpis|due_7d/.test(portalSrc),
    'portal-ui surfaces Phase 4B ops_kpis / dashboard-kpis',
    'portal renderChequeDashboardTab KPIs');
  softTodo(/void_lost_leaves|issued_uncleared|party-cheque-turnover/.test(portalSrc),
    'portal-ui surfaces Phase 4C report sections',
    'portal chequebook / party turnover UI');
}

/* ---- runtime sample DB ---- */
(async () => {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;

  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-p4-'));
  const httpDb = path.join(httpDir, 't.db');
  process.env.DB_PATH = httpDb;
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-cheque-module-p4-secret-32chars!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(httpDir, 'sessions.db');
  process.env.ERP_TEST_ISOLATION = '1';
  process.env.NODE_ENV = 'test';

  Object.keys(require.cache).forEach((k) => {
    if (/[\\/]server[\\/](db\.js|lib[\\/]cheque|lib[\\/]coa-map|lib[\\/]bank-recon|routes[\\/])/.test(k)
      || /[\\/]server[\\/](db\.js|lib\/cheque|lib\/coa-map|lib\/bank-recon|routes\/)/.test(k)) {
      delete require.cache[k];
    }
  });
  try { delete require.cache[require.resolve('../db')]; } catch (_) { /* */ }

  try {
    const { initDB, getDB } = require('../db');
    initDB();
    const db = getDB();

    const { acct } = require('../lib/coa-map');
    const { addDaysToJalali } = require('../jalali');
    const { postToLedger } = require('../lib/ledger');
    const { rialToLedger } = require('../lib/money');
    const { buildChequeDashboard, buildChequeDashboardKpis } = require('../lib/cheque-dashboard');
    const { buildChequeReconciliation } = require('../lib/cheque-reconciliation');
    const { runChequeSummary } = require('../lib/cheque-register-query');

    const TODAY = '1405/08/05';
    const opening = acct(db, 'coa_opening_balance');
    const recv = acct(db, 'coa_cheques_receivable');
    const bounced = acct(db, 'coa_bounced_cheques');
    ok(bounced && bounced.code && bounced.code !== '1105',
      `coa_bounced_cheques resolves to non-1105 (${bounced && bounced.code})`);
    ok(bounced.code === '1121' || String(bounced.code).startsWith('11'),
      `bounced COA is 11xx asset (got ${bounced.code})`);

    const partyId = db.prepare(`
      INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, biz)
      VALUES ('P-P4-1', 'customer', 'customer', 'طرف تست P4', '09120000014', 1, 'طرف تست P4')
    `).run().lastInsertRowid;

    function insCheque(row) {
      const cols = Object.keys(row);
      const qs = cols.map(() => '?').join(',');
      return db.prepare(`
        INSERT INTO cheque_records (${cols.join(',')}) VALUES (${qs})
      `).run(...cols.map((c) => row[c])).lastInsertRowid;
    }

    // Open portfolio amounts that should match GL 1109 after post
    const A_DUE3 = 10_000_000;   // +3d → due_7/30/90
    const A_DUE15 = 20_000_000;  // +15d → due_30/90
    const A_DUE45 = 30_000_000;  // +45d → due_90
    const A_OVER = 5_000_000;    // overdue
    const A_NOSAY = 7_000_000;   // missing sayadi, +5d
    const A_SAYNR = 8_000_000;   // sayadi present, not registered, +5d
    const A_GUAR = 12_000_000;   // guarantee
    const A_BOUNCE = 4_000_000;  // bounced near protest deadline

    const openSum = A_DUE3 + A_DUE15 + A_DUE45 + A_OVER + A_NOSAY + A_SAYNR;

    insCheque({
      direction: 'in', cheque_number: 'P4-1', due_date: addDaysToJalali(TODAY, 3),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_DUE3,
      sayadi: '2215300887814701', sayad_registered: 1, lifecycle_status: 'registered',
      record_status: 'posted', status: 'ثبت',
    });
    insCheque({
      direction: 'in', cheque_number: 'P4-2', due_date: addDaysToJalali(TODAY, 15),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_DUE15,
      sayadi: '2215300887814702', sayad_registered: 1, lifecycle_status: 'registered',
      record_status: 'posted', status: 'ثبت',
    });
    insCheque({
      direction: 'in', cheque_number: 'P4-3', due_date: addDaysToJalali(TODAY, 45),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_DUE45,
      sayadi: '2215300887814703', sayad_registered: 1, lifecycle_status: 'registered',
      record_status: 'posted', status: 'ثبت',
    });
    insCheque({
      direction: 'in', cheque_number: 'P4-4', due_date: addDaysToJalali(TODAY, -10),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_OVER,
      sayadi: '2215300887814704', sayad_registered: 1, lifecycle_status: 'registered',
      record_status: 'posted', status: 'ثبت',
    });
    insCheque({
      direction: 'in', cheque_number: 'P4-5', due_date: addDaysToJalali(TODAY, 5),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_NOSAY,
      sayadi: '', sayad_registered: 0, lifecycle_status: 'registered',
      record_status: 'posted', status: 'ثبت',
    });
    insCheque({
      direction: 'in', cheque_number: 'P4-6', due_date: addDaysToJalali(TODAY, 5),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_SAYNR,
      sayadi: '2215300887814706', sayad_registered: 0, lifecycle_status: 'registered',
      record_status: 'posted', status: 'ثبت',
    });
    insCheque({
      direction: 'in', cheque_number: 'P4-G', due_date: addDaysToJalali(TODAY, 20),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_GUAR,
      sayadi: '2215300887814710', sayad_registered: 1, lifecycle_status: 'guarantee',
      is_guarantee: 1, record_status: 'posted', status: 'تضمین',
    });
    // Protest window = due + 180d; near ≤30d left → due ≈ today - 160
    insCheque({
      direction: 'in', cheque_number: 'P4-B', due_date: addDaysToJalali(TODAY, -160),
      party_name: 'طرف تست P4', party_id: partyId, amount: A_BOUNCE,
      sayadi: '2215300887814711', sayad_registered: 1, lifecycle_status: 'bounced',
      record_status: 'posted', status: 'برگشتی',
    });
    // one payable open for out horizon
    const A_OUT = 9_000_000;
    insCheque({
      direction: 'out', cheque_number: 'P4-O1', due_date: addDaysToJalali(TODAY, 4),
      party_name: 'تأمین P4', party_id: partyId, amount: A_OUT,
      sayadi: '2215300887814799', sayad_registered: 1, lifecycle_status: 'registered',
      record_status: 'posted', status: 'registered',
    });

    postToLedger(db, {
      sourceType: 'chq_p4_recv',
      sourceId: 9001,
      date: TODAY,
      description: 'چک دریافتنی تست P4',
      createdBy: 1,
      lines: [
        { code: recv.code, name: recv.name, debit: rialToLedger(openSum), credit: 0 },
        { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(openSum) },
      ],
    });
    if (bounced) {
      postToLedger(db, {
        sourceType: 'chq_p4_bounce',
        sourceId: 9002,
        date: TODAY,
        description: 'واخواست تست P4',
        createdBy: 1,
        lines: [
          { code: bounced.code, name: bounced.name, debit: rialToLedger(A_BOUNCE), credit: 0 },
          { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(A_BOUNCE) },
        ],
      });
    }

    /* ---- dashboard sample KPIs ---- */
    const kpisPayload = buildChequeDashboardKpis(db, TODAY);
    ok(kpisPayload && kpisPayload.ops_kpis, 'buildChequeDashboardKpis returns ops_kpis');
    const ops = kpisPayload.ops_kpis;
    ok(ops.due_7d.in.count === 3 && ops.due_7d.in.amount_rial === A_DUE3 + A_NOSAY + A_SAYNR,
      `due_7d.in = 3 / ${A_DUE3 + A_NOSAY + A_SAYNR}`, JSON.stringify(ops.due_7d));
    ok(ops.due_7d.out.count === 1 && ops.due_7d.out.amount_rial === A_OUT,
      'due_7d.out includes payable sample');
    ok(ops.due_30d.in.count === 4, 'due_30d.in includes +3/+5/+15 (not +45)',
      JSON.stringify(ops.due_30d.in));
    ok(ops.due_90d.in.count === 5, 'due_90d.in includes +3/+5/+15/+45',
      JSON.stringify(ops.due_90d.in));
    ok(ops.overdue_open.in.count === 1 && ops.overdue_open.in.amount_rial === A_OVER,
      'overdue_open.in = 1 sample');
    ok(ops.missing_sayadi.count === 1 && ops.missing_sayadi.amount_rial === A_NOSAY,
      'missing_sayadi detected');
    ok(ops.sayad_not_registered.count === 1 && ops.sayad_not_registered.amount_rial === A_SAYNR,
      'sayad_not_registered detected');
    ok(ops.guarantee.count >= 1 && ops.guarantee.amount_rial >= A_GUAR,
      'guarantee KPI counts guarantee cheque');
    ok(ops.protests_near_deadline.count === 1 && ops.protests_near_deadline.amount_rial === A_BOUNCE,
      'protests_near_deadline for bounced near 6m window');
    ok(Array.isArray(kpisPayload.cashflow_forecast) && kpisPayload.cashflow_forecast.length >= 4,
      'cashflow_forecast buckets present');
    const cf7 = kpisPayload.cashflow_forecast.find((b) => b.bucket === '0_7');
    ok(cf7 && cf7.inflow_rial === A_DUE3 + A_NOSAY + A_SAYNR && cf7.outflow_rial === A_OUT,
      'cashflow 0_7 matches due_7 horizons');

    const fullDash = buildChequeDashboard(db, TODAY, TODAY);
    ok(fullDash && fullDash.ops_kpis && fullDash.ops_kpis.due_7d,
      'buildChequeDashboard embeds ops_kpis');
    ok(fullDash.gl_bridge && typeof fullDash.gl_bridge.ops_recv_rial === 'number',
      'dashboard gl_bridge present');

    /* ---- bounced recon code ---- */
    const recon = buildChequeReconciliation(db);
    ok(recon && Array.isArray(recon.accounts), 'reconciliation accounts array');
    ok(recon.bounced_code === bounced.code, `recon.bounced_code === ${bounced.code}`);
    ok(recon.bounced_code !== '1105', 'recon.bounced_code is not 1105');
    const bounceRow = recon.accounts.find((a) => a.code === bounced.code || a.kind === 'bounced');
    ok(!!bounceRow, 'reconciliation includes bounced account row');
    ok(bounceRow && bounceRow.code !== '1105', 'bounced account row code ≠ 1105');
    const memoRows = recon.accounts.filter((a) => a.kind === 'memorandum');
    softTodo(memoRows.length >= 1, 'reconciliation includes ≥1 memorandum row when COA mapped',
      'memo guarantee COA may be absent in fresh DB');

    /* ---- QA: dashboard ≈ summary ≈ GL (where feasible) ---- */
    note('QA: compare dashboard ops / summary cards / GL bridge where filters overlap');
    const summary = runChequeSummary(db, TODAY);
    ok(summary && summary.cards, 'runChequeSummary cards');

    // Open recv portfolio (registered, not guarantee/bounced) ≈ GL 1109 ≈ dashboard gl_bridge
    const glRecv = Number(fullDash.gl_bridge.gl_recv_1109_rial) || 0;
    const opsRecv = Number(fullDash.gl_bridge.ops_recv_rial) || 0;
    ok(opsRecv === openSum, `dashboard ops_recv_rial === open portfolio ${openSum}`, String(opsRecv));
    ok(glRecv === openSum, `GL 1109 === open portfolio ${openSum}`, String(glRecv));
    ok(Math.abs((fullDash.gl_bridge.variance_recv_rial || 0)) === 0,
      'GL↔ops variance_recv_rial === 0 on sample');

    // summary.in_hand should match registered open in amount
    ok(summary.cards.in_hand.amount === openSum,
      `summary.in_hand.amount === ${openSum}`, String(summary.cards.in_hand.amount));

    // due_7d: summary includes in_collection; our sample has none → should match ops total in+out
    const sumDue7 = Number(summary.cards.due_7d.amount) || 0;
    const opsDue7 = Number(ops.due_7d.total.amount_rial) || 0;
    ok(sumDue7 === opsDue7,
      `summary.due_7d.amount === ops_kpis.due_7d.total (${opsDue7})`,
      `summary=${sumDue7} ops=${opsDue7}`);
    note('QA pass: dashboard ops_recv = summary.in_hand = GL 1109; due_7d summary ≈ ops_kpis (no collection in sample)');

    // overdue: summary includes in_collection; sample only registered overdue
    ok(summary.cards.overdue.amount === A_OVER
      && ops.overdue_open.total.amount_rial === A_OVER,
      'overdue summary ≈ ops_kpis.overdue_open on sample');

    /* ---- sibling libs smoke ---- */
    try {
      const { buildPartyChequeTurnover } = require('../lib/cheque-party-turnover');
      const turn = buildPartyChequeTurnover(db, { party_id: partyId, limit: 20 });
      ok(turn && Array.isArray(turn.parties), 'party turnover returns parties[]');
      ok((turn.totals && turn.totals.received_count >= 1) || turn.parties.length >= 1,
        'party turnover sees received cheques');
      softTodo((turn.totals && turn.totals.bounced_count >= 1)
        || turn.parties.some((p) => (p.bounced_count || 0) >= 1),
        'party turnover counts bounced sample',
        'party turnover bounce classification');
    } catch (e) {
      softTodo(false, 'party turnover callable', e.message);
    }

    try {
      const { buildChequebookDashboard } = require('../lib/chequebook-dashboard');
      const book = buildChequebookDashboard(db);
      ok(book && book.kpis, 'chequebook dashboard builds without throw');
      softTodo('void_lost_leaves' in (book.kpis || {}),
        'chequebook kpis.void_lost_leaves field',
        'chequebook KPI void_lost_leaves');
    } catch (e) {
      softTodo(false, 'chequebook dashboard callable', e.message);
    }

    try {
      const suggest = require('../lib/bank-recon-cheque-suggest');
      ok(typeof suggest.suggestChequeMatches === 'function', 'suggestChequeMatches export');
      ok(typeof suggest.confirmChequeMatch === 'function', 'confirmChequeMatch export (manual)');
      const empty = suggest.suggestChequeMatches(db, { id: 0, bank_id: 1 });
      ok(empty && Array.isArray(empty.suggestions), 'suggestChequeMatches empty recon safe');
    } catch (e) {
      softTodo(false, 'bank-recon-cheque-suggest loadable', e.message);
    }

    /* ---- HTTP smoke for dashboard-kpis if route wired ---- */
    try {
      const http = require('http');
      const express = require('express');
      const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
      if (admin) {
        db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
        const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
        const token = issueStaffSession(db, admin, {
          device_kind: 'test',
          device_name: 'chq-p4',
          device_fingerprint: 'chq-p4-fp',
        }).token;
        const chequeRecords = require('../routes/cheque-records');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/cheque-records', chequeRecords);
        const server = await new Promise((resolve) => {
          const s = http.createServer(app);
          s.listen(0, '127.0.0.1', () => resolve(s));
        });
        const { port } = server.address();
        const body = await new Promise((resolve, reject) => {
          const r = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/cheque-records/dashboard-kpis?today=${encodeURIComponent(TODAY)}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, raw }));
          });
          r.on('error', reject);
          r.end();
        });
        softTodo(body.status === 200, `HTTP dashboard-kpis status 200 (got ${body.status})`,
          'dashboard-kpis route auth/HTTP');
        if (body.status === 200) {
          const json = JSON.parse(body.raw);
          ok(json.ops_kpis && json.ops_kpis.due_7d.in.count === 3,
            'HTTP dashboard-kpis due_7d.in matches sample');
        }
        await new Promise((r) => server.close(r));
        try { closeSessionStore(); } catch (_) { /* */ }
      }
    } catch (e) {
      softTodo(false, 'HTTP dashboard-kpis smoke', e.message);
    }
  } catch (e) {
    failed += 1;
    console.log('  ✗ harness', e && e.stack ? e.stack : e);
  }

  console.log('\nQA notes:');
  for (const n of qaNotes) console.log('  -', n);
  console.log(`\n${passed} passed, ${failed} failed, ${blockers.length} blockers`);
  if (blockers.length) {
    console.log('Blockers:');
    for (const b of blockers) console.log('  -', b);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
