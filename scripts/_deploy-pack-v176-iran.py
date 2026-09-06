#!/usr/bin/env python3
"""SFTP overlay PACK v176. Never wholesale-replace db.js."""
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
STAMP_FILE = ".sftp-deploy-stamp-pack-v176"

FILES = [
    "docs/CHANGE-LOG.md",
    ".ai-dos/project/status.md",
    ".ai-dos/tasks/active.yaml",
    ".ai-dos/tasks/handoff.md",
    "server/lib/production/cutting.js",
    "server/lib/production/engine-advanced.js",
    "server/lib/production/engine.js",
    "server/lib/production/schema.js",
    "server/routes/production-cutting.js",
    "server/sync/tables.js",
    "server/sync/capture.js",
    "server/public/acc-nav.js",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
]

DB_HOOK = """
    const backfillV13 = db.prepare("SELECT value FROM settings WHERE key='sync_seq_backfill_v13'").get();
    if (!backfillV13 || backfillV13.value !== '1') {
      for (const t of SYNCABLE_TABLES) {
        if (!tableExists(db, t.name)) continue;
        if (!tableColumns(db, t.name).includes('sync_seq')) continue;
        try {
          db.prepare(`UPDATE ${t.name} SET sync_seq = 0 WHERE sync_seq IS NULL`).run();
        } catch (e) {
          console.warn(`⚠️ sync_seq backfill v13 skipped for ${t.name}:`, e.message);
        }
      }
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('sync_seq_backfill_v13','1')").run();
    }
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
    if "sync_seq_backfill_v13" in src:
        return src, "already-patched"
    needle = "INSERT OR REPLACE INTO settings (key,value) VALUES ('sync_seq_backfill_v12','1')"
    idx = src.find(needle)
    if idx < 0:
        return src, "pattern-missing"
    end = src.find("\n", idx)
    return src[: end + 1] + DB_HOOK + src[end + 1 :], "patched"


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

    tmp = Path(__file__).with_name("_iran-patch-v176.tmp")
    remote = f"{APP}/server/db.js"
    sftp.get(remote, str(tmp))
    src = tmp.read_text(encoding="utf-8")
    patched, how = patch_db(src)
    print("server/db.js PATCH", how)
    if how == "patched":
        sftp.put(str(tmp), f"{APP}/server/db.js.bak-v176")
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
        print("health failed; restoring db.js bak-v176")
        run(
            c,
            f"test -f {APP}/server/db.js.bak-v176 && cp {APP}/server/db.js.bak-v176 {APP}/server/db.js; "
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
