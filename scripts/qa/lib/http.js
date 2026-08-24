'use strict';

const http = require('http');

function createHttp(port) {
  function req(method, urlPath, body, token) {
    return new Promise((resolve, reject) => {
      const pathName = urlPath.startsWith('/api') ? urlPath : '/api' + urlPath;
      const data = body != null ? JSON.stringify(body) : null;
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const r = http.request({
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch { json = { raw: buf.slice(0, 2000) }; }
          resolve({ status: res.statusCode, body: json, raw: buf });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  const get = (p, token) => req('GET', p, null, token);
  const post = (p, body, token) => req('POST', p, body, token);
  const put = (p, body, token) => req('PUT', p, body, token);
  const patch = (p, body, token) => req('PATCH', p, body, token);
  const del = (p, token) => req('DELETE', p, null, token);

  function idOf(res) {
    const b = res && res.body;
    if (!b) return null;
    return b.id || b.data?.id || b.invoice?.id || b.customer?.id || b.product?.id || null;
  }

  return { req, get, post, put, patch, del, idOf };
}

module.exports = { createHttp };
