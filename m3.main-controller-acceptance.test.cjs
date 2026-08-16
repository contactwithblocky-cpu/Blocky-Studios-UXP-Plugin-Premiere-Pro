"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const oracleShellApi = require("./src/app/oracle-shell.js");

const root = __dirname;
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const m3Css = fs.readFileSync(path.join(root, "styles", "overdrive-m3.css"), "utf8");

const controllerStart = mainSource.indexOf("class OraclePanelController");
const controllerEnd = mainSource.indexOf("function injectOracleProfiler", controllerStart);
const watchHelpersStart = mainSource.indexOf("function replayParentPath");
const watchHelpersEnd = mainSource.indexOf("function isReplayPayload", watchHelpersStart);
const bootstrapStart = mainSource.indexOf("function setOracleStartupState");
const bootstrapEnd = mainSource.indexOf("function captureOracleM7PanelBlueprints", bootstrapStart);
const exportPollerStart = mainSource.indexOf("class ExportDirectoryPoller");
const exportPollerEnd = mainSource.indexOf("class ThemePreferences", exportPollerStart);

assert.ok(controllerStart >= 0 && controllerEnd > controllerStart, "OraclePanelController source must be present");
assert.ok(watchHelpersStart >= 0 && watchHelpersEnd > watchHelpersStart, "native watcher helpers must be present");
assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart, "visible Blocky Studios bootstrap state must be present");
assert.ok(exportPollerStart >= 0 && exportPollerEnd > exportPollerStart, "export poller source must be present");

function windowsPathKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function createControllerRuntime(overrides = {}) {
  const context = {
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Reflect,
    RegExp,
    Set,
    String,
    console: { debug() {}, error() {}, log() {}, warn() {} },
    document: {},
    oracleWindow: { oracleWorkspacePreferences: { replay: { roots: [], relinkRoots: [] } } },
    nativeDragAddon: null,
    traceNativeCall(_name, operation) { return operation(); },
    tracePremiereCall(_name, operation) { return operation(); },
    NATIVE_DIRECTORY_WATCH_MAX_ROOTS: 16,
    pathKey: windowsPathKey,
    nativeWindowsFilePath(value) {
      return String(value || "").trim().replace(/\//g, "\\");
    },
    isAbsoluteLocalPath(value) {
      const candidate = String(value || "");
      return /^[A-Za-z]:\\/.test(candidate) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(candidate);
    },
    ...overrides,
  };
  vm.runInNewContext(
    `${mainSource.slice(controllerStart, controllerEnd)}\n` +
      `${mainSource.slice(watchHelpersStart, watchHelpersEnd)}\n` +
      "this.OraclePanelController = OraclePanelController;" +
      "this.watchHelpers = { mergeNativeWatchRootCandidates, nativeWatchRootCoversDirectory, nativeWatchRootCoversFile, nativeConfiguredWatchRootSignature };",
    context,
    { filename: "main.js#M3ControllerAcceptance" },
  );
  return context;
}

function createBareController(runtime, properties = {}) {
  return Object.assign(Object.create(runtime.OraclePanelController.prototype), properties);
}

function createExportPollerRuntime(overrides = {}) {
  const context = {
    Array,
    Boolean,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    clearTimeout,
    setTimeout,
    document: { hidden: false },
    uxpFs: null,
    EXPORT_DIRECTORY_MAX_COUNT: 8,
    EXPORT_DIRECTORY_POLL_MS: 1000,
    EXPORT_DIRECTORY_HIDDEN_POLL_MS: 5000,
    EXPORT_FILE_STABLE_SCANS: 2,
    defaultExportDirectory() { return ""; },
    isAbsoluteLocalPath() { return false; },
    normalizeLocalDirectory(value) { return String(value || ""); },
    pathKey: windowsPathKey,
    parentLocalDirectory() { return ""; },
    localBasename(value) { return String(value || "").split(/[\\/]/).at(-1); },
    isSupportedReplayVideo(value) { return /\.mov$/i.test(String(value || "")); },
    resolveDirectoryEntryPath(directory, entry) { return `${directory}\\${entry}`; },
    fileModifiedAt(stats) { return Number(stats && stats.mtimeMs) || 0; },
    siblingThumbnailPath() { return ""; },
    normalizeCompletedAt(value) { return new Date(value).toISOString(); },
    replayTitleFromFilepath(value) { return String(value || ""); },
    yieldToHost() { return Promise.resolve(); },
    ...overrides,
  };
  vm.runInNewContext(
    `${mainSource.slice(exportPollerStart, exportPollerEnd)}\nthis.ExportDirectoryPoller = ExportDirectoryPoller;`,
    context,
    { filename: "main.js#M3ExportPollerAcceptance" },
  );
  return context;
}

async function runReplayStabilityScenario(observations, declared = {}) {
  let observationIndex = 0;
  const delays = [];
  const domainPatches = [];
  const runtimePatches = [];
  const runtime = createControllerRuntime({
    uxpFs: {
      async lstat() {
        const observation = observations[Math.min(observationIndex, observations.length - 1)];
        observationIndex += 1;
        return {
          size: observation.size,
          mtimeMs: observation.mtimeMs,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      },
    },
    fileModifiedAt(stats) { return Number(stats && stats.mtimeMs) || 0; },
    async delay(milliseconds) { delays.push(milliseconds); },
    isMissingFileError() { return false; },
  });
  let record = {
    id: "stability-replay",
    canonicalPath: "D:\\Blocky Studios Exports\\Stability.mov",
    fileSize: declared.fileSize ?? null,
    modifiedAt: declared.modifiedAt ?? null,
    missingState: "pending",
    thumbnailCacheKey: "",
    thumbnailStatus: "unavailable",
    legacy: {},
  };
  const controller = createBareController(runtime, {
    destroyed: false,
    processingGenerations: new Map(),
    processingTasks: new Map(),
    metadataQueue: {
      submit(task) { return Promise.resolve().then(task); },
    },
    store: {
      getRecord(id) { return id === record.id ? { ...record, legacy: { ...record.legacy } } : null; },
      consumeThumbnail() { return ""; },
      updateById(id, patch, options = {}) {
        if (id !== record.id) return null;
        if (options.domain === true) {
          domainPatches.push({ ...patch });
          record = { ...record, ...patch };
        } else {
          runtimePatches.push({ ...patch });
        }
        return { ...record };
      },
    },
    thumbnailCache: {
      async invalidate() {},
      async store() { throw new Error("thumbnail store must not run without a payload"); },
    },
    viewer: null,
    persistReplayState() {},
  });

  controller.scheduleReplayProcessing(record.id, "stability-acceptance");
  const processingTask = Array.from(controller.processingTasks.get(record.id) || [])[0];
  assert.ok(processingTask, "scheduleReplayProcessing must retain its bounded task");
  await processingTask;
  return { delays, domainPatches, runtimePatches, observationCount: observationIndex, record };
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

function createAcceptanceClassList() {
  const names = new Set();
  return {
    add(...values) { values.forEach((value) => names.add(String(value))); },
    remove(...values) { values.forEach((value) => names.delete(String(value))); },
    toggle(value, force) {
      const name = String(value);
      const enabled = force === undefined ? !names.has(name) : Boolean(force);
      if (enabled) names.add(name);
      else names.delete(name);
      return enabled;
    },
    contains(value) { return names.has(String(value)); },
  };
}

function createAcceptanceEventTarget() {
  const listeners = new Map();
  const maximums = new Map();
  return {
    addEventListener(type, listener) {
      const key = String(type);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(listener);
      maximums.set(key, Math.max(maximums.get(key) || 0, listeners.get(key).size));
    },
    removeEventListener(type, listener) {
      const group = listeners.get(String(type));
      if (group) group.delete(listener);
    },
    dispatchEvent(event) {
      const current = event || {};
      const group = Array.from(listeners.get(String(current.type || "")) || []);
      group.forEach((listener) => listener.call(this, current));
      return true;
    },
    listenerCount(type) { return (listeners.get(String(type)) || new Set()).size; },
    maximumListenerCount(type) { return maximums.get(String(type)) || 0; },
    _listeners: listeners,
  };
}

function createBootstrapNavigationDom(documentObject) {
  function createRouteButton(route) {
    const attributes = new Map();
    const button = {
      dataset: { oracleRoute: route },
      disabled: false,
      hidden: false,
      classList: createAcceptanceClassList(),
      getAttribute(name) { return attributes.get(String(name)) || null; },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      closest(selector) { return selector === "[data-oracle-route]" ? button : null; },
      focus() { documentObject.activeElement = button; },
    };
    return button;
  }

  const routeButtons = new Map([
    ["replays", createRouteButton("replays")],
    ["curves", createRouteButton("curves")],
    ["quick-apply", createRouteButton("quick-apply")],
  ]);
  const views = Array.from(routeButtons.keys(), (route) => ({
    dataset: { oracleView: route },
    hidden: route !== "replays",
  }));
  const navigationToggle = Object.assign(createAcceptanceEventTarget(), {
    classList: createAcceptanceClassList(),
    isConnected: true,
    setAttribute(name, value) { this[String(name)] = String(value); },
    focus() { documentObject.activeElement = this; },
  });
  const navigationBackdrop = Object.assign(createAcceptanceEventTarget(), {
    classList: createAcceptanceClassList(),
    hidden: true,
  });
  const navigationDrawer = Object.assign(createAcceptanceEventTarget(), {
    classList: createAcceptanceClassList(),
    hidden: true,
    querySelector(selector) {
      const match = String(selector).match(/data-oracle-route="([^"]+)"/);
      return match ? routeButtons.get(match[1]) || null : null;
    },
    querySelectorAll(selector) {
      return selector === "[data-oracle-route]" ? Array.from(routeButtons.values()) : [];
    },
    contains(value) { return Array.from(routeButtons.values()).includes(value); },
    focus() { documentObject.activeElement = this; },
  });
  const root = {
    ownerDocument: documentObject,
    querySelectorAll(selector) { return selector === "[data-oracle-view]" ? views : []; },
    contains(value) {
      return value === navigationToggle || value === navigationBackdrop ||
        value === navigationDrawer || Array.from(routeButtons.values()).includes(value);
    },
  };
  return {
    root,
    routeButtons,
    views,
    elements: { navigationToggle, navigationBackdrop, navigationDrawer },
  };
}

function createBootstrapRuntime({
  addonPromise = Promise.resolve({
    diagnostic: {
      packagedFonts: {
        ok: true,
        processPrivate: true,
        sessionVisible: false,
        registrationFlags: "FR_PRIVATE",
        registeredFileCount: 3,
      },
    },
  }),
  fontPromise = Promise.resolve(true),
  Controller,
} = {}) {
  const title = { textContent: "Loading cinematic tools" };
  const message = { textContent: "Connecting startup services." };
  const attributes = new Map([["role", "status"]]);
  const startup = {
    hidden: false,
    dataset: { state: "loading" },
    setAttribute(name, value) { attributes.set(String(name), String(value)); },
    getAttribute(name) { return attributes.get(String(name)) || null; },
    querySelector(selector) {
      if (selector === "[data-oracle-startup-title]") return title;
      if (selector === "[data-oracle-startup-message]") return message;
      return null;
    },
  };
  const errors = [];
  const warnings = [];
  const documentClassNames = new Set();
  const documentTarget = createAcceptanceEventTarget();
  const windowTarget = createAcceptanceEventTarget();
  class AcceptanceEvent {
    constructor(type) { this.type = String(type); }
  }
  const documentObject = Object.assign(documentTarget, {
    readyState: "complete",
    activeElement: null,
    documentElement: {
      dataset: {},
      classList: {
        add(...names) { names.forEach((name) => documentClassNames.add(String(name))); },
        remove(...names) { names.forEach((name) => documentClassNames.delete(String(name))); },
      },
    },
  });
  const navigation = createBootstrapNavigationDom(documentObject);
  documentObject.getElementById = (id) => {
    if (id === "oracleStartupState") return startup;
    if (id === "navigationToggle") return navigation.elements.navigationToggle;
    if (id === "navigationBackdrop") return navigation.elements.navigationBackdrop;
    if (id === "navigationDrawer") return navigation.elements.navigationDrawer;
    return null;
  };
  documentObject.querySelector = (selector) =>
    selector === '[data-oracle-panel-root="oraclePanel"]' ? navigation.root : null;
  windowTarget.OracleOverdriveShell = oracleShellApi;
  const runtime = {
    Error,
    Event: AcceptanceEvent,
    Promise,
    Reflect,
    String,
    console: {
      debug() {},
      log() {},
      warn(...values) { warnings.push(values); },
      error(...values) { errors.push(values); },
    },
    document: documentObject,
    window: windowTarget,
    ORACLE_PANEL_CONTROLLER_KEY: "__oracleM3AcceptanceController",
    ORACLE_PANEL_BOOTSTRAP_KEY: "__oracleM3AcceptanceBootstrap",
    ORACLE_RUNTIME_REPLACE_EVENT: "oracle-runtime-replace",
    nativeDragAddonLoadPromise: addonPromise,
    OraclePanelController: Controller || class {
      async start() {}
      destroy() {}
    },
    verifyBlockyStudiosFonts() { return fontPromise; },
  };
  vm.runInNewContext(
    `${mainSource.slice(bootstrapStart, bootstrapEnd)}\n` +
      "this.setOracleStartupState = setOracleStartupState;" +
      "this.initializeOraclePanel = initializeOraclePanel;" +
      "this.retireOraclePanelBootstrap = retireOraclePanelBootstrap;" +
      "this.scheduleOraclePanelInitialization = scheduleOraclePanelInitialization;",
    runtime,
    { filename: "main.js#M3BootstrapAcceptance" },
  );
  return {
    runtime,
    startup,
    title,
    message,
    errors,
    warnings,
    documentClassNames,
    documentListeners: documentTarget._listeners,
    navigation,
  };
}

function successfulPlan(value) {
  return { ok: true, ...value };
}

function requireSuccessfulPlan(plan) {
  if (!plan || plan.ok !== true) {
    const message = plan && plan.error && plan.error.message || "Organization plan failed.";
    throw new Error(message);
  }
  return plan;
}

test("M2 metadata stabilization requires a delayed second filesystem observation even when declared metadata matches", async () => {
  const mtimeMs = Date.parse("2026-07-15T18:00:01.000Z");
  const result = await runReplayStabilityScenario([
    { size: 4096, mtimeMs },
    { size: 4096, mtimeMs },
  ], {
    fileSize: 4096,
    modifiedAt: "2026-07-15T18:00:01.000Z",
  });
  assert.equal(result.observationCount, 2);
  assert.deepEqual(result.delays, [120]);
  assert.equal(result.record.missingState, "available");
  assert.equal(result.runtimePatches.at(-1).status, "ready");
});

test("M2 metadata stabilization rejects a premature producer declaration that changes during observation", async () => {
  const base = Date.parse("2026-07-15T18:00:01.000Z");
  const result = await runReplayStabilityScenario([
    { size: 4096, mtimeMs: base },
    { size: 6144, mtimeMs: base + 1000 },
    { size: 8192, mtimeMs: base + 2000 },
  ], {
    fileSize: 4096,
    modifiedAt: "2026-07-15T18:00:01.000Z",
  });
  assert.equal(result.observationCount, 3);
  assert.deepEqual(result.delays, [120, 120]);
  assert.equal(result.record.missingState, "unknown");
  assert.equal(result.runtimePatches.at(-1).status, "error");
});

test("M2 metadata stabilization rejects continuously growing size within the bounded attempts", async () => {
  const mtimeMs = Date.parse("2026-07-15T18:00:01.000Z");
  const result = await runReplayStabilityScenario([
    { size: 1024, mtimeMs },
    { size: 2048, mtimeMs },
    { size: 3072, mtimeMs },
  ]);
  assert.equal(result.observationCount, 3);
  assert.deepEqual(result.delays, [120, 120]);
  assert.equal(result.record.missingState, "unknown");
  assert.equal(result.runtimePatches.at(-1).statusMessage, "Metadata validation failed");
});

test("M2 metadata stabilization rejects changing modification time within the bounded attempts", async () => {
  const base = Date.parse("2026-07-15T18:00:01.000Z");
  const result = await runReplayStabilityScenario([
    { size: 4096, mtimeMs: base },
    { size: 4096, mtimeMs: base + 1000 },
    { size: 4096, mtimeMs: base + 2000 },
  ]);
  assert.equal(result.observationCount, 3);
  assert.deepEqual(result.delays, [120, 120]);
  assert.equal(result.record.missingState, "unknown");
  assert.equal(result.runtimePatches.at(-1).status, "error");
});

test("M3 processing epoch cannot apply old-file observations to a reused replay ID", async () => {
  const firstObservation = deferred();
  let lstatCalls = 0;
  let updates = 0;
  let record = {
    id: "reused-id",
    canonicalPath: "D:\\Blocky Studios Exports\\same.mov",
    fileIdentity: { key: "IDENTITY-A" },
    fileSize: null,
    modifiedAt: null,
    missingState: "pending",
    thumbnailCacheKey: "",
    thumbnailStatus: "unavailable",
    legacy: {},
  };
  const runtime = createControllerRuntime({
    uxpFs: {
      async lstat() {
        lstatCalls += 1;
        if (lstatCalls === 1) await firstObservation.promise;
        return { size: 4096, mtimeMs: 1000, isFile: () => true, isSymbolicLink: () => false };
      },
    },
    fileModifiedAt(stats) { return Number(stats && stats.mtimeMs) || 0; },
    async delay() {},
    isMissingFileError() { return false; },
  });
  const controller = createBareController(runtime, {
    destroyed: false,
    metadataMutationActive: false,
    metadataMutationGeneration: 0,
    processingGenerations: new Map(),
    processingTasks: new Map(),
    metadataQueue: { submit(task) { return Promise.resolve().then(task); } },
    store: {
      getRecord(id) { return id === record.id ? { ...record, fileIdentity: { ...record.fileIdentity } } : null; },
      consumeThumbnail() { return ""; },
      updateById() { updates += 1; },
    },
    thumbnailCache: { async invalidate() {}, async store() { return {}; } },
    persistReplayState() {},
  });
  controller.scheduleReplayProcessing(record.id, "old-watcher-event");
  await Promise.resolve();
  controller.metadataMutationActive = true;
  controller.metadataMutationGeneration += 1;
  record = { ...record, fileIdentity: { key: "IDENTITY-B" } };
  firstObservation.resolve();
  const task = Array.from(controller.processingTasks.get(record.id) || [])[0];
  await task;
  assert.equal(updates, 0, "stale observations must not update an imported record that reused the ID");
});

test("M3 native watcher roots keep configured replay/relink roots recursive and known parents bounded", () => {
  const runtime = createControllerRuntime();
  runtime.oracleWindow.oracleWorkspacePreferences = {
    replay: {
      roots: ["D:\\Blocky Studios\\Exports"],
      relinkRoots: ["E:\\Archive"],
    },
  };
  const controller = createBareController(runtime, {
    store: {
      state: {
        replaysById: {
          covered: { canonicalPath: "D:\\Blocky Studios\\Exports\\Episode 1\\covered.mov", exportedAt: "2026-07-15T10:00:00Z" },
          known: { canonicalPath: "F:\\Known Only\\known.mov", exportedAt: "2026-07-15T11:00:00Z" },
        },
      },
    },
  });

  const roots = controller.nativeWatchRootConfigs(["G:\\One Shot\\extra.mov"]);
  assert.deepEqual(
    Array.from(roots, (entry) => ({ path: String(entry.path), recursive: entry.recursive === true })),
    [
      { path: "D:\\Blocky Studios\\Exports", recursive: true },
      { path: "E:\\Archive", recursive: true },
      { path: "G:\\One Shot", recursive: false },
      { path: "F:\\Known Only", recursive: false },
    ],
  );
  assert.equal(
    runtime.watchHelpers.nativeWatchRootCoversFile(roots[0], "D:\\Blocky Studios\\Exports\\Episode 2\\nested.mov"),
    true,
  );
  assert.equal(
    runtime.watchHelpers.nativeWatchRootCoversFile(roots[2], "G:\\One Shot\\Nested\\not-covered.mov"),
    false,
  );
});

test("M3 watcher overlap merging upgrades exact roots to recursive and distinguishes nonrecursive descendants", () => {
  const runtime = createControllerRuntime();
  const merged = runtime.watchHelpers.mergeNativeWatchRootCandidates([
    { path: "D:\\Projects\\Shots", recursive: false },
    { path: "D:\\Projects\\Shots", recursive: true },
    { path: "D:\\Projects\\Shots\\Nested", recursive: false },
    { path: "E:\\Exports", recursive: false },
    { path: "E:\\Exports\\Nested", recursive: false },
  ], 16);
  assert.deepEqual(
    Array.from(merged, (entry) => ({ path: String(entry.path), recursive: entry.recursive === true })),
    [
      { path: "D:\\Projects\\Shots", recursive: true },
      { path: "E:\\Exports", recursive: false },
      { path: "E:\\Exports\\Nested", recursive: false },
    ],
  );

  const ancestorArrivesLater = runtime.watchHelpers.mergeNativeWatchRootCandidates([
    { path: "F:\\Blocky Studios\\Exports\\Episode", recursive: false },
    { path: "F:\\Blocky Studios\\Exports", recursive: true },
  ], 16);
  assert.deepEqual(
    Array.from(ancestorArrivesLater, (entry) => ({ path: String(entry.path), recursive: entry.recursive === true })),
    [{ path: "F:\\Blocky Studios\\Exports", recursive: true }],
  );
});

test("M3 preference previews never restart native watching while committed root changes do", () => {
  const runtime = createControllerRuntime();
  runtime.oracleWindow.oracleWorkspacePreferences = {
    replay: { roots: ["D:\\Before"], relinkRoots: [] },
  };
  runtime.oracleWindow.OracleOverdrivePreferences = {
    applyPreferencesToDocument(preferences) {
      return JSON.parse(JSON.stringify(preferences));
    },
  };
  const restarts = [];
  const controller = createBareController(runtime, {
    destroyed: false,
    nativeLifecycleStarted: true,
    gridScale: { updateGridColumns() {} },
    restartNativeDirectoryWatch(paths) { restarts.push(paths.slice()); },
    showToast(message) { throw new Error(`unexpected toast: ${message}`); },
  });

  controller.applyWorkspacePreferences(
    { replay: { roots: ["D:\\Preview"], relinkRoots: [], gridColumns: 3 } },
    { source: "input", preview: true },
  );
  assert.equal(restarts.length, 0);

  controller.applyWorkspacePreferences(
    { replay: { roots: ["D:\\Committed"], relinkRoots: ["E:\\Relink"], gridColumns: 3 } },
    { source: "apply", preview: false },
  );
  assert.deepEqual(Array.from(restarts, (value) => Array.from(value)), [[]]);

  controller.applyWorkspacePreferences(
    { replay: { roots: ["D:\\Committed"], relinkRoots: ["E:\\Relink"], gridColumns: 3 } },
    { source: "apply", preview: false },
  );
  assert.equal(restarts.length, 1, "an unchanged committed root set must not churn the watcher");
});

function deleteHarness(runtime, options = {}) {
  const replay = {
    id: "replay-1",
    title: "Replay One",
    filepath: "D:\\Exports\\Replay One.mov",
    canonicalPath: "D:\\Exports\\Replay One.mov",
    missingState: "available",
  };
  const originalConfirmation = {
    ok: true,
    kind: "replay.delete-confirmation",
    confirmationId: "modal-confirmation-1",
    stateRevision: 1,
    items: [{ replayId: replay.id, canonicalPath: replay.canonicalPath }],
  };
  const calls = { confirmationsCreated: 0, confirmationsUsed: [], commits: [] };
  const state = { revision: options.stateRevision || 1, replaysById: { [replay.id]: { ...replay } } };
  const organization = {
    createDeleteConfirmationModel(currentState) {
      calls.confirmationsCreated += 1;
      return successfulPlan({
        confirmationId: `fresh-${currentState.revision}`,
        stateRevision: currentState.revision,
        items: [{ replayId: replay.id, canonicalPath: currentState.replaysById[replay.id].canonicalPath }],
      });
    },
    createDeletePlan(currentState, confirmation, request) {
      calls.confirmationsUsed.push(confirmation);
      const expectedPath = confirmation && confirmation.items && confirmation.items[0] && confirmation.items[0].canonicalPath;
      const currentPath = currentState.replaysById[replay.id].canonicalPath;
      if (confirmation.stateRevision !== currentState.revision || windowsPathKey(expectedPath) !== windowsPathKey(currentPath)) {
        return { ok: false, error: { message: "Delete confirmation is stale." } };
      }
      return successfulPlan({
        request,
        items: [{ replayId: replay.id, status: "ready" }],
        state: currentState,
      });
    },
    applyDeleteResults(currentState, plan, results) {
      const items = results.length ? results : [{ replayId: replay.id, status: "skipped" }];
      return successfulPlan({
        state: currentState,
        aggregate: {
          ok: items.every((item) => item.status === "success"),
          partial: false,
          counts: { total: 1, success: items.filter((item) => item.status === "success").length, failed: 0, canceled: 0, skipped: 0 },
          items,
        },
      });
    },
  };
  const controller = createBareController(runtime, {
    store: {
      state,
      getRecord(id) { return state.replaysById[id] || null; },
    },
    replayOrganizationApi: organization,
    requireOrganizationPlan: requireSuccessfulPlan,
    commitOrganizationPlan(plan, reason) { calls.commits.push({ plan, reason }); },
    processingGenerations: new Map(),
    processingTasks: new Map(),
    ensureNativeReplayRegistration: async () => {},
    gateway: {
      async closeSourceMonitorClip() { return true; },
      async findExactProjectItemsByMediaPath() { return []; },
    },
    sourceMonitorReplayId: "",
    sourceMonitorPlaying: false,
    nativeLifecycleStarted: false,
    destroyed: false,
    scheduleReplayProcessing() {},
  });
  return {
    controller,
    replay,
    originalConfirmation,
    calls,
    context: { replays: [replay], deleteConfirmation: originalConfirmation },
  };
}

test("M3 archive, metadata removal, and recycle execute against the original modal confirmation", async () => {
  for (const scenario of [
    { mode: "delete", payload: { recycle: false } },
    { mode: "remove-metadata", payload: {} },
    { mode: "delete", payload: { recycle: true } },
  ]) {
    const runtime = createControllerRuntime({
      nativeDragAddon: {
        recycleKnownFiles(ids) {
          return Promise.resolve({
            ok: true,
            items: ids.map((id) => ({ recordId: id, ok: true, cancelled: false })),
          });
        },
        unregisterKnownReplayFile() { return { ok: true }; },
      },
    });
    const harness = deleteHarness(runtime);
    await harness.controller.applyReplayDelete(scenario.mode, scenario.payload, harness.context);
    assert.equal(harness.calls.confirmationsCreated, 0, `${scenario.mode} must not silently replace the user's confirmation`);
    assert.ok(harness.calls.confirmationsUsed.length >= 1);
    assert.ok(
      harness.calls.confirmationsUsed.every((confirmation) => confirmation === harness.originalConfirmation),
      `${scenario.mode} must preserve the exact confirmation object shown by the modal`,
    );
  }
});

test("M3 delete rejects a modal confirmation made stale by a path/state change", async () => {
  const runtime = createControllerRuntime();
  const harness = deleteHarness(runtime, { stateRevision: 2 });
  harness.controller.store.state.replaysById[harness.replay.id].canonicalPath = "D:\\Exports\\Moved After Modal.mov";

  await assert.rejects(
    harness.controller.applyReplayDelete("delete", { recycle: false }, harness.context),
    /confirmation is stale/i,
  );
  assert.equal(harness.calls.confirmationsCreated, 0);
  assert.equal(harness.calls.commits.length, 0);
});

function mutationHarness(runtime, options = {}) {
  const events = [];
  const replay = {
    id: "replay-1",
    title: "Replay One",
    filepath: "D:\\Exports\\Replay One.mov",
    canonicalPath: "D:\\Exports\\Replay One.mov",
    missingState: "available",
  };
  const record = { ...replay, fileIdentity: { key: "0000000000000001:00000000000000000000000000000001" } };
  const state = { revision: 1, replaysById: { [replay.id]: record } };
  const controller = createBareController(runtime, {
    store: {
      state,
      getRecord(id) { return state.replaysById[id] || null; },
      getById(id) { return state.replaysById[id] || null; },
    },
    replayOrganizationApi: {
      sourceRenamePlan(_state, id) {
        return successfulPlan({
          replayId: id,
          sourcePath: replay.canonicalPath,
          targetPath: "D:\\Exports\\Renamed.mov",
        });
      },
      commitGuardedReplayMutation(_state, plan) { return successfulPlan({ state, plan }); },
      createDeletePlan(_state, confirmation, request) {
        return successfulPlan({ request, confirmation, items: [{ replayId: replay.id, status: "ready" }], state });
      },
      applyDeleteResults(_state, _plan, results) {
        return successfulPlan({
          state,
          aggregate: {
            ok: true,
            partial: false,
            counts: { total: 1, success: 1, failed: 0, canceled: 0, skipped: 0 },
            items: results,
          },
        });
      },
    },
    requireOrganizationPlan: requireSuccessfulPlan,
    commitOrganizationPlan() { events.push("domain-commit"); },
    processingGenerations: new Map([[replay.id, 7]]),
    processingTasks: new Map(),
    sourceMonitorReplayId: replay.id,
    sourceMonitorPlaying: true,
    nativeLifecycleStarted: false,
    destroyed: false,
    gateway: {
      async closeSourceMonitorClip() {
        events.push("source-monitor-close");
        return true;
      },
      async findExactProjectItemsByMediaPath() {
        events.push("premiere-reference-check");
        return options.referencesAfterClose && events.includes("source-monitor-close") ? [{}] : [];
      },
    },
    ensureNativeReplayRegistration: async () => { events.push("native-registration"); },
    thumbnailCache: { async invalidate() {} },
    exportPoller: { registerFile() {} },
    reconcileBridgeReplayPath() {},
    scheduleReplayProcessing() {},
  });
  return { controller, replay, record, state, events };
}

test("M3 source rename cancels processing, releases Source Monitor, and rechecks Premiere immediately before mutation", async () => {
  let controller;
  const runtime = createControllerRuntime({
    nativeDragAddon: {
      renameKnownReplayFile() {
        assert.ok(controller.processingGenerations.get("replay-1") > 7, "processing must be canceled before rename");
        assert.equal(controller.sourceMonitorReplayId, "", "Source Monitor ownership must be cleared before rename");
        controller.__events.push("native-rename");
        return { ok: true, identityKey: "0000000000000001:00000000000000000000000000000001" };
      },
    },
  });
  const harness = mutationHarness(runtime);
  controller = harness.controller;
  controller.__events = harness.events;
  await controller.renameReplaySource(harness.replay, "Renamed.mov", { premiereReferenceCount: 0 });

  const closeIndex = harness.events.indexOf("source-monitor-close");
  const nativeIndex = harness.events.indexOf("native-rename");
  const finalReferenceIndex = harness.events.lastIndexOf("premiere-reference-check");
  assert.ok(closeIndex >= 0 && closeIndex < nativeIndex, "Source Monitor must close before the native rename");
  assert.ok(finalReferenceIndex > closeIndex && finalReferenceIndex < nativeIndex, "Premiere references must be rechecked after handle release and before rename");
  assert.equal(controller.sourceMonitorPlaying, false);
});

test("M3 final Premiere reference recheck blocks rename after handle release without touching the file", async () => {
  let nativeCalls = 0;
  const runtime = createControllerRuntime({
    nativeDragAddon: {
      renameKnownReplayFile() {
        nativeCalls += 1;
        return { ok: true, identityKey: "0000000000000001:00000000000000000000000000000001" };
      },
    },
  });
  const harness = mutationHarness(runtime, { referencesAfterClose: true });
  await assert.rejects(
    harness.controller.renameReplaySource(harness.replay, "Renamed.mov", { premiereReferenceCount: 0 }),
    /Premiere.*reference|PREMIERE_RELINK_UNSUPPORTED/i,
  );
  assert.equal(nativeCalls, 0);
  assert.ok(harness.events.indexOf("source-monitor-close") < harness.events.lastIndexOf("premiere-reference-check"));
});

test("M3 metadata replacement validates before mutation and restores the exact prior state after an atomic write failure", async () => {
  const unregistered = [];
  const diagnostics = [];
  const runtime = createControllerRuntime({
    ORACLE_PLUGIN_VERSION: "2.0.15",
    cloneOracleDomainValue(value) { return JSON.parse(JSON.stringify(value)); },
    nativeDragAddon: {
      unregisterKnownReplayFile(id) { unregistered.push(id); return { ok: true }; },
    },
    recordOracleDiagnostic(level, code, details) { diagnostics.push({ level, code, details }); },
  });
  const previous = {
    schema: "com.blocky.oracle.state",
    version: 3,
    revision: 8,
    writtenAt: "2026-07-16T12:00:00.000Z",
    writerId: "oracle-premiere-v5",
    replaysById: {
      old: { id: "old", thumbnailCacheKey: "old-cache", thumbnailStatus: "ready" },
    },
    collectionsById: {},
    curvePresetsById: {},
    preferences: {},
    quickApplyState: {},
    recipesById: {},
    tombstones: {},
  };
  const imported = {
    ...JSON.parse(JSON.stringify(previous)),
    revision: 999999,
    writerId: "untrusted-writer",
    replaysById: {
      fresh: { id: "fresh", thumbnailCacheKey: "foreign-cache", thumbnailStatus: "ready" },
    },
  };
  let validationCount = 0;
  let releaseCount = 0;
  let resumed = 0;
  let restarted = 0;
  let discardedPending = 0;
  const pollerStates = [];
  const store = {
    state: JSON.parse(JSON.stringify(previous)),
    replaceDomainState(value) { this.state = JSON.parse(JSON.stringify(value)); },
    get items() { return Object.values(this.state.replaysById || {}).map((item) => ({ id: item.id, filepath: item.canonicalPath || "" })); },
  };
  const controller = createBareController(runtime, {
    destroyed: false,
    metadataMutationPromise: null,
    replayLibraryApi: {
      createReplayMetadataExport(value) {
        validationCount += 1;
        assert.equal(value.revision, previous.revision, "untrusted revisions must be rebased before persistence");
        assert.equal(value.writerId, previous.writerId, "untrusted writer IDs must be rebased before persistence");
        assert.equal(value.replaysById.fresh.thumbnailCacheKey, "", "foreign cache references must be discarded");
        assert.equal(value.replaysById.fresh.thumbnailStatus, "unavailable");
        return { state: value };
      },
    },
    store,
    persistence: {
      save() { return Promise.reject(new Error("atomic replace failed")); },
    },
    nativeRegistrationTasks: new Map(),
    curveWorkspaceStateStore: {
      flush() {},
      discardPending() { discardedPending += 1; },
    },
    releaseReplayMutationHandles: async (ids) => { releaseCount += 1; assert.deepEqual(Array.from(ids), ["old"]); },
    pauseNativeDirectoryWatchForMutation() { return () => { resumed += 1; }; },
    refreshMetadataDomainConsumers() {},
    exportPoller: {
      replaceTrackedFiles(items) { pollerStates.push(items.map((item) => item.id)); },
    },
    startNativeReplayLifecycle() { restarted += 1; },
    showToast() {},
  });

  await assert.rejects(
    controller.runReplayMetadataReplacement(imported, "metadata-import", { replayCount: 1 }),
    /atomic replace failed/,
  );
  assert.equal(validationCount, 1);
  assert.equal(releaseCount, 1);
  assert.deepEqual(unregistered, ["old"]);
  assert.equal(JSON.stringify(store.state), JSON.stringify(previous), "failed commit must restore the exact prior in-memory state");
  assert.deepEqual(pollerStates, [], "poller tracking must not publish an uncommitted candidate or require rollback");
  assert.equal(resumed, 1);
  assert.equal(restarted, 0, "the pause closure owns the single watcher restart");
  assert.equal(discardedPending, 0, "failed metadata replacement must preserve pending Curves state");
  assert.equal(controller.metadataMutationPromise, null);
  assert.ok(diagnostics.some((entry) => entry.code === "STATE_WRITE_FAILED"));
});

test("M3 metadata replacement aborts on a native unregister result failure and restores partial registry changes", async () => {
  const unregistered = [];
  const restored = [];
  const runtime = createControllerRuntime({
    ORACLE_PLUGIN_VERSION: "2.0.15",
    cloneOracleDomainValue(value) { return JSON.parse(JSON.stringify(value)); },
    nativeDragAddon: {
      unregisterKnownReplayFile(id) {
        unregistered.push(id);
        return id === "old-b"
          ? { ok: false, errorCode: "REGISTRY_BUSY", errorMessage: "registry refused release" }
          : { ok: true };
      },
    },
  });
  const previous = {
    revision: 4,
    writtenAt: "2026-07-16T12:00:00.000Z",
    writerId: "oracle-premiere-v5",
    replaysById: { "old-a": { id: "old-a" }, "old-b": { id: "old-b" } },
  };
  let replacements = 0;
  const controller = createBareController(runtime, {
    destroyed: false,
    metadataMutationPromise: null,
    metadataMutationActive: false,
    metadataMutationGeneration: 0,
    dedicatedMounts: new Set(),
    store: {
      state: JSON.parse(JSON.stringify(previous)),
      replaceDomainState() { replacements += 1; },
      get items() { return Object.values(this.state.replaysById || {}); },
    },
    replayLibraryApi: { createReplayMetadataExport() { return {}; } },
    nativeRegistrationTasks: new Map(),
    nativeWatcherTasks: new Set(),
    nativeMissingVerificationTimers: new Map(),
    curveWorkspaceStateStore: { flush() {}, discardPending() { throw new Error("commit must not occur"); } },
    persistence: { async flush() {}, async save() { throw new Error("persistence must not run"); } },
    releaseReplayMutationHandles: async () => undefined,
    pauseNativeDirectoryWatchForMutation() { return () => undefined; },
    ensureNativeReplayRegistration: async (id) => { restored.push(id); },
    scheduleReplayProcessing() {},
  });

  await assert.rejects(
    controller.runReplayMetadataReplacement({ ...previous, replaysById: {} }, "metadata-reset", { replayCount: 0 }),
    /REGISTRY_BUSY.*registry refused release/,
  );
  assert.deepEqual(unregistered, ["old-a", "old-b"]);
  assert.deepEqual(restored, ["old-a", "old-b"], "every prior record is re-registered after a partial release");
  assert.equal(replacements, 0, "the in-memory domain must not change after native reconciliation fails");
});

test("M3 metadata commit drains domain writes, refreshes every mount, discards stale drafts, and resumes watching once", async () => {
  const events = [];
  const blocked = [];
  const mainDomain = {
    setPersistenceBlocked(value) { blocked.push(["main", value]); },
    async drainPersistence() { events.push("main-domain-drained"); },
  };
  const dedicatedDomain = {
    setPersistenceBlocked(value) { blocked.push(["dedicated", value]); },
    async drainPersistence() { events.push("dedicated-domain-drained"); },
  };
  const dedicatedCurves = { restoreWorkspaceState() { events.push("dedicated-curves-restored"); } };
  const dedicatedQuick = { closeRecipeEditor() { events.push("dedicated-draft-closed"); } };
  const runtime = createControllerRuntime({
    ORACLE_PLUGIN_VERSION: "2.0.15",
    cloneOracleDomainValue(value) { return JSON.parse(JSON.stringify(value)); },
  });
  const previous = {
    revision: 5,
    writtenAt: "2026-07-16T12:00:00.000Z",
    writerId: "oracle-premiere-v5",
    replaysById: {},
    quickApplyState: {},
  };
  const candidate = { ...previous, replaysById: { fresh: { id: "fresh" } }, quickApplyState: {} };
  const store = {
    state: JSON.parse(JSON.stringify(previous)),
    replaceDomainState(value) { this.state = JSON.parse(JSON.stringify(value)); events.push("state-replaced"); },
    adoptPersistenceMetadata() { events.push("persistence-adopted"); },
    get items() { return Object.values(this.state.replaysById || {}); },
  };
  const controller = createBareController(runtime, {
    destroyed: false,
    metadataMutationPromise: null,
    metadataMutationActive: false,
    metadataMutationGeneration: 0,
    quickApplyDomain: mainDomain,
    dedicatedMounts: new Set([
      { kind: "curves", workspace: dedicatedCurves },
      { kind: "quick-apply", domain: dedicatedDomain, workspace: dedicatedQuick },
    ]),
    store,
    replayLibraryApi: { createReplayMetadataExport() { events.push("candidate-validated"); return {}; } },
    nativeRegistrationTasks: new Map(),
    nativeWatcherTasks: new Set(),
    nativeMissingVerificationTimers: new Map(),
    curveWorkspaceStateStore: {
      flush() { events.push("curves-flushed"); },
      discardPending() { events.push("curves-discarded"); },
    },
    curvePresetStore: { refresh() { events.push("presets-refreshed"); } },
    curvesWorkspace: { restoreWorkspaceState() { events.push("main-curves-restored"); } },
    quickApplyStateStore: { refresh() { events.push("quick-state-refreshed"); } },
    quickApplyRecipeStore: { refresh() { events.push("quick-recipes-refreshed"); } },
    quickApplyWorkspace: { closeRecipeEditor() { events.push("main-draft-closed"); } },
    persistence: {
      async flush() { events.push("repository-drained"); },
      async save() { events.push("candidate-persisted"); return { revision: 6 }; },
    },
    releaseReplayMutationHandles: async () => { events.push("handles-released"); },
    pauseNativeDirectoryWatchForMutation() {
      events.push("watcher-paused");
      return () => events.push("watcher-resumed");
    },
    exportPoller: { replaceTrackedFiles() { events.push("poller-rebased"); } },
    scheduleReplayProcessing(id) { events.push(`processing:${id}`); },
    showToast() {},
  });

  const result = await controller.runReplayMetadataReplacement(candidate, "metadata-import", { replayCount: 1 });
  assert.equal(result.replayCount, 1);
  assert.deepEqual(blocked, [
    ["main", true], ["dedicated", true], ["main", false], ["dedicated", false],
  ]);
  assert.ok(events.indexOf("repository-drained") < events.indexOf("state-replaced"));
  assert.ok(events.indexOf("candidate-persisted") < events.indexOf("curves-discarded"));
  assert.ok(events.includes("main-curves-restored"));
  assert.ok(events.includes("dedicated-curves-restored"));
  assert.ok(events.includes("main-draft-closed"));
  assert.ok(events.includes("dedicated-draft-closed"));
  assert.equal(events.filter((entry) => entry === "watcher-resumed").length, 1);
  assert.ok(events.indexOf("poller-rebased") > events.indexOf("candidate-persisted"));
  assert.ok(events.indexOf("processing:fresh") > events.indexOf("watcher-resumed"));
});

test("M3 metadata poller epoch drops an in-flight old-directory scan after tracked files are replaced", async () => {
  const readGate = deferred();
  let lstatCalls = 0;
  const received = [];
  const runtime = createExportPollerRuntime({
    uxpFs: {
      async readdir() { return readGate.promise; },
      async lstat() {
        lstatCalls += 1;
        return { size: 4096, mtimeMs: Date.now(), isFile: () => true };
      },
    },
  });
  const poller = new runtime.ExportDirectoryPoller((payload) => received.push(payload));
  poller.running = true;
  const oldState = {
    path: "D:\\Old Exports",
    registeredAt: Date.now(),
    primed: true,
    seen: new Map(),
    pending: new Map(),
  };
  const scan = poller.scanDirectory(oldState, poller.generation);
  await Promise.resolve();
  poller.replaceTrackedFiles([]);
  readGate.resolve(["late.mov"]);
  await scan;
  assert.equal(lstatCalls, 0, "the stale scan must stop immediately after its awaited read");
  assert.deepEqual(received, [], "old-epoch media must never be replayed into replacement metadata");
  poller.destroy();
});

test("M3 bridge snapshots wait for metadata commit or rollback before mutating replay state", async () => {
  const gate = deferred();
  let snapshotCount = 0;
  const runtime = createControllerRuntime({
    messageEventName(message) { return String(message && message.event || "").toUpperCase(); },
  });
  const controller = createBareController(runtime, {
    destroyed: false,
    metadataMutationPromise: gate.promise,
    store: {
      replaceSnapshot() { snapshotCount += 1; return []; },
    },
    persistReplayState() {},
    acceptImportClip: async () => undefined,
  });

  const handling = controller.handleBridgeMessage({ event: "snapshot", replays: [], imports: [] });
  await Promise.resolve();
  assert.equal(snapshotCount, 0, "bridge state must not interleave with the metadata transaction");
  gate.resolve(true);
  await handling;
  assert.equal(snapshotCount, 1);
});

test("M3 recycle cancels processing, releases Source Monitor, and revalidates the original confirmation before native deletion", async () => {
  let controller;
  const runtime = createControllerRuntime({
    nativeDragAddon: {
      recycleKnownFiles(ids) {
        assert.deepEqual(Array.from(ids), ["replay-1"]);
        assert.ok(controller.processingGenerations.get("replay-1") > 7, "processing must be canceled before recycle");
        assert.equal(controller.sourceMonitorReplayId, "", "Source Monitor ownership must be cleared before recycle");
        controller.__events.push("native-recycle");
        return Promise.resolve({
          ok: true,
          items: [{ recordId: "replay-1", ok: true, cancelled: false }],
        });
      },
      unregisterKnownReplayFile() { return { ok: true }; },
    },
  });
  const harness = mutationHarness(runtime);
  controller = harness.controller;
  controller.__events = harness.events;
  const confirmation = {
    ok: true,
    kind: "replay.delete-confirmation",
    confirmationId: "modal-1",
    items: [{ replayId: "replay-1" }],
  };
  await controller.applyReplayDelete("delete", { recycle: true }, {
    replays: [harness.replay],
    deleteConfirmation: confirmation,
  });

  const closeIndex = harness.events.indexOf("source-monitor-close");
  const nativeIndex = harness.events.indexOf("native-recycle");
  assert.ok(closeIndex >= 0 && closeIndex < nativeIndex, "Source Monitor must close before native recycle");
  assert.equal(controller.sourceMonitorPlaying, false);
});

test("M3 bootstrap markup reserves a visible, announced Blocky Studios loading or fatal state", () => {
  assert.match(html, /id="oracleStartupState"/);
  assert.match(html, /data-oracle-startup-title/);
  assert.match(html, /data-oracle-startup-message/);
  assert.match(html, /role="(?:status|alert)"/);
  assert.doesNotMatch(html.match(/<[^>]+id="oracleStartupState"[^>]*>/)?.[0] || "", /\bhidden\b/);
  assert.match(m3Css, /\.oracle-startup-state\s*\{/);
  assert.match(m3Css, /\.oracle-startup-state\[data-state="error"\]/);
});

test("M3 bootstrap catches add-on, constructor, and asynchronous start failures into the visible fatal shell", async () => {
  const scenarios = [
    {
      name: "add-on",
      detail: "native add-on rejected",
      create() {
        return createBootstrapRuntime({ addonPromise: Promise.reject(new Error("native add-on rejected")) });
      },
    },
    {
      name: "constructor",
      detail: "controller constructor failed",
      create() {
        return createBootstrapRuntime({
          Controller: class {
            constructor() { throw new Error("controller constructor failed"); }
          },
        });
      },
    },
    {
      name: "start",
      detail: "controller start failed",
      create() {
        return createBootstrapRuntime({
          Controller: class {
            async start() { throw new Error("controller start failed"); }
            destroy() { this.destroyed = true; }
          },
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    const harness = scenario.create();
    await harness.runtime.initializeOraclePanel();
    assert.equal(harness.startup.hidden, false, `${scenario.name} failure must remain visible`);
    assert.equal(harness.startup.dataset.state, "error");
    assert.equal(harness.startup.getAttribute("role"), "alert");
    assert.match(harness.title.textContent, /could not start/i);
    assert.match(harness.message.textContent, new RegExp(scenario.detail, "i"));
    assert.ok(harness.errors.length >= 1, `${scenario.name} failure must be logged for UDT diagnostics`);
  }
});

test("M3 bootstrap keeps loading visible until controller start resolves, then reveals the real shell", async () => {
  const gate = deferred();
  let startCalled = false;
  const harness = createBootstrapRuntime({
    Controller: class {
      start() {
        startCalled = true;
        return gate.promise;
      }
      destroy() {}
    },
  });

  const initializing = harness.runtime.initializeOraclePanel();
  for (let turn = 0; turn < 10 && !startCalled; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(startCalled, true);
  assert.equal(harness.startup.hidden, false, "loading shell must remain visible during asynchronous startup");
  assert.equal(harness.startup.dataset.state, "loading");
  assert.equal(harness.startup.getAttribute("role"), "status");

  gate.resolve();
  await initializing;
  assert.equal(harness.startup.hidden, true);
  assert.equal(harness.startup.dataset.state, "ready");
});

test("M3 bootstrap treats UXP font rejection as a progressive fallback, never an empty or fatal panel", async () => {
  let startCount = 0;
  const harness = createBootstrapRuntime({
    Controller: class {
      async start() { startCount += 1; }
      destroy() {}
    },
  });
  harness.runtime.verifyBlockyStudiosFonts = async () => {
    throw Object.assign(new Error("UXP renderer rejected packaged face"), {
      code: "FONT_RENDERER_UNSUPPORTED",
    });
  };

  await harness.runtime.initializeOraclePanel();

  assert.equal(startCount, 1);
  assert.equal(harness.startup.hidden, true);
  assert.equal(harness.startup.dataset.state, "ready");
  assert.equal(harness.runtime.document.documentElement.dataset.oracleFontState, "host-fallback");
  assert.equal(harness.errors.length, 0);
  assert.ok(harness.warnings.some((values) => String(values[0]).includes("VERIFIER_UNAVAILABLE")));
});

test("M3 bootstrap navigation owns input synchronously and transfers the selected route without duplicate listeners", async () => {
  const addon = deferred();
  const fonts = deferred();
  const harness = createBootstrapRuntime({ addonPromise: addon.promise });
  let fontVerificationCount = 0;

  harness.runtime.verifyBlockyStudiosFonts = () => {
    fontVerificationCount += 1;
    return fonts.promise;
  };
  harness.runtime.OraclePanelController = class {
    constructor() {
      this.shell = new oracleShellApi.OracleShellController(harness.navigation.elements, {
        root: harness.navigation.root,
        document: harness.runtime.document,
      });
    }
    async start() { this.shell.start(); }
    destroy() { this.shell.destroy(); }
  };

  const bootstrapState = {
    cancelled: false,
    controller: null,
    navigationShell: null,
    listener: null,
    promise: null,
    retirementPromise: null,
    startedAt: 0,
  };
  Reflect.set(
    harness.runtime.window,
    harness.runtime.ORACLE_PANEL_BOOTSTRAP_KEY,
    bootstrapState,
  );

  const initializing = harness.runtime.initializeOraclePanel(bootstrapState);
  const { navigationToggle, navigationBackdrop, navigationDrawer } = harness.navigation.elements;
  assert.equal(navigationToggle.listenerCount("click"), 1, "menu input must bind before the native promise settles");
  assert.equal(navigationBackdrop.listenerCount("click"), 1);
  assert.equal(navigationDrawer.listenerCount("click"), 1);
  assert.equal(harness.runtime.document.listenerCount("keydown"), 1);
  assert.ok(bootstrapState.navigationShell, "the synchronous owner must be retained for teardown and route transfer");

  const curvesButton = harness.navigation.routeButtons.get("curves");
  navigationDrawer.dispatchEvent({
    type: "click",
    target: curvesButton,
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(bootstrapState.navigationShell.route, "curves");
  assert.equal(harness.navigation.views.find((view) => view.dataset.oracleView === "curves").hidden, false);

  addon.resolve({ diagnostic: { packagedFonts: { ok: true } } });
  for (let turn = 0; turn < 10 && fontVerificationCount === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fontVerificationCount, 1, "font verification begins only after the one native load settles");
  assert.equal(navigationToggle.listenerCount("click"), 1, "bootstrap keeps sole ownership while fonts are unresolved");

  fonts.resolve(true);
  await initializing;

  assert.equal(bootstrapState.navigationShell, null, "the temporary shell must be released during handoff");
  assert.ok(bootstrapState.controller);
  assert.equal(bootstrapState.controller.shell.route, "curves", "the selected route survives the controller handoff");
  assert.equal(navigationToggle.listenerCount("click"), 1);
  assert.equal(navigationBackdrop.listenerCount("click"), 1);
  assert.equal(navigationDrawer.listenerCount("click"), 1);
  assert.equal(harness.runtime.document.listenerCount("keydown"), 1);
  assert.equal(navigationToggle.maximumListenerCount("click"), 1, "temporary and final shells must never overlap");
  assert.equal(navigationBackdrop.maximumListenerCount("click"), 1);
  assert.equal(navigationDrawer.maximumListenerCount("click"), 1);
  assert.equal(harness.runtime.document.maximumListenerCount("keydown"), 1);

  await harness.runtime.retireOraclePanelBootstrap(bootstrapState);
  assert.equal(navigationToggle.listenerCount("click"), 0, "retirement removes the final owner");
  assert.equal(navigationBackdrop.listenerCount("click"), 0);
  assert.equal(navigationDrawer.listenerCount("click"), 0);
  assert.equal(harness.runtime.document.listenerCount("keydown"), 0);
});

test("M3 hot reload awaits delayed referenced and event-registered teardown before the new runtime owns the DOM", async () => {
  const staleGate = deferred();
  const orphanGate = deferred();
  let staleDestroyCount = 0;
  let orphanDestroyCount = 0;
  let newStartCount = 0;
  const harness = createBootstrapRuntime({
    Controller: class {
      constructor() { this.destroyed = false; }
      async start() { newStartCount += 1; }
      destroy() { this.destroyed = true; }
    },
  });
  const stale = {
    destroyed: false,
    destroyPromise: null,
    destroy() {
      if (this.destroyPromise) return this.destroyPromise;
      staleDestroyCount += 1;
      this.destroyed = true;
      this.destroyPromise = staleGate.promise;
      return this.destroyPromise;
    },
  };
  harness.runtime.window.__oracleM3AcceptanceController = stale;
  harness.runtime.document.documentElement.__oracleM3AcceptanceController = stale;
  harness.runtime.document.addEventListener("oracle-runtime-replace", (event) => {
    orphanDestroyCount += 1;
    event.waitUntil(orphanGate.promise);
  });

  const initializing = harness.runtime.initializeOraclePanel();
  for (let turn = 0; turn < 10 && (!staleDestroyCount || !orphanDestroyCount); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(newStartCount, 0, "replacement must not start while either old teardown is pending");
  orphanGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(newStartCount, 0, "referenced controller cleanup must still gate replacement");
  staleGate.resolve();
  await initializing;

  assert.equal(staleDestroyCount, 1, "the same stale controller must be torn down exactly once");
  assert.equal(orphanDestroyCount, 1, "unreferenced controllers receive the shared teardown event");
  assert.equal(newStartCount, 1);
  assert.notEqual(harness.runtime.window.__oracleM3AcceptanceController, stale);
  assert.equal(
    harness.runtime.window.__oracleM3AcceptanceController,
    harness.runtime.document.documentElement.__oracleM3AcceptanceController,
  );
});

test("M3 shared bootstrap gate lets only the newest UDT runtime finish asynchronous startup", async () => {
  const addon = deferred();
  let fontVerificationCount = 0;
  let startCount = 0;
  const harness = createBootstrapRuntime({
    addonPromise: addon.promise,
    Controller: class {
      constructor() { this.destroyed = false; }
      async start() { startCount += 1; }
      destroy() { this.destroyed = true; }
    },
  });
  harness.runtime.verifyBlockyStudiosFonts = async () => {
    fontVerificationCount += 1;
  };

  const superseded = harness.runtime.scheduleOraclePanelInitialization();
  const current = harness.runtime.scheduleOraclePanelInitialization();
  addon.resolve({ diagnostic: { packagedFonts: { ok: true } } });
  await Promise.all([superseded.promise, current.promise]);

  assert.equal(superseded.cancelled, true);
  assert.equal(fontVerificationCount, 1);
  assert.equal(startCount, 1);
  assert.equal(harness.runtime.window.__oracleM3AcceptanceBootstrap, current);
  assert.equal(harness.startup.dataset.state, "ready");
});

test("M3 bootstrap supersession waits for in-flight start and asynchronous controller retirement", async () => {
  const firstStart = deferred();
  const firstDestroy = deferred();
  const events = [];
  let instanceCount = 0;
  const harness = createBootstrapRuntime({
    Controller: class {
      constructor() {
        this.id = ++instanceCount;
        this.destroyed = false;
        this.destroyPromise = null;
        events.push(`construct-${this.id}`);
      }
      start() {
        events.push(`start-${this.id}`);
        return this.id === 1 ? firstStart.promise : Promise.resolve();
      }
      destroy() {
        if (this.destroyPromise) return this.destroyPromise;
        this.destroyed = true;
        events.push(`destroy-${this.id}`);
        this.destroyPromise = this.id === 1 ? firstDestroy.promise : Promise.resolve(true);
        return this.destroyPromise;
      }
    },
  });

  const superseded = harness.runtime.scheduleOraclePanelInitialization();
  for (let turn = 0; turn < 10 && !events.includes("start-1"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(events.includes("start-1"));
  const current = harness.runtime.scheduleOraclePanelInitialization();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("construct-2"), false);

  firstStart.resolve();
  for (let turn = 0; turn < 10 && !events.includes("destroy-1"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(events.includes("destroy-1"));
  assert.equal(events.includes("construct-2"), false, "the replacement must await the first teardown promise");

  firstDestroy.resolve(true);
  await Promise.all([superseded.promise, current.promise]);
  assert.ok(events.indexOf("destroy-1") < events.indexOf("construct-2"));
  assert.ok(events.indexOf("construct-2") < events.indexOf("start-2"));
  assert.equal(harness.runtime.window.__oracleM3AcceptanceController.id, 2);
  assert.equal(harness.startup.dataset.state, "ready");
});
