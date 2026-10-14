#!/usr/bin/env python3
"""Overlay SW v368 party books opening/supplier SoT; pm2 restart; tests + mismatch probe."""
from pathlib import Path
import paramiko

KEY = next(
    p
    for p in (
        Path.home() / ".ssh" / "id_ed25519_taranom",
        Path(r"D:\proje\.ssh\id_ed25519_taranom"),
    )
    if p.is_file()
)
ROOT = Path(r"D:\proje\erp-taranom1")
REMOTE = "/home/taranom/crm-taranom"
FILES = [
    "docs/CHANGE-LOG.md",
    "docs/architecture/PARTY-ACC-ADR-001.md",
    "server/lib/party-books.js",
    "server/lib/party-control-dashboard.js",
    "server/lib/opening-post.js",
    "server/public/app.js",
    "server/public/portal-ui.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/scripts/test-party-books-opening-align-v368.js",
    "server/scripts/test-party-books-turnover-v362.js",
]


def run(client, cmd, timeout=600):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


PROBE = r'''
'use strict';
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();
const { buildPartyControlDashboard } = require('../lib/party-control-dashboard');
const d = buildPartyControlDashboard(db, { balance: 'all', risk: 'mismatch', limit: 100 });
const items = (d.parties || []).filter(p => p.books_mismatch).map(p => ({
  id: p.id, name: p.name, live: p.balance_rial, gl: p.gl_balance_rial,
  src: p.balance_source, leaf: p.balance_coa_code,
}));
console.log(JSON.stringify({ mismatch_count: d.kpis.mismatch_count, items }, null, 2));
try { closeDB(); } catch (_) {}
'''


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("94.249.244.208", username="taranom", key_filename=str(KEY), timeout=30)
    sftp = client.open_sftp()
    for rel in FILES:
        remote = f"{REMOTE}/{rel}"
        parent = str(Path(remote).parent).replace("\\", "/")
        run(client, f"mkdir -p {parent}")
        sftp.put(str(ROOT / rel), remote)
        print("put", rel)
    with sftp.file(f"{REMOTE}/server/scripts/_probe-mismatch-after-v368.js", "w") as f:
        f.write(PROBE)
    sftp.close()

    code, out, err = run(
        client,
        "set -e; cd /home/taranom/crm-taranom; "
        "node --check server/lib/party-books.js; "
        "node --check server/lib/party-control-dashboard.js; "
        "node --check server/lib/opening-post.js; "
        "node --check server/public/app.js; "
        "node --check server/public/portal-ui.js; "
        "node server/scripts/test-party-books-opening-align-v368.js; "
        "node server/scripts/test-party-books-turnover-v362.js; "
        "node server/scripts/test-sms.js; "
        "node server/scripts/test-sync.js; "
        "pm2 restart erp-taranom >/tmp/pm2-v368.txt 2>&1; sleep 4; "
        "curl -s -o /tmp/h368.json -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "python3 -c \"import json; d=json.load(open('/tmp/h368.json')); print('image_engine', d.get('image_engine'));\"; "
        "grep -o 'erp-taranom-v[0-9]*' server/public/sw.js | head -1; "
        "node server/scripts/_probe-mismatch-after-v368.js",
        timeout=600,
    )
    client.close()
    text = f"exit={code}\n" + out + ("\nERR:" + err if err.strip() else "")
    Path(r"D:\proje\erp-taranom1\_deploy-v368-party-books.txt").write_text(text, encoding="utf-8")
    print(text.encode("ascii", "replace").decode())
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
