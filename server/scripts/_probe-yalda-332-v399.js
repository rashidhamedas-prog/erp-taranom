'use strict';
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
const pid = 332;
console.log(JSON.stringify({
  product: db.prepare('SELECT id,code,name,stock FROM products WHERE id=?').get(pid),
  orders: db.prepare(`
    SELECT id,order_no,status,qty_planned,qty_produced FROM production_orders WHERE product_id=?
  `).all(pid),
  receipts: db.prepare(`
    SELECT id,doc_no,order_id,qty,status,date,amount_rial FROM production_receipts WHERE product_id=?
  `).all(pid),
  packs: db.prepare(`
    SELECT id,pack_no,qty,production_order_id,status,date FROM cutting_packs WHERE product_id=?
  `).all(pid),
  fg_ledger: db.prepare(`
    SELECT id,event_type,qty_in,qty_out,note,source_type,source_id,status,date
    FROM inventory_ledger
    WHERE product_id=? AND status='posted' AND qty_in>0
      AND event_type IN ('production_receipt','cutting_pack')
    ORDER BY id
  `).all(pid),
}, null, 2));
