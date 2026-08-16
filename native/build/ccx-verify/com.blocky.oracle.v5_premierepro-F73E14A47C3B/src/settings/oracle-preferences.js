"use strict";

(function exposeOraclePreferences(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (globalScope) {
    Reflect.set(globalScope, "OracleOverdrivePreferences", api);
  }
})(typeof window !== "undefined" ? window : null, function createOraclePreferencesApi() {
  const PREFERENCES_SCHEMA = "oracle-overdrive-preferences";
  const PREFERENCES_VERSION = 1;
  const PREFERENCES_STORAGE_KEY = "oracle.overdrive.preferences.v1";
  const LEGACY_THEME_KEY = "oracle.themePreferences.v1";
  const LEGACY_GRID_KEY = "oracle.gridColumns.v2";
  const AVATAR_URL = "plugin-data:/oracle-profile-avatar.v1.png";
  const AVATAR_TEMP_URL = "plugin-data:/oracle-profile-avatar.v1.tmp.png";
  const AVATAR_BACKUP_URL = "plugin-data:/oracle-profile-avatar.v1.backup.png";
  const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
  const AVATAR_MIN_PIXELS = 64;
  const AVATAR_MAX_PIXELS = 8192;
  const AVATAR_MAX_TOTAL_PIXELS = 16 * 1024 * 1024;
  const AVATAR_OUTPUT_PIXELS = 256;
  const DIALOG_TRANSITION_MS = 160;
  const IMPORT_MAX_CHARACTERS = 1024 * 1024;
  const METADATA_IMPORT_MAX_CHARACTERS = 32 * 1024 * 1024;
  const BLOCKY_THEME_PALETTES = Object.freeze({
    dark: Object.freeze({
      text: "#F5F7FA",
      mutedText: "#BBC2CC",
      surfaces: Object.freeze({
        header: "#0C0E12",
        surface: "#181C22",
        raised: "#20252D",
        hover: "#292F39",
      }),
    }),
    light: Object.freeze({
      text: "#1D2025",
      mutedText: "#555D68",
      surfaces: Object.freeze({
        header: "#FFFDF8",
        surface: "#FFFDF9",
        raised: "#EEEBE4",
        hover: "#E4E1D9",
      }),
    }),
  });
  const DOCUMENT_THEME_BINDINGS = new WeakMap();
  const BLOCKY_STUDIOS_LOGOS = Object.freeze({
    dark: "assets/logo/blocky-studios-dark-mode.png",
    light: "assets/logo/blocky-studios-light-mode.png",
  });

  function replaceElementChildren(element, nodes = []) {
    element.innerHTML = "";
    for (const node of nodes) element.appendChild(node);
  }

  function clamp(value, minimum, maximum, fallback = minimum) {
    const number = Number(value);
    const finite = Number.isFinite(number) ? number : Number(fallback);
    return Math.max(minimum, Math.min(maximum, finite));
  }

  function normalizeCurveGridSize(value, fallback = 8) {
    const requested = Math.round(clamp(value, 4, 16, fallback));
    return [4, 8, 16].reduce((best, candidate) => (
      Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
    ), 4);
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeHexColor(value, fallback = "") {
    const text = String(value || "").trim();
    const prefixed = text.startsWith("#") ? text : `#${text}`;
    if (/^#[0-9a-f]{6}$/i.test(prefixed)) return prefixed.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(prefixed)) {
      return `#${prefixed[1]}${prefixed[1]}${prefixed[2]}${prefixed[2]}${prefixed[3]}${prefixed[3]}`.toUpperCase();
    }
    return fallback;
  }

  function hexToRgb(value) {
    const color = normalizeHexColor(value, "#000000");
    return {
      r: Number.parseInt(color.slice(1, 3), 16),
      g: Number.parseInt(color.slice(3, 5), 16),
      b: Number.parseInt(color.slice(5, 7), 16),
    };
  }

  function rgbToHex(red, green, blue) {
    const channel = (value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
    return `#${channel(red)}${channel(green)}${channel(blue)}`.toUpperCase();
  }

  function rgbToHsv(red, green, blue) {
    const r = clamp(red, 0, 255) / 255;
    const g = clamp(green, 0, 255) / 255;
    const b = clamp(blue, 0, 255) / 255;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const delta = maximum - minimum;
    let hue = 0;
    if (delta !== 0) {
      if (maximum === r) hue = 60 * (((g - b) / delta) % 6);
      else if (maximum === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return { h: hue, s: maximum === 0 ? 0 : delta / maximum, v: maximum };
  }

  function hsvToRgb(hue, saturation, value) {
    const h = ((Number(hue) % 360) + 360) % 360;
    const s = clamp(saturation, 0, 1);
    const v = clamp(value, 0, 1);
    const chroma = v * s;
    const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - chroma;
    let channels;
    if (h < 60) channels = [chroma, x, 0];
    else if (h < 120) channels = [x, chroma, 0];
    else if (h < 180) channels = [0, chroma, x];
    else if (h < 240) channels = [0, x, chroma];
    else if (h < 300) channels = [x, 0, chroma];
    else channels = [chroma, 0, x];
    return {
      r: (channels[0] + m) * 255,
      g: (channels[1] + m) * 255,
      b: (channels[2] + m) * 255,
    };
  }

  function relativeLuminance(value) {
    const rgb = hexToRgb(value);
    const channel = (entry) => {
      const normalized = entry / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function contrastRatio(first, second) {
    const high = Math.max(relativeLuminance(first), relativeLuminance(second));
    const low = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (high + 0.05) / (low + 0.05);
  }

  function normalizeThemeMode(value, fallback = "dark") {
    return ["dark", "light", "system"].includes(value) ? value : fallback;
  }

  function contrastReportForMode(normalized, mode) {
    const palette = BLOCKY_THEME_PALETTES[mode];
    const background = mode === "light" ? normalized.lightBackground : normalized.background;
    const focus = mode === "light" ? normalized.lightFocus : normalized.focus;
    const border = mode === "light" ? normalized.lightBorder : normalized.border;
    const surfaces = { background, ...palette.surfaces };
    const ratios = (color) => Object.fromEntries(
      Object.entries(surfaces).map(([name, surface]) => [name, contrastRatio(color, surface)]),
    );
    const textRatios = ratios(palette.text);
    const mutedRatios = ratios(palette.mutedText);
    const focusRatios = ratios(focus);
    const minimum = (values) => Math.min(...Object.values(values));
    return {
      mode,
      palette,
      background,
      border,
      focus,
      surfaces,
      textRatios,
      mutedRatios,
      focusRatios,
      textMinimum: minimum(textRatios),
      mutedMinimum: minimum(mutedRatios),
      focusMinimum: minimum(focusRatios),
      controlText: contrastRatio(palette.text, palette.surfaces.raised),
      borderContrast: contrastRatio(border, background),
      accentContrast: contrastRatio(normalized.accent, background),
    };
  }

  function themeContrastReport(appearance = {}, requestedMode = null) {
    const defaults = createDefaultPreferences().appearance;
    const normalized = {
      theme: normalizeThemeMode(appearance.theme, defaults.theme),
      accent: normalizeHexColor(appearance.accent, defaults.accent),
      background: normalizeHexColor(appearance.background, defaults.background),
      lightBackground: normalizeHexColor(appearance.lightBackground, defaults.lightBackground),
      border: normalizeHexColor(appearance.border, defaults.border),
      lightBorder: normalizeHexColor(appearance.lightBorder, defaults.lightBorder),
      focus: normalizeHexColor(appearance.focus, defaults.focus),
      lightFocus: normalizeHexColor(appearance.lightFocus, defaults.lightFocus),
    };
    const themes = {
      dark: contrastReportForMode(normalized, "dark"),
      light: contrastReportForMode(normalized, "light"),
    };
    const mode = requestedMode === "light" || requestedMode === "dark"
      ? requestedMode
      : (normalized.theme === "light" ? "light" : "dark");
    const active = themes[mode];
    const accentForeground = contrastRatio("#000000", normalized.accent) >= contrastRatio("#FFFFFF", normalized.accent)
      ? "#000000"
      : "#FFFFFF";
    return {
      appearance: normalized,
      themes,
      activeMode: mode,
      surfaces: active.surfaces,
      textRatios: active.textRatios,
      mutedRatios: active.mutedRatios,
      focusRatios: active.focusRatios,
      textMinimum: active.textMinimum,
      mutedMinimum: active.mutedMinimum,
      focusMinimum: active.focusMinimum,
      controlText: active.controlText,
      accentForeground,
      accentText: contrastRatio(accentForeground, normalized.accent),
    };
  }

  function resolveDocumentAppearance(appearance = {}, resolvedTheme = "dark") {
    const defaults = createDefaultPreferences().appearance;
    const mode = resolvedTheme === "light" ? "light" : "dark";
    const candidate = themeContrastReport(appearance, mode);
    const active = candidate.themes[mode];
    const defaultReport = themeContrastReport(defaults, mode).themes[mode];
    const background = active.textRatios.background >= 4.5 && active.mutedRatios.background >= 4.5
      ? active.background
      : defaultReport.background;
    const focus = Math.min(...Object.values(active.focusRatios)) >= 3
      ? active.focus
      : defaultReport.focus;
    const accent = contrastRatio(candidate.appearance.accent, background) >= 1.5
      ? candidate.appearance.accent
      : defaults.accent;
    const border = contrastRatio(active.border, background) >= 1.15
      ? active.border
      : defaultReport.border;
    return {
      ...candidate.appearance,
      accent,
      activeBackground: background,
      activeBorder: border,
      activeFocus: focus,
      resolvedTheme: mode,
      fallbackApplied: background !== active.background || accent !== candidate.appearance.accent ||
        border !== active.border || focus !== active.focus,
    };
  }

  function createDefaultPreferences() {
    return {
      schema: PREFERENCES_SCHEMA,
      version: PREFERENCES_VERSION,
      profile: {
        displayName: "Blocky Studios Editor",
        avatarUrl: "",
        avatarUpdatedAt: null,
        panX: 0,
        panY: 0,
        zoom: 1,
      },
      appearance: {
        theme: "dark",
        accent: "#1D78C8",
        background: "#101216",
        lightBackground: "#F5F3EE",
        border: "#343A44",
        lightBorder: "#CBC7BD",
        focus: "#FFFFFF",
        lightFocus: "#111318",
        fontScale: 1,
        reducedMotion: "system",
      },
      replay: {
        gridColumns: 3,
        thumbnailPosition: 0.5,
        cacheLimitMb: 512,
        roots: [],
        relinkRoots: [],
        archiveNew: false,
        deleteFromDisk: false,
        dateFormat: "system",
        timeFormat: "system",
      },
      curves: {
        gridVisible: true,
        subdivisions: 8,
        snapping: true,
        handleSize: 12,
        gridColor: "#3C3C3C",
        curveColor: "#1D78C8",
        defaultMode: "native",
        sampleBudget: 48,
        warningThreshold: 120,
      },
      quickApply: {
        favoritesFirst: true,
        grouping: "type",
        defaultMedia: "auto",
        recentLimit: 20,
        experimentalEnabled: false,
      },
    };
  }

  function cleanString(value, maximum = 120) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maximum);
  }

  function cleanDiagnosticCode(value) {
    return cleanString(value, 96)
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLocaleUpperCase("en-US") || "ORACLE_DIAGNOSTIC";
  }

  function boundedDiagnosticInteger(value, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.round(number))) : 0;
  }

  function boundedDiagnosticNumber(value, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.round(Math.max(0, Math.min(maximum, number)) * 1000) / 1000;
  }

  function boundedSignedDiagnosticInteger(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(-2147483648, Math.min(2147483647, Math.round(number)));
  }

  function normalizeNativeDragEvidenceRecord(entry) {
    const code = cleanDiagnosticCode(entry && entry.code);
    if (![
      "NATIVE_DRAG_CANCELLED_BEFORE_THRESHOLD",
      "NATIVE_DRAG_INVOCATION_LATENCY",
      "NATIVE_DRAG_COMPLETED",
      "LABEL_9_VERIFIED",
    ].includes(code)) return null;
    const source = entry && entry.details && typeof entry.details === "object" ? entry.details : {};
    const record = {
      sequence: boundedDiagnosticInteger(entry && entry.sequence, Number.MAX_SAFE_INTEGER),
      at: boundedDiagnosticInteger(entry && entry.at, 8640000000000000),
      code,
      details: {},
    };
    if (code === "NATIVE_DRAG_CANCELLED_BEFORE_THRESHOLD") {
      record.details = {
        gestureId: cleanString(source.gestureId, 96),
        movementPx: boundedDiagnosticNumber(source.movementPx, 100000),
        thresholdPx: boundedDiagnosticNumber(source.thresholdPx, 1000),
      };
      return record;
    }
    if (code === "NATIVE_DRAG_INVOCATION_LATENCY") {
      record.details = {
        gestureId: cleanString(source.gestureId, 96),
        latencyMs: boundedDiagnosticNumber(source.latencyMs, 60000),
      };
      return record;
    }
    if (code === "LABEL_9_VERIFIED") {
      record.details = {
        scope: cleanString(source.scope, 48),
        labelIndex: boundedDiagnosticInteger(source.labelIndex, 64),
        expectedLabelIndex: boundedDiagnosticInteger(source.expectedLabelIndex, 64),
      };
      return record;
    }
    const errorCode = cleanString(source.errorCode, 96);
    record.details = {
      gestureId: cleanString(source.gestureId, 96),
      requestId: boundedDiagnosticInteger(source.requestId, Number.MAX_SAFE_INTEGER),
      ok: Boolean(source.ok),
      dropped: Boolean(source.dropped),
      cancelled: Boolean(source.cancelled),
      totalElapsedMs: boundedDiagnosticNumber(source.totalElapsedMs, 3600000),
      nativeDispatchMs: boundedDiagnosticNumber(source.nativeDispatchMs, 3600000),
      nativeSnapshotElapsedMs: boundedDiagnosticNumber(source.nativeSnapshotElapsedMs, 3600000),
      effect: boundedDiagnosticInteger(source.effect, 15),
      finalEffect: boundedDiagnosticInteger(source.finalEffect, 15),
      hresult: boundedSignedDiagnosticInteger(source.hresult),
      stage: cleanDiagnosticCode(source.stage),
      errorCode: errorCode ? cleanDiagnosticCode(errorCode) : "",
      requestReceived: Boolean(source.requestReceived),
      pathValidated: Boolean(source.pathValidated),
      leftButtonConfirmed: Boolean(source.leftButtonConfirmed),
      workerDispatched: Boolean(source.workerDispatched),
      oleInitialized: Boolean(source.oleInitialized),
      doDragDropEntered: Boolean(source.doDragDropEntered),
      doDragDropReturned: Boolean(source.doDragDropReturned),
      queryContinueDragCalls: boundedDiagnosticInteger(source.queryContinueDragCalls, 1000000),
      giveFeedbackCalls: boundedDiagnosticInteger(source.giveFeedbackCalls, 1000000),
      escapeObserved: Boolean(source.escapeObserved),
      promiseCreated: Boolean(source.promiseCreated),
      promiseResolved: Boolean(source.promiseResolved),
      promiseRejected: Boolean(source.promiseRejected),
      cancellationHookInstalled: Boolean(source.cancellationHookInstalled),
    };
    return record;
  }

  function normalizeDiagnosticsSummary(value, recordLimit = 20) {
    const source = value && typeof value === "object" ? value : {};
    const countEntries = Object.entries(source.counts && typeof source.counts === "object" ? source.counts : {})
      .slice(0, 64);
    const counts = {};
    for (const [code, count] of countEntries) {
      counts[cleanDiagnosticCode(code)] = boundedDiagnosticInteger(count, 1000000);
    }
    const limit = Math.max(0, Math.min(20, Math.round(Number(recordLimit) || 0)));
    const sourceRecords = Array.isArray(source.records) ? source.records : [];
    const records = (limit === 0 ? [] : sourceRecords.slice(-limit))
      .map((entry) => ({
        sequence: boundedDiagnosticInteger(entry && entry.sequence, Number.MAX_SAFE_INTEGER),
        at: boundedDiagnosticInteger(entry && entry.at, 8640000000000000),
        level: ["debug", "info", "warn", "error"].includes(String(entry && entry.level || "").toLowerCase())
          ? String(entry.level).toLowerCase()
          : "info",
        code: cleanDiagnosticCode(entry && entry.code),
      }));
    const nativeDragEvidence = sourceRecords
      .map(normalizeNativeDragEvidenceRecord)
      .filter(Boolean)
      .slice(-80);
    return {
      bounded: true,
      capacity: boundedDiagnosticInteger(source.capacity, 500),
      totalRetained: boundedDiagnosticInteger(source.totalRetained == null ? records.length : source.totalRetained, 500),
      latestSequence: boundedDiagnosticInteger(source.latestSequence, Number.MAX_SAFE_INTEGER),
      counts,
      records,
      nativeDragEvidence,
      privacy: {
        fullPathsIncluded: false,
        mediaIncluded: false,
        thumbnailsIncluded: false,
        avatarBytesIncluded: false,
        payloadBytesIncluded: false,
      },
    };
  }

  function cleanStringList(value, maximum = 12) {
    if (!Array.isArray(value)) return [];
    const unique = new Set();
    for (const entry of value) {
      const text = cleanString(entry, 2048);
      if (text) unique.add(text);
      if (unique.size >= maximum) break;
    }
    return Array.from(unique);
  }

  function normalizeReplayRoot(value) {
    const candidate = cleanString(value, 32767).replace(/\//g, "\\");
    if (!candidate || /[\u0000-\u001f]/.test(candidate)) return "";
    let remainder = "";
    if (/^[A-Za-z]:\\/.test(candidate)) {
      remainder = candidate.slice(3);
    } else if (/^\\\\\?\\[A-Za-z]:\\/i.test(candidate)) {
      remainder = candidate.slice(7);
    } else if (/^\\\\\?\\UNC\\/i.test(candidate)) {
      remainder = candidate.slice(8);
    } else if (/^\\\\(?![.?]\\)/.test(candidate)) {
      remainder = candidate.slice(2);
    } else {
      return "";
    }
    const segments = remainder.split("\\").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === ".." || /:/.test(segment))) {
      return "";
    }
    return candidate.replace(/\\+$/g, "");
  }

  function cleanReplayRootList(value, maximum = 12) {
    const unique = new Set();
    for (const entry of Array.isArray(value) ? value : []) {
      const root = normalizeReplayRoot(entry);
      if (root) unique.add(root);
      if (unique.size >= maximum) break;
    }
    return Array.from(unique);
  }

  function normalizePreferences(input, legacy = {}) {
    const defaults = createDefaultPreferences();
    const source = input && typeof input === "object" ? input : {};
    const profile = source.profile && typeof source.profile === "object" ? source.profile : {};
    const appearance = source.appearance && typeof source.appearance === "object"
      ? source.appearance
      : {};
    const replay = source.replay && typeof source.replay === "object" ? source.replay : {};
    const curves = source.curves && typeof source.curves === "object" ? source.curves : {};
    const quickApply = source.quickApply && typeof source.quickApply === "object"
      ? source.quickApply
      : {};
    const legacyTheme = legacy.theme && typeof legacy.theme === "object" ? legacy.theme : {};
    const reducedMotion = ["system", "reduce", "allow"].includes(appearance.reducedMotion)
      ? appearance.reducedMotion
      : defaults.appearance.reducedMotion;
    const avatarUrl = profile.avatarUrl === AVATAR_URL ? AVATAR_URL : "";
    return {
      schema: PREFERENCES_SCHEMA,
      version: PREFERENCES_VERSION,
      profile: {
        displayName: cleanString(profile.displayName, 40) || defaults.profile.displayName,
        avatarUrl,
        avatarUpdatedAt: avatarUrl && Number.isFinite(Date.parse(profile.avatarUpdatedAt))
          ? new Date(profile.avatarUpdatedAt).toISOString()
          : null,
        panX: clamp(profile.panX ?? defaults.profile.panX, -1, 1, defaults.profile.panX),
        panY: clamp(profile.panY ?? defaults.profile.panY, -1, 1, defaults.profile.panY),
        zoom: clamp(profile.zoom ?? defaults.profile.zoom, 1, 3, defaults.profile.zoom),
      },
      appearance: {
        theme: normalizeThemeMode(appearance.theme, defaults.appearance.theme),
        accent: normalizeHexColor(
          appearance.accent || legacyTheme.outlineColor,
          defaults.appearance.accent,
        ),
        background: normalizeHexColor(
          appearance.background || legacyTheme.backgroundColor,
          defaults.appearance.background,
        ),
        lightBackground: normalizeHexColor(
          appearance.lightBackground,
          defaults.appearance.lightBackground,
        ),
        border: normalizeHexColor(appearance.border, defaults.appearance.border),
        lightBorder: normalizeHexColor(appearance.lightBorder, defaults.appearance.lightBorder),
        focus: normalizeHexColor(appearance.focus, defaults.appearance.focus),
        lightFocus: normalizeHexColor(appearance.lightFocus, defaults.appearance.lightFocus),
        fontScale: clamp(
          appearance.fontScale ?? defaults.appearance.fontScale,
          0.85,
          1.3,
          defaults.appearance.fontScale,
        ),
        reducedMotion,
      },
      replay: {
        gridColumns: Math.round(clamp(
          replay.gridColumns ?? legacy.gridColumns ?? defaults.replay.gridColumns,
          1,
          6,
          defaults.replay.gridColumns,
        )),
        thumbnailPosition: clamp(
          replay.thumbnailPosition ?? defaults.replay.thumbnailPosition,
          0.1,
          0.9,
          defaults.replay.thumbnailPosition,
        ),
        cacheLimitMb: Math.round(clamp(
          replay.cacheLimitMb ?? defaults.replay.cacheLimitMb,
          64,
          4096,
          defaults.replay.cacheLimitMb,
        )),
        roots: cleanReplayRootList(replay.roots),
        relinkRoots: cleanReplayRootList(replay.relinkRoots, 8),
        archiveNew: replay.archiveNew === true,
        deleteFromDisk: replay.deleteFromDisk === true,
        dateFormat: ["system", "iso", "long", "short"].includes(replay.dateFormat)
          ? replay.dateFormat
          : defaults.replay.dateFormat,
        timeFormat: ["system", "12", "24"].includes(replay.timeFormat)
          ? replay.timeFormat
          : defaults.replay.timeFormat,
      },
      curves: {
        gridVisible: curves.gridVisible !== false,
        subdivisions: normalizeCurveGridSize(curves.subdivisions, defaults.curves.subdivisions),
        snapping: curves.snapping !== false,
        handleSize: Math.round(clamp(
          curves.handleSize ?? defaults.curves.handleSize,
          8,
          24,
          defaults.curves.handleSize,
        )),
        gridColor: normalizeHexColor(curves.gridColor, defaults.curves.gridColor),
        curveColor: normalizeHexColor(curves.curveColor, defaults.curves.curveColor),
        defaultMode: curves.defaultMode === "baked" ? "baked" : "native",
        sampleBudget: Math.round(clamp(
          curves.sampleBudget ?? defaults.curves.sampleBudget,
          8,
          240,
          defaults.curves.sampleBudget,
        )),
        warningThreshold: Math.round(clamp(
          curves.warningThreshold ?? defaults.curves.warningThreshold,
          16,
          1000,
          defaults.curves.warningThreshold,
        )),
      },
      quickApply: {
        favoritesFirst: quickApply.favoritesFirst !== false,
        grouping: ["type", "category", "none"].includes(quickApply.grouping)
          ? quickApply.grouping
          : defaults.quickApply.grouping,
        defaultMedia: ["auto", "video", "audio"].includes(quickApply.defaultMedia)
          ? quickApply.defaultMedia
          : defaults.quickApply.defaultMedia,
        recentLimit: Math.round(clamp(
          quickApply.recentLimit ?? defaults.quickApply.recentLimit,
          5,
          100,
          defaults.quickApply.recentLimit,
        )),
        // Retained in the persisted schema for backward compatibility. There is
        // no supported experimental Quick Apply runtime to enable.
        experimentalEnabled: false,
      },
    };
  }

  function validatePreferences(preferences) {
    const normalized = normalizePreferences(preferences);
    const errors = [];
    for (const path of [
      "profile.panX",
      "profile.panY",
      "profile.zoom",
      "appearance.fontScale",
      "replay.gridColumns",
      "replay.thumbnailPosition",
      "replay.cacheLimitMb",
      "curves.subdivisions",
      "curves.handleSize",
      "curves.sampleBudget",
      "curves.warningThreshold",
      "quickApply.recentLimit",
    ]) {
      const raw = getPath(preferences, path);
      if (raw !== undefined && raw !== null && raw !== "" && !Number.isFinite(Number(raw))) {
        errors.push(`${path} must be a finite number.`);
      }
    }
    if (!cleanString(preferences && preferences.profile && preferences.profile.displayName, 40)) {
      errors.push("Profile display name is required.");
    }
    const themeContrast = themeContrastReport(normalized.appearance);
    for (const mode of ["dark", "light"]) {
      const report = themeContrast.themes[mode];
      if (report.textMinimum < 4.5) {
        errors.push(`Background color for the ${mode} theme needs at least 4.5:1 contrast with Blocky Studios text across every supported surface (currently ${report.textMinimum.toFixed(2)}:1).`);
      }
      if (report.mutedMinimum < 4.5) {
        errors.push(`Background color for the ${mode} theme needs at least 4.5:1 contrast with Blocky Studios secondary text across every supported surface (currently ${report.mutedMinimum.toFixed(2)}:1).`);
      }
      if (report.focusMinimum < 3) {
        errors.push(`Focus color needs at least 3:1 contrast against the ${mode} background and control surfaces (currently ${report.focusMinimum.toFixed(2)}:1).`);
      }
      if (report.borderContrast < 1.15) {
        errors.push(`Border color for the ${mode} theme is too close to the background to distinguish controls.`);
      }
      if (report.accentContrast < 1.5) {
        errors.push(`Accent color is too close to the ${mode} background to distinguish active controls.`);
      }
    }
    const curveBackgrounds = [normalized.appearance.background, normalized.appearance.lightBackground];
    const curveContrast = Math.min(...curveBackgrounds.map(
      (background) => contrastRatio(normalized.curves.curveColor, background),
    ));
    if (curveContrast < 3) {
      errors.push("Curve color needs at least 3:1 contrast against both workspace backgrounds.");
    }
    const curveGridContrast = Math.min(...curveBackgrounds.map(
      (background) => contrastRatio(normalized.curves.gridColor, background),
    ));
    if (curveGridContrast < 1.15) {
      errors.push("Curve grid color is too close to a workspace background to remain visible.");
    }
    const curveSeparation = contrastRatio(normalized.curves.curveColor, normalized.curves.gridColor);
    if (curveSeparation < 1.5) {
      errors.push("Curve and grid colors need at least 1.5:1 contrast from each other.");
    }
    if (normalized.curves.warningThreshold < normalized.curves.sampleBudget) {
      errors.push("Curve warning threshold cannot be lower than the default sample budget.");
    }
    return { ok: errors.length === 0, errors, normalized };
  }

  function getPath(object, path) {
    return String(path).split(".").reduce((value, key) => value && value[key], object);
  }

  function setPath(object, path, value) {
    const keys = String(path).split(".");
    const leaf = keys.pop();
    let target = object;
    for (const key of keys) {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      target = target[key];
    }
    target[leaf] = value;
  }

  function profileInitials(displayName) {
    const words = cleanString(displayName, 40).split(/\s+/).filter(Boolean);
    if (words.length === 0) return "BS";
    return words.slice(0, 2).map((word) => word[0].toUpperCase()).join("");
  }

  function getDocumentThemeBinding(doc, values) {
    let binding = DOCUMENT_THEME_BINDINGS.get(doc);
    if (!binding) {
      binding = { values, mediaQuery: null, listener: null };
      const view = doc && (doc.defaultView || doc.parentWindow);
      if (view && typeof view.matchMedia === "function") {
        try {
          binding.mediaQuery = view.matchMedia("(prefers-color-scheme: light)");
        } catch (error) {
          binding.mediaQuery = null;
        }
      }
      DOCUMENT_THEME_BINDINGS.set(doc, binding);
    }
    binding.values = values;
    return binding;
  }

  function resolveDocumentTheme(values, binding) {
    if (values.appearance.theme === "light") return "light";
    if (values.appearance.theme === "system" && binding.mediaQuery) {
      return binding.mediaQuery.matches ? "light" : "dark";
    }
    return "dark";
  }

  function applyThemeTokensToDocument(values, doc, resolvedTheme) {
    const root = doc.documentElement;
    const darkAppearance = resolveDocumentAppearance(values.appearance, "dark");
    const lightAppearance = resolveDocumentAppearance(values.appearance, "light");
    const appearance = resolvedTheme === "light" ? lightAppearance : darkAppearance;
    const rgb = (color) => {
      const channel = hexToRgb(color);
      return `${channel.r}, ${channel.g}, ${channel.b}`;
    };
    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = values.appearance.theme;
    root.dataset.themeContrast = appearance.fallbackApplied ? "fallback" : "safe";
    root.style.setProperty("--bs-accent", appearance.accent);
    root.style.setProperty("--bs-dark-canvas", darkAppearance.activeBackground);
    root.style.setProperty("--bs-light-canvas", lightAppearance.activeBackground);
    root.style.setProperty("--bs-dark-border", darkAppearance.activeBorder);
    root.style.setProperty("--bs-light-border", lightAppearance.activeBorder);
    root.style.setProperty("--bs-focus", appearance.activeFocus);
    root.style.setProperty("--accent-color", appearance.accent);
    root.style.setProperty("--accent-rgb", rgb(appearance.accent));
    root.style.setProperty("--outline-color", appearance.accent);
    root.style.setProperty("--outline-rgb", rgb(appearance.accent));
    root.style.setProperty("--bg-color", appearance.activeBackground);
    root.style.setProperty("--bg-rgb", rgb(appearance.activeBackground));
    root.style.setProperty("--user-border-color", appearance.activeBorder);
    root.style.setProperty("--focus-color", appearance.activeFocus);
    root.style.setProperty(
      "--accent-foreground",
      contrastRatio("#000000", appearance.accent) >=
        contrastRatio("#FFFFFF", appearance.accent)
        ? "#000000"
        : "#FFFFFF",
    );
    root.style.setProperty("--oracle-font-scale", String(values.appearance.fontScale));
    root.dataset.reducedMotion = values.appearance.reducedMotion;
    if (typeof doc.querySelectorAll === "function") {
      const logoSource = BLOCKY_STUDIOS_LOGOS[resolvedTheme];
      for (const logo of doc.querySelectorAll("[data-blocky-brand-logo]")) {
        if (logo.getAttribute("src") !== logoSource) logo.setAttribute("src", logoSource);
      }
    }
  }

  function applyPreferencesToDocument(preferences, doc = document) {
    const values = normalizePreferences(preferences);
    const binding = getDocumentThemeBinding(doc, values);
    const applyCurrentTheme = () => {
      const currentValues = binding.values || values;
      applyThemeTokensToDocument(currentValues, doc, resolveDocumentTheme(currentValues, binding));
    };
    if (binding.mediaQuery && !binding.listener) {
      binding.listener = () => {
        if (binding.values && binding.values.appearance.theme === "system") applyCurrentTheme();
      };
      if (typeof binding.mediaQuery.addEventListener === "function") {
        binding.mediaQuery.addEventListener("change", binding.listener);
      } else if (typeof binding.mediaQuery.addListener === "function") {
        binding.mediaQuery.addListener(binding.listener);
      }
    }
    applyCurrentTheme();
    const avatarImage = doc.getElementById("profileAvatarImage");
    const avatarInitials = doc.getElementById("profileAvatarInitials");
    if (avatarImage && avatarInitials) {
      avatarInitials.textContent = profileInitials(values.profile.displayName);
      avatarImage.hidden = !values.profile.avatarUrl;
      avatarInitials.hidden = Boolean(values.profile.avatarUrl);
      if (values.profile.avatarUrl) {
        const revision = values.profile.avatarUpdatedAt
          ? encodeURIComponent(values.profile.avatarUpdatedAt)
          : "1";
        /** @type {HTMLImageElement} */ (avatarImage).src = `${values.profile.avatarUrl}?v=${revision}`;
      } else {
        avatarImage.removeAttribute("src");
      }
    }
    return values;
  }

  class PreferencesRepository {
    constructor(storage = typeof window !== "undefined" ? window.localStorage : null) {
      this.storage = storage;
    }

    load() {
      let source = null;
      let legacyTheme = null;
      let legacyGrid = null;
      try {
        const raw = this.storage && this.storage.getItem(PREFERENCES_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        source = parsed && parsed.schema === PREFERENCES_SCHEMA && parsed.version === PREFERENCES_VERSION
          ? parsed
          : null;
      } catch (error) {
        source = null;
      }
      try {
        const rawTheme = this.storage && this.storage.getItem(LEGACY_THEME_KEY);
        legacyTheme = rawTheme ? JSON.parse(rawTheme) : null;
      } catch (error) {
        legacyTheme = null;
      }
      try {
        const rawGrid = this.storage && this.storage.getItem(LEGACY_GRID_KEY);
        legacyGrid = rawGrid ? Number.parseInt(rawGrid, 10) : null;
      } catch (error) {
        legacyGrid = null;
      }
      return normalizePreferences(source, { theme: legacyTheme, gridColumns: legacyGrid });
    }

    save(preferences) {
      const validation = validatePreferences(preferences);
      if (!validation.ok) {
        throw new Error(validation.errors.join(" "));
      }
      if (!this.storage) throw new Error("Blocky Studios settings storage is unavailable.");
      this.storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(validation.normalized));
      return validation.normalized;
    }
  }

  function getUxpStorage() {
    try {
      const moduleName = "u" + "xp";
      const uxp = require(moduleName);
      return uxp && uxp.storage ? uxp.storage : null;
    } catch (error) {
      return null;
    }
  }

  function getUxpFs() {
    try {
      const moduleName = "f" + "s";
      return require(moduleName);
    } catch (error) {
      return null;
    }
  }

  async function chooseEntry(kind, options) {
    const storage = getUxpStorage();
    const picker = storage && storage.localFileSystem;
    if (!picker) throw new Error("Premiere's local file picker is unavailable.");
    if (kind === "open") return picker.getFileForOpening(options);
    if (kind === "save") return picker.getFileForSaving(options.suggestedName, options);
    if (kind === "folder") return picker.getFolder();
    throw new Error("Unknown file-picker request.");
  }

  async function readTextEntry(entry) {
    if (!entry || typeof entry.read !== "function") throw new Error("No file was selected.");
    const storage = getUxpStorage();
    return String(await entry.read({ format: storage.formats.utf8 }));
  }

  async function readEntryByteSize(entry) {
    if (!entry || (typeof entry !== "object" && typeof entry !== "function")) {
      throw new Error("Blocky Studios could not verify the selected file size before reading it.");
    }
    let rawSize;
    if (typeof entry.getMetadata === "function") {
      let metadata;
      try {
        metadata = await entry.getMetadata();
      } catch {
        throw new Error("Blocky Studios could not verify the selected file size before reading it.");
      }
      rawSize = metadata && metadata.size;
    } else {
      rawSize = entry.size;
    }
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Blocky Studios could not verify the selected file size before reading it.");
    }
    return size;
  }

  async function writeTextEntry(entry, text) {
    if (!entry || typeof entry.write !== "function") throw new Error("No writable file was selected.");
    const storage = getUxpStorage();
    await entry.write(String(text), { format: storage.formats.utf8 });
  }

  function readUint16BigEndian(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readUint24LittleEndian(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  }

  function readUint32BigEndian(bytes, offset) {
    return (
      (bytes[offset] * 0x1000000) +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]
    ) >>> 0;
  }

  function readUint32LittleEndian(bytes, offset) {
    return (
      bytes[offset] +
      (bytes[offset + 1] << 8) +
      (bytes[offset + 2] << 16) +
      (bytes[offset + 3] * 0x1000000)
    ) >>> 0;
  }

  function parsePngMetadata(bytes) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
    if (
      readUint32BigEndian(bytes, 8) !== 13 ||
      String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
    ) return null;
    return {
      mimeType: "image/png",
      width: readUint32BigEndian(bytes, 16),
      height: readUint32BigEndian(bytes, 20),
    };
  }

  function parseJpegMetadata(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset < bytes.length) {
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const segmentLength = readUint16BigEndian(bytes, offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
      const isStartOfFrame = (
        marker >= 0xc0 && marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      );
      if (isStartOfFrame) {
        if (segmentLength < 8) return null;
        return {
          mimeType: "image/jpeg",
          width: readUint16BigEndian(bytes, offset + 5),
          height: readUint16BigEndian(bytes, offset + 3),
        };
      }
      offset += segmentLength;
    }
    return null;
  }

  function parseWebpMetadata(bytes) {
    if (
      bytes.length < 30 ||
      String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
      String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP" ||
      readUint32LittleEndian(bytes, 4) + 8 > bytes.length
    ) return null;
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    const chunkSize = readUint32LittleEndian(bytes, 16);
    if (20 + chunkSize > bytes.length) return null;
    if (chunk === "VP8X" && chunkSize >= 10) {
      return {
        mimeType: "image/webp",
        width: readUint24LittleEndian(bytes, 24) + 1,
        height: readUint24LittleEndian(bytes, 27) + 1,
      };
    }
    if (
      chunk === "VP8 " && chunkSize >= 10 && bytes.length >= 30 &&
      bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
    ) {
      return {
        mimeType: "image/webp",
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && chunkSize >= 5 && bytes.length >= 25 && bytes[20] === 0x2f) {
      return {
        mimeType: "image/webp",
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
    }
    return null;
  }

  function avatarMetadataFromBytes(bytes) {
    return parsePngMetadata(bytes) || parseJpegMetadata(bytes) || parseWebpMetadata(bytes);
  }

  function validateAvatarBytes(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) {
      throw new Error("Profile image must be between 1 byte and 8 MB.");
    }
    const metadata = avatarMetadataFromBytes(bytes);
    if (!metadata) throw new Error("Choose a structurally valid PNG, JPEG, or WebP image with encoded dimensions.");
    const dimensions = validateAvatarDimensions(metadata.width, metadata.height);
    return { bytes, mimeType: metadata.mimeType, ...dimensions };
  }

  function validateAvatarDimensions(width, height) {
    const dimensions = { width: Number(width), height: Number(height) };
    if (
      !Number.isFinite(dimensions.width) ||
      !Number.isFinite(dimensions.height) ||
      dimensions.width < AVATAR_MIN_PIXELS ||
      dimensions.height < AVATAR_MIN_PIXELS ||
      dimensions.width > AVATAR_MAX_PIXELS ||
      dimensions.height > AVATAR_MAX_PIXELS ||
      dimensions.width * dimensions.height > AVATAR_MAX_TOTAL_PIXELS
    ) {
      throw new Error("Profile image dimensions must be between 64 and 8192 pixels per side and no more than 16 megapixels.");
    }
    return dimensions;
  }

  function calculateAvatarCrop(width, height, profile) {
    const dimensions = validateAvatarDimensions(width, height);
    const baseScale = Math.max(
      AVATAR_OUTPUT_PIXELS / dimensions.width,
      AVATAR_OUTPUT_PIXELS / dimensions.height,
    );
    const scale = baseScale * clamp(profile && profile.zoom, 1, 3, 1);
    const outputWidth = dimensions.width * scale;
    const outputHeight = dimensions.height * scale;
    return {
      x: (AVATAR_OUTPUT_PIXELS - outputWidth) / 2 +
        clamp(profile && profile.panX, -1, 1, 0) * AVATAR_OUTPUT_PIXELS * 0.45,
      y: (AVATAR_OUTPUT_PIXELS - outputHeight) / 2 +
        clamp(profile && profile.panY, -1, 1, 0) * AVATAR_OUTPUT_PIXELS * 0.45,
      width: outputWidth,
      height: outputHeight,
    };
  }

  async function loadAvatarEntry(entry) {
    if (!entry || typeof entry.read !== "function") throw new Error("No image was selected.");
    const storage = getUxpStorage();
    const binary = await entry.read({ format: storage.formats.binary });
    const { bytes, mimeType, width: encodedWidth, height: encodedHeight } = validateAvatarBytes(binary);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const image = new Image();
    const dimensions = await new Promise((resolve, reject) => {
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("Blocky Studios could not decode that profile image."));
      image.src = objectUrl;
    }).catch((error) => {
      URL.revokeObjectURL(objectUrl);
      throw error;
    });
    try {
      validateAvatarDimensions(dimensions.width, dimensions.height);
      if (dimensions.width !== encodedWidth || dimensions.height !== encodedHeight) {
        throw new Error("Profile image decoded dimensions do not match its encoded metadata.");
      }
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
    return { bytes, mimeType, objectUrl, image, ...dimensions };
  }

  function canvasPngBytes(imageState, profile) {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_OUTPUT_PIXELS;
    canvas.height = AVATAR_OUTPUT_PIXELS;
    const context = canvas.getContext("2d");
    if (!context || typeof canvas.toDataURL !== "function") {
      throw new Error("This UXP runtime cannot process profile images safely.");
    }
    const crop = calculateAvatarCrop(imageState.width, imageState.height, profile);
    context.clearRect(0, 0, AVATAR_OUTPUT_PIXELS, AVATAR_OUTPUT_PIXELS);
    context.drawImage(imageState.image, crop.x, crop.y, crop.width, crop.height);
    const dataUrl = canvas.toDataURL("image/png");
    const encoded = dataUrl.split(",")[1] || "";
    const decoded = atob(encoded);
    const output = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) output[index] = decoded.charCodeAt(index);
    return output;
  }

  function isMissingFsError(error) {
    const message = `${error && error.code ? error.code : ""} ${error && error.message ? error.message : error || ""}`;
    return /ENOENT|not\s+found|does\s+not\s+exist|no\s+such\s+file/i.test(message);
  }

  async function unlinkIfPresent(fs, url) {
    try {
      await fs.unlink(url);
      return true;
    } catch (error) {
      if (isMissingFsError(error)) return false;
      throw error;
    }
  }

  async function renameIfPresent(fs, source, destination) {
    try {
      await fs.rename(source, destination);
      return true;
    } catch (error) {
      if (isMissingFsError(error)) return false;
      throw error;
    }
  }

  async function stageAvatar(imageState, profile) {
    const fs = getUxpFs();
    if (
      !fs ||
      typeof fs.writeFile !== "function" ||
      typeof fs.rename !== "function" ||
      typeof fs.unlink !== "function"
    ) {
      throw new Error("Private plugin-data storage cannot commit profile images atomically.");
    }
    const bytes = canvasPngBytes(imageState, profile);
    await unlinkIfPresent(fs, AVATAR_TEMP_URL);
    await fs.writeFile(AVATAR_TEMP_URL, bytes);
    return { fs, url: AVATAR_URL, updatedAt: new Date().toISOString(), byteLength: bytes.byteLength };
  }

  async function beginAvatarFileTransaction(staged, remove) {
    const fs = staged ? staged.fs : getUxpFs();
    if (!fs || typeof fs.rename !== "function" || typeof fs.unlink !== "function") {
      throw new Error("Private plugin-data storage cannot update the profile image atomically.");
    }
    await unlinkIfPresent(fs, AVATAR_BACKUP_URL);
    const hadPrevious = await renameIfPresent(fs, AVATAR_URL, AVATAR_BACKUP_URL);
    let installedNew = false;
    try {
      if (!remove) {
        const installed = await renameIfPresent(fs, AVATAR_TEMP_URL, AVATAR_URL);
        if (!installed) throw new Error("The staged profile image disappeared before commit.");
        installedNew = true;
      }
    } catch (error) {
      if (hadPrevious) await renameIfPresent(fs, AVATAR_BACKUP_URL, AVATAR_URL);
      throw error;
    }
    let settled = false;
    return {
      async finalize() {
        if (settled) return;
        settled = true;
        await unlinkIfPresent(fs, AVATAR_BACKUP_URL);
        await unlinkIfPresent(fs, AVATAR_TEMP_URL);
      },
      async rollback() {
        if (settled) return;
        settled = true;
        if (installedNew) await unlinkIfPresent(fs, AVATAR_URL);
        if (hadPrevious) {
          const restored = await renameIfPresent(fs, AVATAR_BACKUP_URL, AVATAR_URL);
          if (!restored) throw new Error("Blocky Studios could not restore the previous profile image.");
        }
        await unlinkIfPresent(fs, AVATAR_TEMP_URL);
      },
    };
  }

  class ColorPickerController {
    constructor(popover, onChange) {
      this.popover = popover;
      this.onChange = onChange;
      this.token = null;
      this.originalColor = "#FFFFFF";
      this.defaultColor = "#FFFFFF";
      this.anchor = null;
      this.hsv = { h: 0, s: 0, v: 1 };
      this.dragging = false;
      this.plane = popover.querySelector("[data-color-plane]");
      this.thumb = popover.querySelector("[data-color-thumb]");
      this.saturation = popover.querySelector("[data-color-saturation]");
      this.brightness = popover.querySelector("[data-color-brightness]");
      this.saturationValue = popover.querySelector("[data-color-saturation-value]");
      this.brightnessValue = popover.querySelector("[data-color-brightness-value]");
      this.hue = popover.querySelector("[data-color-hue]");
      this.hex = popover.querySelector("[data-color-hex]");
      this.red = popover.querySelector("[data-color-red]");
      this.green = popover.querySelector("[data-color-green]");
      this.blue = popover.querySelector("[data-color-blue]");
      this.done = popover.querySelector("[data-color-done]");
      this.cancel = popover.querySelector("[data-color-cancel]");
      this.reset = popover.querySelector("[data-color-reset]");
      this.onPlanePointer = (event) => {
        if (event.type === "pointerdown") {
          this.dragging = true;
          if (this.plane.setPointerCapture) this.plane.setPointerCapture(event.pointerId);
        }
        if (!this.dragging && event.type === "pointermove") return;
        this.updatePlaneFromPointer(event);
      };
      this.onPlaneEnd = () => { this.dragging = false; };
      this.onSaturation = () => {
        this.hsv.s = clamp(Number(this.saturation.value) / 100, 0, 1);
        this.commitHsv();
      };
      this.onBrightness = () => {
        this.hsv.v = clamp(Number(this.brightness.value) / 100, 0, 1);
        this.commitHsv();
      };
      this.onHue = () => {
        this.hsv.h = Number(this.hue.value);
        this.commitHsv();
      };
      this.onHex = () => {
        const color = normalizeHexColor(this.hex.value, "");
        if (!color) {
          this.hex.setAttribute("aria-invalid", "true");
          return;
        }
        this.hex.removeAttribute("aria-invalid");
        this.setColor(color, true);
      };
      this.onRgb = () => this.setColor(rgbToHex(this.red.value, this.green.value, this.blue.value), true);
      this.onDone = () => this.close(true, true);
      this.onCancel = () => this.close(false, true);
      this.onReset = () => this.setColor(this.defaultColor, true);
    }

    start() {
      this.plane.addEventListener("pointerdown", this.onPlanePointer);
      this.plane.addEventListener("pointermove", this.onPlanePointer);
      this.plane.addEventListener("pointerup", this.onPlaneEnd);
      this.plane.addEventListener("pointercancel", this.onPlaneEnd);
      this.saturation.addEventListener("input", this.onSaturation);
      this.brightness.addEventListener("input", this.onBrightness);
      this.hue.addEventListener("input", this.onHue);
      this.hex.addEventListener("change", this.onHex);
      this.red.addEventListener("change", this.onRgb);
      this.green.addEventListener("change", this.onRgb);
      this.blue.addEventListener("change", this.onRgb);
      this.done.addEventListener("click", this.onDone);
      this.cancel.addEventListener("click", this.onCancel);
      this.reset.addEventListener("click", this.onReset);
    }

    open(token, color, anchor, defaultColor = color) {
      this.token = token;
      this.originalColor = normalizeHexColor(color, "#FFFFFF");
      this.defaultColor = normalizeHexColor(defaultColor, this.originalColor);
      this.anchor = anchor;
      this.setColor(this.originalColor, false);
      this.popover.hidden = false;
      this.popover.dataset.token = token;
      const anchorRect = anchor.getBoundingClientRect();
      // UXP's DOM does not currently expose `offsetParent` consistently. Keep
      // the picker anchored to its actual containing dialog instead of
      // throwing after the popover has already been made visible.
      const positioningContainer = this.popover.offsetParent || this.popover.parentElement;
      const panelRect = positioningContainer
        && typeof positioningContainer.getBoundingClientRect === "function"
        ? positioningContainer.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
      const desiredLeft = anchorRect.left - panelRect.left;
      const maximumLeft = Math.max(8, panelRect.width - 276);
      const popoverHeight = Math.max(300, Number(this.popover.offsetHeight) || 0);
      const maximumTop = Math.max(8, panelRect.height - popoverHeight - 8);
      const desiredTop = anchorRect.bottom - panelRect.top + 6;
      this.popover.style.left = `${clamp(desiredLeft, 8, maximumLeft)}px`;
      this.popover.style.top = `${clamp(desiredTop, 8, maximumTop, 8)}px`;
      this.saturation.focus();
    }

    close(commit, restoreFocus) {
      const token = this.token;
      if (!commit && token) this.onChange(token, this.originalColor);
      this.token = null;
      this.popover.hidden = true;
      this.dragging = false;
      if (restoreFocus && this.anchor && typeof this.anchor.focus === "function") this.anchor.focus();
      this.anchor = null;
    }

    setColor(color, notify) {
      const normalized = normalizeHexColor(color, "#FFFFFF");
      const rgb = hexToRgb(normalized);
      this.hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      this.sync(normalized, rgb);
      if (notify && this.token) this.onChange(this.token, normalized);
    }

    updatePlaneFromPointer(event) {
      const rect = this.plane.getBoundingClientRect();
      this.hsv.s = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      this.hsv.v = clamp(1 - (event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
      this.commitHsv();
    }

    commitHsv() {
      const rgb = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
      const color = rgbToHex(rgb.r, rgb.g, rgb.b);
      this.sync(color, hexToRgb(color));
      if (this.token) this.onChange(this.token, color);
    }

    sync(color, rgb) {
      this.plane.style.setProperty("--picker-hue", `hsl(${this.hsv.h}, 100%, 50%)`);
      this.thumb.style.left = `${this.hsv.s * 100}%`;
      this.thumb.style.top = `${(1 - this.hsv.v) * 100}%`;
      this.hue.value = String(Math.round(this.hsv.h));
      this.hex.value = color;
      this.red.value = String(rgb.r);
      this.green.value = String(rgb.g);
      this.blue.value = String(rgb.b);
      const saturation = Math.round(this.hsv.s * 100);
      const brightness = Math.round(this.hsv.v * 100);
      this.saturation.value = String(saturation);
      this.brightness.value = String(brightness);
      if (this.saturationValue) this.saturationValue.textContent = `${saturation}%`;
      if (this.brightnessValue) this.brightnessValue.textContent = `${brightness}%`;
      this.plane.setAttribute("aria-label", `Color plane preview: ${saturation}% saturation, ${brightness}% brightness, ${color}. Use the Saturation and Brightness sliders to adjust.`);
    }

    destroy() {
      this.plane.removeEventListener("pointerdown", this.onPlanePointer);
      this.plane.removeEventListener("pointermove", this.onPlanePointer);
      this.plane.removeEventListener("pointerup", this.onPlaneEnd);
      this.plane.removeEventListener("pointercancel", this.onPlaneEnd);
      this.saturation.removeEventListener("input", this.onSaturation);
      this.brightness.removeEventListener("input", this.onBrightness);
      this.hue.removeEventListener("input", this.onHue);
      this.hex.removeEventListener("change", this.onHex);
      this.red.removeEventListener("change", this.onRgb);
      this.green.removeEventListener("change", this.onRgb);
      this.blue.removeEventListener("change", this.onRgb);
      this.done.removeEventListener("click", this.onDone);
      this.cancel.removeEventListener("click", this.onCancel);
      this.reset.removeEventListener("click", this.onReset);
    }
  }

  class OraclePreferencesController {
    constructor(elements, options = {}) {
      this.elements = elements;
      const globalDocument = typeof document !== "undefined" ? document : null;
      const rootAnchor = elements && (elements.preferencesPanel || elements.preferencesToggle);
      const inferredRoot = rootAnchor && typeof rootAnchor.closest === "function"
        ? rootAnchor.closest("[data-oracle-panel-root], .oracle-panel")
        : null;
      this.root = options.root || inferredRoot || options.document || globalDocument;
      this.document = options.document || this.root && this.root.ownerDocument || globalDocument;
      this.repository = options.repository || new PreferencesRepository();
      this.onApply = typeof options.onApply === "function" ? options.onApply : () => undefined;
      this.onToast = typeof options.onToast === "function" ? options.onToast : () => undefined;
      this.onClearThumbnailCache = typeof options.onClearThumbnailCache === "function"
        ? options.onClearThumbnailCache
        : null;
      this.onExportMetadata = typeof options.onExportMetadata === "function"
        ? options.onExportMetadata
        : null;
      this.onImportMetadata = typeof options.onImportMetadata === "function"
        ? options.onImportMetadata
        : null;
      this.onResetMetadata = typeof options.onResetMetadata === "function"
        ? options.onResetMetadata
        : null;
      this.getStorageSummary = typeof options.getStorageSummary === "function"
        ? options.getStorageSummary
        : () => null;
      this.getDiagnosticsSummary = typeof options.getDiagnosticsSummary === "function"
        ? options.getDiagnosticsSummary
        : () => null;
      this.onDiagnostic = typeof options.onDiagnostic === "function"
        ? options.onDiagnostic
        : () => undefined;
      this.chooseEntry = typeof options.chooseEntry === "function" ? options.chooseEntry : chooseEntry;
      this.readTextEntry = typeof options.readTextEntry === "function" ? options.readTextEntry : readTextEntry;
      this.writeTextEntry = typeof options.writeTextEntry === "function" ? options.writeTextEntry : writeTextEntry;
      this.committed = createDefaultPreferences();
      this.draft = createDefaultPreferences();
      this.isOpen = false;
      this.activeSection = "profile";
      this.closeTimer = null;
      this.restoreFocus = null;
      this.avatarState = null;
      this.avatarRemoved = false;
      this.started = false;
      this.destroyed = false;
      this.committing = false;
      this.operationGeneration = 0;
      this.busyDisabledState = null;
      this.colorPicker = new ColorPickerController(elements.colorPopover, (token, color) => {
        setPath(this.draft, token, color);
        this.preview();
        this.syncColorControls();
      });
      this.onToggle = (event) => { event.preventDefault(); this.isOpen ? this.cancel() : this.open(); };
      this.onClose = (event) => { if (event) event.preventDefault(); this.cancel(); };
      this.onApplyClick = (event) => { event.preventDefault(); void this.apply(); };
      this.onPanelClick = (event) => this.handlePanelClick(event);
      this.onPanelInput = (event) => this.handlePanelInput(event);
      this.onPanelKeyDown = (event) => this.handlePanelKeyDown(event);
      this.onKeyDown = (event) => this.handleKeyDown(event);
      this.onDrawerOpening = () => this.cancel();
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.destroyed = false;
      this.committed = this.repository.load();
      this.draft = deepClone(this.committed);
      this.onApply(this.committed, { source: "startup", preview: false });
      this.elements.preferencesToggle.addEventListener("click", this.onToggle);
      this.elements.preferencesClose.addEventListener("click", this.onClose);
      this.elements.preferencesBackdrop.addEventListener("click", this.onClose);
      this.elements.preferencesCancel.addEventListener("click", this.onClose);
      this.elements.preferencesApply.addEventListener("click", this.onApplyClick);
      this.elements.preferencesPanel.addEventListener("click", this.onPanelClick);
      this.elements.preferencesPanel.addEventListener("input", this.onPanelInput);
      this.elements.preferencesPanel.addEventListener("change", this.onPanelInput);
      this.elements.preferencesPanel.addEventListener("keydown", this.onPanelKeyDown);
      if (this.document) {
        this.document.addEventListener("keydown", this.onKeyDown, true);
        this.document.addEventListener("oracle:shell-drawer-opening", this.onDrawerOpening);
      }
      this.colorPicker.start();
      this.syncAllControls();
    }

    open(section = "profile") {
      if (this.committing || this.destroyed) return;
      this.operationGeneration += 1;
      if (this.closeTimer !== null) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      this.cleanupAvatarState();
      this.avatarRemoved = false;
      this.draft = deepClone(this.committed);
      this.activeSection = section;
      this.restoreFocus = this.document && this.document.activeElement;
      this.isOpen = true;
      this.elements.preferencesPanel.hidden = false;
      this.elements.preferencesBackdrop.hidden = false;
      this.elements.preferencesToggle.setAttribute("aria-expanded", "true");
      if (this.document) this.document.dispatchEvent(new CustomEvent("oracle:preferences-opening"));
      this.syncAllControls();
      requestAnimationFrame(() => {
        if (!this.isOpen) return;
        this.elements.preferencesPanel.classList.add("is-open");
        this.elements.preferencesBackdrop.classList.add("is-open");
        const active = this.elements.preferencesPanel.querySelector(
          `[data-preferences-tab="${this.activeSection}"]`,
        );
        if (active) active.focus();
      });
    }

    close(restoreFocus = true) {
      this.isOpen = false;
      this.colorPicker.close(true, false);
      this.elements.preferencesPanel.classList.remove("is-open");
      this.elements.preferencesBackdrop.classList.remove("is-open");
      this.elements.preferencesToggle.setAttribute("aria-expanded", "false");
      if (this.closeTimer !== null) clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        if (!this.isOpen) {
          this.elements.preferencesPanel.hidden = true;
          this.elements.preferencesBackdrop.hidden = true;
        }
      }, DIALOG_TRANSITION_MS);
      if (restoreFocus) {
        const target = this.restoreFocus || this.elements.preferencesToggle;
        if (target && typeof target.focus === "function") target.focus();
      }
      this.restoreFocus = null;
    }

    cancel() {
      if (!this.isOpen || this.committing) return;
      this.operationGeneration += 1;
      this.draft = deepClone(this.committed);
      this.cleanupAvatarState();
      this.avatarRemoved = false;
      this.onApply(this.committed, { source: "cancel", preview: false });
      this.close(true);
    }

    async apply() {
      if (this.committing || this.destroyed) return;
      this.colorPicker.close(true, false);
      this.pullAllControls();
      const validation = validatePreferences(this.draft);
      if (!validation.ok) {
        this.showError(validation.errors.join(" "));
        return;
      }
      const generation = ++this.operationGeneration;
      this.committing = true;
      this.setBusy(true);
      let stagedAvatar = null;
      let avatarTransaction = null;
      let settingsSaved = false;
      try {
        const next = validation.normalized;
        if (this.avatarState) {
          stagedAvatar = await stageAvatar(this.avatarState, next.profile);
          this.assertOperationCurrent(generation);
          next.profile.avatarUrl = stagedAvatar.url;
          next.profile.avatarUpdatedAt = stagedAvatar.updatedAt;
          avatarTransaction = await beginAvatarFileTransaction(stagedAvatar, false);
          this.assertOperationCurrent(generation);
        } else if (this.avatarRemoved) {
          next.profile.avatarUrl = "";
          next.profile.avatarUpdatedAt = null;
          avatarTransaction = await beginAvatarFileTransaction(null, true);
          this.assertOperationCurrent(generation);
        }
        const saved = this.repository.save(next);
        settingsSaved = true;
        if (avatarTransaction) {
          try {
            await avatarTransaction.finalize();
          } catch (cleanupError) {
            this.onDiagnostic("warn", "AVATAR_BACKUP_CLEANUP_FAILED", {
              message: String(cleanupError && cleanupError.message || "Avatar backup cleanup failed."),
            });
          }
        }
        if (!this.isOperationCurrent(generation)) return;
        this.committed = saved;
        this.draft = deepClone(this.committed);
        this.onApply(this.committed, { source: "apply", preview: false });
        this.cleanupAvatarState();
        this.avatarRemoved = false;
        this.showError("");
        this.onToast("Preferences applied.", "success");
        this.close(true);
      } catch (error) {
        if (!settingsSaved && avatarTransaction) {
          try {
            await avatarTransaction.rollback();
          } catch (rollbackError) {
            this.onDiagnostic("error", "AVATAR_TRANSACTION_ROLLBACK_FAILED", {
              message: String(rollbackError && rollbackError.message || "Avatar rollback failed."),
            });
          }
        } else if (!avatarTransaction && stagedAvatar) {
          try {
            await unlinkIfPresent(stagedAvatar.fs, AVATAR_TEMP_URL);
          } catch (cleanupError) {
            this.onDiagnostic("warn", "AVATAR_STAGE_CLEANUP_FAILED", {
              message: String(cleanupError && cleanupError.message || "Avatar stage cleanup failed."),
            });
          }
        }
        if (this.isOperationCurrent(generation)) {
          this.showError(String(error && error.message ? error.message : error));
        }
      } finally {
        if (generation === this.operationGeneration) {
          this.committing = false;
          this.setBusy(false);
        }
      }
    }

    isOperationCurrent(generation) {
      return !this.destroyed && this.started && generation === this.operationGeneration;
    }

    assertOperationCurrent(generation) {
      if (!this.isOperationCurrent(generation)) {
        const error = /** @type {Error & { code?: string }} */ (
          new Error("Blocky Studios Preferences operation was cancelled.")
        );
        error.code = "PREFERENCES_OPERATION_CANCELLED";
        throw error;
      }
    }

    setBusy(busy) {
      this.elements.preferencesPanel.setAttribute("aria-busy", busy ? "true" : "false");
      const controls = Array.from(
        this.elements.preferencesPanel.querySelectorAll("button, input, select, textarea"),
      );
      if (busy) {
        this.busyDisabledState = new Map(controls.map((control) => [control, control.disabled]));
        for (const control of controls) control.disabled = true;
        return;
      }
      if (this.busyDisabledState) {
        for (const [control, disabled] of this.busyDisabledState) control.disabled = disabled;
      }
      this.busyDisabledState = null;
    }

    commitExternal(path, value) {
      const next = deepClone(this.committed);
      setPath(next, path, value);
      const saved = this.repository.save(next);
      this.committed = saved;
      if (this.isOpen) setPath(this.draft, path, getPath(saved, path));
      else this.draft = deepClone(saved);
      this.onApply(saved, { source: "external-control", preview: false });
      return getPath(saved, path);
    }

    preview() {
      this.onApply(normalizePreferences(this.draft), { source: "preview", preview: true });
      this.updateContrastStatus();
    }

    handleKeyDown(event) {
      if (!this.isOpen || event.defaultPrevented) return;
      if (!this.ownsKeyboardInteraction(event)) return;
      if (this.committing) {
        const target = event && event.target;
        const activeModal = target && typeof target.closest === "function"
          ? target.closest('[role="dialog"][aria-modal="true"]')
          : null;
        const preferencesPanel = this.elements && this.elements.preferencesPanel;
        const belongsToPreferences = activeModal && preferencesPanel && (
          activeModal === preferencesPanel ||
          (typeof preferencesPanel.contains === "function" && preferencesPanel.contains(activeModal))
        );
        if (activeModal && !belongsToPreferences) return;
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (this.colorPicker.token && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.colorPicker.close(false, true);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
        return;
      }
      const shellApi = typeof window !== "undefined" && Reflect.get(window, "OracleOverdriveShell");
      if (shellApi && typeof shellApi.trapTab === "function") {
        shellApi.trapTab(
          event,
          this.colorPicker.token ? this.elements.colorPopover : this.elements.preferencesPanel,
        );
      }
    }

    ownsKeyboardInteraction(event) {
      const root = this.root;
      const ownerDocument = this.document;
      if (!root || root === ownerDocument || typeof root.contains !== "function") return true;
      const target = event && event.target;
      if (target) return target === root || root.contains(target);
      const active = ownerDocument && ownerDocument.activeElement;
      return !active || active === root || root.contains(active);
    }

    handlePanelKeyDown(event) {
      const tab = event.target && event.target.closest
        ? event.target.closest("[data-preferences-tab]")
        : null;
      if (!tab || this.committing) return;
      const tabs = Array.from(
        this.elements.preferencesPanel.querySelectorAll("[data-preferences-tab]"),
      ).filter((entry) => !entry.disabled);
      const index = tabs.indexOf(tab);
      if (index < 0) return;
      let targetIndex = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") targetIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") targetIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") targetIndex = 0;
      else if (event.key === "End") targetIndex = tabs.length - 1;
      if (targetIndex === null) return;
      event.preventDefault();
      const target = tabs[targetIndex];
      this.showSection(target.dataset.preferencesTab);
      target.focus();
    }

    handlePanelClick(event) {
      const tab = event.target.closest("[data-preferences-tab]");
      if (tab) {
        event.preventDefault();
        this.showSection(tab.dataset.preferencesTab);
        return;
      }
      const colorButton = event.target.closest("[data-color-token]");
      if (colorButton) {
        event.preventDefault();
        const token = colorButton.dataset.colorToken;
        this.colorPicker.open(
          token,
          getPath(this.draft, token),
          colorButton,
          getPath(createDefaultPreferences(), token),
        );
        return;
      }
      const action = event.target.closest("[data-preferences-action]");
      if (!action || action.disabled) return;
      event.preventDefault();
      void this.performAction(action.dataset.preferencesAction);
    }

    handlePanelInput(event) {
      const control = event.target.closest("[data-pref]");
      if (!control) return;
      const path = control.dataset.pref;
      let value;
      if (control.type === "checkbox") value = control.checked;
      else if (control.type === "number" || control.type === "range") value = Number(control.value);
      else value = control.value;
      setPath(this.draft, path, value);
      if (path.startsWith("profile.")) this.syncAvatarPreview();
      this.preview();
      this.syncValueOutputs();
    }

    async performAction(action) {
      if (!this.isOpen || this.committing || this.destroyed) return;
      const generation = ++this.operationGeneration;
      const locksPanel = action === "import-metadata" ||
        action === "export-metadata" ||
        (action === "reset-section" && this.activeSection === "data");
      if (locksPanel) {
        this.committing = true;
        this.setBusy(true);
      }
      try {
        if (action === "choose-avatar") {
          const entry = await this.chooseEntry("open", { types: ["png", "jpg", "jpeg", "webp"], allowMultiple: false });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          const loaded = await loadAvatarEntry(entry);
          if (!this.isOperationCurrent(generation)) {
            URL.revokeObjectURL(loaded.objectUrl);
            return;
          }
          this.cleanupAvatarState();
          this.avatarState = loaded;
          this.avatarRemoved = false;
          this.draft.profile.panX = 0;
          this.draft.profile.panY = 0;
          this.draft.profile.zoom = 1;
          this.syncAllControls();
          return;
        }
        if (action === "remove-avatar") {
          this.cleanupAvatarState();
          this.avatarRemoved = true;
          this.draft.profile.avatarUrl = "";
          this.draft.profile.avatarUpdatedAt = null;
          this.syncAvatarPreview();
          return;
        }
        if (action === "reset-section") {
          if (this.activeSection === "data") {
            if (!this.onResetMetadata) throw new Error("Replay metadata reset is unavailable.");
            const result = await this.onResetMetadata();
            this.assertOperationCurrent(generation);
            if (!result || result.cancelled !== true) {
              this.updateStorageSummary();
              this.updateDiagnosticsSummary();
              this.onToast("Blocky Studios metadata reset. This metadata action did not delete source media.", "success");
            }
            return;
          }
          const defaults = createDefaultPreferences();
          const preferenceKey = this.activeSection === "replays" ? "replay" : this.activeSection;
          if (!Object.prototype.hasOwnProperty.call(defaults, preferenceKey)) {
            throw new Error("This diagnostics section has no preferences to reset.");
          }
          this.draft[preferenceKey] = deepClone(defaults[preferenceKey]);
          if (this.activeSection === "profile") {
            this.cleanupAvatarState();
            this.avatarRemoved = Boolean(this.committed.profile.avatarUrl);
          }
          this.syncAllControls();
          this.preview();
          return;
        }
        if (action === "export-theme") {
          const entry = await this.chooseEntry("save", { suggestedName: "Blocky-Studios-Theme.json", types: ["json"] });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          await this.writeTextEntry(entry, JSON.stringify({
            schema: "blocky-studios-theme-preset",
            version: 1,
            appearance: normalizePreferences(this.draft).appearance,
          }, null, 2));
          this.assertOperationCurrent(generation);
          this.onToast("Theme preset exported.", "success");
          return;
        }
        if (action === "import-theme") {
          const entry = await this.chooseEntry("open", { types: ["json"], allowMultiple: false });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          const text = await this.readTextEntry(entry);
          this.assertOperationCurrent(generation);
          if (text.length > IMPORT_MAX_CHARACTERS) throw new Error("Theme preset exceeds the 1 MB import limit.");
          const payload = JSON.parse(text);
          if (!payload || !["blocky-studios-theme-preset", "oracle-theme-preset"].includes(payload.schema) || payload.version !== 1) {
            throw new Error("That file is not a supported Blocky Studios theme preset.");
          }
          this.draft.appearance = normalizePreferences({ appearance: payload.appearance }).appearance;
          this.syncAllControls();
          this.preview();
          return;
        }
        if (action === "export-settings") {
          const entry = await this.chooseEntry("save", { suggestedName: "Blocky-Studios-Settings.json", types: ["json"] });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          const exportable = normalizePreferences(this.draft);
          exportable.profile.avatarUrl = exportable.profile.avatarUrl ? "private-avatar-present" : "";
          exportable.profile.avatarUpdatedAt = null;
          exportable.replay.roots = [];
          exportable.replay.relinkRoots = [];
          await this.writeTextEntry(entry, JSON.stringify(exportable, null, 2));
          this.assertOperationCurrent(generation);
          this.onToast("Settings exported without avatar bytes or private file paths.", "success");
          return;
        }
        if (action === "import-settings") {
          const entry = await this.chooseEntry("open", { types: ["json"], allowMultiple: false });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          const text = await this.readTextEntry(entry);
          this.assertOperationCurrent(generation);
          if (text.length > IMPORT_MAX_CHARACTERS) throw new Error("Settings file exceeds the 1 MB import limit.");
          const payload = JSON.parse(text);
          if (!payload || payload.schema !== PREFERENCES_SCHEMA || payload.version !== PREFERENCES_VERSION) {
            throw new Error("That settings file uses an unsupported schema or version.");
          }
          const importedValidation = validatePreferences(payload);
          if (!importedValidation.ok) throw new Error(importedValidation.errors.join(" "));
          const imported = importedValidation.normalized;
          imported.profile.avatarUrl = this.committed.profile.avatarUrl;
          imported.profile.avatarUpdatedAt = this.committed.profile.avatarUpdatedAt;
          this.draft = imported;
          this.syncAllControls();
          this.preview();
          return;
        }
        if (action === "export-metadata") {
          if (!this.onExportMetadata) throw new Error("Replay metadata export is unavailable.");
          const payload = await this.onExportMetadata();
          this.assertOperationCurrent(generation);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("Blocky Studios could not create a valid metadata export.");
          }
          const text = JSON.stringify(payload, null, 2);
          if (!text) throw new Error("Blocky Studios could not serialize replay metadata.");
          const entry = await this.chooseEntry("save", { suggestedName: "Blocky-Studios-Replay-Metadata.json", types: ["json"] });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          await this.writeTextEntry(entry, text);
          this.assertOperationCurrent(generation);
          this.onToast("Versioned replay metadata exported. The file contains private replay paths.", "success");
          return;
        }
        if (action === "import-metadata") {
          if (!this.onImportMetadata) throw new Error("Replay metadata import is unavailable.");
          const entry = await this.chooseEntry("open", { types: ["json"], allowMultiple: false });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          const byteSize = await readEntryByteSize(entry);
          this.assertOperationCurrent(generation);
          if (byteSize > METADATA_IMPORT_MAX_CHARACTERS) {
            throw new Error("Replay metadata exceeds the 32 MB import limit.");
          }
          const text = await this.readTextEntry(entry);
          this.assertOperationCurrent(generation);
          if (text.length > METADATA_IMPORT_MAX_CHARACTERS) {
            throw new Error("Replay metadata exceeds the 32 MB import limit.");
          }
          const result = await this.onImportMetadata(JSON.parse(text));
          this.assertOperationCurrent(generation);
          if (!result || result.cancelled !== true) {
            const replayCount = Math.max(0, Number(result && result.replayCount) || 0);
            const collectionCount = Math.max(0, Number(result && result.collectionCount) || 0);
            this.updateStorageSummary();
            this.onToast(
              `Imported ${replayCount} replay${replayCount === 1 ? "" : "s"} and ${collectionCount} collection${collectionCount === 1 ? "" : "s"}.`,
              "success",
            );
          }
          return;
        }
        if (action === "support-bundle") {
          const entry = await this.chooseEntry("save", { suggestedName: "Blocky-Studios-Support.json", types: ["json"] });
          this.assertOperationCurrent(generation);
          if (!entry) return;
          const settings = normalizePreferences(this.committed);
          const payload = {
            schema: "blocky-studios-support-bundle",
            version: 1,
            createdAt: new Date().toISOString(),
            pluginVersion: "2.0.15",
            preferencesVersion: settings.version,
            replayRootCount: settings.replay.roots.length,
            relinkRootCount: settings.replay.relinkRoots.length,
            avatarPresent: Boolean(settings.profile.avatarUrl),
            appearance: settings.appearance,
            diagnostics: this.readDiagnosticsSummary(),
          };
          await this.writeTextEntry(entry, JSON.stringify(payload, null, 2));
          this.assertOperationCurrent(generation);
          this.onToast("Privacy-safe support bundle exported.", "success");
          return;
        }
        if (action === "add-replay-root" || action === "add-relink-root") {
          const folder = await this.chooseEntry("folder", {});
          this.assertOperationCurrent(generation);
          if (!folder) return;
          const storage = getUxpStorage();
          const path = typeof storage.localFileSystem.getNativePath === "function"
            ? await storage.localFileSystem.getNativePath(folder)
            : folder.nativePath;
          this.assertOperationCurrent(generation);
          const cleanPath = normalizeReplayRoot(path);
          if (!cleanPath) throw new Error("Blocky Studios could not resolve the selected folder.");
          if (action === "add-relink-root") {
            this.draft.replay.relinkRoots = cleanReplayRootList([...this.draft.replay.relinkRoots, cleanPath], 8);
          } else {
            this.draft.replay.roots = cleanReplayRootList([...this.draft.replay.roots, cleanPath]);
          }
          this.syncRootList();
          return;
        }
        if (action === "clear-thumbnail-cache") {
          if (!this.onClearThumbnailCache) throw new Error("Thumbnail cache is unavailable.");
          await this.onClearThumbnailCache();
          this.assertOperationCurrent(generation);
          this.updateStorageSummary();
          return;
        }
        if (action.startsWith("remove-replay-root:")) {
          const index = Number.parseInt(action.split(":")[1], 10);
          this.draft.replay.roots.splice(index, 1);
          this.syncRootList();
          return;
        }
        if (action.startsWith("remove-relink-root:")) {
          const index = Number.parseInt(action.split(":")[1], 10);
          this.draft.replay.relinkRoots.splice(index, 1);
          this.syncRootList();
        }
      } catch (error) {
        if (this.isOperationCurrent(generation)) {
          this.showError(String(error && error.message ? error.message : error));
        }
      } finally {
        if (locksPanel && generation === this.operationGeneration) {
          this.committing = false;
          this.setBusy(false);
          this.showSection(this.activeSection);
        }
      }
    }

    showSection(section) {
      this.activeSection = section;
      for (const tab of this.elements.preferencesPanel.querySelectorAll("[data-preferences-tab]")) {
        const active = tab.dataset.preferencesTab === section;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
        tab.tabIndex = active ? 0 : -1;
      }
      for (const panel of this.elements.preferencesPanel.querySelectorAll("[data-preferences-section]")) {
        panel.hidden = panel.dataset.preferencesSection !== section;
      }
      if (section === "data") this.updateDiagnosticsSummary();
      const resetButton = this.elements.preferencesPanel.querySelector(
        '[data-preferences-action="reset-section"]',
      );
      if (resetButton) {
        resetButton.disabled = false;
        resetButton.title = section === "data"
          ? "Reset Blocky Studios metadata after an explicit confirmation. This metadata action does not delete source media."
          : "Reset this section to Blocky Studios defaults.";
      }
    }

    pullAllControls() {
      for (const control of this.elements.preferencesPanel.querySelectorAll("[data-pref]")) {
        let value;
        if (control.type === "checkbox") value = control.checked;
        else if (control.type === "number" || control.type === "range") value = Number(control.value);
        else value = control.value;
        setPath(this.draft, control.dataset.pref, value);
      }
    }

    syncAllControls() {
      for (const control of this.elements.preferencesPanel.querySelectorAll("[data-pref]")) {
        const value = getPath(this.draft, control.dataset.pref);
        if (control.type === "checkbox") control.checked = Boolean(value);
        else control.value = String(value ?? "");
      }
      this.showSection(this.activeSection);
      this.syncColorControls();
      this.syncAvatarPreview();
      this.syncRootList();
      this.syncValueOutputs();
      this.updateStorageSummary();
      this.updateDiagnosticsSummary();
      this.updateContrastStatus();
      this.showError("");
    }

    syncColorControls() {
      for (const control of this.elements.preferencesPanel.querySelectorAll("[data-color-token]")) {
        const color = getPath(this.draft, control.dataset.colorToken);
        control.style.setProperty("--swatch-color", color);
        const value = control.querySelector("[data-color-value]");
        if (value) value.textContent = color;
      }
    }

    syncAvatarPreview() {
      const image = this.elements.preferencesPanel.querySelector("[data-avatar-preview-image]");
      const initials = this.elements.preferencesPanel.querySelector("[data-avatar-preview-initials]");
      const source = this.avatarState
        ? this.avatarState.objectUrl
        : (!this.avatarRemoved ? this.draft.profile.avatarUrl : "");
      image.hidden = !source;
      initials.hidden = Boolean(source);
      initials.textContent = profileInitials(this.draft.profile.displayName);
      if (source) {
        image.src = source;
        image.style.transform = `translate(${this.draft.profile.panX * 45}%, ${this.draft.profile.panY * 45}%) scale(${this.draft.profile.zoom})`;
      } else {
        image.removeAttribute("src");
      }
      const remove = this.elements.preferencesPanel.querySelector('[data-preferences-action="remove-avatar"]');
      if (remove) remove.disabled = !source;
    }

    syncRootList() {
      const renderList = (selector, roots, actionPrefix, emptyMessage, labelPrefix) => {
        const list = this.elements.preferencesPanel.querySelector(selector);
        if (!list) return;
        replaceElementChildren(list);
        if (roots.length === 0) {
          const empty = this.document.createElement("li");
          empty.className = "preference-list__empty";
          empty.textContent = emptyMessage;
          list.appendChild(empty);
          return;
        }
        roots.forEach((path, index) => {
        const item = this.document.createElement("li");
        const label = this.document.createElement("span");
        label.textContent = path;
        label.title = path;
        const remove = this.document.createElement("button");
        remove.type = "button";
        remove.className = "oracle-button oracle-button--quiet";
        remove.dataset.preferencesAction = `${actionPrefix}:${index}`;
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove ${labelPrefix} ${index + 1}`);
        item.append(label, remove);
        list.appendChild(item);
      });
      };
      renderList(
        "[data-replay-roots]",
        this.draft.replay.roots,
        "remove-replay-root",
        "No additional replay roots configured.",
        "replay root",
      );
      renderList(
        "[data-relink-roots]",
        this.draft.replay.relinkRoots,
        "remove-relink-root",
        "No bounded relink search roots configured.",
        "relink root",
      );
    }

    syncValueOutputs() {
      for (const output of this.elements.preferencesPanel.querySelectorAll("[data-value-for]")) {
        const value = getPath(this.draft, output.dataset.valueFor);
        const suffix = output.dataset.valueSuffix || "";
        output.textContent = `${value}${suffix}`;
      }
    }

    updateStorageSummary() {
      const target = this.elements.preferencesPanel.querySelector("[data-storage-summary]");
      if (!target) return;
      let characters = 0;
      try {
        characters = JSON.stringify(this.committed).length;
      } catch (error) {
        characters = 0;
      }
      const cache = this.getStorageSummary();
      const cacheBytes = Math.max(0, Number(cache && cache.totalBytes) || 0);
      const cacheCount = Math.max(0, Number(cache && cache.count) || 0);
      const cacheMegabytes = cacheBytes / (1024 * 1024);
      target.textContent = `Settings ${characters.toLocaleString()} characters · thumbnail cache ${cacheMegabytes.toFixed(1)} MB across ${cacheCount} ${cacheCount === 1 ? "file" : "files"}`;
    }

    readDiagnosticsSummary() {
      try {
        return normalizeDiagnosticsSummary(this.getDiagnosticsSummary(), 20);
      } catch (error) {
        this.onDiagnostic("warn", "DIAGNOSTICS_SUMMARY_UNAVAILABLE", {});
        return normalizeDiagnosticsSummary(null, 20);
      }
    }

    updateDiagnosticsSummary() {
      const summaryTarget = this.elements.preferencesPanel.querySelector("[data-diagnostics-summary]");
      const recordsTarget = this.elements.preferencesPanel.querySelector("[data-diagnostics-records]");
      if (!summaryTarget && !recordsTarget) return;
      const summary = this.readDiagnosticsSummary();
      if (summaryTarget) {
        summaryTarget.textContent = summary.totalRetained === 0
          ? "No retained diagnostics. Records are bounded and console mirroring is off by default."
          : `${summary.totalRetained} of ${summary.capacity || 200} bounded records retained · latest sequence ${summary.latestSequence}`;
      }
      if (!recordsTarget) return;
      replaceElementChildren(recordsTarget);
      if (summary.records.length === 0) {
        const empty = this.document.createElement("li");
        empty.className = "preference-list__empty";
        empty.textContent = "No retained diagnostics.";
        recordsTarget.appendChild(empty);
        return;
      }
      for (const record of summary.records.slice().reverse()) {
        const item = this.document.createElement("li");
        item.dataset.level = record.level;
        const code = this.document.createElement("span");
        code.textContent = record.code;
        const metadata = this.document.createElement("span");
        const time = record.at > 0 ? new Date(record.at).toLocaleTimeString() : "session";
        metadata.textContent = `${record.level.toUpperCase()} · ${time}`;
        item.append(code, metadata);
        recordsTarget.appendChild(item);
      }
    }

    updateContrastStatus() {
      const status = this.elements.preferencesPanel.querySelector("[data-contrast-status]");
      const values = normalizePreferences(this.draft);
      if (status) {
        const report = themeContrastReport(values.appearance);
        const dark = report.themes.dark;
        const light = report.themes.light;
        status.textContent = `Dark text ${dark.textMinimum.toFixed(2)}:1 · Light text ${light.textMinimum.toFixed(2)}:1 · Focus ${Math.min(dark.focusMinimum, light.focusMinimum).toFixed(2)}:1 · Accent ${Math.min(dark.accentContrast, light.accentContrast).toFixed(2)}:1`;
        status.classList.toggle(
          "is-invalid",
          [dark, light].some((theme) => theme.textMinimum < 4.5 || theme.mutedMinimum < 4.5 || theme.focusMinimum < 3 || theme.accentContrast < 1.5),
        );
      }
      const curvesStatus = this.elements.preferencesPanel.querySelector("[data-curves-contrast-status]");
      if (curvesStatus) {
        const backgrounds = [values.appearance.background, values.appearance.lightBackground];
        const line = Math.min(...backgrounds.map((background) => contrastRatio(values.curves.curveColor, background)));
        const grid = Math.min(...backgrounds.map((background) => contrastRatio(values.curves.gridColor, background)));
        const separation = contrastRatio(values.curves.curveColor, values.curves.gridColor);
        curvesStatus.textContent = `Both themes · Curve ${line.toFixed(2)}:1 · Grid ${grid.toFixed(2)}:1 · Separation ${separation.toFixed(2)}:1`;
        curvesStatus.classList.toggle("is-invalid", line < 3 || grid < 1.15 || separation < 1.5);
      }
    }

    showError(message) {
      this.elements.preferencesError.textContent = message;
      this.elements.preferencesError.hidden = !message;
    }

    cleanupAvatarState() {
      if (this.avatarState && this.avatarState.objectUrl) {
        URL.revokeObjectURL(this.avatarState.objectUrl);
      }
      this.avatarState = null;
    }

    destroy() {
      if (!this.started) return;
      this.started = false;
      this.destroyed = true;
      this.operationGeneration += 1;
      this.committing = false;
      this.setBusy(false);
      if (this.closeTimer !== null) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      if (this.isOpen) {
        this.draft = deepClone(this.committed);
        this.onApply(this.committed, { source: "destroy", preview: false });
      }
      this.isOpen = false;
      this.colorPicker.close(true, false);
      this.elements.preferencesPanel.classList.remove("is-open");
      this.elements.preferencesBackdrop.classList.remove("is-open");
      this.elements.preferencesPanel.hidden = true;
      this.elements.preferencesBackdrop.hidden = true;
      this.elements.preferencesToggle.setAttribute("aria-expanded", "false");
      this.restoreFocus = null;
      this.cleanupAvatarState();
      this.colorPicker.destroy();
      this.elements.preferencesToggle.removeEventListener("click", this.onToggle);
      this.elements.preferencesClose.removeEventListener("click", this.onClose);
      this.elements.preferencesBackdrop.removeEventListener("click", this.onClose);
      this.elements.preferencesCancel.removeEventListener("click", this.onClose);
      this.elements.preferencesApply.removeEventListener("click", this.onApplyClick);
      this.elements.preferencesPanel.removeEventListener("click", this.onPanelClick);
      this.elements.preferencesPanel.removeEventListener("input", this.onPanelInput);
      this.elements.preferencesPanel.removeEventListener("change", this.onPanelInput);
      this.elements.preferencesPanel.removeEventListener("keydown", this.onPanelKeyDown);
      if (this.document) {
        this.document.removeEventListener("keydown", this.onKeyDown, true);
        this.document.removeEventListener("oracle:shell-drawer-opening", this.onDrawerOpening);
      }
    }
  }

  return {
    AVATAR_MAX_BYTES,
    AVATAR_MAX_TOTAL_PIXELS,
    AVATAR_URL,
    PREFERENCES_SCHEMA,
    PREFERENCES_STORAGE_KEY,
    PREFERENCES_VERSION,
    ColorPickerController,
    OraclePreferencesController,
    PreferencesRepository,
    applyPreferencesToDocument,
    avatarMetadataFromBytes,
    beginAvatarFileTransaction,
    calculateAvatarCrop,
    contrastRatio,
    createDefaultPreferences,
    hexToRgb,
    hsvToRgb,
    normalizeHexColor,
    normalizeDiagnosticsSummary,
    normalizePreferences,
    normalizeReplayRoot,
    profileInitials,
    rgbToHex,
    rgbToHsv,
    themeContrastReport,
    validateAvatarBytes,
    validateAvatarDimensions,
    validatePreferences,
  };
});
