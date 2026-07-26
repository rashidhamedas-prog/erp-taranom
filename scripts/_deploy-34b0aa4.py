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


def run(cmd, timeout=180):
    print("==>", cmd[:200])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    print(out)
    if err.strip():
        print("STDERR:", err)
    print("EXIT", o.channel.recv_exit_status())


run(
    "cd /home/taranom/crm-taranom && "
    "git stash push -m deploy-34b0aa4 -- server/package-lock.json 2>/dev/null; "
    "git pull --ff-only origin claude/claude-md-docs-2ssrpy && "
    "git stash pop || true && "
    "pm2 restart erp-taranom --update-env && "
    "sleep 2 && curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health && "
    "git rev-parse --short HEAD && "
    "grep -n erp-taranom-v117 server/public/sw.js && "
    "grep -n 'customer_ledger' server/routes/accounting.js | head -5"
)

# Simulate overview numbers from live DB (same SQL as route)
run(
    r"""cd /home/taranom/crm-taranom/server && node <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('./crm.db',{readonly:true});
const totalInvoiced=db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final'").get().s;
const totalSettled=db.prepare("SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE COALESCE(status,'posted')<>'reversed'").get().s;
const ledRecv=db.prepare(`SELECT
  COALESCE(SUM(CASE WHEN bal > 0 THEN bal ELSE 0 END), 0) AS recv,
  COALESCE(SUM(CASE WHEN bal < 0 THEN -bal ELSE 0 END), 0) AS cred
  FROM (SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS bal FROM customer_ledger GROUP BY customer_id)`).get();
const hasLedger=(Number(ledRecv.recv)||0)!==0||(Number(ledRecv.cred)||0)!==0;
const outstanding=hasLedger?Number(ledRecv.recv)||0:Math.max(0,Number(totalInvoiced)-Number(totalSettled));
console.log(JSON.stringify({totalInvoiced,totalSettled,outstanding,creditorBalance:hasLedger?Number(ledRecv.cred)||0:0,hasLedger,ledRecv},null,2));
NODE"""
)

c.close()
print("DONE")
