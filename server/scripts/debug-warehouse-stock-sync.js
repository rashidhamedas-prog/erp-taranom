/**
 * Runtime proof: warehouse_stock tombstone apply (pre/post fix).
 * Writes NDJSON to workspace debug-2fcabd.log + ingest endpoint.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { SYNCABLE_TABLES } = require('../sync/tables');

const LOG_PATH = path.join(__dirname, '..', '..', '..', 'debug-2fcabd.log');
const INGEST = 'http://127.0.0.1:7550/ingest/7c3b024e-51f2-48e0-b234-568dde667709';
const SESSION = '2fcabd';
const runId = process.env.DEBUG_RUN_ID || 'pre-fix';

function agentLog(hypothesisId, location, message, data) {
  const payload = {
    sessionId: SESSION,
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(payload) + '\n');
  } catch (_) { /* ignore */ }
  fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function applyDeleteBroken(db, del) {
  const spec = SYNCABLE_TABLES.find((t) => t.name === 'warehouse_stock');
  // Mirror OLD client.js: DELETE WHERE upsertKey=?
  try {
    const info = db.prepare(`DELETE FROM warehouse_stock WHERE ${spec.upsertKey}=?`).run(del);
    return { upsertKey: spec.upsertKey, changes: info.changes, compositeKeys: spec.compositeKeys || null, threw: false };
  } catch (e) {
    return {
      upsertKey: spec.upsertKey,
      changes: 0,
      compositeKeys: spec.compositeKeys || null,
      threw: true,
      error: e.message,
    };
  }
}

function applyDeleteFixed(db, del) {
  const spec = SYNCABLE_TABLES.find((t) => t.name === 'warehouse_stock');
  if (spec.compositeKeys && spec.compositeKeys.length) {
    const parts = String(del).split(':');
    const wh = spec.compositeKeys.map((c) => `${c}=?`).join(' AND ');
    const vals = parts.map((p) => {
      const n = Number(p);
      return Number.isFinite(n) ? n : p;
    });
    const info = db.prepare(`DELETE FROM warehouse_stock WHERE ${wh}`).run(...vals);
    return { upsertKey: spec.upsertKey, changes: info.changes, compositeKeys: spec.compositeKeys, parts: vals };
  }
  return applyDeleteBroken(db, del);
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE warehouse_stock (
    product_id INTEGER NOT NULL,
    warehouse_id INTEGER NOT NULL,
    qty INTEGER DEFAULT 0,
    PRIMARY KEY (product_id, warehouse_id)
  );
`);
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (12, 3, 50)').run();
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (12, 4, 10)').run();

const before = db.prepare('SELECT COUNT(*) c FROM warehouse_stock').get().c;
const tombstone = '12:3';
const spec = SYNCABLE_TABLES.find((t) => t.name === 'warehouse_stock');

agentLog('A', 'debug-warehouse-stock-sync.js:spec', 'warehouse_stock registry', {
  upsertKey: spec.upsertKey,
  compositeKeys: spec.compositeKeys || null,
  beforeCount: before,
  tombstone,
});

const broken = applyDeleteBroken(db, tombstone);
const afterBroken = db.prepare('SELECT COUNT(*) c FROM warehouse_stock').get().c;
const stillHasTarget = !!db.prepare('SELECT 1 FROM warehouse_stock WHERE product_id=12 AND warehouse_id=3').get();

agentLog('A', 'debug-warehouse-stock-sync.js:broken', 'delete with upsertKey column', {
  ...broken,
  afterCount: afterBroken,
  targetStillPresent: stillHasTarget,
  bugConfirmed: broken.changes === 0 && stillHasTarget,
});

const fixed = applyDeleteFixed(db, tombstone);
const afterFixed = db.prepare('SELECT COUNT(*) c FROM warehouse_stock').get().c;
const targetGone = !db.prepare('SELECT 1 FROM warehouse_stock WHERE product_id=12 AND warehouse_id=3').get();
const otherRemains = !!db.prepare('SELECT 1 FROM warehouse_stock WHERE product_id=12 AND warehouse_id=4').get();

agentLog('B', 'debug-warehouse-stock-sync.js:fixed', 'delete with compositeKeys', {
  ...fixed,
  afterCount: afterFixed,
  targetGone,
  otherRemains,
  fixWorks: fixed.changes === 1 && targetGone && otherRemains,
});

console.log(JSON.stringify({
  runId,
  upsertKey: spec.upsertKey,
  compositeKeys: spec.compositeKeys || null,
  broken,
  afterBroken,
  stillHasTarget,
  fixed,
  afterFixed,
  targetGone,
  otherRemains,
}, null, 2));

db.close();
