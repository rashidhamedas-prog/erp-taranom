'use strict';
/** Export helpers — E_EXPORT_TOO_LARGE, xlsx buffer, cost-sheet PDF HTML */
const { ok, throws, summary } = require('./lib/test-harness');
const { toExcel, toPdf, EXPORT_ROW_LIMIT } = require('../lib/production/report-export');

(async () => {
  console.log('\n══ Production Export Tests ══\n');

  ok('EXPORT_ROW_LIMIT is 60000', EXPORT_ROW_LIMIT === 60000);

  try {
    await toExcel({
      report: 'PR-01',
      data: { rows: new Array(EXPORT_ROW_LIMIT + 1).fill({ a: 1 }) },
    });
    ok('E_EXPORT_TOO_LARGE on huge rows', false, 'خطایی رخ نداد');
  } catch (e) {
    ok('E_EXPORT_TOO_LARGE on huge rows', String(e.code || e.message).includes('E_EXPORT_TOO_LARGE'),
      `انتظار E_EXPORT_TOO_LARGE · دریافت ${e.code || e.message}`);
  }

  const small = await toExcel({
    report: 'PR-01',
    title: 'Test',
    data: { rows: [{ order_no: 'PO-1', qty: 10 }, { order_no: 'PO-2', qty: 20 }] },
  });
  ok('toExcel small report → xlsx buffer', small.format === 'xlsx'
    && Buffer.isBuffer(small.buffer)
    && small.buffer.length > 100);

  const costPdf = toPdf({
    report: 'PR-02',
    title: 'برگه بهای تمام‌شده',
    data: {
      summary: {
        order_no: 'PO-TEST',
        product_name: 'مانتو',
        period_label: '1405/04',
        qty_planned: 300,
        qty_produced: 294,
        yield_pct: 98,
        material_cost_rial: 300_000_000,
        labor_cost_rial: 200_000_000,
        overhead_cost_rial: 150_000_000,
        packaging_cost_rial: 0,
        subcontract_cost_rial: 0,
        total_cost_rial: 650_000_000,
        unit_cost_rial: 2_210_884,
      },
      stages: [{ seq: 1, cc_code: 'CC1', cc_name: 'برش', qty_in: 300, qty_out: 294 }],
    },
  });
  ok('toPdf cost sheet has HTML', typeof costPdf.html === 'string' && costPdf.html.includes('برگه'));

  summary();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
