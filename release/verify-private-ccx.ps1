param(
    [Parameter(Mandatory = $true)]
    [string]$CcxPath
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
$verificationRoot = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot 'native\build\ccx-verify'))
$verificationPrefix = $verificationRoot.TrimEnd('\') + '\'
$destinationFull = $null
$archive = $null
$archiveStream = $null

$maximumArchiveBytes = 512MB
$maximumExtractedBytes = 512MB
$maximumEntryBytes = 128MB
$maximumEntries = 2000
$maximumTextBytes = 8MB

$requiredPanels = @(
    'oraclePanel',
    'oracleReplaysPanel',
    'oracleCurvesPanel',
    'oracleQuickApplyPanel'
)
$requiredCommand = 'oracleQuickApplyCommand'
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
$allowedArchiveFiles = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)
foreach ($relativePath in @(
    'manifest.json',
    'index.html',
    'PRIVATE_LOCAL_ACCEPTANCE_ONLY.txt',
    'PRIVATE_LOCAL_INVENTORY.json',
    'win/x64/oracle-native-drag.uxpaddon'
) + $requiredStyles + $requiredModules + $requiredAssets + $requiredRuntimeFiles) {
    if (-not $allowedArchiveFiles.Add($relativePath)) {
        throw "The exact CCX file allowlist contains a duplicate path: $relativePath"
    }
}

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

function Assert-NoReparseAncestors([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($pluginRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $full.Equals($pluginRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Verification path escaped the plugin root: $full"
    }

    $relative = $full.Substring($pluginRoot.Length).TrimStart('\')
    $cursor = $pluginRoot
    foreach ($segment in @($relative.Split('\') | Where-Object { $_ })) {
        $cursor = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (Test-IsReparsePoint $item) {
                throw "CCX verification refuses a reparse-point path: $cursor"
            }
        }
    }
}

function Remove-ConfinedVerificationDirectory([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($verificationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the CCX verification root: $full"
    }
    if (-not (Test-Path -LiteralPath $full)) {
        return
    }

    $rootItem = Get-Item -LiteralPath $full -Force
    if (Test-IsReparsePoint $rootItem) {
        throw "Refusing to remove a reparse-point verification directory: $full"
    }
    foreach ($item in Get-ChildItem -LiteralPath $full -Recurse -Force) {
        if (Test-IsReparsePoint $item) {
            throw "Refusing to remove a verification tree containing a reparse point: $($item.FullName)"
        }
    }
    Remove-Item -LiteralPath $full -Recurse -Force
}

function Assert-SafeArchivePath([string]$Name, [bool]$IsDirectory) {
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 512) {
        throw 'CCX contains an empty or overlong ZIP entry name.'
    }
    if ($Name.Contains('\') -or $Name.Contains(':') -or $Name.StartsWith('/') -or $Name.Contains([char]0)) {
        throw "CCX contains an unsafe ZIP path: $Name"
    }

    $normalized = $Name
    if ($IsDirectory) {
        $normalized = $normalized.TrimEnd('/')
    }
    if (-not $normalized -or $normalized -notmatch '^[A-Za-z0-9@._ /-]+$') {
        throw "CCX contains an unsupported ZIP path: $Name"
    }

    $segments = @($normalized.Split('/'))
    foreach ($segment in $segments) {
        if (-not $segment -or $segment -eq '.' -or $segment -eq '..' -or
            $segment.StartsWith('.') -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
            throw "CCX contains an unsafe ZIP path segment: $Name"
        }
        $deviceStem = [System.IO.Path]::GetFileNameWithoutExtension($segment)
        if ($deviceStem -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
            throw "CCX contains a reserved Windows path segment: $Name"
        }
    }

    if ($IsDirectory) {
        if ($normalized -notmatch '^(?:dist|icons|src(?:/(?:app|core|generated|settings|data|replays|curves|quick-apply))?|assets(?:/(?:fonts|icons|logo))?|win(?:/x64(?:/media)?)?)$') {
            throw "CCX contains an unexpected directory: $Name"
        }
        return $normalized
    }

    if ($normalized -match '(?i)(?:^|/)(?:node_modules|tests?|__tests__|coverage|fixtures|samples?|debug|docs?|release|native|build|tmp|temp)(?:/|$)' -or
        $normalized -match '(?i)(?:\.test|\.spec|\.bench)\.[^.]+$') {
        throw "CCX contains development-only content: $Name"
    }

    if (-not $allowedArchiveFiles.Contains($normalized)) {
        throw "CCX contains an unexpected or disallowed file: $Name"
    }
    return $normalized
}

function Resolve-BundleReference([string]$SourcePath, [string]$Reference) {
    $referenceWithoutQuery = ($Reference -split '[?#]', 2)[0].Replace('\', '/')
    $pluginRelative = if ($referenceWithoutQuery.StartsWith('plugin://', [System.StringComparison]::OrdinalIgnoreCase)) {
        $referenceWithoutQuery.Substring('plugin://'.Length)
    } else { $null }
    if ($null -ne $pluginRelative) {
        if (-not $pluginRelative -or $pluginRelative.StartsWith('/') -or $pluginRelative.Contains('..')) {
            throw "Bundle file $SourcePath contains an invalid plugin reference: $Reference"
        }
        return Assert-SafeArchivePath $pluginRelative $false
    }
    if (-not $referenceWithoutQuery -or $referenceWithoutQuery.StartsWith('/') -or
        $referenceWithoutQuery.StartsWith('//') -or $referenceWithoutQuery -match '^[A-Za-z][A-Za-z0-9+.-]*:') {
        throw "Bundle file $SourcePath contains a non-local reference: $Reference"
    }

    $baseSegments = [System.Collections.Generic.List[string]]::new()
    $sourceDirectory = [System.IO.Path]::GetDirectoryName($SourcePath.Replace('/', '\'))
    if ($sourceDirectory) {
        foreach ($segment in $sourceDirectory.Replace('\', '/').Split('/')) {
            if ($segment) { [void]$baseSegments.Add($segment) }
        }
    }
    foreach ($segment in $referenceWithoutQuery.Split('/')) {
        if (-not $segment -or $segment -eq '.') {
            continue
        }
        if ($segment -eq '..') {
            if ($baseSegments.Count -eq 0) {
                throw "Bundle reference escapes the package root: $SourcePath -> $Reference"
            }
            $baseSegments.RemoveAt($baseSegments.Count - 1)
            continue
        }
        [void]$baseSegments.Add($segment)
    }
    if ($baseSegments.Count -eq 0) {
        throw "Bundle reference resolves to the package root: $SourcePath -> $Reference"
    }
    return [string]::Join('/', $baseSegments)
}

function Assert-FileExists([System.Collections.Generic.HashSet[string]]$Files, [string]$RelativePath) {
    if (-not $Files.Contains($RelativePath)) {
        throw "CCX is missing required runtime content: $RelativePath"
    }
}

function Get-RelativeVerificationPath([string]$FullName) {
    $prefix = $destinationFull.TrimEnd('\') + '\'
    if (-not $FullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Extracted file escaped the verification directory: $FullName"
    }
    return $FullName.Substring($prefix.Length).Replace('\', '/')
}

function Assert-X64Dll([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 128 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw 'The canonical native addon is not a valid PE image.'
    }
    $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -lt 0x40 -or $peOffset -gt ($bytes.Length - 24) -or
        [System.BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x00004550) {
        throw 'The canonical native addon has an invalid PE header.'
    }
    $machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
    $characteristics = [System.BitConverter]::ToUInt16($bytes, $peOffset + 22)
    if ($machine -ne 0x8664 -or ($characteristics -band 0x2000) -eq 0) {
        throw 'The canonical native addon must be a Windows x64 DLL.'
    }
}

try {
    $ccxFull = [System.IO.Path]::GetFullPath($CcxPath)
    if (-not (Test-Path -LiteralPath $ccxFull -PathType Leaf)) {
        throw "CCX does not exist: $ccxFull"
    }
    if ([System.IO.Path]::GetExtension($ccxFull) -ine '.ccx') {
        throw 'The verification input must use the .ccx extension.'
    }
    $ccxItem = Get-Item -LiteralPath $ccxFull -Force
    if (Test-IsReparsePoint $ccxItem) {
        throw 'CCX verification refuses a reparse-point input.'
    }
    if ($ccxItem.Length -le 0 -or $ccxItem.Length -gt $maximumArchiveBytes) {
        throw "CCX size is outside the supported verification bounds (1-$maximumArchiveBytes bytes)."
    }

    Assert-NoReparseAncestors $verificationRoot
    [System.IO.Directory]::CreateDirectory($verificationRoot) | Out-Null
    if ($ccxFull.StartsWith($verificationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'CCX input must remain outside the verifier extraction tree.'
    }

    $ccxHash = Get-Sha256Hex $ccxFull
    $slug = [regex]::Replace([System.IO.Path]::GetFileNameWithoutExtension($ccxFull), '[^A-Za-z0-9._-]+', '-')
    $slug = $slug.Trim('.', '-', '_')
    if (-not $slug) { $slug = 'oracle-private' }
    if ($slug.Length -gt 48) { $slug = $slug.Substring(0, 48) }
    $destinationFull = [System.IO.Path]::GetFullPath((Join-Path $verificationRoot ($slug + '-' + $ccxHash.Substring(0, 12))))
    if (-not $destinationFull.StartsWith($verificationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Computed CCX verification destination escaped its confined root.'
    }
    Remove-ConfinedVerificationDirectory $destinationFull
    [System.IO.Directory]::CreateDirectory($destinationFull) | Out-Null

    Add-Type -AssemblyName System.IO.Compression
    $archiveStream = [System.IO.File]::Open($ccxFull, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $archive = [System.IO.Compression.ZipArchive]::new(
        $archiveStream,
        [System.IO.Compression.ZipArchiveMode]::Read,
        $false
    )
    if ($archive.Entries.Count -eq 0 -or $archive.Entries.Count -gt $maximumEntries) {
        throw "CCX entry count is outside the supported verification bounds (1-$maximumEntries)."
    }

    $archiveFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $seenEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $entryPlans = [System.Collections.Generic.List[object]]::new()
    [long]$totalExtractedBytes = 0
    foreach ($entry in $archive.Entries) {
        $isDirectory = $entry.FullName.EndsWith('/')
        $normalized = Assert-SafeArchivePath $entry.FullName $isDirectory
        if (-not $seenEntries.Add($normalized)) {
            throw "CCX contains duplicate or case-colliding entries: $($entry.FullName)"
        }

        $external = [System.BitConverter]::ToUInt32(
            [System.BitConverter]::GetBytes([int]$entry.ExternalAttributes),
            0
        )
        $unixType = (($external -shr 16) -band 0xF000)
        $dosAttributes = ($external -band 0xFFFF)
        if (($dosAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($unixType -ne 0 -and $unixType -ne 0x8000 -and -not ($isDirectory -and $unixType -eq 0x4000))) {
            throw "CCX contains a link, reparse point, or unexpected entry type: $($entry.FullName)"
        }
        if (-not $isDirectory -and $unixType -eq 0x4000) {
            throw "CCX file entry is marked as a directory: $($entry.FullName)"
        }

        if ($isDirectory) {
            continue
        }
        if ($entry.Length -lt 0 -or $entry.Length -gt $maximumEntryBytes) {
            throw "CCX entry exceeds the per-file extraction bound: $($entry.FullName)"
        }
        $totalExtractedBytes += $entry.Length
        if ($totalExtractedBytes -gt $maximumExtractedBytes) {
            throw 'CCX exceeds the total extraction bound.'
        }
        [void]$archiveFiles.Add($normalized)
        [void]$entryPlans.Add([pscustomobject]@{ Entry = $entry; RelativePath = $normalized })
    }

    foreach ($required in @('manifest.json', 'index.html', 'PRIVATE_LOCAL_ACCEPTANCE_ONLY.txt', 'PRIVATE_LOCAL_INVENTORY.json', 'win/x64/oracle-native-drag.uxpaddon')) {
        Assert-FileExists $archiveFiles $required
    }
    foreach ($required in $requiredStyles + $requiredModules + $requiredAssets + $requiredRuntimeFiles) {
        Assert-FileExists $archiveFiles $required
    }

    foreach ($plan in $entryPlans) {
        $target = [System.IO.Path]::GetFullPath((Join-Path $destinationFull $plan.RelativePath.Replace('/', '\')))
        $destinationPrefix = $destinationFull.TrimEnd('\') + '\'
        if (-not $target.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "CCX extraction target escaped its confined directory: $($plan.RelativePath)"
        }
        $targetDirectory = Split-Path -Parent $target
        [System.IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
        $inputStream = $null
        $outputStream = $null
        try {
            $inputStream = $plan.Entry.Open()
            $outputStream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $inputStream.CopyTo($outputStream)
        } finally {
            if ($outputStream) { $outputStream.Dispose() }
            if ($inputStream) { $inputStream.Dispose() }
        }
        $written = Get-Item -LiteralPath $target -Force
        if (Test-IsReparsePoint $written -or $written.Length -ne $plan.Entry.Length) {
            throw "Extracted CCX entry failed integrity checks: $($plan.RelativePath)"
        }
    }

    $manifestPath = Join-Path $destinationFull 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.manifestVersion -ne 6 -or $manifest.id -cne 'com.blocky.oracle.v5' -or
        $manifest.main -cne 'index.html' -or $manifest.host -is [System.Array] -or
        $manifest.host.app -cne 'premierepro' -or $manifest.host.minVersion -cne '26.3.0' -or
        $manifest.addon.name -cne 'oracle-native-drag.uxpaddon') {
        throw 'CCX manifest is not the canonical Blocky Studios Premiere manifest v6.'
    }
    Assert-ExactPropertyNames $manifest.requiredPermissions @('localFileSystem', 'enableAddon', 'ipc', 'network') 'requiredPermissions'
    Assert-ExactPropertyNames $manifest.requiredPermissions.ipc @('enablePluginCommunication') 'requiredPermissions.ipc'
    Assert-ExactPropertyNames $manifest.requiredPermissions.network @('domains') 'requiredPermissions.network'
    $networkDomains = $manifest.requiredPermissions.network.domains
    if ($manifest.requiredPermissions.localFileSystem -cne 'fullAccess' -or
        $manifest.requiredPermissions.enableAddon -ne $true -or
        $manifest.requiredPermissions.ipc.enablePluginCommunication -ne $true -or
        -not ($networkDomains -is [string]) -or $networkDomains -cne 'all') {
        throw 'CCX manifest requiredPermissions contract is not the exact private-local Blocky Studios contract.'
    }

    $entrypointIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $panels = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $commands = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($entrypoint in @($manifest.entrypoints)) {
        if (-not $entrypoint.id -or -not $entrypointIds.Add([string]$entrypoint.id)) {
            throw 'CCX manifest contains a missing or duplicate entrypoint ID.'
        }
        if ($entrypoint.type -ceq 'panel') {
            [void]$panels.Add([string]$entrypoint.id)
        } elseif ($entrypoint.type -ceq 'command') {
            [void]$commands.Add([string]$entrypoint.id)
        } else {
            throw "CCX manifest contains an unsupported entrypoint type: $($entrypoint.type)"
        }
    }
    if ($entrypointIds.Count -ne 5 -or $panels.Count -ne 4 -or $commands.Count -ne 1 -or
        -not $commands.Contains($requiredCommand)) {
        throw 'CCX manifest must contain exactly four Blocky Studios panels and the Quick Apply command.'
    }
    foreach ($panel in $requiredPanels) {
        if (-not $panels.Contains($panel)) {
            throw "CCX manifest is missing required panel entrypoint: $panel"
        }
    }

    $htmlPath = Join-Path $destinationFull 'index.html'
    $html = Get-Content -LiteralPath $htmlPath -Raw
    $htmlReferences = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($match in [regex]::Matches($html, '(?i)(?:src|href)\s*=\s*["'']([^"''?#]+)(?:[?#][^"'']*)?["'']')) {
        $resolved = Resolve-BundleReference 'index.html' $match.Groups[1].Value
        Assert-FileExists $archiveFiles $resolved
        [void]$htmlReferences.Add($resolved)
    }
    foreach ($requiredReference in $requiredStyles + $requiredModules) {
        if (-not $htmlReferences.Contains($requiredReference)) {
            throw "CCX index does not load required runtime content: $requiredReference"
        }
    }
    $sourceStylePattern = '^(?:style\.css|styles/)'
    foreach ($reference in $htmlReferences) {
        if ($reference -match $sourceStylePattern) {
            throw "CCX index loads authored source CSS instead of the generated runtime stylesheet: $reference"
        }
    }
    foreach ($sourceStyle in @(
        'style.css',
        'styles/overdrive-m1.css',
        'styles/overdrive-m2.css',
        'styles/overdrive-m3.css',
        'styles/overdrive-m4.css',
        'styles/overdrive-m5.css',
        'styles/overdrive-m6.css',
        'styles/overdrive-m7.css',
        'styles/blocky-studios.css'
    )) {
        if ($archiveFiles.Contains($sourceStyle)) {
            throw "CCX contains generated-source CSS that must not ship: $sourceStyle"
        }
    }

    foreach ($cssRelative in $requiredStyles) {
        $css = Get-Content -LiteralPath (Join-Path $destinationFull $cssRelative.Replace('/', '\')) -Raw
        foreach ($match in [regex]::Matches($css, '(?i)url\(\s*["'']?([^\)"'']+)')) {
            $rawReference = $match.Groups[1].Value.Trim()
            if ($rawReference.StartsWith('data:', [System.StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            $resolved = Resolve-BundleReference $cssRelative $rawReference
            Assert-FileExists $archiveFiles $resolved
        }
    }

    $textExtensions = @('.json', '.html', '.js', '.css', '.svg', '.txt')
    $privateContentPattern = '(?i)(?:[A-Z]:[\\/]+(?:Users|Documents and Settings)[\\/]+|[A-Z]:[\\/]+Blocky HQ[\\/]+|\\\\[^\\/\s]+[\\/]+(?:Users|home)[\\/]+|file:///+[A-Z]:/Users/|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)'
    foreach ($file in Get-ChildItem -LiteralPath $destinationFull -Recurse -File -Force) {
        if (Test-IsReparsePoint $file) {
            throw "Extracted CCX contains a reparse point: $($file.FullName)"
        }
        if ($textExtensions -contains $file.Extension) {
            if ($file.Length -gt $maximumTextBytes) {
                throw "Text asset exceeds the verification bound: $(Get-RelativeVerificationPath $file.FullName)"
            }
            $text = Get-Content -LiteralPath $file.FullName -Raw
            if ($text -match $privateContentPattern) {
                throw "CCX contains a private absolute path or private key: $(Get-RelativeVerificationPath $file.FullName)"
            }
        }
    }

    $noticePath = Join-Path $destinationFull 'PRIVATE_LOCAL_ACCEPTANCE_ONLY.txt'
    $notice = Get-Content -LiteralPath $noticePath -Raw
    if ($notice -notmatch '(?i)PRIVATE LOCAL ACCEPTANCE ONLY' -or
        $notice -notmatch '(?i)DO NOT DISTRIBUTE' -or
        $notice -notmatch '(?i)font' -or $notice -notmatch '(?i)artwork') {
        throw 'CCX is missing the complete private-local distribution notice.'
    }

    $addonRelative = 'win/x64/oracle-native-drag.uxpaddon'
    $addonPath = Join-Path $destinationFull $addonRelative.Replace('/', '\')
    Assert-X64Dll $addonPath
    $addons = @(Get-ChildItem -LiteralPath $destinationFull -Recurse -File -Filter '*.uxpaddon' -Force)
    if ($addons.Count -ne 1 -or (Get-RelativeVerificationPath $addons[0].FullName) -cne $addonRelative) {
        throw 'CCX must contain exactly one canonical Windows x64 native addon.'
    }
    $addonHash = Get-Sha256Hex $addonPath

    $inventoryPath = Join-Path $destinationFull 'PRIVATE_LOCAL_INVENTORY.json'
    $inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
    if ($inventory.schema -cne 'com.blocky.oracle.private-ccx-inventory' -or
        $inventory.version -ne 2 -or $inventory.releaseEligible -ne $false -or
        $inventory.pluginId -cne $manifest.id -or $inventory.pluginVersion -cne $manifest.version -or
        $inventory.distribution -notmatch '(?i)PRIVATE LOCAL ACCEPTANCE ONLY') {
        throw 'CCX private inventory metadata is invalid or inconsistent with the manifest.'
    }
    if ($inventory.nativeAddon.path -cne $addonRelative -or
        [long]$inventory.nativeAddon.size -ne (Get-Item -LiteralPath $addonPath).Length -or
        [string]$inventory.nativeAddon.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
        -not ([string]$inventory.nativeAddon.sha256).Equals($addonHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'CCX native addon size or SHA-256 does not match the private inventory.'
    }
    $blockerText = [string]::Join(' ', @($inventory.blockers | ForEach-Object { [string]$_ }))
    if ($blockerText -notmatch '(?i)font' -or $blockerText -notmatch '(?i)(?:logo|icon|artwork)' -or
        $blockerText -notmatch '(?i)(?:version|semantic)') {
        throw 'CCX private inventory does not preserve all known distribution blockers.'
    }

    $inventoryFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($record in @($inventory.files)) {
        Assert-ExactPropertyNames $record @('path', 'size', 'sha256') 'private inventory file record'
        $recordPath = Assert-SafeArchivePath ([string]$record.path) $false
        if ($recordPath -ceq 'PRIVATE_LOCAL_INVENTORY.json' -or -not $inventoryFiles.Add($recordPath)) {
            throw "CCX private inventory contains a duplicate or self-referential file: $recordPath"
        }
        Assert-FileExists $archiveFiles $recordPath
        $recordFile = Get-Item -LiteralPath (Join-Path $destinationFull $recordPath.Replace('/', '\')) -Force
        if ([long]$record.size -ne $recordFile.Length) {
            throw "CCX private inventory size mismatch: $recordPath"
        }
        $recordHash = Get-Sha256Hex $recordFile.FullName
        if ([string]$record.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
            -not ([string]$record.sha256).Equals($recordHash, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "CCX private inventory SHA-256 mismatch: $recordPath"
        }
    }
    $expectedInventoryCount = $archiveFiles.Count - 1
    if ($inventoryFiles.Count -ne $expectedInventoryCount) {
        throw 'CCX private inventory does not describe every packaged file exactly once.'
    }
    foreach ($relativePath in $archiveFiles) {
        if ($relativePath -cne 'PRIVATE_LOCAL_INVENTORY.json' -and -not $inventoryFiles.Contains($relativePath)) {
            throw "CCX private inventory omitted packaged file: $relativePath"
        }
    }

    $inventoryHash = Get-Sha256Hex $inventoryPath
    [pscustomobject]@{
        Verified = $true
        PrivateLocalAcceptance = $true
        ReleaseEligible = $false
        CcxPath = $ccxFull
        VerificationDirectory = $destinationFull
        PluginId = $manifest.id
        PluginVersion = $manifest.version
        EntryCount = $archiveFiles.Count
        CcxSHA256 = $ccxHash
        NativeAddonSHA256 = $addonHash
        InventorySHA256 = $inventoryHash
    } | ConvertTo-Json -Depth 4 -Compress
} catch {
    if ($destinationFull) {
        try {
            Remove-ConfinedVerificationDirectory $destinationFull
        } catch {
            Write-Error "CCX verification failed and confined cleanup also failed: $($_.Exception.Message)"
            exit 1
        }
    }
    Write-Error "CCX verification failed: $($_.Exception.Message)"
    exit 1
} finally {
    if ($archive) { $archive.Dispose() }
    if ($archiveStream) { $archiveStream.Dispose() }
}
