// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const source = fs.readFileSync(path.join(root, "release", "stage-private-ccx.ps1"), "utf8");
const verifierSource = fs.readFileSync(path.join(root, "release", "verify-private-ccx.ps1"), "utf8");
const installerSource = fs.readFileSync(path.join(root, "release", "install-private-ccx.ps1"), "utf8");
const buildSource = fs.readFileSync(path.join(root, "release", "build-ui.cjs"), "utf8");
const generatedCss = fs.readFileSync(path.join(root, "dist", "blocky-studios-ui.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function JavaScriptSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return JavaScriptSources(entryPath);
    return entry.isFile() && /\.js$/i.test(entry.name) ? [fs.readFileSync(entryPath, "utf8")] : [];
  });
}

function readPowerShellArray(scriptSource, variableName) {
  const match = scriptSource.match(new RegExp(`\\$${variableName}\\s*=\\s*@\\(([\\s\\S]*?)\\r?\\n\\)`));
  assert.ok(match, `missing PowerShell array ${variableName}`);
  return Array.from(match[1].matchAll(/'([^']+)'/g), (entry) => entry[1]);
}

test("M9 package staging is explicit private-local acceptance and public release fails closed", () => {
  assert.match(source, /\[switch\]\$PrivateLocalAcceptance/);
  assert.match(source, /if \(-not \$PrivateLocalAcceptance\)\s*\{[\s\S]*redistribution rights are not documented/);
  assert.match(source, /PRIVATE LOCAL ACCEPTANCE ONLY - DO NOT DISTRIBUTE/);
  assert.match(source, /releaseEligible = \$false/);
  assert.match(packageJson.scripts["release:stage:private"], /stage-private-ccx\.ps1 -PrivateLocalAcceptance$/);
  assert.match(installerSource, /Get-Process -Name 'Adobe Premiere Pro'/);
  assert.match(installerSource, /\/remove \$quotedName/);
  assert.match(installerSource, /retained the old Blocky Studios payload/);
});

test("M9 stages one exact file allowlist and excludes unused modules", () => {
  assert.match(source, /foreach \(\$file in \$requiredBundleFiles\)/);
  assert.match(source, /\$allowedStagedPaths\.Contains\(\$relativePath\)/);
  assert.match(source, /Unexpected file outside the exact release allowlist/);
  assert.doesNotMatch(source, /Copy-ReleaseDirectory/);
  assert.doesNotMatch(source, /src\/core\/feature-flags\.js/);
  assert.deepEqual(readPowerShellArray(source, "requiredStyles"), ["dist/blocky-studios-ui.css"]);
  assert.match(source, /src\/generated\/oracle-build-info\.js/);
  assert.match(source, /src\/core\/oracle-ui-runtime\.js/);
  assert.doesNotMatch(readPowerShellArray(source, "requiredStyles").join("\n"), /(?:^|\/)style\.css$|^styles\//);

  for (const variableName of ["requiredStyles", "requiredModules", "requiredAssets", "requiredRuntimeFiles"]) {
    assert.deepEqual(
      readPowerShellArray(source, variableName),
      readPowerShellArray(verifierSource, variableName),
      `${variableName} must stay identical in staging and verification`,
    );
  }
});

test("M9 compiles CSS fonts and keeps packaged icons as observable DOM assets", () => {
  assert.match(buildSource, /return `plugin:\/\/\$\{pluginRelative\}\$\{suffix\}`/);
  const references = Array.from(
    generatedCss.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi),
    (match) => match[1],
  );
  assert.ok(references.length >= 3, "all packaged font faces remain referenced");
  assert.ok(references.every((reference) => reference.startsWith("plugin://")));
  assert.doesNotMatch(generatedCss, /url\([^)]*assets\/icons\//i);
  const runtimeSources = [indexHtml, fs.readFileSync(path.join(root, "main.js"), "utf8"), ...JavaScriptSources(path.join(root, "src"))].join("\n");
  const requiredIcons = readPowerShellArray(source, "requiredAssets").filter((asset) => asset.startsWith("assets/icons/"));
  assert.ok(requiredIcons.length >= 20, "the complete packaged icon set remains staged");
  for (const icon of requiredIcons) {
    assert.ok(runtimeSources.includes(icon), `${icon} must be referenced by observable HTML or runtime-created img markup`);
  }
});

test("M9 staging verifies one canonical addon, hashes, references, reparse points, and private paths", () => {
  assert.match(source, /\$addons\.Count -ne 1/);
  assert.match(source, /oracle-native-drag\.uxpaddon/);
  assert.match(source, /System\.Security\.Cryptography\.SHA256[\s\S]*ComputeHash/);
  assert.match(source, /ReparsePoint/);
  assert.match(source, /function Assert-NoReparseSourcePath/);
  assert.match(source, /Assert-NoReparseSourcePath \$Path/);
  assert.match(source, /function Remove-ConfinedStageDirectory/);
  assert.match(source, /Refusing to remove a staging tree containing a reparse point/);
  assert.match(source, /Remove-ConfinedStageDirectory \$destinationFull/);
  assert.match(source, /Release staging copy hash mismatch/);
  assert.match(source, /Staged HTML reference is missing/);
  assert.match(source, /Staged stylesheet reference (?:escapes the package|is missing)/);
  assert.match(source, /assets\/logo\/blocky-studios-light-mode\.png/);
  assert.match(source, /assets\/logo\/blocky-studios-dark-mode\.png/);
  assert.match(source, /dist\/blocky-studios-ui\.css/);
  assert.match(source, /Invoke-ReleaseNodeScript 'release\\build-ui\.cjs'/);
  assert.match(source, /Invoke-ReleaseNodeScript 'release\\generate-ui-build\.cjs'/);
  assert.match(verifierSource, /generated-source CSS that must not ship/);
  assert.match(source, /assets\/fonts\/samsung_sharp_sans_regular\.otf/);
  assert.match(source, /assets\/fonts\/samsung_sharp_sans_medium\.otf/);
  assert.match(source, /assets\/fonts\/samsung_sharp_sans_bold\.otf/);
  for (const icon of [
    "add", "apply", "close", "curves", "favorite", "loop", "menu", "muted", "pause", "play",
    "quick-apply", "refresh", "reorder", "replays", "search", "settings", "step-back", "step-forward",
    "stop", "subtract", "volume",
  ]) {
    assert.match(source, new RegExp(`assets/icons/${icon.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.png`));
  }
  assert.match(source, /win\/x64\/media\/ffmpeg\.exe/);
  assert.match(source, /THIRD_PARTY_NOTICES\.txt/);
  assert.match(source, /freshly staged native runtime/);
  assert.match(source, /private absolute user path entered/i);
  assert.match(source, /PRIVATE_LOCAL_INVENTORY\.json/);
  assert.match(source, /native\\build\\stage\\win\\x64\\oracle-native-drag\.uxpaddon/);
  assert.match(source, /\$sourceHash -ne \$builtHash/);
  assert.match(source, /does not match the freshly built Release addon/);
  assert.match(source, /version = 2/);
  assert.match(source, /sha256 = Get-Sha256Hex \$_\.FullName/);
  assert.match(verifierSource, /private inventory SHA-256 mismatch/);
});

test("M9 staging enforces the exact private-local manifest contract", () => {
  assert.match(source, /manifest\.host\.minVersion -cne '26\.3\.0'/);
  assert.match(source, /Assert-ExactPropertyNames \$manifest\.requiredPermissions @\('localFileSystem', 'enableAddon', 'ipc', 'network'\)/);
  assert.match(source, /requiredPermissions\.ipc @\('enablePluginCommunication'\)/);
  assert.match(source, /requiredPermissions\.network @\('domains'\)/);
  assert.match(source, /localFileSystem -cne 'fullAccess'/);
  assert.match(source, /enablePluginCommunication -ne \$true/);
  assert.match(source, /networkDomains -is \[string\]/);
  assert.match(source, /networkDomains -cne 'all'/);
});
