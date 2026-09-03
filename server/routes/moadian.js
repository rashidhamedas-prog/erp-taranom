const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting, centralOnly, centralOnlyStrict } = require('../middleware/auth');
const { getPublicSettings, updateSettings, getSetting } = require('../lib/secret-settings');
const { ENVELOPE_PREFIX, LEGACY_ENVELOPE_RE, decryptDetailed } = require('../services/crypto');
const moadian = require('../lib/moadian');

const MOADIAN_SETTING_KEYS = ['moadian_enabled', 'moadian_fiscal_id', 'moadian_private_key_path', 'moadian_adapter'];

function enqueueMoadian(db, docType, docId) {
  return moadian.enqueueMoadian(db, docType, docId);
}

/** Path setting may still be legacy-encrypted from when it was classified as secret. */
function readMoadianKeyPath(db) {
  let value = getSetting(db, 'moadian_private_key_path') || '';
  if (!value) return '';
  const looksEncrypted = value.startsWith(ENVELOPE_PREFIX) || LEGACY_ENVELOPE_RE.test(value);
  if (looksEncrypted) {
    try {
      value = decryptDetailed(value, 'setting:moadian_private_key_path').plaintext || '';
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
        .run('moadian_private_key_path', value);
    } catch (_) {
      return '';
    }
  }
  return value;
}

function adapterOpts(db) {
  return {
    fiscalId: getSetting(db, 'moadian_fiscal_id') || '',
    privateKeyPath: readMoadianKeyPath(db),
  };
}

router.get('/queue', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { status } = req.query;
  let sql = `
    SELECT q.*, i.num as invoice_num, i.final, i.date as invoice_date,
           i.moadian_invoice_type, c.biz as cust_biz
    FROM moadian_queue q
    LEFT JOIN invoices i ON q.doc_type='sales' AND q.doc_id=i.id
    LEFT JOIN customers c ON i.cust_id=c.id
  `;
  const params = [];
  if (status) { sql += ' WHERE q.status=?'; params.push(status); }
  sql += ' ORDER BY q.id DESC LIMIT 200';
  res.json({ success: true, data: db.prepare(sql).all(...params) });
});

router.get('/queue/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare(`
    SELECT q.*, i.num as invoice_num, i.moadian_invoice_type, i.moadian_ref_tax_id,
           i.moadian_correction_type, c.biz as cust_biz
    FROM moadian_queue q
    LEFT JOIN invoices i ON q.doc_type='sales' AND q.doc_id=i.id
    LEFT JOIN customers c ON i.cust_id=c.id
    WHERE q.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  res.json({ success: true, data: row });
});

router.post('/queue/:id/submit', auth, adminOnly, centralOnlyStrict, async (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    if (row.status === 'accepted' || row.status === 'sent') {
      return res.status(422).json({ error: 'قبلاً ارسال/پذیرفته شده' });
    }

    const inv = row.doc_type === 'sales'
      ? db.prepare('SELECT i.*, c.national_id, c.economic_code, c.biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(row.doc_id)
      : null;
    if (inv && inv.type === 'final') {
      if (!inv.economic_code && !inv.national_id) {
        return res.status(422).json({ error: 'کد ملی/اقتصادی مشتری برای مودیان الزامی است' });
      }
    }

    const adapterSetting = getSetting(db, 'moadian_adapter') || 'stub';
    const opts = adapterOpts(db);
    const invoiceType = parseInt(inv?.moadian_invoice_type || row.invoice_type, 10) || 1;

    let adapter;
    try {
      adapter = moadian.getAdapter(adapterSetting, opts);
    } catch (e) {
      return res.status(e.status || 501).json({ error: e.message, code: e.code || 'MOADIAN_ADAPTER' });
    }

    const payload = moadian.buildSalesPayload(inv || { final: 0, rows: [] }, {
      fiscalId: opts.fiscalId,
      invoiceType,
    });
    const signed = moadian.signPayload(payload, { privateKeyPath: opts.privateKeyPath || undefined });

    let result;
    try {
      result = await adapter.submit({
        payload,
        signed,
        fiscalId: opts.fiscalId,
        privateKeyPath: opts.privateKeyPath,
      });
    } catch (e) {
      moadian.markFailed(db, row.id, e.message);
      return res.status(422).json({ error: e.message, code: e.code || 'MOADIAN_SUBMIT_FAILED' });
    }

    const usedAdapter = result.adapter || adapterSetting;
    const isSandbox = usedAdapter === 'sandbox' || usedAdapter === 'sandbox-offline' || usedAdapter === 'stub';
    if (isSandbox) {
      moadian.markTestSent(db, row.id, result.taxId, result.response);
    } else {
      moadian.markSent(db, row.id, result.taxId, result.response);
    }
    db.prepare('UPDATE moadian_queue SET invoice_type=?, adapter=? WHERE id=?')
      .run(invoiceType, usedAdapter, row.id);

    if (inv) {
      const invStatus = isSandbox ? 'test_sent' : 'sent';
      db.prepare('UPDATE invoices SET moadian_tax_id=?, moadian_status=? WHERE id=?')
        .run(result.taxId, invStatus, inv.id);
    }
    audit(req.user.id, 'moadian_submit', 'moadian_queue', req.params.id, result.taxId);
    res.json({
      success: true,
      data: {
        tax_id: result.taxId,
        status: isSandbox ? 'test_sent' : 'sent',
        invoice_type: invoiceType,
        adapter: usedAdapter,
        response: result.response || null,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Ping official tax endpoint (sandbox or live) — no invoice stamp. */
router.post('/ping', auth, adminOnly, centralOnlyStrict, async (req, res) => {
  try {
    const db = getDB();
    const env = String(req.body?.env || getSetting(db, 'moadian_adapter') || 'sandbox').toLowerCase();
    const target = env === 'live' ? 'live' : 'sandbox';
    const info = await moadian.client.getServerInformation(target);
    audit(req.user.id, 'moadian_ping', 'moadian', null, target);
    res.json({
      success: true,
      data: {
        ok: !!info.ok,
        env: target,
        base: info.base,
        httpStatus: info.status,
        hasServerKey: !!(info.serverKey && (info.serverKey.pem || info.serverKey.id)),
        message: info.ok
          ? (target === 'sandbox' ? 'ارتباط با سندباکس مودیان برقرار است' : 'ارتباط با سرور عملیاتی مودیان برقرار است')
          : 'پاسخ ناموفق از سرور مودیان',
      },
    });
  } catch (e) {
    res.status(422).json({ error: e.message, code: e.code || 'MOADIAN_PING_FAILED' });
  }
});

/**
 * Experimental invoice send to sandbox (ارسال آزمایشی) without requiring queue row lock rules of live.
 * Body: { queue_id?: number, invoice_id?: number }
 */
router.post('/test-send', auth, adminOnly, centralOnlyStrict, async (req, res) => {
  try {
    const db = getDB();
    const opts = adapterOpts(db);
    if (!opts.fiscalId) {
      return res.status(422).json({ error: 'شناسه حافظه مالیاتی را در تنظیمات مودیان وارد کنید', code: 'MOADIAN_FISCAL_REQUIRED' });
    }
    if (!opts.privateKeyPath) {
      return res.status(422).json({ error: 'مسیر کلید خصوصی مودیان تنظیم نشده', code: 'MOADIAN_KEY_REQUIRED' });
    }

    let inv = null;
    let queueId = req.body?.queue_id ? Number(req.body.queue_id) : null;
    if (queueId) {
      const row = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
      if (!row) return res.status(404).json({ error: 'ردیف صف یافت نشد' });
      inv = db.prepare('SELECT i.*, c.national_id, c.economic_code, c.biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(row.doc_id);
    } else if (req.body?.invoice_id) {
      inv = db.prepare('SELECT i.*, c.national_id, c.economic_code, c.biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(Number(req.body.invoice_id));
      if (!inv) return res.status(404).json({ error: 'فاکتور یافت نشد' });
      queueId = moadian.enqueueMoadian(db, 'sales', inv.id)
        || db.prepare('SELECT id FROM moadian_queue WHERE doc_type=? AND doc_id=?').get('sales', inv.id)?.id;
    } else {
      return res.status(400).json({ error: 'queue_id یا invoice_id الزامی است' });
    }

    const invoiceType = parseInt(inv?.moadian_invoice_type || 1, 10) || 1;
    const payload = moadian.buildSalesPayload(inv || { final: 0, rows: [] }, {
      fiscalId: opts.fiscalId,
      invoiceType,
    });
    const signed = moadian.signPayload(payload, { privateKeyPath: opts.privateKeyPath });
    const adapter = moadian.getAdapter('sandbox', opts);
    let result;
    try {
      result = await adapter.submit({
        payload,
        signed,
        fiscalId: opts.fiscalId,
        privateKeyPath: opts.privateKeyPath,
      });
    } catch (e) {
      if (queueId) moadian.markFailed(db, queueId, e.message);
      return res.status(422).json({ error: e.message, code: e.code || 'MOADIAN_TEST_SEND_FAILED', extra: e.extra || null });
    }

    if (queueId) {
      moadian.markTestSent(db, queueId, result.taxId, result.response);
      db.prepare('UPDATE moadian_queue SET invoice_type=?, adapter=? WHERE id=?').run(invoiceType, 'sandbox', queueId);
    }
    if (inv) {
      db.prepare('UPDATE invoices SET moadian_tax_id=?, moadian_status=? WHERE id=?')
        .run(result.taxId, 'test_sent', inv.id);
    }
    audit(req.user.id, 'moadian_test_send', 'moadian_queue', queueId, result.taxId);
    res.json({
      success: true,
      data: {
        tax_id: result.taxId,
        status: 'test_sent',
        adapter: 'sandbox',
        queue_id: queueId,
        response: result.response || null,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code || 'MOADIAN_TEST_SEND' });
  }
});

router.post('/queue/:id/correct', auth, adminOnly, centralOnlyStrict, (req, res) => {
  try {
    const db = getDB();
    const orig = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(req.params.id);
    if (!orig) return res.status(404).json({ error: 'یافت نشد' });
    if (orig.doc_type !== 'sales') throw new Error('اصلاح فقط برای فاکتور فروش پشتیبانی می‌شود');

    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(orig.doc_id);
    if (!inv) throw new Error('فاکتور مبنا یافت نشد');

    const refTaxId = req.body.moadian_ref_tax_id || inv.moadian_tax_id || orig.tax_id;
    if (!refTaxId) throw new Error('شناسه مالیاتی مرجع الزامی است');

    const correctionType = req.body.correction_type || 'correct';
    const invoiceType = parseInt(req.body.moadian_invoice_type || inv.moadian_invoice_type || 1, 10) || 1;
    const adapter = db.prepare("SELECT value FROM settings WHERE key='moadian_adapter'").get()?.value || 'stub';

    const result = db.transaction(() => {
      db.prepare(`
        UPDATE invoices SET moadian_ref_tax_id=?, moadian_correction_type=?, moadian_invoice_type=?
        WHERE id=?
      `).run(refTaxId, correctionType, invoiceType, inv.id);

      const ins = db.prepare(`
        INSERT INTO moadian_queue (doc_type, doc_id, status, invoice_type, adapter, response_json)
        VALUES ('sales', ?, 'pending', ?, ?, ?)
      `).run(
        inv.id, invoiceType, adapter,
        JSON.stringify({ correction: true, ref_tax_id: refTaxId, correction_type: correctionType })
      );
      return ins.lastInsertRowid;
    })();

    audit(req.user.id, 'moadian_correct', 'moadian_queue', result, `اصلاح ${refTaxId}`);
    res.json({ success: true, data: { queue_id: result, moadian_ref_tax_id: refTaxId, invoice_type: invoiceType } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/settings', auth, adminOrAccounting, (req, res) => {
  res.json({ success: true, data: getPublicSettings(getDB(), MOADIAN_SETTING_KEYS) });
});

router.put('/settings', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  updateSettings(db, Object.entries(req.body || {}), new Set(MOADIAN_SETTING_KEYS));
  res.json({ success: true });
});

module.exports = router;
module.exports.enqueueMoadian = enqueueMoadian;
