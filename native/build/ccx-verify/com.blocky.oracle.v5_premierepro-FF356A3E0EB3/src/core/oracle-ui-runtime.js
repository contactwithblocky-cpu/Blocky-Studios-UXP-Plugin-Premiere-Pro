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

  function visibleTextElements(root, getComputedStyleFunction) {
    if (!root || typeof root.querySelectorAll !== "function" || typeof getComputedStyleFunction !== "function") {
      return { checked: 0, unexpected: [] };
    }
    const unexpected = [];
    let checked = 0;
    const selector = "button,input,select,textarea,option,output,label,h1,h2,h3,h4,p,span,small,strong,[role=button],[role=tab],[role=tooltip]";
    for (const element of Array.from(root.querySelectorAll(selector))) {
      if (!element || element.hidden || element.getAttribute && element.getAttribute("aria-hidden") === "true") continue;
      let style;
      try { style = getComputedStyleFunction(element); } catch (error) { continue; }
      if (!style || style.display === "none" || style.visibility === "hidden") continue;
      checked += 1;
      const family = String(style.fontFamily || "").trim();
      if (family && !family.toLocaleLowerCase("en-US").includes(EXPECTED_FONT.toLocaleLowerCase("en-US"))) {
        unexpected.push(Object.freeze({
          tag: String(element.tagName || "").toLocaleLowerCase("en-US"),
          id: String(element.id || ""),
          className: typeof element.className === "string" ? element.className.slice(0, 160) : "",
          text: String(element.textContent || element.value || "").trim().slice(0, 80),
          fontFamily: family.slice(0, 160),
        }));
      }
    }
    return { checked, unexpected };
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
    const runtimeConsole = options.console || (runtimeWindow && runtimeWindow.console) || null;
    const buildInfo = normalizeBuildInfo(options.buildInfo || (runtimeWindow && runtimeWindow.OracleBuildInfo));
    let sequence = 0;

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
      });
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
      if (record.resizeObserver && typeof record.resizeObserver.disconnect === "function") {
        record.resizeObserver.disconnect();
      }
      if (record.windowResizeListener && runtimeWindow && typeof runtimeWindow.removeEventListener === "function") {
        runtimeWindow.removeEventListener("resize", record.windowResizeListener);
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
        fonts: Object.freeze({
          status: String(fontSet && fontSet.status || "unsupported"),
          checked: fontAudit.checked,
          expectedFamily: EXPECTED_FONT,
          unexpected: Object.freeze(fontAudit.unexpected.slice()),
        }),
        duplicateIds: Object.freeze(duplicateIdReport(root)),
        zeroSizedVisibleRegions: Object.freeze(zeroSizedVisibleRegions(root, getComputedStyleFunction)),
        subscriberCount: record.listeners.size,
        resizeSchedulerActive: record.frame !== null,
      });
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
        resizeObserver: null,
        windowResizeListener: null,
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
      } else if (runtimeWindow && typeof runtimeWindow.addEventListener === "function") {
        record.windowResizeListener = () => schedule(record);
        runtimeWindow.addEventListener("resize", record.windowResizeListener);
      }
      return record.handle;
    }

    function subscribe(root, callback, subscriptionOptions = {}) {
      const handle = mount(root, subscriptionOptions);
      return handle.subscribe(callback, subscriptionOptions);
    }

    function audit(auditOptions = {}) {
      const requestedRoot = auditOptions && auditOptions.root;
      const selected = requestedRoot ? records.get(requestedRoot) : null;
      const reports = requestedRoot
        ? [auditRecord(selected)].filter(Boolean)
        : Array.from(mountedRecords, auditRecord).filter(Boolean);
      return Object.freeze({
        available: true,
        developmentOnly: true,
        build: buildInfo,
        mountedRootCount: mountedRecords.size,
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
      audit,
      classifyWidth,
      classifyHeight,
      widthClasses: WIDTH_CLASSES,
      heightClasses: HEIGHT_CLASSES,
      buildInfo,
    });
  }

  return Object.freeze({
    createOracleUiRuntime,
    classifyWidth,
    classifyHeight,
    widthClasses: WIDTH_CLASSES,
    heightClasses: HEIGHT_CLASSES,
  });
});
