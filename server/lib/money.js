// Monetary helpers — DB+UI store INTEGER Rials (currency_base=rial).
// Only postToLedger still expects Toman input (internally ×10 → debit_rial).

const RIAL_PER_TOMAN = 10;

function tomanToRial(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * RIAL_PER_TOMAN);
}

function rialToToman(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n / RIAL_PER_TOMAN;
}

/** Convert rial amount to postToLedger toman input. */
function rialToLedger(v) {
  return (Number(v) || 0) / RIAL_PER_TOMAN;
}

/** Read journal line amount in rial (prefer debit_rial; fallback debit after migration). */
function jlDebitRial(l) {
  const r = Number(l?.debit_rial);
  if (r) return Math.round(r);
  return Math.round(Number(l?.debit) || 0);
}

function jlCreditRial(l) {
  const r = Number(l?.credit_rial);
  if (r) return Math.round(r);
  return Math.round(Number(l?.credit) || 0);
}

/** SQL expr: journal line debit/credit in rial */
const SQL_JL_DEBIT_RIAL = 'COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)';
const SQL_JL_CREDIT_RIAL = 'COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)';

/** Attach display_toman alongside rial integer fields on a row object. */
function withTomanDisplay(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (out[f] != null) out[f + '_toman'] = rialToToman(out[f]);
  }
  return out;
}

/** One-time migration: REAL toman column → INTEGER rial column. */
function migrateRealToRial(db, table, realCol, rialCol) {
  const hasRial = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === rialCol);
  if (!hasRial) return false;
  const flag = `money_migrated_${table}_${rialCol}`;
  if (db.prepare("SELECT value FROM settings WHERE key=?").get(flag)?.value === '1') return false;
  const rows = db.prepare(`SELECT rowid AS _rid, ${realCol} AS v FROM ${table} WHERE ${realCol} IS NOT NULL AND ${realCol} != 0`).all();
  const upd = db.prepare(`UPDATE ${table} SET ${rialCol}=? WHERE rowid=?`);
  db.transaction(() => {
    for (const r of rows) upd.run(tomanToRial(r.v), r._rid);
  })();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(flag, '1');
  return true;
}

module.exports = {
  RIAL_PER_TOMAN, tomanToRial, rialToToman, rialToLedger,
  jlDebitRial, jlCreditRial, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL,
  withTomanDisplay, migrateRealToRial,
};
