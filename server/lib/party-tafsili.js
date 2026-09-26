/**
 * Ensure parties / CRM customers / suppliers always have a 12-digit COA tafsili.
 * Historically customers/suppliers only got allocTafsili when coa_mode=mahak,
 * while /api/parties always allocated — so CRM creates (e.g. distribution_office)
 * left CUST-* rows with empty coa_code.
 */
const { allocTafsili } = require('./coa-map');

function parseRoles(raw, partyType) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch (_) { /* fall through */ }
  }
  if (partyType === 'both') return ['customer', 'supplier'];
  if (partyType === 'supplier') return ['supplier'];
  if (partyType === 'other') return ['other'];
  return ['customer'];
}

function coaKindForRoles(roles) {
  if (roles.includes('customer')) return 'customer';
  if (roles.includes('supplier')) return 'supplier';
  return 'person';
}

function bindCoa(db, { partyId, customerId, supplierId }, code) {
  if (!code) return;
  if (partyId) {
    db.prepare("UPDATE parties SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')").run(code, partyId);
  }
  if (customerId) {
    db.prepare("UPDATE customers SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')").run(code, customerId);
  }
  if (supplierId) {
    db.prepare("UPDATE suppliers SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')").run(code, supplierId);
  }
}

/** Allocate (if missing) and dual-write customer + linked party. */
function ensureCustomerTafsili(db, customerId) {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  if (!c) return null;
  if (c.coa_code && String(c.coa_code).trim()) {
    if (c.party_id) bindCoa(db, { partyId: c.party_id }, c.coa_code);
    return c.coa_code;
  }
  const name = c.biz || c.owner || c.company_name || (`مشتری ${customerId}`);
  const code = allocTafsili(db, 'customer', name);
  if (!code) return null;
  db.prepare('UPDATE customers SET coa_code=? WHERE id=?').run(code, customerId);
  let partyId = c.party_id;
  if (!partyId) {
    try {
      const { syncCustomerToParty } = require('./parties-sync');
      partyId = syncCustomerToParty(db, customerId);
    } catch (_) { /* party sync optional during early boot */ }
  }
  if (partyId) db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(code, partyId);
  return code;
}

/** Allocate (if missing) and dual-write supplier + linked party. */
function ensureSupplierTafsili(db, supplierId) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!s) return null;
  if (s.coa_code && String(s.coa_code).trim()) {
    if (s.party_id) bindCoa(db, { partyId: s.party_id }, s.coa_code);
    return s.coa_code;
  }
  const name = s.name || (`تأمین‌کننده ${supplierId}`);
  const code = allocTafsili(db, 'supplier', name);
  if (!code) return null;
  db.prepare('UPDATE suppliers SET coa_code=? WHERE id=?').run(code, supplierId);
  let partyId = s.party_id;
  if (!partyId) {
    try {
      const { syncSupplierToParty } = require('./parties-sync');
      partyId = syncSupplierToParty(db, supplierId);
    } catch (_) { /* optional */ }
  }
  if (partyId) db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(code, partyId);
  return code;
}

/** Allocate (if missing) for a parties row and mirror to legacy customer/supplier. */
function ensurePartyTafsili(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!p) return null;
  if (p.coa_code && String(p.coa_code).trim()) {
    if (p.legacy_table === 'customers' && p.legacy_id) bindCoa(db, { customerId: p.legacy_id }, p.coa_code);
    if (p.legacy_table === 'suppliers' && p.legacy_id) bindCoa(db, { supplierId: p.legacy_id }, p.coa_code);
    return p.coa_code;
  }
  const roles = parseRoles(p.party_roles, p.party_type);
  const kind = coaKindForRoles(roles);
  const name = p.full_name || p.biz || p.company_name || (`شخص ${partyId}`);
  const code = allocTafsili(db, kind, name);
  if (!code) return null;
  db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(code, partyId);
  if (p.legacy_table === 'customers' && p.legacy_id) {
    db.prepare("UPDATE customers SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')").run(code, p.legacy_id);
  }
  if (p.legacy_table === 'suppliers' && p.legacy_id) {
    db.prepare("UPDATE suppliers SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')").run(code, p.legacy_id);
  }
  return code;
}

/**
 * One-shot boot repair: fill coa_code for active parties (and linked CRM rows) that lack it.
 * Idempotent via settings.party_tafsili_backfill_v1.
 */
function backfillMissingPartyTafsili(db) {
  const flag = db.prepare("SELECT value FROM settings WHERE key='party_tafsili_backfill_v1'").get();
  if (flag && flag.value === '1') return { skipped: true, filled: 0 };

  const missing = db.prepare(`
    SELECT id FROM parties
    WHERE COALESCE(is_active,1)=1
      AND (coa_code IS NULL OR TRIM(coa_code)='')
  `).all();

  let filled = 0;
  const codes = [];
  const tx = db.transaction(() => {
    for (const row of missing) {
      const code = ensurePartyTafsili(db, row.id);
      if (code) {
        filled++;
        codes.push({ party_id: row.id, coa_code: code });
      }
    }
    // Orphan CRM customers without party link
    const orphanCust = db.prepare(`
      SELECT id FROM customers
      WHERE (coa_code IS NULL OR TRIM(coa_code)='')
        AND (party_id IS NULL OR party_id=0)
    `).all();
    for (const row of orphanCust) {
      const code = ensureCustomerTafsili(db, row.id);
      if (code) {
        filled++;
        codes.push({ customer_id: row.id, coa_code: code });
      }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('party_tafsili_backfill_v1','1')").run();
  });
  tx();
  return { skipped: false, filled, sample: codes.slice(0, 10) };
}

module.exports = {
  ensureCustomerTafsili,
  ensureSupplierTafsili,
  ensurePartyTafsili,
  backfillMissingPartyTafsili,
  coaKindForRoles,
};
