/**
 * Strip legacy import field names from API JSON — expose neutral aliases only.
 */
const FIELD_MAP = [
  ['mahak_doc_no', 'ref_doc_no'],
  ['mahak_doc_type', 'ref_doc_type'],
  ['mahak_invoice_code', 'ref_invoice_code'],
  ['mahak_receipt_code', 'ref_receipt_code'],
  ['mahak_op_code', 'op_code'],
];

function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/Mahak/gi, '')
    .replace(/محک/g, 'سیستم قبلی')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeValue(val, depth = 0) {
  if (depth > 14) return val;
  if (Array.isArray(val)) return val.map(v => sanitizeValue(v, depth + 1));
  if (val && typeof val === 'object') {
    const o = { ...val };
    for (const [from, to] of FIELD_MAP) {
      if (o[from] != null && o[to] == null) o[to] = o[from];
      delete o[from];
    }
    if (o.coa_mode === 'mahak') o.coa_mode = 'extended';
    for (const k of Object.keys(o)) {
      o[k] = sanitizeValue(o[k], depth + 1);
    }
    return o;
  }
  if (typeof val === 'string') return scrubString(val);
  return val;
}

function refDocResponseMiddleware(req, res, next) {
  const orig = res.json.bind(res);
  res.json = (body) => orig(sanitizeValue(body));
  next();
}

module.exports = { sanitizeValue, refDocResponseMiddleware, scrubString };
