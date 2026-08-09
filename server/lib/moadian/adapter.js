'use strict';

function createStubAdapter() {
  return {
    name: 'stub',
    async submit({ payload, signed }) {
      const taxId = 'MOADIAN-' + Date.now().toString(36).toUpperCase();
      return {
        ok: true,
        taxId,
        adapter: 'stub',
        response: { message: 'ارسال آزمایشی stub', signed: !!signed, payloadHeader: payload?.header || null },
      };
    },
  };
}

function createSandboxAdapter(opts = {}) {
  return {
    name: 'sandbox',
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
        adapter: 'sandbox',
        response: {
          message: 'sandbox accept (MVP — بدون HTTP واقعی)',
          fiscalId: fid,
          keyConfigured: !!(privateKeyPath || opts.privateKeyPath),
          signed: !!signed,
        },
      };
    },
  };
}

function getAdapter(name, opts = {}) {
  const n = String(name || 'stub').toLowerCase();
  if (n === 'sandbox' || n === 'live') return createSandboxAdapter(opts);
  return createStubAdapter();
}

module.exports = {
  getAdapter,
  createStubAdapter,
  createSandboxAdapter,
};
