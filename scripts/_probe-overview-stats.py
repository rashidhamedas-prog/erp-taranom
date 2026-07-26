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
cd /home/taranom/crm-taranom/server && node <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('./crm.db',{readonly:true});
const inv=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE type='final'").get();
const sett=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM settlements WHERE COALESCE(status,'posted')<>'reversed'").get();
const led=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) cr, COALESCE(SUM(debit)-SUM(credit),0) bal FROM customer_ledger").get();
const byCust=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN bal>0 THEN bal ELSE 0 END),0) recv, COALESCE(SUM(CASE WHEN bal<0 THEN -bal ELSE 0 END),0) cred FROM (SELECT customer_id, SUM(debit)-SUM(credit) bal FROM customer_ledger GROUP BY customer_id)").get();
const parties=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(ABS(opening_balance)),0) abs_open FROM parties").get();
let supp={};
try{supp=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(debit)-SUM(credit),0) bal FROM supplier_ledger").get();}catch(e){supp={err:e.message};}
const purch=db.prepare("SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM purchase_invoices").get();
console.log(JSON.stringify({inv,sett,led,byCust,parties,supp,purch},null,2));
NODE
"""
_i, o, e = c.exec_command(cmd, timeout=60, get_pty=True)
print(o.read().decode("utf-8", "replace"))
c.close()
