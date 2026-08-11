#!/usr/bin/env bash
# Recover production DB after SQLITE_CORRUPT rollback removed Mahak import.
# Run ON THE SERVER from repo root:
#   bash server/scripts/recover-production-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER_DIR="$(pwd)"

echo "==> CRM production DB recovery"
echo "    dir: $SERVER_DIR"

CORRUPT=""
for f in crm.db.corrupted crm.db.corrupted- crm.db.corrupted.*; do
  [[ -f "$f" ]] && CORRUPT="$f" && break
done

if [[ -z "$CORRUPT" ]]; then
  echo "ERROR: no crm.db.corrupted* file found"
  ls -lh crm.db* 2>/dev/null || true
  exit 1
fi

echo "==> Found corrupt backup: $CORRUPT ($(du -h "$CORRUPT" | cut -f1))"

if ! command -v sqlite3 >/dev/null; then
  echo "ERROR: sqlite3 CLI required (apt install sqlite3)"
  exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
OUT="crm-mahak-recovered-${TS}.db"
SQL="crm-mahak-recovered-${TS}.sql"

echo "==> Attempting .recover from $CORRUPT ..."
if sqlite3 "$CORRUPT" ".recover" > "$SQL" 2>/dev/null; then
  rm -f "$OUT"
  sqlite3 "$OUT" < "$SQL"
  IC=$(sqlite3 "$OUT" "PRAGMA integrity_check;" | head -1)
  JE=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM journal_entries;" 2>/dev/null || echo 0)
  MAHAK=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM journal_entries WHERE src_system='mahak';" 2>/dev/null || echo 0)
  echo "    recovered: integrity=$IC journal_entries=$JE mahak=$MAHAK"
  if [[ "$IC" == "ok" && "$MAHAK" -gt 0 ]]; then
    cp crm.db "crm.db.before-recover-${TS}.db" 2>/dev/null || true
    rm -f crm.db-shm crm.db-wal
    cp "$OUT" crm.db
    echo "==> SUCCESS: crm.db replaced with recovered Mahak DB"
    echo "    Restart: pm2 restart erp-taranom"
    exit 0
  fi
fi

echo "==> .recover failed or incomplete — re-import from Excel required:"
echo "    pm2 stop erp-taranom"
echo "    cp crm.db backups/pre-recover-${TS}.db"
echo "    node scripts/import-mahak-journal.js <coding.xlsx> <roznameh.xlsx> crm.db"
echo "    node scripts/import-mahak-stock.js <mojodi.xlsx> crm.db"
echo "    pm2 restart erp-taranom"
exit 2
