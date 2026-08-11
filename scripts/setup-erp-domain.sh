#!/usr/bin/env bash
# Setup erp.poshaktaranom.com behind nginx + Let's Encrypt
set -euo pipefail
DOMAIN="${1:-erp.poshaktaranom.com}"

echo "==> [1/5] writing nginx HTTP config for ${DOMAIN}"
sudo tee /etc/nginx/sites-available/erp-taranom >/dev/null <<EOF
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name ${DOMAIN} _;

  client_max_body_size 20m;

  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;

  location /.well-known/acme-challenge/ {
    root /var/www/html;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
}
EOF

sudo mkdir -p /var/www/html
sudo nginx -t
sudo systemctl reload nginx
echo "==> nginx reloaded (HTTP OK)"

echo "==> [2/5] install certbot if missing"
if ! command -v certbot >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
fi

echo "==> [3/5] request Let's Encrypt certificate for ${DOMAIN}"
if sudo certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
  echo "==> certbot success"
else
  echo "==> CERTBOT FAILED — keeping HTTP. Check DNS and port 80."
  exit 2
fi

echo "==> [4/5] verify nginx + https"
sudo nginx -t
sudo systemctl reload nginx

echo "==> [5/5] smoke tests"
curl -sI "https://${DOMAIN}/" | head -20 || true
echo "---"
curl -s "https://${DOMAIN}/api/system/time" || true
echo
echo "✅ Done: https://${DOMAIN}"
