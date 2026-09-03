'use strict';

const { submitInvoiceHttp, getServerInformation } = require('./client');

function createStubAdapter() {
  return {
    name: 'stub',
    async submit({ payload, signed }) {
      const taxId = 'MOADIAN-' + Date.now().toString(36).toUpperCase();
      return {
        ok: true,
        taxId,
        adapter: 'stub',
        response: { message: 'ارسال آزمایشی stub (بدون HTTP)', signed: !!signed, payloadHeader: payload?.header || null },
      };
    },
  };
}

/** Offline mock — kept for unit tests without network. Prefer `sandbox` in production UI. */
function createOfflineSandboxAdapter(opts = {}) {
  return {
    name: 'sandbox-offline',
    async submit({ payload, signed, fiscalId, privateKeyPath }) {
      const fid = fiscalId || opts.fiscalId || payload?.header?.fiscalId || '';
      if (!fid) {
        const err = new Error('شناسه حافظه مالیاتی (fiscal id) برای sandbox الزامی است');
        err.code = 'MOADIAN_FISCAL_REQUIRED';
        throw err;
      }
      const taxId = 'SBX-' + Date.now().toString(36).toUpperCase();
      return {
        ok: true,
        taxId,
        adapter: 'sandbox-offline',
        response: {
          message: 'sandbox-offline (بدون HTTP — فقط تست واحد)',
          fiscalId: fid,
          keyConfigured: !!(privateKeyPath || opts.privateKeyPath),
          signed: !!signed,
        },
      };
    },
  };
}

function createSandboxAdapter(opts = {}) {
  return {
    name: 'sandbox',
    async submit(args) {
      return submitInvoiceHttp({
        env: 'sandbox',
        fiscalId: args.fiscalId || opts.fiscalId || args.payload?.header?.fiscalId,
        privateKeyPath: args.privateKeyPath || opts.privateKeyPath,
        payload: args.payload,
      });
    },
    async ping() {
      return getServerInformation('sandbox');
    },
  };
}

function createLiveAdapter(opts = {}) {
  return {
    name: 'live',
    async submit(args) {
      return submitInvoiceHttp({
        env: 'live',
        fiscalId: args.fiscalId || opts.fiscalId || args.payload?.header?.fiscalId,
        privateKeyPath: args.privateKeyPath || opts.privateKeyPath,
        payload: args.payload,
      });
    },
    async ping() {
      return getServerInformation('live');
    },
  };
}

function getAdapter(name, opts = {}) {
  const n = String(name || 'stub').toLowerCase();
  if (n === 'live') return createLiveAdapter(opts);
  if (n === 'sandbox') return createSandboxAdapter(opts);
  if (n === 'sandbox-offline') return createOfflineSandboxAdapter(opts);
  return createStubAdapter();
}

module.exports = {
  getAdapter,
  createStubAdapter,
  createSandboxAdapter,
  createOfflineSandboxAdapter,
  createLiveAdapter,
};
