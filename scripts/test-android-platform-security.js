'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'android/app/src/main/java/ir/taranom/crm/MainActivity.java');
const storePath = path.join(root, 'android/app/src/main/java/ir/taranom/crm/SecureSecretStore.java');
const bootstrapPath = path.join(root, 'android/app/src/main/assets/nodejs-project/main.js');
const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');

const main = fs.readFileSync(mainPath, 'utf8');
const store = fs.readFileSync(storePath, 'utf8');
const bootstrap = fs.readFileSync(bootstrapPath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

check('Android backup is disabled', /android:allowBackup="false"/.test(manifest));
check('global cleartext is disabled', /android:usesCleartextTraffic="false"/.test(manifest));
check('package installer permission is explicit', /android\.permission\.REQUEST_INSTALL_PACKAGES/.test(manifest));
check('WebView file/content access is disabled',
  /setAllowFileAccess\(false\)/.test(main) && /setAllowContentAccess\(false\)/.test(main));
check('WebView file-origin and universal-origin access is disabled',
  /setAllowFileAccessFromFileURLs\(false\)/.test(main)
    && /setAllowUniversalAccessFromFileURLs\(false\)/.test(main));
check('WebView debugging follows BuildConfig.DEBUG',
  /setWebContentsDebuggingEnabled\(BuildConfig\.DEBUG\)/.test(main));
check('root and debuggable environments produce a warning',
  /FLAG_DEBUGGABLE/.test(main) && /isLikelyRooted\(\)/.test(main) && /Security warning/.test(main));

check('JWT key is non-exportable AndroidKeyStore AES-GCM',
  /AndroidKeyStore/.test(store)
    && /KEY_ALGORITHM_AES/.test(store)
    && /BLOCK_MODE_GCM/.test(store)
    && /AES\/GCM\/NoPadding/.test(store));
check('JWT ciphertext uses authenticated AAD and persistent IV',
  /updateAAD\(aad\(context\)\)/.test(store)
    && /PREF_CIPHERTEXT/.test(store)
    && /PREF_IV/.test(store));
check('legacy plaintext is migrated only after encrypted persistence verification',
  /encryptAndPersist\(appContext, prefs, candidate\)[\s\S]*?if \(!persisted\)[\s\S]*?eraseLegacyPlaintext\(legacyFile, dataDir\)/.test(store));
check('legacy plaintext deletion is checked and storage is synced',
  /getFD\(\)\.sync\(\)/.test(store)
    && /!legacyFile\.delete\(\) && legacyFile\.exists\(\)/.test(store));
check('Node receives the in-memory secret and immediately redacts argv',
  /const inMemoryJwtSecret =/.test(bootstrap)
    && /process\.argv\[jwtSecretArgIndex\] = '\[REDACTED\]'/.test(bootstrap)
    && /process\.env\.JWT_SECRET = inMemoryJwtSecret/.test(bootstrap));
check('Node no longer creates plaintext jwt-secret',
  !/function getOrCreateSecret/.test(bootstrap)
    && !/writeFileSync\([^\n]*jwt-secret/.test(bootstrap));

check('verified APK bridge requires URL, SHA-256 and numeric size',
  /downloadVerifiedApk\(String url, String sha256, long size\)/.test(main));
check('APK bridge requires exactly 64 hex SHA-256 characters',
  /\^\[0-9a-f\]\{64\}\$/.test(main));
check('APK bridge rejects missing, zero and oversized payloads',
  /expectedSize <= 0 \|\| expectedSize > MAX_APK_SIZE_BYTES/.test(main));

const hostsMatch = main.match(/APK_UPDATE_HOSTS[\s\S]*?Arrays\.asList\(([^)]*)\)/);
const hosts = hostsMatch
  ? [...hostsMatch[1].matchAll(/"([^"]+)"/g)].map(match => match[1])
  : [];
function allowedApkUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !parsed.username && !parsed.password
      && (!parsed.port || parsed.port === '443')
      && !parsed.hash
      && hosts.includes(parsed.hostname.toLowerCase())
      && parsed.pathname.toLowerCase().endsWith('.apk');
  } catch {
    return false;
  }
}

check('APK HTTPS allowlist accepts the production artifact',
  allowedApkUrl('https://erp.poshaktaranom.com/releases/erp-taranom.apk'));
check('APK HTTPS allowlist rejects scheme/host/port/userinfo/fragment/path attacks', [
  'http://erp.poshaktaranom.com/releases/erp-taranom.apk',
  'https://evil.example/releases/erp-taranom.apk',
  'https://erp.poshaktaranom.com.evil.example/release.apk',
  'https://erp.poshaktaranom.com:444/release.apk',
  'https://user@erp.poshaktaranom.com/release.apk',
  'https://erp.poshaktaranom.com/release.apk#fragment',
  'https://erp.poshaktaranom.com/release.exe',
].every(value => !allowedApkUrl(value)));

check('DownloadManager reports and enforces byte size before install',
  /COLUMN_BYTES_DOWNLOADED_SO_FAR/.test(main)
    && /COLUMN_TOTAL_SIZE_BYTES/.test(main)
    && /actualSize == expectedSize/.test(main));
check('downloaded APK is streamed through SHA-256 and constant-time comparison',
  /MessageDigest\.getInstance\("SHA-256"\)/.test(main)
    && /MessageDigest\.isEqual\(expectedHash, digest\.digest\(\)\)/.test(main));
check('APK package identity and version are verified before install',
  /getPackageArchiveInfo\(apkFile\.getAbsolutePath\(\), flags\)/.test(main)
    && /BuildConfig\.APPLICATION_ID\.equals\(archive\.packageName\)/.test(main)
    && /getLongVersionCode\(archive\) <= getLongVersionCode\(installed\)/.test(main));
check('APK signer certificate digest must equal the installed signer digest',
  /GET_SIGNING_CERTIFICATES/.test(main)
    && /getApkContentsSigners\(\)/.test(main)
    && /archiveSigners\.equals\(installedSigners\)/.test(main)
    && /return "signer_mismatch"/.test(main));
check('mismatched APK is removed',
  /"sha256_mismatch" : "size_mismatch"/.test(main)
    && /dm\.remove\(id\)/.test(main));
check('installer is reachable only after both hash and size pass',
  main.indexOf('if (!sizeMatches || !hashMatches)')
    < main.indexOf('verifyApkIdentityAndSigner(apkFile)')
    && main.indexOf('verifyApkIdentityAndSigner(apkFile)')
      < main.indexOf('launchVerifiedApkInstaller(apkUri, dm, id)'));
check('installer uses explicit package-install action with read grant',
  /Intent\.ACTION_INSTALL_PACKAGE/.test(main)
    && /FLAG_GRANT_READ_URI_PERMISSION/.test(main));
check('generic ACTION_VIEW fallback is absent', !/Intent\.ACTION_VIEW/.test(main));
check('unstructured WebView APK downloads are blocked',
  /Blocked APK download without verified metadata/.test(main));

console.log(`android platform security: ${passed}/${passed + failed} pass`);
process.exit(failed ? 1 : 0);
