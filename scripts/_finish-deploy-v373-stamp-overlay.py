#!/usr/bin/env python3
"""Overlay CHANGE-LOG stamp + verify SW v373 / heal flag on Iran."""
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
FILES = ["docs/CHANGE-LOG.md"]


def run(client, cmd, timeout=120):
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
        sftp.put(str(ROOT / rel), f"{REMOTE}/{rel}")
        print("put", rel)
    sftp.close()

    code, out, err = run(
        client,
        "set -e; cd /home/taranom/crm-taranom; "
        "grep -n 'SW v373' docs/CHANGE-LOG.md | head -3; "
        "grep -o 'erp-taranom-v[0-9]*' server/public/sw.js | head -1; "
        "grep -o 'app.js?v=[0-9]*' server/public/index.html | head -1; "
        "curl -s -o /tmp/h373b.json -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "python3 -c \"import json; d=json.load(open('/tmp/h373b.json')); print('image_engine', d.get('image_engine'));\"; "
        "node -e \""
        "const {getDB}=require('./server/db'); const db=getDB(); "
        "const f=db.prepare(\\\"SELECT value FROM settings WHERE key='purge_hollow_party_ledger_v373'\\\").get(); "
        "const hollow=db.prepare(\\\"SELECT COUNT(*) c FROM customer_ledger WHERE entry_type='reversal' OR ref_type LIKE '%\\\\_reversal' ESCAPE '\\\\' OR description LIKE 'ابطال %'\\\").get(); "
        "const srMis=db.prepare(\\\"SELECT COUNT(*) c FROM customer_ledger WHERE ref_type='sales_return' AND entry_type='reversal'\\\").get(); "
        "console.log('heal_flag', f&&f.value); console.log('hollow_cl_left', hollow.c); console.log('sr_mislabel', srMis.c);"
        "\"",
        timeout=120,
    )
    client.close()
    text = f"exit={code}\n" + out + ("\nERR:" + err if err.strip() else "")
    Path(r"D:\proje\erp-taranom1\_deploy-v373-stamp-verify.txt").write_text(text, encoding="utf-8")
    print(text.encode("ascii", "replace").decode())
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
