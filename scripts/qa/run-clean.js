'use strict';
const fs = require('fs');
const path = require('path');
const { latestPointer } = require('./lib/artifacts');
const { looksProduction } = require('./lib/fail-closed');

const repoRoot = path.resolve(__dirname, '..', '..');
const confirm = process.argv.includes('--yes');
if (!confirm) {
  console.error('Refusing to delete. Re-run with --yes after reviewing the resolved paths.');
  process.exit(2);
}
const ptr = latestPointer(repoRoot);
if (!ptr) {
  console.error('No latest QA run pointer');
  process.exit(2);
}
const art = ptr.dir || path.join(repoRoot, 'artifacts', 'qa', ptr.qa_run_id);
const dbMeta = path.join(art, 'db-path.json');
const targets = [art];
if (fs.existsSync(dbMeta)) {
  const j = JSON.parse(fs.readFileSync(dbMeta, 'utf8'));
  if (j.tmpRoot) targets.push(j.tmpRoot);
  if (j.dbPath) targets.push(j.dbPath);
}
for (const t of targets) {
  const resolved = path.resolve(t);
  if (looksProduction(resolved)) {
    console.error('Fail-closed: refusing to delete production-like path', resolved);
    process.exit(2);
  }
  if (!resolved.includes('erp-qa-') && !resolved.includes(path.join('artifacts', 'qa'))) {
    console.error('Fail-closed: path is not a QA temp/artifact', resolved);
    process.exit(2);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  console.log('removed', resolved);
}
process.exit(0);
