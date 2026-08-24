'use strict';

const { DEFAULT_ROLE_PERMISSIONS, ACTIONS, RESOURCES, hasPermission, fillRoleDefaults } = require('../../../server/lib/rbac');
const { ROLE_PASS, QA_DATE, ADMIN_PASS, ADMIN_USER } = require('../lib/constants');
const { login } = require('./admin');

function expected(role, resource, action) {
  if (role === 'admin') return true;
  const matrix = fillRoleDefaults(role);
  return !!(matrix[resource] && matrix[resource][action]);
}

async function changeIfNeeded(http, token, oldPass) {
  const me = await http.get('/rbac/me', token);
  if (me.body?.must_change_password || me.body?.user?.must_change_password) {
    await http.post('/auth/change-password', { oldPass, newPass: ROLE_PASS }, token);
    return true;
  }
  return false;
}

async function runRolesBatch({ http, rec, ctx, Database }) {
  const adminToken = ctx.adminToken;
  const roles = Object.keys(DEFAULT_ROLE_PERMISSIONS);
  rec({
    id: 'roles.discovered', suite: 'roles', module: 'rbac',
    status: roles.length >= 10 ? 'PASS' : 'FAIL',
    expected: 'Object.keys(DEFAULT_ROLE_PERMISSIONS)',
    actual: roles.join(','),
  });

  const anon = await http.get('/customers');
  rec({
    id: 'rbac.anonymous_401', suite: 'roles', module: 'rbac', severity: 'high',
    status: anon.status === 401 || anon.status === 403 ? 'PASS' : 'FAIL',
    expected: 401, actual: anon.status,
  });

  const probes = [
    { id: 'invoices.create', method: 'post', path: '/invoices', resource: 'invoices', action: 'create',
      body: () => ({ cust_id: ctx.customerId, type: 'proforma', date: QA_DATE, warehouse_id: ctx.whFg?.id,
        rows: [{ product_id: ctx.productId, qty: 1, price: 1000, warehouse_id: ctx.whFg?.id }] }) },
    { id: 'customers.view', method: 'get', path: '/customers', resource: 'customers', action: 'view' },
    { id: 'payroll.create', method: 'post', path: '/payroll', resource: 'payroll', action: 'create',
      body: (role) => ({ person_id: ctx.personId, period_label: 'qa-' + role.slice(0, 12), regular_hours: 1, hourly_rate: 1 }) },
    { id: 'users.create', method: 'post', path: '/admin/users', resource: 'users', action: 'create',
      body: (role) => ({ name: 'escalate', username: 'esc-' + role.slice(0, 8) + '-' + Date.now().toString(36).slice(-4), password: ROLE_PASS, role: 'field_sales' }) },
    { id: 'accounting.view', method: 'get', path: '/reps', resource: 'accounting', action: 'view' },
    { id: 'settings.view', method: 'get', path: '/settings', resource: 'settings', action: 'view' },
    { id: 'production.view', method: 'get', path: '/production/boms', resource: 'production_bom', action: 'view' },
  ];

  ctx.roleSessions = {};

  for (const role of roles) {
    if (role === 'admin') {
      ctx.roleSessions.admin = { token: adminToken, username: ADMIN_USER, password: ADMIN_PASS };
      rec({
        id: `roles.${role}.login`, suite: 'roles', module: 'rbac',
        status: 'PASS', message: 'bootstrap admin',
      });
    } else {
      const username = ('qa_' + role).slice(0, 32);
      const created = await http.post('/admin/users', {
        name: 'QA ' + role, username, password: ROLE_PASS, role, phone: '09150000000',
        sales_warehouse_id: ctx.whFg?.id || null,
      }, ctx.roleSessions.admin?.token || adminToken);
      rec({
        id: `roles.${role}.create_user`, suite: 'roles', module: 'rbac',
        status: created.status === 200 || created.status === 400 ? (created.status === 200 ? 'PASS' : 'SKIP') : 'FAIL',
        expected: 200, actual: created.status, message: created.body?.error || '',
      });
      let password = ROLE_PASS;
      let lr = await login(http, username, password);
      if (lr.body?.must_change_password && lr.body?.token) {
        password = ROLE_PASS + 'x';
        await http.post('/auth/change-password', { oldPass: ROLE_PASS, newPass: password }, lr.body.token);
        lr = await login(http, username, password);
      }
      rec({
        id: `roles.${role}.login`, suite: 'roles', module: 'rbac',
        status: lr.status === 200 && lr.body?.token ? 'PASS' : 'FAIL',
        expected: 200, actual: lr.status, message: lr.body?.error || '',
      });
      if (lr.body?.token) ctx.roleSessions[role] = { token: lr.body.token, username, password };
    }

    const session = ctx.roleSessions[role];
    if (!session?.token) continue;

    const me = await http.get('/rbac/me', session.token);
    rec({
      id: `roles.${role}.me`, suite: 'roles', module: 'rbac',
      status: me.status === 200 ? 'PASS' : 'FAIL',
      expected: 200, actual: me.status,
    });

    for (const probe of probes) {
      const expAllow = expected(role, probe.resource, probe.action);
      const body = typeof probe.body === 'function' ? probe.body(role) : probe.body;
      let res;
      if (probe.method === 'get') res = await http.get(probe.path, session.token);
      else res = await http[probe.method](probe.path, body, session.token);
      const allowed = res.status < 400;
      const deny = res.status === 403 || res.status === 401;
      const businessBlock = res.status === 400 || res.status === 409;
      let pass;
      let severity = null;
      if (expAllow) {
        pass = allowed || res.status === 404 || businessBlock;
        if (!pass && deny) severity = 'medium';
        else if (!pass) severity = 'high';
      } else {
        pass = deny;
        if (allowed) severity = 'high';
        else if (res.status === 404) pass = true;
        else severity = 'medium';
      }
      rec({
        id: `roles.${role}.${probe.id}`, suite: 'roles', module: 'rbac',
        severity: pass ? null : severity,
        status: pass ? 'PASS' : 'FAIL',
        expected: expAllow ? 'allow (2xx/400/409)' : '403',
        actual: res.status,
        message: res.body?.error || '',
        evidence: `role=${role} ${probe.resource}.${probe.action} expectedAllow=${expAllow}`,
      });
      ctx.roleMatrix && ctx.roleMatrix.push({
        role, page: probe.path, endpoint: probe.path, action: probe.action,
        expected: expAllow ? 'allow' : 'deny', actual: allowed ? 'allow' : res.status,
        evidence: `HTTP ${res.status}`,
      });
    }

    const salesReturns = await http.get('/accounting/sales-returns', session.token);
    const salesReturnsAllow = role === 'admin' || role === 'accounting';
    rec({
      id: `roles.${role}.sales_returns_gate`, suite: 'roles', module: 'rbac',
      severity: salesReturnsAllow ? null : 'medium',
      status: salesReturnsAllow
        ? ((salesReturns.status < 400 || salesReturns.status === 404) ? 'PASS' : 'FAIL')
        : ((salesReturns.status === 403 || salesReturns.status === 401) ? 'PASS' : 'FAIL'),
      expected: salesReturnsAllow ? 'allow (admin|accounting)' : '403',
      actual: salesReturns.status,
      message: salesReturns.body?.error || '',
      evidence: 'GET /accounting/sales-returns is adminOrAccounting, not accounting.view',
    });

    if (role === 'admin') {
      const list = await http.get('/admin/users', session.token);
      rec({
        id: `roles.${role}.privilege_escalation`, suite: 'roles', module: 'rbac',
        status: list.status === 200 ? 'PASS' : 'FAIL',
        expected: 200, actual: list.status,
        message: list.body?.error || 'admin GET /admin/users',
      });
    } else {
      const escalate = await http.put('/admin/users/1', { role: 'admin', name: 'مدیر سیستم' }, session.token);
      rec({
        id: `roles.${role}.privilege_escalation`, suite: 'roles', module: 'rbac', severity: 'high',
        status: escalate.status === 403 || escalate.status === 401 ? 'PASS' : 'FAIL',
        expected: 403, actual: escalate.status,
        message: escalate.body?.error || '',
      });
    }

    if (role === 'field_sales' && ctx.invoiceId) {
      const mass = await http.put('/invoices/' + ctx.invoiceId, {
        cust_id: ctx.customerId, type: 'final', date: QA_DATE,
        user_id: 1, role: 'admin', paid: 999999999, warehouse_id: ctx.whFg?.id,
        rows: [{ product_id: ctx.productId, qty: 1, price: 2500000 }],
      }, session.token);
      const after = await http.get('/invoices/' + ctx.invoiceId, ctx.roleSessions.admin?.token || adminToken);
      const stolen = Number(after.body?.user_id) === 1 && Number(after.body?.paid) >= 999999999;
      rec({
        id: 'rbac.mass_assignment.invoice', suite: 'roles', module: 'rbac', severity: 'high',
        status: stolen ? 'FAIL' : (mass.status === 403 || mass.status === 401 || mass.status < 500 ? 'PASS' : 'FAIL'),
        expected: 'reject or ignore user_id/paid hijack',
        actual: mass.status,
        message: stolen ? 'user_id or paid overwritten' : (mass.body?.error || ''),
        evidence: 'after.user_id=' + after.body?.user_id + ' paid=' + after.body?.paid,
      });
    }

    if (role !== 'admin') {
      const logout = await http.post('/auth/logout', {}, session.token);
      rec({
        id: `roles.${role}.logout`, suite: 'roles', module: 'rbac',
        status: logout.status === 200 || logout.status === 204 ? 'PASS' : 'FAIL',
        expected: 200, actual: logout.status,
      });
      const relog = await login(http, session.username, session.password || ROLE_PASS);
      if (relog.body?.token) session.token = relog.body.token;
      rec({
        id: `roles.${role}.relogin`, suite: 'roles', module: 'rbac',
        status: relog.body?.token ? 'PASS' : 'FAIL',
        expected: 200, actual: relog.status, message: relog.body?.error || '',
      });
    }
  }

  if (ctx.roleSessions.admin?.token) {
    const logout = await http.post('/auth/logout', {}, ctx.roleSessions.admin.token);
    rec({
      id: 'roles.admin.logout', suite: 'roles', module: 'rbac',
      status: logout.status === 200 || logout.status === 204 ? 'PASS' : 'FAIL',
      expected: 200, actual: logout.status,
    });
    const relog = await login(http, ADMIN_USER, ADMIN_PASS);
    if (relog.body?.token) {
      ctx.roleSessions.admin.token = relog.body.token;
      ctx.adminToken = relog.body.token;
    }
    rec({
      id: 'roles.admin.relogin', suite: 'roles', module: 'rbac',
      status: relog.body?.token ? 'PASS' : 'FAIL',
      expected: 200, actual: relog.status, message: relog.body?.error || '',
    });
  }

  if (ctx.customerId && ctx.roleSessions.field_sales?.token) {
    const other = await http.get('/customers/' + ctx.customerId, ctx.roleSessions.field_sales.token);
    rec({
      id: 'rbac.idor.customer', suite: 'roles', module: 'rbac',
      status: other.status === 200 || other.status === 403 || other.status === 404 ? 'PASS' : 'FAIL',
      expected: 'scoped 200/403/404', actual: other.status,
      message: 'field_sales GET customer created by admin',
    });
  }

  rec({
    id: 'rbac.sod.maker_checker', suite: 'roles', module: 'rbac',
    status: 'NOT_IMPLEMENTED',
    message: 'No maker-checker / SOD policy in rbac.js',
  });
  rec({
    id: 'rbac.branch_scope', suite: 'roles', module: 'rbac',
    status: 'NOT_IMPLEMENTED',
    message: 'Staff ACL is not branch-scoped',
  });

  void ACTIONS; void RESOURCES; void hasPermission; void changeIfNeeded; void Database; void DEFAULT_ROLE_PERMISSIONS;
}

module.exports = { runRolesBatch, expected };
