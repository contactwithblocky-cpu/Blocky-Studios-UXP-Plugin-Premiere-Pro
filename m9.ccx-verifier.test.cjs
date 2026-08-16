// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = __dirname;
const verifierPath = path.join(root, "release", "verify-private-ccx.ps1");
const verificationRoot = path.resolve(root, "native", "build", "ccx-verify");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-m9-ccx-verifier-"));
const extracted = new Set();

const requiredStyles = [
  "dist/blocky-studios-ui.css",
];
const requiredModules = [
  "main.js",
  "src/generated/oracle-build-info.js",
  "src/core/oracle-platform-telemetry.js",
  "src/core/oracle-ui-runtime.js",
  "src/core/oracle-diagnostics.js",
  "src/app/oracle-shell.js",
  "src/app/oracle-panel-dom.js",
  "src/app/oracle-runtime-registry.js",
  "src/settings/oracle-preferences.js",
  "src/data/oracle-data-schema.js",
  "src/data/oracle-migrations.js",
  "src/replays/oracle-replay-library.js",
  "src/replays/oracle-replay-media.js",
  "src/replays/oracle-replay-workspace.js",
  "src/replays/oracle-replay-organization.js",
  "src/replays/oracle-replay-lifecycle-ui.js",
  "src/replays/oracle-replay-viewer.js",
  "src/curves/oracle-curve-math.js",
  "src/curves/oracle-curve-presets.js",
  "src/curves/oracle-premiere-curves-adapter.js",
  "src/curves/oracle-curves-workspace.js",
  "src/quick-apply/oracle-effect-index.js",
  "src/quick-apply/oracle-premiere-effects-adapter.js",
  "src/quick-apply/oracle-quick-apply-domain.js",
  "src/quick-apply/oracle-quick-apply-workspace.js",
];
const requiredAssets = [
  "assets/fonts/samsung_sharp_sans_regular.otf",
  "assets/fonts/samsung_sharp_sans_medium.otf",
  "assets/fonts/samsung_sharp_sans_bold.otf",
  "assets/icons/add.png",
  "assets/icons/apply.png",
  "assets/icons/close.png",
  "assets/icons/curves.png",
  "assets/icons/favorite.png",
  "assets/icons/loop.png",
  "assets/icons/menu.png",
  "assets/icons/muted.png",
  "assets/icons/pause.png",
  "assets/icons/play.png",
  "assets/icons/quick-apply.png",
  "assets/icons/refresh.png",
  "assets/icons/reorder.png",
  "assets/icons/replays.png",
  "assets/icons/search.png",
  "assets/icons/settings.png",
  "assets/icons/step-back.png",
  "assets/icons/step-forward.png",
  "assets/icons/stop.png",
  "assets/icons/subtract.png",
  "assets/icons/volume.png",
  "assets/logo/blocky-studios-light-mode.png",
  "assets/logo/blocky-studios-dark-mode.png",
  "icons/dark.png",
  "icons/dark@1x.png",
  "icons/dark@2x.png",
  "icons/light.png",
  "icons/light@1x.png",
  "icons/light@2x.png",
  "icons/plugin-icon.png",
  "icons/plugin-icon@2x.png",
  "icons/plugin@1x.png",
  "icons/plugin@2x.png",
];
const requiredRuntimeFiles = [
  "win/x64/media/ffmpeg.exe",
  "win/x64/media/ffprobe.exe",
  "win/x64/media/avcodec-60.dll",
  "win/x64/media/avdevice-60.dll",
  "win/x64/media/avfilter-9.dll",
  "win/x64/media/avformat-60.dll",
  "win/x64/media/avutil-58.dll",
  "win/x64/media/swresample-4.dll",
  "win/x64/media/swscale-7.dll",
  "win/x64/media/THIRD_PARTY_NOTICES.txt",
];

function findPowerShell() {
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "pwsh.exe";
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeStoredZip(targetPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.externalAttributes ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(targetPath, Buffer.concat([...localParts, ...centralParts, end]));
}

function makeX64DllFixture() {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(0, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x2022, 0x96);
  return bytes;
}

function attachInventory(files) {
  const withoutInventory = new Map(files);
  withoutInventory.delete("PRIVATE_LOCAL_INVENTORY.json");
  const addon = withoutInventory.get("win/x64/oracle-native-drag.uxpaddon");
  const manifest = JSON.parse(withoutInventory.get("manifest.json").toString("utf8"));
  const inventory = {
    schema: "com.blocky.oracle.private-ccx-inventory",
    version: 2,
    releaseEligible: false,
    distribution: "PRIVATE LOCAL ACCEPTANCE ONLY - DO NOT DISTRIBUTE",
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    generatedAt: "2026-07-16T00:00:00.000Z",
    nativeAddon: {
      path: "win/x64/oracle-native-drag.uxpaddon",
      size: addon.length,
      sha256: crypto.createHash("sha256").update(addon).digest("hex").toUpperCase(),
    },
    files: [...withoutInventory.entries()]
      .map(([filePath, data]) => ({
        path: filePath,
        size: data.length,
        sha256: crypto.createHash("sha256").update(data).digest("hex").toUpperCase(),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    blockers: [
      "Font redistribution rights are undocumented.",
      "Blocky Studios logo and artwork rights are undocumented.",
      "Final semantic version requires confirmation.",
    ],
  };
  files.set("PRIVATE_LOCAL_INVENTORY.json", Buffer.from(JSON.stringify(inventory), "utf8"));
  return files;
}

function makeSafeFiles() {
  const files = new Map();
  const manifest = {
    manifestVersion: 6,
    id: "com.blocky.oracle.v5",
    name: "Blocky Studios",
    version: "2.0.18",
    main: "index.html",
    host: { app: "premierepro", minVersion: "26.3.0" },
    addon: { name: "oracle-native-drag.uxpaddon" },
    requiredPermissions: {
      localFileSystem: "fullAccess",
      enableAddon: true,
      ipc: { enablePluginCommunication: true },
      network: { domains: "all" },
    },
    entrypoints: [
      { id: "oraclePanel", type: "panel", label: { default: "Blocky Studios" } },
      { id: "oracleReplaysPanel", type: "panel", label: { default: "Blocky Studios Replays" } },
      { id: "oracleCurvesPanel", type: "panel", label: { default: "Blocky Studios Curves" } },
      { id: "oracleQuickApplyPanel", type: "panel", label: { default: "Blocky Studios Quick Apply" } },
      { id: "oracleQuickApplyCommand", type: "command", label: { default: "Open Blocky Studios Quick Apply" } },
    ],
  };
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  const html = [
    "<!doctype html><html><head>",
    ...requiredStyles.map((filePath) => `<link rel="stylesheet" href="${filePath}?m9-test">`),
    "</head><body><main id=\"oracleApp\"></main>",
    ...requiredModules.map((filePath) => `<script src="${filePath}?m9-test"></script>`),
    "</body></html>",
  ].join("\n");
  files.set("index.html", Buffer.from(html, "utf8"));
  for (const filePath of requiredStyles) {
    const content = [
      "@font-face { font-family: 'Samsung Sharp Sans'; src: url('plugin://assets/fonts/samsung_sharp_sans_regular.otf'); }",
      ".bs-icon--menu { background-image: url('plugin://assets/icons/menu.png'); }",
    ].join("\n");
    files.set(filePath, Buffer.from(content, "utf8"));
  }
  for (const filePath of requiredModules) {
    files.set(filePath, Buffer.from(`"use strict"; /* ${filePath} */`, "utf8"));
  }
  for (const filePath of requiredAssets) {
    let content = Buffer.from(`fixture:${filePath}`, "utf8");
    if (filePath.endsWith(".json")) content = Buffer.from("{}", "utf8");
    if (filePath.endsWith(".svg")) content = Buffer.from("<svg></svg>", "utf8");
    files.set(filePath, content);
  }
  for (const filePath of requiredRuntimeFiles) {
    files.set(filePath, Buffer.from(`runtime-fixture:${filePath}`, "utf8"));
  }
  files.set("win/x64/oracle-native-drag.uxpaddon", makeX64DllFixture());
  files.set(
    "PRIVATE_LOCAL_ACCEPTANCE_ONLY.txt",
    Buffer.from(
      "PRIVATE LOCAL ACCEPTANCE ONLY - DO NOT DISTRIBUTE\n" +
      "Packaged fonts and Blocky Studios artwork lack documented redistribution rights.\n",
      "utf8",
    ),
  );
  return attachInventory(files);
}

function entriesFromFiles(files, extras = []) {
  return [
    ...[...files.entries()].map(([name, data]) => ({ name, data })),
    ...extras,
  ];
}

function runVerifier(ccxPath) {
  return spawnSync(
    findPowerShell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", verifierPath, "-CcxPath", ccxPath],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
}

function parseVerification(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result = JSON.parse(lines.at(-1));
  const resolved = path.resolve(result.VerificationDirectory);
  assert.equal(resolved.startsWith(`${verificationRoot}${path.sep}`), true);
  extracted.add(resolved);
  return result;
}

test.after(() => {
  for (const directory of extracted) {
    if (directory.startsWith(`${verificationRoot}${path.sep}`)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("CCX verifier is fail-closed, confined, and validates the complete private bundle contract", () => {
  const source = fs.readFileSync(verifierPath, "utf8");
  assert.match(source, /native\\build\\ccx-verify/);
  assert.match(source, /ZipArchiveMode\]::Read/);
  assert.match(source, /ReparsePoint/);
  assert.match(source, /unsafe ZIP path segment/);
  assert.match(source, /maximumExtractedBytes/);
  assert.match(source, /manifestVersion -ne 6/);
  assert.match(source, /host\.minVersion -cne '26\.3\.0'/);
  assert.match(source, /Assert-ExactPropertyNames \$manifest\.requiredPermissions/);
  assert.match(source, /networkDomains -is \[string\]/);
  assert.match(source, /networkDomains -cne 'all'/);
  assert.match(source, /oracleQuickApplyCommand/);
  assert.match(source, /exactly four Blocky Studios panels/);
  assert.match(source, /win\/x64\/oracle-native-drag\.uxpaddon/);
  assert.match(source, /Windows x64 DLL/);
  assert.match(source, /PRIVATE_LOCAL_INVENTORY\.json/);
  assert.match(source, /private inventory SHA-256 mismatch/);
  assert.match(source, /dist\/blocky-studios-ui\.css/);
  assert.match(source, /src\/generated\/oracle-build-info\.js/);
  assert.match(source, /src\/core\/oracle-ui-runtime\.js/);
  assert.match(source, /generated-source CSS that must not ship/);
  assert.doesNotMatch(requiredStyles.join("\n"), /(?:^|\/)style\.css$|^styles\//);
  assert.match(source, /development-only content/);
  assert.match(source, /\$allowedArchiveFiles\.Contains\(\$normalized\)/);
  assert.match(source, /private absolute path or private key/);
  assert.doesNotMatch(source, /ExtractToDirectory/);
});

test("synthetic private-local CCX passes and reports package, inventory, and addon hashes", { skip: process.platform !== "win32" }, () => {
  const ccxPath = path.join(testRoot, "oracle-private-safe.ccx");
  const files = makeSafeFiles();
  writeStoredZip(ccxPath, entriesFromFiles(files));

  const result = runVerifier(ccxPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verified = parseVerification(result.stdout);
  assert.equal(verified.Verified, true);
  assert.equal(verified.PrivateLocalAcceptance, true);
  assert.equal(verified.ReleaseEligible, false);
  assert.equal(verified.PluginId, "com.blocky.oracle.v5");
  assert.equal(verified.PluginVersion, "2.0.18");
  assert.equal(verified.EntryCount, files.size);
  assert.match(verified.CcxSHA256, /^[A-F0-9]{64}$/);
  assert.match(verified.NativeAddonSHA256, /^[A-F0-9]{64}$/);
  assert.match(verified.InventorySHA256, /^[A-F0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(verified.VerificationDirectory, "manifest.json")), true);
});

test("synthetic zip-slip CCX is rejected before extraction and cannot escape", { skip: process.platform !== "win32" }, () => {
  const escapeName = `m9-ccx-escape-${process.pid}.txt`;
  const escapePath = path.join(verificationRoot, escapeName);
  fs.rmSync(escapePath, { force: true });
  const ccxPath = path.join(testRoot, "oracle-private-zipslip.ccx");
  writeStoredZip(
    ccxPath,
    entriesFromFiles(makeSafeFiles(), [{ name: `../${escapeName}`, data: "escape" }]),
  );

  const result = runVerifier(ccxPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /unsafe ZIP path segment|unsafe ZIP path/i);
  assert.equal(fs.existsSync(escapePath), false);
});

test("synthetic Unix symlink CCX entry is rejected as a reparse-equivalent", { skip: process.platform !== "win32" }, () => {
  const ccxPath = path.join(testRoot, "oracle-private-symlink.ccx");
  const entries = entriesFromFiles(makeSafeFiles());
  const fontEntry = entries.find(
    (entry) => entry.name === "assets/fonts/samsung_sharp_sans_regular.otf",
  );
  fontEntry.data = "../../outside.ttf";
  fontEntry.versionMadeBy = 0x0314;
  fontEntry.externalAttributes = 0xa1ff0000;
  writeStoredZip(ccxPath, entries);

  const result = runVerifier(ccxPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /link, reparse point, or unexpected entry type/i);
});

test("synthetic private-path payload is rejected inside an exact-allowlist runtime module", { skip: process.platform !== "win32" }, () => {
  const files = makeSafeFiles();
  files.set(
    "src/core/oracle-diagnostics.js",
    Buffer.from("const localPath = 'C:\\\\Users\\\\salim\\\\private-token.txt';", "utf8"),
  );
  attachInventory(files);
  const ccxPath = path.join(testRoot, "oracle-private-path-leak.ccx");
  writeStoredZip(ccxPath, entriesFromFiles(files));

  const result = runVerifier(ccxPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /private absolute path or private key/i);
});

test("synthetic same-size post-inventory drift is rejected by per-file SHA-256", { skip: process.platform !== "win32" }, () => {
  const files = makeSafeFiles();
  const target = "src/core/oracle-diagnostics.js";
  const tampered = Buffer.from(files.get(target));
  tampered[0] = tampered[0] === 0x22 ? 0x27 : 0x22;
  assert.equal(tampered.length, files.get(target).length);
  files.set(target, tampered);
  const ccxPath = path.join(testRoot, "oracle-private-same-size-drift.ccx");
  writeStoredZip(ccxPath, entriesFromFiles(files));

  const result = runVerifier(ccxPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /private inventory SHA-256 mismatch/i);
});

test("synthetic development-only module is rejected from the release bundle", { skip: process.platform !== "win32" }, () => {
  const ccxPath = path.join(testRoot, "oracle-private-development-file.ccx");
  writeStoredZip(
    ccxPath,
    entriesFromFiles(makeSafeFiles(), [{
      name: "src/core/oracle-release.test.js",
      data: "throw new Error('test-only');",
    }]),
  );

  const result = runVerifier(ccxPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /development-only content/i);
});

test("synthetic ordinary extra module is rejected by the exact file allowlist", { skip: process.platform !== "win32" }, () => {
  const files = makeSafeFiles();
  files.set("src/core/oracle-extra.js", Buffer.from('"use strict";', "utf8"));
  attachInventory(files);
  const ccxPath = path.join(testRoot, "oracle-private-extra-module.ccx");
  writeStoredZip(ccxPath, entriesFromFiles(files));

  const result = runVerifier(ccxPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /unexpected or disallowed file/i);
});

test("synthetic permission and host drift are rejected from the exact manifest contract", { skip: process.platform !== "win32" }, () => {
  const cases = [
    ["missing-filesystem", (manifest) => { delete manifest.requiredPermissions.localFileSystem; }],
    ["array-network", (manifest) => { manifest.requiredPermissions.network.domains = ["ws://127.0.0.1"]; }],
    ["wrong-network-scalar", (manifest) => { manifest.requiredPermissions.network.domains = "ws://127.0.0.1"; }],
    ["extra-permission", (manifest) => { manifest.requiredPermissions.clipboard = "read"; }],
    ["host-version", (manifest) => { manifest.host.minVersion = "26.2.0"; }],
  ];

  for (const [name, mutate] of cases) {
    const files = makeSafeFiles();
    const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
    mutate(manifest);
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
    attachInventory(files);
    const ccxPath = path.join(testRoot, `oracle-private-${name}.ccx`);
    writeStoredZip(ccxPath, entriesFromFiles(files));

    const result = runVerifier(ccxPath);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /requiredPermissions|canonical Blocky Studios Premiere manifest/i,
      `${name} did not fail at the manifest contract`,
    );
  }
});
