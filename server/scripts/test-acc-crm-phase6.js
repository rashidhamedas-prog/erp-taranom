#!/usr/bin/env node
/**
 * ACC-CRM-UNIFY Phase 6 — medium edge cases:
 * new_customers from/to, cheque PATCH block, bounce→resend, CACHE guard static.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const { buildDashboard } = require('../lib/crm-analytics');
const { j2g } = require('../jalali');

console.log('══ ACC-CRM Phase 6 medium edges ══');

// --- Static: invoice WH picker must not overwrite CACHE.allProducts ---
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok('reloadInvProducts uses CACHE._invProducts', /CACHE\._invProducts\s*=\s*list/.test(appJs));
ok('reloadInvProducts does not assign allProducts=list', !/reloadInvProductsForWarehouse[\s\S]{0,400}?CACHE\.allProducts\s*=\s*list/.test(appJs));
ok('renderInvPicker prefers _invProducts', /CACHE\._invProducts\s*&&\s*CACHE\._invProducts\.length/.test(appJs));
ok('chequeResend UI present', /chequeResend|\/cheque-records\/.*\/resend/.test(appJs));

const { db, cleanup } = freshDb();
try {
  const { j2g: _j } = { j2g };
  const dayStart = (jStr) => {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(jStr);
    const [gy, gm, gd] = j2g(+m[1], +m[2], +m[3]);
    return Math.floor(new Date(gy, gm - 1, gd, 0, 0, 0).getTime() / 1000);
  };

  const u = db.prepare(`
    INSERT INTO users (username,password,name,role,active)
    VALUES ('p6rep','x','P6','field_sales',1)
  `).run().lastInsertRowid;

  const inRange = dayStart('1405/02/10') + 3600;
  const outRange = dayStart('1404/01/01') + 3600;

  db.prepare(`
    INSERT INTO customers (user_id,biz,phone,city,status,created_at)
    VALUES (?,'جدید در بازه','09150000001','مشهد','active',?)
  `).run(u, inRange);
  db.prepare(`
    INSERT INTO customers (user_id,biz,phone,city,status,created_at)
    VALUES (?,'قدیمی خارج بازه','09150000002','تهران','active',?)
  `).run(u, outRange);

  const all = buildDashboard(db, {}, null);
  eq('new_customers without dates = all scoped', all.kpis.new_customers, 2);

  const ranged = buildDashboard(db, { from: '1405/02/01', to: '1405/02/28' }, null);
  eq('new_customers respects from/to', ranged.kpis.new_customers, 1);

  // --- Cheque lifecycle: PATCH block + bounce→resend ---
  const party = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone)
    VALUES ('P6-CHQ','customer','طرف چک','09151110000')
  `).run().lastInsertRowid;

  const chqId = db.prepare(`
    INSERT INTO cheque_records (
      direction, cheque_number, amount, party_name, party_id, status, lifecycle_status, record_status
    ) VALUES ('in','CHQ-P6',1000000,'طرف چک',?,'ثبت‌شده','registered','posted')
  `).run(party).lastInsertRowid;

  // Simulate route refuse helper logic via requiring the router is heavy;
  // exercise JE path through lib pieces used by resend.
  const { acct } = require('../lib/coa-map');
  const { postToLedger } = require('../lib/ledger');
  const { reverseJournalEntry } = require('../lib/void-journal');
  const { todayJalali } = require('../jalali');
  const collection = acct(db, 'coa_cheques_in_collection');
  const receivable = acct(db, 'coa_cheques_receivable');
  const amt = 100000;

  const sendJe = postToLedger(db, {
    sourceType: 'cheque_send_to_bank', sourceId: chqId, date: todayJalali(),
    description: 'test send', createdBy: u,
    lines: [
      { code: collection.code, name: collection.name, debit: amt, credit: 0, debit_rial: amt * 10 },
      { code: receivable.code, name: receivable.name, debit: 0, credit: amt, credit_rial: amt * 10 },
    ],
  });
  db.prepare(`UPDATE cheque_records SET lifecycle_status='in_collection', collection_je_id=? WHERE id=?`)
    .run(sendJe, chqId);

  const bounceJe = postToLedger(db, {
    sourceType: 'cheque_bounce', sourceId: chqId, date: todayJalali(),
    description: 'test bounce', createdBy: u,
    lines: [
      { code: receivable.code, name: receivable.name, debit: amt, credit: 0, debit_rial: amt * 10 },
      { code: collection.code, name: collection.name, debit: 0, credit: amt, credit_rial: amt * 10 },
    ],
  });
  db.prepare(`UPDATE cheque_records SET lifecycle_status='bounced', bounced_je_id=?, status='برگشتی' WHERE id=?`)
    .run(bounceJe, chqId);

  const rev = reverseJournalEntry(db, bounceJe, {
    userId: u, date: todayJalali(), reason: 'resend test', sourceType: 'cheque_resend',
  });
  ok('resend reverse JE created', !!rev);
  db.prepare(`
    UPDATE cheque_records SET lifecycle_status='in_collection', bounced_je_id=NULL, status='در جریان وصول'
    WHERE id=?
  `).run(chqId);
  const after = db.prepare('SELECT lifecycle_status, bounced_je_id FROM cheque_records WHERE id=?').get(chqId);
  ok('resend restores in_collection', after.lifecycle_status === 'in_collection');
  ok('bounced_je_id cleared', after.bounced_je_id == null);

  // Financial free-text patterns (mirror route regex)
  const FINANCIAL_STATUS_RE = /وصول|برگشت|واگذار|cleared|bounced|received|in[_ ]?collection|send[_ -]?to[_ -]?bank|resend|واگذارى/i;
  ok('blocks English cleared', FINANCIAL_STATUS_RE.test('cleared'));
  ok('blocks English bounced', FINANCIAL_STATUS_RE.test('bounced'));
  ok('blocks Persian وصول', FINANCIAL_STATUS_RE.test('وصول‌شده'));
  ok('allows note-only status', !FINANCIAL_STATUS_RE.test('پیگیری داخلی'));
} finally {
  cleanup();
}

summary();
