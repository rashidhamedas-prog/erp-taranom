'use strict';
/**
 * Opening-cheque Excel/JSON import — preview validation only (no DB write).
 * Commit path reuses createOpeningChequeRow from the route after all rows pass.
 */

const { validateSayadi } = require('./cheque-quality');

function text(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();
}

function num(value) {
  const clean = text(value).replace(/[,\u066C\s]/g, '').replace(/[^\d.-]/g, '');
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}

function field(row, ...names) {
  if (!row || typeof row !== 'object') return '';
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] != null && row[name] !== '') {
      return row[name];
    }
  }
  // case-insensitive / trimmed key fallback
  const keys = Object.keys(row);
  for (const name of names) {
    const want = String(name).trim().toLowerCase();
    const hit = keys.find((k) => String(k).trim().toLowerCase() === want);
    if (hit != null && row[hit] != null && row[hit] !== '') return row[hit];
  }
  return '';
}

function excelDateCell(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const epoch = Date.UTC(1899, 11, 30) + Math.round(value) * 86400000;
    const dt = new Date(epoch);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  }
  return text(value);
}

function isTruthyOpening(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'بله' || s === 'بلی';
}

function assertBranchNotPlaceholder(branch) {
  const b = String(branch == null ? '' : branch).trim();
  if (!b) return;
  const low = b.toLowerCase();
  if (b === '0' || low === 'placeholder' || low === 'n/a' || b === '-' || b === '—' || b === 'ناشناس') {
    const err = new Error('شعبه نامعتبر است — مقدار «0» یا placeholder مجاز نیست');
    err.status = 400;
    err.code = 'E_BRANCH_PLACEHOLDER';
    throw err;
  }
}

/**
 * Resolve party from party_id or customer_id (opening mandatory).
 * Mirrors route resolveChequeParty; kept here for preview without circular require.
 */
function resolvePartyForOpening(db, body) {
  let partyId = parseInt(body && body.party_id, 10);
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const customerId = parseInt(body && body.customer_id, 10);
    if (Number.isFinite(customerId) && customerId > 0) {
      const linked = db.prepare(`
        SELECT id FROM parties
        WHERE legacy_table='customers' AND legacy_id=? AND COALESCE(is_active,1)=1
      `).get(customerId);
      if (linked) partyId = linked.id;
      else {
        try {
          const cust = db.prepare('SELECT party_id FROM customers WHERE id=?').get(customerId);
          if (cust && cust.party_id) partyId = Number(cust.party_id);
        } catch (_) { /* */ }
      }
    }
  }
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const err = new Error('طرف حساب باید از فهرست اشخاص انتخاب شود (party_id یا customer_id)');
    err.status = 400;
    err.code = 'E_CHEQUE_PARTY_REQUIRED';
    throw err;
  }
  const party = db.prepare(`
    SELECT id, full_name, company_name, biz, legacy_table, legacy_id
    FROM parties WHERE id=? AND COALESCE(is_active,1)=1
  `).get(partyId);
  if (!party) {
    const err = new Error('طرف حساب یافت نشد');
    err.status = 400;
    err.code = 'E_CHEQUE_PARTY_INVALID';
    throw err;
  }
  return {
    partyId: party.id,
    partyName: party.full_name || party.company_name || party.biz || '',
    customerId: party.legacy_table === 'customers' && party.legacy_id ? party.legacy_id : null,
  };
}

function findPartyRef(db, raw) {
  const t = text(raw);
  if (!t) return null;
  const asId = parseInt(t, 10);
  if (Number.isFinite(asId) && asId > 0 && String(asId) === t) {
    const byId = db.prepare('SELECT id FROM parties WHERE id=? AND COALESCE(is_active,1)=1').get(asId);
    if (byId) return byId.id;
  }
  const row = db.prepare(`
    SELECT id FROM parties
    WHERE COALESCE(is_active,1)=1 AND (
      person_code=? OR full_name=? OR company_name=? OR biz=? OR phone=?
    )
    LIMIT 1
  `).get(t, t, t, t, t);
  return row ? row.id : null;
}

/**
 * Normalize one import source row (Excel object or JSON) → create body or errors.
 * @param {object} ctx { db, direction, seenSayads: Set, existingSayadStmt }
 */
function validateOpeningImportRow(raw, rowIndex, ctx) {
  const db = ctx.db;
  const direction = ctx.direction === 'out' ? 'out' : 'in';
  const errors = [];
  const rowNo = rowIndex + 1;

  const chequeNumber = text(field(raw, 'شماره چک*', 'شماره چک', 'cheque_number'));
  const amountRial = Math.round(num(field(raw, 'مبلغ (ریال)*', 'مبلغ (ریال)', 'amount', 'مبلغ')));
  if (!chequeNumber && !amountRial) {
    return { ok: false, skipped: true, row: rowNo, errors: [] };
  }
  if (!chequeNumber) errors.push({ code: 'E_CHEQUE_NUMBER', message: `ردیف ${rowNo}: شماره چک الزامی است` });
  if (!amountRial || amountRial <= 0) {
    errors.push({ code: 'E_CHEQUE_AMOUNT', message: `ردیف ${rowNo}: مبلغ (ریال) باید عدد مثبت باشد` });
  }
  if (amountRial > 1e15) {
    errors.push({ code: 'E_CHEQUE_AMOUNT', message: `ردیف ${rowNo}: مبلغ خارج از محدوده مجاز است` });
  }

  const branch = text(field(raw, 'شعبه', 'branch'));
  try {
    assertBranchNotPlaceholder(branch);
  } catch (e) {
    errors.push({ code: e.code || 'E_BRANCH_PLACEHOLDER', message: `ردیف ${rowNo}: ${e.message}` });
  }

  const rawSay = text(field(raw, 'شماره صیادی', 'صیاد', 'sayadi', 'sayad'));
  let sayDigits = '';
  if (!rawSay) {
    errors.push({
      code: 'E_SAYAD_REQUIRED',
      message: `ردیف ${rowNo}: شناسه صیاد برای چک اول دوره الزامی است (۱۶ رقم)`,
    });
  } else {
    const sayV = validateSayadi(rawSay);
    if (!sayV.ok) {
      errors.push({
        code: sayV.code === 'E_SAYAD_INVALID' && !sayV.digits ? 'E_SAYAD_REQUIRED' : sayV.code,
        message: `ردیف ${rowNo}: ${sayV.message}`,
      });
    } else {
      sayDigits = sayV.digits;
      if (ctx.seenSayads && ctx.seenSayads.has(sayDigits)) {
        errors.push({ code: 'E_SAYAD_DUP', message: `ردیف ${rowNo}: شناسه صیاد تکراری در فایل است` });
      } else {
        const dup = db.prepare(`
          SELECT id FROM cheque_records
          WHERE COALESCE(record_status,'posted')='posted'
            AND direction=?
            AND TRIM(sayadi)=?
          LIMIT 1
        `).get(direction, sayDigits);
        if (dup) {
          errors.push({
            code: 'E_SAYAD_DUP',
            message: `ردیف ${rowNo}: شناسه صیاد تکراری است`,
            existing_id: dup.id,
          });
        }
      }
      if (ctx.seenSayads && sayDigits) ctx.seenSayads.add(sayDigits);
    }
  }

  let partyId = parseInt(field(raw, 'party_id'), 10);
  let customerId = parseInt(field(raw, 'customer_id'), 10);
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const partyRef = field(raw, 'طرف حساب*', 'طرف حساب', 'party_name', 'کد شخص');
    if (partyRef !== '' && partyRef != null) {
      const found = findPartyRef(db, partyRef);
      if (found) partyId = found;
      else errors.push({ code: 'E_CHEQUE_PARTY_INVALID', message: `ردیف ${rowNo}: طرف حساب یافت نشد` });
    }
  }
  if ((!Number.isFinite(partyId) || partyId <= 0) && (!Number.isFinite(customerId) || customerId <= 0)) {
    errors.push({
      code: 'E_CHEQUE_PARTY_REQUIRED',
      message: `ردیف ${rowNo}: طرف حساب (party_id یا customer_id) الزامی است`,
    });
  }

  let party = null;
  if (!errors.some((e) => String(e.code || '').startsWith('E_CHEQUE_PARTY'))) {
    try {
      party = resolvePartyForOpening(db, {
        party_id: Number.isFinite(partyId) && partyId > 0 ? partyId : undefined,
        customer_id: Number.isFinite(customerId) && customerId > 0 ? customerId : undefined,
      });
    } catch (e) {
      errors.push({ code: e.code || 'E_CHEQUE_PARTY_REQUIRED', message: `ردیف ${rowNo}: ${e.message}` });
    }
  }

  const body = {
    direction,
    opening: true,
    from_excel: true,
    cheque_number: chequeNumber,
    amount: amountRial,
    issue_date: excelDateCell(field(raw, 'تاریخ صدور', 'issue_date')),
    receive_date: excelDateCell(field(raw, 'تاریخ دریافت', 'receive_date')),
    due_date: excelDateCell(field(raw, 'تاریخ سررسید', 'due_date')),
    bank_name: text(field(raw, 'بانک', 'bank_name')),
    branch,
    sayadi: sayDigits || rawSay,
    sheba: text(field(raw, 'شبا', 'sheba')),
    account_number: text(field(raw, 'شماره حساب', 'account_number')),
    party_id: party ? party.partyId : (Number.isFinite(partyId) ? partyId : null),
    customer_id: party ? party.customerId : (Number.isFinite(customerId) ? customerId : null),
    status: text(field(raw, 'وضعیت')) || 'مانده اول دوره',
    status_note: text(field(raw, 'شرح وضعیت', 'status_note')),
    note: text(field(raw, 'شرح', 'note')),
    sayad_registered: isTruthyOpening(field(raw, 'sayad_registered', 'ثبت در صیاد')) ? 1 : 0,
    sayad_tracking_code: text(field(raw, 'sayad_tracking_code', 'کد پیگیری صیاد')),
    beneficiary_national_id: text(field(raw, 'beneficiary_national_id', 'کد ملی ذینفع')),
    is_guarantee: isTruthyOpening(field(raw, 'is_guarantee', 'تضمینی')) ? 1 : 0,
  };

  return {
    ok: errors.length === 0,
    skipped: false,
    row: rowNo,
    errors,
    body,
    party_name: party ? party.partyName : '',
  };
}

/**
 * Validate a list of rows. No DB writes.
 * @returns {{ ok, direction, rows, errors, valid_bodies, summary }}
 */
function previewOpeningImport(db, { direction, rows }) {
  const dir = direction === 'out' ? 'out' : 'in';
  const list = Array.isArray(rows) ? rows : [];
  const seenSayads = new Set();
  const out = [];
  const validBodies = [];
  const allErrors = [];
  let skipped = 0;

  list.forEach((raw, i) => {
    const result = validateOpeningImportRow(raw, i, { db, direction: dir, seenSayads });
    if (result.skipped) {
      skipped += 1;
      return;
    }
    out.push({
      row: result.row,
      ok: result.ok,
      errors: result.errors,
      cheque_number: result.body && result.body.cheque_number,
      amount: result.body && result.body.amount,
      sayadi: result.body && result.body.sayadi,
      party_id: result.body && result.body.party_id,
      party_name: result.party_name || '',
      body: result.ok ? result.body : undefined,
    });
    if (result.ok) validBodies.push(result.body);
    else allErrors.push(...result.errors);
  });

  return {
    ok: allErrors.length === 0 && validBodies.length > 0,
    direction: dir,
    row_count: list.length,
    skipped_blank: skipped,
    valid_count: validBodies.length,
    error_count: allErrors.length,
    rows: out,
    errors: allErrors,
    valid_bodies: validBodies,
    summary: {
      total: list.length - skipped,
      valid: validBodies.length,
      invalid: out.filter((r) => !r.ok).length,
      skipped_blank: skipped,
    },
  };
}

module.exports = {
  text,
  num,
  field,
  excelDateCell,
  isTruthyOpening,
  assertBranchNotPlaceholder,
  resolvePartyForOpening,
  validateOpeningImportRow,
  previewOpeningImport,
};
