'use strict';
/**
 * P9 — پورسانت چندنفره (سرپرست + چند فروشنده روی یک فاکتور).
 *
 * پایه = مبلغ خالص فروش هر ردیف پس از تخفیف ردیف و سهم تخفیف سرفاکتور (بدون ارزش افزوده)،
 * منهای برگشت از فروش (ردیف‌های برگشت با سهم تخفیف سرفاکتور/اضافهٔ همان برگشت) در دورهٔ برگشت.
 *
 * سرپرست: قاعدهٔ role=supervisor با scope=product (کد کالا) یا product_group (گروه کالا) — کالا بر گروه مقدم است.
 *   اگر روی فاکتور «سرپرست» صریح ثبت شده باشد، فقط همان‌ها (به نسبت share_pct) پورسانت سرپرستی می‌گیرند.
 * فروشنده: طرف‌های role=seller در invoice_commission_parties (share_pct جمعاً ۱۰۰)؛ در نبود آن،
 *   کاربر ثبت‌کنندهٔ فاکتور (users.person_id) با سهم ۱۰۰٪. درصد از قاعدهٔ seller:
 *   product > product_group > invoice(scope_id = همین فاکتور) > invoice(scope_id خالی = پیش‌فرض).
 *
 * انتقال: کارمند (کد پرسنلی/شمارهٔ کارمندی) → ردیف «پورسانت» در حقوق همان دوره (مشمول بیمه و مالیات)؛
 *   غیرکارمند → سند پیش‌نویس: بدهکار هزینهٔ پورسانت / بستانکار حساب شخص. هیچ پرداخت خودکاری ساخته نمی‌شود.
 * ابطال (R13): انتقالِ حقوقیِ مصرف‌نشده یا سند پیش‌نویس/ثبت‌شده کامل برمی‌گردد؛ حذف فیزیکی ندارد.
 */
const { allocateNumber } = require('../db');
const { firmSaleAliveSql } = require('./sales-document');

const ROLES = new Set(['supervisor', 'seller']);
const SCOPES = new Set(['product_group', 'product', 'invoice']);

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function colSet(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function normDate(v) {
  const s = String(v == null ? '' : v).trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/-/g, '/');
  if (!s) return '';
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(s)) throw httpErr(400, `تاریخ نامعتبر است (${s}) — قالب ۱۴۰۵/۰۷/۰۱`, 'E_DATE');
  return s;
}

function round(n) { return Math.round(Number(n) || 0); }

function isEmployee(person) {
  if (!person) return false;
  return !!(String(person.personnel_code || '').trim() || String(person.employee_no || '').trim());
}

function personOf(db, id) {
  return db.prepare('SELECT * FROM persons WHERE id=?').get(Number(id));
}

function ruleActiveOn(rule, date) {
  if (!Number(rule.active)) return false;
  if (rule.from_date && date && date < rule.from_date) return false;
  if (rule.to_date && date && date > rule.to_date) return false;
  return true;
}

function loadRules(db) {
  if (!tableExists(db, 'commission_rules')) return [];
  return db.prepare('SELECT * FROM commission_rules WHERE active=1').all();
}

function loadParties(db, invoiceId) {
  if (!tableExists(db, 'invoice_commission_parties')) return [];
  return db.prepare(`
    SELECT person_id, role, share_pct FROM invoice_commission_parties
    WHERE invoice_id=? AND active=1 ORDER BY id
  `).all(invoiceId);
}

function parseRows(json) {
  try {
    const r = JSON.parse(json || '[]');
    return Array.isArray(r) ? r : [];
  } catch (_) { return []; }
}

function rowGoods(row) {
  if (row.sum != null && row.sum !== '') return Math.max(0, Number(row.sum) || 0);
  const gross = (Number(row.qty) || 0) * (Number(row.price) || 0);
  const discAmt = Number(row.disc_amt != null ? row.disc_amt : row.disc_amount) || 0;
  const disc = discAmt > 0 ? discAmt : gross * (Number(row.disc) || 0) / 100;
  return Math.max(0, gross - disc);
}

/** Net (ex-VAT) per product row after row + header discount. */
function invoiceNetLines(inv) {
  const rows = parseRows(inv.rows).filter((r) => r && r.product_id && r.row_type !== 'income');
  const goods = rows.map(rowGoods);
  const totalGoods = goods.reduce((a, b) => a + b, 0);
  const hdr = Math.max(0, Number(inv.disc_amt) || 0);
  const ratio = totalGoods > 0 ? Math.max(0, totalGoods - hdr) / totalGoods : 0;
  return rows.map((r, i) => ({ product_id: Number(r.product_id), net: goods[i] * ratio }));
}

function returnNetLines(ret) {
  const rows = parseRows(ret.rows).filter((r) => r && r.product_id);
  const goods = rows.map(rowGoods);
  const totalGoods = goods.reduce((a, b) => a + b, 0);
  let netBase;
  const ga = Number(ret.goods_amount) || 0;
  if (ga > 0) netBase = Math.max(0, ga - (Number(ret.hdr_disc_amt) || 0) - (Number(ret.extra_disc_amt) || 0));
  else netBase = Math.max(0, (Number(ret.amount) || 0) - (Number(ret.vat_amount) || 0));
  const ratio = totalGoods > 0 ? netBase / totalGoods : 0;
  return rows.map((r, i) => ({ product_id: Number(r.product_id), net: goods[i] * ratio }));
}

/** Seller parties of an invoice: explicit split, else creator user → person (100%). */
function sellerParties(db, inv, parties) {
  const sellers = parties.filter((p) => p.role === 'seller');
  if (sellers.length) return sellers.map((p) => ({ person_id: Number(p.person_id), share: Number(p.share_pct) || 0 }));
  const u = inv.user_id ? db.prepare('SELECT person_id FROM users WHERE id=?').get(inv.user_id) : null;
  if (u && u.person_id) return [{ person_id: Number(u.person_id), share: 100 }];
  return [];
}

function pickSellerRule(rules, personId, product, invoiceId, date) {
  const mine = rules.filter((r) => r.role === 'seller' && Number(r.person_id) === personId && ruleActiveOn(r, date));
  const by = (scope, sid) => mine.find((r) => r.scope === scope && (sid == null ? r.scope_id == null : Number(r.scope_id) === Number(sid)));
  return (product && by('product', product.id))
    || (product && product.category_id && by('product_group', product.category_id))
    || by('invoice', invoiceId)
    || by('invoice', null)
    || null;
}

/** Supervisor rules matching a product: one per person, product beats group. */
function supervisorRules(rules, product, date) {
  const out = new Map();
  for (const r of rules) {
    if (r.role !== 'supervisor' || !ruleActiveOn(r, date) || !product) continue;
    const hitProduct = r.scope === 'product' && Number(r.scope_id) === Number(product.id);
    const hitGroup = r.scope === 'product_group' && product.category_id && Number(r.scope_id) === Number(product.category_id);
    if (!hitProduct && !hitGroup) continue;
    const pid = Number(r.person_id);
    const prev = out.get(pid);
    if (!prev || (hitProduct && prev.scope !== 'product')) out.set(pid, r);
  }
  return [...out.values()];
}

/**
 * Commission contributions of one document (invoice sign=+1, return sign=-1).
 * Rules are evaluated at the invoice date (return of an invoice uses the original invoice's rules).
 */
function documentContributions(db, ctx, { inv, lines, sign, ruleDate, kind, docId, docNo, docDate }) {
  const out = [];
  const parties = inv ? loadParties(db, inv.id) : [];
  const sellers = inv ? sellerParties(db, inv, parties) : [];
  const explicitSup = parties.filter((p) => p.role === 'supervisor');
  for (const line of lines) {
    if (!(line.net > 0)) continue;
    let product = ctx.products.get(line.product_id);
    if (product === undefined) {
      product = db.prepare('SELECT id, name, code, category_id FROM products WHERE id=?').get(line.product_id) || null;
      ctx.products.set(line.product_id, product);
    }
    for (const r of supervisorRules(ctx.rules, product, ruleDate)) {
      let share = 100;
      if (explicitSup.length) {
        const hit = explicitSup.find((p) => Number(p.person_id) === Number(r.person_id));
        if (!hit) continue;
        share = Number(hit.share_pct) || 0;
      }
      const base = line.net * share / 100;
      out.push({
        person_id: Number(r.person_id), role: 'supervisor', kind, doc_id: docId, doc_no: docNo, date: docDate,
        product_id: line.product_id, rule_id: r.id, pct: Number(r.pct) || 0, share_pct: share,
        base: sign * base, amount: sign * base * (Number(r.pct) || 0) / 100,
      });
    }
    for (const s of sellers) {
      const r = pickSellerRule(ctx.rules, s.person_id, product, inv && inv.id, ruleDate);
      if (!r) continue;
      const base = line.net * s.share / 100;
      out.push({
        person_id: s.person_id, role: 'seller', kind, doc_id: docId, doc_no: docNo, date: docDate,
        product_id: line.product_id, rule_id: r.id, pct: Number(r.pct) || 0, share_pct: s.share,
        base: sign * base, amount: sign * base * (Number(r.pct) || 0) / 100,
      });
    }
  }
  return out;
}

/** Raw per-line contributions for [from, to]. */
function computeContributions(db, { from, to } = {}) {
  const f = normDate(from);
  const t = normDate(to);
  const ctx = { rules: loadRules(db), products: new Map() };
  if (!ctx.rules.length) return [];
  const requireApproved = (db.prepare("SELECT value FROM settings WHERE key='commission_p9_require_approved'").get() || {}).value === '1';
  const invWhere = [firmSaleAliveSql('i')];
  const invParams = [];
  if (requireApproved) invWhere.push('COALESCE(i.approved,0)=1');
  if (f) { invWhere.push('i.date>=?'); invParams.push(f); }
  if (t) { invWhere.push('i.date<=?'); invParams.push(t); }
  const invoices = db.prepare(`SELECT i.* FROM invoices i WHERE ${invWhere.join(' AND ')} ORDER BY i.date, i.id`).all(...invParams);
  const out = [];
  for (const inv of invoices) {
    out.push(...documentContributions(db, ctx, {
      inv, lines: invoiceNetLines(inv), sign: 1, ruleDate: inv.date, kind: 'invoice',
      docId: inv.id, docNo: inv.num, docDate: inv.date,
    }));
  }
  const rc = colSet(db, 'sales_returns');
  const retWhere = [];
  const retParams = [];
  if (rc.has('status')) retWhere.push("COALESCE(r.status,'posted')<>'reversed'");
  if (rc.has('deleted_at')) retWhere.push('COALESCE(r.deleted_at,0)=0');
  if (f) { retWhere.push('r.date>=?'); retParams.push(f); }
  if (t) { retWhere.push('r.date<=?'); retParams.push(t); }
  const returns = db.prepare(`SELECT r.* FROM sales_returns r ${retWhere.length ? 'WHERE ' + retWhere.join(' AND ') : ''} ORDER BY r.date, r.id`).all(...retParams);
  for (const ret of returns) {
    const inv = ret.invoice_id ? db.prepare('SELECT * FROM invoices WHERE id=?').get(ret.invoice_id) : null;
    out.push(...documentContributions(db, ctx, {
      inv, lines: returnNetLines(ret), sign: -1, ruleDate: inv ? inv.date : ret.date, kind: 'return',
      docId: ret.id, docNo: `R-${ret.id}`, docDate: ret.date,
    }));
  }
  return out;
}

function transferredFor(db, personId, from, to) {
  if (!tableExists(db, 'commission_transfers')) return null;
  return db.prepare(`
    SELECT id, doc_no, status, target, amount_rial FROM commission_transfers
    WHERE person_id=? AND period_from=? AND period_to=? AND status<>'void'
    ORDER BY id DESC LIMIT 1
  `).get(personId, from, to) || null;
}

/** Monthly (or any range) report per person. */
function commissionReport(db, { from, to, person_id: onlyPerson, detail } = {}) {
  const f = normDate(from);
  const t = normDate(to);
  const contribs = computeContributions(db, { from: f, to: t });
  const byPerson = new Map();
  for (const c of contribs) {
    if (onlyPerson && Number(onlyPerson) !== c.person_id) continue;
    let p = byPerson.get(c.person_id);
    if (!p) {
      p = { person_id: c.person_id, sales_base_rial: 0, returns_base_rial: 0, supervisor_rial: 0, seller_rial: 0, returns_deduction_rial: 0, lines: [] };
      byPerson.set(c.person_id, p);
    }
    if (c.kind === 'invoice') {
      p.sales_base_rial += c.base;
      if (c.role === 'supervisor') p.supervisor_rial += c.amount;
      else p.seller_rial += c.amount;
    } else {
      p.returns_base_rial += -c.base;
      p.returns_deduction_rial += -c.amount;
    }
    if (detail) p.lines.push(c);
  }
  const rows = [];
  for (const p of byPerson.values()) {
    const person = personOf(db, p.person_id) || { id: p.person_id, name: `#${p.person_id}` };
    const total = p.supervisor_rial + p.seller_rial - p.returns_deduction_rial;
    const row = {
      person_id: p.person_id,
      name: person.name,
      is_employee: isEmployee(person) ? 1 : 0,
      sales_base_rial: round(p.sales_base_rial),
      returns_base_rial: round(p.returns_base_rial),
      net_base_rial: round(p.sales_base_rial - p.returns_base_rial),
      supervisor_rial: round(p.supervisor_rial),
      seller_rial: round(p.seller_rial),
      returns_deduction_rial: round(p.returns_deduction_rial),
      total_rial: round(total),
      transfer: f && t ? transferredFor(db, p.person_id, f, t) : null,
    };
    if (detail) {
      row.lines = p.lines.map((l) => ({ ...l, base: round(l.base), amount: round(l.amount) }));
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.total_rial - a.total_rial || a.person_id - b.person_id);
  return { from: f, to: t, rows, total_rial: rows.reduce((a, r) => a + r.total_rial, 0) };
}

// ── locks: rules/parties may not change under a live transfer ──

function assertNoLiveTransfer(db, personIds, from, to) {
  if (!tableExists(db, 'commission_transfers')) return;
  const ids = [...new Set((personIds || []).map(Number).filter(Boolean))];
  for (const pid of ids) {
    const hit = db.prepare(`
      SELECT doc_no FROM commission_transfers
      WHERE person_id=? AND status<>'void'
        AND (? = '' OR period_to >= ?)
        AND (? = '' OR period_from <= ?)
      LIMIT 1
    `).get(pid, from || '', from || '', to || '', to || '');
    if (hit) {
      throw httpErr(409, `پورسانت این شخص در سند انتقال ${hit.doc_no} منتقل شده است؛ ابتدا آن انتقال را ابطال کنید`, 'E_COMMISSION_LOCKED');
    }
  }
}

// ── rules ──

function validateRule(db, b) {
  const personId = Number(b.person_id);
  if (!personId || !personOf(db, personId)) throw httpErr(400, 'شخص معتبر انتخاب کنید', 'E_PERSON');
  const role = String(b.role || '');
  if (!ROLES.has(role)) throw httpErr(400, 'نقش باید supervisor (سرپرست) یا seller (فروشنده) باشد', 'E_ROLE');
  const scope = String(b.scope || '');
  if (!SCOPES.has(scope)) throw httpErr(400, 'دامنه باید product_group، product یا invoice باشد', 'E_SCOPE');
  if (role === 'supervisor' && scope === 'invoice') throw httpErr(400, 'پورسانت سرپرست فقط بر اساس گروه یا کد کالا تعریف می‌شود', 'E_SCOPE');
  let scopeId = b.scope_id === '' || b.scope_id == null ? null : Number(b.scope_id);
  const code = String(b.scope_code || '').trim();
  if (!scopeId && code && scope === 'product') {
    const hit = db.prepare('SELECT id FROM products WHERE code=? ORDER BY id LIMIT 1').get(code);
    if (!hit) throw httpErr(400, `کالا با کد ${code} یافت نشد`, 'E_SCOPE_ID');
    scopeId = hit.id;
  } else if (!scopeId && code && scope === 'invoice') {
    const hit = db.prepare('SELECT id FROM invoices WHERE num=? ORDER BY id DESC LIMIT 1').get(code);
    if (!hit) throw httpErr(400, `فاکتور ${code} یافت نشد`, 'E_SCOPE_ID');
    scopeId = hit.id;
  }
  if (scope === 'product') {
    if (!scopeId || !db.prepare('SELECT 1 FROM products WHERE id=?').get(scopeId)) throw httpErr(400, 'کالا یافت نشد', 'E_SCOPE_ID');
  } else if (scope === 'product_group') {
    if (!scopeId || !db.prepare('SELECT 1 FROM product_categories WHERE id=?').get(scopeId)) throw httpErr(400, 'گروه کالا یافت نشد', 'E_SCOPE_ID');
  } else if (scopeId && !db.prepare('SELECT 1 FROM invoices WHERE id=?').get(scopeId)) {
    throw httpErr(400, 'فاکتور یافت نشد', 'E_SCOPE_ID');
  }
  if (scope === 'invoice' && !scopeId) scopeId = null;
  const pct = Number(b.pct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw httpErr(400, 'درصد پورسانت باید بیشتر از ۰ و حداکثر ۱۰۰ باشد', 'E_PCT');
  const fromDate = normDate(b.from_date);
  const toDate = normDate(b.to_date);
  if (fromDate && toDate && fromDate > toDate) throw httpErr(400, 'تاریخ شروع از پایان بزرگ‌تر است', 'E_DATE');
  return { person_id: personId, role, scope, scope_id: scopeId, pct, from_date: fromDate, to_date: toDate, note: String(b.note || '').slice(0, 300) };
}

function assertNoOverlap(db, r, excludeId) {
  const rows = db.prepare(`
    SELECT id, from_date, to_date FROM commission_rules
    WHERE active=1 AND person_id=? AND role=? AND scope=? AND COALESCE(scope_id,0)=COALESCE(?,0) AND id<>?
  `).all(r.person_id, r.role, r.scope, r.scope_id, excludeId || 0);
  for (const o of rows) {
    const aFrom = r.from_date || '0000/00/00';
    const aTo = r.to_date || '9999/99/99';
    const bFrom = o.from_date || '0000/00/00';
    const bTo = o.to_date || '9999/99/99';
    if (aFrom <= bTo && bFrom <= aTo) {
      throw httpErr(409, `قاعدهٔ هم‌پوشان فعال (#${o.id}) برای همین شخص/نقش/دامنه وجود دارد`, 'E_RULE_OVERLAP');
    }
  }
}

function listRules(db, { person_id, include_inactive } = {}) {
  const where = [];
  const p = [];
  if (!include_inactive) where.push('r.active=1');
  if (person_id) { where.push('r.person_id=?'); p.push(Number(person_id)); }
  return db.prepare(`
    SELECT r.*, pe.name AS person_name,
      CASE r.scope WHEN 'product' THEN (SELECT COALESCE(code,'')||' '||name FROM products WHERE id=r.scope_id)
                   WHEN 'product_group' THEN (SELECT name FROM product_categories WHERE id=r.scope_id)
                   WHEN 'invoice' THEN (SELECT num FROM invoices WHERE id=r.scope_id) END AS scope_label
    FROM commission_rules r LEFT JOIN persons pe ON pe.id=r.person_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.active DESC, pe.name, r.role, r.scope, r.id
  `).all(...p);
}

function createRule(db, body, userId) {
  return db.transaction(() => {
    const r = validateRule(db, body);
    assertNoOverlap(db, r, 0);
    assertNoLiveTransfer(db, [r.person_id], r.from_date, r.to_date);
    const id = db.prepare(`
      INSERT INTO commission_rules (person_id, role, scope, scope_id, pct, from_date, to_date, active, note, created_by)
      VALUES (?,?,?,?,?,?,?,1,?,?)
    `).run(r.person_id, r.role, r.scope, r.scope_id, r.pct, r.from_date, r.to_date, r.note, userId || null).lastInsertRowid;
    return db.prepare('SELECT * FROM commission_rules WHERE id=?').get(id);
  })();
}

function updateRule(db, id, body, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM commission_rules WHERE id=?').get(Number(id));
    if (!old) throw httpErr(404, 'قاعده یافت نشد');
    if (!Number(old.active)) throw httpErr(409, 'قاعدهٔ غیرفعال قابل ویرایش نیست', 'E_RULE_INACTIVE');
    const r = validateRule(db, { ...old, ...body });
    assertNoOverlap(db, r, old.id);
    assertNoLiveTransfer(db, [old.person_id, r.person_id], old.from_date && r.from_date ? (old.from_date < r.from_date ? old.from_date : r.from_date) : '',
      old.to_date && r.to_date ? (old.to_date > r.to_date ? old.to_date : r.to_date) : '');
    db.prepare(`
      UPDATE commission_rules SET person_id=?, role=?, scope=?, scope_id=?, pct=?, from_date=?, to_date=?, note=?,
        updated_by=?, updated_at=strftime('%s','now') WHERE id=?
    `).run(r.person_id, r.role, r.scope, r.scope_id, r.pct, r.from_date, r.to_date, r.note, userId || null, old.id);
    return db.prepare('SELECT * FROM commission_rules WHERE id=?').get(old.id);
  })();
}

/** R13: «حذف» قاعده = غیرفعال‌سازی (بدون حذف فیزیکی). */
function deactivateRule(db, id, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM commission_rules WHERE id=?').get(Number(id));
    if (!old) throw httpErr(404, 'قاعده یافت نشد');
    if (!Number(old.active)) return old;
    assertNoLiveTransfer(db, [old.person_id], old.from_date, old.to_date);
    db.prepare(`UPDATE commission_rules SET active=0, deactivated_by=?, deactivated_at=strftime('%s','now') WHERE id=?`)
      .run(userId || null, old.id);
    return db.prepare('SELECT * FROM commission_rules WHERE id=?').get(old.id);
  })();
}

// ── invoice parties ──

function getInvoiceParties(db, ref) {
  const s = String(ref == null ? '' : ref).trim();
  let inv = /^\d+$/.test(s) ? db.prepare('SELECT id, num, date, user_id FROM invoices WHERE id=?').get(Number(s)) : null;
  if (!inv && s) inv = db.prepare('SELECT id, num, date, user_id FROM invoices WHERE num=? ORDER BY id DESC LIMIT 1').get(s);
  if (!inv) throw httpErr(404, 'فاکتور یافت نشد');
  const parties = db.prepare(`
    SELECT icp.*, p.name AS person_name FROM invoice_commission_parties icp
    LEFT JOIN persons p ON p.id=icp.person_id
    WHERE icp.invoice_id=? AND icp.active=1 ORDER BY icp.role, icp.id
  `).all(inv.id);
  const fallback = inv.user_id ? db.prepare('SELECT u.person_id, p.name FROM users u LEFT JOIN persons p ON p.id=u.person_id WHERE u.id=?').get(inv.user_id) : null;
  return { invoice: inv, parties, default_seller: fallback && fallback.person_id ? { person_id: fallback.person_id, name: fallback.name } : null };
}

function setInvoiceParties(db, invoiceId, list, userId) {
  return db.transaction(() => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(invoiceId));
    if (!inv) throw httpErr(404, 'فاکتور یافت نشد');
    if (Number(inv.deleted_at || 0) > 0 || String(inv.status || '') === 'reversed') {
      throw httpErr(409, 'فاکتور ابطال‌شده است', 'E_INVOICE_VOID');
    }
    const rows = (Array.isArray(list) ? list : []).map((p) => ({
      person_id: Number(p.person_id), role: String(p.role || 'seller'), share_pct: Number(p.share_pct),
    }));
    const seen = new Set();
    for (const p of rows) {
      if (!p.person_id || !personOf(db, p.person_id)) throw httpErr(400, 'شخص نامعتبر در فهرست طرف‌ها', 'E_PERSON');
      if (!ROLES.has(p.role)) throw httpErr(400, 'نقش نامعتبر', 'E_ROLE');
      if (!Number.isFinite(p.share_pct) || p.share_pct <= 0 || p.share_pct > 100) throw httpErr(400, 'سهم هر نفر باید بیشتر از ۰ و حداکثر ۱۰۰ درصد باشد', 'E_SHARE');
      const k = `${p.role}:${p.person_id}`;
      if (seen.has(k)) throw httpErr(400, 'یک شخص با یک نقش دو بار آمده است', 'E_DUP');
      seen.add(k);
    }
    for (const role of ROLES) {
      const sum = rows.filter((p) => p.role === role).reduce((a, p) => a + p.share_pct, 0);
      if (sum > 0 && Math.abs(sum - 100) > 0.001) {
        throw httpErr(400, `جمع سهم ${role === 'seller' ? 'فروشنده‌ها' : 'سرپرست‌ها'} باید ۱۰۰٪ باشد (اکنون ${sum})`, 'E_SHARE_SUM');
      }
    }
    const before = db.prepare('SELECT person_id FROM invoice_commission_parties WHERE invoice_id=? AND active=1').all(inv.id).map((r) => r.person_id);
    const creator = inv.user_id ? db.prepare('SELECT person_id FROM users WHERE id=?').get(inv.user_id) : null;
    assertNoLiveTransfer(db, [...before, ...rows.map((r) => r.person_id), creator && creator.person_id], inv.date, inv.date);
    db.prepare(`
      UPDATE invoice_commission_parties SET active=0, deactivated_by=?, deactivated_at=strftime('%s','now')
      WHERE invoice_id=? AND active=1
    `).run(userId || null, inv.id);
    const ins = db.prepare(`
      INSERT INTO invoice_commission_parties (invoice_id, person_id, role, share_pct, active, created_by)
      VALUES (?,?,?,?,1,?)
    `);
    let lastId = null;
    for (const p of rows) lastId = ins.run(inv.id, p.person_id, p.role, p.share_pct, userId || null).lastInsertRowid;
    return { id: lastId, ...getInvoiceParties(db, inv.id) };
  })();
}

// ── transfers ──

function expenseAccount(db) {
  const { acct } = require('./coa-map');
  return acct(db, 'coa_rep_commission_expense');
}

function personCreditAccount(db, person) {
  const { loadCoa } = require('./payroll/person-account');
  const fromPerson = loadCoa(db, person.coa_code);
  if (fromPerson) return fromPerson;
  if (person.party_id) {
    const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(person.party_id);
    const fromParty = loadCoa(db, party && party.coa_code);
    if (fromParty) return fromParty;
  }
  const { acct } = require('./coa-map');
  return acct(db, 'coa_rep_commission_payable');
}

function createTransfer(db, body, userId) {
  const from = normDate(body.from);
  const to = normDate(body.to);
  if (!from || !to) throw httpErr(400, 'بازهٔ دوره (از/تا) الزامی است', 'E_DATE');
  if (from > to) throw httpErr(400, 'تاریخ شروع از پایان بزرگ‌تر است', 'E_DATE');
  const personId = Number(body.person_id);
  const person = personOf(db, personId);
  if (!person) throw httpErr(404, 'شخص یافت نشد');
  const employee = isEmployee(person);
  let target = String(body.target || 'auto');
  if (target === 'auto') target = employee ? 'payroll' : 'voucher';
  if (!['payroll', 'voucher'].includes(target)) throw httpErr(400, 'مقصد باید payroll یا voucher باشد', 'E_TARGET');
  if (target === 'payroll' && !employee) {
    throw httpErr(400, 'این شخص کد پرسنلی/شمارهٔ کارمندی ندارد؛ برای غیرکارمند فقط سند پیش‌نویس ساخته می‌شود', 'E_NOT_EMPLOYEE');
  }

  return db.transaction(() => {
    const dup = transferredFor(db, personId, from, to);
    if (dup) throw httpErr(409, `پورسانت این دوره قبلاً منتقل شده است (${dup.doc_no})`, 'E_COMMISSION_DUP');
    const overlap = db.prepare(`
      SELECT doc_no FROM commission_transfers
      WHERE person_id=? AND status<>'void' AND period_from<=? AND period_to>=? LIMIT 1
    `).get(personId, to, from);
    if (overlap) throw httpErr(409, `بازه با انتقال ${overlap.doc_no} هم‌پوشانی دارد`, 'E_COMMISSION_DUP');

    const rep = commissionReport(db, { from, to, person_id: personId, detail: true });
    const row = rep.rows[0];
    const amount = row ? row.total_rial : 0;
    if (!(amount > 0)) throw httpErr(400, 'پورسانت قابل انتقال این دوره صفر یا منفی است', 'E_COMMISSION_ZERO');

    let periodId = null;
    if (target === 'payroll') {
      periodId = Number(body.payroll_period_id);
      const period = periodId ? db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(periodId) : null;
      if (!period) throw httpErr(400, 'دورهٔ حقوق را انتخاب کنید', 'E_PAYROLL_PERIOD');
      if (period.status === 'closed') throw httpErr(409, 'دورهٔ حقوق بسته است', 'E_PAYROLL_PERIOD');
      const processed = db.prepare(`
        SELECT id FROM payroll_records WHERE person_id=? AND period_id=? AND COALESCE(status,'posted')<>'reversed' LIMIT 1
      `).get(personId, periodId);
      if (processed) {
        throw httpErr(409, 'حقوق این شخص در این دوره قبلاً پردازش شده است؛ ابتدا حقوق را ابطال کنید یا دورهٔ بعد را انتخاب کنید', 'E_PAYROLL_PROCESSED');
      }
    }

    const docNo = allocateNumber(db, 'commission_transfer', 'CMT');
    const detail = {
      supervisor_rial: row.supervisor_rial, seller_rial: row.seller_rial,
      returns_deduction_rial: row.returns_deduction_rial, sales_base_rial: row.sales_base_rial,
      returns_base_rial: row.returns_base_rial, line_count: (row.lines || []).length,
    };
    const id = db.prepare(`
      INSERT INTO commission_transfers
        (doc_no, person_id, period_from, period_to, target, amount_rial, base_rial, detail_json, status,
         payroll_period_id, cost_center_id, note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      docNo, personId, from, to, target, amount, row.net_base_rial, JSON.stringify(detail),
      target === 'payroll' ? 'pending' : 'voucher', periodId, Number(body.cost_center_id) || null,
      String(body.note || '').slice(0, 300), userId || null
    ).lastInsertRowid;

    if (target === 'voucher') {
      const { postToLedger } = require('./ledger');
      const exp = expenseAccount(db);
      const cr = personCreditAccount(db, person);
      const ccId = Number(body.cost_center_id) || null;
      const jeId = postToLedger(db, {
        sourceType: 'commission_transfer', sourceId: id,
        date: normDate(body.date) || to,
        description: `پورسانت ${person.name} (${from} تا ${to}) — ${docNo}`,
        createdBy: userId,
        costCenterId: ccId,
        status: 'draft',
        lines: [
          { code: exp.code, name: exp.name, debit: amount / 10, credit: 0, cost_center_id: ccId },
          { code: cr.code, name: cr.name, debit: 0, credit: amount / 10 },
        ],
      });
      db.prepare('UPDATE commission_transfers SET je_id=? WHERE id=?').run(jeId, id);
    }
    return db.prepare('SELECT * FROM commission_transfers WHERE id=?').get(id);
  })();
}

/** R13 — ابطال کامل انتقال. */
function voidTransfer(db, id, userId, reason) {
  return db.transaction(() => {
    const t = db.prepare('SELECT * FROM commission_transfers WHERE id=?').get(Number(id));
    if (!t) throw httpErr(404, 'انتقال یافت نشد');
    if (t.status === 'void') return t;
    if (t.status === 'in_payroll') {
      throw httpErr(409, 'این پورسانت در حقوق پردازش‌شده آمده است؛ ابتدا سند حقوق را ابطال کنید', 'E_IN_PAYROLL');
    }
    if (t.je_id) {
      const { reverseJournalEntry } = require('./void-journal');
      reverseJournalEntry(db, t.je_id, {
        userId, reason: reason || `ابطال انتقال پورسانت ${t.doc_no}`, sourceType: 'commission_transfer_reversal',
      });
    }
    db.prepare(`
      UPDATE commission_transfers SET status='void', voided_by=?, voided_at=strftime('%s','now'), void_reason=? WHERE id=?
    `).run(userId || null, String(reason || '').slice(0, 300), t.id);
    return db.prepare('SELECT * FROM commission_transfers WHERE id=?').get(t.id);
  })();
}

function listTransfers(db, { status, person_id } = {}) {
  const where = [];
  const p = [];
  if (status) { where.push('t.status=?'); p.push(String(status)); }
  if (person_id) { where.push('t.person_id=?'); p.push(Number(person_id)); }
  return db.prepare(`
    SELECT t.*, pe.name AS person_name, pp.label AS payroll_period_label, je.voucher_number AS je_no, je.status AS je_status
    FROM commission_transfers t
    LEFT JOIN persons pe ON pe.id=t.person_id
    LEFT JOIN payroll_periods pp ON pp.id=t.payroll_period_id
    LEFT JOIN journal_entries je ON je.id=t.je_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.id DESC LIMIT 500
  `).all(...p);
}

// ── payroll hooks ──

/** Sum of pending payroll transfers for (person, period). */
function pendingPayrollCommission(db, personId, periodId) {
  if (!tableExists(db, 'commission_transfers')) return { amount_rial: 0, ids: [] };
  const rows = db.prepare(`
    SELECT id, amount_rial FROM commission_transfers
    WHERE person_id=? AND payroll_period_id=? AND target='payroll' AND status='pending'
  `).all(Number(personId), Number(periodId));
  return { amount_rial: rows.reduce((a, r) => a + (Number(r.amount_rial) || 0), 0), ids: rows.map((r) => r.id) };
}

function markConsumedByPayroll(db, ids, payrollRecordId) {
  if (!ids || !ids.length) return 0;
  const st = db.prepare(`UPDATE commission_transfers SET status='in_payroll', payroll_record_id=? WHERE id=? AND status='pending'`);
  let n = 0;
  for (const id of ids) n += st.run(payrollRecordId, id).changes;
  return n;
}

/** ابطال حقوق → پورسانت به صف «در انتظار حقوق» برمی‌گردد (قابل پردازش مجدد یا ابطال). */
function releaseFromPayroll(db, payrollRecordId) {
  if (!payrollRecordId || !tableExists(db, 'commission_transfers')) return 0;
  return db.prepare(`
    UPDATE commission_transfers SET status='pending', payroll_record_id=NULL
    WHERE payroll_record_id=? AND status='in_payroll'
  `).run(payrollRecordId).changes;
}

/** Pickers for the commissions page (persons, product groups, open payroll periods, cost centers). */
function commissionMeta(db) {
  const persons = db.prepare(`
    SELECT id, name, personnel_code, employee_no FROM persons WHERE COALESCE(active,1)=1 ORDER BY name LIMIT 2000
  `).all().map((p) => ({ id: p.id, name: p.name, is_employee: isEmployee(p) ? 1 : 0 }));
  const groups = db.prepare('SELECT id, name FROM product_categories ORDER BY name').all();
  const periods = tableExists(db, 'payroll_periods')
    ? db.prepare("SELECT id, label, status FROM payroll_periods WHERE status<>'closed' ORDER BY fiscal_year DESC, month_no DESC LIMIT 24").all()
    : [];
  const costCenters = db.prepare('SELECT id, code, name FROM cost_centers WHERE COALESCE(active,1)=1 ORDER BY code, name').all();
  return { persons, groups, payroll_periods: periods, cost_centers: costCenters };
}

module.exports = {
  commissionMeta,
  isEmployee,
  invoiceNetLines,
  returnNetLines,
  computeContributions,
  commissionReport,
  listRules,
  createRule,
  updateRule,
  deactivateRule,
  getInvoiceParties,
  setInvoiceParties,
  createTransfer,
  voidTransfer,
  listTransfers,
  pendingPayrollCommission,
  markConsumedByPayroll,
  releaseFromPayroll,
};
