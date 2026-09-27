#!/usr/bin/env node
'use strict';
/** Smoke: start host in-process listen + client ping (no external deps). */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\erp-taranom-domain-test-' + process.pid
  : path.join(os.tmpdir(), 'erp-taranom-domain-test-' + process.pid + '.sock');

const env = {
  ...process.env,
  ...(process.platform === 'win32'
    ? { ERP_HOST_PIPE: endpoint }
    : { ERP_HOST_SOCK: endpoint }),
};

const host = spawn(process.execPath, [path.join(__dirname, '..', 'host-main.js')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ready = false;
host.stdout.on('data', (d) => {
  const s = d.toString();
  if (s.includes('"listening"')) ready = true;
});
host.stderr.on('data', (d) => process.stderr.write(d));

function waitReady(ms = 8000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ready) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('host not ready'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function invoke(command, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint);
    let buf = '';
    const id = 't1';
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id, command, payload: payload || {} }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) {
        try {
          resolve(JSON.parse(buf.trim()));
        } catch (e) {
          reject(e);
        }
        sock.end();
      }
    });
    sock.on('error', reject);
  });
}

(async () => {
  let failed = 0;
  const check = (cond, name) => {
    console.log(cond ? '  ✅' : '  ❌', name);
    if (!cond) failed++;
  };
  try {
    await waitReady();
    const ping = await invoke('ping');
    check(ping.ok && ping.result && ping.result.pong === true, 'ping');
    const ver = await invoke('version');
    check(ver.ok && ver.result.host === 'domain-host', 'version');
    check(ver.result.version === '0.2.0', 'version 0.2.0');
    const schema = await invoke('schema.hash');
    check(ver.ok && /^[a-f0-9]{64}$/.test(schema.result.sha256), 'schema.hash');
    const contract = await invoke('contract.hash');
    check(contract.ok && /^[a-f0-9]{64}$/.test(contract.result.sha256), 'contract.hash');
    const brand = await invoke('brand.get');
    check(brand.ok && brand.result.brandId === 'taranom', 'brand.get');
    const bad = await invoke('nope');
    check(!bad.ok && bad.error.code === 'E_UNKNOWN_COMMAND', 'unknown command rejected');
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    host.kill();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(endpoint); } catch { /* */ }
    }
  }
  console.log(failed ? `💥 ${failed} failed` : '🎉 pipe smoke OK');
  process.exit(failed ? 1 : 0);
})();
