#!/usr/bin/env python3
"""v407b: finish wipe — unfinalize PO-0008, purge, hide remaining BOMs, fix stock."""
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
OUT = Path(r"D:\proje\erp-taranom1\_heal-prod-wipe-v407b-out.json")

REMOTE_NODE = r'''
cd /home/taranom/crm-taranom/server && node <<'NODE'
'use strict';
const path = require('path');
process.env.DB_PATH = '/home/taranom/crm-taranom/server/crm.db';
const { getDB } = require('./db');
const engine = require('./lib/production/engine');
const cutting = require('./lib/production/cutting');

const db = getDB();
const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const user = { id: admin.id };
const reason = 'پاک‌سازی کامل تولید v407b — شروع مجدد';
const out = { ok: true, actions: [], errors: [], before: {}, after: {} };

function snap() {
  return {
    boms_visible: db.prepare("SELECT COUNT(*) c FROM bom_headers WHERE deleted_at IS NULL").get().c,
    orders_live: db.prepare("SELECT COUNT(*) c FROM production_orders WHERE IFNULL(status,'')!='voided'").get().c,
    lays_posted: db.prepare("SELECT COUNT(*) c FROM cutting_lays WHERE COALESCE(status,'posted')<>'reversed'").get().c,
    packs_posted: db.prepare("SELECT COUNT(*) c FROM cutting_packs WHERE COALESCE(status,'posted')<>'reversed'").get().c,
    receipts_posted: db.prepare("SELECT COUNT(*) c FROM production_receipts WHERE status='posted'").get().c,
    issues_posted: db.prepare("SELECT COUNT(*) c FROM production_material_issues WHERE status='posted'").get().c,
    stages_done: db.prepare("SELECT COUNT(*) c FROM production_order_stages WHERE status='done'").get().c,
    yalda_stock: db.prepare('SELECT stock FROM products WHERE id=332').get()?.stock,
  };
}
out.before = snap();

// Ensure leftover packs/lays voided
for (const p of db.prepare(`SELECT id, pack_no FROM cutting_packs WHERE COALESCE(status,'posted')<>'reversed'`).all()) {
  try { cutting.voidCuttingPack(db, p.id, user, { reason }); out.actions.push({ void_pack: p.pack_no }); }
  catch (e) { out.errors.push({ void_pack: p.id, code: e.code || e.message }); }
}
for (const L of db.prepare(`SELECT id, lay_no FROM cutting_lays WHERE COALESCE(status,'posted')<>'reversed'`).all()) {
  try { cutting.voidCuttingLay(db, L.id, user, { reason }); out.actions.push({ void_lay: L.lay_no }); }
  catch (e) { out.errors.push({ void_lay: L.id, code: e.code || e.message }); }
}

const live = db.prepare(`
  SELECT id, order_no, status, analysis_type FROM production_orders
  WHERE IFNULL(status,'')!='voided' ORDER BY id DESC
`).all();

for (const o of live) {
  try {
    if (o.status === 'closed') {
      engine.reopenOrder(db, o.id, user.id);
      out.actions.push({ reopen: o.order_no });
      o.status = 'completed';
    }
    // reverseStage rejects completed — drop to in_progress for purge path
    if (o.status === 'completed') {
      db.prepare(`
        UPDATE production_orders SET status='in_progress', updated_at=strftime('%s','now') WHERE id=?
      `).run(o.id);
      out.actions.push({ unfinalize: o.order_no });
    }

    const receipts = db.prepare(`
      SELECT id, product_id, qty, prev_stock_qty, warehouse_id
      FROM production_receipts WHERE order_id=? AND status='posted'
    `).all(o.id);
    for (const r of receipts) {
      const need = Number(r.prev_stock_qty || 0) + Number(r.qty || 0);
      const cur = Number(db.prepare('SELECT stock FROM products WHERE id=?').get(r.product_id)?.stock || 0);
      if (cur + 0.0001 < need) {
        const delta = need - cur;
        db.prepare('UPDATE products SET stock=? WHERE id=?').run(need, r.product_id);
        if (r.warehouse_id) {
          try {
            db.prepare(`
              UPDATE warehouse_stock SET qty=COALESCE(qty,0)+?
              WHERE warehouse_id=? AND product_id=?
            `).run(delta, r.warehouse_id, r.product_id);
          } catch (_) {}
        }
        out.actions.push({ inflate: o.order_no, product_id: r.product_id, from: cur, to: need });
      }
    }

    engine.purgeOrder(db, o.id, user.id, reason);
    out.actions.push({ purge_order: o.order_no });
  } catch (e) {
    out.errors.push({
      purge_order: o.order_no, code: e.code || e.message, msg: e.message,
      extra: e.extra || null, stack: String(e.stack || '').split('\n').slice(0, 4),
    });
  }
}

// Soft-hide remaining visible BOMs without deactivate (avoids unique/draft collisions)
const now = Math.floor(Date.now() / 1000);
for (const b of db.prepare(`SELECT id, code, status, version, revision FROM bom_headers WHERE deleted_at IS NULL`).all()) {
  try {
    db.prepare(`UPDATE products SET default_bom_id=NULL WHERE default_bom_id=?`).run(b.id);
    // bump version into reserved negative space to free unique (product,version,revision)
    const newVer = -100000 - Number(b.id);
    db.prepare(`
      UPDATE bom_headers
      SET deleted_at=?, status='obsolete', version=?, revision=COALESCE(revision,0)
      WHERE id=?
    `).run(now, newVer, b.id);
    out.actions.push({ hide_bom: b.code, was: b.status, version: newVer });
  } catch (e) {
    out.errors.push({ hide_bom: b.code, code: e.code || e.message, msg: e.message });
  }
}

out.after = snap();
out.after.orders = db.prepare(`SELECT id,order_no,status FROM production_orders WHERE IFNULL(status,'')!='voided'`).all();
out.after.boms = db.prepare(`SELECT id,code,status FROM bom_headers WHERE deleted_at IS NULL`).all();
out.after.lays = db.prepare(`SELECT id,lay_no,status FROM cutting_lays WHERE COALESCE(status,'posted')<>'reversed'`).all();
out.after.posted_receipts = db.prepare(`
  SELECT id, order_id, doc_no, status FROM production_receipts WHERE status='posted'
`).all();
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
        "actions_n": len(r.get("actions") or []),
        "stderr": (err or "")[:1200],
    }
    OUT.with_name("_heal-prod-wipe-v407b-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("ok=", r.get("ok"), "errors=", r.get("errors"), "after=", r.get("after"))
    c.close()

if __name__ == "__main__":
    main()
