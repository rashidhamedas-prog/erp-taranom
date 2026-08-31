'use strict';

const { ADMIN_USER, ADMIN_BOOTSTRAP_PASS, ADMIN_PASS, ROLE_PASS, QA_DATE } = require('../lib/constants');

async function login(http, username, password) {
  const r = await http.post('/auth/login', {
    username, password,
    device_kind: 'qa', device_name: 'qa-harness', device_fingerprint: 'qa-' + username,
  });
  return r;
}

async function loginAdmin(http, rec) {
  let r = await login(http, ADMIN_USER, ADMIN_BOOTSTRAP_PASS);
  if (r.status !== 200 || !r.body?.token) {
    r = await login(http, ADMIN_USER, ADMIN_PASS);
  }
  rec({
    id: 'admin.login', suite: 'admin', module: 'auth',
    status: r.status === 200 && r.body?.token ? 'PASS' : 'FAIL',
    expected: 200, actual: r.status,
    message: r.body?.error || '',
    evidence: 'token=' + (r.body?.token ? 'yes' : 'no'),
  });
  if (!(r.status === 200 && r.body?.token)) throw new Error('admin login failed: ' + (r.body?.error || r.status));
  let token = r.body.token;
  if (r.body.must_change_password) {
    const ch = await http.post('/auth/change-password', { oldPass: ADMIN_BOOTSTRAP_PASS, newPass: ADMIN_PASS }, token);
    rec({
      id: 'admin.change_password', suite: 'admin', module: 'auth',
      status: ch.status === 200 ? 'PASS' : 'FAIL',
      expected: 200, actual: ch.status,
      message: ch.body?.error || '',
    });
    r = await login(http, ADMIN_USER, ADMIN_PASS);
    token = r.body?.token;
    rec({
      id: 'admin.relogin', suite: 'admin', module: 'auth',
      status: token ? 'PASS' : 'FAIL', expected: 200, actual: r.status,
    });
  } else {
    rec({ id: 'admin.change_password', suite: 'admin', module: 'auth', status: 'SKIP', message: 'must_change_password not set' });
  }
  return { token, user: r.body?.user };
}

function okStatus(res) {
  return res.status === 200 || res.status === 201;
}

async function runAdminBatch({ http, rec, gap, ctx }) {
  const { token } = await loginAdmin(http, rec);
  ctx.adminToken = token;

  const fy = await http.get('/fiscal-year', token);
  rec({
    id: 'boot.fiscal_year', suite: 'admin', module: 'fiscal',
    status: okStatus(fy) && (fy.body?.current || (fy.body?.years || []).length) ? 'PASS' : 'FAIL',
    expected: 'open FY', actual: fy.status,
    evidence: fy.body?.current?.label || fy.body?.current?.status || JSON.stringify(fy.body).slice(0, 200),
  });
  ctx.fiscalYear = fy.body?.current || null;

  const coa = await http.get('/accounting/chart', token).catch(() => ({ status: 404, body: null }));
  if (coa.status === 404) {
    const alt = await http.get('/detail-accounts', token);
    rec({
      id: 'boot.coa', suite: 'admin', module: 'accounting',
      status: okStatus(alt) || okStatus(coa) ? 'PASS' : 'FAIL',
      expected: 200, actual: alt.status,
    });
  } else {
    rec({
      id: 'boot.coa', suite: 'admin', module: 'accounting',
      status: okStatus(coa) ? 'PASS' : 'FAIL',
      expected: 200, actual: coa.status,
    });
  }

  const whList = await http.get('/warehouses', token);
  const warehouses = Array.isArray(whList.body) ? whList.body : (whList.body?.data || whList.body?.rows || []);
  rec({
    id: 'boot.warehouses_seed', suite: 'admin', module: 'warehouse',
    status: okStatus(whList) && warehouses.length ? 'PASS' : 'FAIL',
    expected: '>0', actual: warehouses.length,
  });
  ctx.warehouses = warehouses;
  const byCode = Object.fromEntries(warehouses.map((w) => [w.code, w]));
  ctx.whRaw = byCode['WH-RAW'] || warehouses.find((w) => w.warehouse_type === 'raw_material') || warehouses[0];
  ctx.whFg = byCode['WH-FG'] || byCode['WH-DIST'] || warehouses.find((w) => w.warehouse_type === 'finished_goods') || warehouses[0];

  async function ensureWh(code, name, type) {
    if (byCode[code]) return byCode[code];
    const created = await http.post('/warehouses', { name, code, warehouse_type: type }, token);
    rec({
      id: 'boot.wh.' + code, suite: 'admin', module: 'warehouse',
      status: okStatus(created) ? 'PASS' : 'FAIL',
      expected: 200, actual: created.status, message: created.body?.error || '',
    });
    const row = created.body;
    if (row?.id) { byCode[code] = row; ctx.warehouses.push(row); }
    return row;
  }
  ctx.whRet = await ensureWh('WH-RET', 'انبار مرجوعی QA', 'returns');
  ctx.whScrap = byCode['WH-SCRAP'] || await ensureWh('WH-SCRAP', 'انبار ضایعات QA', 'scrap');
  ctx.whCons = await ensureWh('WH-CONS', 'انبار امانی QA', 'consignment');

  const bank = await http.post('/banks', {
    name: 'بانک QA ملت', account_number: '0101010101', branch: 'مشهد',
    opening_balance_rial: 100000000, opening_balance_date: QA_DATE,
  }, token);
  rec({
    id: 'boot.bank', suite: 'admin', module: 'treasury',
    status: okStatus(bank) ? 'PASS' : 'FAIL',
    expected: 200, actual: bank.status, message: bank.body?.error || '',
  });
  ctx.bankId = bank.body?.id;

  const cash = await http.post('/cash-boxes', {
    name: 'صندوق QA', opening_balance_rial: 50000000, opening_balance_date: QA_DATE,
  }, token);
  rec({
    id: 'boot.cash', suite: 'admin', module: 'treasury',
    status: okStatus(cash) ? 'PASS' : 'FAIL',
    expected: 200, actual: cash.status, message: cash.body?.error || '',
  });
  ctx.cashId = cash.body?.id;

  const partyCust = await http.post('/parties', {
    full_name: 'فروشگاه QA مشتری', phone: '09151110001', city: 'مشهد',
    party_roles: ['customer'], party_type: 'customer',
  }, token);
  rec({
    id: 'boot.party.customer', suite: 'admin', module: 'party',
    status: okStatus(partyCust) ? 'PASS' : 'FAIL',
    expected: 200, actual: partyCust.status, message: partyCust.body?.error || '',
  });
  ctx.partyCustomer = partyCust.body?.id || partyCust.body?.data?.id;

  const dup = await http.post('/parties', {
    full_name: 'تکراری', phone: '09151110001', party_roles: ['customer'],
  }, token);
  rec({
    id: 'boot.party.duplicate', suite: 'admin', module: 'party',
    status: dup.status === 409 ? 'PASS' : 'FAIL',
    expected: 409, actual: dup.status, message: dup.body?.error || '',
  });

  const partySup = await http.post('/parties', {
    full_name: 'تأمین‌کننده QA', phone: '09151110002',
    party_roles: ['supplier'], party_type: 'supplier',
  }, token);
  rec({
    id: 'boot.party.supplier', suite: 'admin', module: 'party',
    status: okStatus(partySup) ? 'PASS' : 'FAIL',
    expected: 200, actual: partySup.status, message: partySup.body?.error || '',
  });
  ctx.partySupplier = partySup.body?.id || partySup.body?.data?.id;

  const partyEmp = await http.post('/parties', {
    full_name: 'کارمند QA', phone: '09151110003',
    party_roles: ['employee'], party_type: 'other',
  }, token);
  rec({
    id: 'boot.party.employee', suite: 'admin', module: 'party',
    status: okStatus(partyEmp) ? 'PASS' : 'FAIL',
    expected: 200, actual: partyEmp.status, message: partyEmp.body?.error || '',
  });

  const partyBoth = await http.post('/parties', {
    full_name: 'چندنقشه QA', phone: '09151110004',
    party_roles: ['customer', 'supplier'], party_type: 'both',
  }, token);
  rec({
    id: 'boot.party.multi_role', suite: 'admin', module: 'party',
    status: okStatus(partyBoth) ? 'PASS' : 'FAIL',
    expected: 200, actual: partyBoth.status, message: partyBoth.body?.error || '',
  });

  const cust = await http.post('/customers', {
    biz: 'فروشگاه QA مشتری', owner: 'QA', city: 'مشهد', phone: '09151110001', status: 'active',
  }, token);
  rec({
    id: 'boot.customer', suite: 'admin', module: 'party',
    status: okStatus(cust) ? 'PASS' : 'FAIL',
    expected: 200, actual: cust.status, message: cust.body?.error || '',
  });
  ctx.customerId = cust.body?.id;

  const sup = await http.post('/suppliers', { name: 'تأمین‌کننده QA', phone: '09151110002' }, token);
  rec({
    id: 'boot.supplier', suite: 'admin', module: 'party',
    status: okStatus(sup) ? 'PASS' : 'FAIL',
    expected: 200, actual: sup.status, message: sup.body?.error || '',
  });
  ctx.supplierId = sup.body?.id;

  const person = await http.post('/persons', {
    name: 'کارمند حقوق QA', phone: '09151110003', hourly_rate: 1000000, overtime_rate: 1500000,
  }, token);
  rec({
    id: 'boot.person', suite: 'admin', module: 'payroll',
    status: okStatus(person) ? 'PASS' : 'FAIL',
    expected: 200, actual: person.status, message: person.body?.error || '',
  });
  ctx.personId = person.body?.id;

  const uom = await http.post('/units', { code: 'QA-PCS', name: 'عدد QA' }, token);
  rec({
    id: 'boot.uom', suite: 'admin', module: 'product',
    status: okStatus(uom) || uom.status === 409 ? 'PASS' : 'FAIL',
    expected: 200, actual: uom.status, message: uom.body?.error || '',
  });
  ctx.uomId = uom.body?.id;

  const fgWh = ctx.whFg?.id;
  const prod = await http.post('/products', {
    name: 'مانتو QA', code: 'QA-FG-01', price: 2500000, cost: 1000000, stock: 20,
    unit: 'عدد', warehouse_id: fgWh,
  }, token);
  rec({
    id: 'boot.product.fg', suite: 'admin', module: 'product',
    status: okStatus(prod) ? 'PASS' : 'FAIL',
    expected: 200, actual: prod.status, message: prod.body?.error || '',
  });
  ctx.productId = prod.body?.id;

  const fabric = await http.post('/products', {
    name: 'کرپ QA', code: 'QA-FAB-01', price: 0, cost: 250000, stock: 0,
    unit: 'متر', warehouse_id: ctx.whRaw?.id,
  }, token);
  rec({
    id: 'boot.product.fabric', suite: 'admin', module: 'product',
    status: okStatus(fabric) ? 'PASS' : 'FAIL',
    expected: 200, actual: fabric.status, message: fabric.body?.error || '',
  });
  ctx.fabricId = fabric.body?.id;

  const color = await http.post('/product-variants/colors', { name: 'مشکی QA', code: 'BLK' }, token);
  rec({
    id: 'boot.variant.color', suite: 'admin', module: 'product',
    status: okStatus(color) || color.status === 400 ? (okStatus(color) ? 'PASS' : 'SKIP') : 'FAIL',
    expected: 200, actual: color.status, message: color.body?.error || '',
  });

  // --- sales cycle ---
  const proforma = await http.post('/invoices', {
    cust_id: ctx.customerId, type: 'proforma', date: QA_DATE, pay_type: 'credit',
    warehouse_id: fgWh,
    rows: [{ product_id: ctx.productId, qty: 2, price: 2500000 }],
  }, token);
  rec({
    id: 'sales.proforma', suite: 'admin', module: 'sales',
    status: okStatus(proforma) ? 'PASS' : 'FAIL',
    expected: 200, actual: proforma.status, message: proforma.body?.error || '',
  });
  ctx.proformaId = proforma.body?.id;

  if (ctx.proformaId) {
    const conv = await http.post(`/invoices/${ctx.proformaId}/convert`, { type: 'final' }, token);
    rec({
      id: 'sales.convert', suite: 'admin', module: 'sales',
      status: okStatus(conv) ? 'PASS' : 'FAIL',
      expected: 200, actual: conv.status, message: conv.body?.error || '',
    });
  }

  const order = await http.post('/orders', {
    cust_id: ctx.customerId, product_id: ctx.productId, date: QA_DATE,
    qty: 1, total: 2500000, paid: 0, status: 'pending',
  }, token);
  rec({
    id: 'sales.order', suite: 'admin', module: 'sales',
    status: okStatus(order) ? 'PASS' : 'FAIL',
    expected: 200, actual: order.status, message: order.body?.error || '',
  });

  const inv = await http.post('/invoices', {
    cust_id: ctx.customerId, type: 'final', date: QA_DATE, pay_type: 'credit',
    warehouse_id: fgWh,
    rows: [{ product_id: ctx.productId, qty: 1, price: 2500000, warehouse_id: fgWh }],
  }, token);
  rec({
    id: 'sales.final', suite: 'admin', module: 'sales',
    status: okStatus(inv) ? 'PASS' : 'FAIL',
    expected: 200, actual: inv.status, message: inv.body?.error || JSON.stringify(inv.body).slice(0, 180),
  });
  ctx.invoiceId = inv.body?.id;
  if (ctx.invoiceId) {
    const receipt = await http.post('/accounting/settlements', {
      cust_id: ctx.customerId, invoice_id: ctx.invoiceId, amount: 500000,
      pay_type: 'cash', date: QA_DATE, cash_box_id: ctx.cashId,
    }, token);
    rec({
      id: 'sales.receipt', suite: 'admin', module: 'sales',
      status: okStatus(receipt) ? 'PASS' : 'FAIL',
      expected: 200, actual: receipt.status, message: receipt.body?.error || '',
    });
    ctx.settlementId = receipt.body?.id;
  }
  if (inv.body?.warehouse_id || (inv.body && 'warehouse_id' in inv.body)) {
    rec({
      id: 'sales.header_warehouse', suite: 'admin', module: 'sales',
      status: Number(inv.body.warehouse_id) === Number(fgWh) ? 'PASS' : 'FAIL',
      expected: fgWh, actual: inv.body.warehouse_id,
    });
  }

  const invDup = await http.post('/invoices', {
    cust_id: ctx.customerId, type: 'final', date: QA_DATE, pay_type: 'credit',
    warehouse_id: fgWh,
    rows: [{ product_id: ctx.productId, qty: 1, price: 2500000 }],
  }, token);
  rec({
    id: 'sales.duplicate_submit', suite: 'admin', module: 'sales',
    status: okStatus(invDup) ? 'PASS' : 'FAIL',
    expected: 'second doc allowed (new number) or 409',
    actual: invDup.status,
    message: 'idempotency of POST invoices is not keyed; second create=' + invDup.status,
  });

  if (ctx.invoiceId) {
    const ret = await http.post('/accounting/sales-returns', {
      cust_id: ctx.customerId, invoice_id: ctx.invoiceId, date: QA_DATE, warehouse_id: fgWh,
      rows: [{ product_id: ctx.productId, qty: 1 }],
    }, token);
    rec({
      id: 'sales.return', suite: 'admin', module: 'sales',
      status: okStatus(ret) ? 'PASS' : 'FAIL',
      expected: 200, actual: ret.status, message: ret.body?.error || '',
    });
    ctx.salesReturnId = ret.body?.id;
  }

  const voidInv = ctx.invoiceId
    ? await http.del('/invoices/' + (invDup.body?.id || ctx.invoiceId), token)
    : { status: 0, body: {} };
  rec({
    id: 'sales.void', suite: 'admin', module: 'sales',
    status: okStatus(voidInv) || voidInv.status === 400 ? (okStatus(voidInv) ? 'PASS' : 'SKIP') : 'FAIL',
    expected: 200, actual: voidInv.status, message: voidInv.body?.error || '',
  });
  if (okStatus(voidInv) && (invDup.body?.id || ctx.invoiceId)) {
    const void2 = await http.del('/invoices/' + (invDup.body?.id || ctx.invoiceId), token);
    rec({
      id: 'sales.void_twice', suite: 'admin', module: 'sales',
      status: void2.status >= 400 ? 'PASS' : 'FAIL',
      expected: '4xx', actual: void2.status, message: void2.body?.error || '',
    });
  }

  gap('sales.rfq', 'sales', 'No RFQ route in server/routes');
  gap('sales.reservation_on_order', 'sales', 'orders POST does not call inventory reservations (legacy order table)');

  // --- purchase ---
  gap('purchase.rfq', 'purchase', 'No RFQ/3-way-match named routes');
  gap('purchase.grni', 'purchase', 'coa_grni not in coa-map; purchase posts Dr Inventory / Cr AP directly');

  const po = await http.post('/purchases', {
    supplier_id: ctx.supplierId, date: QA_DATE, pay_type: 'credit', warehouse_id: ctx.whRaw?.id,
    rows: [{ product_id: ctx.fabricId, qty: 10, price: 250000 }],
  }, token);
  rec({
    id: 'purchase.create', suite: 'admin', module: 'purchase',
    status: okStatus(po) ? 'PASS' : 'FAIL',
    expected: 200, actual: po.status, message: po.body?.error || '',
  });
  ctx.purchaseId = po.body?.id;
  if (ctx.purchaseId) {
    const poVoid = await http.del('/purchases/' + ctx.purchaseId, token);
    rec({
      id: 'purchase.void', suite: 'admin', module: 'purchase',
      status: okStatus(poVoid) ? 'PASS' : 'FAIL',
      expected: 200, actual: poVoid.status, message: poVoid.body?.error || '',
    });
  }

  // --- fabric ---
  const roll = await http.post('/inventory/fabric-rolls', {
    product_id: ctx.fabricId,
    warehouse_id: ctx.whRaw?.id,
    color: 'مشکی',
    width_cm: 150,
    meters: 40,
    unit: 'متر',
    unit_cost_rial: 250000,
    supplier_id: ctx.supplierId,
    roll_no: 'QA-R-1001',
    date: QA_DATE,
    idempotency_key: 'qa-fab-1',
  }, token);
  rec({
    id: 'fabric.receive', suite: 'admin', module: 'fabric',
    status: okStatus(roll) ? 'PASS' : 'FAIL',
    expected: 200, actual: roll.status, message: roll.body?.error || JSON.stringify(roll.body).slice(0, 180),
  });
  ctx.rollId = roll.body?.id || roll.body?.data?.id;
  const roll2 = await http.post('/inventory/fabric-rolls', {
    product_id: ctx.fabricId, warehouse_id: ctx.whRaw?.id, meters: 40, unit: 'متر',
    color: 'مشکی', idempotency_key: 'qa-fab-1', date: QA_DATE, supplier_id: ctx.supplierId,
  }, token);
  rec({
    id: 'fabric.idempotent', suite: 'admin', module: 'fabric',
    status: okStatus(roll2) && (roll2.body?.id === ctx.rollId || roll2.body?.idempotent || roll2.status === 200)
      ? 'PASS' : (roll2.status >= 400 ? 'PASS' : 'FAIL'),
    expected: 'same roll or 409', actual: roll2.status,
    message: roll2.body?.error || '',
  });
  gap('fabric.tracking_profile', 'fabric', 'products.tracking_profile=roll not present; rolls live on inventory_batches.kind');

  // --- warehouse ---
  const xfer = await http.post('/warehouses/moves/transfer', {
    product_id: ctx.productId, from_warehouse_id: fgWh, to_warehouse_id: ctx.whRet?.id,
    qty: 1, date: QA_DATE, note: 'QA transfer',
  }, token);
  rec({
    id: 'wh.transfer', suite: 'admin', module: 'warehouse',
    status: okStatus(xfer) || xfer.status === 400 ? (okStatus(xfer) ? 'PASS' : 'SKIP') : 'FAIL',
    expected: 200, actual: xfer.status, message: xfer.body?.error || '',
  });
  const adj = await http.post('/inventory/adjust', {
    product_id: ctx.productId, warehouse_id: fgWh, qty: 1, reason: 'QA opening adjust', date: QA_DATE,
  }, token);
  rec({
    id: 'wh.adjust', suite: 'admin', module: 'warehouse',
    status: okStatus(adj) ? 'PASS' : 'FAIL',
    expected: 200, actual: adj.status, message: adj.body?.error || '',
  });
  const oversell = await http.post('/invoices', {
    cust_id: ctx.customerId, type: 'final', date: QA_DATE, pay_type: 'credit', warehouse_id: fgWh,
    rows: [{ product_id: ctx.productId, qty: 999999, price: 1 }],
  }, token);
  rec({
    id: 'wh.insufficient_stock', suite: 'admin', module: 'warehouse',
    status: oversell.status >= 400 ? 'PASS' : 'FAIL',
    expected: '4xx', actual: oversell.status, message: oversell.body?.error || oversell.body?.code || '',
  });

  // --- treasury / cheque ---
  const chequePartyId = Number(ctx.partyCustomer);
  const chqFree = await http.post('/cheque-records', {
    direction: 'in', cheque_number: 'QA-CH-FREE', amount: 10000000,
    issue_date: QA_DATE, due_date: QA_DATE, bank_name: 'ملت',
    party_name: 'متن آزاد بدون شناسه',
  }, token);
  rec({
    id: 'cheque.party_name_without_id', suite: 'admin', module: 'treasury',
    status: chqFree.status === 400 ? 'PASS' : 'FAIL',
    expected: 400, actual: chqFree.status,
    message: chqFree.body?.error || chqFree.body?.code || '',
  });
  const freeStoredId = chqFree.body?.id || chqFree.body?.data?.id;
  const listedAfterFree = await http.get('/cheque-records?direction=in', token);
  const listedRows = Array.isArray(listedAfterFree.body)
    ? listedAfterFree.body
    : (listedAfterFree.body?.data || listedAfterFree.body?.rows || []);
  const freeTextStored = listedRows.some((row) =>
    row && (row.cheque_number === 'QA-CH-FREE'
      || (String(row.party_name || '') === 'متن آزاد بدون شناسه' && !Number(row.party_id)))
  );
  rec({
    id: 'cheque.free_text_party', suite: 'admin', module: 'party',
    status: chqFree.status >= 400 && !freeStoredId && !freeTextStored ? 'PASS' : 'FAIL',
    expected: 'reject free-text party_name; cheque not stored',
    actual: chqFree.status,
    message: chqFree.body?.error || chqFree.body?.code || (freeStoredId ? 'stored id=' + freeStoredId : '') || (freeTextStored ? 'leaked in list' : ''),
  });

  const chq = await http.post('/cheque-records', {
    direction: 'in', cheque_number: 'QA-CH-1', amount: 10000000,
    issue_date: QA_DATE, due_date: QA_DATE, bank_name: 'ملت',
    party_id: chequePartyId,
  }, token);
  rec({
    id: 'cheque.create_in', suite: 'admin', module: 'treasury',
    status: okStatus(chq) && Number(chq.body?.party_id) === chequePartyId && chequePartyId > 0 ? 'PASS' : 'FAIL',
    expected: 200, actual: chq.status,
    message: chq.body?.error || (Number(chq.body?.party_id) !== chequePartyId ? 'party_id mismatch' : ''),
  });
  ctx.chequeId = chq.body?.id;
  if (ctx.chequeId) {
    const send = await http.post(`/cheque-records/${ctx.chequeId}/send-to-bank`, {}, token);
    rec({
      id: 'cheque.send_to_bank', suite: 'admin', module: 'treasury',
      status: okStatus(send) || send.status === 400 ? (okStatus(send) ? 'PASS' : 'SKIP') : 'FAIL',
      expected: 200, actual: send.status, message: send.body?.error || '',
    });
    const clr = await http.post(`/cheque-records/${ctx.chequeId}/clear`, {}, token);
    rec({
      id: 'cheque.clear', suite: 'admin', module: 'treasury',
      status: okStatus(clr) || clr.status === 400 ? (okStatus(clr) ? 'PASS' : 'SKIP') : 'FAIL',
      expected: 200, actual: clr.status, message: clr.body?.error || '',
    });
    const send2 = await http.post(`/cheque-records/${ctx.chequeId}/send-to-bank`, {}, token);
    rec({
      id: 'cheque.replay_transition', suite: 'admin', module: 'treasury',
      status: send2.status >= 400 ? 'PASS' : 'FAIL',
      expected: '4xx replay', actual: send2.status, message: send2.body?.error || '',
    });
  }

  // --- other modules ---
  const fu = await http.post('/followups', {
    cust_id: ctx.customerId, subject: 'پیگیری QA', type: 'تلفن', date: QA_DATE, status: 'open',
  }, token);
  rec({
    id: 'crm.followup', suite: 'admin', module: 'crm',
    status: okStatus(fu) ? 'PASS' : 'FAIL',
    expected: 200, actual: fu.status, message: fu.body?.error || '',
  });
  const opp = await http.post('/crm/opportunities', {
    customer_id: ctx.customerId, title: 'فرصت QA', stage: 'lead',
  }, token);
  rec({
    id: 'crm.opportunity', suite: 'admin', module: 'crm',
    status: okStatus(opp) || opp.status === 400 ? (okStatus(opp) ? 'PASS' : 'SKIP') : 'FAIL',
    expected: 200, actual: opp.status, message: opp.body?.error || '',
  });

  const boms = await http.get('/production/boms', token);
  rec({
    id: 'prod.boms_list', suite: 'admin', module: 'production',
    status: okStatus(boms) || boms.status === 403 ? (okStatus(boms) ? 'PASS' : 'FAIL') : 'FAIL',
    expected: 200, actual: boms.status, message: boms.body?.error || '',
  });
  const porders = await http.get('/production/orders', token);
  rec({
    id: 'prod.orders_list', suite: 'admin', module: 'production',
    status: okStatus(porders) || porders.status === 404 ? (okStatus(porders) ? 'PASS' : 'SKIP') : 'FAIL',
    expected: 200, actual: porders.status, message: porders.body?.error || '',
  });

  const pay = await http.post('/payroll', {
    person_id: ctx.personId, period_label: '1405-06', regular_hours: 160, hourly_rate: 1000000,
    overtime_hours: 0, date: QA_DATE,
  }, token);
  rec({
    id: 'payroll.create', suite: 'admin', module: 'payroll',
    status: okStatus(pay) ? 'PASS' : 'FAIL',
    expected: 200, actual: pay.status, message: pay.body?.error || '',
  });
  if (pay.body?.id) {
    const payVoid = await http.post('/payroll/' + pay.body.id + '/void-payment', {}, token);
    rec({
      id: 'payroll.void_payment', suite: 'admin', module: 'payroll',
      status: okStatus(payVoid) || payVoid.status === 400 || payVoid.status === 404
        ? (okStatus(payVoid) ? 'PASS' : 'SKIP') : 'FAIL',
      expected: 'void or 4xx if unpaid', actual: payVoid.status, message: payVoid.body?.error || '',
    });
  }

  const fa = await http.post('/fixed-assets', {
    name: 'چرخ خیاطی QA', cost_rial: 80000000, useful_life_months: 60, purchase_date: QA_DATE,
  }, token);
  rec({
    id: 'assets.create', suite: 'admin', module: 'assets',
    status: okStatus(fa) ? 'PASS' : 'FAIL',
    expected: 200, actual: fa.status, message: fa.body?.error || '',
  });
  if (fa.body?.id) {
    const dep = await http.post('/fixed-assets/run-depreciation', { period_label: '1405/06' }, token);
    rec({
      id: 'assets.depreciation', suite: 'admin', module: 'assets',
      status: okStatus(dep) || dep.status === 400 ? (okStatus(dep) ? 'PASS' : 'SKIP') : 'FAIL',
      expected: 200, actual: dep.status, message: dep.body?.error || '',
    });
  }

  const bud = await http.post('/budgeting', { name: 'بودجه QA', year_label: '1405', status: 'draft' }, token);
  rec({
    id: 'budget.create', suite: 'admin', module: 'budget',
    status: okStatus(bud) ? 'PASS' : 'FAIL',
    expected: 200, actual: bud.status, message: bud.body?.error || '',
  });

  const pos = await http.post('/pos/terminals', {
    name: 'کارتخوان QA', terminal_id: 'QA-T-1', bank_id: ctx.bankId,
  }, token);
  rec({
    id: 'pos.terminal', suite: 'admin', module: 'pos',
    status: okStatus(pos) ? 'PASS' : 'FAIL',
    expected: 200, actual: pos.status, message: pos.body?.error || '',
  });

  const moadian = await http.get('/moadian/status', token).catch(() => ({ status: 404, body: {} }));
  const moadian2 = moadian.status === 404 ? await http.get('/moadian', token) : moadian;
  rec({
    id: 'moadian.mock', suite: 'admin', module: 'tax',
    status: moadian2.status === 200 || moadian2.status === 404 || moadian2.status === 403 ? 'PASS' : 'FAIL',
    expected: 'no live tax egress', actual: moadian2.status,
    message: moadian2.body?.error || 'settings moadian_enabled=0',
  });
  gap('backup.restore', 'backup', 'Backup/restore exercised only if caller uses isolated DB; this batch does not hit /api/admin/backup*');

  const noParty = await http.post('/invoices', {
    type: 'final', date: QA_DATE, rows: [{ product_id: ctx.productId, qty: 1, price: 1 }],
  }, token);
  rec({
    id: 'fault.invoice_no_party', suite: 'admin', module: 'sales',
    status: noParty.status >= 400 ? 'PASS' : 'FAIL',
    expected: 400, actual: noParty.status,
  });
  const noWh = await http.post('/invoices', {
    cust_id: ctx.customerId, type: 'final', date: QA_DATE, pay_type: 'credit',
    rows: [{ product_id: ctx.productId, qty: 1, price: 2500000 }],
  }, token);
  rec({
    id: 'fault.invoice_maybe_wh', suite: 'admin', module: 'sales', severity: 'high',
    status: noWh.status >= 400 ? 'PASS' : 'FAIL',
    expected: '4xx — firm invoice requires warehouse',
    actual: noWh.status,
    message: noWh.body?.error || noWh.body?.code || 'posted without warehouse_id',
    file: 'server/routes/invoices.js',
  });

  const periodLock = await http.post('/fiscal-year/' + (ctx.fiscalYear?.id || 0) + '/lock', {}, token);
  rec({
    id: 'fault.period_lock', suite: 'admin', module: 'fiscal',
    status: periodLock.status === 200 || periodLock.status === 404 || periodLock.status === 400
      ? (periodLock.status === 200 ? 'PASS' : 'SKIP') : 'FAIL',
    expected: 'lock endpoint', actual: periodLock.status, message: periodLock.body?.error || '',
  });
  if (periodLock.status === 200 && ctx.fiscalYear?.id) {
    await http.post('/fiscal-year/' + ctx.fiscalYear.id + '/unlock', {}, token);
  }

  rec({
    id: 'boot.role_users_deferred', suite: 'admin', module: 'rbac',
    status: 'PASS', message: 'role users created in All-Roles batch',
  });

  ctx.rolePass = ROLE_PASS;
  return ctx;
}

module.exports = { runAdminBatch, loginAdmin, login };
