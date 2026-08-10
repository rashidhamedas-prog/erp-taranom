#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only SHA-256 probe for PROD-P5-R2 Medium-2 deploy evidence.

Computes local hashes of key production BOM files and optionally compares
them to the same paths on the Iran VPS over SSH (sha256sum only — never mutates).
"""
from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("PROBE_SSH_HOST", "94.249.244.208")
USER = os.environ.get("PROBE_SSH_USER", "taranom")
APP = os.environ.get("PROBE_APP_ROOT", "/home/taranom/crm-taranom")
KEY = Path(os.environ.get("PROBE_SSH_KEY", str(Path.home() / ".ssh" / "id_ed25519_taranom")))

REL_PATHS = [
    "server/public/app.js",
    "server/lib/production/bom-advanced.js",
    "server/routes/production-boms.js",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def local_hashes() -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for rel in REL_PATHS:
        p = ROOT / rel
        out[rel] = sha256_file(p) if p.is_file() else None
    return out


def remote_hashes() -> tuple[dict[str, str | None] | None, str]:
    """Return (hashes, note). hashes is None when SSH was skipped/failed."""
    if not KEY.is_file():
        return None, f"SSH key missing: {KEY} — skipped remote"

    try:
        import paramiko
    except ImportError:
        return None, "paramiko not installed — skipped remote"

    try:
        pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            HOST,
            username=USER,
            pkey=pkey,
            timeout=45,
            allow_agent=False,
            look_for_keys=False,
        )
        # Read-only: sha256sum only; never write/pull/reset.
        remote_list = " ".join(f"{APP}/{rel}" for rel in REL_PATHS)
        cmd = f"sha256sum {remote_list} 2>&1"
        _stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        client.close()

        by_rel: dict[str, str | None] = {rel: None for rel in REL_PATHS}
        for line in (out + "\n" + err).splitlines():
            line = line.strip()
            if not line or " " not in line:
                continue
            # sha256sum: "<hash>  <path>" or "<hash> *<path>"
            parts = line.split(None, 1)
            if len(parts) != 2 or len(parts[0]) != 64:
                continue
            digest, path = parts[0], parts[1].lstrip("*")
            for rel in REL_PATHS:
                if path.endswith("/" + rel) or path.endswith(rel.replace("/", os.sep)):
                    by_rel[rel] = digest
                    break
                if path.rstrip("/").endswith(rel):
                    by_rel[rel] = digest
                    break
        note = f"SSH ok ({USER}@{HOST}) exit={code}"
        if code != 0 and not any(by_rel.values()):
            note += f" stderr={err.strip()[:200]!r}"
        return by_rel, note
    except Exception as exc:  # noqa: BLE001 — probe must never fail hard on SSH
        return None, f"SSH failed: {type(exc).__name__}: {exc}"


def main() -> int:
    local = local_hashes()
    remote, note = remote_hashes()

    print("PROD-P5-R2 hash probe (read-only)")
    print(f"local root: {ROOT}")
    print(f"remote:     {note}")
    print()
    header = f"{'file':<42} {'local_sha256':<64} {'remote_sha256':<64} {'match'}"
    print(header)
    print("-" * len(header))

    for rel in REL_PATHS:
        loc = local.get(rel) or "(missing)"
        if remote is None:
            rem = "(skipped)"
            match = "n/a"
        else:
            rem = remote.get(rel) or "(missing)"
            match = "YES" if (
                local.get(rel) and remote.get(rel) and local[rel] == remote[rel]
            ) else "NO"
        print(f"{rel:<42} {loc:<64} {rem:<64} {match}")

    if remote is None:
        print()
        print("NOTE: local hashes printed; remote comparison unavailable. exit 0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
