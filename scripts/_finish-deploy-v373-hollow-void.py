#!/usr/bin/env python3
"""Overlay SW v373 hollow void books; pm2 restart; health + tests."""
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
    "server/lib/party-ledger-retire.js",
    "server/lib/customer-books.js",
    "server/lib/sales-return-doc.js",
    "server/lib/void-settlement.js",
    "server/lib/pos.js",
    "server/lib/cheque-party-books.js",
    "server/lib/party-turnover.js",
    "server/lib/inventory/fabric-rolls.js",
    "server/routes/accounting.js",
    "server/routes/purchases.js",
    "server/db.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/scripts/test-hollow-void-books-v373.js",
]


def run(client, cmd, timeout=600):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


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
    sftp.close()

    code, out, err = run(
        client,
        "set -e; cd /home/taranom/crm-taranom; "
        "node --check server/lib/party-ledger-retire.js; "
        "node --check server/lib/customer-books.js; "
        "node --check server/lib/sales-return-doc.js; "
        "node --check server/lib/void-settlement.js; "
        "node --check server/lib/pos.js; "
        "node server/scripts/test-hollow-void-books-v373.js; "
        "node server/scripts/test-sms.js; "
        "node server/scripts/test-sync.js; "
        "pm2 restart erp-taranom >/tmp/pm2-v373.txt 2>&1; sleep 8; "
        "curl -s -o /tmp/h373.json -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "python3 -c \"import json; d=json.load(open('/tmp/h373.json')); print('image_engine', d.get('image_engine')); print('ok', d.get('ok', d.get('status')));\"; "
        "grep -o 'erp-taranom-v[0-9]*' server/public/sw.js | head -1; "
        "grep -o 'app.js?v=[0-9]*' server/public/index.html | head -1; "
        "grep -c purge_hollow_party_ledger_v373 server/db.js; "
        "pm2 logs erp-taranom --lines 40 --nostream 2>/dev/null | grep -E 'purge_hollow|v373|error' || true",
        timeout=600,
    )
    client.close()
    text = f"exit={code}\n" + out + ("\nERR:" + err if err.strip() else "")
    Path(r"D:\proje\erp-taranom1\_deploy-v373-hollow-void.txt").write_text(text, encoding="utf-8")
    print(text.encode("ascii", "replace").decode())
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
