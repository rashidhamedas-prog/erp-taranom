#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dump remote vs local snippets for key UI files (ASCII-only remote cmds)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import paramiko

APP = "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
ROOT = Path(__file__).resolve().parents[1]

cmd = f"""
wc -c {APP}/server/public/acc-nav.js {APP}/server/public/index.html {APP}/server/public/app.css {APP}/server/routes/production-orders.js
echo ---
grep -c acc-production-boms {APP}/server/public/acc-nav.js
grep -c acc-production-rates {APP}/server/public/acc-nav.js
grep -c acc-moadian {APP}/server/public/acc-nav.js
grep -n \"title: .تولید.\" {APP}/server/public/acc-nav.js | head -5 || true
grep -n production {APP}/server/public/acc-nav.js | head -30
echo ---INDEX_SCRIPTS---
grep -E 'src=|href=.*css' {APP}/server/public/index.html | head -40
echo ---APP_CSS---
wc -l {APP}/server/public/app.css
"""

pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("94.249.244.208", username="taranom", pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)
_i, o, e = c.exec_command(cmd, timeout=60)
print(o.read().decode("utf-8", "replace"))
print(e.read().decode("utf-8", "replace"))
c.close()
for f in [
    "server/public/acc-nav.js",
    "server/public/index.html",
    "server/public/app.css",
    "server/routes/production-orders.js",
]:
    p = ROOT / f
    print("local", f, p.stat().st_size, "lines", sum(1 for _ in p.open("rb")))
