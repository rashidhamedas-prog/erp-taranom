'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_ROLE_PERMISSIONS, ACTIONS, RESOURCES } = require('../../server/lib/rbac');

function walk(dir, acc, filter) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === 'artifacts') continue;
      walk(p, acc, filter);
    } else if (!filter || filter(p, name)) acc.push(p);
  }
  return acc;
}

function inventoryRepo(repoRoot) {
  const routesDir = path.join(repoRoot, 'server', 'routes');
  const routeFiles = walk(routesDir, [], (p, n) => n.endsWith('.js'));
  const endpoints = [];
  const methodRe = /router\.(get|post|put|patch|delete)\(\s*['`]([^'`]+)['`]/g;
  for (const file of routeFiles) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    while ((m = methodRe.exec(src))) {
      endpoints.push({ method: m[1].toUpperCase(), path: m[2], file: rel });
    }
  }

  const serverJs = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const mounts = [];
  const mountRe = /app\.use\(\s*['`](\/api\/[^'`]+)['`]/g;
  let mm;
  while ((mm = mountRe.exec(serverJs))) mounts.push(mm[1]);

  const appJs = fs.readFileSync(path.join(repoRoot, 'server', 'public', 'app.js'), 'utf8');
  function extractNav(name) {
    const re = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`);
    const m = appJs.match(re);
    if (!m) return [];
    const ids = [];
    const idRe = /id:'([^']+)'/g;
    let x;
    while ((x = idRe.exec(m[1]))) ids.push(x[1]);
    return ids;
  }
  const nav = {
    admin: extractNav('NAV_ADMIN'),
    sales: extractNav('NAV_SALES'),
    accounting: extractNav('NAV_ACCOUNTING'),
  };

  const accNavPath = path.join(repoRoot, 'server', 'public', 'acc-nav.js');
  const accNavSrc = fs.readFileSync(accNavPath, 'utf8');
  const accPages = [];
  const accIdRe = /id:\s*'([^']+)'/g;
  let a;
  while ((a = accIdRe.exec(accNavSrc))) {
    if (a[1].startsWith('acc-')) accPages.push(a[1]);
  }

  const pickers = [];
  if (appJs.includes('function custSelect')) pickers.push({ name: 'custSelect', searchable: true });
  if (appJs.includes('function supplierSelect')) pickers.push({ name: 'supplierSelect', searchable: true });
  if (appJs.includes('acctSearchHtml')) pickers.push({ name: 'acctSearchHtml', searchable: true });
  if (appJs.includes('invProdSearch')) pickers.push({ name: 'invProdSearch', searchable: true });
  const freeTextParty = [];
  if (appJs.includes('id="cs-party"') || appJs.includes("id='cs-party'")) freeTextParty.push('consignments#cs-party');
  if (appJs.includes('id="tc-party"')) freeTextParty.push('trust-checks#tc-party');
  if (appJs.includes('id="oc-party"')) freeTextParty.push('opening-cheques#oc-party');

  const settingsSrc = fs.readFileSync(path.join(repoRoot, 'server', 'routes', 'settings.js'), 'utf8');
  const modules = [...settingsSrc.matchAll(/'(module_[a-z_]+)'/g)].map((x) => x[1]);
  const uniqueModules = [...new Set(modules)];

  const tables = [];
  for (const file of [
    path.join(repoRoot, 'server', 'db.js'),
    path.join(repoRoot, 'server', 'lib', 'production', 'schema.js'),
  ]) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const tre = /CREATE TABLE IF NOT EXISTS\s+(\w+)/gi;
    let t;
    while ((t = tre.exec(src))) tables.push(t[1]);
  }

  const tests = walk(path.join(repoRoot, 'server', 'scripts'), [], (p, n) => n.startsWith('test-') && n.endsWith('.js'))
    .map((p) => path.relative(repoRoot, p).replace(/\\/g, '/'));
  const e2e = walk(path.join(repoRoot, 'e2e'), [], (p, n) => n.endsWith('.spec.js'))
    .map((p) => path.relative(repoRoot, p).replace(/\\/g, '/'));

  const srcAll = appJs + accNavSrc + serverJs;
  const gaps = {
    rfq: !/rfq/i.test(srcAll + routeFiles.map((f) => fs.readFileSync(f, 'utf8').slice(0, 200)).join('')),
    three_way_match: !/3[\s-]?way|three.?way/i.test(srcAll),
    tracking_profile_roll: !/tracking_profile/.test(srcAll),
    coa_grni: !/coa_grni|GRNI/.test(fs.readFileSync(path.join(repoRoot, 'server', 'lib', 'coa-map.js'), 'utf8')),
    sod_maker_checker: !/segregation|maker.?checker|sod_/i.test(srcAll),
    branch_acl: !/branch_id/.test(fs.readFileSync(path.join(repoRoot, 'server', 'lib', 'rbac.js'), 'utf8')),
  };
  // more precise rfq scan
  let hasRfq = false;
  for (const file of routeFiles) {
    if (/rfq/i.test(fs.readFileSync(file, 'utf8'))) { hasRfq = true; break; }
  }
  gaps.rfq = !hasRfq;

  return {
    generated_at: new Date().toISOString(),
    roles: Object.keys(DEFAULT_ROLE_PERMISSIONS),
    actions: ACTIONS,
    resources: RESOURCES,
    route_files: routeFiles.length,
    mounts,
    endpoints,
    nav,
    acc_pages: [...new Set(accPages)],
    pickers,
    free_text_party: freeTextParty,
    modules: uniqueModules,
    tables: [...new Set(tables)],
    tests,
    e2e,
    gaps,
  };
}

module.exports = { inventoryRepo };
