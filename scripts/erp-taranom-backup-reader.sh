#!/bin/sh
set -eu

BACKUP_DIR=/home/taranom/crm-taranom/server/backups
ORIGINAL_COMMAND=${SSH_ORIGINAL_COMMAND-}

case "$ORIGINAL_COMMAND" in
  erp-backup-list)
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'crm-backup-*.zip.enc' -printf '%f\n' |
      LC_ALL=C sort
    ;;
  'scp -f '*)
    requested=${ORIGINAL_COMMAND#scp -f }
    base=$(basename -- "$requested")
    case "$base" in
      crm-backup-????????-??????.zip.enc|crm-backup-????????-??????.zip.enc.sha256) ;;
      *) exit 126 ;;
    esac
    [ "$requested" = "$BACKUP_DIR/$base" ] || exit 126
    [ -f "$BACKUP_DIR/$base" ] || exit 1
    exec /usr/bin/scp -f -- "$BACKUP_DIR/$base"
    ;;
  *) exit 126 ;;
esac
