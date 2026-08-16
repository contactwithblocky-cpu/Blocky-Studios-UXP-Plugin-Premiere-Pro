"use strict";

(function exposeOracleDataSchema(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleDataSchema", api);
})(typeof window !== "undefined" ? window : null, function createOracleDataSchemaApi() {

const ORACLE_STATE_SCHEMA = "com.blocky.oracle.state";
const ORACLE_STATE_VERSION = 3;
const EMPTY_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanString(value, maximum = 4096) {
  return String(value == null ? "" : value).trim().slice(0, maximum);
}

function normalizeIsoTimestamp(value, fallback = null) {
  const parsed = new Date(value == null ? "" : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function normalizeWindowsPath(value) {
  const path = cleanString(value, 32767);
  if (!path || /[\u0000-\u001f]/.test(path)) {
    return "";
  }
  return path.replace(/\//g, "\\");
}

function replayPathKey(value) {
  return normalizeWindowsPath(value)
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replace(/\\+$/g, "")
    .toLocaleLowerCase("en-US");
}

function isSafeWindowsPathSegment(segment) {
  if (!segment || segment === "." || segment === ".." || /[:\u0000-\u001f]/.test(segment)) {
    return false;
  }
  if (/[. ]$/.test(segment)) return false;
  const basename = segment.split(".")[0].toLocaleUpperCase("en-US");
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(basename);
}

function isAbsoluteWindowsPath(value) {
  const path = normalizeWindowsPath(value);
  if (!path) return false;
  let segments = null;
  let minimumSegments = 0;
  if (/^\\\\\?\\UNC\\/i.test(path)) {
    segments = path.slice(8).split("\\");
    minimumSegments = 2;
  } else if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) {
    segments = path.slice(7).split("\\");
  } else if (/^[A-Za-z]:\\/.test(path)) {
    segments = path.slice(3).split("\\");
  } else if (/^\\\\(?![.?]\\)/.test(path)) {
    segments = path.slice(2).split("\\");
    minimumSegments = 2;
  } else {
    return false;
  }
  while (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();
  if (segments.length < minimumSegments) return false;
  return segments.every(isSafeWindowsPathSegment);
}

function isUuid(value) {
  return UUID_PATTERN.test(cleanString(value, 64));
}

function hash32(value, seed) {
  let hash = seed >>> 0;
  const input = String(value);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function stableUuidFromSeed(seed) {
  const input = cleanString(seed, 131072) || "oracle-empty-seed";
  const words = [
    hash32(`0:${input}`, 0x811c9dc5),
    hash32(`1:${input}`, 0x9e3779b9),
    hash32(`2:${input}`, 0x85ebca6b),
    hash32(`3:${input}`, 0xc2b2ae35),
  ];
  const bytes = [];
  for (const word of words) {
    bytes.push(
      (word >>> 24) & 0xff,
      (word >>> 16) & 0xff,
      (word >>> 8) & 0xff,
      word & 0xff,
    );
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uniqueStrings(values, maximumItems = 256, maximumLength = 240) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const clean = cleanString(value, maximumLength);
    if (!clean || seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    result.push(clean);
    if (result.length >= maximumItems) {
      break;
    }
  }
  return result;
}

function finiteNumber(value, fallback = null, minimum = -Infinity, maximum = Infinity) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : fallback;
}

function isFiniteNumberInRange(value, minimum, maximum = Infinity) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function createEmptyOracleState(options = {}) {
  const writtenAt = normalizeIsoTimestamp(options.writtenAt, EMPTY_TIMESTAMP);
  return {
    schema: ORACLE_STATE_SCHEMA,
    version: ORACLE_STATE_VERSION,
    revision: Math.max(0, Math.trunc(finiteNumber(options.revision, 0, 0))),
    writtenAt,
    writerId: cleanString(options.writerId, 128) || "oracle-overdrive",
    replaysById: {},
    collectionsById: {},
    curvePresetsById: {},
    preferences: {},
    quickApplyState: {},
    recipesById: {},
    tombstones: {},
  };
}

function validateReplayRecord(record, key) {
  const errors = [];
  if (!isPlainObject(record)) errors.push(`${key} must be an object`);
  if (!record || !isUuid(record.id) || record.id !== key) errors.push(`${key} must use its UUID id as the key`);
  if (!record || !isAbsoluteWindowsPath(record.canonicalPath)) errors.push(`${key} is missing an absolute canonicalPath`);
  if (!record || replayPathKey(record.canonicalPath) !== record.pathKey) errors.push(`${key} has an invalid pathKey`);
  if (!record || !Array.isArray(record.collectionIds)) errors.push(`${key} collectionIds must be an array`);
  if (!record || !Array.isArray(record.tags)) errors.push(`${key} tags must be an array`);
  if (record && Array.isArray(record.collectionIds) && record.collectionIds.some((id) => !isUuid(id))) errors.push(`${key} collectionIds must contain UUIDs`);
  if (record && Array.isArray(record.tags) && record.tags.some((tag) => typeof tag !== "string")) errors.push(`${key} tags must contain strings`);
  if (!record || typeof record.sourceName !== "string") errors.push(`${key} sourceName must be a string`);
  if (!record || typeof record.displayNameOverride !== "string") errors.push(`${key} displayNameOverride must be a string`);
  if (record && record.fileIdentity !== null && !isPlainObject(record.fileIdentity)) errors.push(`${key} fileIdentity must be null or an object`);
  if (record && record.fileSize !== null && !isFiniteNumberInRange(record.fileSize, 0)) errors.push(`${key} fileSize must be null or non-negative`);
  if (record && record.durationMs !== null && !isFiniteNumberInRange(record.durationMs, 0)) errors.push(`${key} durationMs must be null or non-negative`);
  for (const field of ["exportedAt", "firstSeenAt"]) {
    if (!record || normalizeIsoTimestamp(record[field], null) !== record[field]) errors.push(`${key} ${field} must be an ISO timestamp`);
  }
  for (const field of ["modifiedAt", "lastOpenedAt", "lastDraggedAt"]) {
    if (record && record[field] !== null && normalizeIsoTimestamp(record[field], null) !== record[field]) errors.push(`${key} ${field} must be null or an ISO timestamp`);
  }
  if (!record || typeof record.thumbnailCacheKey !== "string" || typeof record.thumbnailStatus !== "string") errors.push(`${key} thumbnail metadata is invalid`);
  if (!record || !["active", "archived"].includes(record.archiveState) || !["available", "missing", "unknown", "pending"].includes(record.missingState)) errors.push(`${key} lifecycle state is invalid`);
  if (!record || typeof record.favorite !== "boolean") errors.push(`${key} favorite must be boolean`);
  if (!record || !isFiniteNumberInRange(record.rating, 0, 5)) errors.push(`${key} rating must be between 0 and 5`);
  if (!record || typeof record.notes !== "string") errors.push(`${key} notes must be a string`);
  if (!record || !Number.isInteger(record.usageCount) || record.usageCount < 0) errors.push(`${key} usageCount must be a non-negative integer`);
  return errors;
}

function validateCollectionRecord(record, key) {
  const errors = [];
  if (!isPlainObject(record) || !isUuid(record.id) || record.id !== key) errors.push(`${key} collection must use its UUID id as the key`);
  if (!record || typeof record.name !== "string" || !record.name) errors.push(`${key} collection name is required`);
  if (!record || typeof record.color !== "string" || typeof record.icon !== "string") errors.push(`${key} collection presentation is invalid`);
  if (!record || normalizeIsoTimestamp(record.createdAt, null) !== record.createdAt || normalizeIsoTimestamp(record.updatedAt, null) !== record.updatedAt) errors.push(`${key} collection timestamps are invalid`);
  if (!record || !Number.isInteger(record.sortOrder) || record.sortOrder < 0) errors.push(`${key} collection sortOrder must be a non-negative integer`);
  if (!record || !Array.isArray(record.manualOrder)) errors.push(`${key} collection manualOrder must be an array`);
  if (record && Array.isArray(record.manualOrder) && record.manualOrder.some((id) => !isUuid(id))) errors.push(`${key} collection manualOrder must contain UUIDs`);
  if (record && record.smartRules !== null && !isPlainObject(record.smartRules)) errors.push(`${key} smartRules must be null or an object`);
  return errors;
}

function validateCurvePresetRecord(record, key) {
  const errors = [];
  if (!isPlainObject(record) || !isUuid(record.id) || record.id !== key) errors.push(`${key} curve preset must use its UUID id as the key`);
  if (!record || typeof record.name !== "string" || !record.name) errors.push(`${key} curve preset name is required`);
  if (!record || !Array.isArray(record.cubicControlPoints) || record.cubicControlPoints.length !== 4 || record.cubicControlPoints.some((value) => !Number.isFinite(value))) errors.push(`${key} cubicControlPoints must contain four finite numbers`);
  if (!record || typeof record.applyMode !== "string" || !isPlainObject(record.sampleSettings)) errors.push(`${key} curve apply settings are invalid`);
  if (!record || !Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string") || typeof record.favorite !== "boolean") errors.push(`${key} curve tags/favorite are invalid`);
  if (
    record &&
    record.folderId !== null &&
    record.folderId !== undefined &&
    (typeof record.folderId !== "string" || record.folderId.length > 96)
  ) {
    errors.push(`${key} curve folderId must be null or a bounded string`);
  }
  if (!record || normalizeIsoTimestamp(record.createdAt, null) !== record.createdAt || normalizeIsoTimestamp(record.updatedAt, null) !== record.updatedAt) errors.push(`${key} curve timestamps are invalid`);
  if (!record || !isFiniteNumberInRange(record.manualOrder, 0)) errors.push(`${key} curve manualOrder must be non-negative`);
  return errors;
}

function validateOracleState(state) {
  const errors = [];
  if (!isPlainObject(state)) {
    return { ok: false, errors: ["State must be an object"] };
  }
  if (state.schema !== ORACLE_STATE_SCHEMA) errors.push("Unsupported Oracle state schema");
  if (state.version !== ORACLE_STATE_VERSION) errors.push("Unsupported Oracle state version");
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push("revision must be a non-negative integer");
  if (normalizeIsoTimestamp(state.writtenAt, null) !== state.writtenAt) errors.push("writtenAt must be an ISO timestamp");
  if (typeof state.writerId !== "string" || !state.writerId) errors.push("writerId is required");
  for (const field of ["replaysById", "collectionsById", "curvePresetsById", "preferences", "quickApplyState", "recipesById", "tombstones"]) {
    if (!isPlainObject(state[field])) errors.push(`${field} must be an object`);
  }
  for (const [id, replay] of Object.entries(isPlainObject(state.replaysById) ? state.replaysById : {})) {
    errors.push(...validateReplayRecord(replay, id));
  }
  for (const [id, collection] of Object.entries(isPlainObject(state.collectionsById) ? state.collectionsById : {})) {
    errors.push(...validateCollectionRecord(collection, id));
  }
  for (const [id, preset] of Object.entries(isPlainObject(state.curvePresetsById) ? state.curvePresetsById : {})) {
    errors.push(...validateCurvePresetRecord(preset, id));
  }
  if (isPlainObject(state.replaysById) && isPlainObject(state.collectionsById)) {
    for (const [id, replay] of Object.entries(state.replaysById)) {
      for (const collectionId of Array.isArray(replay.collectionIds) ? replay.collectionIds : []) {
        if (!state.collectionsById[collectionId]) errors.push(`${id} references missing collection ${collectionId}`);
      }
    }
    for (const [id, collection] of Object.entries(state.collectionsById)) {
      for (const replayId of Array.isArray(collection.manualOrder) ? collection.manualOrder : []) {
        if (!state.replaysById[replayId]) errors.push(`${id} manualOrder references missing replay ${replayId}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

return {
  EMPTY_TIMESTAMP,
  ORACLE_STATE_SCHEMA,
  ORACLE_STATE_VERSION,
  UUID_PATTERN,
  cleanString,
  createEmptyOracleState,
  finiteNumber,
  isPlainObject,
  isUuid,
  isAbsoluteWindowsPath,
  normalizeIsoTimestamp,
  normalizeWindowsPath,
  replayPathKey,
  stableUuidFromSeed,
  uniqueStrings,
  validateOracleState,
};
});
