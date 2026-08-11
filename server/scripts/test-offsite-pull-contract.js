'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const pullScript = path.join(root, 'scripts', 'pull-offsite-backup.ps1');
const installScript = path.join(root, 'scripts', 'install-offsite-backup-task.ps1');
const drillScript = path.join(root, 'scripts', 'run-offsite-restore-drill.ps1');
const uploader = path.join(root, 'scripts', '_deploy-rc-chunked-sftp.py');
let passed = 0;

function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log('  ✅', message);
}

for (const file of [pullScript, installScript, drillScript, uploader]) {
  ok(fs.existsSync(file), `${path.basename(file)} exists`);
}

const pull = fs.readFileSync(pullScript, 'utf8');
const install = fs.readFileSync(installScript, 'utf8');
const drill = fs.readFileSync(drillScript, 'utf8');
const upload = fs.readFileSync(uploader, 'utf8');

ok(/StrictHostKeyChecking=yes/.test(pull), 'pull pins SSH host keys and fails closed');
ok(/'-O'/.test(pull), 'pull forces legacy SCP for the audited read-only wrapper protocol');
ok(/sidecar-before/.test(pull) && /sidecar-after/.test(pull), 'pull checks sidecar before and after transfer');
ok(/Get-FileHash[\s\S]*SHA256/.test(pull), 'pull verifies archive SHA-256');
ok(/FileShare\]::None/.test(pull), 'pull uses an exclusive single-instance lock');
ok(/MultipleInstances IgnoreNew/.test(install) && /RunLevel Limited/.test(install) && /LogonType S4U/.test(install), 'task is limited, logged-out capable, and rejects overlap');
ok(!/BACKUP_(?:PASSWORD|ENCRYPTION_KEY)[^\r\n]*Argument/i.test(install), 'scheduled pull does not carry backup secrets');
ok(/SecureStringToBSTR/.test(drill) && /ZeroFreeBSTR/.test(drill), 'drill handles DPAPI secret without command-line exposure');
ok(!/AutoAddPolicy/.test(upload) && /StrictHostKeyChecking=yes/.test(upload), 'uploader rejects unknown host keys');
ok(/reput/.test(upload) && /\.part\.\{self\.sha256\.lower\(\)\}/.test(upload), 'uploader resumes to digest-scoped stage files');
ok(upload.indexOf('sha256sum --') < upload.indexOf('mv -f --'), 'uploader verifies staged hash before atomic promotion');
ok(/recover-stale-lock-minutes/.test(upload) && /corrupt full-size stage/.test(upload), 'uploader has explicit stale-lock recovery and corrupt-stage reset');
ok(/sha512_file/.test(upload) && /latest\.yml metadata do not match/.test(upload), 'uploader binds EXE SHA-512 to latest.yml');
ok(/rollback incomplete/.test(upload) && /alias HTTP SHA-256 mismatch/.test(upload), 'uploader uses best-effort rollback and HTTP-verifies aliases');

if (process.platform === 'win32') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-offsite-pull-test-'));
  const mockDir = path.join(temp, 'mocks');
  fs.mkdirSync(mockDir, { recursive: true });
  const fileName = 'crm-backup-20260808-120000.zip.enc';
  const archive = Buffer.from('TRNMBKP1-test-encrypted-payload-for-transfer-contract');
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  fs.writeFileSync(path.join(mockDir, 'archive.bin'), archive);
  fs.writeFileSync(path.join(mockDir, 'sidecar.txt'), `${digest}  ${fileName}\n`);
  const key = path.join(temp, 'id_test');
  const knownHosts = path.join(temp, 'known_hosts');
  fs.writeFileSync(key, 'not-used-by-mocks');
  fs.writeFileSync(knownHosts, 'pinned-test-host');

  const writeMock = (name, source) => {
    const target = path.join(mockDir, `${name}.ps1`);
    fs.writeFileSync(target, source);
    return target;
  };
  const mockKeygen = writeMock('mock-keygen', `
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$AllArgs)
if ($env:MOCK_HOST_UNKNOWN -eq '1') { $global:LASTEXITCODE=1; return }
$global:LASTEXITCODE=0
Write-Output '94.249.244.208 ssh-ed25519 pinned-test-key'
  `);
  const mockSsh = writeMock('mock-ssh', `
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$AllArgs)
$global:LASTEXITCODE=0
if ($env:MOCK_SELECTION) { Write-Output $env:MOCK_SELECTION }
else { Write-Output '${fileName}' }
  `);
  const mockScp = writeMock('mock-scp', `
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$AllArgs)
$global:LASTEXITCODE=0
$src=$AllArgs[$AllArgs.Count-2]; $dst=$AllArgs[$AllArgs.Count-1]; $root=$env:MOCK_ROOT
if ($src.EndsWith('.sha256')) {
  $counter=Join-Path $root 'side-count'; $n=0
  if (Test-Path -LiteralPath $counter) { $n=[int](Get-Content -LiteralPath $counter -Raw) }
  $n++; [IO.File]::WriteAllText($counter,[string]$n)
  $text=[IO.File]::ReadAllText((Join-Path $root 'sidecar.txt'))
  if ($env:MOCK_MUTATE_SIDECAR -eq '1' -and $n -ge 2) { $text=('0'*64)+'  ${fileName}'+[Environment]::NewLine }
  [IO.File]::WriteAllText($dst,$text); return
}
$data=[IO.File]::ReadAllBytes((Join-Path $root 'archive.bin'))
if ($env:MOCK_CORRUPT_ARCHIVE -eq '1') { $data[$data.Length-1]=$data[$data.Length-1] -bxor 255 }
[IO.File]::WriteAllBytes($dst,$data)
  `);

  function runPull(destination, extraEnv = {}, extraArgs = []) {
    fs.rmSync(path.join(mockDir, 'side-count'), { force: true });
    return spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', pullScript,
      '-Destination', destination,
      '-IdentityFile', key,
      '-KnownHostsFile', knownHosts,
      '-SshPath', mockSsh,
      '-ScpPath', mockScp,
      '-SshKeygenPath', mockKeygen,
      ...extraArgs,
    ], {
      encoding: 'utf8',
      env: { ...process.env, MOCK_ROOT: mockDir, ...extraEnv },
      timeout: 30000,
    });
  }

  const goodDest = path.join(temp, 'good');
  let run = runPull(goodDest);
  ok(run.status === 0, `mock pull succeeds: ${run.stderr || run.stdout}`);
  ok(fs.existsSync(path.join(goodDest, fileName)), 'verified archive is promoted');
  ok(JSON.parse(fs.readFileSync(path.join(goodDest, 'last-success.json'), 'utf8')).sha256 === digest.toUpperCase(), 'receipt records exact digest');

  run = runPull(goodDest);
  ok(run.status === 0 && /"downloaded":\s*false/i.test(run.stdout), 'second pull is idempotent');

  const unknownDest = path.join(temp, 'unknown-host');
  run = runPull(unknownDest, { MOCK_HOST_UNKNOWN: '1' });
  ok(run.status !== 0 && !fs.existsSync(path.join(unknownDest, fileName)), 'unknown host key fails before promotion');

  const traversalDest = path.join(temp, 'traversal');
  run = runPull(traversalDest, { MOCK_SELECTION: '../evil.zip.enc|10' });
  ok(run.status !== 0 && !fs.existsSync(path.join(traversalDest, fileName)), 'unsafe remote filename is rejected');

  const mutateDest = path.join(temp, 'mutated');
  run = runPull(mutateDest, { MOCK_MUTATE_SIDECAR: '1' });
  ok(run.status !== 0 && !fs.existsSync(path.join(mutateDest, fileName)), 'sidecar TOCTOU change blocks promotion');

  const corruptDest = path.join(temp, 'corrupt');
  run = runPull(corruptDest, { MOCK_CORRUPT_ARCHIVE: '1' });
  ok(run.status !== 0 && !fs.existsSync(path.join(corruptDest, fileName)), 'archive hash mismatch blocks promotion');
  fs.rmSync(temp, { recursive: true, force: true });
} else {
  console.log('  ℹ️ Windows behavioral transport tests skipped on non-Windows runner');
}

console.log(`offsite pull contract: ${passed}/${passed} pass`);
