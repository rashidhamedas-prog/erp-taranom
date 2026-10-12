#!/usr/bin/env python3
"""Finish post-cutover CORS harden + PM2 reload + verify (ASCII-safe prints)."""
from __future__ import annotations

import pathlib
import sys
import time

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
NEW_ORIGINS = "https://erptaranom.com,https://www.erptaranom.com"
ECO = "/home/taranom/crm-taranom/server/ecosystem.config.js"


def p(s: str) -> None:
    sys.stdout.write(s.encode("ascii", "replace").decode("ascii") + "\n")
    sys.stdout.flush()


def find_key() -> pathlib.Path:
    for cand in (
        pathlib.Path.home() / ".ssh" / "id_ed25519_taranom",
        pathlib.Path(r"D:\proje\.ssh\id_ed25519_taranom"),
    ):
        if cand.exists():
            return cand
    raise SystemExit("SSH key not found")


def main() -> int:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(find_key()), timeout=30)

    def run(cmd: str, timeout: int = 120) -> tuple[int, str]:
        _i, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace") + stderr.read().decode("utf-8", "replace")
        return stdout.channel.recv_exit_status(), out

    # Sync ecosystem ALLOWED_ORIGINS from local intent
    code, eco = run(f"cat {ECO}")
    if code != 0:
        p(eco)
        return 1
    if "https://erp.poshaktaranom.com" in eco:
        eco2 = eco.replace(
            "https://erptaranom.com,https://www.erptaranom.com,https://erp.poshaktaranom.com",
            NEW_ORIGINS,
        )
        eco2 = eco2.replace(
            "Keep retired erp.poshaktaranom.com in CORS only until DNS cutover completes.",
            "Retired erp.poshaktaranom.com dropped from CORS after cutover.",
        )
        sftp = client.open_sftp()
        with sftp.file("/tmp/ecosystem.cors-v348.js", "w") as f:
            f.write(eco2)
        sftp.close()
        run(f"cp /tmp/ecosystem.cors-v348.js {ECO}")
        p("ecosystem: dropped old origin")
    else:
        p("ecosystem: already clean")

    code, snip = run(f"sed -n '18,22p' {ECO}")
    p("snippet:\n" + snip)

    for cmd in (
        "cd /home/taranom/crm-taranom/server && pm2 delete erp-taranom || true",
        "cd /home/taranom/crm-taranom/server && pm2 start ecosystem.config.js --only erp-taranom",
        "pm2 save",
    ):
        code, out = run(cmd)
        p(f"$ {cmd}\nexit={code}\n{out[-800:]}")

    ready = False
    for i in range(45):
        _c, out = run(
            "curl -sS -o /dev/null -w '%{http_code}' "
            "-H 'Host: erptaranom.com' https://127.0.0.1/api/system/health --insecure"
        )
        if out.strip() == "200":
            p(f"ready after {i}s")
            ready = True
            break
        time.sleep(1)
    if not ready:
        p("WARN health not ready: " + out)

    _c, out = run(
        "pm2 jlist | python3 - <<"
        "'PY'\n"
        "import sys, json\n"
        "d = json.load(sys.stdin)\n"
        "e = next(x['pm2_env'] for x in d if x.get('name') == 'erp-taranom')\n"
        "print(e.get('PUBLIC_URL'))\n"
        "print(e.get('ALLOWED_ORIGINS'))\n"
        "print(e.get('LISTEN_HOST'))\n"
        "print(e.get('status'))\n"
        "PY"
    )
    # fallback without heredoc if shell eats it
    if "erptaranom" not in out:
        _c, out = run(
            "node -e \"const {execSync}=require('child_process');"
            "const d=JSON.parse(execSync('pm2 jlist',{encoding:'utf8'}));"
            "const e=d.find(x=>x.name==='erp-taranom').pm2_env;"
            "console.log([e.PUBLIC_URL,e.ALLOWED_ORIGINS,e.LISTEN_HOST,e.status].join('\\n'));\""
        )
    p("env:\n" + out)

    _c, out = run(
        "curl -sSI --max-redirs 0 -H 'Host: erp.poshaktaranom.com' "
        "https://127.0.0.1/ --insecure | head -15"
    )
    p("old-host redirect:\n" + out)

    _c, out = run(
        "curl -sS https://erptaranom.com/api/system/health; echo; "
        "curl -sS https://erptaranom.com/sw.js | head -2"
    )
    p("public:\n" + out)

    for origin in (
        "https://erptaranom.com",
        "https://www.erptaranom.com",
        "https://erp.poshaktaranom.com",
        "https://evil.example",
    ):
        _c, h = run(
            f"curl -sSI -H 'Origin: {origin}' -H 'Host: erptaranom.com' "
            f"https://127.0.0.1/api/system/health --insecure "
            f"| tr -d '\\r' | grep -iE 'HTTP/|access-control-allow-origin' | head -6"
        )
        p(f"CORS {origin} => {h.strip()}")

    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
