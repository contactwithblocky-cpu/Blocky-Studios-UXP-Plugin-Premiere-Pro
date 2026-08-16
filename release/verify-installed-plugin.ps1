param(
    [string]$Stage = '',
    [string]$Installed = '',
    [switch]$RequirePremiereLoaded
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
$stageFull = if ($Stage) {
    [System.IO.Path]::GetFullPath($Stage)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $pluginRoot 'native\build\ccx-stage\com.blocky.oracle.v5'))
}
$installedFull = if ($Installed) {
    [System.IO.Path]::GetFullPath($Installed)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $env:ProgramFiles "Common Files\Adobe\UXP\Plugins\salim\External\$($manifest.id)_$($manifest.version)"))
}

if (-not (Test-Path -LiteralPath $stageFull -PathType Container)) {
    throw "The exact staged payload does not exist: $stageFull"
}
if (-not (Test-Path -LiteralPath $installedFull -PathType Container)) {
    throw "The exact installed payload does not exist: $installedFull"
}

function Get-RelativeFiles([string]$Root) {
    $prefix = $Root.TrimEnd('\') + '\'
    $map = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName) {
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to verify a reparse-point payload file: $($file.FullName)"
        }
        if (-not $file.FullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Payload file escaped its verification root: $($file.FullName)"
        }
        $relative = $file.FullName.Substring($prefix.Length).Replace('\', '/')
        $map[$relative] = [pscustomobject]@{
            Size = $file.Length
            SHA256 = Get-Sha256Hex $file.FullName
        }
    }
    return $map
}

$stageFiles = Get-RelativeFiles $stageFull
$installedFiles = Get-RelativeFiles $installedFull
$stagePaths = @($stageFiles.Keys | Sort-Object)
$installedPaths = @($installedFiles.Keys | Sort-Object)
$pathDifferences = @(Compare-Object -ReferenceObject $stagePaths -DifferenceObject $installedPaths -CaseSensitive)
if ($pathDifferences.Count -ne 0) {
    throw "Installed payload file inventory differs from the exact stage: $($pathDifferences | ConvertTo-Json -Compress)"
}

$contentDifferences = @()
foreach ($relative in $stagePaths) {
    $expected = $stageFiles[$relative]
    $actual = $installedFiles[$relative]
    if ($expected.Size -ne $actual.Size -or $expected.SHA256 -cne $actual.SHA256) {
        $contentDifferences += [pscustomobject]@{
            Path = $relative
            StageSize = $expected.Size
            InstalledSize = $actual.Size
            StageSHA256 = $expected.SHA256
            InstalledSHA256 = $actual.SHA256
        }
    }
}
if ($contentDifferences.Count -ne 0) {
    throw "Installed payload bytes differ from the exact stage: $($contentDifferences | ConvertTo-Json -Depth 4 -Compress)"
}

$installedManifest = Get-Content -LiteralPath (Join-Path $installedFull 'manifest.json') -Raw | ConvertFrom-Json
if ($installedManifest.id -cne $manifest.id -or $installedManifest.version -cne $manifest.version) {
    throw 'Installed manifest identity/version differs from source.'
}

$expectedAddonPath = [System.IO.Path]::GetFullPath((Join-Path $installedFull 'win\x64\oracle-native-drag.uxpaddon'))
$loadedAddonPaths = @()
foreach ($process in @(Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue)) {
    try {
        foreach ($module in @($process.Modules)) {
            if ($module.FileName -and $module.FileName.EndsWith('oracle-native-drag.uxpaddon', [System.StringComparison]::OrdinalIgnoreCase)) {
                $loadedAddonPaths += [System.IO.Path]::GetFullPath($module.FileName)
            }
        }
    } catch {
        if ($RequirePremiereLoaded) {
            throw "Premiere module inspection failed for PID $($process.Id): $($_.Exception.Message)"
        }
    }
}
$loadedAddonPaths = @($loadedAddonPaths | Sort-Object -Unique)
if ($RequirePremiereLoaded) {
    if ($loadedAddonPaths.Count -ne 1 -or -not $loadedAddonPaths[0].Equals($expectedAddonPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Premiere is not loading exactly the expected addon. Expected: $expectedAddonPath; Actual: $([string]::Join(', ', $loadedAddonPaths))"
    }
}

[pscustomobject]@{
    Verified = $true
    PluginId = $manifest.id
    PluginVersion = $manifest.version
    Stage = $stageFull
    Installed = $installedFull
    FileCount = $stagePaths.Count
    TotalBytes = ($stagePaths | ForEach-Object { $stageFiles[$_].Size } | Measure-Object -Sum).Sum
    LoadedAddon = if ($loadedAddonPaths.Count) { $loadedAddonPaths[0] } else { $null }
} | Format-List
