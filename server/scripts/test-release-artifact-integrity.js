'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const releaseDir = path.join(__dirname, '..', 'public', 'releases');
const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
const requireArtifacts = process.argv.includes('--require-artifacts');

function digest(filePath, algorithm) {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(filePath));
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

function artifactPath(url) {
  const parsed = new URL(url, 'https://release.invalid');
  assert.strictEqual(parsed.origin, 'https://release.invalid', 'release URL must be relative');
  assert.strictEqual(parsed.username, '', 'release URL must not contain credentials');
  assert.strictEqual(parsed.password, '', 'release URL must not contain credentials');
  assert.ok(parsed.pathname.startsWith('/releases/'), 'release URL must stay below /releases');
  const name = decodeURIComponent(parsed.pathname.slice('/releases/'.length));
  assert.strictEqual(name, path.basename(name), 'release filename must not traverse directories');
  return path.join(releaseDir, name);
}

function verifyManifestArtifact(platform) {
  const item = manifest[platform];
  assert.ok(item && item.url, `${platform} release URL is required`);
  assert.match(String(item.sha256 || ''), /^[a-f0-9]{64}$/i, `${platform} SHA-256 is required`);
  assert.ok(Number.isSafeInteger(item.size) && item.size > 0, `${platform} size is required`);
  const filePath = artifactPath(item.url);
  if (!fs.existsSync(filePath)) {
    if (requireArtifacts) assert.fail(`${platform} artifact is missing: ${path.basename(filePath)}`);
    console.log(`SKIP ${platform}: ignored binary is not present in this checkout`);
    return;
  }
  assert.strictEqual(fs.statSync(filePath).size, item.size, `${platform} size mismatch`);
  assert.strictEqual(digest(filePath, 'sha256').toLowerCase(), item.sha256.toLowerCase(), `${platform} SHA-256 mismatch`);
  console.log(`OK ${platform}: size + SHA-256 match manifest`);
}

verifyManifestArtifact('android');
verifyManifestArtifact('desktop');

const latestPath = path.join(releaseDir, 'latest.yml');
const latest = fs.readFileSync(latestPath, 'utf8');
const latestVersion = latest.match(/^version:\s*(\S+)\s*$/m)?.[1];
const latestSize = Number(latest.match(/^\s*size:\s*(\d+)\s*$/m)?.[1]);
const latestSha512 = latest.match(/^sha512:\s*(\S+)\s*$/m)?.[1];
const latestInstaller = latest.match(/^path:\s*(.+?)\s*$/m)?.[1];
assert.strictEqual(latestVersion, manifest.desktop.version, 'latest.yml version must match manifest');
assert.strictEqual(latestSize, manifest.desktop.size, 'latest.yml size must match manifest');
assert.strictEqual(latestSha512, manifest.desktop.sha512, 'latest.yml SHA-512 must match manifest');

const installerPath = path.join(releaseDir, latestInstaller || '');
if (fs.existsSync(installerPath)) {
  assert.strictEqual(fs.statSync(installerPath).size, latestSize, 'latest.yml installer size mismatch');
  assert.strictEqual(digest(installerPath, 'sha512'), latestSha512, 'latest.yml installer SHA-512 mismatch');
  assert.strictEqual(digest(installerPath, 'sha256').toLowerCase(), manifest.desktop.sha256.toLowerCase(), 'installer aliases differ');
  console.log('OK desktop feed: version + size + SHA-512 + alias SHA-256 match');
} else if (requireArtifacts) {
  assert.fail(`latest.yml installer is missing: ${latestInstaller}`);
} else {
  console.log('SKIP desktop feed binary: ignored installer is not present in this checkout');
}

console.log('OK release artifact integrity metadata');
