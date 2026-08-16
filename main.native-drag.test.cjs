"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const viewStart = mainSource.indexOf("class ReplayGridView");
const viewEnd = mainSource.indexOf("class GridScaleControl", viewStart);
const gatewayStart = mainSource.indexOf("class PremiereGateway");
const gatewayEnd = mainSource.indexOf("class ReplayGridView", gatewayStart);
const dragHelpersStart = mainSource.indexOf("function normalizeReplayPath");
const dragHelpersEnd = mainSource.indexOf("function pathKey", dragHelpersStart);
const pathKeyStart = dragHelpersEnd;
const pathKeyEnd = mainSource.indexOf("function tickTimeTicks", pathKeyStart);
const addonLoaderStart = mainSource.indexOf("function nativeDragRuntimeInfo");
const addonLoaderEnd = mainSource.indexOf("const nativeDragAddonLoad", addonLoaderStart);
const addonBootstrapRuntimeEnd = mainSource.indexOf("let uxpFs", addonLoaderStart);
const nativeErrorStart = mainSource.indexOf("function nativeDragError");
const nativeErrorEnd = mainSource.indexOf("function pathKey", nativeErrorStart);

assert.ok(
  addonBootstrapRuntimeEnd > addonLoaderStart,
  "native addon bootstrap runtime source must be extractable for race acceptance tests",
);

function readyPackagedFontStatus() {
  return {
    ok: true,
    attempted: true,
    processPrivate: true,
    sessionVisible: false,
    registrationFlags: "FR_PRIVATE",
    registeredFileCount: 3,
    registeredFaceCount: 3,
    items: [
      {
        id: "samsungSharpSansRegular",
        familyName: "Samsung Sharp Sans",
        registered: true,
      },
      {
        id: "samsungSharpSansMedium",
        familyName: "Samsung Sharp Sans",
        registered: true,
      },
      {
        id: "samsungSharpSansBold",
        familyName: "Samsung Sharp Sans",
        registered: true,
      },
    ],
  };
}

function readyNativeAddon() {
  return {
    startNativeFileDrag() {},
    nativeSelfTest() {
      return {
        ok: true,
        architecture: "x64",
        platform: "win32",
        workerAvailable: true,
        replayMediaPreparationAvailable: true,
      };
    },
    getNativeDragSnapshot() {},
    registerPackagedFonts() { return readyPackagedFontStatus(); },
    getPackagedFontStatus() { return readyPackagedFontStatus(); },
    unregisterPackagedFonts() {},
    prepareReplayMedia() {},
    cancelReplayMedia() {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createManualTimers() {
  let currentTime = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, {
        callback,
        dueAt: currentTime + Math.max(0, Number(delay) || 0),
      });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    advance(milliseconds) {
      currentTime += Math.max(0, Number(milliseconds) || 0);
      for (;;) {
        const due = Array.from(tasks.entries())
          .filter(([, task]) => task.dueAt <= currentTime)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0]);
        if (due.length === 0) break;
        const [id, task] = due[0];
        tasks.delete(id);
        task.callback();
      }
    },
    pendingCount() { return tasks.size; },
  };
}

function createAddonBootstrapRuntime(requirePromise) {
  const timers = createManualTimers();
  const diagnostics = [];
  const errors = [];
  const oracleWindow = {};
  let requireCount = 0;
  let initializationCount = 0;
  const context = {
    Array,
    Math,
    Number,
    Object,
    Promise,
    String,
    NATIVE_DRAG_ADDON_NAME: "oracle-native-drag.uxpaddon",
    NATIVE_ADDON_BOOTSTRAP_TIMEOUT_MS: 250,
    ORACLE_PLUGIN_VERSION: "2.0.18",
    navigator: {
      platform: "win32",
      userAgent:
        "Adobe UXP Runtime/uxp-9.3.0-local (win32; x64) Premiere Pro/26.3.0 com.blocky.oracle.v5/2.0.18",
    },
    oracleWindow,
    window: oracleWindow,
    traceNativeCall(_name, operation) { return operation(); },
    tracePremiereCall(_name, operation) { return operation(); },
    require(name) {
      assert.equal(name, "oracle-native-drag.uxpaddon");
      requireCount += 1;
      return requirePromise;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    recordOracleDiagnostic(level, code, details) {
      diagnostics.push({ level, code, details });
    },
    reportOracleCritical(code, error, details) {
      errors.push({ code, error, details });
    },
    scheduleOraclePanelInitialization() {
      initializationCount += 1;
      return { initializationCount };
    },
    console: {
      log() {},
      warn() {},
      error(...values) { errors.push(values); },
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(nativeErrorStart, nativeErrorEnd)}\n` +
      `${mainSource.slice(addonLoaderStart, addonBootstrapRuntimeEnd)}\n` +
      "this.addonBootstrap = {" +
      "completionPromise: nativeDragAddonLoadCompletionPromise," +
      "bootstrapPromise: nativeDragAddonLoadPromise," +
      "snapshot: () => ({ addon: nativeDragAddon, diagnostic: nativeDragAddonDiagnostic," +
      "timedOut: nativeAddonBootstrapTimedOut, recoveryScheduled: nativeAddonLateRecoveryScheduled })" +
      "};",
    context,
    { filename: "main.js#NativeAddonBootstrapRace" },
  );
  return {
    context,
    timers,
    diagnostics,
    errors,
    oracleWindow,
    get requireCount() { return requireCount; },
    get initializationCount() { return initializationCount; },
  };
}

async function flushPromiseTurns(count = 6) {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

async function loadAddonWith(requireResult) {
  const errors = [];
  const logs = [];
  const context = {
    NATIVE_DRAG_ADDON_NAME: "oracle-native-drag.uxpaddon",
    ORACLE_PLUGIN_VERSION: "2.0.18",
    Object,
    String,
    navigator: {
      platform: "win32",
      userAgent:
        "Adobe UXP Runtime/uxp-9.3.0-local (win32; x64) Premiere Pro/26.3.0 com.blocky.oracle.v5/2.0.18",
    },
    require(name) {
      assert.equal(name, "oracle-native-drag.uxpaddon");
      if (requireResult instanceof Error) return Promise.reject(requireResult);
      return Promise.resolve(requireResult);
    },
    traceNativeCall(_name, operation) { return operation(); },
    tracePremiereCall(_name, operation) { return operation(); },
    console: {
      log(...values) {
        logs.push(values);
      },
      error(...values) {
        errors.push(values);
      },
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(nativeErrorStart, nativeErrorEnd)}\n${mainSource.slice(addonLoaderStart, addonLoaderEnd)}\nthis.result = loadNativeDragAddon();`,
    context,
    { filename: "main.js#NativeAddonLoader" },
  );
  return { result: await context.result, errors, logs };
}

test("native addon loader awaits require rejections and distinguishes invalid module shapes", async () => {
  const requireError = new Error("The specified module could not be found");
  requireError.name = "ModuleLoadError";
  const failedRequire = (await loadAddonWith(requireError)).result;
  assert.equal(failedRequire.diagnostic.errorCode, "ADDON_REQUIRE_FAILED");
  assert.equal(failedRequire.diagnostic.details.exceptionName, "ModuleLoadError");
  assert.equal(
    failedRequire.diagnostic.details.exceptionMessage,
    "The specified module could not be found",
  );
  assert.match(failedRequire.diagnostic.details.exceptionStack, /specified module/i);

  assert.equal((await loadAddonWith(null)).result.diagnostic.errorCode, "ADDON_RETURNED_NULL");
  assert.equal((await loadAddonWith({})).result.diagnostic.errorCode, "ADDON_EXPORT_MISSING");
  assert.equal(
    (await loadAddonWith({
      startNativeFileDrag: true,
      nativeSelfTest() {},
      getNativeDragSnapshot() {},
      registerPackagedFonts() {},
      getPackagedFontStatus() {},
      unregisterPackagedFonts() {},
      prepareReplayMedia() {},
      cancelReplayMedia() {},
    })).result.diagnostic.errorCode,
    "ADDON_EXPORT_NOT_FUNCTION",
  );
  assert.equal(
    (await loadAddonWith({
      startNativeFileDrag() {},
      nativeSelfTest() {
        return { ok: false, workerAvailable: false };
      },
      getNativeDragSnapshot() {},
      registerPackagedFonts() { return readyPackagedFontStatus(); },
      getPackagedFontStatus() { return readyPackagedFontStatus(); },
      unregisterPackagedFonts() {},
      prepareReplayMedia() {},
      cancelReplayMedia() {},
    })).result.diagnostic.errorCode,
    "ADDON_SELF_TEST_FAILED",
  );
});

test("native addon loader accepts only callable exports with a ready self-test", async () => {
  const addon = {
    startNativeFileDrag() {},
    nativeSelfTest() {
      return {
        ok: true,
        addonVersion: "2.0.18",
        architecture: "x64",
        platform: "win32",
        workerAvailable: true,
        oleWorkerState: "ready",
        replayMediaPreparationAvailable: true,
      };
    },
    getNativeDragSnapshot() {
      return { requestId: 0, stage: "IDLE" };
    },
    registerPackagedFonts() {
      return readyPackagedFontStatus();
    },
    getPackagedFontStatus() {
      return readyPackagedFontStatus();
    },
    unregisterPackagedFonts() {},
    prepareReplayMedia() {},
    cancelReplayMedia() {},
  };
  const loaded = await loadAddonWith(addon);
  assert.equal(loaded.result.addon, addon);
  assert.equal(loaded.result.diagnostic.ok, true);
  assert.deepEqual(Array.from(loaded.result.diagnostic.addonKeys).sort(), [
    "nativeSelfTest",
    "getNativeDragSnapshot",
    "getPackagedFontStatus",
    "registerPackagedFonts",
    "startNativeFileDrag",
    "unregisterPackagedFonts",
    "prepareReplayMedia",
    "cancelReplayMedia",
  ].sort());
  assert.equal(loaded.result.diagnostic.selfTest.ok, true);
  assert.equal(loaded.result.diagnostic.packagedFonts.ok, true);
  assert.equal(loaded.result.diagnostic.packagedFonts.processPrivate, true);
  assert.equal(loaded.result.diagnostic.packagedFonts.sessionVisible, false);
  assert.equal(loaded.result.diagnostic.packagedFonts.registrationFlags, "FR_PRIVATE");
});

test("native addon bootstrap commits one late success and schedules one controlled reinitialization without requiring twice", async () => {
  const pendingRequire = deferred();
  const addon = readyNativeAddon();
  const harness = createAddonBootstrapRuntime(pendingRequire.promise);

  assert.equal(harness.requireCount, 1, "bootstrap starts one shared hybrid require");
  assert.equal(harness.timers.pendingCount(), 1, "only the bounded UI timeout is pending");

  harness.timers.advance(250);
  const boundedResult = await harness.context.addonBootstrap.bootstrapPromise;
  assert.equal(boundedResult.addon, null);
  assert.equal(boundedResult.diagnostic.errorCode, "ADDON_LOAD_TIMEOUT");
  assert.equal(harness.initializationCount, 0, "timeout continues baseline UI without immediately replacing it");

  pendingRequire.resolve(addon);
  const completionResult = await harness.context.addonBootstrap.completionPromise;
  await flushPromiseTurns();

  const snapshot = harness.context.addonBootstrap.snapshot();
  assert.equal(completionResult.addon, addon);
  assert.equal(snapshot.addon, addon, "the late native result replaces the timeout diagnostic in shared state");
  assert.equal(snapshot.diagnostic.ok, true);
  assert.equal(snapshot.timedOut, true);
  assert.equal(snapshot.recoveryScheduled, true);
  assert.equal(harness.oracleWindow.oracleNativeDragAddon, addon);
  assert.equal(harness.initializationCount, 1, "late readiness schedules exactly one controlled panel replacement");
  assert.equal(harness.requireCount, 1, "the replacement reuses the settled single-flight result");
  assert.equal(
    harness.diagnostics.filter((entry) => entry.code === "NATIVE_ADDON_LATE_RECOVERY").length,
    1,
  );

  harness.timers.advance(5000);
  await flushPromiseTurns();
  assert.equal(harness.initializationCount, 1);
  assert.equal(harness.requireCount, 1);
});

test("native addon bootstrap does not reinitialize for normal sub-timeout success or failed loads", async () => {
  const addon = readyNativeAddon();
  const readyHarness = createAddonBootstrapRuntime(Promise.resolve(addon));
  const readyCompletion = await readyHarness.context.addonBootstrap.completionPromise;
  const readyBootstrap = await readyHarness.context.addonBootstrap.bootstrapPromise;
  await flushPromiseTurns();
  assert.equal(readyCompletion.addon, addon);
  assert.equal(readyBootstrap.addon, addon);
  assert.equal(readyHarness.context.addonBootstrap.snapshot().timedOut, false);
  assert.equal(readyHarness.initializationCount, 0, "normal bootstrap completion already feeds the first controller");
  assert.equal(readyHarness.requireCount, 1);
  assert.equal(readyHarness.timers.pendingCount(), 0);

  const immediateFailure = deferred();
  const failedHarness = createAddonBootstrapRuntime(immediateFailure.promise);
  immediateFailure.reject(new Error("hybrid loader rejected"));
  const failedCompletion = await failedHarness.context.addonBootstrap.completionPromise;
  const failedBootstrap = await failedHarness.context.addonBootstrap.bootstrapPromise;
  await flushPromiseTurns();
  assert.equal(failedCompletion.addon, null);
  assert.equal(failedBootstrap.addon, null);
  assert.equal(failedCompletion.diagnostic.errorCode, "ADDON_REQUIRE_FAILED");
  assert.equal(failedHarness.initializationCount, 0);
  assert.equal(failedHarness.requireCount, 1);

  const lateFailure = deferred();
  const lateFailedHarness = createAddonBootstrapRuntime(lateFailure.promise);
  lateFailedHarness.timers.advance(250);
  await lateFailedHarness.context.addonBootstrap.bootstrapPromise;
  lateFailure.reject(new Error("hybrid loader rejected after timeout"));
  const lateFailedCompletion = await lateFailedHarness.context.addonBootstrap.completionPromise;
  await flushPromiseTurns();
  assert.equal(lateFailedCompletion.addon, null);
  assert.equal(lateFailedCompletion.diagnostic.errorCode, "ADDON_REQUIRE_FAILED");
  assert.equal(lateFailedHarness.context.addonBootstrap.snapshot().timedOut, true);
  assert.equal(lateFailedHarness.initializationCount, 0, "a late failure must not churn the working baseline panel");
  assert.equal(lateFailedHarness.requireCount, 1);
});

test("native addon loader rejects incomplete or throwing packaged font registration", async () => {
  const baseAddon = {
    startNativeFileDrag() {},
    nativeSelfTest() {
      return {
        ok: true,
        architecture: "x64",
        platform: "win32",
        workerAvailable: true,
        replayMediaPreparationAvailable: true,
      };
    },
    getNativeDragSnapshot() {},
    getPackagedFontStatus() { return readyPackagedFontStatus(); },
    unregisterPackagedFonts() {},
    prepareReplayMedia() {},
    cancelReplayMedia() {},
  };
  const partial = await loadAddonWith({
    ...baseAddon,
    registerPackagedFonts() {
      return { ...readyPackagedFontStatus(), ok: false, registeredFileCount: 2 };
    },
  });
  assert.equal(partial.result.addon, null);
  assert.equal(partial.result.diagnostic.errorCode, "PACKAGED_FONT_REGISTRATION_FAILED");

  const thrown = await loadAddonWith({
    ...baseAddon,
    registerPackagedFonts() { throw new Error("font table unavailable"); },
  });
  assert.equal(thrown.result.addon, null);
  assert.equal(thrown.result.diagnostic.errorCode, "PACKAGED_FONT_REGISTRATION_FAILED");
});

function createClassList() {
  const values = new Set();
  return {
    values,
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    },
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    },
  };
}

function createViewHarness(
  nativeResult = { ok: true, dropped: false, cancelled: true },
  nativeDragDebug = false,
) {
  const listeners = new Map();
  const documentListeners = new Map();
  const nativePaths = [];
  const telemetry = [];
  const diagnostics = [];
  const results = [];
  const opens = [];
  const imports = [];
  let snapshotCalls = 0;
  let now = 1000;
  const grid = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    contains() {
      return true;
    },
  };
  const context = {
    Map,
    Array,
    Date,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    console,
    REPLAY_NATIVE_DRAG_THRESHOLD_PX: 5,
    REPLAY_NATIVE_DRAG_SUPPRESSION_MS: 650,
    NATIVE_DRAG_DEBUG: nativeDragDebug,
    uxpFs: null,
    window: { devicePixelRatio: 1 },
    document: {
      addEventListener(type, listener) {
        documentListeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (documentListeners.get(type) === listener) documentListeners.delete(type);
      },
    },
    performance: { now: () => now },
    setTimeout(callback) {
      context.pendingTimer = callback;
      return 1;
    },
    clearTimeout() {},
    setInterval(callback) {
      context.pendingInterval = callback;
      return 2;
    },
    clearInterval() {
      context.pendingInterval = null;
    },
    statusLabel: (replay) => replay.statusMessage || replay.status || "Unavailable",
    isAbsoluteLocalPath: (value) => /^[A-Za-z]:[\\/]/.test(String(value || "")),
    normalizeError: (error) => error,
    logTimelineLabelTelemetry(eventName, details) {
      telemetry.push({ eventName, details });
    },
    recordOracleDiagnostic(level, code, details) {
      diagnostics.push({ level, code, details });
    },
    traceNativeCall(_name, operation) { return operation(); },
    tracePremiereCall(_name, operation) { return operation(); },
    UserFacingError: class UserFacingError extends Error {
      constructor(message, retry, code, details) {
        super(message);
        this.retry = retry;
        this.code = code;
        this.details = details;
      }
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(dragHelpersStart, dragHelpersEnd)}\n${mainSource.slice(viewStart, viewEnd)}\nthis.ReplayGridView = ReplayGridView;`,
    context,
    { filename: "main.js#NativeReplayDragView" },
  );
  const view = new context.ReplayGridView(
    { grid, empty: {}, recentExports: {}, exportCount: {} },
    {
      onOpen(replay) {
        opens.push(replay);
      },
      onInsert(replay) {
        imports.push(replay);
      },
      onNativeDragResult(replay, result, canonicalPath) {
        results.push({ replay, result, canonicalPath });
      },
      onBlockedDrag() {},
      nativeAddon: {
        nativeSelfTest() {
          return { ok: true, oleWorkerState: "ready" };
        },
        startNativeFileDrag(absolutePath) {
          nativePaths.push(absolutePath);
          return Promise.resolve(nativeResult);
        },
        getNativeDragSnapshot() {
          snapshotCalls += 1;
          return {
            requestId: 17,
            stage: "PROMISE_RESOLVED",
            requestReceived: true,
            pathValidated: true,
            leftButtonConfirmed: true,
            workerQueued: true,
            workerAwakened: true,
            oleInitialized: true,
            doDragDropEntered: true,
            doDragDropReturned: true,
            queryContinueDragCalls: 3,
            giveFeedbackCalls: 2,
            escapeObserved: false,
            finalEffect: 1,
            promiseCreated: true,
            promiseResolved: true,
            promiseRejected: false,
            cancellationHookInstalled: true,
            elapsedMs: 24.5,
          };
        },
      },
    },
  );
  const card = {
    dataset: { replayId: "replay-1" },
    classList: createClassList(),
    captured: false,
    closest(selector) {
      return selector === ".replay-card" ? this : null;
    },
    setPointerCapture() {
      this.captured = true;
    },
    hasPointerCapture() {
      return this.captured;
    },
    releasePointerCapture() {
      this.captured = false;
    },
  };
  const replay = {
    id: "replay-1",
    title: "Timeline Clip",
    filepath: "D:\\Blocky Studios Renders\\Unicode 雪 (take 1).mov",
    status: "ready",
  };
  view.replayById.set(replay.id, replay);
  const event = (overrides = {}) => ({
    button: 0,
    buttons: 1,
    pointerId: 42,
    clientX: 10,
    clientY: 20,
    target: card,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...overrides,
  });
  return {
    view,
    card,
    replay,
    event,
    listeners,
    documentListeners,
    nativePaths,
    telemetry,
    diagnostics,
    results,
    opens,
    imports,
    getSnapshotCalls: () => snapshotCalls,
    runTimer: () => context.pendingTimer && context.pendingTimer(),
    setNow: (value) => (now = value),
  };
}

test("pointer movement over threshold never imports and starts native drag exactly once", async () => {
  const harness = createViewHarness();
  assert.deepEqual([...harness.listeners.keys()].sort(), [
    "click",
    "contextmenu",
    "dblclick",
    "error",
    "focusin",
    "keydown",
    "lostpointercapture",
    "pointercancel",
    "pointerdown",
    "pointermove",
    "pointerup",
    "scroll",
  ]);

  harness.view.onReplayPointerDown(harness.event());
  assert.equal(harness.card.classList.values.has("replay-card--drag-pending"), true);
  assert.equal(harness.nativePaths.length, 0, "pointerdown must not dispatch native drag");

  harness.view.onReplayPointerMove(harness.event({ clientX: 12, clientY: 22 }));
  assert.equal(harness.nativePaths.length, 0, "sub-threshold movement dispatched native drag");
  harness.view.onReplayPointerMove(harness.event({ clientX: 13, clientY: 24 }));
  harness.view.onReplayPointerMove(harness.event({ clientX: 30, clientY: 40 }));
  assert.deepEqual(
    harness.nativePaths,
    [harness.replay.filepath],
    "threshold did not enter native OLE synchronously",
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.nativePaths, [harness.replay.filepath]);
  assert.equal(harness.results.length, 1);
  assert.equal(harness.results[0].canonicalPath, harness.replay.filepath);
  assert.equal(harness.view.dragState, null);
  assert.equal(harness.card.captured, false);
  assert.equal(harness.card.classList.values.has("replay-card--drag-pending"), false);
  assert.equal(harness.card.classList.values.has("replay-card--dragging"), false);
  assert.equal(harness.imports.length, 0, "native drag routed into explicit import");
});

test("native drag returns a pending Promise without blocking snapshot polling", async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const harness = createViewHarness(pending, true);
  harness.view.onReplayPointerDown(harness.event());
  harness.view.onReplayPointerMove(harness.event({ clientX: 30, clientY: 40 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.nativePaths, [harness.replay.filepath]);
  assert.equal(harness.card.classList.values.has("replay-card--dragging"), true);
  assert.ok(harness.getSnapshotCalls() >= 1, "snapshot was not polled before awaiting");

  settle({ ok: true, dropped: false, cancelled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.results.length, 1);
  assert.equal(harness.card.classList.values.has("replay-card--dragging"), false);
});

test("native drag records privacy-safe physical latency, completion, and pre-threshold cancellation evidence", async () => {
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  const harness = createViewHarness(pending);
  harness.view.onReplayPointerDown(harness.event());
  harness.view.onReplayPointerMove(harness.event({ clientX: 30, clientY: 40 }));
  harness.setNow(1025);
  settle({
    requestId: 17,
    ok: true,
    dropped: true,
    cancelled: false,
    effect: 1,
    hresult: 262400,
    nativeDispatchMs: 2.75,
    lastStage: "DO_DRAG_DROP_RETURNED",
    requestReceived: true,
    pathValidated: true,
    leftButtonConfirmed: true,
    workerDispatched: true,
    doDragDropEntered: true,
    doDragDropReturned: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const latency = harness.diagnostics.find((entry) => entry.code === "NATIVE_DRAG_INVOCATION_LATENCY");
  const completed = harness.diagnostics.find((entry) => entry.code === "NATIVE_DRAG_COMPLETED");
  assert.equal(latency.details.latencyMs, 0);
  assert.equal(completed.details.totalElapsedMs, 25);
  assert.equal(completed.details.nativeDispatchMs, 2.75);
  assert.equal(completed.details.nativeSnapshotElapsedMs, 24.5);
  assert.equal(completed.details.requestId, 17);
  assert.equal(completed.details.doDragDropEntered, true);
  assert.equal(completed.details.doDragDropReturned, true);
  assert.equal(completed.details.promiseResolved, true);
  assert.equal(completed.details.finalEffect, 1);

  const cancelled = createViewHarness();
  cancelled.view.onReplayPointerDown(cancelled.event());
  cancelled.view.onReplayPointerMove(cancelled.event({ clientX: 12, clientY: 22 }));
  cancelled.view.onDocumentKeyDown(cancelled.event({ key: "Escape", buttons: 0 }));
  const beforeThreshold = cancelled.diagnostics.find((entry) => entry.code === "NATIVE_DRAG_CANCELLED_BEFORE_THRESHOLD");
  assert.ok(beforeThreshold);
  assert.equal(beforeThreshold.details.thresholdPx, 5);
  assert.ok(beforeThreshold.details.movementPx > 0 && beforeThreshold.details.movementPx < 5);
  assert.equal(cancelled.nativePaths.length, 0);
});

test("post-OLE click and dblclick are consumed while ordinary activation remains separate", async () => {
  const dragged = createViewHarness();
  dragged.view.onReplayPointerDown(dragged.event());
  dragged.view.onReplayPointerMove(dragged.event({ clientX: 20, clientY: 30 }));
  await Promise.resolve();
  await Promise.resolve();

  let prevented = 0;
  let immediateStops = 0;
  const synthetic = dragged.event({
    preventDefault() { prevented += 1; },
    stopImmediatePropagation() { immediateStops += 1; },
  });
  dragged.view.onReplayClickCapture(synthetic);
  dragged.view.onReplayDoubleClickCapture(synthetic);
  assert.equal(prevented, 2);
  assert.equal(immediateStops, 2);
  assert.equal(dragged.opens.length, 0);
  assert.equal(dragged.imports.length, 0);

  const clicked = createViewHarness();
  clicked.view.onReplayPointerDown(clicked.event());
  clicked.view.onReplayPointerUp(clicked.event({ buttons: 0 }));
  clicked.view.onReplayClickCapture(clicked.event({ buttons: 0 }));
  assert.equal(clicked.opens.length, 0, "ordinary click selects without opening the replay");
  clicked.view.onReplayDoubleClickCapture(clicked.event({ buttons: 0 }));
  assert.equal(clicked.opens.length, 1, "double-click opens Blocky Studios Viewer");
  assert.equal(clicked.imports.length, 0, "double-click never imports the replay");
});

test("native replay drag filters non-primary and interactive targets and cancels released buttons", () => {
  const harness = createViewHarness();
  harness.view.onReplayPointerDown(harness.event({ button: 1 }));
  assert.equal(harness.view.dragState, null);

  const button = {
    closest(selector) {
      if (selector.includes("button")) return this;
      if (selector === ".replay-card") return harness.card;
      return null;
    },
  };
  harness.view.onReplayPointerDown(harness.event({ target: button }));
  assert.equal(harness.view.dragState, null);

  harness.view.onReplayPointerDown(harness.event());
  harness.view.onReplayPointerMove(harness.event({ buttons: 0, clientX: 40 }));
  assert.equal(harness.nativePaths.length, 0);
  assert.equal(harness.view.dragState, null);
});

test("native drag invokes OLE before any await or ProjectItem work and retains no playhead fallback", () => {
  const viewSource = mainSource.slice(viewStart, viewEnd);
  const beginStart = viewSource.indexOf("  async beginNativeReplayDrag(dragState, thresholdEvent) {");
  const beginEnd = viewSource.indexOf("  handleNativeDragResult(", beginStart);
  const beginSource = viewSource.slice(beginStart, beginEnd);
  assert.match(beginSource, /startNativeFileDrag\(nativeDragPath\)/);
  const invocationIndex = beginSource.indexOf("startNativeFileDrag(nativeDragPath)");
  const firstAwaitIndex = beginSource.indexOf("await ");
  assert.ok(invocationIndex >= 0 && firstAwaitIndex > invocationIndex);
  assert.doesNotMatch(beginSource, /onPrepareNativeDrag|prepareReplaySource|captureNativeDropTimelineSnapshot/);
  assert.doesNotMatch(viewSource, /dragstart|dataTransfer|dropEffect|setDragImage/);
  assert.doesNotMatch(viewSource, /dropReplayAtPlayhead|replay-card--drop-pending/);
});

test("button release after threshold cannot cancel before native OLE invocation", async () => {
  let finishNative;
  const waiting = new Promise((resolve) => {
    finishNative = resolve;
  });
  const harness = createViewHarness(waiting);
  harness.view.onReplayPointerDown(harness.event());
  harness.view.onReplayPointerMove(harness.event({ clientX: 30, clientY: 40 }));
  harness.view.onReplayPointerUp(harness.event({ buttons: 0 }));
  assert.deepEqual(harness.nativePaths, [harness.replay.filepath]);
  assert.equal(harness.results.length, 0);
  finishNative({ ok: true, dropped: false, cancelled: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.results.length, 1);
  assert.equal(harness.results[0].result.cancelled, true);
});

test("Escape after threshold is left to the active native OLE operation", async () => {
  let finishNative;
  const waiting = new Promise((resolve) => {
    finishNative = resolve;
  });
  const harness = createViewHarness(waiting);
  harness.view.onReplayPointerDown(harness.event());
  harness.view.onReplayPointerMove(harness.event({ clientX: 30, clientY: 40 }));
  harness.documentListeners.get("keydown")({
    key: "Escape",
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(harness.nativePaths, [harness.replay.filepath]);
  finishNative({ ok: true, dropped: false, cancelled: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.results[0].result.cancelled, true);
});

test("post-drop reconciliation retains the immutable path actually sent to OLE", async () => {
  let finishNative;
  const waiting = new Promise((resolve) => {
    finishNative = resolve;
  });
  const harness = createViewHarness(waiting);
  const draggedPath = harness.replay.filepath;
  harness.view.onReplayPointerDown(harness.event());
  harness.view.onReplayPointerMove(harness.event({ clientX: 30, clientY: 40 }));
  harness.replay.filepath = "D:\\Blocky Studios Renders\\different.mov";
  finishNative({ ok: true, dropped: true, cancelled: false, effect: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.results[0].canonicalPath, draggedPath);
  const controllerStart = mainSource.indexOf("class OraclePanelController");
  const controllerEnd = mainSource.indexOf("function injectOracleProfiler", controllerStart);
  const controllerSource = mainSource.slice(controllerStart, controllerEnd);
  assert.match(
    controllerSource,
    /scheduleLabelReconciliation\(canonicalPath \|\| replay\.filepath,\s*\{\s*showToast,\s*announce\s*\}\)/,
  );
});

test("filesystem-style forward-slash Windows paths become valid native shell paths", async () => {
  const harness = createViewHarness();
  harness.replay.filepath = "C:/Users/salim/Downloads/clip.mov";
  harness.view.onReplayPointerDown(harness.event());
  harness.view.onReplayPointerMove(harness.event({ clientX: 30, clientY: 40 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.nativePaths, ["C:\\Users\\salim\\Downloads\\clip.mov"]);
});

function createGatewayContext(api, options = {}) {
  const telemetry = [];
  const context = {
    Map,
    Set,
    Math,
    Number,
    Promise,
    String,
    Date,
    console,
    performance: { now: () => 0 },
    NATIVE_DRAG_DEBUG: false,
    uxpFs: null,
    PREMIERE_REPLAY_LABEL_VALUE: 9,
    LABEL_RECONCILE_TIMEOUT_MS: 15000,
    NATIVE_DROP_TRACK_ITEM_TIMEOUT_MS: 5000,
    PROJECT_SCAN_SLICE_MS: 4,
    PROJECT_SCAN_YIELD_ITEMS: 24,
    PREMIERE_REPLAY_BIN_NAME: "Minecraft Replays",
    delay: () => Promise.resolve(),
    yieldToHost: () => Promise.resolve(),
    normalizeReplayPath: (value) => (typeof value === "string" ? value : ""),
    normalizeError: (error) => error,
    logTimelineLabelTelemetry(eventName, details) {
      telemetry.push({ eventName, details });
    },
    setTimeout,
    UserFacingError: class UserFacingError extends Error {
      constructor(message, retry = false, code = "ORACLE_OPERATION_FAILED", details = {}) {
        super(message);
        this.retry = retry;
        this.code = code;
        this.details = details;
      }
    },
    tickTimeTicks: () => "",
    validateImportFilePath: (value) => value,
    traceNativeCall(_name, operation) { return operation(); },
    tracePremiereCall(_name, operation) { return operation(); },
  };
  vm.runInNewContext(
    `${mainSource.slice(pathKeyStart, pathKeyEnd)}\n${mainSource.slice(gatewayStart, gatewayEnd)}\nthis.PremiereGateway = PremiereGateway;`,
    context,
    { filename: "main.js#NativeReplayDragGateway" },
  );
  const gateway = new context.PremiereGateway(api, options);
  gateway.__telemetry = telemetry;
  return gateway;
}

test("ProjectItem lookup scans the fresh active-project tree and accepts exact normalized paths only", async () => {
  let rootCalls = 0;
  const exactA = { type: 1, path: "D:\\renders\\clip.mov" };
  const substring = { type: 1, path: "D:\\renders\\clip.mov.proxy" };
  const exactB = { type: 1, path: "d:/renders/CLIP.mov" };
  const nestedBin = { type: 2, getItems: async () => [exactB] };
  const root = { getItems: async () => [exactA, substring, nestedBin] };
  const api = {
    Project: {
      async getActiveProject() {
        return { async getRootItem() { rootCalls += 1; return root; } };
      },
    },
    ProjectItem: { TYPE_CLIP: 1, TYPE_BIN: 2, TYPE_ROOT: 3 },
    FolderItem: { cast: (item) => item },
    ClipProjectItem: {
      cast(item) {
        return { ...item, getMediaFilePath: async () => item.path };
      },
    },
  };
  const gateway = createGatewayContext(api);
  const matches = await gateway.findExactProjectItemsByMediaPath("D:\\renders\\clip.mov");
  assert.equal(matches.length, 2);
  assert.equal(rootCalls, 1);
  assert.deepEqual(Array.from(matches, (item) => item.path), [exactA.path, exactB.path]);
  assert.doesNotMatch(gateway.findExactProjectItemsByMediaPath.toString(), /findItemsMatchingMediaPath/);
});

test("source readiness imports once, labels before drag readiness, and coalesces by exact path", async () => {
  const order = [];
  let label = 2;
  let locked = false;
  let lookupCalls = 0;
  let importCalls = 0;
  const item = {
    async getMediaFilePath() { return "D:\\renders\\clip.mov"; },
    async getColorLabelIndex() { return label; },
    createSetColorLabelAction(index) {
      assert.equal(locked, true);
      order.push("create-label-action");
      return { index };
    },
    getId() { return "prepared-node-9"; },
  };
  const project = {
    guid: "project-ready",
    async getRootItem() { return {}; },
    lockedAccess(callback) {
      locked = true;
      const result = callback();
      assert.equal(result, undefined);
      locked = false;
    },
    executeTransaction(callback) {
      order.push("label-transaction");
      callback({ addAction(action) { label = action.index; } });
      return true;
    },
  };
  const api = {
    Project: { getActiveProject: async () => project },
    ProjectItem: { cast: (value) => value },
  };
  const gateway = createGatewayContext(api);
  gateway.findExactProjectItemsByMediaPath = async () => {
    lookupCalls += 1;
    await Promise.resolve();
    return [];
  };
  gateway.performImport = async () => {
    importCalls += 1;
    order.push("import");
    return item;
  };

  const first = gateway.prepareReplaySource("D:\\renders\\clip.mov", {
    caller: "native-source-preparation",
  });
  const second = gateway.prepareReplaySource("d:/renders/CLIP.mov", {
    caller: "native-source-preparation",
  });
  const [prepared] = await Promise.all([first, second]);

  assert.equal(lookupCalls, 1);
  assert.equal(importCalls, 1);
  assert.equal(prepared.projectItemId, "prepared-node-9");
  assert.equal(prepared.labelIndex, 9);
  assert.equal(label, 9);
  assert.deepEqual(
    gateway.__telemetry.map((entry) => entry.eventName),
    ["PROJECT_ITEM_FOUND_OR_IMPORTED", "LABEL_ACTION_COMMITTED", "LABEL_9_VERIFIED"],
  );
  assert.ok(order.indexOf("import") < order.indexOf("create-label-action"));
});

test("source readiness rescans and recreates a ProjectItem deleted after prewarm", async () => {
  let present = true;
  let importCalls = 0;
  const createItem = (id) => ({
    async getMediaFilePath() { return "D:\\renders\\deleted.mov"; },
    async getColorLabelIndex() { return 9; },
    createSetColorLabelAction() { throw new Error("already labeled"); },
    getId() { return id; },
  });
  let item = createItem("node-before-delete");
  const project = { guid: "project-delete" };
  const gateway = createGatewayContext({
    Project: { getActiveProject: async () => project },
    ProjectItem: { cast: (value) => value },
  });
  gateway.findExactProjectItemsByMediaPath = async () => (present ? [item] : []);
  gateway.performImport = async () => {
    importCalls += 1;
    present = true;
    item = createItem("node-after-delete");
    return item;
  };
  gateway.applyPremiereLabelValue9 = async () => ({ labelValue: 9 });

  const first = await gateway.prepareReplaySource("D:\\renders\\deleted.mov");
  present = false;
  const second = await gateway.prepareReplaySource("D:\\renders\\deleted.mov", {
    caller: "native-source-preparation",
  });

  assert.equal(first.projectItemId, "node-before-delete");
  assert.equal(second.projectItemId, "node-after-delete");
  assert.equal(importCalls, 1);
});

test("post-drop verification resolves the new TrackItem and matches its prepared ProjectItem identity", async () => {
  const source = { getId: () => "prepared-node-9" };
  const existingSource = { getId: () => "other-node" };
  const trackItem = (name, projectItem) => ({
    async getProjectItem() { return projectItem; },
    async getStartTime() { return { ticks: name === "new" ? "200" : "100" }; },
    async getEndTime() { return { ticks: name === "new" ? "300" : "150" }; },
    async getName() { return name; },
  });
  let items = [trackItem("existing", existingSource)];
  const videoTrack = { async getTrackItems() { return items; } };
  const sequence = {
    async getVideoTrackCount() { return 1; },
    async getAudioTrackCount() { return 0; },
    async getVideoTrack() { return videoTrack; },
  };
  const project = { async getActiveSequence() { return sequence; } };
  const gateway = createGatewayContext({
    Project: { getActiveProject: async () => project },
    ProjectItem: { cast: (value) => value },
    Constants: { TrackItemType: { CLIP: "clip" } },
  });

  const before = await gateway.captureNativeDropTimelineSnapshot();
  items = [...items, trackItem("new", source)];
  const result = await gateway.resolveNativeDropTrackItem(
    {
      absolutePath: "D:\\renders\\clip.mov",
      projectItemId: "prepared-node-9",
    },
    before,
    { timeoutMs: 100, wait: async () => undefined },
  );

  assert.equal(result.resolved, true);
  assert.equal(result.identityMatched, true);
  assert.equal(result.entry.sourceProjectItemId, "prepared-node-9");
  assert.deepEqual(
    gateway.__telemetry.slice(-2).map((entry) => entry.eventName),
    ["TIMELINE_TRACK_ITEM_RESOLVED", "TRACK_ITEM_PROJECT_ITEM_IDENTITY_MATCHED"],
  );
});

test("label reconciliation retries with bounded backoff and verifies label index 9", async () => {
  let label = 3;
  let locked = false;
  let findCalls = 0;
  let now = 0;
  const waits = [];
  const projectItem = {
    getColorLabelIndex: async () => label,
    createSetColorLabelAction(index) {
      assert.equal(locked, true, "label action was created outside lockedAccess");
      return { index };
    },
  };
  const project = {
    lockedAccess(callback) {
      locked = true;
      const returned = callback();
      assert.equal(returned, undefined, "label lockedAccess callback became async");
      locked = false;
    },
    executeTransaction(callback) {
      assert.equal(locked, true, "label transaction ran outside lockedAccess");
      callback({
        addAction(action) {
          label = action.index;
        },
      });
      return true;
    },
  };
  const api = { Project: { getActiveProject: async () => project } };
  const gateway = createGatewayContext(api);
  gateway.findExactProjectItemsByMediaPath = async () => {
    findCalls += 1;
    return findCalls >= 3 ? [projectItem] : [];
  };
  const items = await gateway.waitForProjectItemsByExactPath("D:\\renders\\clip.mov", {
    timeoutMs: 1000,
    initialDelayMs: 100,
    maxDelayMs: 400,
    now: () => now,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  assert.deepEqual(waits, [100, 165, 272]);
  assert.equal(items.length, 1);
  assert.equal(await gateway.applyAndVerifyLabel9(projectItem), true);
  assert.equal(label, 9);
  assert.equal(await projectItem.getColorLabelIndex(), 9);
});

test("label reconciliation reports a structured timeout without importing media", async () => {
  let now = 0;
  const gateway = createGatewayContext({ Project: {} });
  gateway.findExactProjectItemsByMediaPath = async () => [];
  await assert.rejects(
    gateway.waitForProjectItemsByExactPath("D:\\renders\\missing-item.mov", {
      timeoutMs: 250,
      initialDelayMs: 100,
      maxDelayMs: 100,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    }),
    (error) => error.code === "LABEL_RECONCILE_FAILED",
  );
  assert.doesNotMatch(
    gateway.waitForProjectItemsByExactPath.toString(),
    /importFiles|importReplay|createInsertProjectItemAction/,
  );
});

test("concurrent label reconciliation for one exact path is coalesced without importing a duplicate", async () => {
  const gateway = createGatewayContext({ Project: {} });
  let lookupCalls = 0;
  let labelCalls = 0;
  const projectItem = { id: "one-project-item" };
  gateway.waitForProjectItemsByExactPath = async () => {
    lookupCalls += 1;
    await Promise.resolve();
    return [projectItem];
  };
  gateway.applyAndVerifyLabel9 = async (item) => {
    assert.equal(item, projectItem);
    labelCalls += 1;
    return true;
  };
  const first = gateway.scheduleLabelReconciliation("D:\\renders\\clip.mov");
  const second = gateway.scheduleLabelReconciliation("d:/renders/CLIP.mov");
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(lookupCalls, 1);
  assert.equal(labelCalls, 1);
  assert.doesNotMatch(
    gateway.scheduleLabelReconciliation.toString(),
    /importFiles|importReplay|createInsertProjectItemAction/,
  );
});

test("replay-bin and label actions are created synchronously inside lockedAccess", async () => {
  const order = [];
  let locked = false;
  let created = false;
  const createdBin = { type: 2, name: "Minecraft Replays" };
  const root = {
    async getItems() {
      order.push("read-items");
      return created ? [createdBin] : [];
    },
    createBinAction(name, makeUnique) {
      assert.equal(locked, true, "createBinAction ran outside lockedAccess");
      assert.equal(name, "Minecraft Replays");
      assert.equal(makeUnique, true);
      order.push("create-bin-action");
      return { type: "create-bin" };
    },
  };
  const project = {
    guid: "project-1",
    lockedAccess(callback) {
      order.push("lock-enter");
      locked = true;
      const returned = callback();
      assert.equal(returned, undefined, "lockedAccess callback became async");
      locked = false;
      order.push("lock-exit");
    },
    executeTransaction(callback) {
      assert.equal(locked, true, "executeTransaction ran outside lockedAccess");
      order.push("transaction");
      callback({ addAction() { created = true; order.push("add-action"); } });
      return true;
    },
  };
  const api = {
    FolderItem: { cast: (item) => item },
    ProjectItem: { TYPE_BIN: 2 },
  };
  const gateway = createGatewayContext(api);
  assert.equal(await gateway.getOrCreateReplayBin(project, root), createdBin);
  assert.deepEqual(order, [
    "read-items",
    "lock-enter",
    "transaction",
    "create-bin-action",
    "add-action",
    "lock-exit",
    "read-items",
  ]);
});

test("performImport suppresses consumed drag activation and keeps importFiles outside the lock", async () => {
  const suppression = { gestureId: "gesture-9", replayId: "replay-1", activationConsumed: true };
  const guarded = createGatewayContext({}, { getImportSuppression: () => suppression });
  await assert.rejects(
    guarded.performImport({}, "D:\\renders\\clip.mov", "dblclick"),
    (error) => error.code === "IMPORT_SUPPRESSED_AFTER_DRAG",
  );

  let locked = false;
  const importedItem = { path: "D:\\renders\\clip.mov" };
  const root = {};
  const project = {
    async getRootItem() { return root; },
    lockedAccess(callback) { locked = true; callback(); locked = false; },
    async importFiles() {
      assert.equal(locked, false, "importFiles ran inside lockedAccess");
      return true;
    },
  };
  const gateway = createGatewayContext({ ProjectItem: { cast: (item) => item } });
  let scans = 0;
  gateway.findClipByPath = async () => (++scans > 1 ? importedItem : null);
  gateway.getOrCreateReplayBin = async () => ({ name: "Minecraft Replays" });
  assert.equal(await gateway.performImport(project, importedItem.path, "explicit-import"), importedItem);
});

test("locked-access failures retain PROJECT_LOCK_REQUIRED and never become NO_REPLAY_PATH", async () => {
  const root = { getItems: async () => [] };
  const api = { FolderItem: { cast: (item) => item }, ProjectItem: { TYPE_BIN: 2 } };
  const gateway = createGatewayContext(api);
  const project = {
    guid: "locked-project",
    lockedAccess() { throw new Error("Requires locked access"); },
  };
  await assert.rejects(
    gateway.getOrCreateReplayBin(project, root),
    (error) => error.code === "PROJECT_LOCK_REQUIRED" && error.code !== "NO_REPLAY_PATH",
  );
});

test("manifest enables the Release x64 hybrid addon without changing plugin version", () => {
  assert.equal(manifest.manifestVersion, 6);
  assert.equal(manifest.version, "2.0.18");
  assert.equal(manifest.host.minVersion, "26.3.0");
  assert.deepEqual(manifest.addon, { name: "oracle-native-drag.uxpaddon" });
  assert.equal(manifest.requiredPermissions.enableAddon, true);
  assert.equal(manifest.requiredPermissions.localFileSystem, "fullAccess");
  assert.match(mainSource, /await traceNativeCall\(["']require\(oracle-native-drag\.uxpaddon\)["'],\s*\(\) => require\(NATIVE_DRAG_ADDON_NAME\)\)/);
  assert.doesNotMatch(mainSource, /ADDON_UNAVAILABLE/);
  assert.doesNotMatch(mainSource, /Preparing import/);
});
