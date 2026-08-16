"use strict";

(function exposeOracleCurvesWorkspace(globalScope, factory) {
  const api = factory(
    typeof module === "object" && module && module.exports
      ? require("./oracle-curve-math.js")
      : globalScope && Reflect.get(globalScope, "OracleCurveMath"),
    typeof module === "object" && module && module.exports
      ? require("./oracle-curve-presets.js")
      : globalScope && Reflect.get(globalScope, "OracleCurvePresets"),
  );
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleCurvesWorkspace", api);
})(typeof window !== "undefined" ? window : null, function createOracleCurvesWorkspaceApi(defaultCurveMath, defaultPresetApi) {
  const WORKSPACE_STATES = Object.freeze(["loading", "empty", "error", "unsupported", "ready"]);
  const DEFAULT_CONTROL_POINTS = Object.freeze([0.25, 0.1, 0.25, 1]);
  const DEFAULT_PREFERENCES = Object.freeze({
    gridVisible: true,
    subdivisions: 4,
    snapping: true,
    handleSize: 12,
    sampleBudget: 48,
    warningThreshold: 120,
    defaultMode: "native",
    gridColor: "#3C3C3C",
    curveColor: "#E548C7",
  });
  const DEFAULT_VIEWPORT = Object.freeze({ zoom: 1, panX: 0, panY: 0 });
  const ALL_VALUE = "*";
  const MAX_CONTROL_Y = 8;
  const MIN_CONTROL_Y = -8;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const PRESET_ACTIONS = Object.freeze([
    "create", "saveAs", "overwrite", "rename", "duplicate", "delete",
    "moveUp", "moveDown", "favorite", "metadata", "folderCreate",
    "folderRename", "folderDelete", "import", "export",
  ]);

  function cleanText(value, maximum = 1024) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maximum);
  }

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function clampInteger(value, minimum, maximum, fallback) {
    return Math.round(clamp(finiteNumber(value, fallback), minimum, maximum));
  }

  function normalizeHexColor(value, fallback) {
    const text = String(value || "").trim();
    const prefixed = text.startsWith("#") ? text : `#${text}`;
    if (/^#[0-9a-f]{6}$/i.test(prefixed)) return prefixed.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(prefixed)) {
      return `#${prefixed[1]}${prefixed[1]}${prefixed[2]}${prefixed[2]}${prefixed[3]}${prefixed[3]}`.toUpperCase();
    }
    return fallback;
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeControlPoints(value, curveMath = defaultCurveMath) {
    try {
      const raw = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? [value.x1, value.y1, value.x2, value.y2]
          : DEFAULT_CONTROL_POINTS;
      if (raw.length !== 4 || raw.some((entry) => !Number.isFinite(Number(entry)))) {
        throw new TypeError("Invalid curve control points.");
      }
      const bounded = [
        clamp(Number(raw[0]), 0, 1),
        clamp(Number(raw[1]), MIN_CONTROL_Y, MAX_CONTROL_Y),
        clamp(Number(raw[2]), 0, 1),
        clamp(Number(raw[3]), MIN_CONTROL_Y, MAX_CONTROL_Y),
      ];
      const points = curveMath && typeof curveMath.normalizeControlPoints === "function"
        ? curveMath.normalizeControlPoints(bounded)
        : bounded;
      if (!Array.isArray(points) || points.length !== 4 || points.some((entry) => !Number.isFinite(entry))) {
        throw new TypeError("Invalid curve control points.");
      }
      return [
        clamp(points[0], 0, 1),
        clamp(points[1], MIN_CONTROL_Y, MAX_CONTROL_Y),
        clamp(points[2], 0, 1),
        clamp(points[3], MIN_CONTROL_Y, MAX_CONTROL_Y),
      ];
    } catch (error) {
      return DEFAULT_CONTROL_POINTS.slice();
    }
  }

  function normalizePreferences(value = {}) {
    const source = value && value.curves && typeof value.curves === "object" ? value.curves : value;
    return {
      gridVisible: source && source.gridVisible !== false,
      subdivisions: clampInteger(source && source.subdivisions, 2, 12, DEFAULT_PREFERENCES.subdivisions),
      snapping: source && source.snapping !== false,
      handleSize: clampInteger(source && source.handleSize, 8, 24, DEFAULT_PREFERENCES.handleSize),
      sampleBudget: clampInteger(source && source.sampleBudget, 8, 240, DEFAULT_PREFERENCES.sampleBudget),
      warningThreshold: clampInteger(source && source.warningThreshold, 16, 1000, DEFAULT_PREFERENCES.warningThreshold),
      defaultMode: source && source.defaultMode === "baked" ? "baked" : "native",
      gridColor: normalizeHexColor(source && source.gridColor, DEFAULT_PREFERENCES.gridColor),
      curveColor: normalizeHexColor(source && source.curveColor, DEFAULT_PREFERENCES.curveColor),
    };
  }

  function capabilitySupported(value) {
    if (value === true) return true;
    return Boolean(value && typeof value === "object" && value.supported === true);
  }

  function capabilityMessage(value, fallback = "") {
    if (typeof value === "string") return cleanText(value, 1024);
    return cleanText(value && (value.message || value.reason || value.code), 1024) || fallback;
  }

  function explicitBakedProof(capabilities, adapter) {
    let proof = capabilities && (capabilities.bakedProof || capabilities.bakedCurveProof);
    if (!proof && adapter && typeof adapter.getBakedProof === "function") {
      try { proof = adapter.getBakedProof(); } catch (error) { proof = null; }
    }
    const explicitWorkspaceProof = Boolean(
      proof && proof.enabled === true && proof.verified === true &&
      proof.readbackVerified === true && proof.oneUndoStep === true && proof.ownershipSafe === true
    );
    const validatedAdapterProof = Boolean(
      proof && proof.verified === true && proof.oneUndoStep === true &&
      proof.detachedKeyframes === true && proof.generatedKeyActions === true &&
      proof.defaultLinearReadback === true && proof.exactEndpointReadback === true &&
      proof.oneTransaction === true && proof.undoRemovedGeneratedKeys === true &&
      Array.isArray(proof.valueKinds) && proof.valueKinds.includes("number")
    );
    const verified = explicitWorkspaceProof || validatedAdapterProof;
    return {
      verified,
      proof: verified ? proof : null,
      reason: verified
        ? ""
        : capabilityMessage(
          capabilities && capabilities.bakedCurve,
          "Baked Oracle curves stay disabled until generated-key actions, exact readback, one-step Undo, and Oracle key ownership are physically proven in this Premiere runtime.",
        ),
    };
  }

  function endpointFrom(value) {
    if (!value || typeof value !== "object") return null;
    const ticks = cleanText(value.ticks != null ? value.ticks : value.tick, 256);
    const seconds = Number(value.timeSeconds != null ? value.timeSeconds : value.seconds);
    return {
      ticks,
      seconds: Number.isFinite(seconds) ? seconds : null,
      value: Object.prototype.hasOwnProperty.call(value, "value") ? clone(value.value) : null,
      interpolation: value.interpolation != null ? value.interpolation : value.interpolationMode,
    };
  }

  function stableBindingKey(binding, index) {
    return cleanText(binding && (binding.bindingId || binding.id), 8192) || `binding-${index}`;
  }

  function reasonSupported(reasonValue) {
    if (reasonValue === false) return false;
    if (!reasonValue || typeof reasonValue !== "object") return true;
    return reasonValue.supported !== false;
  }

  function normalizeBinding(binding, index) {
    const display = binding && binding.display && typeof binding.display === "object" ? binding.display : {};
    const endpoints = binding && binding.endpoints && typeof binding.endpoints === "object" ? binding.endpoints : {};
    const capabilities = binding && binding.capabilities && typeof binding.capabilities === "object"
      ? binding.capabilities
      : {};
    const nativeCapability = capabilities.nativeInterpolation;
    const bakedCapability = capabilities.bakedCurve;
    const start = endpointFrom(binding && (binding.start || endpoints.start));
    const end = endpointFrom(binding && (binding.end || endpoints.end));
    const supportedInterpolations = Array.isArray(binding && binding.supportedInterpolations)
      ? binding.supportedInterpolations.map((entry) => cleanText(entry, 64).toUpperCase()).filter(Boolean)
      : [];
    const nativeCompatible = Boolean(
      binding && binding.compatible !== false &&
      reasonSupported(nativeCapability) &&
      start && end && start.ticks && end.ticks && start.ticks !== end.ticks
    );
    const bakedCompatible = Boolean(
      binding && cleanText(binding.valueType || display.valueKind, 128).toLowerCase() === "number" &&
      capabilitySupported(bakedCapability) && start && end && start.ticks && end.ticks && start.ticks !== end.ticks
    );
    const reason = nativeCompatible
      ? ""
      : capabilityMessage(
        binding && binding.reason || nativeCapability,
        !start || !end ? "No bracketing keyframe segment exists at the current playhead." : "This property cannot use supported native interpolation.",
      );
    const clipId = cleanText(binding && binding.clipId, 4096) || cleanText(binding && binding.identity && binding.identity.track && JSON.stringify(binding.identity.track), 4096) || `clip-${index}`;
    const componentId = cleanText(binding && binding.componentId, 4096) || cleanText(binding && binding.identity && binding.identity.component && JSON.stringify(binding.identity.component), 4096) || `component-${index}`;
    const propertyId = cleanText(binding && binding.propertyId, 4096) || cleanText(binding && binding.identity && binding.identity.parameter && JSON.stringify(binding.identity.parameter), 4096) || `property-${index}`;
    return {
      source: binding,
      id: stableBindingKey(binding, index),
      revision: cleanText(binding && binding.revision, 16384),
      clipId,
      clipName: cleanText(binding && (binding.clipName || display.clip || display.name), 512) || "Timeline clip",
      componentId,
      componentName: cleanText(binding && (binding.componentName || display.component), 512) || "Component",
      propertyId,
      propertyName: cleanText(binding && (binding.propertyName || display.property), 512) || "Property",
      valueType: cleanText(binding && (binding.valueType || display.valueKind), 128) || "unknown",
      start,
      end,
      interpolation: binding && binding.interpolation != null
        ? binding.interpolation
        : start && start.interpolation,
      supportedInterpolations,
      compatible: nativeCompatible,
      nativeCompatible,
      bakedCompatible,
      bakedReason: bakedCompatible ? "" : capabilityMessage(bakedCapability, "This property is not proven safe for baked numeric interpolation."),
      reason,
      keyTicks: Array.isArray(binding && binding.keyTicks) ? binding.keyTicks.map((entry) => cleanText(entry, 256)).filter(Boolean) : [],
      ticksPerFrame: cleanText(binding && binding.ticksPerFrame, 256),
      controlPoints: normalizeControlPoints(binding && (binding.controlPoints || binding.cubicControlPoints)),
    };
  }

  function normalizeWorkspaceState(value) {
    const state = cleanText(value, 32).toLowerCase();
    return WORKSPACE_STATES.includes(state) ? state : "loading";
  }

  function normalizeSnapshot(input = {}, adapter = null) {
    const sourceBindings = Array.isArray(input.selectedBindings)
      ? input.selectedBindings
      : Array.isArray(input.bindings) ? input.bindings : [];
    const bindings = sourceBindings.map(normalizeBinding);
    let state = normalizeWorkspaceState(input.state || input.phase);
    const error = input.error && typeof input.error === "object"
      ? { code: cleanText(input.error.code || input.error.name, 128) || "CURVES_ERROR", message: capabilityMessage(input.error, "Curves could not inspect Premiere.") }
      : null;
    if (error) state = "error";
    else if (!input.state && !input.phase) {
      if (bindings.length === 0) state = "empty";
      else if (!bindings.some((entry) => entry.compatible)) state = "unsupported";
      else state = "ready";
    }
    const capabilities = input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {};
    const baked = explicitBakedProof({ ...capabilities, bakedProof: input.bakedProof || capabilities.bakedProof }, adapter);
    const nativeSupported = capabilitySupported(capabilities.nativeInterpolation) || bindings.some((entry) => entry.compatible);
    const anySupportedMode = bindings.some((entry) => entry.nativeCompatible || (baked.verified && entry.bakedCompatible));
    if (state === "ready" && !anySupportedMode) state = bindings.length ? "unsupported" : "empty";
    else if (state === "unsupported" && anySupportedMode) state = "ready";
    const message = cleanText(input.message || input.status && input.status.message, 1024) || ({
      loading: "Inspecting selected timeline clips and bracketing keyframes…",
      empty: "Select one or more timeline clips with an animated property, then place the playhead between two keyframes.",
      error: error && error.message || "Curves could not inspect Premiere.",
      unsupported: bindings[0] && bindings[0].reason || "The selected properties do not expose a supported keyframe segment.",
      ready: `${bindings.filter((entry) => entry.nativeCompatible || (baked.verified && entry.bakedCompatible)).length} compatible curve target${bindings.filter((entry) => entry.nativeCompatible || (baked.verified && entry.bakedCompatible)).length === 1 ? "" : "s"} ready.`,
    }[state]);
    const nativeModes = capabilities.nativeModes && typeof capabilities.nativeModes === "object"
      ? Object.values(capabilities.nativeModes)
        .filter((entry) => capabilitySupported(entry))
        .map((entry) => cleanText(entry.name, 64).toUpperCase())
      : [];
    return {
      source: input,
      revision: input.revision == null ? "" : String(input.revision),
      state,
      message,
      error,
      bindings,
      capabilities: {
        nativeSupported,
        nativeModes,
        bakedVerified: baked.verified,
        bakedProof: baked.proof,
        bakedReason: baked.reason,
      },
    };
  }

  function uniqueOptions(bindings, valueKey, labelKey) {
    const seen = new Set();
    const result = [];
    for (const binding of bindings) {
      const value = binding[valueKey];
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push({ value, label: binding[labelKey] || value });
    }
    return result;
  }

  function setDisabled(element, disabled, reason = "") {
    if (!element) return;
    element.disabled = Boolean(disabled);
    if (typeof element.setAttribute === "function") {
      element.setAttribute("aria-disabled", disabled ? "true" : "false");
      if (reason) element.setAttribute("data-disabled-reason", reason);
      else if (typeof element.removeAttribute === "function") element.removeAttribute("data-disabled-reason");
    }
    element.title = reason;
  }

  function setPressed(element, pressed) {
    if (!element) return;
    if (typeof element.setAttribute === "function") element.setAttribute("aria-pressed", pressed ? "true" : "false");
    if (element.classList && typeof element.classList.toggle === "function") element.classList.toggle("is-active", Boolean(pressed));
  }

  function formatValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(Math.round(value * 10000) / 10000);
    if (value && typeof value === "object" && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) {
      return `(${Math.round(Number(value.x) * 10000) / 10000}, ${Math.round(Number(value.y) * 10000) / 10000})`;
    }
    return cleanText(value == null ? "—" : JSON.stringify(value), 160) || "—";
  }

  function formatEndpoint(endpoint) {
    if (!endpoint) return "—";
    const time = endpoint.seconds === null ? `${endpoint.ticks} ticks` : `${endpoint.seconds.toFixed(3)} s`;
    return `${time} · ${formatValue(endpoint.value)}`;
  }

  function formatInterpolation(value) {
    if (value == null || value === "") return "Unknown";
    if (typeof value === "number") return `Premiere enum ${value}`;
    return cleanText(value, 80) || "Unknown";
  }

  function normalizeElements(elements = {}) {
    const aliases = (name, ...extra) => {
      for (const key of [name, ...extra]) if (elements[key]) return elements[key];
      return null;
    };
    return {
      root: aliases("root", "curvesWorkspace"),
      state: aliases("state", "curvesWorkspaceState"),
      stateTitle: aliases("stateTitle", "curvesStateTitle"),
      stateMessage: aliases("stateMessage", "curvesStateMessage"),
      content: aliases("content", "curvesWorkspaceContent"),
      refresh: aliases("refresh", "curvesRefresh"),
      clipSelect: aliases("clipSelect", "curvesClipSelect"),
      componentSelect: aliases("componentSelect", "curvesComponentSelect"),
      propertySelect: aliases("propertySelect", "curvesPropertySelect"),
      clipSummary: aliases("clipSummary", "curvesClipSummary"),
      componentSummary: aliases("componentSummary", "curvesComponentSummary"),
      propertySummary: aliases("propertySummary", "curvesPropertySummary"),
      endpointsSummary: aliases("endpointsSummary", "curvesEndpointsSummary"),
      interpolationSummary: aliases("interpolationSummary", "curvesInterpolationSummary"),
      compatibilitySummary: aliases("compatibilitySummary", "curvesCompatibilitySummary"),
      modeNative: aliases("modeNative", "curvesModeNative"),
      modeBaked: aliases("modeBaked", "curvesModeBaked"),
      bakedReason: aliases("bakedReason", "curvesBakedReason"),
      nativeInterpolation: aliases("nativeInterpolation", "curvesNativeInterpolation"),
      graph: aliases("graph", "curvesGraph"),
      grid: aliases("grid", "curvesGraphGrid"),
      overlayGroup: aliases("overlayGroup", "curvesOverlayGroup"),
      path: aliases("path", "curvesGraphPath"),
      handleOne: aliases("handleOne", "curvesHandleOne"),
      handleTwo: aliases("handleTwo", "curvesHandleTwo"),
      handleOneLine: aliases("handleOneLine", "curvesHandleOneLine"),
      handleTwoLine: aliases("handleTwoLine", "curvesHandleTwoLine"),
      pointOneX: aliases("pointOneX", "curvesPointOneX"),
      pointOneY: aliases("pointOneY", "curvesPointOneY"),
      pointTwoX: aliases("pointTwoX", "curvesPointTwoX"),
      pointTwoY: aliases("pointTwoY", "curvesPointTwoY"),
      zoomIn: aliases("zoomIn", "curvesZoomIn"),
      zoomOut: aliases("zoomOut", "curvesZoomOut"),
      fit: aliases("fit", "curvesFit"),
      reset: aliases("reset", "curvesReset"),
      mirror: aliases("mirror", "curvesMirror"),
      reverse: aliases("reverse", "curvesReverse"),
      copy: aliases("copy", "curvesCopy"),
      paste: aliases("paste", "curvesPaste"),
      apply: aliases("apply", "curvesApply"),
      status: aliases("status", "curvesStatus"),
      samplePreview: aliases("samplePreview", "curvesSamplePreview"),
      presetBuiltInTab: aliases("presetBuiltInTab", "curvesPresetBuiltInTab"),
      presetUserTab: aliases("presetUserTab", "curvesPresetUserTab"),
      presetSearch: aliases("presetSearch", "curvesPresetSearch"),
      presetFolder: aliases("presetFolder", "curvesPresetFolder"),
      presetTags: aliases("presetTags", "curvesPresetTags"),
      presetMetadata: aliases("presetMetadata", "curvesPresetMetadata"),
      presetFolderCreate: aliases("presetFolderCreate", "curvesPresetFolderCreate"),
      presetFolderRename: aliases("presetFolderRename", "curvesPresetFolderRename"),
      presetFolderDelete: aliases("presetFolderDelete", "curvesPresetFolderDelete"),
      presetList: aliases("presetList", "curvesPresetList"),
      presetEmpty: aliases("presetEmpty", "curvesPresetEmpty"),
      presetCreate: aliases("presetCreate", "curvesPresetCreate"),
      presetSaveAs: aliases("presetSaveAs", "curvesPresetSaveAs"),
      presetOverwrite: aliases("presetOverwrite", "curvesPresetOverwrite"),
      presetRename: aliases("presetRename", "curvesPresetRename"),
      presetDuplicate: aliases("presetDuplicate", "curvesPresetDuplicate"),
      presetDelete: aliases("presetDelete", "curvesPresetDelete"),
      presetMoveUp: aliases("presetMoveUp", "curvesPresetMoveUp"),
      presetMoveDown: aliases("presetMoveDown", "curvesPresetMoveDown"),
      presetFavorite: aliases("presetFavorite", "curvesPresetFavorite"),
      presetImport: aliases("presetImport", "curvesPresetImport"),
      presetExport: aliases("presetExport", "curvesPresetExport"),
    };
  }

  function curvePathData(points) {
    const value = normalizeControlPoints(points);
    return `M 0 100 C ${value[0] * 100} ${(1 - value[1]) * 100} ${value[2] * 100} ${(1 - value[3]) * 100} 100 0`;
  }

  function viewportBox(viewport) {
    const zoom = clamp(finiteNumber(viewport.zoom, 1), 0.75, 8);
    const baseWidth = 110 / zoom;
    const baseHeight = 150 / zoom;
    const centerX = 50 + (clamp(finiteNumber(viewport.panX, 0), -1.5, 1.5) * 100);
    const centerY = 50 + (clamp(finiteNumber(viewport.panY, 0), -1.5, 1.5) * 100);
    return { x: centerX - (baseWidth / 2), y: centerY - (baseHeight / 2), width: baseWidth, height: baseHeight, zoom };
  }

  function isFormControl(target) {
    const tagName = cleanText(target && target.tagName, 16).toUpperCase();
    return ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tagName);
  }

  class CurvesWorkspaceController {
    constructor(elements, options = {}) {
      this.elements = normalizeElements(elements);
      if (!this.elements.root) throw new TypeError("CurvesWorkspaceController requires a workspace root element.");
      this.adapter = options.adapter || null;
      this.curveMath = options.curveMath || defaultCurveMath;
      this.presetApi = options.presetApi || defaultPresetApi;
      this.presetStore = options.presetStore || null;
      this.stateStore = options.stateStore || null;
      this.presetHooks = options.presetHooks && typeof options.presetHooks === "object" ? options.presetHooks : {};
      this.confirmPresetAction = typeof options.confirmPresetAction === "function" ? options.confirmPresetAction : null;
      this.confirmBakedApply = typeof options.confirmBakedApply === "function" ? options.confirmBakedApply : null;
      this.document = options.document || (typeof document !== "undefined" ? document : null);
      this.requestAnimationFrame = typeof options.requestAnimationFrame === "function"
        ? options.requestAnimationFrame
        : (callback) => requestAnimationFrame(callback);
      this.cancelAnimationFrame = typeof options.cancelAnimationFrame === "function"
        ? options.cancelAnimationFrame
        : (handle) => cancelAnimationFrame(handle);
      this.onToast = typeof options.onToast === "function" ? options.onToast : () => undefined;
      this.onAnnounce = typeof options.onAnnounce === "function" ? options.onAnnounce : () => undefined;
      this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : () => undefined;
      this.ownsAdapter = options.ownsAdapter === true;
      this.preferences = normalizePreferences(options.preferences || {});
      this.visible = options.visible === true;
      this.active = options.active === true;
      this.started = false;
      this.destroyed = false;
      this.destroyPromise = null;
      this.listeners = [];
      this.unsubscribeAdapter = null;
      this.unsubscribePresets = null;
      this.refreshGeneration = 0;
      this.refreshPromise = null;
      this.renderHandle = null;
      /** @type {any} */
      this.drag = null;
      this.spacePressed = false;
      this.applying = false;
      this.snapshot = normalizeSnapshot({ state: "loading" }, this.adapter);
      this.selection = { clipId: ALL_VALUE, componentId: "", propertyId: "" };
      this.activeBindings = [];
      this.bindingDrafts = new Map();
      this.draftKey = "";
      this.controlPoints = DEFAULT_CONTROL_POINTS.slice();
      /** @type {{zoom: number, panX: number, panY: number}} */
      this.viewport = { zoom: 1, panX: 0, panY: 0 };
      this.mode = this.preferences.defaultMode;
      this.nativeInterpolation = "LINEAR";
      this.internalClipboard = null;
      this.presetLibrary = this.presetApi && typeof this.presetApi.createEmptyPresetLibrary === "function"
        ? this.presetApi.createEmptyPresetLibrary()
        : { presets: [], builtInFavorites: [], folders: [] };
      this.presetTab = "built-in";
      this.presetTabFocus = "built-in";
      this.presetQuery = "";
      this.selectedPresetId = "";
      this.presetFocusId = "";
      this.presetReorderDrag = null;
      this.presetOrganizationDirty = false;
      this.lastPresetGroups = { builtIns: [], users: [] };

      this.handleRefresh = () => { void this.requestRefresh("user"); };
      this.handleClipChange = () => this.onSelectorChange("clip");
      this.handleComponentChange = () => this.onSelectorChange("component");
      this.handlePropertyChange = () => this.onSelectorChange("property");
      this.handleNativeMode = () => this.setMode("native");
      this.handleBakedMode = () => this.setMode("baked");
      this.handleInterpolationChange = () => this.setNativeInterpolation(this.elements.nativeInterpolation && this.elements.nativeInterpolation.value);
      this.handleGraphPointerDown = (event) => this.onGraphPointerDown(event);
      this.handleGraphPointerMove = (event) => this.onGraphPointerMove(event);
      this.handleGraphPointerUp = (event) => this.onGraphPointerUp(event);
      this.handleGraphWheel = (event) => this.onGraphWheel(event);
      this.handleWorkspaceKeyDown = (event) => this.onWorkspaceKeyDown(event);
      this.handleWorkspaceKeyUp = (event) => this.onWorkspaceKeyUp(event);
      this.handleGraphLostCapture = (event) => this.onGraphPointerUp(event);
      this.handleApply = () => { void this.apply(); };
      this.handlePresetListClick = (event) => this.onPresetListClick(event);
      this.handlePresetListKeyDown = (event) => this.onPresetListKeyDown(event);
      this.handlePresetReorderPointerDown = (event) => this.onPresetReorderPointerDown(event);
      this.handlePresetReorderPointerMove = (event) => this.onPresetReorderPointerMove(event);
      this.handlePresetReorderPointerUp = (event) => this.onPresetReorderPointerUp(event);
      this.handlePresetTabKeyDown = (event) => this.onPresetTabKeyDown(event);
      this.handlePresetSearch = () => {
        this.presetQuery = cleanText(this.elements.presetSearch && this.elements.presetSearch.value, 200);
        this.renderPresetList();
      };
      this.handlePresetOrganizationInput = () => {
        this.presetOrganizationDirty = true;
        this.syncPresetOrganizationControls(this.selectedPreset());
      };
    }

    start() {
      if (this.started || this.destroyed) return this;
      this.started = true;
      this.applyPreferencePresentation();
      this.bindControls();
      this.setWorkspaceState("loading", "Inspecting selected timeline clips and bracketing keyframes…");
      if (this.adapter && typeof this.adapter.start === "function") this.adapter.start();
      if (this.adapter && typeof this.adapter.subscribe === "function") {
        this.unsubscribeAdapter = this.adapter.subscribe((snapshot) => this.receiveSnapshot(snapshot), { immediate: true });
      }
      if (this.presetStore && typeof this.presetStore.subscribe === "function") {
        this.unsubscribePresets = this.presetStore.subscribe((library) => this.receivePresetLibrary(library), { immediate: true });
      }
      this.restoreWorkspaceState();
      this.reconcileActivation();
      this.refreshPresetLibrary();
      this.sync();
      this.scheduleRender();
      return this;
    }

    bindControls() {
      this.listen(this.elements.refresh, "click", this.handleRefresh);
      this.listen(this.elements.clipSelect, "change", this.handleClipChange);
      this.listen(this.elements.componentSelect, "change", this.handleComponentChange);
      this.listen(this.elements.propertySelect, "change", this.handlePropertyChange);
      this.listen(this.elements.modeNative, "click", this.handleNativeMode);
      this.listen(this.elements.modeBaked, "click", this.handleBakedMode);
      this.listen(this.elements.nativeInterpolation, "change", this.handleInterpolationChange);
      this.listen(this.elements.graph, "pointerdown", this.handleGraphPointerDown);
      this.listen(this.elements.graph, "pointermove", this.handleGraphPointerMove);
      this.listen(this.elements.graph, "pointerup", this.handleGraphPointerUp);
      this.listen(this.elements.graph, "pointercancel", this.handleGraphPointerUp);
      this.listen(this.elements.graph, "lostpointercapture", this.handleGraphLostCapture);
      this.listen(this.elements.graph, "wheel", this.handleGraphWheel);
      this.listen(this.elements.root, "keydown", this.handleWorkspaceKeyDown);
      this.listen(this.elements.root, "keyup", this.handleWorkspaceKeyUp);
      this.listen(this.elements.handleOne, "keydown", (event) => this.onHandleKeyDown(event, 0));
      this.listen(this.elements.handleTwo, "keydown", (event) => this.onHandleKeyDown(event, 1));
      this.listen(this.elements.zoomIn, "click", () => this.zoomBy(1.25));
      this.listen(this.elements.zoomOut, "click", () => this.zoomBy(0.8));
      this.listen(this.elements.fit, "click", () => this.fitGraph());
      this.listen(this.elements.reset, "click", () => this.resetCurve());
      this.listen(this.elements.mirror, "click", () => this.mirrorCurve());
      this.listen(this.elements.reverse, "click", () => this.reverseCurve());
      this.listen(this.elements.copy, "click", () => { void this.copyCurve(); });
      this.listen(this.elements.paste, "click", () => { void this.pasteCurve(); });
      this.listen(this.elements.apply, "click", this.handleApply);
      const numeric = [
        [this.elements.pointOneX, 0], [this.elements.pointOneY, 1],
        [this.elements.pointTwoX, 2], [this.elements.pointTwoY, 3],
      ];
      for (const [element, index] of numeric) {
        this.listen(element, "change", () => this.onNumericPointChange(index, element && element.value));
        this.listen(element, "input", () => this.onNumericPointChange(index, element && element.value, false));
      }
      this.listen(this.elements.presetBuiltInTab, "click", () => this.setPresetTab("built-in"));
      this.listen(this.elements.presetUserTab, "click", () => this.setPresetTab("user"));
      this.listen(this.elements.presetBuiltInTab, "keydown", this.handlePresetTabKeyDown);
      this.listen(this.elements.presetUserTab, "keydown", this.handlePresetTabKeyDown);
      this.listen(this.elements.presetSearch, "input", this.handlePresetSearch);
      this.listen(this.elements.presetFolder, "change", this.handlePresetOrganizationInput);
      this.listen(this.elements.presetTags, "input", this.handlePresetOrganizationInput);
      this.listen(this.elements.presetList, "click", this.handlePresetListClick);
      this.listen(this.elements.presetList, "keydown", this.handlePresetListKeyDown);
      this.listen(this.elements.presetList, "pointerdown", this.handlePresetReorderPointerDown);
      this.listen(this.elements.presetList, "pointermove", this.handlePresetReorderPointerMove);
      this.listen(this.elements.presetList, "pointerup", this.handlePresetReorderPointerUp);
      this.listen(this.elements.presetList, "pointercancel", this.handlePresetReorderPointerUp);
      this.listen(this.elements.presetList, "lostpointercapture", this.handlePresetReorderPointerUp);
      for (const action of PRESET_ACTIONS) {
        const key = `preset${action[0].toUpperCase()}${action.slice(1)}`;
        this.listen(this.elements[key], "click", () => { void this.invokePresetAction(action); });
      }
    }

    listen(target, type, handler) {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(type, handler);
      this.listeners.push({ target, type, handler });
    }

    removeListeners() {
      for (const entry of this.listeners.splice(0)) entry.target.removeEventListener(entry.type, entry.handler);
    }

    restoreWorkspaceState() {
      if (!this.stateStore) return;
      const getter = this.stateStore.getCurvesWorkspaceState || this.stateStore.getState || this.stateStore.load;
      if (typeof getter !== "function") return;
      try {
        const result = getter.call(this.stateStore);
        if (result && typeof result.then === "function") {
          result.then((state) => this.applyRestoredState(state)).catch(() => undefined);
        } else this.applyRestoredState(result);
      } catch (error) { /* Optional UI state never blocks Curves. */ }
    }

    applyRestoredState(state) {
      if (this.destroyed || !state || typeof state !== "object") return;
      if (state.mode === "native" || state.mode === "baked") {
        this.mode = state.mode === "baked" && !this.snapshot.capabilities.bakedVerified ? "native" : state.mode;
      }
      if (state.controlPoints) this.controlPoints = normalizeControlPoints(state.controlPoints, this.curveMath);
      if (state.viewport && typeof state.viewport === "object") {
        this.viewport = {
          zoom: clamp(finiteNumber(state.viewport.zoom, 1), 0.75, 8),
          panX: clamp(finiteNumber(state.viewport.panX, 0), -1.5, 1.5),
          panY: clamp(finiteNumber(state.viewport.panY, 0), -1.5, 1.5),
        };
      }
      if (state.presetTab === "user" || state.presetTab === "built-in") this.presetTab = state.presetTab;
      this.presetTabFocus = this.presetTab;
      this.sync();
      this.scheduleRender();
    }

    persistWorkspaceState() {
      if (!this.stateStore || this.destroyed) return;
      const setter = this.stateStore.setCurvesWorkspaceState || this.stateStore.setState || this.stateStore.save;
      if (typeof setter !== "function") return;
      const state = {
        version: 1,
        mode: this.mode,
        controlPoints: this.controlPoints.slice(),
        viewport: { ...this.viewport },
        presetTab: this.presetTab,
      };
      try {
        const result = setter.call(this.stateStore, state);
        if (result && typeof result.catch === "function") result.catch(() => undefined);
      } catch (error) { /* UI persistence is isolated from Premiere operations. */ }
    }

    setPreferences(value) {
      this.preferences = normalizePreferences(value);
      this.applyPreferencePresentation();
      this.sync();
      this.scheduleRender();
    }

    applyPreferencePresentation() {
      if (this.elements.root && this.elements.root.style && typeof this.elements.root.style.setProperty === "function") {
        this.elements.root.style.setProperty("--curve-handle-size", `${this.preferences.handleSize}px`);
        this.elements.root.style.setProperty("--curve-subdivisions", String(this.preferences.subdivisions));
        this.elements.root.style.setProperty("--curve-graph-grid", this.preferences.gridColor);
        this.elements.root.style.setProperty("--curve-graph-line", this.preferences.curveColor);
      }
      this.renderGrid();
    }

    renderGrid() {
      const grid = this.elements.grid;
      if (!grid) return;
      grid.hidden = !this.preferences.gridVisible;
      if (!this.preferences.gridVisible) return;
      const doc = grid.ownerDocument || this.document;
      if (!doc || typeof doc.createElementNS !== "function") return;
      grid.innerHTML = "";
      const subdivisions = this.preferences.subdivisions;
      for (let index = 0; index <= subdivisions; index += 1) {
        const position = (index * 100) / subdivisions;
        const vertical = doc.createElementNS(SVG_NAMESPACE, "line");
        vertical.setAttribute("x1", String(position));
        vertical.setAttribute("y1", "0");
        vertical.setAttribute("x2", String(position));
        vertical.setAttribute("y2", "100");
        grid.appendChild(vertical);
        const horizontal = doc.createElementNS(SVG_NAMESPACE, "line");
        horizontal.setAttribute("x1", "0");
        horizontal.setAttribute("y1", String(position));
        horizontal.setAttribute("x2", "100");
        horizontal.setAttribute("y2", String(position));
        grid.appendChild(horizontal);
      }
    }

    setVisible(visible) {
      const next = Boolean(visible);
      if (next === this.visible || this.destroyed) return;
      this.visible = next;
      if (!next) this.cancelPreviewFrame();
      this.reconcileActivation();
    }

    setActive(active) {
      const next = Boolean(active);
      if (next === this.active || this.destroyed) return;
      this.active = next;
      if (!next) this.cancelPreviewFrame();
      this.reconcileActivation();
    }

    reconcileActivation() {
      if (!this.started || this.destroyed) return;
      const observing = this.visible && this.active;
      if (this.adapter && typeof this.adapter.setVisible === "function") this.adapter.setVisible(this.visible);
      if (this.adapter && typeof this.adapter.setActive === "function") this.adapter.setActive(this.active);
      if (this.elements.root && typeof this.elements.root.setAttribute === "function") {
        this.elements.root.setAttribute("data-curves-active", observing ? "true" : "false");
      }
      if (observing) {
        this.requestRefresh("activation");
        this.scheduleRender();
      }
    }

    async requestRefresh(reason = "workspace") {
      if (this.destroyed || !this.visible || !this.active || !this.adapter) return false;
      const generation = ++this.refreshGeneration;
      if (this.snapshot.state !== "ready") this.setWorkspaceState("loading", "Inspecting selected timeline clips and bracketing keyframes…");
      const operation = (async () => {
        try {
          let result;
          if (typeof this.adapter.requestRefresh === "function") result = await this.adapter.requestRefresh(reason);
          if (this.destroyed || generation !== this.refreshGeneration) return false;
          const snapshot = result && (result.bindings || result.selectedBindings || result.state)
            ? result
            : typeof this.adapter.getSnapshot === "function" ? this.adapter.getSnapshot() : result;
          if (snapshot) this.receiveSnapshot(snapshot);
          return true;
        } catch (error) {
          if (this.destroyed || generation !== this.refreshGeneration) return false;
          this.receiveSnapshot({ state: "error", error, message: error && error.message });
          return false;
        }
      })();
      this.refreshPromise = operation;
      return operation;
    }

    receiveSnapshot(value) {
      if (this.destroyed) return;
      this.snapshot = normalizeSnapshot(value || {}, this.adapter);
      if (this.mode === "baked" && !this.snapshot.capabilities.bakedVerified) this.mode = "native";
      this.reconcileSelection();
      this.sync();
      this.scheduleRender();
    }

    setWorkspaceState(state, message, error = null) {
      this.snapshot = normalizeSnapshot({ state, message, error, bindings: this.snapshot.bindings.map((entry) => entry.source) }, this.adapter);
      this.reconcileSelection();
      this.sync();
    }

    selectorBindings() {
      const all = this.snapshot.bindings;
      const clips = uniqueOptions(all, "clipId", "clipName");
      if (this.selection.clipId !== ALL_VALUE && !clips.some((entry) => entry.value === this.selection.clipId)) this.selection.clipId = ALL_VALUE;
      const byClip = all.filter((binding) => this.selection.clipId === ALL_VALUE || binding.clipId === this.selection.clipId);
      const components = uniqueOptions(byClip, "componentId", "componentName");
      if (!components.some((entry) => entry.value === this.selection.componentId)) this.selection.componentId = components[0] && components[0].value || "";
      const byComponent = byClip.filter((binding) => !this.selection.componentId || binding.componentId === this.selection.componentId);
      const properties = uniqueOptions(byComponent, "propertyId", "propertyName");
      if (!properties.some((entry) => entry.value === this.selection.propertyId)) this.selection.propertyId = properties[0] && properties[0].value || "";
      const active = byComponent.filter((binding) => !this.selection.propertyId || binding.propertyId === this.selection.propertyId);
      return { clips, components, properties, active };
    }

    reconcileSelection() {
      const options = this.selectorBindings();
      this.activeBindings = options.active;
      this.setSelectOptions(this.elements.clipSelect, [{ value: ALL_VALUE, label: `All selected clips (${options.clips.length})` }, ...options.clips], this.selection.clipId);
      this.setSelectOptions(this.elements.componentSelect, options.components, this.selection.componentId);
      this.setSelectOptions(this.elements.propertySelect, options.properties, this.selection.propertyId);
      const primary = this.activeBindings[0];
      const nextDraftKey = primary ? `${primary.id}|${primary.revision}` : "";
      if (nextDraftKey !== this.draftKey) {
        if (this.draftKey) this.bindingDrafts.set(this.draftKey, this.controlPoints.slice());
        this.draftKey = nextDraftKey;
        this.controlPoints = normalizeControlPoints(this.bindingDrafts.get(nextDraftKey) || primary && primary.controlPoints || DEFAULT_CONTROL_POINTS, this.curveMath);
      }
      this.syncInterpolationOptions();
    }

    setSelectOptions(select, options, value) {
      if (!select) return;
      select.innerHTML = "";
      const doc = select.ownerDocument || this.document;
      if (doc && typeof doc.createElement === "function") {
        for (const entry of options) {
          const option = doc.createElement("option");
          option.value = entry.value;
          option.textContent = entry.label;
          option.selected = entry.value === value;
          select.appendChild(option);
        }
      }
      select.value = options.some((entry) => entry.value === value) ? value : options[0] && options[0].value || "";
      setDisabled(select, options.length === 0, options.length === 0 ? "No compatible selection options are available." : "");
    }

    syncInterpolationOptions() {
      const supported = new Set();
      for (const binding of this.activeBindings) for (const mode of binding.supportedInterpolations) supported.add(mode);
      for (const mode of this.snapshot.capabilities.nativeModes) supported.add(mode);
      const modes = ["LINEAR", "HOLD", "BEZIER"].filter((mode) => supported.size === 0 || supported.has(mode));
      if (!modes.includes(this.nativeInterpolation)) this.nativeInterpolation = modes[0] || "";
      this.setSelectOptions(
        this.elements.nativeInterpolation,
        modes.map((mode) => ({ value: mode, label: `${mode[0]}${mode.slice(1).toLowerCase()}` })),
        this.nativeInterpolation,
      );
    }

    onSelectorChange(kind) {
      if (kind === "clip") {
        this.selection.clipId = this.elements.clipSelect && this.elements.clipSelect.value || ALL_VALUE;
        this.selection.componentId = "";
        this.selection.propertyId = "";
      } else if (kind === "component") {
        this.selection.componentId = this.elements.componentSelect && this.elements.componentSelect.value || "";
        this.selection.propertyId = "";
      } else this.selection.propertyId = this.elements.propertySelect && this.elements.propertySelect.value || "";
      this.reconcileSelection();
      this.sync();
      this.scheduleRender();
    }

    getCompatibleBindings() {
      if (this.mode === "baked") {
        return this.snapshot.capabilities.bakedVerified
          ? this.activeBindings.filter((binding) => binding.bakedCompatible && binding.valueType.toLowerCase() === "number")
          : [];
      }
      return this.activeBindings.filter((binding) => binding.nativeCompatible);
    }

    setMode(mode) {
      const requested = mode === "baked" ? "baked" : "native";
      if (requested === "baked" && !this.snapshot.capabilities.bakedVerified) {
        const reason = this.snapshot.capabilities.bakedReason;
        this.mode = "native";
        this.toast(reason, "warning");
        this.announce(reason);
        this.sync();
        return false;
      }
      if (requested === "baked" && !this.activeBindings.some((binding) => binding.bakedCompatible && binding.valueType.toLowerCase() === "number")) {
        const reason = this.activeBindings[0] && this.activeBindings[0].bakedReason || "Baked Oracle curves require a proven numeric property segment.";
        this.mode = "native";
        this.toast(reason, "warning");
        this.announce(reason);
        this.sync();
        return false;
      }
      this.mode = requested;
      this.sync();
      this.persistWorkspaceState();
      return true;
    }

    setNativeInterpolation(mode) {
      const requested = cleanText(mode, 64).toUpperCase();
      const select = this.elements.nativeInterpolation;
      const valid = !select || Array.from(select.children || []).some((entry) => entry.value === requested);
      if (!requested || !valid) return false;
      this.nativeInterpolation = requested;
      if (select) select.value = requested;
      this.sync();
      return true;
    }

    sync() {
      const state = this.snapshot.state;
      const readyLike = state === "ready" || (state === "unsupported" && this.snapshot.bindings.length > 0);
      if (this.elements.root.dataset) this.elements.root.dataset.curvesState = state;
      if (typeof this.elements.root.setAttribute === "function") this.elements.root.setAttribute("aria-busy", state === "loading" ? "true" : "false");
      if (this.elements.state) {
        this.elements.state.hidden = false;
        if (this.elements.state.dataset) this.elements.state.dataset.state = state;
        if (typeof this.elements.state.setAttribute === "function") this.elements.state.setAttribute("role", state === "error" ? "alert" : "status");
      }
      const titles = {
        loading: "Loading Curves",
        empty: "Choose an animated property",
        error: "Curves needs attention",
        unsupported: "Selection is not compatible",
        ready: "Curves ready",
      };
      if (this.elements.stateTitle) this.elements.stateTitle.textContent = titles[state];
      if (this.elements.stateMessage) this.elements.stateMessage.textContent = this.snapshot.message;
      if (this.elements.content) this.elements.content.hidden = !readyLike;

      const primary = this.activeBindings[0] || null;
      const compatible = this.getCompatibleBindings();
      if (this.elements.clipSummary) this.elements.clipSummary.textContent = this.activeBindings.length > 1 ? `${new Set(this.activeBindings.map((entry) => entry.clipId)).size} selected clips` : primary && primary.clipName || "—";
      if (this.elements.componentSummary) this.elements.componentSummary.textContent = primary && primary.componentName || "—";
      if (this.elements.propertySummary) this.elements.propertySummary.textContent = primary ? `${primary.propertyName} · ${primary.valueType}` : "—";
      if (this.elements.endpointsSummary) this.elements.endpointsSummary.textContent = primary ? `${formatEndpoint(primary.start)} → ${formatEndpoint(primary.end)}` : "—";
      if (this.elements.interpolationSummary) this.elements.interpolationSummary.textContent = primary ? formatInterpolation(primary.interpolation) : "—";
      if (this.elements.compatibilitySummary) {
        this.elements.compatibilitySummary.textContent = compatible.length
          ? `${compatible.length} of ${this.activeBindings.length} target${this.activeBindings.length === 1 ? "" : "s"} compatible`
          : primary && primary.reason || "No compatible target";
      }

      setPressed(this.elements.modeNative, this.mode === "native");
      setPressed(this.elements.modeBaked, this.mode === "baked");
      if (this.elements.modeNative) this.elements.modeNative.checked = this.mode === "native";
      if (this.elements.modeBaked) this.elements.modeBaked.checked = this.mode === "baked";
      const hasNativeTarget = this.activeBindings.some((binding) => binding.nativeCompatible);
      const hasBakedTarget = this.activeBindings.some((binding) => binding.bakedCompatible && binding.valueType.toLowerCase() === "number");
      setDisabled(this.elements.modeNative, !this.snapshot.capabilities.nativeSupported || !hasNativeTarget, hasNativeTarget ? "Premiere did not expose supported interpolation actions for this selection." : primary && primary.reason || "No native-compatible keyframe segment is selected.");
      setDisabled(this.elements.modeBaked, !this.snapshot.capabilities.bakedVerified || !hasBakedTarget, !this.snapshot.capabilities.bakedVerified ? this.snapshot.capabilities.bakedReason : primary && primary.bakedReason || "No proven numeric baked target is selected.");
      if (this.elements.bakedReason) {
        this.elements.bakedReason.hidden = this.snapshot.capabilities.bakedVerified;
        this.elements.bakedReason.textContent = this.snapshot.capabilities.bakedVerified ? "" : this.snapshot.capabilities.bakedReason;
      }
      setDisabled(this.elements.nativeInterpolation, this.mode !== "native" || compatible.length === 0, compatible.length === 0 ? "Choose a compatible property segment." : this.mode !== "native" ? "Native interpolation options apply only in Native interpolation mode." : "");

      const applyReason = this.applying
        ? "Oracle is applying and verifying the current curve."
        : compatible.length === 0
          ? (primary && primary.reason || "Choose a compatible property segment.")
          : this.mode === "baked" && !this.snapshot.capabilities.bakedVerified
            ? this.snapshot.capabilities.bakedReason
            : !this.adapter
              ? "Premiere Curves adapter is unavailable."
              : "";
      setDisabled(this.elements.apply, Boolean(applyReason), applyReason);
      if (this.elements.apply) this.elements.apply.textContent = this.applying ? "Applying…" : `Apply to ${compatible.length || 0}`;
      if (this.elements.status && !this.applying) {
        this.elements.status.textContent = compatible.length
          ? "Preview is local. Premiere changes only after Apply, with readback verification."
          : this.snapshot.message;
      }
      if (this.elements.samplePreview) {
        if (this.mode !== "baked") this.elements.samplePreview.textContent = "No generated keys in Native mode";
        else if (!this.snapshot.capabilities.bakedVerified) this.elements.samplePreview.textContent = "Baked sampling unavailable";
        else {
          try {
            const preview = this.buildBakedSamples();
            const thresholdExceeded = preview.addedKeyCount > this.preferences.warningThreshold;
            this.elements.samplePreview.textContent = `${preview.addedKeyCount} generated key${preview.addedKeyCount === 1 ? "" : "s"} · ${preview.collisionCount} preserved collision${preview.collisionCount === 1 ? "" : "s"}${thresholdExceeded ? ` · exceeds warning threshold ${this.preferences.warningThreshold}` : ""}`;
            if (this.elements.samplePreview.classList && typeof this.elements.samplePreview.classList.toggle === "function") {
              this.elements.samplePreview.classList.toggle("is-warning", thresholdExceeded);
            }
          } catch (error) {
            this.elements.samplePreview.textContent = cleanText(error && error.message, 240) || "Baked sampling unavailable";
            if (this.elements.samplePreview.classList && typeof this.elements.samplePreview.classList.remove === "function") {
              this.elements.samplePreview.classList.remove("is-warning");
            }
          }
        }
      }
      setDisabled(this.elements.paste, !this.internalClipboard && !this.canReadExternalClipboard(), !this.internalClipboard && !this.canReadExternalClipboard() ? "Copy an Oracle curve before pasting." : "");
      this.syncPresetControls();
    }

    scheduleRender() {
      if (this.destroyed || !this.visible || !this.active || this.renderHandle !== null) return;
      this.renderHandle = this.requestAnimationFrame(() => {
        this.renderHandle = null;
        if (this.destroyed || !this.visible || !this.active) return;
        this.renderGraph();
      });
    }

    cancelPreviewFrame() {
      if (this.renderHandle === null) return;
      this.cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }

    renderGraph() {
      const points = this.controlPoints;
      const box = viewportBox(this.viewport);
      if (this.elements.graph) {
        if (typeof this.elements.graph.setAttribute === "function") {
          this.elements.graph.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
          this.elements.graph.setAttribute("aria-label", `Oracle curve. First control point ${points[0].toFixed(3)}, ${points[1].toFixed(3)}. Second control point ${points[2].toFixed(3)}, ${points[3].toFixed(3)}.`);
        }
      }
      if (this.elements.path && typeof this.elements.path.setAttribute === "function") this.elements.path.setAttribute("d", curvePathData(points));
      this.setSvgPoint(this.elements.handleOne, points[0] * 100, (1 - points[1]) * 100, `First control point: x ${points[0].toFixed(3)}, y ${points[1].toFixed(3)}`);
      this.setSvgPoint(this.elements.handleTwo, points[2] * 100, (1 - points[3]) * 100, `Second control point: x ${points[2].toFixed(3)}, y ${points[3].toFixed(3)}`);
      this.setSvgLine(this.elements.handleOneLine, 0, 100, points[0] * 100, (1 - points[1]) * 100);
      this.setSvgLine(this.elements.handleTwoLine, 100, 0, points[2] * 100, (1 - points[3]) * 100);
      this.renderOverlays();
      const numeric = [this.elements.pointOneX, this.elements.pointOneY, this.elements.pointTwoX, this.elements.pointTwoY];
      for (let index = 0; index < numeric.length; index += 1) if (numeric[index]) numeric[index].value = String(Math.round(points[index] * 10000) / 10000);
      this.bindingDrafts.set(this.draftKey, points.slice());
      this.persistWorkspaceState();
      try {
        this.onStateChange(this.getState());
      } catch (error) { /* Consumer callbacks cannot break graph rendering. */ }
    }

    setSvgPoint(element, x, y, label) {
      if (!element || typeof element.setAttribute !== "function") return;
      element.setAttribute("cx", String(x));
      element.setAttribute("cy", String(y));
      element.setAttribute("aria-valuetext", label);
      element.setAttribute("r", String(this.preferences.handleSize / 2));
    }

    setSvgLine(element, x1, y1, x2, y2) {
      if (!element || typeof element.setAttribute !== "function") return;
      element.setAttribute("x1", String(x1));
      element.setAttribute("y1", String(y1));
      element.setAttribute("x2", String(x2));
      element.setAttribute("y2", String(y2));
    }

    renderOverlays() {
      const group = this.elements.overlayGroup;
      if (!group) return;
      group.innerHTML = "";
      const doc = group.ownerDocument || this.document;
      if (!doc || typeof doc.createElementNS !== "function") return;
      for (let index = 1; index < this.activeBindings.length; index += 1) {
        const binding = this.activeBindings[index];
        const path = doc.createElementNS(SVG_NAMESPACE, "path");
        path.setAttribute("d", curvePathData(binding.controlPoints));
        path.setAttribute("class", binding.compatible ? "curves-graph__overlay" : "curves-graph__overlay curves-graph__overlay--unsupported");
        path.setAttribute("aria-hidden", "true");
        group.appendChild(path);
      }
    }

    graphPointFromClient(event) {
      const graph = this.elements.graph;
      const rect = graph && typeof graph.getBoundingClientRect === "function" ? graph.getBoundingClientRect() : null;
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      const box = viewportBox(this.viewport);
      const svgX = box.x + (clamp((finiteNumber(event.clientX) - rect.left) / rect.width, 0, 1) * box.width);
      const svgY = box.y + (clamp((finiteNumber(event.clientY) - rect.top) / rect.height, 0, 1) * box.height);
      return { x: svgX / 100, y: 1 - (svgY / 100) };
    }

    capturePointer(event) {
      const graph = this.elements.graph;
      if (graph && typeof graph.setPointerCapture === "function" && event.pointerId != null) {
        try { graph.setPointerCapture(event.pointerId); } catch (error) { /* Some UXP builds capture implicitly. */ }
      }
    }

    releasePointer(event) {
      const graph = this.elements.graph;
      if (graph && typeof graph.releasePointerCapture === "function" && event.pointerId != null) {
        try { graph.releasePointerCapture(event.pointerId); } catch (error) { /* Capture may already be released. */ }
      }
    }

    onGraphPointerDown(event) {
      if (!this.visible || !this.active || this.destroyed) return;
      const target = event && event.target;
      const handleIndex = target === this.elements.handleOne ? 0 : target === this.elements.handleTwo ? 1 : -1;
      const panRequested = handleIndex < 0 && (event.button === 1 || event.button === 0 || this.spacePressed);
      if (handleIndex < 0 && !panRequested) return;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      this.capturePointer(event);
      this.drag = handleIndex >= 0
        ? { type: "handle", index: handleIndex, pointerId: event.pointerId, start: this.graphPointFromClient(event), original: this.controlPoints.slice() }
        : { type: "pan", pointerId: event.pointerId, clientX: finiteNumber(event.clientX), clientY: finiteNumber(event.clientY), original: { ...this.viewport } };
    }

    onGraphPointerMove(event) {
      if (!this.drag || (this.drag.pointerId != null && event.pointerId != null && event.pointerId !== this.drag.pointerId)) return;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (this.drag.type === "pan") {
        const graph = this.elements.graph;
        const rect = graph && typeof graph.getBoundingClientRect === "function" ? graph.getBoundingClientRect() : { width: 1, height: 1 };
        this.viewport.panX = clamp(this.drag.original.panX - ((finiteNumber(event.clientX) - this.drag.clientX) / Math.max(1, rect.width)) / this.viewport.zoom, -1.5, 1.5);
        this.viewport.panY = clamp(this.drag.original.panY - ((finiteNumber(event.clientY) - this.drag.clientY) / Math.max(1, rect.height)) / this.viewport.zoom, -1.5, 1.5);
        this.scheduleRender();
        return;
      }
      const point = this.graphPointFromClient(event);
      if (!point) return;
      if (event.shiftKey && this.drag.start) {
        const dx = Math.abs(point.x - this.drag.start.x);
        const dy = Math.abs(point.y - this.drag.start.y);
        if (dx >= dy) point.y = this.drag.original[(this.drag.index * 2) + 1];
        else point.x = this.drag.original[this.drag.index * 2];
      }
      this.setHandlePoint(this.drag.index, point.x, point.y, event.altKey);
    }

    onGraphPointerUp(event) {
      if (!this.drag || (this.drag.pointerId != null && event.pointerId != null && event.pointerId !== this.drag.pointerId)) return;
      this.releasePointer(event);
      this.drag = null;
      this.persistWorkspaceState();
    }

    onGraphWheel(event) {
      if (!this.visible || !this.active || this.destroyed) return;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      this.zoomBy(finiteNumber(event.deltaY) < 0 ? 1.12 : 0.89);
    }

    onWorkspaceKeyDown(event) {
      if (!this.visible || !this.active || this.destroyed) return;
      if (event.key === " " && !isFormControl(event.target)) this.spacePressed = true;
      if ((event.ctrlKey || event.metaKey) && !isFormControl(event.target)) {
        const key = cleanText(event.key, 8).toLowerCase();
        if (key === "c") {
          event.preventDefault();
          void this.copyCurve();
        } else if (key === "v") {
          event.preventDefault();
          void this.pasteCurve();
        } else if (key === "0") {
          event.preventDefault();
          this.fitGraph();
        }
      }
    }

    onWorkspaceKeyUp(event) {
      if (event.key === " ") this.spacePressed = false;
    }

    onHandleKeyDown(event, handleIndex) {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (!directions[event.key]) return;
      event.preventDefault();
      event.stopPropagation();
      const base = event.ctrlKey || event.metaKey ? 0.001 : event.shiftKey ? 0.05 : 0.01;
      const xIndex = handleIndex * 2;
      const yIndex = xIndex + 1;
      this.setHandlePoint(handleIndex, this.controlPoints[xIndex] + directions[event.key][0] * base, this.controlPoints[yIndex] + directions[event.key][1] * base, event.altKey);
      this.announce(`Control point ${handleIndex + 1}: x ${this.controlPoints[xIndex].toFixed(3)}, y ${this.controlPoints[yIndex].toFixed(3)}.`);
    }

    snapCoordinate(value, axis, modifierOverride) {
      const shouldSnap = modifierOverride ? !this.preferences.snapping : this.preferences.snapping;
      if (!shouldSnap) return value;
      const unit = 1 / this.preferences.subdivisions;
      const snapped = Math.round(value / unit) * unit;
      return axis === "x" ? clamp(snapped, 0, 1) : clamp(snapped, MIN_CONTROL_Y, MAX_CONTROL_Y);
    }

    setHandlePoint(handleIndex, x, y, modifierOverride = false) {
      const xIndex = handleIndex * 2;
      const yIndex = xIndex + 1;
      this.controlPoints[xIndex] = this.snapCoordinate(clamp(finiteNumber(x), 0, 1), "x", modifierOverride);
      this.controlPoints[yIndex] = this.snapCoordinate(clamp(finiteNumber(y), MIN_CONTROL_Y, MAX_CONTROL_Y), "y", modifierOverride);
      this.scheduleRender();
    }

    onNumericPointChange(index, value, announce = true) {
      const number = Number(value);
      if (!Number.isFinite(number)) return false;
      const clamped = index === 0 || index === 2 ? clamp(number, 0, 1) : clamp(number, MIN_CONTROL_Y, MAX_CONTROL_Y);
      this.controlPoints[index] = clamped;
      this.scheduleRender();
      if (announce) this.announce(`Curve control point updated to ${clamped}.`);
      return true;
    }

    zoomBy(factor) {
      this.viewport.zoom = clamp(this.viewport.zoom * finiteNumber(factor, 1), 0.75, 8);
      this.scheduleRender();
    }

    fitGraph() {
      this.viewport = { ...DEFAULT_VIEWPORT };
      this.scheduleRender();
      this.announce("Curve graph fitted to the normalized axes.");
    }

    resetCurve() {
      this.controlPoints = DEFAULT_CONTROL_POINTS.slice();
      this.scheduleRender();
      this.announce("Curve reset to Oracle default ease.");
    }

    mirrorCurve() {
      const [x1, y1, x2, y2] = this.controlPoints;
      this.controlPoints = [x1, 1 - y1, x2, 1 - y2];
      this.scheduleRender();
      this.announce("Curve mirrored vertically around the normalized midpoint.");
    }

    reverseCurve() {
      const [x1, y1, x2, y2] = this.controlPoints;
      this.controlPoints = [1 - x2, 1 - y2, 1 - x1, 1 - y1];
      this.scheduleRender();
      this.announce("Curve timing reversed while preserving normalized endpoints.");
    }

    canReadExternalClipboard() {
      return Boolean(this.stateStore && (typeof this.stateStore.readCurveClipboard === "function" || typeof this.stateStore.getCurveClipboard === "function"));
    }

    async copyCurve() {
      const payload = { schema: "com.blocky.oracle.curve-clipboard", version: 1, cubicControlPoints: this.controlPoints.slice() };
      this.internalClipboard = payload;
      const writer = this.stateStore && (this.stateStore.writeCurveClipboard || this.stateStore.setCurveClipboard);
      if (typeof writer === "function") {
        try { await writer.call(this.stateStore, clone(payload)); } catch (error) { /* In-memory clipboard remains valid. */ }
      }
      this.sync();
      this.toast("Oracle curve copied.", "success");
      this.announce("Oracle curve copied.");
      return true;
    }

    async pasteCurve() {
      let payload = this.internalClipboard;
      if (!payload && this.stateStore) {
        const reader = this.stateStore.readCurveClipboard || this.stateStore.getCurveClipboard;
        if (typeof reader === "function") {
          try { payload = await reader.call(this.stateStore); } catch (error) { payload = null; }
        }
      }
      if (!payload || payload.schema !== "com.blocky.oracle.curve-clipboard" || payload.version !== 1) {
        this.toast("Copy an Oracle curve before pasting.", "warning");
        return false;
      }
      this.controlPoints = normalizeControlPoints(payload.cubicControlPoints, this.curveMath);
      this.internalClipboard = clone(payload);
      this.scheduleRender();
      this.sync();
      this.toast("Oracle curve pasted into the local preview.", "success");
      this.announce("Oracle curve pasted into the local preview.");
      return true;
    }

    async apply() {
      if (this.destroyed || this.applying) return false;
      const bindings = this.getCompatibleBindings();
      if (!this.adapter || bindings.length === 0) {
        this.toast("Choose a compatible property segment before applying a curve.", "warning");
        return false;
      }
      if (this.mode === "baked" && !this.snapshot.capabilities.bakedVerified) {
        this.toast(this.snapshot.capabilities.bakedReason, "warning");
        return false;
      }
      this.applying = true;
      if (this.elements.status) this.elements.status.textContent = "Applying one verified Premiere transaction…";
      this.sync();
      try {
        let plan;
        let result;
        if (this.mode === "native" && typeof this.adapter.planNativeInterpolation === "function" && typeof this.adapter.applyNativeInterpolation === "function") {
          plan = await this.adapter.planNativeInterpolation(bindings.map((entry) => entry.source), this.nativeInterpolation, {
            controlPoints: this.controlPoints.slice(),
            revision: this.snapshot.revision,
            undoString: `Oracle Curves: ${this.nativeInterpolation[0]}${this.nativeInterpolation.slice(1).toLowerCase()}`,
          });
          result = await this.adapter.applyNativeInterpolation(plan);
        } else if (this.mode === "baked" && typeof this.adapter.planBakedCurve === "function" && typeof this.adapter.applyBakedCurve === "function") {
          const baked = this.buildBakedSamples(bindings);
          if (baked.addedKeyCount <= 0) {
            throw Object.assign(new Error("The bounded baked plan produced no new interior frame-aligned keys."), { code: "CURVES_EMPTY_BAKED_PLAN" });
          }
          if (baked.addedKeyCount > this.preferences.warningThreshold) {
            if (!this.confirmBakedApply) {
              throw Object.assign(
                new Error(`This bake would add ${baked.addedKeyCount} keys, above the warning threshold of ${this.preferences.warningThreshold}, but no confirmation dialog is available.`),
                { code: "CURVES_BAKED_CONFIRMATION_UNAVAILABLE" },
              );
            }
            const confirmed = await this.confirmBakedApply({
              addedKeyCount: baked.addedKeyCount,
              collisionCount: baked.collisionCount,
              warningThreshold: this.preferences.warningThreshold,
              bindingCount: bindings.length,
            });
            if (confirmed !== true) {
              const message = "Baked curve apply cancelled before Premiere was changed.";
              if (this.elements.status) this.elements.status.textContent = message;
              this.toast(message, "info");
              this.announce(message);
              return false;
            }
          }
          plan = await this.adapter.planBakedCurve(bindings.map((entry) => entry.source), baked.samplesByBinding, {
            warningThreshold: this.preferences.warningThreshold,
            undoString: "Oracle Curves: Bake Curve",
            runtimeProofVersion: this.snapshot.capabilities.bakedProof && this.snapshot.capabilities.bakedProof.version,
          });
          result = await this.adapter.applyBakedCurve(plan);
        } else if (typeof this.adapter.applyCurve === "function") {
          result = await this.adapter.applyCurve({
            mode: this.mode,
            interpolation: this.nativeInterpolation,
            bindings: bindings.map((entry) => entry.source),
            cubicControlPoints: this.controlPoints.slice(),
            revision: this.snapshot.revision,
          });
        } else throw Object.assign(new Error("Premiere Curves apply actions are unavailable."), { code: "CURVES_APPLY_UNAVAILABLE" });

        if (!result || result.ok !== true || (result.verified !== true && result.readbackVerified !== true)) {
          throw Object.assign(new Error("Premiere did not return verified curve readback."), { code: "CURVES_READBACK_UNVERIFIED" });
        }
        const changed = result.changed !== false && result.committed !== false;
        const oneStep = result.oneUndoStep === true || result.undoStep === 1 || (!changed && (result.undoStep === 0 || result.oneUndoStep === false));
        if (!oneStep) throw Object.assign(new Error("Premiere did not verify the curve as one Undo step."), { code: "CURVES_UNDO_UNVERIFIED" });
        const message = changed
          ? `Applied and verified ${bindings.length} curve target${bindings.length === 1 ? "" : "s"} as one Premiere Undo step.`
          : `Verified ${bindings.length} curve target${bindings.length === 1 ? "" : "s"}; interpolation was already current.`;
        if (this.elements.status) this.elements.status.textContent = message;
        this.toast(message, "success");
        this.announce(message);
        await this.requestRefresh("apply-readback");
        return true;
      } catch (error) {
        const message = cleanText(error && error.message, 1024) || "Premiere could not apply this curve.";
        if (this.elements.status) this.elements.status.textContent = message;
        this.toast(message, "error");
        this.announce(message);
        return false;
      } finally {
        this.applying = false;
        this.sync();
      }
    }

    buildBakedSamples(bindings = this.activeBindings.filter((binding) => binding.bakedCompatible && binding.valueType.toLowerCase() === "number")) {
      if (!this.curveMath || typeof this.curveMath.createBakedCurveSamples !== "function") {
        throw new Error("Oracle curve sampling math is unavailable.");
      }
      const sequenceTicksPerFrame = cleanText(this.snapshot.source && this.snapshot.source.sequence && this.snapshot.source.sequence.ticksPerFrame, 256);
      const samplesByBinding = {};
      let addedKeyCount = 0;
      let collisionCount = 0;
      for (const binding of bindings) {
        if (!binding || binding.valueType.toLowerCase() !== "number" || !binding.start || !binding.end) {
          throw new Error("Baked Oracle curves support proven numeric endpoints only.");
        }
        const ticksPerFrame = binding.ticksPerFrame || sequenceTicksPerFrame;
        if (!/^\d+$/.test(ticksPerFrame) || ticksPerFrame === "0") {
          throw new Error("Exact Premiere frame quantization is unavailable for this property.");
        }
        const generated = this.curveMath.createBakedCurveSamples({
          controlPoints: this.controlPoints.slice(),
          startTick: binding.start.ticks,
          endTick: binding.end.ticks,
          startValue: binding.start.value,
          endValue: binding.end.value,
          quantizationTicks: ticksPerFrame,
          occupiedTicks: binding.keyTicks,
          budget: this.preferences.sampleBudget,
          minimumSamples: Math.min(8, this.preferences.sampleBudget),
        });
        const samples = Array.isArray(generated && generated.samples) ? generated.samples : [];
        samplesByBinding[binding.id] = samples.map((sample) => ({
          ticks: cleanText(sample.ticks, 256),
          value: Number(sample.value),
          endpoint: sample.endpoint === true,
        }));
        const interiorCount = samples.filter((sample) => sample.endpoint !== true).length;
        addedKeyCount += interiorCount;
        collisionCount += Number(generated && generated.collisionCount) || 0;
      }
      return { samplesByBinding, addedKeyCount, collisionCount };
    }

    refreshPresetLibrary() {
      if (!this.presetStore) {
        this.renderPresetList();
        return;
      }
      const getter = this.presetStore.getLibrary || this.presetStore.getSnapshot || this.presetStore.load;
      if (typeof getter !== "function") {
        this.renderPresetList();
        return;
      }
      try {
        const result = getter.call(this.presetStore);
        if (result && typeof result.then === "function") result.then((library) => this.receivePresetLibrary(library)).catch((error) => this.toast(error.message, "error"));
        else this.receivePresetLibrary(result);
      } catch (error) { this.toast(error.message, "error"); }
    }

    receivePresetLibrary(library) {
      if (this.destroyed || !library) return;
      this.presetOrganizationDirty = false;
      this.presetLibrary = this.presetApi && typeof this.presetApi.normalizePresetLibrary === "function"
        ? this.presetApi.normalizePresetLibrary(library)
        : clone(library);
      this.renderPresetList();
      this.syncPresetControls();
    }

    setPresetTab(tab) {
      this.presetTab = tab === "user" ? "user" : "built-in";
      this.presetTabFocus = this.presetTab;
      this.selectedPresetId = "";
      this.presetFocusId = "";
      this.presetOrganizationDirty = false;
      this.renderPresetList();
      this.syncPresetControls();
      this.persistWorkspaceState();
    }

    presetTabControls() {
      return [this.elements.presetBuiltInTab, this.elements.presetUserTab].filter(Boolean);
    }

    focusPresetTab(control, controls = this.presetTabControls()) {
      if (!control) return false;
      this.presetTabFocus = control === this.elements.presetUserTab ? "user" : "built-in";
      for (const candidate of controls) candidate.tabIndex = candidate === control ? 0 : -1;
      if (typeof control.focus === "function") control.focus();
      return true;
    }

    onPresetTabKeyDown(event) {
      const controls = this.presetTabControls();
      const control = event.currentTarget || event.target;
      const current = controls.indexOf(control);
      if (current < 0) return false;
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % controls.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + controls.length) % controls.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = controls.length - 1;
      if (next !== null) {
        event.preventDefault();
        event.stopPropagation();
        this.focusPresetTab(controls[next], controls);
        return true;
      }
      if (!["Enter", " ", "Spacebar"].includes(event.key)) return false;
      event.preventDefault();
      event.stopPropagation();
      this.focusPresetTab(control, controls);
      this.setPresetTab(control === this.elements.presetUserTab ? "user" : "built-in");
      this.focusPresetTab(control, controls);
      return true;
    }

    presetGroups() {
      if (this.presetApi && typeof this.presetApi.searchPresets === "function") {
        return this.presetApi.searchPresets(this.presetLibrary, this.presetQuery, { tab: this.presetTab, thumbnails: true });
      }
      const builtIns = Array.isArray(this.presetApi && this.presetApi.BUILTIN_CURVE_PRESETS) ? this.presetApi.BUILTIN_CURVE_PRESETS : [];
      const users = Array.isArray(this.presetLibrary && this.presetLibrary.presets) ? this.presetLibrary.presets : [];
      const needle = this.presetQuery.toLowerCase();
      const matches = (preset) => !needle || cleanText(preset && preset.name, 200).toLowerCase().includes(needle);
      return { builtIns: this.presetTab === "user" ? [] : builtIns.filter(matches), users: this.presetTab === "built-in" ? [] : users.filter(matches) };
    }

    renderPresetList() {
      const list = this.elements.presetList;
      this.lastPresetGroups = this.presetGroups();
      const presets = this.presetTab === "user" ? this.lastPresetGroups.users : this.lastPresetGroups.builtIns;
      if (!["built-in", "user"].includes(this.presetTabFocus)) this.presetTabFocus = this.presetTab;
      if (this.elements.presetBuiltInTab) {
        this.elements.presetBuiltInTab.setAttribute("aria-selected", this.presetTab === "built-in" ? "true" : "false");
        this.elements.presetBuiltInTab.tabIndex = this.presetTabFocus === "built-in" ? 0 : -1;
      }
      if (this.elements.presetUserTab) {
        this.elements.presetUserTab.setAttribute("aria-selected", this.presetTab === "user" ? "true" : "false");
        this.elements.presetUserTab.tabIndex = this.presetTabFocus === "user" ? 0 : -1;
      }
      if (this.elements.presetEmpty) {
        this.elements.presetEmpty.hidden = presets.length > 0;
        this.elements.presetEmpty.textContent = this.presetQuery ? "No Oracle curve presets match this search." : this.presetTab === "user" ? "No user curves yet. Save the current curve as a versioned Oracle JSON preset." : "Built-in presets are unavailable.";
      }
      if (!list) return;
      list.innerHTML = "";
      const doc = list.ownerDocument || this.document;
      if (!doc || typeof doc.createElement !== "function") return;
      const folderNames = new Map((this.presetLibrary.folders || []).map((folder) => [folder.id, folder.name]));
      const visiblePresetIds = presets.map((preset) => cleanText(preset && preset.id, 160)).filter(Boolean);
      if (!visiblePresetIds.includes(this.presetFocusId)) {
        this.presetFocusId = visiblePresetIds.includes(this.selectedPresetId)
          ? this.selectedPresetId
          : visiblePresetIds[0] || "";
      }
      for (const preset of presets) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "curves-preset-card";
        button.dataset.curvePresetId = preset.id;
        button.dataset.curvePresetKind = this.presetTab;
        button.dataset.curvePresetIndex = String(presets.indexOf(preset));
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", preset.id === this.selectedPresetId ? "true" : "false");
        button.tabIndex = preset.id === this.presetFocusId ? 0 : -1;
        if (preset.id === this.selectedPresetId) button.classList.add("is-selected");
        if (this.presetTab === "user") {
          const reorderHandle = doc.createElement("span");
          reorderHandle.className = "curves-preset-card__reorder";
          reorderHandle.dataset.curvePresetReorderHandle = "true";
          reorderHandle.setAttribute("aria-hidden", "true");
          reorderHandle.title = "Drag to reorder this user preset";
          reorderHandle.textContent = "⠿";
          button.appendChild(reorderHandle);
        }
        const preview = doc.createElementNS ? doc.createElementNS(SVG_NAMESPACE, "svg") : null;
        if (preview) {
          preview.setAttribute("viewBox", "0 0 160 96");
          preview.setAttribute("aria-hidden", "true");
          preview.setAttribute("class", "curves-preset-card__preview");
          const path = doc.createElementNS(SVG_NAMESPACE, "path");
          path.setAttribute("d", preset.thumbnail && preset.thumbnail.pathData || curvePathData(preset.cubicControlPoints));
          preview.appendChild(path);
          button.appendChild(preview);
        }
        const label = doc.createElement("span");
        label.className = "curves-preset-card__name";
        label.textContent = cleanText(preset.name, 100) || "Curve preset";
        button.appendChild(label);
        if (this.presetTab === "user") {
          const details = doc.createElement("small");
          details.className = "curves-preset-card__metadata";
          const folderName = folderNames.get(preset.folderId) || "Unfiled";
          const tags = Array.isArray(preset.tags) && preset.tags.length ? ` · ${preset.tags.join(", ")}` : "";
          details.textContent = `${folderName}${tags}`;
          button.appendChild(details);
        }
        if (preset.favorite === true) {
          const favorite = doc.createElement("span");
          favorite.className = "curves-preset-card__favorite";
          favorite.setAttribute("aria-label", "Favorite");
          favorite.textContent = "★";
          button.appendChild(favorite);
        }
        list.appendChild(button);
      }
    }

    selectedPreset() {
      return [...this.lastPresetGroups.builtIns, ...this.lastPresetGroups.users].find((preset) => preset.id === this.selectedPresetId) || null;
    }

    presetButtons() {
      return this.elements.presetList
        ? Array.from(this.elements.presetList.children || []).filter((entry) => entry && entry.dataset && entry.dataset.curvePresetId)
        : [];
    }

    focusPresetButton(button, buttons = this.presetButtons()) {
      if (!button) return false;
      this.presetFocusId = cleanText(button.dataset && button.dataset.curvePresetId, 160);
      for (const candidate of buttons) candidate.tabIndex = candidate === button ? 0 : -1;
      if (typeof button.focus === "function") button.focus();
      return true;
    }

    focusPresetById(id) {
      const button = this.presetButtons().find((entry) => entry.dataset.curvePresetId === id);
      return this.focusPresetButton(button);
    }

    onPresetListKeyDown(event) {
      const button = event.target && typeof event.target.closest === "function"
        ? event.target.closest("[data-curve-preset-id]")
        : null;
      if (!button) return false;
      const buttons = this.presetButtons();
      const current = buttons.indexOf(button);
      if (current < 0) return false;
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % buttons.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      if (next !== null) {
        event.preventDefault();
        event.stopPropagation();
        this.focusPresetButton(buttons[next], buttons);
        return true;
      }
      if (!["Enter", " ", "Spacebar"].includes(event.key)) return false;
      event.preventDefault();
      event.stopPropagation();
      return this.activatePresetButton(button, true);
    }

    activatePresetButton(button, restoreFocus = false) {
      if (!button) return false;
      const id = cleanText(button.dataset && button.dataset.curvePresetId, 160);
      const preset = [...this.lastPresetGroups.builtIns, ...this.lastPresetGroups.users].find((entry) => entry.id === id);
      if (!preset) return false;
      this.selectedPresetId = id;
      this.presetFocusId = id;
      this.presetOrganizationDirty = false;
      this.controlPoints = normalizeControlPoints(preset.cubicControlPoints, this.curveMath);
      const presetMode = preset.applyMode === "native" || preset.applyMode === "native-interpolation"
        ? "native"
        : preset.applyMode === "baked" || preset.applyMode === "baked-oracle-curve"
          ? "baked"
          : null;
      if (presetMode === "native" || (presetMode === "baked" && this.snapshot.capabilities.bakedVerified)) {
        this.mode = presetMode;
      }
      this.renderPresetList();
      this.sync();
      this.scheduleRender();
      if (restoreFocus) this.focusPresetById(id);
      this.announce(`${preset.name} loaded into the local curve preview.`);
      return true;
    }

    onPresetListClick(event) {
      const reorderHandle = event.target && typeof event.target.closest === "function"
        ? event.target.closest("[data-curve-preset-reorder-handle]")
        : null;
      if (reorderHandle) return;
      const button = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-curve-preset-id]") : null;
      this.activatePresetButton(button, false);
    }

    onPresetReorderPointerDown(event) {
      if (this.presetTab !== "user" || this.destroyed || this.presetReorderDrag) return false;
      const handle = event.target && typeof event.target.closest === "function"
        ? event.target.closest("[data-curve-preset-reorder-handle]")
        : null;
      const button = handle && typeof handle.closest === "function"
        ? handle.closest("[data-curve-preset-id]")
        : null;
      if (!button) return false;
      const buttons = this.presetButtons();
      const sourceIndex = buttons.indexOf(button);
      const presetId = cleanText(button.dataset && button.dataset.curvePresetId, 160);
      if (sourceIndex < 0 || !presetId) return false;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      const list = this.elements.presetList;
      if (list && typeof list.setPointerCapture === "function" && event.pointerId != null) {
        try { list.setPointerCapture(event.pointerId); } catch (error) { /* Some UXP builds capture implicitly. */ }
      }
      this.selectedPresetId = presetId;
      this.presetFocusId = presetId;
      this.presetReorderDrag = {
        pointerId: event.pointerId,
        presetId,
        sourceIndex,
        targetIndex: sourceIndex,
      };
      if (button.classList) button.classList.add("is-reordering");
      return true;
    }

    presetReorderIndexFromClientY(clientY) {
      const buttons = this.presetButtons();
      if (!buttons.length) return -1;
      const y = finiteNumber(clientY);
      for (let index = 0; index < buttons.length; index += 1) {
        const rect = typeof buttons[index].getBoundingClientRect === "function"
          ? buttons[index].getBoundingClientRect()
          : null;
        if (rect && y < finiteNumber(rect.top) + (Math.max(0, finiteNumber(rect.height)) / 2)) return index;
      }
      return buttons.length - 1;
    }

    onPresetReorderPointerMove(event) {
      const drag = this.presetReorderDrag;
      if (!drag || (drag.pointerId != null && event.pointerId != null && drag.pointerId !== event.pointerId)) return false;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      const targetIndex = this.presetReorderIndexFromClientY(event.clientY);
      if (targetIndex < 0) return false;
      drag.targetIndex = targetIndex;
      const buttons = this.presetButtons();
      for (let index = 0; index < buttons.length; index += 1) {
        if (buttons[index].classList) buttons[index].classList.toggle("is-reorder-target", index === targetIndex);
      }
      return true;
    }

    onPresetReorderPointerUp(event) {
      const drag = this.presetReorderDrag;
      if (!drag || (drag.pointerId != null && event.pointerId != null && drag.pointerId !== event.pointerId)) return false;
      this.presetReorderDrag = null;
      const list = this.elements.presetList;
      if (list && typeof list.releasePointerCapture === "function" && drag.pointerId != null) {
        try { list.releasePointerCapture(drag.pointerId); } catch (error) { /* Capture may already be released. */ }
      }
      for (const button of this.presetButtons()) {
        if (button.classList) {
          button.classList.remove("is-reordering");
          button.classList.remove("is-reorder-target");
        }
      }
      if (drag.targetIndex === drag.sourceIndex) return true;
      this.selectedPresetId = drag.presetId;
      this.presetFocusId = drag.presetId;
      void this.invokePresetAction("reorder", { targetIndex: drag.targetIndex });
      return true;
    }

    presetHook(action) {
      if (typeof this.presetHooks[action] === "function") return this.presetHooks[action];
      if (this.presetStore && typeof this.presetStore[action] === "function") return this.presetStore[action].bind(this.presetStore);
      return null;
    }

    syncPresetOrganizationControls(selected = this.selectedPreset()) {
      const userSelected = Boolean(selected && this.presetTab === "user");
      const folders = Array.isArray(this.presetLibrary && this.presetLibrary.folders)
        ? this.presetLibrary.folders
        : [];
      if (!this.presetOrganizationDirty) {
        this.setSelectOptions(
          this.elements.presetFolder,
          [{ value: "", label: "Unfiled" }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))],
          userSelected && selected.folderId || "",
        );
        if (this.elements.presetTags) {
          this.elements.presetTags.value = userSelected && Array.isArray(selected.tags) ? selected.tags.join(", ") : "";
        }
      }
      const selectedFolderId = cleanText(this.elements.presetFolder && this.elements.presetFolder.value, 96);
      const selectedFolderExists = folders.some((folder) => folder.id === selectedFolderId);
      setDisabled(this.elements.presetFolder, !userSelected, userSelected ? "" : "Select a user preset to assign a folder.");
      setDisabled(this.elements.presetTags, !userSelected, userSelected ? "" : "Select a user preset to edit tags.");
      setDisabled(
        this.elements.presetMetadata,
        !userSelected || !this.presetHook("metadata"),
        !userSelected ? "Select a user preset to edit tags and folder." : "Preset metadata hook is unavailable.",
      );
      setDisabled(
        this.elements.presetFolderCreate,
        this.presetTab !== "user" || !this.presetHook("folderCreate"),
        this.presetTab !== "user" ? "Open the User tab to manage folders." : "Folder creation hook is unavailable.",
      );
      setDisabled(
        this.elements.presetFolderRename,
        !selectedFolderExists || !this.presetHook("folderRename"),
        !selectedFolderExists ? "Choose an assigned folder to rename." : "Folder rename hook is unavailable.",
      );
      setDisabled(
        this.elements.presetFolderDelete,
        !selectedFolderExists || !this.presetHook("folderDelete"),
        !selectedFolderExists ? "Choose an assigned folder to delete." : "Folder delete hook is unavailable.",
      );
    }

    syncPresetControls() {
      const selected = this.selectedPreset();
      const userSelected = Boolean(selected && this.presetTab === "user");
      const builtInSelected = Boolean(selected && this.presetTab === "built-in");
      const confirmAvailable = Boolean(this.confirmPresetAction);
      const controlRules = {
        create: [!this.presetHook("create"), "Preset creation needs the Oracle preset editor hook."],
        saveAs: [!this.presetHook("saveAs"), "Save As needs the Oracle preset editor hook."],
        overwrite: [!userSelected || !this.presetHook("overwrite") || !confirmAvailable, !userSelected ? "Select a user preset to overwrite. Built-ins are immutable." : !confirmAvailable ? "Overwrite requires a confirmation dialog." : "Preset overwrite hook is unavailable."],
        rename: [!userSelected || !this.presetHook("rename"), !userSelected ? "Select a user preset to rename. Built-ins are immutable." : "Preset rename hook is unavailable."],
        duplicate: [!selected || !this.presetHook("duplicate"), !selected ? "Select a preset to duplicate." : "Preset duplicate hook is unavailable."],
        delete: [!userSelected || !this.presetHook("delete") || !confirmAvailable, !userSelected ? "Select a user preset to delete. Built-ins are immutable." : !confirmAvailable ? "Delete requires a confirmation dialog." : "Preset delete hook is unavailable."],
        moveUp: [!userSelected || !this.presetHook("moveUp"), !userSelected ? "Only user presets can be reordered." : "Preset reorder hook is unavailable."],
        moveDown: [!userSelected || !this.presetHook("moveDown"), !userSelected ? "Only user presets can be reordered." : "Preset reorder hook is unavailable."],
        favorite: [!selected || !this.presetHook("favorite"), !selected ? "Select a preset to change its favorite status." : "Preset favorite hook is unavailable."],
        metadata: [!userSelected || !this.presetHook("metadata"), !userSelected ? "Select a user preset to edit tags and folder." : "Preset metadata hook is unavailable."],
        folderCreate: [this.presetTab !== "user" || !this.presetHook("folderCreate"), this.presetTab !== "user" ? "Open the User tab to manage folders." : "Folder creation hook is unavailable."],
        folderRename: [!this.presetHook("folderRename"), "Folder rename hook is unavailable."],
        folderDelete: [!this.presetHook("folderDelete"), "Folder delete hook is unavailable."],
        import: [!this.presetHook("import"), "Import needs the Oracle versioned JSON file picker hook."],
        export: [!this.presetHook("export"), "Export needs the Oracle versioned JSON save hook."],
      };
      for (const action of PRESET_ACTIONS) {
        const key = `preset${action[0].toUpperCase()}${action.slice(1)}`;
        const [disabled, reason] = controlRules[action];
        setDisabled(this.elements[key], disabled, disabled ? reason : "");
      }
      if (this.elements.presetFavorite) {
        setPressed(this.elements.presetFavorite, Boolean(selected && selected.favorite));
        this.elements.presetFavorite.textContent = selected && selected.favorite ? "Unfavorite" : "Favorite";
      }
      if (builtInSelected) {
        for (const action of ["overwrite", "rename", "delete", "moveUp", "moveDown"]) {
          const key = `preset${action[0].toUpperCase()}${action.slice(1)}`;
          setDisabled(this.elements[key], true, "Built-in Oracle curve presets are immutable.");
        }
      }
      this.syncPresetOrganizationControls(selected);
    }

    async invokePresetAction(action, extra = {}) {
      const hook = this.presetHook(action);
      const selected = this.selectedPreset();
      if (!hook) return false;
      if (["overwrite", "delete"].includes(action)) {
        if (!selected || this.presetTab !== "user" || !this.confirmPresetAction) return false;
        const confirmed = await this.confirmPresetAction({ action, preset: clone(selected) });
        if (confirmed !== true) return false;
      }
      if (["rename", "overwrite", "delete", "moveUp", "moveDown", "metadata", "reorder"].includes(action) && (!selected || this.presetTab !== "user")) return false;
      if (["duplicate", "favorite"].includes(action) && !selected) return false;
      const tags = cleanText(this.elements.presetTags && this.elements.presetTags.value, 1200)
        .split(",")
        .map((tag) => cleanText(tag, 48))
        .filter(Boolean);
      const payload = {
        action,
        preset: clone(selected),
        library: clone(this.presetLibrary),
        draft: {
          cubicControlPoints: this.controlPoints.slice(),
          applyMode: this.mode,
          sampleSettings: { budget: this.preferences.sampleBudget, warningThreshold: this.preferences.warningThreshold },
        },
        confirmed: ["overwrite", "delete"].includes(action),
        format: "oracle-json",
        tags,
        folderId: cleanText(this.elements.presetFolder && this.elements.presetFolder.value, 96) || null,
        ...extra,
      };
      try {
        const result = await hook(payload);
        if (result && result.ok === false) throw new Error(result.message || "The curve preset action failed.");
        if (result && result.cancelled === true) return false;
        if (result && result.library) this.receivePresetLibrary(result.library);
        else this.refreshPresetLibrary();
        this.toast(`Curve preset ${action} completed.`, "success");
        return true;
      } catch (error) {
        this.toast(cleanText(error && error.message, 1024) || "The curve preset action failed.", "error");
        return false;
      }
    }

    toast(message, tone) {
      try { this.onToast(cleanText(message, 1024), { tone }); } catch (error) { /* Callback isolation. */ }
    }

    announce(message) {
      try { this.onAnnounce(cleanText(message, 1024)); } catch (error) { /* Callback isolation. */ }
    }

    getState() {
      return {
        state: this.snapshot.state,
        message: this.snapshot.message,
        visible: this.visible,
        active: this.active,
        mode: this.mode,
        nativeInterpolation: this.nativeInterpolation,
        controlPoints: this.controlPoints.slice(),
        viewport: { ...this.viewport },
        selection: { ...this.selection },
        compatibleBindingCount: this.getCompatibleBindings().length,
        bindingCount: this.activeBindings.length,
        bakedVerified: this.snapshot.capabilities.bakedVerified,
        applying: this.applying,
        presetTab: this.presetTab,
        selectedPresetId: this.selectedPresetId,
      };
    }

    destroy() {
      if (this.destroyPromise) return this.destroyPromise;
      this.destroyPromise = (async () => {
        if (this.destroyed) return true;
        this.destroyed = true;
        this.refreshGeneration += 1;
        this.cancelPreviewFrame();
        if (this.drag) this.drag = null;
        this.removeListeners();
        if (typeof this.unsubscribeAdapter === "function") this.unsubscribeAdapter();
        if (typeof this.unsubscribePresets === "function") this.unsubscribePresets();
        this.unsubscribeAdapter = null;
        this.unsubscribePresets = null;
        if (this.adapter) {
          if (typeof this.adapter.setVisible === "function") this.adapter.setVisible(false);
          if (typeof this.adapter.setActive === "function") this.adapter.setActive(false);
          if (this.ownsAdapter && typeof this.adapter.destroy === "function") await this.adapter.destroy();
        }
        this.started = false;
        if (this.elements.root.dataset) this.elements.root.dataset.curvesState = "empty";
        return true;
      })();
      return this.destroyPromise;
    }
  }

  return Object.freeze({
    WORKSPACE_STATES,
    DEFAULT_CONTROL_POINTS,
    DEFAULT_PREFERENCES,
    PRESET_ACTIONS,
    CurvesWorkspaceController,
    normalizeControlPoints,
    normalizePreferences,
    normalizeSnapshot,
    normalizeElements,
    explicitBakedProof,
    curvePathData,
    viewportBox,
    formatEndpoint,
  });
});
