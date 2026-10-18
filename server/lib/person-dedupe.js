'use strict';

/**
 * Person phone-dedupe helpers (v450).
 *
 * Root cause of duplicate BOM labor-creditor rows: syncPartyToPerson /
 * ensurePersonForParty only matched on party_id, so two parties sharing a phone
 * (or an orphan person + later party sync) created two persons with the same
 * name/phone. Picker then listed both.
 */

function normalizePersonPhone(phone) {
  return String(phone == null ? '' : phone).replace(/\s+/g, '').trim();
}

function personSurvivorScore(row) {
  const active = Number(row && row.active) ? 2 : 0;
  const linked = row && row.party_id != null ? 1 : 0;
  // Prefer older id as stable when scores tie (historical BOM refs often on first row).
  const idBoost = row && row.id != null ? (1 / (1 + Number(row.id))) : 0;
  return active + linked + idBoost;
}

function pickPersonSurvivor(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  return list.slice().sort((a, b) => personSurvivorScore(b) - personSurvivorScore(a))[0];
}

function findPersonByPhone(db, phone) {
  const p = normalizePersonPhone(phone);
  if (!p) return null;
  const rows = db.prepare(`
    SELECT * FROM persons WHERE TRIM(IFNULL(phone,'')) = ? ORDER BY id ASC
  `).all(p);
  return pickPersonSurvivor(rows);
}

function findPersonForParty(db, partyId) {
  const id = Number(partyId) || 0;
  if (!id) return null;
  const byParty = db.prepare('SELECT * FROM persons WHERE party_id=? ORDER BY id ASC LIMIT 1').get(id);
  if (byParty) return byParty;
  const party = db.prepare('SELECT id, phone, national_id FROM parties WHERE id=?').get(id);
  if (!party) return null;
  const nid = String(party.national_id || '').trim();
  if (nid) {
    const byNid = db.prepare(`
      SELECT * FROM persons WHERE TRIM(IFNULL(national_id,'')) = ? ORDER BY active DESC, id ASC LIMIT 1
    `).get(nid);
    if (byNid) return byNid;
  }
  return findPersonByPhone(db, party.phone);
}

/**
 * Deduplicate a persons list for UI pickers: one row per normalized phone
 * (empty phone → keep by id). Prefer active + linked survivors.
 */
function dedupePersonsForPicker(rows, opts) {
  const selectedId = opts && opts.selectedId != null ? Number(opts.selectedId) : null;
  const onlyActive = !!(opts && opts.onlyActive);
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  for (const row of list) {
    if (!row) continue;
    if (onlyActive && !Number(row.active) && Number(row.id) !== selectedId) continue;
    const phone = normalizePersonPhone(row.phone);
    const key = phone || ('id:' + String(row.id));
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    // Always keep selected id visible even if not the natural survivor.
    if (selectedId != null && Number(row.id) === selectedId) {
      byKey.set(key, row);
      continue;
    }
    if (selectedId != null && Number(prev.id) === selectedId) continue;
    byKey.set(key, pickPersonSurvivor([prev, row]));
  }
  return [...byKey.values()].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'fa')
  );
}

/**
 * Boot heal: for each non-empty phone with >1 person, keep survivor active-preference
 * and soft-deactivate the rest (no physical delete, no FK rewrite).
 */
function runPersonPhoneDedupeHealV450(db) {
  const done = db.prepare("SELECT value FROM settings WHERE key='person_phone_dedupe_v450'").get();
  if (done && done.value === '1') return { skipped: true };

  return db.transaction(() => {
    const groups = db.prepare(`
      SELECT phone FROM persons
      WHERE TRIM(IFNULL(phone,'')) <> ''
      GROUP BY TRIM(phone)
      HAVING COUNT(*) > 1
    `).all();
    let deactivated = 0;
    let groupsTouched = 0;
    for (const g of groups) {
      const phone = normalizePersonPhone(g.phone);
      const rows = db.prepare(`
        SELECT id, name, phone, active, party_id FROM persons
        WHERE TRIM(IFNULL(phone,'')) = ?
        ORDER BY id ASC
      `).all(phone);
      if (rows.length < 2) continue;
      const survivor = pickPersonSurvivor(rows);
      if (!survivor) continue;
      groupsTouched += 1;
      for (const row of rows) {
        if (Number(row.id) === Number(survivor.id)) continue;
        if (Number(row.active)) {
          db.prepare('UPDATE persons SET active=0 WHERE id=?').run(row.id);
          deactivated += 1;
        }
      }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('person_phone_dedupe_v450','1')").run();
    return { skipped: false, groupsTouched, deactivated };
  })();
}

module.exports = {
  normalizePersonPhone,
  pickPersonSurvivor,
  findPersonByPhone,
  findPersonForParty,
  dedupePersonsForPicker,
  runPersonPhoneDedupeHealV450,
};
