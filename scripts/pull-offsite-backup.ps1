[CmdletBinding()]
param(
    [string]$ServerHost = '94.249.244.208',
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]{0,31}$')]
    [string]$UserName = 'taranom',
    [ValidateRange(1, 65535)]
    [int]$Port = 22,
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\id_ed25519_taranom_backup'),
    [string]$KnownHostsFile = (Join-Path $env:USERPROFILE '.ssh\known_hosts'),
    [string]$RemoteBackupDir = '/home/taranom/crm-taranom/server/backups',
    [string]$Destination = 'D:\ERP-Taranom-Offsite',
    [ValidateRange(8, 4096)]
    [int]$RetentionCount = 128,
    [string]$SshPath = 'ssh.exe',
    [string]$ScpPath = 'scp.exe',
    [string]$SshKeygenPath = 'ssh-keygen.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [Parameter(Mandatory)] [string[]]$Arguments,
        [string]$Operation = $FilePath
    )
    $output = @(& $FilePath @Arguments 2>&1)
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $safe = ($output | Out-String).Trim()
        if ($safe.Length -gt 800) { $safe = $safe.Substring(0, 800) }
        throw "$Operation failed (exit=$code): $safe"
    }
    return $output
}

function Assert-SafeConfiguration {
    if ($ServerHost -notmatch '^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$') {
        throw 'ServerHost contains unsafe characters.'
    }
    if ($RemoteBackupDir -notmatch '^/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$' -or
        $RemoteBackupDir.Split('/') -contains '..') {
        throw 'RemoteBackupDir must be an absolute path without traversal or shell characters.'
    }
    foreach ($tool in @($SshPath, $ScpPath, $SshKeygenPath)) {
        if (-not (Get-Command -Name $tool -ErrorAction SilentlyContinue)) {
            throw "Required executable not found: $tool"
        }
    }
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        throw "SSH identity file not found: $IdentityFile"
    }
    if (-not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) {
        throw "Pinned known_hosts file not found: $KnownHostsFile"
    }
    $target = if ($Port -eq 22) { $ServerHost } else { "[$ServerHost]:$Port" }
    $found = @(& $SshKeygenPath -F $target -f $KnownHostsFile 2>$null)
    if ($LASTEXITCODE -ne 0 -or $found.Count -eq 0) {
        throw "Pinned SSH host key not found for $target. Verify the fingerprint out-of-band first."
    }
}

function Write-Receipt {
    param(
        [string]$FileName,
        [string]$Sha256,
        [long]$Size,
        [bool]$Downloaded
    )
    $receipt = [ordered]@{
        schema_version = 1
        ok = $true
        verified_at_utc = [DateTime]::UtcNow.ToString('o')
        source = "ssh://${UserName}@${ServerHost}:$Port$RemoteBackupDir/$FileName"
        file = $FileName
        sha256 = $Sha256.ToUpperInvariant()
        size = $Size
        encrypted = $true
        downloaded = $Downloaded
    }
    $json = $receipt | ConvertTo-Json -Depth 4
    $receiptPath = Join-Path $Destination "$FileName.receipt.json"
    [IO.File]::WriteAllText($receiptPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $latestTmp = Join-Path $Destination '.last-success.json.tmp'
    $latest = Join-Path $Destination 'last-success.json'
    [IO.File]::WriteAllText($latestTmp, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $latestTmp -Destination $latest -Force
    return $receipt
}

function Invoke-Retention {
    $archives = @(Get-ChildItem -LiteralPath $Destination -File |
        Where-Object { $_.Name -match '^crm-backup-\d{8}-\d{6}\.zip\.enc$' } |
        Sort-Object LastWriteTimeUtc -Descending)
    foreach ($old in @($archives | Select-Object -Skip $RetentionCount)) {
        foreach ($path in @($old.FullName, "$($old.FullName).sha256", "$($old.FullName).receipt.json")) {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                Remove-Item -LiteralPath $path -Force
            }
        }
    }
}

Assert-SafeConfiguration
[IO.Directory]::CreateDirectory($Destination) | Out-Null
$Destination = [IO.Path]::GetFullPath($Destination)

$lockPath = Join-Path $Destination '.pull.lock'
$lockStream = $null
$tempFiles = [Collections.Generic.List[string]]::new()
try {
    try {
        $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw 'Another offsite pull is already running.'
    }

    $common = @(
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ClearAllForwardings=yes',
        '-o', "UserKnownHostsFile=$KnownHostsFile",
        '-o', 'ConnectTimeout=30',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-i', $IdentityFile
    )
    $listOutput = @(& $SshPath @common '-p' ([string]$Port) "$UserName@$ServerHost" 'erp-backup-list' 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Remote backup listing failed (exit=$LASTEXITCODE)."
    }
    $remoteNames = @($listOutput | ForEach-Object { ([string]$_).Trim() } |
        Where-Object { $_ -match '^crm-backup-\d{8}-\d{6}\.zip\.enc$' } |
        Sort-Object -Descending -Unique)
    if ($remoteNames.Count -eq 0) { throw 'Remote backup listing contained no safe immutable encrypted archive.' }
    $fileName = $remoteNames[0]

    $runId = [Guid]::NewGuid().ToString('N')
    $side1 = Join-Path $Destination ".$fileName.$runId.sidecar-before.part"
    $side2 = Join-Path $Destination ".$fileName.$runId.sidecar-after.part"
    $archivePart = Join-Path $Destination ".$fileName.$runId.archive.part"
    $tempFiles.Add($side1); $tempFiles.Add($side2); $tempFiles.Add($archivePart)
    $remoteBase = "${UserName}@${ServerHost}:$RemoteBackupDir/$fileName"
    # Legacy SCP is intentional: the forced server wrapper accepts only strict
    # read requests for immutable encrypted backups and rejects SFTP/write/shell.
    $scpCommon = @($common + @('-O', '-P', [string]$Port, '-q'))

    Invoke-NativeChecked -FilePath $ScpPath -Arguments @($scpCommon + @("$remoteBase.sha256", $side1)) -Operation 'download checksum before' | Out-Null
    $sidePattern = '^([0-9A-Fa-f]{64})  ' + [regex]::Escape($fileName) + "(?:`r?`n)?$"
    $sideText1 = [IO.File]::ReadAllText($side1, [Text.Encoding]::UTF8)
    if ($sideText1 -notmatch $sidePattern) { throw 'Remote checksum sidecar is malformed or names another file.' }
    $expectedSha = $Matches[1].ToUpperInvariant()

    $finalPath = Join-Path $Destination $fileName
    $downloaded = $true
    if (Test-Path -LiteralPath $finalPath -PathType Leaf) {
        $existingSha = (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($existingSha -eq $expectedSha) {
            $downloaded = $false
        } else {
            $quarantine = "$finalPath.quarantine-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
            Move-Item -LiteralPath $finalPath -Destination $quarantine
        }
    }

    if ($downloaded) {
        Invoke-NativeChecked -FilePath $ScpPath -Arguments @($scpCommon + @($remoteBase, $archivePart)) -Operation 'download encrypted archive' | Out-Null
    }
    Invoke-NativeChecked -FilePath $ScpPath -Arguments @($scpCommon + @("$remoteBase.sha256", $side2)) -Operation 'download checksum after' | Out-Null

    $sideText2 = [IO.File]::ReadAllText($side2, [Text.Encoding]::UTF8)
    if ($sideText1 -cne $sideText2) { throw 'Checksum sidecar changed during download; refusing promotion.' }
    if ($sideText2 -notmatch $sidePattern -or $Matches[1].ToUpperInvariant() -ne $expectedSha) {
        throw 'Post-download checksum sidecar is invalid.'
    }

    if ($downloaded) {
        $partInfo = Get-Item -LiteralPath $archivePart
        if ($partInfo.Length -le 0) { throw 'Downloaded archive is empty.' }
        $actualSha = (Get-FileHash -LiteralPath $archivePart -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($actualSha -ne $expectedSha) { throw 'Archive SHA-256 mismatch; refusing promotion.' }
        Move-Item -LiteralPath $archivePart -Destination $finalPath
    }

    $finalSha = (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($finalSha -ne $expectedSha) {
        throw 'Final archive verification failed.'
    }
    [long]$finalSize = (Get-Item -LiteralPath $finalPath).Length
    Move-Item -LiteralPath $side2 -Destination "$finalPath.sha256" -Force
    $receipt = Write-Receipt -FileName $fileName -Sha256 $expectedSha -Size $finalSize -Downloaded $downloaded
    Invoke-Retention
    $receipt | ConvertTo-Json -Depth 4
} catch {
    if (Test-Path -LiteralPath $Destination -PathType Container) {
        $message = [string]$_.Exception.Message
        if ($message.Length -gt 800) { $message = $message.Substring(0, 800) }
        $failure = [ordered]@{
            schema_version = 1
            ok = $false
            failed_at_utc = [DateTime]::UtcNow.ToString('o')
            source_host = $ServerHost
            error = $message
        } | ConvertTo-Json
        $failureTmp = Join-Path $Destination '.last-failure.json.tmp'
        $failurePath = Join-Path $Destination 'last-failure.json'
        [IO.File]::WriteAllText($failureTmp, $failure + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $failureTmp -Destination $failurePath -Force
    }
    throw
} finally {
    foreach ($temp in $tempFiles) {
        if (Test-Path -LiteralPath $temp -PathType Leaf) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $lockStream) { $lockStream.Dispose() }
}
