[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ServerHost = '94.249.244.208',
    [ValidateRange(1, 65535)] [int]$Port = 22,
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]{0,31}$')] [string]$UserName = 'taranom',
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\id_ed25519_taranom'),
    [string]$KnownHostsFile = (Join-Path $env:USERPROFILE '.ssh\known_hosts'),
    [string]$KeyFile = (Join-Path $env:LOCALAPPDATA 'ERP-Taranom\OffsiteAgent\backup-key.dpapi'),
    [string]$RemoteKeyFile = '/home/taranom/crm-taranom/server/backup-encryption-key.txt'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-SshChecked {
    param([string]$Command, [AllowNull()][string]$InputText = $null)
    $args = @(
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'IdentitiesOnly=yes', '-o', 'ClearAllForwardings=yes',
        '-o', "UserKnownHostsFile=$KnownHostsFile", '-o', 'ConnectTimeout=30',
        '-i', $IdentityFile, '-p', [string]$Port, "$UserName@$ServerHost", $Command
    )
    if ($null -eq $InputText) { $output = @(& ssh.exe @args 2>&1) }
    else { $output = @($InputText | & ssh.exe @args 2>&1) }
    if ($LASTEXITCODE -ne 0) {
        $safe = ($output | Out-String).Trim()
        if ($safe.Length -gt 800) { $safe = $safe.Substring(0, 800) }
        throw "SSH operation failed (exit=$LASTEXITCODE): $safe"
    }
    return $output
}

function Set-PrivateDirectoryAcl {
    param([string]$Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if ($PSVersionTable.PSEdition -ne 'Desktop' -and -not $IsWindows) { throw 'Windows DPAPI is required.' }
if ($RemoteKeyFile -notmatch '^/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$' -or $RemoteKeyFile.Split('/') -contains '..') {
    throw 'RemoteKeyFile is unsafe.'
}
foreach ($path in @($IdentityFile, $KnownHostsFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required SSH file missing: $path" }
}
$target = if ($Port -eq 22) { $ServerHost } else { "[$ServerHost]:$Port" }
$known = @(ssh-keygen.exe -F $target -f $KnownHostsFile 2>$null)
if ($LASTEXITCODE -ne 0 -or $known.Count -eq 0) { throw "Pinned host key missing for $target" }

$stateCommand = @'
set -eu
file_hash=MISSING
if [ -f '__KEY_FILE__' ]; then file_hash=$(sha256sum '__KEY_FILE__' | awk '{print $1}'); fi
pm2_hash=MISSING
pid=$(pm2 pid erp-taranom 2>/dev/null | tail -1 || true)
if printf '%s' "$pid" | grep -Eq '^[0-9]+$' && [ -r "/proc/$pid/environ" ]; then
  key=$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^BACKUP_ENCRYPTION_KEY=//p' | head -1)
  if [ -n "$key" ]; then pm2_hash=$(printf '%s' "$key" | sha256sum | awk '{print $1}'); fi
  unset key
fi
printf 'FILE %s\nPM2 %s\n' "$file_hash" "$pm2_hash"
'@
$stateCommand = $stateCommand.Replace('__KEY_FILE__', $RemoteKeyFile).Trim()
$remoteState = (Invoke-SshChecked -Command $stateCommand) -join "`n"
$fileMatch = [regex]::Match($remoteState, '(?m)^FILE (MISSING|[0-9a-f]{64})$')
$pm2Match = [regex]::Match($remoteState, '(?m)^PM2 (MISSING|[0-9a-f]{64})$')
if (-not $fileMatch.Success -or -not $pm2Match.Success) { throw 'Remote key hash state is malformed.' }
$remoteFileHash = $fileMatch.Groups[1].Value.ToUpperInvariant()
$remotePm2Hash = $pm2Match.Groups[1].Value.ToUpperInvariant()

$keyDir = Split-Path -Parent $KeyFile
$keyDirExisted = Test-Path -LiteralPath $keyDir -PathType Container
[IO.Directory]::CreateDirectory($keyDir) | Out-Null
if (-not $keyDirExisted) { Set-PrivateDirectoryAcl -Path $keyDir }
$localKeyExists = Test-Path -LiteralPath $KeyFile -PathType Leaf
if (-not $localKeyExists -and ($remoteFileHash -ne 'MISSING' -or $remotePm2Hash -ne 'MISSING')) {
    throw 'Production already has a backup key but the local DPAPI recovery key is missing. Recover the existing key; refusing to replace it.'
}
if (-not $localKeyExists) {
    $bytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $plainGenerated = [Convert]::ToBase64String($bytes)
    [Array]::Clear($bytes, 0, $bytes.Length)
    $secureGenerated = ConvertTo-SecureString $plainGenerated -AsPlainText -Force
    $protected = ConvertFrom-SecureString -SecureString $secureGenerated
    [IO.File]::WriteAllText($KeyFile, $protected, [Text.UTF8Encoding]::new($false))
    $plainGenerated = $null
}

$secure = ConvertTo-SecureString ([IO.File]::ReadAllText($KeyFile, [Text.Encoding]::UTF8))
$bstr = [IntPtr]::Zero
$activated = $false
try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([Text.Encoding]::UTF8.GetByteCount($plain) -lt 32) { throw 'Backup encryption key is too short.' }
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($plain)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $localHash = ([BitConverter]::ToString($sha256.ComputeHash($plainBytes))).Replace('-', '')
    } finally {
        $sha256.Dispose()
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
    foreach ($remoteHash in @($remoteFileHash, $remotePm2Hash)) {
        if ($remoteHash -ne 'MISSING' -and $remoteHash -ne $localHash) {
            throw 'Local DPAPI key does not match the existing production backup key. Rotation is disabled; refusing overwrite.'
        }
    }
    if ($PSCmdlet.ShouldProcess($ServerHost, 'Provision backup encryption key and restart PM2 with updated environment')) {
        $writeCommand = @'
umask 077; IFS= read -r key; key=$(printf '%s' "$key" | tr -d '\r\n'); test ${#key} -ge 32; printf '%s' "$key" > '__KEY_FILE__'; unset key; chmod 600 '__KEY_FILE__'; echo KEY_FILE_WRITTEN
'@
        $writeCommand = $writeCommand.Replace('__KEY_FILE__', $RemoteKeyFile).Trim()
        $written = Invoke-SshChecked -Command $writeCommand -InputText $plain
        if (($written -join "`n") -notmatch 'KEY_FILE_WRITTEN') { throw 'Remote key file confirmation missing.' }
        $activateCommand = @'
set -eu; key=$(cat '__KEY_FILE__'); test ${#key} -ge 32; export BACKUP_ENCRYPTION_KEY="$key"; pm2 restart erp-taranom --update-env >/dev/null; unset key; pm2 save >/dev/null; pid=$(pm2 pid erp-taranom | tail -1); tr '\0' '\n' < /proc/$pid/environ | grep -q '^BACKUP_ENCRYPTION_KEY='; echo KEY_ACTIVE
'@
        $activateCommand = $activateCommand.Replace('__KEY_FILE__', $RemoteKeyFile).Trim()
        $active = Invoke-SshChecked -Command $activateCommand
        if (($active -join "`n") -notmatch 'KEY_ACTIVE') { throw 'PM2 key activation confirmation missing.' }
        $activated = $true
    }
} finally {
    $plain = $null
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

[ordered]@{
    ok = $true
    local_dpapi_key = $KeyFile
    remote_key_file = $RemoteKeyFile
    pm2_key_active = $activated
    secret_printed = $false
} | ConvertTo-Json
