#!/usr/bin/env bash
# DEPRECATED — fail-closed.
# The old body wiped files with wildcards, hardcoded a public IP, printed
# well-known passwords, and used `pm2 --update-env` / `pm2 save`.
# Do not restore that behavior.
set -euo pipefail
echo "REFUSED: scripts/demo-online.sh is retired." >&2
echo "Use the isolated V2 demo tooling instead:" >&2
echo "  docs/runbooks/DEMO-V2-SECURE-SALES.md" >&2
echo "  node scripts/demo-v2/provision.js <absolute-demo-root>" >&2
echo "  node server/scripts/seed-demo.js <absolute-db-path>" >&2
echo "  node scripts/demo-v2/launch.js <absolute-demo-root>" >&2
echo "  node scripts/demo-v2/reset.js <absolute-demo-root>" >&2
exit 2
