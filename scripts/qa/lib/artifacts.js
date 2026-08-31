'use strict';

const fs = require('fs');
const path = require('path');
const { redact, redactText } = require('./redact');

function makeArtifactDir(repoRoot, qaRunId) {
  const dir = path.join(repoRoot, 'artifacts', 'qa', qaRunId);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'artifacts', 'qa', '_latest.json'), JSON.stringify({
    qa_run_id: qaRunId, dir, started_at: new Date().toISOString(),
  }, null, 2));
  return dir;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(redact(data), null, 2), 'utf8');
}

function appendLog(dir, name, text) {
  fs.appendFileSync(path.join(dir, 'logs', name), redactText(String(text)) + '\n', 'utf8');
}

function writeText(file, text) {
  fs.writeFileSync(file, redactText(String(text)), 'utf8');
}

function latestPointer(repoRoot) {
  const p = path.join(repoRoot, 'artifacts', 'qa', '_latest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

module.exports = { makeArtifactDir, writeJson, appendLog, writeText, latestPointer };
