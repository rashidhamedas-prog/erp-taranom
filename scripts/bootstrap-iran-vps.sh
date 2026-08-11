#!/usr/bin/env bash
# Bootstrap ERP ترنم روی VPS ایران (اجرا با sudo روی سرور)
set -euo pipefail

APP_USER="${APP_USER:-taranom}"
APP_ROOT="${APP_ROOT:-/home/${APP_USER}/crm-taranom}"
REPO_URL="${REPO_URL:-https://github.com/rashidhamedas-prog/crm-taranom.git}"
BRANCH="${DEPLOY_BRANCH:-claude/claude-md-docs-2ssrpy}"
DOMAIN="${CRM_DOMAIN:-_}"

export DEBIAN_FRONTEND=noninteractive

echo "==> [1/7] Node.js 20 + tools"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git nginx curl ca-certificates build-essential python3
npm install -g pm2

echo "==> [2/7] Clone/update repo -> ${APP_ROOT}"
if [[ -d "${APP_ROOT}/.git" ]]; then
  cd "${APP_ROOT}"
  sudo -u "${APP_USER}" git fetch origin "${BRANCH}"
  sudo -u "${APP_USER}" git checkout "${BRANCH}"
  sudo -u "${APP_USER}" git pull origin "${BRANCH}"
else
  rm -rf "${APP_ROOT}"
  sudo -u "${APP_USER}" git clone --branch "${BRANCH}" --single-branch "${REPO_URL}" "${APP_ROOT}"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_ROOT}"

echo "==> [3/7] JWT + npm + PM2"
SERVER_DIR="${APP_ROOT}/server"
JWT_FILE="${SERVER_DIR}/jwt-secret.txt"
if [[ ! -f "${JWT_FILE}" ]]; then
  sudo -u "${APP_USER}" bash -lc "cd '${SERVER_DIR}' && node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" > jwt-secret.txt"
  chmod 600 "${JWT_FILE}"
  chown "${APP_USER}:${APP_USER}" "${JWT_FILE}"
fi
sudo -u "${APP_USER}" bash -lc "cd '${SERVER_DIR}' && npm install --omit=dev"

# ensure ecosystem JWT is loaded from file via pm2 start
sudo -u "${APP_USER}" bash -lc "
  cd '${SERVER_DIR}'
  export JWT_SECRET=\$(cat jwt-secret.txt | tr -d '\n')
  pm2 delete erp-taranom >/dev/null 2>&1 || true
  JWT_SECRET=\"\$JWT_SECRET\" pm2 start ecosystem.config.js --update-env
  pm2 save
  pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER} | tail -n 1 | bash || true
  pm2 save
"

echo "==> [4/7] Nginx reverse proxy"
cat >/etc/nginx/sites-available/crm-taranom <<EOF
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name ${DOMAIN};

  client_max_body_size 20m;

  # Security headers
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
ln -sfn /etc/nginx/sites-available/crm-taranom /etc/nginx/sites-enabled/crm-taranom
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> [5/7] Firewall 80/443"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> [6/7] Health checks"
sleep 3
curl -sf "http://127.0.0.1:3000/api/system/time" >/dev/null
curl -sf "http://127.0.0.1/api/system/time" >/dev/null
echo "local+nginx OK"

echo "==> [7/7] Done"
echo "APP_ROOT=${APP_ROOT}"
echo "NODE=$(node -v)"
sudo -u "${APP_USER}" pm2 status || true
echo BOOTSTRAP_OK
