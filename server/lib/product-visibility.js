/**
 * Product-group visibility for non-admin users:
 * - is_shared=1 → visible to all authenticated users
 * - else → only creator, admin, accounting
 * Optional per-user ACL (user_catalog_categories) further restricts catalog/picker lists.
 */

function canSeeAllProductGroups(user) {
  return !!(user && (user.role === 'admin' || user.role === 'accounting'));
}

/** null = no per-user ACL rows (still apply is_shared). Array = restrict to these category ids. */
function userCatalogAclIds(db, user) {
  if (!user || canSeeAllProductGroups(user)) return null;
  try {
    const rows = db.prepare('SELECT category_id FROM user_catalog_categories WHERE user_id=?').all(user.id);
    if (!rows.length) return null;
    return rows.map(r => r.category_id);
  } catch (_) {
    return null;
  }
}

function addProductGroupVisibility(user, where, params, alias = 'p', categoryAlias = 'pc') {
  if (!canSeeAllProductGroups(user)) {
    where.push(
      `(${alias}.category_id IS NULL OR ${categoryAlias}.id IS NULL OR ${categoryAlias}.is_shared=1 OR ${categoryAlias}.created_by=?)`
    );
    params.push(user.id);
  }
}

function addCatalogAclFilter(db, user, where, params, alias = 'p') {
  const allowed = userCatalogAclIds(db, user);
  if (allowed && allowed.length) {
    where.push(`${alias}.category_id IN (${allowed.map(() => '?').join(',')})`);
    params.push(...allowed);
  }
  return allowed;
}

module.exports = {
  canSeeAllProductGroups,
  userCatalogAclIds,
  addProductGroupVisibility,
  addCatalogAclFilter,
};
