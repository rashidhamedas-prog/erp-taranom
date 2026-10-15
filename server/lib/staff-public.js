'use strict';
/**
 * Public staff identity for login /auth/me.
 * Sales warehouse is part of the CRM session (locked source WH), not a secret.
 */
function publicStaffUser(db, user) {
  if (!user) return null;
  const rawWh = user.sales_warehouse_id;
  const whId = rawWh == null || rawWh === '' ? null : (Number(rawWh) || null);
  let sales_warehouse_name = '';
  if (whId) {
    try {
      const w = db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId);
      sales_warehouse_name = (w && w.name) ? String(w.name) : '';
    } catch (_) {}
  }
  const rawCb = user.sales_cash_box_id;
  const cashBoxId = rawCb == null || rawCb === '' ? null : (Number(rawCb) || null);
  let sales_cash_box_name = '';
  if (cashBoxId) {
    try {
      const b = db.prepare('SELECT name FROM cash_boxes WHERE id=?').get(cashBoxId);
      sales_cash_box_name = (b && b.name) ? String(b.name) : '';
    } catch (_) {}
  }
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    phone: user.phone || '',
    sales_warehouse_id: whId,
    sales_warehouse_name,
    sales_cash_box_id: cashBoxId,
    sales_cash_box_name,
  };
}

module.exports = { publicStaffUser };
