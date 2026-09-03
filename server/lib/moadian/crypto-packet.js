'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { resolveMoadianKeyPath } = require('./sign');

function normalizeJson(data) {
  if (data === null) return 'null';
  if (typeof data === 'boolean') return data ? 'true' : 'false';
  if (typeof data === 'number') {
    if (!Number.isFinite(data)) throw new Error('عدد نامعتبر در نرمال‌سازی JSON مودیان');
    return String(data);
  }
  if (typeof data === 'string') return JSON.stringify(data);
  if (Array.isArray(data)) return `[${data.map(normalizeJson).join(',')}]`;
  if (typeof data === 'object') {
    const keys = Object.keys(data).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${normalizeJson(data[k])}`).join(',')}}`;
  }
  return JSON.stringify(data);
}

function loadPrivateKey(rawPath) {
  const keyPath = resolveMoadianKeyPath(rawPath);
  if (!keyPath) {
    const err = new Error('مسیر کلید خصوصی مودیان تنظیم نشده');
    err.code = 'MOADIAN_KEY_REQUIRED';
    throw err;
  }
  if (!fs.existsSync(keyPath)) {
    const err = new Error('فایل کلید خصوصی مودیان یافت نشد');
    err.code = 'MOADIAN_KEY_MISSING';
    throw err;
  }
  return { keyPath, pem: fs.readFileSync(keyPath, 'utf8') };
}

function rsaSignBase64(pem, dataUtf8) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(dataUtf8, 'utf8');
  sign.end();
  return sign.sign(pem, 'base64');
}

function encryptInvoicePacket({ payload, privateKeyPem, fiscalId, serverKey }) {
  const normalized = normalizeJson(payload);
  const dataSignature = rsaSignBase64(privateKeyPem, normalized);

  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  let symmetricKey;
  let encryptionKeyId = serverKey?.id || '';
  if (serverKey?.pem) {
    symmetricKey = crypto.publicEncrypt(
      {
        key: serverKey.pem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      aesKey
    ).toString('base64');
  } else {
    symmetricKey = aesKey.toString('base64');
  }

  return {
    uid: crypto.randomUUID(),
    packetType: 'INVOICE.V01',
    retry: false,
    data: ciphertext.toString('base64'),
    encryptionKeyId,
    symmetricKey,
    iv: iv.toString('base64'),
    fiscalId,
    dataSignature,
  };
}

function signTokenPacket({ fiscalId, privateKeyPem }) {
  const data = { username: fiscalId };
  const normalized = normalizeJson(data);
  return {
    uid: crypto.randomUUID(),
    packetType: 'GET_TOKEN',
    retry: false,
    data,
    encryptionKeyId: '',
    symmetricKey: '',
    iv: '',
    fiscalId,
    dataSignature: rsaSignBase64(privateKeyPem, normalized),
  };
}

module.exports = {
  normalizeJson,
  loadPrivateKey,
  encryptInvoicePacket,
  signTokenPacket,
  rsaSignBase64,
};
