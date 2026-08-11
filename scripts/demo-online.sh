#!/usr/bin/env bash
# Start (or RESET) the online DEMO instance on the production server.
# Same codebase, fully separate database/uploads — runs on port 3001.
#
#   bash scripts/demo-online.sh
#
# Re-running it wipes and re-seeds the demo DB (nightly reset via cron:
#   0 4 * * * bash /home/taranom-admin/crm-taranom/scripts/demo-online.sh
# ). Login for presentations: demo / demo1234
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${DEMO_DIR:-$HOME/crm-demo}"
mkdir -p "$DEMO"

pm2 delete erp-taranom-demo 2>/dev/null || true
pm2 delete crm-taranom-demo 2>/dev/null || true
rm -f "$DEMO/demo.db" "$DEMO/demo.db-shm" "$DEMO/demo.db-wal"

cd "$ROOT/server"
node scripts/seed-demo.js "$DEMO/demo.db" 4499

DB_PATH="$DEMO/demo.db" UPLOADS_DIR="$DEMO/uploads" PORT=3001 \
  JWT_SECRET="demo-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" \
  pm2 start server.js --name erp-taranom-demo --update-env
pm2 save

echo ""
echo "DEMO ready:  http://45.90.98.99:3001/   (login: demo / demo1234)"
echo "The main app on port 80/3000 is completely untouched."
