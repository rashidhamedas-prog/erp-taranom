'use strict';

function parseRoles(raw) {
  try { return raw ? JSON.parse(raw) : []; } catch (_) { return []; }
}

function ensurePersonnelPartyGroup(db) {
  let g = db.prepare("SELECT id FROM party_groups WHERE name='پرسنل'").get();
  if (!g) {
    const nextCode = db.prepare('SELECT COALESCE(MAX(code),0)+1 AS c FROM party_groups').get().c;
    g = {
      id: db.prepare('INSERT INTO party_groups (code,name,entity_type,description) VALUES (?,?,?,?)')
        .run(nextCode, 'پرسنل', 'person', 'اشخاص این گروه در پرونده کارکنان ظاهر می‌شوند').lastInsertRowid,
    };
  }
  return g.id;
}

function isPersonnelParty(db, party) {
  const roles = parseRoles(party.party_roles);
  if (roles.includes('employee') || roles.includes('partner')) return true;
  if (!party.party_group_id) return false;
  const g = db.prepare('SELECT name, entity_type FROM party_groups WHERE id=?').get(party.party_group_id);
  return !!(g && (g.entity_type === 'person' || (g.name && String(g.name).includes('پرسنل'))));
}

function syncPartyToPerson(db, partyId) {
  const p = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!p || !isPersonnelParty(db, p)) return null;
  const name = p.full_name || p.biz || p.company_name || '';
  if (!name) return null;
  const roles = parseRoles(p.party_roles);
  let groupId = p.party_group_id || null;
  if (roles.includes('employee')) {
    const g = groupId ? db.prepare('SELECT name, entity_type FROM party_groups WHERE id=?').get(groupId) : null;
    if (!g || !(g.name && String(g.name).includes('پرسنل'))) {
      if (!g || g.entity_type !== 'person') groupId = ensurePersonnelPartyGroup(db);
    }
  } else if (!groupId) {
    groupId = ensurePersonnelPartyGroup(db);
  }
  const existing = db.prepare('SELECT * FROM persons WHERE party_id=?').get(partyId);
  const positionId = p.position_id || null;
  if (existing) {
    db.prepare(`
      UPDATE persons SET name=?, phone=?, address=?, note=?, party_group_id=?,
        national_id=?, birth_date=?, coa_code=?, position_id=?, active=1
      WHERE id=?
    `).run(
      name, p.phone || '', p.address || '', p.notes || '', groupId,
      p.national_id || '', p.birth_date || '', p.coa_code || '', positionId, existing.id
    );
    return existing.id;
  }
  const r = db.prepare(`
    INSERT INTO persons (name, phone, address, note, party_id, party_group_id, national_id, birth_date, coa_code, position_id, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    name, p.phone || '', p.address || '', p.notes || '', partyId, groupId,
    p.national_id || '', p.birth_date || '', p.coa_code || '', positionId
  );
  return r.lastInsertRowid;
}

function ensurePersonParty(db, personId) {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
  if (!person) return null;
  if (person.party_id) {
    const party = db.prepare('SELECT * FROM parties WHERE id=?').get(person.party_id);
    if (party) {
      const roles = parseRoles(party.party_roles);
      if (!roles.includes('employee')) roles.push('employee');
      db.prepare(`
        UPDATE parties SET full_name=?, phone=?, notes=?, party_group_id=?, national_id=?,
          party_roles=?, is_active=?, updated_at=strftime('%s','now')
        WHERE id=?
      `).run(
        person.name, person.phone || party.phone || '-', person.note || '',
        person.party_group_id || party.party_group_id, person.national_id || party.national_id,
        JSON.stringify(roles), person.active == null ? 1 : (person.active ? 1 : 0), party.id
      );
      return party.id;
    }
  }
  const staffGid = person.party_group_id || ensurePersonnelPartyGroup(db);
  let coaCode = person.coa_code || null;
  if (!coaCode) {
    try { coaCode = require('./coa-map').allocTafsili(db, 'person', person.name); } catch (_) { /* optional */ }
  }
  const phone = String(person.phone || '').trim();
  if (phone) {
    const existingByPhone = db.prepare('SELECT * FROM parties WHERE phone=? AND is_active=1').get(phone);
    if (existingByPhone) {
      db.prepare('UPDATE persons SET party_id=? WHERE id=?').run(existingByPhone.id, person.id);
      return existingByPhone.id;
    }
  }
  const code = 'EMP-' + String(person.id).padStart(5, '0');
  const r = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, notes, biz, party_group_id, coa_code, national_id, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    code, 'other', JSON.stringify(['employee']), person.name, phone || ('emp-' + person.id),
    person.note || '', person.name, staffGid, coaCode, person.national_id || null,
    person.active == null ? 1 : (person.active ? 1 : 0)
  );
  db.prepare('UPDATE persons SET party_id=? WHERE id=?').run(r.lastInsertRowid, person.id);
  return r.lastInsertRowid;
}

function deactivateLinkedPerson(db, partyId) {
  try { db.prepare('UPDATE persons SET active=0 WHERE party_id=?').run(partyId); } catch (_) { /* ignore */ }
}

function looksLikeEmployee(person) {
  return !!(
    (person.personnel_code && String(person.personnel_code).trim())
    || (person.employee_no && String(person.employee_no).trim())
    || person.employee_group_id
  );
}

function runPersonPartyUnifyV1(db) {
  const has = (name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!has('persons') || !has('parties') || !has('party_groups')) {
    return { skipped: true, reason: 'schema' };
  }
  const done = db.prepare("SELECT value FROM settings WHERE key='person_party_unify_v1'").get();
  if (done && done.value === '1') return { skipped: true };

  return db.transaction(() => {
    let linked = 0;
    let created = 0;
    let forwarded = 0;
    const orphans = db.prepare('SELECT * FROM persons WHERE party_id IS NULL').all();
    for (const person of orphans) {
      let party = null;
      const nid = String(person.national_id || '').trim();
      if (nid) {
        party = db.prepare('SELECT * FROM parties WHERE national_id=? AND is_active=1').get(nid);
      }
      const phone = String(person.phone || '').trim();
      if (!party && phone) {
        party = db.prepare('SELECT * FROM parties WHERE phone=? AND is_active=1').get(phone);
      }
      if (party) {
        const taken = db.prepare('SELECT id FROM persons WHERE party_id=?').get(party.id);
        if (!taken) {
          db.prepare('UPDATE persons SET party_id=? WHERE id=?').run(party.id, person.id);
          linked += 1;
          continue;
        }
      }
      if (looksLikeEmployee(person)) {
        ensurePersonParty(db, person.id);
        created += 1;
      }
    }

    const parties = db.prepare('SELECT id FROM parties WHERE COALESCE(is_active,1)=1').all();
    for (const row of parties) {
      const party = db.prepare('SELECT * FROM parties WHERE id=?').get(row.id);
      if (!isPersonnelParty(db, party)) continue;
      const has = db.prepare('SELECT id FROM persons WHERE party_id=?').get(party.id);
      if (!has) {
        syncPartyToPerson(db, party.id);
        forwarded += 1;
      }
    }

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('person_party_unify_v1','1')").run();
    return { skipped: false, linked, created, forwarded };
  })();
}

module.exports = {
  syncPartyToPerson,
  ensurePersonParty,
  isPersonnelParty,
  ensurePersonnelPartyGroup,
  deactivateLinkedPerson,
  runPersonPartyUnifyV1,
};
