"use strict";

(function exposeOracleEffectIndex(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleEffectIndex", api);
})(typeof window !== "undefined" ? window : null, function createOracleEffectIndexApi() {
  const EFFECT_INDEX_SCHEMA = "oracle-premiere-effect-index";
  const EFFECT_INDEX_VERSION = 1;
  const MAX_EFFECT_COUNT = 8192;
  const MAX_EFFECT_NAME_LENGTH = 512;
  const MAX_HOST_VERSION_LENGTH = 64;
  const MAX_SEARCH_QUERY_LENGTH = 128;
  const MAX_SEARCH_RESULTS = 250;
  const trustedIndexes = new WeakSet();

  class EffectIndexError extends Error {
    constructor(code, message, details = {}) {
      super(message || "The Premiere effect index is invalid.");
      this.name = "EffectIndexError";
      this.code = String(code || "EFFECT_INDEX_INVALID");
      this.details = details && typeof details === "object" ? { ...details } : {};
    }
  }

  function cleanText(value, maximum = MAX_EFFECT_NAME_LENGTH) {
    return String(value ?? "").trim().slice(0, maximum);
  }

  function foldText(value) {
    return cleanText(value, MAX_SEARCH_QUERY_LENGTH * 4)
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
  }

  function effectIdentityKey(type, displayName, matchName, occurrence) {
    return JSON.stringify([
      type,
      cleanText(matchName),
      cleanText(displayName),
      Number(occurrence),
    ]);
  }

  function effectIdFor(type, displayName, matchName, occurrence) {
    const encoded = encodeURIComponent(effectIdentityKey(type, displayName, matchName, occurrence));
    return `oracle-effect:${encoded}`;
  }

  function normalizeNameArray(value, fieldName) {
    if (!Array.isArray(value)) {
      throw new EffectIndexError("EFFECT_INDEX_FACTORY_RESULT_INVALID", `${fieldName} must be an array.`);
    }
    if (value.length > MAX_EFFECT_COUNT) {
      throw new EffectIndexError("EFFECT_INDEX_LIMIT_EXCEEDED", `${fieldName} exceeded the supported effect count.`, {
        count: value.length,
        maximum: MAX_EFFECT_COUNT,
      });
    }
    return value.map((entry, index) => {
      const normalized = cleanText(entry);
      if (!normalized) {
        throw new EffectIndexError("EFFECT_INDEX_FACTORY_RESULT_INVALID", `${fieldName} contains an empty name.`, { index });
      }
      return normalized;
    });
  }

  function makeEntry(type, displayName, matchName, sourceIndex, occurrence) {
    const displaySearch = foldText(displayName);
    const matchSearch = foldText(matchName || "");
    const searchText = `${displaySearch} ${matchSearch} ${type}`.trim();
    const identity = Object.freeze({
      type,
      displayName,
      matchName,
      occurrence,
    });
    const entry = {
      effectId: effectIdFor(type, displayName, matchName, occurrence),
      type,
      displayName,
      matchName,
      occurrence,
      sourceIndex,
      identity,
      displaySearch,
      matchSearch,
      searchText,
    };
    // Search runs on every keystroke. Cache normalized tokens without adding
    // derived data to the persisted effect-index JSON contract.
    Object.defineProperty(entry, "searchTokens", {
      value: Object.freeze(searchText.split(" ").filter(Boolean)),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return Object.freeze(entry);
  }

  function buildEffectEntries(videoDisplayNamesValue, videoMatchNamesValue, audioDisplayNamesValue) {
    const videoDisplayNames = normalizeNameArray(videoDisplayNamesValue, "videoDisplayNames");
    const videoMatchNames = normalizeNameArray(videoMatchNamesValue, "videoMatchNames");
    const audioDisplayNames = normalizeNameArray(audioDisplayNamesValue, "audioDisplayNames");
    if (videoDisplayNames.length !== videoMatchNames.length) {
      throw new EffectIndexError(
        "VIDEO_EFFECT_MAPPING_MISMATCH",
        "Premiere returned different video display-name and match-name counts; Oracle will not guess the mapping.",
        { displayNameCount: videoDisplayNames.length, matchNameCount: videoMatchNames.length },
      );
    }
    if (videoDisplayNames.length + audioDisplayNames.length > MAX_EFFECT_COUNT) {
      throw new EffectIndexError("EFFECT_INDEX_LIMIT_EXCEEDED", "The combined Premiere effect index is too large.");
    }

    const entries = [];
    const duplicateCounts = new Map();
    for (let index = 0; index < videoDisplayNames.length; index += 1) {
      const displayName = videoDisplayNames[index];
      const matchName = videoMatchNames[index];
      const duplicateKey = JSON.stringify(["video", matchName, displayName]);
      const occurrence = duplicateCounts.get(duplicateKey) || 0;
      duplicateCounts.set(duplicateKey, occurrence + 1);
      entries.push(makeEntry("video", displayName, matchName, index, occurrence));
    }
    for (let index = 0; index < audioDisplayNames.length; index += 1) {
      const displayName = audioDisplayNames[index];
      const duplicateKey = JSON.stringify(["audio", displayName]);
      const occurrence = duplicateCounts.get(duplicateKey) || 0;
      duplicateCounts.set(duplicateKey, occurrence + 1);
      entries.push(makeEntry("audio", displayName, null, index, occurrence));
    }
    return Object.freeze(entries);
  }

  function createEffectIndex(options = {}) {
    const hostVersion = cleanText(options.hostVersion, MAX_HOST_VERSION_LENGTH);
    if (!hostVersion) {
      throw new EffectIndexError("HOST_VERSION_UNAVAILABLE", "Premiere's host version is required for the effect cache.");
    }
    const generatedAt = Number(options.generatedAt);
    const entries = buildEffectEntries(
      options.videoDisplayNames,
      options.videoMatchNames,
      options.audioDisplayNames,
    );
    const videoCount = entries.filter((entry) => entry.type === "video").length;
    const audioCount = entries.length - videoCount;
    const index = Object.freeze({
      schema: EFFECT_INDEX_SCHEMA,
      version: EFFECT_INDEX_VERSION,
      hostVersion,
      generatedAt: Number.isFinite(generatedAt) ? generatedAt : Date.now(),
      entries,
      counts: Object.freeze({ total: entries.length, video: videoCount, audio: audioCount }),
    });
    trustedIndexes.add(index);
    return index;
  }

  function validateEffectEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const type = entry.type === "video" || entry.type === "audio" ? entry.type : null;
    const displayName = cleanText(entry.displayName);
    const matchName = type === "video" ? cleanText(entry.matchName) : null;
    const occurrence = Number(entry.occurrence);
    const sourceIndex = Number(entry.sourceIndex);
    if (!type || !displayName || (type === "video" && !matchName) ||
        !Number.isInteger(occurrence) || occurrence < 0 || !Number.isInteger(sourceIndex) || sourceIndex < 0) {
      return null;
    }
    const expectedId = effectIdFor(type, displayName, matchName, occurrence);
    if (cleanText(entry.effectId, 4096) !== expectedId) return null;
    return makeEntry(type, displayName, matchName, sourceIndex, occurrence);
  }

  function validateEffectIndex(value, options = {}) {
    if (!value || typeof value !== "object" || value.schema !== EFFECT_INDEX_SCHEMA ||
        value.version !== EFFECT_INDEX_VERSION || !Array.isArray(value.entries) ||
        value.entries.length > MAX_EFFECT_COUNT) return null;
    const hostVersion = cleanText(value.hostVersion, MAX_HOST_VERSION_LENGTH);
    const expectedHostVersion = cleanText(options.hostVersion, MAX_HOST_VERSION_LENGTH);
    if (!hostVersion || (expectedHostVersion && hostVersion !== expectedHostVersion)) return null;
    const entries = [];
    const ids = new Set();
    const duplicateProgress = new Map();
    for (const candidate of value.entries) {
      const entry = validateEffectEntry(candidate);
      if (!entry || ids.has(entry.effectId)) return null;
      const duplicateKey = entry.type === "video"
        ? JSON.stringify([entry.type, entry.matchName, entry.displayName])
        : JSON.stringify([entry.type, entry.displayName]);
      const expectedOccurrence = duplicateProgress.get(duplicateKey) || 0;
      if (entry.occurrence !== expectedOccurrence) return null;
      duplicateProgress.set(duplicateKey, expectedOccurrence + 1);
      ids.add(entry.effectId);
      entries.push(entry);
    }
    const generatedAt = Number(value.generatedAt);
    if (!Number.isFinite(generatedAt)) return null;
    const videoCount = entries.filter((entry) => entry.type === "video").length;
    const audioCount = entries.length - videoCount;
    const index = Object.freeze({
      schema: EFFECT_INDEX_SCHEMA,
      version: EFFECT_INDEX_VERSION,
      hostVersion,
      generatedAt,
      entries: Object.freeze(entries),
      counts: Object.freeze({ total: entries.length, video: videoCount, audio: audioCount }),
    });
    trustedIndexes.add(index);
    return index;
  }

  function boundedEditDistance(leftValue, rightValue, maximumDistance = 2) {
    const left = String(leftValue || "");
    const right = String(rightValue || "");
    const maximum = clampInteger(maximumDistance, 0, 3, 2);
    if (left === right) return 0;
    if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
    if (!left.length || !right.length) return Math.max(left.length, right.length);
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      let rowMinimum = current[0];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
        const insertion = current[rightIndex - 1] + 1;
        const deletion = previous[rightIndex] + 1;
        const distance = Math.min(substitution, insertion, deletion);
        current.push(distance);
        rowMinimum = Math.min(rowMinimum, distance);
      }
      if (rowMinimum > maximum) return maximum + 1;
      previous = current;
    }
    return previous[right.length];
  }

  function scoreEffect(entry, foldedQuery, queryTokens, allowFuzzy = true) {
    if (!foldedQuery) return entry.sourceIndex;
    const display = entry.displaySearch;
    const match = entry.matchSearch;
    if (display === foldedQuery) return 0;
    if (display.startsWith(foldedQuery)) return 10 + display.length - foldedQuery.length;
    const displayIndex = display.indexOf(foldedQuery);
    if (displayIndex >= 0) return 30 + displayIndex;
    const matchIndex = match.indexOf(foldedQuery);
    if (matchIndex >= 0) return 45 + matchIndex;
    if (!allowFuzzy) return null;
    const tokens = entry.searchTokens;
    let typoCost = 0;
    for (const queryToken of queryTokens) {
      if (tokens.includes(queryToken)) continue;
      let best = 3;
      for (const token of tokens) {
        const prefix = token.slice(0, Math.max(queryToken.length, Math.min(token.length, queryToken.length + 1)));
        if (Math.abs(queryToken.length - prefix.length) > 2) continue;
        best = Math.min(best, boundedEditDistance(queryToken, prefix, 2));
        if (best === 0) break;
      }
      if (best > 2) return null;
      typoCost += best;
    }
    return 80 + typoCost * 10 + display.length;
  }

  function searchEffectIndex(indexValue, queryValue, options = {}) {
    const index = indexValue && trustedIndexes.has(indexValue)
      ? indexValue
      : validateEffectIndex(indexValue, { hostVersion: indexValue && indexValue.hostVersion });
    if (!index) throw new EffectIndexError("EFFECT_INDEX_INVALID");
    const query = foldText(cleanText(queryValue, MAX_SEARCH_QUERY_LENGTH));
    const queryTokens = query ? query.split(" ").filter(Boolean) : Object.freeze([]);
    const type = options.type === "video" || options.type === "audio" ? options.type : null;
    const limit = clampInteger(options.limit, 1, MAX_SEARCH_RESULTS, 60);
    const ranked = [];
    for (const entry of index.entries) {
      if (type && entry.type !== type) continue;
      const score = scoreEffect(entry, query, queryTokens, false);
      if (score === null) continue;
      ranked.push({ entry, score });
    }
    // Exact, prefix, and substring results are more useful than padded fuzzy
    // near-misses. Run the bounded typo pass only when no direct host-derived
    // result exists; this keeps ordinary 5,000-effect keystrokes deterministic.
    if (query && ranked.length === 0) {
      for (const entry of index.entries) {
        if (type && entry.type !== type) continue;
        const score = scoreEffect(entry, query, queryTokens, true);
        if (score === null) continue;
        ranked.push({ entry, score });
      }
    }
    ranked.sort((left, right) => left.score - right.score ||
      left.entry.displayName.localeCompare(right.entry.displayName) ||
      left.entry.effectId.localeCompare(right.entry.effectId));
    return Object.freeze(ranked.slice(0, limit).map(({ entry, score }) => Object.freeze({ ...entry, searchScore: score })));
  }

  return Object.freeze({
    EffectIndexError,
    EFFECT_INDEX_SCHEMA,
    EFFECT_INDEX_VERSION,
    MAX_EFFECT_COUNT,
    MAX_SEARCH_RESULTS,
    cleanText,
    foldText,
    effectIdentityKey,
    effectIdFor,
    buildEffectEntries,
    createEffectIndex,
    validateEffectIndex,
    boundedEditDistance,
    searchEffectIndex,
  });
});
