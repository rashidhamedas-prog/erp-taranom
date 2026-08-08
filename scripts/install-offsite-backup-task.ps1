[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Destination = 'D:\ERP-Taranom-Offsite',
    [string]$ServerHost = '94.249.244.208',
    [ValidateRange(1, 65535)] [int]$Port = 22,
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]{0,31}$')] [string]$UserName = 'taranom',
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\id_ed25519_taranom_backup'),
    [string]$KnownHostsFile = (Join-Path $env:USERPROFILE '.ssh\known_hosts'),
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [ValidateRange(8, 4096)] [int]$RetentionCount = 128,
    [string]$TaskName = 'ERP-Taranom-Offsite-Pull',
    [switch]$EnableWeeklyDrill
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-PrivateKeyAcl {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "SSH key not found: $Path" }
    $broadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    foreach ($rule in (Get-Acl -LiteralPath $Path).Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { continue }
        $readMask = [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::ReadData
        if ($broadSids -contains $sid -and (($rule.FileSystemRights -band $readMask) -ne 0)) {
            throw "SSH private key ACL is too broad ($sid has read access): $Path"
        }
    }
}

function Set-PrivateDirectoryAcl {
    param([string]$Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [Security.AccessControl.PropagationFlags]::None
    foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl,
            $inherit, $propagation, [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    try {
        Set-Acl -LiteralPath $Path -AclObject $acl
    } catch [System.Security.AccessControl.PrivilegeNotHeldException] {
        $userSid = $identity.User.Value
        $result = @(& icacls.exe $Path '/inheritance:r' '/grant:r' "*$userSid`:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Failed to protect directory ACL: $($result -join ' ')" }
    }
}

if ($PSVersionTable.PSEdition -ne 'Desktop' -and -not $IsWindows) { throw 'This installer supports Windows only.' }
foreach ($path in @($PSScriptRoot, $RepositoryRoot, $Destination, $IdentityFile, $KnownHostsFile)) {
    if ($path -match '"') { throw 'Paths containing a double quote are not supported.' }
}
Assert-PrivateKeyAcl -Path $IdentityFile
if (-not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) { throw "known_hosts not found: $KnownHostsFile" }
$hostTarget = if ($Port -eq 22) { $ServerHost } else { "[$ServerHost]:$Port" }
$known = @(ssh-keygen.exe -F $hostTarget -f $KnownHostsFile 2>$null)
if ($LASTEXITCODE -ne 0 -or $known.Count -eq 0) {
    throw "Pinned host key missing for $hostTarget. Verify its fingerprint outside SSH before installation."
}
if (-not $PSCmdlet.ShouldProcess($TaskName, 'Install offsite agent, ACLs, and scheduled tasks')) { return }

$agentDir = Join-Path $env:LOCALAPPDATA 'ERP-Taranom\OffsiteAgent'
$keyFile = Join-Path $agentDir 'backup-key.dpapi'
if ($EnableWeeklyDrill -and -not (Test-Path -LiteralPath $keyFile -PathType Leaf)) {
    throw "Weekly drill key is not stored. Run provision-backup-encryption-key.ps1 first."
}

[IO.Directory]::CreateDirectory($Destination) | Out-Null
[IO.Directory]::CreateDirectory($agentDir) | Out-Null
Set-PrivateDirectoryAcl -Path $Destination
Set-PrivateDirectoryAcl -Path $agentDir

$installedPull = Join-Path $agentDir 'pull-offsite-backup.ps1'
$installedDrill = Join-Path $agentDir 'run-offsite-restore-drill.ps1'
$installedKnownHosts = Join-Path $agentDir 'known_hosts'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'pull-offsite-backup.ps1') -Destination $installedPull -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-offsite-restore-drill.ps1') -Destination $installedDrill -Force
Copy-Item -LiteralPath $KnownHostsFile -Destination $installedKnownHosts -Force

$pullArgs = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', "`"$installedPull`"",
    '-Destination', "`"$Destination`"",
    '-ServerHost', $ServerHost,
    '-Port', [string]$Port,
    '-UserName', $UserName,
    '-IdentityFile', "`"$IdentityFile`"",
    '-KnownHostsFile', "`"$installedKnownHosts`"",
    '-RetentionCount', [string]$RetentionCount
) -join ' '
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $pullArgs
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$logon = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType S4U -RunLevel Limited
$effectiveLogonType = 'S4U'
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($repeat, $logon) `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
} catch [Microsoft.Management.Infrastructure.CimException] {
    $accessDenied = ($_.FullyQualifiedErrorId -like 'HRESULT 0x80070005,*')
    if (-not $accessDenied) { throw }
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($repeat, $logon) `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
    $effectiveLogonType = 'Interactive'
}

if ($EnableWeeklyDrill) {
    $drillTask = "$TaskName-Weekly-Drill"
    $drillArgs = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', "`"$installedDrill`"",
        '-RepositoryRoot', "`"$RepositoryRoot`"",
        '-Destination', "`"$Destination`"",
        '-KeyFile', "`"$keyFile`""
    ) -join ' '
    $drillAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $drillArgs
    $weekly = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At '03:00'
    Register-ScheduledTask -TaskName $drillTask -Action $drillAction -Trigger $weekly `
        -Settings $settings -Principal $principal -Force | Out-Null
}

[ordered]@{
    ok = $true
    task = $TaskName
    run_as = $currentUser
    run_level = 'Limited'
    logon_type = $effectiveLogonType
    logged_out_capable = ($effectiveLogonType -eq 'S4U')
    interval_minutes = 15
    destination = [IO.Path]::GetFullPath($Destination)
    agent = $installedPull
    weekly_drill_enabled = [bool]$EnableWeeklyDrill
} | ConvertTo-Json
