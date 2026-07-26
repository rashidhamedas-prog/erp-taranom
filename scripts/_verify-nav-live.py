#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
from pathlib import Path
import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
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


def run(cmd, timeout=60):
    print("==>", cmd[:200])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    print(out)
    print("EXIT", o.channel.recv_exit_status())
    return out


run("cd /home/taranom/crm-taranom && git rev-parse --short HEAD && git log -3 --oneline")
run(
    "cd /home/taranom/crm-taranom && "
    "grep -E \"title: '\" server/public/acc-nav.js | head -20; "
    "grep -n 'erp-taranom-v' server/public/sw.js; "
    "grep -n 'acc-nav.js' server/public/index.html | head -3"
)
run(
    "curl -sS http://127.0.0.1:3000/acc-nav.js?v=76 | head -c 800; echo; "
    "curl -sS http://127.0.0.1:3000/acc-nav.js?v=76 | grep -E \"title: '\" | head -20; "
    "curl -sS http://127.0.0.1:3000/sw.js | head -3; "
    "curl -sS -o /dev/null -w 'acc-nav:%{http_code} size:%{size_download}\\n' http://127.0.0.1:3000/acc-nav.js?v=76"
)
run(
    "curl -sS https://erp.poshaktaranom.com/acc-nav.js?v=76 2>/dev/null | grep -E \"title: '\" | head -20; "
    "curl -sS https://erp.poshaktaranom.com/sw.js 2>/dev/null | head -3"
)
c.close()
print("DONE")
