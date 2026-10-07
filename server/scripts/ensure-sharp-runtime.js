#!/usr/bin/env node
'use strict';

/**
 * Post-npm-install guard for Iran VPS (and any host without x86-64-v2).
 *
 * Source/CI pin sharp@0.35.0. Waiver W0-OPS-002-SHARP-RUNTIME-0335 allows
 * runtime 0.33.5 when CPU cannot load 0.35. Routine `npm install` overwrites
 * the waived module and leaves uploads broken until this restore runs.
 *
 * Usage (from server/):
 *   node scripts/ensure-sharp-runtime.js
 *   node scripts/ensure-sharp-runtime.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RECOVER_ROOT = path.join(ROOT, '_recover');
const WAIVER_VERSION = '0.33.5';
const dryRun = process.argv.includes('--dry-run');

function probe() {
  try {
    const mod = require(path.join(ROOT, 'node_modules', 'sharp'));
    let version = null;
    try {
      version = require(path.join(ROOT, 'node_modules', 'sharp', 'package.json')).version;
    } catch {
      version = null;
    }
    return { ok: true, version, error: null, mod };
  } catch (err) {
    return { ok: false, version: null, error: err && err.message ? err.message : String(err), mod: null };
  }
}

async function encodeSmoke(mod) {
  const buf = await mod({
    create: { width: 2, height: 2, channels: 3, background: '#112233' },
  }).webp().toBuffer();
  return Buffer.isBuffer(buf) && buf.length > 0;
}

function listRecoverDirs() {
  if (!fs.existsSync(RECOVER_ROOT)) return [];
  return fs.readdirSync(RECOVER_ROOT)
    .filter((name) => name.startsWith('sharp-') && fs.statSync(path.join(RECOVER_ROOT, name)).isDirectory())
    .sort()
    .reverse()
    .map((name) => path.join(RECOVER_ROOT, name));
}

function copyTree(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function restoreFromRecover(dir) {
  const sharpSrc = path.join(dir, 'node_modules', 'sharp');
  const imgSrc = path.join(dir, 'node_modules', '@img');
  const sharpDest = path.join(ROOT, 'node_modules', 'sharp');
  const imgDest = path.join(ROOT, 'node_modules', '@img');
  if (!fs.existsSync(sharpSrc)) {
    // Some recover stamps store sharp/ at the stamp root
    const altSharp = path.join(dir, 'sharp');
    const altImg = path.join(dir, '@img');
    if (fs.existsSync(altSharp)) {
      if (dryRun) {
        console.log(`[dry-run] would restore sharp from ${altSharp}`);
        return true;
      }
      copyTree(altSharp, sharpDest);
      if (fs.existsSync(altImg)) copyTree(altImg, imgDest);
      return true;
    }
    return false;
  }
  if (dryRun) {
    console.log(`[dry-run] would restore sharp from ${sharpSrc}`);
    return true;
  }
  copyTree(sharpSrc, sharpDest);
  if (fs.existsSync(imgSrc)) copyTree(imgSrc, imgDest);
  return true;
}

function npmInstallWaiver() {
  const tgz = path.join(RECOVER_ROOT, 'sharp-0.33.5.tgz');
  const args = fs.existsSync(tgz)
    ? ['install', tgz, '--omit=dev', '--no-save', '--no-audit', '--no-fund']
    : ['install', `sharp@${WAIVER_VERSION}`, '--omit=dev', '--no-save', '--no-audit', '--no-fund'];
  if (dryRun) {
    console.log(`[dry-run] would run: npm ${args.join(' ')}`);
    return true;
  }
  const result = spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status === 0;
}

async function main() {
  console.log('ensure-sharp-runtime: probing…');
  let status = probe();
  if (status.ok) {
    try {
      const smoke = await encodeSmoke(status.mod);
      if (smoke) {
        console.log(`ENSURE_SHARP_OK version=${status.version || '?'}`);
        process.exit(0);
      }
      console.warn('encode smoke failed; treating as broken');
      status = { ok: false, version: status.version, error: 'encode_smoke_failed', mod: null };
    } catch (err) {
      status = { ok: false, version: status.version, error: err.message, mod: null };
    }
  } else {
    console.warn('probe failed:', status.error);
  }

  // Clear require cache so restore is visible
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(`${path.sep}node_modules${path.sep}sharp`) || key.includes(`${path.sep}node_modules${path.sep}@img`)) {
      delete require.cache[key];
    }
  });

  let restored = false;
  for (const dir of listRecoverDirs()) {
    console.log('trying recover stamp:', path.basename(dir));
    if (!restoreFromRecover(dir)) continue;
    const again = probe();
    if (again.ok) {
      try {
        if (await encodeSmoke(again.mod)) {
          console.log(`ENSURE_SHARP_RESTORED_FROM_RECOVER stamp=${path.basename(dir)} version=${again.version || '?'}`);
          restored = true;
          break;
        }
      } catch (err) {
        console.warn('recover encode failed:', err.message);
      }
    }
  }

  if (!restored) {
    console.log(`falling back to npm install sharp@${WAIVER_VERSION}`);
    if (!npmInstallWaiver()) {
      console.error('ENSURE_SHARP_FAIL npm_install');
      process.exit(2);
    }
    Object.keys(require.cache).forEach((key) => {
      if (key.includes(`${path.sep}node_modules${path.sep}sharp`) || key.includes(`${path.sep}node_modules${path.sep}@img`)) {
        delete require.cache[key];
      }
    });
    const again = probe();
    if (!again.ok) {
      console.error('ENSURE_SHARP_FAIL after_npm', again.error);
      process.exit(3);
    }
    try {
      if (!(await encodeSmoke(again.mod))) {
        console.error('ENSURE_SHARP_FAIL encode_after_npm');
        process.exit(4);
      }
    } catch (err) {
      console.error('ENSURE_SHARP_FAIL encode_after_npm', err.message);
      process.exit(4);
    }
    console.log(`ENSURE_SHARP_RESTORED_VIA_NPM version=${again.version || WAIVER_VERSION}`);
  }

  console.log('NOTE: source package.json may still list 0.35.0 (CI pin). Runtime waiver is 0.33.5 until CPU upgrade.');
  process.exit(0);
}

main().catch((err) => {
  console.error('ENSURE_SHARP_FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
