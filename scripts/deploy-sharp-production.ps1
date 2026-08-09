#Requires -Version 5.1
<#
.SYNOPSIS
  Safely deploy source-pinned sharp@0.35.0 to Iran VPS without blind git pull/reset.

.DESCRIPTION
  Builds a Linux x64 offline sharp bundle on Windows (via system proxy), uploads over SFTP,
  backs up the live sharp module + package files, swaps modules with bounded verification,
  restarts PM2 without --update-env, and supports rollback to the stamped recover directory.

  Modes:
    -InventoryOnly   read-only production inventory
    -PrepareBundle   build offline Linux x64 tarball only
    -Deploy          inventory + prepare (if needed) + install + verify + restart + smoke
    -Rollback        restore last stamped recover dir (or -RecoverStamp)
#>
[CmdletBinding(DefaultParameterSetName = 'Deploy')]
param(
    [Parameter(ParameterSetName = 'Inventory')]
    [switch]$InventoryOnly,

    [Parameter(ParameterSetName = 'Prepare')]
    [switch]$PrepareBundle,

    [Parameter(ParameterSetName = 'Deploy')]
    [switch]$Deploy,

    [Parameter(ParameterSetName = 'Rollback')]
    [switch]$Rollback,

    [string]$ServerHost = '94.249.244.208',
    [string]$UserName = 'taranom',
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\id_ed25519_taranom'),
    [string]$AppRoot = '/home/taranom/crm-taranom',
    [string]$TargetVersion = '0.35.0',
    [string]$RollbackVersion = '0.33.5',
    [ValidateRange(30, 900)]
    [int]$InstallTimeoutSec = 180,
    [ValidateRange(5, 120)]
    [int]$ConnectTimeoutSec = 45,
    [string]$BundleDir = '',
    [string]$RecoverStamp = '',
    [string]$HttpProxy = 'http://127.0.0.1:10808',
    [string]$PublicBaseUrl = 'https://erp.taranom.app'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $BundleDir) {
    $BundleDir = Join-Path $RepoRoot 'artifacts\sharp-linux-x64-bundle'
}
$BundleTar = Join-Path $BundleDir ("sharp-{0}-linux-x64.tgz" -f $TargetVersion)

function Assert-Prereqs {
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        throw "SSH identity not found: $IdentityFile"
    }
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        throw 'python is required (paramiko).'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue) -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm is required to build the offline Linux bundle.'
    }
    $probe = & python -c "import paramiko; print(paramiko.__version__)"
    if ($LASTEXITCODE -ne 0) { throw 'paramiko is not importable in python.' }
    Write-Host "paramiko=$probe"
}

function Get-RemoteHelperPath {
    $dir = Join-Path $env:TEMP 'erp-taranom-w0-ops-002'
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    return (Join-Path $dir 'deploy_sharp_remote.py')
}

function Write-RemoteHelper {
    $path = Get-RemoteHelperPath
    $helper = @'
import json, os, sys, time, hashlib
import paramiko
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

cfg = json.loads(sys.stdin.read())
HOST = cfg["host"]; USER = cfg["user"]; KEY = cfg["key"]; APP = cfg["app"]
MODE = cfg["mode"]; TARGET = cfg["target"]
TIMEOUT = int(cfg["install_timeout"]); CT = int(cfg["connect_timeout"])
BUNDLE = cfg.get("bundle_tar") or ""; STAMP = (cfg.get("recover_stamp") or "").strip()


def connect():
    pkey = paramiko.Ed25519Key.from_private_key_file(KEY)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=CT, allow_agent=False, look_for_keys=False)
    return c


def run(c, cmd, timeout=120):
    print("==>", cmd[:240] + ("..." if len(cmd) > 240 else ""))
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + ("\n" + err if err.strip() else "")).strip()
    if text:
        chunk = text[-8000:] if len(text) > 8000 else text
        try:
            print(chunk)
        except UnicodeEncodeError:
            print(chunk.encode("utf-8", "replace").decode("ascii", "replace"))
    print("EXIT", code)
    return code, text


def run_bash(c, script, timeout=120):
    import base64
    b64 = base64.b64encode(script.encode("utf-8")).decode("ascii")
    cmd = "printf %s " + json.dumps(b64) + " | base64 -d | bash"
    return run(c, cmd, timeout=timeout)


def assert_x86_64_v2(c):
    """sharp>=0.34 linux-x64 prebuilds require x86-64-v2 (SSE4.2)."""
    script = """
set -e
FLAGS=$(grep -m1 '^flags' /proc/cpuinfo || true)
missing=""
for f in cx16 lahf_lm popcnt sse4_1 sse4_2 ssse3; do
  if ! echo "$FLAGS" | grep -qw "$f"; then missing="$missing $f"; fi
done
echo CPU_MODEL=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)
if [ -n "$missing" ]; then
  echo CPU_X86_64_V2=no
  echo CPU_MISSING_FLAGS:$missing
  exit 42
fi
echo CPU_X86_64_V2=yes
"""
    code, text = run_bash(c, script, timeout=30)
    if code == 42 or "CPU_X86_64_V2=no" in text:
        raise SystemExit(
            "BLOCKED: VPS CPU lacks x86-64-v2 flags required by sharp "
            + TARGET
            + " linux-x64 prebuilds (and wasm needs SSE4.1). "
            + "Upgrade hypervisor CPU type (e.g. x86-64-v2/host) before deploy. "
            + text.replace("\n", " | ")
        )
    if code != 0:
        raise SystemExit(f"CPU preflight failed exit={code}")
    print("CPU_PREFLIGHT_OK")


def inventory(c):
    script = f"""
set -e
cd {APP}
echo HOST_ARCH=$(uname -m)
echo NODE=$(node -v)
echo UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo GIT_HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo UNKNOWN)
echo '---STATUS_SB---'
git status -sb | head -20
echo '---PORCELAIN---'
git status --porcelain | head -80
echo '---PKG_SHARP---'
node -p "require('./server/package.json').dependencies.sharp"
echo '---RUNTIME_SHARP---'
node -e "const fs=require('fs');const p='./server/node_modules/sharp/package.json'; if(!fs.existsSync(p)){{console.log('MISSING'); process.exit(2)}}; console.log(require(p).version); require('./server/node_modules/sharp'); console.log('REQUIRE_OK')"
echo '---RECOVER---'
ls -1 server/_recover 2>/dev/null | tail -20 || echo NO_RECOVER
echo '---PM2---'
pm2 describe erp-taranom | sed -n '1,35p'
echo '---ENV_NAMES---'
pm2 show erp-taranom | grep -E 'BACKUP_|DATA_ENC|ENCRYPTION|JWT_SECRET|SYNC_' | sed 's/=.*/=<redacted>/' | head -40 || true
echo '---HTTP---'
curl -s -o /dev/null -w 'root=%{{http_code}}\\n' http://127.0.0.1:3000/
curl -s -o /dev/null -w 'health=%{{http_code}}\\n' http://127.0.0.1:3000/api/system/health || true
echo '---REGISTRY---'
getent hosts registry.npmjs.org || echo DNS_FAIL_registry
timeout 6 curl -sI https://registry.npmjs.org/sharp | head -3 || echo HTTPS_FAIL_registry
"""
    return run_bash(c, script, timeout=90)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def upload_bundle(c, local_tar):
    remote_dir = f"{APP}/server/_recover/bundles"
    remote_tar = f"{remote_dir}/sharp-{TARGET}-linux-x64.tgz"
    run(c, f"mkdir -p {remote_dir}", timeout=30)
    sftp = c.open_sftp()
    print("PUT", local_tar, "->", remote_tar, "sha256", sha256_file(local_tar))
    sftp.put(local_tar, remote_tar)
    sftp.close()
    return remote_tar


def backup_live(c):
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    dest = f"{APP}/server/_recover/sharp-{stamp}"
    cmd = f"""
set -e
DEST="{dest}"
mkdir -p "$DEST"
cp -a {APP}/server/package.json "$DEST/package.json"
cp -a {APP}/server/package-lock.json "$DEST/package-lock.json" 2>/dev/null || true
if [ -d {APP}/server/node_modules/sharp ]; then cp -a {APP}/server/node_modules/sharp "$DEST/sharp"; fi
if [ -d {APP}/server/node_modules/@img ]; then cp -a {APP}/server/node_modules/@img "$DEST/img"; fi
if [ -d {APP}/server/_recover/sharp-20260808T160047Z ]; then
  echo PREV_RECOVER=sharp-20260808T160047Z > "$DEST/PREV_RECOVER.txt"
fi
node -p "require('{APP}/server/node_modules/sharp/package.json').version" > "$DEST/BEFORE_VERSION.txt" || echo MISSING > "$DEST/BEFORE_VERSION.txt"
echo "$DEST"
"""
    code, text = run_bash(c, cmd, timeout=120)
    if code != 0:
        raise SystemExit(f"backup_live failed exit={code}")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith(f"{APP}/server/_recover/sharp-")]
    if not lines:
        for ln in reversed(text.splitlines()):
            if "/_recover/sharp-" in ln:
                lines = [ln.strip()]
                break
    if not lines:
        raise SystemExit("could not determine recover stamp path")
    print("RECOVER_DIR", lines[-1])
    return lines[-1], stamp


def apply_bundle(c, remote_tar, recover_dir):
    cmd = f"""
set -e
cd {APP}/server
STAGE=$(mktemp -d /tmp/sharp-stage-XXXXXX)
tar -xzf "{remote_tar}" -C "$STAGE"
test -d "$STAGE/sharp"
test -f "$STAGE/sharp/package.json"
STAGE_VER=$(node -p "require('$STAGE/sharp/package.json').version")
test "$STAGE_VER" = "{TARGET}"
test -d "$STAGE/detect-libc"
test -d "$STAGE/semver"
test -d "$STAGE/@img"
rm -rf node_modules/sharp.__old node_modules/@img.__old node_modules/detect-libc.__old node_modules/semver.__old
if [ -d node_modules/sharp ]; then mv node_modules/sharp node_modules/sharp.__old; fi
if [ -d node_modules/@img ]; then mv node_modules/@img node_modules/@img.__old; fi
if [ -d node_modules/detect-libc ]; then mv node_modules/detect-libc node_modules/detect-libc.__old; fi
if [ -d node_modules/semver ]; then mv node_modules/semver node_modules/semver.__old; fi
mkdir -p node_modules
mv "$STAGE/sharp" node_modules/sharp
mv "$STAGE/detect-libc" node_modules/detect-libc
mv "$STAGE/semver" node_modules/semver
mv "$STAGE/@img" node_modules/@img
node -e "const v=require('./node_modules/sharp/package.json').version; if(v!=='{TARGET}') process.exit(4); require('sharp'); console.log('POST_SWAP', v)"
rm -rf node_modules/sharp.__old node_modules/@img.__old node_modules/detect-libc.__old node_modules/semver.__old "$STAGE"
echo APPLY_OK
"""
    code, text = run_bash(c, cmd, timeout=TIMEOUT)
    if code != 0 or "APPLY_OK" not in text:
        restore = f"""
set -e
cd {APP}/server
if [ -f "{recover_dir}/package.json" ]; then cp -a "{recover_dir}/package.json" package.json; fi
if [ -f "{recover_dir}/package-lock.json" ]; then cp -a "{recover_dir}/package-lock.json" package-lock.json; fi
if [ -d "{recover_dir}/sharp" ]; then
  rm -rf node_modules/sharp
  cp -a "{recover_dir}/sharp" node_modules/sharp
fi
if [ -d "{recover_dir}/img" ]; then
  rm -rf node_modules/@img
  cp -a "{recover_dir}/img" node_modules/@img
fi
node -e "console.log('RESTORED', require('./node_modules/sharp/package.json').version); require('sharp'); console.log('PKG', require('./package.json').dependencies.sharp)"
"""
        run_bash(c, restore, timeout=90)
        raise SystemExit(f"apply_bundle failed exit={code}")
    return True


def pin_packages(c, local_pkg, local_lock):
    sftp = c.open_sftp()
    for local, remote in ((local_pkg, f"{APP}/server/package.json"), (local_lock, f"{APP}/server/package-lock.json")):
        if local and os.path.isfile(local):
            print("PUT", local, "->", remote)
            sftp.put(local, remote)
    sftp.close()
    code, text = run(c, "node -p \"require('%s/server/package.json').dependencies.sharp\"" % APP, timeout=30)
    if code != 0 or TARGET not in text:
        raise SystemExit("package.json pin mismatch after upload")


def restart_and_smoke(c):
    code, _ = run(c, "pm2 restart erp-taranom", timeout=90)
    if code != 0:
        raise SystemExit("pm2 restart failed")
    time.sleep(5)
    cmd = f"""
set -e
cd {APP}/server
node -e "console.log('RUNTIME', require('sharp/package.json').version); require('sharp')"
curl -s -o /dev/null -w 'root=%{{http_code}}\\n' http://127.0.0.1:3000/
curl -s -o /dev/null -w 'health=%{{http_code}}\\n' http://127.0.0.1:3000/api/system/health || true
pm2 describe erp-taranom | sed -n '1,25p'
pm2 show erp-taranom | grep -E 'BACKUP_|DATA_ENC|ENCRYPTION' | sed 's/=.*/=<redacted>/' | head -20 || true
node -e "const sharp=require('sharp'); const fs=require('fs'); const path=require('path'); const out=path.join('{APP}','server','_recover','sharp-smoke-tmp.jpg'); sharp({{create:{{width:64,height:64,channels:3,background:{{r:180,g:40,b:90}}}}}}).jpeg().toBuffer().then(async buf=>{{fs.writeFileSync(out,buf); const meta=await sharp(out).metadata(); if(meta.width!==64||meta.format!=='jpeg') process.exit(5); console.log('SMOKE_THUMB_OK', meta.width, meta.height, meta.format, require('sharp/package.json').version); try{{fs.unlinkSync(out)}}catch(e){{}}); }}).catch(e=>{{console.error(e); process.exit(6);}});"
"""
    code, text = run_bash(c, cmd, timeout=90)
    if code != 0:
        raise SystemExit("post-restart smoke command failed")
    if f"RUNTIME {TARGET}" not in text:
        raise SystemExit("post-restart runtime version check failed")
    if "root=200" not in text and "health=200" not in text:
        raise SystemExit("HTTP smoke failed")
    if "SMOKE_THUMB_OK" not in text:
        raise SystemExit("thumbnail smoke failed")
    print("DEPLOY_SMOKE_OK")
    return True


def rollback(c, stamp=None):
    if stamp:
        if stamp.startswith("/"):
            dest = stamp
        elif stamp.startswith("sharp-"):
            dest = f"{APP}/server/_recover/{stamp}"
        else:
            dest = f"{APP}/server/_recover/sharp-{stamp}"
    else:
        code, text = run(c, f"ls -1 {APP}/server/_recover | grep '^sharp-20' | sort | tail -1", timeout=30)
        cand = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("sharp-20")]
        if code != 0 or not cand:
            raise SystemExit("no recover stamp found")
        dest = f"{APP}/server/_recover/{cand[-1]}"
    cmd = f"""
set -e
DEST="{dest}"
test -d "$DEST/sharp"
cd {APP}/server
cp -a "$DEST/package.json" package.json
if [ -f "$DEST/package-lock.json" ]; then cp -a "$DEST/package-lock.json" package-lock.json; fi
rm -rf node_modules/sharp node_modules/@img
cp -a "$DEST/sharp" node_modules/sharp
if [ -d "$DEST/img" ]; then cp -a "$DEST/img" node_modules/@img; fi
node -e "console.log('ROLLBACK_RUNTIME', require('./node_modules/sharp/package.json').version); require('sharp')"
pm2 restart erp-taranom
sleep 4
curl -s -o /dev/null -w 'root=%{{http_code}}\\n' http://127.0.0.1:3000/
pm2 describe erp-taranom | sed -n '1,20p'
echo ROLLBACK_OK
"""
    code, text = run_bash(c, cmd, timeout=120)
    if code != 0 or "ROLLBACK_OK" not in text:
        raise SystemExit(f"rollback failed exit={code}")
    print("ROLLBACK_COMPLETE", dest)
    return True


def main():
    c = connect()
    try:
        if MODE == "inventory":
            code, _ = inventory(c)
            sys.exit(code)
        if MODE == "deploy":
            if not BUNDLE or not os.path.isfile(BUNDLE):
                raise SystemExit(f"bundle missing: {BUNDLE}")
            inventory(c)
            assert_x86_64_v2(c)
            recover_dir, stamp = backup_live(c)
            print("BACKUP_STAMP", stamp)
            remote_tar = upload_bundle(c, BUNDLE)
            pin_packages(c, cfg.get("local_pkg") or "", cfg.get("local_lock") or "")
            apply_bundle(c, remote_tar, recover_dir)
            restart_and_smoke(c)
            print("FINAL_STAMP", stamp)
            print("FINAL_RECOVER", recover_dir)
            sys.exit(0)
        if MODE == "rollback":
            rollback(c, STAMP or None)
            sys.exit(0)
        raise SystemExit(f"unknown mode {MODE}")
    finally:
        c.close()


if __name__ == "__main__":
    main()
'@
    Set-Content -LiteralPath $path -Value $helper -Encoding utf8
    return $path
}

function Invoke-RemotePython {
    param(
        [Parameter(Mandatory)] [string]$Mode,
        [hashtable]$Extra = @{}
    )
    $helper = Write-RemoteHelper
    $payload = [ordered]@{
        mode             = $Mode
        host             = $ServerHost
        user             = $UserName
        key              = $IdentityFile
        app              = $AppRoot
        target           = $TargetVersion
        rollback_version = $RollbackVersion
        install_timeout  = $InstallTimeoutSec
        connect_timeout  = $ConnectTimeoutSec
        bundle_tar       = $BundleTar
        recover_stamp    = $RecoverStamp
        public_base      = $PublicBaseUrl
    }
    foreach ($k in $Extra.Keys) { $payload[$k] = $Extra[$k] }
    $json = ($payload | ConvertTo-Json -Compress -Depth 6)
    $json | & python $helper
    if ($LASTEXITCODE -ne 0) {
        throw "Remote python mode '$Mode' failed with exit $LASTEXITCODE"
    }
}

function New-LinuxSharpBundle {
    Write-Host "Building Linux x64 offline sharp@$TargetVersion bundle via proxy $HttpProxy"
    [IO.Directory]::CreateDirectory($BundleDir) | Out-Null
    $work = Join-Path $BundleDir 'work'
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    [IO.Directory]::CreateDirectory($work) | Out-Null
    $npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { 'npm.cmd' } else { 'npm' }

    Push-Location $work
    try {
        $env:HTTP_PROXY = $HttpProxy
        $env:HTTPS_PROXY = $HttpProxy
        $env:npm_config_fetch_timeout = '120000'
        $env:npm_config_fetch_retries = '2'
        '{"name":"sharp-linux-bundle","private":true}' | Set-Content -LiteralPath (Join-Path $work 'package.json') -Encoding utf8
        & $npm install "sharp@$TargetVersion" --os=linux --cpu=x64 --libc=glibc --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install sharp@$TargetVersion for linux-x64 failed" }
        $ver = & node -p "require('./node_modules/sharp/package.json').version"
        if ($ver -ne $TargetVersion) { throw "bundled sharp version $ver != $TargetVersion" }
        if (-not (Test-Path -LiteralPath (Join-Path $work 'node_modules\@img\sharp-linux-x64'))) {
            throw 'missing @img/sharp-linux-x64 in offline bundle'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $work 'node_modules\@img\sharp-libvips-linux-x64'))) {
            throw 'missing @img/sharp-libvips-linux-x64 in offline bundle'
        }
        $stage = Join-Path $BundleDir 'stage'
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        # Pack sharp + platform binaries + runtime deps Node resolves from node_modules/
        foreach ($name in @('sharp', 'detect-libc', 'semver')) {
            $src = Join-Path $work ("node_modules\" + $name)
            if (-not (Test-Path -LiteralPath $src)) { throw "missing bundle package: $name" }
            Copy-Item -LiteralPath $src -Destination (Join-Path $stage $name) -Recurse -Force
        }
        Copy-Item -LiteralPath (Join-Path $work 'node_modules\@img') -Destination (Join-Path $stage '@img') -Recurse -Force
        if (Test-Path -LiteralPath $BundleTar) { Remove-Item -LiteralPath $BundleTar -Force }
        $packPy = @"
import tarfile
from pathlib import Path
stage = Path(r'''$stage''')
out = Path(r'''$BundleTar''')
with tarfile.open(out, 'w:gz') as tf:
    for name in ('sharp', 'detect-libc', 'semver', '@img'):
        tf.add(stage / name, arcname=name)
print('BUNDLE_OK', out, out.stat().st_size)
"@
        & python -c $packPy
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $BundleTar)) {
            throw 'failed to create bundle tarball'
        }
        $hash = (Get-FileHash -LiteralPath $BundleTar -Algorithm SHA256).Hash
        Write-Host "BUNDLE_TAR=$BundleTar"
        Write-Host "BUNDLE_SHA256=$hash"
        Set-Content -LiteralPath (Join-Path $BundleDir 'SHA256.txt') -Value "$hash  $(Split-Path -Leaf $BundleTar)" -Encoding ascii
    }
    finally {
        Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
        Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
        Pop-Location
    }
}

Assert-Prereqs

if ($InventoryOnly) {
    Invoke-RemotePython -Mode inventory
    return
}

if ($PrepareBundle) {
    New-LinuxSharpBundle
    return
}

if ($Rollback) {
    Invoke-RemotePython -Mode rollback
    return
}

if (-not $Deploy -and -not $InventoryOnly -and -not $PrepareBundle -and -not $Rollback) {
    $Deploy = $true
}

if ($Deploy) {
    if (-not (Test-Path -LiteralPath $BundleTar -PathType Leaf)) {
        New-LinuxSharpBundle
    }
    $localPkg = Join-Path $RepoRoot 'server\package.json'
    $localLock = Join-Path $RepoRoot 'server\package-lock.json'
    Invoke-RemotePython -Mode deploy -Extra @{
        local_pkg  = $localPkg
        local_lock = $localLock
    }
}
