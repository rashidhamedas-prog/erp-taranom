# Deploy constants — ERP Taranom (Iran)

Canonical product name: **ERP Taranom** / repo: **erp-taranom**

## Disk path on Iran VPS (DO NOT rename casually)

```text
APP_DIR=/home/taranom/crm-taranom
PM2_NAME=erp-taranom
```

The on-disk folder remains `crm-taranom` for historical deploy/scripts/keystore paths.
GitHub remote is `erp-taranom`; clone into the same APP_DIR or update this file + all deploy scripts together.

## Releases

- Desktop: `/releases/ERP-Taranom-Setup-*.exe`
- Android: `/releases/erp-taranom.apk` (also keep `crm-taranom.apk` copy for old links)

**Important:** APK binaries are usually **not** in git. After changing `manifest.json` URL to `erp-taranom.apk`, on the VPS always ensure the file exists:

```bash
cd /home/taranom/crm-taranom/server/public/releases
# if only legacy name exists:
test -f erp-taranom.apk || cp -f crm-taranom.apk erp-taranom.apk
# verify real APK size (~tens of MB), not SPA fallback (~1.2MB index.html):
curl -sS -o /dev/null -w '%{http_code} %{size_download} %{content_type}\n' http://127.0.0.1:3000/releases/erp-taranom.apk
```

SPA fallback (`app.get('*')`) returns `index.html` for missing files with HTTP 200 — do not trust status alone.
