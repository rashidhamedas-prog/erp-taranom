#!/usr/bin/env python3
"""
Sync erptaranom.com A/CAA records from scripts/dns-erptaranom.zone intent to Cloudflare.

True AXFR secondary requires Cloudflare Enterprise. This implements multi-primary:
Iran BIND + Cloudflare full zone (DNS-only), kept in sync.

Requires env: CLOUDFLARE_API_TOKEN (Zone.DNS Edit on erptaranom.com)
Optional: CLOUDFLARE_ZONE_ID (default: erptaranom.com zone)
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

ZONE_ID = os.environ.get("CLOUDFLARE_ZONE_ID", "43c759b6ee3b9ccf96015e5b451a6636")
ORIGIN = "94.249.244.208"
DESIRED = [
    {"type": "A", "name": "erptaranom.com", "content": ORIGIN, "proxied": False, "ttl": 300},
    {"type": "A", "name": "www.erptaranom.com", "content": ORIGIN, "proxied": False, "ttl": 300},
    {"type": "A", "name": "ns1.erptaranom.com", "content": ORIGIN, "proxied": False, "ttl": 300},
    {"type": "A", "name": "ns2.erptaranom.com", "content": ORIGIN, "proxied": False, "ttl": 300},
    {"type": "CAA", "name": "erptaranom.com", "data": {"flags": 0, "tag": "issue", "value": "letsencrypt.org"}, "ttl": 300},
    {"type": "CAA", "name": "erptaranom.com", "data": {"flags": 0, "tag": "issuewild", "value": "letsencrypt.org"}, "ttl": 300},
]


def api(method: str, path: str, body: dict | None = None) -> dict:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        raise SystemExit("CLOUDFLARE_API_TOKEN missing")
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        raise SystemExit(f"HTTP {e.code}: {err}") from e


def main() -> int:
    listed = api("GET", f"/zones/{ZONE_ID}/dns_records?per_page=100")
    existing = listed.get("result") or []
    print(f"existing={len(existing)}")

    def find_a(name: str) -> dict | None:
        for r in existing:
            if r.get("type") == "A" and r.get("name") == name:
                return r
        return None

    for want in DESIRED:
        if want["type"] == "A":
            cur = find_a(want["name"])
            if cur:
                if (
                    cur.get("content") == want["content"]
                    and cur.get("proxied") is False
                ):
                    print(f"OK A {want['name']}")
                    continue
                r = api(
                    "PUT",
                    f"/zones/{ZONE_ID}/dns_records/{cur['id']}",
                    {
                        "type": "A",
                        "name": want["name"],
                        "content": want["content"],
                        "ttl": want["ttl"],
                        "proxied": False,
                    },
                )
                print(f"UPD A {want['name']} success={r.get('success')}")
            else:
                r = api("POST", f"/zones/{ZONE_ID}/dns_records", want)
                print(f"ADD A {want['name']} success={r.get('success')}")
        elif want["type"] == "CAA":
            tag = want["data"]["tag"]
            val = want["data"]["value"]
            cur = next(
                (
                    r
                    for r in existing
                    if r.get("type") == "CAA"
                    and r.get("name") == want["name"]
                    and (r.get("data") or {}).get("tag") == tag
                ),
                None,
            )
            body = {
                "type": "CAA",
                "name": want["name"],
                "data": want["data"],
                "ttl": want["ttl"],
            }
            if cur:
                r = api("PUT", f"/zones/{ZONE_ID}/dns_records/{cur['id']}", body)
                print(f"UPD CAA {tag} success={r.get('success')}")
            else:
                r = api("POST", f"/zones/{ZONE_ID}/dns_records", body)
                print(f"ADD CAA {tag} success={r.get('success')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
