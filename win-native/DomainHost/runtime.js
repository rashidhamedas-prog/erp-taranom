'use strict';
/**
 * Internal domain runtime: spawn headless Express on 127.0.0.1 only.
 * Never advertised to end users — WPF uses Named Pipe exclusively.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { ROOT } = require('./protocol');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

class DomainRuntime {
  constructor(opts = {}) {
    this.brandId = opts.brandId || 'taranom';
    this.syncRole = opts.syncRole || process.env.ERP_HOST_SYNC_ROLE || 'central';
    this.dataRoot = opts.dataRoot || process.env.ERP_HOST_DATA
      || path.join(os.tmpdir(), 'erp-domain-host-' + process.pid);
    this.child = null;
    this.port = null;
    this.baseUrl = null;
    this.startedAt = null;
    this.stderrTail = '';
  }

  get status() {
    return {
      running: !!(this.child && this.child.exitCode == null),
      port: this.port,
      baseUrl: this.baseUrl,
      listen: '127.0.0.1',
      syncRole: this.syncRole,
      dataRoot: this.dataRoot,
      startedAt: this.startedAt,
      publicUi: false,
    };
  }

  async start() {
    if (this.status.running) return this.status;
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.mkdirSync(path.join(this.dataRoot, 'uploads'), { recursive: true });
    this.port = await pickFreePort();
    this.baseUrl = `http://127.0.0.1:${this.port}`;

    const env = {
      ...process.env,
      PORT: String(this.port),
      LISTEN_HOST: '127.0.0.1',
      DB_PATH: path.join(this.dataRoot, 'erp.db'),
      UPLOADS_DIR: path.join(this.dataRoot, 'uploads'),
      JWT_SECRET: process.env.JWT_SECRET || 'erp-domain-host-dev-jwt-secret-32chars!!',
      SYNC_ROLE: this.syncRole,
      ERP_TEST_ISOLATION: process.env.ERP_TEST_ISOLATION || '1',
      ERP_DOMAIN_HOST: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete env[k];
    }

    this.stderrTail = '';
    this.child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      cwd: path.join(ROOT, 'server'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });
    this.child.on('exit', () => {
      this.port = null;
      this.baseUrl = null;
    });

    await this._waitReady(90000);
    this.startedAt = Date.now();
    return this.status;
  }

  async _waitReady(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.child && this.child.exitCode != null) {
        throw Object.assign(
          new Error('domain runtime exited early: ' + this.stderrTail.slice(-800)),
          { code: 'E_RUNTIME_EXIT' }
        );
      }
      try {
        const r = await fetch(this.baseUrl + '/api/system/time', { signal: AbortSignal.timeout(1500) });
        if (r.ok) return;
      } catch { /* */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw Object.assign(
      new Error('domain runtime boot timeout: ' + this.stderrTail.slice(-800)),
      { code: 'E_RUNTIME_TIMEOUT' }
    );
  }

  async stop() {
    if (!this.child) return { stopped: true };
    const child = this.child;
    this.child = null;
    try {
      if (process.platform === 'win32') {
        const { execFileSync } = require('child_process');
        try {
          execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch { child.kill(); }
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* */ }
    this.port = null;
    this.baseUrl = null;
    return { stopped: true };
  }

  async fetch(method, apiPath, { token, body } = {}) {
    if (!this.baseUrl) {
      throw Object.assign(new Error('runtime not started'), { code: 'E_RUNTIME_DOWN' });
    }
    let p = String(apiPath || '');
    if (!p.startsWith('/')) p = '/' + p;
    if (!p.startsWith('/api/')) p = '/api' + (p.startsWith('/') ? p : '/' + p);
    const r = await fetch(this.baseUrl + p, {
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body != null && method && method.toUpperCase() !== 'GET'
        ? JSON.stringify(body)
        : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, body: data };
  }
}

module.exports = { DomainRuntime, pickFreePort };
