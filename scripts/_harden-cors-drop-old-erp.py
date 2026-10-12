#!/usr/bin/env python3
"""Post-cutover harden: drop retired origin from CORS; ensure old host 301; verify."""
from __future__ import annotations

import json
import pathlib
import re
import sys

import paramiko

HOST = "94.249.244.208"
USER = "taranom"
REMOTE_NGINX = "/etc/nginx/sites-available/crm-taranom"
NEW_ORIGINS = "https://erptaranom.com,https://www.erptaranom.com"
ECO = "/home/taranom/crm-taranom/server/ecosystem.config.js"


def find_key() -> pathlib.Path:
    for p in (
        pathlib.Path.home() / ".ssh" / "id_ed25519_taranom",
        pathlib.Path(r"D:\proje\.ssh\id_ed25519_taranom"),
    ):
        if p.exists():
            return p
    raise SystemExit("SSH key not found")


def main() -> int:
    key = find_key()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(key), timeout=30)

    def run(cmd: str, timeout: int = 90) -> tuple[int, str]:
        _i, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode(errors="replace") + stderr.read().decode(errors="replace")
        return stdout.channel.recv_exit_status(), out

    # --- nginx: old host -> 301 apex ---
    code, text = run(f"sudo cat {REMOTE_NGINX}")
    if code != 0:
        print(text)
        return 1

    changed_nginx = False
    if "return 301 https://erptaranom.com$request_uri" not in text:
        pat = re.compile(
            r"(server \{[^\n]*\n(?:.*\n)*?\s*server_name erp\.poshaktaranom\.com;\n(?:.*\n)*?)"
            r"(\s*location / \{[\s\S]*?\n\s*\})",
            re.M,
        )

        def repl(m: re.Match[str]) -> str:
            return (
                m.group(1)
                + "  location / {\n"
                + "    return 301 https://erptaranom.com$request_uri;\n"
                + "  }"
            )

        new, n = pat.subn(repl, text, count=1)
        if n == 0:
            print("WARN: old erp.poshaktaranom.com block not matched")
        else:
            sftp = client.open_sftp()
            with sftp.file("/tmp/crm-taranom.harden-cors.conf", "w") as f:
                f.write(new)
            sftp.close()
            for cmd in (
                f"sudo cp -a {REMOTE_NGINX} {REMOTE_NGINX}.bak-harden-cors",
                f"sudo cp /tmp/crm-taranom.harden-cors.conf {REMOTE_NGINX}",
                "sudo nginx -t",
                "sudo systemctl reload nginx",
            ):
                c, o = run(cmd)
                print(f"$ {cmd}\nexit={c}\n{o}")
                if c != 0 and "nginx -t" in cmd:
                    run(f"sudo cp -a {REMOTE_NGINX}.bak-harden-cors {REMOTE_NGINX}")
                    run("sudo nginx -t && sudo systemctl reload nginx")
                    client.close()
                    return 1
            changed_nginx = True
    else:
        print("nginx: old-host 301 already present")

    # --- ecosystem on VPS: drop old origin default ---
    code, eco = run(f"cat {ECO}")
    if code != 0:
        print(eco)
        return 1
    eco2 = eco
    eco2 = re.sub(
        r"// Canonical:.*\nconst ALLOWED_ORIGINS = process\.env\.ALLOWED_ORIGINS\n"
        r"  \|\| '[^']*';",
        "// Canonical: erptaranom.com only (retired erp.poshaktaranom.com dropped from CORS after cutover).\n"
        "const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS\n"
        f"  || '{NEW_ORIGINS}';",
        eco2,
        count=1,
    )
    if eco2 == eco:
        # simpler replace
        if "https://erp.poshaktaranom.com" in eco:
            eco2 = eco.replace(
                "https://erptaranom.com,https://www.erptaranom.com,https://erp.poshaktaranom.com",
                NEW_ORIGINS,
            )
            eco2 = eco2.replace(
                "Keep retired erp.poshaktaranom.com in CORS only until DNS cutover completes.",
                "Retired erp.poshaktaranom.com dropped from CORS after cutover.",
            )
    if eco2 != eco:
        sftp = client.open_sftp()
        with sftp.file("/tmp/ecosystem.harden-cors.js", "w") as f:
            f.write(eco2)
        sftp.close()
        c, o = run(f"cp /tmp/ecosystem.harden-cors.js {ECO}")
        print(f"ecosystem updated exit={c}\n{o}")
    else:
        print("ecosystem: already without old origin (or pattern mismatch)")
        print("snippet:", "\n".join(eco.splitlines()[17:23]))

    # restart with new env from ecosystem (delete+start so env reloads; no --update-env on secrets)
    for cmd in (
        "cd /home/taranom/crm-taranom/server && pm2 delete erp-taranom || true",
        "cd /home/taranom/crm-taranom/server && pm2 start ecosystem.config.js --only erp-taranom",
        "pm2 save",
    ):
        c, o = run(cmd, timeout=120)
        safe = o[-2000:].encode("ascii", "replace").decode("ascii")
        print(f"$ {cmd}\nexit={c}\n{safe}")

    # wait ready
    import time

    for i in range(30):
        c, o = run(
            "curl -sS -o /dev/null -w '%{http_code}' https://127.0.0.1/api/system/health "
            "-H 'Host: erptaranom.com' --insecure"
        )
        if o.strip() == "200":
            print(f"ready after {i}s: 200")
            break
        time.sleep(1)
    else:
        print("WARN: health not 200 yet:", o)

    # verify env
    c, o = run(
        "pm2 jlist | python3 -c \"import sys,json;d=json.load(sys.stdin);"
        "e=next(x['pm2_env'] for x in d if x.get('name')=='erp-taranom');"
        "print('PUBLIC_URL',e.get('PUBLIC_URL'));"
        "print('ALLOWED_ORIGINS',e.get('ALLOWED_ORIGINS'));"
        "print('LISTEN_HOST',e.get('LISTEN_HOST'));"
        "print('status',e.get('status'))\""
    )
    print(o)

    # local Host-based redirect check
    c, o = run(
        "curl -sSI --max-redirs 0 -H 'Host: erp.poshaktaranom.com' https://127.0.0.1/ --insecure | head -20"
    )
    print("old-host local:\n", o)

    # CORS checks
    for origin, expect in (
        ("https://erptaranom.com", "allow"),
        ("https://www.erptaranom.com", "allow"),
        ("https://erp.poshaktaranom.com", "deny"),
        ("https://evil.example", "deny"),
    ):
        c, o = run(
            f"curl -sS -o /dev/null -w '%{{http_code}}' -H 'Origin: {origin}' "
            f"-H 'Host: erptaranom.com' https://127.0.0.1/api/system/health --insecure"
        )
        # Also check ACAO header on OPTIONS-ish GET
        c2, h = run(
            f"curl -sSI -H 'Origin: {origin}' -H 'Host: erptaranom.com' "
            f"https://127.0.0.1/api/system/health --insecure | tr -d '\\r' | grep -i access-control-allow-origin || true"
        )
        print(f"CORS origin={origin} status={o.strip()} acao={h.strip()!r} expect={expect}")

    print("changed_nginx=", changed_nginx)
    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
