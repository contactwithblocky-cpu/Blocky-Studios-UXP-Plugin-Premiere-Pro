// @ts-nocheck
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const workspaceApi = require("./src/curves/oracle-curves-workspace.js");
const presetApi = require("./src/curves/oracle-curve-presets.js");
const indexSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(__dirname, "styles", "overdrive-m5.css"), "utf8");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
    toString() { return [...values].join(" "); },
  };
}

function fakeDocument() {
  const document = {
    activeElement: null,
    createElement(tagName) { return fakeElement(tagName, document); },
    createElementNS(namespace, tagName) { return fakeElement(tagName, document); },
  };
  return document;
}

function fakeElement(tagName = "DIV", ownerDocument = null) {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  let html = "";
  const element = {
    tagName: String(tagName).toUpperCase(),
    ownerDocument,
    parentElement: null,
    children,
    dataset: {},
    style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
    classList: fakeClassList(),
    className: "",
    hidden: false,
    disabled: false,
    checked: false,
    selected: false,
    value: "",
    textContent: "",
    title: "",
    tabIndex: 0,
    capturedPointer: null,
    releasedPointer: null,
    appendChild(child) {
      child.parentElement = element;
      if (!child.ownerDocument) child.ownerDocument = ownerDocument;
      children.push(child);
      return child;
    },
    setAttribute(name, value) {
      const text = String(value);
      attributes.set(name, text);
      if (name === "class") element.className = text;
      if (name.startsWith("data-")) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
        element.dataset[key] = text;
      }
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      if (listeners.has(type)) listeners.get(type).delete(handler);
    },
    listenerCount(type) { return listeners.has(type) ? listeners.get(type).size : 0; },
    dispatch(type, init = {}) {
      const event = {
        type,
        target: element,
        currentTarget: element,
        key: "",
        button: 0,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        deltaY: 0,
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...init,
      };
      for (const handler of Array.from(listeners.get(type) || [])) handler(event);
      return event;
    },
    closest(selector) {
      if (selector === "[data-curve-preset-reorder-handle]" && element.dataset.curvePresetReorderHandle) return element;
      if (selector === "[data-curve-preset-id]" && element.dataset.curvePresetId) return element;
      if (selector === "[data-curve-property-key]" && element.dataset.curvePropertyKey) return element;
      return element.parentElement && typeof element.parentElement.closest === "function" ? element.parentElement.closest(selector) : null;
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }; },
    setPointerCapture(pointerId) { element.capturedPointer = pointerId; },
    releasePointerCapture(pointerId) { element.releasedPointer = pointerId; },
    focus() { if (ownerDocument) ownerDocument.activeElement = element; },
  };
  Object.defineProperty(element, "innerHTML", {
    get() { return html; },
    set(value) {
      html = String(value);
      if (html === "") children.splice(0);
    },
  });
  return element;
}

function createElements(document = fakeDocument()) {
  const names = [
    "root", "state", "stateTitle", "stateMessage", "content", "refresh",
    "settingsToggle", "settingsPanel", "settingsClose", "inspector", "resizeHandle", "detectedProperties", "gridSize", "grid4", "grid8", "grid16", "presetViewList", "presetViewGrid",
    "clipSelect", "componentSelect", "propertySelect", "clipSummary", "componentSummary",
    "propertySummary", "endpointsSummary", "interpolationSummary", "compatibilitySummary", "graphTitle",
    "modeNative", "modeBaked", "bakedReason", "nativeInterpolation", "interpolationBezier", "interpolationLinear", "interpolationHold", "graph", "grid",
    "overlayGroup", "path", "handleOne", "handleTwo", "endpointStart", "endpointEnd", "handleOneLine", "handleTwoLine",
    "pointOneX", "pointOneY", "pointTwoX", "pointTwoY", "zoomIn", "zoomOut", "zoomLabel", "fit",
    "reset", "mirror", "reverse", "copy", "paste", "apply", "status", "samplePreview",
    "presetBuiltInTab", "presetUserTab", "presetSearch", "presetList", "presetEmpty",
    "presetFolder", "presetTags", "presetMetadata", "presetFolderCreate", "presetFolderRename", "presetFolderDelete",
    "presetCreate", "presetSaveAs", "presetOverwrite", "presetRename", "presetDuplicate",
    "presetDelete", "presetMoveUp", "presetMoveDown", "presetFavorite", "presetImport", "presetExport",
  ];
  const elements = {};
  for (const name of names) {
    let tag = "DIV";
    if (["clipSelect", "componentSelect", "propertySelect", "nativeInterpolation", "presetFolder", "gridSize"].includes(name)) tag = "SELECT";
    else if (["pointOneX", "pointOneY", "pointTwoX", "pointTwoY", "presetSearch", "presetTags"].includes(name)) tag = "INPUT";
    else if (["graph", "overlayGroup"].includes(name)) tag = name === "graph" ? "SVG" : "G";
    else if (["path", "handleOne", "handleTwo", "endpointStart", "endpointEnd", "handleOneLine", "handleTwoLine", "grid"].includes(name)) tag = name === "path" ? "PATH" : name === "grid" ? "G" : name.includes("Line") ? "LINE" : name.includes("endpoint") ? "ELLIPSE" : "CIRCLE";
    else if (name === "graphTitle") tag = "H3";
    else if (!name.includes("Summary") && !["root", "state", "stateTitle", "stateMessage", "content", "bakedReason", "status", "samplePreview", "presetList", "presetEmpty"].includes(name)) tag = "BUTTON";
    elements[name] = document.createElement(tag);
  }
  elements.root.appendChild(elements.state);
  elements.root.appendChild(elements.content);
  elements.content.appendChild(elements.resizeHandle);
  elements.content.appendChild(elements.inspector);
  elements.inspector.appendChild(elements.detectedProperties);
  elements.content.appendChild(elements.graph);
  elements.graph.appendChild(elements.overlayGroup);
  elements.graph.appendChild(elements.path);
  elements.graph.appendChild(elements.handleOneLine);
  elements.graph.appendChild(elements.handleTwoLine);
  elements.graph.appendChild(elements.endpointStart);
  elements.graph.appendChild(elements.endpointEnd);
  elements.graph.appendChild(elements.handleOne);
  elements.graph.appendChild(elements.handleTwo);
  return elements;
}

function binding(id, options = {}) {
  return {
    bindingId: id,
    id,
    revision: options.revision || `rev-${id}`,
    clipId: options.clipId || "clip-a",
    clipName: options.clipName || "Hero.mov",
    componentId: options.componentId || "motion#0",
    componentName: options.componentName || "Motion",
    propertyId: options.propertyId || "motion#0:position-x",
    propertyName: options.propertyName || "Position X",
    valueType: options.valueType || "number",
    start: options.start || { ticks: "100", timeSeconds: 1, value: 0, interpolation: 1 },
    end: options.end || { ticks: "200", timeSeconds: 2, value: 100, interpolation: 1 },
    interpolation: options.interpolation == null ? 1 : options.interpolation,
    supportedInterpolations: options.supportedInterpolations || ["LINEAR", "HOLD", "BEZIER"],
    compatible: options.compatible !== false,
    reason: options.reason || null,
    keyTicks: options.keyTicks || ["100", "200"],
    ticksPerFrame: options.ticksPerFrame || "10",
    capabilities: {
      nativeInterpolation: options.compatible === false ? { supported: false, message: options.reason || "Unsupported" } : { supported: true },
      bakedCurve: options.bakedCompatible === true ? { supported: true } : { supported: false, message: "Baked runtime proof is required." },
    },
  };
}

function readySnapshot(bindings = [binding("binding-a")], extra = {}) {
  return {
    state: "ready",
    revision: extra.revision || 7,
    message: "Selection ready.",
    selectedBindings: bindings,
    capabilities: {
      nativeInterpolation: { supported: true },
      nativeModes: {
        LINEAR: { name: "LINEAR", supported: true },
        HOLD: { name: "HOLD", supported: true },
        BEZIER: { name: "BEZIER", supported: true },
      },
      bakedCurve: { supported: false, message: "Baked runtime proof is required." },
      ...extra.capabilities,
    },
  };
}

function createRaf() {
  let nextId = 1;
  const callbacks = new Map();
  const cancelled = [];
  return {
    callbacks,
    cancelled,
    request(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    cancel(id) { cancelled.push(id); callbacks.delete(id); },
    flush() {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(16.7);
    },
  };
}

function createAdapter(snapshot = readySnapshot(), options = {}) {
  const subscribers = new Set();
  const calls = { start: 0, visible: [], active: [], refresh: [], plan: [], apply: [], destroy: 0 };
  const adapter = {
    snapshot,
    calls,
    start() { calls.start += 1; return this; },
    subscribe(listener) { subscribers.add(listener); listener(this.snapshot); return () => subscribers.delete(listener); },
    setVisible(value) { calls.visible.push(Boolean(value)); },
    setActive(value) { calls.active.push(Boolean(value)); },
    async requestRefresh(reason) { calls.refresh.push(reason); return this.snapshot; },
    getSnapshot() { return this.snapshot; },
    getBakedProof() { return options.bakedProof || null; },
    async planNativeInterpolation(bindings, mode, options) {
      calls.plan.push({ bindings, mode, options });
      return { kind: "plan", bindings, mode };
    },
    async applyNativeInterpolation(plan) {
      calls.apply.push(plan);
      return { ok: true, verified: true, readbackVerified: true, oneUndoStep: true, undoStep: 1, changed: true, committed: true };
    },
    emit(next) { this.snapshot = next; for (const subscriber of subscribers) subscriber(next); },
    destroy() { calls.destroy += 1; },
  };
  return adapter;
}

function createHarness(options = {}) {
  const document = fakeDocument();
  const elements = createElements(document);
  const raf = createRaf();
  const adapter = options.adapter || createAdapter(options.snapshot || readySnapshot());
  const toasts = [];
  const announcements = [];
  const states = [];
  const controller = new workspaceApi.CurvesWorkspaceController(elements, {
    adapter,
    document,
    presetApi,
    presetStore: options.presetStore,
    presetHooks: options.presetHooks,
    confirmPresetAction: options.confirmPresetAction,
    confirmBakedApply: options.confirmBakedApply,
    allowBakedMode: options.allowBakedMode,
    stateStore: options.stateStore,
    preferences: options.preferences,
    visible: options.visible !== false,
    active: options.active !== false,
    ownsAdapter: options.ownsAdapter,
    requestAnimationFrame: raf.request,
    cancelAnimationFrame: raf.cancel,
    onToast: (...args) => toasts.push(args),
    onAnnounce: (message) => announcements.push(message),
    onStateChange: (state) => states.push(state),
  });
  return { controller, elements, adapter, document, raf, toasts, announcements, states };
}

test("M5 workspace exposes a strict state model, integration aliases, and normalized graph utilities", () => {
  assert.deepEqual(workspaceApi.WORKSPACE_STATES, ["loading", "empty", "error", "unsupported", "ready"]);
  assert.equal(typeof workspaceApi.CurvesWorkspaceController, "function");
  assert.deepEqual(workspaceApi.normalizeControlPoints([2, -9, -1, 9]), [1, -1, 0, 2]);
  assert.equal(workspaceApi.curvePathData([0.25, 0.1, 0.25, 1]), "M 0 100 C 25 90 25 0 100 0");
  const root = fakeElement("SECTION");
  const replayGrid = fakeElement("DIV");
  const curvesGraphGrid = fakeElement("G");
  const aliases = workspaceApi.normalizeElements({
    curvesWorkspace: root,
    curvesGraphPath: fakeElement("PATH"),
    grid: replayGrid,
    curvesGraphGrid,
  });
  assert.equal(aliases.root, root);
  assert.equal(aliases.path.tagName, "PATH");
  assert.equal(aliases.grid, curvesGraphGrid);
  assert.notEqual(aliases.grid, replayGrid);
});

test("M9 Curves keeps the SVG a visual preview and exposes four scalar numeric controls", () => {
  assert.match(indexSource, /<svg id="curvesGraph"[^>]*role="img"[^>]*aria-describedby="curvesGraphDescription"/);
  assert.doesNotMatch(indexSource, /id="curvesHandle(?:One|Two)"[^>]*role="slider"/);
  assert.match(indexSource, /id="curvesHandleOne"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(indexSource, /id="curvesHandleTwo"[^>]*aria-hidden="true"[^>]*focusable="false"/);
  for (const id of ["curvesPointOneX", "curvesPointOneY", "curvesPointTwoX", "curvesPointTwoY"]) {
    assert.match(indexSource, new RegExp(`<label[^>]*><span>[^<]+</span><input id="${id}" type="number"`));
  }
  assert.match(indexSource, /id="curvesGridSize"[\s\S]*4 × 4[\s\S]*8 × 8[\s\S]*16 × 16/);
  assert.match(indexSource, /id="curvesPresetViewList"[\s\S]*id="curvesPresetViewGrid"/);
  assert.doesNotMatch(indexSource, /id="curvesModeBaked"/);
});

test("docked Curves keeps detected properties in a bounded scroller and Go in the fixed footer", () => {
  const inspectorStart = indexSource.indexOf('<aside id="curvesInspector"');
  const inspectorEnd = indexSource.indexOf("</aside>", inspectorStart);
  const footerStart = indexSource.indexOf('<footer class="curves-workspace__apply-bar">');
  const footerEnd = indexSource.indexOf("</footer>", footerStart);
  const applyIndex = indexSource.indexOf('id="curvesApply"');
  const detectedIndex = indexSource.indexOf('id="curvesDetectedProperties"');
  assert.ok(detectedIndex > inspectorStart && detectedIndex < inspectorEnd);
  assert.ok(applyIndex > footerStart && applyIndex < footerEnd);
  assert.ok(footerStart > inspectorEnd, "Go must not share the shrinking inspector stack");
  assert.match(cssSource, /\.curves-detected\s*\{[\s\S]*?min-height:\s*43px;[\s\S]*?flex:\s*0 0 auto;[\s\S]*?overflow:\s*hidden;/);
  assert.match(cssSource, /\.curves-detected__list\s*\{[\s\S]*?min-height:\s*24px;[\s\S]*?max-height:\s*52px;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(cssSource, /\.curves-inspector\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(cssSource, /\.curves-workspace__apply-bar\s*\{[\s\S]*?flex:\s*0 0 40px;/);
});

test("M1 Curves color preferences normalize and update the real graph tokens", async () => {
  assert.deepEqual(
    workspaceApi.normalizePreferences({ gridColor: "123", curveColor: "#abcdef" }),
    {
      gridVisible: true,
      subdivisions: 8,
      snapping: true,
      handleSize: 12,
      sampleBudget: 48,
      warningThreshold: 120,
      defaultMode: "native",
      gridColor: "#112233",
      curveColor: "#ABCDEF",
    },
  );
  const harness = createHarness({ preferences: { gridColor: "#223344", curveColor: "#FEDCBA" } });
  harness.controller.start();
  assert.equal(harness.elements.root.style.values.get("--curve-graph-grid"), "#223344");
  assert.equal(harness.elements.root.style.values.get("--curve-graph-line"), "#FEDCBA");
  harness.controller.setPreferences({ gridColor: "invalid", curveColor: "#0f8" });
  assert.equal(harness.elements.root.style.values.get("--curve-graph-grid"), "#3C3C3C");
  assert.equal(harness.elements.root.style.values.get("--curve-graph-line"), "#00FF88");
  await harness.controller.destroy();
});

test("M5 baked mode requires the complete explicit runtime proof, never a hopeful capability boolean", () => {
  const incomplete = workspaceApi.normalizeSnapshot(readySnapshot(undefined, {
    capabilities: { bakedProof: { enabled: true, verified: true, readbackVerified: true, oneUndoStep: true } },
  }));
  assert.equal(incomplete.capabilities.bakedVerified, false);
  const complete = workspaceApi.normalizeSnapshot(readySnapshot(undefined, {
    capabilities: { bakedProof: { enabled: true, verified: true, readbackVerified: true, oneUndoStep: true, ownershipSafe: true } },
  }));
  assert.equal(complete.capabilities.bakedVerified, true);
});

test("M5 lifecycle activates host observation only while both route-visible and active", async () => {
  const adapter = createAdapter({ state: "loading", message: "Waiting", selectedBindings: [], capabilities: {} });
  const harness = createHarness({ adapter, visible: false, active: false });
  harness.controller.start();
  assert.equal(harness.elements.root.dataset.curvesState, "loading");
  assert.equal(harness.elements.state.hidden, false, "the state surface is never blank");
  assert.equal(adapter.calls.refresh.length, 0);

  harness.controller.setLifecycle({ visible: true, active: true });
  await flush();
  assert.equal(adapter.calls.refresh.length, 1);
  assert.deepEqual(adapter.calls.visible.at(-1), true);
  assert.deepEqual(adapter.calls.active.at(-1), true);

  harness.controller.setVisible(false);
  assert.equal(adapter.calls.visible.at(-1), false);
  await harness.controller.destroy();
});

test("M5 ready state presents a stable property selector across multiple compatible clips", async () => {
  const snapshot = readySnapshot([
    binding("a", { clipId: "clip-a", clipName: "Hero A", propertyId: "position-x" }),
    binding("b", { clipId: "clip-b", clipName: "Hero B", propertyId: "position-x" }),
  ]);
  const harness = createHarness({ snapshot });
  harness.controller.start();
  await flush();
  harness.raf.flush();
  assert.equal(harness.elements.root.dataset.curvesState, "ready");
  assert.equal(harness.elements.content.hidden, false);
  assert.equal(harness.elements.clipSelect.children.length, 3, "All selected plus two explicit clips");
  assert.equal(harness.elements.clipSelect.value, "*");
  assert.equal(harness.controller.getState().compatibleBindingCount, 2);
  assert.match(harness.elements.clipSummary.textContent, /2 selected clips/);
  assert.match(harness.elements.endpointsSummary.textContent, /1\.000 s.*2\.000 s/);
  assert.equal(harness.elements.apply.disabled, false);
  assert.match(harness.elements.path.getAttribute("d"), /^M 0 100 C/);
  await harness.controller.destroy();
});

test("OpenCurve-style property buttons auto-select detected targets and support multi-property Apply", async () => {
  const snapshot = readySnapshot([
    binding("opacity-a", { clipId: "clip-a", propertyId: "opacity", propertyName: "Opacity" }),
    binding("opacity-b", { clipId: "clip-b", propertyId: "opacity", propertyName: "Opacity" }),
    binding("rotation-a", { clipId: "clip-a", propertyId: "rotation", propertyName: "Rotation" }),
  ], { detectionSource: "playhead", autoDetected: true });
  snapshot.detectionSource = "playhead";
  snapshot.autoDetected = true;
  const adapter = createAdapter(snapshot);
  const harness = createHarness({ adapter });
  harness.controller.start();
  await flush();
  assert.equal(harness.controller.getState().autoDetected, true);
  assert.equal(harness.controller.getState().compatibleBindingCount, 3);
  assert.equal(harness.elements.detectedProperties.children.length, 2);
  const opacityButton = harness.elements.detectedProperties.children.find((entry) => entry.textContent === "Opacity");
  harness.elements.detectedProperties.dispatch("click", { target: opacityButton });
  assert.equal(harness.controller.getState().compatibleBindingCount, 1);
  assert.equal(await harness.controller.apply(), true);
  assert.equal(adapter.calls.plan.at(-1).bindings.length, 1);
  harness.elements.detectedProperties.dispatch("click", { target: opacityButton });
  assert.equal(harness.controller.getState().compatibleBindingCount, 3);
  await harness.controller.destroy();
});

test("the preset rail is resizable and persists its bounded width", async () => {
  const writes = [];
  const harness = createHarness({ stateStore: { setCurvesWorkspaceState: (state) => writes.push(state) } });
  harness.controller.start();
  await flush();
  harness.elements.resizeHandle.dispatch("pointerdown", { pointerId: 11, button: 0, clientX: 400 });
  harness.elements.resizeHandle.dispatch("pointermove", { pointerId: 11, clientX: 350 });
  harness.elements.resizeHandle.dispatch("pointerup", { pointerId: 11, clientX: 350 });
  assert.equal(harness.controller.getState().inspectorWidth, 234);
  assert.equal(harness.elements.inspector.style.values.get("--curves-inspector-width"), "234px");
  assert.equal(writes.at(-1).inspectorWidth, 234);
  await harness.controller.destroy();
});

test("M5 loading, empty, unsupported, and error snapshots always leave an actionable visible state", async () => {
  const harness = createHarness();
  harness.controller.start();
  const cases = [
    [{ state: "loading", message: "Inspecting", selectedBindings: [] }, "loading", "Loading Curves"],
    [{ state: "empty", message: "Select a clip", selectedBindings: [] }, "empty", "Choose an animated property"],
    [{ state: "unsupported", message: "No keys", selectedBindings: [binding("bad", { compatible: false, reason: "No keys" })] }, "unsupported", "Selection is not compatible"],
    [{ state: "error", error: { code: "HOST", message: "Host failed" }, selectedBindings: [] }, "error", "Curves needs attention"],
  ];
  for (const [snapshot, state, title] of cases) {
    harness.adapter.emit(snapshot);
    assert.equal(harness.elements.root.dataset.curvesState, state);
    assert.equal(harness.elements.state.hidden, false);
    assert.equal(harness.elements.stateTitle.textContent, title);
    assert.ok(harness.elements.stateMessage.textContent.length > 0);
  }
  await harness.controller.destroy();
});

test("M5 pointer preview is smooth by default, Shift-snapped, RAF-coalesced, and never mutates Premiere", async () => {
  const harness = createHarness({ preferences: { curves: { subdivisions: 4, snapping: true } } });
  harness.controller.start();
  await flush();
  harness.raf.flush();
  const beforePath = harness.elements.path.getAttribute("d");
  harness.elements.graph.dispatch("pointerdown", { target: harness.elements.handleOne, pointerId: 17, clientX: 55, clientY: 153 });
  harness.elements.graph.dispatch("pointermove", { target: harness.elements.graph, pointerId: 17, clientX: 78, clientY: 82, shiftKey: true });
  assert.equal(harness.elements.graph.capturedPointer, 17);
  assert.deepEqual(harness.controller.getState().controlPoints.slice(0, 2), [0.5, 0.5]);
  assert.equal(harness.elements.path.getAttribute("d"), beforePath, "SVG preview waits for the next display frame");
  assert.equal(harness.adapter.calls.plan.length, 0);
  assert.equal(harness.adapter.calls.apply.length, 0);
  assert.equal(harness.raf.callbacks.size, 1, "rapid preview changes coalesce into one frame");
  harness.raf.flush();
  assert.notEqual(harness.elements.path.getAttribute("d"), beforePath);
  harness.elements.graph.dispatch("pointerup", { target: harness.elements.graph, pointerId: 17 });
  assert.equal(harness.elements.graph.releasedPointer, 17);
  await harness.controller.destroy();
});

test("M5 ordinary pointer drag stays unsnapped and keyboard/numeric edits remain precise and announced", async () => {
  const harness = createHarness({ preferences: { snapping: true, subdivisions: 4 } });
  harness.controller.start();
  await flush();
  harness.raf.flush();
  harness.elements.graph.dispatch("pointerdown", { target: harness.elements.handleOne, pointerId: 3, clientX: 55, clientY: 153 });
  harness.elements.graph.dispatch("pointermove", { target: harness.elements.graph, pointerId: 3, clientX: 78, clientY: 82 });
  const free = harness.controller.getState().controlPoints;
  assert.ok(Math.abs(free[0] - 0.379) < 0.01);
  assert.ok(Math.abs(free[1] - 0.599) < 0.02);
  harness.elements.graph.dispatch("pointerup", { pointerId: 3 });

  const keyEvent = harness.elements.handleTwo.dispatch("keydown", { key: "ArrowRight", target: harness.elements.handleTwo, ctrlKey: true });
  assert.equal(keyEvent.defaultPrevented, true);
  const beforeNumeric = harness.controller.getState().controlPoints[1];
  harness.elements.pointOneY.value = "1.375";
  harness.elements.pointOneY.dispatch("change", { target: harness.elements.pointOneY });
  assert.equal(harness.controller.getState().controlPoints[1], 1.375);
  assert.notEqual(beforeNumeric, 1.375);
  assert.ok(harness.announcements.length >= 2);
  await harness.controller.destroy();
});

test("M5 graph tools fit, reset, mirror, reverse, copy, and paste operate on local state", async () => {
  const harness = createHarness();
  harness.controller.start();
  await flush();
  harness.controller.controlPoints = [0.1, -0.2, 0.8, 1.4];
  harness.controller.viewport = { zoom: 4, panX: 0.4, panY: -0.2 };
  harness.controller.fitGraph();
  assert.deepEqual(harness.controller.getState().viewport, { zoom: 1, panX: 0, panY: 0 });
  harness.controller.mirrorCurve();
  assert.deepEqual(harness.controller.getState().controlPoints, [0.1, 1.2, 0.8, -0.3999999999999999]);
  harness.controller.reverseCurve();
  assert.ok(Math.abs(harness.controller.getState().controlPoints[0] - 0.2) < 1e-12);
  assert.equal(await harness.controller.copyCurve(), true);
  harness.controller.resetCurve();
  assert.deepEqual(harness.controller.getState().controlPoints, workspaceApi.DEFAULT_CONTROL_POINTS);
  assert.equal(await harness.controller.pasteCurve(), true);
  assert.notDeepEqual(harness.controller.getState().controlPoints, workspaceApi.DEFAULT_CONTROL_POINTS);
  assert.equal(harness.elements.paste.disabled, false);
  assert.equal(harness.adapter.calls.apply.length, 0);
  await harness.controller.destroy();
});

test("M5 native Apply plans once, preserves the selected bindings, and accepts only verified one-step readback", async () => {
  const snapshot = readySnapshot([
    binding("a", { clipId: "clip-a", propertyId: "position-x" }),
    binding("b", { clipId: "clip-b", propertyId: "position-x" }),
  ]);
  const adapter = createAdapter(snapshot);
  const harness = createHarness({ adapter });
  harness.controller.start();
  await flush();
  const refreshBeforeApply = adapter.calls.refresh.length;
  assert.equal(await harness.controller.apply(), true);
  assert.equal(adapter.calls.plan.length, 1);
  assert.equal(adapter.calls.plan[0].bindings.length, 2);
  assert.equal(adapter.calls.plan[0].mode, "BEZIER");
  assert.equal(Object.prototype.hasOwnProperty.call(adapter.calls.plan[0].options, "controlPoints"), false);
  assert.equal(adapter.calls.apply.length, 1);
  assert.ok(adapter.calls.refresh.length > refreshBeforeApply, "verified readback refresh follows Apply");
  assert.match(harness.toasts.at(-1)[0], /0 keys added, 1 Undo step/);

  adapter.applyNativeInterpolation = async () => ({ ok: true, verified: false, oneUndoStep: true });
  assert.equal(await harness.controller.apply(), false);
  assert.match(harness.toasts.at(-1)[0], /verified curve readback/i);
  await harness.controller.destroy();
});

test("M5 page-level baked mode is unreachable and cannot call host actions", async () => {
  const harness = createHarness();
  harness.controller.start();
  await flush();
  assert.equal(harness.elements.modeBaked.disabled, true);
  assert.equal(harness.elements.modeBaked.title, "This Curves page intentionally uses native two-key interpolation only.");
  assert.equal(harness.controller.setMode("baked"), false);
  assert.equal(harness.controller.getState().mode, "native");
  assert.equal(harness.adapter.calls.plan.length, 0);
  assert.equal(harness.adapter.calls.apply.length, 0);
  await harness.controller.destroy();
});

test("M5 proven numeric baked mode generates exact frame-quantized samples before the adapter plan", async () => {
  const bakedProof = {
    enabled: true,
    verified: true,
    readbackVerified: true,
    oneUndoStep: true,
    ownershipSafe: true,
    version: 1,
    valueKinds: ["number"],
  };
  const snapshot = readySnapshot([
    binding("baked-a", {
      bakedCompatible: true,
      ticksPerFrame: "10",
      keyTicks: ["100", "200"],
      start: { ticks: "100", value: 0, interpolation: 1 },
      end: { ticks: "200", value: 100, interpolation: 1 },
    }),
  ]);
  snapshot.sequence = { ticksPerFrame: "10" };
  snapshot.capabilities.bakedCurve = { supported: true };
  const adapter = createAdapter(snapshot, { bakedProof });
  const bakedCalls = [];
  adapter.planBakedCurve = async (bindings, samplesByBinding, options) => {
    bakedCalls.push({ bindings, samplesByBinding, options });
    return { kind: "baked-plan" };
  };
  adapter.applyBakedCurve = async () => ({ ok: true, verified: true, oneUndoStep: true, undoStep: 1, changed: true, committed: true });
  const harness = createHarness({ adapter, preferences: { sampleBudget: 24, warningThreshold: 40 }, allowBakedMode: true });
  harness.controller.start();
  await flush();
  assert.equal(harness.controller.setMode("baked"), true);
  assert.equal(harness.elements.modeBaked.disabled, false);
  assert.match(harness.elements.samplePreview.textContent, /generated key/);
  assert.equal(await harness.controller.apply(), true);
  assert.equal(bakedCalls.length, 1);
  const generated = bakedCalls[0].samplesByBinding["baked-a"];
  assert.ok(generated.length > 2);
  assert.ok(generated.every((sample) => BigInt(sample.ticks) % 10n === 0n));
  assert.equal(bakedCalls[0].options.warningThreshold, 40);
  assert.equal(Object.prototype.hasOwnProperty.call(bakedCalls[0], "cubicControlPoints"), false);
  await harness.controller.destroy();
});

test("M5 graph settings render only supported 4, 8, and 16 subdivision grids", async () => {
  const harness = createHarness({ preferences: { subdivisions: 4, gridVisible: true } });
  harness.controller.start();
  assert.equal(harness.elements.grid.hidden, false);
  assert.equal(harness.elements.grid.children.length, 10);
  assert.equal(harness.elements.grid.children[2].getAttribute("x1"), "25");

  assert.equal(harness.controller.setGridSize(8), true);
  assert.equal(harness.elements.grid.children.length, 18);
  assert.equal(harness.elements.grid.children[2].getAttribute("x1"), "12.5");
  assert.equal(harness.elements.grid8.getAttribute("aria-pressed"), "true");

  harness.elements.grid16.dispatch("click");
  assert.equal(harness.controller.getState().gridSize, 16);
  assert.equal(harness.elements.grid16.getAttribute("aria-pressed"), "true");
  assert.equal(harness.elements.grid.children.length, 34);
  harness.controller.setPreferences({ subdivisions: 16, gridVisible: false });
  assert.equal(harness.elements.grid.hidden, true);
  await harness.controller.destroy();
});

test("M5 Curves-only settings drawer persists grid density, preset view, and native output", async () => {
  const writes = [];
  const stateStore = {
    getCurvesWorkspaceState: () => ({ version: 2, gridSize: 4, presetView: "list", nativeInterpolation: "HOLD" }),
    setCurvesWorkspaceState: (state) => { writes.push(state); return true; },
  };
  const harness = createHarness({ stateStore });
  harness.controller.start();
  await flush();
  assert.equal(harness.controller.getState().gridSize, 4);
  assert.equal(harness.controller.getState().nativeInterpolation, "HOLD");
  assert.equal(harness.elements.settingsPanel.hidden, true);
  harness.elements.settingsToggle.dispatch("click");
  assert.equal(harness.elements.settingsPanel.hidden, false);
  assert.equal(harness.elements.settingsToggle.getAttribute("aria-expanded"), "true");
  harness.elements.gridSize.value = "16";
  harness.elements.gridSize.dispatch("change");
  harness.elements.presetViewGrid.dispatch("click");
  assert.equal(harness.controller.getState().gridSize, 16);
  assert.equal(harness.controller.getState().presetView, "grid");
  assert.ok(writes.some((state) => state.version === 2 && state.gridSize === 16 && state.presetView === "grid"));
  harness.elements.settingsClose.dispatch("click");
  assert.equal(harness.elements.settingsPanel.hidden, true);
  await harness.controller.destroy();
});

test("M5 baked warning threshold requires explicit confirmation before any host plan", async () => {
  const bakedProof = {
    enabled: true,
    verified: true,
    readbackVerified: true,
    oneUndoStep: true,
    ownershipSafe: true,
    version: 1,
    valueKinds: ["number"],
  };
  const snapshot = readySnapshot([
    binding("threshold-a", {
      bakedCompatible: true,
      ticksPerFrame: "10",
      keyTicks: ["100", "1100"],
      start: { ticks: "100", value: 0, interpolation: 1 },
      end: { ticks: "1100", value: 100, interpolation: 1 },
    }),
  ]);
  snapshot.sequence = { ticksPerFrame: "10" };
  snapshot.capabilities.bakedCurve = { supported: true };
  const adapter = createAdapter(snapshot, { bakedProof });
  const hostCalls = [];
  adapter.planBakedCurve = async (...args) => { hostCalls.push(["plan", ...args]); return { kind: "baked-plan" }; };
  adapter.applyBakedCurve = async (...args) => { hostCalls.push(["apply", ...args]); return { ok: true, verified: true, oneUndoStep: true, undoStep: 1, changed: true, committed: true }; };
  const confirmations = [];
  const harness = createHarness({
    adapter,
    preferences: { sampleBudget: 48, warningThreshold: 16 },
    confirmBakedApply: async (request) => { confirmations.push(request); return false; },
    allowBakedMode: true,
  });
  harness.controller.start();
  await flush();
  assert.equal(harness.controller.setMode("baked"), true);
  assert.match(harness.elements.samplePreview.textContent, /exceeds warning threshold 16/);
  assert.equal(await harness.controller.apply(), false);
  assert.equal(confirmations.length, 1);
  assert.ok(confirmations[0].addedKeyCount > 16);
  assert.equal(hostCalls.length, 0);
  assert.match(harness.toasts.at(-1)[0], /cancelled before Premiere was changed/i);

  harness.controller.confirmBakedApply = async () => true;
  assert.equal(await harness.controller.apply(), true);
  assert.deepEqual(hostCalls.map((entry) => entry[0]), ["plan", "apply"]);
  await harness.controller.destroy();
});

test("M5 combined preset rail renders built-in and saved curves while keeping built-ins immutable", async () => {
  const library = presetApi.createEmptyPresetLibrary({ now: "2026-07-16T00:00:00.000Z" });
  const created = presetApi.createUserPreset(library, { name: "My Curve", cubicControlPoints: [0.2, 0.2, 0.8, 0.8] }, { now: "2026-07-16T00:00:01.000Z" });
  const presetStore = { getLibrary: () => created.library };
  const harness = createHarness({
    presetStore,
    presetHooks: {
      rename: async (payload) => ({ ok: true, library: payload.library }),
      duplicate: async (payload) => ({ ok: true, library: payload.library }),
    },
  });
  harness.controller.start();
  await flush();
  assert.equal(harness.elements.presetList.children.length, 13, "built-ins and the saved curve share one compact rail");
  const builtInButton = harness.elements.presetList.children[0];
  harness.elements.presetList.dispatch("click", { target: builtInButton });
  assert.ok(harness.controller.getState().selectedPresetId);
  assert.equal(harness.elements.presetOverwrite.disabled, true);
  assert.match(harness.elements.presetOverwrite.title, /immutable/i);

  const savedButton = harness.elements.presetList.children.at(-1);
  assert.equal(savedButton.children.find((child) => child.className === "curves-preset-card__name").textContent, "My Curve");
  assert.equal(savedButton.dataset.curvePresetKind, "user");
  harness.elements.presetList.dispatch("click", { target: savedButton });
  assert.equal(harness.elements.graphTitle.textContent, "My Curve");
  assert.equal(harness.elements.presetRename.disabled, false);
  assert.equal(harness.elements.presetDuplicate.disabled, false);
  await harness.controller.destroy();
});

test("M5 user preset tags and folders render, edit atomically, and keep real management hooks gated", async () => {
  let library = presetApi.createUserPreset(
    presetApi.createEmptyPresetLibrary(),
    { name: "Organized", cubicControlPoints: [0.2, 0.2, 0.8, 0.8], tags: ["Hero"] },
    { now: "2026-07-16T00:00:01.000Z" },
  ).library;
  const folderResult = presetApi.createFolder(library, "Action", { now: "2026-07-16T00:00:02.000Z" });
  library = presetApi.assignPresetFolder(
    folderResult.library,
    folderResult.library.presets[0].id,
    folderResult.folder.id,
    { now: "2026-07-16T00:00:03.000Z" },
  ).library;
  const payloads = [];
  const hooks = {
    metadata: async (payload) => {
      payloads.push(payload);
      const result = presetApi.updateUserPresetOrganization(payload.library, payload.preset.id, payload);
      return result;
    },
    folderCreate: async (payload) => ({ ...presetApi.createFolder(payload.library, "Settle"), ok: true }),
    folderRename: async (payload) => ({ ...presetApi.renameFolder(payload.library, payload.folderId, "Action Renamed"), ok: true }),
    folderDelete: async (payload) => presetApi.deleteFolder(payload.library, payload.folderId, { confirmed: true }),
  };
  const harness = createHarness({ presetStore: { getLibrary: () => library }, presetHooks: hooks });
  harness.controller.start();
  await flush();
  const userCard = harness.elements.presetList.children.find((card) => card.dataset.curvePresetKind === "user");
  harness.elements.presetList.dispatch("click", { target: userCard });
  assert.equal(harness.elements.presetFolder.value, folderResult.folder.id);
  assert.equal(harness.elements.presetTags.value, "Hero");
  assert.equal(harness.elements.presetMetadata.disabled, false);
  assert.equal(harness.elements.presetFolderRename.disabled, false);
  assert.equal(harness.elements.presetFolderDelete.disabled, false);
  assert.equal(userCard.children.find((child) => child.className === "curves-preset-card__kind").textContent, "Saved");

  harness.elements.presetFolder.value = "";
  harness.elements.presetFolder.dispatch("change");
  harness.elements.presetTags.value = "Impact, hero, Impact";
  harness.elements.presetTags.dispatch("input");
  assert.equal(await harness.controller.invokePresetAction("metadata"), true);
  assert.deepEqual(payloads[0].tags, ["Impact", "hero", "Impact"]);
  assert.equal(harness.controller.presetLibrary.presets[0].folderId, null);
  assert.deepEqual(harness.controller.presetLibrary.presets[0].tags, ["Impact", "hero"]);
  await harness.controller.destroy();
});

test("M5 user preset ordering remains available through the compact library actions", async () => {
  let library = presetApi.createEmptyPresetLibrary();
  for (const name of ["First", "Second", "Third"]) {
    library = presetApi.createUserPreset(library, { name, cubicControlPoints: [0.2, 0.2, 0.8, 0.8] }).library;
  }
  const reorderCalls = [];
  const hooks = {
    moveDown: async (payload) => {
      reorderCalls.push(payload);
      const index = payload.library.presets.findIndex((preset) => preset.id === payload.preset.id);
      return presetApi.reorderUserPreset(payload.library, payload.preset.id, Math.min(payload.library.presets.length - 1, index + 1));
    },
  };
  const harness = createHarness({ presetStore: { getLibrary: () => library }, presetHooks: hooks });
  harness.controller.start();
  await flush();
  const firstUserCard = harness.elements.presetList.children.find((card) => card.dataset.curvePresetKind === "user");
  harness.elements.presetList.dispatch("click", { target: firstUserCard });
  assert.equal(await harness.controller.invokePresetAction("moveDown"), true);
  await flush();
  assert.equal(reorderCalls.length, 1);
  assert.deepEqual(harness.controller.presetLibrary.presets.map((preset) => preset.name), ["Second", "First", "Third"]);
  await harness.controller.destroy();
});

test("M9 combined Curves listbox uses APG roving focus and switches list/grid presentation", async () => {
  const library = presetApi.createUserPreset(
    presetApi.createEmptyPresetLibrary(),
    { name: "Keyboard Curve", cubicControlPoints: [0.15, 0.2, 0.85, 0.9] },
  ).library;
  const harness = createHarness({ presetStore: { getLibrary: () => library } });
  harness.controller.start();
  await flush();

  const cards = harness.elements.presetList.children;
  assert.equal(cards.length, 13);
  assert.equal(cards[0].tabIndex, 0);
  assert.ok(cards.slice(1).every((card) => card.tabIndex === -1));
  let event = harness.elements.presetList.dispatch("keydown", { target: cards[0], key: "End" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.document.activeElement, cards[cards.length - 1]);
  assert.equal(harness.controller.getState().selectedPresetId, "", "roving does not load a curve prematurely");
  const endId = cards[cards.length - 1].dataset.curvePresetId;
  event = harness.elements.presetList.dispatch("keydown", { target: cards[cards.length - 1], key: "Spacebar" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.controller.getState().selectedPresetId, endId);
  assert.equal(harness.document.activeElement.dataset.curvePresetId, endId, "focus follows the rebuilt selected option");
  assert.match(harness.announcements.at(-1), /loaded into the local curve preview/i);
  assert.equal(harness.controller.setPresetView("grid"), true);
  assert.equal(harness.elements.presetList.dataset.view, "grid");
  assert.equal(harness.elements.presetViewGrid.getAttribute("aria-pressed"), "true");
  assert.equal(harness.controller.setGridSize(16), true);
  assert.equal(harness.elements.grid.children.length, 34);
  await harness.controller.destroy();
});

test("M5 destructive user-preset hooks require explicit confirmation and JSON hooks stay honest", async () => {
  const library = presetApi.createUserPreset(
    presetApi.createEmptyPresetLibrary(),
    { name: "Delete Me", cubicControlPoints: [0.2, 0.1, 0.8, 0.9] },
  ).library;
  const calls = [];
  const hooks = {
    delete: async (payload) => { calls.push(payload); return { ok: true, library: presetApi.createEmptyPresetLibrary() }; },
    import: async (payload) => { calls.push(payload); return { ok: true, library }; },
    export: async (payload) => { calls.push(payload); return { ok: true }; },
  };
  let confirmed = false;
  const harness = createHarness({
    presetStore: { getLibrary: () => library },
    presetHooks: hooks,
    confirmPresetAction: async () => confirmed,
  });
  harness.controller.start();
  await flush();
  harness.controller.setPresetTab("user");
  const button = harness.elements.presetList.children[0];
  harness.elements.presetList.dispatch("click", { target: button });
  assert.equal(await harness.controller.invokePresetAction("delete"), false);
  assert.equal(calls.length, 0);
  confirmed = true;
  assert.equal(await harness.controller.invokePresetAction("delete"), true);
  assert.equal(calls[0].confirmed, true);
  assert.equal(calls[0].format, "oracle-json");
  assert.equal(await harness.controller.invokePresetAction("import"), true);
  assert.equal(await harness.controller.invokePresetAction("export"), true);
  assert.ok(calls.every((entry) => entry.format === "oracle-json"));
  await harness.controller.destroy();
});

test("M5 hidden workspace cancels pending previews and teardown is idempotent without destroying a shared adapter", async () => {
  const harness = createHarness();
  harness.controller.start();
  await flush();
  assert.ok(harness.raf.callbacks.size > 0);
  harness.controller.setVisible(false);
  assert.equal(harness.raf.callbacks.size, 0);
  assert.ok(harness.raf.cancelled.length > 0);
  const listenerCount = harness.elements.graph.listenerCount("pointermove");
  assert.equal(listenerCount, 1);
  const first = harness.controller.destroy();
  const second = harness.controller.destroy();
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(harness.elements.graph.listenerCount("pointermove"), 0);
  assert.equal(harness.adapter.calls.destroy, 0, "the shared injected adapter is not destroyed by one mount");
});

test("M5 workspace source contains no fake media, unsafe child replacement, CSS layout grid, Blob URL, or Premiere preset path", () => {
  const source = fs.readFileSync("./src/curves/oracle-curves-workspace.js", "utf8");
  const css = fs.readFileSync("./styles/overdrive-m5.css", "utf8");
  assert.doesNotMatch(source, /\.replaceChildren\s*\(/);
  assert.doesNotMatch(source, /createObjectURL|revokeObjectURL|new\s+Blob|<video/i);
  assert.doesNotMatch(source, /\.prfpset/i);
  assert.doesNotMatch(css, /display\s*:\s*grid|grid-template/i);
  assert.match(source, /planNativeInterpolation/);
  assert.match(source, /oneUndoStep/);
  assert.match(source, /setPointerCapture/);
});
