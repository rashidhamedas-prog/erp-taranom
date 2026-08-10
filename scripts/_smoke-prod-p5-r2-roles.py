#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HTTP smoke for PROD-P5-R2 Medium-2 — health + optional role/BOM checks.

Never mutates the VPS (no git pull/reset). Optional login uses env credentials only.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("SMOKE_BASE_URL", "https://erp.poshaktaranom.com").rstrip("/")
# Direct VPS fallback when CDN/WAF returns 403 on the public hostname.
VPS_FALLBACK = os.environ.get("SMOKE_VPS_FALLBACK", "http://94.249.244.208:3000").rstrip("/")
USER = os.environ.get("SMOKE_USER", "")
PASS = os.environ.get("SMOKE_PASS", "")
OP_USER = os.environ.get("SMOKE_OP_USER", "")
OP_PASS = os.environ.get("SMOKE_OP_PASS", "")
BOM_ID = os.environ.get("SMOKE_BOM_ID", "")

UI_MARKERS = ("اقلام", "مسیر عملیات", "خروجی‌ها", "بهای تمام‌شده")
COST_KEY_HINTS = ("_rial", "unit_cost", "std_cost", "var_price", "var_qty", "var_total")


def http(method: str, path: str, token: str | None = None, body: dict | None = None, timeout: int = 30, base: str | None = None):
    root = (base or BASE).rstrip("/")
    url = path if path.startswith("http") else root + path
    data = None
    headers = {"Accept": "application/json, text/plain, */*"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            text = raw.decode("utf-8", "replace")
            parsed = None
            if "json" in ctype or (text[:1] in "{["):
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    parsed = None
            return resp.status, text, parsed
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        parsed = None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            pass
        return e.code, raw, parsed
    except Exception as exc:  # noqa: BLE001
        return 0, f"{type(exc).__name__}: {exc}", None


def ssh_localhost_get(path: str) -> tuple[int, str]:
    """Read-only curl via SSH to VPS loopback (when CDN/WAF blocks the public host)."""
    key = os.environ.get("SMOKE_SSH_KEY") or str(Path.home() / ".ssh" / "id_ed25519_taranom")
    host = os.environ.get("SMOKE_SSH_HOST", "taranom@94.249.244.208")
    if not Path(key).is_file():
        return 0, "no_ssh_key"
    # Avoid piping large Persian HTML through Windows console encodings:
    # status on stdout, body size + optional json snippet for API paths.
    if path.startswith("/api/"):
        remote = (
            "curl -sS -o /tmp/p5r2-smoke.out -w '%{http_code}' "
            f"http://127.0.0.1:3000{path}; echo; cat /tmp/p5r2-smoke.out"
        )
    else:
        remote = (
            "curl -sS -o /tmp/p5r2-smoke.out -w '%{http_code}' "
            f"http://127.0.0.1:3000{path}; echo; wc -c </tmp/p5r2-smoke.out"
        )
    try:
        import subprocess
        r = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-i", key, host, remote],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
        )
        if r.returncode != 0:
            return 0, (r.stderr or r.stdout or "ssh_fail")[:200]
        lines = (r.stdout or "").splitlines()
        if not lines:
            return 0, "empty"
        try:
            code = int(lines[0].strip())
        except ValueError:
            return 0, lines[0][:120]
        return code, "\n".join(lines[1:])
    except Exception as exc:  # noqa: BLE001
        return 0, f"{type(exc).__name__}: {exc}"


def resolve_base() -> str:
    """Prefer canonical domain; fall back to SSH loopback evidence if WAF blocks."""
    global BASE
    status, _text, body = http("GET", "/api/system/health", base=BASE, timeout=20)
    if status == 200:
        return BASE
    if VPS_FALLBACK and VPS_FALLBACK != BASE:
        st2, _t2, body2 = http("GET", "/api/system/health", base=VPS_FALLBACK, timeout=20)
        if st2 == 200:
            print(f"  [INFO] canonical base returned {status}; using VPS fallback {VPS_FALLBACK}")
            BASE = VPS_FALLBACK
            return BASE
        print(f"  [INFO] health probe canonical={status} vps={st2}")
    return BASE


def check(label: str, ok: bool, detail: str = "") -> bool:
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label}" + (f" — {detail}" if detail else ""))
    return ok


def login(username: str, password: str) -> str | None:
    status, text, body = http("POST", "/api/auth/login", body={"username": username, "password": password})
    if status != 200 or not isinstance(body, dict):
        print(f"  [FAIL] login {username!r} status={status} body={text[:160]!r}")
        return None
    token = body.get("token")
    if not token:
        print(f"  [FAIL] login {username!r}: no token in response")
        return None
    role = (body.get("user") or {}).get("role") or body.get("role") or "?"
    print(f"  [PASS] login {username!r} role={role}")
    return token


def has_cost_fields(obj, depth: int = 0) -> list[str]:
    found: list[str] = []
    if depth > 6:
        return found
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if any(h in kl for h in COST_KEY_HINTS) or kl in {
                "cost", "costs", "pricing", "breakdown", "standard", "variance", "cogs",
            }:
                found.append(k)
            found.extend(has_cost_fields(v, depth + 1))
    elif isinstance(obj, list):
        for item in obj[:20]:
            found.extend(has_cost_fields(item, depth + 1))
    return found


def probe_bom(token: str, bom_id: str, expect_cost_stripped: bool | None) -> list[bool]:
    results: list[bool] = []
    endpoints = [
        f"/api/production/boms/{bom_id}",
        f"/api/production/boms/{bom_id}/operations",
        f"/api/production/boms/{bom_id}/routing",
        f"/api/production/boms/{bom_id}/outputs",
    ]
    # std-cost needs production_cost:view — operator may get 403; that's OK for strip check.
    for path in endpoints:
        status, _text, body = http("GET", path, token=token)
        ok = status == 200
        results.append(check(f"GET {path}", ok, f"status={status}"))
        if ok and expect_cost_stripped is not None and isinstance(body, (dict, list)):
            hits = has_cost_fields(body)
            if expect_cost_stripped:
                results.append(check(
                    f"cost-strip {path}",
                    len(hits) == 0,
                    f"leaked={hits[:8]}" if hits else "no cost keys",
                ))
            else:
                # Admin/accountant: presence is informational, not required (BOM may be empty).
                print(f"  [INFO] cost keys sample {path}: {hits[:8] or '(none in payload)'}")

    status, _text, body = http("GET", f"/api/production/boms/{bom_id}/std-cost", token=token)
    if expect_cost_stripped:
        # Operator without production_cost:view → 403, or 200 with stripped empty cost blocks.
        if status == 403:
            results.append(check("GET .../std-cost (operator)", True, "403 as expected without production_cost"))
        elif status == 200:
            hits = has_cost_fields(body) if isinstance(body, (dict, list)) else []
            results.append(check("GET .../std-cost stripped", len(hits) == 0, f"status=200 leaked={hits[:8]}"))
        else:
            results.append(check("GET .../std-cost (operator)", False, f"status={status}"))
    else:
        results.append(check("GET .../std-cost", status in (200, 403, 404), f"status={status}"))
    return results


def check_ui_markers() -> list[bool]:
    results: list[bool] = []
    # Prefer live app.js; fall back to local file if CDN/cache fails.
    status, text, _ = http("GET", "/app.js", timeout=45)
    source = "remote /app.js"
    if status != 200 or not text:
        status2, text2, _ = http("GET", "/", timeout=45)
        if status2 == 200 and text2:
            text = text2
            source = "remote /"
        else:
            local = ROOT / "server" / "public" / "app.js"
            if local.is_file():
                text = local.read_text(encoding="utf-8", errors="replace")
                source = f"local {local}"
            else:
                results.append(check("UI markers source", False, f"app.js HTTP {status}"))
                return results
    print(f"  [INFO] UI marker source: {source} ({len(text)} chars)")
    for marker in UI_MARKERS:
        results.append(check(f"UI marker {marker!r}", marker in text))
    return results


def main() -> int:
    print(f"PROD-P5-R2 role smoke — preferred base={BASE}")
    print("(no blind pull; HTTP checks only)")
    print()
    resolve_base()
    print(f"PROD-P5-R2 role smoke — active base={BASE}")
    print()

    results: list[bool] = []

    print("== public ==")
    use_ssh_public = False
    for path in ("/", "/api/system/health", "/api/system/ready"):
        status, text, body = http("GET", path)
        if status != 200:
            use_ssh_public = True
            break
        detail = f"status={status}"
        if path.endswith("/health") and isinstance(body, dict):
            detail += f" ok={body.get('ok')!r}"
        elif path.endswith("/ready") and isinstance(body, dict):
            detail += f" ok={body.get('ok')!r}"
        elif path == "/":
            detail += f" bytes={len(text)}"
        results.append(check(f"GET {path}", True, detail))
    if use_ssh_public:
        print("  [INFO] public HTTP blocked; verifying via SSH localhost curl (read-only)")
        for path in ("/", "/api/system/health", "/api/system/ready"):
            code, body = ssh_localhost_get(path)
            ok = code == 200
            detail = f"ssh_localhost status={code}"
            if "health" in path and '"ok":true' in body.replace(" ", ""):
                detail += " ok=true"
            if "ready" in path and '"ok":true' in body.replace(" ", ""):
                detail += " ready=true"
            if path == "/":
                detail += f" bytes={len(body)}"
            results.append(check(f"GET {path} (ssh)", ok, detail))

    print()
    print("== UI markers ==")
    results.extend(check_ui_markers())

    discovered_bom_id = BOM_ID

    print()
    print("== authenticated BOM ==")
    if not USER or not PASS:
        print("  [SKIP] set SMOKE_USER/SMOKE_PASS to exercise login + BOM endpoints")
    else:
        token = login(USER, PASS)
        if not token:
            results.append(False)
        else:
            bom_id = discovered_bom_id
            if not bom_id:
                status, _t, body = http("GET", "/api/production/boms", token=token)
                if status == 200 and isinstance(body, dict):
                    rows = body.get("rows") or body.get("items") or []
                    if isinstance(rows, list) and rows:
                        bom_id = str(rows[0].get("id") or "")
                        print(f"  [INFO] using first BOM id={bom_id}")
                elif status == 200 and isinstance(body, list) and body:
                    bom_id = str(body[0].get("id") or "")
                    print(f"  [INFO] using first BOM id={bom_id}")
                else:
                    print(f"  [INFO] list BOMs status={status}; set SMOKE_BOM_ID to probe a specific BOM")
            if bom_id:
                discovered_bom_id = bom_id
                results.extend(probe_bom(token, bom_id, expect_cost_stripped=None))
            else:
                print("  [SKIP] no BOM id available")

    if OP_USER and OP_PASS:
        print()
        print("== production_operator cost strip ==")
        op_token = login(OP_USER, OP_PASS)
        if not op_token:
            results.append(False)
        else:
            bom_id = discovered_bom_id
            if not bom_id:
                status, _t, body = http("GET", "/api/production/boms", token=op_token)
                if status == 200:
                    rows = body.get("rows") if isinstance(body, dict) else body
                    if isinstance(rows, list) and rows:
                        bom_id = str(rows[0].get("id") or "")
                        print(f"  [INFO] operator using BOM id={bom_id}")
                if not bom_id:
                    print(f"  [SKIP] operator could not resolve a BOM id (list status={status})")
            if bom_id:
                results.extend(probe_bom(op_token, bom_id, expect_cost_stripped=True))
    else:
        print()
        print("  [SKIP] set SMOKE_OP_USER/SMOKE_OP_PASS to verify production_operator cost strip")

    print()
    failed = sum(1 for r in results if not r)
    passed = sum(1 for r in results if r)
    print(f"Summary: {passed} passed, {failed} failed (of {len(results)} checks)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
