#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from pathlib import Path
import paramiko
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(
    "94.249.244.208",
    username="taranom",
    pkey=paramiko.Ed25519Key.from_private_key_file(str(Path.home() / ".ssh" / "id_ed25519_taranom")),
    timeout=30,
    allow_agent=False,
    look_for_keys=False,
)
cmd = r"""
cd /home/taranom/crm-taranom
echo '=== ACC_NAV module titles ==='
grep -E "title: '" server/public/acc-nav.js | head -40
echo '=== main NAV labels matching screenshot ==='
grep -nE 'عملیات حسابداری|عملیات خاص|پورتال عملیاتی|اطلاعات پایه|دارایی ثابت|امکانات|NAV_ADMIN' server/public/index.html | head -50
echo '=== chart_of_accounts sample groups ==='
cd server && node -e "
const Database=require('better-sqlite3');
const db=new Database('./crm.db',{readonly:true});
const tops=db.prepare(\"SELECT code,name,level,parent_code FROM chart_of_accounts WHERE parent_code IS NULL OR parent_code='' OR level=1 ORDER BY code LIMIT 20\").all();
console.log(JSON.stringify(tops,null,2));
const byLevel=db.prepare('SELECT level, COUNT(*) c FROM chart_of_accounts GROUP BY level ORDER BY level').all();
console.log('by_level', byLevel);
"
"""
_i, o, e = c.exec_command(cmd, timeout=60, get_pty=True)
print(o.read().decode("utf-8", "replace"))
c.close()
