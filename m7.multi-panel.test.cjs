// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles", "overdrive-m7.css"), "utf8");

const PANEL_IDS = [
  "oraclePanel",
  "oracleReplaysPanel",
  "oracleCurvesPanel",
  "oracleQuickApplyPanel",
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCall(calls, name) {
  for (let turn = 0; turn < 20 && !calls.includes(name); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(calls.includes(name), `${name} must be reached`);
}

function createPanelTestNode(id, ownerDocument = null, tagName = "div") {
  return {
    id,
    tagName: String(tagName).toUpperCase(),
    ownerDocument,
    isConnected: true,
    children: [],
    parentNode: null,
    appendChild(child) {
      if (child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === "function") {
        child.parentNode.removeChild(child);
      }
      if (!this.children.includes(child)) this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      if (child.parentNode === this) child.parentNode = null;
      return child;
    },
    contains(candidate) {
      return candidate === this || this.children.some((child) =>
        child === candidate || (typeof child.contains === "function" && child.contains(candidate)));
    },
  };
}

test("M7 manifest exposes exactly four real panel entrypoints with inter-panel communication", () => {
  const panels = manifest.entrypoints.filter((entry) => entry.type === "panel");
  assert.deepEqual(panels.map((entry) => entry.id), PANEL_IDS);
  assert.equal(new Set(panels.map((entry) => entry.id)).size, 4);
  for (const panel of panels) {
    assert.equal(panel.minimumSize.width, 240, "the host must permit the verified micro-width layout");
    assert.ok(panel.minimumSize.height >= 320);
    assert.ok(panel.preferredDockedSize.width >= panel.minimumSize.width);
    assert.ok(panel.preferredFloatingSize.height >= panel.minimumSize.height);
  }
  assert.equal(manifest.requiredPermissions.ipc.enablePluginCommunication, true);
});

test("M7 registers all panels in one lifecycle setup and retains one application controller", () => {
  assert.equal((main.match(/entrypoints\.setup\s*\(/g) || []).length, 1);
  for (const id of PANEL_IDS) assert.match(main, new RegExp(`"${id}"`));
  assert.equal((main.match(/new OraclePanelController\s*\(/g) || []).length, 1);
  assert.match(main, /class OracleM7PanelHostRegistry/);
  assert.match(main, /class OracleDedicatedPanelMount/);
  assert.match(main, /registerDedicatedMount\(mount\)/);
  assert.match(main, /SourceMonitorViewerLeaseCoordinator/);
  assert.match(main, /ActivationLeaseCoordinator/);
  assert.doesNotMatch(main, /ensureOracleM7ProbeSurface/);
  assert.equal((main.match(/event && event\.reason === "superseded"/g) || []).length, 2);
});

test("M7 captures pristine workspace blueprints before bootstrap and never clones the main shell", () => {
  const capture = main.indexOf("const ORACLE_M7_BLUEPRINT_CAPTURE = captureOracleM7PanelBlueprints()");
  const bootstrap = main.indexOf("scheduleOraclePanelInitialization();");
  assert.ok(capture >= 0 && bootstrap > capture);
  assert.match(main, /replays: panelDom\.capturePristineBlueprint\(document, \[[\s\S]*?"replayScroller"/);
  assert.match(main, /curves: panelDom\.capturePristineBlueprint\(document, \[[\s\S]*?"curvesWorkspace"/);
  assert.match(main, /quickApply: panelDom\.capturePristineBlueprint\(document, \[[\s\S]*?"quickApplyWorkspace"/);
  const captureBlock = main.slice(main.indexOf("function captureOracleM7PanelBlueprints"), capture);
  assert.doesNotMatch(captureBlock, /navigationDrawer|preferencesPanel|oracleLogo/);
});

test("M7 source document IDs remain unique and the main shell is explicitly scoped", () => {
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const revision = html.match(/main\.js\?blocky-ui=([^"']+)/)?.[1];
  assert.deepEqual(duplicates, []);
  assert.match(revision || "", /^[a-f0-9]{16}$/);
  assert.match(html, /class="oracle-panel blocky-studios-panel" data-oracle-panel-root="oraclePanel" data-oracle-panel-kind="main"/);
  assert.ok(html.includes(`src="src/app/oracle-panel-dom.js?blocky-ui=${revision}"`));
  assert.ok(html.includes(`src="src/app/oracle-runtime-registry.js?blocky-ui=${revision}"`));
  assert.ok(html.includes(`href="dist/blocky-studios-ui.css?blocky-ui=${revision}"`));
  const revisions = Array.from(html.matchAll(/\?blocky-ui=([^"']+)/g), (match) => match[1]);
  assert.deepEqual(new Set(revisions), new Set([revision]));
});

test("M7 dedicated roots always have styled loading/error UI and mount-relative workspaces", () => {
  assert.match(main, /createDedicatedPanelShell/);
  assert.match(main, /setDedicatedPanelShellState\(record\.shell, "ready"\)/);
  assert.match(main, /setDedicatedPanelShellState\(record\.shell, "error", error\)/);
  assert.match(css, /\.oracle-panel--entrypoint\s*\{[\s\S]*height:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.oracle-panel-entrypoint__content\s*\{[\s\S]*flex:\s*1 1 auto/);
  assert.match(css, /\.oracle-panel--entrypoint \.oracle-context-menu,[\s\S]*position:\s*absolute/);
  assert.match(css, /data-oracle-panel-density="compact"/);
  assert.match(main, /renderOracleM7EmergencyPanelState\(rootValue, panelId, error\)/);
});

test("M7 teardown is panel-local while plugin teardown owns singleton services", () => {
  assert.match(main, /destroyPanel\(panelId, rootValue\)[\s\S]*await mount\.destroy\(\)/);
  assert.match(main, /destroyAll\(\)[\s\S]*for \(const record of Array\.from\(this\.records\)\)[\s\S]*await this\.destroyPanel/);
  assert.match(main, /plugin:[\s\S]*async destroy\(\)[\s\S]*await retireOraclePanelBootstrap[\s\S]*await oracleM7PanelHostRegistry\.destroyAll\(\)[\s\S]*await retireExistingOraclePanelControllers\(\)/);
  assert.match(main, /await run\("Quick Apply coordinator", \(\) => this\.quickApplyAdapterCoordinator\.destroy\(\)\)/);
  assert.match(main, /await run\("Curves coordinator", \(\) => this\.curvesAdapterCoordinator\.destroy\(\)\)/);
  assert.match(main, /await run\("Source Monitor coordinator", \(\) => this\.viewerAdapterCoordinator\.destroy\(\)\)/);
  assert.match(main, /pruneDisconnectedRecords\(\)/);
  assert.match(main, /async function retireExistingOraclePanelControllers[\s\S]*await teardown/);
});

test("M7 main panel lifecycle gates route observation without acquiring replacement leases", () => {
  assert.match(main, /setMainPanelVisible\(value\)[\s\S]*this\.applyMainPanelRoute/);
  assert.match(main, /const curvesActive = panelVisible && nextRoute === "curves"/);
  assert.match(main, /const quickApplyActive = panelVisible && nextRoute === "quick-apply"/);
  assert.match(main, /this\.viewer\.close\(panelVisible \? reason : "panel-hide"\)/);
  assert.match(main, /show\(panelId, rootValue\)[\s\S]*panelId === "oraclePanel"[\s\S]*setMainPanelVisible\(true\)/);
  assert.match(main, /hide\(panelId, rootValue\)[\s\S]*panelId === "oraclePanel"[\s\S]*setMainPanelVisible\(false\)/);
  assert.match(main, /destroyPanel\(panelId, rootValue\)[\s\S]*panelId === "oraclePanel"[\s\S]*setMainPanelVisible\(false\)/);
  assert.equal((main.match(/acquireLease\("oraclePanel:curves"\)/g) || []).length, 1);
  assert.equal((main.match(/acquireLease\("oraclePanel:quick-apply"\)/g) || []).length, 1);
});

test("M7 create prepares an inert root while show alone activates and mounts it", () => {
  assert.match(main, /this\.mainPanelVisible = false/);
  const prepareStart = main.indexOf("  prepare(panelId, rootValue) {");
  const showStart = main.indexOf("\n  show(panelId, rootValue) {", prepareStart);
  assert.ok(prepareStart >= 0 && showStart > prepareStart);
  const prepareBlock = main.slice(prepareStart, showStart);
  assert.match(prepareBlock, /this\.ensureRecord\(panelId, rootValue\)/);
  assert.doesNotMatch(prepareBlock, /ensureMounted|record\.visible\s*=\s*true|setMainPanelVisible\(true\)/);

  const hooksStart = main.indexOf("function createOracleM7PanelHooks");
  const hooksEnd = main.indexOf("\nfunction setupOracleM7PanelEntrypoints", hooksStart);
  const hooks = main.slice(hooksStart, hooksEnd);
  assert.match(hooks, /create\(rootNode\)[\s\S]*?oracleM7PanelHostRegistry\.prepare\(panelId, rootNode\)/);
  assert.match(hooks, /show\(rootNode, data\)[\s\S]*?oracleM7PanelHostRegistry\.show\(panelId, rootNode\)/);
  const createBlock = hooks.slice(hooks.indexOf("create(rootNode)"), hooks.indexOf("show(rootNode, data)"));
  assert.doesNotMatch(createBlock, /\.show\(/);
});

test("M7 rejects a panel ID collision on an already-owned UXP root", () => {
  const ensureStart = main.indexOf("  ensureRecord(panelId, rootValue) {");
  const ensureEnd = main.indexOf("\n  async waitForController()", ensureStart);
  assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);
  const ensureBlock = main.slice(ensureStart, ensureEnd);
  assert.match(ensureBlock, /existing\.panelId !== panelId/);
  assert.match(ensureBlock, /existing\.conflicted = true/);
  assert.match(ensureBlock, /\{ code: "ROOT_PANEL_ID_CONFLICT" \}/);
  assert.match(main, /record\.destroyed \|\| record\.conflicted/);
});

test("M7 first dedicated mount applies committed preferences and keeps action feedback panel-local", () => {
  assert.match(main, /this\.elements\.grid = this\.elements\.replayGrid/);
  assert.match(main, /this\.elements\.empty = this\.elements\.emptyState/);
  assert.match(main, /mount\.start\(\);[\s\S]*mount\.setPreferences\(controller\.theme && controller\.theme\.committed \|\| \{\}\)/);
  assert.match(main, /explicitImportReplay\(replay, this\.view, \{[\s\S]*showToast: \(message, kind\) => this\.showToast/);
  assert.match(main, /applyReplayLifecycleAction\(mode, payload, \{[\s\S]*showToast: \(message, kind\) => this\.showToast/);
  assert.match(main, /handleNativeDragResult\([\s\S]*showToast: \(message, kind\) => this\.showToast/);
  assert.match(main, /handleReplayReorder\(request, \{[\s\S]*refresh: \(change\) => this\.refresh\(change\)/);
  assert.match(main, /openLifecycleConfirmation\(replays, lifecycleAction, button, this\.lifecycleUi\);[\s\S]*this\.showToast\(error && error\.message/);
});

test("M7 compact workspaces preserve controls and never anchor past a visible replay toolbar", () => {
  assert.match(css, /data-oracle-panel-kind="quick-apply"\] \.quick-apply-search input\s*\{[\s\S]*width:\s*100%[\s\S]*min-width:\s*0/);
  assert.match(css, /data-oracle-element="quickApplySearchClear"\][\s\S]*flex:\s*0 0 auto/);

  const viewStart = main.indexOf("class ReplayGridView");
  const viewEnd = main.indexOf("\nclass GridScaleControl", viewStart);
  assert.ok(viewStart >= 0 && viewEnd > viewStart);
  const context = { Array, Boolean, Map, Math, Number, Object, Set, String };
  vm.runInNewContext(`${main.slice(viewStart, viewEnd)}\nthis.View = ReplayGridView;`, context);
  const view = Object.assign(Object.create(context.View.prototype), {
    layoutRows: [{ kind: "cards", ids: ["replay-1"] }],
    layoutOffsets: [0, 120],
    scroller: { scrollTop: 0 },
    grid: { offsetTop: 379 },
    rowIndexAtOffset() { return 0; },
  });
  assert.equal(view.captureScrollAnchor(), null);
  view.scroller.scrollTop = 399;
  assert.deepEqual({ ...view.captureScrollAnchor() }, { id: "replay-1", offset: 20 });
});

test("M7 emergency renderer leaves an actionable visible state when panel helpers are unavailable", () => {
  const start = main.indexOf("function renderOracleM7EmergencyPanelState");
  const end = main.indexOf("\nclass OracleM7PanelHostRegistry", start);
  assert.ok(start >= 0 && end > start);
  const makeNode = (tagName) => ({
    tagName: String(tagName).toUpperCase(),
    attributes: new Map(),
    children: [],
    textContent: "",
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    querySelector() { return null; },
  });
  const target = makeNode("uxp-panel");
  const context = {
    String,
    console: { error() {} },
    document: { createElement: makeNode },
  };
  vm.runInNewContext(`${main.slice(start, end)}\nthis.renderEmergency = renderOracleM7EmergencyPanelState;`, context);
  assert.equal(context.renderEmergency({ node: { node: target } }, "oracleCurvesPanel", new Error("helper missing")), true);
  assert.equal(target.children.length, 1);
  const shell = target.children[0];
  assert.equal(shell.attributes.get("data-oracle-panel-state"), "error");
  const collectText = (node) => [node.textContent || "", ...node.children.flatMap(collectText)].join(" ");
  const text = collectText(shell).toLowerCase();
  assert.match(text, /blocky studios could not start/);
  assert.match(text, /first uxp console exception/);
});

test("M7 main lifecycle root attaches before bootstrap, moves safely, and hands off only current visibility", async () => {
  const start = main.indexOf("class OracleM7PanelHostRegistry");
  const end = main.indexOf("\nconst oracleM7PanelHostRegistry", start);
  assert.ok(start >= 0 && end > start);

  const controllerKey = "__m7MainRootController";
  const bootstrapKey = "__m7MainRootBootstrap";
  const windowRef = {};
  const diagnostics = [];
  const emergencyStates = [];
  const visibilityCalls = [];
  let canonicalShellAvailable = true;
  let canonicalShell = null;
  const documentRef = {
    querySelector(selector) {
      assert.equal(selector, '[data-oracle-panel-root="oraclePanel"][data-oracle-panel-kind="main"]');
      return canonicalShellAvailable ? canonicalShell : null;
    },
  };
  documentRef.body = createPanelTestNode("document-body", documentRef, "body");
  canonicalShell = createPanelTestNode("canonical-main-shell", documentRef, "main");
  documentRef.body.appendChild(canonicalShell);

  const panelDom = {
    resolvePanelRoot(value) {
      return value && value.node ? value.node : value;
    },
  };
  const context = {
    Array,
    Boolean,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Reflect,
    Set,
    String,
    WeakMap,
    ORACLE_M7_BLUEPRINT_CAPTURE: { blueprints: {}, error: null },
    ORACLE_PANEL_BOOTSTRAP_KEY: bootstrapKey,
    ORACLE_PANEL_CONTROLLER_KEY: controllerKey,
    OracleDedicatedPanelMount: class {},
    bridgeClient: {},
    delay: async () => undefined,
    document: documentRef,
    nativeDragAddon: {},
    oracleErrorMessage: (error) => String(error && error.message || error),
    oracleM7ObjectId: () => "object",
    oracleM7RealmProbe: () => ({ realmId: "main-root-test-realm" }),
    oracleM7RootId: (rootValue) => String(rootValue && rootValue.id || "root"),
    oracleWindow: { OraclePanelDom: panelDom },
    recordOracleDiagnostic(level, code, details) {
      diagnostics.push({ level, code, details });
    },
    renderOracleM7EmergencyPanelState(rootValue, panelId, error) {
      emergencyStates.push({ rootValue, panelId, error });
      return true;
    },
    resolveOracleMainPanelShell(documentValue) {
      return documentValue.querySelector('[data-oracle-panel-root="oraclePanel"][data-oracle-panel-kind="main"]');
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    window: windowRef,
  };
  vm.runInNewContext(`${main.slice(start, end)}\nthis.Registry = OracleM7PanelHostRegistry;`, context);

  const registry = new context.Registry();
  const initialRoot = createPanelTestNode("initial-main-root", documentRef, "uxp-panel");
  registry.prepare("oraclePanel", { node: initialRoot });
  registry.prepare("oraclePanel", initialRoot);
  assert.equal(registry.mainLifecycleRoot, initialRoot);
  assert.equal(canonicalShell.parentNode, initialRoot);
  assert.deepEqual(initialRoot.children, [canonicalShell]);
  assert.equal(windowRef[controllerKey], undefined, "create must attach the shell without requiring bootstrap");
  assert.equal(
    diagnostics.filter((entry) => entry.code === "MAIN_PANEL_ROOT_ATTACHED").length,
    1,
    "repeated create on one root must not report or append another attachment",
  );

  registry.show("oraclePanel", initialRoot);
  registry.hide("oraclePanel", initialRoot);
  windowRef[controllerKey] = {
    destroyed: false,
    quickApplyWorkspace: {},
    setMainPanelVisible(value) {
      visibilityCalls.push(Boolean(value));
      return true;
    },
  };
  for (let turn = 0; turn < 8 && visibilityCalls.length < 1; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(visibilityCalls, [false], "a late controller must not receive the superseded show state");

  registry.show("oraclePanel", initialRoot);
  registry.show("oraclePanel", initialRoot);
  assert.deepEqual(visibilityCalls, [false, true, true]);
  assert.deepEqual(initialRoot.children, [canonicalShell]);

  const replacementRoot = createPanelTestNode("replacement-main-root", documentRef, "uxp-panel");
  registry.prepare("oraclePanel", replacementRoot);
  assert.equal(registry.mainLifecycleRoot, replacementRoot);
  assert.equal(canonicalShell.parentNode, replacementRoot);
  assert.deepEqual(initialRoot.children, []);
  assert.deepEqual(replacementRoot.children, [canonicalShell]);
  registry.show("oraclePanel", replacementRoot);
  registry.hide("oraclePanel", replacementRoot);
  assert.deepEqual(visibilityCalls.slice(-2), [true, false]);
  assert.equal(
    diagnostics.filter((entry) => entry.code === "MAIN_PANEL_ROOT_ATTACHED").length,
    2,
    "moving to a replacement host root must produce one new attachment record",
  );

  canonicalShellAvailable = false;
  const failedRoot = createPanelTestNode("failed-main-root", documentRef, "uxp-panel");
  registry.prepare("oraclePanel", failedRoot);
  assert.equal(emergencyStates.length, 1);
  assert.equal(emergencyStates[0].panelId, "oraclePanel");
  assert.match(String(emergencyStates[0].error.message), /canonical main-panel shell is unavailable/i);
  assert.ok(diagnostics.some((entry) =>
    entry.code === "MAIN_PANEL_ROOT_ATTACH_FAILED" && entry.details.hook === "create"));
  assert.deepEqual(failedRoot.children, []);
});

test("M7 dedicated teardown awaits delayed workspace cleanup, remains idempotent, and continues after rejection", async () => {
  const start = main.indexOf("class OracleDedicatedPanelMount");
  const end = main.indexOf("\nfunction injectOracleProfiler", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    Array,
    Boolean,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    clearTimeout() {},
    console: { warn() {} },
  };
  vm.runInNewContext(`${main.slice(start, end)}\nthis.Mount = OracleDedicatedPanelMount;`, context);
  const calls = [];
  const workspaceGate = deferred();
  const mount = Object.assign(Object.create(context.Mount.prototype), {
    destroyed: false,
    visible: true,
    panelId: "oracleCurvesPanel",
    kind: "curves",
    controller: { unregisterDedicatedMount() { calls.push("unregister"); throw new Error("registry failed"); } },
    viewportHandle: { destroy() { calls.push("viewport"); throw new Error("viewport failed"); } },
    workspace: { destroy() { calls.push("workspace-start"); return workspaceGate.promise; } },
    domain: { destroy() { calls.push("domain"); } },
    adapterLease: { release() { calls.push("lease"); return true; } },
    promptDialog: { destroy() { calls.push("dialog"); } },
    instance: { nodes: [{ remove() { calls.push("clone"); } }] },
    toastTimers: new Set([1]),
    announceTimer: 2,
    elements: {
      toastRegion: { innerHTML: "toast" },
      screenReaderStatus: { textContent: "status" },
    },
  });
  const first = mount.destroy();
  const second = mount.destroy();
  assert.equal(first, second);
  assert.equal(typeof first.then, "function");
  assert.equal(mount.destroyed, true);
  await waitForCall(calls, "workspace-start");
  assert.equal(calls.includes("domain"), false, "domain teardown must wait for its workspace owner");
  workspaceGate.reject(new Error("workspace failed asynchronously"));
  assert.equal(await first, true);
  assert.deepEqual(calls, ["unregister", "viewport", "workspace-start", "domain", "lease", "dialog", "clone"]);
  assert.equal(mount.toastTimers.size, 0);
  assert.equal(mount.elements.toastRegion.innerHTML, "");
  assert.equal(mount.elements.screenReaderStatus.textContent, "");
});

test("M7 shared controller teardown awaits workspace, viewer, and coordinator cleanup while continuing after failure", async () => {
  const start = main.indexOf("class OraclePanelController");
  const end = main.indexOf("\nfunction injectOracleProfiler", start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const controllerKey = "__m7Controller";
  const windowRef = {
    removeEventListener() { calls.push("window-listener"); },
  };
  const documentElement = {};
  const documentRef = {
    documentElement,
    removeEventListener() { calls.push("document-listener"); },
  };
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
    clearInterval() {},
    clearTimeout() {},
    console: { warn() {} },
    destroyBridge() { calls.push("bridge"); },
    document: documentRef,
    nativeDragAddon: null,
    ORACLE_PANEL_CONTROLLER_KEY: controllerKey,
    ORACLE_RUNTIME_REPLACE_EVENT: "oracle-runtime-replace",
    window: windowRef,
  };
  vm.runInNewContext(`${main.slice(start, end)}\nthis.Controller = OraclePanelController;`, context);
  const resource = (name, method = "destroy") => ({ [method]() { calls.push(name); } });
  const quickWorkspaceGate = deferred();
  const viewerGate = deferred();
  const viewerCoordinatorGate = deferred();
  const controller = Object.assign(Object.create(context.Controller.prototype), {
    destroyed: false,
    dedicatedMounts: new Set(),
    quickApplyWorkspace: { destroy() { calls.push("quick-workspace-start"); return quickWorkspaceGate.promise; } },
    quickApplyDomain: resource("quick-domain"),
    quickApplyAdapterLease: resource("quick-lease", "release"),
    quickApplyAdapterCoordinator: resource("quick-coordinator"),
    quickApplyRecipeStore: resource("quick-recipes"),
    quickApplyStateStore: resource("quick-state"),
    curvesWorkspace: null,
    curvesAdapterLease: null,
    curvesAdapterCoordinator: resource("curves-coordinator"),
    curveWorkspaceStateStore: null,
    curvePresetStore: null,
    curvesPresetDialog: null,
    viewer: {
      destroy() {
        calls.push("viewer-start");
        return viewerGate.promise.then(() => { calls.push("viewer-end"); });
      },
    },
    viewerAdapterCoordinator: {
      destroy() {
        calls.push("viewer-coordinator-start");
        return viewerCoordinatorGate.promise.then(() => { calls.push("viewer-coordinator-end"); });
      },
    },
    elements: {
      replayViewerPoster: null,
      replayBatchBar: null,
      toasts: { innerHTML: "toast" },
      screenReaderStatus: { textContent: "status" },
    },
    logo: resource("logo", "stop"),
    retryTimers: new Map(),
    retryAttempts: new Map(),
    nativeWatchTimer: null,
    nativeWatchRefreshTimer: null,
    nativeMissingVerificationTimers: new Map(),
    activeFileOperationRequestId: null,
    nativeLifecycleStarted: true,
    nativeWatchRoots: ["root"],
    nativeRegistrationTasks: new Set(),
    toastTimers: new Set(),
    announceTimer: null,
    shell: resource("shell"),
    workspace: resource("replay-workspace"),
    lifecycleUi: resource("lifecycle"),
    theme: resource("preferences"),
    wheelScroller: resource("wheel"),
    gridScale: resource("grid"),
    exportPoller: resource("poller"),
    polledReplayIds: new Set(),
    processingGenerations: new Map(),
    processingTasks: new Map(),
    metadataQueue: resource("metadata"),
    thumbnailCache: resource("thumbnails"),
    persistence: resource("persistence"),
    view: resource("view"),
    gateway: resource("gateway"),
    store: resource("store"),
  });
  windowRef[controllerKey] = controller;
  documentElement[controllerKey] = controller;

  const first = controller.destroy();
  const second = controller.destroy();
  assert.equal(first, second);
  assert.equal(typeof first.then, "function");
  assert.equal(controller.destroyed, true);
  await waitForCall(calls, "quick-workspace-start");
  assert.equal(calls.includes("quick-domain"), false, "Quick Apply domain must outlive its workspace cleanup");
  quickWorkspaceGate.reject(new Error("early asynchronous failure"));
  await waitForCall(calls, "viewer-start");
  assert.ok(calls.includes("quick-domain"));
  assert.equal(calls.includes("viewer-coordinator-start"), false, "viewer coordinator must outlive viewer cleanup");
  viewerGate.resolve();
  await waitForCall(calls, "viewer-coordinator-start");
  assert.equal(calls.includes("store"), false, "shared stores must remain until coordinator cleanup finishes");
  viewerCoordinatorGate.resolve();
  assert.equal(await first, true);
  assert.ok(calls.includes("bridge"));
  assert.ok(calls.includes("store"));
  assert.equal(Reflect.has(windowRef, controllerKey), false);
  assert.equal(Reflect.has(documentElement, controllerKey), false);
});

test("M7 host registry mounts four panel entrypoints concurrently, shares state, survives arbitrary reopen order, and restarts cleanly", async () => {
  const start = main.indexOf("class OracleM7PanelHostRegistry");
  const end = main.indexOf("\nconst oracleM7PanelHostRegistry", start);
  assert.ok(start >= 0 && end > start);

  const controllerKey = "__m7IntegratedController";
  const bootstrapKey = "__m7IntegratedBootstrap";
  const windowRef = {};
  const diagnostics = [];
  const persistedState = { revision: 1, value: "initial" };
  let mountSequence = 0;
  let canonicalMainShell = null;
  const documentRef = {
    querySelector(selector) {
      assert.equal(selector, '[data-oracle-panel-root="oraclePanel"][data-oracle-panel-kind="main"]');
      return canonicalMainShell;
    },
  };

  function makeRoot(id) {
    return createPanelTestNode(id, documentRef, "uxp-panel");
  }

  documentRef.body = createPanelTestNode("integrated-document-body", documentRef, "body");
  canonicalMainShell = createPanelTestNode("integrated-canonical-main-shell", documentRef, "main");
  documentRef.body.appendChild(canonicalMainShell);

  const panelDom = {
    resolvePanelRoot(value) {
      return value && value.node ? value.node : value;
    },
    createDedicatedPanelShell(_document, options) {
      const shellRoot = {
        id: `${options.entrypointId}-shell`,
        parentNode: null,
        remove() {
          if (this.parentNode) this.parentNode.removeChild(this);
        },
      };
      options.target.appendChild(shellRoot);
      return { root: shellRoot, state: "loading" };
    },
    setDedicatedPanelShellState(shell, state, error) {
      shell.state = state;
      shell.error = error || null;
    },
  };

  class IntegratedMount {
    constructor(options) {
      this.panelId = options.panelId;
      this.controller = options.controller;
      this.mountId = `integrated-mount-${++mountSequence}`;
      this.visible = false;
      this.destroyed = false;
    }
    start() {
      this.controller.dedicatedMounts.add(this);
    }
    setPreferences(preferences) {
      this.preferences = preferences;
    }
    setVisible(value) {
      this.visible = Boolean(value);
    }
    writeShared(value) {
      this.controller.store.state.value = value;
      this.controller.store.state.revision += 1;
    }
    readShared() {
      return this.controller.store.state.value;
    }
    async destroy() {
      if (this.destroyed) return true;
      this.destroyed = true;
      this.visible = false;
      this.controller.dedicatedMounts.delete(this);
      return true;
    }
  }

  function coordinator() {
    return { getState() { return { leaseCount: 0 }; } };
  }

  function makeController(label) {
    return {
      label,
      destroyed: false,
      quickApplyWorkspace: {},
      theme: { committed: { appearance: { theme: "obsidian" } } },
      dedicatedMounts: new Set(),
      store: { state: persistedState },
      persistence: { state: persistedState },
      gateway: {},
      viewerAdapterCoordinator: coordinator(),
      curvesAdapterCoordinator: coordinator(),
      quickApplyAdapterCoordinator: coordinator(),
      shell: { route: "replays" },
      mainPanelVisible: false,
      setMainPanelVisible(value) {
        this.mainPanelVisible = Boolean(value);
        return true;
      },
    };
  }

  const identity = new WeakMap();
  let identitySequence = 0;
  const context = {
    Array,
    Boolean,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Reflect,
    Set,
    String,
    WeakMap,
    ORACLE_M7_BLUEPRINT_CAPTURE: { blueprints: { replays: {}, curves: {}, quickApply: {} }, error: null },
    ORACLE_PANEL_BOOTSTRAP_KEY: bootstrapKey,
    ORACLE_PANEL_CONTROLLER_KEY: controllerKey,
    OracleDedicatedPanelMount: IntegratedMount,
    bridgeClient: {},
    delay: async () => undefined,
    document: documentRef,
    nativeDragAddon: {},
    oracleErrorMessage: (error) => String(error && error.message || error),
    oracleM7ObjectId(value, label) {
      if (!value || typeof value !== "object") return "";
      if (!identity.has(value)) identity.set(value, `${label}-${++identitySequence}`);
      return identity.get(value);
    },
    oracleM7RealmProbe: () => ({ realmId: "integrated-test-realm" }),
    oracleM7RootId: (rootValue) => String(rootValue && rootValue.id || "root"),
    oracleWindow: { OraclePanelDom: panelDom },
    recordOracleDiagnostic(level, code, details) {
      diagnostics.push({ level, code, details });
    },
    resolveOracleMainPanelShell(documentValue) {
      return documentValue.querySelector('[data-oracle-panel-root="oraclePanel"][data-oracle-panel-kind="main"]');
    },
    renderOracleM7EmergencyPanelState() {
      throw new Error("the integrated registry must not enter its emergency renderer");
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    window: windowRef,
  };
  vm.runInNewContext(`${main.slice(start, end)}\nthis.Registry = OracleM7PanelHostRegistry;`, context);

  const firstController = makeController("first-runtime");
  windowRef[controllerKey] = firstController;
  const registry = new context.Registry();
  const roots = {
    main: makeRoot("main-root"),
    replays: makeRoot("replays-root"),
    curves: makeRoot("curves-root"),
    quick: makeRoot("quick-root"),
  };

  registry.show("oraclePanel", roots.main);
  registry.show("oracleReplaysPanel", roots.replays);
  registry.show("oracleCurvesPanel", { node: roots.curves });
  registry.show("oracleQuickApplyPanel", roots.quick);
  await Promise.all(Array.from(registry.records, (record) => record.mountPromise));

  assert.equal(firstController.mainPanelVisible, true);
  assert.equal(registry.records.size, 3);
  assert.equal(firstController.dedicatedMounts.size, 3);
  assert.equal(mountSequence, 3);
  assert.deepEqual(
    new Set(Array.from(registry.records, (record) => record.panelId)),
    new Set(["oracleReplaysPanel", "oracleCurvesPanel", "oracleQuickApplyPanel"]),
  );
  assert.ok(Array.from(registry.records).every((record) => record.mount.visible));
  assert.ok(Array.from(registry.records).every((record) => record.mount.controller === firstController));

  registry.show("oracleReplaysPanel", roots.replays);
  await registry.recordsByRoot.get(roots.replays).mountPromise;
  assert.equal(mountSequence, 3, "duplicate show must reuse the existing mount");

  const replayMount = registry.recordsByRoot.get(roots.replays).mount;
  const curvesMount = registry.recordsByRoot.get(roots.curves).mount;
  const quickMount = registry.recordsByRoot.get(roots.quick).mount;
  replayMount.writeShared("written-from-replays");
  assert.equal(curvesMount.readShared(), "written-from-replays");
  assert.equal(quickMount.readShared(), "written-from-replays");

  registry.hide("oracleCurvesPanel", roots.curves);
  assert.equal(curvesMount.visible, false);
  registry.show("oracleCurvesPanel", roots.curves);
  assert.equal(curvesMount.visible, true);
  assert.equal(mountSequence, 3);

  await registry.destroyPanel("oracleQuickApplyPanel", roots.quick);
  assert.equal(quickMount.destroyed, true);
  assert.equal(firstController.dedicatedMounts.size, 2);
  assert.equal(registry.recordsByRoot.has(roots.quick), false);
  registry.show("oracleQuickApplyPanel", roots.quick);
  await registry.recordsByRoot.get(roots.quick).mountPromise;
  assert.equal(mountSequence, 4);
  assert.equal(firstController.dedicatedMounts.size, 3);

  await registry.destroyPanel("oracleReplaysPanel", roots.replays);
  await registry.destroyPanel("oracleCurvesPanel", roots.curves);
  registry.show("oracleCurvesPanel", roots.curves);
  registry.show("oracleReplaysPanel", roots.replays);
  await Promise.all(Array.from(registry.records, (record) => record.mountPromise));
  assert.equal(firstController.dedicatedMounts.size, 3);

  assert.equal(await registry.destroyAll(), true);
  assert.equal(firstController.mainPanelVisible, false);
  assert.equal(firstController.dedicatedMounts.size, 0);
  assert.equal(registry.records.size, 0);

  const secondController = makeController("restarted-runtime");
  windowRef[controllerKey] = secondController;
  const restarted = new context.Registry();
  const restartedRoots = [makeRoot("restart-replays"), makeRoot("restart-curves"), makeRoot("restart-quick")];
  restarted.show("oraclePanel", makeRoot("restart-main"));
  restarted.show("oracleReplaysPanel", restartedRoots[0]);
  restarted.show("oracleCurvesPanel", restartedRoots[1]);
  restarted.show("oracleQuickApplyPanel", restartedRoots[2]);
  await Promise.all(Array.from(restarted.records, (record) => record.mountPromise));
  assert.equal(secondController.mainPanelVisible, true);
  assert.equal(secondController.dedicatedMounts.size, 3);
  assert.equal(restarted.recordsByRoot.get(restartedRoots[0]).mount.readShared(), "written-from-replays");
  assert.ok(diagnostics.some((entry) => entry.code === "DEDICATED_PANEL_MOUNT_READY"));
  await restarted.destroyAll();
  assert.equal(secondController.dedicatedMounts.size, 0);
});
