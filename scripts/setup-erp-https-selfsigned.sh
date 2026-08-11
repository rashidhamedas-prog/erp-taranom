#!/usr/bin/env bash
# HTTPS for erp.poshaktaranom.com without certbot (Iran apt/snap often blocked).
# Uses OpenSSL self-signed cert. Pair with Cloudflare SSL mode "Full" (orange cloud)
# OR replace with Cloudflare Origin Certificate later.
set -euo pipefail
DOMAIN="${1:-erp.poshaktaranom.com}"
CERT_DIR="/etc/ssl/taranom"
KEY="${CERT_DIR}/${DOMAIN}.key"
CRT="${CERT_DIR}/${DOMAIN}.crt"

echo "==> [1/4] ensure certificate at ${CRT}"
sudo mkdir -p "${CERT_DIR}"
if [ ! -f "${KEY}" ] || [ ! -f "${CRT}" ]; then
  sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "${KEY}" -out "${CRT}" \
    -subj "/CN=${DOMAIN}/O=Poshak Taranom/C=IR" \
    -addext "subjectAltName=DNS:${DOMAIN}"
  sudo chmod 600 "${KEY}"
  echo "    created self-signed cert"
else
  echo "    cert already exists — keeping"
fi

echo "==> [2/4] write nginx HTTP+HTTPS config"
sudo tee /etc/nginx/sites-available/erp-taranom >/dev/null <<EOF
# Redirect HTTP -> HTTPS
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name ${DOMAIN} _;
  client_max_body_size 20m;

  location /.well-known/acme-challenge/ {
    root /var/www/html;
  }

  location / {
    return 301 https://\$host\$request_uri;
  }
}

server {
  listen 443 ssl http2 default_server;
  listen [::]:443 ssl http2 default_server;
  server_name ${DOMAIN} _;

  ssl_certificate     ${CRT};
  ssl_certificate_key ${KEY};
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;

  client_max_body_size 20m;

  add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;

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
echo "==> [3/4] nginx test + reload"
sudo nginx -t
sudo systemctl reload nginx

echo "==> [4/4] set PUBLIC_URL for pm2 (if ecosystem supports env)"
cd "$HOME/erp-taranom/server"
# Persist PUBLIC_URL into a local env file that ecosystem can read — or pm2 set
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart erp-taranom --update-env || true
fi

echo "==> smoke"
ss -lntp | grep -E ':80|:443' || sudo ss -lntp | grep -E ':80|:443'
curl -skI "https://127.0.0.1/" -H "Host: ${DOMAIN}" | head -15
curl -sk "https://127.0.0.1/api/system/time" -H "Host: ${DOMAIN}"
echo
echo "✅ HTTPS enabled for ${DOMAIN}"
echo "Cloudflare: Proxy ON (orange) + SSL/TLS mode = Full"
echo "Optional: replace ${CRT} with Cloudflare Origin Certificate for no browser warning on DNS-only."
