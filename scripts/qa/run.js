'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { inventoryRepo } = require('./inventory');
const { runRecon } = require('./recon');
const { runAdminBatch } = require('./batches/admin');
const { runRolesBatch } = require('./batches/roles');
const { runE2E } = require('./batches/e2e');
const { runWrappedTests } = require('./batches/wrap-existing');
const { applyFailClosedEnv, HarnessError, looksProduction } = require('./lib/fail-closed');
const { makeArtifactDir, writeJson, appendLog, writeText, latestPointer } = require('./lib/artifacts');
const { toJunit } = require('./lib/junit');
const { createReporter } = require('./lib/reporter');
const { startQaServer } = require('./lib/server');
const { QA_JWT } = require('./lib/constants');

function parseArgs(argv) {
  const out = { mode: 'full', cleanupOnSuccess: false, resume: false, skipE2e: false, qaRunId: process.env.QA_RUN_ID };
  for (const a of argv.slice(2)) {
    if (a === '--cleanup-on-success') out.cleanupOnSuccess = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--skip-e2e') out.skipE2e = true;
    else if (a.startsWith('--mode=')) out.mode = a.slice(7);
    else if (a.startsWith('--qa-run-id=')) out.qaRunId = a.slice(12);
  }
  if (!out.qaRunId) {
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    out.qaRunId = 'qa-' + stamp + '-' + process.pid;
  }
  return out;
}

function summarize(rep, recon, qaRunId, extra) {
  const c = rep.counts();
  const lines = [
    `# QA ${qaRunId}`,
    '',
    `- mode: ${extra.mode}`,
    `- exit: ${rep.exitCode()}`,
    `- PASS ${c.PASS} · FAIL ${c.FAIL} · ERROR ${c.ERROR || 0} · NOT_IMPLEMENTED ${c.NOT_IMPLEMENTED} · BLOCKED ${c.BLOCKED} · SKIP ${c.SKIP}`,
    `- issues: ${rep.issues.length} (C/H: ${rep.issues.filter((i) => i.severity === 'critical' || i.severity === 'high').length})`,
    `- recon unbalanced JE: ${recon?.unbalanced ?? 'n/a'} · checks ${recon?.checks?.length ?? 0}`,
    `- DB: ${extra.dbPath}`,
    `- keep DB: ${extra.keepDb ? 'yes' : 'no'}`,
    '',
    '## Failures',
    ...(rep.issues.length ? rep.issues.slice(0, 30).map((i) => `- **${i.severity || 'medium'}** ${i.id}: ${i.message || i.expected} → ${i.actual}`) : ['- none']),
    '',
    '## Gaps',
    ...rep.gaps.slice(0, 40).map((g) => `- ${g.status} ${g.id}: ${g.message}`),
  ];
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(__dirname, '..', '..');
  process.env.NODE_ENV = 'test';
  process.env.QA_RUN_ID = args.qaRunId;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-qa-' + args.qaRunId + '-'));
  const dbPath = path.join(tmpRoot, 'crm.db');
  const companiesDir = path.join(tmpRoot, 'companies');
  const artifactDir = makeArtifactDir(repoRoot, args.qaRunId);

  const ctx = { repoRoot, qaRunId: args.qaRunId, roleMatrix: [] };
  const rep = createReporter();
  ctx.roleMatrix = rep.roleMatrix;

  let server;
  let exit = 2;
  try {
    applyFailClosedEnv({
      nodeEnv: 'test',
      qaRunId: args.qaRunId,
      dbPath,
      companiesDir,
      baseUrl: 'http://127.0.0.1:9',
    });
    process.env.JWT_SECRET = QA_JWT;
    process.env.DB_PATH = dbPath;
    process.env.COMPANIES_DIR = companiesDir;
    process.env.ERP_TEST_ISOLATION = '1';

    const guardOk = looksProduction('server/crm.db')
      && looksProduction('https://erp.poshaktaranom.com')
      && !looksProduction(dbPath);
    rep.rec({
      id: 'harness.fail_closed_guard', suite: 'harness', module: 'harness',
      status: guardOk ? 'PASS' : 'FAIL',
      expected: 'prod snippets rejected, tmp db accepted',
      actual: String(guardOk),
    });

    const inv = inventoryRepo(repoRoot);
    ctx.inventory = inv;
    writeJson(path.join(artifactDir, 'inventory.json'), inv);
    rep.rec({
      id: 'inventory.generated', suite: 'harness', module: 'inventory',
      status: inv.roles.length && inv.endpoints.length ? 'PASS' : 'FAIL',
      expected: 'roles+endpoints', actual: `${inv.roles.length} roles, ${inv.endpoints.length} endpoints, ${inv.tables.length} tables`,
    });
    for (const [k, missing] of Object.entries(inv.gaps || {})) {
      if (missing) rep.gap('gap.' + k, k, 'not found in repository evidence');
    }

    try {
      const { seedTaranom } = require('../../server/scripts/lib/seed-taranom');
      const seeded = seedTaranom(null);
      rep.rec({
        id: 'seed.module', suite: 'harness', status: seeded?.ok ? 'PASS' : 'SKIP',
        message: 'seedTaranom is a no-op; FY/COA/warehouses come from initDB on QA server boot',
      });
    } catch (e) {
      rep.rec({ id: 'seed.module', suite: 'harness', status: 'SKIP', message: e.message });
    }

    server = await startQaServer({
      repoRoot, dbPath, companiesDir, jwtSecret: QA_JWT,
      backupDir: path.join(tmpRoot, 'backups'),
    });
    applyFailClosedEnv({
      nodeEnv: 'test', qaRunId: args.qaRunId, dbPath, companiesDir, baseUrl: server.baseUrl,
    });
    appendLog(artifactDir, 'server.log', 'listening ' + server.baseUrl);

    if (args.mode === 'admin' || args.mode === 'full') {
      await runAdminBatch({ http: server.http, rec: rep.rec, gap: rep.gap, ctx });
    }
    if (args.mode === 'full') {
      await runWrappedTests({ repoRoot, rec: rep.rec, artifactDir });
    }
    if (args.mode === 'roles' || args.mode === 'full') {
      if (!ctx.adminToken) await runAdminBatch({ http: server.http, rec: rep.rec, gap: rep.gap, ctx });
      await runRolesBatch({ http: server.http, rec: rep.rec, ctx });
    }
    if (args.mode === 'full' && !args.skipE2e) {
      await runE2E({ repoRoot, baseUrl: server.baseUrl, rec: rep.rec, ctx, artifactDir, skip: false });
    } else if (args.skipE2e) {
      await runE2E({ repoRoot, baseUrl: server.baseUrl, rec: rep.rec, ctx, artifactDir, skip: true });
    }

    let recon = { checks: [], issues: [], unbalanced: 0 };
    try {
      const Database = require(path.join(repoRoot, 'server', 'node_modules', 'better-sqlite3'));
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      recon = runRecon(db);
      db.close();
      for (const ch of recon.checks) {
        rep.rec({
          id: 'recon.' + ch.id, suite: 'recon', module: 'accounting',
          status: ch.ok ? 'PASS' : 'FAIL',
          severity: ch.ok ? null : 'high',
          expected: ch.expected, actual: ch.actual, message: ch.extra,
        });
      }
    } catch (e) {
      rep.rec({ id: 'recon.open', suite: 'recon', module: 'accounting', status: 'FAIL', message: e.message });
    }
    writeJson(path.join(artifactDir, 'reconciliation.json'), recon);
    writeJson(path.join(artifactDir, 'issues.json'), { issues: rep.issues, gaps: rep.gaps, role_matrix: rep.roleMatrix });
    writeText(path.join(artifactDir, 'junit.xml'), toJunit(rep.cases, 'erp-qa'));
    const keepDb = args.cleanupOnSuccess && rep.exitCode() === 0 ? false : true;
    const summary = summarize(rep, recon, args.qaRunId, { mode: args.mode, dbPath, keepDb });
    writeText(path.join(artifactDir, 'summary.md'), summary);
    writeJson(path.join(artifactDir, 'meta.json'), {
      qa_run_id: args.qaRunId, mode: args.mode, dbPath, companiesDir, keepDb,
      port: server.port, counts: rep.counts(), exit: rep.exitCode(),
      skip_e2e: args.skipE2e, resume: args.resume,
    });
    if (!keepDb) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* keep */ }
    } else {
      writeJson(path.join(artifactDir, 'db-path.json'), { dbPath, tmpRoot });
    }
    exit = rep.exitCode();
    console.log('\n' + summary);
  } catch (e) {
    const harnessFail = e instanceof HarnessError;
    appendLog(artifactDir, 'fatal.log', (e && e.stack) || String(e));
    rep.rec({
      id: 'harness.fatal', suite: 'harness', module: 'harness', status: 'ERROR',
      severity: 'critical', message: e.message, evidence: String(e.stack || e),
    });
    writeJson(path.join(artifactDir, 'issues.json'), { issues: rep.issues, gaps: rep.gaps });
    writeText(path.join(artifactDir, 'summary.md'), `FATAL ${e.message}\nDB kept at ${dbPath}\n`);
    exit = harnessFail ? 2 : 2;
    console.error('QA harness fatal:', e.message);
  } finally {
    if (server) await server.stop().catch(() => {});
  }
  process.exit(exit);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(2); });
}

module.exports = { main, parseArgs, latestPointer };
