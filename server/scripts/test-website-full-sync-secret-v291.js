'use strict';
/**
 * v291 — full-sync must not surface English crypto errors when
 * website_b2b_token was sealed under a different DATA_ENCRYPTION_KEY.
 * Unrelated Woo secrets under a wrong key must not block site_b2b.
 *
 * Uses an in-memory settings stub (no native better-sqlite3) so Node 24 hosts can run it.
 */
const assert = require('assert');

const DATA_KEY_A = 'hex:' + '11'.repeat(32);
const DATA_KEY_B = 'hex:' + '22'.repeat(32);

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = DATA_KEY_A;
process.env.JWT_SECRET = 'test-jwt-secret-for-website-sync-v291-xxxxxxxx';

const { encrypt } = require('../services/crypto');
const { setSetting, getSetting } = require('../lib/secret-settings');
const {
  getSettingsMap,
  enqueueFullSync,
  secretOpenError,
} = require('../lib/website-stock-sync');

function makeDb(initial = {}) {
  const store = { ...initial };
  const outbox = new Map();
  return {
    _store: store,
    _outbox: outbox,
    exec() { /* CREATE TABLE IF NOT EXISTS — no-op for stub */ },
    prepare(sql) {
      const s = String(sql);
      if (s.includes('SELECT value FROM settings WHERE key=?')) {
        return {
          get: (key) => (store[key] != null ? { value: store[key] } : undefined),
          pluck() {
            return { get: (key) => (store[key] != null ? store[key] : undefined) };
          },
        };
      }
      if (s.includes('FROM settings WHERE key IN')) {
        return {
          all: (...keys) => keys.map((k) => ({ key: k, value: store[k] != null ? store[k] : '' })),
        };
      }
      if (s.includes('INSERT INTO settings') && s.includes('ON CONFLICT')) {
        return {
          run: (key, value) => { store[key] = value; return { changes: 1 }; },
        };
      }
      if (s.includes('UPDATE settings SET value=? WHERE key=? AND value=?')) {
        return {
          run: (replacement, key, oldValue) => {
            if (store[key] === oldValue) store[key] = replacement;
            return { changes: 1 };
          },
        };
      }
      if (s.includes('FROM product_variants')) {
        return {
          all: () => [{ id: 99 }],
        };
      }
      if (s.includes('website_stock_outbox') && s.includes('INSERT')) {
        return {
          run: (...args) => {
            const productId = args[0];
            const channel = args[1];
            const key = `${productId}:${channel}`;
            outbox.set(key, { product_id: productId, channel, status: 'pending' });
            return { changes: 1 };
          },
        };
      }
      if (s.includes('website_stock_outbox')) {
        return {
          get: () => null,
          all: () => [...outbox.values()],
          run: () => ({ changes: 0 }),
        };
      }
      return {
        get: () => null,
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
}

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  PASS', msg);
}

const db = makeDb({
  website_stock_sync_enabled: '1',
  website_stock_sync_mode: 'push',
  website_target: 'site_b2b',
  website_b2b_url: 'https://api.example.com',
  website_wh_wholesale_id: '10',
  website_wh_retail_id: '20',
  website_wc_url: 'https://woo.example.com',
});

setSetting(db, 'website_b2b_token', 'site-token-under-key-a');
setSetting(db, 'website_wc_key', 'woo-key');
setSetting(db, 'website_wc_secret', 'woo-secret');

const tokenCipher = db._store.website_b2b_token;
check(String(tokenCipher).startsWith('enc:v2:'), 'token stored as enc:v2 envelope');

process.env.DATA_ENCRYPTION_KEY = DATA_KEY_B;
let threw = null;
try {
  getSettingsMap(db);
} catch (e) {
  threw = e;
}
check(threw && threw.code === 'E_SECRET_KEY_MISMATCH', 'getSettingsMap throws E_SECRET_KEY_MISMATCH');
check(threw.key === 'website_b2b_token', 'error.key is website_b2b_token');
check(/قابل خواندن نیست/.test(threw.message), 'error message is Persian recovery guidance');
check(!/Encrypted secret|cannot be opened/i.test(threw.message), 'no English crypto string in message');
check(!String(threw.message).includes(tokenCipher), 'ciphertext never appears in error');

let enqErr = null;
try {
  enqueueFullSync(db);
} catch (e) {
  enqErr = e;
}
check(enqErr && enqErr.code === 'E_SECRET_KEY_MISMATCH', 'enqueueFullSync fails closed on unreadable token');
check(/کلید API موجودی سایت/.test(enqErr.message), 'enqueueFullSync names the API key field');
check(enqErr.code === 'E_SECRET_KEY_MISMATCH' && enqErr.key === 'website_b2b_token', 'API body contract code+key');

// Token resealed under KEY_B; Woo secret left as KEY_A ciphertext — must not block site_b2b
process.env.DATA_ENCRYPTION_KEY = DATA_KEY_A;
const plainToken = getSetting(db, 'website_b2b_token');
const wooCipherA = db._store.website_wc_secret;
process.env.DATA_ENCRYPTION_KEY = DATA_KEY_B;
setSetting(db, 'website_b2b_token', plainToken);
db._store.website_wc_secret = wooCipherA;
db._store.website_wc_key = encrypt('woo-key', 'setting:website_wc_key'); // also KEY_B so only secret mismatched if we loaded it
// Keep KEY_A ciphertext for woo secret while process key is B
db._store.website_wc_secret = wooCipherA;

const mapOk = getSettingsMap(db);
check(mapOk.website_b2b_token === plainToken, 'site_b2b opens token despite unreadable woo secret');
check(mapOk.website_wc_secret === '', 'woo secret not loaded for site_b2b target');

const wrapped = secretOpenError('website_b2b_token', Object.assign(new Error('x'), { code: 'E_SECRET_KEY_MISMATCH' }));
check(wrapped.code === 'E_SECRET_KEY_MISMATCH' && wrapped.key === 'website_b2b_token', 'secretOpenError preserves code/key');

console.log(`ALL PASS (${passed})`);
process.exit(0);
