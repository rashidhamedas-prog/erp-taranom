#!/usr/bin/env node
'use strict';
/**
 * Headless Domain Host — Named Pipe (Windows) / Unix socket (dev).
 * Boots internal Express on 127.0.0.1 only; product UI must use this pipe.
 *
 * Env:
 *   ERP_BRAND_ID=taranom
 *   ERP_HOST_PIPE=\\.\pipe\erp-taranom-domain
 *   ERP_HOST_SOCK=...
 *   ERP_HOST_DATA=...
 *   ERP_HOST_SYNC_ROLE=central|device
 *   ERP_HOST_AUTOSTART=1  (default) — start runtime on listen
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const {
  handleCommand, parseLine, formatOk, formatErr, loadBrand, createSessionStore,
} = require('./protocol');
const { DomainRuntime } = require('./runtime');

const brandId = process.env.ERP_BRAND_ID || 'taranom';
const brand = loadBrand(brandId);
const store = createSessionStore();
const runtime = new DomainRuntime({ brandId });
const ctx = { brandId, brand, runtime, store };
const autostart = process.env.ERP_HOST_AUTOSTART !== '0';

function defaultEndpoint() {
  if (process.platform === 'win32') {
    return process.env.ERP_HOST_PIPE || '\\\\.\\pipe\\erp-taranom-domain';
  }
  return process.env.ERP_HOST_SOCK || path.join(require('os').tmpdir(), 'erp-taranom-domain.sock');
}

const endpoint = defaultEndpoint();

function attachSocket(socket) {
  let buf = '';
  let chain = Promise.resolve();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        let id = null;
        try {
          const msg = parseLine(line);
          id = msg.id;
          const result = await handleCommand(msg.command, msg.payload || {}, ctx);
          if (!socket.destroyed) socket.write(formatOk(id, result));
        } catch (err) {
          if (!socket.destroyed) socket.write(formatErr(id, err));
        }
      });
    }
  });
}

if (process.platform !== 'win32' && endpoint.endsWith('.sock')) {
  try { fs.unlinkSync(endpoint); } catch { /* */ }
}

const server = net.createServer(attachSocket);
server.on('error', (err) => {
  console.error('[domain-host] listen error:', err.message);
  process.exit(1);
});

async function boot() {
  server.listen(endpoint, async () => {
    const commands = [
      'ping', 'version', 'schema.hash', 'contract.hash', 'brand.get',
      'runtime.start', 'runtime.status', 'runtime.stop',
      'auth.login', 'auth.logout', 'auth.me', 'api.call',
    ];
    console.log(JSON.stringify({
      event: 'listening',
      endpoint,
      brandId: brand.brandId,
      productName: brand.productName,
      commands,
      publicUi: false,
    }));
    if (autostart) {
      try {
        const st = await runtime.start();
        console.log(JSON.stringify({ event: 'runtime_ready', ...st }));
      } catch (e) {
        console.error('[domain-host] autostart failed:', e.message);
      }
    }
  });
}

boot();

async function shutdown() {
  try { await runtime.stop(); } catch { /* */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
