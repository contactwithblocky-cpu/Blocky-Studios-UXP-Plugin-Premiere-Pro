"use strict";

(function exposeOracleReplayLibrary(globalScope, factory) {
  const schema = typeof module === "object" && module && module.exports
    ? require("../data/oracle-data-schema.js")
    : globalScope && Reflect.get(globalScope, "OracleDataSchema");
  const migrations = typeof module === "object" && module && module.exports
    ? require("../data/oracle-migrations.js")
    : globalScope && Reflect.get(globalScope, "OracleDataMigrations");
  const api = factory(schema, migrations);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleReplayLibrary", api);
})(typeof window !== "undefined" ? window : null, function createOracleReplayLibraryApi(schema, migrations) {
  if (!schema || !migrations) throw new Error("Oracle replay data dependencies did not load.");

  const STATE_URL = "plugin-data:/oracle-state.v3.json";
  const STATE_TEMP_URL = "plugin-data:/oracle-state.v3.tmp.json";
  const STATE_BACKUP_URL = "plugin-data:/oracle-state.v3.backup.json";
  const THUMBNAIL_INDEX_URL = "plugin-data:/oracle-thumbnails.v1.json";
  const THUMBNAIL_INDEX_TEMP_URL = "plugin-data:/oracle-thumbnails.v1.tmp.json";
  const THUMBNAIL_SCHEMA_VERSION = 1;
  const BRIDGE_EVENT_SCHEMA = "com.blocky.oracle.replay-event";
  const BRIDGE_EVENT_VERSION = 2;
  const REPLAY_METADATA_EXPORT_SCHEMA = "com.blocky.oracle.replay-metadata-export";
  const REPLAY_METADATA_EXPORT_VERSION = 1;
  const MAX_EVENT_BYTES = 12 * 1024 * 1024;
  const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
  const MAX_THUMBNAIL_INDEX_CHARACTERS = 4 * 1024 * 1024;
  const MAX_THUMBNAIL_INDEX_ENTRIES = 10000;
  const MAX_THUMBNAIL_INDEX_TOTAL_BYTES = 4096 * 1024 * 1024;
  const MIN_THUMBNAIL_DIMENSION = 64;
  const MAX_THUMBNAIL_DIMENSION = 4096;
  const MAX_THUMBNAIL_PIXELS = 4096 * 2304;
  const THUMBNAIL_JPEG_QUALITY = 0.86;
  const THUMBNAIL_ENCODE_TIMEOUT_MS = 10000;
  const MAX_DIAGNOSTICS = 200;
  const MAX_DEDUP_EVENTS = 4096;
  const SUPPORTED_MEDIA_EXTENSIONS = new Set([
    ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv",
  ]);

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  const RAW_IMAGE_SUBJECT_PATTERN = /(?:thumbnail|thumb|image|img|bitmap|picture|photo|jpeg|jpg|png|webp|gif|preview|poster|cover|artwork|avatar|icon|logo|screenshot|framegrab|still)/;
  const RAW_IMAGE_PAYLOAD_HINT_PATTERN = /(?:base64|dataurl|bytes?|bytearray|binary|blob|buffer|payload|rawdata|encodeddata|data|raw|encoded)$/;
  const BARE_IMAGE_FIELD_KEYS = new Set([
    "thumbnail", "thumb", "image", "img", "bitmap", "picture", "photo",
    "jpeg", "jpg", "png", "webp", "gif", "preview", "previewimage",
    "poster", "posterframe", "cover", "coverart", "artwork",
    "avatar", "icon", "logo", "screenshot", "framegrab", "still",
  ]);

  function normalizedMetadataKey(key) {
    return String(key || "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  }

  function metadataPath(parentPath, key, arrayIndex = false) {
    if (arrayIndex) return `${parentPath}[${key}]`;
    const property = String(key);
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
      ? `${parentPath}.${property}`
      : `${parentPath}[${JSON.stringify(property)}]`;
  }

  function isExplicitRawImagePayloadAlias(key) {
    const normalized = normalizedMetadataKey(key);
    if (!normalized) return false;
    const mentionsImage = RAW_IMAGE_SUBJECT_PATTERN.test(normalized);
    return mentionsImage && (
      RAW_IMAGE_PAYLOAD_HINT_PATTERN.test(normalized) ||
      /^(?:raw|encoded)(?:thumbnail|image|bitmap|jpeg|jpg|png|webp|gif)/.test(normalized)
    );
  }

  function isBareImageField(key) {
    return BARE_IMAGE_FIELD_KEYS.has(normalizedMetadataKey(key));
  }

  function declaresImageMime(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    for (const key of ["mime", "mimeType", "mediaType", "contentType", "type"]) {
      if (/^image\//i.test(String(value[key] || "").trim())) return true;
    }
    return false;
  }

  function isByteArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every((entry) => (
      Number.isInteger(entry) && entry >= 0 && entry <= 255
    ));
  }

  function isBinaryLikeValue(value) {
    if (isByteArray(value)) return true;
    if (typeof ArrayBuffer !== "undefined") {
      if (value instanceof ArrayBuffer) return value.byteLength > 0;
      if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return value.byteLength > 0;
    }
    if (
      value &&
      typeof value === "object" &&
      normalizedMetadataKey(value.type) === "buffer" &&
      isByteArray(value.data)
    ) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (
        entries.length > 0 &&
        entries.every(([key, entry], index) => key === String(index) && Number.isInteger(entry) && entry >= 0 && entry <= 255)
      ) return true;
    }
    return false;
  }

  function isRawImageString(value, imageContext = false) {
    if (typeof value !== "string") return false;
    const compact = value.trim().replace(/\s+/g, "");
    if (!compact) return false;
    if (/^data:image\//i.test(compact)) return true;
    if (!imageContext) return false;
    if (/^(?:blob:|image\/[^;,]+;base64,)/i.test(compact)) return true;
    const encoded = compact.replace(/^base64,/i, "");
    if (encoded.length < 8 || encoded.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) {
      return false;
    }
    return true;
  }

  function isPresentPayload(value) {
    return value !== null && value !== undefined && value !== "";
  }

  function isRawImagePayloadField(key, value, imageContext = false) {
    if (isExplicitRawImagePayloadAlias(key)) return isPresentPayload(value);
    const fieldContext = imageContext || isBareImageField(key);
    return isRawImageString(value, fieldContext) || (fieldContext && isBinaryLikeValue(value));
  }

  function rawImagePayloadFindings(value, rootPath = "$.state") {
    const findings = [];
    const ancestors = new Set();

    function visit(candidate, path, imageContext = false) {
      if (!candidate || typeof candidate !== "object") return;
      if (ancestors.has(candidate)) return;
      ancestors.add(candidate);
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          visit(candidate[index], metadataPath(path, index, true), imageContext);
        }
      } else {
        const containerImageContext = imageContext || declaresImageMime(candidate);
        for (const [key, nestedValue] of Object.entries(candidate)) {
          const nestedPath = metadataPath(path, key);
          if (isRawImagePayloadField(key, nestedValue, containerImageContext)) {
            findings.push({ path: nestedPath, reason: `raw image payload field ${key}` });
            continue;
          }
          visit(nestedValue, nestedPath, containerImageContext || isBareImageField(key));
        }
      }
      ancestors.delete(candidate);
    }

    visit(value, rootPath);
    return findings;
  }

  function cloneWithoutRawImagePayloads(value) {
    const ancestors = new Set();

    function sanitize(candidate, imageContext = false) {
      if (!candidate || typeof candidate !== "object") return candidate;
      if (ancestors.has(candidate)) throw new TypeError("Replay metadata state contains a cyclic value.");
      ancestors.add(candidate);
      let sanitized;
      if (Array.isArray(candidate)) {
        sanitized = candidate.map((entry) => sanitize(entry, imageContext));
      } else {
        sanitized = Object.create(null);
        const containerImageContext = imageContext || declaresImageMime(candidate);
        for (const [key, nestedValue] of Object.entries(candidate)) {
          if (isExplicitRawImagePayloadAlias(key)) continue;
          if (isRawImagePayloadField(key, nestedValue, containerImageContext)) continue;
          sanitized[key] = sanitize(nestedValue, containerImageContext || isBareImageField(key));
        }
      }
      ancestors.delete(candidate);
      return sanitized;
    }

    return JSON.parse(JSON.stringify(sanitize(value)));
  }

  function unsupportedReplayMediaFindings(state) {
    const findings = [];
    for (const [id, record] of Object.entries(state && state.replaysById || {})) {
      if (isSupportedMediaPath(record && record.canonicalPath)) continue;
      findings.push({
        id,
        path: metadataPath(metadataPath("$.state.replaysById", id), "canonicalPath"),
        canonicalPath: String(record && record.canonicalPath || ""),
      });
    }
    return findings;
  }

  function createReplayMetadataExport(state, options = {}) {
    const validation = schema.validateOracleState(state);
    if (!validation.ok) {
      const error = /** @type {TypeError & { code?: string, diagnostics?: Array<object>, cause?: unknown }} */ (
        new TypeError(`Replay metadata export requires valid Oracle v3 state: ${validation.errors.join("; ")}`)
      );
      error.code = "INVALID_METADATA_STATE";
      error.diagnostics = validation.errors.map((message) => ({ code: "INVALID_V3_SNAPSHOT", message }));
      throw error;
    }
    const exportedAt = schema.normalizeIsoTimestamp(options.exportedAt || new Date().toISOString(), null);
    if (!exportedAt) {
      const error = /** @type {TypeError & { code?: string, diagnostics?: Array<object>, cause?: unknown }} */ (
        new TypeError("Replay metadata export requires a valid ISO exportedAt timestamp.")
      );
      error.code = "INVALID_METADATA_EXPORTED_AT";
      throw error;
    }
    let sanitizedState;
    try {
      sanitizedState = cloneWithoutRawImagePayloads(state);
    } catch (cause) {
      const error = /** @type {TypeError & { code?: string, diagnostics?: Array<object>, cause?: unknown }} */ (
        new TypeError("Replay metadata state must be JSON-serializable.")
      );
      error.code = "INVALID_METADATA_STATE";
      error.cause = cause;
      throw error;
    }
    const sanitizedValidation = schema.validateOracleState(sanitizedState);
    if (!sanitizedValidation.ok) {
      const error = /** @type {TypeError & { code?: string, diagnostics?: Array<object>, cause?: unknown }} */ (
        new TypeError(`Replay metadata state became invalid after live-only payload removal: ${sanitizedValidation.errors.join("; ")}`)
      );
      error.code = "INVALID_METADATA_STATE";
      error.diagnostics = sanitizedValidation.errors.map((message) => ({ code: "INVALID_SANITIZED_SNAPSHOT", message }));
      throw error;
    }
    return {
      schema: REPLAY_METADATA_EXPORT_SCHEMA,
      version: REPLAY_METADATA_EXPORT_VERSION,
      pluginVersion: schema.cleanString(options.pluginVersion, 64) || "unknown",
      exportedAt,
      state: sanitizedState,
    };
  }

  function metadataImportFailure(code, message, diagnostics = []) {
    return { ok: false, code, message, diagnostics: clone(diagnostics) || [] };
  }

  function normalizeReplayMetadataImport(payload, options = {}) {
    let envelope = payload;
    if (typeof envelope === "string") {
      try {
        envelope = JSON.parse(envelope);
      } catch (error) {
        return metadataImportFailure(
          "MALFORMED_METADATA_EXPORT",
          "Replay metadata import is not valid JSON.",
          [{ code: "METADATA_JSON_PARSE_FAILED", message: String(error && error.message ? error.message : error) }],
        );
      }
    }
    if (!schema.isPlainObject(envelope)) {
      return metadataImportFailure(
        "MALFORMED_METADATA_EXPORT",
        "Replay metadata import must be a versioned object.",
      );
    }
    if (envelope.schema !== REPLAY_METADATA_EXPORT_SCHEMA) {
      return metadataImportFailure(
        "UNSUPPORTED_METADATA_SCHEMA",
        "Replay metadata import uses an unsupported schema.",
      );
    }
    if (envelope.version !== REPLAY_METADATA_EXPORT_VERSION) {
      return metadataImportFailure(
        "UNSUPPORTED_METADATA_VERSION",
        "Replay metadata import uses an unsupported envelope version.",
      );
    }
    const pluginVersion = schema.cleanString(envelope.pluginVersion, 64);
    if (typeof envelope.pluginVersion !== "string" || !pluginVersion || pluginVersion !== envelope.pluginVersion) {
      return metadataImportFailure(
        "MALFORMED_METADATA_EXPORT",
        "Replay metadata import is missing its plugin version.",
      );
    }
    if (schema.normalizeIsoTimestamp(envelope.exportedAt, null) !== envelope.exportedAt) {
      return metadataImportFailure(
        "MALFORMED_METADATA_EXPORT",
        "Replay metadata import has an invalid export timestamp.",
      );
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, "state")) {
      return metadataImportFailure(
        "MALFORMED_METADATA_EXPORT",
        "Replay metadata import is missing its state snapshot.",
      );
    }
    const rawImageFindings = rawImagePayloadFindings(envelope, "$");
    if (rawImageFindings.length > 0) {
      return metadataImportFailure(
        "LOSSY_METADATA_IMPORT",
        "Replay metadata contains live-only image bytes and cannot be imported without data loss.",
        rawImageFindings.map((finding) => ({
          code: "RAW_THUMBNAIL_DROPPED",
          path: finding.path,
          message: `Raw thumbnail or image bytes at ${finding.path} are not part of durable Oracle metadata.`,
        })),
      );
    }

    const source = envelope.state;
    const isCurrentState = schema.isPlainObject(source) &&
      source.schema === schema.ORACLE_STATE_SCHEMA &&
      source.version === schema.ORACLE_STATE_VERSION;
    if (isCurrentState) {
      const validation = schema.validateOracleState(source);
      if (!validation.ok) {
        return metadataImportFailure(
          "INVALID_METADATA_STATE",
          "Replay metadata contains an invalid Oracle v3 state snapshot.",
          validation.errors.map((message) => ({ code: "INVALID_V3_SNAPSHOT", message })),
        );
      }
      const unsupportedMedia = unsupportedReplayMediaFindings(source);
      if (unsupportedMedia.length > 0) {
        return metadataImportFailure(
          "UNSUPPORTED_METADATA_MEDIA",
          "Replay metadata contains paths with unsupported media extensions.",
          unsupportedMedia.map((finding) => ({
            code: "UNSUPPORTED_REPLAY_MEDIA",
            path: finding.path,
            message: `Replay path at ${finding.path} must use a supported media extension.`,
          })),
        );
      }
      let state;
      try {
        state = clone(source);
      } catch (error) {
        return metadataImportFailure(
          "MALFORMED_METADATA_EXPORT",
          "Replay metadata state must be JSON-serializable.",
          [{ code: "METADATA_STATE_CLONE_FAILED", message: String(error && error.message ? error.message : error) }],
        );
      }
      return {
        ok: true,
        schema: envelope.schema,
        version: envelope.version,
        pluginVersion,
        exportedAt: envelope.exportedAt,
        state,
        diagnostics: [],
        migrated: false,
      };
    }

    let migrated;
    try {
      migrated = migrations.migrateOracleState(source, {
        writtenAt: envelope.exportedAt,
        writerId: schema.cleanString(options.writerId, 128) || "oracle-metadata-import",
      });
    } catch (error) {
      return metadataImportFailure(
        "INVALID_METADATA_STATE",
        "Replay metadata migration failed.",
        [{ code: "METADATA_MIGRATION_EXCEPTION", message: String(error && error.message ? error.message : error) }],
      );
    }
    if (!migrated || !migrated.sourceValid) {
      return metadataImportFailure(
        "INVALID_METADATA_STATE",
        "Replay metadata does not contain a supported Oracle state snapshot.",
        migrated && migrated.diagnostics,
      );
    }
    const migrationDiagnostics = Array.isArray(migrated.diagnostics) ? migrated.diagnostics : [];
    const hasLossyDiagnostic = migrationDiagnostics.some((entry) => (
      !entry || entry.code !== "LEGACY_STATE_MIGRATED"
    ));
    if (!migrated.complete || hasLossyDiagnostic) {
      return metadataImportFailure(
        "LOSSY_METADATA_IMPORT",
        "Replay metadata migration would omit or alter unsupported records.",
        migrationDiagnostics,
      );
    }
    const migratedValidation = schema.validateOracleState(migrated.state);
    if (!migratedValidation.ok) {
      return metadataImportFailure(
        "INVALID_METADATA_STATE",
        "Replay metadata migration did not produce valid Oracle v3 state.",
        migratedValidation.errors.map((message) => ({ code: "INVALID_MIGRATED_SNAPSHOT", message })),
      );
    }
    const unsupportedMedia = unsupportedReplayMediaFindings(migrated.state);
    if (unsupportedMedia.length > 0) {
      return metadataImportFailure(
        "UNSUPPORTED_METADATA_MEDIA",
        "Replay metadata contains paths with unsupported media extensions.",
        unsupportedMedia.map((finding) => ({
          code: "UNSUPPORTED_REPLAY_MEDIA",
          path: finding.path,
          message: `Replay path at ${finding.path} must use a supported media extension.`,
        })),
      );
    }
    return {
      ok: true,
      schema: envelope.schema,
      version: envelope.version,
      pluginVersion,
      exportedAt: envelope.exportedAt,
      state: clone(migrated.state),
      diagnostics: clone(migrationDiagnostics),
      migrated: true,
    };
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (!value || typeof value !== "object") return JSON.stringify(value);
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }

  function finite(value, fallback = null, minimum = -Infinity, maximum = Infinity) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function timestamp(value, fallback) {
    return schema.normalizeIsoTimestamp(value, fallback);
  }

  function sourceName(filepath) {
    const parts = schema.normalizeWindowsPath(filepath).split("\\");
    return schema.cleanString(String(parts[parts.length - 1] || "").replace(/\.[^.]+$/, ""), 260);
  }

  function mediaExtension(filepath) {
    const match = schema.normalizeWindowsPath(filepath).match(/(\.[^.\\]+)$/);
    return match ? match[1].toLocaleLowerCase("en-US") : "";
  }

  function isSupportedMediaPath(filepath) {
    return schema.isAbsoluteWindowsPath(filepath) && SUPPORTED_MEDIA_EXTENSIONS.has(mediaExtension(filepath));
  }

  function nestedPayload(message) {
    if (!message || typeof message !== "object") return {};
    for (const key of ["payload", "data", "export", "render"]) {
      if (message[key] && typeof message[key] === "object" && !Array.isArray(message[key])) {
        return message[key];
      }
    }
    return {};
  }

  function eventName(message) {
    return String(message && (message.event || message.type || message.action) || "")
      .trim()
      .toLocaleUpperCase("en-US");
  }

  function normalizeFileIdentity(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string" || typeof value === "number") {
      const key = schema.cleanString(value, 512);
      return key ? { key } : null;
    }
    if (!schema.isPlainObject(value)) return null;
    const normalized = {};
    for (const key of Object.keys(value).sort().slice(0, 16)) {
      const cleanKey = schema.cleanString(key, 64);
      const cleanValue = schema.cleanString(value[key], 256);
      if (cleanKey && cleanValue) normalized[cleanKey] = cleanValue;
    }
    return Object.keys(normalized).length ? normalized : null;
  }

  function fileIdentityKey(value) {
    const identity = normalizeFileIdentity(value);
    return identity ? stableJson(identity).toLocaleLowerCase("en-US") : "";
  }

  function physicalFingerprint(record) {
    const identity = fileIdentityKey(record && record.fileIdentity);
    const path = schema.replayPathKey(record && record.canonicalPath);
    const size = finite(record && record.fileSize, null, 0);
    const modified = timestamp(record && record.modifiedAt, null);
    const observation = size !== null || modified
      ? `observation:${size ?? "?"}|${modified || "?"}`
      : `export:${timestamp(record && record.exportedAt, schema.EMPTY_TIMESTAMP)}`;
    // A native file identity is stable across later size/mtime observations.
    // Once it is available, path + identity is the physical export key; the
    // mutable observation remains the fallback only when identity is absent.
    return identity ? `${path}|identity:${identity}` : `${path}|${observation}`;
  }

  function normalizeThumbnailBase64(value) {
    const input = String(value || "").trim().replace(/^data:image\/jpeg;base64,/i, "").replace(/\s+/g, "");
    if (!input || input.length > Math.ceil(MAX_THUMBNAIL_BYTES * 4 / 3) + 8) return "";
    if (input.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(input)) return "";
    return input.startsWith("/9j/") ? input : "";
  }

  function bridgePayloadSize(message) {
    try {
      return JSON.stringify(message).length;
    } catch (error) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function normalizeBridgeReplay(message, options = {}) {
    const now = timestamp(options.now || new Date().toISOString(), schema.EMPTY_TIMESTAMP);
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, code: "INVALID_MESSAGE", message: "Replay event must be an object." };
    }
    if (bridgePayloadSize(message) > MAX_EVENT_BYTES) {
      return { ok: false, code: "EVENT_TOO_LARGE", message: "Replay event exceeds the 12 MB transport limit." };
    }
    const name = eventName(message);
    if (!["IMPORT_CLIP", "RENDER_COMPLETE", "EXPORT_COMPLETE"].includes(name)) {
      return { ok: false, code: "UNSUPPORTED_EVENT", message: "Unsupported replay event type." };
    }
    const nested = nestedPayload(message);
    const source = Object.assign({}, message, nested);
    const declaredSchema = schema.cleanString(source.schema || message.schema, 128);
    const declaredVersion = finite(source.version ?? source.protocol ?? message.protocol, 1, 1, 100);
    if (declaredSchema && declaredSchema !== BRIDGE_EVENT_SCHEMA) {
      return { ok: false, code: "UNSUPPORTED_SCHEMA", message: "Unsupported replay event schema." };
    }
    if (![1, BRIDGE_EVENT_VERSION].includes(declaredVersion)) {
      return { ok: false, code: "UNSUPPORTED_VERSION", message: "Unsupported replay event version." };
    }
    const canonicalPath = schema.normalizeWindowsPath(
      source.canonicalPath || source.absolutePath || source.filePath || source.filepath ||
      source.outputPath || source.outputFile,
    );
    if (!schema.isAbsoluteWindowsPath(canonicalPath)) {
      return { ok: false, code: "INVALID_PATH", message: "Replay event requires a safe absolute Windows path." };
    }
    if (!isSupportedMediaPath(canonicalPath)) {
      return { ok: false, code: "UNSUPPORTED_MEDIA", message: "Replay event uses an unsupported media extension." };
    }
    const exportedAt = timestamp(
      source.exportedAt || source.completedAt || source.timestamp || source.receivedAt,
      now,
    );
    const rawEventId = schema.cleanString(
      source.eventId || source.id || source.exportId || source.event_id || source.export_id,
      256,
    );
    const eventId = rawEventId || schema.stableUuidFromSeed(
      `bridge|${name}|${schema.replayPathKey(canonicalPath)}|${exportedAt}`,
    );
    const modifiedAt = timestamp(
      source.modifiedAt || source.mtime ||
      (finite(source.modifiedAtEpochMs ?? source.mtimeMs, null, 0) !== null
        ? new Date(Number(source.modifiedAtEpochMs ?? source.mtimeMs)).toISOString()
        : null),
      null,
    );
    const durationMs = finite(
      source.durationMs,
      finite(source.durationSeconds ?? source.duration, null, 0) === null
        ? null
        : finite(source.durationSeconds ?? source.duration, 0, 0) * 1000,
      0,
    );
    const thumbnailCandidate = source.thumbnailBase64 || source.thumbnail_base64 || "";
    const thumbnailBase64 = normalizeThumbnailBase64(thumbnailCandidate);
    const width = finite(source.width ?? source.videoWidth ?? source.resolutionWidth, null, 1);
    const height = finite(source.height ?? source.videoHeight ?? source.resolutionHeight, null, 1);
    const fps = finite(source.fps ?? source.frameRate ?? source.framerate, null, 0.001);
    const migrated = migrations.migrateOracleState({
      version: 2,
      savedAt: exportedAt,
      replays: [{
        id: eventId,
        canonicalPath,
        sourceName: schema.cleanString(source.sourceName || source.fileName, 260) || sourceName(canonicalPath),
        displayNameOverride: schema.cleanString(source.displayNameOverride || source.title || source.name, 240),
        fileIdentity: normalizeFileIdentity(source.fileIdentity || source.fileKey),
        fileSize: finite(source.fileSize ?? source.sizeBytes, null, 0),
        modifiedAt,
        exportedAt,
        firstSeenAt: now,
        durationMs: durationMs === null ? null : Math.round(durationMs),
        thumbnailStatus: thumbnailBase64 ? "processing" : "unavailable",
        archiveState: "active",
        missingState: "pending",
        resolution: width && height ? `${Math.round(width)} × ${Math.round(height)}` : source.resolution,
        fps,
        legacy: {
          id: eventId,
          resolution: width && height ? `${Math.round(width)} × ${Math.round(height)}` : source.resolution,
          fps,
          thumbnailPosition: finite(source.thumbnailPosition, 0.5, 0, 1),
          thumbnailWidth: finite(source.thumbnailWidth, 640, 1),
          thumbnailHeight: finite(source.thumbnailHeight, 360, 1),
        },
      }],
    }, { writtenAt: exportedAt, writerId: "oracle-bridge-ingest" });
    if (!migrated.sourceValid || Object.keys(migrated.state.replaysById).length !== 1) {
      return { ok: false, code: "INVALID_RECORD", message: "Replay event could not form a valid v3 record." };
    }
    const record = Object.values(migrated.state.replaysById)[0];
    return {
      ok: true,
      protocol: declaredVersion,
      legacyProtocol: declaredVersion === 1,
      eventId,
      record,
      thumbnailBase64,
      thumbnailError: thumbnailCandidate && !thumbnailBase64 ? "Invalid JPEG thumbnail payload." : "",
    };
  }

  function mergeReplayRecord(previous, incoming) {
    if (!previous) return clone(incoming);
    return {
      ...clone(previous),
      canonicalPath: incoming.canonicalPath,
      pathKey: incoming.pathKey,
      fileIdentity: incoming.fileIdentity || previous.fileIdentity,
      sourceName: incoming.sourceName || previous.sourceName,
      displayNameOverride: previous.displayNameOverride || incoming.displayNameOverride,
      fileSize: incoming.fileSize ?? previous.fileSize,
      modifiedAt: incoming.modifiedAt || previous.modifiedAt,
      exportedAt: incoming.exportedAt,
      durationMs: incoming.durationMs ?? previous.durationMs,
      thumbnailCacheKey: incoming.thumbnailCacheKey || previous.thumbnailCacheKey,
      thumbnailStatus: incoming.thumbnailStatus === "processing"
        ? "processing"
        : previous.thumbnailStatus,
      missingState: incoming.missingState === "pending"
        ? previous.missingState
        : incoming.missingState,
      legacy: { ...(previous.legacy || {}), ...(incoming.legacy || {}) },
    };
  }

  function displayName(record) {
    return record.displayNameOverride || record.sourceName || sourceName(record.canonicalPath) || "Untitled Replay";
  }

  function formatReplayDuration(durationMs) {
    const milliseconds = finite(durationMs, null, 0);
    if (milliseconds === null) return "--";
    const centiseconds = Math.round(milliseconds / 10);
    const totalSeconds = Math.floor(centiseconds / 100);
    const fraction = String(centiseconds % 100).padStart(2, "0");
    if (totalSeconds < 60) return `${totalSeconds}.${fraction}s`;
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}:${seconds}.${fraction}`;
    const minutes = String(totalMinutes % 60).padStart(2, "0");
    return `${Math.floor(totalMinutes / 60)}:${minutes}:${seconds}.${fraction}`;
  }

  function replayToPresentation(record, runtime = {}) {
    const legacy = record.legacy || {};
    return {
      id: record.id,
      title: displayName(record),
      filepath: record.canonicalPath,
      canonicalPath: record.canonicalPath,
      completedAt: record.exportedAt,
      durationMs: record.durationMs,
      durationSeconds: record.durationMs === null ? null : record.durationMs / 1000,
      resolution: legacy.resolution || "",
      fps: legacy.fps ?? null,
      thumbnail: record.thumbnailCacheKey
        ? `plugin-data:/oracle-thumbnail-v1-${record.thumbnailCacheKey}.jpg`
        : "",
      thumbnailCacheKey: record.thumbnailCacheKey,
      thumbnailError: runtime.thumbnailError || (record.thumbnailStatus === "unavailable" ? "Thumbnail unavailable" : ""),
      archiveState: record.archiveState,
      missingState: record.missingState,
      collectionIds: [...record.collectionIds],
      tags: [...record.tags],
      favorite: record.favorite,
      rating: record.rating,
      notes: record.notes,
      usageCount: record.usageCount,
      status: runtime.status || (record.missingState === "missing" ? "error" : "ready"),
      statusMessage: runtime.statusMessage || (record.missingState === "missing" ? "Source file is missing" : "Drag ready"),
      projectItem: runtime.projectItem || null,
      projectItemId: runtime.projectItemId || "",
      isNew: runtime.isNew === true,
    };
  }

  function replaySearchDocument(record) {
    return [
      displayName(record),
      record.sourceName,
      record.canonicalPath,
      record.tags.join(" "),
      record.notes,
    ].join("\n").toLocaleLowerCase("en-US");
  }

  function matchesNormalizedSmartRule(record, rule, nowValue = Date.now()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    if (rule.field === "name") {
      const value = String(rule.value || "").toLocaleLowerCase("en-US");
      const name = displayName(record).toLocaleLowerCase("en-US");
      if (rule.operator === "contains") return name.includes(value);
      if (rule.operator === "startsWith") return name.startsWith(value);
      return name === value;
    }
    if (rule.field === "root") {
      const root = schema.replayPathKey(rule.pathKey || rule.value || "");
      const recordPath = schema.replayPathKey(record.canonicalPath);
      const separator = recordPath.lastIndexOf("\\");
      const parent = separator > 1 ? recordPath.slice(0, separator) : "";
      return rule.operator === "is"
        ? parent === root
        : recordPath === root || recordPath.startsWith(`${root}\\`);
    }
    if (rule.field === "tag") {
      const value = String(rule.value || "").toLocaleLowerCase("en-US");
      const present = record.tags.some((tag) => String(tag).toLocaleLowerCase("en-US") === value);
      return rule.operator === "contains" ? present : !present;
    }
    if (rule.field === "favorite") return record.favorite === rule.value;
    if (rule.field === "missing") return (record.missingState === "missing") === rule.value;
    if (rule.field === "duration") {
      if (!Number.isFinite(record.durationMs)) return false;
      if (rule.operator === "between") {
        return record.durationMs >= Number(rule.minimumMs) && record.durationMs <= Number(rule.maximumMs);
      }
      const boundary = Number(rule.valueMs);
      if (rule.operator === "lessThan") return record.durationMs < boundary;
      if (rule.operator === "atMost") return record.durationMs <= boundary;
      if (rule.operator === "greaterThan") return record.durationMs > boundary;
      return record.durationMs >= boundary;
    }
    if (rule.field === "date") {
      const observed = Date.parse(record[rule.source || "exportedAt"] || "");
      if (!Number.isFinite(observed)) return false;
      if (rule.operator === "withinDays") {
        const nowMs = new Date(nowValue).getTime();
        return Number.isFinite(nowMs) && observed <= nowMs && observed >= nowMs - Number(rule.value) * 86400000;
      }
      if (rule.operator === "between") {
        return observed >= Date.parse(rule.from) && observed <= Date.parse(rule.to);
      }
      const boundary = Date.parse(rule.value);
      if (rule.operator === "before") return observed < boundary;
      if (rule.operator === "after") return observed > boundary;
      if (rule.operator === "onOrBefore") return observed <= boundary;
      return observed >= boundary;
    }
    return false;
  }

  function matchesSmartRules(record, rules, nowValue = Date.now()) {
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) return false;
    if (Array.isArray(rules.rules)) {
      if (!rules.rules.length) return false;
      const results = rules.rules.map((rule) => matchesNormalizedSmartRule(record, rule, nowValue));
      return rules.match === "any" ? results.some(Boolean) : results.every(Boolean);
    }
    const name = String(rules.name || "").trim().toLocaleLowerCase("en-US");
    if (name && !displayName(record).toLocaleLowerCase("en-US").includes(name)) return false;
    const root = schema.replayPathKey(rules.root || "");
    if (root && record.pathKey !== root && !record.pathKey.startsWith(`${root}\\`)) return false;
    const tag = String(rules.tag || "").trim().toLocaleLowerCase("en-US");
    if (tag && !record.tags.some((value) => String(value).toLocaleLowerCase("en-US") === tag)) return false;
    if (rules.favorite === true && !record.favorite) return false;
    if (rules.favorite === false && record.favorite) return false;
    if (rules.missingState && record.missingState !== rules.missingState) return false;
    const minimum = finite(rules.minimumDurationMs, null, 0);
    const maximum = finite(rules.maximumDurationMs, null, 0);
    if (minimum !== null && (record.durationMs === null || record.durationMs < minimum)) return false;
    if (maximum !== null && (record.durationMs === null || record.durationMs > maximum)) return false;
    const exportedMs = new Date(record.exportedAt).getTime();
    const from = timestamp(rules.dateFrom, null);
    const to = timestamp(rules.dateTo, null);
    if (from && exportedMs < new Date(from).getTime()) return false;
    if (to && exportedMs > new Date(to).getTime()) return false;
    return true;
  }

  function selectReplayIds(state, options = {}) {
    const view = String(options.view || "all");
    const query = String(options.query || "").trim().toLocaleLowerCase("en-US");
    const collectionId = String(options.collectionId || "");
    const collection = collectionId && state && state.collectionsById
      ? state.collectionsById[collectionId]
      : null;
    const root = schema.replayPathKey(options.root || "");
    const minimumDurationMs = finite(options.minimumDurationMs, null, 0);
    const maximumDurationMs = finite(options.maximumDurationMs, null, 0);
    const dateFrom = timestamp(options.dateFrom, null);
    const dateTo = timestamp(options.dateTo, null);
    const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : null;
    const dateToMs = dateTo ? new Date(dateTo).getTime() : null;
    const nowMs = new Date(options.now || Date.now()).getTime();
    const recentAfterMs = Number.isFinite(nowMs) ? nowMs - 30 * 86400000 : null;
    const records = Object.values(state && state.replaysById || {}).filter((record) => {
      if (view === "favorites" && !record.favorite) return false;
      if (view === "archived" && record.archiveState !== "archived") return false;
      if (view !== "archived" && record.archiveState === "archived") return false;
      if (view === "missing" && record.missingState !== "missing") return false;
      if (view === "recent" && recentAfterMs !== null && new Date(record.exportedAt).getTime() < recentAfterMs) return false;
      if (view === "collections" && !collectionId && record.collectionIds.length === 0) return false;
      if (collectionId && collection && collection.smartRules) {
        if (!matchesSmartRules(record, collection.smartRules)) return false;
      } else if (collectionId && !record.collectionIds.includes(collectionId)) return false;
      if (root && record.pathKey !== root && !record.pathKey.startsWith(`${root}\\`)) return false;
      if (minimumDurationMs !== null && (record.durationMs === null || record.durationMs < minimumDurationMs)) return false;
      if (maximumDurationMs !== null && (record.durationMs === null || record.durationMs > maximumDurationMs)) return false;
      const exportedMs = new Date(record.exportedAt).getTime();
      if (dateFromMs !== null && exportedMs < dateFromMs) return false;
      if (dateToMs !== null && exportedMs > dateToMs) return false;
      if (options.tag && !record.tags.includes(options.tag)) return false;
      if (options.favorite === true && !record.favorite) return false;
      if (options.favorite === false && record.favorite) return false;
      if (options.archiveState && record.archiveState !== options.archiveState) return false;
      if (options.missingState && record.missingState !== options.missingState) return false;
      return !query || replaySearchDocument(record).includes(query);
    });
    records.sort((left, right) => {
      if (view === "most-used") {
        const uses = Number(right.usageCount || 0) - Number(left.usageCount || 0);
        if (uses) return uses;
        const leftLast = Math.max(new Date(left.lastOpenedAt || 0).getTime() || 0, new Date(left.lastDraggedAt || 0).getTime() || 0);
        const rightLast = Math.max(new Date(right.lastOpenedAt || 0).getTime() || 0, new Date(right.lastDraggedAt || 0).getTime() || 0);
        if (rightLast !== leftLast) return rightLast - leftLast;
      }
      if (collection && !collection.smartRules) {
        const order = Array.isArray(collection.manualOrder) ? collection.manualOrder : [];
        const leftIndex = order.indexOf(left.id);
        const rightIndex = order.indexOf(right.id);
        if (leftIndex >= 0 || rightIndex >= 0) {
          if (leftIndex < 0) return 1;
          if (rightIndex < 0) return -1;
          if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        }
      }
      const time = new Date(right.exportedAt).getTime() - new Date(left.exportedAt).getTime();
      return time || left.id.localeCompare(right.id);
    });
    return records.map((record) => record.id);
  }

  function dateGroupLabel(value, nowValue = new Date()) {
    const date = new Date(value);
    const now = new Date(nowValue);
    if (!Number.isFinite(date.getTime())) return "Unknown date";
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (day === today) return "Today";
    if (day === today - 86400000) return "Yesterday";
    try {
      return date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
    } catch (error) {
      return date.toISOString().slice(0, 10);
    }
  }

  function chronologicalEntries(state, ids, nowValue) {
    const entries = [];
    let previousLabel = "";
    for (const id of ids) {
      const record = state.replaysById[id];
      if (!record) continue;
      const label = dateGroupLabel(record.exportedAt, nowValue);
      if (label !== previousLabel) {
        entries.push({ kind: "header", key: `date:${label}`, label });
        previousLabel = label;
      }
      entries.push({ kind: "replay", key: id, id });
    }
    return entries;
  }

  class ReplayVirtualWindow {
    constructor(options = {}) {
      this.overscanRows = Math.max(1, Math.min(12, Math.round(finite(options.overscanRows, 3, 1, 12))));
      this.maximumItems = Math.max(40, Math.min(400, Math.round(finite(options.maximumItems, 180, 40, 400))));
    }

    calculate(options = {}) {
      const count = Math.max(0, Math.round(finite(options.itemCount, 0, 0)));
      const columns = Math.max(1, Math.round(finite(options.columns, 1, 1, 12)));
      const rowHeight = Math.max(1, finite(options.rowHeight, 240, 1));
      const scrollTop = Math.max(0, finite(options.scrollTop, 0, 0));
      const viewportHeight = Math.max(0, finite(options.viewportHeight, 0, 0));
      const rowCount = Math.ceil(count / columns);
      const firstVisibleRow = Math.min(rowCount, Math.floor(scrollTop / rowHeight));
      const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
      const startRow = Math.min(rowCount, Math.max(0, firstVisibleRow - this.overscanRows));
      const endRow = Math.min(rowCount, firstVisibleRow + visibleRows + this.overscanRows);
      const start = Math.min(count, startRow * columns);
      const naturalEnd = Math.min(count, endRow * columns);
      const end = Math.min(naturalEnd, start + this.maximumItems);
      return {
        start,
        end,
        topSpacer: startRow * rowHeight,
        bottomSpacer: Math.max(0, (rowCount - Math.ceil(end / columns)) * rowHeight),
        totalHeight: rowCount * rowHeight,
      };
    }
  }

  class ReplayLibraryStore {
    constructor(options = {}) {
      this.writerId = String(options.writerId || "oracle-premiere");
      this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
      this.state = schema.createEmptyOracleState({ writerId: this.writerId });
      this.runtimeById = new Map();
      this.thumbnailPayloadById = new Map();
      this.eventIds = new Map();
      this.idByPhysicalFingerprint = new Map();
      this.listeners = new Set();
      this.batchState = null;
      this.emitItems = options.emitItems !== false;
      if (typeof options.onChange === "function") this.listeners.add(options.onChange);
    }

    subscribe(listener) {
      if (typeof listener !== "function") return () => undefined;
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(change) {
      const items = this.emitItems ? this.items : null;
      for (const listener of this.listeners) listener(items, change, this.state);
    }

    rebuildIndexes() {
      this.idByPhysicalFingerprint.clear();
      this.eventIds.clear();
      for (const record of Object.values(this.state.replaysById)) {
        this.idByPhysicalFingerprint.set(physicalFingerprint(record), record.id);
        this.rememberEvent(record.id, record.id);
        if (record.legacy && record.legacy.id) this.rememberEvent(record.legacy.id, record.id);
      }
    }

    hydrate(value) {
      const result = migrations.migrateOracleState(value, {
        writtenAt: this.now(),
        writerId: this.writerId,
      });
      if (!result.sourceValid) throw new Error("Oracle replay state failed v3 migration validation.");
      this.state = clone(result.state);
      this.rebuildIndexes();
      this.emit({ type: "replace", diagnostics: result.diagnostics });
      return result;
    }

    get items() {
      return selectReplayIds(this.state, { view: "all" })
        .map((id) => this.getById(id))
        .filter(Boolean);
    }

    getById(id) {
      const record = this.state.replaysById[String(id || "")];
      return record ? replayToPresentation(record, this.runtimeById.get(record.id)) : null;
    }

    getRecord(id) {
      const record = this.state.replaysById[String(id || "")];
      return record ? clone(record) : null;
    }

    get(filepath) {
      const pathKey = schema.replayPathKey(filepath);
      const id = selectReplayIds(this.state, { view: "all" })
        .find((candidate) => this.state.replaysById[candidate].pathKey === pathKey);
      return id ? this.getById(id) : null;
    }

    select(options = {}) {
      return selectReplayIds(this.state, options);
    }

    presentations(ids) {
      return (Array.isArray(ids) ? ids : []).map((id) => this.getById(id)).filter(Boolean);
    }

    rememberEvent(eventId, replayId) {
      this.eventIds.delete(eventId);
      this.eventIds.set(eventId, replayId);
      while (this.eventIds.size > MAX_DEDUP_EVENTS) this.eventIds.delete(this.eventIds.keys().next().value);
    }

    ingest(message, options = {}) {
      const normalized = normalizeBridgeReplay(message, { now: this.now() });
      if (!normalized.ok) return normalized;
      const workingState = this.batchState || this.state;
      const repeatedId = this.eventIds.get(normalized.eventId);
      if (repeatedId && workingState.replaysById[repeatedId]) {
        const repeated = workingState.replaysById[repeatedId];
        const pathChanged = repeated.pathKey !== normalized.record.pathKey;
        const previousIdentity = fileIdentityKey(repeated.fileIdentity);
        const incomingIdentity = fileIdentityKey(normalized.record.fileIdentity);
        const identityMatched = Boolean(
          previousIdentity && incomingIdentity && previousIdentity === incomingIdentity,
        );
        const identityChanged = Boolean(
          previousIdentity && incomingIdentity && previousIdentity !== incomingIdentity,
        );
        const sizeChanged = repeated.fileSize !== null && normalized.record.fileSize !== null &&
          Number(repeated.fileSize) !== Number(normalized.record.fileSize);
        const modifiedChanged = Boolean(
          repeated.modifiedAt && normalized.record.modifiedAt &&
          repeated.modifiedAt !== normalized.record.modifiedAt,
        );
        if (pathChanged || identityChanged || (!identityMatched && (sizeChanged || modifiedChanged))) {
          return {
            ok: false,
            code: "EVENT_ID_COLLISION",
            message: "Replay event ID was reused for a different physical export.",
          };
        }
      }
      const fingerprint = physicalFingerprint(normalized.record);
      const existingId = repeatedId && workingState.replaysById[repeatedId]
        ? repeatedId
        : workingState.replaysById[normalized.record.id]
          ? normalized.record.id
          : this.idByPhysicalFingerprint.get(fingerprint);
      const previous = existingId ? workingState.replaysById[existingId] : null;
      const previousFingerprint = previous ? physicalFingerprint(previous) : "";
      const nextRecord = mergeReplayRecord(previous, normalized.record);
      if (previous) nextRecord.id = previous.id;
      if (this.batchState) {
        this.batchState.replaysById[nextRecord.id] = nextRecord;
      } else {
        this.state = {
          ...this.state,
          replaysById: { ...this.state.replaysById, [nextRecord.id]: nextRecord },
        };
      }
      if (previousFingerprint && this.idByPhysicalFingerprint.get(previousFingerprint) === nextRecord.id) {
        this.idByPhysicalFingerprint.delete(previousFingerprint);
      }
      this.idByPhysicalFingerprint.set(physicalFingerprint(nextRecord), nextRecord.id);
      this.rememberEvent(normalized.eventId, nextRecord.id);
      const runtime = this.runtimeById.get(nextRecord.id) || {};
      this.runtimeById.set(nextRecord.id, {
        ...runtime,
        isNew: !previous,
        status: "processing",
        statusMessage: "Validating export metadata",
        thumbnailError: normalized.thumbnailError,
      });
      if (normalized.thumbnailBase64) this.thumbnailPayloadById.set(nextRecord.id, normalized.thumbnailBase64);
      const replay = replayToPresentation(nextRecord, this.runtimeById.get(nextRecord.id));
      if (options.silent !== true) {
        this.emit({ type: previous ? "update" : "upsert", replay, replays: [replay] });
      }
      return { ...normalized, duplicate: Boolean(previous), record: clone(nextRecord), replay };
    }

    replaceSnapshot(messages) {
      const touched = [];
      if (this.batchState) throw new Error("Nested replay snapshot batches are not supported.");
      this.batchState = {
        ...this.state,
        replaysById: { ...this.state.replaysById },
      };
      try {
        for (const message of Array.isArray(messages) ? messages : []) {
          const result = /** @type {any} */ (this.ingest(message, { silent: true }));
          if (result.ok) touched.push(result.replay);
        }
        this.state = this.batchState;
      } finally {
        this.batchState = null;
      }
      this.emit({ type: "replace", reason: "bridge-snapshot", touched });
      return touched;
    }

    consumeThumbnail(id) {
      const value = this.thumbnailPayloadById.get(id) || "";
      this.thumbnailPayloadById.delete(id);
      return value;
    }

    updateById(id, patch, options = {}) {
      const key = String(id || "");
      const record = this.state.replaysById[key];
      if (!record) return null;
      const domain = options.domain === true;
      if (domain) {
        const allowed = [
          "displayNameOverride", "fileIdentity", "fileSize", "modifiedAt", "durationMs",
          "thumbnailCacheKey", "thumbnailStatus", "archiveState", "missingState", "collectionIds",
          "tags", "favorite", "rating", "notes", "usageCount", "lastOpenedAt", "lastDraggedAt",
        ];
        const previousFingerprint = physicalFingerprint(record);
        const nextRecord = clone(record);
        for (const field of allowed) {
          if (Object.prototype.hasOwnProperty.call(patch, field)) nextRecord[field] = clone(patch[field]);
        }
        const nextState = clone(this.state);
        nextState.replaysById[key] = nextRecord;
        const validation = schema.validateOracleState(nextState);
        if (!validation.ok) throw new Error(validation.errors.join(" "));
        this.state = nextState;
        if (this.idByPhysicalFingerprint.get(previousFingerprint) === key) {
          this.idByPhysicalFingerprint.delete(previousFingerprint);
        }
        this.idByPhysicalFingerprint.set(physicalFingerprint(nextRecord), key);
      } else {
        this.runtimeById.set(key, { ...(this.runtimeById.get(key) || {}), ...patch });
      }
      const replay = this.getById(key);
      this.emit({
        type: "update",
        domain,
        fields: Object.keys(patch || {}),
        replay,
        replays: [replay],
      });
      return replay;
    }

    update(filepath, patch) {
      const replay = this.get(filepath);
      return replay ? this.updateById(replay.id, patch) : null;
    }

    replaceDomainState(nextState, change = {}) {
      const candidate = clone(nextState);
      const validation = schema.validateOracleState(candidate);
      if (!validation.ok) throw new Error(validation.errors.join(" "));
      const previousById = this.state.replaysById || {};
      for (const id of new Set([
        ...this.runtimeById.keys(),
        ...this.thumbnailPayloadById.keys(),
      ])) {
        const previous = previousById[id];
        const next = candidate.replaysById[id];
        if (!next) {
          this.runtimeById.delete(id);
          this.thumbnailPayloadById.delete(id);
          continue;
        }
        if (previous && previous.pathKey !== next.pathKey) {
          const runtime = this.runtimeById.get(id) || {};
          this.runtimeById.set(id, {
            ...runtime,
            projectItem: null,
            projectItemId: "",
            status: next.missingState === "missing" ? "error" : "ready",
            statusMessage: next.missingState === "missing" ? "Source file is missing" : "Drag ready",
          });
          this.thumbnailPayloadById.delete(id);
        }
      }
      this.state = candidate;
      this.rebuildIndexes();
      this.emit({ type: "replace", reason: "domain-transaction", ...change });
      return clone(this.state);
    }

    upsert(payload) {
      const result = /** @type {any} */ (this.ingest(payload));
      return result.ok ? result.replay : null;
    }

    restorePersisted(value) {
      this.hydrate(value);
      return this.items;
    }

    adoptPersistenceMetadata(snapshot) {
      if (!snapshot || Number(snapshot.revision) < Number(this.state.revision)) return;
      this.state = {
        ...this.state,
        revision: Number(snapshot.revision),
        writtenAt: snapshot.writtenAt,
        writerId: snapshot.writerId,
      };
    }

    replaceSnapshotLegacy(messages) {
      return this.replaceSnapshot(messages);
    }

    clearThumbnailMetadata() {
      const nextState = clone(this.state);
      let changed = false;
      for (const record of Object.values(nextState.replaysById)) {
        if (!record.thumbnailCacheKey && record.thumbnailStatus === "unavailable") continue;
        record.thumbnailCacheKey = "";
        record.thumbnailStatus = "unavailable";
        changed = true;
      }
      if (!changed) return false;
      const validation = schema.validateOracleState(nextState);
      if (!validation.ok) throw new Error(validation.errors.join(" "));
      this.state = nextState;
      this.emit({ type: "replace", reason: "thumbnail-cache-cleared" });
      return true;
    }

    destroy() {
      this.listeners.clear();
      this.runtimeById.clear();
      this.thumbnailPayloadById.clear();
      this.eventIds.clear();
      this.idByPhysicalFingerprint.clear();
      this.batchState = null;
    }
  }

  function isMissingError(error) {
    return /ENOENT|not\s+found|does\s+not\s+exist|no\s+such\s+file/i.test(
      `${error && error.code || ""} ${error && error.message || error || ""}`,
    );
  }

  async function unlinkIfPresent(fs, url) {
    try {
      await fs.unlink(url);
      return true;
    } catch (error) {
      if (isMissingError(error)) return false;
      throw error;
    }
  }

  async function readText(fs, url) {
    const result = await readOptionalText(fs, url);
    return result.value;
  }

  async function readOptionalText(fs, url) {
    try {
      return { found: true, value: String(await fs.readFile(url, { encoding: "utf-8" })) };
    } catch (error) {
      if (isMissingError(error)) return { found: false, value: "" };
      throw error;
    }
  }

  async function writeDurableText(fs, url, text) {
    if (typeof fs.open === "function" && typeof fs.fsync === "function" && typeof fs.close === "function") {
      const handle = await fs.open(url, "w");
      try {
        if (typeof fs.write === "function") await fs.write(handle, String(text));
        else await fs.writeFile(url, String(text), { encoding: "utf-8" });
        await fs.fsync(handle);
      } finally {
        await fs.close(handle);
      }
      return;
    }
    await fs.writeFile(url, String(text), { encoding: "utf-8" });
  }

  class OracleStateRepository {
    constructor(options = {}) {
      this.fs = options.fs || null;
      this.atomicWriter = typeof options.atomicWriter === "function" ? options.atomicWriter : null;
      this.legacyLoader = typeof options.legacyLoader === "function" ? options.legacyLoader : async () => [];
      this.writerId = String(options.writerId || "oracle-premiere");
      this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
      this.writeChain = Promise.resolve();
      this.destroyed = false;
      this.diagnostics = [];
      this.lastRevision = 0;
    }

    diagnostic(code, details = {}) {
      this.diagnostics.push({ code, at: this.now(), ...details });
      if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
    }

    async load() {
      const candidates = [];
      if (this.fs && typeof this.fs.readFile === "function") {
        for (const [source, url] of [["primary", STATE_URL], ["temp", STATE_TEMP_URL], ["backup", STATE_BACKUP_URL]]) {
          try {
            const read = await readOptionalText(this.fs, url);
            if (read.found) candidates.push({ source, value: read.value });
          } catch (error) {
            this.diagnostic("STATE_READ_FAILED", { source });
            candidates.push({ source, value: undefined });
          }
        }
      }
      for (const candidate of await this.legacyLoader()) candidates.push(candidate);
      let recovered;
      try {
        recovered = migrations.recoverOracleState(candidates, {
          writtenAt: this.now(),
          writerId: this.writerId,
        });
      } catch (error) {
        if (error && error.code === "STATE_RECOVERY_REQUIRED") {
          for (const entry of Array.isArray(error.diagnostics) ? error.diagnostics : []) {
            this.diagnostic(entry.code, { source: entry.source || "none" });
          }
        }
        throw error;
      }
      this.lastRevision = Math.max(this.lastRevision, Number(recovered.state.revision) || 0);
      for (const entry of recovered.diagnostics) this.diagnostic(entry.code, { source: recovered.source || "none" });
      return recovered;
    }

    save(state) {
      if (this.destroyed) return Promise.reject(new Error("Oracle state repository is closed."));
      const snapshot = clone(state);
      snapshot.revision = Math.max(this.lastRevision, Number(snapshot.revision) || 0) + 1;
      this.lastRevision = snapshot.revision;
      snapshot.writtenAt = timestamp(this.now(), schema.EMPTY_TIMESTAMP);
      snapshot.writerId = this.writerId;
      const validation = schema.validateOracleState(snapshot);
      if (!validation.ok) return Promise.reject(new Error(validation.errors.join(" ")));
      this.writeChain = this.writeChain.catch(() => undefined).then(() => this.writeSnapshot(snapshot));
      return this.writeChain.then(() => clone(snapshot));
    }

    async writeSnapshot(snapshot) {
      if (!this.fs && !this.atomicWriter) throw new Error("Oracle v3 state storage is unavailable.");
      const text = JSON.stringify(snapshot);
      if (this.atomicWriter) {
        await this.atomicWriter({ primary: STATE_URL, backup: STATE_BACKUP_URL, temp: STATE_TEMP_URL, text });
        this.diagnostic("STATE_WRITE_COMMITTED", { revision: snapshot.revision, writer: "native-atomic" });
        return;
      }
      const fs = this.fs;
      if (
        typeof fs.writeFile !== "function" ||
        typeof fs.readFile !== "function" ||
        typeof fs.rename !== "function" ||
        typeof fs.unlink !== "function"
      ) {
        throw new Error("Oracle state storage lacks atomic replace primitives.");
      }
      await unlinkIfPresent(fs, STATE_TEMP_URL);
      await writeDurableText(fs, STATE_TEMP_URL, text);
      const stagedText = await readText(fs, STATE_TEMP_URL);
      const staged = migrations.migrateOracleState(stagedText);
      if (!staged.sourceValid || !staged.complete || stableJson(staged.state) !== stableJson(snapshot)) {
        await unlinkIfPresent(fs, STATE_TEMP_URL);
        throw new Error("Oracle rejected an incomplete staged v3 snapshot.");
      }
      await unlinkIfPresent(fs, STATE_BACKUP_URL);
      let hadPrimary = false;
      try {
        await fs.rename(STATE_URL, STATE_BACKUP_URL);
        hadPrimary = true;
      } catch (error) {
        if (!isMissingError(error)) throw error;
      }
      try {
        await fs.rename(STATE_TEMP_URL, STATE_URL);
        const committed = migrations.migrateOracleState(await readText(fs, STATE_URL));
        if (!committed.sourceValid || stableJson(committed.state) !== stableJson(snapshot)) {
          throw new Error("Oracle could not verify the committed v3 snapshot.");
        }
      } catch (error) {
        await unlinkIfPresent(fs, STATE_URL);
        if (hadPrimary) await fs.rename(STATE_BACKUP_URL, STATE_URL);
        await unlinkIfPresent(fs, STATE_TEMP_URL);
        throw error;
      }
      const durableFlush = typeof fs.open === "function" && typeof fs.fsync === "function" && typeof fs.close === "function";
      this.diagnostic("STATE_WRITE_COMMITTED", {
        revision: snapshot.revision,
        writer: durableFlush ? "uxp-fsync-rename" : "uxp-rename-no-fsync",
        durableFlush,
      });
    }

    async flush() {
      await this.writeChain;
      return true;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  class BoundedTaskQueue {
    constructor(limit = 2) {
      this.limit = Math.max(1, Math.min(8, Math.round(finite(limit, 2, 1, 8))));
      this.active = 0;
      this.pending = [];
      this.generation = 0;
      this.closed = false;
    }

    submit(task) {
      if (this.closed) return Promise.reject(new Error("Task queue is closed."));
      const generation = this.generation;
      return new Promise((resolve, reject) => {
        this.pending.push({ task, generation, resolve, reject });
        this.drain();
      });
    }

    drain() {
      while (!this.closed && this.active < this.limit && this.pending.length) {
        const entry = this.pending.shift();
        if (entry.generation !== this.generation) {
          entry.reject(new Error("Task was cancelled."));
          continue;
        }
        this.active += 1;
        Promise.resolve().then(entry.task).then((value) => {
          if (entry.generation !== this.generation) throw new Error("Task was cancelled.");
          entry.resolve(value);
        }).catch(entry.reject).finally(() => {
          this.active -= 1;
          this.drain();
        });
      }
    }

    cancelPending() {
      this.generation += 1;
      for (const entry of this.pending.splice(0)) entry.reject(new Error("Task was cancelled."));
    }

    destroy() {
      this.closed = true;
      this.cancelPending();
    }
  }

  const JPEG_SOF_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);

  function parseJpegFrame(bytes) {
    let offset = 2;
    const markerLimit = bytes.byteLength - 2;
    while (offset < markerLimit) {
      if (bytes[offset] !== 0xff) {
        throw new Error("Thumbnail JPEG contains malformed marker data before its frame header.");
      }
      while (offset < markerLimit && bytes[offset] === 0xff) offset += 1;
      if (offset >= markerLimit) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0x00) {
        throw new Error("Thumbnail JPEG contains an escaped marker before its frame header.");
      }
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd8) {
        throw new Error("Thumbnail JPEG contains an unexpected nested start marker.");
      }
      if (offset + 2 > markerLimit) {
        throw new Error("Thumbnail JPEG contains a truncated marker length.");
      }
      const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
      if (segmentLength < 2) {
        throw new Error("Thumbnail JPEG contains an invalid marker length.");
      }
      const segmentEnd = offset + segmentLength;
      if (segmentEnd > markerLimit) {
        throw new Error(JPEG_SOF_MARKERS.has(marker)
          ? "Thumbnail JPEG contains a truncated SOF segment."
          : "Thumbnail JPEG contains a truncated marker segment.");
      }
      if (JPEG_SOF_MARKERS.has(marker)) {
        if (segmentLength < 8) throw new Error("Thumbnail JPEG contains a truncated SOF segment.");
        const componentCount = bytes[offset + 7];
        const expectedLength = 8 + (componentCount * 3);
        if (componentCount < 1 || segmentLength < expectedLength) {
          throw new Error("Thumbnail JPEG contains a truncated SOF component table.");
        }
        if (segmentLength !== expectedLength) {
          throw new Error("Thumbnail JPEG contains a malformed SOF component table.");
        }
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        if (width < 1 || height < 1) {
          throw new Error("Thumbnail JPEG SOF dimensions must be positive.");
        }
        if (width > MAX_THUMBNAIL_DIMENSION || height > MAX_THUMBNAIL_DIMENSION) {
          throw new Error(`Thumbnail JPEG dimensions exceed the ${MAX_THUMBNAIL_DIMENSION} px side limit.`);
        }
        const pixels = width * height;
        if (pixels > MAX_THUMBNAIL_PIXELS) {
          throw new Error(`Thumbnail JPEG dimensions exceed the ${MAX_THUMBNAIL_PIXELS} pixel limit.`);
        }
        return Object.freeze({
          marker,
          precision: bytes[offset + 2],
          width,
          height,
          pixels,
          componentCount,
        });
      }
      offset = segmentEnd;
    }
    throw new Error("Thumbnail JPEG does not contain a supported SOF marker with dimensions.");
  }

  function thumbnailCancellationError() {
    return Object.assign(new Error("Thumbnail cache operation was cancelled."), {
      code: "THUMBNAIL_CANCELLED",
    });
  }

  function createThumbnailCancellationSignal() {
    let cancelled = false;
    const listeners = new Set();
    return {
      get cancelled() {
        return cancelled;
      },
      throwIfCancelled() {
        if (cancelled) throw thumbnailCancellationError();
      },
      onCancel(listener) {
        if (typeof listener !== "function") return () => undefined;
        if (cancelled) {
          listener();
          return () => undefined;
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch (error) {
            // Cancellation cleanup is best-effort; the cache generation guard
            // still prevents any cancelled output from being committed.
          }
        }
        listeners.clear();
      },
    };
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError("Thumbnail encoder must return JPEG bytes.");
  }

  function validateJpegBytes(value, expected = null) {
    const bytes = toUint8Array(value);
    if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
      throw new Error("Thumbnail exceeds the 8 MB cache limit.");
    }
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[bytes.byteLength - 2] !== 0xff ||
      bytes[bytes.byteLength - 1] !== 0xd9
    ) {
      throw new Error("Thumbnail bytes are not a complete JPEG image.");
    }
    const frame = parseJpegFrame(bytes);
    if (expected && (frame.width !== expected.width || frame.height !== expected.height)) {
      throw new Error(
        `Thumbnail encoder returned ${frame.width} x ${frame.height}; expected exactly ${expected.width} x ${expected.height}.`,
      );
    }
    return { bytes, frame };
  }

  function decodeBase64(value) {
    const normalized = normalizeThumbnailBase64(value);
    if (!normalized) throw new Error("Thumbnail is not a valid bounded JPEG payload.");
    const bufferConstructor = typeof globalThis !== "undefined"
      ? Reflect.get(globalThis, "Buffer")
      : null;
    let bytes;
    if (bufferConstructor && typeof bufferConstructor.from === "function") {
      bytes = new Uint8Array(bufferConstructor.from(normalized, "base64"));
    } else {
      const decoded = atob(normalized);
      bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    }
    return validateJpegBytes(bytes).bytes;
  }

  function normalizeThumbnailVariant(options = {}) {
    const normalizeDimension = (value, fallback, label) => {
      const candidate = value === null || value === undefined || value === "" ? fallback : Number(value);
      if (!Number.isFinite(candidate) || !Number.isInteger(candidate)) {
        throw new TypeError(`Thumbnail ${label} must be an integer pixel dimension.`);
      }
      if (candidate < MIN_THUMBNAIL_DIMENSION || candidate > MAX_THUMBNAIL_DIMENSION) {
        throw new RangeError(
          `Thumbnail ${label} must be between ${MIN_THUMBNAIL_DIMENSION} and ${MAX_THUMBNAIL_DIMENSION} pixels.`,
        );
      }
      return candidate;
    };
    const width = normalizeDimension(options.width, 640, "width");
    const height = normalizeDimension(options.height, 360, "height");
    if (width * height > MAX_THUMBNAIL_PIXELS) {
      throw new RangeError(`Thumbnail variant exceeds the ${MAX_THUMBNAIL_PIXELS} pixel limit.`);
    }
    return { width, height, pixels: width * height };
  }

  async function encodeJpegVariantWithCanvas(request) {
    const runtime = request && request.runtime
      ? request.runtime
      : typeof globalThis !== "undefined"
        ? globalThis
        : {};
    const documentValue = Reflect.get(runtime, "document");
    const ImageConstructor = Reflect.get(runtime, "Image");
    const BlobConstructor = Reflect.get(runtime, "Blob");
    const urlApi = Reflect.get(runtime, "URL");
    if (
      !documentValue || typeof documentValue.createElement !== "function" ||
      typeof BlobConstructor !== "function" ||
      !urlApi || typeof urlApi.createObjectURL !== "function" || typeof urlApi.revokeObjectURL !== "function"
    ) {
      throw new Error(
        "Thumbnail JPEG resizing is unavailable because this UXP runtime did not expose its canvas image encoder.",
      );
    }

    const signal = request && request.signal;
    if (signal && typeof signal.throwIfCancelled === "function") signal.throwIfCancelled();
    const source = validateJpegBytes(request && request.bytes);
    const target = normalizeThumbnailVariant(request || {});
    const objectUrl = urlApi.createObjectURL(new BlobConstructor([source.bytes], { type: "image/jpeg" }));
    const image = typeof ImageConstructor === "function"
      ? new ImageConstructor()
      : documentValue.createElement("img");
    if (!image || typeof image !== "object") {
      urlApi.revokeObjectURL(objectUrl);
      throw new Error("This UXP runtime cannot create an image decoder for replay thumbnails.");
    }
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let unsubscribe = () => undefined;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          unsubscribe();
          image.onload = null;
          image.onerror = null;
          if (error) reject(error);
          else resolve(undefined);
        };
        if (signal && typeof signal.onCancel === "function") {
          unsubscribe = signal.onCancel(() => {
            try {
              image.src = "";
            } catch (error) {
              // Clearing the decoder source is a best-effort cancellation hint.
            }
            finish(thumbnailCancellationError());
          });
        }
        image.onload = () => finish();
        image.onerror = () => finish(new Error("The UXP image decoder could not decode the replay thumbnail JPEG."));
        timer = setTimeout(
          () => finish(new Error("The UXP image decoder timed out while resizing the replay thumbnail.")),
          THUMBNAIL_ENCODE_TIMEOUT_MS,
        );
        image.src = objectUrl;
      });
      if (signal && typeof signal.throwIfCancelled === "function") signal.throwIfCancelled();
      if (Number(image.naturalWidth) !== source.frame.width || Number(image.naturalHeight) !== source.frame.height) {
        throw new Error("Decoded thumbnail dimensions do not match the JPEG frame metadata.");
      }

      const canvas = documentValue.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const context = canvas.getContext && canvas.getContext("2d");
      if (!context || typeof context.drawImage !== "function" || typeof canvas.toDataURL !== "function") {
        throw new Error("This UXP runtime cannot resize replay thumbnails safely.");
      }
      if ("imageSmoothingEnabled" in context) context.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";

      const sourceRatio = source.frame.width / source.frame.height;
      const targetRatio = target.width / target.height;
      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = source.frame.width;
      let sourceHeight = source.frame.height;
      if (sourceRatio > targetRatio) {
        sourceWidth = source.frame.height * targetRatio;
        sourceX = (source.frame.width - sourceWidth) / 2;
      } else if (sourceRatio < targetRatio) {
        sourceHeight = source.frame.width / targetRatio;
        sourceY = (source.frame.height - sourceHeight) / 2;
      }
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        target.width,
        target.height,
      );
      if (signal && typeof signal.throwIfCancelled === "function") signal.throwIfCancelled();
      const dataUrl = String(canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY) || "");
      if (!/^data:image\/jpeg;base64,/i.test(dataUrl)) {
        throw new Error("This UXP runtime did not return JPEG bytes from its canvas image encoder.");
      }
      return validateJpegBytes(decodeBase64(dataUrl), target).bytes;
    } finally {
      try {
        image.src = "";
      } catch (error) {
        // Decoder teardown is best-effort after output validation.
      }
      urlApi.revokeObjectURL(objectUrl);
    }
  }

  function hashKey(value) {
    return schema.stableUuidFromSeed(value).replace(/-/g, "");
  }

  function thumbnailCacheKey(record, options = {}) {
    const variant = normalizeThumbnailVariant(options);
    return hashKey(stableJson({
      version: THUMBNAIL_SCHEMA_VERSION,
      pathKey: record.pathKey,
      fileIdentity: normalizeFileIdentity(record.fileIdentity),
      fileSize: record.fileSize,
      modifiedAt: record.modifiedAt,
      position: finite(options.position, 0.5, 0, 1),
      width: variant.width,
      height: variant.height,
    }));
  }

  function normalizeThumbnailIndexEntry(entry) {
    if (!entry || typeof entry !== "object" || !/^[0-9a-f]{32}$/i.test(String(entry.key || ""))) {
      return null;
    }
    const bytes = Number(entry.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_THUMBNAIL_BYTES) return null;
    const lastAccessedAt = String(entry.lastAccessedAt || "");
    if (!lastAccessedAt || !Number.isFinite(Date.parse(lastAccessedAt))) return null;
    const pathKeyHash = String(entry.pathKeyHash || "");
    const sourceFingerprint = String(entry.sourceFingerprint || "");
    if (!/^[0-9a-f]{32}$/i.test(pathKeyHash) || !/^[0-9a-f]{32}$/i.test(sourceFingerprint)) return null;
    return {
      key: String(entry.key).toLowerCase(),
      bytes,
      lastAccessedAt: new Date(lastAccessedAt).toISOString(),
      pathKeyHash: pathKeyHash.toLowerCase(),
      sourceFingerprint: sourceFingerprint.toLowerCase(),
    };
  }

  class ThumbnailCache {
    constructor(options = {}) {
      this.fs = options.fs || null;
      this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
      this.queue = new BoundedTaskQueue(options.concurrency || 2);
      this.encoder = typeof options.encoder === "function"
        ? options.encoder
        : options.encoder && typeof options.encoder.encode === "function"
          ? options.encoder.encode.bind(options.encoder)
          : encodeJpegVariantWithCanvas;
      this.entries = new Map();
      this.loaded = false;
      this.loadPromise = null;
      this.destroyed = false;
      this.generation = 0;
      this.pathGenerations = new Map();
      /** @type {Promise<unknown>} */
      this.mutationChain = Promise.resolve();
      this.touchTimer = null;
      this.activeTempUrls = new Set();
      this.activeOperations = new Map();
    }

    async load() {
      if (this.loaded) return;
      if (!this.loadPromise) {
        this.loadPromise = (async () => {
          try {
            if (!this.fs || typeof this.fs.readFile !== "function") return;
            try {
              const text = await readText(this.fs, THUMBNAIL_INDEX_URL);
              if (text.length > MAX_THUMBNAIL_INDEX_CHARACTERS) {
                throw new Error("Thumbnail cache index exceeds its bounded size.");
              }
              const payload = JSON.parse(text);
              if (payload && payload.schema === "oracle-thumbnail-cache" && payload.version === THUMBNAIL_SCHEMA_VERSION) {
                const entries = Array.isArray(payload.entries) ? payload.entries : [];
                if (entries.length > MAX_THUMBNAIL_INDEX_ENTRIES) {
                  throw new Error("Thumbnail cache index contains too many entries.");
                }
                const loadedEntries = new Map();
                let totalBytes = 0;
                for (const entry of entries) {
                  const normalized = normalizeThumbnailIndexEntry(entry);
                  if (!normalized || loadedEntries.has(normalized.key)) continue;
                  totalBytes += normalized.bytes;
                  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_THUMBNAIL_INDEX_TOTAL_BYTES) {
                    throw new Error("Thumbnail cache index exceeds its bounded byte total.");
                  }
                  loadedEntries.set(normalized.key, normalized);
                }
                this.entries = loadedEntries;
              }
            } catch (error) {
              this.entries.clear();
            }
          } finally {
            this.loaded = true;
          }
        })();
      }
      await this.loadPromise;
    }

    url(key) {
      return key ? `plugin-data:/oracle-thumbnail-v1-${key}.jpg` : "";
    }

    async persistIndexUnlocked() {
      if (!this.fs) return;
      const text = JSON.stringify({
        schema: "oracle-thumbnail-cache",
        version: THUMBNAIL_SCHEMA_VERSION,
        entries: Array.from(this.entries.values()),
      });
      await unlinkIfPresent(this.fs, THUMBNAIL_INDEX_TEMP_URL);
      await writeDurableText(this.fs, THUMBNAIL_INDEX_TEMP_URL, text);
      await unlinkIfPresent(this.fs, THUMBNAIL_INDEX_URL);
      await this.fs.rename(THUMBNAIL_INDEX_TEMP_URL, THUMBNAIL_INDEX_URL);
    }

    /**
     * @template T
     * @param {() => T | PromiseLike<T>} task
     * @returns {Promise<T>}
     */
    mutate(task) {
      const result = this.mutationChain.catch(() => undefined).then(() => task());
      this.mutationChain = result;
      return result;
    }

    assertCurrent(generation, operation = null) {
      if (
        this.destroyed || generation !== this.generation ||
        (operation && operation.signal.cancelled) ||
        (operation && operation.pathGeneration !== (this.pathGenerations.get(operation.pathHash) || 0))
      ) {
        throw thumbnailCancellationError();
      }
    }

    createOperation(record) {
      const pathHash = hashKey(record && record.pathKey);
      const operation = {
        pathHash,
        pathGeneration: this.pathGenerations.get(pathHash) || 0,
        signal: createThumbnailCancellationSignal(),
      };
      this.activeOperations.set(operation.signal, operation);
      return operation;
    }

    finishOperation(operation) {
      if (operation) this.activeOperations.delete(operation.signal);
    }

    cancelOperations(pathHash = "") {
      for (const operation of Array.from(this.activeOperations.values())) {
        if (pathHash && operation.pathHash !== pathHash) continue;
        operation.signal.cancel();
      }
    }

    cacheLimitBytes(limitMb) {
      return Math.max(1, finite(limitMb, 512, 1, 4096)) * 1024 * 1024;
    }

    async reuseUnlocked(key, variant, sourceFrame, limitMb, generation, operation) {
      const existing = this.entries.get(key);
      if (!existing) return null;
      const url = this.url(key);
      try {
        this.assertCurrent(generation, operation);
        const cached = validateJpegBytes(await this.fs.readFile(url), variant);
        if (cached.bytes.byteLength !== existing.bytes) {
          throw new Error("Thumbnail cache index byte count does not match its JPEG file.");
        }
        if (existing.bytes > this.cacheLimitBytes(limitMb)) {
          throw new Error("Thumbnail variant exceeds the configured cache limit.");
        }
      } catch (error) {
        if (error && error.code === "THUMBNAIL_CANCELLED") throw error;
        await unlinkIfPresent(this.fs, url);
        this.entries.delete(key);
        this.assertCurrent(generation, operation);
        await this.persistIndexUnlocked();
        return null;
      }
      existing.lastAccessedAt = this.now();
      await this.evictUnlocked(limitMb);
      this.assertCurrent(generation, operation);
      await this.persistIndexUnlocked();
      if (!this.entries.has(key)) return null;
      return {
        key,
        url,
        bytes: existing.bytes,
        width: variant.width,
        height: variant.height,
        sourceWidth: sourceFrame.width,
        sourceHeight: sourceFrame.height,
        reused: true,
      };
    }

    store(record, base64, options = {}) {
      const generation = this.generation;
      const operation = this.createOperation(record);
      return this.queue.submit(async () => {
        try {
          this.assertCurrent(generation, operation);
          await this.load();
          if (
            !this.fs || typeof this.fs.readFile !== "function" ||
            typeof this.fs.writeFile !== "function" || typeof this.fs.rename !== "function"
          ) {
            throw new Error("Permanent thumbnail storage is unavailable.");
          }
          const source = validateJpegBytes(decodeBase64(base64));
          const variant = normalizeThumbnailVariant(options);
          const key = thumbnailCacheKey(record, options);
          const reused = await this.mutate(() => this.reuseUnlocked(
            key,
            variant,
            source.frame,
            options.limitMb,
            generation,
            operation,
          ));
          if (reused) return reused;

          this.assertCurrent(generation, operation);
          const encoded = await this.encoder({
            bytes: source.bytes,
            sourceFrame: source.frame,
            width: variant.width,
            height: variant.height,
            quality: THUMBNAIL_JPEG_QUALITY,
            signal: operation.signal,
          });
          const output = validateJpegBytes(
            encoded && typeof encoded === "object" && Object.prototype.hasOwnProperty.call(encoded, "bytes")
              ? encoded.bytes
              : encoded,
            variant,
          );
          if (output.bytes.byteLength > this.cacheLimitBytes(options.limitMb)) {
            throw new Error("Thumbnail variant exceeds the configured cache limit.");
          }
          this.assertCurrent(generation, operation);

          return this.mutate(async () => {
            this.assertCurrent(generation, operation);
            const raced = await this.reuseUnlocked(
              key,
              variant,
              source.frame,
              options.limitMb,
              generation,
              operation,
            );
            if (raced) return raced;
            const url = this.url(key);
            const temp = `${url}.tmp`;
            await unlinkIfPresent(this.fs, temp);
            try {
              this.activeTempUrls.add(temp);
              this.assertCurrent(generation, operation);
              await this.fs.writeFile(temp, output.bytes);
              this.assertCurrent(generation, operation);
              await unlinkIfPresent(this.fs, url);
              await this.fs.rename(temp, url);
              try {
                this.assertCurrent(generation, operation);
              } catch (error) {
                await unlinkIfPresent(this.fs, url);
                throw error;
              }
            } finally {
              this.activeTempUrls.delete(temp);
              await unlinkIfPresent(this.fs, temp);
            }
            this.entries.set(key, {
              key,
              bytes: output.bytes.byteLength,
              lastAccessedAt: this.now(),
              pathKeyHash: operation.pathHash,
              sourceFingerprint: hashKey(physicalFingerprint(record)),
            });
            await this.evictUnlocked(options.limitMb);
            this.assertCurrent(generation, operation);
            if (!this.entries.has(key)) {
              throw new Error("Thumbnail variant exceeds the configured cache limit.");
            }
            await this.persistIndexUnlocked();
            return {
              key,
              url,
              bytes: output.bytes.byteLength,
              width: variant.width,
              height: variant.height,
              sourceWidth: source.frame.width,
              sourceHeight: source.frame.height,
              reused: false,
            };
          });
        } finally {
          this.finishOperation(operation);
        }
      }).finally(() => this.finishOperation(operation));
    }

    async evictUnlocked(limitMb) {
      const limit = this.cacheLimitBytes(limitMb);
      const entries = Array.from(this.entries.values()).sort((left, right) =>
        new Date(left.lastAccessedAt).getTime() - new Date(right.lastAccessedAt).getTime());
      let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of entries) {
        if (total <= limit) break;
        await unlinkIfPresent(this.fs, this.url(entry.key));
        this.entries.delete(entry.key);
        total -= entry.bytes;
      }
      return { totalBytes: total, count: this.entries.size };
    }

    async evict(limitMb) {
      await this.load();
      const generation = this.generation;
      return this.mutate(async () => {
        this.assertCurrent(generation);
        const result = await this.evictUnlocked(limitMb);
        this.assertCurrent(generation);
        await this.persistIndexUnlocked();
        return result;
      });
    }

    async invalidate(record) {
      const pathHash = hashKey(record && record.pathKey);
      this.pathGenerations.set(pathHash, (this.pathGenerations.get(pathHash) || 0) + 1);
      this.cancelOperations(pathHash);
      const generation = this.generation;
      await this.load();
      return this.mutate(async () => {
        this.assertCurrent(generation);
        for (const entry of Array.from(this.entries.values())) {
          if (entry.pathKeyHash !== pathHash) continue;
          await unlinkIfPresent(this.fs, this.url(entry.key));
          this.assertCurrent(generation);
          this.entries.delete(entry.key);
        }
        await this.persistIndexUnlocked();
      });
    }

    async clear() {
      await this.load();
      this.generation += 1;
      this.cancelOperations();
      this.queue.cancelPending();
      const generation = this.generation;
      return this.mutate(async () => {
        if (this.destroyed) return;
        for (const entry of Array.from(this.entries.values())) {
          await unlinkIfPresent(this.fs, this.url(entry.key));
        }
        if (generation !== this.generation || this.destroyed) return;
        this.entries.clear();
        this.pathGenerations.clear();
        await this.persistIndexUnlocked();
      });
    }

    touch(key) {
      const entry = this.entries.get(String(key || ""));
      if (!entry || this.destroyed) return false;
      entry.lastAccessedAt = this.now();
      if (this.touchTimer === null) {
        this.touchTimer = setTimeout(() => {
          this.touchTimer = null;
          const generation = this.generation;
          void this.mutate(async () => {
            this.assertCurrent(generation);
            await this.persistIndexUnlocked();
          }).catch(() => undefined);
        }, 1000);
      }
      return true;
    }

    usage() {
      const totalBytes = Array.from(this.entries.values()).reduce((sum, entry) => sum + entry.bytes, 0);
      return { totalBytes, count: this.entries.size };
    }

    destroy() {
      this.destroyed = true;
      this.generation += 1;
      this.cancelOperations();
      this.queue.destroy();
      if (this.touchTimer !== null) {
        clearTimeout(this.touchTimer);
        this.touchTimer = null;
      }
      for (const temp of Array.from(this.activeTempUrls)) {
        void unlinkIfPresent(this.fs, temp).catch(() => undefined);
      }
      this.activeTempUrls.clear();
      this.activeOperations.clear();
      this.pathGenerations.clear();
      this.entries.clear();
    }
  }

  return {
    BRIDGE_EVENT_SCHEMA,
    BRIDGE_EVENT_VERSION,
    BoundedTaskQueue,
    MAX_DIAGNOSTICS,
    MAX_THUMBNAIL_BYTES,
    MAX_THUMBNAIL_DIMENSION,
    MAX_THUMBNAIL_INDEX_CHARACTERS,
    MAX_THUMBNAIL_INDEX_ENTRIES,
    MAX_THUMBNAIL_INDEX_TOTAL_BYTES,
    MAX_THUMBNAIL_PIXELS,
    MIN_THUMBNAIL_DIMENSION,
    OracleStateRepository,
    REPLAY_METADATA_EXPORT_SCHEMA,
    REPLAY_METADATA_EXPORT_VERSION,
    ReplayLibraryStore,
    ReplayVirtualWindow,
    STATE_BACKUP_URL,
    STATE_TEMP_URL,
    STATE_URL,
    SUPPORTED_MEDIA_EXTENSIONS,
    THUMBNAIL_SCHEMA_VERSION,
    ThumbnailCache,
    chronologicalEntries,
    createReplayMetadataExport,
    dateGroupLabel,
    decodeBase64,
    encodeJpegVariantWithCanvas,
    fileIdentityKey,
    formatReplayDuration,
    matchesSmartRules,
    isSupportedMediaPath,
    normalizeBridgeReplay,
    normalizeReplayMetadataImport,
    normalizeFileIdentity,
    normalizeThumbnailBase64,
    normalizeThumbnailIndexEntry,
    normalizeThumbnailVariant,
    parseJpegFrame,
    physicalFingerprint,
    replayToPresentation,
    selectReplayIds,
    stableJson,
    thumbnailCacheKey,
    validateJpegBytes,
  };
});
