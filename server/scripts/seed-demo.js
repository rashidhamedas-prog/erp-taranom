#!/usr/bin/env node
'use strict';
/**
 * Thin CLI for the V2 demo seed.
 *
 *   node server/scripts/seed-demo.js <absolute-db-path>
 *
 * Refuses if the DB already exists. Sets ERP_TEST_ISOLATION=1.
 * JWT_SECRET must be ≥32 chars; otherwise an ephemeral secret is generated
 * for the child server only (crypto.randomBytes — never a well-known string).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { seedDemoV2 } = require('./lib/seed-demo-v2');

const FORBIDDEN_SECRETS = /^(demo-seed-secret|laptop-demo-secret)$/i;

function ensureJwtSecret() {
  const raw = String(process.env.JWT_SECRET || '').trim();
  if (raw && raw.length >= 32 && !FORBIDDEN_SECRETS.test(raw)) return;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
}

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: node server/scripts/seed-demo.js <absolute-db-path>');
    process.exit(2);
  }
  if (!path.isAbsolute(dbPath)) {
    console.error('database path must be absolute');
    process.exit(2);
  }
  if (fs.existsSync(dbPath)) {
    console.error(`DB already exists — delete it first (demo seeds must start clean): ${dbPath}`);
    process.exit(1);
  }
  process.env.ERP_TEST_ISOLATION = '1';
  ensureJwtSecret();
  await seedDemoV2({ dbPath });
}

main().catch((e) => {
  console.error('SEED FAILED:', e.message || e);
  process.exit(e.status || 1);
});
