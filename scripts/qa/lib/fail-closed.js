'use strict';

const path = require('path');
const os = require('os');
const { PROD_PATH_SNIPPETS, PROD_HOSTS } = require('./constants');

class HarnessError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'E_HARNESS';
    this.exitCode = 2;
  }
}

function looksProduction(value) {
  const s = String(value || '').toLowerCase().replace(/\\/g, '/');
  if (!s) return false;
  for (const snip of PROD_PATH_SNIPPETS) {
    if (s.includes(String(snip).toLowerCase().replace(/\\/g, '/'))) return true;
  }
  for (const host of PROD_HOSTS) {
    if (s.includes(host.toLowerCase())) return true;
  }
  return false;
}

function assertSafePath(label, p) {
  if (!p) return;
  const resolved = path.resolve(String(p));
  if (looksProduction(resolved) || looksProduction(p)) {
    throw new HarnessError(
      `Fail-closed: ${label} resembles production (${p})`,
      'E_QA_PROD_PATH'
    );
  }
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const art = path.resolve(process.cwd(), 'artifacts', 'qa').toLowerCase();
  const low = resolved.toLowerCase();
  if (!low.startsWith(tmp) && !low.startsWith(art)) {
    throw new HarnessError(
      `Fail-closed: ${label} must be under os.tmpdir() or artifacts/qa (${resolved})`,
      'E_QA_PATH_SCOPE'
    );
  }
}

function assertSafeUrl(label, url) {
  const s = String(url || '');
  if (!s) return;
  let host = '';
  try { host = new URL(s).hostname; } catch { host = s; }
  if (looksProduction(s) || looksProduction(host)) {
    throw new HarnessError(`Fail-closed: ${label} is a production host (${s})`, 'E_QA_PROD_URL');
  }
  if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new HarnessError(`Fail-closed: ${label} must be loopback (${s})`, 'E_QA_NON_LOOPBACK');
  }
}

function applyFailClosedEnv(opts) {
  const nodeEnv = String(process.env.NODE_ENV || opts.nodeEnv || '');
  if (nodeEnv !== 'test') {
    throw new HarnessError('Fail-closed: NODE_ENV must be test', 'E_QA_NODE_ENV');
  }
  if (!opts.qaRunId) {
    throw new HarnessError('Fail-closed: QA_RUN_ID required', 'E_QA_RUN_ID');
  }
  assertSafePath('DB_PATH', opts.dbPath);
  assertSafePath('COMPANIES_DIR', opts.companiesDir);
  assertSafeUrl('baseURL', opts.baseUrl);

  process.env.NODE_ENV = 'test';
  process.env.QA_RUN_ID = opts.qaRunId;
  process.env.ERP_TEST_ISOLATION = '1';
  process.env.SYNC_ROLE = 'central';
  process.env.LISTEN_HOST = '127.0.0.1';
  process.env.MOADIAN_ENABLED = '0';
  process.env.SMS_API_KEY = '';
  process.env.SMS_DISABLED = '1';
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
}

module.exports = { HarnessError, looksProduction, assertSafePath, assertSafeUrl, applyFailClosedEnv };
