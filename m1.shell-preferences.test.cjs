"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const shellApi = require("./src/app/oracle-shell.js");
const preferencesApi = require("./src/settings/oracle-preferences.js");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles", "overdrive-m1.css"), "utf8");
const blockyCss = fs.readFileSync(path.join(root, "styles", "blocky-studios.css"), "utf8");
const m6Css = fs.readFileSync(path.join(root, "styles", "overdrive-m6.css"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preferencesSource = fs.readFileSync(
  path.join(root, "src", "settings", "oracle-preferences.js"),
  "utf8",
);

class MemoryStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function assertReferenceRoleContrast(appearance) {
  const report = preferencesApi.themeContrastReport(appearance);
  const persistentSurfaceRoles = ["background", "header", "surface", "raised"];
  for (const theme of Object.values(report.themes)) {
    for (const [role, ratio] of Object.entries(theme.textRatios)) {
      assert.ok(ratio >= 4.5, `${theme.mode} primary text is readable on ${role}`);
    }
    for (const role of persistentSurfaceRoles) {
      assert.ok(theme.mutedRatios[role] >= 4.5, `${theme.mode} secondary text is readable on ${role}`);
      assert.ok(theme.focusRatios[role] >= 3, `${theme.mode} focus is visible against the owning ${role}`);
    }
    assert.ok(theme.controlText >= 4.5, `${theme.mode} control text remains readable`);
    assert.ok(theme.accentContrast >= 1.5, `${theme.mode} accent remains distinguishable`);
  }
  return report;
}

test("M1 preferences defaults cover every product section with destructive behavior off", () => {
  const defaults = preferencesApi.createDefaultPreferences();
  assert.equal(defaults.schema, preferencesApi.PREFERENCES_SCHEMA);
  assert.equal(defaults.version, preferencesApi.PREFERENCES_VERSION);
  assert.deepEqual(
    Object.keys(defaults),
    ["schema", "version", "profile", "appearance", "replay", "curves", "quickApply"],
  );
  assert.equal(defaults.replay.deleteFromDisk, false);
  assert.equal(defaults.quickApply.experimentalEnabled, false);
  assert.equal(defaults.quickApply.grouping, "type");
  assert.match(html, /data-pref="quickApply\.grouping"[^>]*>[\s\S]*?value="type"[\s\S]*?value="category"[\s\S]*?value="none"/);
  assert.equal(
    preferencesApi.normalizePreferences({ quickApply: { experimentalEnabled: true } }).quickApply.experimentalEnabled,
    false,
    "legacy experimental state remains schema-compatible but cannot enable unsupported behavior",
  );
  assert.equal(defaults.appearance.reducedMotion, "system");
  assert.equal(defaults.appearance.theme, "dark");
  assert.equal(defaults.appearance.accent, "#2167E8");
  assert.equal(defaults.appearance.background, "#111318");
  assert.equal(defaults.appearance.lightBackground, "#F5F3EE");
  assert.equal(defaults.curves.gridColor, "#343840");
  assert.equal(defaults.curves.curveColor, "#2167E8");
  assert.match(html, /data-color-token="curves\.gridColor"/);
  assert.match(html, /data-color-token="curves\.curveColor"/);
  assert.match(html, /data-curves-contrast-status/);
  assertReferenceRoleContrast(defaults.appearance);
});

test("corrupt settings recover safely and legacy theme/grid values migrate once", () => {
  const corrupt = new preferencesApi.PreferencesRepository(new MemoryStorage({
    [preferencesApi.PREFERENCES_STORAGE_KEY]: "{broken-json",
  })).load();
  assert.deepEqual(corrupt, preferencesApi.createDefaultPreferences());

  const storage = new MemoryStorage({
    "oracle.themePreferences.v1": JSON.stringify({
      outlineColor: "#123abc",
      backgroundColor: "#202020",
    }),
    "oracle.gridColumns.v2": "6",
  });
  const migrated = new preferencesApi.PreferencesRepository(storage).load();
  assert.equal(migrated.appearance.accent, "#123ABC");
  assert.equal(migrated.appearance.background, "#202020");
  assert.equal(migrated.replay.gridColumns, 6);
});

test("saved preferences survive restart and validation rejects unsafe contrast", () => {
  const storage = new MemoryStorage();
  const first = new preferencesApi.PreferencesRepository(storage);
  const values = preferencesApi.createDefaultPreferences();
  values.profile.displayName = "Blocky Editor";
  values.replay.gridColumns = 5;
  values.appearance.accent = "#FF44CC";
  first.save(values);
  const restarted = new preferencesApi.PreferencesRepository(storage).load();
  assert.equal(restarted.profile.displayName, "Blocky Editor");
  assert.equal(restarted.replay.gridColumns, 5);
  assert.equal(restarted.appearance.accent, "#FF44CC");

  restarted.appearance.background = "#111111";
  restarted.appearance.focus = "#121212";
  assert.throws(() => first.save(restarted), /Focus color needs at least 3:1 contrast/);
});

test("header grid changes commit through the same versioned Preferences repository", () => {
  assert.match(mainSource, /new GridScaleControl\([\s\S]*commitExternal\("replay\.gridColumns", columns\)/);
  assert.match(preferencesSource, /commitExternal\(path, value\)[\s\S]*this\.repository\.save\(next\)/);
  assert.match(preferencesSource, /exportable\.replay\.roots = \[\]/);
  assert.match(preferencesSource, /exportable\.replay\.relinkRoots = \[\]/);
  assert.match(html, /data-replay-watcher-status/);
  assert.match(html, /data-relink-roots/);
  assert.match(html, /data-preferences-action="add-relink-root"/);
  assert.match(preferencesSource, /remove-relink-root/);
});

test("Data and Diagnostics exposes versioned metadata import, export, and confirmed reset without hiding private-path scope", () => {
  assert.match(html, /data-preferences-action="import-metadata"/);
  assert.match(html, /data-preferences-action="export-metadata"/);
  assert.match(html, /metadata exports include replay source paths/i);
  assert.match(html, /never include media, thumbnail image bytes, or avatar bytes/i);
  assert.match(preferencesSource, /METADATA_IMPORT_MAX_CHARACTERS\s*=\s*32 \* 1024 \* 1024/);
  assert.match(preferencesSource, /this\.onExportMetadata/);
  assert.match(preferencesSource, /this\.onImportMetadata/);
  assert.match(preferencesSource, /this\.onResetMetadata/);
  assert.match(preferencesSource, /Replay metadata exceeds the 32 MB import limit/);
  assert.match(preferencesSource, /This metadata action did not delete source media/);
  assert.doesNotMatch(preferencesSource, /thumbnail image files were not deleted/i);
  assert.match(preferencesSource, /section === "data"[\s\S]*Reset Blocky Studios metadata after an explicit confirmation/);
});

test("malformed settings and metadata picker input remains transactional and restores the Preferences busy state", async () => {
  const createController = (text, overrides = {}) => {
    const committed = preferencesApi.createDefaultPreferences();
    const calls = { busy: [], errors: [], imported: 0, sections: [] };
    const controller = Object.assign(
      Object.create(preferencesApi.OraclePreferencesController.prototype),
      {
        isOpen: true,
        committing: false,
        destroyed: false,
        started: true,
        operationGeneration: 0,
        activeSection: "data",
        committed,
        draft: JSON.parse(JSON.stringify(committed)),
        chooseEntry: async () => ({ size: Buffer.byteLength(text, "utf8") }),
        readTextEntry: async () => text,
        writeTextEntry: async () => undefined,
        onImportMetadata: async () => { calls.imported += 1; return {}; },
        onToast() {},
        setBusy(value) { calls.busy.push(Boolean(value)); },
        showSection(section) { calls.sections.push(section); },
        showError(message) { calls.errors.push(String(message)); },
        updateStorageSummary() {},
        updateDiagnosticsSummary() {},
        syncAllControls() {},
        preview() {},
      },
      overrides,
    );
    return { controller, committed, calls };
  };

  const malformedSettings = createController("{broken-json");
  const beforeSettings = JSON.stringify(malformedSettings.controller.draft);
  await malformedSettings.controller.performAction("import-settings");
  assert.equal(JSON.stringify(malformedSettings.controller.draft), beforeSettings);
  assert.equal(malformedSettings.calls.imported, 0);
  assert.match(malformedSettings.calls.errors.at(-1), /JSON|Unexpected|property name/i);

  const malformedMetadata = createController("{broken-json");
  const beforeMetadata = JSON.stringify(malformedMetadata.controller.draft);
  await malformedMetadata.controller.performAction("import-metadata");
  assert.equal(JSON.stringify(malformedMetadata.controller.draft), beforeMetadata);
  assert.equal(malformedMetadata.calls.imported, 0);
  assert.deepEqual(malformedMetadata.calls.busy, [true, false]);
  assert.deepEqual(malformedMetadata.calls.sections, ["data"]);
  assert.equal(malformedMetadata.controller.committing, false);
  assert.match(malformedMetadata.calls.errors.at(-1), /JSON|Unexpected|property name/i);
});

test("metadata picker actions route only versioned payloads through injected I/O and preserve cancel semantics", async () => {
  const payload = { schema: "com.blocky.oracle.replay-metadata-export", version: 1, state: {} };
  const writes = [];
  const toasts = [];
  const resetResults = [];
  const controller = Object.assign(
    Object.create(preferencesApi.OraclePreferencesController.prototype),
    {
      isOpen: true,
      committing: false,
      destroyed: false,
      started: true,
      operationGeneration: 0,
      activeSection: "data",
      committed: preferencesApi.createDefaultPreferences(),
      draft: preferencesApi.createDefaultPreferences(),
      chooseEntry: async (kind) => ({ kind, size: Buffer.byteLength(JSON.stringify(payload), "utf8") }),
      readTextEntry: async () => JSON.stringify(payload),
      writeTextEntry: async (_entry, text) => { writes.push(JSON.parse(text)); },
      onExportMetadata: async () => payload,
      onImportMetadata: async (value) => {
        assert.deepEqual(value, payload);
        return { replayCount: 2, collectionCount: 1 };
      },
      onResetMetadata: async () => {
        const result = { cancelled: true };
        resetResults.push(result);
        return result;
      },
      onToast(message, kind) { toasts.push({ message, kind }); },
      setBusy() {},
      showSection() {},
      showError(message) { assert.equal(message, ""); },
      updateStorageSummary() {},
      updateDiagnosticsSummary() {},
    },
  );

  await controller.performAction("export-metadata");
  assert.deepEqual(writes, [payload]);
  await controller.performAction("import-metadata");
  assert.ok(toasts.some((entry) => /Imported 2 replays and 1 collection/.test(entry.message)));
  const toastCount = toasts.length;
  await controller.performAction("reset-section");
  assert.equal(resetResults.length, 1);
  assert.equal(toasts.length, toastCount, "cancelled reset must not claim success");
});

test("metadata import preflights UXP file size before reading and fails closed without trustworthy size metadata", async () => {
  const limit = 32 * 1024 * 1024;
  const runImport = async (entry, readResult = "{}") => {
    const calls = { busy: [], errors: [], reads: 0, imports: 0 };
    const controller = Object.assign(
      Object.create(preferencesApi.OraclePreferencesController.prototype),
      {
        isOpen: true,
        committing: false,
        destroyed: false,
        started: true,
        operationGeneration: 0,
        activeSection: "data",
        committed: preferencesApi.createDefaultPreferences(),
        draft: preferencesApi.createDefaultPreferences(),
        chooseEntry: async () => entry,
        readTextEntry: async () => { calls.reads += 1; return readResult; },
        onImportMetadata: async () => { calls.imports += 1; return {}; },
        onToast() {},
        setBusy(value) { calls.busy.push(Boolean(value)); },
        showSection() {},
        showError(message) { calls.errors.push(String(message)); },
        updateStorageSummary() {},
        updateDiagnosticsSummary() {},
      },
    );
    await controller.performAction("import-metadata");
    return calls;
  };

  let metadataReads = 0;
  const oversized = await runImport({
    async getMetadata() {
      metadataReads += 1;
      return { size: limit + 1 };
    },
  });
  assert.equal(metadataReads, 1);
  assert.equal(oversized.reads, 0, "oversized files must be rejected before entry.read allocates them");
  assert.equal(oversized.imports, 0);
  assert.match(oversized.errors.at(-1), /exceeds the 32 MB import limit/);
  assert.deepEqual(oversized.busy, [true, false]);

  const unverifiable = await runImport({});
  assert.equal(unverifiable.reads, 0, "missing or malformed UXP metadata must fail closed");
  assert.equal(unverifiable.imports, 0);
  assert.match(unverifiable.errors.at(-1), /could not verify the selected file size/i);
  assert.deepEqual(unverifiable.busy, [true, false]);

  const racedLargerRead = await runImport({ size: 2 }, { length: limit + 1 });
  assert.equal(racedLargerRead.reads, 1);
  assert.equal(racedLargerRead.imports, 0);
  assert.match(racedLargerRead.errors.at(-1), /exceeds the 32 MB import limit/);
});

test("normalization clamps inputs, deduplicates roots, and never persists an original avatar path", () => {
  const normalized = preferencesApi.normalizePreferences({
    profile: { displayName: "  Blocky Studios\u0000 User  ", avatarUrl: "C:\\private\\portrait.png", zoom: 99 },
    appearance: { accent: "e548c7", fontScale: 9, reducedMotion: "invalid" },
    replay: {
      gridColumns: 99,
      roots: ["D:\\Renders", "D:\\Renders", "", "E:\\Exports"],
      deleteFromDisk: "true",
    },
  });
  assert.equal(normalized.profile.displayName, "Blocky Studios User");
  assert.equal(normalized.profile.avatarUrl, "");
  assert.equal(normalized.profile.zoom, 3);
  assert.equal(normalized.appearance.accent, "#E548C7");
  assert.equal(normalized.appearance.fontScale, 1.3);
  assert.equal(normalized.appearance.reducedMotion, "system");
  assert.equal(normalized.replay.gridColumns, 6);
  assert.deepEqual(normalized.replay.roots, ["D:\\Renders", "E:\\Exports"]);
  assert.equal(normalized.replay.deleteFromDisk, false);
});

test("hostile numerics fall back deterministically and cannot be saved as NaN", () => {
  const hostile = preferencesApi.createDefaultPreferences();
  hostile.appearance.fontScale = "bad";
  hostile.replay.gridColumns = Number.NaN;
  hostile.replay.cacheLimitMb = Number.POSITIVE_INFINITY;
  hostile.curves.sampleBudget = "not-a-budget";
  const normalized = preferencesApi.normalizePreferences(hostile);
  assert.equal(normalized.appearance.fontScale, 1);
  assert.equal(normalized.replay.gridColumns, 3);
  assert.equal(normalized.replay.cacheLimitMb, 512);
  assert.equal(normalized.curves.sampleBudget, 48);
  assert.equal(Object.values(normalized).some((value) => Number.isNaN(value)), false);
  const validation = preferencesApi.validatePreferences(hostile);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((message) => message.includes("appearance.fontScale")));
});

test("replay roots accept absolute Windows locations and reject traversal, ADS, and relative input", () => {
  assert.equal(preferencesApi.normalizeReplayRoot("D:/Blocky Studios Exports"), "D:\\Blocky Studios Exports");
  assert.equal(preferencesApi.normalizeReplayRoot("\\\\server\\share\\Renders"), "\\\\server\\share\\Renders");
  assert.equal(preferencesApi.normalizeReplayRoot("renders\\relative"), "");
  assert.equal(preferencesApi.normalizeReplayRoot("D:\\Blocky Studios\\..\\secret"), "");
  assert.equal(preferencesApi.normalizeReplayRoot("D:\\Blocky Studios\\clip.mov:secret"), "");
});

test("Cancel restores the committed snapshot without persisting preview changes", () => {
  const committed = preferencesApi.createDefaultPreferences();
  committed.profile.displayName = "Committed";
  const applied = [];
  const controller = {
    isOpen: true,
    committed,
    draft: preferencesApi.normalizePreferences({ profile: { displayName: "Preview" } }),
    avatarRemoved: true,
    cleanupAvatarStateCalled: false,
    cleanupAvatarState() { this.cleanupAvatarStateCalled = true; },
    onApply(value, metadata) { applied.push({ value, metadata }); },
    closeCalled: false,
    close() { this.closeCalled = true; },
  };
  preferencesApi.OraclePreferencesController.prototype.cancel.call(controller);
  assert.notEqual(controller.draft, committed);
  assert.deepEqual(controller.draft, committed);
  assert.equal(controller.avatarRemoved, false);
  assert.equal(controller.cleanupAvatarStateCalled, true);
  assert.equal(controller.closeCalled, true);
  assert.deepEqual(applied[0].metadata, { source: "cancel", preview: false });
  assert.equal(applied[0].value.profile.displayName, "Committed");
});

test("avatar validation recognizes supported bytes, bounds dimensions, and computes square cover crop", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00,
  ]);
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x01, 0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  const webp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x16, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 0x0a, 0, 0, 0, 0, 0, 0, 0,
    0xff, 0x01, 0, 0xff, 0, 0,
  ]);
  assert.deepEqual(
    { ...preferencesApi.validateAvatarBytes(png), bytes: undefined },
    { bytes: undefined, mimeType: "image/png", width: 512, height: 256 },
  );
  assert.deepEqual(
    { ...preferencesApi.validateAvatarBytes(jpeg), bytes: undefined },
    { bytes: undefined, mimeType: "image/jpeg", width: 512, height: 256 },
  );
  assert.deepEqual(
    { ...preferencesApi.validateAvatarBytes(webp), bytes: undefined },
    { bytes: undefined, mimeType: "image/webp", width: 512, height: 256 },
  );
  assert.throws(() => preferencesApi.validateAvatarBytes(png.slice(0, 8)), /structurally valid/);
  assert.throws(() => preferencesApi.validateAvatarBytes(Uint8Array.from([1, 2, 3])), /valid PNG/);
  assert.throws(() => preferencesApi.validateAvatarDimensions(63, 256), /between 64 and 8192/);
  assert.throws(() => preferencesApi.validateAvatarDimensions(256, 8193), /between 64 and 8192/);
  assert.throws(() => preferencesApi.validateAvatarDimensions(8192, 8192), /16 megapixels/);
  assert.deepEqual(preferencesApi.validateAvatarDimensions(64, 8192), { width: 64, height: 8192 });

  const centered = preferencesApi.calculateAvatarCrop(512, 256, { zoom: 1, panX: 0, panY: 0 });
  assert.deepEqual(centered, { x: -128, y: 0, width: 512, height: 256 });
  const moved = preferencesApi.calculateAvatarCrop(512, 256, { zoom: 2, panX: 1, panY: -1 });
  assert.equal(moved.width, 1024);
  assert.equal(moved.height, 512);
  assert.ok(moved.x > -384 && moved.y < -128);
});

test("shared color utilities round-trip and preference validation catches curve and border errors", () => {
  for (const color of ["#E548C7", "#FFFFFF", "#151515", "#12AB34"]) {
    const rgb = preferencesApi.hexToRgb(color);
    assert.equal(preferencesApi.rgbToHex(rgb.r, rgb.g, rgb.b), color);
    const hsv = preferencesApi.rgbToHsv(rgb.r, rgb.g, rgb.b);
    const roundTrip = preferencesApi.hsvToRgb(hsv.h, hsv.s, hsv.v);
    assert.equal(preferencesApi.rgbToHex(roundTrip.r, roundTrip.g, roundTrip.b), color);
  }
  assert.ok(preferencesApi.contrastRatio("#FFFFFF", "#151515") > 3);
  const invalid = preferencesApi.createDefaultPreferences();
  invalid.appearance.border = invalid.appearance.background;
  invalid.curves.sampleBudget = 200;
  invalid.curves.warningThreshold = 20;
  const result = preferencesApi.validatePreferences(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("Border color")));
  assert.ok(result.errors.some((message) => message.includes("warning threshold")));

  const invisibleCurve = preferencesApi.createDefaultPreferences();
  invisibleCurve.curves.curveColor = invisibleCurve.appearance.background;
  invisibleCurve.curves.gridColor = invisibleCurve.appearance.background;
  const curveResult = preferencesApi.validatePreferences(invisibleCurve);
  assert.equal(curveResult.ok, false);
  assert.ok(curveResult.errors.some((message) => message.includes("Curve color needs at least 3:1")));
  assert.ok(curveResult.errors.some((message) => message.includes("Curve grid color")));
});

test("M9 supported themes prove text, control, focus, surface, and accent contrast and preview unsafe drafts through safe tokens", () => {
  const defaults = preferencesApi.createDefaultPreferences();
  const report = assertReferenceRoleContrast(defaults.appearance);
  assert.ok(report.controlText >= 4.5);
  assert.ok(report.accentText >= 4.5);

  const unsafe = preferencesApi.createDefaultPreferences();
  unsafe.appearance.background = "#FFFFFF";
  const validation = preferencesApi.validatePreferences(unsafe);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((message) => /Background color for the dark theme needs at least 4\.5:1 contrast with Blocky Studios text/.test(message)));

  const styleValues = new Map();
  const document = {
    documentElement: {
      dataset: {},
      style: { setProperty(name, value) { styleValues.set(name, String(value)); } },
    },
    getElementById() { return null; },
  };
  preferencesApi.applyPreferencesToDocument(unsafe, document);
  assert.equal(styleValues.get("--bg-color"), "#111318", "an invalid draft never replaces Blocky Studios' safe rendered surface");
  assert.equal(document.documentElement.dataset.themeContrast, "fallback");
  assert.ok(preferencesApi.contrastRatio("#F4F5F7", styleValues.get("--bg-color")) >= 4.5);

  const validDark = preferencesApi.createDefaultPreferences();
  validDark.appearance.background = "#202020";
  preferencesApi.applyPreferencesToDocument(validDark, document);
  assert.equal(styleValues.get("--bg-color"), "#202020");
  assert.equal(document.documentElement.dataset.themeContrast, "safe");
});

test("M9 custom accents are never used as small text foregrounds", () => {
  const darkAccent = preferencesApi.createDefaultPreferences();
  darkAccent.appearance.accent = "#373737";
  assert.equal(
    preferencesApi.validatePreferences(darkAccent).ok,
    true,
    "a low-luminance accent remains valid for borders, fills, and active-control distinction",
  );
  assert.doesNotMatch(m6Css, /^\s*color:\s*var\(--accent-color/m);
  assert.match(m6Css, /\.quick-apply-recipe-stage-label\s*\{[^}]*color:\s*var\(--oracle-text/s);
  assert.match(m6Css, /\.quick-apply-recipe-step__order\s*\{[^}]*color:\s*var\(--oracle-text/s);
});

test("M9 color picker exposes saturation and brightness as two native scalar controls", () => {
  assert.match(html, /data-color-plane role="img"[^>]*aria-label="Color plane preview"/);
  assert.doesNotMatch(html, /data-color-plane[^>]*role="slider"/);
  assert.match(html, /type="range"[^>]*data-color-saturation/);
  assert.match(html, /type="range"[^>]*data-color-brightness/);
  assert.match(css, /\.oracle-color-picker__axis-grid\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.oracle-color-picker__axis-grid > \*\s*\{[^}]*flex:\s*1 1 0/s);

  const attributes = new Map();
  const controller = {
    hsv: { h: 240, s: 0.42, v: 0.67 },
    plane: {
      style: { setProperty() {} },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
    },
    thumb: { style: {} },
    hue: {},
    hex: {},
    red: {},
    green: {},
    blue: {},
    saturation: {},
    brightness: {},
    saturationValue: {},
    brightnessValue: {},
  };
  preferencesApi.ColorPickerController.prototype.sync.call(controller, "#3C3CAA", { r: 60, g: 60, b: 170 });
  assert.equal(controller.saturation.value, "42");
  assert.equal(controller.brightness.value, "67");
  assert.equal(controller.saturationValue.textContent, "42%");
  assert.equal(controller.brightnessValue.textContent, "67%");
  assert.match(attributes.get("aria-label"), /42% saturation, 67% brightness, #3C3CAA/);
  assert.equal(attributes.has("aria-valuenow"), false);
});

test("M9 high-contrast mode uses system colors and keeps selected and focused controls distinguishable", () => {
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(css, /--oracle-text:\s*CanvasText/);
  assert.match(css, /--focus-color:\s*Highlight/);
  assert.match(css, /\[aria-selected="true"\][\s\S]*Highlight/);
  assert.match(css, /:focus-visible[\s\S]*outline:\s*2px solid Highlight/);
});

test("focus trap wraps both directions and does not touch ordinary keys", () => {
  const doc = { activeElement: null };
  const makeFocusable = () => ({
    hidden: false,
    getAttribute() { return null; },
    focus() { doc.activeElement = this; },
  });
  const first = makeFocusable();
  const last = makeFocusable();
  const container = {
    ownerDocument: doc,
    querySelectorAll() { return [first, last]; },
    contains(value) { return value === first || value === last; },
    focus() { doc.activeElement = this; },
  };
  const event = (key, shiftKey = false) => ({
    key,
    shiftKey,
    prevented: false,
    preventDefault() { this.prevented = true; },
  });

  doc.activeElement = last;
  const forward = event("Tab");
  assert.equal(shellApi.trapTab(forward, container), true);
  assert.equal(forward.prevented, true);
  assert.equal(doc.activeElement, first);

  doc.activeElement = first;
  const backward = event("Tab", true);
  assert.equal(shellApi.trapTab(backward, container), true);
  assert.equal(doc.activeElement, last);
  assert.equal(shellApi.trapTab(event("ArrowRight"), container), false);
});

test("focus discovery excludes controls inside hidden tabpanels and nested hidden popovers", () => {
  const visible = {
    hidden: false,
    parentElement: null,
    getAttribute() { return null; },
  };
  const hiddenPanel = {
    hidden: true,
    parentElement: null,
    getAttribute() { return null; },
  };
  const hiddenControl = {
    hidden: false,
    parentElement: hiddenPanel,
    getAttribute() { return null; },
  };
  const container = {
    querySelectorAll() { return [visible, hiddenControl]; },
  };
  visible.parentElement = container;
  hiddenPanel.parentElement = container;
  assert.deepEqual(shellApi.focusableElements(container), [visible]);
});

test("profile avatar replacement can commit or roll back without deleting the previous image", async () => {
  const avatar = "plugin-data:/oracle-profile-avatar.v1.png";
  const temp = "plugin-data:/oracle-profile-avatar.v1.tmp.png";
  const backup = "plugin-data:/oracle-profile-avatar.v1.backup.png";
  const files = new Map([[avatar, "old"], [temp, "new"]]);
  const missing = () => Object.assign(new Error("ENOENT: not found"), { code: "ENOENT" });
  const fsMock = {
    async rename(source, destination) {
      if (!files.has(source)) throw missing();
      const value = files.get(source);
      files.delete(source);
      files.set(destination, value);
    },
    async unlink(url) {
      if (!files.has(url)) throw missing();
      files.delete(url);
    },
  };
  const rollbackTransaction = await preferencesApi.beginAvatarFileTransaction({ fs: fsMock }, false);
  assert.equal(files.get(avatar), "new");
  assert.equal(files.get(backup), "old");
  await rollbackTransaction.rollback();
  assert.equal(files.get(avatar), "old");
  assert.equal(files.has(backup), false);

  files.set(temp, "newer");
  const commitTransaction = await preferencesApi.beginAvatarFileTransaction({ fs: fsMock }, false);
  await commitTransaction.finalize();
  assert.equal(files.get(avatar), "newer");
  assert.equal(files.has(backup), false);
});

test("color-picker Cancel restores its opening value while Apply keeps the preview", () => {
  const changes = [];
  const createController = () => ({
    token: "appearance.accent",
    originalColor: "#E548C7",
    popover: { hidden: false },
    dragging: true,
    anchor: null,
    onChange(token, color) { changes.push({ token, color }); },
  });
  const cancelled = createController();
  preferencesApi.ColorPickerController.prototype.close.call(cancelled, false, false);
  assert.deepEqual(changes.pop(), { token: "appearance.accent", color: "#E548C7" });
  const applied = createController();
  preferencesApi.ColorPickerController.prototype.close.call(applied, true, false);
  assert.equal(changes.length, 0);
});

test("color-picker anchors through its containing dialog when UXP omits offsetParent", () => {
  let focused = false;
  const popover = {
    hidden: true,
    dataset: {},
    offsetParent: undefined,
    offsetHeight: 320,
    parentElement: {
      getBoundingClientRect() {
        return { left: 20, top: 30, width: 500, height: 600 };
      },
    },
    style: {},
  };
  const controller = {
    popover,
    saturation: { focus() { focused = true; } },
    setColor() {},
  };
  const anchor = {
    getBoundingClientRect() {
      return { left: 80, bottom: 120 };
    },
  };

  assert.doesNotThrow(() => preferencesApi.ColorPickerController.prototype.open.call(
    controller,
    "appearance.accent",
    "#E548C7",
    anchor,
    "#E548C7",
  ));
  assert.equal(popover.hidden, false);
  assert.equal(popover.style.left, "60px");
  assert.equal(popover.style.top, "96px");
  assert.equal(focused, true);
});

test("dismissal respects an earlier gesture owner and closes only when Escape remains available", () => {
  const drawer = { querySelectorAll() { return []; } };
  const controller = new shellApi.OracleShellController({ navigationDrawer: drawer });
  controller.drawerOpen = true;
  let closed = 0;
  controller.closeDrawer = () => { closed += 1; };
  controller.onKeyDown({
    key: "Escape",
    defaultPrevented: true,
    preventDefault() { throw new Error("must not consume"); },
    stopPropagation() { throw new Error("must not consume"); },
  });
  assert.equal(closed, 0);
  let prevented = false;
  controller.onKeyDown({
    key: "Escape",
    defaultPrevented: false,
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(closed, 1);
  assert.equal(prevented, true);
});

test("drawer restores focus in a microtask after the promoted UXP layer is hidden", async () => {
  let focused = 0;
  const classList = { remove() {} };
  const focusTarget = { isConnected: true, focus() { focused += 1; } };
  const controller = Object.assign(
    Object.create(shellApi.OracleShellController.prototype),
    {
      drawerOpen: true,
      restoreFocus: focusTarget,
      elements: {
        navigationDrawer: { hidden: false, classList },
        navigationBackdrop: { hidden: false, classList },
        navigationToggle: { setAttribute() {}, focus() {} },
      },
    },
  );
  controller.closeDrawer(true);
  assert.equal(focused, 0, "focus cannot target a compositor-hidden routed input");
  assert.equal(controller.elements.navigationBackdrop.hidden, true);
  assert.equal(controller.elements.navigationDrawer.hidden, true);
  await Promise.resolve();
  assert.equal(focused, 1);
});

test("drawer route activation removes the UXP top layer before the workspace can request focus", () => {
  const order = [];
  const routeButton = {
    disabled: false,
    dataset: { oracleRoute: "quick-apply" },
    getAttribute() { return "false"; },
  };
  const controller = new shellApi.OracleShellController({
    navigationDrawer: { querySelectorAll() { return []; } },
  });
  controller.closeDrawer = (restoreFocus, immediate) => {
    order.push(["close", restoreFocus, immediate]);
  };
  controller.setRoute = (route) => {
    order.push(["route", route]);
  };
  let prevented = 0;
  let stopped = 0;
  controller.onNavigationClick({
    target: { closest() { return routeButton; } },
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  });
  assert.deepEqual(order, [
    ["close", false, true],
    ["route", "quick-apply"],
  ]);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test("immediate drawer close is synchronous and never schedules hidden-focus restoration", () => {
  const previousSetTimeout = global.setTimeout;
  let scheduled = 0;
  global.setTimeout = () => {
    scheduled += 1;
    return 99;
  };
  const classList = { remove() {} };
  const controller = Object.assign(
    Object.create(shellApi.OracleShellController.prototype),
    {
      drawerOpen: true,
      drawerTimer: null,
      restoreFocus: { focus() { throw new Error("must not restore hidden route focus"); } },
      elements: {
        navigationDrawer: { hidden: false, classList },
        navigationBackdrop: { hidden: false, classList },
        navigationToggle: { setAttribute() {} },
      },
    },
  );
  try {
    controller.closeDrawer(false, true);
    assert.equal(controller.elements.navigationDrawer.hidden, true);
    assert.equal(controller.elements.navigationBackdrop.hidden, true);
    assert.equal(controller.restoreFocus, null);
    assert.equal(scheduled, 0);
  } finally {
    global.setTimeout = previousSetTimeout;
  }
});

test("drawer becomes usable synchronously when Premiere does not deliver an animation frame", () => {
  const added = [];
  let expanded = null;
  let focused = 0;
  const activeRoute = { focus() { focused += 1; } };
  const controller = Object.assign(
    Object.create(shellApi.OracleShellController.prototype),
    {
      document: null,
      root: null,
      route: "replays",
      drawerOpen: false,
      drawerTimer: null,
      restoreFocus: null,
      elements: {
        navigationDrawer: {
          hidden: true,
          classList: { add(value) { added.push(`drawer:${value}`); } },
          querySelector() { return activeRoute; },
          querySelectorAll() { return []; },
        },
        navigationBackdrop: {
          hidden: true,
          classList: { add(value) { added.push(`backdrop:${value}`); } },
        },
        navigationToggle: {
          setAttribute(name, value) {
            if (name === "aria-expanded") expanded = value;
          },
        },
      },
    },
  );

  controller.openDrawer();
  assert.equal(controller.drawerOpen, true);
  assert.equal(controller.elements.navigationDrawer.hidden, false);
  assert.equal(controller.elements.navigationBackdrop.hidden, false);
  assert.equal(expanded, "true");
  assert.deepEqual(added, ["drawer:is-open", "backdrop:is-open"]);
  assert.equal(focused, 1);
});

test("shell routing is scoped to its inferred panel root and never hides a dedicated panel view", () => {
  const classList = () => ({ toggle() {} });
  const routeButton = (route) => ({
    dataset: { oracleRoute: route },
    disabled: false,
    classList: classList(),
    getAttribute() { return null; },
    setAttribute() {},
  });
  const replaysButton = routeButton("replays");
  const curvesButton = routeButton("curves");
  const mainReplayView = { dataset: { oracleView: "replays" }, hidden: false };
  const mainCurvesView = { dataset: { oracleView: "curves" }, hidden: true };
  const dedicatedCurvesView = { dataset: { oracleView: "curves" }, hidden: false };
  let documentViewQueries = 0;
  const ownerDocument = {
    activeElement: null,
    querySelectorAll(selector) {
      if (selector === "[data-oracle-view]") documentViewQueries += 1;
      return [mainReplayView, mainCurvesView, dedicatedCurvesView];
    },
  };
  const mainRoot = {
    ownerDocument,
    contains(value) { return value === mainReplayView || value === mainCurvesView; },
    querySelectorAll(selector) {
      return selector === "[data-oracle-view]" ? [mainReplayView, mainCurvesView] : [];
    },
  };
  const drawer = {
    closest() { return mainRoot; },
    querySelector(selector) {
      if (selector.includes('"curves"')) return curvesButton;
      if (selector.includes('"replays"')) return replaysButton;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-oracle-route]" ? [replaysButton, curvesButton] : [];
    },
  };

  const controller = new shellApi.OracleShellController(
    { navigationDrawer: drawer },
    { document: ownerDocument },
  );
  assert.equal(controller.root, mainRoot);
  assert.equal(controller.setRoute("curves"), true);
  assert.equal(mainReplayView.hidden, true);
  assert.equal(mainCurvesView.hidden, false);
  assert.equal(dedicatedCurvesView.hidden, false);
  assert.equal(documentViewQueries, 0);
});

test("document-level shell keys are ignored while another panel root owns interaction", () => {
  const mainControl = {};
  const dedicatedControl = {};
  const ownerDocument = { activeElement: dedicatedControl };
  const mainRoot = {
    ownerDocument,
    contains(value) { return value === mainControl; },
  };
  const drawer = {
    closest() { return mainRoot; },
    querySelectorAll() { return []; },
  };
  const controller = new shellApi.OracleShellController(
    { navigationDrawer: drawer },
    { document: ownerDocument },
  );
  controller.drawerOpen = true;
  let closed = 0;
  let prevented = 0;
  controller.closeDrawer = () => { closed += 1; };
  const keyEvent = (target) => ({
    key: "Escape",
    target,
    defaultPrevented: false,
    preventDefault() { prevented += 1; },
    stopPropagation() {},
  });

  controller.onKeyDown(keyEvent(dedicatedControl));
  assert.equal(closed, 0);
  assert.equal(prevented, 0);

  ownerDocument.activeElement = mainControl;
  controller.onKeyDown(keyEvent(mainControl));
  assert.equal(closed, 1);
  assert.equal(prevented, 1);
});

test("open Preferences never consumes keyboard input owned by a dedicated panel root", () => {
  const mainChild = {};
  const dedicatedChild = {};
  const root = {
    contains(node) { return node === mainChild; },
  };
  const ownerDocument = { activeElement: dedicatedChild };
  let cancelCount = 0;
  const controller = Object.assign(
    Object.create(preferencesApi.OraclePreferencesController.prototype),
    {
      isOpen: true,
      committing: false,
      root,
      document: ownerDocument,
      colorPicker: { token: "", close() {} },
      cancel() { cancelCount += 1; },
    },
  );
  const event = (target, key) => ({
    target,
    key,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  });

  const dedicatedEscape = event(dedicatedChild, "Escape");
  controller.handleKeyDown(dedicatedEscape);
  assert.equal(dedicatedEscape.defaultPrevented, false);
  assert.equal(cancelCount, 0);

  const mainEscape = event(mainChild, "Escape");
  controller.handleKeyDown(mainEscape);
  assert.equal(mainEscape.defaultPrevented, true);
  assert.equal(mainEscape.propagationStopped, true);
  assert.equal(cancelCount, 1);
});

test("committing Preferences leaves Tab and Escape to a higher-priority modal dialog", () => {
  const modalDialog = {};
  const preferencesPanel = {
    contains(node) { return node === preferencesControl; },
  };
  const modalControl = {
    closest(selector) {
      assert.equal(selector, '[role="dialog"][aria-modal="true"]');
      return modalDialog;
    },
  };
  const preferencesControl = {
    closest(selector) {
      assert.equal(selector, '[role="dialog"][aria-modal="true"]');
      return preferencesPanel;
    },
  };
  const root = {
    contains(node) { return node === modalControl || node === preferencesControl; },
  };
  const controller = Object.assign(
    Object.create(preferencesApi.OraclePreferencesController.prototype),
    {
      isOpen: true,
      committing: true,
      root,
      document: { activeElement: modalControl },
      elements: { preferencesPanel },
    },
  );
  const keyEvent = (target, key) => ({
    target,
    key,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  });

  for (const key of ["Tab", "Escape"]) {
    const modalEvent = keyEvent(modalControl, key);
    controller.handleKeyDown(modalEvent);
    assert.equal(modalEvent.defaultPrevented, false, `${key} must reach the confirmation dialog`);
    assert.equal(modalEvent.propagationStopped, false, `${key} propagation must reach the confirmation dialog`);

    const preferencesEvent = keyEvent(preferencesControl, key);
    controller.handleKeyDown(preferencesEvent);
    assert.equal(preferencesEvent.defaultPrevented, true, `${key} remains locked inside busy Preferences`);
    assert.equal(preferencesEvent.propagationStopped, true, `${key} cannot escape busy Preferences itself`);
  }
});

test("shell markup exposes only real routes and keeps overlays outside replay input ownership", () => {
  assert.match(html, /id="navigationToggle"[^>]*aria-controls="navigationDrawer"/s);
  assert.match(html, /id="navigationToggle"[^>]*>[\s\S]*?<img[^>]*class="bs-icon bs-icon--menu"[^>]*src="assets\/icons\/menu\.png"[^>]*>[\s\S]*?<\/button>/s);
  assert.doesNotMatch(blockyCss, /background(?:-image)?\s*:\s*[^;]*url\([^)]*assets\/icons\//i);
  assert.doesNotMatch(html, /&#8801;|[☰≡]/);
  assert.match(html, /id="preferencesToggle"[^>]*aria-controls="preferencesPanel"/s);
  assert.match(html, /data-oracle-route="replays"[^>]*aria-current="page"/s);
  assert.match(html, /data-oracle-route="curves"[^>]*title="Edit supported Premiere keyframe interpolation"/s);
  assert.doesNotMatch(html, /data-oracle-route="curves"[^>]*disabled/s);
  assert.match(html, /id="curvesWorkspace"[^>]*data-oracle-view="curves"/s);
  assert.match(html, /data-oracle-route="quick-apply"[^>]*title="Search and apply host-supported Premiere effects and Blocky Studios Recipes"/s);
  assert.doesNotMatch(html, /data-oracle-route="quick-apply"[^>]*disabled/s);
  assert.match(html, /id="quickApplyWorkspace"[^>]*data-oracle-view="quick-apply"/s);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="preferencesTitle"/s);
  assert.match(html, /role="tab"[^>]*aria-controls="preferencesSectionProfile"/s);
  assert.match(html, /data-color-reset/);
  assert.match(html, /data-color-cancel/);
  assert.match(html, /data-color-done>Apply/);
  assert.doesNotMatch(html, /quickApply\.experimentalEnabled|experimentalFeaturesLabel|Experimental features/i);
  assert.ok(html.indexOf("id=\"navigationDrawer\"") < html.indexOf("id=\"replayScroller\""));
  assert.match(css, /\.oracle-layer-backdrop:not\(\[hidden\]\) ~ \[data-oracle-view\]\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.oracle-layer-backdrop:not\(\[hidden\]\) ~ \[data-oracle-view\] input[\s\S]*display:\s*none\s*!important/);
  assert.doesNotMatch(html, /\bdraggable\s*=\s*["']true["']/i);
  assert.equal((html.match(/\bdraggable\s*=\s*["']false["']/gi) || []).length, 2, "only the two brand images suppress browser-native dragging");
  assert.doesNotMatch(`${html}\n${css}`, /DataTransfer|drag ghost/i);
});

test("compact-height navigation keeps every real route reachable without status overlap", () => {
  assert.match(css, /\.navigation-drawer\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /@media \(max-height:\s*420px\)[\s\S]*\.navigation-drawer__items\s*\{[\s\S]*flex:\s*0 0 auto/);
  assert.match(css, /@media \(max-height:\s*420px\)[\s\S]*\.navigation-drawer__status\s*\{[\s\S]*margin:\s*0/);
});

test("narrow Preferences keeps Reset, Cancel, and Apply inside the dialog footer", () => {
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*\.oracle-dialog__footer\s*\{[\s\S]*gap:\s*6px/);
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*\.oracle-dialog__footer-spacer\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*\.oracle-dialog__footer \.oracle-button\s*\{[\s\S]*flex:\s*1 1 0/);
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*\.oracle-dialog__footer \.oracle-button\s*\{[\s\S]*white-space:\s*normal/);
  assert.match(html, /data-preferences-action="reset-section"[\s\S]*aria-label="Reset current preference section"[\s\S]*>Reset<\/button>/);
});

test("responsive geometry remains deterministic through narrow, wide, collapsed, and repeated resize states", () => {
  assert.match(css, /\.oracle-header\s*\{[^}]*display:\s*flex;/s);
  assert.match(css, /\.oracle-header__side\s*\{[^}]*flex:\s*1 1 0;/s);
  assert.match(css, /\.oracle-brand\s*\{[^}]*flex:\s*0 1 auto;/s);
  const drawerRule = css.match(/\.navigation-drawer\s*\{([^}]*)\}/s);
  assert.ok(drawerRule);
  assert.doesNotMatch(drawerRule[1], /transition:/);
  assert.doesNotMatch(drawerRule[1], /(?:width|height)[^;]*var\(--motion/);
  assert.match(css, /data-reduced-motion="reduce"/);
  assert.match(css, /\.oracle-layer-backdrop\.is-open\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.navigation-drawer\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.oracle-dialog\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.replay-grid-container\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s);
  assert.match(css, /--replay-card-basis:\s*calc\(33\.333333% - 13\.333333px\)/);
  const widths = [0, 180, 300, 420, 560, 800, 1200];
  for (let cycle = 0; cycle < 50; cycle += 1) {
    for (const width of cycle % 2 === 0 ? widths : [...widths].reverse()) {
      for (let requested = 1; requested <= 6; requested += 1) {
        const available = Math.max(0, width - 40);
        const minimumCardWidth = 132;
        const columns = width === 0
          ? 1
          : Math.max(1, Math.min(requested, Math.floor((available + 20) / (minimumCardWidth + 20))));
        const track = columns === 0 ? 0 : Math.max(0, (available - (columns - 1) * 20) / columns);
        const measured = Array.from({ length: columns }, () => track);
        assert.ok(Math.max(...measured) - Math.min(...measured) <= 1);
      }
    }
  }
});
