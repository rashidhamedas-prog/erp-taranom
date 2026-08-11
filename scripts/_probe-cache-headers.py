#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Check Cache-Control / ETag of production static assets."""
from __future__ import annotations

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import paramiko

KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
cmd = r"""
for u in / /index.html /app.js /app.js?v=1 /app.css /app.css?v=1 /acc-nav.js /sw.js /prod-ui.js; do
  echo "== $u"
  curl -sS -D - -o /dev/null "http://127.0.0.1:3000$u" | tr -d '\r' | grep -iE 'HTTP/|cache-control|etag|last-modified|content-type|content-length' | head -10
done
# also via public host if nginx local
if curl -sS -o /dev/null -w '%{http_code}' --max-time 5 https://erp.poshaktaranom.com/sw.js | grep -q 200; then
  echo '== public sw.js headers'
  curl -sS -D - -o /dev/null --max-time 15 'https://erp.poshaktaranom.com/sw.js' | tr -d '\r' | grep -iE 'HTTP/|cache-control|etag|cf-|age|content-length' | head -15
  echo '== public app.js?v=1'
  curl -sS -D - -o /dev/null --max-time 15 'https://erp.poshaktaranom.com/app.js?v=1' | tr -d '\r' | grep -iE 'HTTP/|cache-control|etag|cf-|age|content-length' | head -15
fi
"""

pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("94.249.244.208", username="taranom", pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)
_i, o, e = c.exec_command(cmd, timeout=90)
print(o.read().decode("utf-8", "replace"))
print(e.read().decode("utf-8", "replace"))
c.close()
