#!/usr/bin/env bash
# Wait until public DNS for erptaranom.com points here, then issue LE cert.
set -euo pipefail
DOMAIN="${1:-erptaranom.com}"
EXPECT_IP="${2:-94.249.244.208}"
TRIES="${3:-40}"

for i in $(seq 1 "$TRIES"); do
  A=$(dig +short "$DOMAIN" A | head -1 || true)
  NS=$(dig +short "$DOMAIN" NS | tr '\n' ' ' || true)
  echo "[$i/$TRIES] A=$A NS=$NS"
  if [[ "$A" == "$EXPECT_IP" ]]; then
    echo "==> DNS ready — issuing cert"
    sudo bash /home/taranom/crm-taranom/scripts/_issue-le-erptaranom.sh "$DOMAIN" || \
      sudo certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
        --non-interactive --agree-tos --register-unsafely-without-email --redirect
    curl -sS -o /dev/null -w "https:%{http_code}\n" "https://${DOMAIN}/api/system/health" || true
    exit 0
  fi
  sleep 30
done
echo "DNS not ready after ${TRIES} tries" >&2
exit 2
