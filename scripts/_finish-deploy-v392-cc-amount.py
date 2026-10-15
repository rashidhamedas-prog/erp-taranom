#!/usr/bin/env python3
"""Overlay SW v392 require-CC amount gate; restart pm2; run tests."""
from pathlib import Path
import gzip
import hashlib
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
    "server/lib/amend-cash-ops.js",
    "server/lib/amend-invoice.js",
    "server/lib/cost-center-policy.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
    "server/routes/cheque-records.js",
    "server/routes/expenses.js",
    "server/scripts/test-require-cc-amount-v392.js",
    "server/scripts/test-require-cc-expense-v375.js",
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
    remote_gz = f"/tmp/v392-{Path(rel).name}.gz"
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
        f"cd {REMOTE} && pm2 restart erp-taranom && sleep 3 && "
        f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:3000/api/system/health && echo && "
        f"curl -s http://127.0.0.1:3000/api/system/health && echo && "
        f"node server/scripts/test-require-cc-amount-v392.js && "
        f"node server/scripts/test-require-cc-expense-v375.js && "
        f"node server/scripts/test-sms.js",
        timeout=300,
    )
    print("remote", code)
    print(out)
    print(err)
    Path(r"D:\proje\erp-taranom1\_deploy-v392-cc-amount.txt").write_text(out + "\n" + err, encoding="utf-8")
    client.close()
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
