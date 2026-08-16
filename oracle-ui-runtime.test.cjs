// @ts-nocheck -- Node test doubles intentionally sit outside the UXP jsconfig.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const runtimeApi = require("./src/core/oracle-ui-runtime.js");
const buildGenerator = require("./release/generate-ui-build.cjs");

class FakeRoot {
  constructor(width, height, panelId = "oraclePanel") {
    this.width = width;
    this.height = height;
    this.clientWidth = width;
    this.clientHeight = height;
    this.dataset = { oraclePanelRoot: panelId };
    this.attributes = new Map();
    this.children = [];
    this.ownerDocument = {
      documentElement: { dataset: { theme: "dark" } },
      fonts: { status: "loaded" },
    };
  }

  getBoundingClientRect() { return { width: this.width, height: this.height }; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  querySelectorAll() { return this.children; }
}

function frameHarness() {
  const callbacks = new Map();
  let next = 1;
  return {
    request(callback) { const id = next++; callbacks.set(id, callback); return id; },
    cancel(id) { callbacks.delete(id); },
    flush() {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      for (const callback of pending) callback();
    },
    count() { return callbacks.size; },
  };
}

test("viewport classifiers preserve every required boundary", () => {
  assert.deepEqual(
    [0, 279, 280, 419, 420, 639, 640, 879, 880].map(runtimeApi.classifyWidth),
    ["micro", "micro", "narrow", "narrow", "compact", "compact", "standard", "standard", "wide"],
  );
  assert.deepEqual(
    [0, 519, 520, 799, 800].map(runtimeApi.classifyHeight),
    ["short", "short", "standard-height", "standard-height", "tall"],
  );
});

test("mount measures synchronously, writes contract aliases, coalesces resize, and is idempotent", () => {
  const frames = frameHarness();
  let observerCallback = null;
  let disconnects = 0;
  class FakeResizeObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { disconnects += 1; }
  }
  const buildLogs = [];
  const runtime = runtimeApi.createOracleUiRuntime({
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
    console: { log(...values) { buildLogs.push(values); } },
    buildInfo: { version: "2.0.18", id: "test", digest: "ABC", generatedAt: "2026-01-01T00:00:00.000Z" },
  });
  const root = new FakeRoot(279, 519);
  const first = runtime.mount(root, { panelId: "oraclePanel" });
  const second = runtime.mount(root, { panelId: "oraclePanel" });
  assert.equal(first, second);
  assert.equal(
    buildLogs.filter((entry) => entry[0] === "[Blocky Studios][UI_BUILD]").length,
    1,
    "build identity logs exactly once for an idempotent root mount",
  );
  assert.equal(buildLogs.find((entry) => entry[0] === "[Blocky Studios][UI_BUILD]")[1].buildId, "test");
  assert.equal(
    buildLogs.filter((entry) => entry[0] === "[Blocky Studios][PLATFORM_RENDER]").length,
    1,
    "render proof logs exactly once for an idempotent root mount",
  );
  assert.equal(first.snapshot().widthClass, "micro");
  assert.equal(first.snapshot().heightClass, "short");
  assert.equal(root.getAttribute("data-width-class"), "micro");
  assert.equal(root.getAttribute("data-height-class"), "short");
  assert.equal(root.getAttribute("data-panel-visible"), "true");
  assert.equal(root.getAttribute("data-oracle-width-class"), "micro");
  assert.equal(root.getAttribute("data-oracle-height-class"), "short");
  assert.equal(root.getAttribute("data-oracle-panel-visible"), "true");
  assert.equal(root.getAttribute("data-oracle-panel-density"), "compact");
  assert.equal(root.getAttribute("data-oracle-max-width-340"), "true");
  assert.equal(root.getAttribute("data-oracle-max-width-720"), "true");
  assert.equal(root.getAttribute("data-oracle-min-width-601"), "false");
  assert.equal(root.getAttribute("data-oracle-max-height-420"), "false");
  assert.equal(root.getAttribute("data-oracle-max-height-520"), "true");
  assert.equal(first.snapshot().visible, true);
  assert.equal(first.setVisible(false), true);
  assert.equal(first.snapshot().visible, false);
  assert.equal(root.getAttribute("data-panel-visible"), "false");
  assert.equal(root.getAttribute("data-oracle-panel-visible"), "false");
  assert.equal(first.setVisible(true), true);
  assert.equal(runtime.captureAfterLayout(root, "first-proof"), true);
  assert.equal(runtime.captureAfterLayout(root, "final-proof"), true);
  assert.equal(frames.count(), 1, "settled render proofs coalesce with the root measurement frame");

  const snapshots = [];
  const unsubscribe = runtime.subscribe(root, (snapshot) => snapshots.push(snapshot), { immediate: true });
  root.width = 880;
  root.height = 800;
  observerCallback();
  observerCallback();
  observerCallback();
  assert.equal(frames.count(), 1, "resize work is frame-coalesced");
  frames.flush();
  const settledProofs = buildLogs.filter((entry) => entry[0] === "[Blocky Studios][PLATFORM_RENDER]");
  assert.equal(settledProofs.length, 2);
  assert.equal(JSON.parse(settledProofs.at(-1)[1]).reason, "final-proof");
  assert.equal(snapshots.at(-1).widthClass, "wide");
  assert.equal(snapshots.at(-1).heightClass, "tall");
  assert.equal(root.getAttribute("data-width-class"), "wide");
  assert.equal(root.getAttribute("data-height-class"), "tall");
  assert.equal(root.getAttribute("data-oracle-panel-density"), "wide");
  assert.equal(root.getAttribute("data-oracle-max-width-720"), "false");
  assert.equal(root.getAttribute("data-oracle-min-width-601"), "true");
  assert.equal(root.getAttribute("data-oracle-max-height-520"), "false");
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  assert.equal(first.destroy(), true);
  assert.equal(root.getAttribute("data-panel-visible"), "false");
  assert.equal(root.getAttribute("data-oracle-panel-visible"), "false");
  assert.equal(first.destroy(), false);
  assert.equal(disconnects, 1);
});

test("a zero-sized Premiere tab remeasures on an idempotent show and logs its first measurable layout once", () => {
  const frames = frameHarness();
  let observerCallback = null;
  class FakeResizeObserver {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const logs = [];
  const runtime = runtimeApi.createOracleUiRuntime({
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
    console: { log(...values) { logs.push(values); } },
  });
  const root = new FakeRoot(0, 0, "oracleQuickApplyPanel");
  const handle = runtime.mount(root, { panelId: "oracleQuickApplyPanel", visible: true });
  assert.equal(handle.snapshot().width, 0);

  root.width = 240;
  root.height = 320;
  assert.equal(handle.setVisible(true), false, "logical visibility remains idempotent");
  assert.equal(handle.snapshot().width, 240, "host show forces a synchronous root remeasurement");
  assert.equal(handle.snapshot().height, 320);
  assert.equal(frames.count(), 1, "show proof shares the single root-owned frame");
  frames.flush();

  const proofs = logs
    .filter((entry) => entry[0] === "[Blocky Studios][PLATFORM_RENDER]")
    .map((entry) => JSON.parse(entry[1]));
  assert.deepEqual(
    proofs.map((proof) => proof.reason),
    ["initial-mount", "first-measurable-layout", "panel-visible-settled"],
  );
  observerCallback();
  frames.flush();
  assert.equal(
    logs.filter((entry) => entry[0] === "[Blocky Studios][PLATFORM_RENDER]")
      .map((entry) => JSON.parse(entry[1]))
      .filter((proof) => proof.reason === "first-measurable-layout").length,
    1,
    "the automatic first-measurable proof never duplicates",
  );
});

test("responsive matrix and rapid resize lifecycle remain exact across hide, close, and reopen", () => {
  const frames = frameHarness();
  const observers = [];
  class TrackingResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      this.disconnectCount = 0;
      observers.push(this);
    }

    observe(root) { this.observed.add(root); }
    disconnect() {
      this.disconnectCount += 1;
      this.observed.clear();
    }

    trigger() { this.callback(); }
  }
  const runtime = runtimeApi.createOracleUiRuntime({
    ResizeObserver: TrackingResizeObserver,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
  });
  const matrix = [
    { width: 240, height: 500, widthClass: "micro", heightClass: "short" },
    { width: 280, height: 600, widthClass: "narrow", heightClass: "standard-height" },
    { width: 320, height: 700, widthClass: "narrow", heightClass: "standard-height" },
    { width: 380, height: 800, widthClass: "narrow", heightClass: "tall" },
    { width: 420, height: 600, widthClass: "compact", heightClass: "standard-height" },
    { width: 480, height: 800, widthClass: "compact", heightClass: "tall" },
    { width: 600, height: 700, widthClass: "compact", heightClass: "standard-height" },
    { width: 720, height: 900, widthClass: "standard", heightClass: "tall" },
    { width: 900, height: 900, widthClass: "wide", heightClass: "tall" },
    { width: 1200, height: 900, widthClass: "wide", heightClass: "tall" },
  ];
  const firstSize = matrix[0];
  const root = new FakeRoot(firstSize.width, firstSize.height, "responsivePanel");
  const firstHandle = runtime.mount(root, { panelId: "responsivePanel" });
  const firstObserver = observers[0];
  const firstSnapshots = [];
  const unsubscribeFirst = firstHandle.subscribe((snapshot) => firstSnapshots.push(snapshot));

  for (const [index, expected] of matrix.entries()) {
    if (index > 0) {
      root.width = expected.width;
      root.height = expected.height;
      firstObserver.trigger();
      assert.equal(frames.count(), 1, `size ${expected.width}x${expected.height} schedules one frame`);
      frames.flush();
    }
    const snapshot = firstHandle.snapshot();
    assert.deepEqual(
      {
        width: snapshot.width,
        height: snapshot.height,
        widthClass: snapshot.widthClass,
        heightClass: snapshot.heightClass,
        viewportClass: snapshot.viewportClass,
      },
      {
        width: expected.width,
        height: expected.height,
        widthClass: expected.widthClass,
        heightClass: expected.heightClass,
        viewportClass: `${expected.widthClass} ${expected.heightClass}`,
      },
      `responsive contract at ${expected.width}x${expected.height}`,
    );
    assert.equal(root.getAttribute("data-width-class"), expected.widthClass);
    assert.equal(root.getAttribute("data-height-class"), expected.heightClass);
    assert.equal(root.getAttribute("data-oracle-viewport-width"), String(expected.width));
    assert.equal(root.getAttribute("data-oracle-viewport-height"), String(expected.height));
  }
  assert.equal(firstSnapshots.length, matrix.length, "subscriber receives the initial size and all nine transitions");

  const beforeBurst = firstSnapshots.length;
  for (let index = 0; index < 30; index += 1) {
    root.width = 241 + (index * 11);
    root.height = 501 + (index * 7);
    firstObserver.trigger();
  }
  assert.equal(frames.count(), 1, "thirty rapid size changes share one scheduled frame");
  frames.flush();
  assert.equal(firstSnapshots.length, beforeBurst + 1, "thirty rapid size changes notify once");
  assert.equal(firstHandle.snapshot().width, 560);
  assert.equal(firstHandle.snapshot().height, 704);
  assert.equal(firstHandle.snapshot().widthClass, "compact");
  assert.equal(firstHandle.snapshot().heightClass, "standard-height");

  assert.equal(firstHandle.setVisible(false), true);
  assert.equal(firstHandle.snapshot().visible, false);
  assert.equal(root.getAttribute("data-panel-visible"), "false");
  assert.equal(firstHandle.setVisible(true), true);
  assert.equal(firstHandle.snapshot().visible, true);
  assert.equal(root.getAttribute("data-panel-visible"), "true");
  assert.equal(runtime.audit({ root }).panels[0].subscriberCount, 1);

  const callbacksBeforeClose = firstSnapshots.length;
  root.width = 640;
  root.height = 900;
  firstObserver.trigger();
  assert.equal(frames.count(), 1, "a pending resize exists before close");
  assert.equal(firstHandle.destroy(), true);
  assert.equal(frames.count(), 0, "close cancels the pending resize frame");
  assert.equal(firstObserver.disconnectCount, 1, "close disconnects its observer exactly once");
  assert.equal(firstObserver.observed.size, 0);
  assert.equal(runtime.audit().mountedRootCount, 0);
  assert.equal(runtime.snapshot(root), null);
  assert.equal(root.getAttribute("data-panel-visible"), "false");
  frames.flush();
  firstObserver.trigger();
  frames.flush();
  assert.equal(frames.count(), 0, "a detached observer cannot schedule more work");
  assert.equal(firstSnapshots.length, callbacksBeforeClose, "no subscriber callback runs after close");
  assert.equal(unsubscribeFirst(), false, "close already removed the first subscription");

  root.width = 420;
  root.height = 700;
  const reopenedHandle = runtime.mount(root, { panelId: "responsivePanel" });
  const reopenedObserver = observers[1];
  const reopenedSnapshots = [];
  const unsubscribeReopened = reopenedHandle.subscribe((snapshot) => reopenedSnapshots.push(snapshot));
  assert.notEqual(reopenedHandle, firstHandle, "reopen creates a fresh lifecycle handle");
  assert.equal(observers.length, 2, "reopen creates a fresh observer");
  assert.equal(reopenedSnapshots.length, 1);
  assert.equal(reopenedHandle.snapshot().widthClass, "compact");
  assert.equal(reopenedHandle.snapshot().heightClass, "standard-height");
  assert.equal(reopenedHandle.snapshot().visible, true);
  assert.equal(root.getAttribute("data-panel-visible"), "true");
  assert.equal(runtime.audit({ root }).panels[0].subscriberCount, 1);

  root.width = 280;
  root.height = 600;
  reopenedObserver.trigger();
  frames.flush();
  assert.equal(reopenedSnapshots.length, 2);
  assert.equal(reopenedHandle.snapshot().widthClass, "narrow");
  assert.equal(reopenedHandle.snapshot().heightClass, "standard-height");
  assert.equal(unsubscribeReopened(), true);
  assert.equal(runtime.audit({ root }).panels[0].subscriberCount, 0);
  const callbacksBeforeFinalClose = reopenedSnapshots.length;
  assert.equal(runtime.unmount(root), true);
  assert.equal(reopenedObserver.disconnectCount, 1);
  reopenedObserver.trigger();
  frames.flush();
  assert.equal(reopenedSnapshots.length, callbacksBeforeFinalClose, "no callback runs after the reopened panel closes");
  assert.equal(runtime.audit().mountedRootCount, 0);
});

test("window resize fallback is installed once and removed on unmount", () => {
  const frames = frameHarness();
  const listeners = new Map();
  const fakeWindow = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
  };
  const runtime = runtimeApi.createOracleUiRuntime({
    window: fakeWindow,
    ResizeObserver: null,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
  });
  const root = new FakeRoot(320, 600);
  runtime.mount(root);
  assert.equal(typeof listeners.get("resize"), "function");
  root.width = 640;
  listeners.get("resize")();
  listeners.get("resize")();
  assert.equal(frames.count(), 1);
  frames.flush();
  assert.equal(runtime.snapshot(root).widthClass, "standard");
  assert.equal(runtime.unmount(root), true);
  assert.equal(listeners.has("resize"), false);
});

test("development UI health reports build, dimensions, theme, font leaks, duplicate IDs, and zero-sized regions", () => {
  const duplicateA = { id: "duplicate", tagName: "SPAN", className: "copy", textContent: "Copy", hidden: false, getAttribute() { return null; } };
  const duplicateB = { id: "duplicate", tagName: "BUTTON", className: "action", textContent: "Action", hidden: false, getAttribute() { return null; } };
  const zero = {
    id: "zero-region", tagName: "DIV", className: "region", hidden: false,
    getAttribute() { return null; }, getBoundingClientRect() { return { width: 0, height: 50 }; },
  };
  const root = new FakeRoot(420, 520);
  root.children = [duplicateA, duplicateB, zero];
  const runtime = runtimeApi.createOracleUiRuntime({
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle(element) {
      return { display: "block", visibility: "visible", fontFamily: element === duplicateB ? "Arial" : '"Samsung Sharp Sans"' };
    },
    buildInfo: { version: "2.0.18", id: "2.0.18+abc", digest: "ABC", generatedAt: "2026-01-01T00:00:00.000Z" },
  });
  runtime.mount(root, { panelId: "oraclePanel" });
  const report = runtime.audit();
  assert.equal(report.build.id, "2.0.18+abc");
  assert.equal(report.mountedRootCount, 1);
  assert.equal(report.panels[0].root.widthClass, "compact");
  assert.equal(report.panels[0].root.heightClass, "standard-height");
  assert.equal(report.panels[0].theme, "dark");
  assert.equal(report.panels[0].duplicateIds[0].id, "duplicate");
  assert.equal(report.panels[0].fonts.unexpected[0].fontFamily, "Arial");
  assert.ok(report.panels[0].zeroSizedVisibleRegions.some((entry) => entry.id === "zero-region"));
});

test("development UI health excludes zero-sized descendants of hidden ancestors", () => {
  const root = new FakeRoot(420, 520);
  const hiddenParent = {
    tagName: "DIV",
    hidden: true,
    parentElement: root,
    getAttribute() { return null; },
  };
  const hiddenSvg = {
    id: "hidden-preview",
    tagName: "SVG",
    className: "preview",
    hidden: false,
    parentElement: hiddenParent,
    getAttribute() { return null; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
  root.children = [hiddenSvg];
  const runtime = runtimeApi.createOracleUiRuntime({
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle() { return { display: "block", visibility: "visible", fontFamily: '"Samsung Sharp Sans"' }; },
  });
  runtime.mount(root, { panelId: "oracleCurvesPanel" });
  assert.deepEqual(runtime.audit().panels[0].zeroSizedVisibleRegions, []);
});

test("development UI health uses the UXP offset box when rect and client geometry are zero", () => {
  const paintedControl = {
    id: "uxp-painted-control",
    tagName: "BUTTON",
    className: "action",
    textContent: "Apply",
    hidden: false,
    parentElement: null,
    clientWidth: 0,
    clientHeight: 0,
    offsetWidth: 144,
    offsetHeight: 32,
    getAttribute(name) { return name === "type" ? "button" : null; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
  const root = new FakeRoot(420, 520);
  paintedControl.parentElement = root;
  root.children = [paintedControl];
  const runtime = runtimeApi.createOracleUiRuntime({
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle() {
      return {
        display: "inline-block",
        visibility: "visible",
        fontFamily: '"Samsung Sharp Sans"',
      };
    },
  });
  runtime.mount(root, { panelId: "oraclePanel" });
  const control = runtime.audit().panels[0].controls.inventory[0];
  assert.equal(control.id, "uxp-painted-control");
  assert.equal(control.width, 144);
  assert.equal(control.height, 32);
});

test("development UI health reports observable assets, diagnostics, owned resources, and real host context", () => {
  const records = [];
  const diagnostics = {
    record(level, code) {
      const entry = { sequence: records.length + 1, level, code, details: {} };
      records.push(entry);
      return entry;
    },
    summary() {
      return {
        bounded: true,
        capacity: 200,
        totalRetained: records.length,
        latestSequence: records.length,
        records: records.slice(),
      };
    },
  };
  const listeners = new Map();
  const fakeWindow = {
    oracleDiagnostics: diagnostics,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
  };
  const asset = (tagName, name, reference, extra = {}) => ({
    tagName,
    [name]: reference,
    getAttribute(attribute) { return attribute === name ? reference : null; },
    ...extra,
  });
  const failedImage = asset("IMG", "src", "assets/logo/missing.png", { complete: true, naturalWidth: 0 });
  const failedStyle = asset("LINK", "href", "dist/missing.css", { rel: "stylesheet", sheet: null });
  const loadedImage = asset("IMG", "src", "assets/logo/loaded.png", { complete: true, naturalWidth: 128 });
  const fakeDocument = {
    readyState: "complete",
    documentElement: { dataset: { theme: "dark" } },
    fonts: { status: "loaded" },
    querySelectorAll() { return [failedImage, failedStyle, loadedImage]; },
    querySelector() { return null; },
  };
  const runtime = runtimeApi.createOracleUiRuntime({
    window: fakeWindow,
    document: fakeDocument,
    ResizeObserver: class { observe() {} disconnect() {} },
    healthContextProvider() {
      return {
        available: true,
        currentRoute: "curves",
        nativeAddon: { available: true, status: "ready", errorCode: "" },
        graphAnimation: {
          available: true,
          schedulerModel: "one-shot-requestAnimationFrame",
          workspaceCount: 1,
          activeFrameCount: 1,
          multipleActiveFrames: false,
          continuousLoopCount: 0,
        },
        renderCount: { available: false, reason: "OPT_IN_PERFORMANCE_PROFILER_INACTIVE" },
      };
    },
  });
  const firstRoot = new FakeRoot(640, 700, "oracleCurvesPanel");
  const secondRoot = new FakeRoot(640, 700, "oracleCurvesPanel");
  firstRoot.ownerDocument = fakeDocument;
  secondRoot.ownerDocument = fakeDocument;
  runtime.mount(firstRoot, { panelId: "oracleCurvesPanel" });
  runtime.mount(secondRoot, { panelId: "oracleCurvesPanel" });
  const unsubscribe = runtime.subscribe(firstRoot, () => undefined);

  const failedScript = asset("SCRIPT", "src", "src/missing.js");
  for (const listener of listeners.get("error") || []) listener({ target: failedScript });
  for (const listener of listeners.get("error") || []) listener({ target: fakeWindow, message: "boom" });
  for (const listener of listeners.get("unhandledrejection") || []) listener({ reason: new Error("rejected") });

  const report = runtime.audit();
  assert.equal(report.currentRoute, "curves");
  assert.equal(report.nativeAddon.available, true);
  assert.equal(report.graphAnimation.activeFrameCount, 1);
  assert.equal(report.renderCount.available, false);
  assert.equal(report.localAssets.checked, 3);
  assert.equal(report.localAssets.stateObservable, 3);
  assert.deepEqual(
    report.localAssets.failures.map((failure) => failure.reference).sort(),
    ["assets/logo/missing.png", "dist/missing.css", "src/missing.js"],
  );
  assert.equal(report.diagnostics.unhandledErrorCount, 2);
  assert.equal(report.diagnostics.errorCount, 3);
  assert.equal(report.runtimeOwnership.subscriberCount, 1);
  assert.equal(report.runtimeOwnership.resizeObserverCount, 2);
  assert.deepEqual(report.runtimeOwnership.repeatedPanelIds, [
    { panelId: "oracleCurvesPanel", instanceCount: 2 },
  ]);
  assert.equal(report.runtimeOwnership.globalListenerCensusAvailable, false);
  assert.equal(unsubscribe(), true);
});

test("development error capture degrades safely when the UXP host rejects global event types", () => {
  const runtime = runtimeApi.createOracleUiRuntime({
    window: {
      addEventListener() { throw new Error("unsupported"); },
    },
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  runtime.mount(new FakeRoot(320, 600));
  assert.deepEqual(runtime.audit().globalErrorCapture, {
    errorEvents: false,
    unhandledRejections: false,
  });
});

test("build generator excludes its output and produces a stable digest for unchanged runtime inputs", () => {
  assert.equal(buildGenerator.isRuntimeInput("src/generated/oracle-build-info.js"), false);
  assert.equal(buildGenerator.isRuntimeInput("native/build/stage/win/x64/oracle-native-drag.uxpaddon"), false);
  assert.equal(buildGenerator.isRuntimeInput("src/core/oracle-ui-runtime.js"), true);
  require("./release/build-ui.cjs").build();
  const paths = buildGenerator.referencedRuntimeInputs();
  assert.ok(paths.includes("manifest.json"));
  assert.ok(paths.includes("src/core/oracle-ui-runtime.js"));
  assert.ok(paths.includes("dist/blocky-studios-ui.css"));
  assert.ok(paths.includes("assets/fonts/samsung_sharp_sans_regular.otf"));
  assert.ok(paths.includes("assets/icons/menu.png"));
  assert.ok(paths.includes("assets/icons/settings.png"));
  assert.ok(paths.includes("win/x64/oracle-native-drag.uxpaddon"));
  assert.ok(paths.includes("win/x64/media/ffmpeg.exe"));
  assert.ok(paths.includes("win/x64/media/avcodec-60.dll"));
  assert.ok(!paths.includes("src/generated/oracle-build-info.js"));
  assert.ok(!paths.includes("release/generate-ui-build.cjs"));
  assert.ok(!paths.includes("win/x64/oracle-native-drag-m3.uxpaddon"));
  const first = buildGenerator.digestInputs(paths);
  const second = buildGenerator.digestInputs(paths);
  assert.equal(first, second);
  assert.match(first, /^[A-F0-9]{64}$/);
  const cache = buildGenerator.stampEntrypointCacheKey(first);
  const indexSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
  assert.equal(cache.key, first.slice(0, 16).toLowerCase());
  assert.ok(cache.referenceCount >= 25);
  assert.doesNotMatch(indexSource, /blocky-ui=2\.0\.18/);
  assert.ok(Array.from(indexSource.matchAll(/blocky-ui=([^"']+)/g)).every((match) => match[1] === cache.key));
  assert.equal(buildGenerator.digestInputs(paths), first, "stamping the derived key cannot perturb the normalized build digest");
});
