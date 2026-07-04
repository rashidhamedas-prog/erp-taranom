const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { todayJalali, nowHHMM } = require('../jalali');

router.use(auth);

const now = () => Math.floor(Date.now() / 1000);

// Create a followup from an offline payload (idempotent by client_uuid)
function createFollowup(db, tenantId, userId, uuid, p) {
  const existing = db.prepare('SELECT id FROM followups WHERE tenant_id=? AND client_uuid=?').get(tenantId, uuid);
  if (existing) return { id: existing.id, deduped: true };
  const cust = db.prepare('SELECT id FROM customers WHERE id=? AND tenant_id=?').get(p.cust_id, tenantId);
  if (!cust) throw new Error('مشتری یافت نشد');
  const r = db.prepare(
    'INSERT INTO followups (tenant_id,user_id,cust_id,date,time,type,subject,note,action,next_date,next_time,status,priority,interest_level,purchase_prob,pipeline_stage,tags,lost_reason,client_uuid,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    tenantId, userId, p.cust_id, p.date || todayJalali(), p.time || nowHHMM(),
    p.type || '📱 تلفن', p.subject || '', p.note || '', p.action || '', p.next_date || '', p.next_time || '',
    p.status || 'open', p.priority || 'mid', p.interest_level || 'mid', parseInt(p.purchase_prob) || 50,
    p.pipeline_stage || 'lead', p.tags || '', p.lost_reason || '', uuid, now()
  );
  return { id: r.lastInsertRowid };
}

// Create an invoice from an offline payload (idempotent; full stock validation server-side)
function createInvoice(db, tenantId, userId, uuid, p) {
  const existing = db.prepare('SELECT id, num FROM invoices WHERE tenant_id=? AND client_uuid=?').get(tenantId, uuid);
  if (existing) return { id: existing.id, num: existing.num, deduped: true };
  const cust = db.prepare('SELECT id, auto_followup FROM customers WHERE id=? AND tenant_id=?').get(p.cust_id, tenantId);
  if (!cust) throw new Error('مشتری یافت نشد');

  // Rebuild rows against current products (offline client may hold stale prices — its explicit prices win)
  let subtotal = 0;
  const rows = [];
  for (const r of (p.rows || [])) {
    const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(parseInt(r.product_id), tenantId);
    if (!prod) throw new Error('محصول یافت نشد (شناسه ' + r.product_id + ')');
    const qty = Math.max(1, parseInt(r.qty) || 1);
    const price = (r.price !== undefined && r.price !== null && r.price !== '') ? (parseFloat(r.price) || 0) : prod.price;
    const sum = qty * price;
    subtotal += sum;
    rows.push({ product_id: prod.id, name: prod.name, qty, price, sum, mac_cost: prod.mac_cost || prod.cost || 0 });
  }
  if (!rows.length) throw new Error('فاکتور بدون ردیف');

  const discPct = parseFloat(p.disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;
  const invType = p.type === 'final' ? 'final' : 'proforma';

  // Stock validation happens NOW (server truth) — offline optimistic deduction is reconciled here
  if (invType === 'final') {
    const wms = require('../services/wms');
    for (const r of rows) {
      const prod = db.prepare('SELECT stock,name FROM products WHERE id=? AND tenant_id=?').get(r.product_id, tenantId);
      if (prod.stock < r.qty) throw new Error(`موجودی ${prod.name} کافی نیست (موجود: ${prod.stock})`);
    }
    for (const r of rows) {
      wms.issueForSale(db, { tenantId, productId: r.product_id, qty: r.qty, note: 'کسر موجودی از فاکتور آفلاین', date: p.date || '', userId });
    }
  }

  const count = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE tenant_id=?').get(tenantId).c;
  const num = 'T-' + String(count + 1).padStart(4, '0');
  const seller = db.prepare('SELECT name,phone FROM users WHERE id=?').get(userId);
  const r = db.prepare(
    'INSERT INTO invoices (tenant_id,user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,seller_name,seller_phone,pay_type,cheque_duration,cheque_due_date,cheque_info,stock_deducted,client_uuid,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(tenantId, userId, p.cust_id, num, invType, p.date || todayJalali(), p.note || '',
        JSON.stringify(rows), subtotal, discPct, discAmt, final,
        seller ? seller.name : '', seller ? (seller.phone || '') : '',
        p.pay_type || 'cash', p.cheque_duration || '', p.cheque_due_date || '', p.cheque_info || '',
        invType === 'final' ? 1 : 0, uuid, now());
  const invId = r.lastInsertRowid;

  if (invType === 'final') {
    db.prepare("UPDATE customers SET status='active' WHERE id=? AND tenant_id=?").run(p.cust_id, tenantId);
    // full accounting (receivable + revenue + COGS) — same entries as the online invoice engine
    const { createLedgerEntry, createJournalEntry } = require('../db');
    createLedgerEntry(db, {
      tenant_id: tenantId, customer_id: p.cust_id, date: p.date || '', entry_type: 'invoice',
      ref_type: 'invoice', ref_id: invId, description: `فاکتور رسمی ${num}`,
      debit: final, credit: 0, user_id: userId
    });
    const jLines = [{ code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: final, credit: 0 }];
    if (discAmt > 0) jLines.push({ code: '4103', name: 'تخفیفات فروش', debit: discAmt, credit: 0 });
    jLines.push({ code: '4101', name: 'درآمد فروش کالا', debit: 0, credit: subtotal });
    createJournalEntry(db, { tenant_id: tenantId, date: p.date || '', description: `فاکتور رسمی ${num}`, ref_type: 'invoice', ref_id: invId, created_by: userId, lines: jLines });
    const cogs = rows.reduce((a, x) => a + (x.mac_cost || 0) * x.qty, 0);
    if (cogs > 0) {
      createJournalEntry(db, {
        tenant_id: tenantId, date: p.date || '', description: `بهای تمام‌شده فاکتور ${num}`,
        ref_type: 'invoice_cogs', ref_id: invId, created_by: userId,
        lines: [
          { code: '5000', name: 'بهای تمام‌شده کالای فروش رفته', debit: cogs, credit: 0 },
          { code: '1104', name: 'موجودی کالا', debit: 0, credit: cogs }
        ]
      });
    }
  }
  return { id: invId, num };
}

// Update a followup with last-write-wins conflict resolution
function updateFollowup(db, tenantId, userId, uuid, p, clientUpdatedAt) {
  const row = p.id
    ? db.prepare('SELECT * FROM followups WHERE id=? AND tenant_id=?').get(p.id, tenantId)
    : db.prepare('SELECT * FROM followups WHERE client_uuid=? AND tenant_id=?').get(uuid, tenantId);
  if (!row) throw new Error('پیگیری یافت نشد');
  const serverTs = row.updated_at || row.created_at || 0;
  const clientTs = Math.floor((clientUpdatedAt || Date.now()) / 1000);
  if (serverTs > clientTs) {
    // server version is newer → client change LOSES; archive it for admin review
    db.prepare('INSERT INTO sync_conflicts (tenant_id,entity,entity_id,client_uuid,loser_payload,winner_payload) VALUES (?,?,?,?,?,?)')
      .run(tenantId, 'followup', row.id, uuid, JSON.stringify(p), JSON.stringify(row));
    return { id: row.id, conflict: true, winner: 'server' };
  }
  // client wins → archive the server version, apply the client's
  db.prepare('INSERT INTO sync_conflicts (tenant_id,entity,entity_id,client_uuid,loser_payload,winner_payload) VALUES (?,?,?,?,?,?)')
    .run(tenantId, 'followup', row.id, uuid, JSON.stringify(row), JSON.stringify(p));
  db.prepare(`UPDATE followups SET subject=?, note=?, action=?, next_date=?, next_time=?, status=?, priority=?, pipeline_stage=?, purchase_prob=?, interest_level=?, tags=?, lost_reason=?, updated_at=? WHERE id=? AND tenant_id=?`)
    .run(p.subject ?? row.subject, p.note ?? row.note, p.action ?? row.action,
         p.next_date ?? row.next_date, p.next_time ?? row.next_time,
         p.status ?? row.status, p.priority ?? row.priority, p.pipeline_stage ?? row.pipeline_stage,
         p.purchase_prob ?? row.purchase_prob, p.interest_level ?? row.interest_level,
         p.tags ?? row.tags, p.lost_reason ?? row.lost_reason, now(), row.id, tenantId);
  return { id: row.id, conflict: serverTs > 0 && serverTs !== clientTs, winner: 'client' };
}

// Push a batch of offline operations. Each item: {client_uuid, entity, action, payload, device, client_updated_at}
router.post('/push', (req, res) => {
  const db = getDB();
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.json({ results: [] });
  if (items.length > 200) return res.status(400).json({ error: 'حداکثر ۲۰۰ آیتم در هر درخواست' });

  const results = [];
  for (const item of items) {
    const uuid = String(item.client_uuid || '').slice(0, 64);
    const entity = item.entity;
    const action = item.action || 'create';
    if (!uuid || !['invoice', 'followup'].includes(entity)) {
      results.push({ client_uuid: uuid, status: 'error', error: 'آیتم نامعتبر' });
      continue;
    }
    // journal the queue item
    const q = db.prepare('INSERT INTO sync_queue (tenant_id,user_id,client_uuid,entity,action,payload,device,status) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.tenantId, req.user.id, uuid, entity, action, JSON.stringify(item.payload || {}), String(item.device || '').slice(0, 80), 'pending');
    try {
      let out;
      const p = item.payload || {};
      if (entity === 'followup' && action === 'create') out = createFollowup(db, req.tenantId, req.user.id, uuid, p);
      else if (entity === 'invoice' && action === 'create') out = createInvoice(db, req.tenantId, req.user.id, uuid, p);
      else if (entity === 'followup' && action === 'update') out = updateFollowup(db, req.tenantId, req.user.id, uuid, p, item.client_updated_at);
      else throw new Error('عملیات پشتیبانی نمی‌شود');
      db.prepare("UPDATE sync_queue SET status=?, processed_at=? WHERE id=?")
        .run(out.conflict ? 'conflict' : 'done', now(), q.lastInsertRowid);
      results.push({ client_uuid: uuid, status: out.conflict ? 'conflict' : 'ok', ...out });
    } catch (e) {
      db.prepare("UPDATE sync_queue SET status='error', error=?, processed_at=? WHERE id=?").run(e.message, now(), q.lastInsertRowid);
      results.push({ client_uuid: uuid, status: 'error', error: e.message });
    }
  }
  audit(req.tenantId, req.user.id, 'sync_push', 'sync', null, `${items.length} آیتم همگام‌سازی (${results.filter(r => r.status === 'ok').length} موفق)`, req.ip);
  res.json({ results });
});

// Pull fresh reference data for the offline cache (customers/products scoped to the user)
router.get('/pull', (req, res) => {
  const db = getDB();
  const isAdminLike = ['admin', 'accounting'].includes(req.user.role);
  const customers = isAdminLike
    ? db.prepare('SELECT id,biz,owner,city,phone,status,auto_followup FROM customers WHERE tenant_id=? ORDER BY biz').all(req.tenantId)
    : db.prepare('SELECT id,biz,owner,city,phone,status,auto_followup FROM customers WHERE tenant_id=? AND user_id=? ORDER BY biz').all(req.tenantId, req.user.id);
  const products = db.prepare('SELECT id,name,code,barcode,category,price,stock,unit,image,colors,pack_size FROM products WHERE tenant_id=? ORDER BY name').all(req.tenantId);
  res.json({ ts: Date.now(), customers, products });
});

// Sync status for the current user's device dashboard widget
router.get('/status', (req, res) => {
  const db = getDB();
  const mine = db.prepare(`
    SELECT status, COUNT(*) c FROM sync_queue WHERE tenant_id=? AND user_id=? GROUP BY status
  `).all(req.tenantId, req.user.id);
  const last = db.prepare("SELECT MAX(processed_at) t FROM sync_queue WHERE tenant_id=? AND user_id=? AND status='done'").get(req.tenantId, req.user.id);
  res.json({ counts: Object.fromEntries(mine.map(r => [r.status, r.c])), last_success: last.t || null });
});

// Admin: conflict archive review
router.get('/conflicts', adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT sc.*, u.name as user_name FROM sync_conflicts sc
    LEFT JOIN sync_queue sq ON sq.client_uuid=sc.client_uuid AND sq.tenant_id=sc.tenant_id
    LEFT JOIN users u ON sq.user_id=u.id
    WHERE sc.tenant_id=? ORDER BY sc.created_at DESC LIMIT 200
  `).all(req.tenantId);
  res.json(rows);
});

router.post('/conflicts/:id/reviewed', adminOnly, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE sync_conflicts SET reviewed=1 WHERE id=? AND tenant_id=?').run(req.params.id, req.tenantId);
  res.json({ ok: true });
});

module.exports = router;
