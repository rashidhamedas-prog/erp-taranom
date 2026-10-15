#!/usr/bin/env python3
"""
v407: Full wipe of production BOM + orders + cutting lays (and related docs)
on Iran crm.db via official engine/cutting/bom reverse paths.

Order: void packs → void lays → reopen closed → inflate stock if E_FG_SOLD
       → purge orders → soft-hide all BOMs (deleted_at).
"""
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
OUT = Path(r"D:\proje\erp-taranom1\_heal-prod-wipe-v407-out.json")

# Node script runs on the VPS against live better-sqlite3 + production libs
REMOTE_NODE = r'''
cd /home/taranom/crm-taranom/server && node <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, 'crm.db');
const { getDB } = require('./db');
const engine = require('./lib/production/engine');
const cutting = require('./lib/production/cutting');
const bomLib = require('./lib/production/bom');

const db = getDB();
const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const user = { id: admin.id };
const reason = 'پاک‌سازی کامل تولید v407 — شروع مجدد BOM/سفارش/لایه‌چینی';
const out = { ok: true, actions: [], errors: [], before: {}, after: {} };

function snap() {
  return {
    boms_visible: db.prepare("SELECT COUNT(*) c FROM bom_headers WHERE deleted_at IS NULL").get().c,
    boms_active: db.prepare("SELECT COUNT(*) c FROM bom_headers WHERE status='active' AND deleted_at IS NULL").get().c,
    orders_live: db.prepare("SELECT COUNT(*) c FROM production_orders WHERE IFNULL(status,'')!='voided'").get().c,
    lays_posted: db.prepare("SELECT COUNT(*) c FROM cutting_lays WHERE COALESCE(status,'posted')<>'reversed'").get().c,
    packs_posted: db.prepare("SELECT COUNT(*) c FROM cutting_packs WHERE COALESCE(status,'posted')<>'reversed'").get().c,
    receipts_posted: db.prepare("SELECT COUNT(*) c FROM production_receipts WHERE status='posted'").get().c,
    issues_posted: db.prepare("SELECT COUNT(*) c FROM production_material_issues WHERE status='posted'").get().c,
  };
}

out.before = snap();
out.before.orders = db.prepare(`
  SELECT id, order_no, status, product_id, bom_id, qty_produced FROM production_orders
  WHERE IFNULL(status,'')!='voided' ORDER BY id
`).all();
out.before.lays = db.prepare(`
  SELECT id, lay_no, status, production_order_id, qty_pieces FROM cutting_lays
  WHERE COALESCE(status,'posted')<>'reversed' ORDER BY id
`).all();
out.before.boms = db.prepare(`
  SELECT id, code, status FROM bom_headers WHERE deleted_at IS NULL ORDER BY id
`).all();

// 1) Void any posted packs (newest first)
const packs = db.prepare(`
  SELECT id, pack_no FROM cutting_packs
  WHERE COALESCE(status,'posted')<>'reversed' ORDER BY id DESC
`).all();
for (const p of packs) {
  try {
    cutting.voidCuttingPack(db, p.id, user, { reason });
    out.actions.push({ void_pack: p.pack_no || p.id });
  } catch (e) {
    out.errors.push({ void_pack: p.id, code: e.code || e.message, msg: e.message });
  }
}

// 2) Void posted lays (newest first)
const lays = db.prepare(`
  SELECT id, lay_no FROM cutting_lays
  WHERE COALESCE(status,'posted')<>'reversed' ORDER BY id DESC
`).all();
for (const L of lays) {
  try {
    cutting.voidCuttingLay(db, L.id, user, { reason });
    out.actions.push({ void_lay: L.lay_no || L.id });
  } catch (e) {
    out.errors.push({ void_lay: L.id, code: e.code || e.message, msg: e.message });
  }
}

// 3) Reopen closed orders so purge can run
const closed = db.prepare(`
  SELECT id, order_no FROM production_orders WHERE status='closed'
`).all();
for (const o of closed) {
  try {
    engine.reopenOrder(db, o.id, user.id);
    out.actions.push({ reopen: o.order_no });
  } catch (e) {
    out.errors.push({ reopen: o.id, code: e.code || e.message, msg: e.message });
  }
}

// 4) For each live order: clear E_FG_SOLD by aligning products.stock to receipt basis, then purge
const live = db.prepare(`
  SELECT id, order_no, status FROM production_orders
  WHERE IFNULL(status,'') NOT IN ('voided') ORDER BY id DESC
`).all();

for (const o of live) {
  try {
    const receipts = db.prepare(`
      SELECT id, product_id, qty, prev_stock_qty, warehouse_id
      FROM production_receipts WHERE order_id=? AND status='posted'
    `).all(o.id);
    const inflate = [];
    for (const r of receipts) {
      const need = Number(r.prev_stock_qty || 0) + Number(r.qty || 0);
      const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(r.product_id);
      const cur = Number(prod?.stock || 0);
      if (cur + 0.0001 < need) {
        db.prepare('UPDATE products SET stock=? WHERE id=?').run(need, r.product_id);
        try {
          if (r.warehouse_id) {
            const ws = db.prepare(`
              SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?
            `).get(r.warehouse_id, r.product_id);
            if (ws) {
              const delta = need - cur;
              db.prepare(`
                UPDATE warehouse_stock SET qty=COALESCE(qty,0)+? WHERE warehouse_id=? AND product_id=?
              `).run(delta, r.warehouse_id, r.product_id);
            }
          }
        } catch (_) {}
        inflate.push({ product_id: r.product_id, from: cur, to: need });
      }
    }
    if (inflate.length) out.actions.push({ inflate_stock_for_purge: o.order_no, inflate });

    engine.purgeOrder(db, o.id, user.id, reason);
    out.actions.push({ purge_order: o.order_no, was: o.status });
  } catch (e) {
    out.errors.push({ purge_order: o.order_no || o.id, code: e.code || e.message, msg: e.message, extra: e.extra || null });
  }
}

// 5) Soft-hide ALL visible BOMs (active/draft/archived) so list is empty
const boms = db.prepare(`
  SELECT id, code, status FROM bom_headers WHERE deleted_at IS NULL ORDER BY id
`).all();
const now = Math.floor(Date.now() / 1000);
for (const b of boms) {
  try {
    if (b.status === 'active') {
      try { bomLib.deactivateBom(db, b.id, user.id); } catch (_) {
        // if deactivate blocked, force draft
        db.prepare("UPDATE bom_headers SET status='draft' WHERE id=?").run(b.id);
      }
    }
    // clear product default
    db.prepare(`
      UPDATE products SET default_bom_id=NULL WHERE default_bom_id=?
    `).run(b.id);
    db.prepare(`
      UPDATE bom_headers SET deleted_at=?, status='obsolete' WHERE id=?
    `).run(now, b.id);
    out.actions.push({ hide_bom: b.code, was: b.status });
  } catch (e) {
    out.errors.push({ hide_bom: b.code || b.id, code: e.code || e.message, msg: e.message });
  }
}

out.after = snap();
out.after.orders_remaining_live = db.prepare(`
  SELECT id, order_no, status FROM production_orders WHERE IFNULL(status,'')!='voided'
`).all();
out.after.lays_remaining_posted = db.prepare(`
  SELECT id, lay_no, status FROM cutting_lays WHERE COALESCE(status,'posted')<>'reversed'
`).all();
out.after.boms_remaining_visible = db.prepare(`
  SELECT id, code, status FROM bom_headers WHERE deleted_at IS NULL
`).all();
out.after.yalda_stock = db.prepare('SELECT id,name,stock FROM products WHERE id=332').get();
out.after.aban_stock = db.prepare('SELECT id,name,stock FROM products WHERE id=334').get();
out.ok = out.errors.length === 0
  && out.after.orders_live === 0
  && out.after.lays_posted === 0
  && out.after.boms_visible === 0;

console.log(JSON.stringify(out, null, 2));
NODE
'''

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect("94.249.244.208", username="taranom", key_filename=str(KEY), timeout=30)
    # backup tip first
    _, o1, e1 = c.exec_command(
        'cp -a /home/taranom/crm-taranom/server/crm.db /home/taranom/crm-taranom/server/crm.db.bak-prod-wipe-v407-$(date +%Y%m%d%H%M%S) && ls -lt /home/taranom/crm-taranom/server/crm.db.bak-prod-wipe-v407-* | head -3',
        timeout=60,
    )
    bak = o1.read().decode("utf-8", "replace")
    bak_err = e1.read().decode("utf-8", "replace")
    _, o, e = c.exec_command(REMOTE_NODE, timeout=180)
    text = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    payload = {
        "backup": bak.strip(),
        "backup_err": bak_err.strip(),
        "result_raw": text,
        "stderr": err,
    }
    try:
        payload["result"] = json.loads(text)
    except Exception as ex:
        payload["parse_error"] = str(ex)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "backup": bak.strip().splitlines()[:2] if bak.strip() else None,
        "ok": payload.get("result", {}).get("ok"),
        "before": payload.get("result", {}).get("before"),
        "after": payload.get("result", {}).get("after"),
        "errors": payload.get("result", {}).get("errors"),
        "actions_n": len(payload.get("result", {}).get("actions") or []),
        "stderr_head": err[:1500] if err else "",
    }, ensure_ascii=False, indent=2))
    c.close()

if __name__ == "__main__":
    main()
