[CmdletBinding()]
param(
    [string]$Destination = 'D:\ERP-Taranom-Offsite',
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$KeyFile = (Join-Path $env:LOCALAPPDATA 'ERP-Taranom\OffsiteAgent\backup-key.dpapi'),
    [switch]$SaveKey,
    [string]$Archive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -ne 'Desktop' -and -not $IsWindows) { throw 'DPAPI restore drill supports Windows only.' }
$drillScript = Join-Path $RepositoryRoot 'server\scripts\weekly-backup-drill.js'
if (-not (Test-Path -LiteralPath $drillScript -PathType Leaf)) { throw "Drill script not found: $drillScript" }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'node.exe not found.' }
[IO.Directory]::CreateDirectory((Split-Path -Parent $KeyFile)) | Out-Null
[IO.Directory]::CreateDirectory($Destination) | Out-Null

if ($SaveKey) {
    if (-not [Environment]::UserInteractive) { throw 'SaveKey requires an interactive user session.' }
    $entered = Read-Host 'Backup encryption key (stored with Windows DPAPI; input is hidden)' -AsSecureString
    $protected = ConvertFrom-SecureString -SecureString $entered
    [IO.File]::WriteAllText($KeyFile, $protected, [Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) {
    throw "DPAPI backup key not found. Run once interactively with -SaveKey: $KeyFile"
}

if (-not $Archive) {
    $latest = Get-ChildItem -LiteralPath $Destination -File |
        Where-Object { $_.Name -match '^crm-backup-\d{8}-\d{6}\.zip\.enc$' } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $latest) { throw 'No verified encrypted backup exists in the offsite destination.' }
    $Archive = $latest.FullName
}
$Archive = [IO.Path]::GetFullPath($Archive)
if ((Split-Path -Leaf $Archive) -notmatch '^crm-backup-\d{8}-\d{6}\.zip\.enc$') {
    throw 'Only immutable timestamped encrypted backup archives are accepted.'
}
$sidecar = "$Archive.sha256"
$receipt = "$Archive.receipt.json"
if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf) -or -not (Test-Path -LiteralPath $receipt -PathType Leaf)) {
    throw 'Archive is missing its verified sidecar or pull receipt.'
}
$sideText = [IO.File]::ReadAllText($sidecar, [Text.Encoding]::UTF8)
$sidePattern = '^([0-9A-Fa-f]{64})  ' + [regex]::Escape((Split-Path -Leaf $Archive)) + "(?:`r?`n)?$"
if ($sideText -notmatch $sidePattern) { throw 'Offsite checksum sidecar is malformed.' }
$expected = $Matches[1].ToUpperInvariant()
$actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actual -ne $expected) { throw 'Offsite archive SHA-256 mismatch before drill.' }
$receiptData = Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json
if ($receiptData.ok -ne $true -or $receiptData.file -ne (Split-Path -Leaf $Archive) -or
    ([string]$receiptData.sha256).ToUpperInvariant() -ne $expected -or
    [long]$receiptData.size -ne (Get-Item -LiteralPath $Archive).Length -or
    $receiptData.encrypted -ne $true) {
    throw 'Pull receipt does not match the selected archive, size, encryption flag, and SHA-256.'
}

$secure = ConvertTo-SecureString ([IO.File]::ReadAllText($KeyFile, [Text.Encoding]::UTF8))
$bstr = [IntPtr]::Zero
$previousKey = $env:BACKUP_ENCRYPTION_KEY
$previousDir = $env:BACKUP_DIR
try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $env:BACKUP_ENCRYPTION_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $env:BACKUP_DIR = Join-Path $Destination '.drill-status'
    [IO.Directory]::CreateDirectory($env:BACKUP_DIR) | Out-Null
    $output = @(& node.exe $drillScript '--file' $Archive 2>&1)
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $safe = ($output | Out-String).Trim()
        if ($safe.Length -gt 1200) { $safe = $safe.Substring(0, 1200) }
        throw "Isolated restore drill failed (exit=$code): $safe"
    }
    $output
} finally {
    $env:BACKUP_ENCRYPTION_KEY = $previousKey
    $env:BACKUP_DIR = $previousDir
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
