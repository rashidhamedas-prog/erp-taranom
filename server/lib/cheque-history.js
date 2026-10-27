'use strict';
/**
 * Read-only cheque leaf detail + chronological history (ADR-CHEQUE-LEAF-001).
 * Reconstructs from journal_entries + audit_log — no cheque_events table.
 */

const { statusLabelFor, normalizeLifecycle, isOpeningCheque } = require('./cheque-lifecycle');

const REF_LABEL = {
  opening_cheque: 'افتتاحیه چک',
  opening_cheque_reversal: 'معکوس افتتاحیه',
  cheque_in: 'ثبت اسناد دریافتنی',
  cheque_in_reversal: 'معکوس ثبت دریافتنی',
  cheque_send_to_bank: 'واگذاری به بانک',
  cheque_clear: 'وصول',
  cheque_bounce: 'برگشت',
  cheque_resend: 'ارسال مجدد (معکوس برگشت)',
  cheque_endorse: 'خرج / ظهرنویسی',
  cheque_pay: 'پرداخت / تحویل',
  cheque_expense: 'خرج چک پرداختنی',
  cheque_lifecycle_reversal: 'معکوس مرحله چرخه',
  settlement: 'تسویه فاکتور (ثبت چک)',
  supplier_payment: 'پرداخت تأمین‌کننده',
};

function labelForRef(refType) {
  const t = String(refType || '');
  if (REF_LABEL[t]) return REF_LABEL[t];
  if (t.endsWith('_reversal')) return 'معکوس سند';
  return t || 'رویداد';
}

function enrichChequeRow(db, row) {
  if (!row) return null;
  let collection_bank_name = '';
  if (row.collection_bank_id) {
    try {
      const b = db.prepare('SELECT name FROM banks WHERE id=?').get(row.collection_bank_id);
      collection_bank_name = (b && b.name) || '';
    } catch (_) { /* */ }
  }
  let invoice_num = '';
  if (row.invoice_id) {
    try {
      const inv = db.prepare('SELECT num FROM invoices WHERE id=?').get(row.invoice_id);
      invoice_num = (inv && inv.num) || '';
    } catch (_) { /* */ }
  }
  const lc = normalizeLifecycle(row);
  return {
    ...row,
    lifecycle_normalized: lc,
    lifecycle_label: statusLabelFor(row),
    direction_label: row.direction === 'out' ? 'پرداختی' : 'دریافتی',
    is_opening: isOpeningCheque(row),
    collection_bank_name,
    invoice_num,
  };
}

function loadJournalLines(db, entryId) {
  try {
    return db.prepare(`
      SELECT account_code, account_name,
             COALESCE(debit_rial, debit*10, 0) AS debit_rial,
             COALESCE(credit_rial, credit*10, 0) AS credit_rial,
             debit, credit
      FROM journal_lines WHERE entry_id=?
      ORDER BY id
    `).all(entryId);
  } catch (_) {
    return db.prepare(`
      SELECT account_code, account_name, debit, credit,
             (debit*10) AS debit_rial, (credit*10) AS credit_rial
      FROM journal_lines WHERE entry_id=?
      ORDER BY id
    `).all(entryId);
  }
}

function buildChequeHistory(db, chequeId) {
  const id = parseInt(chequeId, 10);
  if (!Number.isFinite(id) || id <= 0) return [];
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(id);
  if (!row) return null;

  const events = [];
  const jeIds = new Set();

  const chequeRefs = db.prepare(`
    SELECT id, entry_date, description, ref_type, ref_id, created_at, created_by,
           COALESCE(deleted_at,0) AS deleted_at, voucher_number
    FROM journal_entries
    WHERE ref_id=? AND (
      ref_type LIKE 'cheque%'
      OR ref_type LIKE 'opening_cheque%'
    )
    ORDER BY COALESCE(created_at,0) ASC, id ASC
  `).all(id);

  for (const je of chequeRefs) {
    jeIds.add(je.id);
    events.push({
      kind: 'journal',
      at: Number(je.created_at) || 0,
      date: je.entry_date || '',
      title: labelForRef(je.ref_type),
      detail: je.description || '',
      ref_type: je.ref_type,
      journal_entry_id: je.id,
      voucher_number: je.voucher_number || '',
      reversed: Number(je.deleted_at) > 0,
      lines: loadJournalLines(db, je.id),
    });
  }

  if (row.settlement_id) {
    const settJes = db.prepare(`
      SELECT id, entry_date, description, ref_type, ref_id, created_at, created_by,
             COALESCE(deleted_at,0) AS deleted_at, voucher_number
      FROM journal_entries
      WHERE ref_type='settlement' AND ref_id=?
      ORDER BY COALESCE(created_at,0) ASC, id ASC
    `).all(row.settlement_id);
    for (const je of settJes) {
      if (jeIds.has(je.id)) continue;
      jeIds.add(je.id);
      events.push({
        kind: 'journal',
        at: Number(je.created_at) || 0,
        date: je.entry_date || '',
        title: labelForRef('settlement'),
        detail: je.description || '',
        ref_type: je.ref_type,
        journal_entry_id: je.id,
        voucher_number: je.voucher_number || '',
        reversed: Number(je.deleted_at) > 0,
        lines: loadJournalLines(db, je.id),
      });
    }
  }

  // Pointer columns that might not have matched ref_type (defensive)
  for (const col of ['journal_entry_id', 'collection_je_id', 'cleared_je_id', 'bounced_je_id', 'reversal_journal_id']) {
    const jid = Number(row[col]) || 0;
    if (jid <= 0 || jeIds.has(jid)) continue;
    const je = db.prepare(`
      SELECT id, entry_date, description, ref_type, ref_id, created_at,
             COALESCE(deleted_at,0) AS deleted_at, voucher_number
      FROM journal_entries WHERE id=?
    `).get(jid);
    if (!je) continue;
    jeIds.add(je.id);
    events.push({
      kind: 'journal',
      at: Number(je.created_at) || 0,
      date: je.entry_date || '',
      title: labelForRef(je.ref_type) + (col === 'reversal_journal_id' ? ' (ابطال)' : ''),
      detail: je.description || '',
      ref_type: je.ref_type,
      journal_entry_id: je.id,
      voucher_number: je.voucher_number || '',
      reversed: Number(je.deleted_at) > 0,
      lines: loadJournalLines(db, je.id),
    });
  }

  let audits = [];
  try {
    audits = db.prepare(`
      SELECT id, action, detail, created_at, user_id
      FROM audit_log
      WHERE entity='cheque_record' AND entity_id=?
      ORDER BY COALESCE(created_at,0) ASC, id ASC
    `).all(id);
  } catch (_) {
    audits = [];
  }

  const ACTION_FA = {
    create: 'ثبت ردیف دفتر',
    update: 'به‌روزرسانی وضعیت نمایشی',
    reverse: 'ابطال کامل',
    cheque_send_bank: 'واگذاری (ممیزی)',
    cheque_clear: 'وصول (ممیزی)',
    cheque_bounce: 'برگشت (ممیزی)',
    cheque_resend: 'ارسال مجدد (ممیزی)',
    cheque_endorse: 'خرج (ممیزی)',
    cheque_pay: 'پرداخت (ممیزی)',
    cheque_expense: 'خرج پرداختنی (ممیزی)',
  };

  for (const a of audits) {
    events.push({
      kind: 'audit',
      at: Number(a.created_at) || 0,
      date: '',
      title: ACTION_FA[a.action] || a.action || 'ممیزی',
      detail: a.detail || '',
      ref_type: null,
      journal_entry_id: null,
      voucher_number: '',
      reversed: false,
      lines: [],
      audit_action: a.action,
    });
  }

  // Created-at anchor if no create audit
  if (row.created_at && !events.some((e) => e.kind === 'audit' && e.audit_action === 'create')) {
    events.push({
      kind: 'meta',
      at: Number(row.created_at) || 0,
      date: row.receive_date || row.issue_date || '',
      title: 'ثبت در دفتر چک',
      detail: row.created_by_name ? `ثبت‌کننده: ${row.created_by_name}` : '',
      ref_type: null,
      journal_entry_id: null,
      voucher_number: '',
      reversed: false,
      lines: [],
    });
  }

  // cheque_events table (v562+) — merge without duplicating JE rows
  try {
    const { listChequeEvents } = require('./cheque-events');
    const cev = listChequeEvents(db, id);
    for (const ev of cev) {
      const jid = Number(ev.journal_entry_id) || 0;
      if (jid > 0 && jeIds.has(jid)) {
        // annotate existing journal event
        const hit = events.find((e) => e.journal_entry_id === jid);
        if (hit) hit.cheque_event_id = ev.id;
        continue;
      }
      events.push({
        kind: 'cheque_event',
        at: Number(ev.created_at) || 0,
        date: ev.event_date || '',
        title: `${statusLabelFor(ev.from_status) || ev.from_status || '—'} → ${statusLabelFor(ev.to_status) || ev.to_status}`,
        detail: ev.note || '',
        ref_type: null,
        journal_entry_id: jid || null,
        voucher_number: '',
        reversed: !!ev.reverses_event_id,
        lines: jid ? loadJournalLines(db, jid) : [],
        cheque_event_id: ev.id,
        from_status: ev.from_status,
        to_status: ev.to_status,
      });
      if (jid) jeIds.add(jid);
    }
  } catch (_) { /* */ }

  events.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    const ao = a.journal_entry_id || 0;
    const bo = b.journal_entry_id || 0;
    return ao - bo;
  });

  return events;
}

module.exports = {
  REF_LABEL,
  labelForRef,
  enrichChequeRow,
  buildChequeHistory,
};
