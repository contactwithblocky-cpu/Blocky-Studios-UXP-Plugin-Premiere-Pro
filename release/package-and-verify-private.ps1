param(
    [switch]$SkipStage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Get-Sha256Hex([string]$Path) {
    $stream = [System.IO.File]::Open([System.IO.Path]::GetFullPath($Path), 'Open', 'Read', 'ReadWrite')
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try { return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '') }
        finally { $sha256.Dispose() }
    } finally { $stream.Dispose() }
}

$pluginRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'manifest.json') -Raw | ConvertFrom-Json
$stage = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot 'native\build\ccx-stage\com.blocky.oracle.v5'))
$output = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot "native\build\ccx-output-$($manifest.version)"))
$ccx = Join-Path $output "$($manifest.id)_premierepro.ccx"

Push-Location $pluginRoot
try {
    if (-not $SkipStage) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File 'release\stage-private-ccx.ps1' -PrivateLocalAcceptance
        if ($LASTEXITCODE -ne 0) { throw "Private staging failed with exit code $LASTEXITCODE." }
    }
    & node 'release\package-private-ccx.cjs' --stage $stage --out $output
    if ($LASTEXITCODE -ne 0) { throw "UDT canonical packaging failed with exit code $LASTEXITCODE." }
    & powershell -NoProfile -ExecutionPolicy Bypass -File 'release\verify-private-ccx.ps1' -CcxPath $ccx
    if ($LASTEXITCODE -ne 0) { throw "CCX verification failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

[pscustomobject]@{
    Verified = $true
    PluginVersion = $manifest.version
    Stage = $stage
    Ccx = $ccx
    CcxBytes = (Get-Item -LiteralPath $ccx).Length
    CcxSHA256 = Get-Sha256Hex $ccx
} | Format-List
