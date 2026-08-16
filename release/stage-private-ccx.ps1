param(
    [string]$Destination = '',
    [switch]$PrivateLocalAcceptance
)

$ErrorActionPreference = 'Stop'

function Get-Sha256Hex([string]$Path) {
    $stream = [System.IO.File]::Open(
        [System.IO.Path]::GetFullPath($Path),
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try { return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '') }
        finally { $sha256.Dispose() }
    } finally { $stream.Dispose() }
}

$pluginRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$stageRoot = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot 'native\build\ccx-stage'))
$destinationFull = if ($Destination) {
    [System.IO.Path]::GetFullPath($Destination)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $stageRoot 'com.blocky.oracle.v5'))
}
$stagePrefix = $stageRoot.TrimEnd('\') + '\'

if (-not $destinationFull.StartsWith($stagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release staging destination must remain under $stageRoot"
}
if (-not $PrivateLocalAcceptance) {
    throw 'Public/distributable CCX staging is blocked: font and Blocky Studios artwork redistribution rights are not documented. Use -PrivateLocalAcceptance only for private local acceptance.'
}

$requiredStyles = @(
    'dist/blocky-studios-ui.css'
)
$requiredModules = @(
    'main.js',
    'src/generated/oracle-build-info.js',
    'src/core/oracle-ui-runtime.js',
    'src/core/oracle-diagnostics.js',
    'src/core/oracle-platform-telemetry.js',
    'src/app/oracle-shell.js',
    'src/app/oracle-panel-dom.js',
    'src/app/oracle-runtime-registry.js',
    'src/settings/oracle-preferences.js',
    'src/data/oracle-data-schema.js',
    'src/data/oracle-migrations.js',
    'src/replays/oracle-replay-library.js',
    'src/replays/oracle-replay-media.js',
    'src/replays/oracle-replay-workspace.js',
    'src/replays/oracle-replay-organization.js',
    'src/replays/oracle-replay-lifecycle-ui.js',
    'src/replays/oracle-replay-viewer.js',
    'src/curves/oracle-curve-math.js',
    'src/curves/oracle-curve-presets.js',
    'src/curves/oracle-premiere-curves-adapter.js',
    'src/curves/oracle-curves-workspace.js',
    'src/quick-apply/oracle-effect-index.js',
    'src/quick-apply/oracle-premiere-effects-adapter.js',
    'src/quick-apply/oracle-quick-apply-domain.js',
    'src/quick-apply/oracle-quick-apply-workspace.js'
)
$requiredAssets = @(
    'assets/fonts/samsung_sharp_sans_regular.otf',
    'assets/fonts/samsung_sharp_sans_medium.otf',
    'assets/fonts/samsung_sharp_sans_bold.otf',
    'assets/icons/add.png',
    'assets/icons/apply.png',
    'assets/icons/close.png',
    'assets/icons/curves.png',
    'assets/icons/favorite.png',
    'assets/icons/loop.png',
    'assets/icons/menu.png',
    'assets/icons/muted.png',
    'assets/icons/pause.png',
    'assets/icons/play.png',
    'assets/icons/quick-apply.png',
    'assets/icons/refresh.png',
    'assets/icons/reorder.png',
    'assets/icons/replays.png',
    'assets/icons/search.png',
    'assets/icons/settings.png',
    'assets/icons/step-back.png',
    'assets/icons/step-forward.png',
    'assets/icons/stop.png',
    'assets/icons/subtract.png',
    'assets/icons/volume.png',
    'assets/logo/blocky-studios-light-mode.png',
    'assets/logo/blocky-studios-dark-mode.png',
    'icons/dark.png',
    'icons/dark@1x.png',
    'icons/dark@2x.png',
    'icons/light.png',
    'icons/light@1x.png',
    'icons/light@2x.png',
    'icons/plugin-icon.png',
    'icons/plugin-icon@2x.png',
    'icons/plugin@1x.png',
    'icons/plugin@2x.png'
)
$requiredRuntimeFiles = @(
    'win/x64/media/ffmpeg.exe',
    'win/x64/media/ffprobe.exe',
    'win/x64/media/avcodec-60.dll',
    'win/x64/media/avdevice-60.dll',
    'win/x64/media/avfilter-9.dll',
    'win/x64/media/avformat-60.dll',
    'win/x64/media/avutil-58.dll',
    'win/x64/media/swresample-4.dll',
    'win/x64/media/swscale-7.dll',
    'win/x64/media/THIRD_PARTY_NOTICES.txt'
)
$requiredBundleFiles = @('manifest.json', 'index.html') +
    $requiredStyles +
    $requiredModules +
    $requiredAssets +
    $requiredRuntimeFiles +
    @('win/x64/oracle-native-drag.uxpaddon')

function Assert-ExactPropertyNames([object]$Value, [string[]]$Expected, [string]$Label) {
    if ($null -eq $Value -or $Value -is [System.Array]) {
        throw "$Label must be an object with the exact required keys."
    }
    $actualNames = @($Value.PSObject.Properties.Name | Sort-Object)
    $expectedNames = @($Expected | Sort-Object)
    if (@(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $actualNames -CaseSensitive).Count -ne 0) {
        throw "$Label must contain exactly: $([string]::Join(', ', $expectedNames))."
    }
}

function Test-IsReparsePoint([System.IO.FileSystemInfo]$Item) {
    return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-NoReparseSourcePath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $pluginPrefix = $pluginRoot.TrimEnd('\') + '\'
    if (-not $full.Equals($pluginRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $full.StartsWith($pluginPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release input escaped the plugin root: $full"
    }

    $cursor = $pluginRoot
    if (Test-Path -LiteralPath $cursor) {
        $rootItem = Get-Item -LiteralPath $cursor -Force
        if (Test-IsReparsePoint $rootItem) {
            throw "Release staging refuses a reparse-point source ancestor: $cursor"
        }
    }
    $relative = $full.Substring($pluginRoot.Length).TrimStart('\')
    foreach ($segment in @($relative.Split('\') | Where-Object { $_ })) {
        $cursor = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (Test-IsReparsePoint $item) {
                throw "Release staging refuses a reparse-point source ancestor: $cursor"
            }
        }
    }
}

function Assert-RegularSource([string]$Path) {
    Assert-NoReparseSourcePath $Path
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Required release input is missing: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (Test-IsReparsePoint $item) {
        throw "Release staging refuses a reparse-point source: $Path"
    }
    return $item
}

function Copy-ReleaseFile([string]$RelativePath) {
    $source = Join-Path $pluginRoot $RelativePath
    [void](Assert-RegularSource $source)
    $sourceHash = Get-Sha256Hex $source
    $target = Join-Path $destinationFull $RelativePath
    $targetDirectory = Split-Path -Parent $target
    [System.IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
    $targetHash = Get-Sha256Hex $target
    if ($sourceHash -ne $targetHash) {
        throw "Release staging copy hash mismatch: $RelativePath"
    }
}

function Get-RelativeStagePath([string]$FullName) {
    $destinationPrefix = $destinationFull.TrimEnd('\') + '\'
    if (-not $FullName.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Staged file escaped the confined release directory: $FullName"
    }
    return $FullName.Substring($destinationPrefix.Length).Replace('\', '/')
}

function Remove-ConfinedStageDirectory([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($stagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the release staging root: $full"
    }
    Assert-NoReparseSourcePath $full
    if (-not (Test-Path -LiteralPath $full)) { return }
    $rootItem = Get-Item -LiteralPath $full -Force
    if (Test-IsReparsePoint $rootItem) {
        throw "Refusing to remove a reparse-point staging directory: $full"
    }
    foreach ($item in Get-ChildItem -LiteralPath $full -Recurse -Force) {
        if (Test-IsReparsePoint $item) {
            throw "Refusing to remove a staging tree containing a reparse point: $($item.FullName)"
        }
    }
    Remove-Item -LiteralPath $full -Recurse -Force
}

function Invoke-ReleaseNodeScript([string]$RelativePath, [string]$Label) {
    $scriptPath = Join-Path $pluginRoot $RelativePath
    [void](Assert-RegularSource $scriptPath)
    $nodeCommand = Get-Command node -ErrorAction Stop
    & $nodeCommand.Source $scriptPath
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

# Generate every authored-to-runtime UI artifact before the exact allowlist is
# evaluated or copied. The stage therefore cannot reuse stale CSS/build identity.
Invoke-ReleaseNodeScript 'release\build-ui.cjs' 'Blocky Studios UI stylesheet generation'
Invoke-ReleaseNodeScript 'release\generate-ui-build.cjs' 'Blocky Studios build identity generation'

if (Test-Path -LiteralPath $destinationFull) {
    # destinationFull was normalized and confined above; refuse junctions before deletion.
    Remove-ConfinedStageDirectory $destinationFull
}
[void](Assert-NoReparseSourcePath $stageRoot)
[void](Assert-NoReparseSourcePath $destinationFull)
[System.IO.Directory]::CreateDirectory($destinationFull) | Out-Null

foreach ($file in $requiredBundleFiles) {
    Copy-ReleaseFile $file
}

# UDT canonicalizes manifest JSON through JSON.stringify(..., null, 2) and
# removes the trailing newline when it builds a CCX. Keep the staged manifest
# byte-stable with that documented packaging path so the private inventory can
# remain exact instead of weakening verification for one rewritten file.
$stagedManifestPath = Join-Path $destinationFull 'manifest.json'
$stagedManifestText = (Get-Content -LiteralPath $stagedManifestPath -Raw).TrimEnd("`r", "`n")
[System.IO.File]::WriteAllText(
    $stagedManifestPath,
    $stagedManifestText,
    [System.Text.UTF8Encoding]::new($false)
)

$privateNotice = @'
PRIVATE LOCAL ACCEPTANCE ONLY - DO NOT DISTRIBUTE

This package contains supplied Samsung Sharp Sans fonts and Blocky Studios artwork whose
redistribution/commercial-use provenance is not documented in this checkout.
It may be used only for local acceptance by the project owner. It is not a
public, Marketplace, commercial, or redistributable release artifact.
'@
[System.IO.File]::WriteAllText(
    (Join-Path $destinationFull 'PRIVATE_LOCAL_ACCEPTANCE_ONLY.txt'),
    $privateNotice,
    [System.Text.UTF8Encoding]::new($false)
)

$allowedExtensions = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)
foreach ($extension in @('.json', '.html', '.js', '.css', '.png', '.svg', '.ttf', '.otf', '.uxpaddon', '.txt', '.exe', '.dll')) {
    [void]$allowedExtensions.Add($extension)
}
$stagedFiles = Get-ChildItem -LiteralPath $destinationFull -Recurse -File -Force
$allowedStagedPaths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)
foreach ($relativePath in $requiredBundleFiles + @('PRIVATE_LOCAL_ACCEPTANCE_ONLY.txt')) {
    if (-not $allowedStagedPaths.Add($relativePath.Replace('\', '/'))) {
        throw "The exact release allowlist contains a duplicate path: $relativePath"
    }
}
foreach ($file in $stagedFiles) {
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Staged package contains a reparse point: $($file.FullName)"
    }
    $relativePath = Get-RelativeStagePath $file.FullName
    if (-not $allowedStagedPaths.Contains($relativePath)) {
        throw "Unexpected file outside the exact release allowlist: $relativePath"
    }
    if (-not $allowedExtensions.Contains($file.Extension)) {
        throw "Unexpected file type in staged package: $($file.FullName)"
    }
    if ($file.Extension -match '^\.(?:mov|mp4|mkv|avi|prproj|log|pdb|obj|lib|exp)$') {
        throw "Development media/build output entered the package: $($file.FullName)"
    }
}
if ($stagedFiles.Count -ne $allowedStagedPaths.Count) {
    throw 'The staged package does not exactly match the release file allowlist.'
}

$addons = @($stagedFiles | Where-Object Extension -EQ '.uxpaddon')
if ($addons.Count -ne 1 -or $addons[0].Name -cne 'oracle-native-drag.uxpaddon') {
    throw 'The staged package must contain exactly one canonical oracle-native-drag.uxpaddon.'
}
$sourceAddon = Join-Path $pluginRoot 'win\x64\oracle-native-drag.uxpaddon'
$builtAddon = Join-Path $pluginRoot 'native\build\stage\win\x64\oracle-native-drag.uxpaddon'
[void](Assert-RegularSource $sourceAddon)
[void](Assert-RegularSource $builtAddon)
$sourceHash = Get-Sha256Hex $sourceAddon
$builtHash = Get-Sha256Hex $builtAddon
if ($sourceHash -ne $builtHash) {
    throw 'The canonical packaged addon does not match the freshly built Release addon. Fully unload Blocky Studios, close Premiere, and run the native Deploy action before staging.'
}
$stagedHash = Get-Sha256Hex $addons[0].FullName
if ($sourceHash -ne $stagedHash) {
    throw 'The staged native addon hash does not match the rebuilt canonical addon.'
}
foreach ($runtimeRelative in $requiredRuntimeFiles) {
    $runtimeName = Split-Path -Leaf $runtimeRelative
    $deployedRuntimeFile = Join-Path $pluginRoot $runtimeRelative
    $builtRuntimeFile = Join-Path $pluginRoot (Join-Path 'native\build\stage\win\x64\media' $runtimeName)
    [void](Assert-RegularSource $deployedRuntimeFile)
    [void](Assert-RegularSource $builtRuntimeFile)
    if ((Get-Sha256Hex $deployedRuntimeFile) -ne (Get-Sha256Hex $builtRuntimeFile)) {
        throw "The packaged replay media runtime does not match the freshly staged native runtime: $runtimeName"
    }
}

$manifest = Get-Content -LiteralPath (Join-Path $destinationFull 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.manifestVersion -ne 6 -or $manifest.id -cne 'com.blocky.oracle.v5' -or
    $manifest.main -cne 'index.html' -or $manifest.host -is [System.Array] -or
    $manifest.host.app -cne 'premierepro' -or $manifest.host.minVersion -cne '26.3.0' -or
    $manifest.addon.name -cne 'oracle-native-drag.uxpaddon') {
    throw 'The staged manifest is not the canonical Blocky Studios Premiere manifest v6.'
}
Assert-ExactPropertyNames $manifest.requiredPermissions @('localFileSystem', 'enableAddon', 'ipc', 'network') 'requiredPermissions'
Assert-ExactPropertyNames $manifest.requiredPermissions.ipc @('enablePluginCommunication') 'requiredPermissions.ipc'
Assert-ExactPropertyNames $manifest.requiredPermissions.network @('domains') 'requiredPermissions.network'
$networkDomains = $manifest.requiredPermissions.network.domains
if ($manifest.requiredPermissions.localFileSystem -cne 'fullAccess' -or
    $manifest.requiredPermissions.enableAddon -ne $true -or
    $manifest.requiredPermissions.ipc.enablePluginCommunication -ne $true -or
    -not ($networkDomains -is [string]) -or $networkDomains -cne 'all') {
    throw 'The staged manifest requiredPermissions contract is not the exact private-local Blocky Studios contract.'
}

$html = Get-Content -LiteralPath (Join-Path $destinationFull 'index.html') -Raw
$references = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($match in [regex]::Matches($html, '(?:src|href)="([^"?#]+)')) {
    $reference = $match.Groups[1].Value.Replace('/', '\')
    if ($reference -and -not $reference.StartsWith('data:')) {
        [void]$references.Add($reference)
    }
}
foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath (Join-Path $destinationFull $reference))) {
        throw "Staged HTML reference is missing: $reference"
    }
}

$destinationPrefix = $destinationFull.TrimEnd('\') + '\'
foreach ($cssFile in $stagedFiles | Where-Object Extension -EQ '.css') {
    $cssText = Get-Content -LiteralPath $cssFile.FullName -Raw
    foreach ($match in [regex]::Matches($cssText, 'url\(\s*["'']?([^\)"'']+)["'']?\s*\)', 'IgnoreCase')) {
        $reference = $match.Groups[1].Value.Trim()
        if (-not $reference -or $reference.StartsWith('data:') -or $reference.StartsWith('#')) { continue }
        $reference = ($reference -split '[?#]', 2)[0]
        $pluginRelative = if ($reference.StartsWith('plugin://', [System.StringComparison]::OrdinalIgnoreCase)) {
            $reference.Substring('plugin://'.Length).Replace('/', '\')
        } else { $null }
        $reference = $reference.Replace('/', '\')
        $resolved = if ($null -ne $pluginRelative) {
            [System.IO.Path]::GetFullPath((Join-Path $destinationFull $pluginRelative))
        } else {
            [System.IO.Path]::GetFullPath((Join-Path $cssFile.DirectoryName $reference))
        }
        if (-not $resolved.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Staged stylesheet reference escapes the package: $reference"
        }
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "Staged stylesheet reference is missing: $reference"
        }
    }
}

foreach ($requiredAsset in $requiredAssets) {
    if (-not (Test-Path -LiteralPath (Join-Path $destinationFull $requiredAsset) -PathType Leaf)) {
        throw "Required Blocky Studios packaged asset is missing: $requiredAsset"
    }
}

$absoluteUserPathPattern = '(?i)(?:[A-Z]:\\Users\\|\\\\[^\\\s]+\\(?:Users|home)\\)'
foreach ($file in $stagedFiles | Where-Object Extension -In @('.json', '.html', '.js', '.css', '.svg', '.txt')) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    if ($text -match $absoluteUserPathPattern) {
        throw "A private absolute user path entered the staged package: $($file.FullName)"
    }
}

$inventory = [ordered]@{
    schema = 'com.blocky.oracle.private-ccx-inventory'
    version = 2
    releaseEligible = $false
    distribution = 'PRIVATE LOCAL ACCEPTANCE ONLY - DO NOT DISTRIBUTE'
    pluginId = $manifest.id
    pluginVersion = $manifest.version
    generatedAt = [DateTime]::UtcNow.ToString('o')
    nativeAddon = [ordered]@{
        path = 'win/x64/oracle-native-drag.uxpaddon'
        size = $addons[0].Length
        sha256 = $stagedHash
    }
    files = @($stagedFiles | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            path = Get-RelativeStagePath $_.FullName
            size = $_.Length
            sha256 = Get-Sha256Hex $_.FullName
        }
    })
    blockers = @(
        'Font redistribution/commercial-use rights are undocumented.',
        'Blocky Studios logo/icon redistribution rights are undocumented.',
        'Final semantic version requires project-owner confirmation.'
    )
}
$inventoryPath = Join-Path $destinationFull 'PRIVATE_LOCAL_INVENTORY.json'
[System.IO.File]::WriteAllText(
    $inventoryPath,
    ($inventory | ConvertTo-Json -Depth 8),
    [System.Text.UTF8Encoding]::new($false)
)
[void]$allowedStagedPaths.Add('PRIVATE_LOCAL_INVENTORY.json')
$finalStagedFiles = @(Get-ChildItem -LiteralPath $destinationFull -Recurse -File -Force)
foreach ($file in $finalStagedFiles) {
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Final staged package contains a reparse point: $($file.FullName)"
    }
    $relativePath = Get-RelativeStagePath $file.FullName
    if (-not $allowedStagedPaths.Contains($relativePath)) {
        throw "Final staged package contains a file outside the exact release allowlist: $relativePath"
    }
}
if ($finalStagedFiles.Count -ne $allowedStagedPaths.Count) {
    throw 'The final staged package does not exactly match the release file allowlist.'
}

[pscustomobject]@{
    Destination = $destinationFull
    PrivateLocalAcceptance = $true
    ReleaseEligible = $false
    FileCount = $finalStagedFiles.Count
    NativeAddonSHA256 = $stagedHash
    Inventory = $inventoryPath
} | Format-List
