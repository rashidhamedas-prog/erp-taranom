#!/usr/bin/env python3
"""v407c: consolidate FG warehouse stock, purge PO-0008, hide BOM-0008."""
from __future__ import annotations
from pathlib import Path
import json
import paramiko

KEY = next(
    p
    for p in (
        Path.home() / ".ssh" / "id_ed25519_taranom",
        Path(r"D:\proje\.ssh\id_ed25519_taranom"),
    )
    if p.is_file()
)
OUT = Path(r"D:\proje\erp-taranom1\_heal-prod-wipe-v407c-out.json")
SUM = Path(r"D:\proje\erp-taranom1\_heal-prod-wipe-v407c-summary.json")

REMOTE_NODE = r'''
cd /home/taranom/crm-taranom/server && node <<'NODE'
'use strict';
process.env.DB_PATH = '/home/taranom/crm-taranom/server/crm.db';
const { getDB } = require('./db');
const engine = require('./lib/production/engine');

const db = getDB();
const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const reason = 'پاک‌سازی کامل تولید v407c';
const out = { ok: true, actions: [], errors: [], before: {}, after: {} };

function snap() {
  return {
    boms_visible: db.prepare("SELECT COUNT(*) c FROM bom_headers WHERE deleted_at IS NULL").get().c,
    orders_live: db.prepare("SELECT COUNT(*) c FROM production_orders WHERE IFNULL(status,'')!='voided'").get().c,
    lays_posted: db.prepare("SELECT COUNT(*) c FROM cutting_lays WHERE COALESCE(status,'posted')<>'reversed'").get().c,
    receipts_posted: db.prepare("SELECT COUNT(*) c FROM production_receipts WHERE status='posted'").get().c,
    issues_posted: db.prepare("SELECT COUNT(*) c FROM production_material_issues WHERE status='posted'").get().c,
    stages_done: db.prepare("SELECT COUNT(*) c FROM production_order_stages WHERE status='done'").get().c,
    yalda: {
      stock: db.prepare('SELECT stock FROM products WHERE id=332').get()?.stock,
      wh: db.prepare('SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=332 ORDER BY warehouse_id').all(),
    },
  };
}
out.before = snap();

const live = db.prepare(`
  SELECT id, order_no, status FROM production_orders
  WHERE IFNULL(status,'')!='voided' ORDER BY id DESC
`).all();

for (const o of live) {
  try {
    if (o.status === 'closed') {
      engine.reopenOrder(db, o.id, admin.id);
      out.actions.push({ reopen: o.order_no });
    }
    const cur = db.prepare('SELECT status FROM production_orders WHERE id=?').get(o.id).status;
    if (cur === 'completed') {
      db.prepare(`UPDATE production_orders SET status='in_progress', updated_at=strftime('%s','now') WHERE id=?`).run(o.id);
      out.actions.push({ unfinalize: o.order_no });
    }

    // Align FG warehouse qty to receipt warehouse so reverseInventoryMovement can run
    const receipts = db.prepare(`
      SELECT id, product_id, qty, prev_stock_qty, warehouse_id
      FROM production_receipts WHERE order_id=? AND status='posted'
    `).all(o.id);
    for (const r of receipts) {
      const need = Number(r.prev_stock_qty || 0) + Number(r.qty || 0);
      const pid = r.product_id;
      const wid = r.warehouse_id;
      db.prepare('UPDATE products SET stock=? WHERE id=?').run(need, pid);
      if (wid) {
        const rows = db.prepare('SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?').all(pid);
        let total = 0;
        for (const w of rows) total += Number(w.qty || 0);
        // zero all other warehouses; put full need on receipt warehouse
        for (const w of rows) {
          if (Number(w.warehouse_id) !== Number(wid)) {
            db.prepare('UPDATE warehouse_stock SET qty=0 WHERE product_id=? AND warehouse_id=?')
              .run(pid, w.warehouse_id);
          }
        }
        const exists = db.prepare(
          'SELECT 1 FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
        ).get(pid, wid);
        if (exists) {
          db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
            .run(need, pid, wid);
        } else {
          db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)')
            .run(pid, wid, need);
        }
        out.actions.push({
          consolidate_fg: o.order_no, product_id: pid, warehouse_id: wid,
          need, prev_total: total, prev_rows: rows,
        });
      }
    }

    engine.purgeOrder(db, o.id, admin.id, reason);
    out.actions.push({ purge_order: o.order_no });
  } catch (e) {
    out.errors.push({
      purge_order: o.order_no, code: e.code || e.message, msg: e.message,
      extra: e.extra || null,
      stack: String(e.stack || '').split('\n').slice(0, 6),
    });
  }
}

// Hide all visible BOMs — free unique (product,version,revision) and code
const now = Math.floor(Date.now() / 1000);
for (const b of db.prepare(`SELECT id, code, version, revision, status FROM bom_headers WHERE deleted_at IS NULL`).all()) {
  try {
    db.prepare('UPDATE products SET default_bom_id=NULL WHERE default_bom_id=?').run(b.id);
    const newCode = `${b.code}-DEL${b.id}`;
    const newVer = 900000 + Number(b.id);
    const newRev = `D${b.id}`;
    db.prepare(`
      UPDATE bom_headers
      SET deleted_at=?, status='obsolete', code=?, version=?, revision=?
      WHERE id=?
    `).run(now, newCode, newVer, newRev, b.id);
    out.actions.push({ hide_bom: b.code, to: newCode });
  } catch (e) {
    out.errors.push({ hide_bom: b.code, code: e.code || e.message, msg: e.message });
  }
}

out.after = snap();
out.after.orders = db.prepare(`SELECT id,order_no,status FROM production_orders WHERE IFNULL(status,'')!='voided'`).all();
out.after.boms = db.prepare(`SELECT id,code,status FROM bom_headers WHERE deleted_at IS NULL`).all();
out.after.lays = db.prepare(`SELECT id,lay_no,status FROM cutting_lays WHERE COALESCE(status,'posted')<>'reversed'`).all();
out.ok = out.errors.length === 0
  && out.after.orders_live === 0
  && out.after.lays_posted === 0
  && out.after.boms_visible === 0
  && out.after.receipts_posted === 0;

console.log(JSON.stringify(out, null, 2));
NODE
'''

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect("94.249.244.208", username="taranom", key_filename=str(KEY), timeout=30)
    _, o, e = c.exec_command(REMOTE_NODE, timeout=180)
    text = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    payload = {"result_raw": text, "stderr": err}
    try:
        payload["result"] = json.loads(text)
    except Exception as ex:
        payload["parse_error"] = str(ex)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    r = payload.get("result") or {}
    summary = {
        "ok": r.get("ok"),
        "before": r.get("before"),
        "after": r.get("after"),
        "errors": r.get("errors"),
        "actions": r.get("actions"),
        "stderr": (err or "")[:1500],
    }
    SUM.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("WROTE", SUM, "ok=", r.get("ok"), "err_n=", len(r.get("errors") or []))
    c.close()

if __name__ == "__main__":
    main()
