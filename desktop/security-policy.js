'use strict';

function isLoopbackUrl(value, port) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && (!port || u.port === String(port));
  } catch { return false; }
}

function isAllowedExternalUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'erp.poshaktaranom.com' || u.hostname === 'poshaktaranom.com' || u.hostname.endsWith('.poshaktaranom.com'));
  } catch { return false; }
}

module.exports = { isLoopbackUrl, isAllowedExternalUrl };
