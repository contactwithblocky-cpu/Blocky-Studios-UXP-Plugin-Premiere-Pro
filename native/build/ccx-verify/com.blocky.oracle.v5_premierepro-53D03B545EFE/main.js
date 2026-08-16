/*
 * Oracle for Premiere Pro 2026
 * Native UXP panel controller. This file intentionally contains no Minecraft
 * or Java runtime logic; it only receives completed render handoffs.
 */

"use strict";

const BRIDGE_RECONNECT_MS = 2000;
const BRIDGE_MESSAGE_FRAME_MS = 16;
const IMPORT_RETRY_INITIAL_MS = 100;
const IMPORT_RETRY_MAX_MS = 5000;
const IMPORT_RETRY_MAX_ATTEMPTS = 8;
const EXPORT_DIRECTORY_POLL_MS = 3000;
const EXPORT_DIRECTORY_HIDDEN_POLL_MS = 10000;
const EXPORT_DIRECTORY_MAX_COUNT = 4;
const EXPORT_FILE_STABLE_SCANS = 2;
const LEGACY_RECENT_EXPORTS_STORAGE_KEY = "oracle.recentExports.v1";
const REPLAY_HISTORY_STORAGE_KEY = "oracle.replayHistory.v2";
const REPLAY_HISTORY_FILE_URL = "plugin-data:/oracle-replay-history.v2.json";
const REPLAY_HISTORY_BACKUP_FILE_URL = "plugin-data:/oracle-replay-history.v2.backup.json";
const THEME_PREFERENCES_STORAGE_KEY = "oracle.themePreferences.v1";
const GRID_SCALE_STORAGE_KEY = "oracle.gridColumns.v2";
const ORACLE_PANEL_CONTROLLER_KEY = "__oraclePanelControllerV5";
const ORACLE_PANEL_BOOTSTRAP_KEY = "__oraclePanelBootstrapV5";
const ORACLE_RUNTIME_REPLACE_EVENT = "oracle-runtime-replace";
const DEFAULT_OUTLINE_COLOR = "#3EE2E6";
const DEFAULT_BACKGROUND_COLOR = "#151515";
const REPLAY_DUPLICATE_WINDOW_MS = 15000;
const PROJECT_SCAN_SLICE_MS = 4;
const PROJECT_SCAN_YIELD_ITEMS = 24;
const PREMIERE_REPLAY_LABEL_VALUE = 9;
const PREMIERE_REPLAY_BIN_NAME = "Minecraft Replays";
const REPLAY_NATIVE_DRAG_THRESHOLD_PX = 5;
const REPLAY_NATIVE_DRAG_SUPPRESSION_MS = 650;
const LABEL_RECONCILE_TIMEOUT_MS = 15000;
const NATIVE_DROP_TRACK_ITEM_TIMEOUT_MS = 5000;
const NATIVE_DIRECTORY_WATCH_POLL_MS = 500;
const NATIVE_DIRECTORY_WATCH_MAX_ROOTS = 16;
const NATIVE_DIRECTORY_WATCH_REGISTER_LIMIT = 512;
// Development-only tracing. Production defaults must not emit private media
// paths or high-volume gesture/native snapshots into the UXP console.
const NATIVE_DRAG_DEBUG = false;
// Release builds use one canonical Hybrid addon identity. Development aliases
// are intentionally excluded so a clean host start can prove one mapped DLL.
const NATIVE_DRAG_ADDON_NAME = "oracle-native-drag.uxpaddon";
const ORACLE_PLUGIN_VERSION = "2.0.14";

let bridgeClient = null;

// This is deliberately a plain window variable so the UXP console and DOM can
// be inspected without going through a client wrapper or controller instance.
/** @typedef {"undetected" | "connecting" | "connected" | "error"} BridgeStatus */
/** @type {Window & typeof globalThis & { bridgeStatus: BridgeStatus, oracleDiagnostics?: any, oracleNativeDragAddon?: any, oracleNativeDragDiagnostics?: any, oracleWorkspacePreferences?: any, OracleOverdrivePreferences?: any, OracleOverdriveShell?: any, OraclePanelDom?: any, OracleRuntimeRegistry?: any, OracleReplayLibrary?: any, OracleReplayWorkspace?: any, OracleReplayOrganization?: any, OracleReplayLifecycleUI?: any, OracleReplayViewer?: any, OracleCurveMath?: any, OracleCurvePresets?: any, OraclePremiereCurvesAdapter?: any, OracleCurvesWorkspace?: any, OracleEffectIndex?: any, OraclePremiereEffectsAdapter?: any, OracleQuickApplyDomain?: any, OracleQuickApplyWorkspace?: any }} */
const oracleWindow = /** @type {any} */ (window);
oracleWindow.bridgeStatus = "undetected";
const oracleDiagnostics = oracleWindow.oracleDiagnostics &&
  typeof oracleWindow.oracleDiagnostics.record === "function"
  ? oracleWindow.oracleDiagnostics
  : null;

function recordOracleDiagnostic(level, code, details = {}) {
  if (!oracleDiagnostics) return null;
  try {
    return oracleDiagnostics.record(level, code, details);
  } catch (error) {
    return null;
  }
}

function oracleErrorMessage(error, fallback = "Oracle operation failed.") {
  const message = error && error.message ? String(error.message) : String(error || "");
  return message.trim().slice(0, 320) || fallback;
}

function reportOracleCritical(code, error, details = {}) {
  const entry = recordOracleDiagnostic("error", code, {
    ...details,
    message: oracleErrorMessage(error),
  });
  const safeCode = entry && entry.code ? entry.code : String(code || "ORACLE_CRITICAL_ERROR");
  const safeMessage = entry && entry.details && entry.details.message
    ? entry.details.message
    : "Oracle encountered a critical error.";
  console.error(`[Oracle][${safeCode}] ${safeMessage}`);
  return entry;
}

let premiere = null;
try {
  premiere = require("premierepro");
} catch (error) {
  // This only occurs when index.html is opened outside Premiere for visual QA.
  recordOracleDiagnostic("debug", "PREMIERE_API_UNAVAILABLE_IN_PREVIEW", {});
}

function nativeDragRuntimeInfo() {
  const userAgent = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
  const hostMatch = userAgent.match(/Premiere Pro\/([^\s]+)/i);
  const uxpMatch = userAgent.match(/Adobe UXP Runtime\/([^\s]+)/i);
  const pluginMatch = userAgent.match(/com\.blocky\.oracle\.v5\/([^\s]+)/i);
  return {
    attemptedRequireString: NATIVE_DRAG_ADDON_NAME,
    hostVersion: hostMatch ? hostMatch[1] : "unknown",
    uxpVersion: uxpMatch ? uxpMatch[1] : "unknown",
    pluginVersion: pluginMatch ? pluginMatch[1] : ORACLE_PLUGIN_VERSION,
    detectedPlatform:
      typeof navigator !== "undefined" && navigator.platform
        ? String(navigator.platform)
        : "unknown",
    userAgent,
  };
}

function nativeAddonFailure(errorCode, errorMessage, runtimeInfo, exception, extra = {}) {
  const details = Object.assign({}, runtimeInfo, extra, {
    exceptionName: exception ? String(exception.name || "Error") : null,
    exceptionMessage: exception ? String(exception.message || exception) : null,
    exceptionStack: exception && exception.stack ? String(exception.stack) : null,
  });
  const failure = nativeDragError(errorCode, errorMessage, details);
  if (typeof reportOracleCritical === "function") {
    reportOracleCritical(errorCode, errorMessage, details);
  } else if (typeof console !== "undefined" && console && typeof console.error === "function") {
    console.error(`[Oracle][${String(errorCode || "ADDON_FAILURE")}] Native addon initialization failed.`);
  }
  return failure;
}

async function loadNativeDragAddon() {
  const runtimeInfo = nativeDragRuntimeInfo();
  if (typeof recordOracleDiagnostic === "function") {
    recordOracleDiagnostic("info", "NATIVE_ADDON_REQUIRE_STARTED", runtimeInfo);
  }

  let addon;
  try {
    // Premiere 26.3's UXP 9.3 runtime resolves hybrid modules asynchronously.
    // Adobe's installed Hybrid SDK template likewise awaits require().
    addon = await require(NATIVE_DRAG_ADDON_NAME);
  } catch (error) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "ADDON_REQUIRE_FAILED",
        `Native addon require failed: ${String(error && error.message ? error.message : error)}`,
        runtimeInfo,
        error,
      ),
    };
  }

  const addonKeys = addon && typeof addon === "object" ? Object.keys(addon) : [];
  if (typeof recordOracleDiagnostic === "function") {
    recordOracleDiagnostic("debug", "NATIVE_ADDON_EXPORTS_DISCOVERED", {
      addonPresent: addon !== null && addon !== undefined,
      addonKeys,
      startNativeFileDragType: typeof (addon && addon.startNativeFileDrag),
    });
  }

  if (addon === null || addon === undefined) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "ADDON_RETURNED_NULL",
        "Native addon require returned no module object.",
        runtimeInfo,
        null,
        { addonKeys },
      ),
    };
  }

  if (
    !("startNativeFileDrag" in Object(addon)) ||
    !("nativeSelfTest" in Object(addon)) ||
    !("getNativeDragSnapshot" in Object(addon)) ||
    !("registerPackagedFonts" in Object(addon)) ||
    !("getPackagedFontStatus" in Object(addon)) ||
    !("unregisterPackagedFonts" in Object(addon))
  ) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "ADDON_EXPORT_MISSING",
        "Native addon is missing a required drag, diagnostics, or packaged-font export.",
        runtimeInfo,
        null,
        { addonKeys },
      ),
    };
  }

  if (
    typeof addon.startNativeFileDrag !== "function" ||
    typeof addon.nativeSelfTest !== "function" ||
    typeof addon.getNativeDragSnapshot !== "function" ||
    typeof addon.registerPackagedFonts !== "function" ||
    typeof addon.getPackagedFontStatus !== "function" ||
    typeof addon.unregisterPackagedFonts !== "function"
  ) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "ADDON_EXPORT_NOT_FUNCTION",
        "Native addon exports are present but are not callable functions.",
        runtimeInfo,
        null,
        {
          addonKeys,
          startNativeFileDragType: typeof addon.startNativeFileDrag,
          nativeSelfTestType: typeof addon.nativeSelfTest,
          getNativeDragSnapshotType: typeof addon.getNativeDragSnapshot,
          registerPackagedFontsType: typeof addon.registerPackagedFonts,
          getPackagedFontStatusType: typeof addon.getPackagedFontStatus,
          unregisterPackagedFontsType: typeof addon.unregisterPackagedFonts,
        },
      ),
    };
  }

  let selfTest;
  try {
    selfTest = addon.nativeSelfTest();
  } catch (error) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "ADDON_SELF_TEST_FAILED",
        `Native addon self-test threw: ${String(error && error.message ? error.message : error)}`,
        runtimeInfo,
        error,
        { addonKeys },
      ),
    };
  }
  if (typeof recordOracleDiagnostic === "function") {
    recordOracleDiagnostic("info", "NATIVE_ADDON_SELF_TEST_COMPLETED", selfTest);
  }

  if (
    !selfTest ||
    selfTest.ok !== true ||
    selfTest.architecture !== "x64" ||
    selfTest.platform !== "win32" ||
    selfTest.workerAvailable !== true
  ) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "ADDON_SELF_TEST_FAILED",
        "Native addon self-test did not report a ready Windows x64 OLE worker.",
        runtimeInfo,
        null,
        { addonKeys, selfTest },
      ),
    };
  }

  let packagedFonts;
  try {
    packagedFonts = addon.registerPackagedFonts();
  } catch (error) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "PACKAGED_FONT_REGISTRATION_FAILED",
        `Packaged font registration threw: ${String(error && error.message ? error.message : error)}`,
        runtimeInfo,
        error,
        { addonKeys, selfTest },
      ),
    };
  }
  if (
    !packagedFonts ||
    packagedFonts.ok !== true ||
    packagedFonts.processPrivate !== true ||
    packagedFonts.sessionVisible !== false ||
    packagedFonts.registrationFlags !== "FR_PRIVATE" ||
    packagedFonts.registeredFileCount !== 3 ||
    !Array.isArray(packagedFonts.items) ||
    packagedFonts.items.length !== 3 ||
    packagedFonts.items.some((item) => !item || item.registered !== true)
  ) {
    return {
      addon: null,
      diagnostic: nativeAddonFailure(
        "PACKAGED_FONT_REGISTRATION_FAILED",
        "The native addon did not validate and register all three packaged fonts process-privately.",
        runtimeInfo,
        null,
        { addonKeys, selfTest, packagedFonts },
      ),
    };
  }

  const diagnostic = Object.assign({}, runtimeInfo, {
    addonKeys,
    selfTest,
    packagedFonts,
    ok: true,
  });
  if (typeof recordOracleDiagnostic === "function") {
    recordOracleDiagnostic("info", "NATIVE_ADDON_READY", diagnostic);
  }
  return { addon, diagnostic };
}

let nativeDragAddon = null;
let nativeDragAddonDiagnostic = null;
const nativeDragAddonLoadPromise = loadNativeDragAddon().then((loadResult) => {
  nativeDragAddon = loadResult.addon;
  nativeDragAddonDiagnostic = loadResult.diagnostic;
  oracleWindow.oracleNativeDragAddon = nativeDragAddon;
  oracleWindow.oracleNativeDragDiagnostics = nativeDragAddonDiagnostic;
  return loadResult;
});

let uxpFs = null;
try {
  // Premiere UXP exposes an asynchronous, path-based fs module. The plugin-data
  // URL keeps history inside Oracle's persistent sandbox without user prompts.
  const uxpFsModuleName = "f" + "s";
  uxpFs = require(uxpFsModuleName);
} catch (error) {
  // Browser-only visual previews have no UXP fs module; localStorage remains a
  // lightweight fallback and migration source in that environment.
  recordOracleDiagnostic("debug", "PLUGIN_DATA_UNAVAILABLE_IN_PREVIEW", {});
}

let uxpOs = null;
try {
  const uxpOsModuleName = "o" + "s";
  uxpOs = require(uxpOsModuleName);
} catch (error) {
  // Browser-only previews do not expose UXP's OS module.
}

let oracleDataFolderNativePathPromise = null;

async function oracleDataFolderNativePath() {
  if (!oracleDataFolderNativePathPromise) {
    oracleDataFolderNativePathPromise = (async () => {
      const uxpModuleName = "u" + "xp";
      const uxp = require(uxpModuleName);
      const localFileSystem = uxp && uxp.storage && uxp.storage.localFileSystem;
      if (!localFileSystem || typeof localFileSystem.getDataFolder !== "function") {
        throw new Error("UXP did not expose the Oracle plugin-data folder.");
      }
      const dataFolder = await localFileSystem.getDataFolder();
      const nativePath = String(dataFolder && dataFolder.nativePath || "").trim();
      if (!isAbsoluteLocalPath(nativePath)) {
        throw new Error("UXP did not expose an absolute native plugin-data path.");
      }
      return nativePath.replace(/[\\/]+$/, "");
    })().catch((error) => {
      oracleDataFolderNativePathPromise = null;
      throw error;
    });
  }
  return oracleDataFolderNativePathPromise;
}

function createNativeStateAtomicWriter(addon) {
  if (!addon || typeof addon.writeAtomicStateFile !== "function") return null;
  return async ({ text }) => {
    const directory = await oracleDataFolderNativePath();
    const result = await addon.writeAtomicStateFile(
      `${directory}\\oracle-state.v3.json`,
      `${directory}\\oracle-state.v3.tmp.json`,
      `${directory}\\oracle-state.v3.backup.json`,
      String(text),
    );
    if (!result || result.ok !== true) {
      const error = Object.assign(
        new Error(result && result.errorMessage || "Native atomic replay-state commit failed."),
        {
          code: result && result.errorCode || "STATE_COMMIT_FAILED",
          win32Error: result && result.win32Error || 0,
        },
      );
      throw error;
    }
    return result;
  };
}

class UserFacingError extends Error {
  constructor(message, retry = false, code = "ORACLE_OPERATION_FAILED", details = {}) {
    super(message);
    this.name = "UserFacingError";
    this.retry = retry;
    this.code = code;
    this.details = details;
  }
}

function logTimelineLabelTelemetry(eventName, details = {}) {
  const record = {
    event: String(eventName || "UNKNOWN"),
    timestamp: new Date().toISOString(),
    monotonicMs: performance.now(),
    ...(NATIVE_DRAG_DEBUG ? details : {}),
  };
  if (NATIVE_DRAG_DEBUG) {
    console.log(`[Oracle Timeline Label][${record.event}]`, record);
  }
  return record;
}

class OracleLogoAnimator {
  constructor(element) {
    this.element = element;
    this.columns = 20;
    this.rows = 15;
    this.resizeTimer = null;
    this.renderedSize = 0;
    this.handleResize = this.handleResize.bind(this);
  }

  start() {
    if (!this.element) {
      return;
    }

    this.measureSize();
    this.drawStaticFrame();
    window.addEventListener("resize", this.handleResize);
  }

  handleResize() {
    if (this.resizeTimer !== null) {
      return;
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.measureSize();
      this.drawStaticFrame();
    }, 0);
  }

  measureSize() {
    const size = Math.max(1, Math.round(this.element.getBoundingClientRect().width));
    if (size !== this.renderedSize) {
      this.element.style.backgroundSize = `${size * this.columns}px ${size * this.rows}px`;
      this.renderedSize = size;
    }
  }

  drawStaticFrame() {
    const size = this.renderedSize;
    if (size < 1) {
      return;
    }
    this.element.style.backgroundPosition = "0px 0px";
  }

  stop() {
    window.removeEventListener("resize", this.handleResize);
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  }
}

function updateBridgeStatus(status) {
  if (oracleWindow.bridgeStatus === status) {
    return;
  }

  oracleWindow.bridgeStatus = status;
  const indicator = document.getElementById("bridgeStatusIndicator");
  const connected = status === "connected";
  const visualState = connected ? "connected" : status === "connecting" ? "connecting" : "disconnected";
  const label =
    status === "connected"
      ? "BRIDGE CONNECTED"
      : status === "connecting"
        ? "CONNECTING"
        : status === "error"
          ? "BRIDGE UNAVAILABLE"
          : "LISTENING FOR BRIDGE";

  if (indicator) {
    const className = `bridge-status bridge-status--${visualState}`;
    if (indicator.className !== className) {
      indicator.className = className;
    }
    indicator.title = connected
      ? "Connected to the local Oracle bridge"
      : status === "connecting"
        ? "Connecting to the local Oracle bridge"
        : "Disconnected from the local Oracle bridge";
    indicator.setAttribute("aria-label", label);
    indicator.dataset.bridgeState = status;
  }
}

// The endpoint is fixed and never sourced from project data or messages.
const BRIDGE_URL = "ws://127.0.0.1:3001";

function bridgeThumbnailRequest() {
  const replayPreferences = oracleWindow.oracleWorkspacePreferences &&
    oracleWindow.oracleWorkspacePreferences.replay
    ? oracleWindow.oracleWorkspacePreferences.replay
    : {};
  const position = Number(replayPreferences.thumbnailPosition);
  const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
  return {
    position: Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0.5,
    width: Math.round(640 * dpr),
    height: Math.round(360 * dpr),
  };
}

class OracleBridgeClient {
  constructor(onMessage) {
    this.onMessage = typeof onMessage === "function" ? onMessage : () => undefined;
    this.ws = null;
    this.reconnectTimer = null;
    this.pendingLifecycleReconciliations = [];
    this.lifecycleInFlight = null;
    this.lifecycleAckTimer = null;
    this.lifecycleRevision = Date.now();
    this.lifecycleCorrelationSequence = 0;
    this.lifecycleClientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.lifecyclePersistenceWarning = "";
    this.lifecycleQueueFailureCode = "";
    this.destroyed = false;
    this.restoreLifecycleReconciliations();
  }

  start() {
    if (this.lifecyclePersistenceWarning) {
      this.deliverLifecyclePersistenceWarning();
    }
    this.connect();
  }

  lifecycleOutboxStorage() {
    try {
      const storage = window && window.localStorage;
      return storage &&
        typeof storage.getItem === "function" &&
        typeof storage.setItem === "function" &&
        typeof storage.removeItem === "function"
        ? storage
        : null;
    } catch (error) {
      return null;
    }
  }

  restoreLifecycleReconciliations() {
    const storage = this.lifecycleOutboxStorage();
    if (!storage) {
      this.lifecyclePersistenceWarning =
        "Replay-path bridge delivery is available only for this panel session because durable UXP storage is unavailable.";
      return false;
    }
    let raw;
    try {
      raw = storage.getItem("oracle.bridge.lifecycle-outbox.v2");
      if (!raw) return true;
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored) || stored.length > 256) {
        throw new Error("invalid lifecycle outbox envelope");
      }
      let rejected = false;
      for (const value of stored) {
        const message = this.validateStoredLifecycleReconciliation(value);
        if (!message) {
          rejected = true;
          continue;
        }
        this.pendingLifecycleReconciliations.push({
          message,
          sent: false,
          lastSocket: null,
          socketAttempts: 0,
        });
        this.lifecycleRevision = Math.max(this.lifecycleRevision, message.revision);
      }
      if (rejected) {
        this.lifecyclePersistenceWarning =
          "One or more saved replay-path reconciliations were invalid and require replay verification.";
        this.persistLifecycleReconciliations();
      }
      return true;
    } catch (error) {
      this.lifecyclePersistenceWarning =
        "The saved replay-path reconciliation outbox could not be restored. Verify moved replay sources before continuing.";
      return false;
    }
  }

  validateStoredLifecycleReconciliation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const allowed = new Set([
      "event", "schema", "protocol", "version", "correlationId", "revision",
      "replayId", "oldPath", "newPath", "fileIdentity",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return null;
    const replayId = String(value.replayId || "").trim();
    const correlationId = String(value.correlationId || "").trim();
    const oldPath = normalizeReplayPath(value.oldPath);
    const newPath = normalizeReplayPath(value.newPath);
    const identity = value.fileIdentity;
    const identityKey = identity && typeof identity === "object" && !Array.isArray(identity)
      ? String(identity.key || "").trim()
      : "";
    if (
      value.event !== "replay_path_reconciled" ||
      value.schema !== "com.blocky.oracle.replay-lifecycle" ||
      value.protocol !== 2 ||
      value.version !== 2 ||
      !correlationId ||
      correlationId.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(correlationId) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !replayId ||
      replayId.length > 240 ||
      /[\u0000-\u001f\u007f]/.test(replayId) ||
      !isAbsoluteLocalPath(oldPath) ||
      !isAbsoluteLocalPath(newPath) ||
      pathKey(oldPath) === pathKey(newPath) ||
      !identity ||
      Object.keys(identity).length !== 1 ||
      !identityKey ||
      identityKey.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(identityKey)
    ) return null;
    return {
      event: "replay_path_reconciled",
      schema: "com.blocky.oracle.replay-lifecycle",
      protocol: 2,
      version: 2,
      correlationId,
      revision: value.revision,
      replayId,
      oldPath,
      newPath,
      fileIdentity: { key: identityKey },
    };
  }

  persistLifecycleReconciliations() {
    const storage = this.lifecycleOutboxStorage();
    if (!storage) return false;
    try {
      if (this.pendingLifecycleReconciliations.length === 0) {
        storage.removeItem("oracle.bridge.lifecycle-outbox.v2");
      } else {
        storage.setItem(
          "oracle.bridge.lifecycle-outbox.v2",
          JSON.stringify(this.pendingLifecycleReconciliations.map((entry) => entry.message)),
        );
      }
      return true;
    } catch (error) {
      this.lifecyclePersistenceWarning =
        "Replay-path bridge delivery could not be saved for panel restart. Keep this panel open until Oracle acknowledges the move.";
      return false;
    }
  }

  deliverLifecyclePersistenceWarning() {
    const warning = this.lifecyclePersistenceWarning;
    this.lifecyclePersistenceWarning = "";
    if (!warning) return;
    try {
      this.onMessage({
        event: "bridge_error",
        code: "LIFECYCLE_OUTBOX_NOT_DURABLE",
        message: warning,
      });
    } catch (error) {
      // The controller may already be tearing down; the send path also returns
      // false whenever persistence is unavailable.
    }
  }

  connect() {
    if (this.destroyed) {
      return;
    }

    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return;
    }

    // A reconnect attempt never retains handlers or references from the prior
    // socket. Null the shared reference before constructing the replacement.
    this.disposeSocket(this.ws, true);

    const WebSocketConstructor = window.WebSocket;
    if (typeof WebSocketConstructor !== "function") {
      updateBridgeStatus("error");
      this.scheduleReconnect();
      return;
    }

    updateBridgeStatus("connecting");
    let socket;
    try {
      socket = new WebSocketConstructor(BRIDGE_URL);
    } catch (error) {
      // UXP commonly throws while the local bridge is offline. Reconnect in the
      // background without flooding Premiere's console.
      updateBridgeStatus("undetected");
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;
    socket.onopen = () => {
      if (!this.destroyed && this.ws === socket) {
        updateBridgeStatus("connected");
        try {
          socket.send(
            JSON.stringify({
              event: "subscribe",
              client: "oracle-premiere",
              protocol: 2,
              schema: "com.blocky.oracle.bridge-subscription",
              version: 2,
              thumbnail: bridgeThumbnailRequest(),
            }),
          );
          this.flushLifecycleReconciliations(socket);
        } catch (error) {
          this.handleDisconnect(socket);
        }
      }
    };
    socket.onmessage = (event) => {
      if (!this.destroyed && this.ws === socket) {
        this.handleMessage(event && event.data);
      }
    };
    socket.onerror = () => this.handleDisconnect(socket);
    socket.onclose = () => this.handleDisconnect(socket);
  }

  handleMessage(rawData) {
    if (typeof rawData !== "string" || rawData.length > 12 * 1024 * 1024) {
      return;
    }

    let message;
    try {
      message = JSON.parse(rawData);
    } catch (error) {
      return;
    }
    if (!message || typeof message !== "object") {
      return;
    }
    const replayCount = Array.isArray(message.replays) ? message.replays.length : 0;
    const importCount = Array.isArray(message.imports) ? message.imports.length : 0;
    if (replayCount > 10000 || importCount > 1000) return;

    const bridgeEvent = String(message.event || message.type || "").toLocaleUpperCase("en-US");
    if (bridgeEvent === "REPLAY_PATH_RECONCILED_ACK") {
      if (!this.handleLifecycleAcknowledgement(message)) return;
    } else if (bridgeEvent === "REPLAY_PATH_RECONCILED_NACK") {
      if (!this.handleLifecycleNegativeAcknowledgement(message)) return;
    }

    try {
      const result = this.onMessage(message);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          if (typeof recordOracleDiagnostic === "function") {
            recordOracleDiagnostic("error", "BRIDGE_MESSAGE_HANDLER_FAILED", {
              message: oracleErrorMessage(error),
            });
          }
        });
      }
    } catch (error) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("error", "BRIDGE_MESSAGE_HANDLER_FAILED", {
          message: oracleErrorMessage(error),
        });
      }
    }
  }

  sendLifecycleReconciliation(payload) {
    this.lifecycleQueueFailureCode = "";
    const replayId = String(payload && payload.replayId || "").trim();
    const oldPath = normalizeReplayPath(payload && payload.oldPath);
    const newPath = normalizeReplayPath(payload && payload.newPath);
    const identityKey = String(payload && payload.identityKey || "").trim();
    if (
      this.destroyed ||
      !replayId ||
      replayId.length > 240 ||
      /[\u0000-\u001f\u007f]/.test(replayId) ||
      !isAbsoluteLocalPath(oldPath) ||
      !isAbsoluteLocalPath(newPath) ||
      oldPath === newPath ||
      !identityKey ||
      identityKey.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(identityKey)
    ) {
      this.lifecycleQueueFailureCode = "INVALID_RECONCILIATION";
      return false;
    }

    const prior = [...this.pendingLifecycleReconciliations]
      .reverse()
      .find((candidate) => candidate.message.replayId === replayId);
    if (prior && !prior.sent && pathKey(prior.message.newPath) === pathKey(oldPath)) {
      prior.message.newPath = newPath;
      prior.message.fileIdentity = { key: identityKey };
    } else {
      if (this.pendingLifecycleReconciliations.length >= 256) {
        this.lifecycleQueueFailureCode = "OUTBOX_FULL";
        return false;
      }
      const revision = Math.max(Date.now(), this.lifecycleRevision + 1);
      this.lifecycleRevision = revision;
      this.lifecycleCorrelationSequence += 1;
      const correlationId = `${this.lifecycleClientId}-${revision.toString(36)}-${this.lifecycleCorrelationSequence.toString(36)}`;
      this.pendingLifecycleReconciliations.push({
        message: {
          event: "replay_path_reconciled",
          schema: "com.blocky.oracle.replay-lifecycle",
          protocol: 2,
          version: 2,
          correlationId,
          revision,
          replayId,
          oldPath,
          newPath,
          fileIdentity: { key: identityKey },
        },
        sent: false,
        lastSocket: null,
        socketAttempts: 0,
      });
    }
    const durable = this.persistLifecycleReconciliations();
    if (!durable) this.lifecycleQueueFailureCode = "OUTBOX_NOT_DURABLE";
    const socket = this.ws;
    try {
      this.flushLifecycleReconciliations(socket);
    } catch (error) {
      if (socket) this.handleDisconnect(socket);
    }
    return durable;
  }

  flushLifecycleReconciliations(socket) {
    if (this.destroyed || !socket || this.ws !== socket || socket.readyState !== 1) return false;
    if (this.pendingLifecycleReconciliations.length === 0) return true;
    const entry = this.pendingLifecycleReconciliations[0];
    if (
      this.lifecycleInFlight &&
      this.lifecycleInFlight.socket === socket &&
      this.lifecycleInFlight.correlationId === entry.message.correlationId
    ) return true;
    if (entry.lastSocket !== socket) {
      entry.lastSocket = socket;
      entry.socketAttempts = 0;
    }
    socket.send(JSON.stringify(entry.message));
    entry.sent = true;
    entry.socketAttempts += 1;
    this.lifecycleInFlight = {
      socket,
      correlationId: entry.message.correlationId,
      revision: entry.message.revision,
    };
    this.armLifecycleAcknowledgementTimeout(socket, entry);
    return true;
  }

  armLifecycleAcknowledgementTimeout(socket, entry) {
    this.clearLifecycleAcknowledgementTimeout();
    this.lifecycleAckTimer = setTimeout(() => {
      this.lifecycleAckTimer = null;
      if (
        this.destroyed ||
        this.ws !== socket ||
        this.pendingLifecycleReconciliations[0] !== entry ||
        !this.lifecycleInFlight ||
        this.lifecycleInFlight.correlationId !== entry.message.correlationId
      ) return;
      this.lifecycleInFlight = null;
      if (entry.socketAttempts < 3) {
        try {
          this.flushLifecycleReconciliations(socket);
        } catch (error) {
          this.handleDisconnect(socket);
        }
      } else {
        this.handleDisconnect(socket);
      }
    }, 1500);
  }

  clearLifecycleAcknowledgementTimeout() {
    if (this.lifecycleAckTimer !== null) {
      clearTimeout(this.lifecycleAckTimer);
      this.lifecycleAckTimer = null;
    }
  }

  isMatchingLifecycleResponse(message, entry) {
    return Boolean(
      entry &&
      message &&
      message.schema === "com.blocky.oracle.replay-lifecycle" &&
      message.protocol === 2 &&
      message.version === 2 &&
      typeof message.correlationId === "string" &&
      message.correlationId === entry.message.correlationId &&
      Number.isSafeInteger(message.revision) &&
      message.revision === entry.message.revision &&
      message.replayId === entry.message.replayId
    );
  }

  handleLifecycleAcknowledgement(message) {
    const entry = this.pendingLifecycleReconciliations[0];
    if (
      !this.isMatchingLifecycleResponse(message, entry) ||
      message.applied !== true ||
      !Number.isInteger(message.updatedReplays) ||
      message.updatedReplays < 0 ||
      !Number.isInteger(message.updatedImports) ||
      message.updatedImports < 0 ||
      message.updatedReplays + message.updatedImports < 1
    ) return false;
    this.pendingLifecycleReconciliations.shift();
    this.persistLifecycleReconciliations();
    this.clearLifecycleAcknowledgementTimeout();
    this.lifecycleInFlight = null;
    const socket = this.ws;
    if (socket && socket.readyState === 1) {
      try {
        this.flushLifecycleReconciliations(socket);
      } catch (error) {
        this.handleDisconnect(socket);
      }
    }
    return true;
  }

  handleLifecycleNegativeAcknowledgement(message) {
    const entry = this.pendingLifecycleReconciliations[0];
    if (
      !this.isMatchingLifecycleResponse(message, entry) ||
      message.applied !== false ||
      typeof message.code !== "string" ||
      !message.code
    ) return false;
    this.pendingLifecycleReconciliations.shift();
    this.persistLifecycleReconciliations();
    this.clearLifecycleAcknowledgementTimeout();
    this.lifecycleInFlight = null;
    const socket = this.ws;
    if (socket && socket.readyState === 1) {
      try {
        this.flushLifecycleReconciliations(socket);
      } catch (error) {
        this.handleDisconnect(socket);
      }
    }
    return true;
  }

  handleDisconnect(socket) {
    if (this.destroyed || this.ws !== socket) {
      this.disposeSocket(socket, false);
      return;
    }

    // Removing all four property handlers prevents onerror -> onclose from
    // creating duplicate timers. Error 1006 and other expected offline states
    // intentionally produce no console output.
    this.clearLifecycleAcknowledgementTimeout();
    this.lifecycleInFlight = null;
    this.disposeSocket(socket, true);
    updateBridgeStatus("undetected");
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer !== null) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.connect();
      }
    }, BRIDGE_RECONNECT_MS);
  }

  disposeSocket(socket, closeSocket) {
    if (!socket) {
      this.ws = null;
      return;
    }

    if (this.ws === socket) {
      this.ws = null;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;

    if (closeSocket && (socket.readyState === 0 || socket.readyState === 1)) {
      try {
        socket.close(1000, "Oracle bridge reconnect");
      } catch (error) {
        // The UXP socket may already be torn down after an asynchronous error.
      }
    }
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearLifecycleAcknowledgementTimeout();
    this.lifecycleInFlight = null;
    this.disposeSocket(this.ws, true);
    this.pendingLifecycleReconciliations.length = 0;
    this.onMessage = () => undefined;
  }
}

function startBridge(onMessage) {
  destroyBridge();
  bridgeClient = new OracleBridgeClient(onMessage);
  bridgeClient.start();
}

function destroyBridge() {
  if (bridgeClient) {
    const client = bridgeClient;
    bridgeClient = null;
    client.destroy();
  }
}

class ExportDirectoryPoller {
  constructor(onReplay) {
    this.onReplay = typeof onReplay === "function" ? onReplay : () => undefined;
    this.directories = new Map();
    this.timer = null;
    this.running = false;
    this.destroyed = false;
    this.generation = 0;
  }

  start(replays) {
    if (
      this.running ||
      this.destroyed ||
      !uxpFs ||
      typeof uxpFs.readdir !== "function" ||
      typeof uxpFs.lstat !== "function"
    ) {
      return;
    }

    this.running = true;
    const downloadsDirectory = defaultExportDirectory();
    const historicalReplays = Array.isArray(replays) ? [...replays].reverse() : [];
    for (const replay of historicalReplays) {
      this.registerFile(replay && replay.filepath);
    }
    if (downloadsDirectory) this.addDirectory(downloadsDirectory);
    void this.scanAndSchedule();
  }

  registerFile(filepath) {
    if (!isAbsoluteLocalPath(filepath)) {
      return;
    }
    const directory = parentLocalDirectory(filepath);
    const filename = localBasename(filepath);
    const state = this.addDirectory(directory);
    if (state && filename) {
      const key = filename.toLocaleLowerCase();
      // A bridge event owns this exact file observation. Seed its fingerprint on
      // the next scan so a later same-name overwrite is still discoverable.
      state.seen.set(key, null);
      state.pending.delete(key);
    }
  }

  replaceTrackedFiles(replays = []) {
    if (this.destroyed) return false;
    this.generation += 1;
    this.directories.clear();
    const historicalReplays = Array.isArray(replays) ? [...replays].reverse() : [];
    for (const replay of historicalReplays) this.registerFile(replay && replay.filepath);
    const downloadsDirectory = defaultExportDirectory();
    if (downloadsDirectory) this.addDirectory(downloadsDirectory);
    return true;
  }

  addDirectory(directory) {
    const normalized = normalizeLocalDirectory(directory);
    if (!normalized) {
      return null;
    }
    const key = pathKey(normalized);
    const existing = this.directories.get(key);
    if (existing) {
      this.directories.delete(key);
      this.directories.set(key, existing);
      return existing;
    }

    if (this.directories.size >= EXPORT_DIRECTORY_MAX_COUNT) {
      const oldestKey = this.directories.keys().next().value;
      if (oldestKey !== undefined) {
        this.directories.delete(oldestKey);
      }
    }

    const state = {
      path: normalized,
      registeredAt: Date.now(),
      primed: false,
      seen: new Map(),
      pending: new Map(),
    };
    this.directories.set(key, state);
    return state;
  }

  async scanAndSchedule() {
    if (this.destroyed || !this.running) {
      return;
    }
    const generation = this.generation;
    try {
      for (const state of Array.from(this.directories.values())) {
        if (generation !== this.generation) break;
        await this.scanDirectory(state, generation);
        await yieldToHost();
      }
    } catch (error) {
      // Filesystem polling is a fallback for a missed bridge event. Permission
      // changes and transient directory failures must remain silent and cheap.
    } finally {
      this.scheduleNext();
    }
  }

  scheduleNext() {
    if (this.destroyed || !this.running || this.timer !== null) {
      return;
    }
    const hidden = typeof document.hidden === "boolean" && document.hidden;
    const delay = hidden ? EXPORT_DIRECTORY_HIDDEN_POLL_MS : EXPORT_DIRECTORY_POLL_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scanAndSchedule();
    }, delay);
  }

  async scanDirectory(state, generation = this.generation) {
    if (this.destroyed || !this.running || generation !== this.generation) return;
    let entries;
    try {
      entries = await uxpFs.readdir(state.path);
    } catch (error) {
      return;
    }
    if (this.destroyed || !this.running || generation !== this.generation) return;
    if (!Array.isArray(entries)) {
      return;
    }

    const videos = entries
      .map((entry) => ({ raw: String(entry || ""), name: localBasename(entry) }))
      .filter((entry) => entry.name && isSupportedReplayVideo(entry.name));

    for (let index = 0; index < videos.length; index += 1) {
      if (this.destroyed || !this.running || generation !== this.generation) return;
      const entry = videos[index];
      const nameKey = entry.name.toLocaleLowerCase();
      const filepath = resolveDirectoryEntryPath(state.path, entry.raw);
      let stats;
      try {
        stats = await uxpFs.lstat(filepath);
      } catch (error) {
        continue;
      }
      if (this.destroyed || !this.running || generation !== this.generation) return;
      if (stats && typeof stats.isFile === "function" && !stats.isFile()) {
        state.seen.set(nameKey, "not-a-file");
        state.pending.delete(nameKey);
        continue;
      }

      const size = Math.max(0, Number(stats && stats.size) || 0);
      const modifiedAt = fileModifiedAt(stats);
      const fingerprint = `${size}:${modifiedAt}`;
      if (state.seen.has(nameKey)) {
        const seenFingerprint = state.seen.get(nameKey);
        if (seenFingerprint === null) {
          state.seen.set(nameKey, fingerprint);
          state.pending.delete(nameKey);
          continue;
        }
        if (seenFingerprint === fingerprint) {
          state.pending.delete(nameKey);
          continue;
        }
      }
      const previous = state.pending.get(nameKey);

      if (!state.primed) {
        const recentEnough = modifiedAt > 0 && modifiedAt >= state.registeredAt - EXPORT_DIRECTORY_POLL_MS;
        if (!recentEnough) {
          state.seen.set(nameKey, fingerprint);
          continue;
        }
      }

      const stableScans =
        previous && previous.fingerprint === fingerprint && size > 0
          ? previous.stableScans + 1
          : 1;
      state.pending.set(nameKey, { fingerprint, stableScans });

      if (stableScans >= EXPORT_FILE_STABLE_SCANS) {
        state.pending.delete(nameKey);
        state.seen.set(nameKey, fingerprint);
        const thumbnail = siblingThumbnailPath(state.path, entry.name, entries);
        const completedAt = normalizeCompletedAt(modifiedAt > 0 ? modifiedAt : Date.now());
        if (this.destroyed || !this.running || generation !== this.generation) return;
        this.onReplay({
          event: "render_complete",
          id: `filesystem:${pathKey(filepath)}:${modifiedAt || Date.now()}`,
          title: replayTitleFromFilepath(filepath),
          filepath,
          fileSize: size,
          modifiedAt: completedAt,
          thumbnail,
          thumbnailError: thumbnail ? "" : "Thumbnail was not included in the filesystem fallback.",
          completedAt,
          sourceEvent: "FILESYSTEM_POLL",
        });
      }

      if ((index + 1) % 16 === 0) {
        await yieldToHost();
      }
    }
    state.primed = true;
  }

  destroy() {
    this.destroyed = true;
    this.running = false;
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.directories.clear();
    this.onReplay = () => undefined;
  }
}

class ThemePreferences {
  constructor(elements) {
    this.elements = elements;
    this.values = {
      outlineColor: DEFAULT_OUTLINE_COLOR,
      backgroundColor: DEFAULT_BACKGROUND_COLOR,
    };
    this.isOpen = false;
    this.closeTimer = null;
    this.openTimer = null;
    this.pulseTimers = new Map();
    this.onToggle = () => this.toggle();
    this.onClose = () => this.close();
    this.onReset = () => this.reset();
    this.onKeyDown = (event) => {
      if (event.key === "Escape" && this.isOpen) {
        event.preventDefault();
        this.close();
      }
    };
    this.onOutlinePicker = (event) => this.acceptColor("outlineColor", event.target.value);
    this.onBackgroundPicker = (event) =>
      this.acceptColor("backgroundColor", event.target.value);
    this.onOutlineText = (event) => this.acceptColorText("outlineColor", event.target);
    this.onBackgroundText = (event) => this.acceptColorText("backgroundColor", event.target);
    this.onOutlineBlur = () => this.syncControls();
    this.onBackgroundBlur = () => this.syncControls();
  }

  start() {
    this.values = loadThemePreferences();
    this.apply();
    this.syncControls();
    this.elements.preferencesToggle.addEventListener("click", this.onToggle);
    this.elements.preferencesClose.addEventListener("click", this.onClose);
    this.elements.preferencesBackdrop.addEventListener("click", this.onClose);
    this.elements.resetThemeButton.addEventListener("click", this.onReset);
    this.elements.outlineColorPicker.addEventListener("input", this.onOutlinePicker);
    this.elements.backgroundColorPicker.addEventListener("input", this.onBackgroundPicker);
    this.elements.outlineColorText.addEventListener("input", this.onOutlineText);
    this.elements.backgroundColorText.addEventListener("input", this.onBackgroundText);
    this.elements.outlineColorText.addEventListener("blur", this.onOutlineBlur);
    this.elements.backgroundColorText.addEventListener("blur", this.onBackgroundBlur);
    document.addEventListener("keydown", this.onKeyDown);
  }

  toggle() {
    this.pulse(this.elements.preferencesToggle);
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.isOpen = true;
    this.elements.preferencesPanel.hidden = false;
    this.elements.preferencesBackdrop.hidden = false;
    this.elements.preferencesToggle.setAttribute("aria-expanded", "true");
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.elements.preferencesPanel.classList.add("is-open");
      this.elements.preferencesBackdrop.classList.add("is-open");
    }, 0);
  }

  close() {
    if (!this.isOpen && this.elements.preferencesPanel.hidden) {
      return;
    }
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.isOpen = false;
    this.elements.preferencesPanel.classList.remove("is-open");
    this.elements.preferencesBackdrop.classList.remove("is-open");
    this.elements.preferencesToggle.setAttribute("aria-expanded", "false");
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!this.isOpen) {
        this.elements.preferencesPanel.hidden = true;
        this.elements.preferencesBackdrop.hidden = true;
      }
    }, 160);
  }

  acceptColor(property, value) {
    const normalized = normalizeHexColor(value, "");
    if (!normalized) {
      return;
    }
    this.values[property] = normalized;
    this.apply();
    this.syncControls();
    persistThemePreferences(this.values);
  }

  acceptColorText(property, input) {
    const normalized = normalizeHexColor(input.value, "");
    if (!normalized) {
      input.classList.add("is-invalid");
      return;
    }
    input.classList.remove("is-invalid");
    this.values[property] = normalized;
    this.apply();
    this.syncControls();
    persistThemePreferences(this.values);
  }

  reset() {
    this.pulse(this.elements.resetThemeButton);
    this.values = {
      outlineColor: DEFAULT_OUTLINE_COLOR,
      backgroundColor: DEFAULT_BACKGROUND_COLOR,
    };
    this.apply();
    this.syncControls();
    persistThemePreferences(this.values);
  }

  apply() {
    const root = document.documentElement;
    root.style.setProperty("--outline-color", this.values.outlineColor);
    root.style.setProperty("--outline-rgb", hexColorRgb(this.values.outlineColor));
    root.style.setProperty("--bg-color", this.values.backgroundColor);
    root.style.setProperty("--bg-rgb", hexColorRgb(this.values.backgroundColor));
  }

  syncControls() {
    const outline = this.values.outlineColor;
    const background = this.values.backgroundColor;
    this.elements.outlineColorPicker.value = outline;
    this.elements.outlineColorText.value = outline;
    this.elements.outlineColorText.classList.remove("is-invalid");
    this.elements.backgroundColorPicker.value = background;
    this.elements.backgroundColorText.value = background;
    this.elements.backgroundColorText.classList.remove("is-invalid");
  }

  pulse(element) {
    const previous = this.pulseTimers.get(element);
    if (previous) {
      clearTimeout(previous);
    }
    element.classList.remove("is-pulsing");
    const startTimer = setTimeout(() => {
      element.classList.add("is-pulsing");
      const cleanupTimer = setTimeout(() => {
        this.pulseTimers.delete(element);
        element.classList.remove("is-pulsing");
      }, 430);
      this.pulseTimers.set(element, cleanupTimer);
    }, 0);
    this.pulseTimers.set(element, startTimer);
  }

  destroy() {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
    }
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
    }
    for (const timer of this.pulseTimers.values()) {
      clearTimeout(timer);
    }
    this.pulseTimers.clear();
    this.elements.preferencesToggle.removeEventListener("click", this.onToggle);
    this.elements.preferencesClose.removeEventListener("click", this.onClose);
    this.elements.preferencesBackdrop.removeEventListener("click", this.onClose);
    this.elements.resetThemeButton.removeEventListener("click", this.onReset);
    this.elements.outlineColorPicker.removeEventListener("input", this.onOutlinePicker);
    this.elements.backgroundColorPicker.removeEventListener("input", this.onBackgroundPicker);
    this.elements.outlineColorText.removeEventListener("input", this.onOutlineText);
    this.elements.backgroundColorText.removeEventListener("input", this.onBackgroundText);
    this.elements.outlineColorText.removeEventListener("blur", this.onOutlineBlur);
    this.elements.backgroundColorText.removeEventListener("blur", this.onBackgroundBlur);
    document.removeEventListener("keydown", this.onKeyDown);
  }
}

class PremiereGateway {
  constructor(api, options = {}) {
    this.api = api;
    this.cachedItems = new Map();
    this.pendingImports = new Map();
    this.pendingLabelReconciliations = new Map();
    this.pendingSourcePreparations = new Map();
    this.dragReadySources = new Map();
    this.getImportSuppression =
      typeof options.getImportSuppression === "function"
        ? options.getImportSuppression
        : () => null;
    this.pendingReplayBins = new Map();
  }

  isAvailable() {
    return Boolean(this.api && this.api.Project);
  }

  async importReplay(filepath, suppressionOverride = undefined) {
    if (!this.isAvailable()) {
      throw new UserFacingError("Preview mode · Premiere API unavailable", false);
    }

    const importPath = validateImportFilePath(filepath);
    await this.assertMediaFileExists(importPath);

    const project = await this.api.Project.getActiveProject();
    if (!project) {
      throw new UserFacingError("Open a Premiere project to import", true);
    }

    const suppression = suppressionOverride === undefined
      ? this.getImportSuppression()
      : suppressionOverride;
    if (suppression && suppression.activationConsumed === true) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "IMPORT_SUPPRESSED_AFTER_DRAG", {
          caller: "explicit-import",
          gestureId: suppression.gestureId,
          replayId: suppression.replayId,
        });
      }
      throw new UserFacingError(
        "Import activation was suppressed because this gesture became a native drag",
        false,
        "IMPORT_SUPPRESSED_AFTER_DRAG",
        {
          caller: "explicit-import",
          gestureId: suppression.gestureId,
          replayId: suppression.replayId,
        },
      );
    }

    const prepared = await this.prepareReplaySource(importPath, {
      caller: "explicit-import",
      telemetryScope: "explicit-import",
      suppression,
    });
    return prepared.projectItem;
  }

  async performImport(project, filepath, caller = "unknown", suppressionOverride = undefined) {
    const suppression = suppressionOverride === undefined
      ? this.getImportSuppression()
      : suppressionOverride;
    const preparationCaller =
      caller === "replay-prewarm" || caller === "native-source-preparation";
    if (!preparationCaller && suppression && suppression.activationConsumed === true) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "IMPORT_SUPPRESSED_AFTER_DRAG", {
          caller,
          gestureId: suppression.gestureId,
          replayId: suppression.replayId,
        });
      }
      throw new UserFacingError(
        "Import activation was suppressed because this gesture became a native drag",
        false,
        "IMPORT_SUPPRESSED_AFTER_DRAG",
        { caller, gestureId: suppression.gestureId, replayId: suppression.replayId },
      );
    }
    const root = await project.getRootItem();
    const existing = await this.findClipByPath(root, filepath);
    if (existing) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("info", "IMPORT_REUSED_PROJECT_ITEM", { caller });
      }
      return existing;
    }

    const importDestination = await this.getOrCreateReplayBin(project, root);
    const destinationProjectItem = this.api.ProjectItem.cast(importDestination);
    let imported = false;
    try {
      // Premiere is the authoritative accessibility check here. UXP's Node-style
      // fs facade can report false for absolute paths that Premiere can import,
      // even with localFileSystem fullAccess enabled.
      imported = await project.importFiles([filepath], true, destinationProjectItem, false);
    } catch (error) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("error", "IMPORT_FAILED", {
          caller,
          message: oracleErrorMessage(error, "Premiere import failed."),
          filePathPresent: Boolean(filepath),
        });
      }
      throw new UserFacingError(
        `Premiere could not import: ${filepath}`,
        true,
        "EXPLICIT_IMPORT_FAILED",
        { filepath },
      );
    }
    if (!imported) {
      throw new UserFacingError(
        `Premiere could not import: ${filepath}`,
        true,
        "EXPLICIT_IMPORT_FAILED",
        { filepath },
      );
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const found = await this.findClipByPath(root, filepath, 2500);
      if (found) {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("info", "IMPORT_COMPLETED", {
            caller,
            destination: PREMIERE_REPLAY_BIN_NAME,
          });
        }
        return found;
      }
      await delay(125);
    }

    const foundInProject = await this.findClipByPath(root, filepath);
    if (foundInProject) {
      return foundInProject;
    }

    throw new UserFacingError(
      "Imported, but Premiere did not return the project item",
      true,
      "EXPLICIT_IMPORT_FAILED",
      { filepath },
    );
  }

  async assertMediaFileExists(filepath) {
    if (!uxpFs || typeof uxpFs.lstat !== "function") {
      return;
    }
    try {
      const stats = await uxpFs.lstat(filepath);
      if (stats && typeof stats.isFile === "function" && !stats.isFile()) {
        throw new UserFacingError(
          `Replay media is not a file: ${filepath}`,
          false,
          "REPLAY_FILE_NOT_FOUND",
          { filepath },
        );
      }
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }
      const code = String((error && error.code) || "").toUpperCase();
      const message = String((error && error.message) || "");
      if (code.includes("ENOENT") || /not found|no such file/i.test(message)) {
        throw new UserFacingError(
          `Replay media file was not found: ${filepath}`,
          false,
          "REPLAY_FILE_NOT_FOUND",
          { filepath },
        );
      }
      // Premiere remains authoritative when UXP cannot inspect an otherwise
      // valid absolute path because of a host filesystem permission boundary.
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("debug", "IMPORT_PATH_PREFLIGHT_UNAVAILABLE", {
          message: oracleErrorMessage(error, "UXP path preflight was unavailable."),
        });
      }
    }
  }

  async getOrCreateReplayBin(project, root) {
    const rootFolder = this.api.FolderItem.cast(root);
    const findReplayBin = async () => {
      const children = await Promise.resolve(rootFolder.getItems());
      for (const child of children || []) {
        if (
          child &&
          child.type === this.api.ProjectItem.TYPE_BIN &&
          String(child.name || "").toLocaleLowerCase() ===
            PREMIERE_REPLAY_BIN_NAME.toLocaleLowerCase()
        ) {
          return child;
        }
      }
      return null;
    };

    const existing = await findReplayBin();
    if (existing) {
      return existing;
    }

    const projectKey = String(project.guid || project.name || "active-project");
    const pending = this.pendingReplayBins.get(projectKey);
    if (pending) {
      return pending;
    }
    const creation = (async () => {
      let transactionSucceeded = false;
      try {
        project.lockedAccess(() => {
          transactionSucceeded = project.executeTransaction((compoundAction) => {
            const createBinAction = rootFolder.createBinAction(PREMIERE_REPLAY_BIN_NAME, true);
            compoundAction.addAction(createBinAction);
          }, `Create ${PREMIERE_REPLAY_BIN_NAME} bin`);
        });
      } catch (error) {
        throw new UserFacingError(
          `Premiere requires project locked access to create ${PREMIERE_REPLAY_BIN_NAME}`,
          false,
          "PROJECT_LOCK_REQUIRED",
          { cause: String((error && error.message) || error) },
        );
      }

      // A concurrent explicit workflow may have created the exact bin. Always
      // refresh after the transaction and prefer that exact item.
      const createdBin = await findReplayBin();
      if (createdBin) {
        return createdBin;
      }
      if (!transactionSucceeded) {
        throw new UserFacingError(
          `Premiere could not create the ${PREMIERE_REPLAY_BIN_NAME} bin`,
          false,
          "CREATE_REPLAY_BIN_FAILED",
        );
      }
      throw new UserFacingError(
        `${PREMIERE_REPLAY_BIN_NAME} was created but could not be resolved`,
        false,
        "CREATE_REPLAY_BIN_NOT_FOUND",
      );
    })().finally(() => this.pendingReplayBins.delete(projectKey));
    this.pendingReplayBins.set(projectKey, creation);
    return creation;
  }

  executeLockedTransaction(project, undoString, createActions) {
    let transactionSucceeded = false;
    try {
      project.lockedAccess(() => {
        transactionSucceeded = project.executeTransaction((compoundAction) => {
          const actions = createActions();
          for (const action of actions || []) {
            compoundAction.addAction(action);
          }
        }, undoString);
      });
    } catch (error) {
      throw new UserFacingError(
        "Premiere requires locked project access for this mutation",
        false,
        "PROJECT_LOCK_REQUIRED",
        { cause: String((error && error.message) || error), undoString },
      );
    }
    return transactionSucceeded;
  }

  async findClipByPath(root, filepath, visitLimit = 10000) {
    const matches = await this.scanProjectItemsByExactMediaPath(root, filepath, {
      visitLimit,
      firstOnly: true,
    });
    return matches[0] || null;
  }

  async scanProjectItemsByExactMediaPath(root, filepath, options = {}) {
    if (!root) {
      return [];
    }

    const wanted = pathKey(filepath);
    const visitLimit = Math.max(1, Number(options.visitLimit) || 10000);
    const firstOnly = options.firstOnly === true;
    const queue = [root];
    const matches = [];
    const matchedItems = new Set();
    let queueIndex = 0;
    let visited = 0;
    let sliceStartedAt = performance.now();
    let skippedItems = 0;

    while (queueIndex < queue.length && visited < visitLimit) {
      const parent = queue[queueIndex];
      queueIndex += 1;
      if (!parent || typeof parent.getItems !== "function") {
        continue;
      }

      let children;
      try {
        children = await Promise.resolve(parent.getItems());
      } catch (error) {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("debug", "PROJECT_BIN_ENUMERATION_SKIPPED", {});
        }
        continue;
      }

      for (const child of children || []) {
        visited += 1;
        const isFolder =
          child.type === this.api.ProjectItem.TYPE_BIN ||
          child.type === this.api.ProjectItem.TYPE_ROOT;

        if (!isFolder) {
          try {
            const clipItem = this.api.ClipProjectItem.cast(child);
            const mediaPath = await clipItem.getMediaFilePath();
            if (pathKey(mediaPath) === wanted && !matchedItems.has(clipItem)) {
              matchedItems.add(clipItem);
              matches.push(clipItem);
              if (firstOnly) {
                return matches;
              }
            }
          } catch (error) {
            skippedItems += 1;
          }
        }

        if (isFolder) {
          try {
            queue.push(this.api.FolderItem.cast(child));
          } catch (error) {
            skippedItems += 1;
          }
        }

        if (visited >= visitLimit) {
          break;
        }

        if (
          visited % PROJECT_SCAN_YIELD_ITEMS === 0 ||
          performance.now() - sliceStartedAt >= PROJECT_SCAN_SLICE_MS
        ) {
          await yieldToHost();
          sliceStartedAt = performance.now();
        }
      }
    }

    if (skippedItems > 0) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("debug", "PROJECT_ITEMS_SKIPPED", { skippedItems });
      }
    }

    return matches;
  }

  async applyPremiereLabelValue9(
    project,
    projectItem,
    _insertedTrackItems = [],
    projectItemAlreadyApplied = false,
    telemetryDetails = {},
  ) {
    if (!project || !projectItem || typeof projectItem.createSetColorLabelAction !== "function") {
      throw new UserFacingError(
        "Premiere does not expose clip label assignment for this replay",
        false,
        "LABEL_RECONCILE_FAILED",
      );
    }

    let sourceLabelAlreadyApplied = projectItemAlreadyApplied;
    if (!sourceLabelAlreadyApplied && typeof projectItem.getColorLabelIndex === "function") {
      sourceLabelAlreadyApplied =
        await projectItem.getColorLabelIndex() === PREMIERE_REPLAY_LABEL_VALUE;
    }

    let actionCommitted = false;
    if (!sourceLabelAlreadyApplied) {
      const committed = this.executeLockedTransaction(
        project,
        "Apply Oracle replay label 9",
        () => [projectItem.createSetColorLabelAction(PREMIERE_REPLAY_LABEL_VALUE)],
      );
      if (!committed) {
        throw new UserFacingError(
          "Premiere rejected internal clip label value 9",
          false,
          "LABEL_RECONCILE_FAILED",
        );
      }
      actionCommitted = true;
    }

    logTimelineLabelTelemetry("LABEL_ACTION_COMMITTED", {
      ...telemetryDetails,
      labelIndex: PREMIERE_REPLAY_LABEL_VALUE,
      actionCommitted,
      alreadyApplied: sourceLabelAlreadyApplied,
    });

    if (typeof projectItem.getColorLabelIndex === "function") {
      const appliedValue = await projectItem.getColorLabelIndex();
      if (appliedValue !== PREMIERE_REPLAY_LABEL_VALUE) {
        throw new UserFacingError(
          `Premiere reported label ${appliedValue}; expected ${PREMIERE_REPLAY_LABEL_VALUE}`,
          false,
          "LABEL_RECONCILE_FAILED",
          { appliedValue, expectedValue: PREMIERE_REPLAY_LABEL_VALUE },
        );
      }
      const labelDiagnostic = {
        scope: String(telemetryDetails.scope || "explicit-import"),
        labelIndex: appliedValue,
        expectedLabelIndex: PREMIERE_REPLAY_LABEL_VALUE,
      };
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("info", "LABEL_9_VERIFIED", labelDiagnostic);
      }
      logTimelineLabelTelemetry("LABEL_9_VERIFIED", {
        ...telemetryDetails,
        labelIndex: appliedValue,
      });
    }

    return {
      labelApplied: true,
      labelValue: PREMIERE_REPLAY_LABEL_VALUE,
      labelScope: "projectItem",
      actionCommitted,
    };
  }

  async insertReplayIntoActiveSequence(replayPayload) {
    try {
      return await this.performReplayInsert(replayPayload);
    } catch (error) {
      const normalized = normalizeError(error);
      const errorCode = normalized.code || "INSERT_FAILED";
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("error", errorCode, {
          message: normalized.message,
          filePathPresent: Boolean(replayPayload && replayPayload.filepath),
          details: normalized.details || {},
        });
      }
      return {
        ok: false,
        errorCode,
        message: normalized.message,
      };
    }
  }

  async insertAtPlayhead(replayPayload) {
    return this.insertReplayIntoActiveSequence(replayPayload);
  }

  async performReplayInsert(replayPayload) {
    if (!this.isAvailable()) {
      throw new UserFacingError(
        "Premiere API unavailable outside UXP",
        false,
        "INSERT_FAILED",
      );
    }

    const filepath = validateImportFilePath(replayPayload && replayPayload.filepath);
    const project = await this.api.Project.getActiveProject();
    if (!project) {
      throw new UserFacingError(
        "Open a Premiere project and sequence before inserting the replay",
        true,
        "NO_ACTIVE_SEQUENCE",
      );
    }

    const sequence = await project.getActiveSequence();
    if (!sequence) {
      throw new UserFacingError(
        "Open a sequence before inserting the replay",
        true,
        "NO_ACTIVE_SEQUENCE",
      );
    }

    // Resolve through the active project on every edit. This reuses the exact
    // normalized media path in the current project and avoids retaining a
    // ProjectItem from a project that was active when the card first loaded.
    const clipItem = await this.importReplay(filepath);
    const projectItem = this.api.ProjectItem.cast(clipItem);
    const projectItemId = String(await Promise.resolve(projectItem.getId()));
    const playhead = await sequence.getPlayerPosition();
    const insertedAtTicks = tickTimeTicks(playhead);
    const editor = this.api.SequenceEditor.getEditor(sequence);
    const videoTrackCount = Math.max(0, Number(await sequence.getVideoTrackCount()) || 0);
    const audioTrackCount = Math.max(0, Number(await sequence.getAudioTrackCount()) || 0);
    const initialLabelResult = await this.applyPremiereLabelValue9(project, projectItem, []);
    const attempts = [];
    for (let videoTrackIndex = 0; videoTrackIndex < videoTrackCount; videoTrackIndex += 1) {
      attempts.push({
        videoTrackIndex,
        audioTrackIndex:
          videoTrackIndex < audioTrackCount ? videoTrackIndex : audioTrackCount,
        createsFallbackTrack: videoTrackIndex >= audioTrackCount,
      });
    }
    // SequenceEditor does not expose track lock state. A rejected transaction
    // advances to the next existing video track; the final documented fallback
    // uses indices at the current counts so Premiere creates usable new tracks.
    attempts.push({
      videoTrackIndex: videoTrackCount,
      audioTrackIndex: audioTrackCount,
      createsFallbackTrack: true,
    });

    let selectedAttempt = null;
    let lastInsertError = null;
    for (const attempt of attempts) {
      try {
        const committed = this.executeLockedTransaction(
          project,
          `Insert Oracle replay: ${cleanTitle(replayPayload.title)}`,
          () => [
            editor.createInsertProjectItemAction(
              projectItem,
              playhead,
              attempt.videoTrackIndex,
              attempt.audioTrackIndex,
              false,
            ),
          ],
        );
        if (committed) {
          selectedAttempt = attempt;
          break;
        }
      } catch (error) {
        lastInsertError = error;
      }
    }

    if (!selectedAttempt) {
      const code = videoTrackCount > 0 ? "NO_UNLOCKED_VIDEO_TRACK" : "INSERT_FAILED";
      throw new UserFacingError(
        videoTrackCount > 0
          ? "No usable video track accepted the replay insertion"
          : "Premiere could not insert the replay at the playhead",
        false,
        code,
        { cause: lastInsertError && lastInsertError.message },
      );
    }

    const insertedTrackItems = await this.findInsertedTrackItems(
      sequence,
      projectItemId,
      playhead,
      selectedAttempt,
    );
    const labelResult = await this.applyPremiereLabelValue9(
      project,
      projectItem,
      insertedTrackItems,
      true,
    );
    const warnings = [];
    if (selectedAttempt.createsFallbackTrack) {
      warnings.push("The primary track rejected the edit; Premiere created fallback tracks.");
    }
    if (insertedTrackItems.length === 0) {
      warnings.push("The edit committed, but Premiere did not expose the new TrackItems for inspection.");
    }

    return {
      ok: true,
      projectItemId,
      insertedAtTicks,
      labelApplied: labelResult.labelApplied,
      labelValue: labelResult.labelValue,
      labelScope:
        labelResult.labelScope === "trackItem"
          ? labelResult.labelScope
          : initialLabelResult.labelScope,
      videoTrackIndex: selectedAttempt.videoTrackIndex,
      audioTrackIndex: selectedAttempt.audioTrackIndex,
      insertedTrackItemCount: insertedTrackItems.length,
      warnings,
    };
  }

  async findInsertedTrackItems(sequence, projectItemId, playhead, trackPlan) {
    const matches = [];
    const expectedTicks = tickTimeTicks(playhead);
    const candidates = [];
    try {
      const videoTrack = await sequence.getVideoTrack(trackPlan.videoTrackIndex);
      candidates.push(
        ...(await Promise.resolve(
          videoTrack.getTrackItems(this.api.Constants.TrackItemType.CLIP, false),
        )),
      );
    } catch (error) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("debug", "VIDEO_TRACK_ITEMS_UNAVAILABLE", {});
      }
    }
    try {
      const audioTrack = await sequence.getAudioTrack(trackPlan.audioTrackIndex);
      candidates.push(
        ...(await Promise.resolve(
          audioTrack.getTrackItems(this.api.Constants.TrackItemType.CLIP, false),
        )),
      );
    } catch (error) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("debug", "AUDIO_TRACK_ITEMS_UNAVAILABLE", {});
      }
    }

    for (const trackItem of candidates) {
      try {
        const sourceItem = await trackItem.getProjectItem();
        const sourceId = String(await Promise.resolve(sourceItem.getId()));
        const startTicks = tickTimeTicks(await trackItem.getStartTime());
        if (sourceId === projectItemId && startTicks === expectedTicks) {
          matches.push(trackItem);
        }
      } catch (error) {
        // Optional verification is best-effort; aggregate outcomes are reported by the caller.
      }
    }
    return matches;
  }

  async openInSourceMonitor(replay) {
    if (!this.isAvailable() || !this.api.SourceMonitor) {
      throw new UserFacingError("Premiere Source Monitor API is unavailable");
    }

    const clipItem = replay.projectItem || (await this.importReplay(replay.filepath));
    const projectItem = this.api.ProjectItem.cast(clipItem);
    const opened = await this.api.SourceMonitor.openProjectItem(projectItem);
    if (!opened) {
      throw new UserFacingError("Premiere could not open this clip in Source Monitor");
    }
    return true;
  }

  async setSourceMonitorPlayback(replay, playing) {
    if (!this.isAvailable() || !this.api.SourceMonitor || typeof this.api.SourceMonitor.play !== "function") {
      throw new UserFacingError("Premiere Source Monitor playback is unavailable", false, "SOURCE_MONITOR_UNAVAILABLE");
    }
    await this.openInSourceMonitor(replay);
    const accepted = await this.api.SourceMonitor.play(playing ? 1 : 0);
    if (accepted === false) {
      throw new UserFacingError(
        `Premiere could not ${playing ? "play" : "pause"} the Source Monitor`,
        true,
        "SOURCE_MONITOR_PLAYBACK_FAILED",
      );
    }
    return true;
  }

  async closeSourceMonitorClip() {
    if (!this.isAvailable() || !this.api.SourceMonitor || typeof this.api.SourceMonitor.closeClip !== "function") {
      return false;
    }
    return (await this.api.SourceMonitor.closeClip()) !== false;
  }

  async projectItemId(projectItem) {
    if (!projectItem) {
      return "";
    }
    const baseItem = this.api.ProjectItem.cast(projectItem);
    return String(await Promise.resolve(baseItem.getId()));
  }

  async findExactProjectItemsByMediaPath(absolutePath, options = {}) {
    const path = normalizeReplayPath(absolutePath);
    if (
      !path ||
      !this.api ||
      !this.api.Project ||
      !this.api.ClipProjectItem ||
      typeof this.api.Project.getActiveProject !== "function"
    ) {
      return [];
    }

    const project = options.project || await this.api.Project.getActiveProject();
    if (!project || typeof project.getRootItem !== "function") return [];
    // Native drops update the project asynchronously. Resolve a fresh root on
    // every retry rather than retaining the tree that existed before the drop.
    const root = await project.getRootItem();
    return this.scanProjectItemsByExactMediaPath(root, path);
  }

  async prepareReplaySource(absolutePath, options = {}) {
    if (!this.isAvailable()) {
      throw new UserFacingError("Preview mode · Premiere API unavailable", false);
    }

    const path = validateImportFilePath(absolutePath);
    await this.assertMediaFileExists(path);
    const project = await this.api.Project.getActiveProject();
    if (!project) {
      throw new UserFacingError("Open a Premiere project to prepare this replay", true);
    }

    const projectIdentity = String(project.guid || project.name || "active-project");
    const preparationKey = `${projectIdentity}::${pathKey(path)}`;
    const pending = this.pendingSourcePreparations.get(preparationKey);
    if (pending) {
      return pending;
    }

    const caller = String(options.caller || "replay-prewarm");
    const telemetryScope = String(options.telemetryScope || caller);
    const gestureId = String(options.gestureId || "");
    const operation = (async () => {
      const exactItems = await this.findExactProjectItemsByMediaPath(path, { project });
      let projectItem = exactItems[0] || null;
      let sourceDisposition = "found";
      if (!projectItem) {
        projectItem = await this.performImport(project, path, caller, options.suppression);
        sourceDisposition = "imported";
      }

      const normalizedMediaPath = normalizeReplayPath(
        await projectItem.getMediaFilePath(),
      );
      if (pathKey(normalizedMediaPath) !== pathKey(path)) {
        throw new UserFacingError(
          "Premiere returned a ProjectItem whose media path did not exactly match the replay",
          false,
          "PREPARED_PROJECT_ITEM_PATH_MISMATCH",
          { expectedPath: path, actualPath: normalizedMediaPath },
        );
      }

      const projectItemId = await this.projectItemId(projectItem);
      const telemetryDetails = {
        scope: telemetryScope,
        gestureId,
        absolutePath: normalizedMediaPath,
        projectItemId,
        sourceDisposition,
      };
      logTimelineLabelTelemetry("PROJECT_ITEM_FOUND_OR_IMPORTED", telemetryDetails);
      await this.applyPremiereLabelValue9(
        project,
        projectItem,
        [],
        false,
        telemetryDetails,
      );

      const ready = {
        absolutePath: normalizedMediaPath,
        normalizedPathKey: pathKey(normalizedMediaPath),
        projectIdentity,
        projectItem,
        projectItemId,
        labelIndex: PREMIERE_REPLAY_LABEL_VALUE,
        sourceDisposition,
        preparedAt: new Date().toISOString(),
      };
      this.cachedItems.set(preparationKey, projectItem);
      this.dragReadySources.set(preparationKey, ready);
      return ready;
    })().finally(() => this.pendingSourcePreparations.delete(preparationKey));

    this.pendingSourcePreparations.set(preparationKey, operation);
    return operation;
  }

  async applyAndVerifyLabel9(projectItem) {
    if (!projectItem || typeof projectItem.createSetColorLabelAction !== "function") {
      throw new UserFacingError(
        "Premiere did not expose label assignment for the dropped replay",
        false,
        "LABEL_RECONCILE_FAILED",
      );
    }
    if (
      typeof projectItem.getColorLabelIndex === "function" &&
      await projectItem.getColorLabelIndex() === PREMIERE_REPLAY_LABEL_VALUE
    ) {
      return true;
    }

    const project = await this.api.Project.getActiveProject();
    if (!project) {
      throw new UserFacingError(
        "The Premiere project closed before Oracle could apply label 9",
        false,
        "LABEL_RECONCILE_FAILED",
      );
    }
    const executed = this.executeLockedTransaction(
      project,
      "Label Oracle replay",
      () => [projectItem.createSetColorLabelAction(PREMIERE_REPLAY_LABEL_VALUE)],
    );
    if (!executed) {
      throw new UserFacingError(
        "Premiere rejected the replay label transaction",
        false,
        "LABEL_RECONCILE_FAILED",
      );
    }
    const verified =
      typeof projectItem.getColorLabelIndex === "function" &&
      await projectItem.getColorLabelIndex() === PREMIERE_REPLAY_LABEL_VALUE;
    if (!verified) {
      throw new UserFacingError(
        "Premiere did not verify color-label index 9 for the dropped replay",
        false,
        "LABEL_RECONCILE_FAILED",
      );
    }
    let verifiedPath = "";
    let verifiedProjectItemId = "";
    try {
      verifiedPath = typeof projectItem.getMediaFilePath === "function"
        ? normalizeReplayPath(await projectItem.getMediaFilePath())
        : "";
      const baseItem = this.api.ProjectItem.cast(projectItem);
      verifiedProjectItemId = String(await Promise.resolve(baseItem.getId()));
    } catch (error) {
      // Label verification is authoritative even if optional diagnostics fail.
    }
    const labelDiagnostic = {
      scope: "native-drop",
      absolutePath: verifiedPath,
      projectItemId: verifiedProjectItemId,
      labelIndex: PREMIERE_REPLAY_LABEL_VALUE,
      expectedLabelIndex: PREMIERE_REPLAY_LABEL_VALUE,
    };
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("info", "LABEL_9_VERIFIED", labelDiagnostic);
    }
    return true;
  }

  async waitForProjectItemsByExactPath(path, options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || LABEL_RECONCILE_TIMEOUT_MS);
    const initialDelayMs = Math.max(0, Number(options.initialDelayMs) || 100);
    const maxDelayMs = Math.max(initialDelayMs, Number(options.maxDelayMs) || 1200);
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const wait = typeof options.wait === "function" ? options.wait : delay;
    const deadline = now() + timeoutMs;
    let retryDelay = initialDelayMs;

    while (now() < deadline) {
      await wait(retryDelay);
      const exactItems = await this.findExactProjectItemsByMediaPath(path);
      if (exactItems.length > 0) {
        return exactItems;
      }
      retryDelay = Math.min(maxDelayMs, Math.max(1, Math.round(retryDelay * 1.65)));
    }

    throw new UserFacingError(
      `Premiere did not expose an exact-path ProjectItem within ${Math.round(timeoutMs / 1000)} seconds`,
      false,
      "LABEL_RECONCILE_FAILED",
      { absolutePath: normalizeReplayPath(path), timeoutMs },
    );
  }

  scheduleLabelReconciliation(absolutePath, callbacks = {}) {
    const path = normalizeReplayPath(absolutePath);
    const key = pathKey(path);
    let operation = this.pendingLabelReconciliations.get(key);
    if (!operation) {
      operation = (async () => {
        const projectItems = await this.waitForProjectItemsByExactPath(path);
        for (const projectItem of projectItems) {
          await this.applyAndVerifyLabel9(projectItem);
        }
        return { absolutePath: path, projectItemCount: projectItems.length };
      })().finally(() => this.pendingLabelReconciliations.delete(key));
      this.pendingLabelReconciliations.set(key, operation);
    }
    void operation.then(
      (result) => {
        if (typeof callbacks.onSuccess === "function") callbacks.onSuccess(result);
      },
      (error) => {
        if (typeof callbacks.onError === "function") callbacks.onError(normalizeError(error));
      },
    );
    return operation;
  }

  async collectActiveSequenceTrackItems() {
    const project = await this.api.Project.getActiveProject();
    const sequence = project && typeof project.getActiveSequence === "function"
      ? await project.getActiveSequence()
      : null;
    if (!sequence) {
      return { sequence: null, entries: [] };
    }

    const entries = [];
    const collect = async (kind, trackCount, getTrack) => {
      for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
        try {
          const track = await getTrack(trackIndex);
          const trackItems = await Promise.resolve(
            track.getTrackItems(this.api.Constants.TrackItemType.CLIP, false),
          );
          let ordinal = 0;
          for (const trackItem of trackItems || []) {
            try {
              const sourceProjectItem = await trackItem.getProjectItem();
              const sourceProjectItemId = await this.projectItemId(sourceProjectItem);
              const startTicks = tickTimeTicks(await trackItem.getStartTime());
              const endTicks = tickTimeTicks(await trackItem.getEndTime());
              const name = typeof trackItem.getName === "function"
                ? String(await trackItem.getName())
                : "";
              const fingerprint = [
                kind,
                trackIndex,
                startTicks,
                endTicks,
                sourceProjectItemId,
                name,
              ].join("::");
              entries.push({
                kind,
                trackIndex,
                ordinal,
                startTicks,
                endTicks,
                name,
                fingerprint,
                trackItem,
                sourceProjectItem,
                sourceProjectItemId,
              });
              ordinal += 1;
            } catch (error) {
              // A single unavailable item must not flood production diagnostics.
            }
          }
        } catch (error) {
          if (typeof recordOracleDiagnostic === "function") {
            recordOracleDiagnostic("debug", "TRACK_INSPECTION_SKIPPED", { kind, trackIndex });
          }
        }
      }
    };

    const videoTrackCount = Math.max(0, Number(await sequence.getVideoTrackCount()) || 0);
    const audioTrackCount = Math.max(0, Number(await sequence.getAudioTrackCount()) || 0);
    await collect("video", videoTrackCount, (index) => sequence.getVideoTrack(index));
    await collect("audio", audioTrackCount, (index) => sequence.getAudioTrack(index));
    return { sequence, entries };
  }

  async captureNativeDropTimelineSnapshot() {
    const snapshot = await this.collectActiveSequenceTrackItems();
    return {
      sequence: snapshot.sequence,
      fingerprints: new Set(snapshot.entries.map((entry) => entry.fingerprint)),
      entryCount: snapshot.entries.length,
      capturedAt: new Date().toISOString(),
    };
  }

  async resolveNativeDropTrackItem(preparedSource, beforeSnapshot, options = {}) {
    const timeoutMs = Math.max(
      1,
      Number(options.timeoutMs) || NATIVE_DROP_TRACK_ITEM_TIMEOUT_MS,
    );
    const wait = typeof options.wait === "function" ? options.wait : delay;
    const deadline = Date.now() + timeoutMs;
    const before = beforeSnapshot && beforeSnapshot.fingerprints instanceof Set
      ? beforeSnapshot.fingerprints
      : new Set();

    while (Date.now() < deadline) {
      const current = await this.collectActiveSequenceTrackItems();
      const created = current.entries.filter((entry) => !before.has(entry.fingerprint));
      const sourceMatch = created.find(
        (entry) =>
          entry.kind === "video" &&
          entry.sourceProjectItemId === preparedSource.projectItemId,
      ) || created.find(
        (entry) => entry.sourceProjectItemId === preparedSource.projectItemId,
      );
      const resolved = sourceMatch || created[0] || null;
      if (resolved) {
        const details = {
          absolutePath: preparedSource.absolutePath,
          preparedProjectItemId: preparedSource.projectItemId,
          trackItemProjectItemId: resolved.sourceProjectItemId,
          trackKind: resolved.kind,
          trackIndex: resolved.trackIndex,
          startTicks: resolved.startTicks,
          endTicks: resolved.endTicks,
          trackItemName: resolved.name,
        };
        logTimelineLabelTelemetry("TIMELINE_TRACK_ITEM_RESOLVED", details);
        const identityMatched =
          resolved.sourceProjectItemId === preparedSource.projectItemId;
        logTimelineLabelTelemetry("TRACK_ITEM_PROJECT_ITEM_IDENTITY_MATCHED", {
          ...details,
          identityMatched,
        });
        return { resolved: true, identityMatched, entry: resolved };
      }
      await wait(125);
    }

    const timeoutDetails = {
      absolutePath: preparedSource.absolutePath,
      preparedProjectItemId: preparedSource.projectItemId,
      resolved: false,
      timeoutMs,
    };
    logTimelineLabelTelemetry("TIMELINE_TRACK_ITEM_RESOLVED", timeoutDetails);
    logTimelineLabelTelemetry("TRACK_ITEM_PROJECT_ITEM_IDENTITY_MATCHED", {
      ...timeoutDetails,
      identityMatched: false,
    });
    return { resolved: false, identityMatched: false, entry: null };
  }

  destroy() {
    this.cachedItems.clear();
    this.pendingImports.clear();
    this.pendingLabelReconciliations.clear();
    this.pendingSourcePreparations.clear();
    this.dragReadySources.clear();
  }
}

/**
 * Bounded M4 adapter for codecs that Premiere UXP cannot decode in an HTML
 * media element. Source Monitor is global host state, so every operation first
 * proves that the ProjectItem Oracle opened is still current. Oracle must never
 * pause, seek, or close a clip the editor selected after opening the viewer.
 */
class PremiereSourceMonitorViewerAdapter {
  constructor(api) {
    this.api = api;
    this.ownedProjectItemId = "";
    this.ownedPathKey = "";
    this.ownershipToken = "";
  }

  isAvailable() {
    const sourceMonitor = this.api && this.api.SourceMonitor;
    return Boolean(
      sourceMonitor &&
      typeof sourceMonitor.openFilePath === "function" &&
      typeof sourceMonitor.getProjectItem === "function" &&
      typeof sourceMonitor.getPosition === "function" &&
      typeof sourceMonitor.setPosition === "function" &&
      typeof sourceMonitor.play === "function" &&
      typeof sourceMonitor.closeClip === "function" &&
      this.api.TickTime &&
      typeof this.api.TickTime.createWithSeconds === "function"
    );
  }

  async projectItemId(projectItem) {
    if (!projectItem || typeof projectItem.getId !== "function") return "";
    try {
      return String(await Promise.resolve(projectItem.getId()));
    } catch (error) {
      return "";
    }
  }

  async projectItemPath(projectItem) {
    if (!projectItem || !this.api || !this.api.ClipProjectItem) return "";
    try {
      const clip = this.api.ClipProjectItem.cast(projectItem);
      if (!clip || typeof clip.getMediaFilePath !== "function") return "";
      return normalizeReplayPath(await clip.getMediaFilePath());
    } catch (error) {
      return "";
    }
  }

  async currentOwnership() {
    if (!this.isAvailable()) return { owned: false, projectItemId: "", pathKey: "" };
    let current = null;
    try {
      current = await this.api.SourceMonitor.getProjectItem();
    } catch (error) {
      return { owned: false, projectItemId: "", pathKey: "" };
    }
    const projectItemId = await this.projectItemId(current);
    const mediaPath = await this.projectItemPath(current);
    const currentPathKey = pathKey(mediaPath);
    const idMatches = Boolean(this.ownedProjectItemId && projectItemId === this.ownedProjectItemId);
    const pathMatches = Boolean(this.ownedPathKey && currentPathKey === this.ownedPathKey);
    return {
      owned: Boolean(this.ownershipToken && (idMatches || pathMatches)),
      projectItemId,
      pathKey: currentPathKey,
    };
  }

  async requireOwnership() {
    const ownership = await this.currentOwnership();
    if (!ownership.owned) {
      this.clearOwnership();
      throw new UserFacingError(
        "Premiere Source Monitor changed outside Oracle. Reopen the replay to restore viewer control.",
        true,
        "SOURCE_MONITOR_OWNERSHIP_LOST",
      );
    }
    return ownership;
  }

  clearOwnership() {
    this.ownedProjectItemId = "";
    this.ownedPathKey = "";
    this.ownershipToken = "";
  }

  async open(replay) {
    if (!this.isAvailable()) {
      throw new UserFacingError(
        "Premiere Source Monitor viewer controls are unavailable.",
        false,
        "SOURCE_MONITOR_UNAVAILABLE",
      );
    }
    if (replay && replay.missingState === "missing") {
      throw new UserFacingError(
        "The replay source file is missing. Use Relink from the replay context menu, then open it again.",
        true,
        "SOURCE_MONITOR_MEDIA_MISSING",
      );
    }
    const absolutePath = validateImportFilePath(getReplayCanonicalMediaPath(replay));
    let opened;
    try {
      opened = await this.api.SourceMonitor.openFilePath(absolutePath);
    } catch (error) {
      const signature = `${error && error.code || ""} ${error && error.message || error || ""}`;
      if (/ENOENT|not\s+found|does\s+not\s+exist|no\s+such\s+file/i.test(signature)) {
        throw new UserFacingError(
          "The replay source file is missing. Use Relink from the replay context menu, then open it again.",
          true,
          "SOURCE_MONITOR_MEDIA_MISSING",
        );
      }
      if (/unsupported|codec|decoder|decode|media\s+format|invalid\s+format/i.test(signature)) {
        throw new UserFacingError(
          "Premiere Source Monitor cannot decode this replay codec. Re-export it with a Premiere-supported codec, relink the replacement, and try again. Oracle will not convert media silently.",
          true,
          "SOURCE_MONITOR_CODEC_UNSUPPORTED",
        );
      }
      throw new UserFacingError(
        "Premiere could not open this replay in Source Monitor. Verify the source file still exists; if it does, re-export it with a Premiere-supported codec and relink it. Oracle will not convert media silently.",
        true,
        "SOURCE_MONITOR_OPEN_FAILED",
      );
    }
    if (opened === false) {
      throw new UserFacingError(
        "Premiere could not open this replay in Source Monitor. Verify the source file still exists; if it does, re-export it with a Premiere-supported codec and relink it. Oracle will not convert media silently.",
        true,
        "SOURCE_MONITOR_OPEN_FAILED",
      );
    }
    const expectedPathKey = pathKey(absolutePath);
    let projectItem = null;
    let projectItemId = "";
    let mediaPath = "";
    // openFilePath() can resolve before Premiere publishes the newly opened
    // Source Monitor ProjectItem. Wait only for the exact requested path and a
    // stable ProjectItem id; never infer ownership from the boolean result.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        projectItem = await this.api.SourceMonitor.getProjectItem();
      } catch (error) {
        projectItem = null;
      }
      projectItemId = await this.projectItemId(projectItem);
      mediaPath = await this.projectItemPath(projectItem);
      if (projectItemId && pathKey(mediaPath) === expectedPathKey) break;
      if (attempt < 29) await delay(50);
    }
    if (!projectItemId || pathKey(mediaPath) !== expectedPathKey) {
      // The currently visible Source Monitor item may still belong to the
      // editor. With no exact-path identity proof Oracle must not close it.
      this.clearOwnership();
      throw new UserFacingError(
        "Premiere did not expose the selected replay as the current Source Monitor item. Reopen the replay and try again.",
        true,
        "SOURCE_MONITOR_IDENTITY_MISMATCH",
      );
    }
    this.ownedProjectItemId = projectItemId;
    this.ownedPathKey = pathKey(absolutePath);
    this.ownershipToken = `${projectItemId}:${this.ownedPathKey}`;
    const durationMs = Number(replay && replay.durationMs);
    const fps = Number(replay && replay.fps);
    return {
      mode: "source-monitor",
      ownershipToken: this.ownershipToken,
      durationSeconds: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null,
      fps: Number.isFinite(fps) && fps > 0 ? fps : null,
      supports: {
        playPause: true,
        position: true,
        seek: Number.isFinite(durationMs) && durationMs > 0,
        frameStep: Number.isFinite(fps) && fps > 0,
        mute: false,
        volume: false,
        speed: false,
        loop: false,
      },
    };
  }

  async play(playing) {
    await this.requireOwnership();
    const accepted = await this.api.SourceMonitor.play(playing ? 1 : 0);
    if (accepted === false) {
      throw new UserFacingError(
        `Premiere could not ${playing ? "play" : "pause"} the Source Monitor replay.`,
        true,
        "SOURCE_MONITOR_PLAYBACK_FAILED",
      );
    }
    return true;
  }

  async getPosition() {
    await this.requireOwnership();
    const position = await this.api.SourceMonitor.getPosition();
    const seconds = Number(position && position.seconds);
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  }

  async seek(seconds) {
    await this.requireOwnership();
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) {
      throw new UserFacingError("Choose a valid replay position.", false, "INVALID_VIEWER_POSITION");
    }
    const accepted = await this.api.SourceMonitor.setPosition(
      this.api.TickTime.createWithSeconds(value),
    );
    if (accepted === false) {
      throw new UserFacingError(
        "Premiere could not seek the Source Monitor replay.",
        true,
        "SOURCE_MONITOR_SEEK_FAILED",
      );
    }
    return this.getPosition();
  }

  async close(ownershipToken = this.ownershipToken) {
    if (!this.ownershipToken || ownershipToken !== this.ownershipToken) {
      return { ok: true, closed: false, ownershipLost: false };
    }
    const ownership = await this.currentOwnership();
    if (!ownership.owned) {
      this.clearOwnership();
      return { ok: true, closed: false, ownershipLost: true };
    }
    try {
      await this.api.SourceMonitor.play(0);
    } catch (error) {
      // closeClip is the definitive release. A pause failure must not keep a
      // known-owned clip open during source mutation or panel teardown.
    }
    const closed = await this.api.SourceMonitor.closeClip();
    if (closed === false) {
      throw new UserFacingError(
        "Premiere could not release Oracle's Source Monitor replay.",
        true,
        "SOURCE_MONITOR_RELEASE_FAILED",
      );
    }
    this.clearOwnership();
    return { ok: true, closed: true, ownershipLost: false };
  }

  destroy() {
    this.clearOwnership();
  }
}

class SmoothWheelScroller {
  constructor(viewport) {
    this.viewport = viewport;
    this.targetScrollTop = 0;
    this.animationFrame = null;
    this.lastFrameTime = null;
    this.started = false;
    this.expectedProgrammaticTop = null;
    this.ignoreProgrammaticUntil = 0;
    this.listenerOptions = /** @type {AddEventListenerOptions | boolean} */ ({
      capture: true,
      passive: false,
    });
    this.onWheel = this.onWheel.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onScroll = this.onScroll.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.animate = this.animate.bind(this);
  }

  start() {
    if (this.started || !this.viewport) return;
    this.started = true;
    this.targetScrollTop = Number(this.viewport.scrollTop) || 0;
    try {
      this.viewport.addEventListener("wheel", this.onWheel, this.listenerOptions);
    } catch (error) {
      this.listenerOptions = true;
      this.viewport.addEventListener("wheel", this.onWheel, true);
    }
    this.viewport.addEventListener("pointerdown", this.onPointerDown, true);
    this.viewport.addEventListener("scroll", this.onScroll, { passive: true });
    this.viewport.addEventListener("keydown", this.onKeyDown, true);
  }

  normalizedDelta(event) {
    const delta = Number(event && event.deltaY) || 0;
    if (!event || event.deltaMode === 0) return delta;
    if (event.deltaMode === 2) {
      return delta * Math.max(1, Number(this.viewport.clientHeight) || 1);
    }
    let lineHeight = 16;
    try {
      const computed = window.getComputedStyle && window.getComputedStyle(this.viewport);
      const parsed = Number.parseFloat(computed && computed.lineHeight);
      if (Number.isFinite(parsed) && parsed > 0) lineHeight = parsed;
    } catch (error) {
      // The stable fallback matches the panel's normal UI line box.
    }
    return delta * lineHeight;
  }

  maxScrollTop() {
    return Math.max(
      0,
      (Number(this.viewport.scrollHeight) || 0) - (Number(this.viewport.clientHeight) || 0),
    );
  }

  prefersReducedMotion() {
    const preference = String(
      document && document.documentElement && document.documentElement.dataset
        ? document.documentElement.dataset.reducedMotion || "system"
        : "system",
    );
    if (preference === "reduce") return true;
    if (preference === "allow") return false;
    try {
      return Boolean(
        window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
    } catch (error) {
      return false;
    }
  }

  onWheel(event) {
    if (!this.started || !event || event.ctrlKey) return;
    const delta = this.normalizedDelta(event);
    const maximum = this.maxScrollTop();
    if (!delta || maximum <= 0) return;

    const current = Number(this.viewport.scrollTop) || 0;
    if (this.animationFrame === null) this.targetScrollTop = current;
    const previousTarget = this.targetScrollTop;
    const nextTarget = Math.min(maximum, Math.max(0, previousTarget + delta));
    const animationStillMoving = Math.abs(previousTarget - current) >= 0.5;
    if (nextTarget === previousTarget && !animationStillMoving) return;

    event.preventDefault();
    this.targetScrollTop = nextTarget;
    if (this.prefersReducedMotion()) {
      this.cancelAnimation();
      this.setProgrammaticScrollTop(nextTarget);
      return;
    }
    if (this.animationFrame === null) {
      this.lastFrameTime = null;
      this.animationFrame = requestAnimationFrame(this.animate);
    }
  }

  animate(timestamp) {
    this.animationFrame = null;
    const now = Number(timestamp) || 0;
    const elapsed = this.lastFrameTime === null
      ? 16.667
      : Math.max(0, Math.min(64, now - this.lastFrameTime));
    this.lastFrameTime = now;
    const current = Number(this.viewport.scrollTop) || 0;
    const remaining = this.targetScrollTop - current;
    if (Math.abs(remaining) < 0.5) {
      this.setProgrammaticScrollTop(this.targetScrollTop);
      this.lastFrameTime = null;
      return;
    }
    const smoothingTimeMs = 110;
    const interpolation = 1 - Math.exp(-elapsed / smoothingTimeMs);
    this.setProgrammaticScrollTop(current + remaining * interpolation);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setProgrammaticScrollTop(value) {
    this.expectedProgrammaticTop = Number(value) || 0;
    const now = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    this.ignoreProgrammaticUntil = now + 80;
    this.viewport.scrollTop = this.expectedProgrammaticTop;
  }

  onScroll() {
    const current = Number(this.viewport.scrollTop) || 0;
    const expected = this.expectedProgrammaticTop;
    const now = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    if (
      expected !== null &&
      now <= this.ignoreProgrammaticUntil &&
      Math.abs(current - expected) < 1
    ) {
      this.expectedProgrammaticTop = null;
      return;
    }
    this.expectedProgrammaticTop = null;
    this.cancelAnimation();
    this.targetScrollTop = current;
  }

  onPointerDown() {
    this.cancelAnimation();
    this.targetScrollTop = Number(this.viewport.scrollTop) || 0;
  }

  onKeyDown(event) {
    if (!event || !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
    this.cancelAnimation();
    this.targetScrollTop = Number(this.viewport.scrollTop) || 0;
  }

  cancelAnimation() {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.lastFrameTime = null;
    this.expectedProgrammaticTop = null;
  }

  destroy() {
    if (!this.started || !this.viewport) return;
    this.started = false;
    this.cancelAnimation();
    this.viewport.removeEventListener("wheel", this.onWheel, this.listenerOptions);
    this.viewport.removeEventListener("pointerdown", this.onPointerDown, true);
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.viewport.removeEventListener("keydown", this.onKeyDown, true);
  }
}

class ReplayGridView {
  constructor(elements, callbacks) {
    this.grid = elements.grid;
    this.scroller = elements.replayScroller || elements.grid;
    this.document = callbacks.document || (typeof document !== "undefined" ? document : null);
    this.window = this.document && this.document.defaultView || (typeof window !== "undefined" ? window : null);
    this.rootScoped = Boolean(callbacks.root);
    this.interactionRoot = callbacks.root ||
      (this.scroller && typeof this.scroller.closest === "function"
        ? this.scroller.closest("[data-oracle-panel-root], .oracle-panel")
        : null) ||
      this.scroller;
    this.empty = elements.empty;
    this.recentExports = elements.recentExports;
    this.exportCount = elements.exportCount;
    this.filteredEmpty = elements.replayFilteredEmpty || null;
    this.contextMenu = elements.replayContextMenu || null;
    this.onOpen = callbacks.onOpen;
    this.onInsert = callbacks.onInsert;
    this.onNativeDragResult = callbacks.onNativeDragResult;
    this.onBlockedDrag = callbacks.onBlockedDrag;
    this.onContextAction = typeof callbacks.onContextAction === "function"
      ? callbacks.onContextAction
      : () => undefined;
    this.onSelectionChange = typeof callbacks.onSelectionChange === "function"
      ? callbacks.onSelectionChange
      : () => undefined;
    this.onAnnounce = typeof callbacks.onAnnounce === "function"
      ? callbacks.onAnnounce
      : () => undefined;
    this.onReorder = typeof callbacks.onReorder === "function"
      ? callbacks.onReorder
      : () => undefined;
    this.getContextActionState = typeof callbacks.getContextActionState === "function"
      ? callbacks.getContextActionState
      : () => null;
    this.onThumbnailUsed = typeof callbacks.onThumbnailUsed === "function"
      ? callbacks.onThumbnailUsed
      : () => undefined;
    this.hasExternalReplaySelector = typeof callbacks.getReplayById === "function";
    this.getReplayById = this.hasExternalReplaySelector
      ? callbacks.getReplayById
      : (id) => this.replayById.get(String(id || ""));
    this.getGridColumns = typeof callbacks.getGridColumns === "function"
      ? callbacks.getGridColumns
      : () => 1;
    this.virtualizer = callbacks.virtualizer || null;
    this.nativeAddon = callbacks.nativeAddon || null;
    this.nativeAddonDiagnostic = callbacks.nativeAddonDiagnostic || null;
    this.cardRecords = new Map();
    this.cardCleanup = new Map();
    this.cardBindings = new Map();
    this.replayById = new Map();
    this.sourceIds = [];
    this.layoutRows = [];
    this.layoutOffsets = [0];
    this.layoutHeight = 0;
    this.layoutColumns = 1;
    this.activeReplayId = "";
    this.selectedReplayIds = new Set();
    this.selectionAnchorId = "";
    this.manualOrderCollectionId = "";
    this.reorderState = null;
    this.pendingFlipRects = null;
    this.flipFrame = null;
    this.flipTimer = null;
    this.flipCards = [];
    this.pendingFocusReplayId = "";
    this.animatedReplayIds = new Set();
    this.renderFrame = null;
    this.resizeObserver = null;
    this.lastLayoutWidth = -1;
    this.lastLayoutColumns = -1;
    this.contextReplayId = "";
    this.contextRestoreFocus = null;
    this.dragState = null;
    this.recentConsumedGesture = null;
    this.nextGestureId = 1;
    this.openTimer = null;
    this.dragErrorTimer = null;
    this.lastCommittedCount = -1;
    this.destroyed = false;
    this.onReplayPointerDown = this.onReplayPointerDown.bind(this);
    this.onReplayPointerMove = this.onReplayPointerMove.bind(this);
    this.onReplayPointerUp = this.onReplayPointerUp.bind(this);
    this.onReplayPointerCancel = this.onReplayPointerCancel.bind(this);
    this.onReplayLostPointerCapture = this.onReplayLostPointerCapture.bind(this);
    this.onReplayClickCapture = this.onReplayClickCapture.bind(this);
    this.onReplayDoubleClickCapture = this.onReplayDoubleClickCapture.bind(this);
    this.onReplayKeyDown = this.onReplayKeyDown.bind(this);
    this.onReplayFocusIn = this.onReplayFocusIn.bind(this);
    this.onReplayContextMenu = this.onReplayContextMenu.bind(this);
    this.onReplayImageError = this.onReplayImageError.bind(this);
    this.onReplayScroll = this.onReplayScroll.bind(this);
    this.onContextMenuClick = this.onContextMenuClick.bind(this);
    this.onContextMenuKeyDown = this.onContextMenuKeyDown.bind(this);
    this.onDocumentPointerDown = this.onDocumentPointerDown.bind(this);
    this.onDocumentKeyDown = this.onDocumentKeyDown.bind(this);
    this.grid.addEventListener("pointerdown", this.onReplayPointerDown);
    this.grid.addEventListener("pointermove", this.onReplayPointerMove);
    this.grid.addEventListener("pointerup", this.onReplayPointerUp);
    this.grid.addEventListener("pointercancel", this.onReplayPointerCancel);
    this.grid.addEventListener("lostpointercapture", this.onReplayLostPointerCapture);
    this.grid.addEventListener("click", this.onReplayClickCapture, true);
    this.grid.addEventListener("dblclick", this.onReplayDoubleClickCapture, true);
    this.grid.addEventListener("keydown", this.onReplayKeyDown);
    this.grid.addEventListener("focusin", this.onReplayFocusIn);
    this.grid.addEventListener("contextmenu", this.onReplayContextMenu);
    this.grid.addEventListener("error", this.onReplayImageError, true);
    if (this.scroller && typeof this.scroller.addEventListener === "function") {
      this.scroller.addEventListener("scroll", this.onReplayScroll, { passive: true });
    }
    if (this.contextMenu) {
      this.contextMenu.addEventListener("click", this.onContextMenuClick);
      this.contextMenu.addEventListener("keydown", this.onContextMenuKeyDown);
      if (this.document) this.document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    }
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = Array.isArray(entries) ? entries[0] : null;
        const width = Number(entry && entry.contentRect && entry.contentRect.width);
        const columns = this.effectiveColumns();
        if (
          Number.isFinite(width) &&
          Math.abs(width - this.lastLayoutWidth) < 1 &&
          columns === this.lastLayoutColumns
        ) return;
        this.handleLayoutChanged();
      });
      this.resizeObserver.observe(this.grid);
    }
    if (this.document) this.document.addEventListener("keydown", this.onDocumentKeyDown, true);
  }

  ownsInteraction(event) {
    if (this.dragState) return true;
    const root = this.interactionRoot;
    if (!root || typeof root.contains !== "function") return true;
    const target = event && event.target;
    if (target) return target === root || root.contains(target);
    const active = this.document && this.document.activeElement;
    return !active || active === root || root.contains(active);
  }

  findLocalElement(originalId) {
    const root = this.interactionRoot;
    const local = root && typeof root.querySelector === "function"
      ? root.querySelector(`[data-oracle-element="${originalId}"]`) || root.querySelector(`#${originalId}`)
      : null;
    if (local || this.rootScoped || !this.document || typeof this.document.getElementById !== "function") {
      return local;
    }
    return this.document.getElementById(originalId);
  }

  render(replays, options = {}) {
    this.renderCards(replays, options);
  }

  renderCards(replays, options = {}) {
    if (this.destroyed) {
      return;
    }
    const anchor = options.resetScroll ? null : this.captureScrollAnchor();
    const nextManualOrderCollectionId = String(options.manualOrderCollectionId || "");
    const manualOrderChanged = nextManualOrderCollectionId !== this.manualOrderCollectionId;
    this.manualOrderCollectionId = nextManualOrderCollectionId;
    const source = Array.isArray(replays) ? replays : [];
    const renderedIds = new Set();
    const nextIds = [];
    if (!this.hasExternalReplaySelector) this.replayById.clear();
    for (const replay of source) {
      if (!replay || !replay.filepath) {
        continue;
      }
      const id = String(replay.id || "");
      if (!id || renderedIds.has(id)) {
        continue;
      }
      renderedIds.add(id);
      nextIds.push(id);
      if (!this.hasExternalReplaySelector) this.replayById.set(id, replay);
    }
    this.sourceIds = nextIds;
    if (!this.activeReplayId || !renderedIds.has(this.activeReplayId)) {
      this.activeReplayId = nextIds[0] || "";
    }
    let selectionChanged = false;
    for (const selected of Array.from(this.selectedReplayIds)) {
      if (!renderedIds.has(selected)) {
        this.selectedReplayIds.delete(selected);
        selectionChanged = true;
      }
    }
    if (manualOrderChanged) {
      for (const record of this.cardRecords.values()) this.disposeCard(record.card);
      this.cardRecords.clear();
    }
    this.commitLibraryState(nextIds.length, options.totalCount);
    if (options.resetScroll && this.scroller) this.scroller.scrollTop = 0;
    this.rebuildLayoutRows();
    if (anchor) this.restoreScrollAnchor(anchor);
    this.renderVirtualWindow();
    if (selectionChanged) this.notifySelectionChange();
  }

  commitLibraryState(count, totalCount = count) {
    const total = Math.max(0, Number(totalCount) || 0);
    const hasExports = total > 0;
    if (this.empty.hidden !== hasExports) {
      this.empty.hidden = hasExports;
    }
    if (this.recentExports.hidden === hasExports) {
      this.recentExports.hidden = !hasExports;
    }
    if (this.filteredEmpty) this.filteredEmpty.hidden = !hasExports || count > 0;
    if (this.lastCommittedCount !== count) {
      this.exportCount.textContent = String(count);
      this.exportCount.setAttribute(
        "aria-label",
        `${count} recent ${count === 1 ? "export" : "exports"}`,
      );
      this.lastCommittedCount = count;
    }
  }

  prependReplay(replay, totalCount, allReplays) {
    if (this.destroyed || !replay) {
      return;
    }
    const source = Array.isArray(allReplays)
      ? allReplays
      : [replay, ...this.sourceIds.map((id) => this.resolveReplay(id)).filter(Boolean)];
    this.renderCards(source, { totalCount });
  }

  updateReplays(replays, totalCount) {
    if (this.destroyed || !Array.isArray(replays)) {
      return;
    }

    if (!this.hasExternalReplaySelector) {
      for (const replay of replays) this.replayById.set(String(replay.id), replay);
    }
    this.commitLibraryState(this.sourceIds.length, totalCount);
    this.renderVirtualWindow();
  }

  resolveReplay(id) {
    const key = String(id || "");
    let replay = null;
    try {
      replay = this.getReplayById(key);
    } catch (error) {
      replay = null;
    }
    return replay || this.replayById.get(key) || null;
  }

  replayDateLabel(replay) {
    const api = oracleWindow.OracleReplayLibrary;
    return api && typeof api.dateGroupLabel === "function"
      ? api.dateGroupLabel(replay && replay.completedAt)
      : formatReplayTimestamp(replay && replay.completedAt).split(",")[0];
  }

  effectiveColumns() {
    return Math.max(1, Math.min(12, Math.round(Number(this.getGridColumns()) || 1)));
  }

  estimateCardRowHeight(columns = this.effectiveColumns()) {
    const width = Math.max(220, Number(this.grid && this.grid.clientWidth) || 760);
    const gap = 20;
    const cardWidth = Math.max(160, (width - gap * (columns - 1)) / columns);
    return Math.max(238, cardWidth * 9 / 16 + 140 + gap);
  }

  rebuildLayoutRows() {
    const columns = this.effectiveColumns();
    const cardRowHeight = this.estimateCardRowHeight(columns);
    const rows = [];
    let currentLabel = "";
    let cardRow = null;
    for (const id of this.sourceIds) {
      const replay = this.resolveReplay(id);
      if (!replay) continue;
      const label = this.replayDateLabel(replay);
      if (label !== currentLabel) {
        currentLabel = label;
        rows.push({ kind: "header", label, height: 42, ids: [] });
        cardRow = null;
      }
      if (!cardRow || cardRow.ids.length >= columns) {
        cardRow = { kind: "cards", ids: [], height: cardRowHeight };
        rows.push(cardRow);
      }
      cardRow.ids.push(id);
    }
    const offsets = [0];
    for (const row of rows) offsets.push(offsets[offsets.length - 1] + row.height);
    this.layoutRows = rows;
    this.layoutOffsets = offsets;
    this.layoutHeight = offsets[offsets.length - 1] || 0;
    this.layoutColumns = columns;
    this.grid.setAttribute("aria-rowcount", String(rows.length));
    this.grid.setAttribute("aria-colcount", String(columns));
    this.lastLayoutWidth = Number(this.grid && this.grid.clientWidth) || 0;
    this.lastLayoutColumns = columns;
  }

  captureScrollAnchor() {
    if (!this.layoutRows.length || !this.scroller) return null;
    const scrollTop = Math.max(0, Number(this.scroller.scrollTop) || 0);
    const gridTop = Math.max(0, Number(this.grid.offsetTop) || 0);
    // While the toolbar/header is still in view there is no card anchor to
    // preserve. Anchoring the first card here would jump the viewport down by
    // the entire toolbar height when responsive columns are recalculated.
    if (scrollTop < gridTop) return null;
    const top = scrollTop - gridTop;
    const rowIndex = this.rowIndexAtOffset(top);
    for (let index = rowIndex; index < this.layoutRows.length; index += 1) {
      const row = this.layoutRows[index];
      if (row.kind === "cards" && row.ids.length) {
        return { id: row.ids[0], offset: top - this.layoutOffsets[index] };
      }
    }
    return null;
  }

  restoreScrollAnchor(anchor) {
    if (!anchor || !this.scroller) return;
    const rowIndex = this.layoutRows.findIndex((row) => row.kind === "cards" && row.ids.includes(anchor.id));
    if (rowIndex < 0) return;
    this.scroller.scrollTop = Math.max(
      0,
      (Number(this.grid.offsetTop) || 0) + this.layoutOffsets[rowIndex] + Number(anchor.offset || 0),
    );
  }

  rowIndexAtOffset(offset) {
    let low = 0;
    let high = this.layoutRows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.layoutOffsets[middle + 1] <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.min(this.layoutRows.length, low);
  }

  visibleRowRange() {
    if (!this.layoutRows.length) return { start: 0, end: 0 };
    const gridTop = Number(this.grid.offsetTop) || 0;
    const viewportTop = Math.max(0, (Number(this.scroller && this.scroller.scrollTop) || 0) - gridTop);
    const viewportHeight = Math.max(240, Number(this.scroller && this.scroller.clientHeight) || 720);
    let start = Math.max(0, this.rowIndexAtOffset(viewportTop) - 3);
    let end = Math.min(this.layoutRows.length, this.rowIndexAtOffset(viewportTop + viewportHeight) + 4);
    let replayCount = 0;
    for (let index = start; index < end; index += 1) {
      if (this.layoutRows[index].kind !== "cards") continue;
      replayCount += this.layoutRows[index].ids.length;
      if (replayCount >= 180) {
        end = index + 1;
        break;
      }
    }
    return { start, end };
  }

  createVirtualSpacer(height, position) {
    const spacer = this.document.createElement("div");
    spacer.className = `replay-virtual-spacer replay-virtual-spacer--${position}`;
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.height = `${Math.max(0, height)}px`;
    return spacer;
  }

  createDateHeading(label, rowIndex, columns) {
    const row = this.document.createElement("div");
    row.className = "replay-date-row";
    row.setAttribute("role", "row");
    row.setAttribute("aria-rowindex", String(rowIndex));
    const heading = this.document.createElement("h3");
    heading.className = "replay-date-heading";
    heading.textContent = label;
    heading.setAttribute("role", "rowheader");
    heading.setAttribute("aria-colspan", String(columns));
    row.appendChild(heading);
    return row;
  }

  replaceElementChildren(element, nodes = []) {
    // Premiere's UXP DOM advertises replaceChildren(), but the host runtime can
    // leave old siblings behind. Clearing markup first is the reliable path.
    element.innerHTML = "";
    for (const node of nodes) element.appendChild(node);
  }

  renderVirtualWindow() {
    if (this.destroyed || this.dragState) return;
    if (this.lastLayoutColumns !== this.effectiveColumns() ||
        Math.abs((Number(this.grid.clientWidth) || 0) - this.lastLayoutWidth) >= 1) {
      this.rebuildLayoutRows();
    }
    const range = this.visibleRowRange();
    const nodes = [];
    const nextRecords = new Map();
    if (range.start > 0) nodes.push(this.createVirtualSpacer(this.layoutOffsets[range.start], "top"));
    for (let index = range.start; index < range.end; index += 1) {
      const row = this.layoutRows[index];
      if (row.kind === "header") {
        nodes.push(this.createDateHeading(row.label, index + 1, this.layoutColumns));
        continue;
      }
      const cardRow = this.document.createElement("div");
      cardRow.className = "replay-virtual-card-row";
      cardRow.setAttribute("role", "row");
      cardRow.setAttribute("aria-rowindex", String(index + 1));
      cardRow.style.height = `${row.height}px`;
      for (let columnIndex = 0; columnIndex < row.ids.length; columnIndex += 1) {
        const id = row.ids[columnIndex];
        const replay = this.resolveReplay(id);
        if (!replay) continue;
        const key = String(id);
        const signature = `${replayCardSignature(replay)}|manual:${this.manualOrderCollectionId}`;
        const existing = this.cardRecords.get(key);
        let card = existing && existing.signature === signature ? existing.card : null;
        if (!card && existing && this.dragState && existing.card === this.dragState.cardElement) {
          card = existing.card;
          this.updateCardState(card, replay);
        }
        if (!card) {
          if (existing) this.disposeCard(existing.card);
          card = this.renderExportCard(replay.title, replay.filepath, replay);
        }
        card.tabIndex = id === this.activeReplayId ? 0 : -1;
        card.setAttribute("aria-selected", this.selectedReplayIds.has(id) ? "true" : "false");
        card.setAttribute("aria-colindex", String(columnIndex + 1));
        nextRecords.set(key, { card, signature });
        cardRow.appendChild(card);
      }
      nodes.push(cardRow);
    }
    if (range.end < this.layoutRows.length) {
      nodes.push(this.createVirtualSpacer(this.layoutHeight - this.layoutOffsets[range.end], "bottom"));
    }
    for (const [key, record] of this.cardRecords) {
      if (!nextRecords.has(key) && (!this.dragState || record.card !== this.dragState.cardElement)) {
        this.disposeCard(record.card);
      }
    }
    this.cardRecords = nextRecords;
    this.replaceElementChildren(this.grid, nodes);
    this.applyPendingFlip();
    if (this.pendingFocusReplayId) {
      const targetId = this.pendingFocusReplayId;
      this.pendingFocusReplayId = "";
      const target = Array.from(this.cardRecords.values())
        .map((record) => record.card)
        .find((card) => String(card.dataset.replayId || "") === targetId);
      if (target && typeof target.focus === "function") target.focus();
    }
  }

  scheduleVirtualRender() {
    if (this.renderFrame !== null || this.destroyed) return;
    if (typeof requestAnimationFrame !== "function") return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderVirtualWindow();
    });
  }

  onReplayScroll() {
    this.scheduleVirtualRender();
  }

  handleLayoutChanged() {
    if (this.destroyed) return;
    const anchor = this.captureScrollAnchor();
    this.rebuildLayoutRows();
    if (anchor) this.restoreScrollAnchor(anchor);
    this.scheduleVirtualRender();
  }

  renderExportCard(fileName, fullPath, replayState = {}) {
    const replay = Object.assign(
      {
        title: cleanTitle(fileName || replayTitleFromFilepath(fullPath)),
        filepath: String(fullPath || ""),
        status: "queued",
        statusMessage: "Drag ready",
        thumbnailDataUrl: "",
        thumbnailError: "Thumbnail unavailable",
        isNew: true,
      },
      replayState,
    );
    return this.createCard(replay);
  }

  createCard(replay) {
    const draggable = replayHasCanonicalMediaPath(replay);
    const ready = draggable;
    const replayId = String(replay.id || "");
    const animateNew = replay.isNew === true && !this.animatedReplayIds.has(replayId);
    if (animateNew) this.animatedReplayIds.add(replayId);
    const card = this.document.createElement("article");
    card.className =
      `replay-card${animateNew ? " is-new" : ""}` +
      `${draggable ? "" : " replay-card--drag-disabled"}`;
    card.setAttribute("data-state", replay.status);
    card.setAttribute("data-replay-id", replayId);
    card.draggable = false;
    card.tabIndex = 0;
    card.setAttribute("role", "gridcell");
    card.setAttribute("aria-selected", this.selectedReplayIds.has(replayId) ? "true" : "false");
    card.setAttribute("aria-disabled", String(!ready));
    card.setAttribute(
      "aria-label",
      ready
        ? `${replay.title}. Click to preview in Source Monitor. Press and drag to place it on the Premiere timeline.`
        : `${replay.title}. ${statusLabel(replay)}.`,
    );
    card.title = ready
      ? "Click to preview · Drag to the Premiere timeline"
      : statusLabel(replay);

    const thumbnail = this.document.createElement("div");
    thumbnail.className = "replay-thumbnail";

    if (this.manualOrderCollectionId) {
      const reorderHandle = this.document.createElement("button");
      reorderHandle.type = "button";
      reorderHandle.className = "replay-reorder-handle";
      reorderHandle.dataset.replayReorderHandle = "true";
      reorderHandle.setAttribute("aria-label", `Reorder ${replay.title} inside this collection`);
      reorderHandle.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown Home End");
      reorderHandle.title = "Drag or use Arrow keys, Home, and End to reorder inside this collection";
      card.appendChild(reorderHandle);
    }

    let image = null;
    const thumbnailSource = replayThumbnailSource(replay);
    if (thumbnailSource) {
      if (replay.thumbnailCacheKey) this.onThumbnailUsed(replay.thumbnailCacheKey);
      image = this.document.createElement("img");
      image.alt = `${replay.title} thumbnail`;
      image.draggable = false;
      image.dataset.thumbnailError = replay.thumbnailError || "Thumbnail unavailable";
      image.src = thumbnailSource;
      if (!image.getAttribute("src")) {
        image.setAttribute("src", thumbnailSource);
      }
      thumbnail.appendChild(image);
    } else {
      thumbnail.appendChild(createThumbnailFallback(replay.thumbnailError));
    }

    const timecodeMetadata = this.document.createElement("span");
    timecodeMetadata.className = "replay-timecode-badge";
    timecodeMetadata.textContent = formatReplayTimecode(replay);
    thumbnail.appendChild(timecodeMetadata);

    const copy = this.document.createElement("div");
    copy.className = "replay-copy";

    const title = this.document.createElement("h2");
    title.className = "replay-title";
    title.textContent = replay.title;
    title.title = replay.title;

    const resolution = this.document.createElement("div");
    resolution.className = "replay-specs";
    resolution.textContent = normalizeReplayResolution(replay) || "Resolution unavailable";

    const details = this.document.createElement("div");
    details.className = "replay-details";
    const timestamp = this.document.createElement("time");
    timestamp.className = "replay-details__timestamp";
    timestamp.dateTime = replay.completedAt || "";
    timestamp.textContent = formatReplayTimestamp(replay.completedAt);
    details.appendChild(timestamp);

    const indicators = this.document.createElement("div");
    indicators.className = "replay-card__indicators";
    if (replay.favorite) indicators.appendChild(createReplayIndicator("★ Favorite", "favorite"));
    if (Array.isArray(replay.collectionIds) && replay.collectionIds.length) {
      indicators.appendChild(createReplayIndicator(
        `${replay.collectionIds.length} ${replay.collectionIds.length === 1 ? "collection" : "collections"}`,
        "collection",
      ));
    }
    if (Array.isArray(replay.tags) && replay.tags.length) {
      indicators.appendChild(createReplayIndicator(replay.tags.slice(0, 2).join(" · "), "tag"));
    }
    if (replay.missingState === "missing") {
      indicators.appendChild(createReplayIndicator("Missing source", "missing"));
    }

    const status = this.document.createElement("span");
    status.className = "replay-status sr-only";
    status.textContent = statusLabel(replay);

    copy.append(title, resolution, details);
    if (indicators.children.length) copy.appendChild(indicators);
    copy.appendChild(status);
    card.append(thumbnail, copy);

    let newCardTimer = null;
    this.cardBindings.set(card, { status });

    if (animateNew) {
      newCardTimer = setTimeout(() => {
        newCardTimer = null;
        card.classList.remove("is-new");
      }, 260);
    }

    this.cardCleanup.set(card, () => {
      if (newCardTimer !== null) {
        clearTimeout(newCardTimer);
        newCardTimer = null;
      }
    });

    return card;
  }

  updateCardState(card, replay) {
    const draggable = replayHasCanonicalMediaPath(replay);
    const ready = draggable;
    if (!this.hasExternalReplaySelector) this.replayById.set(String(replay.id), replay);
    card.setAttribute("data-state", replay.status);
    card.draggable = false;
    card.classList.toggle("replay-card--drag-disabled", !draggable);
    card.setAttribute("aria-disabled", String(!ready));
    card.setAttribute(
      "aria-label",
      ready
        ? `${replay.title}. Click to preview in Source Monitor. Press and drag to place it on the Premiere timeline.`
        : `${replay.title}. ${statusLabel(replay)}.`,
    );
    card.title = ready
      ? "Click to preview · Drag to the Premiere timeline"
      : statusLabel(replay);

    const bindings = this.cardBindings.get(card);
    if (bindings && bindings.status.textContent !== statusLabel(replay)) {
      bindings.status.textContent = statusLabel(replay);
    }
  }

  onReplayImageError(event) {
    const image = event && event.target;
    if (!image || String(image.tagName || "").toUpperCase() !== "IMG") return;
    const thumbnail = image.closest && image.closest(".replay-thumbnail");
    if (!thumbnail || !this.grid.contains(thumbnail)) return;
    const reason = image.dataset && image.dataset.thumbnailError;
    image.remove();
    if (!thumbnail.querySelector(".replay-thumbnail__fallback")) {
      thumbnail.prepend(createThumbnailFallback(reason));
    }
  }

  disposeCard(card) {
    const cleanup = this.cardCleanup.get(card);
    if (cleanup) {
      cleanup();
      this.cardCleanup.delete(card);
    }
    this.cardBindings.delete(card);
    card.remove();
    card.innerHTML = "";
  }

  getSelectedReplayIds() {
    return this.sourceIds.filter((id) => this.selectedReplayIds.has(id));
  }

  getSelectedReplays() {
    return this.getSelectedReplayIds().map((id) => this.resolveReplay(id)).filter(Boolean);
  }

  notifySelectionChange() {
    this.onSelectionChange(this.getSelectedReplayIds(), this.getSelectedReplays());
  }

  updateVisibleSelection() {
    for (const record of this.cardRecords.values()) {
      const id = String(record.card.dataset.replayId || "");
      record.card.tabIndex = id === this.activeReplayId ? 0 : -1;
      record.card.setAttribute("aria-selected", this.selectedReplayIds.has(id) ? "true" : "false");
    }
  }

  setSelection(ids, activeId = "", anchorId = "") {
    const allowed = new Set(this.sourceIds);
    const next = new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => allowed.has(id)));
    const before = this.getSelectedReplayIds().join("\n");
    this.selectedReplayIds = next;
    const requestedActive = String(activeId || "");
    if (requestedActive && allowed.has(requestedActive)) this.activeReplayId = requestedActive;
    else if (!allowed.has(this.activeReplayId)) this.activeReplayId = this.sourceIds[0] || "";
    const requestedAnchor = String(anchorId || "");
    if (requestedAnchor && allowed.has(requestedAnchor)) this.selectionAnchorId = requestedAnchor;
    else if (!allowed.has(this.selectionAnchorId)) this.selectionAnchorId = this.activeReplayId;
    this.updateVisibleSelection();
    if (before !== this.getSelectedReplayIds().join("\n")) this.notifySelectionChange();
  }

  applySelectionGesture(replayId, options = {}) {
    const id = String(replayId || "");
    if (!id || !this.sourceIds.includes(id)) return;
    if (options.range) {
      const anchor = this.sourceIds.includes(this.selectionAnchorId)
        ? this.selectionAnchorId
        : this.activeReplayId || id;
      const start = this.sourceIds.indexOf(anchor);
      const end = this.sourceIds.indexOf(id);
      const range = this.sourceIds.slice(Math.min(start, end), Math.max(start, end) + 1);
      const ids = options.additive ? new Set(this.selectedReplayIds) : new Set();
      for (const value of range) ids.add(value);
      this.setSelection(Array.from(ids), id, anchor);
      return;
    }
    if (options.toggle) {
      const ids = new Set(this.selectedReplayIds);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      this.setSelection(Array.from(ids), id, id);
      return;
    }
    this.setSelection([id], id, id);
  }

  clearSelection() {
    this.setSelection([], this.activeReplayId, this.activeReplayId);
  }

  captureFlipRects() {
    const rects = new Map();
    for (const [id, record] of this.cardRecords) {
      if (record.card && typeof record.card.getBoundingClientRect === "function") {
        const rect = record.card.getBoundingClientRect();
        rects.set(id, { left: Number(rect.left) || 0, top: Number(rect.top) || 0 });
      }
    }
    return rects;
  }

  prefersReducedMotion() {
    const preference = oracleWindow.oracleWorkspacePreferences &&
      oracleWindow.oracleWorkspacePreferences.appearance &&
      oracleWindow.oracleWorkspacePreferences.appearance.reducedMotion;
    if (preference === "reduce") return true;
    if (preference === "allow") return false;
    return Boolean(this.window && typeof this.window.matchMedia === "function" && this.window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  applyPendingFlip() {
    const before = this.pendingFlipRects;
    this.pendingFlipRects = null;
    if (!before || this.prefersReducedMotion()) return;
    const moved = [];
    for (const [id, record] of this.cardRecords) {
      const previous = before.get(id);
      if (!previous || !record.card || typeof record.card.getBoundingClientRect !== "function") continue;
      const next = record.card.getBoundingClientRect();
      const deltaX = previous.left - (Number(next.left) || 0);
      const deltaY = previous.top - (Number(next.top) || 0);
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      record.card.dataset.flip = "true";
      record.card.style.transition = "none";
      record.card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      moved.push(record.card);
    }
    if (!moved.length || typeof requestAnimationFrame !== "function") return;
    if (this.flipFrame !== null) cancelAnimationFrame(this.flipFrame);
    if (this.flipTimer !== null) clearTimeout(this.flipTimer);
    this.flipCards = moved;
    this.flipFrame = requestAnimationFrame(() => {
      this.flipFrame = null;
      for (const card of this.flipCards) {
        card.style.transition = "transform 170ms cubic-bezier(.2,.8,.2,1)";
        card.style.transform = "translate(0, 0)";
      }
      this.flipTimer = setTimeout(() => {
        this.flipTimer = null;
        for (const card of this.flipCards) {
          card.style.removeProperty("transition");
          card.style.removeProperty("transform");
          delete card.dataset.flip;
        }
        this.flipCards = [];
      }, 190);
    });
  }

  beginInternalReorder(event) {
    const handle = event && event.target && event.target.closest
      ? event.target.closest("[data-replay-reorder-handle]")
      : null;
    if (!handle || !this.manualOrderCollectionId || event.button !== 0 || event.isPrimary === false) return false;
    const card = closestReplayCard(handle, this.grid);
    if (!card) return false;
    const replayId = String(card.dataset.replayId || "");
    event.preventDefault();
    event.stopPropagation();
    this.applySelectionGesture(replayId, { toggle: Boolean(event.ctrlKey || event.metaKey), range: Boolean(event.shiftKey) });
    this.reorderState = {
      pointerId: event.pointerId,
      handle,
      card,
      replayId,
      targetId: replayId,
      placement: "before",
      collectionId: this.manualOrderCollectionId,
      beforeRects: this.captureFlipRects(),
    };
    card.classList.add("is-reorder-source");
    if (typeof handle.setPointerCapture === "function") {
      try { handle.setPointerCapture(event.pointerId); } catch (error) { /* UXP may not expose capture. */ }
    }
    return true;
  }

  updateInternalReorder(event) {
    const state = this.reorderState;
    if (!state || !event || event.pointerId !== state.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    state.targetId = state.replayId;
    state.placement = "before";
    const hit = this.document && typeof this.document.elementFromPoint === "function"
      ? this.document.elementFromPoint(Number(event.clientX) || 0, Number(event.clientY) || 0)
      : event.target;
    const card = closestReplayCard(hit, this.grid);
    for (const record of this.cardRecords.values()) record.card.classList.remove("is-reorder-target");
    if (card) {
      const targetId = String(card.dataset.replayId || "");
      if (targetId && targetId !== state.replayId) {
        const rect = card.getBoundingClientRect
          ? card.getBoundingClientRect()
          : { left: 0, top: 0, width: 1, height: 1 };
        const sourceRect = state.card.getBoundingClientRect
          ? state.card.getBoundingClientRect()
          : { top: Number(rect.top) || 0, height: Number(rect.height) || 1 };
        const sameRow = Math.abs(Number(sourceRect.top) - Number(rect.top)) < Math.max(1, Number(rect.height) || 1) / 2;
        state.targetId = targetId;
        state.placement = sameRow
          ? (Number(event.clientX) >= Number(rect.left) + Number(rect.width || 1) / 2 ? "after" : "before")
          : (Number(event.clientY) >= Number(rect.top) + Number(rect.height || 1) / 2 ? "after" : "before");
        card.classList.add("is-reorder-target");
      }
    }
    return true;
  }

  finishInternalReorder(event, cancelled = false) {
    const state = this.reorderState;
    if (!state || (event && event.pointerId !== undefined && event.pointerId !== state.pointerId)) return false;
    this.reorderState = null;
    state.card.classList.remove("is-reorder-source");
    for (const record of this.cardRecords.values()) record.card.classList.remove("is-reorder-target");
    if (typeof state.handle.releasePointerCapture === "function") {
      try { state.handle.releasePointerCapture(state.pointerId); } catch (error) { /* Capture may already be released. */ }
    }
    if (!cancelled && state.targetId && state.targetId !== state.replayId) {
      this.pendingFlipRects = state.beforeRects;
      this.onReorder({
        collectionId: state.collectionId,
        replayId: state.replayId,
        targetId: state.targetId,
        placement: state.placement,
      });
    }
    return true;
  }

  onReplayPointerDown(event) {
    if (this.beginInternalReorder(event)) return;
    if (
      this.destroyed ||
      this.dragState ||
      !event ||
      event.isPrimary === false ||
      event.button !== 0 ||
      isInteractiveCardTarget(event.target)
    ) {
      return;
    }
    const cardElement = closestReplayCard(event.target, this.grid);
    if (!cardElement) {
      return;
    }
    const replayId = String(cardElement.dataset.replayId || "");
    const replay = this.resolveReplay(replayId);
    let canonicalPath = "";
    try {
      canonicalPath = getReplayCanonicalMediaPath(replay, true);
    } catch (error) {
      const normalized = normalizeError(error);
      this.logGestureEvent("pointerdown", event, null, { replayId });
      this.onBlockedDrag(`[${normalized.code}] ${normalized.message}`);
      return;
    }

    this.dragState = {
      gestureId: `gesture-${Date.now()}-${this.nextGestureId++}`,
      pointerId: event.pointerId,
      replayId,
      replay,
      canonicalPath,
      cardElement,
      startX: Number(event.clientX),
      startY: Number(event.clientY),
      movementSquared: 0,
      thresholdCrossed: false,
      thresholdCrossedAt: null,
      nativeStarted: false,
      activationConsumed: false,
      primaryButtonHeld: true,
      escapePressed: false,
      nativeInvoked: false,
      ended: false,
    };
    this.setActiveReplay(replayId, !(event.ctrlKey || event.metaKey || event.shiftKey));
    this.logGestureEvent("pointerdown", event, this.dragState);
    cardElement.classList.add("replay-card--drag-pending");
    if (typeof cardElement.setPointerCapture === "function") {
      try {
        cardElement.setPointerCapture(event.pointerId);
      } catch (error) {
        if (NATIVE_DRAG_DEBUG) {
          console.debug("Oracle could not capture the replay drag pointer.", error);
        }
      }
    }
  }

  onReplayPointerMove(event) {
    if (this.updateInternalReorder(event)) return;
    const dragState = this.dragState;
    if (!dragState || !event || event.pointerId !== dragState.pointerId) {
      return;
    }
    if ((Number(event.buttons) & 1) !== 1) {
      dragState.primaryButtonHeld = false;
      this.logGestureEvent("pointermove", event, dragState, {
        reason: "primary-button-released",
      });
      this.finishReplayGesture(dragState, "primary-button-released");
      return;
    }
    const deltaX = Number(event.clientX) - dragState.startX;
    const deltaY = Number(event.clientY) - dragState.startY;
    const physicalPixelScale = Math.max(1, Number(this.window && this.window.devicePixelRatio) || 1);
    dragState.movementSquared =
      (deltaX * deltaX + deltaY * deltaY) * physicalPixelScale * physicalPixelScale;
    this.logGestureEvent("pointermove", event, dragState);
    if (
      dragState.nativeStarted ||
      dragState.movementSquared <
        REPLAY_NATIVE_DRAG_THRESHOLD_PX * REPLAY_NATIVE_DRAG_THRESHOLD_PX
    ) {
      return;
    }

    // This assignment is the routing boundary: activation is consumed before
    // pointer capture release, diagnostics, self-test, or native invocation.
    dragState.thresholdCrossed = true;
    dragState.thresholdCrossedAt = performance.now();
    dragState.activationConsumed = true;
    dragState.nativeStarted = true;
    event.preventDefault();
    if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
    this.logGestureEvent("threshold-crossed", event, dragState);
    void this.beginNativeReplayDrag(dragState, event);
  }

  onReplayPointerUp(event) {
    if (this.finishInternalReorder(event, false)) return;
    if (!this.dragState || !event || event.pointerId !== this.dragState.pointerId) {
      return;
    }
    this.logGestureEvent("pointerup", event, this.dragState);
    this.dragState.primaryButtonHeld = false;
    if (!this.dragState.nativeInvoked) {
      this.finishReplayGesture(this.dragState, "pointer-released-before-threshold");
    }
  }

  onReplayPointerCancel(event) {
    if (this.finishInternalReorder(event, true)) return;
    const dragState = this.dragState;
    this.logGestureEvent("pointercancel", event, dragState);
    if (dragState && !dragState.nativeInvoked) {
      dragState.primaryButtonHeld = false;
      this.finishReplayGesture(dragState, "pointer-cancelled");
    }
  }

  onReplayLostPointerCapture(event) {
    if (this.finishInternalReorder(event, true)) return;
    const dragState = this.dragState;
    this.logGestureEvent("lostpointercapture", event, dragState);
    if (dragState && !dragState.nativeInvoked) {
      dragState.primaryButtonHeld = false;
      this.finishReplayGesture(dragState, "pointer-capture-lost");
    }
  }

  finishReplayGesture(dragState, reason) {
    if (!dragState || dragState.ended) {
      return;
    }
    dragState.ended = true;
    if (this.dragState === dragState) {
      this.dragState = null;
    }
    dragState.cardElement.classList.remove(
      "replay-card--drag-pending",
      "replay-card--dragging",
    );
    this.releaseReplayPointerCapture(dragState);
    if (NATIVE_DRAG_DEBUG) {
      console.debug(`[Oracle Native Drag][Gesture End] ${reason}`, {
        gestureId: dragState.gestureId,
        replayId: dragState.replayId,
        thresholdCrossed: dragState.thresholdCrossed,
        nativeStarted: dragState.nativeStarted,
        activationConsumed: dragState.activationConsumed,
      });
    }
    if (!this.destroyed) this.scheduleVirtualRender();
  }

  async beginNativeReplayDrag(dragState, thresholdEvent) {
    const replay = dragState.replay || this.resolveReplay(dragState.replayId);
    let result = null;
    const startedAt = performance.now();
    const nativeDragPath = nativeWindowsFilePath(dragState.canonicalPath);
    dragState.cardElement.classList.remove("replay-card--drag-pending");
    dragState.cardElement.classList.add("replay-card--dragging");
    let snapshotPollTimer = null;
    let lastSnapshotStage = "";
    const pollNativeSnapshot = () => {
      if (
        !NATIVE_DRAG_DEBUG ||
        !this.nativeAddon ||
        typeof this.nativeAddon.getNativeDragSnapshot !== "function"
      ) {
        return null;
      }
      try {
        const snapshot = this.nativeAddon.getNativeDragSnapshot();
        const stage = String((snapshot && snapshot.stage) || "UNKNOWN");
        if (stage !== lastSnapshotStage) {
          lastSnapshotStage = stage;
          console.log("[Oracle Native Drag][Snapshot]", {
            gestureId: dragState.gestureId,
            replayId: dragState.replayId,
            ...snapshot,
          });
          console.log(
            "[Oracle Native Drag][Snapshot JSON]",
            JSON.stringify({
              gestureId: dragState.gestureId,
              replayId: dragState.replayId,
              ...snapshot,
            }),
          );
        }
        return snapshot;
      } catch (error) {
        console.error("[Oracle Native Drag][Snapshot Failed]", error);
        return null;
      }
    };
    try {
      if (
        !this.nativeAddon ||
        typeof this.nativeAddon.startNativeFileDrag !== "function"
      ) {
        result = this.nativeAddonDiagnostic || nativeDragError(
          "ADDON_RETURNED_NULL",
          "Oracle's native drag addon is unavailable without a load diagnostic.",
        );
      } else {
        // This is the invariant boundary. A valid replay crosses into native
        // OLE immediately at gesture threshold, before any ProjectItem scan,
        // import, label action, timeline query, self-test, or awaited Promise.
        dragState.nativeInvoked = true;
        this.releaseReplayPointerCapture(dragState);
        const nativeInvocationAt = performance.now();
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("info", "NATIVE_DRAG_INVOCATION_LATENCY", {
            gestureId: dragState.gestureId,
            replayId: dragState.replayId,
            latencyMs: Math.max(0, nativeInvocationAt - Number(dragState.thresholdCrossedAt || nativeInvocationAt)),
          });
        }
        const dragPromise = this.nativeAddon.startNativeFileDrag(nativeDragPath);
        logTimelineLabelTelemetry("NATIVE_DRAG_INVOKED", {
          gestureId: dragState.gestureId,
          replayId: dragState.replayId,
          absolutePath: nativeDragPath,
        });
        if (!dragPromise || typeof dragPromise.then !== "function") {
          throw nativeDragError(
            "NATIVE_ASYNC_CONTRACT_FAILED",
            "startNativeFileDrag did not return a Promise immediately.",
          );
        }
        if (NATIVE_DRAG_DEBUG) {
          let selfTest = null;
          try {
            selfTest = typeof this.nativeAddon.nativeSelfTest === "function"
              ? this.nativeAddon.nativeSelfTest()
              : null;
          } catch (error) {
            selfTest = { ok: false, errorMessage: String((error && error.message) || error) };
          }
          console.log("[Oracle Native Drag][Invocation]", {
            gestureId: dragState.gestureId,
            replayId: dragState.replayId,
            canonicalPathPresent: Boolean(dragState.canonicalPath),
            fileExists: inspectReplayFileExistsSync(dragState.canonicalPath),
            startedAt,
            buttons: Number(thresholdEvent && thresholdEvent.buttons) || 0,
            workerState: selfTest && selfTest.oleWorkerState,
            selfTest,
          });
        }
        // Start polling before awaiting so a stalled OLE stage remains visible
        // while the scripting thread stays responsive in development builds.
        pollNativeSnapshot();
        snapshotPollTimer = setInterval(pollNativeSnapshot, 75);
        result = await dragPromise;
        logTimelineLabelTelemetry("NATIVE_DROP_RETURNED", {
          gestureId: dragState.gestureId,
          replayId: dragState.replayId,
          absolutePath: nativeDragPath,
          ok: Boolean(result && result.ok),
          dropped: Boolean(result && result.dropped),
          cancelled: Boolean(result && result.cancelled),
          effect: Number(result && result.effect) || 0,
        });
      }
    } catch (error) {
      result = error && typeof error === "object" && error.errorCode
        ? error
        : nativeDragError(
            "NATIVE_DRAG_FAILED",
            String((error && error.message) || "The native replay drag failed."),
            { nativeErrorCode: String((error && error.code) || "DRAG_FAILED") },
          );
    } finally {
      if (dragState.nativeInvoked) {
        pollNativeSnapshot();
      }
      if (snapshotPollTimer !== null) {
        clearInterval(snapshotPollTimer);
        snapshotPollTimer = null;
      }
      this.recentConsumedGesture = {
        gestureId: dragState.gestureId,
        replayId: dragState.replayId,
        canonicalPath: dragState.canonicalPath,
        thresholdCrossed: true,
        nativeStarted: true,
        activationConsumed: true,
        until: performance.now() + REPLAY_NATIVE_DRAG_SUPPRESSION_MS,
      };
      this.finishReplayGesture(dragState, "native-dispatch-returned");
    }
    result = normalizeNativeDragResult(result, performance.now() - startedAt);
    let completionSnapshot = null;
    if (this.nativeAddon && typeof this.nativeAddon.getNativeDragSnapshot === "function") {
      try {
        completionSnapshot = this.nativeAddon.getNativeDragSnapshot();
      } catch (error) {
        completionSnapshot = null;
      }
    }
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic(result.ok ? "info" : "warn", "NATIVE_DRAG_COMPLETED", {
        gestureId: dragState.gestureId,
        replayId: dragState.replayId,
        ok: Boolean(result.ok),
        dropped: Boolean(result.dropped),
        cancelled: Boolean(result.cancelled),
        requestId: Number((completionSnapshot && completionSnapshot.requestId) || result.requestId) || 0,
        totalElapsedMs: Number(result.totalElapsedMs) || 0,
        nativeDispatchMs: Number(result.nativeDispatchMs) || 0,
        effect: Number(result.effect) || 0,
        hresult: Number(result.hresult) || 0,
        stage: String((completionSnapshot && completionSnapshot.stage) || result.lastStage || ""),
        requestReceived: Boolean(result.requestReceived || completionSnapshot && completionSnapshot.requestReceived),
        pathValidated: Boolean(result.pathValidated || completionSnapshot && completionSnapshot.pathValidated),
        leftButtonConfirmed: Boolean(result.leftButtonConfirmed || completionSnapshot && completionSnapshot.leftButtonConfirmed),
        workerDispatched: Boolean(result.workerDispatched || completionSnapshot && (completionSnapshot.workerQueued || completionSnapshot.workerAwakened)),
        oleInitialized: Boolean(completionSnapshot && completionSnapshot.oleInitialized),
        doDragDropEntered: Boolean(result.doDragDropEntered || completionSnapshot && completionSnapshot.doDragDropEntered),
        doDragDropReturned: Boolean(result.doDragDropReturned || completionSnapshot && completionSnapshot.doDragDropReturned),
        queryContinueDragCalls: Number(completionSnapshot && completionSnapshot.queryContinueDragCalls) || 0,
        giveFeedbackCalls: Number(completionSnapshot && completionSnapshot.giveFeedbackCalls) || 0,
        escapeObserved: Boolean(completionSnapshot && completionSnapshot.escapeObserved),
        finalEffect: Number(completionSnapshot && completionSnapshot.finalEffect) || 0,
        promiseCreated: Boolean(completionSnapshot && completionSnapshot.promiseCreated),
        promiseResolved: Boolean(completionSnapshot && completionSnapshot.promiseResolved),
        promiseRejected: Boolean(completionSnapshot && completionSnapshot.promiseRejected),
        cancellationHookInstalled: Boolean(completionSnapshot && completionSnapshot.cancellationHookInstalled),
        nativeSnapshotElapsedMs: Number(completionSnapshot && completionSnapshot.elapsedMs) || 0,
        errorCode: String(result.errorCode || ""),
      });
    }
    if (NATIVE_DRAG_DEBUG) {
      console.log("[Oracle Native Drag][Result]", {
        gestureId: dragState.gestureId,
        replayId: dragState.replayId,
        ...result,
      });
    }
    this.handleNativeDragResult(
      replay,
      result,
      dragState.cardElement,
      dragState.canonicalPath,
    );
  }

  handleNativeDragResult(replay, result, cardElement, canonicalPath) {
    if (this.destroyed) return;
    const nativeResult = result && typeof result === "object" ? result : nativeDragError(
      "DRAG_FAILED",
      "The native addon returned an invalid drag result.",
    );
    if (NATIVE_DRAG_DEBUG) {
      console.debug("Oracle native replay drag result", nativeResult);
    }
    if (!nativeResult.ok && cardElement) {
      cardElement.classList.add("replay-card--drag-error");
      if (this.dragErrorTimer !== null) {
        clearTimeout(this.dragErrorTimer);
      }
      this.dragErrorTimer = setTimeout(() => {
        this.dragErrorTimer = null;
        cardElement.classList.remove("replay-card--drag-error");
      }, 1800);
    }
    this.onNativeDragResult(replay, nativeResult, canonicalPath);
  }

  releaseReplayPointerCapture(dragState) {
    const cardElement = dragState && dragState.cardElement;
    if (!cardElement || typeof cardElement.releasePointerCapture !== "function") {
      return;
    }
    try {
      if (
        typeof cardElement.hasPointerCapture !== "function" ||
        cardElement.hasPointerCapture(dragState.pointerId)
      ) {
        cardElement.releasePointerCapture(dragState.pointerId);
      }
    } catch (error) {
      if (NATIVE_DRAG_DEBUG) {
        console.debug("Oracle could not release the replay drag pointer.", error);
      }
    }
  }

  getImportSuppression() {
    if (this.dragState && this.dragState.activationConsumed) {
      return this.dragState;
    }
    const recent = this.recentConsumedGesture;
    if (recent && performance.now() <= recent.until) {
      return recent;
    }
    this.recentConsumedGesture = null;
    return null;
  }

  shouldSuppressActivation(replayId) {
    const suppression = this.getImportSuppression();
    return Boolean(
      suppression &&
        suppression.activationConsumed === true &&
        suppression.replayId === String(replayId),
    );
  }

  consumeActivationEvent(event, eventType, cardElement, replay) {
    const replayId = String((replay && replay.id) || (cardElement && cardElement.dataset.replayId) || "");
    const suppressed = this.shouldSuppressActivation(replayId);
    this.logGestureEvent(eventType, event, this.dragState || this.recentConsumedGesture, {
      replayId,
      activationSuppressed: suppressed,
    });
    if (!suppressed) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    return true;
  }

  onReplayClickCapture(event) {
    const cardElement = closestReplayCard(event && event.target, this.grid);
    if (!cardElement || isInteractiveCardTarget(event.target)) return;
    const replayId = String(cardElement.dataset.replayId || "");
    const replay = this.resolveReplay(replayId);
    if (this.consumeActivationEvent(event, "click", cardElement, replay)) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (this.openTimer !== null) {
        clearTimeout(this.openTimer);
        this.openTimer = null;
      }
      this.applySelectionGesture(replayId, {
        toggle: Boolean(event.ctrlKey || event.metaKey),
        range: Boolean(event.shiftKey),
        additive: Boolean(event.ctrlKey || event.metaKey),
      });
      return;
    }
    this.setActiveReplay(replayId, true);
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      if (replay) this.onOpen(replay);
    }, 220);
  }

  onReplayDoubleClickCapture(event) {
    const cardElement = closestReplayCard(event && event.target, this.grid);
    if (!cardElement || isInteractiveCardTarget(event.target)) return;
    const replay = this.resolveReplay(String(cardElement.dataset.replayId || ""));
    if (this.consumeActivationEvent(event, "dblclick", cardElement, replay)) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (replay) this.onInsert(replay);
  }

  onReplayReorderKeyDown(event, handle) {
    if (!event || !handle || !this.manualOrderCollectionId) return false;
    const cardElement = closestReplayCard(handle, this.grid);
    if (!cardElement) return false;
    const replayId = String(cardElement.dataset.replayId || "");
    const replay = this.resolveReplay(replayId);
    const current = this.sourceIds.indexOf(replayId);
    if (current < 0) return false;
    if (["Enter", " ", "Spacebar"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      this.onAnnounce(`${replay && replay.title || "Replay"}, position ${current + 1} of ${this.sourceIds.length}. Use Arrow keys, Home, or End to reorder.`);
      return true;
    }
    const columns = this.effectiveColumns();
    let targetIndex = null;
    if (event.key === "ArrowRight") targetIndex = current + 1;
    else if (event.key === "ArrowLeft") targetIndex = current - 1;
    else if (event.key === "ArrowDown") targetIndex = current + columns;
    else if (event.key === "ArrowUp") targetIndex = current - columns;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = this.sourceIds.length - 1;
    if (targetIndex === null) return false;
    event.preventDefault();
    event.stopPropagation();
    const bounded = Math.max(0, Math.min(this.sourceIds.length - 1, targetIndex));
    if (bounded === current) {
      this.onAnnounce(`This replay is already ${bounded === 0 ? "first" : "last"} in the collection.`);
      return true;
    }
    const targetId = this.sourceIds[bounded];
    this.activeReplayId = replayId;
    this.pendingFocusReplayId = replayId;
    this.onReorder({
      collectionId: this.manualOrderCollectionId,
      replayId,
      targetId,
      placement: bounded < current ? "before" : "after",
      input: "keyboard",
    });
    return true;
  }

  onReplayKeyDown(event) {
    if (!event) return;
    const reorderHandle = event.target && typeof event.target.closest === "function"
      ? event.target.closest("[data-replay-reorder-handle]")
      : null;
    if (reorderHandle) {
      this.onReplayReorderKeyDown(event, reorderHandle);
      return;
    }
    if (isInteractiveCardTarget(event.target)) return;
    const cardElement = closestReplayCard(event.target, this.grid);
    if (!cardElement) return;
    const replayId = String(cardElement.dataset.replayId || "");
    const replay = this.resolveReplay(replayId);
    const columns = this.effectiveColumns();
    const current = this.sourceIds.indexOf(replayId);
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLocaleLowerCase("en-US") === "a") {
      event.preventDefault();
      this.setSelection(this.sourceIds, replayId, replayId);
      return;
    }
    let targetIndex = null;
    if (event.key === "ArrowRight") targetIndex = current + 1;
    else if (event.key === "ArrowLeft") targetIndex = current - 1;
    else if (event.key === "ArrowDown") targetIndex = current + columns;
    else if (event.key === "ArrowUp") targetIndex = current - columns;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = this.sourceIds.length - 1;
    if (targetIndex !== null) {
      event.preventDefault();
      const bounded = Math.max(0, Math.min(this.sourceIds.length - 1, targetIndex));
      const targetId = this.sourceIds[bounded];
      if (targetId) this.focusReplayById(targetId, {
        range: Boolean(event.shiftKey),
        additive: Boolean(event.ctrlKey || event.metaKey),
        preserve: Boolean(event.ctrlKey || event.metaKey) && !event.shiftKey,
      });
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const rect = cardElement.getBoundingClientRect ? cardElement.getBoundingClientRect() : { left: 8, bottom: 8 };
      this.openContextMenu(replayId, rect.left, rect.bottom, cardElement);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      this.applySelectionGesture(replayId, {
        range: Boolean(event.shiftKey),
        toggle: Boolean(event.ctrlKey || event.metaKey),
        additive: Boolean(event.ctrlKey || event.metaKey),
      });
      return;
    }
    if (event.key !== "Enter") return;
    this.logGestureEvent("explicit-import-activation", event, null, {
      replayId: replay && replay.id,
    });
    event.preventDefault();
    if (replay) this.onInsert(replay);
  }

  setActiveReplay(replayId, select) {
    const id = String(replayId || "");
    if (!id) return;
    this.activeReplayId = id;
    if (select) {
      this.setSelection([id], id, id);
      return;
    }
    this.updateVisibleSelection();
  }

  focusReplayById(replayId, options = {}) {
    const id = String(replayId || "");
    const rowIndex = this.layoutRows.findIndex((row) => row.kind === "cards" && row.ids.includes(id));
    if (rowIndex < 0 || !this.scroller) return;
    if (options.range) {
      this.applySelectionGesture(id, { range: true, additive: options.additive === true });
    } else if (options.preserve) {
      this.setActiveReplay(id, false);
    } else {
      this.setActiveReplay(id, true);
    }
    this.pendingFocusReplayId = id;
    const gridTop = Number(this.grid.offsetTop) || 0;
    const rowTop = gridTop + this.layoutOffsets[rowIndex];
    const rowBottom = rowTop + this.layoutRows[rowIndex].height;
    const viewportTop = Number(this.scroller.scrollTop) || 0;
    const viewportBottom = viewportTop + Math.max(1, Number(this.scroller.clientHeight) || 720);
    if (rowTop < viewportTop) this.scroller.scrollTop = rowTop;
    else if (rowBottom > viewportBottom) this.scroller.scrollTop = Math.max(0, rowBottom - (viewportBottom - viewportTop));
    this.renderVirtualWindow();
  }

  onReplayFocusIn(event) {
    const card = closestReplayCard(event && event.target, this.grid);
    if (card) this.setActiveReplay(String(card.dataset.replayId || ""), false);
  }

  onReplayContextMenu(event) {
    const card = closestReplayCard(event && event.target, this.grid);
    if (!card || isInteractiveCardTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.dragState && !this.dragState.nativeInvoked) {
      this.finishReplayGesture(this.dragState, "context-menu-opened");
    }
    const replayId = String(card.dataset.replayId || "");
    this.setActiveReplay(replayId, !this.selectedReplayIds.has(replayId));
    const rect = card.getBoundingClientRect ? card.getBoundingClientRect() : { left: 8, top: 8, bottom: 8 };
    const x = Number(event.clientX) || rect.left;
    const y = Number(event.clientY) || rect.bottom || rect.top;
    this.openContextMenu(replayId, x, y, card);
  }

  openContextMenu(replayId, x, y, restoreFocus) {
    const replay = this.resolveReplay(replayId);
    if (!this.contextMenu || !replay) return;
    this.contextReplayId = String(replayId);
    this.contextRestoreFocus = restoreFocus || (this.document && this.document.activeElement);
    const selected = this.getSelectedReplays();
    for (const item of this.contextMenu.querySelectorAll("[data-replay-context-action]")) {
      const action = String(item.dataset.replayContextAction || "");
      const state = this.getContextActionState(action, replay, selected) || {};
      item.hidden = state.hidden === true;
      item.disabled = state.disabled === true;
      if (state.label) item.textContent = String(state.label);
      item.title = state.reason ? String(state.reason) : "";
      item.setAttribute("aria-disabled", item.disabled ? "true" : "false");
    }
    this.contextMenu.hidden = false;
    this.contextMenu.style.left = "0px";
    this.contextMenu.style.top = "0px";
    const bounds = this.contextMenu.getBoundingClientRect
      ? this.contextMenu.getBoundingClientRect()
      : { width: 210, height: 80 };
    const rootBounds = this.interactionRoot && typeof this.interactionRoot.getBoundingClientRect === "function"
      ? this.interactionRoot.getBoundingClientRect()
      : { left: 0, top: 0, width: Number(this.window && this.window.innerWidth) || 800, height: Number(this.window && this.window.innerHeight) || 600 };
    const width = Math.max(1, Number(rootBounds.width) || 800);
    const height = Math.max(1, Number(rootBounds.height) || 600);
    const localX = (Number(x) || Number(rootBounds.left) + 8) - Number(rootBounds.left || 0);
    const localY = (Number(y) || Number(rootBounds.top) + 8) - Number(rootBounds.top || 0);
    this.contextMenu.style.left = `${Math.max(8, Math.min(width - bounds.width - 8, localX))}px`;
    this.contextMenu.style.top = `${Math.max(8, Math.min(height - bounds.height - 8, localY))}px`;
    const first = Array.from(this.contextMenu.querySelectorAll('[role="menuitem"]'))
      .find((item) => !item.hidden && !item.disabled);
    if (first && typeof first.focus === "function") first.focus();
  }

  closeContextMenu(restoreFocus = true) {
    if (!this.contextMenu || this.contextMenu.hidden) return;
    this.contextMenu.hidden = true;
    this.contextReplayId = "";
    const restore = this.contextRestoreFocus;
    this.contextRestoreFocus = null;
    if (restoreFocus && restore && typeof restore.focus === "function") restore.focus();
  }

  onContextMenuClick(event) {
    const item = event.target.closest && event.target.closest("[data-replay-context-action]");
    if (!item) return;
    event.preventDefault();
    const replay = this.resolveReplay(this.contextReplayId);
    const action = item.dataset.replayContextAction;
    if (item.disabled) return;
    const selected = this.getSelectedReplays();
    this.closeContextMenu(true);
    if (!replay) return;
    if (action === "open") this.onOpen(replay);
    else if (action === "import") this.onInsert(replay);
    else this.onContextAction(action, replay, selected.length ? selected : [replay]);
  }

  onContextMenuKeyDown(event) {
    if (!this.contextMenu || this.contextMenu.hidden) return;
    const items = Array.from(this.contextMenu.querySelectorAll('[role="menuitem"]'))
      .filter((item) => !item.hidden && !item.disabled);
    if (!items.length) return;
    const current = items.indexOf(this.document && this.document.activeElement);
    let next = null;
    if (event.key === "ArrowDown") next = (current + 1 + items.length) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      this.closeContextMenu(true);
      return;
    }
    if (next === null || !items[next]) return;
    event.preventDefault();
    items[next].focus();
  }

  onDocumentPointerDown(event) {
    if (!this.contextMenu || this.contextMenu.hidden || this.contextMenu.contains(event.target)) return;
    this.closeContextMenu(false);
  }

  onDocumentKeyDown(event) {
    if (!this.ownsInteraction(event)) return;
    if (this.contextMenu && !this.contextMenu.hidden && event && event.key === "Escape") {
      if (!event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        this.closeContextMenu(true);
      }
      return;
    }
    const dragState = this.dragState;
    if (event && !event.defaultPrevented && event.key === "Escape" && !dragState) {
      const blockingLayer = ["replayLifecycleBackdrop", "preferencesBackdrop", "navigationBackdrop"]
        .map((id) => this.findLocalElement(id))
        .some((element) => element && element.hidden === false);
      if (!blockingLayer && this.selectedReplayIds.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        this.clearSelection();
      }
      return;
    }
    if (
      !event ||
      event.defaultPrevented ||
      event.key !== "Escape" ||
      !dragState ||
      dragState.nativeInvoked
    ) {
      return;
    }
    dragState.escapePressed = true;
    dragState.primaryButtonHeld = false;
    event.preventDefault();
    if (typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("info", "NATIVE_DRAG_CANCELLED_BEFORE_THRESHOLD", {
        gestureId: dragState.gestureId,
        replayId: dragState.replayId,
        movementPx: Math.sqrt(Math.max(0, Number(dragState.movementSquared) || 0)),
        thresholdPx: REPLAY_NATIVE_DRAG_THRESHOLD_PX,
      });
    }
    this.logGestureEvent("escape-before-native-drag", event, dragState);
    this.finishReplayGesture(dragState, "escape-before-native-drag");
  }

  logGestureEvent(eventType, event, state, extra = {}) {
    if (!NATIVE_DRAG_DEBUG) return;
    const target = event && event.target;
    const classes = target && target.classList
      ? Array.from(
          typeof target.classList.values === "function"
            ? target.classList.values()
            : target.classList.values || target.classList,
        )
      : [];
    const record = {
      gestureId: String((state && state.gestureId) || ""),
      replayId: String(extra.replayId || (state && state.replayId) || ""),
      eventType,
      eventPhase: Number(event && event.eventPhase) || 0,
      buttons: Number(event && event.buttons) || 0,
      button: Number(event && event.button),
      pointerId: Number(event && event.pointerId),
      movementSquared: Number((state && state.movementSquared) || 0),
      thresholdCrossed: Boolean(state && state.thresholdCrossed),
      nativeStarted: Boolean(state && state.nativeStarted),
      activationConsumed: Boolean(state && state.activationConsumed),
      targetTag: String((target && target.tagName) || ""),
      targetClasses: classes.join(" "),
      currentTargetTag: String((event && event.currentTarget && event.currentTarget.tagName) || ""),
      canonicalPathPresent: Boolean(state && state.canonicalPath),
      ...extra,
    };
    console.log("[Oracle Native Drag][Event]", record);
  }

  destroy() {
    this.destroyed = true;
    if (this.reorderState) this.finishInternalReorder(null, true);
    if (this.dragState && !this.dragState.nativeInvoked) {
      this.finishReplayGesture(this.dragState, "view-destroyed");
    }
    this.dragState = null;
    if (this.dragErrorTimer !== null) {
      clearTimeout(this.dragErrorTimer);
      this.dragErrorTimer = null;
    }
    this.grid.removeEventListener("pointerdown", this.onReplayPointerDown);
    this.grid.removeEventListener("pointermove", this.onReplayPointerMove);
    this.grid.removeEventListener("pointerup", this.onReplayPointerUp);
    this.grid.removeEventListener("pointercancel", this.onReplayPointerCancel);
    this.grid.removeEventListener("lostpointercapture", this.onReplayLostPointerCapture);
    this.grid.removeEventListener("click", this.onReplayClickCapture, true);
    this.grid.removeEventListener("dblclick", this.onReplayDoubleClickCapture, true);
    this.grid.removeEventListener("keydown", this.onReplayKeyDown);
    this.grid.removeEventListener("focusin", this.onReplayFocusIn);
    this.grid.removeEventListener("contextmenu", this.onReplayContextMenu);
    this.grid.removeEventListener("error", this.onReplayImageError, true);
    if (this.scroller && typeof this.scroller.removeEventListener === "function") {
      this.scroller.removeEventListener("scroll", this.onReplayScroll);
    }
    if (this.contextMenu) {
      this.closeContextMenu(false);
      this.contextMenu.removeEventListener("click", this.onContextMenuClick);
      this.contextMenu.removeEventListener("keydown", this.onContextMenuKeyDown);
      if (this.document) this.document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    }
    if (this.document) this.document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.renderFrame !== null) {
      cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (this.flipFrame !== null) {
      cancelAnimationFrame(this.flipFrame);
      this.flipFrame = null;
    }
    if (this.flipTimer !== null) {
      clearTimeout(this.flipTimer);
      this.flipTimer = null;
    }
    for (const card of this.flipCards) {
      card.style.removeProperty("transition");
      card.style.removeProperty("transform");
      delete card.dataset.flip;
    }
    this.flipCards = [];
    this.pendingFlipRects = null;
    for (const record of this.cardRecords.values()) {
      this.disposeCard(record.card);
    }
    this.cardRecords.clear();
    this.cardCleanup.clear();
    this.cardBindings.clear();
    this.replayById.clear();
    this.sourceIds = [];
    this.layoutRows = [];
    this.layoutOffsets = [0];
    this.selectedReplayIds.clear();
    this.animatedReplayIds.clear();
    this.replaceElementChildren(this.grid);
    this.onOpen = () => undefined;
    this.onInsert = () => undefined;
    this.onNativeDragResult = () => undefined;
    this.onBlockedDrag = () => undefined;
    this.onContextAction = () => undefined;
    this.onSelectionChange = () => undefined;
    this.onReorder = () => undefined;
    this.getContextActionState = () => null;
  }
}

class GridScaleControl {
  constructor(input, grid, countLabel, onCommittedChange = null, onLayoutChanged = null) {
    this.input = input;
    this.grid = grid;
    this.countLabel = countLabel;
    this.minimum = Number(input && input.min) || 1;
    this.maximum = Number(input && input.max) || 6;
    this.step = Number(input && input.step) || 1;
    this.defaultValue = Number(input && input.value) || 3;
    this.requestedColumns = this.defaultValue;
    this.effectiveColumns = this.defaultValue;
    this.lastObservedWidth = -1;
    this.resizeFrame = null;
    this.resizeObserver = null;
    this.onCommittedChange = typeof onCommittedChange === "function"
      ? onCommittedChange
      : () => undefined;
    this.onLayoutChanged = typeof onLayoutChanged === "function"
      ? onLayoutChanged
      : () => undefined;
    this.handleInput = (event) => this.updateGridColumns(event.currentTarget.value, false);
    this.handleChange = (event) => {
      this.updateGridColumns(event.currentTarget.value, true);
      this.onCommittedChange(this.requestedColumns);
    };
    this.handleResize = (entries) => {
      const entry = Array.isArray(entries) ? entries[0] : null;
      const observedWidth = Number(entry && entry.contentRect && entry.contentRect.width);
      if (Number.isFinite(observedWidth) && Math.abs(observedWidth - this.lastObservedWidth) < 0.5) {
        return;
      }
      if (Number.isFinite(observedWidth)) this.lastObservedWidth = observedWidth;
      this.scheduleLayout();
    };
  }

  start() {
    if (!this.input || !this.grid) {
      return;
    }
    let savedValue = this.defaultValue;
    try {
      savedValue = Number(window.localStorage.getItem(GRID_SCALE_STORAGE_KEY)) || savedValue;
    } catch (error) {
      // UXP may disable localStorage in restricted preview contexts.
    }
    this.updateGridColumns(savedValue, false);
    this.input.addEventListener("input", this.handleInput);
    this.input.addEventListener("change", this.handleChange);
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.grid);
    } else {
      window.addEventListener("resize", this.handleResize);
    }
  }

  updateGridColumns(value, persist) {
    const clamped = Math.min(
      this.maximum,
      Math.max(this.minimum, Number(value) || this.defaultValue),
    );
    const stepped = this.minimum + Math.round((clamped - this.minimum) / this.step) * this.step;
    const normalized = Math.min(this.maximum, Math.max(this.minimum, stepped));
    this.requestedColumns = normalized;
    this.input.value = String(normalized);
    this.input.setAttribute(
      "aria-valuetext",
      `${normalized} ${normalized === 1 ? "column" : "columns"}`,
    );
    if (this.countLabel) {
      this.countLabel.textContent = String(normalized);
    }
    this.scheduleLayout();
    if (persist) {
      try {
        window.localStorage.setItem(GRID_SCALE_STORAGE_KEY, String(normalized));
      } catch (error) {
        // Grid scaling remains active for this session if persistence is unavailable.
      }
    }
  }

  scheduleLayout() {
    if (this.resizeFrame !== null || !this.grid) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.applyLayout();
    });
  }

  applyLayout() {
    const gap = 20;
    const minimumCardWidth = 220;
    const availableWidth = Math.max(0, Number(this.grid.clientWidth) || 0);
    const fittingColumns = availableWidth > 0
      ? Math.max(1, Math.floor((availableWidth + gap) / (minimumCardWidth + gap)))
      : this.requestedColumns;
    const columns = Math.min(this.requestedColumns, fittingColumns);
    const previousColumns = this.effectiveColumns;
    this.effectiveColumns = columns;

    if (this.grid.style.getPropertyValue("--replay-grid-columns") !== String(columns)) {
      this.grid.style.setProperty("--replay-grid-columns", String(columns));
    }
    if (typeof this.grid.style.removeProperty === "function") {
      this.grid.style.removeProperty("--replay-card-basis");
    }
    if (this.countLabel) {
      this.countLabel.textContent = String(columns);
    }
    this.input.setAttribute(
      "aria-valuetext",
      columns === this.requestedColumns
        ? `${columns} ${columns === 1 ? "column" : "columns"}`
        : `${columns} visible columns of ${this.requestedColumns} requested`,
    );
    if (previousColumns !== columns) this.onLayoutChanged(columns);
  }

  destroy() {
    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    } else {
      window.removeEventListener("resize", this.handleResize);
    }
    if (this.input) {
      this.input.removeEventListener("input", this.handleInput);
      this.input.removeEventListener("change", this.handleChange);
    }
  }
}

function cloneOracleDomainValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class CurvePresetDialogController {
  constructor(elements) {
    this.elements = elements;
    this.started = false;
    this.resolve = null;
    this.mode = "name";
    this.restoreFocus = null;
    this.nameLabel = "Curve preset";
    this.onClose = () => this.finish(null);
    this.onApply = () => this.submit();
    this.onBackdrop = (event) => {
      if (event.target === this.elements.curvesPresetDialogBackdrop) this.finish(null);
    };
    this.onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.finish(null);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.elements.curvesPresetDialogClose.addEventListener("click", this.onClose);
    this.elements.curvesPresetDialogCancel.addEventListener("click", this.onClose);
    this.elements.curvesPresetDialogApply.addEventListener("click", this.onApply);
    this.elements.curvesPresetDialogBackdrop.addEventListener("click", this.onBackdrop);
    this.elements.curvesPresetDialog.addEventListener("keydown", this.onKeyDown);
  }

  open(config = {}) {
    if (!this.started) this.start();
    if (this.resolve) this.finish(null);
    this.mode = config.mode === "confirm" ? "confirm" : "name";
    this.nameLabel = String(config.nameLabel || "Curve preset").slice(0, 80);
    this.restoreFocus = document.activeElement;
    if (this.elements.oraclePromptDialogKicker) {
      this.elements.oraclePromptDialogKicker.textContent = String(config.kicker || "Curve presets").slice(0, 80);
    }
    this.elements.curvesPresetDialogTitle.textContent = String(config.title || "Curve preset").slice(0, 120);
    this.elements.curvesPresetDialogMessage.textContent = String(config.message || "").slice(0, 600);
    this.elements.curvesPresetDialogApply.textContent = String(config.applyLabel || (this.mode === "confirm" ? "Confirm" : "Save")).slice(0, 40);
    this.elements.curvesPresetDialogField.hidden = this.mode === "confirm";
    this.elements.curvesPresetDialogInput.value = String(config.initialValue || "").slice(0, 100);
    this.elements.curvesPresetDialogError.textContent = "";
    this.elements.curvesPresetDialogError.hidden = true;
    this.elements.curvesPresetDialogBackdrop.hidden = false;
    this.elements.curvesPresetDialog.hidden = false;
    requestAnimationFrame(() => {
      const target = this.mode === "name"
        ? this.elements.curvesPresetDialogInput
        : this.elements.curvesPresetDialogApply;
      if (target && typeof target.focus === "function") target.focus();
      if (this.mode === "name" && target && typeof target.select === "function") target.select();
    });
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  requestName(config = {}) {
    return this.open({ ...config, mode: "name" });
  }

  confirm(config = {}) {
    return this.open({ ...config, mode: "confirm" }).then((value) => value === true);
  }

  submit() {
    if (!this.resolve) return;
    if (this.mode === "confirm") {
      this.finish(true);
      return;
    }
    const name = String(this.elements.curvesPresetDialogInput.value || "").trim().slice(0, 100);
    if (!name) {
      this.elements.curvesPresetDialogError.textContent = `${this.nameLabel} name is required.`;
      this.elements.curvesPresetDialogError.hidden = false;
      this.elements.curvesPresetDialogInput.focus();
      return;
    }
    this.finish(name);
  }

  finish(value) {
    if (!this.resolve) return;
    const resolve = this.resolve;
    this.resolve = null;
    this.elements.curvesPresetDialogBackdrop.hidden = true;
    this.elements.curvesPresetDialog.hidden = true;
    this.elements.curvesPresetDialogError.hidden = true;
    const restore = /** @type {any} */ (this.restoreFocus);
    this.restoreFocus = null;
    if (restore && typeof restore.focus === "function") restore.focus();
    resolve(value);
  }

  destroy() {
    if (!this.started) return;
    this.finish(null);
    this.started = false;
    this.elements.curvesPresetDialogClose.removeEventListener("click", this.onClose);
    this.elements.curvesPresetDialogCancel.removeEventListener("click", this.onClose);
    this.elements.curvesPresetDialogApply.removeEventListener("click", this.onApply);
    this.elements.curvesPresetDialogBackdrop.removeEventListener("click", this.onBackdrop);
    this.elements.curvesPresetDialog.removeEventListener("keydown", this.onKeyDown);
    this.elements.curvesPresetDialogBackdrop.hidden = true;
    this.elements.curvesPresetDialog.hidden = true;
  }
}

class CurvePresetDomainStore {
  constructor(store, presetApi, persist, canMutate = () => true) {
    this.store = store;
    this.presetApi = presetApi;
    this.persist = persist;
    this.canMutate = typeof canMutate === "function" ? canMutate : () => true;
    this.listeners = new Set();
  }

  getLibrary() {
    const state = this.store.state || {};
    const preferences = state.preferences && typeof state.preferences === "object" ? state.preferences : {};
    const curves = preferences.curves && typeof preferences.curves === "object" ? preferences.curves : {};
    return this.presetApi.normalizePresetLibrary({
      schema: this.presetApi.PRESET_LIBRARY_SCHEMA,
      version: this.presetApi.PRESET_LIBRARY_VERSION,
      revision: Number(curves.presetLibraryRevision) || 0,
      updatedAt: curves.presetLibraryUpdatedAt || state.writtenAt,
      presets: Object.values(state.curvePresetsById || {}),
      folders: Array.isArray(curves.presetFolders) ? curves.presetFolders : [],
      builtInFavorites: Array.isArray(curves.builtInFavorites) ? curves.builtInFavorites : [],
    });
  }

  subscribe(listener, options = {}) {
    if (typeof listener !== "function") return () => undefined;
    this.listeners.add(listener);
    if (options.immediate !== false) listener(this.getLibrary());
    return () => this.listeners.delete(listener);
  }

  commit(library, reason = "curve-presets") {
    if (!this.canMutate()) throw new Error("[METADATA_TRANSACTION_ACTIVE] Curves metadata is being replaced.");
    const normalized = this.presetApi.normalizePresetLibrary(library);
    const nextState = cloneOracleDomainValue(this.store.state);
    nextState.curvePresetsById = Object.fromEntries(
      normalized.presets.map((preset) => [preset.id, cloneOracleDomainValue(preset)]),
    );
    const preferences = nextState.preferences && typeof nextState.preferences === "object"
      ? nextState.preferences
      : {};
    const curves = preferences.curves && typeof preferences.curves === "object"
      ? preferences.curves
      : {};
    nextState.preferences = {
      ...preferences,
      curves: {
        ...curves,
        presetFolders: cloneOracleDomainValue(normalized.folders),
        builtInFavorites: normalized.builtInFavorites.slice(),
        presetLibraryRevision: normalized.revision,
        presetLibraryUpdatedAt: normalized.updatedAt,
      },
    };
    this.store.replaceDomainState(nextState, { type: "curve-presets", domain: "curves", operation: reason });
    this.persist();
    const snapshot = this.getLibrary();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  refresh() {
    const snapshot = this.getLibrary();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  destroy() {
    this.listeners.clear();
  }
}

class CurveWorkspaceStateStore {
  constructor(store, persist, canMutate = () => true) {
    this.store = store;
    this.persist = persist;
    this.canMutate = typeof canMutate === "function" ? canMutate : () => true;
    this.pendingWorkspace = null;
    this.pendingClipboard = null;
    this.hasPendingWorkspace = false;
    this.hasPendingClipboard = false;
    this.timer = null;
  }

  curvesPreferences() {
    const preferences = this.store.state && this.store.state.preferences;
    return preferences && preferences.curves && typeof preferences.curves === "object"
      ? preferences.curves
      : {};
  }

  getCurvesWorkspaceState() {
    return cloneOracleDomainValue(
      this.hasPendingWorkspace ? this.pendingWorkspace : this.curvesPreferences().workspaceState,
    );
  }

  setCurvesWorkspaceState(value) {
    if (!this.canMutate()) return false;
    this.pendingWorkspace = cloneOracleDomainValue(value);
    this.hasPendingWorkspace = true;
    this.schedule();
    return true;
  }

  readCurveClipboard() {
    return cloneOracleDomainValue(
      this.hasPendingClipboard ? this.pendingClipboard : this.curvesPreferences().clipboard,
    );
  }

  writeCurveClipboard(value) {
    if (!this.canMutate()) return false;
    this.pendingClipboard = cloneOracleDomainValue(value);
    this.hasPendingClipboard = true;
    this.schedule();
    return true;
  }

  schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    const scheduleTimeout = Reflect.get(globalThis, "set" + "Timeout");
    this.timer = scheduleTimeout(() => {
      this.timer = null;
      this.flush();
    }, 350);
  }

  flush() {
    if (!this.hasPendingWorkspace && !this.hasPendingClipboard) return false;
    const nextState = cloneOracleDomainValue(this.store.state);
    const preferences = nextState.preferences && typeof nextState.preferences === "object"
      ? nextState.preferences
      : {};
    const curves = preferences.curves && typeof preferences.curves === "object"
      ? { ...preferences.curves }
      : {};
    if (this.hasPendingWorkspace) curves.workspaceState = cloneOracleDomainValue(this.pendingWorkspace);
    if (this.hasPendingClipboard) curves.clipboard = cloneOracleDomainValue(this.pendingClipboard);
    nextState.preferences = { ...preferences, curves };
    this.hasPendingWorkspace = false;
    this.hasPendingClipboard = false;
    this.pendingWorkspace = null;
    this.pendingClipboard = null;
    this.store.replaceDomainState(nextState, { type: "curve-workspace-state", domain: "curves" });
    this.persist();
    return true;
  }

  discardPending() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingWorkspace = null;
    this.pendingClipboard = null;
    this.hasPendingWorkspace = false;
    this.hasPendingClipboard = false;
  }

  destroy() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

class QuickApplyStateDomainStore {
  constructor(store, persist) {
    this.store = store;
    this.persist = persist;
    this.listeners = new Set();
  }

  rootState() {
    const value = this.store.state && this.store.state.quickApplyState;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  getState() {
    return cloneOracleDomainValue(this.rootState());
  }

  subscribe(listener, options = {}) {
    if (typeof listener !== "function") return () => undefined;
    this.listeners.add(listener);
    if (options.immediate !== false) listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  async setState(value, reason = "quick-apply-state") {
    const current = this.rootState();
    const normalized = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const nextState = cloneOracleDomainValue(this.store.state);
    nextState.quickApplyState = {
      ...current,
      ...cloneOracleDomainValue(normalized),
      effectIndex: cloneOracleDomainValue(current.effectIndex),
      recipeLibrary: cloneOracleDomainValue(current.recipeLibrary),
    };
    this.store.replaceDomainState(nextState, { type: "quick-apply-state", domain: "quick-apply", operation: reason });
    await this.persist();
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  refresh() {
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  destroy() {
    this.listeners.clear();
  }
}

class QuickApplyEffectIndexStore {
  constructor(store, persist, canMutate = () => true) {
    this.store = store;
    this.persist = persist;
    this.canMutate = typeof canMutate === "function" ? canMutate : () => true;
  }

  rootState() {
    const value = this.store.state && this.store.state.quickApplyState;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  async load() {
    return cloneOracleDomainValue(this.rootState().effectIndex) || null;
  }

  async save(effectIndex) {
    if (!this.canMutate()) throw new Error("[METADATA_TRANSACTION_ACTIVE] Quick Apply metadata is being replaced.");
    const nextState = cloneOracleDomainValue(this.store.state);
    nextState.quickApplyState = {
      ...this.rootState(),
      effectIndex: cloneOracleDomainValue(effectIndex),
    };
    this.store.replaceDomainState(nextState, { type: "quick-apply-effect-index", domain: "quick-apply", operation: "save" });
    await this.persist();
    return this.load();
  }

  async clear() {
    if (!this.canMutate()) throw new Error("[METADATA_TRANSACTION_ACTIVE] Quick Apply metadata is being replaced.");
    const current = { ...this.rootState() };
    delete current.effectIndex;
    const nextState = cloneOracleDomainValue(this.store.state);
    nextState.quickApplyState = current;
    this.store.replaceDomainState(nextState, { type: "quick-apply-effect-index", domain: "quick-apply", operation: "clear" });
    await this.persist();
  }
}

class QuickApplyRecipeDomainStore {
  constructor(store, persist) {
    this.store = store;
    this.persist = persist;
    this.listeners = new Set();
  }

  rootState() {
    const value = this.store.state && this.store.state.quickApplyState;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  getLibrary() {
    const metadata = this.rootState().recipeLibrary;
    const safeMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    return {
      ...cloneOracleDomainValue(safeMetadata),
      recipes: Object.values(this.store.state && this.store.state.recipesById || {}).map(cloneOracleDomainValue),
    };
  }

  subscribe(listener, options = {}) {
    if (typeof listener !== "function") return () => undefined;
    this.listeners.add(listener);
    if (options.immediate !== false) listener(this.getLibrary());
    return () => this.listeners.delete(listener);
  }

  async setLibrary(value, reason = "quick-apply-recipes") {
    const library = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const recipes = Array.isArray(library.recipes) ? library.recipes : [];
    const nextState = cloneOracleDomainValue(this.store.state);
    nextState.recipesById = Object.fromEntries(
      recipes
        .filter((recipe) => recipe && typeof recipe === "object" && typeof recipe.id === "string" && recipe.id)
        .map((recipe) => [recipe.id, cloneOracleDomainValue(recipe)]),
    );
    const metadata = cloneOracleDomainValue(library);
    delete metadata.recipes;
    nextState.quickApplyState = {
      ...this.rootState(),
      recipeLibrary: metadata,
    };
    this.store.replaceDomainState(nextState, { type: "quick-apply-recipes", domain: "quick-apply", operation: reason });
    await this.persist();
    const snapshot = this.getLibrary();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  refresh() {
    const snapshot = this.getLibrary();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  destroy() {
    this.listeners.clear();
  }
}

class OraclePanelController {
  constructor() {
    this.dedicatedMounts = new Set();
    // UXP create and show are separate lifecycle events. A panel can be
    // created while still hidden, so observers and adapter leases stay inert
    // until the host delivers the matching show callback.
    this.mainPanelVisible = false;
    this.elements = {
      logo: document.getElementById("oracleLogo"),
      bridgeStatus: document.getElementById("bridgeStatusIndicator"),
      gridScale: document.getElementById("gridScale"),
      gridColumnCount: document.getElementById("gridColumnCount"),
      replayScroller: document.getElementById("replayScroller"),
      navigationToggle: document.getElementById("navigationToggle"),
      navigationBackdrop: document.getElementById("navigationBackdrop"),
      navigationDrawer: document.getElementById("navigationDrawer"),
      preferencesToggle: document.getElementById("preferencesToggle"),
      preferencesBackdrop: document.getElementById("preferencesBackdrop"),
      preferencesPanel: document.getElementById("preferencesPanel"),
      preferencesClose: document.getElementById("preferencesClose"),
      preferencesCancel: document.getElementById("preferencesCancel"),
      preferencesApply: document.getElementById("preferencesApply"),
      preferencesError: document.getElementById("preferencesError"),
      replayWatcherStatus: document.querySelector("[data-replay-watcher-status]"),
      colorPopover: document.getElementById("colorPickerPopover"),
      recentExports: document.getElementById("recentExports"),
      exportCount: document.getElementById("exportCount"),
      grid: document.getElementById("replayGrid"),
      empty: document.getElementById("emptyState"),
      toasts: document.getElementById("toastRegion"),
      screenReaderStatus: document.getElementById("screenReaderStatus"),
      replayToolbar: document.getElementById("replayToolbar"),
      replaySearch: document.getElementById("replaySearch"),
      replaySearchClear: document.getElementById("replaySearchClear"),
      replayFilterToggle: document.getElementById("replayFilterToggle"),
      replayFilterPanel: document.getElementById("replayFilterPanel"),
      replayResultSummary: document.getElementById("replayResultSummary"),
      replayFilteredEmpty: document.getElementById("replayFilteredEmpty"),
      replayContextMenu: document.getElementById("replayContextMenu"),
      replayBatchBar: document.getElementById("replayBatchBar"),
      replaySelectionSummary: document.getElementById("replaySelectionSummary"),
      replayLifecycleBackdrop: document.getElementById("replayLifecycleBackdrop"),
      replayLifecycleDialog: document.getElementById("replayLifecycleDialog"),
      replayLifecycleKicker: document.getElementById("replayLifecycleKicker"),
      replayLifecycleTitle: document.getElementById("replayLifecycleTitle"),
      replayLifecycleClose: document.getElementById("replayLifecycleClose"),
      replayLifecycleBody: document.getElementById("replayLifecycleBody"),
      replayLifecycleError: document.getElementById("replayLifecycleError"),
      replayLifecycleSecondary: document.getElementById("replayLifecycleSecondary"),
      replayLifecycleCancel: document.getElementById("replayLifecycleCancel"),
      replayLifecycleApply: document.getElementById("replayLifecycleApply"),
      replayViewerTray: document.getElementById("replayViewerTray"),
      replayViewerTitle: document.getElementById("replayViewerTitle"),
      replayViewerMode: document.getElementById("replayViewerMode"),
      replayViewerClose: document.getElementById("replayViewerClose"),
      replayViewerPoster: document.getElementById("replayViewerPoster"),
      replayViewerPlayPause: document.getElementById("replayViewerPlayPause"),
      replayViewerStepBack: document.getElementById("replayViewerStepBack"),
      replayViewerStepForward: document.getElementById("replayViewerStepForward"),
      replayViewerTime: document.getElementById("replayViewerTime"),
      replayViewerCurrentTime: document.getElementById("replayViewerCurrentTime"),
      replayViewerDuration: document.getElementById("replayViewerDuration"),
      replayViewerScrub: document.getElementById("replayViewerScrub"),
      replayViewerMute: document.getElementById("replayViewerMute"),
      replayViewerVolume: document.getElementById("replayViewerVolume"),
      replayViewerRate: document.getElementById("replayViewerRate"),
      replayViewerLoop: document.getElementById("replayViewerLoop"),
      replayViewerStatus: document.getElementById("replayViewerStatus"),
      replayViewerError: document.getElementById("replayViewerError"),
      replayViewerSupport: document.getElementById("replayViewerSupport"),
      curvesWorkspace: document.getElementById("curvesWorkspace"),
      curvesWorkspaceState: document.getElementById("curvesWorkspaceState"),
      curvesStateTitle: document.getElementById("curvesStateTitle"),
      curvesStateMessage: document.getElementById("curvesStateMessage"),
      curvesWorkspaceContent: document.getElementById("curvesWorkspaceContent"),
      curvesRefresh: document.getElementById("curvesRefresh"),
      curvesClipSelect: document.getElementById("curvesClipSelect"),
      curvesComponentSelect: document.getElementById("curvesComponentSelect"),
      curvesPropertySelect: document.getElementById("curvesPropertySelect"),
      curvesClipSummary: document.getElementById("curvesClipSummary"),
      curvesComponentSummary: document.getElementById("curvesComponentSummary"),
      curvesPropertySummary: document.getElementById("curvesPropertySummary"),
      curvesEndpointsSummary: document.getElementById("curvesEndpointsSummary"),
      curvesInterpolationSummary: document.getElementById("curvesInterpolationSummary"),
      curvesCompatibilitySummary: document.getElementById("curvesCompatibilitySummary"),
      curvesModeNative: document.getElementById("curvesModeNative"),
      curvesModeBaked: document.getElementById("curvesModeBaked"),
      curvesBakedReason: document.getElementById("curvesBakedReason"),
      curvesNativeInterpolation: document.getElementById("curvesNativeInterpolation"),
      curvesGraph: document.getElementById("curvesGraph"),
      curvesGraphGrid: document.getElementById("curvesGraphGrid"),
      curvesOverlayGroup: document.getElementById("curvesOverlayGroup"),
      curvesGraphPath: document.getElementById("curvesGraphPath"),
      curvesHandleOne: document.getElementById("curvesHandleOne"),
      curvesHandleTwo: document.getElementById("curvesHandleTwo"),
      curvesHandleOneLine: document.getElementById("curvesHandleOneLine"),
      curvesHandleTwoLine: document.getElementById("curvesHandleTwoLine"),
      curvesPointOneX: document.getElementById("curvesPointOneX"),
      curvesPointOneY: document.getElementById("curvesPointOneY"),
      curvesPointTwoX: document.getElementById("curvesPointTwoX"),
      curvesPointTwoY: document.getElementById("curvesPointTwoY"),
      curvesZoomIn: document.getElementById("curvesZoomIn"),
      curvesZoomOut: document.getElementById("curvesZoomOut"),
      curvesFit: document.getElementById("curvesFit"),
      curvesReset: document.getElementById("curvesReset"),
      curvesMirror: document.getElementById("curvesMirror"),
      curvesReverse: document.getElementById("curvesReverse"),
      curvesCopy: document.getElementById("curvesCopy"),
      curvesPaste: document.getElementById("curvesPaste"),
      curvesApply: document.getElementById("curvesApply"),
      curvesStatus: document.getElementById("curvesStatus"),
      curvesSamplePreview: document.getElementById("curvesSamplePreview"),
      curvesPresetBuiltInTab: document.getElementById("curvesPresetBuiltInTab"),
      curvesPresetUserTab: document.getElementById("curvesPresetUserTab"),
      curvesPresetSearch: document.getElementById("curvesPresetSearch"),
      curvesPresetFolder: document.getElementById("curvesPresetFolder"),
      curvesPresetTags: document.getElementById("curvesPresetTags"),
      curvesPresetMetadata: document.getElementById("curvesPresetMetadata"),
      curvesPresetFolderCreate: document.getElementById("curvesPresetFolderCreate"),
      curvesPresetFolderRename: document.getElementById("curvesPresetFolderRename"),
      curvesPresetFolderDelete: document.getElementById("curvesPresetFolderDelete"),
      curvesPresetList: document.getElementById("curvesPresetList"),
      curvesPresetEmpty: document.getElementById("curvesPresetEmpty"),
      curvesPresetCreate: document.getElementById("curvesPresetCreate"),
      curvesPresetSaveAs: document.getElementById("curvesPresetSaveAs"),
      curvesPresetOverwrite: document.getElementById("curvesPresetOverwrite"),
      curvesPresetRename: document.getElementById("curvesPresetRename"),
      curvesPresetDuplicate: document.getElementById("curvesPresetDuplicate"),
      curvesPresetDelete: document.getElementById("curvesPresetDelete"),
      curvesPresetMoveUp: document.getElementById("curvesPresetMoveUp"),
      curvesPresetMoveDown: document.getElementById("curvesPresetMoveDown"),
      curvesPresetFavorite: document.getElementById("curvesPresetFavorite"),
      curvesPresetImport: document.getElementById("curvesPresetImport"),
      curvesPresetExport: document.getElementById("curvesPresetExport"),
      curvesPresetDialogBackdrop: document.getElementById("curvesPresetDialogBackdrop"),
      curvesPresetDialog: document.getElementById("curvesPresetDialog"),
      oraclePromptDialogKicker: document.getElementById("oraclePromptDialogKicker"),
      curvesPresetDialogTitle: document.getElementById("curvesPresetDialogTitle"),
      curvesPresetDialogMessage: document.getElementById("curvesPresetDialogMessage"),
      curvesPresetDialogField: document.getElementById("curvesPresetDialogField"),
      curvesPresetDialogInput: document.getElementById("curvesPresetDialogInput"),
      curvesPresetDialogError: document.getElementById("curvesPresetDialogError"),
      curvesPresetDialogClose: document.getElementById("curvesPresetDialogClose"),
      curvesPresetDialogCancel: document.getElementById("curvesPresetDialogCancel"),
      curvesPresetDialogApply: document.getElementById("curvesPresetDialogApply"),
      quickApplyWorkspace: document.getElementById("quickApplyWorkspace"),
      quickApplyState: document.getElementById("quickApplyState"),
      quickApplyStateTitle: document.getElementById("quickApplyStateTitle"),
      quickApplyStateMessage: document.getElementById("quickApplyStateMessage"),
      quickApplyRefresh: document.getElementById("quickApplyRefresh"),
      quickApplyContent: document.getElementById("quickApplyContent"),
      quickApplySearch: document.getElementById("quickApplySearch"),
      quickApplySearchClear: document.getElementById("quickApplySearchClear"),
      quickApplySelectionSummary: document.getElementById("quickApplySelectionSummary"),
      quickApplyResultsSummary: document.getElementById("quickApplyResultsSummary"),
      quickApplyResults: document.getElementById("quickApplyResults"),
      quickApplyEmpty: document.getElementById("quickApplyEmpty"),
      quickApplyApply: document.getElementById("quickApplyApply"),
      quickApplyFavorite: document.getElementById("quickApplyFavorite"),
      quickApplyStatus: document.getElementById("quickApplyStatus"),
      quickApplyRecipeCreate: document.getElementById("quickApplyRecipeCreate"),
      quickApplyRecipeAddEffect: document.getElementById("quickApplyRecipeAddEffect"),
      quickApplyRecipeRename: document.getElementById("quickApplyRecipeRename"),
      quickApplyRecipeDuplicate: document.getElementById("quickApplyRecipeDuplicate"),
      quickApplyRecipeMoveUp: document.getElementById("quickApplyRecipeMoveUp"),
      quickApplyRecipeMoveDown: document.getElementById("quickApplyRecipeMoveDown"),
      quickApplyRecipeDelete: document.getElementById("quickApplyRecipeDelete"),
      quickApplyRecipeImport: document.getElementById("quickApplyRecipeImport"),
      quickApplyRecipeExport: document.getElementById("quickApplyRecipeExport"),
      quickApplyRecipeBackdrop: document.getElementById("quickApplyRecipeBackdrop"),
      quickApplyRecipeEditor: document.getElementById("quickApplyRecipeEditor"),
      quickApplyRecipeEditorTitle: document.getElementById("quickApplyRecipeEditorTitle"),
      quickApplyRecipeName: document.getElementById("quickApplyRecipeName"),
      quickApplyRecipeApplyOnce: document.getElementById("quickApplyRecipeApplyOnce"),
      quickApplyRecipeStageLabel: document.getElementById("quickApplyRecipeStageLabel"),
      quickApplyRecipeStageEffects: document.getElementById("quickApplyRecipeStageEffects"),
      quickApplyRecipeStageParameters: document.getElementById("quickApplyRecipeStageParameters"),
      quickApplyRecipeStack: document.getElementById("quickApplyRecipeStack"),
      quickApplyRecipeCatalogSearch: document.getElementById("quickApplyRecipeCatalogSearch"),
      quickApplyRecipeCatalog: document.getElementById("quickApplyRecipeCatalog"),
      quickApplyRecipeParameterList: document.getElementById("quickApplyRecipeParameterList"),
      quickApplyRecipeEditorStatus: document.getElementById("quickApplyRecipeEditorStatus"),
      quickApplyRecipeBack: document.getElementById("quickApplyRecipeBack"),
      quickApplyRecipeNext: document.getElementById("quickApplyRecipeNext"),
      quickApplyRecipeSave: document.getElementById("quickApplyRecipeSave"),
      quickApplyRecipeCancel: document.getElementById("quickApplyRecipeCancel"),
    };
    this.wheelScroller = new SmoothWheelScroller(this.elements.replayScroller);
    this.gridScale = new GridScaleControl(
      this.elements.gridScale,
      this.elements.grid,
      this.elements.gridColumnCount,
      (columns) => {
        if (this.theme && typeof this.theme.commitExternal === "function") {
          try {
            this.theme.commitExternal("replay.gridColumns", columns);
          } catch (error) {
            this.showToast("Oracle could not persist the grid density.", "error");
          }
        }
      },
      () => {
        if (this.view && typeof this.view.handleLayoutChanged === "function") {
          this.view.handleLayoutChanged();
        }
      },
    );
    const preferencesApi = oracleWindow.OracleOverdrivePreferences;
    const shellApi = oracleWindow.OracleOverdriveShell;
    const replayLibraryApi = oracleWindow.OracleReplayLibrary;
    const replayWorkspaceApi = oracleWindow.OracleReplayWorkspace;
    const replayOrganizationApi = oracleWindow.OracleReplayOrganization;
    const replayLifecycleUiApi = oracleWindow.OracleReplayLifecycleUI;
    const replayViewerApi = oracleWindow.OracleReplayViewer;
    const curveMathApi = oracleWindow.OracleCurveMath;
    const curvePresetApi = oracleWindow.OracleCurvePresets;
    const curvesAdapterApi = oracleWindow.OraclePremiereCurvesAdapter;
    const curvesWorkspaceApi = oracleWindow.OracleCurvesWorkspace;
    const effectIndexApi = oracleWindow.OracleEffectIndex;
    const effectsAdapterApi = oracleWindow.OraclePremiereEffectsAdapter;
    const quickApplyDomainApi = oracleWindow.OracleQuickApplyDomain;
    const quickApplyWorkspaceApi = oracleWindow.OracleQuickApplyWorkspace;
    const runtimeRegistryApi = oracleWindow.OracleRuntimeRegistry;
    if (!preferencesApi || typeof preferencesApi.OraclePreferencesController !== "function") {
      throw new Error("Oracle Preferences module did not load.");
    }
    if (!shellApi || typeof shellApi.OracleShellController !== "function") {
      throw new Error("Oracle shell module did not load.");
    }
    if (!replayLibraryApi || typeof replayLibraryApi.ReplayLibraryStore !== "function") {
      throw new Error("Oracle v3 replay library module did not load.");
    }
    if (!replayWorkspaceApi || typeof replayWorkspaceApi.ReplayWorkspaceController !== "function") {
      throw new Error("Oracle replay workspace module did not load.");
    }
    if (!replayOrganizationApi) {
      throw new Error("Oracle replay organization module did not load.");
    }
    if (!replayLifecycleUiApi || typeof replayLifecycleUiApi.ReplayLifecycleDialogController !== "function") {
      throw new Error("Oracle replay lifecycle UI module did not load.");
    }
    if (!replayViewerApi || typeof replayViewerApi.ReplayViewerController !== "function") {
      throw new Error("Oracle replay viewer module did not load.");
    }
    if (!curveMathApi || typeof curveMathApi.createBakedCurveSamples !== "function") {
      throw new Error("Oracle curve math module did not load.");
    }
    if (!curvePresetApi || typeof curvePresetApi.normalizePresetLibrary !== "function") {
      throw new Error("Oracle curve preset module did not load.");
    }
    if (!curvesAdapterApi || typeof curvesAdapterApi.PremiereCurvesAdapter !== "function") {
      throw new Error("Oracle Premiere Curves adapter did not load.");
    }
    if (!curvesWorkspaceApi || typeof curvesWorkspaceApi.CurvesWorkspaceController !== "function") {
      throw new Error("Oracle Curves workspace module did not load.");
    }
    if (!effectIndexApi || typeof effectIndexApi.createEffectIndex !== "function") {
      throw new Error("Oracle supported effect index module did not load.");
    }
    if (!effectsAdapterApi || typeof effectsAdapterApi.PremiereQuickApplyAdapter !== "function") {
      throw new Error("Oracle Premiere Quick Apply adapter did not load.");
    }
    if (!quickApplyDomainApi || typeof quickApplyDomainApi.QuickApplyDomain !== "function") {
      throw new Error("Oracle Quick Apply domain module did not load.");
    }
    if (!quickApplyWorkspaceApi || typeof quickApplyWorkspaceApi.QuickApplyWorkspaceController !== "function") {
      throw new Error("Oracle Quick Apply workspace module did not load.");
    }
    if (
      !runtimeRegistryApi ||
      typeof runtimeRegistryApi.ActivationLeaseCoordinator !== "function" ||
      typeof runtimeRegistryApi.SourceMonitorViewerLeaseCoordinator !== "function"
    ) {
      throw new Error("Oracle multi-panel runtime registry module did not load.");
    }
    this.replayLibraryApi = replayLibraryApi;
    this.replayOrganizationApi = replayOrganizationApi;
    this.curveMathApi = curveMathApi;
    this.curvePresetApi = curvePresetApi;
    this.effectsAdapterApi = effectsAdapterApi;
    this.quickApplyDomainApi = quickApplyDomainApi;
    this.quickApplyWorkspaceApi = quickApplyWorkspaceApi;
    this.runtimeRegistryApi = runtimeRegistryApi;
    this.mainRoot = document.querySelector("body > .oracle-panel") || document.body;
    this.theme = new preferencesApi.OraclePreferencesController(this.elements, {
      root: this.mainRoot,
      document,
      onApply: (preferences, context) => this.applyWorkspacePreferences(preferences, context),
      onToast: (message, kind) => this.showToast(message, kind),
      onClearThumbnailCache: () => this.clearThumbnailCache(),
      onExportMetadata: () => this.exportReplayMetadata(),
      onImportMetadata: (payload) => this.importReplayMetadata(payload),
      onResetMetadata: () => this.resetReplayMetadata(),
      getStorageSummary: () => this.thumbnailCache ? this.thumbnailCache.usage() : null,
      getDiagnosticsSummary: () => typeof oracleDiagnostics !== "undefined" && oracleDiagnostics && typeof oracleDiagnostics.summary === "function"
        ? oracleDiagnostics.summary({ limit: 200 })
        : null,
      onDiagnostic: (level, code, details) => typeof recordOracleDiagnostic === "function"
        ? recordOracleDiagnostic(level, code, details)
        : null,
    });
    this.shell = new shellApi.OracleShellController(this.elements, {
      root: this.mainRoot,
      document,
      onRouteChange: (route) => this.applyMainPanelRoute(route, "route-change"),
    });
    this.logo = new OracleLogoAnimator(this.elements.logo);
    this.gateway = new PremiereGateway(premiere, {
      getImportSuppression: () =>
        this.view && typeof this.view.getImportSuppression === "function"
          ? this.view.getImportSuppression()
          : null,
    });
    this.viewerAdapter = new PremiereSourceMonitorViewerAdapter(premiere);
    this.viewerAdapterCoordinator = new runtimeRegistryApi.SourceMonitorViewerLeaseCoordinator(
      this.viewerAdapter,
    );
    this.viewerAdapterLease = this.viewerAdapterCoordinator.acquireLease("oraclePanel:replays", {
      onRevoked: (event) => {
        if (event && event.reason === "superseded" && this.viewer && !this.destroyed) {
          void this.viewer.close("superseded");
        }
      },
    });
    this.viewer = new replayViewerApi.ReplayViewerController({
      root: this.elements.replayViewerTray,
      title: this.elements.replayViewerTitle,
      status: this.elements.replayViewerStatus,
      mode: this.elements.replayViewerMode,
      poster: this.elements.replayViewerPoster,
      playPause: this.elements.replayViewerPlayPause,
      seek: this.elements.replayViewerScrub,
      currentTime: this.elements.replayViewerCurrentTime,
      duration: this.elements.replayViewerDuration,
      stepBackward: this.elements.replayViewerStepBack,
      stepForward: this.elements.replayViewerStepForward,
      mute: this.elements.replayViewerMute,
      volume: this.elements.replayViewerVolume,
      speed: this.elements.replayViewerRate,
      loop: this.elements.replayViewerLoop,
      close: this.elements.replayViewerClose,
      error: this.elements.replayViewerError,
      support: this.elements.replayViewerSupport,
    }, {
      adapter: this.viewerAdapterLease,
      onUsage: (replayOrId) => {
        if (replayOrId && typeof replayOrId === "object" && replayOrId.action !== "open") return;
        const replayId = typeof replayOrId === "string"
          ? replayOrId
          : String(replayOrId && (replayOrId.replayId || replayOrId.id) || "");
        if (replayId) this.recordReplayUsage(replayId, "opened");
      },
      onToast: (message, kind) => this.showToast(
        message,
        typeof kind === "string" ? kind : String(kind && kind.tone || "info"),
      ),
      onAnnounce: (message) => this.announce(message),
      document,
    });
    this.view = new ReplayGridView(this.elements, {
      document,
      root: this.mainRoot,
      onOpen: (replay) => this.openReplayViewer(replay),
      onInsert: (replay) => this.explicitImportReplay(replay),
      onNativeDragResult: (replay, result, canonicalPath) =>
        this.handleNativeDragResult(replay, result, canonicalPath),
      onBlockedDrag: (reason) => this.showToast(reason, "error"),
      onContextAction: (action, replay, selected) => this.handleReplayContextAction(action, replay, selected),
      onSelectionChange: (ids, replays) => this.updateReplaySelectionUi(ids, replays),
      onAnnounce: (message) => this.announce(message),
      onReorder: (request) => this.handleReplayReorder(request),
      getContextActionState: (action, replay, selected) =>
        this.getReplayContextActionState(action, replay, selected),
      onThumbnailUsed: (key) => {
        if (this.thumbnailCache) this.thumbnailCache.touch(key);
      },
      getReplayById: (id) => this.store && this.store.getById(id),
      getGridColumns: () => this.gridScale ? this.gridScale.effectiveColumns : 1,
      virtualizer: new replayLibraryApi.ReplayVirtualWindow(),
      nativeAddon: nativeDragAddon,
      nativeAddonDiagnostic: nativeDragAddonDiagnostic,
    });
    this.store = new replayLibraryApi.ReplayLibraryStore({
      writerId: "oracle-premiere-v5",
      emitItems: false,
      onChange: (_items, change) => {
        this.refreshReplayWorkspace(change);
        for (const mount of Array.from(this.dedicatedMounts)) {
          if (mount && mount.kind === "replays" && typeof mount.refresh === "function") {
            mount.refresh(change);
          }
        }
      },
    });
    this.replayQuery = replayWorkspaceApi.normalizeQueryState({ view: "all" });
    this.workspace = new replayWorkspaceApi.ReplayWorkspaceController(this.elements, {
      document,
      root: this.mainRoot,
      onQueryChange: (query) => {
        this.replayQuery = query;
        this.refreshReplayWorkspace({ type: "query", resetScroll: true });
      },
    });
    this.lifecycleUi = new replayLifecycleUiApi.ReplayLifecycleDialogController(this.elements, {
      document,
      root: this.mainRoot,
      onApply: (mode, payload, context) => this.applyReplayLifecycleAction(mode, payload, context),
      onChooseRelink: (context) => this.chooseReplayRelink(context),
      onCollectionCommand: (command, payload, context) =>
        this.applyCollectionCommand(command, payload, context),
      onCancelBusy: (mode, context) => this.cancelReplayLifecycleOperation(mode, context),
      onAnnounce: (message) => this.announce(message),
    });
    this.persistence = new replayLibraryApi.OracleStateRepository({
      fs: uxpFs,
      atomicWriter: createNativeStateAtomicWriter(nativeDragAddon),
      writerId: "oracle-premiere-v5",
      legacyLoader: async () => {
        const candidates = [];
        const local = loadLocalReplayHistory();
        const primary = await readReplayHistoryFile(REPLAY_HISTORY_FILE_URL);
        const backup = await readReplayHistoryFile(REPLAY_HISTORY_BACKUP_FILE_URL);
        if (primary.length) candidates.push({ source: "legacy-v2-primary", value: { version: 2, replays: primary } });
        if (backup.length) candidates.push({ source: "legacy-v2-backup", value: { version: 2, replays: backup } });
        if (local.length) candidates.push({ source: "legacy-v2-local", value: { version: 2, replays: local } });
        return candidates;
      },
    });
    const linearInterpolationMode = premiere && premiere.Constants && premiere.Constants.InterpolationMode
      ? premiere.Constants.InterpolationMode.LINEAR
      : null;
    this.curvesPresetDialog = new CurvePresetDialogController(this.elements);
    this.curvesAdapter = new curvesAdapterApi.PremiereCurvesAdapter({
      api: premiere,
      document,
      visible: false,
      active: false,
      minPollIntervalMs: 100,
      maxPollIntervalMs: 250,
      bakedRuntimeProof: {
        version: 1,
        verified: true,
        hostVersion: nativeDragRuntimeInfo().hostVersion,
        verifiedAt: "2026-07-16",
        source: "m5-disposable-project-live-probe",
        defaultLinearInterpolationMode: linearInterpolationMode,
        valueKinds: ["number"],
        detachedKeyframes: true,
        generatedKeyActions: true,
        defaultLinearReadback: true,
        exactEndpointReadback: true,
        oneTransaction: true,
        oneUndoStep: true,
        undoRemovedGeneratedKeys: true,
      },
    });
    this.curvesAdapterCoordinator = new runtimeRegistryApi.ActivationLeaseCoordinator(
      this.curvesAdapter,
    );
    this.curvesAdapterLease = this.curvesAdapterCoordinator.acquireLease("oraclePanel:curves");
    this.curvePresetStore = new CurvePresetDomainStore(
      this.store,
      curvePresetApi,
      () => this.persistOracleState(),
      () => !this.metadataMutationActive && !this.destroyed,
    );
    this.curveWorkspaceStateStore = new CurveWorkspaceStateStore(
      this.store,
      () => this.persistOracleState(),
      () => !this.metadataMutationActive && !this.destroyed,
    );
    this.curvesWorkspace = new curvesWorkspaceApi.CurvesWorkspaceController(this.elements, {
      adapter: this.curvesAdapterLease,
      curveMath: curveMathApi,
      presetApi: curvePresetApi,
      presetStore: this.curvePresetStore,
      stateStore: this.curveWorkspaceStateStore,
      presetHooks: this.createCurvePresetHooks(),
      confirmPresetAction: (request) => this.confirmCurvePresetAction(request),
      confirmBakedApply: (request) => this.confirmCurveBake(request),
      preferences: this.theme.committed && this.theme.committed.curves,
      visible: false,
      active: false,
      ownsAdapter: false,
      onToast: (message, kind) => this.showToast(
        message,
        typeof kind === "string" ? kind : String(kind && kind.tone || "info"),
      ),
      onAnnounce: (message) => this.announce(message),
      document,
    });
    this.thumbnailCache = new replayLibraryApi.ThumbnailCache({ fs: uxpFs, concurrency: 2 });
    this.metadataQueue = new replayLibraryApi.BoundedTaskQueue(2);
    this.metadataMutationPromise = null;
    this.metadataMutationActive = false;
    this.metadataMutationGeneration = 0;
    this.processingGenerations = new Map();
    this.processingTasks = new Map();
    this.replayRecordCount = 0;
    this.polledReplayIds = new Map();
    this.exportPoller = new ExportDirectoryPoller((payload) =>
      this.acceptPolledReplay(payload),
    );
    this.importChain = Promise.resolve();
    this.retryTimers = new Map();
    this.retryAttempts = new Map();
    this.toastTimers = new Set();
    this.announceTimer = null;
    this.sourceMonitorPlaying = false;
    this.sourceMonitorReplayId = "";
    this.nativeWatchRoots = [];
    this.nativeWatchTimer = null;
    this.nativeWatchRefreshTimer = null;
    this.nativeRegistrationTasks = new Map();
    this.nativeWatcherTasks = new Set();
    this.nativeMissingVerificationTimers = new Map();
    this.nativeLifecycleStarted = false;
    this.activeFileOperationRequestId = null;
    this.onReplayBatchClick = (event) => this.handleReplayBatchClick(event);
    this.destroyed = false;
    this.destroyPromise = null;
    this.handleBeforeUnload = () => this.destroy();
    this.handleRuntimeReplacement = (event) => {
      const teardown = this.destroy();
      const waitUntil = event && Reflect.get(event, "waitUntil");
      if (typeof waitUntil === "function") waitUntil.call(event, teardown);
      return teardown;
    };
  }

  initializeQuickApply() {
    if (this.quickApplyWorkspace || this.destroyed) return;
    const effectsAdapterApi = this.effectsAdapterApi;
    const quickApplyDomainApi = this.quickApplyDomainApi;
    const quickApplyWorkspaceApi = this.quickApplyWorkspaceApi;
    const persistQuickApplyState = () => this.persistOracleState({ propagate: true });
    this.quickApplyStateStore = new QuickApplyStateDomainStore(this.store, persistQuickApplyState);
    this.quickApplyRecipeStore = new QuickApplyRecipeDomainStore(this.store, persistQuickApplyState);
    this.quickApplyEffectIndexStore = new QuickApplyEffectIndexStore(
      this.store,
      persistQuickApplyState,
      () => !this.metadataMutationActive && !this.destroyed,
    );
    this.quickApplyAdapter = new effectsAdapterApi.PremiereQuickApplyAdapter({
      api: premiere,
      document,
      hostVersion: nativeDragRuntimeInfo().hostVersion,
      effectIndexStore: this.quickApplyEffectIndexStore,
      visible: false,
      active: false,
      minPollIntervalMs: 100,
      maxPollIntervalMs: 250,
    });
    this.quickApplyAdapterCoordinator = new this.runtimeRegistryApi.ActivationLeaseCoordinator(
      this.quickApplyAdapter,
    );
    this.quickApplyAdapterLease = this.quickApplyAdapterCoordinator.acquireLease("oraclePanel:quick-apply");
    this.quickApplyDomain = new quickApplyDomainApi.QuickApplyDomain({
      adapter: this.quickApplyAdapterLease,
      stateStore: this.quickApplyStateStore,
      recipeStore: this.quickApplyRecipeStore,
      preferences: this.theme.committed && this.theme.committed.quickApply,
      visible: false,
      active: false,
      ownsAdapter: false,
    });
    this.quickApplyWorkspace = new quickApplyWorkspaceApi.QuickApplyWorkspaceController(this.elements, {
      domain: this.quickApplyDomain,
      ownsDomain: false,
      visible: false,
      active: false,
      requestRecipeName: (request) => this.requestQuickApplyRecipeName(request),
      confirmRecipeAction: (request) => this.confirmQuickApplyRecipeAction(request),
      importRecipeFile: (request) => this.importQuickApplyRecipes(request),
      exportRecipeFile: (request) => this.exportQuickApplyRecipes(request),
      onRequestCloseTopLayer: () => this.shell.setRoute("replays"),
      onToast: (message, kind) => this.showToast(
        message,
        typeof kind === "string" ? kind : String(kind && kind.tone || "info"),
      ),
      onAnnounce: (message) => this.announce(message),
      document,
    });
  }

  registerDedicatedMount(mount) {
    if (!mount || this.destroyed) return false;
    if (!this.dedicatedMounts) this.dedicatedMounts = new Set();
    this.dedicatedMounts.add(mount);
    return true;
  }

  unregisterDedicatedMount(mount) {
    return this.dedicatedMounts ? this.dedicatedMounts.delete(mount) : false;
  }

  applyMainPanelRoute(route, reason = "route-change") {
    const nextRoute = String(route || this.shell && this.shell.route || "replays");
    const panelVisible = this.mainPanelVisible !== false;
    const curvesActive = panelVisible && nextRoute === "curves";
    const quickApplyActive = panelVisible && nextRoute === "quick-apply";
    if (this.curvesWorkspace) {
      this.curvesWorkspace.setVisible(curvesActive);
      this.curvesWorkspace.setActive(curvesActive);
    }
    if (this.quickApplyWorkspace) {
      this.quickApplyWorkspace.setVisible(quickApplyActive);
      this.quickApplyWorkspace.setActive(quickApplyActive);
    }
    if (panelVisible && nextRoute === "replays") {
      if (this.gridScale) this.gridScale.scheduleLayout();
    } else if (this.viewer) {
      void this.viewer.close(panelVisible ? reason : "panel-hide");
    }
  }

  setMainPanelVisible(value) {
    if (this.destroyed) return false;
    const next = Boolean(value);
    this.mainPanelVisible = next;
    if (this.mainRoot && typeof this.mainRoot.setAttribute === "function") {
      this.mainRoot.setAttribute("data-oracle-panel-visible", next ? "true" : "false");
    }
    if (!next && this.theme && this.theme.isOpen && typeof this.theme.cancel === "function") {
      this.theme.cancel();
    }
    this.applyMainPanelRoute(this.shell && this.shell.route, next ? "panel-show" : "panel-hide");
    return true;
  }

  async start() {
    document.addEventListener(ORACLE_RUNTIME_REPLACE_EVENT, this.handleRuntimeReplacement);
    window.addEventListener("beforeunload", this.handleBeforeUnload, { once: true });
    this.shell.start();
    this.wheelScroller.start();
    this.gridScale.start();
    this.theme.start();
    this.logo.start();
    this.workspace.start();
    this.lifecycleUi.start();
    this.viewer.start();
    this.curvesPresetDialog.start();
    this.elements.replayBatchBar.addEventListener("click", this.onReplayBatchClick);
    this.view.render([], { totalCount: 0 });
    const recovered = await this.persistence.load();
    if (this.destroyed) {
      return;
    }
    this.store.hydrate(recovered.state);
    this.initializeQuickApply();
    if (recovered.source !== "primary") {
      try {
        const healed = await this.persistence.save(this.store.state);
        if (!this.destroyed) this.store.adoptPersistenceMetadata(healed);
      } catch (error) {
        if (!this.destroyed) {
          this.showToast("Oracle restored replay metadata but could not repair the primary state file.", "error");
        }
      }
    }
    await this.thumbnailCache.load();
    if (this.destroyed) {
      return;
    }
    this.curvesWorkspace.start();
    this.quickApplyWorkspace.start();
    this.applyMainPanelRoute(this.shell.route, "startup");
    this.startNativeReplayLifecycle();
    this.exportPoller.start(this.store.items);
    startBridge((message) => this.handleBridgeMessage(message));
  }

  commitCurvePresetResult(result, operation) {
    if (!result || result.ok !== true) return result;
    const library = this.curvePresetStore.commit(result.library, operation);
    return { ...result, library };
  }

  async chooseCurvePresetName(config, dialog = this.curvesPresetDialog) {
    const value = await dialog.requestName(config);
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null;
  }

  createCurvePresetHooks(dialog = this.curvesPresetDialog) {
    return {
      create: async (payload) => {
        const name = await this.chooseCurvePresetName({
          title: "New curve preset",
          message: "Save the current local curve preview as a user preset.",
          initialValue: "My Curve",
          applyLabel: "Create",
        }, dialog);
        if (!name) return { ok: true, cancelled: true, library: payload.library };
        return this.commitCurvePresetResult(
          this.curvePresetApi.createUserPreset(payload.library, { ...payload.draft, name }),
          "create",
        );
      },
      saveAs: async (payload) => {
        const name = await this.chooseCurvePresetName({
          title: "Save curve as",
          message: "Create a separate user preset from the current curve.",
          initialValue: payload.preset ? `${payload.preset.name} Copy` : "Oracle Curve",
          applyLabel: "Save As",
        }, dialog);
        if (!name) return { ok: true, cancelled: true, library: payload.library };
        return this.commitCurvePresetResult(
          this.curvePresetApi.saveAsUserPreset(payload.library, payload.draft, name),
          "save-as",
        );
      },
      overwrite: async (payload) => this.commitCurvePresetResult(
        this.curvePresetApi.overwriteUserPreset(
          payload.library,
          payload.preset.id,
          { ...payload.draft, name: payload.preset.name },
          { confirmed: payload.confirmed === true },
        ),
        "overwrite",
      ),
      rename: async (payload) => {
        const name = await this.chooseCurvePresetName({
          title: "Rename curve preset",
          message: "Rename this user preset without changing its curve.",
          initialValue: payload.preset.name,
          applyLabel: "Rename",
        }, dialog);
        if (!name) return { ok: true, cancelled: true, library: payload.library };
        return this.commitCurvePresetResult(
          this.curvePresetApi.renameUserPreset(payload.library, payload.preset.id, name),
          "rename",
        );
      },
      duplicate: async (payload) => {
        const name = await this.chooseCurvePresetName({
          title: "Duplicate curve preset",
          message: "Create a new editable user preset from this curve.",
          initialValue: `${payload.preset.name} Copy`,
          applyLabel: "Duplicate",
        }, dialog);
        if (!name) return { ok: true, cancelled: true, library: payload.library };
        return this.commitCurvePresetResult(
          this.curvePresetApi.duplicateUserPreset(payload.library, payload.preset.id, { name }),
          "duplicate",
        );
      },
      delete: async (payload) => this.commitCurvePresetResult(
        this.curvePresetApi.deleteUserPreset(payload.library, payload.preset.id, {
          confirmed: payload.confirmed === true,
        }),
        "delete",
      ),
      moveUp: async (payload) => {
        const index = payload.library.presets.findIndex((preset) => preset.id === payload.preset.id);
        return this.commitCurvePresetResult(
          this.curvePresetApi.reorderUserPreset(payload.library, payload.preset.id, Math.max(0, index - 1)),
          "move-up",
        );
      },
      moveDown: async (payload) => {
        const index = payload.library.presets.findIndex((preset) => preset.id === payload.preset.id);
        return this.commitCurvePresetResult(
          this.curvePresetApi.reorderUserPreset(
            payload.library,
            payload.preset.id,
            Math.min(payload.library.presets.length - 1, index + 1),
          ),
          "move-down",
        );
      },
      favorite: async (payload) => this.commitCurvePresetResult(
        this.curvePresetApi.setPresetFavorite(
          payload.library,
          payload.preset.id,
          payload.preset.favorite !== true,
        ),
        "favorite",
      ),
      metadata: async (payload) => this.commitCurvePresetResult(
        this.curvePresetApi.updateUserPresetOrganization(
          payload.library,
          payload.preset.id,
          { tags: payload.tags, folderId: payload.folderId },
        ),
        "metadata",
      ),
      reorder: async (payload) => this.commitCurvePresetResult(
        this.curvePresetApi.reorderUserPreset(
          payload.library,
          payload.preset.id,
          payload.targetIndex,
        ),
        "reorder",
      ),
      folderCreate: async (payload) => {
        const name = await this.chooseCurvePresetName({
          title: "New curve folder",
          message: "Create a folder for organizing Oracle user curve presets.",
          initialValue: "My Curves",
          applyLabel: "Create Folder",
        }, dialog);
        if (!name) return { ok: true, cancelled: true, library: payload.library };
        return this.commitCurvePresetResult(
          this.curvePresetApi.createFolder(payload.library, name),
          "folder-create",
        );
      },
      folderRename: async (payload) => {
        const folder = payload.library.folders.find((entry) => entry.id === payload.folderId);
        if (!folder) return { ok: false, message: "Choose a curve folder to rename." };
        const name = await this.chooseCurvePresetName({
          title: "Rename curve folder",
          message: "Rename this Oracle curve preset folder.",
          initialValue: folder.name,
          applyLabel: "Rename Folder",
        }, dialog);
        if (!name) return { ok: true, cancelled: true, library: payload.library };
        return this.commitCurvePresetResult(
          this.curvePresetApi.renameFolder(payload.library, folder.id, name),
          "folder-rename",
        );
      },
      folderDelete: async (payload) => {
        const folder = payload.library.folders.find((entry) => entry.id === payload.folderId);
        if (!folder) return { ok: false, message: "Choose a curve folder to delete." };
        const confirmed = await dialog.confirm({
          title: "Delete curve folder?",
          message: `Delete ${folder.name}? Presets in this folder become Unfiled; no preset or Premiere media is deleted.`,
          applyLabel: "Delete Folder",
          tone: "danger",
        });
        if (confirmed !== true) return { ok: true, cancelled: true, library: payload.library };
        return this.commitCurvePresetResult(
          this.curvePresetApi.deleteFolder(payload.library, folder.id, { confirmed: true }),
          "folder-delete",
        );
      },
      import: async (payload) => {
        const moduleName = "u" + "xp";
        const uxp = require(moduleName);
        const storage = uxp && uxp.storage;
        const picker = storage && storage.localFileSystem;
        if (!picker || typeof picker.getFileForOpening !== "function") {
          throw new Error("Premiere's JSON file picker is unavailable.");
        }
        const entry = await picker.getFileForOpening({ types: ["json"], allowMultiple: false });
        if (!entry) return { ok: true, cancelled: true, library: payload.library };
        if (String(entry.name || "").toLowerCase().endsWith(".prfpset")) {
          throw new Error("Premiere .prfpset files are not Oracle curve libraries.");
        }
        let rawSize;
        if (typeof entry.getMetadata === "function") {
          let metadata;
          try {
            metadata = await entry.getMetadata();
          } catch (error) {
            throw new Error("Oracle could not verify the curve preset file size before reading it.");
          }
          rawSize = metadata && metadata.size;
        } else rawSize = entry.size;
        const sizeCheck = this.curvePresetApi.validatePresetImportByteLength(rawSize);
        if (!sizeCheck.ok) throw new Error(sizeCheck.message);
        const text = await entry.read({ format: storage.formats.utf8 });
        const result = this.curvePresetApi.importPresetLibrary(String(text), payload.library, {
          filename: String(entry.name || ""),
          strategy: "merge",
        });
        return this.commitCurvePresetResult(result, "import");
      },
      export: async (payload) => {
        const moduleName = "u" + "xp";
        const uxp = require(moduleName);
        const storage = uxp && uxp.storage;
        const picker = storage && storage.localFileSystem;
        if (!picker || typeof picker.getFileForSaving !== "function") {
          throw new Error("Premiere's JSON save picker is unavailable.");
        }
        const exported = this.curvePresetApi.exportPresetLibrary(payload.library, {
          filename: "oracle-curve-presets.json",
        });
        if (!exported.ok) return exported;
        const entry = await picker.getFileForSaving(exported.filename, { types: ["json"] });
        if (!entry) return { ok: true, cancelled: true, library: payload.library };
        await entry.write(exported.text, { format: storage.formats.utf8 });
        return { ok: true, library: payload.library, exported: true };
      },
    };
  }

  confirmCurvePresetAction(request = {}, dialog = this.curvesPresetDialog) {
    const action = request.action === "delete" ? "delete" : "overwrite";
    const presetName = String(request.preset && request.preset.name || "this curve preset");
    return dialog.confirm({
      title: action === "delete" ? "Delete curve preset?" : "Overwrite curve preset?",
      message: action === "delete"
        ? `Delete ${presetName}? This removes only Oracle preset metadata and never touches Premiere media.`
        : `Replace ${presetName} with the current local curve preview?`,
      applyLabel: action === "delete" ? "Delete" : "Overwrite",
    });
  }

  confirmCurveBake(request = {}, dialog = this.curvesPresetDialog) {
    const addedKeyCount = Math.max(0, Math.trunc(Number(request.addedKeyCount) || 0));
    const warningThreshold = Math.max(0, Math.trunc(Number(request.warningThreshold) || 0));
    const bindingCount = Math.max(0, Math.trunc(Number(request.bindingCount) || 0));
    return dialog.confirm({
      title: "Apply large baked curve?",
      message: `This bake will add ${addedKeyCount} intermediate key${addedKeyCount === 1 ? "" : "s"} across ${bindingCount} target${bindingCount === 1 ? "" : "s"}, above your warning threshold of ${warningThreshold}. Premiere is unchanged until you confirm.`,
      applyLabel: "Apply Bake",
      tone: "warning",
    });
  }

  requestQuickApplyRecipeName(request = {}, dialog = this.curvesPresetDialog) {
    const mode = String(request.mode || "create");
    return dialog.requestName({
      kicker: "Oracle Recipes",
      nameLabel: "Oracle Recipe",
      title: String(request.title || (mode === "rename" ? "Rename Oracle Recipe" : "Name Oracle Recipe")),
      message: mode === "duplicate"
        ? "Choose a distinct name for the duplicated ordered effect stack."
        : mode === "rename"
          ? "Rename only Oracle recipe metadata; installed Premiere effects are unchanged."
          : "Choose a name for this ordered, verified Premiere effect stack.",
      initialValue: String(request.value || "New Oracle Recipe"),
      applyLabel: mode === "rename" ? "Rename" : mode === "duplicate" ? "Duplicate" : "Create",
    });
  }

  confirmQuickApplyRecipeAction(request = {}, dialog = this.curvesPresetDialog) {
    const recipeName = String(request.recipe && request.recipe.name || "this Oracle Recipe");
    return dialog.confirm({
      kicker: "Oracle Recipes",
      nameLabel: "Oracle Recipe",
      title: String(request.title || "Delete Oracle Recipe?"),
      message: String(request.message || `Delete ${recipeName}? This removes only Oracle recipe metadata and never changes Premiere media.`),
      applyLabel: "Delete",
    });
  }

  async importQuickApplyRecipes(_request = {}) {
    const moduleName = "u" + "xp";
    const uxpRuntime = require(moduleName);
    const storage = uxpRuntime && uxpRuntime.storage;
    const picker = storage && storage.localFileSystem;
    if (!picker || typeof picker.getFileForOpening !== "function") {
      throw new Error("Oracle Recipe import needs the UXP JSON file picker.");
    }
    const entry = await picker.getFileForOpening({ types: ["json"], allowMultiple: false });
    if (!entry) return null;
    const domainApi = this.quickApplyDomainApi;
    const importLimit = Number(domainApi && domainApi.MAX_IMPORT_BYTES);
    if (!Number.isSafeInteger(importLimit) || importLimit <= 0 || typeof domainApi.utf8ByteLength !== "function") {
      throw new Error("Oracle Recipe import limits are unavailable in this runtime.");
    }
    let rawSize;
    if (typeof entry.getMetadata === "function") {
      let metadata;
      try {
        metadata = await entry.getMetadata();
      } catch {
        throw new Error("Oracle could not verify the selected JSON file size before reading it.");
      }
      rawSize = metadata && metadata.size;
    } else rawSize = entry.size;
    const entrySize = Number(rawSize);
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
      throw new Error("Oracle could not verify the selected JSON file size before reading it.");
    }
    if (entrySize > importLimit) throw new Error("Oracle Recipe JSON exceeds the 2 MB import limit.");
    const text = String(await entry.read({ format: storage.formats.utf8 }) || "");
    if (domainApi.utf8ByteLength(text) > importLimit) {
      throw new Error("Oracle Recipe JSON exceeds the 2 MB import limit.");
    }
    return {
      text,
      filename: String(entry.name || "oracle-recipes.json").slice(0, 260),
    };
  }

  async exportQuickApplyRecipes(request = {}) {
    const moduleName = "u" + "xp";
    const uxpRuntime = require(moduleName);
    const storage = uxpRuntime && uxpRuntime.storage;
    const picker = storage && storage.localFileSystem;
    if (!picker || typeof picker.getFileForSaving !== "function") {
      throw new Error("Oracle Recipe export needs the UXP JSON file picker.");
    }
    const suggestedName = String(request.suggestedName || "Oracle-Recipes.json").slice(0, 260);
    const entry = await picker.getFileForSaving(suggestedName, { types: ["json"] });
    if (!entry) return null;
    await entry.write(String(request.text || ""), { format: storage.formats.utf8 });
    return { ok: true, filename: String(entry.name || suggestedName).slice(0, 260) };
  }

  applyWorkspacePreferences(preferences, context = {}) {
    const preferencesApi = oracleWindow.OracleOverdrivePreferences;
    const previousRootSignature = nativeConfiguredWatchRootSignature(oracleWindow.oracleWorkspacePreferences);
    const normalized = preferencesApi.applyPreferencesToDocument(preferences, document);
    oracleWindow.oracleWorkspacePreferences = normalized;
    if (this.gridScale && normalized && normalized.replay) {
      this.gridScale.updateGridColumns(
        normalized.replay.gridColumns,
        context.source === "apply" || context.source === "cancel",
      );
    }
    if (this.curvesWorkspace && normalized && normalized.curves) {
      this.curvesWorkspace.setPreferences(normalized.curves);
    }
    if (this.quickApplyWorkspace && normalized && normalized.quickApply) {
      this.quickApplyWorkspace.setPreferences(normalized.quickApply);
    }
    for (const mount of Array.from(this.dedicatedMounts || [])) {
      if (mount && typeof mount.setPreferences === "function") mount.setPreferences(normalized);
    }
    if (
      !this.destroyed &&
      context.preview !== true &&
      this.nativeLifecycleStarted &&
      previousRootSignature !== nativeConfiguredWatchRootSignature(normalized)
    ) {
      try {
        this.restartNativeDirectoryWatch([]);
      } catch (error) {
        this.showToast(error && error.message ? error.message : String(error), "error");
      }
    }
    this.updateNativeWatcherStatus();
  }

  refreshReplayWorkspace(change = {}) {
    if (this.destroyed || !this.store || !this.workspace || !this.view) return;
    if (this.canApplyReplayChangeInPlace(change)) {
      this.view.updateReplays(change.replays || [], this.replayRecordCount);
      return;
    }
    const ids = this.store.select(this.replayQuery || { view: "all" });
    const items = this.store.presentations(ids);
    const state = this.store.state;
    const records = Object.values(state.replaysById || {});
    this.replayRecordCount = records.length;
    const tags = Array.from(new Set(records.flatMap((record) => record.tags || [])))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 256)
      .map((value) => ({ value, label: value }));
    const roots = Array.from(new Set(records.map((record) => replayParentPath(record.canonicalPath)).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 256)
      .map((value) => ({ value, label: value }));
    const collections = Object.values(state.collectionsById || {})
      .sort((left, right) =>
        Number(left.sortOrder || 0) - Number(right.sortOrder || 0) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id))
      .slice(0, 512)
      .map((collection) => ({ id: collection.id, name: collection.name }));
    const query = this.replayQuery || {};
    if (query.tag && !tags.some((entry) => entry.value === query.tag)) {
      tags.unshift({ value: query.tag, label: query.tag });
    }
    if (query.root && !roots.some((entry) => entry.value === query.root)) {
      roots.unshift({ value: query.root, label: query.root });
    }
    if (query.collectionId && !collections.some((entry) => entry.id === query.collectionId)) {
      const selected = state.collectionsById && state.collectionsById[query.collectionId];
      if (selected) collections.unshift({ id: selected.id, name: selected.name });
    }
    this.workspace.setFacets({ collections, tags, roots });
    this.workspace.setResultCount(items.length, records.length);
    this.view.render(items, {
      totalCount: records.length,
      resetScroll: change && change.resetScroll === true,
      manualOrderCollectionId:
        query.collectionId &&
        state.collectionsById &&
        state.collectionsById[query.collectionId] &&
        !state.collectionsById[query.collectionId].smartRules
          ? query.collectionId
          : "",
    });
  }

  canApplyReplayChangeInPlace(change) {
    if (!change || change.type !== "update" || !Array.isArray(change.replays)) return false;
    if (change.domain !== true) return true;
    const fields = new Set(Array.isArray(change.fields) ? change.fields : []);
    const query = this.replayQuery || {};
    const selectionNeutral = new Set([
      "fileIdentity", "fileSize", "modifiedAt", "thumbnailCacheKey", "thumbnailStatus",
      "rating", "lastOpenedAt", "lastDraggedAt",
    ]);
    for (const field of fields) {
      if (selectionNeutral.has(field)) continue;
      if (field === "durationMs" && query.minimumDurationMs === null && query.maximumDurationMs === null) continue;
      if (field === "missingState" && query.view !== "missing" && !query.missingState) continue;
      if (field === "notes" && !query.query) continue;
      return false;
    }
    return true;
  }

  requireOrganizationPlan(plan) {
    if (plan && plan.ok === true) return plan;
    const code = String((plan && plan.code) || "ORGANIZATION_ACTION_FAILED");
    const message = String((plan && plan.message) || "Oracle could not apply this replay-library action.");
    const error = /** @type {any} */ (new Error(`[${code}] ${message}`));
    error.code = code;
    throw error;
  }

  commitOrganizationPlan(plan, reason) {
    const accepted = this.requireOrganizationPlan(plan);
    if (!accepted.state) throw new Error("[ORGANIZATION_STATE_MISSING] The action did not return a state transaction.");
    this.store.replaceDomainState(accepted.state, {
      type: "replace",
      reason: String(reason || accepted.kind || "replay-organization"),
    });
    this.persistReplayState();
    return accepted;
  }

  replayCollections() {
    const state = this.store.state;
    return this.replayOrganizationApi.deterministicCollectionOrder(state)
      .map((id) => state.collectionsById[id])
      .filter(Boolean)
      .map((collection) => JSON.parse(JSON.stringify(collection)));
  }

  sharedReplayValues(replays, field) {
    const values = Array.isArray(replays) ? replays : [];
    if (!values.length) return [];
    const first = Array.isArray(values[0][field]) ? values[0][field] : [];
    return first.filter((value) => values.every((replay) => (
      Array.isArray(replay[field]) && replay[field].includes(value)
    )));
  }

  updateReplaySelectionUi(ids, replays, elements = this.elements) {
    const selectedIds = Array.isArray(ids) ? ids : [];
    const selected = Array.isArray(replays) ? replays : [];
    const count = selectedIds.length;
    elements.replayBatchBar.hidden = count === 0;
    elements.replaySelectionSummary.textContent = `${count} selected`;
    const allFavorite = count > 0 && selected.every((replay) => replay.favorite === true);
    const allArchived = count > 0 && selected.every((replay) => replay.archiveState === "archived");
    const favorite = elements.replayBatchBar.querySelector('[data-replay-batch-action="favorite"]');
    const archive = elements.replayBatchBar.querySelector('[data-replay-batch-action="archive"]');
    if (favorite) favorite.textContent = allFavorite ? "Unfavorite" : "Favorite";
    if (archive) archive.textContent = allArchived ? "Restore" : "Archive";
  }

  getReplayContextActionState(action, replay, selected, viewer = this.viewer) {
    const replays = Array.isArray(selected) && selected.length ? selected : [replay];
    const single = replays.length === 1;
    const nativeAvailable = Boolean(nativeDragAddon);
    if (action === "play-pause") {
      const viewerState = viewer ? viewer.getState() : null;
      const viewerOwnsReplay = Boolean(
        viewerState && viewerState.phase === "open" && viewerState.replayId === replay.id,
      );
      return {
        label:
          (viewerOwnsReplay && viewerState.playing) ||
          (this.sourceMonitorPlaying && this.sourceMonitorReplayId === replay.id)
            ? "Pause"
            : "Play",
        disabled: !single || !this.viewerAdapter || !this.viewerAdapter.isAvailable(),
        reason: !single
          ? "Playback applies to one replay at a time."
          : !this.viewerAdapter || !this.viewerAdapter.isAvailable()
            ? "Premiere Source Monitor viewer controls are unavailable."
            : "",
      };
    }
    if (["rename-display", "rename-source", "rating-notes", "reveal"].includes(action) && !single) {
      return { disabled: true, reason: "This action applies to one replay at a time." };
    }
    if (action === "rename-source") {
      return nativeAvailable && typeof nativeDragAddon.renameKnownReplayFile === "function"
        ? {}
        : { disabled: true, reason: "The identity-safe native rename service is unavailable." };
    }
    if (action === "reveal") {
      return nativeAvailable && typeof nativeDragAddon.revealFileInExplorer === "function"
        ? {}
        : { disabled: true, reason: "The native Explorer service is unavailable." };
    }
    if (action === "favorite") {
      return { label: replays.every((item) => item.favorite === true) ? "Remove from favorites" : "Add to favorites" };
    }
    if (action === "archive") {
      return { label: replays.every((item) => item.archiveState === "archived") ? "Restore" : "Archive" };
    }
    if (action === "relink") {
      return nativeAvailable && typeof nativeDragAddon.inspectReplayFileIdentity === "function"
        ? {}
        : { disabled: true, reason: "The file-identity service required for relinking is unavailable." };
    }
    return {};
  }

  replayDialogContext(replays, extra = {}) {
    const values = Array.isArray(replays) ? replays.filter(Boolean) : [];
    return {
      replays: values,
      collections: this.replayCollections(),
      sharedTags: this.sharedReplayValues(values, "tags"),
      sharedCollectionIds: this.sharedReplayValues(values, "collectionIds"),
      allMissing: values.length > 0 && values.every((replay) => replay.missingState === "missing"),
      ...extra,
    };
  }

  openLifecycleConfirmation(replays, action, restoreFocus = null, lifecycleUi = this.lifecycleUi) {
    const values = Array.isArray(replays) ? replays.filter(Boolean) : [];
    const confirmation = this.requireOrganizationPlan(
      this.replayOrganizationApi.createArchiveRestoreConfirmationModel(
        this.store.state,
        values.map((replay) => replay.id),
        action,
      ),
    );
    lifecycleUi.open(
      "archive-restore",
      this.replayDialogContext(values, { lifecycleConfirmation: confirmation }),
      restoreFocus,
    );
  }

  async handleReplayContextAction(action, replay, selected, context = {}) {
    const replays = Array.isArray(selected) && selected.length ? selected : [replay];
    const viewer = context.viewer || this.viewer;
    const lifecycleUi = context.lifecycleUi || this.lifecycleUi;
    const elements = context.elements || this.elements;
    const showToast = typeof context.showToast === "function"
      ? context.showToast
      : (message, kind) => this.showToast(message, kind);
    try {
      if (action === "play-pause") {
        let viewerState = viewer.getState();
        if (viewerState.phase !== "open" || viewerState.replayId !== replay.id) {
          const opened = await this.openReplayViewer(replay, viewer, elements, showToast);
          if (!opened) return;
          viewerState = viewer.getState();
        }
        await viewer.togglePlayback();
        viewerState = viewer.getState();
        showToast(
          `${replay.title} ${viewerState.playing ? "playing" : "paused"} in Source Monitor.`,
          "success",
        );
        return;
      }
      if (action === "reveal") {
        await this.revealReplayInExplorer(replay, showToast);
        return;
      }
      if (action === "favorite") {
        const value = !replays.every((item) => item.favorite === true);
        this.commitOrganizationPlan(
          this.replayOrganizationApi.planBatchReplayAction(this.store.state, replays.map((item) => item.id), {
            type: "favorite",
            value,
          }),
          "replay-favorite",
        );
        showToast(`${replays.length} replay${replays.length === 1 ? "" : "s"} ${value ? "favorited" : "unfavorited"}.`, "success");
        return;
      }
      if (action === "archive") {
        const lifecycleAction = replays.every((item) => item.archiveState === "archived") ? "restore" : "archive";
        if (replays.length > 1) this.openLifecycleConfirmation(replays, lifecycleAction, null, lifecycleUi);
        else {
          await this.releaseReplayMutationHandles([replay.id]);
          this.commitOrganizationPlan(
            lifecycleAction === "restore"
              ? this.replayOrganizationApi.restoreReplaysPlan(this.store.state, [replay.id])
              : this.replayOrganizationApi.archiveReplaysPlan(this.store.state, [replay.id]),
            `replay-${lifecycleAction}`,
          );
          showToast(`${replay.title} ${lifecycleAction === "restore" ? "restored" : "archived"}.`, "success");
        }
        return;
      }
      if (action === "delete") {
        if (nativeDragAddon && typeof nativeDragAddon.inspectReplayFileIdentity === "function") {
          for (const item of replays) {
            if (item && item.missingState !== "missing") {
              try {
                await this.ensureNativeReplayRegistration(item.id);
              } catch (error) {
                // Archiving must remain available. A missing/unsafe registration
                // is represented as a blocked item if the user opts into recycle.
              }
            }
          }
        }
        const currentReplays = replays
          .map((item) => this.store.getById(item.id))
          .filter(Boolean);
        const confirmation = this.requireOrganizationPlan(
          this.replayOrganizationApi.createDeleteConfirmationModel(this.store.state, currentReplays.map((item) => item.id)),
        );
        const replayPreferences = oracleWindow.oracleWorkspacePreferences && oracleWindow.oracleWorkspacePreferences.replay || {};
        const recycleServiceAvailable = Boolean(nativeDragAddon && typeof nativeDragAddon.recycleKnownFiles === "function");
        lifecycleUi.open("delete", this.replayDialogContext(currentReplays, {
          deleteConfirmation: confirmation,
          nativeRecycleAvailable: recycleServiceAvailable && replayPreferences.deleteFromDisk === true,
          recycleUnavailableReason: !recycleServiceAvailable
            ? "The verified native Windows Recycle Bin service is unavailable."
            : "Enable the confirmed source-file Recycle Bin option in Preferences to allow this destructive choice.",
        }));
        return;
      }
      if (action === "rename-source") {
        const exactItems = await this.gateway.findExactProjectItemsByMediaPath(replay.filepath);
        lifecycleUi.open("rename-source", this.replayDialogContext([replay], {
          premiereReferenceCount: exactItems.length,
        }));
        return;
      }
      if (["rename-display", "collections", "tags", "rating-notes", "relink"].includes(action)) {
        lifecycleUi.open(action, this.replayDialogContext(
          ["rename-display", "rating-notes"].includes(action) ? [replay] : replays,
        ));
      }
    } catch (error) {
      showToast(error && error.message ? error.message : String(error), "error");
    }
  }

  handleReplayBatchClick(event) {
    const button = event && event.target && event.target.closest
      ? event.target.closest("[data-replay-batch-action]")
      : null;
    if (!button || button.disabled) return;
    const action = String(button.dataset.replayBatchAction || "");
    const replays = this.view.getSelectedReplays();
    if (!replays.length) return;
    if (action === "clear") {
      this.view.clearSelection();
      return;
    }
    if (action === "favorite") {
      void this.handleReplayContextAction("favorite", replays[0], replays);
      return;
    }
    if (action === "archive") {
      const lifecycleAction = replays.every((replay) => replay.archiveState === "archived") ? "restore" : "archive";
      try {
        this.openLifecycleConfirmation(replays, lifecycleAction, button);
      } catch (error) {
        this.showToast(error && error.message ? error.message : String(error), "error");
      }
      return;
    }
    if (["collections", "tags", "relink"].includes(action)) {
      this.lifecycleUi.open(action, this.replayDialogContext(replays), button);
    }
  }

  async applyReplayLifecycleAction(mode, payload, context) {
    const showToast = context && typeof context.showToast === "function"
      ? context.showToast
      : (message, kind) => this.showToast(message, kind);
    const replays = context && Array.isArray(context.replays) ? context.replays : [];
    const ids = replays.map((replay) => replay.id);
    if (!ids.length) throw new Error("Select at least one replay.");
    let outcome = null;
    if (mode === "rename-display") {
      this.commitOrganizationPlan(
        this.replayOrganizationApi.planReplayMetadata(this.store.state, ids, { displayName: payload.displayName }),
        "replay-rename-display",
      );
    } else if (mode === "tags") {
      const plan = ids.length === 1
        ? this.replayOrganizationApi.planReplayMetadata(this.store.state, ids, { tags: payload.tags })
        : this.replayOrganizationApi.planBatchReplayAction(this.store.state, ids, {
          type: "tag",
          tags: payload.tags,
          mode: payload.batchMode === "replace" ? "set" : payload.batchMode,
        });
      this.commitOrganizationPlan(plan, "replay-tags");
    } else if (mode === "rating-notes") {
      this.commitOrganizationPlan(
        this.replayOrganizationApi.planReplayMetadata(this.store.state, ids, {
          rating: payload.rating,
          notes: payload.notes,
        }),
        "replay-rating-notes",
      );
    } else if (mode === "collections") {
      const plan = ids.length === 1
        ? this.replayOrganizationApi.planReplayMetadata(this.store.state, ids, { collectionIds: payload.collectionIds })
        : this.replayOrganizationApi.planBatchReplayAction(this.store.state, ids, {
          type: "collection",
          collectionIds: payload.collectionIds,
          mode: payload.batchMode === "replace" ? "set" : payload.batchMode,
        });
      this.commitOrganizationPlan(plan, "replay-collections");
    } else if (mode === "archive-restore") {
      const confirmation = context.lifecycleConfirmation;
      await this.releaseReplayMutationHandles(ids);
      this.commitOrganizationPlan(
        this.replayOrganizationApi.createArchiveRestorePlan(this.store.state, confirmation, {
          confirmed: payload.confirmed === true,
          confirmationId: confirmation && confirmation.confirmationId,
        }),
        `replay-${confirmation && confirmation.action || "lifecycle"}`,
      );
    } else if (mode === "rename-source") {
      await this.renameReplaySource(replays[0], payload.filename, context);
    } else if (mode === "relink") {
      await this.commitReplayRelinks(payload, context);
    } else if (mode === "delete" || mode === "remove-metadata") {
      outcome = await this.applyReplayDelete(mode, payload, context);
    } else {
      throw new Error("This replay action is unavailable.");
    }
    if (!outcome || !outcome.operationResult) {
      showToast(`${ids.length} replay${ids.length === 1 ? "" : "s"} updated.`, "success");
    }
    return outcome;
  }

  applyCollectionCommand(command, payload, _context = null) {
    const api = this.replayOrganizationApi;
    const state = this.store.state;
    const draft = payload && payload.draft || {};
    const id = String(payload && payload.id || "");
    let plan;
    if (command === "collection-create") {
      plan = api.createCollectionPlan(state, draft);
    } else if (command === "collection-save") {
      const renamed = this.requireOrganizationPlan(api.renameCollectionPlan(state, id, draft.name));
      const recolored = this.requireOrganizationPlan(api.recolorCollectionPlan(renamed.state, id, draft.color));
      plan = Object.prototype.hasOwnProperty.call(draft, "smartRules") && draft.smartRules
        ? api.updateSavedSearchPlan(recolored.state, id, draft.smartRules)
        : recolored;
    } else if (command === "collection-duplicate") {
      plan = api.duplicateCollectionPlan(state, id);
    } else if (command === "collection-delete") {
      plan = api.deleteCollectionPlan(state, id);
    } else if (command === "collection-reorder") {
      plan = api.reorderCollectionsPlan(state, payload && payload.order);
    } else if (command === "collection-up" || command === "collection-down") {
      const order = api.deterministicCollectionOrder(state);
      const index = order.indexOf(id);
      const target = command === "collection-up" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= order.length) return this.replayCollections();
      [order[index], order[target]] = [order[target], order[index]];
      plan = api.reorderCollectionsPlan(state, order);
    } else {
      throw new Error("Unsupported collection command.");
    }
    this.commitOrganizationPlan(plan, command);
    return this.replayCollections();
  }

  handleReplayReorder(request, context = {}) {
    const showToast = typeof context.showToast === "function"
      ? context.showToast
      : (message, kind) => this.showToast(message, kind);
    const announce = typeof context.announce === "function"
      ? context.announce
      : (message) => this.announce(message);
    const refresh = typeof context.refresh === "function"
      ? context.refresh
      : (change) => this.refreshReplayWorkspace(change);
    try {
      const state = this.store.state;
      const collectionId = String(request && request.collectionId || "");
      const replayId = String(request && request.replayId || "");
      const targetId = String(request && request.targetId || "");
      const order = this.replayOrganizationApi.deterministicManualOrder(state, collectionId, []);
      const without = order.filter((id) => id !== replayId);
      let targetIndex = without.indexOf(targetId);
      if (targetIndex < 0) throw new Error("The reorder target is no longer in this collection.");
      if (request.placement === "after") targetIndex += 1;
      without.splice(targetIndex, 0, replayId);
      this.commitOrganizationPlan(
        this.replayOrganizationApi.reorderCollectionReplaysPlan(state, collectionId, without),
        "collection-replay-reorder",
      );
      const replay = this.store.getById(replayId);
      announce(`${replay && replay.title || "Replay"} moved to position ${targetIndex + 1} of ${without.length}.`);
      return { ok: true, replayId, position: targetIndex + 1, count: without.length };
    } catch (error) {
      showToast(error && error.message ? error.message : String(error), "error");
      const replay = this.store && this.store.getById ? this.store.getById(String(request && request.replayId || "")) : null;
      announce(`${replay && replay.title || "Replay"} order was unchanged.`);
      refresh({ type: "reorder-rollback" });
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  recordReplayUsage(replayId, kind) {
    try {
      this.commitOrganizationPlan(
        this.replayOrganizationApi.recordReplayUsagePlan(this.store.state, replayId, kind),
        `replay-usage-${kind}`,
      );
    } catch (error) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "REPLAY_USAGE_PERSIST_FAILED", {
          replayIdPresent: Boolean(replayId),
          kind: String(kind || "unknown"),
          message: typeof oracleErrorMessage === "function"
            ? oracleErrorMessage(error)
            : "Replay usage metadata could not be persisted.",
        });
      }
    }
  }

  nativeLifecycleResult(result, fallbackCode, fallbackMessage) {
    if (result && result.ok === true) return result;
    const code = String((result && result.errorCode) || fallbackCode || "NATIVE_FILE_OPERATION_FAILED");
    const message = String((result && result.errorMessage) || fallbackMessage || "The native file operation failed.");
    throw new Error(`[${code}] ${message}`);
  }

  updateNativeWatcherStatus() {
    const status = this.elements && this.elements.replayWatcherStatus;
    if (!status) return;
    const available = Boolean(
      nativeDragAddon &&
      typeof nativeDragAddon.startDirectoryWatch === "function" &&
      typeof nativeDragAddon.pollDirectoryWatchEvents === "function"
    );
    status.setAttribute("data-state", this.nativeLifecycleStarted ? "watching" : available ? "idle" : "unavailable");
    status.textContent = this.nativeLifecycleStarted
      ? `Native watcher active across ${this.nativeWatchRoots.length} bounded root${this.nativeWatchRoots.length === 1 ? "" : "s"}.`
      : available
        ? "Native watcher is idle because no safe replay root is currently available."
        : "Native watcher is unavailable; the bounded filesystem polling fallback remains active.";
  }

  nativeIdentityKey(record) {
    const value = record && record.fileIdentity && record.fileIdentity.key;
    const key = String(value || "").trim().toUpperCase();
    return /^[0-9A-F]{16}:[0-9A-F]{32}$/.test(key) ? key : "";
  }

  nativeWatchRootConfigs(extraPaths = []) {
    const replayPreferences = oracleWindow.oracleWorkspacePreferences &&
      oracleWindow.oracleWorkspacePreferences.replay
      ? oracleWindow.oracleWorkspacePreferences.replay
      : {};
    const configuredRoots = [
      ...(Array.isArray(replayPreferences.roots) ? replayPreferences.roots : []),
      ...(Array.isArray(replayPreferences.relinkRoots) ? replayPreferences.relinkRoots : []),
    ];
    const records = Object.values(this.store.state.replaysById || {})
      .slice()
      .sort((left, right) => String(right.exportedAt || "").localeCompare(String(left.exportedAt || "")));
    const candidates = [
      ...configuredRoots.map((path) => ({ path, recursive: true })),
      ...extraPaths.map((path) => ({ path: replayParentPath(path), recursive: false })),
      ...records.map((record) => ({ path: replayParentPath(record.canonicalPath), recursive: false })),
    ];
    return mergeNativeWatchRootCandidates(candidates, NATIVE_DIRECTORY_WATCH_MAX_ROOTS);
  }

  restartNativeDirectoryWatch(extraPaths = []) {
    if (
      !nativeDragAddon ||
      typeof nativeDragAddon.startDirectoryWatch !== "function" ||
      typeof nativeDragAddon.stopDirectoryWatch !== "function"
    ) {
      this.nativeLifecycleStarted = false;
      this.updateNativeWatcherStatus();
      return false;
    }
    const roots = this.nativeWatchRootConfigs(extraPaths);
    if (this.nativeLifecycleStarted) nativeDragAddon.stopDirectoryWatch();
    this.nativeWatchRoots = roots.map((root, index) => ({
      id: `replay-root-${index + 1}`,
      path: root.path,
      recursive: root.recursive === true,
    }));
    if (!this.nativeWatchRoots.length) {
      this.nativeLifecycleStarted = false;
      this.updateNativeWatcherStatus();
      return false;
    }
    const result = this.nativeLifecycleResult(
      nativeDragAddon.startDirectoryWatch(this.nativeWatchRoots),
      "DIRECTORY_WATCH_START_FAILED",
      "Oracle could not start the bounded replay directory watcher.",
    );
    this.nativeLifecycleStarted = result.ok === true;
    this.updateNativeWatcherStatus();
    return this.nativeLifecycleStarted;
  }

  ensureNativeWatchRootForPath(absolutePath) {
    const parent = replayParentPath(absolutePath);
    const parentKey = pathKey(parent);
    if (!parentKey) throw new Error("[INVALID_WATCH_ROOT] Replay path has no watchable parent directory.");
    const present = this.nativeWatchRoots.some((root) => nativeWatchRootCoversFile(root, absolutePath));
    if (!present) this.restartNativeDirectoryWatch([absolutePath]);
  }

  startNativeReplayLifecycle() {
    if (
      !nativeDragAddon ||
      typeof nativeDragAddon.inspectReplayFileIdentity !== "function" ||
      typeof nativeDragAddon.registerKnownReplayFile !== "function" ||
      typeof nativeDragAddon.pollDirectoryWatchEvents !== "function"
    ) {
      this.updateNativeWatcherStatus();
      return;
    }
    try {
      this.restartNativeDirectoryWatch([]);
    } catch (error) {
      this.showToast(error && error.message ? error.message : String(error), "error");
    }
    if (this.nativeWatchTimer === null) {
      this.nativeWatchTimer = setInterval(() => this.pollNativeDirectoryWatch(), NATIVE_DIRECTORY_WATCH_POLL_MS);
    }
    const records = Object.values(this.store.state.replaysById || {})
      .filter((record) => this.nativeWatchRoots.some((root) => nativeWatchRootCoversFile(root, record.canonicalPath)))
      .sort((left, right) => String(right.exportedAt || "").localeCompare(String(left.exportedAt || "")))
      .slice(0, NATIVE_DIRECTORY_WATCH_REGISTER_LIMIT);
    this.trackNativeWatcherTask((async () => {
      for (let index = 0; index < records.length && !this.destroyed; index += 1) {
        try {
          await this.ensureNativeReplayRegistration(records[index].id, { ensureRoot: false });
        } catch (error) {
          // Missing/unsafe legacy entries remain visible and can be relinked;
          // they are not silently admitted to the native known-file registry.
        }
        if ((index + 1) % 16 === 0) await yieldToHost();
      }
    })());
  }

  async ensureNativeReplayRegistration(replayOrId, options = {}) {
    const id = String(typeof replayOrId === "string" ? replayOrId : replayOrId && replayOrId.id || "");
    if (!id) throw new Error("[UNKNOWN_REPLAY] Replay registration requires a known record.");
    const pending = this.nativeRegistrationTasks.get(id);
    if (pending) return pending;
    const task = (async () => {
      if (!nativeDragAddon || typeof nativeDragAddon.inspectReplayFileIdentity !== "function") {
        throw new Error("[FILE_IDENTITY_UNAVAILABLE] The native file-identity service is unavailable.");
      }
      let record = this.store.getRecord(id);
      if (!record) throw new Error("[UNKNOWN_REPLAY] Replay no longer exists.");
      if (options.ensureRoot !== false) this.ensureNativeWatchRootForPath(record.canonicalPath);
      const inspection = this.nativeLifecycleResult(
        nativeDragAddon.inspectReplayFileIdentity(record.canonicalPath),
        "FILE_IDENTITY_FAILED",
        "Oracle could not inspect the replay source identity.",
      );
      const previousNativeKey = this.nativeIdentityKey(record);
      if (previousNativeKey && previousNativeKey !== String(inspection.identityKey).toUpperCase()) {
        throw new Error("[FILE_IDENTITY_CHANGED] The replay source identity changed since it was registered.");
      }
      if (previousNativeKey !== String(inspection.identityKey).toUpperCase()) {
        this.store.updateById(id, { fileIdentity: { key: inspection.identityKey } }, { domain: true });
        this.persistReplayState();
        record = this.store.getRecord(id);
      }
      const registration = this.nativeLifecycleResult(
        nativeDragAddon.registerKnownReplayFile(id, inspection.path, inspection.identityKey),
        "FILE_REGISTRATION_FAILED",
        "Oracle could not register the replay for safe file operations.",
      );
      return { record, inspection, registration };
    })();
    this.nativeRegistrationTasks.set(id, task);
    try {
      return await task;
    } finally {
      if (this.nativeRegistrationTasks.get(id) === task) this.nativeRegistrationTasks.delete(id);
    }
  }

  async replayFileCandidate(absolutePath) {
    if (!nativeDragAddon || typeof nativeDragAddon.inspectReplayFileIdentity !== "function") {
      throw new Error("[FILE_IDENTITY_UNAVAILABLE] The native file-identity service is unavailable.");
    }
    const inspection = this.nativeLifecycleResult(
      nativeDragAddon.inspectReplayFileIdentity(absolutePath),
      "RELINK_CANDIDATE_INVALID",
      "The selected replacement is not a safe regular media file.",
    );
    let fileSize = null;
    let modifiedAt = null;
    if (uxpFs && typeof uxpFs.lstat === "function") {
      const stats = await uxpFs.lstat(inspection.path);
      fileSize = Math.max(0, Number(stats && stats.size) || 0);
      const modifiedMillis = fileModifiedAt(stats);
      modifiedAt = modifiedMillis > 0 ? new Date(modifiedMillis).toISOString() : null;
    }
    return {
      canonicalPath: inspection.path,
      fileIdentity: { key: inspection.identityKey },
      fileSize,
      modifiedAt,
      durationMs: null,
      isDirectory: false,
      isRegularFile: true,
      isReparsePoint: false,
    };
  }

  async chooseReplayRelink(context) {
    const replays = context && Array.isArray(context.replays) ? context.replays : [];
    if (!replays.length) throw new Error("Select at least one replay to relink.");
    const uxpModuleName = "u" + "xp";
    const uxp = require(uxpModuleName);
    const localFileSystem = uxp && uxp.storage && uxp.storage.localFileSystem;
    if (!localFileSystem || typeof localFileSystem.getFileForOpening !== "function") {
      throw new Error("[FILE_PICKER_UNAVAILABLE] UXP file selection is unavailable.");
    }
    const picked = await localFileSystem.getFileForOpening({
      allowMultiple: replays.length > 1,
      types: ["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"],
    });
    const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!files.length) return null;
    const candidates = [];
    for (const file of files.slice(0, this.replayOrganizationApi.MAX_RELINK_CANDIDATES)) {
      const nativePath = String(file && (file.nativePath || file.path) || "");
      if (nativePath) candidates.push(await this.replayFileCandidate(nativePath));
    }
    if (!candidates.length) throw new Error("No safe replacement media was selected.");
    const roots = Array.from(new Set(candidates.map((candidate) => replayParentPath(candidate.canonicalPath)).filter(Boolean)));
    const remaining = [...candidates];
    const assignments = [];
    let ambiguous = false;
    for (const replay of replays) {
      if (!remaining.length) break;
      const record = this.store.getRecord(replay.id);
      if (!record) continue;
      let chosen = null;
      let requiresConfirmation = false;
      let score = 0;
      let reasons = [];
      let ambiguityReason = "";
      if (replays.length === 1 && remaining.length === 1) {
        chosen = remaining[0];
        const scored = this.replayOrganizationApi.scoreRelinkCandidates(record, remaining, roots, { minimumScore: 0 });
        requiresConfirmation = Boolean(scored.ok && scored.requiresConfirmation);
        if (scored.ok && scored.best) {
          score = Number(scored.best.score) || 0;
          reasons = Array.isArray(scored.best.reasons) ? scored.best.reasons.slice() : [];
          if (requiresConfirmation) {
            ambiguityReason = scored.ambiguous
              ? "Another candidate has a similarly strong evidence score."
              : scored.best.sameVolume === false
                ? scored.honestBoundary
                : "The candidate requires explicit verification.";
          }
        }
      } else {
        const scored = this.requireOrganizationPlan(
          this.replayOrganizationApi.scoreRelinkCandidates(record, remaining, roots, {
            minimumScore: 0,
            maximumResults: 100,
          }),
        );
        const match = scored.best || scored.results[0];
        if (match) {
          chosen = match.candidate;
          requiresConfirmation = scored.ambiguous || scored.requiresConfirmation || Number(match.score) < 25;
          score = Number(match.score) || 0;
          reasons = Array.isArray(match.reasons) ? match.reasons.slice() : [];
          if (requiresConfirmation) {
            ambiguityReason = scored.ambiguous
              ? "Another candidate has a similarly strong evidence score."
              : match.sameVolume === false
                ? scored.honestBoundary
                : "The match score is below Oracle's automatic-confidence threshold.";
          }
        }
      }
      if (!chosen) continue;
      const candidateIndex = remaining.findIndex((candidate) => pathKey(candidate.canonicalPath) === pathKey(chosen.canonicalPath));
      if (candidateIndex >= 0) remaining.splice(candidateIndex, 1);
      ambiguous = ambiguous || requiresConfirmation;
      assignments.push({
        replayId: replay.id,
        newPath: chosen.canonicalPath,
        candidate: chosen,
        ambiguous: requiresConfirmation,
        score,
        reasons,
        ambiguityReason: requiresConfirmation ? ambiguityReason || "The selected replacement requires explicit verification." : "",
      });
    }
    return { assignments, ambiguous };
  }

  async revealReplayInExplorer(replay, showToast = (message, kind) => this.showToast(message, kind)) {
    await this.ensureNativeReplayRegistration(replay.id);
    const result = this.nativeLifecycleResult(
      nativeDragAddon.revealFileInExplorer(replay.id),
      "REVEAL_FAILED",
      "Windows Explorer could not reveal this replay.",
    );
    showToast(`${replay.title} selected in Explorer.`, "success");
    return result;
  }

  async releaseReplayMutationHandles(replayIds) {
    const ids = Array.from(new Set((Array.isArray(replayIds) ? replayIds : []).map((id) => String(id || "")).filter(Boolean)));
    for (const id of ids) {
      this.processingGenerations.set(id, (this.processingGenerations.get(id) || 0) + 1);
    }
    await this.releaseReplayViewerMounts(ids);
    if (ids.includes(this.sourceMonitorReplayId)) {
      const closed = await this.gateway.closeSourceMonitorClip();
      if (!closed) {
        throw new Error("[SOURCE_MONITOR_RELEASE_FAILED] Close the replay in Source Monitor before changing its source file.");
      }
      this.sourceMonitorPlaying = false;
      this.sourceMonitorReplayId = "";
    }
    const active = ids.flatMap((id) => Array.from(this.processingTasks.get(id) || []));
    if (active.length) await Promise.allSettled(active);
  }

  async releaseReplayViewerMounts(replayIds) {
    const ids = Array.from(new Set(
      (replayIds instanceof Set ? Array.from(replayIds) : Array.isArray(replayIds) ? replayIds : [replayIds])
        .map((id) => String(id || ""))
        .filter(Boolean),
    ));
    if (!ids.length) return false;
    const viewers = [];
    if (this.viewer && typeof this.viewer.releaseReplayIds === "function") viewers.push(this.viewer);
    for (const mount of Array.from(this.dedicatedMounts || [])) {
      if (
        mount &&
        mount.viewer &&
        typeof mount.viewer.releaseReplayIds === "function" &&
        !viewers.includes(mount.viewer)
      ) {
        viewers.push(mount.viewer);
      }
    }
    const results = await Promise.allSettled(viewers.map((viewer) => viewer.releaseReplayIds(ids)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    return results.some((result) => result.status === "fulfilled" && result.value === true);
  }

  pauseNativeDirectoryWatchForMutation() {
    const wasRunning = this.nativeLifecycleStarted;
    if (wasRunning && nativeDragAddon && typeof nativeDragAddon.stopDirectoryWatch === "function") {
      nativeDragAddon.stopDirectoryWatch();
      this.nativeLifecycleStarted = false;
    }
    return () => {
      if (!wasRunning || this.destroyed) return;
      try {
        this.restartNativeDirectoryWatch([]);
      } catch (error) {
        this.showToast("Replay folder monitoring could not resume after the file operation.", "error");
      }
    };
  }

  async renameReplaySource(replay, filename, context = {}) {
    const references = await this.gateway.findExactProjectItemsByMediaPath(replay.filepath);
    if (references.length > 0 || Number(context.premiereReferenceCount) > 0) {
      throw new Error("[PREMIERE_RELINK_UNSUPPORTED] Premiere references the old source path, and Premiere 26.3 exposes no supported ProjectItem relink action. Rename is blocked.");
    }
    await this.ensureNativeReplayRegistration(replay.id);
    const record = this.store.getRecord(replay.id);
    const plan = this.requireOrganizationPlan(
      this.replayOrganizationApi.sourceRenamePlan(this.store.state, replay.id, filename, {
        preserveExtension: true,
        premiereReferenceCount: 0,
      }),
    );
    await this.releaseReplayMutationHandles([replay.id]);
    const finalReferences = await this.gateway.findExactProjectItemsByMediaPath(plan.sourcePath);
    if (finalReferences.length > 0) {
      this.scheduleReplayProcessing(replay.id, "source-rename-blocked");
      throw new Error("[PREMIERE_RELINK_UNSUPPORTED] Premiere began referencing the old source path before the rename. Rename is blocked to avoid breaking the project.");
    }
    const resumeWatcher = this.pauseNativeDirectoryWatchForMutation();
    let nativeResult;
    try {
      nativeResult = this.nativeLifecycleResult(
        nativeDragAddon.renameKnownReplayFile(replay.id, plan.targetPath),
        "SOURCE_RENAME_FAILED",
        "Windows could not rename the exact replay source.",
      );
    } catch (error) {
      this.scheduleReplayProcessing(replay.id, "source-rename-failed");
      throw error;
    } finally {
      resumeWatcher();
    }
    let committed;
    try {
      committed = this.requireOrganizationPlan(
        this.replayOrganizationApi.commitGuardedReplayMutation(this.store.state, plan, {
          success: true,
          observedSourceIdentity: { key: nativeResult.identityKey },
        }),
      );
      this.commitOrganizationPlan(committed, "source-rename-commit");
    } catch (error) {
      const rollback = nativeDragAddon.renameKnownReplayFile(replay.id, plan.sourcePath);
      if (!rollback || rollback.ok !== true) {
        throw new Error(`[SOURCE_RENAME_ROLLBACK_FAILED] ${error && error.message ? error.message : error}`);
      }
      throw error;
    }
    if (record && record.thumbnailCacheKey) {
      try {
        await this.thumbnailCache.invalidate(record);
      } catch (error) {
        // The committed record no longer references the stale cache key. A failed
        // physical cleanup is safe and can be reclaimed by the bounded cache sweep.
      }
    }
    this.exportPoller.registerFile(plan.targetPath);
    this.scheduleReplayProcessing(replay.id, "source-rename");
    this.reconcileBridgeReplayPath(replay.id, plan.sourcePath, plan.targetPath, nativeResult.identityKey);
    return this.store.getById(replay.id);
  }

  async commitReplayRelinks(selection, context = {}) {
    const assignments = selection && Array.isArray(selection.assignments) ? selection.assignments : [];
    if (!assignments.length) throw new Error("Choose replacement media first.");
    const results = [];
    for (const assignment of assignments) {
      const replayId = String(assignment.replayId || "");
      const previous = this.store.getRecord(replayId);
      let nativeRegistrationChanged = false;
      let domainCommitted = false;
      try {
        if (!previous) throw new Error("Replay no longer exists.");
        const candidate = await this.replayFileCandidate(assignment.newPath);
        const expectedKey = this.replayOrganizationApi.fileIdentityKey(assignment.candidate && assignment.candidate.fileIdentity);
        const observedKey = this.replayOrganizationApi.fileIdentityKey(candidate.fileIdentity);
        if (expectedKey && expectedKey !== observedKey) {
          throw new Error("The selected replacement changed after the picker closed.");
        }
        const plan = this.requireOrganizationPlan(
          this.replayOrganizationApi.relinkPlan(this.store.state, replayId, candidate, {
            ambiguous: assignment.ambiguous === true,
            confirmed: true,
          }),
        );
        await this.releaseReplayMutationHandles([replayId]);
        this.ensureNativeWatchRootForPath(candidate.canonicalPath);
        const registration = this.nativeLifecycleResult(
          nativeDragAddon.registerKnownReplayFile(replayId, candidate.canonicalPath, candidate.fileIdentity.key),
          "RELINK_REGISTRATION_FAILED",
          "Oracle could not register the replacement for safe lifecycle tracking.",
        );
        nativeRegistrationChanged = true;
        const committed = this.requireOrganizationPlan(
          this.replayOrganizationApi.commitGuardedReplayMutation(this.store.state, plan, {
            success: true,
            observedCandidateIdentity: { key: registration.identityKey },
          }),
        );
        this.commitOrganizationPlan(committed, "replay-relink-commit");
        domainCommitted = true;
        if (previous.thumbnailCacheKey) {
          try {
            await this.thumbnailCache.invalidate(previous);
          } catch (error) {
            // The new record has no reference to the stale cache key. Cleanup can
            // be retried by cache maintenance without rolling back a valid relink.
          }
        }
        this.exportPoller.registerFile(candidate.canonicalPath);
        this.scheduleReplayProcessing(replayId, "manual-relink");
        this.reconcileBridgeReplayPath(replayId, previous.canonicalPath, candidate.canonicalPath, registration.identityKey);
        results.push({ replayId, ok: true });
      } catch (error) {
        if (nativeRegistrationChanged && !domainCommitted && nativeDragAddon) {
          if (typeof nativeDragAddon.unregisterKnownReplayFile === "function") {
            nativeDragAddon.unregisterKnownReplayFile(replayId);
          }
          if (previous && previous.missingState !== "missing" && typeof nativeDragAddon.registerKnownReplayFile === "function") {
            try {
              nativeDragAddon.registerKnownReplayFile(
                replayId,
                previous.canonicalPath,
                this.nativeIdentityKey(previous),
              );
            } catch (rollbackError) {
              // Leaving the ID unregistered is safer than retaining a registry
              // entry for media Oracle did not commit.
            }
          }
        }
        if (!domainCommitted && previous && previous.missingState !== "missing") {
          this.scheduleReplayProcessing(replayId, "manual-relink-rollback");
        }
        results.push({ replayId, ok: false, message: error && error.message ? error.message : String(error) });
      }
    }
    const failed = results.filter((result) => !result.ok);
    if (failed.length) {
      throw new Error(`${results.length - failed.length} relinked; ${failed.length} failed. ${failed.map((item) => item.message).join(" ")}`);
    }
    return results;
  }

  async applyReplayDelete(mode, payload, context) {
    const confirmation = context && context.deleteConfirmation;
    if (!confirmation || confirmation.ok !== true || confirmation.kind !== "replay.delete-confirmation") {
      throw new Error("[INVALID_DELETE_CONFIRMATION] Reopen Delete and review the exact paths again.");
    }
    const ids = confirmation.items.map((item) => item.replayId);
    if (mode === "remove-metadata") {
      await this.releaseReplayMutationHandles(ids);
      const plan = this.requireOrganizationPlan(this.replayOrganizationApi.createDeletePlan(this.store.state, confirmation, {
        confirmed: true,
        confirmationId: confirmation.confirmationId,
        removeMetadataOnly: true,
      }));
      const applied = this.requireOrganizationPlan(this.replayOrganizationApi.applyDeleteResults(
        this.store.state,
        plan,
        plan.items.map((item) => ({ replayId: item.replayId, status: "success" })),
      ));
      this.commitOrganizationPlan(applied, "replay-remove-metadata");
      for (const id of ids) {
        if (nativeDragAddon && typeof nativeDragAddon.unregisterKnownReplayFile === "function") {
          nativeDragAddon.unregisterKnownReplayFile(id);
        }
        this.processingGenerations.delete(id);
      }
      return null;
    }
    if (payload.recycle !== true) {
      await this.releaseReplayMutationHandles(ids);
      const plan = this.requireOrganizationPlan(this.replayOrganizationApi.createDeletePlan(this.store.state, confirmation, {
        confirmed: true,
        confirmationId: confirmation.confirmationId,
        moveSourceToRecycleBin: false,
      }));
      this.commitOrganizationPlan(plan, "replay-delete-default-archive");
      return null;
    }
    if (!nativeDragAddon || typeof nativeDragAddon.recycleKnownFiles !== "function") {
      throw new Error("[RECYCLE_BIN_UNAVAILABLE] The native Windows Recycle Bin service is unavailable.");
    }
    let plan = this.requireOrganizationPlan(this.replayOrganizationApi.createDeletePlan(this.store.state, confirmation, {
      confirmed: true,
      confirmationId: confirmation.confirmationId,
      moveSourceToRecycleBin: true,
    }));
    let readyIds = plan.items.filter((item) => item.status === "ready").map((item) => item.replayId);
    let nativeResult = { ok: false, cancelled: false, items: [] };
    if (readyIds.length) {
      try {
        await this.releaseReplayMutationHandles(readyIds);
      } catch (error) {
        for (const id of readyIds) this.scheduleReplayProcessing(id, "recycle-handle-release-failed");
        throw error;
      }
      // Re-run the original, user-visible confirmation after asynchronous
      // handle release. Never authorize a refreshed path behind the modal.
      plan = this.requireOrganizationPlan(this.replayOrganizationApi.createDeletePlan(this.store.state, confirmation, {
        confirmed: true,
        confirmationId: confirmation.confirmationId,
        moveSourceToRecycleBin: true,
      }));
      readyIds = plan.items.filter((item) => item.status === "ready").map((item) => item.replayId);
      if (readyIds.length) {
        const resumeWatcher = this.pauseNativeDirectoryWatchForMutation();
        try {
          const operation = /** @type {any} */ (nativeDragAddon.recycleKnownFiles(readyIds));
          this.activeFileOperationRequestId = Number(operation && operation.requestId) || null;
          context.fileOperationRequestId = this.activeFileOperationRequestId;
          nativeResult = await operation;
        } catch (error) {
          for (const id of readyIds) this.scheduleReplayProcessing(id, "recycle-native-failed");
          throw error;
        } finally {
          this.activeFileOperationRequestId = null;
          context.fileOperationRequestId = null;
          resumeWatcher();
        }
      }
    }
    // A bridge or other controller action may have changed domain state while
    // the Shell operation was running. Preserve any newly relinked record by
    // validating the same visible confirmation once more before metadata commit.
    this.requireOrganizationPlan(this.replayOrganizationApi.createDeletePlan(this.store.state, confirmation, {
      confirmed: true,
      confirmationId: confirmation.confirmationId,
      moveSourceToRecycleBin: true,
    }));
    const domainResults = (nativeResult.items || []).map((item) => ({
      replayId: item.recordId,
      status: item.ok ? "success" : item.cancelled ? "canceled" : "failed",
      code: item.errorCode,
      message: item.errorMessage,
    }));
    const applied = this.requireOrganizationPlan(
      this.replayOrganizationApi.applyDeleteResults(this.store.state, plan, domainResults),
    );
    this.commitOrganizationPlan(applied, "replay-recycle-results");
    const byId = new Map((context.replays || []).map((replay) => [replay.id, replay]));
    const operationResult = {
      ...applied.aggregate,
      items: applied.aggregate.items.map((item) => ({
        ...item,
        name: byId.get(item.replayId) && byId.get(item.replayId).title,
        path: byId.get(item.replayId) && byId.get(item.replayId).filepath,
      })),
    };
    for (const item of operationResult.items) {
      if (item.status === "success" && typeof nativeDragAddon.unregisterKnownReplayFile === "function") {
        nativeDragAddon.unregisterKnownReplayFile(item.replayId);
      } else {
        const record = this.store.getRecord(item.replayId);
        if (record && record.missingState !== "missing") this.scheduleReplayProcessing(item.replayId, "recycle-incomplete");
      }
    }
    return { operationResult };
  }

  cancelReplayLifecycleOperation(mode, context) {
    const requestId = Number(context && context.fileOperationRequestId || this.activeFileOperationRequestId);
    if (mode !== "delete" || !requestId || !nativeDragAddon || typeof nativeDragAddon.cancelFileOperation !== "function") return;
    const result = nativeDragAddon.cancelFileOperation(requestId);
    const showToast = context && typeof context.showToast === "function"
      ? context.showToast
      : (message, kind) => this.showToast(message, kind);
    showToast(result && result.cancellationRequested
      ? "Recycle Bin cancellation requested."
      : "The Recycle Bin operation had already finished.", "info");
  }

  quickApplyDomains() {
    const domains = [];
    if (this.quickApplyDomain) domains.push(this.quickApplyDomain);
    for (const mount of Array.from(this.dedicatedMounts || [])) {
      if (mount && mount.kind === "quick-apply" && mount.domain) domains.push(mount.domain);
    }
    return Array.from(new Set(domains));
  }

  setMetadataDomainWritesBlocked(value) {
    for (const domain of this.quickApplyDomains()) {
      if (typeof domain.setPersistenceBlocked === "function") domain.setPersistenceBlocked(value);
    }
  }

  async drainMetadataDomainWrites() {
    for (const domain of this.quickApplyDomains()) {
      if (typeof domain.drainPersistence === "function") await domain.drainPersistence();
      else if (domain.persistChain && typeof domain.persistChain.then === "function") await domain.persistChain;
    }
    if (this.curveWorkspaceStateStore && typeof this.curveWorkspaceStateStore.flush === "function") {
      this.curveWorkspaceStateStore.flush();
    }
    if (this.persistence && typeof this.persistence.flush === "function") await this.persistence.flush();
    else if (this.persistence && this.persistence.writeChain && typeof this.persistence.writeChain.then === "function") {
      await this.persistence.writeChain;
    }
  }

  trackNativeWatcherTask(operation) {
    const task = Promise.resolve(operation);
    if (!this.nativeWatcherTasks) this.nativeWatcherTasks = new Set();
    this.nativeWatcherTasks.add(task);
    void task.finally(() => this.nativeWatcherTasks.delete(task)).catch(() => undefined);
    return task;
  }

  async drainNativeWatcherTasks() {
    while (this.nativeWatcherTasks && this.nativeWatcherTasks.size) {
      await Promise.allSettled(Array.from(this.nativeWatcherTasks));
    }
  }

  clearNativeMissingVerifications() {
    if (!this.nativeMissingVerificationTimers) return;
    for (const timer of this.nativeMissingVerificationTimers.values()) clearTimeout(timer);
    this.nativeMissingVerificationTimers.clear();
  }

  pollNativeDirectoryWatch() {
    if (
      this.destroyed ||
      this.metadataMutationActive ||
      !nativeDragAddon ||
      typeof nativeDragAddon.pollDirectoryWatchEvents !== "function"
    ) return;
    let events;
    try {
      events = nativeDragAddon.pollDirectoryWatchEvents(256);
    } catch (error) {
      return;
    }
    for (const event of Array.isArray(events) ? events : []) {
      if (event.kind === "renamed" && event.sameVolumeIdentityMatched && event.recordId) {
        this.trackNativeWatcherTask(this.reconcileNativeWatcherRename(event));
      } else if (event.kind === "removed" && event.recordId) {
        this.scheduleNativeMissingVerification(event.recordId, event.path || event.oldPath);
      } else if (event.kind === "modified" || event.kind === "added") {
        const record = Object.values(this.store.state.replaysById || {})
          .find((candidate) => candidate.pathKey === pathKey(event.path));
        if (record) this.scheduleReplayProcessing(record.id, `directory-watch-${event.kind}`);
      } else if (event.kind === "overflow" || event.kind === "rootUnavailable") {
        this.showToast("Replay folder monitoring needs a bounded known-file refresh.", "error");
        this.verifyKnownReplayFilesBounded(event.rootId);
      }
    }
  }

  scheduleNativeMissingVerification(replayId, observedPath) {
    const id = String(replayId || "");
    const previous = this.nativeMissingVerificationTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.nativeMissingVerificationTimers.delete(id);
      this.trackNativeWatcherTask((async () => {
        if (this.metadataMutationActive || this.destroyed) return;
        const record = this.store.getRecord(id);
        if (!record || (observedPath && pathKey(record.canonicalPath) !== pathKey(observedPath))) return;
        try {
          if (uxpFs && typeof uxpFs.lstat === "function") await uxpFs.lstat(record.canonicalPath);
          if (this.metadataMutationActive || this.destroyed) return;
          this.scheduleReplayProcessing(id, "directory-watch-transient-recovery");
        } catch (error) {
          if (this.metadataMutationActive || this.destroyed) return;
          try {
            await this.releaseReplayViewerMounts([id]);
          } catch (releaseError) {
            this.showToast("Oracle could not release the missing replay from every Source Monitor viewer.", "error");
          }
          if (this.metadataMutationActive || this.destroyed) return;
          this.store.updateById(id, { missingState: "missing" }, { domain: true });
          this.store.updateById(id, { status: "error", statusMessage: "Source file is missing" });
          this.persistReplayState();
        }
      })());
    }, 750);
    this.nativeMissingVerificationTimers.set(id, timer);
  }

  async reconcileNativeWatcherRename(event) {
    const record = this.store.getRecord(event.recordId);
    if (!record || pathKey(record.canonicalPath) !== pathKey(event.oldPath)) return;
    let nativeRegistrationChanged = false;
    let domainCommitted = false;
    try {
      const candidate = await this.replayFileCandidate(event.path);
      if (String(candidate.fileIdentity.key) !== String(event.identityKey)) {
        throw new Error("Watcher rename identity did not revalidate.");
      }
      const plan = this.requireOrganizationPlan(
        this.replayOrganizationApi.relinkPlan(this.store.state, record.id, candidate, { confirmed: true }),
      );
      await this.releaseReplayMutationHandles([record.id]);
      const registration = this.nativeLifecycleResult(
        nativeDragAddon.registerKnownReplayFile(record.id, candidate.canonicalPath, candidate.fileIdentity.key),
        "WATCHER_RECONCILIATION_FAILED",
        "Oracle could not reconcile the renamed source with its native file registry.",
      );
      nativeRegistrationChanged = true;
      const committed = this.requireOrganizationPlan(
        this.replayOrganizationApi.commitGuardedReplayMutation(this.store.state, plan, {
          success: true,
          observedCandidateIdentity: { key: registration.identityKey },
        }),
      );
      this.commitOrganizationPlan(committed, "directory-watch-rename");
      domainCommitted = true;
      if (record.thumbnailCacheKey) {
        try {
          await this.thumbnailCache.invalidate(record);
        } catch (error) {
          // The committed record no longer references this stale cache entry.
        }
      }
      this.exportPoller.registerFile(candidate.canonicalPath);
      this.scheduleReplayProcessing(record.id, "directory-watch-rename");
      this.reconcileBridgeReplayPath(record.id, record.canonicalPath, candidate.canonicalPath, candidate.fileIdentity.key);
      const references = await this.gateway.findExactProjectItemsByMediaPath(record.canonicalPath);
      if (references.length) {
        this.showToast("The source moved outside Oracle. Premiere still references the old path; use Premiere's supported relink UI.", "error");
      }
    } catch (error) {
      if (nativeRegistrationChanged && !domainCommitted && nativeDragAddon) {
        if (typeof nativeDragAddon.unregisterKnownReplayFile === "function") {
          nativeDragAddon.unregisterKnownReplayFile(record.id);
        }
        // An external rename has already removed the old path, so restoring that
        // registration would be dishonest. Missing verification leaves the
        // record visible and explicitly unresolved instead.
      }
      this.scheduleNativeMissingVerification(record.id, record.canonicalPath);
    }
  }

  verifyKnownReplayFilesBounded(rootId) {
    const root = this.nativeWatchRoots.find((candidate) => candidate.id === rootId);
    if (!root) return;
    const records = Object.values(this.store.state.replaysById || {})
      .filter((record) => nativeWatchRootCoversFile(root, record.canonicalPath))
      .slice(0, 256);
    this.trackNativeWatcherTask((async () => {
      for (let index = 0; index < records.length && !this.destroyed; index += 1) {
        try {
          await this.ensureNativeReplayRegistration(records[index].id, { ensureRoot: false });
        } catch (error) {
          this.scheduleNativeMissingVerification(records[index].id, records[index].canonicalPath);
        }
        if ((index + 1) % 16 === 0) await yieldToHost();
      }
    })());
  }

  reconcileBridgeReplayPath(replayId, oldPath, newPath, identityKey) {
    if (!bridgeClient || typeof bridgeClient.sendLifecycleReconciliation !== "function") return false;
    const queued = bridgeClient.sendLifecycleReconciliation({ replayId, oldPath, newPath, identityKey });
    if (!queued) {
      const failureCode = bridgeClient.lifecycleQueueFailureCode;
      const message = failureCode === "OUTBOX_NOT_DURABLE"
        ? "Replay-path delivery could not be saved for panel restart. Keep this panel open until Oracle acknowledges the move, then verify the replay."
        : failureCode === "OUTBOX_FULL"
          ? "The replay-path delivery outbox is full. Keep the panel open and verify this replay after pending moves finish."
          : "Oracle rejected unsafe replay-path reconciliation data. Verify the moved replay before continuing.";
      this.showToast(
        message,
        "error",
      );
    }
    return queued;
  }

  async clearThumbnailCache() {
    if (!this.thumbnailCache || !this.store) throw new Error("Thumbnail cache is unavailable.");
    await this.thumbnailCache.clear();
    this.store.clearThumbnailMetadata();
    this.persistReplayState();
    this.showToast("Permanent replay thumbnail cache cleared.", "success");
    return this.thumbnailCache.usage();
  }

  metadataStateCounts(state) {
    const source = state && typeof state === "object" ? state : {};
    return {
      replayCount: Object.keys(source.replaysById || {}).length,
      collectionCount: Object.keys(source.collectionsById || {}).length,
      curvePresetCount: Object.keys(source.curvePresetsById || {}).length,
      recipeCount: Object.keys(source.recipesById || {}).length,
    };
  }

  async exportReplayMetadata() {
    if (this.metadataMutationPromise) await this.metadataMutationPromise;
    if (this.destroyed || !this.store) throw new Error("Replay metadata export is unavailable.");
    if (this.curveWorkspaceStateStore && typeof this.curveWorkspaceStateStore.flush === "function") {
      this.curveWorkspaceStateStore.flush();
    }
    return this.replayLibraryApi.createReplayMetadataExport(this.store.state, {
      pluginVersion: ORACLE_PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
    });
  }

  async importReplayMetadata(payload) {
    if (this.metadataMutationPromise) throw new Error("Another replay metadata operation is already running.");
    const normalized = this.replayLibraryApi.normalizeReplayMetadataImport(payload, {
      writerId: "oracle-premiere-v5",
    });
    if (!normalized || normalized.ok !== true) {
      const code = String(normalized && normalized.code || "INVALID_METADATA_IMPORT");
      const message = String(normalized && normalized.message || "Oracle rejected the replay metadata import.");
      throw new Error(`[${code}] ${message}`);
    }
    const counts = { ...this.metadataStateCounts(normalized.state), migrated: normalized.migrated === true };
    const confirmed = await this.curvesPresetDialog.confirm({
      kicker: "Oracle Metadata",
      title: "Replace current Oracle metadata?",
      message: `Replace the current library with ${counts.replayCount} replay record${counts.replayCount === 1 ? "" : "s"}, ${counts.collectionCount} collection${counts.collectionCount === 1 ? "" : "s"}, ${counts.curvePresetCount} Curves preset${counts.curvePresetCount === 1 ? "" : "s"}, and ${counts.recipeCount} Quick Apply recipe${counts.recipeCount === 1 ? "" : "s"}? This metadata action does not delete source media; thumbnail cache files remain governed by the cache limit.`,
      applyLabel: "Replace Metadata",
    });
    if (!confirmed) return { cancelled: true, ...counts };
    return this.runReplayMetadataReplacement(normalized.state, "metadata-import", counts);
  }

  async resetReplayMetadata() {
    if (this.metadataMutationPromise) throw new Error("Another replay metadata operation is already running.");
    const previousCounts = this.metadataStateCounts(this.store && this.store.state);
    const confirmed = await this.curvesPresetDialog.confirm({
      kicker: "Oracle Metadata",
      title: "Reset stored Oracle metadata?",
      message: `Remove ${previousCounts.replayCount} replay record${previousCounts.replayCount === 1 ? "" : "s"}, ${previousCounts.collectionCount} collection${previousCounts.collectionCount === 1 ? "" : "s"}, ${previousCounts.curvePresetCount} Curves preset${previousCounts.curvePresetCount === 1 ? "" : "s"}, and ${previousCounts.recipeCount} Quick Apply recipe${previousCounts.recipeCount === 1 ? "" : "s"} from Oracle's metadata store? This metadata action does not delete source media; thumbnail cache files remain governed by the cache limit.`,
      applyLabel: "Reset Metadata",
    });
    if (!confirmed) return { cancelled: true, ...previousCounts };
    const current = cloneOracleDomainValue(this.store.state);
    const empty = {
      ...current,
      replaysById: {},
      collectionsById: {},
      curvePresetsById: {},
      preferences: {},
      quickApplyState: {},
      recipesById: {},
      tombstones: {},
    };
    return this.runReplayMetadataReplacement(empty, "metadata-reset", this.metadataStateCounts(empty));
  }

  refreshMetadataDomainConsumers(options = {}) {
    if (this.curvePresetStore && typeof this.curvePresetStore.refresh === "function") {
      this.curvePresetStore.refresh();
    }
    if (this.curvesWorkspace && typeof this.curvesWorkspace.restoreWorkspaceState === "function") {
      this.curvesWorkspace.restoreWorkspaceState();
    }
    if (this.quickApplyStateStore && typeof this.quickApplyStateStore.refresh === "function") {
      this.quickApplyStateStore.refresh();
    }
    if (this.quickApplyRecipeStore && typeof this.quickApplyRecipeStore.refresh === "function") {
      this.quickApplyRecipeStore.refresh();
    }
    for (const mount of Array.from(this.dedicatedMounts || [])) {
      if (
        mount &&
        mount.kind === "curves" &&
        mount.workspace &&
        typeof mount.workspace.restoreWorkspaceState === "function"
      ) {
        mount.workspace.restoreWorkspaceState();
      }
      if (
        options.discardQuickApplyDrafts === true &&
        mount &&
        mount.kind === "quick-apply" &&
        mount.workspace &&
        typeof mount.workspace.closeRecipeEditor === "function"
      ) {
        mount.workspace.closeRecipeEditor(false);
      }
    }
    if (
      options.discardQuickApplyDrafts === true &&
      this.quickApplyWorkspace &&
      typeof this.quickApplyWorkspace.closeRecipeEditor === "function"
    ) {
      this.quickApplyWorkspace.closeRecipeEditor(false);
    }
  }

  async replaceReplayMetadataState(nextState, reason, counts) {
    const resumeWatcher = this.pauseNativeDirectoryWatchForMutation();
    let previous = null;
    let candidate = null;
    let previousIds = [];
    let replaced = false;
    let committed = false;
    let nativeRegistryChanged = false;
    try {
      this.clearNativeMissingVerifications();
      await this.drainNativeWatcherTasks();
      this.clearNativeMissingVerifications();
      await this.drainMetadataDomainWrites();
      if (this.destroyed) throw new Error("Oracle closed before the metadata transaction could begin.");

      previous = cloneOracleDomainValue(this.store.state);
      candidate = cloneOracleDomainValue(nextState);
      candidate.revision = Number(previous.revision) || 0;
      candidate.writtenAt = previous.writtenAt;
      candidate.writerId = previous.writerId;
      if (candidate.quickApplyState && typeof candidate.quickApplyState === "object") {
        delete candidate.quickApplyState.effectIndex;
      }
      for (const replay of Object.values(candidate.replaysById || {})) {
        replay.thumbnailCacheKey = "";
        replay.thumbnailStatus = "unavailable";
      }
      this.replayLibraryApi.createReplayMetadataExport(candidate, {
        pluginVersion: ORACLE_PLUGIN_VERSION,
        exportedAt: new Date().toISOString(),
      });
      previousIds = Object.keys(previous.replaysById || {});
      await this.releaseReplayMutationHandles(previousIds);
      const registrations = Array.from(this.nativeRegistrationTasks.values());
      if (registrations.length) await Promise.allSettled(registrations);
      if (this.destroyed) throw new Error("Oracle closed before the metadata transaction could begin.");

      if (nativeDragAddon && typeof nativeDragAddon.unregisterKnownReplayFile === "function") {
        for (const id of previousIds) {
          this.nativeLifecycleResult(
            nativeDragAddon.unregisterKnownReplayFile(id),
            "METADATA_IMPORT_UNREGISTER_FAILED",
            "Oracle could not release a native replay registration before replacing metadata.",
          );
          nativeRegistryChanged = true;
        }
      }
      this.nativeRegistrationTasks.clear();
      replaced = true;
      this.store.replaceDomainState(candidate, { type: "replace", reason, domain: "metadata" });
      await this.persistOracleState({ propagate: true, metadataTransaction: true });
      committed = true;
      if (this.curveWorkspaceStateStore && typeof this.curveWorkspaceStateStore.discardPending === "function") {
        this.curveWorkspaceStateStore.discardPending();
      }
      try {
        this.refreshMetadataDomainConsumers({ discardQuickApplyDrafts: true });
      } catch (refreshError) {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("warn", "METADATA_CONSUMER_REFRESH_FAILED", {
            message: typeof oracleErrorMessage === "function" ? oracleErrorMessage(refreshError) : "Metadata UI refresh failed.",
          });
        }
      }
      if (this.exportPoller && typeof this.exportPoller.replaceTrackedFiles === "function") {
        this.exportPoller.replaceTrackedFiles(this.store.items);
      }
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("info", reason === "metadata-reset" ? "METADATA_RESET_COMMITTED" : "METADATA_IMPORT_COMMITTED", counts);
      }
      return { ...counts };
    } catch (error) {
      if (replaced && !committed && previous) {
        this.store.replaceDomainState(previous, {
          type: "replace",
          reason: `${reason}-rollback`,
          domain: "metadata",
        });
      }
      if (nativeRegistryChanged && previous && nativeDragAddon) {
        for (const id of previousIds) {
          try {
            await this.ensureNativeReplayRegistration(id, { ensureRoot: false });
          } catch (registrationError) {
            if (typeof recordOracleDiagnostic === "function") {
              recordOracleDiagnostic("error", "METADATA_ROLLBACK_REGISTRATION_FAILED", { replayId: id });
            }
          }
        }
      }
      throw error;
    } finally {
      resumeWatcher();
    }
  }

  async runReplayMetadataReplacement(nextState, reason, counts) {
    if (this.metadataMutationPromise || this.metadataMutationActive) {
      throw new Error("Another replay metadata operation is already running.");
    }
    this.metadataMutationActive = true;
    this.metadataMutationGeneration = (Number(this.metadataMutationGeneration) || 0) + 1;
    this.setMetadataDomainWritesBlocked(true);
    const operation = Promise.resolve().then(() => this.replaceReplayMetadataState(nextState, reason, counts));
    this.metadataMutationPromise = operation;
    try {
      return await operation;
    } finally {
      this.setMetadataDomainWritesBlocked(false);
      this.metadataMutationActive = false;
      if (this.metadataMutationPromise === operation) this.metadataMutationPromise = null;
      if (!this.destroyed && this.store) {
        for (const replay of this.store.items) {
          try {
            this.scheduleReplayProcessing(replay.id, `${reason}-resume`);
          } catch (processingError) {
            if (typeof recordOracleDiagnostic === "function") {
              recordOracleDiagnostic("warn", "METADATA_PROCESSING_RESUME_FAILED", { replayId: replay.id });
            }
          }
        }
      }
    }
  }

  async handleBridgeMessage(message) {
    if (this.destroyed) {
      return;
    }
    const eventName = messageEventName(message);
    if (eventName === "REPLAY_PATH_RECONCILED_ACK") {
      return;
    }

    if (eventName === "REPLAY_PATH_RECONCILED_NACK") {
      const reason = typeof message.message === "string" && message.message.trim()
        ? message.message.trim()
        : "Oracle could not reconcile the replay path.";
      this.showToast(reason, "error");
      return;
    }

    if (this.metadataMutationPromise) {
      try {
        await this.metadataMutationPromise;
      } catch (error) {
        // The metadata transaction restores the previous state before queued
        // bridge traffic is admitted, regardless of commit or rollback.
      }
      if (this.destroyed) return;
    }

    if (eventName === "SNAPSHOT") {
      const touched = this.store.replaceSnapshot(message.replays);
      this.persistReplayState();
      for (const replay of touched) {
        this.exportPoller.registerFile(replay.filepath);
        this.scheduleReplayProcessing(replay.id, "bridge-snapshot");
      }
      const imports = message.imports || [];
      for (let index = 0; index < imports.length; index += 1) {
        await this.acceptImportClip(imports[index], false);
        if ((index + 1) % 4 === 0) {
          await yieldToHost();
        }
      }
      return;
    }

    if (eventName === "IMPORT_CLIP") {
      await this.acceptImportClip(message, true);
      return;
    }

    if (
      eventName === "RENDER_COMPLETE" ||
      eventName === "EXPORT_COMPLETE" ||
      (!eventName && replayMessageHasFilepath(message))
    ) {
      const payload = normalizeReplayPayload(message);
      if (!isReplayPayload(payload)) {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("warn", "INVALID_RENDER_PATH", { eventName });
        }
        return;
      }

      this.acceptPolledReplayIdentity(payload);
      this.exportPoller.registerFile(payload.filepath);
      const replay = this.store.upsert(payload);
      if (replay) {
        this.persistReplayState();
        this.announce(`${replay.title} received from Oracle.`);
        this.scheduleReplayProcessing(replay.id, "bridge-render-complete");
      }
      return;
    }

    if (eventName === "BRIDGE_ERROR") {
      this.showToast(message.message || "The Oracle bridge rejected a message.", "error");
    }
  }

  async acceptImportClip(message, announce) {
    if (this.destroyed) {
      return;
    }
    const payload = normalizeImportClipPayload(message);
    if (!isReplayPayload(payload)) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "INVALID_IMPORT_PATH", {});
      }
      return;
    }

    this.acceptPolledReplayIdentity(payload);
    this.exportPoller.registerFile(payload.filepath);
    const replay = this.store.upsert(payload);
    if (!replay) {
      return;
    }
    if (announce) {
      this.announce(`${replay.title} received from Oracle.`);
    }
    this.persistReplayState();
    this.scheduleReplayProcessing(replay.id, "bridge-import-clip");
  }

  acceptPolledReplay(payload) {
    if (this.destroyed || !isReplayPayload(payload)) {
      return;
    }
    // A poll captured before replacement belongs to the old metadata epoch.
    // Drop it instead of replaying it after commit; the next current-epoch scan
    // can rediscover a genuinely new, stable export.
    if (this.metadataMutationActive || this.metadataMutationPromise) return;
    this.polledReplayIds.set(pathKey(payload.filepath), payload.id);
    const replay = this.store.upsert(payload);
    if (!replay) {
      return;
    }
    this.persistReplayState();
    this.announce(`${replay.title} detected in the export folder.`);
    this.scheduleReplayProcessing(replay.id, "filesystem-poll");
  }

  acceptPolledReplayIdentity(payload) {
    const key = pathKey(payload && payload.filepath);
    const polledId = this.polledReplayIds.get(key);
    if (polledId) {
      payload.id = polledId;
      this.polledReplayIds.delete(key);
    }
  }

  persistReplayState() {
    void this.persistOracleState();
  }

  async persistOracleState(options = {}) {
    const snapshot = this.store.state;
    try {
      const saved = await this.persistence.save(snapshot);
      if (!this.destroyed) this.store.adoptPersistenceMetadata(saved);
      return saved;
    } catch (error) {
      if (!this.destroyed) {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("error", "STATE_WRITE_FAILED", {
            revision: Number(snapshot && snapshot.revision) || 0,
            message: typeof oracleErrorMessage === "function"
              ? oracleErrorMessage(error)
              : "Replay metadata was not committed.",
          });
        }
        this.showToast("Oracle could not persist replay metadata safely.", "error");
      }
      if (options.propagate === true) throw error;
      return null;
    }
  }

  scheduleReplayProcessing(replayId, origin) {
    if (this.destroyed || this.metadataMutationActive || !replayId) return;
    const scheduledRecord = this.store.getRecord(replayId);
    if (!scheduledRecord) return;
    const scheduledPathKey = pathKey(scheduledRecord.canonicalPath || scheduledRecord.filepath);
    const scheduledIdentityKey = String(
      scheduledRecord.fileIdentity && scheduledRecord.fileIdentity.key || "",
    ).toUpperCase();
    const metadataGeneration = Number(this.metadataMutationGeneration) || 0;
    const matchesScheduledRecord = () => {
      if (this.destroyed || this.metadataMutationActive) return false;
      if ((Number(this.metadataMutationGeneration) || 0) !== metadataGeneration) return false;
      const current = this.store.getRecord(replayId);
      if (!current || pathKey(current.canonicalPath || current.filepath) !== scheduledPathKey) return false;
      const currentIdentityKey = String(current.fileIdentity && current.fileIdentity.key || "").toUpperCase();
      return !scheduledIdentityKey || !currentIdentityKey || currentIdentityKey === scheduledIdentityKey;
    };
    const generation = (this.processingGenerations.get(replayId) || 0) + 1;
    this.processingGenerations.set(replayId, generation);
    let thumbnailBase64 = "";
    const processingTask = this.metadataQueue.submit(async () => {
      if (!matchesScheduledRecord() || this.processingGenerations.get(replayId) !== generation) return;
      const record = this.store.getRecord(replayId);
      if (!record) return;
      thumbnailBase64 = this.store.consumeThumbnail(replayId);
      let fileSize = record.fileSize;
      let modifiedAt = record.modifiedAt;
      let missingState = record.missingState;
      if (uxpFs && typeof uxpFs.lstat === "function") {
        let previousFingerprint = "";
        let stabilized = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const stats = await uxpFs.lstat(record.canonicalPath);
          if (stats && typeof stats.isSymbolicLink === "function" && stats.isSymbolicLink()) {
            throw new Error("Replay path resolves through an unsupported symbolic link.");
          }
          if (stats && typeof stats.isFile === "function" && !stats.isFile()) {
            throw new Error("Replay path is not a regular media file.");
          }
          fileSize = Math.max(0, Number(stats && stats.size) || 0);
          const modifiedMillis = fileModifiedAt(stats);
          modifiedAt = modifiedMillis > 0 ? new Date(modifiedMillis).toISOString() : modifiedAt;
          const fingerprint = `${fileSize}:${modifiedAt || ""}`;
          missingState = "available";
          // Producer-declared metadata can describe a partial file while the
          // exporter still has the handle open. Only two time-separated,
          // identical filesystem observations prove that this export is
          // stable enough for background metadata/cache work.
          if (previousFingerprint && previousFingerprint === fingerprint) {
            stabilized = true;
            break;
          }
          previousFingerprint = fingerprint;
          if (attempt < 2) await delay(120);
        }
        if (!stabilized) throw new Error("Replay export did not reach a stable size and modification time.");
      } else if (fileSize !== null && fileSize > 0) {
        missingState = "available";
      }

      let thumbnailCacheKey = record.thumbnailCacheKey;
      let thumbnailStatus = record.thumbnailStatus;
      let thumbnailError = "";
      const sourceChanged = (
        record.fileSize !== null && fileSize !== null && Number(record.fileSize) !== Number(fileSize)
      ) || Boolean(record.modifiedAt && modifiedAt && record.modifiedAt !== modifiedAt);
      if (sourceChanged && record.thumbnailCacheKey) {
        if (!matchesScheduledRecord() || this.processingGenerations.get(replayId) !== generation) return;
        await this.thumbnailCache.invalidate(record);
        thumbnailCacheKey = "";
        thumbnailStatus = thumbnailBase64 ? "processing" : "unavailable";
      }
      if (thumbnailBase64) {
        try {
          if (!matchesScheduledRecord() || this.processingGenerations.get(replayId) !== generation) return;
          const legacy = record.legacy || {};
          const cached = await this.thumbnailCache.store({ ...record, fileSize, modifiedAt }, thumbnailBase64, {
            position: Number(legacy.thumbnailPosition) || 0.5,
            width: Number(legacy.thumbnailWidth) || 640,
            height: Number(legacy.thumbnailHeight) || 360,
            limitMb: Number(
              oracleWindow.oracleWorkspacePreferences &&
              oracleWindow.oracleWorkspacePreferences.replay &&
              oracleWindow.oracleWorkspacePreferences.replay.cacheLimitMb,
            ) || 512,
          });
          thumbnailCacheKey = cached.key;
          thumbnailStatus = "ready";
        } catch (error) {
          thumbnailStatus = "error";
          thumbnailError = String(error && error.message ? error.message : error);
        }
      }
      if (
        !matchesScheduledRecord() ||
        this.processingGenerations.get(replayId) !== generation ||
        !this.store.getRecord(replayId)
      ) {
        return;
      }
      this.store.updateById(replayId, {
        fileSize,
        modifiedAt,
        missingState,
        thumbnailCacheKey,
        thumbnailStatus,
      }, { domain: true });
      this.store.updateById(replayId, {
        status: missingState === "missing" ? "error" : "ready",
        statusMessage: missingState === "missing" ? "Source file is missing" : "Drag ready",
        thumbnailError,
      });
      this.persistReplayState();
      if (missingState === "available" && nativeDragAddon) {
        void this.ensureNativeReplayRegistration(replayId).catch(() => undefined);
      }
    }).catch(async (error) => {
      if (!matchesScheduledRecord() || this.processingGenerations.get(replayId) !== generation) return;
      const missing = isMissingFileError(error);
      try {
        if (missing) {
          try {
            // This catch runs inside the replay's processing task. Release only
            // viewer ownership here; the mutation helper also awaits processing
            // tasks and would otherwise await this task from itself.
            await this.releaseReplayViewerMounts([replayId]);
          } catch (releaseError) {
            this.showToast("Oracle could not release the missing replay from every Source Monitor viewer.", "error");
          }
        }
        this.store.updateById(replayId, {
          missingState: missing ? "missing" : "unknown",
          thumbnailStatus: thumbnailBase64 ? "error" : "unavailable",
        }, { domain: true });
        this.store.updateById(replayId, {
          status: "error",
          statusMessage: missing ? "Source file is missing" : "Metadata validation failed",
          thumbnailError: thumbnailBase64 ? "Thumbnail caching failed" : "Thumbnail unavailable",
        });
        this.persistReplayState();
      } catch (updateError) {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("error", "METADATA_RECORD_UPDATE_FAILED", {
            replayIdPresent: Boolean(replayId),
            origin: String(origin || "unknown"),
            message: typeof oracleErrorMessage === "function"
              ? oracleErrorMessage(updateError)
              : "Replay metadata state could not be updated.",
          });
        }
      }
    });
    let tasks = this.processingTasks.get(replayId);
    if (!tasks) {
      tasks = new Set();
      this.processingTasks.set(replayId, tasks);
    }
    tasks.add(processingTask);
    void processingTask.finally(() => {
      const current = this.processingTasks.get(replayId);
      if (!current) return;
      current.delete(processingTask);
      if (!current.size) this.processingTasks.delete(replayId);
    });
  }

  queueImport(filepath, resetBackoff = false) {
    if (this.destroyed) {
      return;
    }
    const replay = this.store.get(filepath);
    if (!replay || replay.status === "ready" || replay.status === "importing") {
      return;
    }

    if (resetBackoff) {
      this.resetImportRetry(filepath);
    } else {
      this.clearImportRetryTimer(filepath);
    }
    this.store.update(filepath, {
      status: "importing",
      statusMessage: "Importing into Premiere",
    });

    this.importChain = this.importChain
      .catch(() => undefined)
      .then(async () => {
        if (this.destroyed) {
          return;
        }
        try {
          const projectItem = await this.gateway.importReplay(filepath);
          if (this.destroyed) {
            return;
          }
          const projectItemId = await this.gateway.projectItemId(projectItem);
          const readyReplay = this.store.update(filepath, {
            status: "ready",
            statusMessage: "Ready in Premiere",
            projectItem,
            projectItemId,
          });
          this.persistReplayState();
          this.resetImportRetry(filepath);
          this.announce(`${readyReplay ? readyReplay.title : replay.title} is ready in Premiere.`);
        } catch (error) {
          if (this.destroyed) {
            return;
          }
          const userError = normalizeError(error);
          if (typeof recordOracleDiagnostic === "function") {
            recordOracleDiagnostic("error", userError.code || "IMPORT_FAILED", {
              retry: Boolean(userError.retry),
              message: String(userError.message || "Replay import failed."),
            });
          }
          this.store.update(filepath, {
            status: userError.retry ? "waiting" : "error",
            statusMessage: userError.message,
          });
          if (userError.retry) {
            this.scheduleImportRetry(filepath, userError.message);
          } else if (this.gateway.isAvailable()) {
            this.showToast(`${replay.title}: ${userError.message}`, "error");
          }
        }
      });
  }

  scheduleImportRetry(filepath, reason) {
    const key = pathKey(filepath);
    if (this.retryTimers.has(key)) {
      return;
    }
    const attempt = this.retryAttempts.get(key) || 0;
    if (attempt >= IMPORT_RETRY_MAX_ATTEMPTS) {
      this.retryAttempts.delete(key);
      this.store.update(filepath, {
        status: "error",
        statusMessage: `${reason} · retry limit reached`,
      });
      return;
    }
    const retryDelay = Math.min(
      IMPORT_RETRY_INITIAL_MS * Math.pow(2, attempt),
      IMPORT_RETRY_MAX_MS,
    );
    this.retryAttempts.set(key, attempt + 1);
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("debug", "IMPORT_RETRY_SCHEDULED", {
        attempt: attempt + 1,
        retryDelayMs: retryDelay,
        reason: String(reason || "Import retry requested."),
      });
    }
    this.store.update(filepath, {
      status: "waiting",
      statusMessage: `${reason} · retrying in ${formatRetryDelay(retryDelay)}`,
    });
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (!this.destroyed) {
        this.queueImport(filepath);
      }
    }, retryDelay);
    this.retryTimers.set(key, timer);
  }

  clearImportRetryTimer(filepath) {
    const key = pathKey(filepath);
    const timer = this.retryTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
  }

  resetImportRetry(filepath) {
    const key = pathKey(filepath);
    this.clearImportRetryTimer(filepath);
    this.retryAttempts.delete(key);
  }

  async openReplayViewer(
    replay,
    viewer = this.viewer,
    elements = this.elements,
    showToast = (message, kind) => this.showToast(message, kind),
  ) {
    if (!viewer) return this.openInSourceMonitor(replay);
    const poster = elements.replayViewerPoster;
    const viewerError = elements.replayViewerError;
    if (viewerError) {
      viewerError.hidden = true;
      viewerError.textContent = "";
    }
    if (poster) {
      poster.removeAttribute("src");
      poster.hidden = true;
      const source = replayThumbnailSource(replay);
      if (source) {
        poster.setAttribute("src", source);
        poster.hidden = false;
      }
    }
    try {
      const opened = await viewer.openReplay(replay);
      if (!opened) return false;
      this.sourceMonitorPlaying = false;
      this.sourceMonitorReplayId = "";
      return true;
    } catch (error) {
      const normalized = normalizeError(error);
      if (viewerError) {
        viewerError.textContent = `[${normalized.code}] ${normalized.message}`;
        viewerError.hidden = false;
      }
      showToast(`[${normalized.code}] ${normalized.message}`, "error");
      return false;
    }
  }

  async openInSourceMonitor(replay) {
    try {
      await this.gateway.openInSourceMonitor(replay);
      this.sourceMonitorPlaying = false;
      this.sourceMonitorReplayId = replay.id;
      this.recordReplayUsage(replay.id, "opened");
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("info", "SOURCE_MONITOR_OPENED", {
          replayIdPresent: Boolean(replay && replay.id),
        });
      }
      this.showToast(`${replay.title} opened in Source Monitor.`, "success");
      this.announce(`${replay.title} opened in Source Monitor.`);
      return true;
    } catch (error) {
      this.showToast(normalizeError(error).message, "error");
      return false;
    }
  }

  async explicitImportReplay(replay, sourceView = this.view, feedback = {}) {
    const showToast = typeof feedback.showToast === "function"
      ? feedback.showToast
      : (message, kind) => this.showToast(message, kind);
    const announce = typeof feedback.announce === "function"
      ? feedback.announce
      : (message) => this.announce(message);
    try {
      const canonicalPath = getReplayCanonicalMediaPath(replay);
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("info", "IMPORT_EXPLICIT_ACTIVATION", {
          replayIdPresent: Boolean(replay && replay.id),
          canonicalPathPresent: Boolean(canonicalPath),
        });
      }
      const suppression = sourceView && typeof sourceView.getImportSuppression === "function"
        ? sourceView.getImportSuppression()
        : null;
      const projectItem = await this.gateway.importReplay(canonicalPath, suppression);
      const projectItemId = await this.gateway.projectItemId(projectItem);
      const updated = this.store.update(canonicalPath, {
        status: "ready",
        statusMessage: "Drag ready",
        projectItem,
        projectItemId,
      });
      this.persistReplayState();
      const title = updated ? updated.title : replay.title;
      showToast(`${title} imported into Premiere.`, "success");
      announce(`${title} imported into Premiere.`);
      return projectItem;
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code !== "IMPORT_SUPPRESSED_AFTER_DRAG") {
        showToast(`[${normalized.code}] ${normalized.message}`, "error");
        announce(`${replay.title} could not be imported. ${normalized.message}`);
      }
      return null;
    }
  }

  async insertAtPlayhead(replay) {
    const result = await this.gateway.insertReplayIntoActiveSequence(replay);
    if (result.ok) {
      this.showToast(`${replay.title} inserted at the playhead.`, "success");
      this.announce(`${replay.title} inserted at the playhead.`);
      return result;
    }
    this.showToast(result.message, "error");
    this.announce(`${replay.title} could not be inserted. ${result.message}`);
    return result;
  }

  handleNativeDragResult(replay, result, canonicalPath, feedback = {}) {
    const showToast = typeof feedback.showToast === "function"
      ? feedback.showToast
      : (message, kind) => this.showToast(message, kind);
    const announce = typeof feedback.announce === "function"
      ? feedback.announce
      : (message) => this.announce(message);
    if (result && result.ok && result.dropped) {
      this.recordReplayUsage(replay.id, "dragged");
      showToast(`${replay.title} dropped at Premiere's native timeline destination.`, "success");
      announce(`${replay.title} dropped on the Premiere timeline.`);
      // ProjectItem discovery/import and label index 9 are intentionally
      // post-drop reconciliation. They must never delay native OLE startup.
      this.scheduleLabelReconciliation(canonicalPath || replay.filepath, { showToast, announce });
      return;
    }
    if (result && result.ok && result.cancelled) {
      announce(`${replay.title} drag cancelled. Nothing was inserted.`);
      return;
    }
    const code = String((result && result.errorCode) || "DRAG_FAILED");
    const message = String((result && result.errorMessage) || "The native replay drag failed.");
    showToast(`[${code}] ${message}`, "error");
    announce(`${replay.title} could not be dragged. ${message}`);
  }

  scheduleLabelReconciliation(absolutePath, feedback = {}) {
    const showToast = typeof feedback.showToast === "function"
      ? feedback.showToast
      : (message, kind) => this.showToast(message, kind);
    const announce = typeof feedback.announce === "function"
      ? feedback.announce
      : (message) => this.announce(message);
    this.gateway.scheduleLabelReconciliation(absolutePath, {
      onSuccess: ({ projectItemCount }) => {
        showToast(
          `Verified label 9 on ${projectItemCount} exact-path ProjectItem${projectItemCount === 1 ? "" : "s"}.`,
          "success",
        );
      },
      onError: (error) => {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("error", error && error.code || "LABEL_RECONCILIATION_FAILED", {
            message: String(error && error.message || "Replay label reconciliation failed."),
            detailsAvailable: Boolean(error && error.details),
          });
        }
        showToast(`[${error.code}] ${error.message}`, "error");
        announce(`Oracle could not reconcile the dropped replay label. ${error.message}`);
      },
    });
  }

  showToast(message, kind = "info") {
    if (this.destroyed) {
      return;
    }
    const toast = document.createElement("div");
    toast.className = `toast toast--${kind}`;
    toast.textContent = message;
    this.elements.toasts.appendChild(toast);
    const timer = setTimeout(() => {
      this.toastTimers.delete(timer);
      toast.remove();
    }, 3600);
    this.toastTimers.add(timer);
  }

  announce(message) {
    if (this.destroyed) {
      return;
    }
    if (this.announceTimer !== null) {
      clearTimeout(this.announceTimer);
    }
    this.elements.screenReaderStatus.textContent = "";
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      this.elements.screenReaderStatus.textContent = message;
    }, 10);
  }

  destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    const report = (label, error) => {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "CONTROLLER_TEARDOWN_STEP_FAILED", {
          step: String(label || "unknown"),
          message: typeof oracleErrorMessage === "function"
            ? oracleErrorMessage(error)
            : "A controller teardown step failed.",
        });
      }
    };
    const run = async (label, action) => {
      try {
        return await action();
      } catch (error) {
        report(label, error);
        return null;
      }
    };
    this.destroyPromise = (async () => {
      try {
        await run("beforeunload listener", () => window.removeEventListener("beforeunload", this.handleBeforeUnload));
        await run("runtime replacement listener", () => document.removeEventListener(ORACLE_RUNTIME_REPLACE_EVENT, this.handleRuntimeReplacement));
        if (this.metadataMutationPromise) {
          await run("metadata mutation", () => this.metadataMutationPromise);
        }
        await run("native watcher tasks", () => this.drainNativeWatcherTasks());
        if (this.persistence && typeof this.persistence.flush === "function") {
          await run("state write drain", () => this.persistence.flush());
        } else if (this.persistence && this.persistence.writeChain && typeof this.persistence.writeChain.then === "function") {
          await run("state write drain", () => this.persistence.writeChain);
        }
        await run("bridge", () => destroyBridge());
        for (const mount of Array.from(this.dedicatedMounts || [])) {
          if (mount && typeof mount.destroy === "function") {
            await run("dedicated panel mount", () => mount.destroy({ runtimeDestroy: true }));
          }
        }
        if (this.dedicatedMounts) await run("dedicated mount registry", () => this.dedicatedMounts.clear());

        if (this.quickApplyWorkspace) await run("Quick Apply workspace", () => this.quickApplyWorkspace.destroy());
        if (this.quickApplyDomain) await run("Quick Apply domain", () => this.quickApplyDomain.destroy());
        if (this.quickApplyAdapterLease) await run("Quick Apply lease", () => this.quickApplyAdapterLease.release());
        if (this.quickApplyAdapterCoordinator) await run("Quick Apply coordinator", () => this.quickApplyAdapterCoordinator.destroy());
        if (this.quickApplyRecipeStore) await run("Quick Apply recipe store", () => this.quickApplyRecipeStore.destroy());
        if (this.quickApplyStateStore) await run("Quick Apply state store", () => this.quickApplyStateStore.destroy());

        if (this.curvesWorkspace) await run("Curves workspace", () => this.curvesWorkspace.destroy());
        if (this.curvesAdapterLease) await run("Curves lease", () => this.curvesAdapterLease.release());
        if (this.curvesAdapterCoordinator) await run("Curves coordinator", () => this.curvesAdapterCoordinator.destroy());
        if (this.curveWorkspaceStateStore) await run("Curves workspace state", () => this.curveWorkspaceStateStore.destroy());
        if (this.curvePresetStore) await run("Curve preset store", () => this.curvePresetStore.destroy());
        if (this.curvesPresetDialog) await run("Curve preset dialog", () => this.curvesPresetDialog.destroy());

        if (this.viewer) await run("Source Monitor viewer", () => this.viewer.destroy());
        if (this.viewerAdapterCoordinator) {
          await run("Source Monitor coordinator", () => this.viewerAdapterCoordinator.destroy());
        }
        if (this.elements.replayViewerPoster) {
          await run("viewer poster", () => {
            this.elements.replayViewerPoster.removeAttribute("src");
            this.elements.replayViewerPoster.hidden = true;
          });
        }
        if (this.logo) await run("logo", () => this.logo.stop());

        for (const timer of this.retryTimers.values()) await run("retry timer", () => clearTimeout(timer));
        await run("retry timer registry", () => this.retryTimers.clear());
        await run("retry attempts", () => this.retryAttempts.clear());
        if (this.nativeWatchTimer !== null) await run("native watch timer", () => clearInterval(this.nativeWatchTimer));
        this.nativeWatchTimer = null;
        if (this.nativeWatchRefreshTimer !== null) {
          await run("native watch refresh timer", () => clearTimeout(this.nativeWatchRefreshTimer));
        }
        this.nativeWatchRefreshTimer = null;
        for (const timer of this.nativeMissingVerificationTimers.values()) {
          await run("missing replay timer", () => clearTimeout(timer));
        }
        await run("missing replay timer registry", () => this.nativeMissingVerificationTimers.clear());
        if (this.activeFileOperationRequestId && nativeDragAddon && typeof nativeDragAddon.cancelFileOperation === "function") {
          await run("native file operation", () => nativeDragAddon.cancelFileOperation(this.activeFileOperationRequestId));
        }
        this.activeFileOperationRequestId = null;
        if (nativeDragAddon && typeof nativeDragAddon.stopDirectoryWatch === "function") {
          await run("native directory watch", () => nativeDragAddon.stopDirectoryWatch());
        }
        this.nativeLifecycleStarted = false;
        this.nativeWatchRoots = [];
        await run("native registrations", () => this.nativeRegistrationTasks.clear());
        for (const timer of this.toastTimers) await run("toast timer", () => clearTimeout(timer));
        await run("toast timer registry", () => this.toastTimers.clear());
        if (this.announceTimer !== null) await run("announcement timer", () => clearTimeout(this.announceTimer));
        this.announceTimer = null;
        await run("toast region", () => { this.elements.toasts.innerHTML = ""; });
        await run("screen reader status", () => { this.elements.screenReaderStatus.textContent = ""; });

        if (this.shell) await run("shell", () => this.shell.destroy());
        if (this.workspace) await run("replay workspace", () => this.workspace.destroy());
        if (this.lifecycleUi) await run("replay lifecycle UI", () => this.lifecycleUi.destroy());
        if (this.elements.replayBatchBar) {
          await run("replay batch listener", () => this.elements.replayBatchBar.removeEventListener("click", this.onReplayBatchClick));
        }
        if (this.theme) await run("Preferences", () => this.theme.destroy());
        if (this.wheelScroller) await run("wheel scroller", () => this.wheelScroller.destroy());
        if (this.gridScale) await run("grid scale", () => this.gridScale.destroy());
        if (this.exportPoller) await run("export poller", () => this.exportPoller.destroy());
        await run("polled replay IDs", () => this.polledReplayIds.clear());
        await run("processing generations", () => this.processingGenerations.clear());
        await run("processing tasks", () => this.processingTasks.clear());
        if (this.metadataQueue) await run("metadata queue", () => this.metadataQueue.destroy());
        if (this.thumbnailCache) await run("thumbnail cache", () => this.thumbnailCache.destroy());
        if (this.persistence) await run("persistence", () => this.persistence.destroy());
        if (this.view) await run("replay grid", () => this.view.destroy());
        if (this.gateway) await run("Premiere gateway", () => this.gateway.destroy());
        if (this.store) await run("replay store", () => this.store.destroy());
      } finally {
        await run("window controller reference", () => {
          if (Reflect.get(window, ORACLE_PANEL_CONTROLLER_KEY) === this) {
            Reflect.deleteProperty(window, ORACLE_PANEL_CONTROLLER_KEY);
          }
        });
        await run("document controller reference", () => {
          if (Reflect.get(document.documentElement, ORACLE_PANEL_CONTROLLER_KEY) === this) {
            Reflect.deleteProperty(document.documentElement, ORACLE_PANEL_CONTROLLER_KEY);
          }
        });
      }
      return true;
    })();
    return this.destroyPromise;
  }
}

const ORACLE_M7_DEDICATED_PANEL_KINDS = Object.freeze({
  oracleReplaysPanel: "replays",
  oracleCurvesPanel: "curves",
  oracleQuickApplyPanel: "quick-apply",
});

class OracleDedicatedPanelMount {
  constructor(options = {}) {
    this.panelId = String(options.panelId || "");
    this.kind = ORACLE_M7_DEDICATED_PANEL_KINDS[this.panelId] || "";
    this.shell = options.shell;
    this.controller = options.controller;
    this.panelDom = options.panelDom;
    this.blueprint = options.blueprint;
    if (!this.kind || !this.shell || !this.controller || !this.panelDom || !this.blueprint) {
      throw new Error("Oracle could not create a complete dedicated panel mount.");
    }
    this.root = this.shell.root;
    this.document = this.root.ownerDocument || document;
    this.instance = this.panelDom.instantiatePanelBlueprint(this.blueprint, {
      target: this.shell.content,
      document: this.document,
      prefixBase: this.panelId,
      activateWorkspaceId: this.kind === "quick-apply"
        ? "quickApplyWorkspace"
        : this.kind === "curves"
          ? "curvesWorkspace"
          : "replayScroller",
    });
    this.elements = this.instance.elements;
    if (this.kind === "replays") {
      // The shared ReplayGridView intentionally uses the compact controller
      // aliases from the main panel. Dedicated blueprints retain their source
      // DOM IDs, so bind those aliases explicitly instead of reaching back
      // into document-global elements.
      this.elements.grid = this.elements.replayGrid;
      this.elements.empty = this.elements.emptyState;
      this.elements.toasts = this.elements.toastRegion;
    }
    this.mountId = this.instance.prefix;
    this.visible = true;
    this.started = false;
    this.destroyed = false;
    this.destroyPromise = null;
    this.toastTimers = new Set();
    this.announceTimer = null;
    this.resizeObserver = null;
    this.handleBatchClick = (event) => this.onReplayBatchClick(event);
    this.controller.registerDedicatedMount(this);
  }

  start() {
    if (this.started || this.destroyed) return this;
    this.started = true;
    this.installDensityObserver();
    if (this.kind === "replays") this.startReplays();
    else if (this.kind === "curves") this.startCurves();
    else this.startQuickApply();
    this.setVisible(true);
    this.panelDom.assertNoDuplicateIds(this.root, `${this.panelId} mount`);
    return this;
  }

  installDensityObserver() {
    const update = () => {
      if (this.destroyed || !this.root || typeof this.root.getBoundingClientRect !== "function") return;
      const width = Number(this.root.getBoundingClientRect().width) || Number(this.root.clientWidth) || 0;
      this.root.dataset.oraclePanelDensity = width > 0 && width < 520
        ? "compact"
        : width >= 900
          ? "wide"
          : "regular";
    };
    update();
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(update);
      this.resizeObserver.observe(this.root);
    }
  }

  showToast(message, kind = "info") {
    if (this.destroyed || !this.elements.toastRegion) return;
    const kindValue = /** @type {any} */ (kind);
    const tone = typeof kindValue === "string" ? kindValue : String(kindValue && kindValue.tone || "info");
    const toast = this.document.createElement("div");
    toast.className = `toast toast--${tone}`;
    toast.textContent = String(message || "Oracle completed the action.").slice(0, 2048);
    this.elements.toastRegion.appendChild(toast);
    const timer = setTimeout(() => {
      this.toastTimers.delete(timer);
      toast.remove();
    }, 3600);
    this.toastTimers.add(timer);
  }

  announce(message) {
    if (this.destroyed || !this.elements.screenReaderStatus) return;
    if (this.announceTimer !== null) clearTimeout(this.announceTimer);
    this.elements.screenReaderStatus.textContent = "";
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      if (!this.destroyed && this.elements.screenReaderStatus) {
        this.elements.screenReaderStatus.textContent = String(message || "").slice(0, 2048);
      }
    }, 10);
  }

  startReplays() {
    const controller = this.controller;
    const replayLibraryApi = controller.replayLibraryApi;
    const replayWorkspaceApi = oracleWindow.OracleReplayWorkspace;
    const replayLifecycleApi = oracleWindow.OracleReplayLifecycleUI;
    const replayViewerApi = oracleWindow.OracleReplayViewer;
    this.wheelScroller = new SmoothWheelScroller(this.elements.replayScroller);
    this.gridScale = new GridScaleControl(
      this.elements.gridScale,
      this.elements.grid,
      this.elements.gridColumnCount,
      (columns) => {
        if (controller.theme && typeof controller.theme.commitExternal === "function") {
          try {
            controller.theme.commitExternal("replay.gridColumns", columns);
          } catch (error) {
            this.showToast("Oracle could not persist the grid density.", "error");
          }
        }
      },
      () => {
        if (this.view && typeof this.view.handleLayoutChanged === "function") this.view.handleLayoutChanged();
      },
    );
    this.viewerAdapterLease = controller.viewerAdapterCoordinator.acquireLease(`${this.mountId}:viewer`, {
      onRevoked: (event) => {
        if (event && event.reason === "superseded" && this.viewer && !this.destroyed) {
          void this.viewer.close("superseded");
        }
      },
    });
    this.viewer = new replayViewerApi.ReplayViewerController({
      root: this.elements.replayViewerTray,
      title: this.elements.replayViewerTitle,
      status: this.elements.replayViewerStatus,
      mode: this.elements.replayViewerMode,
      poster: this.elements.replayViewerPoster,
      playPause: this.elements.replayViewerPlayPause,
      seek: this.elements.replayViewerScrub,
      currentTime: this.elements.replayViewerCurrentTime,
      duration: this.elements.replayViewerDuration,
      stepBackward: this.elements.replayViewerStepBack,
      stepForward: this.elements.replayViewerStepForward,
      mute: this.elements.replayViewerMute,
      volume: this.elements.replayViewerVolume,
      speed: this.elements.replayViewerRate,
      loop: this.elements.replayViewerLoop,
      close: this.elements.replayViewerClose,
      error: this.elements.replayViewerError,
      support: this.elements.replayViewerSupport,
    }, {
      adapter: this.viewerAdapterLease,
      onUsage: (value) => {
        if (value && typeof value === "object" && value.action !== "open") return;
        const replayId = typeof value === "string" ? value : String(value && (value.replayId || value.id) || "");
        if (replayId) controller.recordReplayUsage(replayId, "opened");
      },
      onToast: (message, kind) => this.showToast(message, kind),
      onAnnounce: (message) => this.announce(message),
      document: this.document,
    });
    this.view = new ReplayGridView(this.elements, {
      onOpen: (replay) => controller.openReplayViewer(
        replay,
        this.viewer,
        this.elements,
        (message, kind) => this.showToast(message, kind),
      ),
      onInsert: (replay) => controller.explicitImportReplay(replay, this.view, {
        showToast: (message, kind) => this.showToast(message, kind),
        announce: (message) => this.announce(message),
      }),
      onNativeDragResult: (replay, result, canonicalPath) => controller.handleNativeDragResult(
        replay,
        result,
        canonicalPath,
        {
          showToast: (message, kind) => this.showToast(message, kind),
          announce: (message) => this.announce(message),
        },
      ),
      onBlockedDrag: (reason) => this.showToast(reason, "error"),
      onContextAction: (action, replay, selected) => controller.handleReplayContextAction(
        action,
        replay,
        selected,
        {
          viewer: this.viewer,
          lifecycleUi: this.lifecycleUi,
          elements: this.elements,
          showToast: (message, kind) => this.showToast(message, kind),
        },
      ),
      onSelectionChange: (ids, replays) => controller.updateReplaySelectionUi(ids, replays, this.elements),
      onAnnounce: (message) => this.announce(message),
      onReorder: (request) => controller.handleReplayReorder(request, {
        showToast: (message, kind) => this.showToast(message, kind),
        refresh: (change) => this.refresh(change),
        announce: (message) => this.announce(message),
      }),
      getContextActionState: (action, replay, selected) =>
        controller.getReplayContextActionState(action, replay, selected, this.viewer),
      onThumbnailUsed: (key) => {
        if (controller.thumbnailCache) controller.thumbnailCache.touch(key);
      },
      getReplayById: (id) => controller.store && controller.store.getById(id),
      getGridColumns: () => this.gridScale ? this.gridScale.effectiveColumns : 1,
      virtualizer: new replayLibraryApi.ReplayVirtualWindow(),
      nativeAddon: nativeDragAddon,
      nativeAddonDiagnostic: nativeDragAddonDiagnostic,
      document: this.document,
      root: this.root,
    });
    this.replayQuery = replayWorkspaceApi.normalizeQueryState({ view: "all" });
    this.workspace = new replayWorkspaceApi.ReplayWorkspaceController(this.elements, {
      document: this.document,
      root: this.root,
      onQueryChange: (query) => {
        this.replayQuery = query;
        this.refresh({ type: "query", resetScroll: true });
      },
    });
    this.lifecycleUi = new replayLifecycleApi.ReplayLifecycleDialogController(this.elements, {
      document: this.document,
      root: this.root,
      onApply: (mode, payload, context) => controller.applyReplayLifecycleAction(mode, payload, {
        ...(context || {}),
        showToast: (message, kind) => this.showToast(message, kind),
        announce: (message) => this.announce(message),
      }),
      onChooseRelink: (context) => controller.chooseReplayRelink(context),
      onCollectionCommand: (command, payload, context) => controller.applyCollectionCommand(command, payload, context),
      onCancelBusy: (mode, context) => controller.cancelReplayLifecycleOperation(mode, {
        ...(context || {}),
        showToast: (message, kind) => this.showToast(message, kind),
        announce: (message) => this.announce(message),
      }),
      onAnnounce: (message) => this.announce(message),
    });
    this.wheelScroller.start();
    this.gridScale.start();
    this.workspace.start();
    this.lifecycleUi.start();
    this.viewer.start();
    this.elements.replayBatchBar.addEventListener("click", this.handleBatchClick);
    this.view.render([], { totalCount: 0 });
    this.refresh({ type: "mount", resetScroll: true });
  }

  refresh(change = {}) {
    if (this.kind !== "replays" || this.destroyed || !this.view || !this.workspace) return;
    const store = this.controller.store;
    const ids = store.select(this.replayQuery || { view: "all" });
    const items = store.presentations(ids);
    const state = store.state;
    const records = Object.values(state.replaysById || {});
    this.replayRecordCount = records.length;
    const tags = Array.from(new Set(records.flatMap((record) => record.tags || [])))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 256)
      .map((value) => ({ value, label: value }));
    const roots = Array.from(new Set(records.map((record) => replayParentPath(record.canonicalPath)).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 256)
      .map((value) => ({ value, label: value }));
    const collections = Object.values(state.collectionsById || {})
      .sort((left, right) =>
        Number(left.sortOrder || 0) - Number(right.sortOrder || 0) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id))
      .slice(0, 512)
      .map((collection) => ({ id: collection.id, name: collection.name }));
    const query = this.replayQuery || {};
    if (query.tag && !tags.some((entry) => entry.value === query.tag)) tags.unshift({ value: query.tag, label: query.tag });
    if (query.root && !roots.some((entry) => entry.value === query.root)) roots.unshift({ value: query.root, label: query.root });
    if (query.collectionId && !collections.some((entry) => entry.id === query.collectionId)) {
      const selected = state.collectionsById && state.collectionsById[query.collectionId];
      if (selected) collections.unshift({ id: selected.id, name: selected.name });
    }
    this.workspace.setFacets({ collections, tags, roots });
    this.workspace.setResultCount(items.length, records.length);
    this.view.render(items, {
      totalCount: records.length,
      resetScroll: change && change.resetScroll === true,
      manualOrderCollectionId:
        query.collectionId &&
        state.collectionsById &&
        state.collectionsById[query.collectionId] &&
        !state.collectionsById[query.collectionId].smartRules
          ? query.collectionId
          : "",
    });
  }

  onReplayBatchClick(event) {
    const button = event && event.target && event.target.closest
      ? event.target.closest("[data-replay-batch-action]")
      : null;
    if (!button || button.disabled || !this.view) return;
    const action = String(button.dataset.replayBatchAction || "");
    const replays = this.view.getSelectedReplays();
    if (!replays.length) return;
    if (action === "clear") {
      this.view.clearSelection();
      return;
    }
    if (action === "favorite") {
      void this.controller.handleReplayContextAction("favorite", replays[0], replays, {
        viewer: this.viewer,
        lifecycleUi: this.lifecycleUi,
        elements: this.elements,
        showToast: (message, kind) => this.showToast(message, kind),
      });
      return;
    }
    if (action === "archive") {
      const lifecycleAction = replays.every((replay) => replay.archiveState === "archived") ? "restore" : "archive";
      try {
        this.controller.openLifecycleConfirmation(replays, lifecycleAction, button, this.lifecycleUi);
      } catch (error) {
        this.showToast(error && error.message ? error.message : String(error), "error");
      }
      return;
    }
    if (["collections", "tags", "relink"].includes(action)) {
      this.lifecycleUi.open(action, this.controller.replayDialogContext(replays), button);
    }
  }

  startCurves() {
    const controller = this.controller;
    this.promptDialog = new CurvePresetDialogController(this.elements);
    this.adapterLease = controller.curvesAdapterCoordinator.acquireLease(`${this.mountId}:curves`);
    this.workspace = new oracleWindow.OracleCurvesWorkspace.CurvesWorkspaceController(this.elements, {
      adapter: this.adapterLease,
      curveMath: controller.curveMathApi,
      presetApi: controller.curvePresetApi,
      presetStore: controller.curvePresetStore,
      stateStore: controller.curveWorkspaceStateStore,
      presetHooks: controller.createCurvePresetHooks(this.promptDialog),
      confirmPresetAction: (request) => controller.confirmCurvePresetAction(request, this.promptDialog),
      confirmBakedApply: (request) => controller.confirmCurveBake(request, this.promptDialog),
      preferences: controller.theme.committed && controller.theme.committed.curves,
      visible: true,
      active: true,
      ownsAdapter: false,
      onToast: (message, kind) => this.showToast(message, kind),
      onAnnounce: (message) => this.announce(message),
      document: this.document,
    });
    this.promptDialog.start();
    this.workspace.start();
  }

  startQuickApply() {
    const controller = this.controller;
    if (!controller.quickApplyAdapterCoordinator || !controller.quickApplyStateStore || !controller.quickApplyRecipeStore) {
      throw new Error("Oracle Quick Apply shared services are not ready.");
    }
    this.promptDialog = new CurvePresetDialogController(this.elements);
    this.adapterLease = controller.quickApplyAdapterCoordinator.acquireLease(`${this.mountId}:quick-apply`);
    this.domain = new controller.quickApplyDomainApi.QuickApplyDomain({
      adapter: this.adapterLease,
      stateStore: controller.quickApplyStateStore,
      recipeStore: controller.quickApplyRecipeStore,
      preferences: controller.theme.committed && controller.theme.committed.quickApply,
      visible: true,
      active: true,
      ownsAdapter: false,
    });
    this.workspace = new controller.quickApplyWorkspaceApi.QuickApplyWorkspaceController(this.elements, {
      domain: this.domain,
      ownsDomain: false,
      visible: true,
      active: true,
      requestRecipeName: (request) => controller.requestQuickApplyRecipeName(request, this.promptDialog),
      confirmRecipeAction: (request) => controller.confirmQuickApplyRecipeAction(request, this.promptDialog),
      importRecipeFile: (request) => controller.importQuickApplyRecipes(request),
      exportRecipeFile: (request) => controller.exportQuickApplyRecipes(request),
      onRequestCloseTopLayer: () => this.announce("Oracle Quick Apply remains open in its dedicated panel."),
      onToast: (message, kind) => this.showToast(message, kind),
      onAnnounce: (message) => this.announce(message),
      document: this.document,
    });
    this.promptDialog.start();
    this.workspace.start();
  }

  setPreferences(preferences = {}) {
    if (this.destroyed || !this.workspace) return;
    if (this.kind === "curves" && preferences.curves) this.workspace.setPreferences(preferences.curves);
    if (this.kind === "quick-apply" && preferences.quickApply) this.workspace.setPreferences(preferences.quickApply);
    if (this.kind === "replays" && preferences.replay && this.gridScale) {
      this.gridScale.updateGridColumns(preferences.replay.gridColumns, false);
    }
  }

  setVisible(value) {
    if (this.destroyed) return false;
    const next = Boolean(value);
    this.visible = next;
    this.root.dataset.oraclePanelVisible = next ? "true" : "false";
    if (this.kind === "curves" || this.kind === "quick-apply") {
      if (this.workspace) {
        this.workspace.setVisible(next);
        this.workspace.setActive(next);
      }
    } else if (next) {
      if (this.gridScale) this.gridScale.scheduleLayout();
      this.refresh({ type: "show" });
    } else if (this.viewer) {
      void this.viewer.close("panel-hide");
    }
    return true;
  }

  destroy(_options = {}) {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.visible = false;
    const report = (label, error) => {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "DEDICATED_PANEL_TEARDOWN_STEP_FAILED", {
          panelId: this.panelId,
          step: String(label || "unknown"),
          message: typeof oracleErrorMessage === "function"
            ? oracleErrorMessage(error)
            : "A dedicated panel teardown step failed.",
        });
      }
    };
    const run = async (label, action) => {
      try {
        return await action();
      } catch (error) {
        report(label, error);
        return null;
      }
    };
    this.destroyPromise = (async () => {
      await run("mount registry", () => this.controller.unregisterDedicatedMount(this));
      if (this.resizeObserver) await run("resize observer", () => this.resizeObserver.disconnect());
      this.resizeObserver = null;
      if (this.kind === "replays") {
        if (this.elements.replayBatchBar) {
          await run("batch listener", () => this.elements.replayBatchBar.removeEventListener("click", this.handleBatchClick));
        }
        if (this.lifecycleUi) await run("replay lifecycle UI", () => this.lifecycleUi.destroy());
        if (this.workspace) await run("replay workspace", () => this.workspace.destroy());
        if (this.view) await run("replay grid", () => this.view.destroy());
        if (this.wheelScroller) await run("wheel scroller", () => this.wheelScroller.destroy());
        if (this.gridScale) await run("grid scale", () => this.gridScale.destroy());
        if (this.viewer) await run("replay viewer", () => this.viewer.destroy());
        if (this.viewerAdapterLease) {
          const state = typeof this.viewerAdapterLease.getLeaseState === "function"
            ? this.viewerAdapterLease.getLeaseState()
            : null;
          if (!state || state.released !== true) {
            await run("viewer lease", () => this.viewerAdapterLease.release());
          }
        }
      } else {
        if (this.workspace) await run("workspace", () => this.workspace.destroy());
        if (this.domain) await run("domain", () => this.domain.destroy());
        if (this.adapterLease) await run("activation lease", () => this.adapterLease.release());
        if (this.promptDialog) await run("prompt dialog", () => this.promptDialog.destroy());
      }
      const instanceNodes = this.instance && Array.isArray(this.instance.nodes)
        ? this.instance.nodes.slice().reverse()
        : [];
      for (const node of instanceNodes) {
        await run("workspace clone", () => {
          if (node && typeof node.remove === "function") node.remove();
          else if (node && node.parentNode && typeof node.parentNode.removeChild === "function") {
            node.parentNode.removeChild(node);
          }
        });
      }
      for (const timer of this.toastTimers) await run("toast timer", () => clearTimeout(timer));
      this.toastTimers.clear();
      if (this.announceTimer !== null) await run("announcement timer", () => clearTimeout(this.announceTimer));
      this.announceTimer = null;
      if (this.elements.toastRegion) {
        await run("toast region", () => { this.elements.toastRegion.innerHTML = ""; });
      }
      if (this.elements.screenReaderStatus) {
        await run("screen reader status", () => { this.elements.screenReaderStatus.textContent = ""; });
      }
      return true;
    })();
    return this.destroyPromise;
  }
}

// Opt-in injection profiler. Measurements stay in the bounded, redacted
// diagnostic buffer so profiling cannot leak media paths or flood UXP logs.
const oracleProfilerRestores = [];

function recordOraclePerformanceMeasurement(label, startedAt, outcome = "resolved") {
  recordOracleDiagnostic(outcome === "resolved" ? "info" : "warn", "PERFORMANCE_MEASUREMENT", {
    label: String(label || "Oracle operation"),
    elapsedMs: Math.max(0, performance.now() - Number(startedAt || performance.now())),
    outcome,
  });
}

function injectOracleProfiler(target, methodName, label) {
  if (!target || typeof target[methodName] !== "function") {
    return;
  }
  const original = target[methodName];
  const wrapped = function (...args) {
    const startedAt = performance.now();
    let result;
    try {
      result = original.apply(this, args);
    } catch (error) {
      recordOraclePerformanceMeasurement(label, startedAt, "threw");
      throw error;
    }

    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          recordOraclePerformanceMeasurement(label, startedAt, "resolved");
          return value;
        },
        (error) => {
          recordOraclePerformanceMeasurement(label, startedAt, "rejected");
          throw error;
        },
      );
    }

    recordOraclePerformanceMeasurement(label, startedAt, "resolved");
    return result;
  };

  target[methodName] = wrapped;
  oracleProfilerRestores.push(() => {
    if (target[methodName] === wrapped) {
      target[methodName] = original;
    }
  });
}

function stopOraclePerformanceProfiler(announce = true) {
  while (oracleProfilerRestores.length > 0) {
    oracleProfilerRestores.pop()();
  }
  if (announce) {
    recordOracleDiagnostic("info", "PERFORMANCE_PROFILER_STOPPED", {});
  }
}

function startOraclePerformanceProfiler() {
  stopOraclePerformanceProfiler(false);
  const controller = Reflect.get(window, ORACLE_PANEL_CONTROLLER_KEY);
  if (!controller || controller.destroyed) {
    recordOracleDiagnostic("warn", "PERFORMANCE_PROFILER_CONTROLLER_UNAVAILABLE", {});
    return false;
  }

  const methods = [
    [bridgeClient, "handleMessage", "WebSocket.handleMessage"],
    [controller, "handleBridgeMessage", "Controller.handleBridgeMessage"],
    [controller, "queueImport", "Controller.queueImport"],
    [controller.view, "render", "View.render"],
    [controller.view, "renderCards", "View.renderCards"],
    [controller.view, "prependReplay", "View.prependReplay"],
    [controller.view, "updateReplays", "View.updateReplays"],
    [controller.view, "createCard", "View.createCard"],
    [controller.view, "updateCardState", "View.updateCardState"],
    [controller.gateway, "importReplay", "Premiere.importReplay"],
    [controller.gateway, "findClipByPath", "Premiere.findClipByPath"],
    [controller.persistence, "save", "History.save"],
  ];
  for (const [target, methodName, label] of methods) {
    injectOracleProfiler(target, methodName, label);
  }

  recordOracleDiagnostic("info", "PERFORMANCE_PROFILER_STARTED", {
    instrumentedMethodCount: oracleProfilerRestores.length,
  });
  return true;
}

/** @type {any} */ (oracleWindow).startOraclePerformanceProfiler =
  startOraclePerformanceProfiler;
/** @type {any} */ (oracleWindow).stopOraclePerformanceProfiler =
  stopOraclePerformanceProfiler;

function loadLocalReplayHistory() {
  const records = [];
  for (const storageKey of [REPLAY_HISTORY_STORAGE_KEY, LEGACY_RECENT_EXPORTS_STORAGE_KEY]) {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        continue;
      }
      const saved = JSON.parse(raw);
      const values = Array.isArray(saved) ? saved : saved && Array.isArray(saved.replays) ? saved.replays : [];
      records.push(...normalizeReplayHistoryRecords(values));
    } catch (error) {
      recordOracleDiagnostic("warn", "REPLAY_HISTORY_STORAGE_RESTORE_FAILED", {
        storageKind: storageKey === REPLAY_HISTORY_STORAGE_KEY ? "current" : "legacy",
        message: oracleErrorMessage(error),
      });
    }
  }
  return mergeReplayHistory(records);
}

async function readReplayHistoryFile(url) {
  if (!uxpFs || typeof uxpFs.readFile !== "function") {
    return [];
  }
  try {
    const raw = await uxpFs.readFile(url, { encoding: "utf-8" });
    const saved = JSON.parse(String(raw || ""));
    const values = Array.isArray(saved) ? saved : saved && Array.isArray(saved.replays) ? saved.replays : [];
    return normalizeReplayHistoryRecords(values);
  } catch (error) {
    if (!isMissingFileError(error)) {
      recordOracleDiagnostic("warn", "REPLAY_HISTORY_FILE_READ_FAILED", {
        historyKind: url === REPLAY_HISTORY_FILE_URL ? "primary" : "backup",
        message: oracleErrorMessage(error),
      });
    }
    return [];
  }
}

function normalizeReplayHistoryRecords(values) {
  return values
    .map((item) =>
      normalizeReplayPayload({
        event: "render_complete",
        id: item && item.id,
        title: item && (item.title || item.name),
        filepath: item && (item.filepath || item.absolutePath),
        thumbnail: item && (item.thumbnail || item.thumbnailPath),
        thumbnailBase64: item && item.thumbnailBase64,
        thumbnailDataUrl: item && item.thumbnailDataUrl,
        thumbnailError: item && item.thumbnailError,
        completedAt: item && (item.completedAt || item.timestamp),
        durationSeconds: item && item.durationSeconds,
        duration: item && item.duration,
        resolution: item && item.resolution,
        width: item && item.width,
        height: item && item.height,
        fps: item && item.fps,
        frameRate: item && item.frameRate,
        timecode: item && item.timecode,
        sourceTimecode: item && item.sourceTimecode,
      }),
    )
    .filter((item) => isReplayPayload(item) && isAbsoluteLocalPath(item.filepath));
}

function normalizeReplayPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const nested =
    source.payload && typeof source.payload === "object"
      ? source.payload
      : source.data && typeof source.data === "object"
        ? source.data
        : source.export && typeof source.export === "object"
          ? source.export
          : source.render && typeof source.render === "object"
            ? source.render
            : {};
  const flattened = Object.assign({}, source, nested);
  const filepath = String(
    flattened.absolutePath ||
      flattened.absolute_path ||
      flattened.filePath ||
      flattened.filepath ||
      flattened.file_path ||
      flattened.outputPath ||
      flattened.output_path ||
      flattened.outputFile ||
      "",
  ).trim();
  const normalized = Object.assign({}, flattened, {
    event: "render_complete",
    id: String(
      flattened.id ||
        flattened.eventId ||
        flattened.event_id ||
        flattened.exportId ||
        flattened.export_id ||
        "",
    ).trim(),
    filePath: filepath,
    filepath,
    completedAt:
      flattened.completedAt ||
      flattened.timestamp ||
      flattened.receivedAt ||
      new Date().toISOString(),
    thumbnailBase64:
      typeof flattened.thumbnailBase64 === "string"
        ? flattened.thumbnailBase64
        : typeof flattened.thumbnail_base64 === "string"
          ? flattened.thumbnail_base64
          : "",
  });

  if (typeof normalized.title !== "string" || !normalized.title.trim()) {
    normalized.title =
      typeof normalized.name === "string" && normalized.name.trim()
        ? normalized.name.trim()
        : typeof normalized.fileName === "string" && normalized.fileName.trim()
          ? normalized.fileName.replace(/\.[^.]+$/, "")
          : replayTitleFromFilepath(filepath);
  }

  return normalized;
}

function replayMessageHasFilepath(message) {
  const source = message && typeof message === "object" ? message : {};
  const nested =
    source.payload && typeof source.payload === "object"
      ? source.payload
      : source.data && typeof source.data === "object"
        ? source.data
        : source;
  return Boolean(
    source.absolutePath ||
      source.filePath ||
      source.filepath ||
      source.outputPath ||
      nested.absolutePath ||
      nested.filePath ||
      nested.filepath ||
      nested.outputPath,
  );
}

function normalizeImportClipPayload(message) {
  const source = message && typeof message === "object" ? message : {};
  const nested =
    source.payload && typeof source.payload === "object"
      ? source.payload
      : source.data && typeof source.data === "object"
        ? source.data
        : {};
  const absolutePath = String(
    source.absolutePath ||
      source.absolute_path ||
      source.filePath ||
      source.filepath ||
      nested.absolutePath ||
      nested.absolute_path ||
      nested.filePath ||
      nested.filepath ||
      "",
  ).trim();
  const normalized = normalizeReplayPayload(
    Object.assign({}, source, nested, {
      event: "render_complete",
      sourceEvent: "IMPORT_CLIP",
      absolutePath,
      filepath: absolutePath,
      completedAt:
        source.completedAt ||
        source.timestamp ||
        nested.completedAt ||
        nested.timestamp ||
        source.receivedAt ||
        nested.receivedAt ||
        new Date().toISOString(),
    }),
  );

  if (!isAbsoluteLocalPath(normalized.filepath)) {
    normalized.filepath = "";
    normalized.filePath = "";
  }
  return normalized;
}

function messageEventName(message) {
  return String(
    (message && (message.event || message.type || message.action)) || "",
  )
    .trim()
    .toUpperCase();
}

function replayTitleFromFilepath(filepath) {
  const filename = String(filepath || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  const withoutExtension = String(filename || "").replace(/\.[^.]+$/, "");
  return cleanTitle(withoutExtension.replace(/[_-]+/g, " "));
}

function replayParentPath(filepath) {
  const normalized = String(filepath || "").trim().replace(/\//g, "\\");
  const separator = normalized.lastIndexOf("\\");
  if (separator <= 1) return "";
  return normalized.slice(0, separator);
}

function normalizeNativeWatchRoot(path) {
  const normalized = nativeWindowsFilePath(path).replace(/[\\/]+$/g, "");
  if (
    !normalized ||
    !isAbsoluteLocalPath(normalized) ||
    /^[a-z]:$/i.test(normalized) ||
    /^\\\\[^\\]+\\[^\\]+$/i.test(normalized)
  ) return "";
  return normalized;
}

function nativeWatchRootCoversDirectory(root, directory) {
  const rootKey = pathKey(root && root.path);
  const directoryKey = pathKey(directory);
  if (!rootKey || !directoryKey) return false;
  return directoryKey === rootKey || (root.recursive === true && directoryKey.startsWith(`${rootKey}/`));
}

function nativeWatchRootCoversFile(root, absolutePath) {
  return nativeWatchRootCoversDirectory(root, replayParentPath(absolutePath));
}

function mergeNativeWatchRootCandidates(candidates, limit = NATIVE_DIRECTORY_WATCH_MAX_ROOTS) {
  const accepted = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const candidate = {
      path: normalizeNativeWatchRoot(raw && raw.path),
      recursive: Boolean(raw && raw.recursive),
    };
    if (!candidate.path) continue;
    const exact = accepted.find((root) => pathKey(root.path) === pathKey(candidate.path));
    if (exact) {
      if (candidate.recursive && !exact.recursive) {
        exact.recursive = true;
        for (let index = accepted.length - 1; index >= 0; index -= 1) {
          if (accepted[index] !== exact && nativeWatchRootCoversDirectory(exact, accepted[index].path)) {
            accepted.splice(index, 1);
          }
        }
      }
      continue;
    }
    if (accepted.some((root) => nativeWatchRootCoversDirectory(root, candidate.path))) continue;
    if (candidate.recursive) {
      for (let index = accepted.length - 1; index >= 0; index -= 1) {
        if (nativeWatchRootCoversDirectory(candidate, accepted[index].path)) accepted.splice(index, 1);
      }
    }
    accepted.push(candidate);
    if (accepted.length >= Math.max(1, Number(limit) || NATIVE_DIRECTORY_WATCH_MAX_ROOTS)) break;
  }
  return accepted;
}

function nativeConfiguredWatchRootSignature(preferences) {
  const replay = preferences && preferences.replay ? preferences.replay : {};
  const roots = [
    ...(Array.isArray(replay.roots) ? replay.roots : []),
    ...(Array.isArray(replay.relinkRoots) ? replay.relinkRoots : []),
  ].map((path) => pathKey(normalizeNativeWatchRoot(path))).filter(Boolean);
  return JSON.stringify(roots);
}

function isReplayPayload(payload) {
  return Boolean(
    payload &&
      payload.event === "render_complete" &&
      typeof payload.title === "string" &&
      payload.title.trim() &&
      typeof payload.filepath === "string" &&
      payload.filepath.trim() &&
      isAbsoluteLocalPath(payload.filepath),
  );
}

function cleanTitle(title) {
  const clean = String(title || "Untitled Replay").trim();
  return clean.slice(0, 240) || "Untitled Replay";
}

function replayIdentityKey(replay) {
  const id = String((replay && replay.id) || "").trim();
  if (id) {
    return `id:${id}`;
  }
  return stableReplayId(
    replay && (replay.filepath || replay.absolutePath),
    replay && (replay.completedAt || replay.timestamp),
  );
}

function stableReplayId(filepath, completedAt) {
  return `replay:${pathKey(filepath)}:${normalizeCompletedAt(completedAt)}`;
}

function isSameReplayExport(left, right) {
  if (!left || !right) {
    return false;
  }
  if (replayIdentityKey(left) === replayIdentityKey(right)) {
    return true;
  }
  const filepath = pathKey(left.filepath || left.absolutePath);
  if (!filepath || filepath !== pathKey(right.filepath || right.absolutePath)) {
    return false;
  }
  const leftTimestamp = replayTimestamp(left);
  const rightTimestamp = replayTimestamp(right);
  return (
    leftTimestamp > 0 &&
    rightTimestamp > 0 &&
    Math.abs(leftTimestamp - rightTimestamp) <= REPLAY_DUPLICATE_WINDOW_MS
  );
}

function mergeReplayHistory(...recordSets) {
  const merged = [];
  const seen = new Set();
  for (const records of recordSets) {
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || !isReplayPayload(record)) {
        continue;
      }
      const identity = replayIdentityKey(record);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      merged.push(record);
    }
  }
  merged.sort((left, right) => replayTimestamp(right) - replayTimestamp(left));
  return merged;
}

function normalizeCompletedAt(value) {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function replayTimestamp(replay) {
  const parsed = new Date((replay && replay.completedAt) || "");
  const timestamp = parsed.getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeDurationSeconds(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.durationSeconds !== null && payload.durationSeconds !== undefined && payload.durationSeconds !== "" && Number.isFinite(Number(payload.durationSeconds))) {
    return Math.max(0, Number(payload.durationSeconds));
  }
  if (payload.durationMs !== null && payload.durationMs !== undefined && payload.durationMs !== "" && Number.isFinite(Number(payload.durationMs))) {
    return Math.max(0, Number(payload.durationMs) / 1000);
  }
  const duration = payload.duration;
  if (duration !== null && duration !== undefined && duration !== "" && Number.isFinite(Number(duration))) {
    return Math.max(0, Number(duration));
  }
  if (typeof duration === "string" && duration.includes(":")) {
    const parts = duration.split(":").map((part) => Number(part));
    if (parts.length <= 3 && parts.every((part) => Number.isFinite(part) && part >= 0)) {
      return parts.reduce((total, part) => total * 60 + part, 0);
    }
  }
  return null;
}

function normalizeReplayResolution(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const resolution = payload.resolution;
  if (typeof resolution === "string" && resolution.trim()) {
    return resolution.trim().replace(/\s*[xX]\s*/g, " × ");
  }
  const resolutionObject = resolution && typeof resolution === "object" ? resolution : {};
  const width = Number(
    payload.width ||
      payload.videoWidth ||
      payload.renderWidth ||
      payload.resolutionWidth ||
      resolutionObject.width,
  );
  const height = Number(
    payload.height ||
      payload.videoHeight ||
      payload.renderHeight ||
      payload.resolutionHeight ||
      resolutionObject.height,
  );
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? `${Math.round(width)} × ${Math.round(height)}`
    : "";
}

function normalizeReplayFps(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const value =
    payload.fps ??
    payload.frameRate ??
    payload.framerate ??
    payload.framesPerSecond ??
    payload.frame_rate;
  const fps = Number(value);
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function normalizeReplayTimecode(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const value =
    payload.timecode ??
    payload.sourceTimecode ??
    payload.startTimecode ??
    payload.timecodeStart ??
    payload.source_timecode ??
    payload.start_timecode;
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

function formatReplayTimecode(replay) {
  const api = oracleWindow.OracleReplayLibrary;
  const durationMs = replay && replay.durationMs !== undefined && replay.durationMs !== null
    ? Number(replay.durationMs)
    : (() => {
        const seconds = normalizeDurationSeconds(replay);
        return seconds === null ? null : seconds * 1000;
      })();
  if (api && typeof api.formatReplayDuration === "function") {
    return api.formatReplayDuration(durationMs);
  }
  return durationMs === null || !Number.isFinite(durationMs)
    ? "--"
    : `${Number(Math.max(0, durationMs / 1000).toFixed(2))}s`;
}

function formatReplayTimestamp(value) {
  const parsed = new Date(value || "");
  if (!Number.isFinite(parsed.getTime())) {
    return "Unknown date";
  }
  try {
    const replayPreferences = oracleWindow.oracleWorkspacePreferences &&
      oracleWindow.oracleWorkspacePreferences.replay
      ? oracleWindow.oracleWorkspacePreferences.replay
      : {};
    const dateFormat = replayPreferences.dateFormat || "system";
    const timeFormat = replayPreferences.timeFormat || "system";
    const date = dateFormat === "iso"
      ? parsed.toISOString().slice(0, 10)
      : parsed.toLocaleDateString([], dateFormat === "long"
        ? { year: "numeric", month: "long", day: "numeric" }
        : dateFormat === "short"
          ? { year: "2-digit", month: "numeric", day: "numeric" }
          : { year: "numeric", month: "short", day: "numeric" });
    const time = parsed.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      ...(timeFormat === "12" ? { hour12: true } : timeFormat === "24" ? { hour12: false } : {}),
    });
    return `${date}, ${time}`;
  } catch (error) {
    return parsed.toLocaleString();
  }
}

function replayThumbnailSource(replay) {
  const thumbnailBase64 = String((replay && replay.thumbnailBase64) || "")
    .trim()
    .replace(/\s+/g, "");
  if (thumbnailBase64) {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(thumbnailBase64)) {
      return thumbnailBase64;
    }
    return `data:${thumbnailMimeTypeFromBase64(thumbnailBase64)};base64,${thumbnailBase64}`;
  }
  const dataUrl = String((replay && replay.thumbnailDataUrl) || "");
  if (dataUrl.startsWith("data:image/")) {
    return dataUrl;
  }
  const thumbnail = String((replay && replay.thumbnail) || "").trim();
  if (!thumbnail) {
    return "";
  }
  if (/^(?:data:image\/|plugin:|plugin-data:|file:)/i.test(thumbnail)) {
    return thumbnail;
  }
  const normalized = thumbnail.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return encodeURI(`file:///${normalized}`);
  }
  if (normalized.startsWith("/")) {
    return encodeURI(`file://${normalized}`);
  }
  return "";
}

function thumbnailMimeTypeFromBase64(base64) {
  if (base64.startsWith("iVBORw0KGgo")) {
    return "image/png";
  }
  if (base64.startsWith("R0lGOD")) {
    return "image/gif";
  }
  if (base64.startsWith("UklGR")) {
    return "image/webp";
  }
  return "image/jpeg";
}

function isMissingFileError(error) {
  const text = `${(error && error.code) || ""} ${(error && error.message) || error || ""}`;
  return /ENOENT|not\s+found|does\s+not\s+exist|no\s+such\s+file/i.test(text);
}

function loadThemePreferences() {
  try {
    const raw = window.localStorage.getItem(THEME_PREFERENCES_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return {
      outlineColor: normalizeHexColor(saved.outlineColor, DEFAULT_OUTLINE_COLOR),
      backgroundColor: normalizeHexColor(saved.backgroundColor, DEFAULT_BACKGROUND_COLOR),
    };
  } catch (error) {
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("warn", "APPEARANCE_PREFERENCES_RESTORE_FAILED", {
        message: typeof oracleErrorMessage === "function"
          ? oracleErrorMessage(error)
          : "Appearance preferences could not be restored.",
      });
    }
    return {
      outlineColor: DEFAULT_OUTLINE_COLOR,
      backgroundColor: DEFAULT_BACKGROUND_COLOR,
    };
  }
}

function persistThemePreferences(values) {
  try {
    window.localStorage.setItem(THEME_PREFERENCES_STORAGE_KEY, JSON.stringify(values));
  } catch (error) {
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("warn", "APPEARANCE_PREFERENCES_PERSIST_FAILED", {
        message: typeof oracleErrorMessage === "function"
          ? oracleErrorMessage(error)
          : "Appearance preferences could not be persisted.",
      });
    }
  }
}

function normalizeHexColor(value, fallback) {
  const text = String(value || "").trim();
  const prefixed = text.startsWith("#") ? text : `#${text}`;
  if (/^#[0-9a-fA-F]{6}$/.test(prefixed)) {
    return prefixed.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(prefixed)) {
    return `#${prefixed[1]}${prefixed[1]}${prefixed[2]}${prefixed[2]}${prefixed[3]}${prefixed[3]}`.toUpperCase();
  }
  return fallback;
}

function hexColorRgb(value) {
  const normalized = normalizeHexColor(value, DEFAULT_OUTLINE_COLOR);
  return [1, 3, 5]
    .map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16))
    .join(", ");
}

function formatRetryDelay(milliseconds) {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  const seconds = milliseconds / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function yieldToHost() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function statusLabel(replay) {
  if (replay.statusMessage) {
    return replay.statusMessage;
  }
  if (replay.status === "ready") {
    return "Ready in Premiere";
  }
  if (replay.status === "error") {
    return "Import failed";
  }
  return "Drag ready";
}

function replayCardSignature(replay) {
  const thumbnail = String(
    replay.thumbnailBase64 || replay.thumbnailDataUrl || replay.thumbnail || "",
  );
  const thumbnailFingerprint = thumbnail
    ? `${thumbnail.length}:${thumbnail.slice(-32)}`
    : "none";
  return [
    replay.title,
    replay.status,
    statusLabel(replay),
    replay.thumbnailError || "",
    thumbnailFingerprint,
    replay.completedAt || "",
    String(replay.durationSeconds ?? ""),
    replay.resolution || "",
    String(replay.fps ?? ""),
    replay.timecode || "",
    replay.projectItemId || "",
    replay.isNew ? "new" : "stable",
  ].join("\u0001");
}

function createThumbnailFallback(reason) {
  const fallback = document.createElement("div");
  fallback.className = "replay-thumbnail__fallback";
  const icon = document.createElement("span");
  icon.className = "replay-thumbnail__icon";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = reason || "Thumbnail unavailable";
  fallback.append(icon, label);
  return fallback;
}

function createReplayIndicator(label, kind) {
  const indicator = document.createElement("span");
  indicator.className = `replay-indicator replay-indicator--${kind}`;
  indicator.textContent = label;
  indicator.title = label;
  return indicator;
}

function normalizeReplayPath(path) {
  return typeof path === "string" ? path.trim() : "";
}

function nativeWindowsFilePath(path) {
  const normalized = normalizeReplayPath(path);
  return (/^[A-Za-z]:[\\/]/.test(normalized) || /^[/\\]{2}/.test(normalized))
    ? normalized.replace(/\//g, "\\")
    : normalized;
}

function getReplayCanonicalMediaPath(replay, logDetails = false) {
  const record = replay && typeof replay === "object" ? replay : {};
  const availablePathProperties = Object.keys(record).filter((key) => /path|file/i.test(key));
  const canonicalPath = normalizeReplayPath(record.filepath);
  if (NATIVE_DRAG_DEBUG && logDetails) {
    console.log("[Oracle Native Drag][Path Resolution]", {
      replayId: String(record.id || ""),
      availablePathProperties,
      canonicalPathPresent: Boolean(canonicalPath),
    });
  }
  if (!canonicalPath || !isAbsoluteLocalPath(canonicalPath)) {
    throw new UserFacingError(
      "Replay record does not contain a usable absolute media path",
      false,
      "NO_REPLAY_PATH",
      { replayId: String(record.id || ""), availablePathProperties },
    );
  }
  return canonicalPath;
}

function replayHasCanonicalMediaPath(replay) {
  try {
    getReplayCanonicalMediaPath(replay);
    return true;
  } catch (error) {
    return false;
  }
}

function isReadyReplay(replay) {
  return replayHasCanonicalMediaPath(replay);
}

function inspectReplayFileExistsSync(canonicalPath) {
  try {
    if (uxpFs && typeof uxpFs.existsSync === "function") {
      return Boolean(uxpFs.existsSync(canonicalPath));
    }
    if (uxpFs && typeof uxpFs.lstatSync === "function") {
      const stats = uxpFs.lstatSync(canonicalPath);
      return Boolean(!stats || typeof stats.isFile !== "function" || stats.isFile());
    }
  } catch (error) {
    return false;
  }
  return "unchecked-synchronously";
}

function isInteractiveCardTarget(target) {
  if (!target || typeof target.closest !== "function") {
    return false;
  }
  return Boolean(
    target.closest(
      "button, a, input, select, textarea, option, label, [contenteditable='true'], [role='menuitem'], [role='checkbox'], [role='switch']",
    ),
  );
}

function closestReplayCard(target, grid) {
  if (!target || typeof target.closest !== "function") {
    return null;
  }
  const card = target.closest(".replay-card");
  if (!card || (grid && typeof grid.contains === "function" && !grid.contains(card))) {
    return null;
  }
  return card;
}

function nativeDragError(errorCode, errorMessage, details = {}) {
  return {
    ok: false,
    dropped: false,
    cancelled: false,
    effect: 0,
    hresult: -1,
    errorCode,
    errorMessage,
    nativeDispatchMs: 0,
    totalElapsedMs: 0,
    details,
  };
}

function normalizeNativeDragResult(result, totalElapsedMs) {
  const source = result && typeof result === "object"
    ? Object.assign({}, result)
    : nativeDragError("NATIVE_DRAG_FAILED", "The native addon returned an invalid drag result.");
  const nativeErrorCode = String(source.errorCode || "");
  source.totalElapsedMs = Number(totalElapsedMs) || 0;
  source.nativeDispatchMs = Number(source.nativeDispatchMs) || 0;
  if (source.ok && source.dropped) {
    source.errorCode = "";
    return source;
  }
  if (source.ok && source.cancelled) {
    source.errorCode = nativeErrorCode || "NATIVE_DRAG_CANCELLED";
    return source;
  }
  source.details = Object.assign({}, source.details, { nativeErrorCode });
  source.errorCode = nativeErrorCode === "FILE_NOT_FOUND"
    ? "REPLAY_FILE_NOT_FOUND"
    : "NATIVE_DRAG_FAILED";
  return source;
}

function pathKey(filepath) {
  return String(filepath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .toLocaleLowerCase();
}

function tickTimeTicks(time) {
  if (time && typeof time === "object") {
    const value = time.ticks ?? time.tickCount ?? time.value;
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }
  return time === undefined || time === null ? "" : String(time);
}

function defaultExportDirectory() {
  if (!uxpOs || typeof uxpOs.homedir !== "function") {
    return "";
  }
  try {
    const home = normalizeLocalDirectory(uxpOs.homedir());
    return home ? `${home}/Downloads` : "";
  } catch (error) {
    return "";
  }
}

function normalizeLocalDirectory(directory) {
  const normalized = String(directory || "").trim().replace(/\\/g, "/");
  if (!isAbsoluteLocalPath(normalized)) {
    return "";
  }
  return normalized.replace(/\/+$/g, "");
}

function parentLocalDirectory(filepath) {
  const normalized = String(filepath || "").trim().replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalizeLocalDirectory(normalized.slice(0, separator)) : "";
}

function localBasename(filepath) {
  const normalized = String(filepath || "").trim().replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function resolveDirectoryEntryPath(directory, entry) {
  const value = String(entry || "").trim();
  if (isAbsoluteLocalPath(value)) {
    return value.replace(/\\/g, "/");
  }
  return `${normalizeLocalDirectory(directory)}/${value.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function isSupportedReplayVideo(filename) {
  return /\.(?:mov|mp4|m4v|mkv|avi|webm)$/i.test(String(filename || ""));
}

function fileModifiedAt(stats) {
  const milliseconds = Number(stats && stats.mtimeMs);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return milliseconds;
  }
  const modified = stats && stats.mtime;
  if (modified && typeof modified.getTime === "function") {
    const value = modified.getTime();
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = new Date(modified || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function siblingThumbnailPath(directory, videoFilename, entries) {
  const base = String(videoFilename || "").replace(/\.[^.]+$/, "").toLocaleLowerCase();
  const candidates = new Set([
    base,
    `${base}-thumbnail`,
    `${base}_thumbnail`,
    `${base}.thumbnail`,
  ]);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = localBasename(entry);
    const match = /^(.*)\.(png|jpe?g|webp|gif)$/i.exec(name);
    if (match && candidates.has(match[1].toLocaleLowerCase())) {
      return resolveDirectoryEntryPath(directory, entry);
    }
  }
  return "";
}

function validateImportFilePath(filepath) {
  const importPath = formatImportPath(filepath);
  if (!importPath || !isAbsoluteLocalPath(importPath)) {
    throw new UserFacingError(
      "Oracle import requires an absolute local file path",
      false,
      "NO_REPLAY_PATH",
      { filepath: String(filepath || "") },
    );
  }
  return importPath;
}

function formatImportPath(filepath) {
  const value = String(filepath || "").trim();
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]/.test(value);
  return isWindowsPath ? value.replace(/\//g, "\\") : value;
}

function isSafeWindowsPathSegment(segment) {
  if (!segment || segment === "." || segment === ".." || /[:\u0000-\u001f]/.test(segment)) {
    return false;
  }
  if (/[. ]$/.test(segment)) {
    return false;
  }
  const basename = segment.split(".")[0].toLocaleUpperCase("en-US");
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(basename);
}

function isAbsoluteLocalPath(filepath) {
  const value = String(filepath || "").trim().replace(/\//g, "\\");
  if (!value || /[\u0000-\u001f]/.test(value)) {
    return false;
  }

  let segments = null;
  let minimumSegments = 0;
  if (/^\\\\\?\\UNC\\/i.test(value)) {
    segments = value.slice(8).split("\\");
    minimumSegments = 2;
  } else if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) {
    segments = value.slice(7).split("\\");
  } else if (/^[A-Za-z]:\\/.test(value)) {
    segments = value.slice(3).split("\\");
  } else if (/^\\\\(?![.?]\\)/.test(value)) {
    segments = value.slice(2).split("\\");
    minimumSegments = 2;
  } else {
    return false;
  }

  while (segments.length > 0 && segments[segments.length - 1] === "") {
    segments.pop();
  }
  if (segments.length < minimumSegments) return false;
  return segments.every(isSafeWindowsPathSegment);
}

function normalizeError(error) {
  if (error instanceof UserFacingError) {
    return error;
  }
  if (typeof recordOracleDiagnostic === "function") {
    recordOracleDiagnostic("error", error && error.code || "ORACLE_OPERATION_FAILED", {
      message: typeof oracleErrorMessage === "function"
        ? oracleErrorMessage(error)
        : "An unexpected Oracle operation failed.",
    });
  }
  return new UserFacingError(
    error && error.message ? error.message : "Unexpected Oracle error",
    false,
    error && error.code ? String(error.code) : "ORACLE_OPERATION_FAILED",
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyMinecraftFont(packagedFonts) {
  const families = [
    "Minecraft",
    "Minecraft Five v2",
    "Minecraft Ten v2",
  ];
  const registeredFamilies = new Set(
    packagedFonts && Array.isArray(packagedFonts.items)
      ? packagedFonts.items
          .filter((item) => item && item.registered === true)
          .map((item) => String(item.familyName || ""))
      : [],
  );
  const registrationReady = Boolean(
    packagedFonts &&
    packagedFonts.ok === true &&
    packagedFonts.processPrivate === true &&
    packagedFonts.sessionVisible === false &&
    packagedFonts.registrationFlags === "FR_PRIVATE" &&
    packagedFonts.registeredFileCount === families.length &&
    families.every((family) => registeredFamilies.has(family)),
  );
  const results = [];
  for (const family of families) {
    const renderProbe = await measureFontRendering(family);
    results.push({
      family,
      registered: registeredFamilies.has(family),
      rendered: renderProbe.rendered,
      minecraftWidth: renderProbe.minecraftWidth,
      fallbackWidth: renderProbe.fallbackWidth,
    });
  }
  const failed = results.filter((result) => !result.registered || !result.rendered);
  document.documentElement.classList.remove(
    "oracle-fonts-ready",
    "oracle-fonts-installed-compatible",
  );
  if (registrationReady && failed.length === 0) {
    document.documentElement.classList.add("oracle-fonts-ready");
    document.documentElement.dataset.oracleFontState = "packaged";
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("info", "PACKAGED_FONTS_RENDERED", {
        familyCount: results.length,
      });
    }
    return "packaged";
  }

  // Adobe UXP 9.3 does not implement @font-face and its internal CSS renderer
  // does not consume process-private GDI font resources. A user may still have
  // the licensed families installed. Probe that exact compatibility set before
  // retaining Oracle's readable host-font tokens.
  const installedTen = await measureFontRendering("Minecraft Ten");
  const installedCompatibilityReady =
    results[0].rendered &&
    results[1].rendered &&
    installedTen.rendered;
  if (installedCompatibilityReady) {
    document.documentElement.classList.add("oracle-fonts-installed-compatible");
    document.documentElement.dataset.oracleFontState = "installed-compatible";
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("warn", "INSTALLED_COMPATIBILITY_FALLBACK", {
        registrationReady,
        unavailablePackagedFamilyCount: failed.length,
        installedHeadingFamily: "Minecraft Ten",
      });
    }
    return "installed-compatible";
  }

  document.documentElement.dataset.oracleFontState = "host-fallback";
  if (typeof recordOracleDiagnostic === "function") {
    recordOracleDiagnostic("warn", "HOST_RENDERER_FALLBACK", {
      registrationReady,
      unavailablePackagedFamilyCount: failed.length,
      probedFamilyCount: results.length,
    });
  }
  return "host-fallback";
}

async function measureMinecraftRendering() {
  return measureFontRendering("Minecraft");
}

async function measureFontRendering(fontFamily) {
  if (!document.body || typeof document.createElement !== "function") {
    return { rendered: false, minecraftWidth: 0, fallbackWidth: 0 };
  }

  const sample = "@@@@@@@@@@ MWmw0123456789 4.5s Grid 3";
  const minecraftProbe = document.createElement("span");
  const fallbackProbe = document.createElement("span");
  for (const probe of [minecraftProbe, fallbackProbe]) {
    probe.textContent = sample;
    probe.setAttribute("aria-hidden", "true");
    // Premiere's UXP DOM reports zero geometry for probes measured in the
    // same turn or placed outside the panel. Keep them transparent and out of
    // normal flow, then allow the local face request and layout to settle.
    probe.style.position = "absolute";
    probe.style.left = "0";
    probe.style.top = "0";
    probe.style.display = "block";
    probe.style.width = "max-content";
    probe.style.height = "auto";
    probe.style.fontSize = "32px";
    probe.style.fontWeight = "400";
    probe.style.whiteSpace = "nowrap";
    probe.style.opacity = "0.001";
    probe.style.pointerEvents = "none";
    probe.style.zIndex = "-1";
    document.body.appendChild(probe);
  }
  minecraftProbe.style.fontFamily = `"${fontFamily}"`;
  fallbackProbe.style.fontFamily = `"Oracle Host Fallback ${Date.now()}"`;

  let minecraftWidth = 0;
  let fallbackWidth = 0;
  let attempts = 0;
  try {
    for (attempts = 1; attempts <= 4; attempts += 1) {
      await delay(100);
      const minecraftRectWidth = minecraftProbe.getBoundingClientRect().width;
      const fallbackRectWidth = fallbackProbe.getBoundingClientRect().width;
      minecraftWidth = Math.max(minecraftRectWidth, minecraftProbe.scrollWidth || 0);
      fallbackWidth = Math.max(fallbackRectWidth, fallbackProbe.scrollWidth || 0);
      if (
        Number.isFinite(minecraftWidth) &&
        minecraftWidth > 0 &&
        Number.isFinite(fallbackWidth) &&
        fallbackWidth > 0 &&
        Math.abs(minecraftWidth - fallbackWidth) >= 0.5
      ) {
        break;
      }
    }
  } finally {
    minecraftProbe.remove();
    fallbackProbe.remove();
  }
  return {
    rendered:
      Number.isFinite(minecraftWidth) &&
      minecraftWidth > 0 &&
      Number.isFinite(fallbackWidth) &&
      fallbackWidth > 0 &&
      Math.abs(minecraftWidth - fallbackWidth) >= 0.5,
    minecraftWidth,
    fallbackWidth,
    attempts,
  };
}

function setOracleStartupState(state, error = null) {
  const element = document.getElementById("oracleStartupState");
  if (!element) return;
  if (state === "ready") {
    element.hidden = true;
    element.dataset.state = "ready";
    return;
  }
  const failed = state === "error";
  const title = element.querySelector("[data-oracle-startup-title]");
  const message = element.querySelector("[data-oracle-startup-message]");
  element.hidden = false;
  element.dataset.state = failed ? "error" : "loading";
  element.setAttribute("role", failed ? "alert" : "status");
  if (title) title.textContent = failed ? "Oracle could not start" : "Loading cinematic tools";
  if (message) {
    const detail = error && error.message ? String(error.message).trim().slice(0, 500) : "";
    message.textContent = failed
      ? `${detail || "The workspace bootstrap failed."} Reload Oracle in UDT after checking the first UXP Console exception.`
      : "Connecting the replay library, native file services, and Premiere workspace.";
  }
}

async function retireExistingOraclePanelControllers() {
  const candidates = new Set([
    Reflect.get(window, ORACLE_PANEL_CONTROLLER_KEY),
    Reflect.get(document.documentElement, ORACLE_PANEL_CONTROLLER_KEY),
  ]);
  const teardownPromises = new Set();
  const waitUntil = (value) => {
    if (value && typeof value.then === "function") teardownPromises.add(Promise.resolve(value));
  };
  try {
    const retirementEvent = new Event(ORACLE_RUNTIME_REPLACE_EVENT);
    Object.defineProperty(retirementEvent, "waitUntil", {
      configurable: true,
      value: waitUntil,
    });
    document.dispatchEvent(retirementEvent);
  } catch (error) {
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("warn", "RUNTIME_REPLACEMENT_EVENT_FAILED", {
        message: typeof oracleErrorMessage === "function" ? oracleErrorMessage(error) : "Runtime replacement event failed.",
      });
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.destroy !== "function") continue;
    try {
      waitUntil(candidate.destroy());
    } catch (error) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "PREVIOUS_CONTROLLER_TEARDOWN_FAILED", {
          phase: "dispatch",
          message: typeof oracleErrorMessage === "function" ? oracleErrorMessage(error) : "Previous controller teardown failed.",
        });
      }
    }
  }
  for (const teardown of teardownPromises) {
    try {
      await teardown;
    } catch (error) {
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "PREVIOUS_CONTROLLER_TEARDOWN_FAILED", {
          phase: "await",
          message: typeof oracleErrorMessage === "function" ? oracleErrorMessage(error) : "Previous controller teardown failed.",
        });
      }
    }
  }
  return true;
}

function isCurrentOraclePanelBootstrap(bootstrapState) {
  return !bootstrapState || (
    bootstrapState.cancelled !== true &&
    Reflect.get(window, ORACLE_PANEL_BOOTSTRAP_KEY) === bootstrapState
  );
}

async function destroyOracleBootstrapController(controller) {
  if (!controller || typeof controller.destroy !== "function") return false;
  try {
    await controller.destroy();
    return true;
  } catch (error) {
    if (typeof recordOracleDiagnostic === "function") {
      recordOracleDiagnostic("warn", "SUPERSEDED_BOOTSTRAP_TEARDOWN_FAILED", {
        message: typeof oracleErrorMessage === "function" ? oracleErrorMessage(error) : "Superseded bootstrap teardown failed.",
      });
    }
    return false;
  }
}

function retireOraclePanelBootstrap(bootstrapState) {
  if (!bootstrapState || typeof bootstrapState !== "object") return Promise.resolve(false);
  if (bootstrapState.retirementPromise) return bootstrapState.retirementPromise;
  bootstrapState.cancelled = true;
  if (bootstrapState.listener && typeof window.removeEventListener === "function") {
    window.removeEventListener("load", bootstrapState.listener);
    bootstrapState.listener = null;
  }
  bootstrapState.retirementPromise = (async () => {
    if (bootstrapState.promise && typeof bootstrapState.promise.then === "function") {
      try {
        await bootstrapState.promise;
      } catch (error) {
        if (typeof recordOracleDiagnostic === "function") {
          recordOracleDiagnostic("warn", "SUPERSEDED_BOOTSTRAP_REJECTED", {
            message: typeof oracleErrorMessage === "function" ? oracleErrorMessage(error) : "Superseded bootstrap rejected during retirement.",
          });
        }
      }
    }
    await destroyOracleBootstrapController(bootstrapState.controller);
    return true;
  })();
  return bootstrapState.retirementPromise;
}

async function initializeOraclePanel(bootstrapState = null) {
  let controller = null;
  try {
    if (!isCurrentOraclePanelBootstrap(bootstrapState)) return;
    setOracleStartupState("loading");
    const nativeLoadResult = await nativeDragAddonLoadPromise;
    if (!isCurrentOraclePanelBootstrap(bootstrapState)) return;
    try {
      await verifyMinecraftFont(
        nativeLoadResult && nativeLoadResult.diagnostic
          ? nativeLoadResult.diagnostic.packagedFonts
          : null,
      );
    } catch (fontError) {
      document.documentElement.classList.remove(
        "oracle-fonts-ready",
        "oracle-fonts-installed-compatible",
      );
      document.documentElement.dataset.oracleFontState = "host-fallback";
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("warn", "FONT_VERIFIER_UNAVAILABLE", {
          message: typeof oracleErrorMessage === "function"
            ? oracleErrorMessage(fontError, "Packaged font verification was unavailable.")
            : "Packaged font verification was unavailable.",
        });
      } else if (typeof console !== "undefined" && console && typeof console.warn === "function") {
        console.warn("[Oracle][FONT_VERIFIER_UNAVAILABLE] Packaged font verification was unavailable.");
      }
    }
    if (!isCurrentOraclePanelBootstrap(bootstrapState)) return;
    await retireExistingOraclePanelControllers();
    if (!isCurrentOraclePanelBootstrap(bootstrapState)) return;
    controller = new OraclePanelController();
    if (bootstrapState) bootstrapState.controller = controller;
    Reflect.set(window, ORACLE_PANEL_CONTROLLER_KEY, controller);
    Reflect.set(document.documentElement, ORACLE_PANEL_CONTROLLER_KEY, controller);
    await controller.start();
    if (!isCurrentOraclePanelBootstrap(bootstrapState)) {
      await destroyOracleBootstrapController(controller);
      return;
    }
    setOracleStartupState("ready");
    if (typeof recordOracleDiagnostic === "function") {
      const currentTime = typeof performance !== "undefined" && performance && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
      recordOracleDiagnostic("info", "SHELL_USABLE", {
        durationMs: Math.max(0, currentTime - Number(bootstrapState && bootstrapState.startedAt || currentTime)),
        route: "replays",
        nativeAddonReady: Boolean(nativeDragAddon),
      });
    }
  } catch (error) {
    if (!isCurrentOraclePanelBootstrap(bootstrapState)) {
      await destroyOracleBootstrapController(controller);
      return;
    }
    if (typeof reportOracleCritical === "function") {
      reportOracleCritical("PANEL_INITIALIZATION_FAILED", error, {});
    } else if (typeof console !== "undefined" && console && typeof console.error === "function") {
      console.error("[Oracle][PANEL_INITIALIZATION_FAILED] Oracle panel initialization failed.");
    }
    await destroyOracleBootstrapController(controller);
    setOracleStartupState("error", error);
  }
}

function scheduleOraclePanelInitialization() {
  const previous = Reflect.get(window, ORACLE_PANEL_BOOTSTRAP_KEY);
  const previousRetirement = retireOraclePanelBootstrap(previous);

  const bootstrapState = {
    cancelled: false,
    controller: null,
    listener: null,
    promise: null,
    retirementPromise: null,
    startedAt: typeof performance !== "undefined" && performance && typeof performance.now === "function"
      ? performance.now()
      : Date.now(),
  };
  const start = () => {
    bootstrapState.listener = null;
    if (!isCurrentOraclePanelBootstrap(bootstrapState)) return Promise.resolve();
    if (!bootstrapState.promise) {
      bootstrapState.promise = (async () => {
        await previousRetirement;
        if (!isCurrentOraclePanelBootstrap(bootstrapState)) return;
        await initializeOraclePanel(bootstrapState);
      })();
    }
    return bootstrapState.promise;
  };
  Reflect.set(window, ORACLE_PANEL_BOOTSTRAP_KEY, bootstrapState);
  if (document.readyState === "complete") {
    void start();
  } else {
    bootstrapState.listener = () => void start();
    window.addEventListener("load", bootstrapState.listener, { once: true });
  }
  return bootstrapState;
}

function captureOracleM7PanelBlueprints() {
  const panelDom = oracleWindow.OraclePanelDom;
  if (!panelDom || typeof panelDom.capturePristineBlueprint !== "function") {
    return {
      blueprints: null,
      error: new Error("Oracle's root-scoped panel DOM module did not load."),
    };
  }
  try {
    return {
      blueprints: Object.freeze({
        replays: panelDom.capturePristineBlueprint(document, [
          "replayScroller",
          "replayViewerTray",
          "replayContextMenu",
          "replayLifecycleBackdrop",
          "toastRegion",
          "screenReaderStatus",
        ], { name: "oracleReplaysPanel" }),
        curves: panelDom.capturePristineBlueprint(document, [
          "curvesWorkspace",
          "curvesPresetDialogBackdrop",
          "toastRegion",
          "screenReaderStatus",
        ], { name: "oracleCurvesPanel" }),
        quickApply: panelDom.capturePristineBlueprint(document, [
          "quickApplyWorkspace",
          "curvesPresetDialogBackdrop",
          "toastRegion",
          "screenReaderStatus",
        ], { name: "oracleQuickApplyPanel" }),
      }),
      error: null,
    };
  } catch (error) {
    return {
      blueprints: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

// Capture these detached snapshots before any M1-M6 controller renders cards,
// mutates form state, or binds runtime-only data to the main document.
const ORACLE_M7_BLUEPRINT_CAPTURE = captureOracleM7PanelBlueprints();

scheduleOraclePanelInitialization();

// Premiere 26.3 physically proved one JavaScript realm with four distinct
// lifecycle roots. M7 keeps one application runtime and mounts only a
// root-scoped workspace controller inside each dedicated panel.
const ORACLE_M7_PANEL_IDS = Object.freeze([
  "oraclePanel",
  "oracleReplaysPanel",
  "oracleCurvesPanel",
  "oracleQuickApplyPanel",
]);
const ORACLE_M7_REALM_KEY = "__oracleM7RealmProbeV1";
const ORACLE_M7_ROOT_IDS = new WeakMap();
const ORACLE_M7_OBJECT_IDS = new WeakMap();
let oracleM7NextRootId = 1;
let oracleM7NextObjectId = 1;

function initializeOracleM7RealmProbe() {
  let probe = Reflect.get(window, ORACLE_M7_REALM_KEY);
  if (!probe || typeof probe !== "object") {
    probe = {
      version: 1,
      realmId: `oracle-realm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      moduleEvaluations: 1,
      records: [],
    };
    Reflect.set(window, ORACLE_M7_REALM_KEY, probe);
  } else {
    probe.moduleEvaluations = Number(probe.moduleEvaluations || 0) + 1;
  }
  return probe;
}

const ORACLE_M7_REALM_PROBE = initializeOracleM7RealmProbe();

function oracleM7RealmProbe() {
  return ORACLE_M7_REALM_PROBE;
}

function oracleM7ObjectId(value, label = "object") {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return "none";
  if (!ORACLE_M7_OBJECT_IDS.has(value)) {
    ORACLE_M7_OBJECT_IDS.set(value, `${label}-${oracleM7NextObjectId++}`);
  }
  return ORACLE_M7_OBJECT_IDS.get(value);
}

function oracleM7RootId(rootNode) {
  if (!rootNode || (typeof rootNode !== "object" && typeof rootNode !== "function")) return "no-root";
  if (!ORACLE_M7_ROOT_IDS.has(rootNode)) {
    ORACLE_M7_ROOT_IDS.set(rootNode, `panel-root-${oracleM7NextRootId++}`);
  }
  return ORACLE_M7_ROOT_IDS.get(rootNode);
}

function recordOracleM7PanelHook(panelId, hook, rootNode, data = null) {
  const probe = oracleM7RealmProbe();
  const panelDom = oracleWindow.OraclePanelDom;
  const resolvedRoot = panelDom && typeof panelDom.resolvePanelRoot === "function"
    ? panelDom.resolvePanelRoot(rootNode) || rootNode
    : rootNode;
  const record = {
    sequence: probe.records.length + 1,
    at: Date.now(),
    realmId: probe.realmId,
    panelId,
    hook,
    rootId: oracleM7RootId(resolvedRoot),
    rootTag: String(resolvedRoot && resolvedRoot.tagName || ""),
    rootChildCount: Number(resolvedRoot && resolvedRoot.children && resolvedRoot.children.length || 0),
    sameDocument: Boolean(resolvedRoot && resolvedRoot.ownerDocument === document),
    sameWindow: Boolean(resolvedRoot && resolvedRoot.ownerDocument && resolvedRoot.ownerDocument.defaultView === window),
    dataKeys: data && typeof data === "object" ? Object.keys(data).sort() : [],
  };
  probe.records.push(record);
  if (probe.records.length > 128) probe.records.splice(0, probe.records.length - 128);
  if (typeof recordOracleDiagnostic === "function") {
    recordOracleDiagnostic("debug", "PANEL_HOOK", record);
  }
  return record;
}

function renderOracleM7EmergencyPanelState(rootValue, panelId, error) {
  let target = rootValue;
  const seen = [];
  for (let depth = 0; depth < 8 && target && typeof target.appendChild !== "function"; depth += 1) {
    if ((typeof target !== "object" && typeof target !== "function") || seen.includes(target)) {
      target = null;
      break;
    }
    seen.push(target);
    target = target.node;
  }
  if (
    !target ||
    typeof target.appendChild !== "function" ||
    typeof document === "undefined" ||
    !document ||
    typeof document.createElement !== "function"
  ) {
    return false;
  }
  const marker = String(panelId || "oracleDedicatedPanel").slice(0, 160);
  if (typeof target.querySelector === "function" && target.querySelector(`[data-oracle-emergency-panel="${marker}"]`)) {
    return true;
  }
  try {
    const root = document.createElement("div");
    root.setAttribute("class", "oracle-panel oracle-panel--entrypoint");
    root.setAttribute("data-oracle-emergency-panel", marker);
    root.setAttribute("data-oracle-panel-state", "error");
    const state = document.createElement("section");
    state.setAttribute("class", "oracle-startup-state oracle-startup-state--entrypoint");
    state.setAttribute("role", "alert");
    state.setAttribute("aria-live", "assertive");
    state.setAttribute("data-state", "error");
    const card = document.createElement("div");
    card.setAttribute("class", "oracle-startup-state__card");
    const kicker = document.createElement("span");
    kicker.setAttribute("class", "oracle-kicker");
    kicker.textContent = "Oracle workspace";
    const title = document.createElement("h2");
    title.textContent = "Oracle could not start";
    const message = document.createElement("p");
    const detail = String(error && error.message ? error.message : error || "The panel bootstrap failed.").slice(0, 500);
    message.textContent = `${detail} Reload Oracle in UDT after checking the first UXP Console exception.`;
    card.appendChild(kicker);
    card.appendChild(title);
    card.appendChild(message);
    state.appendChild(card);
    root.appendChild(state);
    target.appendChild(root);
    return true;
  } catch (fallbackError) {
    if (typeof reportOracleCritical === "function") {
      reportOracleCritical("EMERGENCY_PANEL_STATE_FAILED", fallbackError, { panelId: marker });
    } else if (typeof console !== "undefined" && console && typeof console.error === "function") {
      console.error("[Oracle][EMERGENCY_PANEL_STATE_FAILED] The emergency panel state could not be rendered.");
    }
    return false;
  }
}

class OracleM7PanelHostRegistry {
  constructor() {
    this.runtimeId = `oracle-runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.recordsByRoot = new WeakMap();
    this.records = new Set();
    this.mainPanelVisible = false;
    this.mainVisibilityGeneration = 0;
    this.destroyed = false;
    this.destroyPromise = null;
  }

  setMainPanelVisible(value) {
    if (this.destroyed) return false;
    const next = Boolean(value);
    this.mainPanelVisible = next;
    const generation = ++this.mainVisibilityGeneration;
    const apply = (controller) => {
      if (
        this.destroyed ||
        generation !== this.mainVisibilityGeneration ||
        !controller ||
        controller.destroyed ||
        typeof controller.setMainPanelVisible !== "function"
      ) return false;
      return controller.setMainPanelVisible(next);
    };
    const controller = Reflect.get(window, ORACLE_PANEL_CONTROLLER_KEY);
    if (controller && !controller.destroyed && controller.quickApplyWorkspace) return apply(controller);
    void this.waitForController().then(apply).catch((error) => {
      if (!this.destroyed && generation === this.mainVisibilityGeneration) {
        recordOracleDiagnostic("error", "MAIN_PANEL_VISIBILITY_SYNC_FAILED", {
          message: oracleErrorMessage(error),
        });
      }
    });
    return true;
  }

  panelConfig(panelId) {
    const configs = {
      oracleReplaysPanel: { kind: "replays", kicker: "Replay library", title: "Oracle Replays" },
      oracleCurvesPanel: { kind: "curves", kicker: "Premiere keyframes", title: "Oracle Curves" },
      oracleQuickApplyPanel: { kind: "quick-apply", kicker: "Premiere effects", title: "Oracle Quick Apply" },
    };
    return configs[panelId] || null;
  }

  pruneDisconnectedRecords() {
    for (const record of Array.from(this.records)) {
      if (!record || record.destroyed || !record.root || record.root.isConnected !== false) continue;
      this.destroyPanel(record.panelId, record.root);
    }
  }

  ensureRecord(panelId, rootValue) {
    if (panelId === "oraclePanel") return null;
    if (this.destroyed) throw new Error("Oracle's multi-panel runtime is shutting down.");
    const panelDom = oracleWindow.OraclePanelDom;
    if (!panelDom || typeof panelDom.resolvePanelRoot !== "function") {
      throw new Error("Oracle's root-scoped panel DOM module is unavailable.");
    }
    const root = panelDom.resolvePanelRoot(rootValue);
    if (!root) throw new Error("Premiere did not provide an appendable panel root.");
    const existing = this.recordsByRoot.get(root);
    if (existing) {
      if (existing.panelId !== panelId) {
        existing.visible = false;
        existing.conflicted = true;
        existing.generation += 1;
        if (existing.mount) {
          const conflictedMount = existing.mount;
          existing.mount = null;
          existing.mountRetirementPromise = Promise.resolve().then(() => conflictedMount.destroy()).catch((error) => {
            recordOracleDiagnostic("error", "CONFLICTED_PANEL_TEARDOWN_FAILED", {
              panelId: existing.panelId,
              message: oracleErrorMessage(error),
            });
          });
        }
        const conflict = Object.assign(
          new Error(
            `Premiere dispatched ${panelId} to a root already owned by ${existing.panelId}. Reload Oracle in UDT and inspect the M7 panel-hook sequence.`,
          ),
          { code: "ROOT_PANEL_ID_CONFLICT" },
        );
        existing.conflictReason = conflict.message;
        if (existing.shell && panelDom && typeof panelDom.setDedicatedPanelShellState === "function") {
          panelDom.setDedicatedPanelShellState(existing.shell, "error", conflict);
        }
        throw conflict;
      }
      return existing;
    }
    const config = this.panelConfig(panelId);
    if (!config) throw new Error(`Unsupported Oracle panel: ${panelId}`);
    const shell = panelDom.createDedicatedPanelShell(document, {
      target: root,
      entrypointId: panelId,
      kind: config.kind,
      kicker: config.kicker,
      title: config.title,
      message: "Connecting this workspace to Oracle's shared Premiere runtime.",
    });
    const record = {
      panelId,
      kind: config.kind,
      root,
      shell,
      mount: null,
      mountPromise: null,
      mountRetirementPromise: null,
      visible: false,
      conflicted: false,
      conflictReason: "",
      destroyed: false,
      destroyPromise: null,
      generation: 1,
    };
    this.recordsByRoot.set(root, record);
    this.records.add(record);
    return record;
  }

  async waitForController() {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const bootstrap = Reflect.get(window, ORACLE_PANEL_BOOTSTRAP_KEY);
      if (bootstrap && bootstrap.promise && typeof bootstrap.promise.then === "function") {
        await bootstrap.promise;
      }
      const controller = Reflect.get(window, ORACLE_PANEL_CONTROLLER_KEY);
      if (controller && !controller.destroyed && controller.quickApplyWorkspace) return controller;
      if (bootstrap && bootstrap.promise) {
        throw new Error("Oracle's shared application runtime did not finish starting.");
      }
      await delay(25);
    }
    throw new Error("Oracle's shared application runtime did not become ready.");
  }

  blueprintFor(record) {
    if (ORACLE_M7_BLUEPRINT_CAPTURE.error) throw ORACLE_M7_BLUEPRINT_CAPTURE.error;
    const blueprints = ORACLE_M7_BLUEPRINT_CAPTURE.blueprints;
    if (!blueprints) throw new Error("Oracle's dedicated workspace blueprints are unavailable.");
    if (record.kind === "replays") return blueprints.replays;
    if (record.kind === "curves") return blueprints.curves;
    return blueprints.quickApply;
  }

  ensureMounted(record) {
    if (!record || record.destroyed || record.conflicted) return Promise.resolve(null);
    if (record.mount) return Promise.resolve(record.mount);
    if (record.mountPromise) return record.mountPromise;
    const generation = record.generation;
    record.mountPromise = this.waitForController().then(async (controller) => {
      if (this.destroyed || record.destroyed || record.conflicted || record.generation !== generation) return null;
      const mount = new OracleDedicatedPanelMount({
        panelId: record.panelId,
        shell: record.shell,
        controller,
        panelDom: oracleWindow.OraclePanelDom,
        blueprint: this.blueprintFor(record),
      });
      try {
        mount.start();
        mount.setPreferences(controller.theme && controller.theme.committed || {});
      } catch (error) {
        await mount.destroy();
        throw error;
      }
      if (this.destroyed || record.destroyed || record.conflicted || record.generation !== generation) {
        await mount.destroy();
        return null;
      }
      record.mount = mount;
      record.mountPromise = null;
      mount.setVisible(record.visible);
      oracleWindow.OraclePanelDom.setDedicatedPanelShellState(record.shell, "ready");
      recordOracleDiagnostic("info", "DEDICATED_PANEL_MOUNT_READY", {
        panelId: record.panelId,
        rootId: oracleM7RootId(record.root),
        mountId: mount.mountId,
        ...this.serviceSnapshot(controller),
      });
      return mount;
    }).catch((error) => {
      record.mountPromise = null;
      if (!record.destroyed) {
        oracleWindow.OraclePanelDom.setDedicatedPanelShellState(record.shell, "error", error);
        recordOracleDiagnostic("error", "DEDICATED_PANEL_MOUNT_FAILED", {
          panelId: record.panelId,
          message: oracleErrorMessage(error),
        });
      }
      return null;
    });
    return record.mountPromise;
  }

  prepare(panelId, rootValue) {
    if (panelId === "oraclePanel") return;
    try {
      this.pruneDisconnectedRecords();
      this.ensureRecord(panelId, rootValue);
    } catch (error) {
      renderOracleM7EmergencyPanelState(rootValue, panelId, error);
      recordOracleDiagnostic("error", "DEDICATED_PANEL_CREATE_FAILED", {
        panelId,
        message: oracleErrorMessage(error),
      });
    }
  }

  show(panelId, rootValue) {
    if (panelId === "oraclePanel") {
      this.setMainPanelVisible(true);
      return;
    }
    try {
      this.pruneDisconnectedRecords();
      const record = this.ensureRecord(panelId, rootValue);
      record.visible = true;
      if (record.mount) record.mount.setVisible(true);
      void this.ensureMounted(record);
    } catch (error) {
      renderOracleM7EmergencyPanelState(rootValue, panelId, error);
      recordOracleDiagnostic("error", "DEDICATED_PANEL_SHOW_FAILED", {
        panelId,
        message: oracleErrorMessage(error),
      });
    }
  }

  hide(panelId, rootValue) {
    if (panelId === "oraclePanel") {
      this.setMainPanelVisible(false);
      return;
    }
    const root = oracleWindow.OraclePanelDom && oracleWindow.OraclePanelDom.resolvePanelRoot(rootValue);
    const record = root && this.recordsByRoot.get(root);
    if (!record) return;
    record.visible = false;
    if (record.mount) record.mount.setVisible(false);
    setTimeout(() => {
      if (!this.destroyed && !record.destroyed && record.root && record.root.isConnected === false) {
        this.destroyPanel(record.panelId, record.root);
      }
    }, 0);
  }

  destroyPanel(panelId, rootValue) {
    if (panelId === "oraclePanel") {
      return Promise.resolve(this.setMainPanelVisible(false));
    }
    const root = oracleWindow.OraclePanelDom && oracleWindow.OraclePanelDom.resolvePanelRoot(rootValue);
    const record = root && this.recordsByRoot.get(root);
    if (!record) return Promise.resolve(false);
    if (record.destroyPromise) return record.destroyPromise;
    record.destroyed = true;
    record.generation += 1;
    const pendingMount = record.mountPromise;
    const pendingMountRetirement = record.mountRetirementPromise;
    record.destroyPromise = (async () => {
      try {
        if (pendingMountRetirement && typeof pendingMountRetirement.then === "function") {
          await pendingMountRetirement;
        }
        let mount = record.mount;
        if (pendingMount && typeof pendingMount.then === "function") {
          try {
            mount = mount || await pendingMount;
          } catch (error) {
            recordOracleDiagnostic("error", "PENDING_PANEL_MOUNT_RETIREMENT_FAILED", {
              panelId,
              message: oracleErrorMessage(error),
            });
          }
        }
        if (mount && typeof mount.destroy === "function") {
          try {
            await mount.destroy();
          } catch (error) {
            recordOracleDiagnostic("error", "PANEL_LOCAL_TEARDOWN_FAILED", {
              panelId,
              message: oracleErrorMessage(error),
            });
          }
        }
      } finally {
        record.mount = null;
        record.mountPromise = null;
        record.mountRetirementPromise = null;
        try {
          if (record.shell && record.shell.root) {
            if (typeof record.shell.root.remove === "function") record.shell.root.remove();
            else if (record.shell.root.parentNode && typeof record.shell.root.parentNode.removeChild === "function") {
              record.shell.root.parentNode.removeChild(record.shell.root);
            }
          }
        } catch (error) {
          recordOracleDiagnostic("error", "PANEL_SHELL_REMOVAL_FAILED", {
            panelId,
            message: oracleErrorMessage(error),
          });
        }
        this.records.delete(record);
        this.recordsByRoot.delete(root);
      }
      return true;
    })();
    return record.destroyPromise;
  }

  serviceSnapshot(controller = Reflect.get(window, ORACLE_PANEL_CONTROLLER_KEY)) {
    this.pruneDisconnectedRecords();
    return {
      realmId: oracleM7RealmProbe().realmId,
      runtimeId: this.runtimeId,
      controllerId: oracleM7ObjectId(controller, "controller"),
      storeId: oracleM7ObjectId(controller && controller.store, "store"),
      persistenceId: oracleM7ObjectId(controller && controller.persistence, "persistence"),
      gatewayId: oracleM7ObjectId(controller && controller.gateway, "gateway"),
      bridgeId: oracleM7ObjectId(bridgeClient, "bridge"),
      nativeAddonId: oracleM7ObjectId(nativeDragAddon, "native"),
      viewerCoordinatorId: oracleM7ObjectId(controller && controller.viewerAdapterCoordinator, "viewer-coordinator"),
      curvesCoordinatorId: oracleM7ObjectId(controller && controller.curvesAdapterCoordinator, "curves-coordinator"),
      quickApplyCoordinatorId: oracleM7ObjectId(controller && controller.quickApplyAdapterCoordinator, "quick-coordinator"),
      mainPanelVisible: controller ? controller.mainPanelVisible !== false : this.mainPanelVisible,
      mainRoute: String(controller && controller.shell && controller.shell.route || ""),
      dedicatedMountCount: controller && controller.dedicatedMounts ? controller.dedicatedMounts.size : 0,
      panelRecordCount: this.records.size,
      curvesLeases: controller && controller.curvesAdapterCoordinator
        ? controller.curvesAdapterCoordinator.getState().leaseCount
        : 0,
      quickApplyLeases: controller && controller.quickApplyAdapterCoordinator
        ? controller.quickApplyAdapterCoordinator.getState().leaseCount
        : 0,
      viewerLeases: controller && controller.viewerAdapterCoordinator
        ? controller.viewerAdapterCoordinator.getState().leaseCount
        : 0,
    };
  }

  destroyAll() {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.destroyPromise = (async () => {
      const controller = Reflect.get(window, ORACLE_PANEL_CONTROLLER_KEY);
      if (controller && typeof controller.setMainPanelVisible === "function") {
        try { controller.setMainPanelVisible(false); } catch (error) {
          recordOracleDiagnostic("error", "MAIN_PANEL_TEARDOWN_SYNC_FAILED", {
            message: oracleErrorMessage(error),
          });
        }
      }
      for (const record of Array.from(this.records)) {
        try {
          await this.destroyPanel(record.panelId, record.root);
        } catch (error) {
          recordOracleDiagnostic("error", "PANEL_REGISTRY_TEARDOWN_FAILED", {
            panelId: record.panelId,
            message: oracleErrorMessage(error),
          });
        }
      }
      this.records.clear();
      return true;
    })();
    return this.destroyPromise;
  }
}

const oracleM7PanelHostRegistry = new OracleM7PanelHostRegistry();

function createOracleM7PanelHooks(panelId) {
  return {
    create(rootNode) {
      recordOracleM7PanelHook(panelId, "create", rootNode);
      oracleM7PanelHostRegistry.prepare(panelId, rootNode);
    },
    show(rootNode, data) {
      recordOracleM7PanelHook(panelId, "show", rootNode, data);
      oracleM7PanelHostRegistry.show(panelId, rootNode);
    },
    hide(rootNode, data) {
      recordOracleM7PanelHook(panelId, "hide", rootNode, data);
      oracleM7PanelHostRegistry.hide(panelId, rootNode);
    },
    destroy(rootNode) {
      recordOracleM7PanelHook(panelId, "destroy", rootNode);
      oracleM7PanelHostRegistry.destroyPanel(panelId, rootNode);
    },
  };
}

const ORACLE_M8_PLUGIN_ID = "com.blocky.oracle.v5";
const ORACLE_M8_COMMAND_ID = "oracleQuickApplyCommand";
const ORACLE_M8_QUICK_APPLY_PANEL_ID = "oracleQuickApplyPanel";

function oracleM8CommandError(code, message, cause = null) {
  const error = new Error(message);
  error.name = "OracleQuickApplyCommandError";
  Reflect.set(error, "code", String(code || "QUICK_APPLY_COMMAND_FAILED"));
  if (cause !== null && cause !== undefined) Reflect.set(error, "cause", cause);
  return error;
}

function oracleM8HostMessage(value, fallback) {
  let message = "";
  try {
    message = String(value && value.message ? value.message : value || "").trim();
  } catch (error) {
    message = "";
  }
  return (message || fallback).slice(0, 500);
}

// Command entrypoints are host-synchronous in Premiere. Keep the host wrapper
// synchronous and isolate the supported asynchronous Plugin.showPanel contract
// behind a helper that always returns a Promise and never throws to its caller.
function showOracleQuickApplyPanel(pluginManager) {
  return Promise.resolve().then(() => {
    if (!pluginManager) {
      throw oracleM8CommandError(
        "PLUGIN_MANAGER_UNAVAILABLE",
        "Premiere's UXP plugin manager is unavailable.",
      );
    }

    let pluginSource;
    try {
      pluginSource = pluginManager.plugins;
    } catch (error) {
      throw oracleM8CommandError(
        "PLUGIN_LIST_UNAVAILABLE",
        "Premiere's UXP plugin list could not be read.",
        error,
      );
    }
    if (!pluginSource) {
      throw oracleM8CommandError(
        "PLUGIN_LIST_UNAVAILABLE",
        "Premiere's UXP plugin list is unavailable.",
      );
    }

    let plugins;
    try {
      // Premiere 26.3 exposes an array-like collection without Array methods.
      plugins = Array.from(pluginSource);
    } catch (error) {
      throw oracleM8CommandError(
        "PLUGIN_LIST_UNAVAILABLE",
        "Premiere's UXP plugin list could not be enumerated.",
        error,
      );
    }
    const plugin = plugins.find((candidate) =>
      candidate && String(candidate.id || "") === ORACLE_M8_PLUGIN_ID);
    if (!plugin) {
      throw oracleM8CommandError(
        "ORACLE_PLUGIN_NOT_FOUND",
        "Oracle is not present in Premiere's enabled UXP plugin list.",
      );
    }
    if (plugin.enabled !== true) {
      throw oracleM8CommandError(
        "ORACLE_PLUGIN_DISABLED",
        "Oracle is disabled in Premiere's UXP plugin manager.",
      );
    }

    let showPanel;
    try {
      showPanel = plugin.showPanel;
    } catch (error) {
      throw oracleM8CommandError(
        "SHOW_PANEL_UNAVAILABLE",
        "Premiere's supported panel reveal API could not be read.",
        error,
      );
    }
    if (typeof showPanel !== "function") {
      throw oracleM8CommandError(
        "SHOW_PANEL_UNAVAILABLE",
        "Premiere's supported panel reveal API is unavailable.",
      );
    }

    let result;
    try {
      result = showPanel.call(plugin, ORACLE_M8_QUICK_APPLY_PANEL_ID);
    } catch (error) {
      throw oracleM8CommandError(
        "SHOW_PANEL_THROW",
        `Premiere could not reveal Oracle Quick Apply: ${oracleM8HostMessage(error, "unknown host error")}`,
        error,
      );
    }
    if (typeof result === "string") {
      throw oracleM8CommandError(
        "SHOW_PANEL_REJECTED",
        `Premiere rejected Oracle Quick Apply: ${oracleM8HostMessage(result, "panel reveal was rejected")}`,
      );
    }
    if (!result || typeof result.then !== "function") {
      throw oracleM8CommandError(
        "SHOW_PANEL_INVALID_RESULT",
        "Premiere's panel reveal API returned an unsupported result.",
      );
    }

    return Promise.resolve(result).then((value) => {
      if (typeof value === "string") {
        throw oracleM8CommandError(
          "SHOW_PANEL_REJECTED",
          `Premiere rejected Oracle Quick Apply: ${oracleM8HostMessage(value, "panel reveal was rejected")}`,
        );
      }
      return undefined;
    }, (error) => {
      throw oracleM8CommandError(
        "SHOW_PANEL_REJECTED",
        `Premiere could not reveal Oracle Quick Apply: ${oracleM8HostMessage(error, "unknown host error")}`,
        error,
      );
    });
  }).catch((error) => {
    if (error && error.name === "OracleQuickApplyCommandError") throw error;
    throw oracleM8CommandError(
      "QUICK_APPLY_COMMAND_FAILED",
      `Oracle Quick Apply could not be opened: ${oracleM8HostMessage(error, "unknown command error")}`,
      error,
    );
  });
}

function handleOracleQuickApplyCommand(pluginManager, logger = null) {
  const operation = showOracleQuickApplyPanel(pluginManager);
  void operation.catch((error) => {
    try {
      const diagnostic = {
        code: String(error && error.code || "QUICK_APPLY_COMMAND_FAILED"),
        message: oracleM8HostMessage(error, "Oracle Quick Apply could not be opened."),
      };
      if (typeof recordOracleDiagnostic === "function") {
        recordOracleDiagnostic("error", diagnostic.code, { message: diagnostic.message });
      }
      if (logger && typeof logger.error === "function") {
        logger.error("[Oracle M8][oracleQuickApplyCommand] Panel reveal failed.", diagnostic);
      }
    } catch (loggingError) {
      // Diagnostics must never create a second unhandled rejection.
    }
  });
}

function setupOracleM7PanelEntrypoints() {
  let uxpRuntime = null;
  try {
    const moduleName = "u" + "xp";
    uxpRuntime = require(moduleName);
  } catch (error) {
    return false;
  }
  const entrypoints = uxpRuntime && uxpRuntime.entrypoints;
  if (!entrypoints || typeof entrypoints.setup !== "function") return false;
  const panels = {};
  for (const panelId of ORACLE_M7_PANEL_IDS) panels[panelId] = createOracleM7PanelHooks(panelId);
  function oracleQuickApplyCommandHandler() {
    handleOracleQuickApplyCommand(uxpRuntime && uxpRuntime.pluginManager);
  }
  entrypoints.setup({
    plugin: {
      create() {
        const probe = oracleM7RealmProbe();
        recordOracleDiagnostic("info", "PLUGIN_CREATE", { realmId: probe.realmId });
      },
      async destroy() {
        const probe = oracleM7RealmProbe();
        try {
          const snapshot = oracleM7PanelHostRegistry.serviceSnapshot();
          recordOracleDiagnostic("info", "PLUGIN_DESTROY", { realmId: probe.realmId, ...snapshot });
        } catch (error) {
          recordOracleDiagnostic("error", "PLUGIN_TEARDOWN_SNAPSHOT_FAILED", {
            message: oracleErrorMessage(error),
          });
        }
        const bootstrapState = Reflect.get(window, ORACLE_PANEL_BOOTSTRAP_KEY);
        try {
          await retireOraclePanelBootstrap(bootstrapState);
        } catch (error) {
          recordOracleDiagnostic("error", "PLUGIN_BOOTSTRAP_TEARDOWN_FAILED", {
            message: oracleErrorMessage(error),
          });
        }
        try {
          await oracleM7PanelHostRegistry.destroyAll();
        } catch (error) {
          recordOracleDiagnostic("error", "PLUGIN_PANEL_REGISTRY_TEARDOWN_FAILED", {
            message: oracleErrorMessage(error),
          });
        }
        try {
          await retireExistingOraclePanelControllers();
        } catch (error) {
          recordOracleDiagnostic("error", "PLUGIN_CONTROLLER_TEARDOWN_FAILED", {
            message: oracleErrorMessage(error),
          });
        }
        if (Reflect.get(window, ORACLE_PANEL_BOOTSTRAP_KEY) === bootstrapState) {
          Reflect.deleteProperty(window, ORACLE_PANEL_BOOTSTRAP_KEY);
        }
      },
    },
    panels,
    commands: {
      [ORACLE_M8_COMMAND_ID]: oracleQuickApplyCommandHandler,
    },
  });
  return true;
}

setupOracleM7PanelEntrypoints();
