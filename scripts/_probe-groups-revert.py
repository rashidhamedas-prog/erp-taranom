#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe Iran: git + COA/groups counts + nav files."""
from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
APP = "/home/taranom/crm-taranom"


def main() -> None:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        "94.249.244.208",
        username="taranom",
        pkey=paramiko.Ed25519Key.from_private_key_file(str(KEY)),
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )

    def run(cmd, timeout=90):
        print("==>", cmd[:180].replace("\n", " "))
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        print(out)
        print("EXIT", o.channel.recv_exit_status())
        return out

    run(f"cd {APP} && git log -10 --oneline && echo --- && git status -sb && echo --- && git rev-parse --short HEAD")
    run(
        f"cd {APP}/server && ls -la crm.db 2>/dev/null; ls -la backups 2>/dev/null | tail -15; "
        "ls -lt *.db* 2>/dev/null | head -10"
    )
    run(
        f"cd {APP}/server && node <<'NODE'\n"
        "const Database=require('better-sqlite3');\n"
        "const path=require('path');\n"
        "const fs=require('fs');\n"
        "const candidates=['./crm.db','./data/crm.db',process.env.DB_PATH].filter(Boolean);\n"
        "let dbPath=null;\n"
        "for (const p of candidates){ try{ if(fs.existsSync(p)){ dbPath=p; break; } }catch(_){} }\n"
        "if(!dbPath){\n"
        "  const found=[];\n"
        "  function walk(d,n){ if(n>4)return; for(const e of fs.readdirSync(d,{withFileTypes:true})){\n"
        "    const fp=path.join(d,e.name);\n"
        "    if(e.isFile()&&e.name==='crm.db') found.push(fp);\n"
        "    else if(e.isDirectory()&&!['node_modules','backups','.git'].includes(e.name)) walk(fp,n+1);\n"
        "  }}\n"
        "  walk('.',0); dbPath=found[0]||null; console.log('found',found);\n"
        "}\n"
        "console.log('DB', dbPath);\n"
        "const db=new Database(dbPath,{readonly:true});\n"
        "const names=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name);\n"
        "const interesting=names.filter(n=>/group|categor|coa|account|party|product|customer|person|ledger|invoice|journal/i.test(n));\n"
        "console.log('tables', interesting.join(','));\n"
        "for (const t of interesting){\n"
        "  try{ const c=db.prepare('SELECT COUNT(*) c FROM '+t).get().c; console.log(t+':'+c);}catch(e){console.log(t+':ERR');}\n"
        "}\n"
        "try{\n"
        "  const sample=db.prepare('SELECT code,name,parent_code FROM accounts ORDER BY code LIMIT 15').all();\n"
        "  console.log('accounts_sample', JSON.stringify(sample));\n"
        "}catch(e){ console.log('accounts_sample_err', e.message); }\n"
        "try{\n"
        "  const g=db.prepare(\"SELECT id,name FROM party_groups LIMIT 10\").all();\n"
        "  console.log('party_groups_sample', JSON.stringify(g));\n"
        "}catch(e){}\n"
        "try{\n"
        "  const g=db.prepare(\"SELECT id,name FROM product_categories LIMIT 10\").all();\n"
        "  console.log('product_categories_sample', JSON.stringify(g));\n"
        "}catch(e){}\n"
        "NODE"
    )
    run(
        f"cd {APP} && "
        "wc -l server/public/acc-nav.js server/public/index.html; "
        "head -5 server/public/acc-nav.js; "
        "grep -n 'ACC_NAV_SECTIONS\\|اطلاعات پایه\\|سرگروه\\|nav-acc-head' server/public/acc-nav.js | head -20; "
        "grep -n 'ledger_balance\\|balNatureBadgeHtml\\|erp-taranom-v11' server/public/sw.js server/routes/accounting.js server/public/index.html | head -20"
    )
    run(
        f"cd {APP} && "
        "git log --oneline --all -- server/public/acc-nav.js | head -8; "
        "git diff HEAD -- server/public/acc-nav.js | head -40; "
        "git diff HEAD -- server/routes/products.js | head -60"
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
