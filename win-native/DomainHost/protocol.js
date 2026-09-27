'use strict';
/**
 * Domain Host IPC protocol — newline-delimited JSON over Named Pipe / Unix socket.
 *
 * Request:  { "id": "...", "command": "ping|version|schema.hash|contract.hash|brand.get", "payload": {}, "idempotencyKey": null }
 * Response: { "id": "...", "ok": true|false, "result": ..., "error": { "code", "message" } }
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function loadBrand(brandId) {
  const p = path.join(ROOT, 'branding', brandId || 'taranom', 'brand.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readSha(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').trim();
}

function handleCommand(command, payload = {}, ctx = {}) {
  switch (command) {
    case 'ping':
      return { pong: true, ts: Date.now() };
    case 'version':
      return {
        host: 'domain-host',
        version: '0.1.0',
        phase: '1-stub',
        node: process.versions.node,
        platform: process.platform,
      };
    case 'schema.hash':
      return { sha256: readSha('docs/native/schema.v1.sha256') };
    case 'contract.hash':
      return { sha256: readSha('docs/native/OPERATION-CONTRACT.sha256') };
    case 'brand.get':
      return loadBrand(payload.brandId || ctx.brandId || 'taranom');
    default: {
      const err = new Error('unknown command: ' + command);
      err.code = 'E_UNKNOWN_COMMAND';
      throw err;
    }
  }
}

function parseLine(line) {
  const msg = JSON.parse(line);
  if (!msg || typeof msg !== 'object') throw Object.assign(new Error('invalid message'), { code: 'E_BAD_MSG' });
  if (!msg.id) throw Object.assign(new Error('id required'), { code: 'E_BAD_MSG' });
  if (!msg.command) throw Object.assign(new Error('command required'), { code: 'E_BAD_MSG' });
  return msg;
}

function formatOk(id, result) {
  return JSON.stringify({ id, ok: true, result }) + '\n';
}

function formatErr(id, err) {
  return JSON.stringify({
    id: id || null,
    ok: false,
    error: { code: err.code || 'E_HOST', message: err.message || String(err) },
  }) + '\n';
}

module.exports = {
  handleCommand,
  parseLine,
  formatOk,
  formatErr,
  loadBrand,
  ROOT,
};
