'use strict';

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toJunit(cases, suiteName) {
  const tests = cases.length;
  const failures = cases.filter((c) => c.status === 'FAIL').length;
  const skipped = cases.filter((c) => c.status === 'SKIP' || c.status === 'NOT_IMPLEMENTED' || c.status === 'BLOCKED').length;
  const errors = cases.filter((c) => c.status === 'ERROR').length;
  const suites = {};
  for (const c of cases) {
    const name = c.suite || suiteName || 'qa';
    if (!suites[name]) suites[name] = [];
    suites[name].push(c);
  }
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}">\n`;
  for (const [name, rows] of Object.entries(suites)) {
    const f = rows.filter((c) => c.status === 'FAIL').length;
    const e = rows.filter((c) => c.status === 'ERROR').length;
    const s = rows.filter((c) => c.status === 'SKIP' || c.status === 'NOT_IMPLEMENTED' || c.status === 'BLOCKED').length;
    xml += `  <testsuite name="${xmlEscape(name)}" tests="${rows.length}" failures="${f}" errors="${e}" skipped="${s}">\n`;
    for (const c of rows) {
      xml += `    <testcase classname="${xmlEscape(c.suite || name)}" name="${xmlEscape(c.id || c.name)}" time="${Number(c.ms || 0) / 1000}">\n`;
      if (c.status === 'FAIL') {
        xml += `      <failure message="${xmlEscape(c.message || 'failed')}">${xmlEscape(c.evidence || c.message || '')}</failure>\n`;
      } else if (c.status === 'ERROR') {
        xml += `      <error message="${xmlEscape(c.message || 'error')}">${xmlEscape(c.evidence || '')}</error>\n`;
      } else if (c.status === 'SKIP' || c.status === 'NOT_IMPLEMENTED' || c.status === 'BLOCKED') {
        xml += `      <skipped message="${xmlEscape(c.status + ': ' + (c.message || ''))}"/>\n`;
      }
      xml += '    </testcase>\n';
    }
    xml += '  </testsuite>\n';
  }
  xml += '</testsuites>\n';
  return xml;
}

module.exports = { toJunit };
