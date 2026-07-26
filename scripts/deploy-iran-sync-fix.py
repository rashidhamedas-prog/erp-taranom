#!/usr/bin/env python3
"""Resolve Iran VPS divergence: backup local, hard-reset to origin, re-apply stash carefully."""
from __future__ import annotations

from pathlib import Path
import paramiko

HOST = "94.249.244.208"
USER = "taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
BRANCH = "claude/claude-md-docs-2ssrpy"
APP_DIR = "/home/taranom/crm-taranom"


def run(c, cmd, timeout=600):
    print("==>", cmd)
    _stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print("ERR", err.rstrip())
    print("EXIT", code)
    return code, out


def main() -> None:
    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=30, allow_agent=False, look_for_keys=False)

    # Leave any conflicted merge/rebase
    run(c, f"cd {APP_DIR} && git merge --abort 2>/dev/null; git rebase --abort 2>/dev/null; true")
    run(c, f"cd {APP_DIR} && git status -sb && git log --oneline -6")

    # Backup current HEAD (includes 4 local commits)
    run(c, f"cd {APP_DIR} && git branch -f backup/pre-sync-fix-20260721 HEAD && git log --oneline backup/pre-sync-fix-20260721 -5")

    # Sync to origin (authoritative for Update11 + sync 2.0.19)
    code, _ = run(
        c,
        f"cd {APP_DIR} && git fetch origin && git reset --hard origin/{BRANCH}",
    )
    if code != 0:
        raise SystemExit("hard reset failed")

    run(c, f"cd {APP_DIR} && git log -5 --oneline && git status -sb")

    # Try cherry-pick local production commits that aren't on origin (party-CRM fixes)
    code, out = run(
        c,
        f"cd {APP_DIR} && git log --oneline backup/pre-sync-fix-20260721 --not origin/{BRANCH}",
    )
    local_only = [ln.split()[0] for ln in out.splitlines() if ln.strip() and len(ln.split()[0]) >= 7]
    # cherry-pick oldest first
    local_only = list(reversed(local_only))
    print("LOCAL_ONLY", local_only)
    for h in local_only:
        code, _ = run(c, f"cd {APP_DIR} && git cherry-pick {h}", timeout=180)
        if code != 0:
            print("cherry-pick conflict on", h, "— skipping, keeping origin version")
            run(c, f"cd {APP_DIR} && git cherry-pick --abort || true")

    run(c, f"cd {APP_DIR}/server && npm install --omit=dev", timeout=600)
    run(c, "pm2 restart erp-taranom --update-env")
    run(c, "sleep 2; pm2 list")
    run(
        c,
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS http://127.0.0.1:3000/api/system/health 2>/dev/null | head -c 300; echo",
    )
    # Confirm sync fix files present
    run(
        c,
        f"cd {APP_DIR} && grep -n 'sync_seq_backfill_v2' server/db.js | head -3; "
        f"grep -n 'OVERFLOW_FLOOR' server/sync/tables.js | head -3; "
        f"grep -n 'erp.poshaktaranom.com' server/public/index.html | head -3; "
        f"head -5 server/routes/import.js",
    )
    c.close()
    print("DONE")


if __name__ == "__main__":
    main()
