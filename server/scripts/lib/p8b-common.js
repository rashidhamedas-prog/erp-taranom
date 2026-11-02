'use strict';
/**
 * P8b — مشترکات اسکریپت‌های اصلاح دفتر کل (dry-run پیش‌فرض).
 *
 * dry-run: منبع فقط با {readonly:true} باز می‌شود، از آن backup گرفته می‌شود و
 * منطق apply روی کپی موقت داخل یک تراکنش اجرا و rollback می‌شود؛ کپی پاک می‌شود.
 * apply/reverse: فقط با --i-have-approval و --reason=… ؛ یک db.transaction اتمیک.
 *
 * P8_SERVER_DIR: ریشهٔ server برای require کد برنامه (روی سرور: /home/taranom/crm-taranom/server).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_DIR = process.env.P8_SERVER_DIR || path.join(__dirname, '..', '..');
const REPO_REPORTS = path.join(__dirname, '..', '..', '..', 'reports', 'prodcycle-p8');

const CSV_COLUMNS = [
  'item', 'target_table', 'target_id', 'action', 'account_code', 'detail_account_id',
  'cost_center_id', 'debit_rial', 'credit_rial', 'person_id', 'note',
];

const JE_ALIVE = "COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void','draft')";

function srv(rel) {
  return require(path.join(SERVER_DIR, rel));
}

function sqlite() {
  try { return require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3')); }
  catch (_) { return require('better-sqlite3'); }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { out._.push(a); continue; }
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function modeOf(args) {
  if (args.apply && args.reverse) throw stop('--apply و --reverse هم‌زمان مجاز نیست');
  const mode = args.apply ? 'apply' : (args.reverse ? 'reverse' : 'dry-run');
  if (mode !== 'dry-run') {
    if (!args['i-have-approval']) throw stop(`${mode} بدون --i-have-approval مجاز نیست`);
    const reason = String(args.reason || '').trim();
    if (reason.length < 5) throw stop(`${mode} بدون --reason=… (حداقل ۵ نویسه) مجاز نیست`);
  }
  return mode;
}

function stop(msg, code = 'P8B_STOP') {
  const e = new Error(msg);
  e.code = code;
  return e;
}

class DryRollback extends Error {
  constructor() { super('dry-run rollback'); this.code = 'DRY_ROLLBACK'; }
}

/** body(db) داخل یک تراکنش؛ در dry-run نتیجه برمی‌گردد ولی rollback می‌شود. */
function runTxn(db, mode, body) {
  let out;
  const txn = db.transaction(() => {
    out = body();
    if (mode === 'dry-run') throw new DryRollback();
  });
  try { txn.immediate(); }
  catch (e) {
    if (e && e.code === 'DRY_ROLLBACK') return out;
    throw e;
  }
  return out;
}

function unlinkDb(p) {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + s); } catch (_) { /* absent */ }
  }
}

/**
 * dry-run → کپی موقت از هندل readonly؛ apply/reverse → خود فایل.
 * fn(db, ctx) باید runTxn را خودش صدا بزند.
 */
async function withWorkingDb(args, mode, fn) {
  const Database = sqlite();
  const src = args.db;
  if (!src || !fs.existsSync(src)) throw stop(`--db=<مسیر> لازم است (یافت نشد: ${src || '-'})`);
  let workPath = path.resolve(src);
  let tmpDir = null;
  if (mode === 'dry-run') {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8b-dry-'));
    workPath = path.join(tmpDir, 'work.db');
    const ro = new Database(src, { readonly: true, fileMustExist: true });
    try { await ro.backup(workPath); } finally { ro.close(); }
  }
  process.env.DB_PATH = workPath;
  process.env.ERP_TEST_ISOLATION = '1';
  const db = new Database(workPath, { timeout: 8000 });
  db.pragma('foreign_keys = ON');
  try {
    return await fn(db, { mode, workPath, sourcePath: path.resolve(src) });
  } finally {
    try { db.close(); } catch (_) { /* closed */ }
    try { srv('db').closeDB(); } catch (_) { /* never opened */ }
    if (tmpDir) {
      unlinkDb(workPath);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* gone */ }
    }
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
  fs.writeFileSync(file, '\uFEFF' + lines.join('\n') + '\n', 'utf8');
  return file;
}

function outDir(args) {
  return args.out ? path.resolve(String(args.out)) : REPO_REPORTS;
}

function glBalance(db, code) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(jl.debit_rial),0) d, COALESCE(SUM(jl.credit_rial),0) c
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND ${JE_ALIVE}
  `).get(String(code));
  const d = Math.round(Number(r.d) || 0);
  const c = Math.round(Number(r.c) || 0);
  return { debit_rial: d, credit_rial: c, net_rial: d - c };
}

function liveJe(db, id) {
  if (!id) return null;
  return db.prepare(`SELECT je.* FROM journal_entries je WHERE je.id=? AND ${JE_ALIVE}`).get(Number(id)) || null;
}

function jeLines(db, id) {
  return db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY line_no, id').all(Number(id));
}

/**
 * reverseJournalEntry → purgeReverseVouchersForOriginal ردیف‌های «*_reversal» هم‌شناسه را
 * فیزیکی حذف می‌کند. حذف فیزیکی ممنوع است، پس اگر چنین سندی هست متوقف می‌شویم.
 */
function assertNoPurgeCollateral(db, jeId) {
  const head = db.prepare('SELECT id, ref_type, ref_id FROM journal_entries WHERE id=?').get(Number(jeId));
  if (!head) throw stop(`سند #${jeId} یافت نشد`);
  const hits = db.prepare(`
    SELECT id FROM journal_entries
    WHERE id<>?
      AND (
        description LIKE ?
        OR (ref_type LIKE '%\\_reversal' ESCAPE '\\' AND ref_id=? AND ref_type NOT LIKE 'payroll_payment%')
        OR (ref_type=? AND ref_id=?)
      )
  `).all(
    head.id, `ابطال سند #${head.id}%`, head.ref_id ?? null,
    head.ref_type ? `${head.ref_type}_reversal` : '__none__', head.ref_id ?? null,
  );
  if (hits.length) {
    throw stop(`STOP: ابطال سند #${jeId} اسناد ${hits.map((h) => h.id).join(',')} را فیزیکی حذف می‌کند`);
  }
}

function insertAudit(db, { userId = null, action, entity, entityId = null, detail }) {
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
    VALUES (?,?,?,?,?)
  `).run(userId, action, entity, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

function lastAudit(db, entity, action) {
  return db.prepare(`
    SELECT * FROM audit_log WHERE entity=? AND action=? ORDER BY id DESC LIMIT 1
  `).get(entity, action) || null;
}

function todayJalali() {
  try { return srv('jalali').todayJalali(); } catch (_) { /* fallback */ }
  return new Intl.DateTimeFormat('en-CA-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/-/g, '/');
}

function userIdArg(args) {
  const n = parseInt(args.user, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

async function cli(main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`❌ ${e.code || 'ERROR'}: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  SERVER_DIR, REPO_REPORTS, CSV_COLUMNS, JE_ALIVE,
  srv, sqlite, parseArgs, modeOf, stop, runTxn, withWorkingDb, writeCsv, outDir,
  glBalance, liveJe, jeLines, assertNoPurgeCollateral, insertAudit, lastAudit,
  todayJalali, userIdArg, fmt, cli, DryRollback,
};
