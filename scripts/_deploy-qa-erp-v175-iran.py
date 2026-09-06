#!/usr/bin/env python3
"""SFTP overlay QA-ERP v175 (RFQ/GRNI/SOD/branch). Never wholesale-replace db.js."""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
ROOT = Path(__file__).resolve().parents[1]
STAMP_FILE = ".sftp-deploy-stamp-qa-erp-v175"

FILES = [
    "docs/CHANGE-LOG.md",
    ".ai-dos/project/status.md",
    ".ai-dos/tasks/active.yaml",
    ".ai-dos/tasks/handoff.md",
    "docs/qa/FIRST-RUN.md",
    "server/lib/qa-gaps-schema.js",
    "server/lib/rbac.js",
    "server/lib/coa-map.js",
    "server/lib/inventory/reservation.js",
    "server/routes/rfq.js",
    "server/routes/procurement.js",
    "server/routes/branches.js",
    "server/routes/orders.js",
    "server/routes/admin.js",
    "server/routes/inventory.js",
    "server/middleware/auth.js",
    "server/sync/tables.js",
    "server/sync/capture.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
]

DB_HOOK = """
  try {
    require('./lib/qa-gaps-schema').ensureQaGapsSchema(db);
  } catch (e) {
    console.error('❌ qa-gaps schema init failed:', e.message);
    throw e;
  }
"""

SERVER_HOOK = """app.use('/api/rfq', require('./routes/rfq')); // RFQ sales/purchase
app.use('/api/branches', require('./routes/branches'));
// three-way match + maker-checker / sod_ / segregation of duties
app.use('/api/purchases', require('./routes/procurement')); // PO / GR / GRNI / 3-way match
app.use('/api/purchases', require('./routes/purchases'));
"""


def stamp_hash() -> str:
    return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()


def run(c, cmd, timeout=300):
    print("==>", cmd[:280])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    print(text[-6000:] if len(text) > 6000 else text)
    print("EXIT", code)
    return code, text


def ensure_dirs(sftp, remote_file: str) -> None:
    parts = remote_file.split("/")[:-1]
    cur = ""
    for p in parts:
        if not p:
            continue
        cur += "/" + p
        try:
            sftp.stat(cur)
        except OSError:
            try:
                sftp.mkdir(cur)
            except OSError:
                pass


def patch_db(src: str) -> tuple[str, str]:
    if "ensureQaGapsSchema" in src:
        return src, "already-patched"
    needle = "require('./lib/inventory/schema').initInventorySchema(db);"
    idx = src.find(needle)
    if idx < 0:
        return src, "pattern-missing"
    # insert after the inventory try/catch block if present, else after the require line
    end = src.find("\n", idx)
    block_end = src.find("}", end)
    insert_at = src.find("\n", block_end) + 1 if block_end > 0 else end + 1
    return src[:insert_at] + DB_HOOK + src[insert_at:], "patched"


def patch_server(src: str) -> tuple[str, str]:
    if "require('./routes/rfq')" in src:
        return src, "already-patched"
    old = "app.use('/api/purchases', require('./routes/purchases'));"
    if old not in src:
        return src, "pattern-missing"
    return src.replace(old, SERVER_HOOK, 1), "patched"


def main() -> None:
    missing = [rel for rel in FILES if not (ROOT / rel).is_file()]
    if missing:
        raise SystemExit(f"missing local files: {missing}")
    if not KEY.is_file():
        raise SystemExit("SSH key missing")
    h = stamp_hash()

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -8")
    print("skip git pull; never wholesale-replace db.js")

    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ensure_dirs(sftp, remote)
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)

    tmp = Path(__file__).with_name("_iran-patch.tmp")
    for rel, fn, bak_name in (
        ("server/db.js", patch_db, "server/db.js.bak-v175"),
        ("server/server.js", patch_server, "server/server.js.bak-v175"),
    ):
        remote = f"{APP}/{rel}"
        sftp.get(remote, str(tmp))
        src = tmp.read_text(encoding="utf-8")
        patched, how = fn(src)
        print(rel, "PATCH", how)
        if how == "patched":
            sftp.put(str(tmp), f"{APP}/{bak_name}")
            tmp.write_text(patched, encoding="utf-8", newline="\n")
            sftp.put(str(tmp), remote)
    tmp.unlink(missing_ok=True)
    sftp.close()

    run(c, "pm2 restart erp-taranom 2>&1 | tail -15")
    _code, health = run(
        c,
        "sleep 10; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1",
        timeout=90,
    )
    if "health:200" not in health or "root:200" not in health:
        print("health failed; restoring db.js/server.js bak-v175")
        run(
            c,
            f"test -f {APP}/server/db.js.bak-v175 && cp {APP}/server/db.js.bak-v175 {APP}/server/db.js; "
            f"test -f {APP}/server/server.js.bak-v175 && cp {APP}/server/server.js.bak-v175 {APP}/server/server.js; "
            "pm2 restart erp-taranom",
        )
        c.close()
        raise SystemExit("health check failed")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run(c, f"cd {APP} && echo {STAMP_FILE}={stamp} hash={h} > {STAMP_FILE} && cat {STAMP_FILE}", timeout=30)
    c.close()
    print("DEPLOY_DONE", h)


if __name__ == "__main__":
    main()
