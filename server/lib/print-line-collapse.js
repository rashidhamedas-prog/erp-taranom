/**
 * جمع‌کردن نمایشی ردیف‌های چاپ فاکتور (فروش و خرید).
 * دادهٔ ذخیره‌شده عوض نمی‌شود — فقط برای HTML چاپ.
 */
'use strict';

function lineGross(r) {
  return Math.round((Number(r.qty) || 0) * (Number(r.price) || 0));
}

function lineDiscOf(r) {
  const amt = Math.max(0, Math.round(Number(r.disc_amount) || 0));
  if (amt > 0) return amt;
  return Math.round((Number(r.qty) || 0) * (Number(r.price) || 0) * (Number(r.disc) || 0) / 100);
}

function lineNet(r) {
  const sum = Math.round(Number(r.sum) || 0);
  if (sum > 0) return sum;
  return Math.max(0, lineGross(r) - lineDiscOf(r));
}

function canCollapse(r) {
  if (!r) return false;
  if (r.row_type === 'income') return false;
  if (r.batch_id) return false;
  if (r.is_fabric_roll) return false;
  if (!r.variant_id) return false;
  return true;
}

function groupKey(r) {
  return [r.product_id, r.price, r.warehouse_id || 0, r.disc || 0, r.disc_amount || 0, r.unit || 'عدد'].join('|');
}

function qtyFa(q) {
  const n = Number(q);
  if (Number.isFinite(n)) return n.toLocaleString('fa-IR');
  return String(q == null ? '' : q);
}

function skuBit(r) {
  const color = String(r.color_name || r.color || '').trim();
  const size = String(r.size_name || '').trim();
  const label = [color, size].filter(Boolean).join(' ');
  const q = qtyFa(r.qty);
  if (!label) return q ? '×' + q : '';
  return label + '×' + q;
}

function compactSummary(members) {
  return members.map(skuBit).filter(Boolean).join('، ');
}

function uniqueNotes(members) {
  const seen = new Set();
  const notes = [];
  for (const r of members) {
    const d = String(r.description || '').trim();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    notes.push(d);
  }
  return notes;
}

function sharedDisc(members) {
  const first = Number(members[0].disc) || 0;
  for (let i = 1; i < members.length; i++) {
    if ((Number(members[i].disc) || 0) !== first) return 0;
  }
  return first;
}

function mergeGroup(members) {
  const first = members[0];
  const qty = members.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const sum = members.reduce((a, r) => a + lineNet(r), 0);
  const discAmount = members.reduce((a, r) => a + lineDiscOf(r), 0);
  let description = compactSummary(members);
  const notes = uniqueNotes(members);
  if (notes.length) {
    description = description ? description + ' — ' + notes.join('، ') : notes.join('، ');
  }
  const productCode = first.code || '';
  return Object.assign({}, first, {
    name: first.name || '',
    qty,
    price: first.price,
    sum,
    disc_amount: discAmount,
    disc: sharedDisc(members),
    unit: first.unit || 'عدد',
    code: productCode,
    sku: productCode,
    description,
  });
}

function truncateDesc(desc, max) {
  const s = String(desc || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function collapsePrintRows(rows, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const thermal = !!(opts && opts.thermal);
  const out = [];
  const seen = new Array(list.length).fill(false);

  for (let i = 0; i < list.length; i++) {
    if (seen[i]) continue;
    const r = list[i];
    if (!canCollapse(r)) {
      seen[i] = true;
      out.push(r);
      continue;
    }
    const key = groupKey(r);
    const members = [r];
    seen[i] = true;
    for (let j = i + 1; j < list.length; j++) {
      if (seen[j]) continue;
      const o = list[j];
      if (!canCollapse(o) || groupKey(o) !== key) continue;
      members.push(o);
      seen[j] = true;
    }
    out.push(mergeGroup(members));
  }

  if (!thermal) return out;
  return out.map((r) => {
    const d = String(r.description || '');
    if (d.length <= 70) return r;
    return Object.assign({}, r, { description: truncateDesc(d, 70) });
  });
}

module.exports = {
  collapsePrintRows,
  lineNet,
  lineDiscOf,
};
