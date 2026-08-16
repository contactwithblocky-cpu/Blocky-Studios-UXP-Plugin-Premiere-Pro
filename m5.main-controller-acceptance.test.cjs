"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("M5 stable revision loads every Curves dependency before main with one cachebuster", () => {
  const mainAsset = html.match(/main\.js\?blocky-ui=([^"']+)/);
  assert.ok(mainAsset, "main.js cachebuster is missing");
  const cachebuster = mainAsset[1];
  const ordered = [
    "src/curves/oracle-curve-math.js",
    "src/curves/oracle-curve-presets.js",
    "src/curves/oracle-premiere-curves-adapter.js",
    "src/curves/oracle-curves-workspace.js",
    "main.js",
  ];
  let previous = -1;
  for (const asset of ordered) {
    const index = html.indexOf(`${asset}?blocky-ui=${cachebuster}`);
    assert.ok(index > previous, `${asset} is missing or out of dependency order`);
    previous = index;
  }
  assert.ok(html.includes(`dist/blocky-studios-ui.css?blocky-ui=${cachebuster}`));
  const cachebusters = Array.from(html.matchAll(/\?blocky-ui=([^"']+)/g), (match) => match[1]);
  assert.ok(cachebusters.length >= 15);
  assert.deepEqual(new Set(cachebusters), new Set([cachebuster]));
});

test("M5 Curves route remains real as later routes advance", () => {
  const curvesButton = html.match(/<button[\s\S]*?data-oracle-route="curves"[\s\S]*?<\/button>/);
  assert.ok(curvesButton);
  assert.doesNotMatch(curvesButton[0], /\bdisabled\b|aria-disabled="true"/);
  assert.match(curvesButton[0], />Curves</);
  const quickButton = html.match(/<button[\s\S]*?data-oracle-route="quick-apply"[\s\S]*?<\/button>/);
  assert.ok(quickButton);
  assert.match(quickButton[0], />Quick Apply</);
  assert.match(html, /id="curvesWorkspace"[\s\S]*?data-oracle-view="curves"/);
});

test("M5 workspace markup exposes every wired selector, graph, action, and nonblank state", () => {
  const ids = [
    "curvesWorkspace", "curvesWorkspaceState", "curvesStateTitle", "curvesStateMessage",
    "curvesWorkspaceContent", "curvesRefresh", "curvesSettingsToggle", "curvesSettingsPanel", "curvesSettingsClose",
    "curvesInspector", "curvesResizeHandle", "curvesDetectedProperties",
    "curvesClipSelect", "curvesComponentSelect",
    "curvesPropertySelect", "curvesClipSummary", "curvesComponentSummary", "curvesPropertySummary",
    "curvesEndpointsSummary", "curvesInterpolationSummary", "curvesCompatibilitySummary",
    "curvesNativeInterpolation", "curvesGridSize", "curvesPresetViewList", "curvesPresetViewGrid",
    "curvesGraphTitle", "curvesGraph", "curvesGraphGrid", "curvesOverlayGroup", "curvesGraphPath",
    "curvesHandleOne", "curvesHandleTwo", "curvesHandleOneLine", "curvesHandleTwoLine",
    "curvesPointOneX", "curvesPointOneY", "curvesPointTwoX", "curvesPointTwoY",
    "curvesZoomIn", "curvesZoomOut", "curvesZoomLabel", "curvesFit", "curvesReset", "curvesMirror",
    "curvesReverse", "curvesCopy", "curvesPaste", "curvesApply", "curvesStatus",
    "curvesSamplePreview", "curvesPresetSearch", "curvesPresetFolder", "curvesPresetTags", "curvesPresetMetadata",
    "curvesPresetFolderCreate", "curvesPresetFolderRename", "curvesPresetFolderDelete",
    "curvesPresetList", "curvesPresetEmpty",
    "curvesPresetSaveAs", "curvesPresetOverwrite", "curvesPresetRename",
    "curvesPresetDuplicate", "curvesPresetDelete", "curvesPresetMoveUp",
    "curvesPresetMoveDown", "curvesPresetFavorite", "curvesPresetImport", "curvesPresetExport",
  ];
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
  assert.match(html, /id="curvesHandleOne"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(html, /id="curvesHandleTwo"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(html, /id="curvesGraphDescription"[^>]*>Drag either curve handle/);
  assert.doesNotMatch(html, /id="curvesHandle(?:One|Two)"[^>]*role="slider"/);
  assert.match(html, /Native Premiere interpolation on the existing keyframes/);
  assert.match(html, /Uses Premiere easing on the existing two-key segment/);
  assert.match(html, /0 new keys/);
  assert.doesNotMatch(html, /id="curvesModeBaked"/);
  assert.match(html, /\.prfpset files are intentionally unsupported/);
});

test("M5 controller uses the real Premiere adapter, disables generated-key proof, and scopes observation to the Curves route", () => {
  assert.match(main, /new curvesAdapterApi\.PremiereCurvesAdapter\(\{/);
  const adapterStart = main.indexOf("new curvesAdapterApi.PremiereCurvesAdapter({");
  const adapterEnd = main.indexOf("\n    });", adapterStart);
  const adapterOptions = main.slice(adapterStart, adapterEnd);
  assert.doesNotMatch(adapterOptions, /bakedRuntimeProof|generatedKeyActions|defaultLinearReadback/);
  assert.match(main, /const curvesActive = panelVisible && nextRoute === "curves"/);
  assert.match(main, /this\.curvesWorkspace\.setVisible\(curvesActive\)/);
  assert.match(main, /this\.curvesWorkspace\.setActive\(curvesActive\)/);
  assert.match(main, /this\.curvesWorkspace\.start\(\)/);
  assert.match(main, /run\("Curves workspace", \(\) => this\.curvesWorkspace\.destroy\(\)\)/);
  assert.match(main, /run\("Curves lease", \(\) => this\.curvesAdapterLease\.release\(\)\)/);
  assert.match(main, /run\("Curves coordinator", \(\) => this\.curvesAdapterCoordinator\.destroy\(\)\)/);
  assert.doesNotMatch(main, /this\.curvesAdapter\) void this\.curvesAdapter\.destroy\(\)/);
});

test("M5 presets persist in Blocky Studios v3 state with real JSON pickers and confirmations", () => {
  assert.match(main, /class CurvePresetDomainStore/);
  assert.match(main, /nextState\.curvePresetsById = Object\.fromEntries/);
  assert.match(main, /this\.store\.replaceDomainState\(nextState, \{ type: "curve-presets"/);
  assert.match(main, /getFileForOpening\(\{ types: \["json"\], allowMultiple: false \}\)/);
  assert.match(main, /getFileForSaving\(exported\.filename, \{ types: \["json"\] \}\)/);
  assert.match(main, /\.importPresetLibrary\(/);
  assert.match(main, /\.exportPresetLibrary\(/);
  assert.match(main, /confirmCurvePresetAction/);
  assert.match(main, /copyPresetToUser\(payload\.library, payload\.preset\.id/);
  assert.doesNotMatch(main, /confirmBakedApply:/);
  const hooksStart = main.indexOf("createCurvePresetHooks(dialog");
  const hooks = main.slice(hooksStart, main.indexOf("\n  confirmCurvePresetAction", hooksStart));
  assert.ok(hooks.indexOf("entry.getMetadata()") >= 0, "curve preset import does not preflight UXP metadata");
  assert.ok(hooks.indexOf("entry.getMetadata()") < hooks.indexOf("entry.read({ format: storage.formats.utf8 })"), "curve preset import reads before size preflight");
  assert.match(hooks, /validatePresetImportByteLength\(rawSize\)/);
  assert.match(main, /updateUserPresetOrganization/);
  assert.match(main, /reorderUserPreset/);
  assert.match(main, /createFolder/);
  assert.match(main, /renameFolder/);
  assert.match(main, /deleteFolder/);
  assert.doesNotMatch(main, /window\.prompt|window\.confirm/);
  assert.match(html, /id="curvesPresetDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
});

test("M5 focused suites are part of the full verification stack", () => {
  for (const filename of [
    "m5.curve-math.test.cjs",
    "m5.curve-presets.test.cjs",
    "m5.curves-adapter.test.cjs",
    "m5.curves-workspace.test.cjs",
    "m5.main-controller-acceptance.test.cjs",
  ]) {
    assert.match(packageJson.scripts.check, new RegExp(filename.replace(/\./g, "\\.")));
    assert.match(packageJson.scripts.test, new RegExp(filename.replace(/\./g, "\\.")));
  }
});
