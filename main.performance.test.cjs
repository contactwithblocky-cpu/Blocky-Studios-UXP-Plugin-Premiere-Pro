"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const styleSource = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");
const m1StyleSource = fs.readFileSync(path.join(__dirname, "styles", "overdrive-m1.css"), "utf8");
const m2StyleSource = fs.readFileSync(path.join(__dirname, "styles", "overdrive-m2.css"), "utf8");
const replayLibrarySource = fs.readFileSync(
  path.join(__dirname, "src", "replays", "oracle-replay-library.js"),
  "utf8",
);
const combinedStyleSource = `${styleSource}\n${m1StyleSource}\n${m2StyleSource}`;
const htmlSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const settingsIconSource = fs.readFileSync(
  path.join(__dirname, "assets", "icons", "settings_icon.svg"),
  "utf8",
);
const samsungSharpSansRegularPath = path.join(
  __dirname,
  "assets",
  "fonts",
  "samsung_sharp_sans_regular.otf",
);
const samsungSharpSansMediumPath = path.join(
  __dirname,
  "assets",
  "fonts",
  "samsung_sharp_sans_medium.otf",
);
const samsungSharpSansBoldPath = path.join(
  __dirname,
  "assets",
  "fonts",
  "samsung_sharp_sans_bold.otf",
);
const nativeFontServiceSource = fs.readFileSync(
  path.join(__dirname, "native", "src", "PackagedFontRegistrationService.cpp"),
  "utf8",
);
const nativeModuleSource = fs.readFileSync(
  path.join(__dirname, "native", "src", "module.cpp"),
  "utf8",
);
const clientStart = mainSource.indexOf("class OracleBridgeClient");
const clientEnd = mainSource.indexOf("function startBridge", clientStart);
assert.ok(clientStart >= 0 && clientEnd > clientStart, "bridge client source must be present");

function createHarness(options = {}) {
  const sockets = [];
  const timers = new Map();
  const statuses = [];
  const storageValues = options.storageValues || new Map();
  let nextTimerId = 1;

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closeCalls = 0;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      sockets.push(this);
    }

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    }

    send(payload) {
      this.sent.push(payload);
    }
  }

  const localStorage = options.localStorageAvailable === false ? undefined : {
    getItem(key) {
      return storageValues.has(key) ? storageValues.get(key) : null;
    },
    setItem(key, value) {
      storageValues.set(key, String(value));
    },
    removeItem(key) {
      storageValues.delete(key);
    },
  };
  const context = {
    BRIDGE_RECONNECT_MS: 2000,
    BRIDGE_URL: "ws://127.0.0.1:3001",
    JSON,
    console,
    window: { WebSocket: MockWebSocket, localStorage },
    bridgeThumbnailRequest() {
      return { position: 0.5, width: 640, height: 360 };
    },
    normalizeReplayPath(value) {
      return String(value || "").replace(/\//g, "\\").trim();
    },
    isAbsoluteLocalPath(value) {
      return /^[A-Za-z]:\\/.test(String(value || ""));
    },
    pathKey(value) {
      return String(value || "").replace(/\//g, "\\").toLocaleLowerCase("en-US");
    },
    updateBridgeStatus(status) {
      statuses.push(status);
    },
    setTimeout(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  vm.runInNewContext(
    `${mainSource.slice(clientStart, clientEnd)}\nthis.OracleBridgeClient = OracleBridgeClient;`,
    context,
    { filename: "main.js#OracleBridgeClient" },
  );

  return {
    OracleBridgeClient: context.OracleBridgeClient,
    sockets,
    statuses,
    timers,
    storageValues,
    runOnlyTimer() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      return timer;
    },
  };
}

test("onerror and onclose share exactly one 2000ms reconnect timer", () => {
  const harness = createHarness();
  const client = new harness.OracleBridgeClient(() => undefined);
  client.start();

  const socket = harness.sockets[0];
  const errorHandler = socket.onerror;
  const closeHandler = socket.onclose;
  errorHandler({ type: "error", code: 1006 });
  closeHandler({ code: 1006 });

  assert.equal(client.ws, null);
  assert.equal(socket.onopen, null);
  assert.equal(socket.onmessage, null);
  assert.equal(socket.onerror, null);
  assert.equal(socket.onclose, null);
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.timers.values().next().value.delay, 2000);

  harness.runOnlyTimer();
  assert.equal(harness.sockets.length, 2);
  assert.equal(client.ws, harness.sockets[1]);
});

test("messages are parsed and delivered synchronously without a queue timer", () => {
  const harness = createHarness();
  const handled = [];
  const client = new harness.OracleBridgeClient((message) => handled.push(message));
  client.start();

  const socket = harness.sockets[0];
  socket.readyState = 1;
  socket.onopen();
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    schema: "com.blocky.oracle.bridge-subscription",
    version: 2,
    thumbnail: {
      position: 0.5,
      width: 640,
      height: 360,
    },
  });
  socket.onmessage({
    data: JSON.stringify({
      event: "render_complete",
      filepath: "C:\\renders\\instant.mov",
      thumbnailBase64: "/9j/2Q==",
    }),
  });

  assert.equal(handled.length, 1);
  assert.equal(handled[0].filepath, "C:\\renders\\instant.mov");
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.statuses.at(-1), "connected");
});

test("lifecycle reconciliation stays queued until its exact correlated ACK", () => {
  const harness = createHarness();
  const handled = [];
  const client = new harness.OracleBridgeClient((message) => handled.push(message));
  client.start();

  assert.equal(client.sendLifecycleReconciliation({
    replayId: "replay-1",
    oldPath: "C:\\renders\\before.mov",
    newPath: "C:\\renders\\middle.mov",
    identityKey: "0000000000000001:00000000000000000000000000000001",
  }), true);
  assert.equal(client.sendLifecycleReconciliation({
    replayId: "replay-1",
    oldPath: "C:\\renders\\middle.mov",
    newPath: "D:\\archive\\after.mov",
    identityKey: "0000000000000002:00000000000000000000000000000002",
  }), true);
  assert.equal(client.pendingLifecycleReconciliations.length, 1);

  const socket = harness.sockets[0];
  socket.readyState = 1;
  socket.onopen();
  assert.equal(socket.sent.length, 2, "subscribe must precede the queued lifecycle frame");
  const reconciled = JSON.parse(socket.sent[1]);
  assert.equal(reconciled.oldPath, "C:\\renders\\before.mov");
  assert.equal(reconciled.newPath, "D:\\archive\\after.mov");
  assert.equal(reconciled.fileIdentity.key, "0000000000000002:00000000000000000000000000000002");
  assert.equal(typeof reconciled.correlationId, "string");
  assert.equal(Number.isSafeInteger(reconciled.revision), true);
  assert.equal(client.pendingLifecycleReconciliations.length, 1);
  assert.equal(harness.timers.size, 1);

  socket.onmessage({ data: JSON.stringify({
    event: "replay_path_reconciled_ack",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: `${reconciled.correlationId}-stale`,
    revision: reconciled.revision,
    replayId: reconciled.replayId,
    applied: true,
    updatedReplays: 1,
    updatedImports: 0,
  }) });
  assert.equal(client.pendingLifecycleReconciliations.length, 1, "a forged ACK must not dequeue work");
  assert.equal(handled.length, 0, "an unmatched lifecycle response must not escape the client");

  socket.onmessage({ data: JSON.stringify({
    event: "replay_path_reconciled_ack",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: reconciled.correlationId,
    revision: reconciled.revision,
    replayId: reconciled.replayId,
    applied: true,
    updatedReplays: 1,
    updatedImports: 0,
  }) });
  assert.equal(client.pendingLifecycleReconciliations.length, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(handled.length, 1);
  assert.equal(client.sendLifecycleReconciliation({ replayId: "", oldPath: "relative.mov", newPath: "C:\\x.mov" }), false);
});

test("lifecycle reconciliation survives disconnect and retries the same request after reconnect", () => {
  const harness = createHarness();
  const client = new harness.OracleBridgeClient(() => undefined);
  client.start();
  const firstSocket = harness.sockets[0];
  firstSocket.readyState = 1;
  firstSocket.onopen();

  assert.equal(client.sendLifecycleReconciliation({
    replayId: "replay-retry",
    oldPath: "C:\\renders\\before.mov",
    newPath: "D:\\archive\\after.mov",
    identityKey: "device:inode",
  }), true);
  const firstRequest = JSON.parse(firstSocket.sent[1]);
  firstSocket.onerror({ code: 1006 });
  assert.equal(client.pendingLifecycleReconciliations.length, 1);
  assert.equal(harness.timers.size, 1, "disconnect replaces the ACK timer with one reconnect timer");

  harness.runOnlyTimer();
  const secondSocket = harness.sockets[1];
  secondSocket.readyState = 1;
  secondSocket.onopen();
  const retriedRequest = JSON.parse(secondSocket.sent[1]);
  assert.deepEqual(retriedRequest, firstRequest, "retry must preserve correlation and revision");

  secondSocket.onmessage({ data: JSON.stringify({
    event: "replay_path_reconciled_ack",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: retriedRequest.correlationId,
    revision: retriedRequest.revision,
    replayId: retriedRequest.replayId,
    applied: true,
    updatedReplays: 0,
    updatedImports: 1,
  }) });
  assert.equal(client.pendingLifecycleReconciliations.length, 0);
  assert.equal(harness.timers.size, 0);
});

test("lifecycle outbox survives panel destruction and restores the same request", () => {
  const storageValues = new Map();
  const firstHarness = createHarness({ storageValues });
  const firstClient = new firstHarness.OracleBridgeClient(() => undefined);
  firstClient.start();
  assert.equal(firstClient.sendLifecycleReconciliation({
    replayId: "replay-panel-restart",
    oldPath: "C:\\renders\\before.mov",
    newPath: "D:\\archive\\after.mov",
    identityKey: "device:inode",
  }), true);
  const retained = JSON.parse(storageValues.get("oracle.bridge.lifecycle-outbox.v2"))[0];
  firstClient.destroy();
  assert.equal(storageValues.has("oracle.bridge.lifecycle-outbox.v2"), true);

  const secondHarness = createHarness({ storageValues });
  const secondClient = new secondHarness.OracleBridgeClient(() => undefined);
  assert.equal(secondClient.pendingLifecycleReconciliations.length, 1);
  secondClient.start();
  const socket = secondHarness.sockets[0];
  socket.readyState = 1;
  socket.onopen();
  const restored = JSON.parse(socket.sent[1]);
  assert.equal(restored.correlationId, retained.correlationId);
  assert.equal(restored.revision, retained.revision);
  assert.equal(restored.oldPath, retained.oldPath);
  assert.equal(restored.newPath, retained.newPath);

  socket.onmessage({ data: JSON.stringify({
    event: "replay_path_reconciled_ack",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: restored.correlationId,
    revision: restored.revision,
    replayId: restored.replayId,
    applied: true,
    updatedReplays: 0,
    updatedImports: 1,
  }) });
  assert.equal(storageValues.has("oracle.bridge.lifecycle-outbox.v2"), false);
});

test("missing durable storage reports an honest boundary while retaining in-session delivery", () => {
  const harness = createHarness({ localStorageAvailable: false });
  const handled = [];
  const client = new harness.OracleBridgeClient((message) => handled.push(message));
  client.start();
  assert.equal(handled.length, 1);
  assert.equal(handled[0].code, "LIFECYCLE_OUTBOX_NOT_DURABLE");
  assert.equal(client.sendLifecycleReconciliation({
    replayId: "replay-memory-only",
    oldPath: "C:\\renders\\before.mov",
    newPath: "D:\\archive\\after.mov",
    identityKey: "device:inode",
  }), false);
  assert.equal(client.lifecycleQueueFailureCode, "OUTBOX_NOT_DURABLE");
  assert.equal(client.pendingLifecycleReconciliations.length, 1);
});

test("lifecycle ACK timeout retries three times before rotating the socket", () => {
  const harness = createHarness();
  const client = new harness.OracleBridgeClient(() => undefined);
  client.start();
  const socket = harness.sockets[0];
  socket.readyState = 1;
  socket.onopen();
  client.sendLifecycleReconciliation({
    replayId: "replay-timeout",
    oldPath: "C:\\renders\\before.mov",
    newPath: "D:\\archive\\after.mov",
    identityKey: "device:inode",
  });

  assert.equal(socket.sent.length, 2);
  assert.equal(harness.runOnlyTimer().delay, 1500);
  assert.equal(socket.sent.length, 3);
  assert.equal(harness.runOnlyTimer().delay, 1500);
  assert.equal(socket.sent.length, 4);
  assert.equal(harness.runOnlyTimer().delay, 1500);
  assert.equal(socket.closeCalls, 1);
  assert.equal(client.pendingLifecycleReconciliations.length, 1);
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.timers.values().next().value.delay, 2000);
});

test("lifecycle NACK dequeues the bounded request and is delivered to the controller", () => {
  const harness = createHarness();
  const handled = [];
  const client = new harness.OracleBridgeClient((message) => handled.push(message));
  client.start();
  const socket = harness.sockets[0];
  socket.readyState = 1;
  socket.onopen();
  client.sendLifecycleReconciliation({
    replayId: "replay-missing",
    oldPath: "C:\\renders\\before.mov",
    newPath: "D:\\archive\\after.mov",
    identityKey: "device:inode",
  });
  const request = JSON.parse(socket.sent[1]);
  socket.onmessage({ data: JSON.stringify({
    event: "replay_path_reconciled_nack",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: request.correlationId,
    revision: request.revision,
    replayId: request.replayId,
    applied: false,
    updatedReplays: 0,
    updatedImports: 0,
    code: "RECONCILIATION_GUARD_MISMATCH",
    message: "Replay lifecycle reconciliation did not match retained state.",
  }) });
  assert.equal(client.pendingLifecycleReconciliations.length, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].code, "RECONCILIATION_GUARD_MISMATCH");
});

test("destroy cancels reconnect work and destroys every socket handler", () => {
  const harness = createHarness();
  const client = new harness.OracleBridgeClient(() => undefined);
  client.start();

  const socket = harness.sockets[0];
  socket.onerror({ code: 1006 });
  assert.equal(harness.timers.size, 1);
  client.destroy();

  assert.equal(client.ws, null);
  assert.equal(harness.timers.size, 0);
  assert.equal(socket.onopen, null);
  assert.equal(socket.onmessage, null);
  assert.equal(socket.onerror, null);
  assert.equal(socket.onclose, null);
});

test("M2 store changes refresh the selector-driven workspace instead of mutating grid cards", () => {
  const controllerStart = mainSource.indexOf("class OraclePanelController");
  const controllerEnd = mainSource.indexOf("function getRequiredElement", controllerStart);
  const controllerSource = mainSource.slice(controllerStart, controllerEnd);

  assert.match(controllerSource, /onChange:\s*\(_items, change\) =>\s*\{[\s\S]*?this\.refreshReplayWorkspace\(change\)/);
  assert.match(controllerSource, /mount\.kind === "replays"[\s\S]*?mount\.refresh\(change\)/);
  assert.match(controllerSource, /const ids = this\.store\.select\(this\.replayQuery/);
  assert.match(controllerSource, /const items = this\.store\.presentations\(ids\)/);
  assert.match(controllerSource, /this\.view\.render\(items,\s*\{/);
  assert.doesNotMatch(controllerSource, /view\.prependReplay\(|grid\.prepend\(/);
});

test("M2 snapshot rendering rebuilds ID rows and commits only a virtual window", () => {
  const viewStart = mainSource.indexOf("class ReplayGridView");
  const viewEnd = mainSource.indexOf("class GridScaleControl", viewStart);
  const viewSource = mainSource.slice(viewStart, viewEnd);
  const renderStart = viewSource.indexOf("  renderCards(replays, options = {}) {");
  const renderEnd = viewSource.indexOf("  commitLibraryState(count, totalCount = count) {", renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSource = viewSource.slice(renderStart, renderEnd);

  assert.match(renderSource, /this\.sourceIds = nextIds/);
  assert.match(renderSource, /this\.rebuildLayoutRows\(\)/);
  assert.match(renderSource, /this\.renderVirtualWindow\(\)/);
  assert.match(viewSource, /const replay = this\.resolveReplay\(id\)/);
  assert.match(viewSource, /if \(replayCount >= 180\)/);
  assert.match(viewSource, /replaceElementChildren\(element, nodes = \[\]\)/);
  assert.match(viewSource, /this\.replaceElementChildren\(this\.grid, nodes\)/);
  assert.doesNotMatch(renderSource, /this\.grid\.appendChild\(card\)|this\.grid\.prepend\(card\)/);
});

test("M3 production DOM updates avoid Premiere UXP's broken replaceChildren implementation", () => {
  const productionSources = [mainSource];
  const directories = [path.join(__dirname, "src")];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(absolutePath);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        productionSources.push(fs.readFileSync(absolutePath, "utf8"));
      }
    }
  }
  const combinedProductionSource = productionSources.join("\n");
  assert.doesNotMatch(combinedProductionSource, /\.replaceChildren\s*\(/);
  assert.match(combinedProductionSource, /element\.innerHTML = "";[\s\S]*element\.appendChild\(node\)/);
});

test("M2 virtual grid keeps a 5000-replay library ID-driven and DOM-bounded", () => {
  const viewStart = mainSource.indexOf("class ReplayGridView");
  const viewEnd = mainSource.indexOf("class GridScaleControl", viewStart);
  const createNode = (tagName) => ({
    tagName: String(tagName).toUpperCase(),
    className: "",
    children: [],
    dataset: {},
    style: {},
    attributes: new Map(),
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  });
  const context = {
    Array,
    Map,
    Math,
    Number,
    Set,
    String,
    document: {
      createElement: createNode,
    },
    replayIdentityKey(replay) {
      return `id:${replay.id}`;
    },
    replayCardSignature(replay) {
      return replay.id;
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(viewStart, viewEnd)}\nthis.ReplayGridView = ReplayGridView;`,
    context,
    { filename: "main.js#ReplayGridView" },
  );

  const replays = new Map(
    Array.from({ length: 5000 }, (_, index) => {
      const id = `replay-${index}`;
      return [id, { id, title: `Replay ${index}`, filepath: `C:\\renders\\${id}.mov` }];
    }),
  );
  const grid = {
    clientWidth: 1200,
    offsetTop: 0,
    children: [],
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    },
    get innerHTML() {
      return "";
    },
    set innerHTML(value) {
      if (String(value) !== "") throw new TypeError("Virtual grid accepts innerHTML clearing only.");
      this.children = [];
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
  };
  const view = Object.create(context.ReplayGridView.prototype);
  Object.assign(view, {
    activeReplayId: "replay-0",
    cardRecords: new Map(),
    destroyed: false,
    dragState: null,
    document: context.document,
    grid,
    lastLayoutColumns: -1,
    lastLayoutWidth: -1,
    layoutHeight: 0,
    layoutOffsets: [0],
    layoutRows: [],
    pendingFocusReplayId: "",
    scroller: { clientHeight: 720, scrollTop: 0 },
    selectedReplayIds: new Set(),
    sourceIds: Array.from(replays.keys()),
    getGridColumns() {
      return 3;
    },
    replayDateLabel() {
      return "Today";
    },
    resolveReplay(id) {
      return replays.get(id) || null;
    },
    renderExportCard(_title, _filepath, replay) {
      const card = createNode("article");
      card.dataset.replayId = replay.id;
      card.tabIndex = -1;
      card.setAttribute("role", "gridcell");
      return card;
    },
    disposeCard() {},
  });

  view.rebuildLayoutRows();
  view.renderVirtualWindow();
  assert.equal(view.sourceIds.length, 5000);
  assert.ok(view.cardRecords.size > 0 && view.cardRecords.size <= 180);
  assert.ok(grid.children.length < 100);
  assert.ok(grid.children.some((node) => node.className === "replay-virtual-card-row"));
  assert.ok(grid.children.some((node) => node.className.includes("replay-virtual-spacer--bottom")));
  assert.equal(grid.attributes.get("aria-rowcount"), String(view.layoutRows.length));
  assert.equal(grid.attributes.get("aria-colcount"), "3");
  assert.ok(
    grid.children
      .filter((node) => node.className === "replay-virtual-card-row")
      .every((row) => row.attributes.get("role") === "row" && row.children.length <= 3),
  );

  view.scroller.scrollTop = view.layoutHeight - view.scroller.clientHeight;
  view.renderVirtualWindow();
  assert.ok(view.cardRecords.size > 0 && view.cardRecords.size <= 180);
  assert.ok(grid.children.length < 100);
  assert.ok(grid.children.some((node) => node.className.includes("replay-virtual-spacer--top")));
});

test("visible logo does not schedule a perpetual animation timer", () => {
  const animatorStart = mainSource.indexOf("class OracleLogoAnimator");
  const animatorEnd = mainSource.indexOf("function updateBridgeStatus", animatorStart);
  assert.ok(animatorStart >= 0 && animatorEnd > animatorStart);

  let scheduledTimers = 0;
  const element = {
    style: {},
    getBoundingClientRect() {
      return { width: 64 };
    },
  };
  const context = {
    Math,
    clearTimeout() {},
    setTimeout() {
      scheduledTimers += 1;
      return scheduledTimers;
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(animatorStart, animatorEnd)}\nthis.OracleLogoAnimator = OracleLogoAnimator;`,
    context,
    { filename: "main.js#OracleLogoAnimator" },
  );

  const animator = new context.OracleLogoAnimator(element);
  animator.start();
  assert.equal(scheduledTimers, 0);
  assert.equal(element.style.backgroundPosition, "0px 0px");
});

test("startup avoids mass-importing restored history and exposes an opt-in profiler", () => {
  assert.doesNotMatch(mainSource, /for \(const replay of restored\)/);
  assert.match(mainSource, /startOraclePerformanceProfiler/);
  assert.match(mainSource, /stopOraclePerformanceProfiler/);
  assert.match(mainSource, /IMPORT_RETRY_MAX_ATTEMPTS/);
});

test("thumbnail cards use persistent cache URLs without logging image payloads or paths", () => {
  assert.match(mainSource, /image\.src = thumbnailSource/);
  assert.doesNotMatch(mainSource, /\[Blocky Studios Thumbnail\]|thumbnailBase64[^\n]*console\./);
  assert.match(replayLibrarySource, /plugin-data:\/oracle-thumbnail-v2-\$\{record\.thumbnailCacheKey\}\.jpg/);
  assert.match(
    m1StyleSource,
    /\.replay-thumbnail\s*\{[^}]*box-sizing:\s*content-box;[^}]*height:\s*0;[^}]*padding-top:\s*56\.25%;/s,
  );
  assert.match(
    m1StyleSource,
    /\.replay-thumbnail img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*0;/s,
  );
  assert.doesNotMatch(m1StyleSource, /\.replay-thumbnail\s*\{[^}]*aspect-ratio:/s);
});

test("replay import actions remain available independently of native drag and retain label 9", async () => {
  const gatewayStart = mainSource.indexOf("class PremiereGateway");
  const gatewayEnd = mainSource.indexOf("class ReplayGridView", gatewayStart);
  const gatewaySource = mainSource.slice(gatewayStart, gatewayEnd);
  const viewStart = mainSource.indexOf("class ReplayGridView");
  const viewEnd = mainSource.indexOf("class GridScaleControl", viewStart);
  const viewSource = mainSource.slice(viewStart, viewEnd);

  assert.match(viewSource, /card\.draggable\s*=\s*false/);
  assert.match(viewSource, /replay-card--drag-disabled/);
  assert.match(viewSource, /replay-card--drag-pending/);
  assert.match(viewSource, /replay-card--dragging/);
  assert.match(viewSource, /startNativeFileDrag\(nativeDragPath\)/);
  assert.doesNotMatch(viewSource, /dragstart|dataTransfer|setDragImage|dropReplayAtPlayhead/);

  assert.match(gatewaySource, /getOrCreateReplayBin/);
  assert.match(gatewaySource, /createBinAction\(PREMIERE_REPLAY_BIN_NAME, true\)/);
  assert.match(
    gatewaySource,
    /project\.importFiles\(\[filepath\], true, destinationProjectItem, false\)/,
  );
  assert.match(gatewaySource, /insertReplayIntoActiveSequence/);
  assert.match(gatewaySource, /createInsertProjectItemAction/);
  assert.match(gatewaySource, /createSetColorLabelAction\([\s\n]*PREMIERE_REPLAY_LABEL_VALUE/);
  assert.match(gatewaySource, /applyPremiereLabelValue9/);
  assert.doesNotMatch(gatewaySource, /trackItem\.createSetColorLabelAction/);
  assert.match(gatewaySource, /executeLockedTransaction/);
  for (const code of [
    "NO_REPLAY_PATH",
    "REPLAY_FILE_NOT_FOUND",
    "NO_ACTIVE_SEQUENCE",
    "NO_UNLOCKED_VIDEO_TRACK",
    "EXPLICIT_IMPORT_FAILED",
    "INSERT_FAILED",
    "LABEL_RECONCILE_FAILED",
  ]) {
    assert.match(mainSource, new RegExp(`["]${code}["]`));
  }

  let labelValue = 0;
  const projectItem = {
    getId() {
      return "project-item-9";
    },
    createSetColorLabelAction(index) {
      assert.equal(index, 9);
      return { type: "label", index };
    },
    async getColorLabelIndex() {
      return labelValue;
    },
  };
  const insertedVideoItem = {
    async getProjectItem() {
      return projectItem;
    },
    async getStartTime() {
      return { ticks: "100" };
    },
  };
  const sequence = {
    async getPlayerPosition() {
      return { ticks: "100" };
    },
    async getVideoTrackCount() {
      return 1;
    },
    async getAudioTrackCount() {
      return 1;
    },
    async getVideoTrack(index) {
      assert.equal(index, 1);
      return {
        async getTrackItems() {
          return [insertedVideoItem];
        },
      };
    },
    async getAudioTrack(index) {
      assert.equal(index, 1);
      return {
        async getTrackItems() {
          return [];
        },
      };
    },
  };
  let transactionCalls = 0;
  let insertTransactionCalls = 0;
  const attemptedTrackPairs = [];
  let activeSequence = sequence;
  const project = {
    async getActiveSequence() {
      return activeSequence;
    },
    lockedAccess(callback) {
      callback();
    },
    executeTransaction(task, undoString) {
      transactionCalls += 1;
      const actions = [];
      task({
        addAction(action) {
          actions.push(action);
          return true;
        },
      });
      if (/Apply Blocky Studios replay label 9/.test(undoString)) {
        labelValue = 9;
        return true;
      }
      assert.match(undoString, /Insert Blocky Studios replay/);
      insertTransactionCalls += 1;
      if (insertTransactionCalls === 1) {
        return false;
      }
      return true;
    },
  };
  const api = {
    Project: {
      async getActiveProject() {
        return project;
      },
    },
    ProjectItem: {
      cast(item) {
        return item;
      },
    },
    Constants: {
      TrackItemType: { CLIP: "clip" },
    },
    SequenceEditor: {
      getEditor(activeSequence) {
        assert.equal(activeSequence, sequence);
        return {
          createInsertProjectItemAction(item, time, videoTrackIndex, audioTrackIndex) {
            assert.equal(item, projectItem);
            assert.equal(time.ticks, "100");
            attemptedTrackPairs.push([videoTrackIndex, audioTrackIndex]);
            return { type: "insert", videoTrackIndex, audioTrackIndex };
          },
        };
      },
    },
  };
  const gatewayContext = {
    Map,
    Set,
    Promise,
    Number,
    String,
    Date,
    console,
    performance: { now() { return 0; } },
    PREMIERE_REPLAY_LABEL_VALUE: 9,
    PREMIERE_REPLAY_BIN_NAME: "Minecraft Replays",
    uxpFs: null,
    cleanTitle(value) { return String(value || "Replay"); },
    tickTimeTicks(time) { return String(time && time.ticks ? time.ticks : "0"); },
    validateImportFilePath(value) {
      if (!value) {
        const error = new Error("Blocky Studios import requires an absolute local file path");
        error.code = "NO_REPLAY_PATH";
        throw error;
      }
      return String(value);
    },
    normalizeError(error) { return error; },
    logTimelineLabelTelemetry() {},
    LABEL_RECONCILE_TIMEOUT_MS: 15000,
    NATIVE_DROP_TRACK_ITEM_TIMEOUT_MS: 5000,
    PROJECT_SCAN_SLICE_MS: 4,
    PROJECT_SCAN_YIELD_ITEMS: 24,
    delay() { return Promise.resolve(); },
    yieldToHost() { return Promise.resolve(); },
    tracePremiereCall(_name, operation) { return operation(); },
    traceNativeCall(_name, operation) { return operation(); },
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
    `${gatewaySource}\nthis.PremiereGateway = PremiereGateway;`,
    gatewayContext,
    { filename: "main.js#PremiereGatewayDrop" },
  );
  const gateway = new gatewayContext.PremiereGateway(api);
  gateway.importReplay = async (filepath) => {
    assert.equal(filepath, "C:\\renders\\drop.mov");
    return projectItem;
  };
  const result = await gateway.insertReplayIntoActiveSequence({
    title: "Native Drop",
    filepath: "C:\\renders\\drop.mov",
    projectItem,
  });

  assert.deepEqual(attemptedTrackPairs, [[0, 0], [1, 1]]);
  assert.equal(transactionCalls, 3);
  assert.equal(insertTransactionCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.projectItemId, "project-item-9");
  assert.equal(result.insertedAtTicks, "100");
  assert.equal(result.labelApplied, true);
  assert.equal(result.labelValue, 9);
  assert.equal(result.videoTrackIndex, 1);
  assert.equal(result.audioTrackIndex, 1);
  assert.equal(result.insertedTrackItemCount, 1);
  assert.equal(result.warnings.length, 1);

  activeSequence = null;
  const noSequence = await gateway.insertReplayIntoActiveSequence({
    title: "No Sequence",
    filepath: "C:\\renders\\drop.mov",
  });
  assert.equal(noSequence.ok, false);
  assert.equal(noSequence.errorCode, "NO_ACTIVE_SEQUENCE");

  const noPath = await gateway.insertReplayIntoActiveSequence({ title: "No Path" });
  assert.equal(noPath.ok, false);
  assert.equal(noPath.errorCode, "NO_REPLAY_PATH");
});

test("native timeline dragging uses delegated pointer handlers and has no HTML or playhead fallback", () => {
  const viewStart = mainSource.indexOf("class ReplayGridView");
  const viewEnd = mainSource.indexOf("class GridScaleControl", viewStart);
  const viewSource = mainSource.slice(viewStart, viewEnd);
  assert.match(viewSource, /grid\.addEventListener\("pointerdown"/);
  assert.match(viewSource, /grid\.addEventListener\("pointermove"/);
  assert.match(viewSource, /REPLAY_NATIVE_DRAG_THRESHOLD_PX \* REPLAY_NATIVE_DRAG_THRESHOLD_PX/);
  assert.match(viewSource, /startNativeFileDrag\(nativeDragPath\)/);
  assert.doesNotMatch(viewSource, /dragstart|DataTransfer|dataTransfer|dropEffect|setDragImage/);
  assert.doesNotMatch(viewSource, /dropReplayAtPlayhead|replay-card--drop-pending/);
});

test("M1 shell exposes centered navigation and profile controls without stale header copy", () => {
  assert.doesNotMatch(
    htmlSource,
    /Cinematic bridge|bridgeStatusText|Project library|>\s*History\s*<|pixel-gear/i,
  );
  assert.match(htmlSource, /id="navigationToggle"[\s\S]*id="oracleLogo"[\s\S]*id="profileAvatarImage"/);
  assert.match(htmlSource, /id="preferencesPanel"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(m1StyleSource, /\.oracle-header\s*\{[^}]*display:\s*flex;/s);
  assert.match(m1StyleSource, /\.oracle-header__side\s*\{[^}]*flex:\s*1 1 0;/s);
  assert.match(m1StyleSource, /\.oracle-brand\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(settingsIconSource, /viewBox="0 0 14 14"/);
  assert.match(settingsIconSource, /M6 0h2v3H6z/);
});

test("card metadata follows collection/tags, title, resolution and date hierarchy below duration", () => {
  const cardStart = mainSource.indexOf("  createCard(replay) {");
  const cardEnd = mainSource.indexOf("  updateCardState(card, replay)", cardStart);
  const cardSource = mainSource.slice(cardStart, cardEnd);
  const timecodeStart = mainSource.indexOf("function formatReplayTimecode(replay)");
  const timecodeEnd = mainSource.indexOf("function formatReplayTimestamp", timecodeStart);
  const timecodeSource = mainSource.slice(timecodeStart, timecodeEnd);
  assert.match(cardSource, /replay-timecode-badge/);
  assert.match(cardSource, /resolution\.className = "replay-specs"/);
  assert.match(cardSource, /timestamp\.className = "replay-details__timestamp"/);
  assert.match(cardSource, /formatReplayTimecode\(replay\)/);
  assert.match(timecodeSource, /replay\.durationMs/);
  assert.match(timecodeSource, /api\.formatReplayDuration\(durationMs\)/);
  assert.match(cardSource, /thumbnail\.appendChild\(timecodeMetadata\)/);
  assert.match(cardSource, /createReplayCollectionChip\(collection\)/);
  assert.match(cardSource, /createReplayTagChip\(tag\)/);
  assert.match(cardSource, /createReplayTagOverflow\(tags\.length - 2\)/);
  assert.match(cardSource, /createReplayIndicator\("Source unavailable", "missing"\)/);
  const copyIndex = cardSource.indexOf("copy.append(title, resolution, details)");
  const indicatorIndex = cardSource.indexOf("copy.appendChild(metadataRow)");
  const statusIndex = cardSource.indexOf("copy.appendChild(status)");
  assert.ok(indicatorIndex >= 0 && copyIndex > indicatorIndex && statusIndex > copyIndex);
  assert.doesNotMatch(cardSource, /replay-thumbnail__metadata-date|replay-thumbnail__metadata-resolution/);
  assert.doesNotMatch(cardSource, /dragHint|replay-meta__dot/);
});

test("grid column scaling coalesces resize work without a render loop", () => {
  const controlStart = mainSource.indexOf("class GridScaleControl");
  const controlEnd = mainSource.indexOf("class OraclePanelController", controlStart);
  const controlSource = mainSource.slice(controlStart, controlEnd);
  assert.match(controlSource, /"--replay-grid-columns"/);
  assert.doesNotMatch(controlSource, /querySelectorAll\("\.replay-card"\)/);
  assert.match(controlSource, /lastObservedWidth/);
  assert.match(controlSource, /new ResizeObserver\(this\.handleResize\)/);
  assert.match(controlSource, /this\.resizeFrame = requestAnimationFrame/);
  assert.doesNotMatch(controlSource, /setInterval|setTimeout|\.render\(/);
  assert.match(m2StyleSource, /\.replay-grid-container\s*\{[^}]*display:\s*block;/s);
  assert.match(
    m2StyleSource,
    /\.replay-virtual-card-row\s*\{[^}]*display:\s*flex;[^}]*flex-flow:\s*row nowrap;[^}]*gap:\s*var\(--replay-grid-gap\)/s,
  );
  assert.match(m2StyleSource, /\.replay-virtual-card-row > \.replay-card\s*\{[^}]*flex:\s*0 0 var\(--replay-card-flex-basis\);/s);
  assert.match(m1StyleSource, /\.replay-card\s*\{[^}]*will-change:\s*auto;/s);
});

test("UXP virtual rows use equal flex tracks without paint containment", () => {
  const gridRule = m2StyleSource.match(/\.replay-grid-container\s*\{([^}]*)\}/s);
  const rowRule = m2StyleSource.match(/\.replay-virtual-card-row\s*\{([^}]*)\}/s);
  const cardRule = m2StyleSource.match(/\.replay-virtual-card-row > \.replay-card\s*\{([^}]*)\}/s);
  assert.ok(gridRule && rowRule && cardRule);
  assert.match(gridRule[1], /display:\s*block/);
  assert.match(rowRule[1], /display:\s*flex/);
  assert.match(rowRule[1], /flex-flow:\s*row nowrap/);
  assert.match(cardRule[1], /width:\s*var\(--replay-card-flex-basis\)/);
  assert.match(cardRule[1], /flex:\s*0 0 var\(--replay-card-flex-basis\)/);
  assert.match(cardRule[1], /min-width:\s*0/);
  const containment = (gridRule[1].match(/contain:\s*([^;]+)/) || ["", ""])[1];
  assert.doesNotMatch(containment, /\b(?:paint|strict|content)\b/);
  assert.doesNotMatch(rowRule[1], /contain:\s*[^;]*(?:paint|strict|content)/);
  assert.doesNotMatch(cardRule[1], /contain:\s*[^;]*(?:paint|strict|content)/);
});

test("M1 packages and verifies the exact Samsung Sharp Sans regular, medium, and bold faces", () => {
  assert.ok(fs.existsSync(samsungSharpSansRegularPath));
  assert.ok(fs.existsSync(samsungSharpSansMediumPath));
  assert.ok(fs.existsSync(samsungSharpSansBoldPath));
  assert.doesNotMatch(combinedStyleSource, /Minecraft.?Seven|Minecraft.?Five|Minecraft.?Ten|font-family:\s*"Minecraft"/i);
  assert.match(styleSource, /@font-face\s*\{[^}]*font-family:\s*"Samsung Sharp Sans";[^}]*samsung_sharp_sans_regular\.otf[^}]*font-weight:\s*400/s);
  assert.match(styleSource, /@font-face\s*\{[^}]*font-family:\s*"Samsung Sharp Sans";[^}]*samsung_sharp_sans_medium\.otf[^}]*font-weight:\s*500/s);
  assert.match(styleSource, /@font-face\s*\{[^}]*font-family:\s*"Samsung Sharp Sans";[^}]*samsung_sharp_sans_bold\.otf[^}]*font-weight:\s*700/s);
  assert.doesNotMatch(combinedStyleSource, /Arial|,\s*sans-serif|system-ui|Segoe UI|ui-monospace|,\s*monospace/);
  assert.match(m1StyleSource, /:root\s*\{[^}]*--font-display:\s*"Samsung Sharp Sans";[^}]*--font-control:\s*"Samsung Sharp Sans";[^}]*--font-copy:\s*"Samsung Sharp Sans";/s);
  assert.match(m1StyleSource, /--oracle-font-heading:\s*var\(--font-display\)/);
  assert.match(m1StyleSource, /--oracle-font-body:\s*var\(--font-copy\)/);
  assert.match(m1StyleSource, /--oracle-font-compact:\s*var\(--font-control\)/);
  assert.match(m1StyleSource, /html \*\s*\{[^}]*letter-spacing:\s*0\s*!important;/s);
  const overdriveLetterSpacing = Array.from(
    `${m1StyleSource}\n${m2StyleSource}`.matchAll(/letter-spacing:\s*([^;]+);/g),
    (match) => match[1].trim().replace(/\s*!important\s*$/, ""),
  );
  assert.ok(overdriveLetterSpacing.length > 0);
  assert.deepEqual(Array.from(new Set(overdriveLetterSpacing)), ["0"]);
  assert.doesNotMatch(combinedStyleSource, /\.replay-drag-preview\s*\{/);
  assert.match(mainSource, /document\.fonts/);
  assert.match(mainSource, /fontSet\.load/);
  assert.doesNotMatch(mainSource, /,\s*sans-serif/);
  assert.match(mainSource, /registerPackagedFonts/);
  assert.match(mainSource, /getPackagedFontStatus/);
  assert.match(mainSource, /unregisterPackagedFonts/);
  assert.match(mainSource, /packagedFonts\.processPrivate === true/);
  assert.match(mainSource, /packagedFonts\.sessionVisible === false/);
  assert.match(mainSource, /packagedFonts\.registrationFlags === "FR_PRIVATE"/);
  assert.match(mainSource, /document\.documentElement\.classList\.add\("oracle-fonts-ready"\)/);
  assert.match(mainSource, /"samsungSharpSansRegular"[\s\S]*"samsungSharpSansMedium"[\s\S]*"samsungSharpSansBold"/);
  assert.match(mainSource, /measureFontRendering\(face\.family, face\.weight\)/);
  assert.match(mainSource, /getBoundingClientRect\(\)\.width/);
  assert.match(mainSource, /HOST_RENDERER_FALLBACK/);
  assert.match(mainSource, /VERIFIER_UNAVAILABLE/);
  assert.match(mainSource, /await verifyBlockyStudiosFonts\([\s\S]*nativeLoadResult[\s\S]*\.diagnostic\.packagedFonts/);
  assert.doesNotMatch(mainSource, /PACKAGED_FONTS_UNAVAILABLE/);
  assert.match(nativeFontServiceSource, /AddFontResourceExW\([\s\S]*(?:FR_PRIVATE|kPrivateFontFlags)/s);
  assert.match(nativeFontServiceSource, /RemoveFontResourceExW/);
  assert.match(nativeFontServiceSource, /HasSfntSignature/);
  assert.match(nativeModuleSource, /UXP_ADDON_TERMINATE\(Terminate\)/);
});

test("grid slider changes equal responsive grid tracks at every supported step", () => {
  const controlStart = mainSource.indexOf("class GridScaleControl");
  const controlEnd = mainSource.indexOf("class OraclePanelController", controlStart);
  const listeners = new Map();
  const properties = new Map();
  const stored = new Map();
  const attributes = new Map();
  const pendingFrames = new Map();
  let nextFrameId = 1;
  const countLabel = { textContent: "" };
  const input = {
    min: "1",
    max: "6",
    step: "1",
    value: "3",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
  const grid = {
    clientWidth: 1600,
    style: {
      getPropertyValue(name) {
        return properties.get(name) || "";
      },
      setProperty(name, value) {
        properties.set(name, value);
      },
      removeProperty(name) {
        properties.delete(name);
      },
    },
  };
  const context = {
    GRID_SCALE_STORAGE_KEY: "oracle.gridScale.v1",
    Math,
    Number,
    String,
    Array,
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      pendingFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      pendingFrames.delete(id);
    },
    window: {
      localStorage: {
        getItem(key) {
          return stored.get(key) || null;
        },
        setItem(key, value) {
          stored.set(key, value);
        },
      },
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(controlStart, controlEnd)}\nthis.GridScaleControl = GridScaleControl;`,
    context,
    { filename: "main.js#GridScaleControl" },
  );

  const control = new context.GridScaleControl(input, grid, countLabel);
  const flushFrame = () => {
    const callbacks = Array.from(pendingFrames.values());
    pendingFrames.clear();
    callbacks.forEach((callback) => callback(16.667));
  };
  control.start();
  flushFrame();
  assert.equal(properties.get("--replay-grid-columns"), "3");
  assert.equal(countLabel.textContent, "3");

  input.value = "6";
  listeners.get("input")({ currentTarget: input });
  flushFrame();
  assert.equal(properties.get("--replay-grid-columns"), "6");
  assert.equal(attributes.get("aria-valuetext"), "6 columns");
  assert.equal(countLabel.textContent, "6");

  input.value = "2";
  listeners.get("change")({ currentTarget: input });
  flushFrame();
  assert.equal(input.value, "2");
  assert.equal(properties.get("--replay-grid-columns"), "2");
  assert.equal(properties.get("--replay-card-flex-basis"), "790px");
  assert.equal(stored.get("oracle.gridScale.v1"), "2");

  control.destroy();
  assert.equal(listeners.size, 0);
  assert.doesNotMatch(styleSource, /\.grid-size-\d+/);
});
