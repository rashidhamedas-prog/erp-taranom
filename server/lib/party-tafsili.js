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
  const existing = c.coa_code && String(c.coa_code).trim() ? String(c.coa_code).trim() : '';
  if (existing) {
    if (codeUnderKind(db, existing, 'customer')) {
      if (c.party_id) bindCoa(db, { partyId: c.party_id }, existing);
      return existing;
    }
    // Wrong kind on customer (e.g. AP leaf copied from supplier-first party).
    // Keep AP on linked suppliers, then allocate a fresh AR leaf.
    if (c.party_id && codeUnderKind(db, existing, 'supplier')) {
      const suppliers = db.prepare('SELECT id, coa_code FROM suppliers WHERE party_id=?').all(c.party_id);
      for (const s of suppliers) {
        if (!s.coa_code || !String(s.coa_code).trim()) {
          db.prepare('UPDATE suppliers SET coa_code=? WHERE id=?').run(existing, s.id);
        }
      }
    }
    db.prepare('UPDATE customers SET coa_code=NULL WHERE id=?').run(customerId);
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

function kindMoeinPrefix(db, kind) {
  try {
    const { ensureControlParents } = require('./coa-map');
    const parent = ensureControlParents(db, kind);
    return parent && parent.code ? String(parent.code) : null;
  } catch (_) {
    return null;
  }
}

function codeUnderKind(db, code, kind) {
  const prefix = kindMoeinPrefix(db, kind);
  if (!prefix || !code) return false;
  return String(code).startsWith(prefix);
}

/**
 * ADR-PARTY-001: dual-role party must not use one leaf for AR and AP.
 * parties/customers keep receivable leaf; each linked supplier gets a distinct payable leaf.
 */
function ensureDualRoleSeparateLeaves(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!p) return null;
  const roles = parseRoles(p.party_roles, p.party_type);
  const dual = roles.includes('customer') && roles.includes('supplier');
  if (!dual) return p.coa_code || null;

  let arCode = p.coa_code && String(p.coa_code).trim() ? String(p.coa_code).trim() : null;
  if (!arCode || !codeUnderKind(db, arCode, 'customer')) {
    const cust = db.prepare('SELECT id FROM customers WHERE party_id=?').get(partyId)
      || (p.legacy_table === 'customers' && p.legacy_id
        ? db.prepare('SELECT id FROM customers WHERE id=?').get(p.legacy_id)
        : null);
    if (cust) {
      arCode = ensureCustomerTafsili(db, cust.id);
    } else {
      const name = p.full_name || p.biz || p.company_name || (`شخص ${partyId}`);
      arCode = allocTafsili(db, 'customer', name);
      if (arCode) db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(arCode, partyId);
    }
  } else {
    bindCoa(db, { partyId }, arCode);
    const cust = db.prepare('SELECT id FROM customers WHERE party_id=?').get(partyId);
    if (cust) bindCoa(db, { customerId: cust.id }, arCode);
  }

  const suppliers = db.prepare('SELECT id, name, coa_code FROM suppliers WHERE party_id=?').all(partyId);
  if (p.legacy_table === 'suppliers' && p.legacy_id) {
    const leg = db.prepare('SELECT id, name, coa_code FROM suppliers WHERE id=?').get(p.legacy_id);
    if (leg && !suppliers.some((s) => s.id === leg.id)) suppliers.push(leg);
  }
  for (const s of suppliers) {
    const cur = s.coa_code && String(s.coa_code).trim() ? String(s.coa_code).trim() : '';
    const collide = !cur || cur === arCode || codeUnderKind(db, cur, 'customer') || !codeUnderKind(db, cur, 'supplier');
    if (!collide) continue;
    const name = s.name || p.company_name || p.full_name || (`تأمین‌کننده ${s.id}`);
    const apCode = allocTafsili(db, 'supplier', name);
    if (apCode) db.prepare('UPDATE suppliers SET coa_code=? WHERE id=?').run(apCode, s.id);
  }
  return arCode;
}

/** Allocate (if missing) and dual-write supplier + linked party. */
function ensureSupplierTafsili(db, supplierId) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!s) return null;
  let partyId = s.party_id;
  if (partyId) {
    try {
      const p = db.prepare('SELECT party_roles, party_type FROM parties WHERE id=?').get(partyId);
      const roles = parseRoles(p?.party_roles, p?.party_type);
      if (roles.includes('customer') && roles.includes('supplier')) {
        ensureDualRoleSeparateLeaves(db, partyId);
        const again = db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId);
        if (again && again.coa_code && String(again.coa_code).trim()) return again.coa_code;
      }
    } catch (_) { /* optional */ }
  }
  if (s.coa_code && String(s.coa_code).trim()) {
    // Dual-role: never push supplier AP leaf onto parties header (AR leaf).
    if (partyId) {
      try {
        const p = db.prepare('SELECT party_roles, party_type FROM parties WHERE id=?').get(partyId);
        const roles = parseRoles(p?.party_roles, p?.party_type);
        if (!(roles.includes('customer') && roles.includes('supplier'))) {
          bindCoa(db, { partyId }, s.coa_code);
        }
      } catch (_) {
        bindCoa(db, { partyId }, s.coa_code);
      }
    }
    return s.coa_code;
  }
  const name = s.name || (`تأمین‌کننده ${supplierId}`);
  const code = allocTafsili(db, 'supplier', name);
  if (!code) return null;
  db.prepare('UPDATE suppliers SET coa_code=? WHERE id=?').run(code, supplierId);
  if (!partyId) {
    try {
      const { syncSupplierToParty } = require('./parties-sync');
      partyId = syncSupplierToParty(db, supplierId);
    } catch (_) { /* optional */ }
  }
  if (partyId) {
    try {
      const p = db.prepare('SELECT party_roles, party_type, coa_code FROM parties WHERE id=?').get(partyId);
      const roles = parseRoles(p?.party_roles, p?.party_type);
      if (roles.includes('customer') && roles.includes('supplier')) {
        // keep parties.coa_code as AR; supplier already has AP leaf
      } else if (!p?.coa_code) {
        db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(code, partyId);
      }
    } catch (_) {
      db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(code, partyId);
    }
  }
  return code;
}

/** Allocate (if missing) for a parties row and mirror to legacy customer/supplier. */
function ensurePartyTafsili(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!p) return null;
  const roles = parseRoles(p.party_roles, p.party_type);
  const dual = roles.includes('customer') && roles.includes('supplier');

  if (p.coa_code && String(p.coa_code).trim()) {
    if (p.legacy_table === 'customers' && p.legacy_id) bindCoa(db, { customerId: p.legacy_id }, p.coa_code);
    if (!dual && p.legacy_table === 'suppliers' && p.legacy_id) {
      bindCoa(db, { supplierId: p.legacy_id }, p.coa_code);
    }
    if (dual) return ensureDualRoleSeparateLeaves(db, partyId);
    return p.coa_code;
  }
  const kind = coaKindForRoles(roles);
  const name = p.full_name || p.biz || p.company_name || (`شخص ${partyId}`);
  const code = allocTafsili(db, kind, name);
  if (!code) return null;
  db.prepare('UPDATE parties SET coa_code=? WHERE id=?').run(code, partyId);
  if (p.legacy_table === 'customers' && p.legacy_id) {
    db.prepare("UPDATE customers SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')").run(code, p.legacy_id);
  }
  if (!dual && p.legacy_table === 'suppliers' && p.legacy_id) {
    db.prepare("UPDATE suppliers SET coa_code=? WHERE id=? AND (coa_code IS NULL OR TRIM(coa_code)='')").run(code, p.legacy_id);
  }
  if (dual) return ensureDualRoleSeparateLeaves(db, partyId);
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
  parseRoles,
  ensureCustomerTafsili,
  ensureSupplierTafsili,
  ensurePartyTafsili,
  ensureDualRoleSeparateLeaves,
  backfillMissingPartyTafsili,
  coaKindForRoles,
  codeUnderKind,
};
