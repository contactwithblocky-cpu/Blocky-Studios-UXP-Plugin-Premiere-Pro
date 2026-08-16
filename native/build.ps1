param(
    [ValidateSet('Configure', 'Build', 'Deploy', 'Test')]
    [string]$Action = 'Build'
)

$ErrorActionPreference = 'Stop'
$cmakeRoot = if ($env:ORACLE_CMAKE_ROOT) { $env:ORACLE_CMAKE_ROOT } else { 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin' }
$cmake = Join-Path $cmakeRoot 'cmake.exe'
$ctest = Join-Path $cmakeRoot 'ctest.exe'
$sdkRoot = if ($env:ADOBE_UXP_HYBRID_SDK_ROOT) { $env:ADOBE_UXP_HYBRID_SDK_ROOT } else { 'D:/Adobe SDKs/UXP Hybrid Plugin SDK/uxp-hybrid-plugin-sdk-main' }
$nativeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildRoot = Join-Path $nativeRoot 'build'
$stagedAddon = Join-Path $buildRoot 'stage\win\x64\oracle-native-drag.uxpaddon'
$runtimeSource = Join-Path $nativeRoot 'third_party\ffmpeg\windows-x86_64'
$stagedRuntime = Join-Path $buildRoot 'stage\win\x64\media'
$pluginRoot = Split-Path -Parent $nativeRoot
$deployedAddon = Join-Path $pluginRoot 'win\x64\oracle-native-drag.uxpaddon'
$deployedRuntime = Join-Path $pluginRoot 'win\x64\media'
$runtimeFiles = @(
    'ffmpeg.exe',
    'ffprobe.exe',
    'avcodec-60.dll',
    'avdevice-60.dll',
    'avfilter-9.dll',
    'avformat-60.dll',
    'avutil-58.dll',
    'swresample-4.dll',
    'swscale-7.dll',
    'THIRD_PARTY_NOTICES.txt'
)

function Get-AddonHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    $item = Get-Item -LiteralPath $Path
    $stream = [System.IO.File]::OpenRead($item.FullName)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('X2') })
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-AddonMetadata([string]$Label, [string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host "${Label}: missing ($Path)"
        return
    }
    $item = Get-Item -LiteralPath $Path
    $hash = Get-AddonHash $item.FullName
    [pscustomobject]@{
        Label = $Label
        Path = $item.FullName
        Size = $item.Length
        ModifiedUtc = $item.LastWriteTimeUtc.ToString('o')
        SHA256 = $hash
    } | Format-List | Out-Host
}

function Invoke-ReleaseBuild {
    & $cmake --build $buildRoot --config Release --parallel
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Sync-MediaRuntime $runtimeSource $stagedRuntime
}

function Sync-MediaRuntime([string]$SourceDirectory, [string]$DestinationDirectory) {
    $sourceFull = [System.IO.Path]::GetFullPath($SourceDirectory)
    $destinationFull = [System.IO.Path]::GetFullPath($DestinationDirectory)
    $workspacePrefix = [System.IO.Path]::GetFullPath($pluginRoot).TrimEnd('\') + '\'
    if (-not $sourceFull.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $destinationFull.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Replay media runtime paths must remain inside the plugin workspace.'
    }
    foreach ($name in $runtimeFiles) {
        $sourcePath = Join-Path $sourceFull $name
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Required replay media runtime file is missing: $sourcePath"
        }
    }
    [System.IO.Directory]::CreateDirectory($destinationFull) | Out-Null
    foreach ($name in $runtimeFiles) {
        $sourcePath = Join-Path $sourceFull $name
        $destinationPath = Join-Path $destinationFull $name
        $sourceHash = Get-AddonHash $sourcePath
        $destinationHash = if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
            Get-AddonHash $destinationPath
        } else {
            $null
        }
        if ($sourceHash -ne $destinationHash) {
            Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
        }
        if ((Get-AddonHash $destinationPath) -ne $sourceHash) {
            throw "Replay media runtime copy hash mismatch: $name"
        }
    }
    $unexpected = @(Get-ChildItem -LiteralPath $destinationFull -File -Force |
        Where-Object { $runtimeFiles -cnotcontains $_.Name })
    if ($unexpected.Count -ne 0) {
        throw "Replay media runtime directory contains unexpected files: $($unexpected.Name -join ', ')"
    }
}

if (-not (Test-Path -LiteralPath $cmake)) {
    throw "Visual Studio Build Tools 2026 CMake was not found: $cmake"
}
if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'src/api/UxpAddonShared.h'))) {
    throw "Adobe UXP Hybrid Plugin SDK was not found: $sdkRoot"
}

if ($Action -eq 'Configure') {
    & $cmake -S $nativeRoot -B $buildRoot -G 'Visual Studio 18 2026' -A x64 "-DADOBE_UXP_HYBRID_SDK_ROOT=$sdkRoot"
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'CMakeCache.txt'))) {
    & $cmake -S $nativeRoot -B $buildRoot -G 'Visual Studio 18 2026' -A x64 "-DADOBE_UXP_HYBRID_SDK_ROOT=$sdkRoot"
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

if ($Action -eq 'Build') {
    Invoke-ReleaseBuild
    Get-AddonMetadata 'Staged Release addon' $stagedAddon
    exit 0
}

if ($Action -eq 'Deploy') {
    Invoke-ReleaseBuild
    if (-not (Test-Path -LiteralPath $stagedAddon)) {
        throw "Staged Release addon was not produced: $stagedAddon"
    }
    Get-AddonMetadata 'Copy source' $stagedAddon
    Get-AddonMetadata 'Destination before copy' $deployedAddon
    $destinationDirectory = Split-Path -Parent $deployedAddon
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    $sourceHash = Get-AddonHash $stagedAddon
    $destinationHash = Get-AddonHash $deployedAddon
    if ($sourceHash -and $sourceHash -eq $destinationHash) {
        Write-Host 'Deployment already current; skipped replacing the identical loaded addon.'
    } else {
        try {
            Copy-Item -LiteralPath $stagedAddon -Destination $deployedAddon -Force
        } catch {
            throw "Could not replace the deployed addon. Fully unload Blocky Studios and close Premiere, then retry. $($_.Exception.Message)"
        }
    }
    Get-AddonMetadata 'Destination after copy' $deployedAddon
    Sync-MediaRuntime $stagedRuntime $deployedRuntime
    Write-Host "Deployed replay media runtime: $deployedRuntime"
    exit 0
}

if (-not (Test-Path -LiteralPath $ctest)) {
    throw "Visual Studio Build Tools 2026 CTest was not found: $ctest"
}
Invoke-ReleaseBuild
& $ctest --test-dir $buildRoot -C Release --output-on-failure
exit $LASTEXITCODE
