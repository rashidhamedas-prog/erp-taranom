#!/usr/bin/env python3
"""Full tip deploy to Iran: stash tracked-only, ff-pull, npm, sharp pin, pm2 restart."""
from pathlib import Path
import sys
import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
BRANCH = "claude/claude-md-docs-2ssrpy"
SHARP_PIN = "0.33.5"

pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)


def run(cmd, t=600):
    print("==>", cmd[:300])
    _i, o, e = c.exec_command(cmd, timeout=t, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    if len(text) > 6000:
        text = text[-6000:]
    print(text)
    print("EXIT", code)
    return code, text


run(f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -40")
run(f"cd {APP} && git fetch origin {BRANCH} 2>&1 | tail -12")
# Stash only tracked modifications (never -u: avoid scooping secret untracked files)
run(f"cd {APP} && git stash push -m 'merge-all-pre-deploy-tracked' 2>&1 || true")
code, out = run(
    f"cd {APP} && git pull --ff-only origin {BRANCH} 2>&1 | tail -50; "
    f"echo HEAD:$(git rev-parse --short HEAD)"
)
if code != 0 or "fatal:" in out.lower() or "Already up to date" not in out and "Updating" not in out and "Fast-forward" not in out and "HEAD:" not in out:
    # still continue if HEAD printed; abort only on hard failure
    if "fatal:" in out.lower() or "error:" in out.lower() and "Fast-forward" not in out:
        print("PULL_FAILED")
        c.close()
        sys.exit(2)

run(f"cd {APP}/server && npm install --omit=dev 2>&1 | tail -30", t=900)
# Permanent sharp waiver: keep runtime on 0.33.5 even if package.json asks newer
run(
    f"cd {APP}/server && npm install sharp@{SHARP_PIN} --omit=dev --no-save 2>&1 | tail -20; "
    f"node -e \"console.log('sharp='+require('sharp/package.json').version)\"",
    t=600,
)
run("pm2 restart erp-taranom 2>&1 | tail -20")
run("sleep 4; pm2 describe erp-taranom 2>&1 | egrep 'status|pid|restarts|script path' | head -20")
run("curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health")
run("curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready")
run("curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/")
run(f"cd {APP} && git rev-parse --short HEAD && git stash list | head -5")
c.close()
print("DEPLOY_DONE")
