param(
    [string]$CcxPath = '',
    [switch]$VerifyPremiereLoaded
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$pluginRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'manifest.json') -Raw | ConvertFrom-Json
$stage = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot 'native\build\ccx-stage\com.blocky.oracle.v5'))
$ccx = if ($CcxPath) {
    [System.IO.Path]::GetFullPath($CcxPath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $pluginRoot "native\build\ccx-output-$($manifest.version)\$($manifest.id)_premierepro.ccx"))
}
$upia = Join-Path $env:ProgramFiles 'Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'
$installed = Join-Path $env:ProgramFiles "Common Files\Adobe\UXP\Plugins\salim\External\$($manifest.id)_$($manifest.version)"

if (-not (Test-Path -LiteralPath $ccx -PathType Leaf)) { throw "Verified CCX is missing: $ccx" }
if (-not (Test-Path -LiteralPath $upia -PathType Leaf)) { throw "Adobe UnifiedPluginInstallerAgent is missing: $upia" }

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-private-ccx.ps1') -CcxPath $ccx
if ($LASTEXITCODE -ne 0) { throw "Refusing to install an unverified CCX (exit code $LASTEXITCODE)." }

$runningPremiere = @(Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue)
if ($runningPremiere.Count -ne 0) {
    throw 'Close Premiere Pro before replacing the installed Blocky Studios payload.'
}

$logPath = Join-Path $env:APPDATA 'Adobe\UPI\Log\Upia.log'
$logOffset = if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).Length } else { 0L }

# UPIA reports success but retains stale bytes when installing the same semantic
# version over itself. Remove only this exact extension name before reinstalling
# so the byte-for-byte verifier cannot be defeated by that Adobe behavior.
if (Test-Path -LiteralPath $installed -PathType Container) {
    $quotedName = '"' + [string]$manifest.name + '"'
    $removeProcess = Start-Process -FilePath $upia -ArgumentList "/remove $quotedName" -Wait -PassThru -WindowStyle Hidden
    if ($removeProcess.ExitCode -ne 0) { throw "Adobe UPIA removal returned exit code $($removeProcess.ExitCode)." }
    $removeDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath $installed -PathType Container) -and [DateTime]::UtcNow -lt $removeDeadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $installed -PathType Container) {
        throw 'Adobe UPIA reported removal success but retained the old Blocky Studios payload.'
    }
}

$quotedCcx = '"' + $ccx + '"'
$process = Start-Process -FilePath $upia -ArgumentList "/install $quotedCcx" -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Adobe UPIA returned exit code $($process.ExitCode)." }

$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (-not (Test-Path -LiteralPath $installed -PathType Container) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
}
if (-not (Test-Path -LiteralPath $installed -PathType Container)) {
    $newLog = if (Test-Path -LiteralPath $logPath) {
        $stream = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
        try {
            [void]$stream.Seek([Math]::Min($logOffset, $stream.Length), 'Begin')
            $reader = [System.IO.StreamReader]::new($stream)
            try { $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
    } else { '' }
    throw "Adobe UPIA did not produce the expected installed version directory. Recent log: $newLog"
}

$verifyArguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'verify-installed-plugin.ps1'),
    '-Stage', $stage,
    '-Installed', $installed
)
if ($VerifyPremiereLoaded) { $verifyArguments += '-RequirePremiereLoaded' }
& powershell @verifyArguments
if ($LASTEXITCODE -ne 0) { throw "Installed-byte verification failed with exit code $LASTEXITCODE." }
