#!/usr/bin/env node
'use strict';
/**
 * Headless Domain Host — listens on Named Pipe (Windows) or Unix socket (dev).
 * Does NOT serve server/public as product UI. WPF talks only via this pipe.
 *
 * Env:
 *   ERP_BRAND_ID=taranom
 *   ERP_HOST_PIPE=\\.\pipe\erp-taranom-domain   (Windows default)
 *   ERP_HOST_SOCK=/tmp/erp-taranom-domain.sock (non-Windows default)
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const {
  handleCommand, parseLine, formatOk, formatErr, loadBrand,
} = require('./protocol');

const brandId = process.env.ERP_BRAND_ID || 'taranom';
const brand = loadBrand(brandId);

function defaultEndpoint() {
  if (process.platform === 'win32') {
    return process.env.ERP_HOST_PIPE || '\\\\.\\pipe\\erp-taranom-domain';
  }
  return process.env.ERP_HOST_SOCK || path.join(require('os').tmpdir(), 'erp-taranom-domain.sock');
}

const endpoint = defaultEndpoint();
const ctx = { brandId, brand };

function attachSocket(socket) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let id = null;
      try {
        const msg = parseLine(line);
        id = msg.id;
        const result = handleCommand(msg.command, msg.payload || {}, ctx);
        socket.write(formatOk(id, result));
      } catch (err) {
        socket.write(formatErr(id, err));
      }
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
server.listen(endpoint, () => {
  console.log(JSON.stringify({
    event: 'listening',
    endpoint,
    brandId: brand.brandId,
    productName: brand.productName,
    commands: ['ping', 'version', 'schema.hash', 'contract.hash', 'brand.get'],
  }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
