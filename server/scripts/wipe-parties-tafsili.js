#!/usr/bin/env node
/**
 * Wipe all parties (soft+cascade) and release orphan entity tafsil / detail_accounts.
 * Leaves products/banks/cash masters; frees person_code/phone for Excel re-import.
 *
 *   node server/scripts/wipe-parties-tafsili.js --confirm=WIPE-PARTIES-TAFSILI
 *   DB_PATH=... node server/scripts/wipe-parties-tafsili.js --confirm=WIPE-PARTIES-TAFSILI
 */
const fs = require('fs');
const path = require('path');

const CONFIRM = 'WIPE-PARTIES-TAFSILI';
const arg = process.argv.find((a) => a.startsWith('--confirm='));
const confirm = arg ? arg.slice('--confirm='.length) : '';
if (confirm !== CONFIRM) {
  console.error(`Refuse: pass --confirm=${CONFIRM}`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

const bak = dbPath + '.pre-wipe-parties-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
fs.copyFileSync(dbPath, bak);
console.log('Backup:', bak);

process.env.DB_PATH = dbPath;
const { initDB, getDB } = require('../db');
const { deactivatePartyCascade } = require('../lib/parties-sync');
const { releaseTafsili } = require('../lib/coa-map');

initDB();
const db = getDB();

const parties = db.prepare('SELECT id FROM parties').all();
let cascaded = 0;
db.transaction(() => {
  for (const p of parties) {
    try {
      deactivatePartyCascade(db, p.id, { userId: 1 });
      cascaded++;
    } catch (e) {
      console.warn('party', p.id, e.message);
    }
  }

  // Free UNIQUE person_code / phone on inactive rows so Excel re-import works
  const inactive = db.prepare('SELECT id, person_code, phone FROM parties WHERE is_active=0').all();
  for (const p of inactive) {
    db.prepare('UPDATE parties SET person_code=?, phone=?, coa_code=NULL WHERE id=?')
      .run(`DEL-${p.id}-${p.person_code || 'x'}`.slice(0, 80), `del-${p.id}`, p.id);
  }

  // Clear party-linked coa on customers/suppliers/persons leftover
  for (const tbl of ['customers', 'suppliers', 'persons']) {
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl)) continue;
      db.prepare(`UPDATE ${tbl} SET coa_code=NULL WHERE coa_code IS NOT NULL`).run();
    } catch (_) { /* ignore */ }
  }

  // Release orphan tafsil (detail) with no JE and no entity link
  const candidates = db.prepare(`
    SELECT code FROM chart_of_accounts
    WHERE COALESCE(tafsili_type,'') <> ''
       OR level=4
       OR length(code)>=12
       OR code LIKE '%-%'
  `).all();
  let released = 0, blocked = 0;
  for (const c of candidates) {
    const r = releaseTafsili(db, c.code);
    if (r.ok) released++;
    else blocked++;
  }

  // Wipe floating detail_accounts registry (re-import via Excel later)
  let detailN = 0;
  try {
    detailN = db.prepare('DELETE FROM detail_accounts').run().changes;
  } catch (_) { /* table may not exist */ }

  console.log(JSON.stringify({
    parties_processed: cascaded,
    inactive_renamed: inactive.length,
    tafsil_released: released,
    tafsil_blocked: blocked,
    detail_accounts_deleted: detailN,
  }, null, 2));
})();

db.close();
console.log('✅ wipe-parties-tafsili done');
