'use strict';
/**
 * Phase 4C — party cheque turnover (دریافتی / خرج‌شده / برگشتی).
 * Read-only aggregation over cheque_records.
 */

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function amountExpr(db) {
  if (tableHasColumn(db, 'cheque_records', 'amount_rial')) {
    return 'COALESCE(NULLIF(amount_rial,0), amount, 0)';
  }
  return 'COALESCE(amount, 0)';
}

function aliveSql(db) {
  const parts = ["COALESCE(record_status,'posted')<>'reversed'"];
  if (tableHasColumn(db, 'cheque_records', 'reversed_at')) {
    parts.push('COALESCE(reversed_at,0)=0');
  }
  return parts.join(' AND ');
}

function emptyPayload(warning) {
  return {
    generated_at: Date.now(),
    warning: warning || '',
    from: '',
    to: '',
    party_id: null,
    parties: [],
    totals: {
      received_count: 0,
      received_rial: 0,
      endorsed_count: 0,
      endorsed_rial: 0,
      bounced_count: 0,
      bounced_rial: 0,
    },
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ from?: string, to?: string, party_id?: number|string, limit?: number }} opts
 */
function buildPartyChequeTurnover(db, opts) {
  const options = opts || {};
  try {
    if (!tableExists(db, 'cheque_records')) {
      return emptyPayload('جدول چک در دسترس نیست');
    }
    const amt = amountExpr(db);
    const lc = tableHasColumn(db, 'cheque_records', 'lifecycle_status')
      ? 'lifecycle_status'
      : 'status';
    const hasPartyId = tableHasColumn(db, 'cheque_records', 'party_id');
    const hasEndorseParty = tableHasColumn(db, 'cheque_records', 'endorse_party_id');
    const from = String(options.from || '').trim();
    const to = String(options.to || '').trim();
    const partyFilter = options.party_id != null && options.party_id !== ''
      ? Number(options.party_id)
      : null;
    const lim = Math.min(Math.max(parseInt(options.limit, 10) || 100, 1), 500);

    const dateCol = tableHasColumn(db, 'cheque_records', 'receive_date')
      ? "COALESCE(NULLIF(receive_date,''), NULLIF(issue_date,''), NULLIF(due_date,''))"
      : "COALESCE(NULLIF(issue_date,''), NULLIF(due_date,''))";

    const where = [aliveSql(db)];
    const params = [];
    if (from) {
      where.push(`(${dateCol}) >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`(${dateCol}) <= ?`);
      params.push(to);
    }
    if (Number.isFinite(partyFilter) && partyFilter > 0 && hasPartyId) {
      if (hasEndorseParty) {
        where.push('(party_id=? OR endorse_party_id=?)');
        params.push(partyFilter, partyFilter);
      } else {
        where.push('party_id=?');
        params.push(partyFilter);
      }
    }

    const rows = db.prepare(`
      SELECT id, direction, cheque_number, party_name,
             ${hasPartyId ? 'party_id' : 'NULL AS party_id'},
             ${hasEndorseParty ? 'endorse_party_id' : 'NULL AS endorse_party_id'},
             ${amt} AS amount_rial, ${lc} AS lc,
             ${dateCol} AS doc_date, due_date, bank_name
      FROM cheque_records
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT 5000
    `).all(...params);

    const byParty = new Map();
    const ensure = (key, name, partyId) => {
      if (!byParty.has(key)) {
        byParty.set(key, {
          party_key: key,
          party_id: partyId || null,
          party_name: name || '—',
          received_count: 0,
          received_rial: 0,
          endorsed_count: 0,
          endorsed_rial: 0,
          bounced_count: 0,
          bounced_rial: 0,
          items: { received: [], endorsed: [], bounced: [] },
        });
      }
      return byParty.get(key);
    };

    const totals = {
      received_count: 0,
      received_rial: 0,
      endorsed_count: 0,
      endorsed_rial: 0,
      bounced_count: 0,
      bounced_rial: 0,
    };

    const pushItem = (bucket, row, kind) => {
      const amtR = Math.round(Number(row.amount_rial) || 0);
      bucket[`${kind}_count`] += 1;
      bucket[`${kind}_rial`] += amtR;
      totals[`${kind}_count`] += 1;
      totals[`${kind}_rial`] += amtR;
      if (bucket.items[kind].length < 20) {
        bucket.items[kind].push({
          id: row.id,
          cheque_number: row.cheque_number || '',
          direction: row.direction,
          amount_rial: amtR,
          lifecycle_status: row.lc || '',
          due_date: row.due_date || '',
          doc_date: row.doc_date || '',
          bank_name: row.bank_name || '',
        });
      }
    };

    for (const row of rows) {
      const lcVal = String(row.lc || '').toLowerCase();
      const dir = String(row.direction || '');
      const partyId = row.party_id != null ? Number(row.party_id) : null;
      const partyKey = partyId && partyId > 0
        ? `id:${partyId}`
        : `name:${String(row.party_name || '').trim() || 'unknown'}`;
      const bucket = ensure(partyKey, row.party_name, partyId);

      // دریافتی: چک in نزد طرف
      if (dir === 'in') {
        pushItem(bucket, row, 'received');
      }

      // خرج‌شده / ظهرنویسی
      const isEndorsed = lcVal === 'endorsed' || lcVal === 'expensed'
        || (hasEndorseParty && row.endorse_party_id);
      if (isEndorsed) {
        // If endorse_party_id differs, also attribute to endorsee
        if (hasEndorseParty && row.endorse_party_id
            && Number(row.endorse_party_id) !== partyId) {
          const epId = Number(row.endorse_party_id);
          const ep = ensure(`id:${epId}`, row.party_name || `طرف #${epId}`, epId);
          pushItem(ep, row, 'endorsed');
        } else {
          pushItem(bucket, row, 'endorsed');
        }
      }

      // برگشتی
      if (lcVal === 'bounced' || lcVal === 'bounced_out') {
        pushItem(bucket, row, 'bounced');
      }
    }

    let parties = [...byParty.values()];
    parties.sort((a, b) => {
      const ta = a.received_rial + a.endorsed_rial + a.bounced_rial;
      const tb = b.received_rial + b.endorsed_rial + b.bounced_rial;
      return tb - ta;
    });
    parties = parties.slice(0, lim);

    return {
      generated_at: Date.now(),
      warning: '',
      from,
      to,
      party_id: Number.isFinite(partyFilter) && partyFilter > 0 ? partyFilter : null,
      parties,
      totals,
    };
  } catch (e) {
    console.error('cheque-party-turnover:', e && e.message);
    return emptyPayload('گزارش گردش چک طرف‌حساب با خطا ساخته شد');
  }
}

module.exports = { buildPartyChequeTurnover };
