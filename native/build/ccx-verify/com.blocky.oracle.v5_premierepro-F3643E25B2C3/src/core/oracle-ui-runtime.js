"use strict";

(function exposeOracleUiRuntime(globalScope, factory) {
  const api = factory(globalScope);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!globalScope) return;

  Reflect.set(globalScope, "OracleUiRuntime", api);
  if (!Reflect.get(globalScope, "oracleUiRuntime")) {
    Reflect.set(globalScope, "oracleUiRuntime", api.createOracleUiRuntime({
      window: globalScope,
      document: Reflect.get(globalScope, "document"),
      buildInfo: Reflect.get(globalScope, "OracleBuildInfo"),
    }));
  }
  if (!Reflect.get(globalScope, "oracleUiHealth")) {
    Reflect.set(globalScope, "oracleUiHealth", (options = {}) => {
      const runtime = Reflect.get(globalScope, "oracleUiRuntime");
      return runtime && typeof runtime.audit === "function"
        ? runtime.audit(options)
        : Object.freeze({ available: false, reason: "UI_RUNTIME_UNAVAILABLE" });
    });
  }
})(typeof window !== "undefined" ? window : null, function createOracleUiRuntimeApi(globalScope) {
  const WIDTH_CLASSES = Object.freeze(["micro", "narrow", "compact", "standard", "wide"]);
  const HEIGHT_CLASSES = Object.freeze(["short", "standard-height", "tall"]);
  const EXPECTED_FONT = "Samsung Sharp Sans";
  const RESPONSIVE_BREAKPOINTS = Object.freeze({
    maxWidth: Object.freeze([340, 360, 380, 460, 476, 480, 500, 520, 560, 600, 620, 700, 720]),
    minWidth: Object.freeze([601, 900]),
    maxHeight: Object.freeze([420, 520]),
    minHeight: Object.freeze([]),
  });

  function finiteDimension(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function classifyWidth(width) {
    const value = finiteDimension(width);
    if (value < 280) return "micro";
    if (value < 420) return "narrow";
    if (value < 640) return "compact";
    if (value < 880) return "standard";
    return "wide";
  }

  function classifyHeight(height) {
    const value = finiteDimension(height);
    if (value < 520) return "short";
    if (value < 800) return "standard-height";
    return "tall";
  }

  function viewportClass(widthClass, heightClass) {
    return `${widthClass} ${heightClass}`;
  }

  function rootDimensions(root) {
    let rectangle = null;
    try {
      rectangle = root && typeof root.getBoundingClientRect === "function"
        ? root.getBoundingClientRect()
        : null;
    } catch (error) {
      rectangle = null;
    }
    return {
      width: finiteDimension(rectangle && rectangle.width) || finiteDimension(root && root.clientWidth),
      height: finiteDimension(rectangle && rectangle.height) || finiteDimension(root && root.clientHeight),
    };
  }

  function writeAttribute(root, name, value) {
    if (!root || typeof root.setAttribute !== "function") return;
    root.setAttribute(name, String(value));
  }

  function writeResponsiveBreakpointAttributes(root, snapshot) {
    for (const pixels of RESPONSIVE_BREAKPOINTS.maxWidth) {
      writeAttribute(root, `data-oracle-max-width-${pixels}`, snapshot.width <= pixels ? "true" : "false");
    }
    for (const pixels of RESPONSIVE_BREAKPOINTS.minWidth) {
      writeAttribute(root, `data-oracle-min-width-${pixels}`, snapshot.width >= pixels ? "true" : "false");
    }
    for (const pixels of RESPONSIVE_BREAKPOINTS.maxHeight) {
      writeAttribute(root, `data-oracle-max-height-${pixels}`, snapshot.height <= pixels ? "true" : "false");
    }
    for (const pixels of RESPONSIVE_BREAKPOINTS.minHeight) {
      writeAttribute(root, `data-oracle-min-height-${pixels}`, snapshot.height >= pixels ? "true" : "false");
    }
  }

  function writeViewportAttributes(root, snapshot) {
    writeAttribute(root, "data-width-class", snapshot.widthClass);
    writeAttribute(root, "data-height-class", snapshot.heightClass);
    writeAttribute(root, "data-panel-visible", snapshot.visible ? "true" : "false");
    writeAttribute(root, "data-oracle-width-class", snapshot.widthClass);
    writeAttribute(root, "data-oracle-height-class", snapshot.heightClass);
    writeAttribute(root, "data-oracle-panel-visible", snapshot.visible ? "true" : "false");
    writeAttribute(root, "data-oracle-viewport-class", snapshot.viewportClass);
    writeAttribute(root, "data-oracle-viewport-width", Math.round(snapshot.width));
    writeAttribute(root, "data-oracle-viewport-height", Math.round(snapshot.height));
    writeResponsiveBreakpointAttributes(root, snapshot);
    writeAttribute(
      root,
      "data-oracle-panel-density",
      snapshot.widthClass === "micro" || snapshot.widthClass === "narrow" || snapshot.widthClass === "compact"
        ? "compact"
        : snapshot.widthClass === "wide"
          ? "wide"
          : "regular",
    );
  }

  function frozenSnapshot(record, dimensions, revision) {
    const widthClass = classifyWidth(dimensions.width);
    const heightClass = classifyHeight(dimensions.height);
    return Object.freeze({
      panelId: record.panelId,
      width: dimensions.width,
      height: dimensions.height,
      widthClass,
      heightClass,
      viewportClass: viewportClass(widthClass, heightClass),
      visible: record.visibilityOverride === null
        ? dimensions.width > 0 && dimensions.height > 0
        : record.visibilityOverride,
      revision,
    });
  }

  function snapshotChanged(previous, next) {
    return !previous ||
      previous.width !== next.width ||
      previous.height !== next.height ||
      previous.widthClass !== next.widthClass ||
      previous.heightClass !== next.heightClass ||
      previous.visible !== next.visible ||
      previous.panelId !== next.panelId;
  }

  function duplicateIdReport(root) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    const counts = new Map();
    const rootId = root.getAttribute && root.getAttribute("id");
    if (rootId) counts.set(rootId, 1);
    for (const node of Array.from(root.querySelectorAll("[id]"))) {
      const id = String(node && (node.id || (node.getAttribute && node.getAttribute("id"))) || "");
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return Array.from(counts.entries())
      .filter((entry) => entry[1] > 1)
      .map(([id, count]) => Object.freeze({ id, count }));
  }

  function isTextEditingControl(element) {
    const tag = String(element && element.tagName || "").toLocaleLowerCase("en-US");
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    const type = String(element.type || element.getAttribute && element.getAttribute("type") || "text")
      .toLocaleLowerCase("en-US");
    return ["email", "number", "password", "search", "tel", "text", "url"].includes(type);
  }

  function elementVisibility(element, root, getComputedStyleFunction) {
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute && current.getAttribute("aria-hidden") === "true") return null;
      if (typeof getComputedStyleFunction === "function") {
        try {
          const style = getComputedStyleFunction(current);
          if (style && (style.display === "none" || style.visibility === "hidden")) return null;
        } catch (error) { /* Geometry and authored hidden state remain available. */ }
      }
      if (current === root) break;
    }
    return typeof getComputedStyleFunction === "function"
      ? (() => { try { return getComputedStyleFunction(element); } catch (error) { return null; } })()
      : null;
  }

  function fontOverrideCapability(element) {
    const tag = String(element && element.tagName || "").toLocaleLowerCase("en-US");
    if (isTextEditingControl(element)) return "host-controlled-text-edit";
    if (tag.startsWith("sp-")) return "spectrum-component-dependent";
    return "css-overridable";
  }

  function controlTechnology(element, customElementsRegistry) {
    const tag = String(element && element.tagName || "").toLocaleLowerCase("en-US");
    if (!tag.startsWith("sp-")) return "standard-html";
    if (customElementsRegistry && typeof customElementsRegistry.get === "function") {
      try {
        if (customElementsRegistry.get(tag)) return "spectrum-web-component";
      } catch (error) { /* Built-in Spectrum UXP widgets are not Custom Elements. */ }
    }
    return "spectrum-uxp-widget";
  }

  function visibleControlInventory(root, getComputedStyleFunction, customElementsRegistry) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    const selector = [
      "button", "input", "select", "textarea", "video", "audio",
      "[role=button]", "[role=tab]", "[role=checkbox]", "[role=switch]",
      "[role=slider]", "[role=combobox]", "[role=listbox]", "[role=option]",
    ].join(",");
    const seen = new Set();
    const inventory = [];
    for (const element of Array.from(root.querySelectorAll(selector))) {
      if (!element || seen.has(element)) continue;
      seen.add(element);
      const style = elementVisibility(element, root, getComputedStyleFunction);
      if (style === null && typeof getComputedStyleFunction === "function") continue;
      if (element.hidden || element.getAttribute && element.getAttribute("aria-hidden") === "true") continue;
      const dimensions = rootDimensions(element);
      if (dimensions.width <= 0 || dimensions.height <= 0) continue;
      const tag = String(element.tagName || "").toLocaleLowerCase("en-US");
      const role = cleanHealthText(element.getAttribute && element.getAttribute("role"), 48);
      const type = cleanHealthText(element.type || element.getAttribute && element.getAttribute("type"), 48);
      const family = cleanHealthText(style && style.fontFamily, 160);
      inventory.push(Object.freeze({
        tag,
        id: cleanHealthText(element.id, 128),
        type,
        role,
        name: cleanHealthText(
          element.getAttribute && (element.getAttribute("aria-label") || element.getAttribute("title")) ||
          element.textContent || element.value,
          120,
        ),
        technology: controlTechnology(element, customElementsRegistry),
        fontOverride: fontOverrideCapability(element),
        fontFamily: family,
        width: dimensions.width,
        height: dimensions.height,
      }));
    }
    return inventory;
  }

  function visibleTextElements(root, getComputedStyleFunction) {
    if (!root || typeof root.querySelectorAll !== "function" || typeof getComputedStyleFunction !== "function") {
      return { checked: 0, unexpected: [], hostControlled: [] };
    }
    const unexpected = [];
    const hostControlled = [];
    let checked = 0;
    const selector = "button,input,select,textarea,option,output,label,h1,h2,h3,h4,p,span,small,strong,[role=button],[role=tab],[role=tooltip]";
    for (const element of Array.from(root.querySelectorAll(selector))) {
      if (!element) continue;
      const tag = String(element.tagName || "").toLocaleLowerCase("en-US");
      if (tag === "input" && !isTextEditingControl(element)) continue;
      const style = elementVisibility(element, root, getComputedStyleFunction);
      if (!style) continue;
      checked += 1;
      const family = String(style.fontFamily || "").trim();
      const capability = fontOverrideCapability(element);
      const detail = Object.freeze({
          tag,
          id: String(element.id || ""),
          className: typeof element.className === "string" ? element.className.slice(0, 160) : "",
          text: String(element.textContent || element.value || "").trim().slice(0, 80),
          fontFamily: family.slice(0, 160),
          capability,
      });
      if (capability === "host-controlled-text-edit") {
        hostControlled.push(detail);
      } else if (family && !family.toLocaleLowerCase("en-US").includes(EXPECTED_FONT.toLocaleLowerCase("en-US"))) {
        unexpected.push(detail);
      }
    }
    return { checked, unexpected, hostControlled };
  }

  function zeroSizedVisibleRegions(root, getComputedStyleFunction) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    const results = [];
    const selector = "[data-oracle-view]:not([hidden]),[role=main]:not([hidden]),[role=dialog]:not([hidden]),canvas:not([hidden]),svg:not([hidden])";
    for (const element of Array.from(root.querySelectorAll(selector))) {
      if (!element || element.hidden) continue;
      if (typeof getComputedStyleFunction === "function") {
        try {
          const style = getComputedStyleFunction(element);
          if (style && (style.display === "none" || style.visibility === "hidden")) continue;
        } catch (error) { /* Geometry remains sufficient. */ }
      }
      const dimensions = rootDimensions(element);
      if (dimensions.width > 0 && dimensions.height > 0) continue;
      results.push(Object.freeze({
        tag: String(element.tagName || "").toLocaleLowerCase("en-US"),
        id: String(element.id || ""),
        className: typeof element.className === "string" ? element.className.slice(0, 160) : "",
        width: dimensions.width,
        height: dimensions.height,
      }));
    }
    return results;
  }

  function normalizeBuildInfo(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.freeze({
      id: String(source.id || "unknown"),
      version: String(source.version || "unknown"),
      generatedAt: String(source.generatedAt || "unknown"),
      digest: String(source.digest || "unknown"),
    });
  }

  function cleanHealthText(value, maximum = 240) {
    let text = "";
    try { text = String(value == null ? "" : value); } catch (error) { text = "[unavailable]"; }
    return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maximum);
  }

  function elementAssetReference(element) {
    if (!element || typeof element !== "object") return "";
    for (const name of ["src", "href"]) {
      let value = "";
      try {
        value = typeof element.getAttribute === "function"
          ? element.getAttribute(name)
          : element[name];
      } catch (error) { value = ""; }
      const reference = cleanHealthText(value, 320);
      if (reference) return reference;
    }
    return "";
  }

  function isPluginLocalAsset(reference) {
    const value = cleanHealthText(reference, 320)
      .replace(/[?#].*$/, "")
      .replace(/\\/g, "/")
      .toLocaleLowerCase("en-US");
    if (!value || /^(?:data|blob|https?):/.test(value)) return false;
    return /^(?:\.\.?\/)*(?:assets|dist|src)\//.test(value) || /^plugin:\//.test(value);
  }

  function assetFailureFromElement(element, documentReady) {
    const reference = elementAssetReference(element);
    if (!isPluginLocalAsset(reference)) return null;
    const tag = cleanHealthText(element && element.tagName, 24).toLocaleLowerCase("en-US");
    if (tag === "img" && element.complete === true && Number(element.naturalWidth) === 0) {
      return Object.freeze({ tag, reference, reason: "IMAGE_DECODE_OR_LOAD_FAILED", source: "dom-state" });
    }
    if (
      tag === "link" &&
      documentReady === "complete" &&
      cleanHealthText(element.rel, 80).toLocaleLowerCase("en-US").split(/\s+/).includes("stylesheet") &&
      "sheet" in element &&
      element.sheet === null
    ) {
      return Object.freeze({ tag, reference, reason: "STYLESHEET_LOAD_FAILED", source: "dom-state" });
    }
    if (["audio", "video"].includes(tag) && Number(element.networkState) === 3) {
      return Object.freeze({ tag, reference, reason: "MEDIA_SOURCE_UNAVAILABLE", source: "dom-state" });
    }
    return null;
  }

  function localAssetReport(scope, observedFailures, eventCaptureSupported = false) {
    const nodes = scope && typeof scope.querySelectorAll === "function"
      ? Array.from(scope.querySelectorAll("img[src],link[href],script[src],source[src],video[src],audio[src]"))
      : [];
    const ownerDocument = scope && scope.documentElement ? scope : scope && scope.ownerDocument;
    const documentReady = cleanHealthText(ownerDocument && ownerDocument.readyState, 24);
    const failures = new Map();
    let checked = 0;
    let stateObservable = 0;
    for (const element of nodes) {
      const reference = elementAssetReference(element);
      if (!isPluginLocalAsset(reference)) continue;
      checked += 1;
      const tag = cleanHealthText(element && element.tagName, 24).toLocaleLowerCase("en-US");
      if (
        tag === "img" ||
        (["audio", "video"].includes(tag) && "networkState" in element) ||
        (tag === "link" && "sheet" in element)
      ) stateObservable += 1;
      const failure = assetFailureFromElement(element, documentReady);
      if (failure) failures.set(`${failure.tag}|${failure.reference}`, failure);
    }
    for (const failure of observedFailures || []) {
      if (!failure) continue;
      failures.set(`${failure.tag}|${failure.reference}`, failure);
    }
    return Object.freeze({
      checked,
      stateObservable,
      eventCaptureSupported: eventCaptureSupported === true,
      cssBackgroundFailuresObservable: false,
      failures: Object.freeze(Array.from(failures.values())),
    });
  }

  function diagnosticsHealth(runtimeWindow) {
    const diagnostics = runtimeWindow && runtimeWindow.oracleDiagnostics;
    if (!diagnostics || typeof diagnostics.summary !== "function") {
      return Object.freeze({
        available: false,
        reason: "DIAGNOSTIC_BUFFER_UNAVAILABLE",
        errorCount: 0,
        unhandledErrorCount: 0,
        recentErrors: Object.freeze([]),
      });
    }
    let summary;
    try { summary = diagnostics.summary({ limit: 200 }); } catch (error) { summary = null; }
    if (!summary || typeof summary !== "object") {
      return Object.freeze({
        available: false,
        reason: "DIAGNOSTIC_SUMMARY_FAILED",
        errorCount: 0,
        unhandledErrorCount: 0,
        recentErrors: Object.freeze([]),
      });
    }
    const records = Array.isArray(summary.records) ? summary.records : [];
    const errors = records.filter((entry) => entry && entry.level === "error");
    const unhandled = records.filter((entry) => (
      entry && ["UNHANDLED_ERROR", "UNHANDLED_REJECTION"].includes(cleanHealthText(entry.code, 96))
    ));
    return Object.freeze({
      available: true,
      bounded: summary.bounded === true,
      capacity: Math.max(0, Number(summary.capacity) || 0),
      totalRetained: Math.max(0, Number(summary.totalRetained) || records.length),
      latestSequence: Math.max(0, Number(summary.latestSequence) || 0),
      errorCount: errors.length,
      unhandledErrorCount: unhandled.length,
      recentErrors: Object.freeze(errors.slice(-20).map((entry) => Object.freeze({
        sequence: Math.max(0, Number(entry.sequence) || 0),
        code: cleanHealthText(entry.code, 96),
      }))),
    });
  }

  function freezeHealthValue(value, depth = 0, seen = null) {
    if (value === null || value === undefined) return value === undefined ? null : value;
    if (["string", "number", "boolean"].includes(typeof value)) return value;
    if (typeof value !== "object" || depth >= 4) return "[unavailable]";
    const visited = seen || new Set();
    if (visited.has(value)) return "[circular]";
    visited.add(value);
    let output;
    if (Array.isArray(value)) {
      output = value.slice(0, 64).map((entry) => freezeHealthValue(entry, depth + 1, visited));
    } else {
      output = {};
      for (const key of Object.keys(value).sort().slice(0, 64)) {
        output[cleanHealthText(key, 96)] = freezeHealthValue(value[key], depth + 1, visited);
      }
    }
    visited.delete(value);
    return Object.freeze(output);
  }

  function createOracleUiRuntime(options = {}) {
    const records = new WeakMap();
    const mountedRecords = new Set();
    const runtimeWindow = options.window || globalScope || null;
    const runtimeDocument = options.document || (runtimeWindow && runtimeWindow.document) || null;
    const ResizeObserverConstructor = options.ResizeObserver ||
      (runtimeWindow && runtimeWindow.ResizeObserver) ||
      (typeof ResizeObserver === "function" ? ResizeObserver : null);
    const requestFrame = options.requestAnimationFrame ||
      (runtimeWindow && typeof runtimeWindow.requestAnimationFrame === "function"
        ? runtimeWindow.requestAnimationFrame.bind(runtimeWindow)
        : (callback) => setTimeout(callback, 0));
    const cancelFrame = options.cancelAnimationFrame ||
      (runtimeWindow && typeof runtimeWindow.cancelAnimationFrame === "function"
        ? runtimeWindow.cancelAnimationFrame.bind(runtimeWindow)
        : (handle) => clearTimeout(handle));
    const getComputedStyleFunction = options.getComputedStyle ||
      (runtimeWindow && typeof runtimeWindow.getComputedStyle === "function"
        ? runtimeWindow.getComputedStyle.bind(runtimeWindow)
        : null);
    const customElementsRegistry = options.customElements ||
      (runtimeWindow && runtimeWindow.customElements) || null;
    const runtimeConsole = options.console || (runtimeWindow && runtimeWindow.console) || null;
    const platformTelemetry = options.platformTelemetry || (runtimeWindow && runtimeWindow.oraclePlatformTelemetry) || null;
    const buildInfo = normalizeBuildInfo(options.buildInfo || (runtimeWindow && runtimeWindow.OracleBuildInfo));
    const observedAssetFailures = new Map();
    let healthContextProvider = typeof options.healthContextProvider === "function"
      ? options.healthContextProvider
      : null;
    let sequence = 0;

    function claimRuntimeResource(owner, type, key) {
      if (!platformTelemetry || typeof platformTelemetry.claimResource !== "function") return null;
      try { return platformTelemetry.claimResource(owner, type, key); } catch (error) { return null; }
    }

    function recordRuntimeDiagnostic(level, code, details) {
      const diagnostics = runtimeWindow && runtimeWindow.oracleDiagnostics;
      if (!diagnostics || typeof diagnostics.record !== "function") return null;
      try { return diagnostics.record(level, code, details); } catch (error) { return null; }
    }

    function globalErrorListener(event) {
      const target = event && event.target;
      const reference = elementAssetReference(target);
      if (isPluginLocalAsset(reference)) {
        const tag = cleanHealthText(target && target.tagName, 24).toLocaleLowerCase("en-US") || "asset";
        const failure = Object.freeze({
          tag,
          reference,
          reason: "RESOURCE_ERROR_EVENT",
          source: "global-error-capture",
        });
        observedAssetFailures.set(`${tag}|${reference}`, failure);
        recordRuntimeDiagnostic("error", "LOCAL_ASSET_LOAD_FAILED", { tag, reference });
        return;
      }
      recordRuntimeDiagnostic("error", "UNHANDLED_ERROR", {
        message: cleanHealthText(event && (event.message || event.error && event.error.message), 320) || "Unhandled UI error.",
      });
    }

    function unhandledRejectionListener(event) {
      const reason = event && event.reason;
      recordRuntimeDiagnostic("error", "UNHANDLED_REJECTION", {
        message: cleanHealthText(reason && reason.message || reason, 320) || "Unhandled UI promise rejection.",
      });
    }

    let capturesResourceAndUnhandledErrors = false;
    let capturesUnhandledRejections = false;
    if (
      options.captureGlobalErrors !== false &&
      runtimeWindow &&
      typeof runtimeWindow.addEventListener === "function"
    ) {
      try {
        runtimeWindow.addEventListener("error", globalErrorListener, true);
        capturesResourceAndUnhandledErrors = true;
        claimRuntimeResource("oracle-ui-runtime", "global-listener", "window:error:capture");
      } catch (error) { /* This UXP host does not expose a global error event. */ }
      try {
        runtimeWindow.addEventListener("unhandledrejection", unhandledRejectionListener);
        capturesUnhandledRejections = true;
        claimRuntimeResource("oracle-ui-runtime", "global-listener", "window:unhandledrejection");
      } catch (error) { /* This UXP host does not expose unhandled rejection events. */ }
    }

    function notify(record) {
      for (const listener of Array.from(record.listeners)) {
        try { listener(record.snapshot); } catch (error) { /* Subscriber failure must not stop measurement. */ }
      }
    }

    function measure(record, forceNotify = false) {
      if (!record || record.destroyed) return null;
      const dimensions = rootDimensions(record.root);
      const next = frozenSnapshot(record, dimensions, sequence + 1);
      const changed = snapshotChanged(record.snapshot, next);
      if (!changed && !forceNotify) return record.snapshot;
      sequence += 1;
      record.snapshot = frozenSnapshot(record, dimensions, sequence);
      writeViewportAttributes(record.root, record.snapshot);
      notify(record);
      return record.snapshot;
    }

    function schedule(record) {
      if (!record || record.destroyed || record.frame !== null) return;
      record.frame = requestFrame(() => {
        record.frame = null;
        measure(record);
        const proofReason = record.pendingProofReason;
        record.pendingProofReason = "";
        if (proofReason) logRenderProof(record, proofReason);
      });
    }

    function scheduleProof(record, reason = "settled") {
      if (!record || record.destroyed) return false;
      record.pendingProofReason = cleanHealthText(reason, 80) || "settled";
      schedule(record);
      return true;
    }

    function subscribeRecord(record, callback, optionsValue = {}) {
      if (typeof callback !== "function") return () => false;
      record.listeners.add(callback);
      if (optionsValue.immediate !== false && record.snapshot) callback(record.snapshot);
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        return record.listeners.delete(callback);
      };
    }

    function setRecordVisible(record, value) {
      if (!record || record.destroyed) return false;
      const next = value == null ? null : value === true;
      if (record.visibilityOverride === next) return false;
      record.visibilityOverride = next;
      measure(record, true);
      if (next === true) scheduleProof(record, "panel-visible-settled");
      return true;
    }

    function unmount(root) {
      const record = records.get(root);
      if (!record || record.destroyed) return false;
      record.destroyed = true;
      writeAttribute(record.root, "data-panel-visible", "false");
      writeAttribute(record.root, "data-oracle-panel-visible", "false");
      if (record.frame !== null) cancelFrame(record.frame);
      record.frame = null;
      record.pendingProofReason = "";
      if (record.resizeObserver && typeof record.resizeObserver.disconnect === "function") {
        record.resizeObserver.disconnect();
      }
      if (record.windowResizeListener && runtimeWindow && typeof runtimeWindow.removeEventListener === "function") {
        runtimeWindow.removeEventListener("resize", record.windowResizeListener);
      }
      for (const claim of record.resourceClaims.splice(0)) {
        try { if (claim && typeof claim.release === "function") claim.release(); } catch (error) { /* Ownership diagnostics never block teardown. */ }
      }
      record.listeners.clear();
      mountedRecords.delete(record);
      records.delete(root);
      return true;
    }

    function auditRecord(record) {
      if (!record || record.destroyed) return null;
      const root = record.root;
      const fontAudit = visibleTextElements(root, getComputedStyleFunction);
      const controls = visibleControlInventory(root, getComputedStyleFunction, customElementsRegistry);
      const controlTechnologyCounts = {};
      for (const control of controls) {
        controlTechnologyCounts[control.technology] = (controlTechnologyCounts[control.technology] || 0) + 1;
      }
      const ownerDocument = (root && root.ownerDocument) || runtimeDocument;
      const documentElement = ownerDocument && ownerDocument.documentElement;
      const fontSet = ownerDocument && ownerDocument.fonts;
      const theme = String(
        documentElement && documentElement.dataset &&
        (documentElement.dataset.theme || documentElement.dataset.themePreference) || "unknown",
      );
      return Object.freeze({
        panelId: record.panelId,
        root: Object.freeze({
          width: record.snapshot ? record.snapshot.width : 0,
          height: record.snapshot ? record.snapshot.height : 0,
          widthClass: record.snapshot ? record.snapshot.widthClass : "micro",
          heightClass: record.snapshot ? record.snapshot.heightClass : "short",
          visible: Boolean(record.snapshot && record.snapshot.visible),
        }),
        theme,
        currentRoute: inferCurrentRoute(root),
        fonts: Object.freeze({
          status: String(fontSet && fontSet.status || "unsupported"),
          checked: fontAudit.checked,
          expectedFamily: EXPECTED_FONT,
          unexpected: Object.freeze(fontAudit.unexpected.slice()),
          hostControlled: Object.freeze(fontAudit.hostControlled.slice()),
        }),
        controls: Object.freeze({
          visibleCount: controls.length,
          technologyCounts: Object.freeze({ ...controlTechnologyCounts }),
          inventory: Object.freeze(controls.slice()),
        }),
        duplicateIds: Object.freeze(duplicateIdReport(root)),
        zeroSizedVisibleRegions: Object.freeze(zeroSizedVisibleRegions(root, getComputedStyleFunction)),
        subscriberCount: record.listeners.size,
        resizeSchedulerActive: record.frame !== null,
        renderProofPending: Boolean(record.pendingProofReason),
      });
    }

    function logRenderProof(record, reason = "manual") {
      if (!record || record.destroyed) return null;
      const report = auditRecord(record);
      const proof = Object.freeze({
        buildId: buildInfo.id,
        version: buildInfo.version,
        panelId: report.panelId,
        reason: cleanHealthText(reason, 80) || "manual",
        root: report.root,
        currentRoute: report.currentRoute,
        theme: report.theme,
        fonts: report.fonts,
        controls: report.controls,
        duplicateIds: report.duplicateIds,
        zeroSizedVisibleRegions: report.zeroSizedVisibleRegions,
      });
      if (runtimeConsole && typeof runtimeConsole.log === "function") {
        try {
          runtimeConsole.log("[Blocky Studios][PLATFORM_RENDER]", JSON.stringify(proof));
        } catch (error) { /* Proof logging must never block the panel. */ }
      }
      recordRuntimeDiagnostic("info", "PLATFORM_RENDER_PROOF", {
        panelId: report.panelId,
        reason: proof.reason,
        visibleControlCount: report.controls.visibleCount,
        standardHtmlCount: report.controls.technologyCounts["standard-html"] || 0,
        spectrumUxpCount: report.controls.technologyCounts["spectrum-uxp-widget"] || 0,
        swcCount: report.controls.technologyCounts["spectrum-web-component"] || 0,
        unexpectedFontCount: report.fonts.unexpected.length,
        hostControlledFontCount: report.fonts.hostControlled.length,
      });
      return proof;
    }

    function mount(root, mountOptions = {}) {
      if (!root || (typeof root !== "object" && typeof root !== "function")) {
        throw new TypeError("Oracle UI runtime requires a panel root object.");
      }
      const existing = records.get(root);
      if (existing && !existing.destroyed) {
        if (mountOptions.panelId) existing.panelId = String(mountOptions.panelId);
        if (Object.prototype.hasOwnProperty.call(mountOptions, "visible")) {
          existing.visibilityOverride = mountOptions.visible === true;
        }
        measure(existing);
        return existing.handle;
      }

      const record = {
        root,
        panelId: String(mountOptions.panelId || (root.dataset && root.dataset.oraclePanelRoot) || "unknown"),
        listeners: new Set(),
        snapshot: null,
        frame: null,
        pendingProofReason: "",
        proofLogged: false,
        resizeObserver: null,
        windowResizeListener: null,
        resourceClaims: [],
        destroyed: false,
        visibilityOverride: Object.prototype.hasOwnProperty.call(mountOptions, "visible")
          ? mountOptions.visible === true
          : null,
        handle: null,
      };
      record.handle = Object.freeze({
        snapshot: () => record.snapshot,
        subscribe: (callback, subscriptionOptions = {}) => subscribeRecord(record, callback, subscriptionOptions),
        setVisible: (value) => setRecordVisible(record, value),
        audit: () => auditRecord(record),
        captureAfterLayout: (reason = "settled") => scheduleProof(record, reason),
        destroy: () => unmount(root),
      });
      records.set(root, record);
      mountedRecords.add(record);
      measure(record, true);
      if (runtimeConsole && typeof runtimeConsole.log === "function") {
        try {
          runtimeConsole.log("[Blocky Studios][UI_BUILD]", Object.freeze({
            buildId: buildInfo.id,
            version: buildInfo.version,
            panelId: record.panelId,
          }));
        } catch (error) { /* Build identity logging must never block panel mount. */ }
      }

      if (typeof ResizeObserverConstructor === "function") {
        record.resizeObserver = new ResizeObserverConstructor(() => schedule(record));
        record.resizeObserver.observe(root);
        const claim = claimRuntimeResource(`oracle-ui-runtime:${record.panelId}`, "resize-observer", record.panelId);
        if (claim) record.resourceClaims.push(claim);
      } else if (runtimeWindow && typeof runtimeWindow.addEventListener === "function") {
        record.windowResizeListener = () => schedule(record);
        runtimeWindow.addEventListener("resize", record.windowResizeListener);
        const claim = claimRuntimeResource(`oracle-ui-runtime:${record.panelId}`, "fallback-resize-listener", record.panelId);
        if (claim) record.resourceClaims.push(claim);
      }
      record.proofLogged = true;
      logRenderProof(record, "initial-mount");
      return record.handle;
    }

    function subscribe(root, callback, subscriptionOptions = {}) {
      const handle = mount(root, subscriptionOptions);
      return handle.subscribe(callback, subscriptionOptions);
    }

    function setHealthContextProvider(provider) {
      if (provider !== null && typeof provider !== "function") {
        throw new TypeError("Oracle UI health context provider must be a function or null.");
      }
      healthContextProvider = provider;
      return true;
    }

    function readHealthContext() {
      if (!healthContextProvider) return Object.freeze({ available: false, reason: "HOST_CONTEXT_UNAVAILABLE" });
      try {
        return freezeHealthValue(healthContextProvider()) || Object.freeze({ available: false, reason: "HOST_CONTEXT_EMPTY" });
      } catch (error) {
        recordRuntimeDiagnostic("error", "UI_HEALTH_CONTEXT_FAILED", {
          message: cleanHealthText(error && error.message || error, 320),
        });
        return Object.freeze({ available: false, reason: "HOST_CONTEXT_FAILED" });
      }
    }

    function inferCurrentRoute(scope) {
      if (!scope || typeof scope.querySelector !== "function") return "";
      let selected = null;
      try { selected = scope.querySelector('[data-oracle-route][aria-current="page"]'); } catch (error) { selected = null; }
      if (selected && selected.dataset && selected.dataset.oracleRoute) {
        return cleanHealthText(selected.dataset.oracleRoute, 80);
      }
      let visible = null;
      try { visible = scope.querySelector("[data-oracle-view]:not([hidden])"); } catch (error) { visible = null; }
      return cleanHealthText(visible && visible.dataset && visible.dataset.oracleView, 80);
    }

    function audit(auditOptions = {}) {
      const requestedRoot = auditOptions && auditOptions.root;
      const selected = requestedRoot ? records.get(requestedRoot) : null;
      const reports = requestedRoot
        ? [auditRecord(selected)].filter(Boolean)
        : Array.from(mountedRecords, auditRecord).filter(Boolean);
      const hostContext = readHealthContext();
      const panelInstanceCounts = {};
      let subscriberCount = 0;
      let resizeObserverCount = 0;
      let fallbackResizeListenerCount = 0;
      let activeResizeSchedulerCount = 0;
      for (const record of mountedRecords) {
        const panelId = cleanHealthText(record.panelId, 96) || "unknown";
        panelInstanceCounts[panelId] = (panelInstanceCounts[panelId] || 0) + 1;
        subscriberCount += record.listeners.size;
        if (record.resizeObserver) resizeObserverCount += 1;
        if (record.windowResizeListener) fallbackResizeListenerCount += 1;
        if (record.frame !== null) activeResizeSchedulerCount += 1;
      }
      const repeatedPanelIds = Object.keys(panelInstanceCounts)
        .filter((panelId) => panelInstanceCounts[panelId] > 1)
        .map((panelId) => Object.freeze({ panelId, instanceCount: panelInstanceCounts[panelId] }));
      const routeScope = requestedRoot || runtimeDocument;
      const currentRoute = cleanHealthText(
        reports.find((report) => report.root.visible && report.currentRoute)?.currentRoute ||
        hostContext && hostContext.currentRoute,
        80,
      ) || inferCurrentRoute(routeScope);
      const fallbackNativeDiagnostic = runtimeWindow && runtimeWindow.oracleNativeDragDiagnostics;
      const nativeAddon = hostContext && hostContext.nativeAddon && typeof hostContext.nativeAddon === "object"
        ? hostContext.nativeAddon
        : Object.freeze({
            available: Boolean(runtimeWindow && runtimeWindow.oracleNativeDragAddon),
            status: runtimeWindow && runtimeWindow.oracleNativeDragAddon
              ? "ready"
              : fallbackNativeDiagnostic
                ? "unavailable"
                : "loading-or-unobserved",
            errorCode: cleanHealthText(fallbackNativeDiagnostic && fallbackNativeDiagnostic.errorCode, 96),
          });
      const graphAnimation = hostContext && hostContext.graphAnimation && typeof hostContext.graphAnimation === "object"
        ? hostContext.graphAnimation
        : Object.freeze({
            available: false,
            reason: "GRAPH_SCHEDULER_CONTEXT_UNAVAILABLE",
          });
      const renderCount = hostContext && hostContext.renderCount && typeof hostContext.renderCount === "object"
        ? hostContext.renderCount
        : Object.freeze({
            available: false,
            reason: "RENDER_COUNT_NOT_INSTRUMENTED",
          });
      return Object.freeze({
        available: true,
        developmentOnly: true,
        build: buildInfo,
        mountedRootCount: mountedRecords.size,
        activePanelId: reports.find((report) => report.root.visible)?.panelId || reports[0]?.panelId || "none",
        currentRoute,
        nativeAddon,
        localAssets: localAssetReport(
          runtimeDocument || routeScope,
          Array.from(observedAssetFailures.values()),
          capturesResourceAndUnhandledErrors,
        ),
        diagnostics: diagnosticsHealth(runtimeWindow),
        globalErrorCapture: Object.freeze({
          errorEvents: capturesResourceAndUnhandledErrors,
          unhandledRejections: capturesUnhandledRejections,
        }),
        runtimeOwnership: Object.freeze({
          scope: "oracle-ui-runtime-owned-resources",
          subscriberCount,
          resizeObserverCount,
          fallbackResizeListenerCount,
          activeResizeSchedulerCount,
          multipleActiveResizeSchedulers: activeResizeSchedulerCount > 1,
          panelInstanceCounts: Object.freeze({ ...panelInstanceCounts }),
          repeatedPanelIds: Object.freeze(repeatedPanelIds),
          globalListenerCensusAvailable: false,
        }),
        graphAnimation,
        renderCount,
        hostContext,
        panels: Object.freeze(reports),
      });
    }

    return Object.freeze({
      mount,
      unmount,
      setVisible(root, value) {
        return setRecordVisible(records.get(root), value);
      },
      subscribe,
      observe: subscribe,
      snapshot(root) {
        const record = records.get(root);
        return record ? record.snapshot : null;
      },
      capture(root, reason = "manual") {
        const record = records.get(root);
        return record ? logRenderProof(record, reason) : null;
      },
      captureAfterLayout(root, reason = "settled") {
        return scheduleProof(records.get(root), reason);
      },
      audit,
      setHealthContextProvider,
      classifyWidth,
      classifyHeight,
      widthClasses: WIDTH_CLASSES,
      heightClasses: HEIGHT_CLASSES,
      responsiveBreakpoints: RESPONSIVE_BREAKPOINTS,
      buildInfo,
    });
  }

  return Object.freeze({
    createOracleUiRuntime,
    classifyWidth,
    classifyHeight,
    widthClasses: WIDTH_CLASSES,
    heightClasses: HEIGHT_CLASSES,
    responsiveBreakpoints: RESPONSIVE_BREAKPOINTS,
  });
});
