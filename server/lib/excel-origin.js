/** Request-scoped flag: Excel import actions set from_excel on the body. */
let _excel = false;

function markFromRequest(req) {
  const b = req && req.body;
  _excel = !!(b && (b.from_excel === true || b.from_excel === 1 || b.from_excel === '1' || b.src_system === 'excel'));
}

function isExcelOrigin() {
  return _excel;
}

function clear() {
  _excel = false;
}

module.exports = { markFromRequest, isExcelOrigin, clear };
