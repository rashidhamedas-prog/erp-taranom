'use strict';

/** Pure decisions for fiscal-year activate / unlock / delete. */

function activateDecision(fy, body) {
  if (!fy) return { status: 404, error: 'سال مالی یافت نشد' };
  const unlock = !!(body && (body.unlock === true || body.unlock === 1 || body.unlock === '1'));
  if (fy.status === 'locked' && !unlock) {
    return {
      status: 409,
      error: 'سال قفل است. برای نوشتن، بازگشت قفل را صریح بفرستید',
      code: 'E_FY_LOCKED',
      mutate: false,
      data: { id: fy.id, status: 'locked' },
    };
  }
  return { ok: true, nextStatus: 'open', closeOtherOpens: true };
}

function deleteDecision({ fy, isCurrent, journalCount, yearCount }) {
  if (!fy) return { status: 404, error: 'سال مالی یافت نشد' };
  if (isCurrent) {
    return { status: 400, error: 'سال فعال قابل حذف نیست — ابتدا سال دیگری را فعال کنید' };
  }
  if ((journalCount || 0) > 0) {
    return {
      status: 409,
      error: 'سال دارای سند حذف نمی‌شود تا پیوند دفترکل نشکند. سال را قفل کنید',
      code: 'E_FY_HAS_JOURNALS',
      txn_count: journalCount,
    };
  }
  if ((yearCount || 0) <= 1) {
    return { status: 400, error: 'حداقل یک سال مالی باید باقی بماند' };
  }
  return { ok: true };
}

module.exports = { activateDecision, deleteDecision };
