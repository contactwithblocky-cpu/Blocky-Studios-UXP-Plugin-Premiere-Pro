"use strict";

(function exposeOracleDataMigrations(globalScope, factory) {
  const dependency = typeof module === "object" && module && module.exports
    ? require("./oracle-data-schema.js")
    : globalScope && Reflect.get(globalScope, "OracleDataSchema");
  const api = factory(dependency);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleDataMigrations", api);
})(typeof window !== "undefined" ? window : null, function createOracleDataMigrationsApi(schema) {
if (!schema) throw new Error("Blocky Studios data schema did not load before migrations.");
const {
  EMPTY_TIMESTAMP,
  ORACLE_STATE_SCHEMA,
  ORACLE_STATE_VERSION,
  cleanString,
  createEmptyOracleState,
  finiteNumber,
  isAbsoluteWindowsPath,
  isPlainObject,
  isUuid,
  normalizeIsoTimestamp,
  normalizeWindowsPath,
  replayPathKey,
  stableUuidFromSeed,
  uniqueStrings,
  validateOracleState,
} = schema;

function cloneJsonObject(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return {};
  }
}

function sourceFilename(filepath) {
  return cleanString(filepath.replace(/\\/g, "/").split("/").pop(), 260);
}

function sourceName(filepath) {
  return sourceFilename(filepath).replace(/\.[^.]+$/, "");
}

function legacyDurationMs(record) {
  const direct = finiteNumber(record.durationMs, null, 0);
  if (direct !== null) return Math.round(direct);
  const seconds = finiteNumber(record.durationSeconds, null, 0);
  return seconds === null ? null : Math.round(seconds * 1000);
}

function replaySeed(record, path, exportedAt) {
  const legacyId = cleanString(record.id, 256);
  return legacyId
    ? `replay|legacy-id|${legacyId}`
    : `replay|path-time|${replayPathKey(path)}|${exportedAt}`;
}

function migrateReplayRecord(record, context) {
  if (!isPlainObject(record)) return null;
  const canonicalPath = normalizeWindowsPath(
    record.canonicalPath || record.absolutePath || record.filepath || record.filePath,
  );
  if (!isAbsoluteWindowsPath(canonicalPath)) return null;
  const exportedAt = normalizeIsoTimestamp(
    record.exportedAt || record.completedAt || record.timestamp || record.receivedAt,
    context.writtenAt,
  );
  const originalId = cleanString(record.id, 256);
  const id = isUuid(originalId)
    ? originalId.toLocaleLowerCase("en-US")
    : stableUuidFromSeed(replaySeed(record, canonicalPath, exportedAt));
  const title = cleanString(record.displayNameOverride || record.title || record.name, 240);
  const legacy = isPlainObject(record.legacy) ? record.legacy : {};
  const thumbnailCandidate = cleanString(
    legacy.thumbnailPath || record.thumbnail || record.thumbnailPath,
    32767,
  );
  const legacyThumbnailPath = isAbsoluteWindowsPath(thumbnailCandidate)
    ? normalizeWindowsPath(thumbnailCandidate)
    : "";
  const rawThumbnailPresent = Boolean(
    record.thumbnailBase64 ||
      (typeof record.thumbnailDataUrl === "string" && /^data:/i.test(record.thumbnailDataUrl)) ||
      (thumbnailCandidate && !legacyThumbnailPath),
  );
  if (rawThumbnailPresent) context.rawThumbnailDropped = true;
  return {
    id,
    canonicalPath,
    pathKey: replayPathKey(canonicalPath),
    fileIdentity: isPlainObject(record.fileIdentity) ? cloneJsonObject(record.fileIdentity) : null,
    sourceName: cleanString(record.sourceName, 260) || sourceName(canonicalPath),
    displayNameOverride: title,
    fileSize: finiteNumber(record.fileSize ?? record.sizeBytes, null, 0),
    modifiedAt: normalizeIsoTimestamp(record.modifiedAt || record.mtime, null),
    exportedAt,
    firstSeenAt: normalizeIsoTimestamp(record.firstSeenAt, exportedAt),
    durationMs: legacyDurationMs(record),
    thumbnailCacheKey: cleanString(record.thumbnailCacheKey, 512),
    thumbnailStatus: cleanString(record.thumbnailStatus, 64) || "pending",
    archiveState: record.archiveState === "archived" || record.archived === true ? "archived" : "active",
    missingState: ["available", "missing", "unknown", "pending"].includes(record.missingState)
      ? record.missingState
      : "unknown",
    collectionIds: uniqueStrings(record.collectionIds),
    tags: uniqueStrings(record.tags),
    favorite: record.favorite === true,
    rating: Math.round(finiteNumber(record.rating, 0, 0, 5)),
    notes: cleanString(record.notes, 16000),
    usageCount: Math.round(finiteNumber(record.usageCount, 0, 0)),
    lastOpenedAt: normalizeIsoTimestamp(record.lastOpenedAt, null),
    lastDraggedAt: normalizeIsoTimestamp(record.lastDraggedAt, null),
    legacy: {
      id: cleanString(legacy.id, 256) || (isUuid(originalId) ? "" : originalId),
      thumbnailPath: legacyThumbnailPath,
      thumbnailError: cleanString(legacy.thumbnailError || record.thumbnailError, 1000),
      resolution: cleanString(legacy.resolution || record.resolution, 64),
      fps: finiteNumber(legacy.fps ?? record.fps ?? record.frameRate, null, 0),
      timecode: cleanString(legacy.timecode || record.timecode || record.sourceTimecode, 64),
      thumbnailPosition: finiteNumber(
        legacy.thumbnailPosition ?? record.thumbnailPosition,
        0.5,
        0,
        1,
      ),
      thumbnailWidth: Math.round(finiteNumber(
        legacy.thumbnailWidth ?? record.thumbnailWidth,
        640,
        1,
        4096,
      )),
      thumbnailHeight: Math.round(finiteNumber(
        legacy.thumbnailHeight ?? record.thumbnailHeight,
        360,
        1,
        4096,
      )),
    },
  };
}

function normalizeCollection(record, writtenAt, ordinal = 0) {
  if (!isPlainObject(record)) return null;
  const name = cleanString(record.name, 240);
  if (!name) return null;
  const originalId = cleanString(record.id, 256);
  const id = isUuid(originalId)
    ? originalId.toLocaleLowerCase("en-US")
    : stableUuidFromSeed(
      originalId
        ? `collection|legacy-id|${originalId}`
        : `collection|name|${name.toLocaleLowerCase("en-US")}`,
    );
  return {
    id,
    name,
    color: cleanString(record.color, 32),
    icon: cleanString(record.icon, 128),
    createdAt: normalizeIsoTimestamp(record.createdAt, writtenAt),
    updatedAt: normalizeIsoTimestamp(record.updatedAt, writtenAt),
    sortOrder: Math.round(finiteNumber(record.sortOrder, ordinal, 0)),
    manualOrder: uniqueStrings(record.manualOrder, 100000, 64),
    smartRules: isPlainObject(record.smartRules) ? cloneJsonObject(record.smartRules) : null,
  };
}

function normalizeCurvePreset(record, ordinal, writtenAt) {
  if (!isPlainObject(record)) return null;
  const name = cleanString(record.name, 240);
  if (!name) return null;
  const originalId = cleanString(record.id, 256);
  const id = isUuid(originalId)
    ? originalId.toLocaleLowerCase("en-US")
    : stableUuidFromSeed(
      originalId
        ? `curve|legacy-id|${originalId}`
        : `curve|name|${name.toLocaleLowerCase("en-US")}`,
    );
  if (
    record.cubicControlPoints !== undefined &&
    (!Array.isArray(record.cubicControlPoints) ||
      record.cubicControlPoints.length !== 4 ||
      record.cubicControlPoints.some((value) => !Number.isFinite(Number(value))))
  ) {
    return null;
  }
  const points = Array.isArray(record.cubicControlPoints)
    ? record.cubicControlPoints.map((value) => finiteNumber(value, 0, -1000, 1000))
    : [0.25, 0.1, 0.25, 1];
  const folderId = cleanString(
    record.folderId ||
    record.categoryId ||
    (isPlainObject(record.sampleSettings) ? record.sampleSettings.folderId : ""),
    96,
  );
  return {
    id,
    name,
    cubicControlPoints: points,
    applyMode: cleanString(record.applyMode, 64) || "native-interpolation",
    sampleSettings: isPlainObject(record.sampleSettings) ? cloneJsonObject(record.sampleSettings) : {},
    tags: uniqueStrings(record.tags),
    favorite: record.favorite === true,
    folderId: folderId || null,
    createdAt: normalizeIsoTimestamp(record.createdAt, writtenAt),
    updatedAt: normalizeIsoTimestamp(record.updatedAt, writtenAt),
    manualOrder: finiteNumber(record.manualOrder, ordinal, 0),
  };
}

function valuesFrom(value) {
  if (Array.isArray(value)) return value;
  return isPlainObject(value) ? Object.values(value) : [];
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return [];
  return Object.entries(value).map(([id, record]) => (
    isPlainObject(record) && !cleanString(record.id)
      ? Object.assign({ id }, record)
      : record
  ));
}

function parseSource(input) {
  if (typeof input !== "string") return { ok: true, value: input };
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify(String(value));
  }
}

function orderedRecords(values) {
  return (Array.isArray(values) ? values : [])
    .map((record, ordinal) => ({ record, ordinal, sortKey: stableJson(record) }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

function failedMigration(options, writtenAt, diagnostics) {
  return {
    state: createEmptyOracleState({ writtenAt, writerId: options.writerId }),
    diagnostics,
    migrated: false,
    sourceValid: false,
    complete: false,
  };
}

function migrateOracleState(input, options = {}) {
  const parsed = parseSource(input);
  const fallbackWrittenAt = normalizeIsoTimestamp(options.writtenAt, EMPTY_TIMESTAMP);
  if (!parsed.ok || (!Array.isArray(parsed.value) && !isPlainObject(parsed.value))) {
    return failedMigration(options, fallbackWrittenAt, [
      { code: "CORRUPT_OR_UNSUPPORTED_STATE", message: parsed.error || "State root is not an object or array" },
    ]);
  }

  const source = parsed.value;
  const sourceObject = isPlainObject(source);
  const isV3 = sourceObject && source.schema === ORACLE_STATE_SCHEMA && source.version === ORACLE_STATE_VERSION;
  if (sourceObject && (source.schema !== undefined || Number(source.version) >= ORACLE_STATE_VERSION)) {
    if (!isV3) {
      return failedMigration(options, fallbackWrittenAt, [
        { code: "UNSUPPORTED_STATE_VERSION", message: `Unsupported schema/version: ${cleanString(source.schema) || "missing"}/${String(source.version)}` },
      ]);
    }
    const sourceValidation = validateOracleState(source);
    if (!sourceValidation.ok) {
      return failedMigration(
        options,
        fallbackWrittenAt,
        sourceValidation.errors.map((message) => ({ code: "INVALID_V3_SNAPSHOT", message })),
      );
    }
  }
  const isLegacyArray = Array.isArray(source);
  const legacyVersion = sourceObject && source.version !== undefined ? Number(source.version) : 1;
  const hasLegacyRecords = sourceObject && (
    Array.isArray(source.replays) ||
    Array.isArray(source.recentExports)
  );
  if (!isV3 && !isLegacyArray && (
    !hasLegacyRecords ||
    !Number.isInteger(legacyVersion) ||
    legacyVersion < 1 ||
    legacyVersion > 2
  )) {
    return failedMigration(options, fallbackWrittenAt, [
      { code: "UNSUPPORTED_LEGACY_STATE", message: "Legacy state must be an array or a version 1/2 object with replay records" },
    ]);
  }
  const writtenAt = normalizeIsoTimestamp(
    sourceObject && (source.writtenAt || source.savedAt),
    fallbackWrittenAt,
  );
  const state = createEmptyOracleState({
    writtenAt,
    writerId: sourceObject && source.writerId ? source.writerId : options.writerId || "oracle-migration",
    revision: isV3 ? source.revision : 0,
  });
  const diagnostics = [];
  const replayValues = isV3
    ? valuesFrom(source.replaysById)
    : isLegacyArray
      ? source
      : valuesFrom(source.replays || source.recentExports);
  const collectionValues = sourceObject
    ? recordsFrom(source.collectionsById || source.collections)
    : [];
  const curveValues = sourceObject
    ? recordsFrom(source.curvePresetsById || source.curvePresets || source.presets)
    : [];

  let rawThumbnailDropped = false;
  let complete = true;
  const collectionIdMap = new Map();
  for (const { record, ordinal } of orderedRecords(collectionValues)) {
    const collection = normalizeCollection(record, writtenAt, ordinal);
    if (!collection) {
      complete = false;
      diagnostics.push({ code: "COLLECTION_SKIPPED", ordinal, message: "Collection record has no usable name" });
      continue;
    }
    const legacyId = cleanString(record && record.id, 256);
    if (legacyId && !collectionIdMap.has(legacyId)) collectionIdMap.set(legacyId, collection.id);
    collectionIdMap.set(collection.id, collection.id);
    const existing = state.collectionsById[collection.id];
    if (!existing || stableJson(collection) < stableJson(existing)) {
      state.collectionsById[collection.id] = collection;
    }
    if (existing) {
      complete = false;
      diagnostics.push({ code: "DUPLICATE_COLLECTION_COLLAPSED", id: collection.id });
    }
  }

  const replayIdMap = new Map();
  for (const { record, ordinal } of orderedRecords(replayValues)) {
    const replay = migrateReplayRecord(record, {
      writtenAt,
      get rawThumbnailDropped() { return rawThumbnailDropped; },
      set rawThumbnailDropped(value) { rawThumbnailDropped = value; },
    });
    if (!replay) {
      complete = false;
      diagnostics.push({ code: "REPLAY_SKIPPED", ordinal, message: "Replay record has no usable path" });
      continue;
    }
    const legacyId = cleanString(record && record.id, 256);
    if (legacyId && !replayIdMap.has(legacyId)) replayIdMap.set(legacyId, replay.id);
    replayIdMap.set(replay.id, replay.id);
    const existing = state.replaysById[replay.id];
    if (!existing || stableJson(replay) < stableJson(existing)) {
      state.replaysById[replay.id] = replay;
    }
    if (existing) {
      complete = false;
      diagnostics.push({ code: "DUPLICATE_REPLAY_COLLAPSED", id: replay.id });
    }
  }

  for (const replay of Object.values(state.replaysById)) {
    const rewritten = [];
    for (const legacyCollectionId of replay.collectionIds) {
      const collectionId = collectionIdMap.get(legacyCollectionId);
      if (collectionId && state.collectionsById[collectionId]) rewritten.push(collectionId);
      else {
        complete = false;
        diagnostics.push({ code: "COLLECTION_REFERENCE_DROPPED", replayId: replay.id, collectionId: legacyCollectionId });
      }
    }
    replay.collectionIds = uniqueStrings(rewritten, 256, 64);
  }
  for (const collection of Object.values(state.collectionsById)) {
    const rewritten = [];
    for (const legacyReplayId of collection.manualOrder) {
      const replayId = replayIdMap.get(legacyReplayId);
      if (replayId && state.replaysById[replayId]) rewritten.push(replayId);
      else {
        complete = false;
        diagnostics.push({ code: "MANUAL_ORDER_REFERENCE_DROPPED", collectionId: collection.id, replayId: legacyReplayId });
      }
    }
    collection.manualOrder = uniqueStrings(rewritten, 100000, 64);
  }

  for (const { record, ordinal } of orderedRecords(curveValues)) {
    const preset = normalizeCurvePreset(record, ordinal, writtenAt);
    if (!preset) {
      complete = false;
      diagnostics.push({ code: "CURVE_PRESET_SKIPPED", ordinal, message: "Curve preset has no usable name" });
      continue;
    }
    const existing = state.curvePresetsById[preset.id];
    if (!existing || stableJson(preset) < stableJson(existing)) {
      state.curvePresetsById[preset.id] = preset;
    }
    if (existing) {
      complete = false;
      diagnostics.push({ code: "DUPLICATE_CURVE_PRESET_COLLAPSED", id: preset.id });
    }
  }

  if (sourceObject) {
    state.preferences = cloneJsonObject(source.preferences);
    state.quickApplyState = cloneJsonObject(source.quickApplyState);
    state.recipesById = cloneJsonObject(source.recipesById);
    state.tombstones = cloneJsonObject(source.tombstones);
  }
  if (!isV3) diagnostics.unshift({ code: "LEGACY_STATE_MIGRATED", fromVersion: sourceObject ? legacyVersion : 1, toVersion: ORACLE_STATE_VERSION });
  if (rawThumbnailDropped) diagnostics.push({ code: "RAW_THUMBNAIL_DROPPED", message: "Raw image bytes remain live-only and were not migrated" });

  const validation = validateOracleState(state);
  if (!validation.ok) {
    return {
      state: createEmptyOracleState({ writtenAt: fallbackWrittenAt, writerId: options.writerId }),
      diagnostics: diagnostics.concat(validation.errors.map((message) => ({ code: "MIGRATION_VALIDATION_FAILED", message }))),
      migrated: false,
      sourceValid: false,
      complete: false,
    };
  }
  return { state, diagnostics, migrated: !isV3, sourceValid: true, complete };
}

class OracleStateRecoveryError extends Error {
  constructor(diagnostics, sources) {
    super("Blocky Studios state files exist, but none can be recovered safely. Preserve the files and restore a valid backup before continuing.");
    this.name = "OracleStateRecoveryError";
    this.code = "STATE_RECOVERY_REQUIRED";
    this.diagnostics = Array.isArray(diagnostics) ? diagnostics.map((entry) => ({ ...entry })) : [];
    this.details = {
      candidateCount: Array.isArray(sources) ? sources.length : 0,
      rejectedCount: Array.isArray(diagnostics)
        ? diagnostics.filter((entry) => entry && entry.code === "RECOVERY_CANDIDATE_REJECTED").length
        : 0,
      sources: Array.isArray(sources) ? sources.slice() : [],
    };
  }
}

function recoverOracleState(candidates, options = {}) {
  const sourceCandidates = Array.isArray(candidates) ? candidates : [];
  const evaluated = [];
  const rejectedDiagnostics = [];
  const candidateSources = [];
  for (const [index, candidate] of sourceCandidates.entries()) {
    const source = isPlainObject(candidate) && Object.prototype.hasOwnProperty.call(candidate, "value")
      ? cleanString(candidate.source, 64) || `candidate-${index}`
      : `candidate-${index}`;
    candidateSources.push(source);
    const value = isPlainObject(candidate) && Object.prototype.hasOwnProperty.call(candidate, "value") ? candidate.value : candidate;
    let result;
    try {
      result = migrateOracleState(value, options);
    } catch (error) {
      result = {
        sourceValid: false,
        complete: false,
        diagnostics: [{ code: "MIGRATION_EXCEPTION", message: String(error && error.message ? error.message : error) }],
      };
    }
    if (!result.sourceValid || !result.complete) {
      rejectedDiagnostics.push({
        code: "RECOVERY_CANDIDATE_REJECTED",
        source,
        reasons: (result.diagnostics || []).map((entry) => entry.code),
      });
      continue;
    }
    evaluated.push({ source, index, ...result });
  }
  evaluated.sort((left, right) => {
    const revisionDelta = Number(right.state.revision) - Number(left.state.revision);
    if (revisionDelta) return revisionDelta;
    const timeDelta = new Date(right.state.writtenAt).getTime() - new Date(left.state.writtenAt).getTime();
    return timeDelta || left.index - right.index;
  });
  if (evaluated.length === 0) {
    if (sourceCandidates.length > 0) {
      const diagnostics = rejectedDiagnostics.concat({
        code: "STATE_RECOVERY_REQUIRED",
        message: "Blocky Studios state candidates exist, but every candidate is invalid or incomplete.",
        candidateCount: sourceCandidates.length,
      });
      throw new OracleStateRecoveryError(diagnostics, candidateSources);
    }
    return {
      source: null,
      state: createEmptyOracleState({ writtenAt: options.writtenAt, writerId: options.writerId }),
      diagnostics: [{ code: "NO_STATE_CANDIDATES", message: "No Blocky Studios state snapshot exists yet" }],
      recovered: false,
      firstRun: true,
      candidateCount: 0,
    };
  }
  const selected = evaluated[0];
  return {
    source: selected.source,
    state: selected.state,
    diagnostics: rejectedDiagnostics.concat(selected.diagnostics),
    recovered: selected.index !== 0,
    firstRun: false,
    candidateCount: sourceCandidates.length,
  };
}

return {
  OracleStateRecoveryError,
  migrateOracleState,
  recoverOracleState,
};
});
