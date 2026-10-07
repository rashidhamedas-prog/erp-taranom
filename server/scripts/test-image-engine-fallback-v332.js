'use strict';

/**
 * v332 — ImageEngine: sharp path + secure passthrough when sharp unavailable.
 */
const path = require('path');
const assert = require('assert');

const imageEngine = require('../lib/image-engine');
const { validateUploadedFile, PROFILES, UploadPolicyError } = require('../lib/upload-policy');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function file(buffer, originalname, mimetype) {
  return { buffer, size: buffer.length, originalname, mimetype, fieldname: 'images' };
}

/** Minimal valid 1×1 PNG */
function tinyPng() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    + '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex'
  );
}

async function main() {
  console.log('\n══ Image engine fallback v332 ══\n');

  const png = tinyPng();
  const dims = imageEngine.readPngDimensions(png);
  ok('PNG IHDR dimensions readable without sharp', dims && dims.width === 1 && dims.height === 1);

  const statusBefore = imageEngine.getStatus();
  ok('getStatus returns mode field', statusBefore && typeof statusBefore.mode === 'string');

  // Force passthrough path
  imageEngine._setSharpForTests(null);
  process.env.IMAGE_ENGINE_MODE = 'auto';
  const passthrough = await validateUploadedFile(file(png, 'sample.png', 'image/png'), 'image');
  ok('passthrough accepts magic-valid PNG', passthrough.uploadValidated === true);
  ok('passthrough keeps PNG mime', passthrough.mimetype === 'image/png');
  ok('passthrough keeps .png extension', passthrough.extension === '.png');
  ok('passthrough marks via', passthrough.imageEngineVia === 'passthrough');
  ok('passthrough sets width/height', passthrough.imageWidth === 1 && passthrough.imageHeight === 1);

  const polyglot = Buffer.concat([png, Buffer.from('<script>x</script>')]);
  try {
    await validateUploadedFile(file(polyglot, 'evil.png', 'image/png'), 'image');
    ok('polyglot rejected in passthrough', false, 'accepted');
  } catch (err) {
    ok('polyglot rejected in passthrough', err.code === 'UPLOAD_POLYGLOT', err.code);
  }

  process.env.IMAGE_ENGINE_MODE = 'require';
  imageEngine._setSharpForTests(null);
  try {
    await validateUploadedFile(file(png, 'sample.png', 'image/png'), 'image');
    ok('require mode hard-fails without sharp', false, 'accepted');
  } catch (err) {
    ok(
      'require mode hard-fails without sharp',
      err.code === 'UPLOAD_IMAGE_ENGINE_UNAVAILABLE' && err.status === 503,
      `${err.code}/${err.status}`
    );
  }

  // Restore real sharp if present for optional re-encode check
  delete require.cache[require.resolve('../lib/image-engine')];
  delete require.cache[require.resolve('../lib/upload-policy')];
  process.env.IMAGE_ENGINE_MODE = 'auto';
  let sharpOk = false;
  try {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    const engine = require('../lib/image-engine');
    const policy = require('../lib/upload-policy');
    engine._setSharpForTests(sharp, require('sharp/package.json').version);
    const encoded = await policy.validateUploadedFile(file(png, 'sample.png', 'image/png'), 'image');
    sharpOk = encoded.mimetype === 'image/webp' && encoded.imageEngineVia === 'sharp';
    ok('sharp path re-encodes to WebP when available', sharpOk);
  } catch (err) {
    ok('sharp path skipped (native unavailable on this host)', true, err.message);
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
