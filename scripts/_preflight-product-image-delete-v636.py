#!/usr/bin/env python3
"""Read-only preflight for product-image-delete (SW v636).

Does NOT SFTP, pm2 restart, or write crm.db.
Compares live files to baseline commit 80043871 (pre-fix tip that contained v635).
Records tip overlay hashes for GO deploy.

Usage:
  python scripts/_preflight-product-image-delete-v636.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import paramiko

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
REMOTE = "/home/taranom/crm-taranom"
ROOT = Path(__file__).resolve().parents[1]
BASELINE = "80043871"  # branched-from tip (v635 stamp parent of fix)
OVERLAY = [
    "server/routes/products.js",
    "server/public/app.js",
    "server/public/sw.js",
    "server/public/index.html",  # ?v=636 cache bust (CHANGE-LOG)
]
# Optional on VPS — hash recorded but not required to match baseline
OPTIONAL = [
    "server/scripts/test-product-image-delete-clears-primary.js",
]


def sh_local(args: list[str], cwd: Path | None = None) -> str:
    return subprocess.check_output(args, cwd=str(cwd or ROOT)).decode("utf-8", "replace").strip()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def blob_at(commit: str, rel: str) -> bytes:
    return subprocess.check_output(["git", "show", f"{commit}:{rel}"], cwd=str(ROOT))


def run(client, cmd: str, timeout: int = 120):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def main() -> int:
    tip = sh_local(["git", "rev-parse", "HEAD"])
    tip_short = tip[:8]
    print(f"LOCAL_TIP={tip}")
    print(f"BASELINE={BASELINE}")
    print(f"WORKTREE={ROOT}")

    print("\n=== TIP overlay hashes (LF-normalized) ===")
    tip_hashes = {}
    for rel in OVERLAY + OPTIONAL:
        try:
            raw = blob_at(tip, rel) if rel in OVERLAY or True else b""
            # optional may only exist on tip
            raw = blob_at(tip, rel)
        except subprocess.CalledProcessError:
            print(f"MISSING_ON_TIP {rel}")
            continue
        h = sha256_bytes(normalize_lf(raw))
        tip_hashes[rel] = h
        print(f"{h}  {rel}  ({len(raw)} bytes raw)")

    print("\n=== BASELINE hashes (LF-normalized) — live must match these ===")
    base_hashes = {}
    for rel in OVERLAY:
        if rel.endswith("index.html"):
            # index ?v= may have been bumped with v635; still compare live to baseline blob
            pass
        raw = blob_at(BASELINE, rel)
        h = sha256_bytes(normalize_lf(raw))
        base_hashes[rel] = h
        print(f"{h}  {rel}")

    if not KEY.exists():
        print(f"FAIL no SSH key at {KEY}")
        return 2

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(KEY), timeout=45)

    print("\n=== LIVE server (read-only) ===")
    code, out, err = run(
        client,
        f"""
set -e
cd {REMOTE}
echo "REMOTE_PWD=$(pwd)"
echo -n "GIT_HEAD="; git rev-parse HEAD 2>/dev/null || echo NO_GIT
echo -n "GIT_STATUS_LINES="; git status --short 2>/dev/null | wc -l || echo 0
git status --short 2>/dev/null | head -40 || true
echo "---"
# hashes with LF normalize via tr
for f in server/routes/products.js server/public/app.js server/public/sw.js server/public/index.html; do
  if [ -f "$f" ]; then
    h=$(tr -d '\\r' < "$f" | sha256sum | awk '{{print $1}}')
    echo "LIVE_HASH $h $f"
    # also raw size
    echo "LIVE_SIZE $(wc -c < "$f") $f"
  else
    echo "LIVE_MISSING $f"
  fi
done
echo "---"
grep -n "CACHE" server/public/sw.js | head -3 || true
grep -oE 'app\\.js\\?v=[0-9]+' server/public/index.html | head -3 || true
echo "---"
# DB snapshot (ro)
cd {REMOTE}/server
node -e "
const Database=require('better-sqlite3');
const db=new Database('crm.db',{{readonly:true}});
db.pragma('query_only=ON');
const je=db.prepare(\\"SELECT COUNT(*) c, COALESCE(SUM(debit_rial),0) s FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id WHERE e.status='approved' AND IFNULL(e.deleted_at,'')=''\\").get();
const maxL=db.prepare('SELECT MAX(id) m FROM inventory_ledger').get();
const p342=db.prepare('SELECT id, code, stock FROM products WHERE id=342').get();
const p100=db.prepare('SELECT id, code, image, images_json FROM products WHERE id=100').get();
console.log('SNAP_JE_APPROVED_LINES='+JSON.stringify(je));
console.log('SNAP_LEDGER_MAX='+JSON.stringify(maxL));
console.log('SNAP_P342='+JSON.stringify(p342));
console.log('SNAP_P100='+JSON.stringify(p100));
db.close();
"
pm2 describe erp-taranom 2>/dev/null | head -20 || true
curl -sS -o /tmp/health-preflight.json -w 'HEALTH_HTTP=%{{http_code}}\\n' http://127.0.0.1:3000/api/system/health || true
head -c 400 /tmp/health-preflight.json; echo
""",
        timeout=180,
    )
    print(out)
    if err.strip():
        print("STDERR", err[:1500])
    if code != 0:
        print(f"REMOTE_CMD_EXIT={code}")
        client.close()
        return code or 1

    live = {}
    for line in out.splitlines():
        if line.startswith("LIVE_HASH "):
            parts = line.split()
            if len(parts) >= 3:
                live[parts[2]] = parts[1]

    print("\n=== COMPARE live vs BASELINE (must match before overlay) ===")
    mismatches = []
    for rel, bh in base_hashes.items():
        lh = live.get(rel)
        if not lh:
            print(f"MISS  {rel}")
            mismatches.append(rel)
            continue
        ok = lh == bh
        print(f"{'OK' if ok else 'DIFF'}  {rel}")
        print(f"      baseline={bh}")
        print(f"      live    ={lh}")
        if tip_hashes.get(rel):
            print(f"      tip     ={tip_hashes[rel]}")
        if not ok:
            mismatches.append(rel)

    client.close()

    print("\n=== PREFLIGHT VERDICT ===")
    if mismatches:
        print("STOP — live files differ from baseline 80043871. Do not overlay until reconciled.")
        print("Mismatches:", ", ".join(mismatches))
        return 3
    print("READY — live matches baseline; tip overlay hashes recorded above.")
    print(f"On GO deploy product-image-delete: overlay {len(OVERLAY)} files from tip {tip_short},")
    print("backup crm.db+wal+shm, pm2 restart WITHOUT --update-env, stamp .sftp-deploy-stamp-product-image-delete-v636")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
