'use strict';
/**
 * بازگردانی تفکیک رنگ×سایز پس از صفر شدن کش توسط rebuildAllStockCaches
 * (تعمیر stock-single-source، ۱۴۰۵/۰۸/۱۲ — بکاپ
 *  ~/backups/crm.db.pre-stock-rebuild-2026-11-03T16-27-32-687Z).
 *
 * هدف هر کالا×انبار×واریانت:
 *   target = qty در بکاپ (variant_warehouse_stock)
 *          + حرکات زنده‌ی با variant_id پس از بکاپ (پیش‌فرض ledger id 2468..2553؛
 *            یا هر id > MAX(id) بکاپ اگر --post-from/--post-to ندهید و --post-after-backup بگذارید)
 *
 * روش: فقط سند رسمی VR (`lib/inventory/variant-reclass`.postReclass) روی ردیف‌های
 * زندهٔ بی‌واریانت. بدون تغییر ارزش/JE/میانگین. حدس تخصیص ممنوع.
 *
 * گروه‌ها:
 *   auto   — یک ردیف ورودِ بی‌واریانت با تعداد = Σ نیاز واریانت (CSV restore-plan-auto)
 *   manual — چند ردیف / عدم تطابق یکتا (CSV restore-plan-manual) → فقط گزارش مگر
 *            همان الگوی auto روی دادهٔ زنده برقرار باشد
 *   unreachable — منفی، drift از قبل، یا need که با ردیف‌های بی‌واریانت دقیقاً قابل
 *            پوشش نیست (حدس نمی‌زنیم)
 *
 * پیش‌فرض dry-run (readonly). اعمال فقط با --apply و --i-have-go پس از بکاپ تازه.
 *
 *   node scripts/restore-variant-split-from-backup.js \
 *     --db <copy> --backup <pre-stock-rebuild.db> --out <dir> \
 *     [--plan-auto data/variant-restore/restore-plan-auto.csv] \
 *     [--plan-manual data/variant-restore/restore-plan-manual.csv] \
 *     [--post-from 2468 --post-to 2553]
 *
 *   ... --apply --i-have-go --backup-dir ~/backups
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const QTY_EPS = 1e-3;
const DEFAULT_POST_FROM = 2468;
const DEFAULT_POST_TO = 2553;
const REASON = 'بازگردانی تفکیک رنگ×سایز از پشتیبان pre-stock-rebuild-2026-11-03T16-27-32';

function parseArgs(argv) {
  const out = {
    apply: false, go: false, db: null, backup: null, out: null, backupDir: null,
    planAuto: null, planManual: null,
    postFrom: DEFAULT_POST_FROM, postTo: DEFAULT_POST_TO, postAfterBackup: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--i-have-go') out.go = true;
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--backup') out.backup = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--backup-dir') out.backupDir = argv[++i];
    else if (a === '--plan-auto') out.planAuto = argv[++i];
    else if (a === '--plan-manual') out.planManual = argv[++i];
    else if (a === '--post-from') out.postFrom = Number(argv[++i]);
    else if (a === '--post-to') out.postTo = Number(argv[++i]);
    else if (a === '--post-after-backup') out.postAfterBackup = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error('پرچم ناشناخته: ' + a);
  }
  return out;
}

function round3(n) {
  const x = Math.round((Number(n) || 0) * 1000) / 1000;
  return Math.abs(x) < 1e-9 ? 0 : x;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + lines.join('\n') + '\n', 'utf8');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] == null ? '' : r[i]])));
}

function liveSql(alias) {
  const a = alias ? `${alias}.` : '';
  return `(${a}status='posted' AND ${a}reversed_of IS NULL
    AND COALESCE(${a}event_type,'') <> 'reversal' AND COALESCE(${a}event_type,'') NOT GLOB '*_reversal')`;
}

function trialBalance(db) {
  const GM = require('../lib/gl-metrics');
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
  const unbalanced = GM.unbalancedEntryCount(db);
  const tot = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
    WHERE ${GM.JE_ALIVE} AND ${GM.JE_APPROVED}
  `).get();
  const debit = Math.round(Number(tot.d) || 0);
  const credit = Math.round(Number(tot.c) || 0);
  return { balanced: unbalanced === 0 && debit === credit, unbalanced, debit, credit };
}

function packRecon(r) {
  const s = (r && r.summary) || {};
  const abs = ((r && r.checks) || []).reduce((n, c) => n + Math.abs(Math.round(Number(c.diff_rial) || 0)), 0);
  return {
    ok: s.ok || 0, warn: s.warn || 0, error: s.error || 0, info: s.info || 0, rounding: s.rounding || 0,
    score: (s.error || 0) * 100 + (s.warn || 0) * 10 + (s.rounding || 0),
    abs_diff_rial: abs,
  };
}

function reconWorse(before, after) {
  return after.score > before.score || after.error > before.error || after.abs_diff_rial > before.abs_diff_rial + 1;
}

function loadAutoPlan(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const byLedger = new Map();
  for (const r of rows) {
    const lid = Number(r.ledger_id);
    const vid = Number(r.variant_id);
    const q = round3(r.qty);
    if (!lid || !vid || !(q > 0)) continue;
    if (!byLedger.has(lid)) {
      byLedger.set(lid, {
        product_id: Number(r.product_id),
        warehouse_id: Number(r.warehouse_id),
        ledger_id: lid,
        ledger_event: r.ledger_event || '',
        ledger_qty: round3(r.ledger_qty),
        lines: [],
      });
    }
    byLedger.get(lid).lines.push({ variant_id: vid, qty: q });
  }
  return [...byLedger.values()];
}

function loadManualPlan(file) {
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r) => {
    const needs = String(r.variant_needs || '').split(';').filter(Boolean).map((p) => {
      const [vid, q] = p.split(':');
      return { variant_id: Number(vid), qty: round3(q) };
    });
    const rows = String(r.unattributed_rows || '').split(';').filter(Boolean).map((p) => {
      const [lid, ev, q] = p.split(':');
      return { ledger_id: Number(lid), event: ev || '', qty: round3(q) };
    });
    return {
      product_id: Number(r.product_id),
      warehouse_id: Number(r.warehouse_id),
      need_total: round3(r.need_total),
      unattributed_total: round3(r.unattributed_total),
      variant_needs: needs,
      unattributed_rows: rows,
    };
  });
}

/** Backup VWS + post-backup attributed moves → per-variant target. */
function computeTargets(live, backup, { postFrom, postTo, postAfterBackup }) {
  const backupMax = Number(backup.prepare('SELECT MAX(id) m FROM inventory_ledger').get().m) || 0;
  const from = postAfterBackup ? backupMax + 1 : postFrom;
  const to = postAfterBackup
    ? Number(live.prepare('SELECT MAX(id) m FROM inventory_ledger').get().m) || from
    : postTo;

  const backupVws = backup.prepare(`
    SELECT v.product_id, s.warehouse_id, s.variant_id, s.qty
    FROM variant_warehouse_stock s
    JOIN product_variants v ON v.id = s.variant_id
    WHERE ABS(COALESCE(s.qty,0)) > ?
  `).all(QTY_EPS);

  const postMoves = live.prepare(`
    SELECT product_id, warehouse_id, variant_id,
      SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS q
    FROM inventory_ledger
    WHERE id BETWEEN ? AND ?
      AND COALESCE(variant_id,0) > 0
      AND ${liveSql()}
    GROUP BY product_id, warehouse_id, variant_id
  `).all(from, to);

  const map = new Map(); // pid:wh:vid -> {backup, post, target}
  const touch = (pid, wh, vid) => {
    const k = `${pid}:${wh}:${vid}`;
    if (!map.has(k)) map.set(k, { product_id: pid, warehouse_id: wh, variant_id: vid, backup: 0, post: 0, target: 0 });
    return map.get(k);
  };
  for (const r of backupVws) {
    const t = touch(Number(r.product_id), Number(r.warehouse_id), Number(r.variant_id));
    t.backup = round3(r.qty);
  }
  for (const r of postMoves) {
    const t = touch(Number(r.product_id), Number(r.warehouse_id), Number(r.variant_id));
    t.post = round3(r.q);
  }
  for (const t of map.values()) t.target = round3(t.backup + t.post);
  return { targets: map, backupMax, postFrom: from, postTo: to };
}

function currentAttributed(live, pid, wh) {
  const rows = live.prepare(`
    SELECT variant_id, SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS q
    FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND COALESCE(variant_id,0)>0 AND ${liveSql()}
    GROUP BY variant_id
  `).all(pid, wh);
  return new Map(rows.map((r) => [Number(r.variant_id), round3(r.q)]));
}

function currentVws(live, pid, wh) {
  if (!live.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='variant_warehouse_stock'").get()) {
    return new Map();
  }
  const rows = live.prepare(`
    SELECT s.variant_id, s.qty FROM variant_warehouse_stock s
    JOIN product_variants v ON v.id=s.variant_id
    WHERE v.product_id=? AND s.warehouse_id=?
  `).all(pid, wh);
  return new Map(rows.map((r) => [Number(r.variant_id), round3(r.qty)]));
}

function unattributedRows(live, pid, wh) {
  return live.prepare(`
    SELECT id, event_type, qty_in, qty_out,
      (COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS net
    FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=?
      AND (variant_id IS NULL OR variant_id=0)
      AND ${liveSql()}
    ORDER BY id
  `).all(pid, wh).map((r) => ({
    ledger_id: Number(r.id),
    event: r.event_type || '',
    qty_in: Number(r.qty_in) || 0,
    qty_out: Number(r.qty_out) || 0,
    net: round3(r.net),
  }));
}

function groupKey(pid, wh) { return `${pid}:${wh}`; }

function buildGroupReport(live, targetsMeta, autoPlans, manualPlans) {
  const { targets } = targetsMeta;
  const groups = new Map(); // pid:wh -> group
  const ensure = (pid, wh) => {
    const k = groupKey(pid, wh);
    if (!groups.has(k)) {
      groups.set(k, {
        product_id: pid,
        warehouse_id: wh,
        variants: [],
        need_total: 0,
        before_vws_total: 0,
        before_attr_total: 0,
        target_total: 0,
        unattributed: [],
        unattributed_total: 0,
        auto_ledgers: [],
        classification: 'pending',
        unreachable_reason: '',
      });
    }
    return groups.get(k);
  };

  for (const t of targets.values()) {
    if (Math.abs(t.target) < QTY_EPS && Math.abs(t.backup) < QTY_EPS) continue;
    const g = ensure(t.product_id, t.warehouse_id);
    const attr = currentAttributed(live, t.product_id, t.warehouse_id);
    const vws = currentVws(live, t.product_id, t.warehouse_id);
    const beforeAttr = attr.get(t.variant_id) || 0;
    const beforeVws = vws.get(t.variant_id) || 0;
    const need = round3(t.target - beforeAttr);
    g.variants.push({
      variant_id: t.variant_id,
      backup: t.backup,
      post: t.post,
      target: t.target,
      before_attr: beforeAttr,
      before_vws: beforeVws,
      need,
    });
  }

  for (const g of groups.values()) {
    g.unattributed = unattributedRows(live, g.product_id, g.warehouse_id);
    g.unattributed_total = round3(g.unattributed.reduce((s, r) => s + r.net, 0));
    g.need_total = round3(g.variants.reduce((s, v) => s + v.need, 0));
    g.target_total = round3(g.variants.reduce((s, v) => s + v.target, 0));
    g.before_vws_total = round3(g.variants.reduce((s, v) => s + v.before_vws, 0));
    g.before_attr_total = round3(g.variants.reduce((s, v) => s + v.before_attr, 0));
  }

  // Attach auto plan ledgers
  const autoByGroup = new Map();
  for (const p of autoPlans) {
    const k = groupKey(p.product_id, p.warehouse_id);
    if (!autoByGroup.has(k)) autoByGroup.set(k, []);
    autoByGroup.get(k).push(p);
    ensure(p.product_id, p.warehouse_id);
  }
  for (const [k, plans] of autoByGroup) {
    const g = groups.get(k);
    g.auto_ledgers = plans;
  }

  const manualKeys = new Set(manualPlans.map((m) => groupKey(m.product_id, m.warehouse_id)));
  for (const m of manualPlans) ensure(m.product_id, m.warehouse_id);

  for (const g of groups.values()) {
    const k = groupKey(g.product_id, g.warehouse_id);
    const needs = g.variants.filter((v) => Math.abs(v.need) > QTY_EPS);
    const negNeed = needs.some((v) => v.need < -QTY_EPS);
    const negTarget = g.variants.some((v) => v.target < -QTY_EPS);
    const posNeeds = needs.filter((v) => v.need > QTY_EPS);
    const needSum = round3(posNeeds.reduce((s, v) => s + v.need, 0));

    if (Math.abs(g.need_total) < QTY_EPS && Math.abs(g.before_attr_total - g.target_total) < QTY_EPS) {
      g.classification = 'already_ok';
      g.unreachable_reason = '';
      continue;
    }
    if (negNeed || negTarget) {
      g.classification = 'unreachable';
      g.unreachable_reason = negTarget ? 'negative_target' : 'negative_need';
      continue;
    }

    // Exact auto from CSV: live unattributed inbound row still matches plan Σ (no guessing).
    // Target/need is reported separately; CSV is the approved split for that ledger row.
    const inbound = g.unattributed.filter((r) => r.net > QTY_EPS && r.qty_in > 0 && r.qty_out === 0);
    const csvPlans = g.auto_ledgers || [];
    let matched = null;
    if (csvPlans.length >= 1) {
      const usable = [];
      for (const p of csvPlans) {
        const sum = round3(p.lines.reduce((s, l) => s + l.qty, 0));
        const row = g.unattributed.find((r) => r.ledger_id === p.ledger_id);
        if (row && Math.abs(Math.abs(row.net) - sum) < QTY_EPS && p.lines.every((l) => l.qty > 0)) {
          usable.push({ ...p, ledger_qty: round3(Math.abs(row.net)) });
        }
      }
      if (usable.length === csvPlans.length && usable.length > 0) {
        // Apply first (typical: one opening row). Multi-row auto CSV rare; still exact per row.
        matched = usable[0];
        g.apply_plans = usable;
      }
    } else if (inbound.length === 1 && Math.abs(inbound[0].net - needSum) < QTY_EPS && posNeeds.length) {
      matched = {
        product_id: g.product_id,
        warehouse_id: g.warehouse_id,
        ledger_id: inbound[0].ledger_id,
        ledger_qty: inbound[0].net,
        lines: posNeeds.map((v) => ({ variant_id: v.variant_id, qty: v.need })),
      };
      g.apply_plans = [matched];
    }

    if (matched) {
      g.classification = 'auto';
      g.apply_plan = matched;
      if (!g.apply_plans) g.apply_plans = [matched];
      continue;
    }

    if (manualKeys.has(k)) {
      // Pre-existing drift: |need_total - unattributed_total| significant and both sides disagree
      const drift = Math.abs(g.need_total - g.unattributed_total) > QTY_EPS;
      g.classification = 'unreachable';
      g.unreachable_reason = drift
        ? (Math.abs(g.unattributed_total) < QTY_EPS ? 'preexisting_drift_no_unattributed' : 'manual_no_exact_split')
        : 'manual_ambiguous_rows';
      continue;
    }

    g.classification = 'unreachable';
    g.unreachable_reason = inbound.length === 0 ? 'no_unattributed_inbound' : 'no_exact_single_row_match';
  }

  return [...groups.values()];
}

function validateLiveLedgerForPlan(db, plan) {
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(plan.ledger_id);
  const sum = round3(plan.lines.reduce((s, l) => s + l.qty, 0));
  const live = row ? round3((Number(row.qty_in) || 0) - (Number(row.qty_out) || 0)) : NaN;
  if (!row) return { ok: false, reason: 'ledger_missing' };
  if (Number(row.variant_id) > 0) return { ok: false, reason: 'already_has_variant' };
  if (String(row.status) !== 'posted' || row.reversed_of != null) return { ok: false, reason: 'not_live' };
  if (Math.abs(live - plan.ledger_qty) > QTY_EPS && Math.abs(live - sum) > QTY_EPS) {
    return { ok: false, reason: 'ledger_qty_changed', live, sum };
  }
  if (Math.abs(sum - Math.abs(live)) > QTY_EPS) return { ok: false, reason: 'sum_mismatch', live, sum };
  return { ok: true, row, live, sum };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db || !args.backup || !args.out) {
    console.log(`Usage: node scripts/restore-variant-split-from-backup.js --db <copy> --backup <bak> --out <dir> [options]
  --plan-auto PATH   (default: scripts/data/variant-restore/restore-plan-auto.csv)
  --plan-manual PATH
  --post-from/--post-to  (default ${DEFAULT_POST_FROM}-${DEFAULT_POST_TO})
  --post-after-backup    (ignore range; use id > MAX(backup))
  --apply --i-have-go    (writes; requires fresh --backup-dir)`);
    process.exit(args.help ? 0 : 2);
  }
  if (args.apply && !args.go) {
    console.error('اعمال فقط با --apply و --i-have-go');
    process.exit(2);
  }

  const here = path.join(__dirname, 'data', 'variant-restore');
  const planAutoPath = args.planAuto || path.join(here, 'restore-plan-auto.csv');
  const planManualPath = args.planManual || path.join(here, 'restore-plan-manual.csv');
  fs.mkdirSync(args.out, { recursive: true });

  const APPLY = !!args.apply;
  const live = new Database(args.db, { readonly: !APPLY, fileMustExist: true });
  live.pragma('foreign_keys = ON');
  const backup = new Database(args.backup, { readonly: true, fileMustExist: true });

  const autoPlans = loadAutoPlan(planAutoPath);
  const manualPlans = fs.existsSync(planManualPath) ? loadManualPlan(planManualPath) : [];
  const targetsMeta = computeTargets(live, backup, args);
  const groups = buildGroupReport(live, targetsMeta, autoPlans, manualPlans);

  const trialBefore = trialBalance(live);
  let reconBefore = { ok: 0, warn: 0, error: 0 };
  try {
    const { runRecon } = require('../lib/subledger-recon');
    reconBefore = packRecon(runRecon(live, { persist: false }));
  } catch (e) {
    reconBefore = { error_message: e.message };
  }

  const VR = require('../lib/inventory/variant-reclass');
  const SC = require('../lib/inventory/stock-cache');
  const admin = live.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();

  const autoGroups = groups.filter((g) => g.classification === 'auto');
  const unreachable = groups.filter((g) => g.classification === 'unreachable');
  const already = groups.filter((g) => g.classification === 'already_ok');
  const preexistingDrift = unreachable.filter((g) =>
    String(g.unreachable_reason).includes('drift') || String(g.unreachable_reason) === 'negative_target'
      || String(g.unreachable_reason) === 'negative_need');

  const applyResults = [];
  const preview = (plan) => {
    const v = validateLiveLedgerForPlan(live, plan);
    if (!v.ok) return { ok: false, ...v };
    try {
      const p = VR.previewReclass(live, { ledger_id: plan.ledger_id, lines: plan.lines, basis: 'backup' });
      return { ok: true, preview: p };
    } catch (e) {
      return { ok: false, reason: e.code || e.message };
    }
  };

  for (const g of autoGroups) {
    const plans = g.apply_plans || [g.apply_plan];
    const details = [];
    let allOk = true;
    for (const plan of plans) {
      const r = preview(plan);
      details.push(r.ok ? { ledger_id: plan.ledger_id, qty: r.preview.qty, lines: r.preview.lines.length } : { ledger_id: plan.ledger_id, ...r });
      if (!r.ok) allOk = false;
    }
    g.preview_ok = allOk;
    g.preview_detail = details;
    if (!allOk) {
      g.classification = 'unreachable';
      g.unreachable_reason = 'preview_failed';
    }
  }

  // Recompute lists after preview failures
  const autoReady = groups.filter((g) => g.classification === 'auto' && g.preview_ok);
  const unreachableFinal = groups.filter((g) => g.classification === 'unreachable');

  let trialAfter = trialBefore;
  let reconAfter = reconBefore;
  let backupPath = null;

  if (APPLY) {
    const backupDir = path.resolve(args.backupDir || process.env.STOCK_REPAIR_BACKUP_DIR || path.join(os.homedir(), 'backups'));
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(backupDir, 'crm.db.pre-variant-restore-' + stamp);
    await live.backup(backupPath);

    const touched = new Set();
    const tx = live.transaction(() => {
      for (const g of autoReady) {
        for (const plan of (g.apply_plans || [g.apply_plan])) {
          VR.postReclass(live, {
            ledger_id: plan.ledger_id,
            lines: plan.lines,
            reason: REASON,
            confirm: true,
            basis: 'backup',
          }, admin);
          applyResults.push({ product_id: g.product_id, warehouse_id: g.warehouse_id, ledger_id: plan.ledger_id, status: 'posted' });
        }
        touched.add(g.product_id);
      }
      // postReclass already rebuilds with forceVariantLedger; final pass for touched products
      for (const pid of touched) SC.rebuildStockCache(live, pid, { forceVariantLedger: true });

      trialAfter = trialBalance(live);
      if (trialAfter.debit !== trialBefore.debit || trialAfter.credit !== trialBefore.credit || !trialAfter.balanced) {
        throw new Error('تراز آزمایشی تغییر کرد — rollback');
      }
      try {
        const { runRecon } = require('../lib/subledger-recon');
        reconAfter = packRecon(runRecon(live, { persist: false }));
        if (reconWorse(reconBefore, reconAfter)) throw new Error('recon بدتر شد — rollback');
      } catch (e) {
        if (String(e.message).includes('rollback')) throw e;
        reconAfter = { error_message: e.message };
      }
    });
    try {
      tx();
    } catch (e) {
      console.error(e.message);
      live.close(); backup.close();
      process.exit(1);
    }
  } else {
    // Dry-run: simulate after = before for TB; per-group after_attr estimate = before_attr + need for auto
    for (const g of groups) {
      if (g.classification === 'auto' && g.preview_ok) {
        g.after_attr_total_est = round3(g.before_attr_total + g.need_total);
        g.after_ok_est = Math.abs(g.after_attr_total_est - g.target_total) < QTY_EPS;
      } else {
        g.after_attr_total_est = g.before_attr_total;
        g.after_ok_est = g.classification === 'already_ok';
      }
    }
  }

  // After apply, refresh attributed for auto groups
  if (APPLY) {
    for (const g of autoReady) {
      const attr = currentAttributed(live, g.product_id, g.warehouse_id);
      g.after_attr_total = round3([...attr.values()].reduce((s, q) => s + q, 0));
      g.after_ok = Math.abs(g.after_attr_total - g.target_total) < QTY_EPS;
    }
  }

  const reportRows = groups.map((g) => ({
    product_id: g.product_id,
    warehouse_id: g.warehouse_id,
    classification: g.classification,
    unreachable_reason: g.unreachable_reason || '',
    target_total: g.target_total,
    before_attr_total: g.before_attr_total,
    before_vws_total: g.before_vws_total,
    need_total: g.need_total,
    unattributed_total: g.unattributed_total,
    after_attr_total: g.after_attr_total != null ? g.after_attr_total : (g.after_attr_total_est != null ? g.after_attr_total_est : ''),
    after_ok: g.after_ok != null ? g.after_ok : (g.after_ok_est != null ? g.after_ok_est : ''),
    auto_ledger_id: g.apply_plan ? g.apply_plan.ledger_id : '',
    preview_ok: g.preview_ok == null ? '' : g.preview_ok,
  }));
  writeCsv(path.join(args.out, 'group-report.csv'), Object.keys(reportRows[0] || {
    product_id: 1, warehouse_id: 1, classification: '', unreachable_reason: '', target_total: 0,
    before_attr_total: 0, before_vws_total: 0, need_total: 0, unattributed_total: 0,
    after_attr_total: '', after_ok: '', auto_ledger_id: '', preview_ok: '',
  }), reportRows);

  writeCsv(path.join(args.out, 'unreachable.csv'),
    ['product_id', 'warehouse_id', 'reason', 'need_total', 'unattributed_total', 'target_total', 'before_attr_total'],
    unreachableFinal.map((g) => ({
      product_id: g.product_id,
      warehouse_id: g.warehouse_id,
      reason: g.unreachable_reason,
      need_total: g.need_total,
      unattributed_total: g.unattributed_total,
      target_total: g.target_total,
      before_attr_total: g.before_attr_total,
    })));

  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    backup_source: args.backup,
    live_db: args.db,
    post_range: { from: targetsMeta.postFrom, to: targetsMeta.postTo, backup_max_id: targetsMeta.backupMax },
    groups: groups.length,
    auto_ready: autoReady.length,
    already_ok: already.length,
    unreachable: unreachableFinal.length,
    preexisting_drift_or_negative: preexistingDrift.length,
    trial_before: trialBefore,
    trial_after: trialAfter,
    trial_unchanged: trialBefore.debit === trialAfter.debit && trialBefore.credit === trialAfter.credit,
    recon_before: reconBefore,
    recon_after: reconAfter,
    apply_backup: backupPath,
    apply_posted: applyResults.length,
  };
  fs.writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));

  live.close();
  backup.close();
  if (!summary.trial_unchanged && APPLY) process.exit(1);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
