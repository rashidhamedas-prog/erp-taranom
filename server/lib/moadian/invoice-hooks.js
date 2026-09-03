'use strict';

const { enqueueMoadian } = require('./queue');

function assertInvoiceEditableForMoadian(invoice) {
  if (!invoice) {
    const err = new Error('فاکتور یافت نشد');
    err.status = 404;
    throw err;
  }
  /* test_sent = sandbox experimental — still editable; only live stamp locks */
  const locked = invoice.moadian_status === 'sent' || invoice.moadian_status === 'accepted';
  if (locked) {
    const err = new Error('فاکتور ارسال‌شده به مودیان قابل ویرایش نیست — فقط سند اصلاحی/ابطالی');
    err.status = 422;
    err.code = 'MOADIAN_LOCKED';
    throw err;
  }
  return true;
}

function onFinalInvoiceEnqueue(db, invoiceId) {
  return enqueueMoadian(db, 'sales', invoiceId);
}

module.exports = {
  assertInvoiceEditableForMoadian,
  onFinalInvoiceEnqueue,
};
