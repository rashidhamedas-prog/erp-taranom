'use strict';

function createReporter() {
  const cases = [];
  const issues = [];
  const gaps = [];
  const roleMatrix = [];

  function rec(partial) {
    const row = {
      id: partial.id,
      suite: partial.suite || 'qa',
      name: partial.name || partial.id,
      status: partial.status,
      severity: partial.severity || null,
      module: partial.module || partial.suite,
      expected: partial.expected,
      actual: partial.actual,
      message: partial.message || '',
      evidence: partial.evidence || '',
      file: partial.file || '',
      ms: partial.ms || 0,
    };
    cases.push(row);
    if (row.status === 'NOT_IMPLEMENTED' || row.status === 'BLOCKED') {
      gaps.push(row);
    }
    if (row.status === 'FAIL' || row.status === 'ERROR') {
      issues.push({
        id: row.id,
        severity: row.severity || 'medium',
        module: row.module,
        file: row.file,
        reproduction: row.id,
        expected: row.expected,
        actual: row.actual,
        evidence: row.evidence,
        message: row.message,
      });
    }
    const icon = row.status === 'PASS' ? 'OK' : row.status;
    console.log(`  [${icon}] ${row.suite}/${row.id} ${row.message || ''}`.trim());
    return row;
  }

  function gap(id, module, reason) {
    return rec({
      id, suite: 'gap', module, status: 'NOT_IMPLEMENTED',
      message: reason, evidence: reason,
    });
  }

  function blocked(id, module, reason) {
    return rec({
      id, suite: 'gap', module, status: 'BLOCKED',
      message: reason, evidence: reason,
    });
  }

  function counts() {
    const c = { PASS: 0, FAIL: 0, ERROR: 0, SKIP: 0, NOT_IMPLEMENTED: 0, BLOCKED: 0 };
    for (const row of cases) c[row.status] = (c[row.status] || 0) + 1;
    return c;
  }

  function exitCode() {
    const harness = cases.filter((c) => c.status === 'ERROR' && c.suite === 'harness');
    if (harness.length) return 2;
    const sec = issues.filter((i) => {
      if (i.severity === 'critical') return true;
      const id = String(i.id);
      if (id.includes('privilege_escalation') || id.includes('anonymous') || id.includes('idor') || id.includes('mass_assignment')) return true;
      if ((i.module === 'rbac' || i.module === 'roles' || id.startsWith('rbac.') || id.startsWith('roles.')) && i.severity === 'high') return true;
      return false;
    });
    if (sec.length) return 3;
    if (issues.length) return 1;
    return 0;
  }

  return { cases, issues, gaps, roleMatrix, rec, gap, blocked, counts, exitCode };
}

module.exports = { createReporter };
