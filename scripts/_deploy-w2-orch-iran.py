#!/usr/bin/env python3
"""Safe Wave-2 deploy to Iran: inventory, stash tracked-only, ff-pull, restart without --update-env."""
from pathlib import Path
import sys
import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
WANT = "b4b653b"

pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)


def run(cmd, t=300):
    print("==>", cmd)
    _i, o, e = c.exec_command(cmd, timeout=t, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    if len(text) > 4000:
        text = text[-4000:]
    print(text)
    print("EXIT", code)
    return code, text


run(f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -40")
run(f"cd {APP} && git fetch origin claude/claude-md-docs-2ssrpy 2>&1 | tail -8")

# Stash only tracked modifications (never -u: avoid scooping secret untracked files)
run(f"cd {APP} && git stash push -m 'w2-pre-deploy-tracked' 2>&1 || true")

code, out = run(
    f"cd {APP} && git pull --ff-only origin claude/claude-md-docs-2ssrpy 2>&1 | tail -40; "
    f"echo HEAD:$(git rev-parse --short HEAD)"
)

run(f"cd {APP}/server && npm install --omit=dev 2>&1 | tail -25", t=600)
# Do NOT use --update-env (preserves encryption env; avoids accidental wipe)
run("pm2 restart erp-taranom 2>&1 | tail -20")
run("sleep 3; pm2 describe erp-taranom 2>&1 | egrep 'status|pid|restarts|script path' | head -20")
run("curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
run("curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready")
run("curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/")
run(f"cd {APP} && git stash list | head -5")
c.close()
print("DEPLOY_DONE")
