#!/usr/bin/env python3
from __future__ import annotations
import pathlib, sys
import paramiko

def p(s): sys.stdout.write(s.encode("ascii","replace").decode()+"\n"); sys.stdout.flush()
key=next(x for x in (pathlib.Path.home()/".ssh"/"id_ed25519_taranom", pathlib.Path(r"D:\proje\.ssh\id_ed25519_taranom")) if x.exists())
c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy()); c.connect("94.249.244.208", username="taranom", key_filename=str(key), timeout=30)
_,o,e=c.exec_command("dig +short erptaranom.com NS @8.8.8.8; dig +short erptaranom.com A @1.1.1.1; curl -sS -o /dev/null -w 'direct:%{http_code}\\n' --connect-timeout 8 https://erptaranom.com/", timeout=40)
p(o.read().decode()+e.read().decode()); c.close()
