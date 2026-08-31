'use strict';
const fs = require('fs');
const path = require('path');
const { latestPointer } = require('./lib/artifacts');

const repoRoot = path.resolve(__dirname, '..', '..');
const ptr = latestPointer(repoRoot);
if (!ptr) {
  console.error('No artifacts/qa/_latest.json');
  process.exit(2);
}
const summary = path.join(ptr.dir || path.join(repoRoot, 'artifacts', 'qa', ptr.qa_run_id), 'summary.md');
const issues = path.join(path.dirname(summary), 'issues.json');
const meta = path.join(path.dirname(summary), 'meta.json');
if (fs.existsSync(summary)) console.log(fs.readFileSync(summary, 'utf8'));
else console.log('QA_RUN_ID=' + ptr.qa_run_id);
if (fs.existsSync(meta)) {
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  console.log('exit', m.exit, 'counts', JSON.stringify(m.counts));
}
if (fs.existsSync(issues)) {
  const j = JSON.parse(fs.readFileSync(issues, 'utf8'));
  const high = (j.issues || []).filter((i) => i.severity === 'high' || i.severity === 'critical');
  console.log('open high/critical', high.length);
}
process.exit(0);
