#!/usr/bin/env bash
# Issue Let's Encrypt cert for erptaranom.com after DNS A → this VPS.
set -euo pipefail
DOMAIN="${1:-erptaranom.com}"
WWW="www.${DOMAIN}"

echo "==> preflight DNS"
dig +short "$DOMAIN" A || true
dig +short "$WWW" A || true

echo "==> certbot nginx for ${DOMAIN} + ${WWW}"
sudo certbot --nginx -d "$DOMAIN" -d "$WWW" \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --redirect --keep-until-expiring

echo "==> harden headers (idempotent notes)"
sudo nginx -t
sudo systemctl reload nginx

echo "==> smoke"
curl -sS -o /dev/null -w "https_apex:%{http_code} ssl:%{ssl_verify_result}\n" "https://${DOMAIN}/api/system/health" || true
curl -sSI "https://${DOMAIN}/" | head -20 || true
echo "OK"
