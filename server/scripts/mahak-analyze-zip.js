#!/usr/bin/env node
// Analyze a Mahak FullBackup.zip locally (no server needed).
const fs = require('fs');
const path = require('path');

const zipPath = process.argv[2];
if (!zipPath || !fs.existsSync(zipPath)) {
  console.error('Usage: node server/scripts/mahak-analyze-zip.js <path-to-FullBackup.zip>');
  process.exit(1);
}

const { extractZip, analyzeExtracted } = require('../lib/mahak-import');
const dir = extractZip(path.resolve(zipPath));
const analysis = analyzeExtracted(dir);
console.log(JSON.stringify(analysis, null, 2));
