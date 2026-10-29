#!/usr/bin/env python3
"""PV readonly probes on Iran production — SELECT only."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
HOST = "taranom@94.249.244.208"
DB = "/home/taranom/crm-taranom/server/data/crm.db"
OUT = Path(__file__).resolve().parents[1] / "reports" / "pv-2026-10-29-data.md"

SQL_BLOCKS = {
    "10_separators": r"""
SELECT 'settings_sep' AS src, key, value FROM settings
 WHERE key LIKE 'coa_%' AND (value LIKE '%,%' OR value LIKE '%٬%' OR value LIKE '% %');
SELECT 'wh_non_digit' AS src, id, inventory_coa_code, cogs_coa_code FROM warehouses
 WHERE inventory_coa_code GLOB '*[^0-9]*' OR IFNULL(cogs_coa_code,'') GLOB '*[^0-9]*';
""",
    "11_accounts": r"""
SELECT code,name,is_active,
  (SELECT COUNT(*) FROM journal_lines l WHERE l.account_code=c.code) n
FROM chart_of_accounts c
WHERE code IN ('1104','110401','110402','110403','1110','1111','3102','3201','5101','610801','1201')
ORDER BY code;
""",
    "12_warehouses": r"""
SELECT id,name,active,kind,warehouse_type,inventory_system,allow_negative,
       inventory_coa_code,cogs_coa_code
FROM warehouses WHERE id BETWEEN 33 AND 37 ORDER BY id;
""",
    "9_flags": r"""
SELECT key,value FROM settings
 WHERE key IN ('vat_rate','coa_vat_payable','coa_vat_receivable',
               'ledger_leaf_enforcement','coa_product_tafsili_mode')
 ORDER BY key;
SELECT role, COUNT(*) AS n FROM users WHERE active=1 GROUP BY role ORDER BY role;
""",
    "13_gl_1104": r"""
SELECT SUM(debit_rial)-SUM(credit_rial) AS bal_1104
FROM journal_lines l
JOIN journal_entries e ON e.id=l.entry_id
WHERE l.account_code LIKE '1104%'
  AND e.deleted_at IS NULL
  AND COALESCE(e.status,'posted')='posted';
""",
    "16_adjust_no_je": r"""
SELECT id,product_id,warehouse_id,amount_rial,event_type,status
FROM inventory_ledger
WHERE event_type LIKE '%adjust%' AND je_id IS NULL AND IFNULL(status,'')<>'void'
ORDER BY id;
""",
    "18_3201_and_1977": r"""
SELECT id,product_id,warehouse_id,qty_in,qty_out,amount_rial,event_type,je_id,status
FROM inventory_ledger WHERE id=1977;
SELECT COUNT(*) AS n3201_lines FROM journal_lines WHERE account_code='3201';
SELECT id,entry_id,account_code,debit_rial,credit_rial FROM journal_lines WHERE entry_id=490;
SELECT id,product_id,warehouse_id,amount_rial,event_type FROM inventory_ledger WHERE id=1230;
""",
    "15_return_null_wh": r"""
SELECT COUNT(*) AS n, IFNULL(SUM(amount_rial),0) AS amt
FROM inventory_ledger
WHERE event_type LIKE '%return%' AND warehouse_id IS NULL AND IFNULL(status,'')<>'void';
SELECT id,product_id,warehouse_id,amount_rial,je_id,event_type
FROM inventory_ledger
WHERE event_type LIKE '%return%' AND warehouse_id IS NULL AND IFNULL(status,'')<>'void'
ORDER BY id LIMIT 40;
""",
    "14_zero_in_transfers": r"""
SELECT COUNT(*) AS zero_in_wh35
FROM inventory_ledger
WHERE warehouse_id=35 AND IFNULL(amount_rial,0)=0 AND qty_in>0
  AND IFNULL(status,'')<>'void'
  AND (event_type LIKE '%transfer%' OR event_type LIKE '%xfer%' OR source_type LIKE '%transfer%');
""",
}


NODE_RO = r"""
const Database = require('better-sqlite3');
const db = new Database(process.env.PV_DB, { readonly: true, fileMustExist: true });
const sql = require('fs').readFileSync(0, 'utf8');
const stmts = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
for (const s of stmts) {
  try {
    const rows = db.prepare(s).all();
    console.log('---');
    console.log(s.replace(/\s+/g, ' ').slice(0, 120));
    if (!rows.length) { console.log('(empty)'); continue; }
    console.log(JSON.stringify(rows, null, 0));
  } catch (e) {
    console.log('ERR', e.message, '::', s.slice(0, 80));
  }
}
"""


def ssh_sql(name: str, sql: str) -> str:
    remote = (
        f"cd /home/taranom/crm-taranom/server && "
        f"PV_DB={DB} node -e {json.dumps(NODE_RO)}"
    )
    cmd = [
        "ssh",
        "-i",
        str(KEY),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=20",
        HOST,
        remote,
    ]
    p = subprocess.run(cmd, input=sql.encode("utf-8"), capture_output=True)
    out = (p.stdout or b"").decode("utf-8", "replace")
    err = (p.stderr or b"").decode("utf-8", "replace")
    if p.returncode != 0:
        return f"ERROR rc={p.returncode}\n{err}\n{out}"
    return out.strip() or "(empty)"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    parts = ["# PV data checks 10–19 (readonly prod)", "", f"DB: `{DB}`", ""]
    results = {}
    for name, sql in SQL_BLOCKS.items():
        print(f"== {name} ==")
        text = ssh_sql(name, sql)
        print(text[:500])
        results[name] = text
        parts.append(f"## {name}")
        parts.append("```")
        parts.append(text)
        parts.append("```")
        parts.append("")
    OUT.write_text("\n".join(parts), encoding="utf-8")
    meta = OUT.with_suffix(".json")
    meta.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
