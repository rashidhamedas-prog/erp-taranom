#!/usr/bin/env node
'use strict';
/**
 * Probe (فقط‌خواندنی) — نقش دستمزد تولید یک شخص طبق resolver P5
 * (lib/payroll/person-account.js → resolveLaborPayableForPerson) روی دادهٔ واقعی.
 *
 *  1) DB اصلی readonly باز می‌شود؛ resolver با allocate:false روی همان اتصال readonly اجرا می‌شود
 *     (هر نوشتنی خطای SQLITE_READONLY می‌دهد).
 *  2) یک کپی سازگار (db.backup) در --copy-dir ساخته می‌شود؛ resolver با allocate:true داخل
 *     BEGIN … ROLLBACK روی کپی اجرا می‌شود تا حساب تفصیلی‌ای که پیمانکار «می‌گرفت» دیده شود؛ کپی حذف می‌شود.
 *  3) اگر نقش پیمانکار (بدون پرچم) نباشد، تغییر حداقلی داده پیشنهاد می‌شود:
 *     UPDATE persons SET employment_type='contractor' WHERE id=?   (برچسب UI: پیمانکاری)
 *     فقط با --db صریح + --apply --i-have-approval، در یک تراکنش + audit_log.
 *
 * Usage: node person-labor-role-probe.js [--db PATH] [--person 132] [--root SERVER_DIR]
 *        [--module better-sqlite3 path] [--copy-dir /tmp]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROD_ROOT = '/home/taranom/crm-taranom/server';

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out.flags.add(a.slice(2));
  }
  return out;
}

function loadSqlite(modulePath, root) {
  const candidates = [modulePath, path.join(root, 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'), 'better-sqlite3'].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch (_) { /* next */ } }
  throw new Error('better-sqlite3 not found');
}

function rmDb(p) {
  for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(p + s, { force: true }); } catch (_) { /* ignore */ } }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.flags.has('apply');
  if (apply && (!args.flags.has('i-have-approval') || !args.db)) {
    console.error('--apply requires --i-have-approval and an explicit --db. Aborting.');
    process.exit(2);
  }
  const root = path.resolve(args.root || (fs.existsSync(PROD_ROOT) ? PROD_ROOT : path.join(__dirname, '..')));
  const dbPath = args.db || path.join(PROD_ROOT, 'crm.db');
  const personId = Number(args.person || 132);
  const Database = loadSqlite(args.module, root);

  const copyDir = args['copy-dir'] || os.tmpdir();
  const copyPath = path.join(copyDir, `probe-person-${personId}-${process.pid}.db`);
  // هر getDB() تنبلِ داخل ماژول‌ها فقط به کپی برسد، نه DB اصلی.
  process.env.DB_PATH = copyPath;
  process.env.SYNC_ROLE = process.env.SYNC_ROLE || 'central';

  const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
  const person = ro.prepare('SELECT * FROM persons WHERE id=?').get(personId);
  if (!person) { console.error(`person ${personId} not found`); process.exit(3); }
  const count = (sql, ...p) => { try { return Number(ro.prepare(sql).get(...p)?.c) || 0; } catch (_) { return null; } };
  const evidence = {
    employment_type: person.employment_type ?? null,
    monthly_salary_rial: person.monthly_salary_rial ?? null,
    coa_code: person.coa_code ?? null,
    labor_payable_coa_code: person.labor_payable_coa_code ?? null,
    party_id: person.party_id ?? null,
    detail_account_id: person.detail_account_id ?? null,
    payroll_records: count('SELECT COUNT(*) c FROM payroll_records WHERE person_id=?', personId),
    salary_structures: count('SELECT COUNT(*) c FROM salary_structures WHERE person_id=?', personId),
    production_labor_entries: count('SELECT COUNT(*) c FROM production_labor_entries WHERE person_id=?', personId),
    party_coa_code: person.party_id ? (ro.prepare('SELECT coa_code FROM parties WHERE id=?').get(person.party_id)?.coa_code ?? null) : null,
    supplier: person.party_id ? (ro.prepare('SELECT id, coa_code FROM suppliers WHERE party_id=? ORDER BY id LIMIT 1').get(person.party_id) || null) : null,
  };

  const pa = require(path.join(root, 'lib', 'payroll', 'person-account.js'));
  const out = { person_id: personId, name: person.name, evidence };
  try {
    out.classify = pa.classifyLaborPersonRole(ro, person);
    out.readonly_allocate_false = pa.resolveLaborPayableForPerson(ro, person, { allocate: false });
  } catch (e) { out.readonly_error = { code: e.code, message: e.message, extra: e.extra }; }

  try {
    await ro.backup(copyPath);
    const cp = new Database(copyPath);
    cp.exec('BEGIN');
    try {
      const p2 = cp.prepare('SELECT * FROM persons WHERE id=?').get(personId);
      out.copy_allocate_true = pa.resolveLaborPayableForPerson(cp, p2, { allocate: true });
      if (out.copy_allocate_true && out.copy_allocate_true.account_code) {
        const acc = cp.prepare('SELECT code, name, type, parent_code FROM chart_of_accounts WHERE code=?').get(out.copy_allocate_true.account_code);
        out.copy_allocate_true.account = acc || null;
      }
      // تغییر حداقلی پیشنهادی را هم روی کپی امتحان کن (و برگردان)
      if (!(out.classify && out.classify.role === 'contractor' && !out.classify.flagged)) {
        cp.prepare("UPDATE persons SET employment_type='contractor' WHERE id=?").run(personId);
        const p3 = cp.prepare('SELECT * FROM persons WHERE id=?').get(personId);
        out.after_proposed_change = pa.resolveLaborPayableForPerson(cp, p3, { allocate: true });
      }
    } catch (e) {
      out.copy_error = { code: e.code, message: e.message, extra: e.extra };
    } finally {
      cp.exec('ROLLBACK');
      cp.close();
    }
  } finally {
    rmDb(copyPath);
  }
  out.copy_deleted = !fs.existsSync(copyPath);

  const isContractor = out.classify && out.classify.role === 'contractor' && !out.classify.flagged;
  out.proposed_change = isContractor ? null : {
    sql: `UPDATE persons SET employment_type='contractor' WHERE id=${personId};`,
    before: { employment_type: person.employment_type ?? null },
    after: { employment_type: 'contractor' },
    ui_label: 'پیمانکاری',
  };
  ro.close();

  if (apply && out.proposed_change) {
    const w = new Database(dbPath, { fileMustExist: true });
    w.transaction(() => {
      w.prepare("UPDATE persons SET employment_type='contractor' WHERE id=?").run(personId);
      w.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (NULL, ?, ?, ?, ?)').run(
        'update', 'person', personId, JSON.stringify({
          source: 'scripts/person-labor-role-probe.js', reason: 'owner decision: contractor (پیمانکار)',
          before: out.proposed_change.before, after: out.proposed_change.after,
        }));
    })();
    w.close();
    out.applied = true;
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
