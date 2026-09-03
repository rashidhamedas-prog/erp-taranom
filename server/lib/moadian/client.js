'use strict';

/**
 * Official Tax Authority Self-TSP HTTP client.
 * Sandbox (ارسال آزمایشی): https://sandboxrc.tax.gov.ir/req/api/self-tsp
 * Live:                   https://tp.tax.gov.ir/req/api/self-tsp
 */
const crypto = require('crypto');
const { safeRequestJSON } = require('../safe-outbound-request');
const {
  loadPrivateKey,
  encryptInvoicePacket,
  signTokenPacket,
} = require('./crypto-packet');

const BASE = {
  sandbox: 'https://sandboxrc.tax.gov.ir/req/api/self-tsp',
  live: 'https://tp.tax.gov.ir/req/api/self-tsp',
};

function envBase(env) {
  return BASE[env === 'live' ? 'live' : 'sandbox'];
}

function parseJsonBody(res) {
  try {
    return res.body ? JSON.parse(res.body) : null;
  } catch {
    return { raw: String(res.body || '').slice(0, 500) };
  }
}

function pickServerKey(info) {
  const keys = info?.result?.publicKeys
    || info?.result?.public_keys
    || info?.publicKeys
    || [];
  if (!Array.isArray(keys) || !keys.length) return null;
  const k = keys.find((x) => x.active !== false) || keys[0];
  const b64 = k.key || k.value || k.publicKey || '';
  if (!b64) return { id: k.id || k.keyId || '', pem: '' };
  const pem = b64.includes('BEGIN')
    ? b64
    : `-----BEGIN PUBLIC KEY-----\n${String(b64).replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || b64}\n-----END PUBLIC KEY-----`;
  return { id: k.id || k.keyId || '', pem };
}

async function taxRequest(url, method, body, headers = {}) {
  const res = await safeRequestJSON(url, method, body, {
    requestTraceId: crypto.randomUUID(),
    ...headers,
  }, { timeoutMs: 20000 });
  return { status: res.status, json: parseJsonBody(res), raw: res.body };
}

async function getServerInformation(env = 'sandbox') {
  const url = `${envBase(env)}/sync/GET_SERVER_INFORMATION`;
  const res = await taxRequest(url, 'GET');
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    env,
    base: envBase(env),
    data: res.json,
    serverKey: pickServerKey(res.json),
  };
}

async function getToken({ env = 'sandbox', fiscalId, privateKeyPath }) {
  const { pem } = loadPrivateKey(privateKeyPath);
  const packet = signTokenPacket({ fiscalId, privateKeyPem: pem });
  const url = `${envBase(env)}/sync/GET_TOKEN`;
  const res = await taxRequest(url, 'POST', { packets: [packet] });
  const token = res.json?.result?.token
    || res.json?.result?.data?.token
    || res.json?.token
    || null;
  return { ok: !!token || (res.status >= 200 && res.status < 300), status: res.status, token, data: res.json };
}

async function enqueueInvoice({
  env = 'sandbox',
  fiscalId,
  privateKeyPath,
  payload,
  token,
  serverKey,
}) {
  const { pem } = loadPrivateKey(privateKeyPath);
  const packet = encryptInvoicePacket({
    payload,
    privateKeyPem: pem,
    fiscalId,
    serverKey,
  });
  const url = `${envBase(env)}/async/normal-enqueue`;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await taxRequest(url, 'POST', { packets: [packet] }, headers);
  const ref = res.json?.result?.referenceNumber
    || res.json?.result?.[0]?.referenceNumber
    || res.json?.referenceNumber
    || null;
  const ok = res.status >= 200 && res.status < 300 && !res.json?.result?.errorCode;
  return {
    ok,
    status: res.status,
    referenceNumber: ref,
    uid: packet.uid,
    data: res.json,
    env,
  };
}

async function submitInvoiceHttp(opts) {
  const env = opts.env === 'live' ? 'live' : 'sandbox';
  const fiscalId = String(opts.fiscalId || '').trim();
  if (!fiscalId) {
    const err = new Error('شناسه حافظه مالیاتی الزامی است');
    err.code = 'MOADIAN_FISCAL_REQUIRED';
    throw err;
  }
  loadPrivateKey(opts.privateKeyPath);

  const server = await getServerInformation(env);
  if (!server.ok && server.status === 0) {
    const err = new Error('ارتباط با سرور مودیان برقرار نشد');
    err.code = 'MOADIAN_NETWORK';
    throw err;
  }

  let token = null;
  try {
    const tok = await getToken({ env, fiscalId, privateKeyPath: opts.privateKeyPath });
    token = tok.token;
  } catch (e) {
    /* some sandbox builds accept enqueue without token if signed packets are valid */
    if (e.code === 'MOADIAN_KEY_REQUIRED' || e.code === 'MOADIAN_KEY_MISSING') throw e;
  }

  const enq = await enqueueInvoice({
    env,
    fiscalId,
    privateKeyPath: opts.privateKeyPath,
    payload: opts.payload,
    token,
    serverKey: server.serverKey,
  });

  if (!enq.ok) {
    const detail = enq.data?.result?.errorDetail
      || enq.data?.result?.errorCode
      || enq.data?.error
      || `HTTP ${enq.status}`;
    const err = new Error(`رد مودیان (${env}): ${detail}`);
    err.code = 'MOADIAN_REJECTED';
    err.extra = enq;
    throw err;
  }

  return {
    ok: true,
    taxId: enq.referenceNumber || `REF-${enq.uid}`,
    adapter: env === 'live' ? 'live' : 'sandbox',
    response: {
      message: env === 'live' ? 'ارسال به مودیان عملیاتی' : 'ارسال آزمایشی به sandboxrc.tax.gov.ir',
      env,
      referenceNumber: enq.referenceNumber,
      uid: enq.uid,
      serverStatus: server.status,
      raw: enq.data,
    },
  };
}

module.exports = {
  BASE,
  getServerInformation,
  getToken,
  submitInvoiceHttp,
  envBase,
};
