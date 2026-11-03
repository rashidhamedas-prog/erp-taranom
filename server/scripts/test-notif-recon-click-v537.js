#!/usr/bin/env node
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v537: nightly recon notification must open acc-subledger-recon from notifClick;
 * notification payload still uses kind=subledger_recon_nightly / entity_type=subledger_recon_run.
 * Static asserts always run; DB asserts skip if better-sqlite3 cannot bind (e.g. Node 24 on Windows).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0, skip = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  OK  ', m); }
  else { fail++; console.log('  FAIL', m, extra != null ? JSON.stringify(extra) : ''); }
}
function skipped(m) { skip++; console.log('  SKIP', m); }

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swJs = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

console.log('\n[1] notifClick routes nightly recon to report page');
{
  const fn = appJs.match(/async function notifClick\([\s\S]*?\n\}/);
  ok(!!fn, 'notifClick found');
  const body = fn ? fn[0] : '';
  ok(/kind==='subledger_recon_nightly'/.test(body), 'handles kind subledger_recon_nightly');
  ok(/entityType==='subledger_recon_run'/.test(body), 'handles entity_type subledger_recon_run');
  ok(/go\(['"]acc-subledger-recon['"]\)/.test(body), 'navigates to acc-subledger-recon');
  ok(/enterAccountingShell/.test(body), 'enters accounting shell first');
}

console.log('\n[2] Help + SW stamp v537');
{
  ok(swAtLeast(swJs, 537), 'sw cache v537');
  ok(/app\.js\?v=537/.test(indexHtml), 'index app.js?v=537');
  ok(/با زدن همان اعلان/.test(appJs), 'Help mentions bell click opens recon');
}

console.log('\n[3] nightly run stamps notification kind/entity');
{
  let dbOk = false;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v537-notif-'));
    const dbPath = path.join(tmp, 't.db');
    process.env.DB_PATH = dbPath;
    process.env.SYNC_ROLE = 'central';
    process.env.JWT_SECRET = 'x'.repeat(48);
    process.env.NODE_ENV = 'test';
    const { initDB, getDB } = require('../db');
    initDB();
    const db = getDB();
    const recon = require('../lib/subledger-recon');
    db.prepare("INSERT OR IGNORE INTO users (id,name,username,password,role,active) VALUES (1,'Admin','admin','x','admin',1)").run();
    const r = recon.runNightlyRecon(db, { date: '1405/08/02' });
    ok(!!r && (r.run_id || r.summary), 'runNightlyRecon returns summary');
    const n = db.prepare("SELECT * FROM app_notifications WHERE kind='subledger_recon_nightly' ORDER BY id DESC LIMIT 1").get();
    ok(!!n, 'notification created');
    ok(n && n.entity_type === 'subledger_recon_run', 'entity_type=subledger_recon_run', n && n.entity_type);
    ok(n && /تطبیق شبانه/.test(n.title || ''), 'title has تطبیق شبانه');
    dbOk = true;
  } catch (e) {
    if (/bindings|better.sqlite|NODE_MODULE_VERSION/i.test(String(e.message || e))) {
      skipped('sqlite unavailable locally — run on Iran: ' + (e.message || e).slice(0, 80));
    } else {
      ok(false, 'DB section error', e.message || String(e));
    }
  }
  if (!dbOk && skip) { /* already logged */ }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
