#!/usr/bin/env python3
"""Overlay SW v386 expense moein …01 picker fix; restart pm2; run tests."""
from pathlib import Path
import gzip
import hashlib
import sys
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
    "server/lib/coa-browse.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/scripts/test-expense-coa-picker-v328.js",
]


def run(client, cmd, timeout=600):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def put_gz(client, sftp, rel):
    local = ROOT / rel
    data = local.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    gz = gzip.compress(data, compresslevel=9)
    remote = f"{REMOTE}/{rel}"
    parent = str(Path(remote).parent).replace("\\", "/")
    remote_gz = f"/tmp/v386-{Path(rel).name}.gz"
    run(client, f"mkdir -p {parent}")
    with sftp.file(remote_gz, "wb") as fh:
        fh.write(gz)
    py = (
        "import gzip,hashlib\n"
        "from pathlib import Path\n"
        f"raw=gzip.open({remote_gz!r},'rb').read()\n"
        f"assert hashlib.sha256(raw).hexdigest()=={sha!r}, (len(raw), hashlib.sha256(raw).hexdigest())\n"
        f"Path({remote!r}).write_bytes(raw)\n"
        f"print('ok', {rel!r}, len(raw))\n"
    )
    code, out, err = run(client, "python3 - <<'PY'\n" + py + "PY")
    print("put", rel, "bytes", len(data), "sha", sha[:12], out.strip(), err.strip(), "code", code)
    if code != 0:
        raise SystemExit(code)


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("94.249.244.208", username="taranom", key_filename=str(KEY), timeout=30)
    sftp = client.open_sftp()
    for rel in FILES:
        put_gz(client, sftp, rel)
    sftp.close()

    code, out, err = run(
        client,
        "set -e; cd /home/taranom/crm-taranom; "
        "node --check server/public/app.js; "
        "node --check server/lib/coa-browse.js; "
        "node server/scripts/test-expense-coa-picker-v328.js; "
        "node server/scripts/test-coa-browse-v324.js; "
        "node server/scripts/test-sms.js; "
        "pm2 restart erp-taranom >/tmp/pm2-v386.txt 2>&1; sleep 8; "
        "curl -s -o /tmp/h386.json -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "python3 - <<'PY'\n"
        "import json\n"
        "h=json.load(open('/tmp/h386.json'))\n"
        "print('ok', h.get('ok'), 'image_engine', h.get('image_engine'))\n"
        "assert h.get('ok') is True or h.get('status')=='ok' or h.get('image_engine')\n"
        "PY\n"
        "rg -n 'erp-taranom-v386|app.js\\?v=386|610301 is selectable|does not reuse the tafsili-shell' "
        "server/public/sw.js server/public/index.html server/public/app.js "
        "server/scripts/test-expense-coa-picker-v328.js | head -20; "
        "echo DONE_V386",
        timeout=300,
    )
    text = out + "\n" + err + f"\ncode={code}\n"
    Path(r"D:\proje\erp-taranom1\_deploy-v386-expense-moein.txt").write_text(text, encoding="utf-8")
    sys.stdout.buffer.write(text.encode("utf-8", "replace"))
    client.close()
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
