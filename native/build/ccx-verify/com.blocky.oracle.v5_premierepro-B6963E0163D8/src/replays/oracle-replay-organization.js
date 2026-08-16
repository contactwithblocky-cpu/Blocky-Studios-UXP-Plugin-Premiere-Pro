"use strict";

(function exposeOracleReplayOrganization(globalScope, factory) {
  const dependency = typeof module === "object" && module && module.exports
    ? require("../data/oracle-data-schema.js")
    : globalScope && Reflect.get(globalScope, "OracleDataSchema");
  const api = factory(dependency);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleReplayOrganization", api);
})(typeof window !== "undefined" ? window : null, function createOracleReplayOrganizationApi(schema) {
  if (!schema) throw new Error("Blocky Studios data schema did not load before replay organization.");

  const MAX_COLLECTIONS = 1000;
  const MAX_RULES = 32;
  const MAX_REPLAY_BATCH = 5000;
  const MAX_SELECTION = 5000;
  const MAX_RELINK_ROOTS = 32;
  const MAX_RELINK_CANDIDATES = 2000;
  const MAX_BATCH_RELINK = 500;
  const DEFAULT_RECENT_DAYS = 30;
  const DEFAULT_COLLECTION_COLOR = "#c83cff";
  const SUPPORTED_MEDIA_EXTENSIONS = new Set([
    ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv",
  ]);
  const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
  const RULE_OPERATORS = Object.freeze({
    date: Object.freeze(["before", "after", "onOrBefore", "onOrAfter", "between", "withinDays"]),
    duration: Object.freeze(["lessThan", "atMost", "greaterThan", "atLeast", "between"]),
    root: Object.freeze(["is", "isUnder"]),
    tag: Object.freeze(["contains", "notContains"]),
    favorite: Object.freeze(["is"]),
    missing: Object.freeze(["is"]),
    name: Object.freeze(["contains", "startsWith", "equals"]),
  });
  const SMART_RULE_FIELDS = Object.freeze([
    Object.freeze({ field: "date", label: "Date", operators: RULE_OPERATORS.date }),
    Object.freeze({ field: "duration", label: "Duration", operators: RULE_OPERATORS.duration }),
    Object.freeze({ field: "root", label: "Path root", operators: RULE_OPERATORS.root }),
    Object.freeze({ field: "tag", label: "Tag", operators: RULE_OPERATORS.tag }),
    Object.freeze({ field: "favorite", label: "Favorite", operators: RULE_OPERATORS.favorite }),
    Object.freeze({ field: "missing", label: "Missing media", operators: RULE_OPERATORS.missing }),
    Object.freeze({ field: "name", label: "Name", operators: RULE_OPERATORS.name }),
  ]);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  /** @returns {any} */
  function failure(code, message, details = {}) {
    return { ok: false, code, message, ...details };
  }

  function toIso(value, fallback = null) {
    return schema.normalizeIsoTimestamp(value, fallback);
  }

  function nowIso(options = {}) {
    const supplied = typeof options.now === "function" ? options.now() : options.now;
    return toIso(supplied, new Date().toISOString());
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? Math.min(maximum, Math.max(minimum, Math.trunc(numeric)))
      : fallback;
  }

  function sourceFilename(filepath) {
    return schema.cleanString(schema.normalizeWindowsPath(filepath).split("\\").pop(), 260);
  }

  function extensionOf(value) {
    const name = sourceFilename(value);
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index).toLocaleLowerCase("en-US") : "";
  }

  function sourceStem(value) {
    const name = sourceFilename(value);
    const extension = extensionOf(name);
    return extension ? name.slice(0, -extension.length) : name;
  }

  function parentPath(value) {
    const path = schema.normalizeWindowsPath(value);
    const index = path.lastIndexOf("\\");
    return index > 0 ? path.slice(0, index) : "";
  }

  function isSupportedMediaPath(value) {
    return schema.isAbsoluteWindowsPath(value) && SUPPORTED_MEDIA_EXTENSIONS.has(extensionOf(value));
  }

  function isSafeFilename(value) {
    const name = schema.cleanString(value, 260);
    if (!name || name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
    if (/[. ]$/.test(name)) return false;
    const base = name.split(".")[0].toLocaleUpperCase("en-US");
    return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base);
  }

  function stableObject(value) {
    if (Array.isArray(value)) return `[${value.map(stableObject).join(",")}]`;
    if (schema.isPlainObject(value)) {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableObject(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function fileIdentityKey(value) {
    if (!schema.isPlainObject(value) || Object.keys(value).length === 0) return "";
    return stableObject(value);
  }

  function validateState(state) {
    const validation = schema.validateOracleState(state);
    return validation.ok ? null : failure("INVALID_STATE", validation.errors.join(" "), { errors: validation.errors });
  }

  function finalize(kind, state, details = {}) {
    const invalid = validateState(state);
    return invalid || { ok: true, kind, state, ...details };
  }

  function orderedUniqueIds(values, maximum = MAX_REPLAY_BATCH) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const id = schema.cleanString(value, 64).toLocaleLowerCase("en-US");
      if (!schema.isUuid(id) || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
      if (result.length >= maximum) break;
    }
    return result;
  }

  function cleanTags(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const tag = schema.cleanString(value, 240);
      const key = tag.toLocaleLowerCase("en-US");
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      result.push(tag);
      if (result.length >= 256) break;
    }
    return result;
  }

  function existingReplayIds(state, values, maximum = MAX_REPLAY_BATCH) {
    const ids = orderedUniqueIds(values, maximum);
    const missing = ids.filter((id) => !state.replaysById[id]);
    return missing.length > 0
      ? failure("UNKNOWN_REPLAY", `Unknown replay record: ${missing[0]}`, { ids, missingIds: missing })
      : { ok: true, ids };
  }

  function existingCollectionIds(state, values, options = {}) {
    const ids = orderedUniqueIds(values, 256);
    const missing = ids.filter((id) => !state.collectionsById[id]);
    if (missing.length > 0) return failure("UNKNOWN_COLLECTION", `Unknown collection: ${missing[0]}`, { ids, missingIds: missing });
    if (options.manualOnly === true) {
      const smart = ids.filter((id) => Boolean(state.collectionsById[id].smartRules));
      if (smart.length > 0) {
        return failure("SMART_COLLECTION_RULE_DRIVEN", "Smart collection membership is controlled by its rules.", { collectionIds: smart });
      }
    }
    return { ok: true, ids };
  }

  function synchronizeReplayCollectionOrder(state, replayId, previousIds, nextIds) {
    const previous = new Set(previousIds);
    const next = new Set(nextIds);
    for (const collection of Object.values(state.collectionsById)) {
      if (previous.has(collection.id) && !next.has(collection.id)) {
        collection.manualOrder = collection.manualOrder.filter((id) => id !== replayId);
      } else if (!previous.has(collection.id) && next.has(collection.id) && !collection.smartRules && !collection.manualOrder.includes(replayId)) {
        collection.manualOrder.push(replayId);
      }
    }
  }

  function collectionNameExists(state, name, exceptId = "") {
    const key = name.toLocaleLowerCase("en-US");
    return Object.values(state.collectionsById).some((collection) => (
      collection.id !== exceptId && collection.name.toLocaleLowerCase("en-US") === key
    ));
  }

  function uniqueCollectionName(state, proposed, exceptId = "") {
    const base = schema.cleanString(proposed, 240) || "Untitled Collection";
    if (!collectionNameExists(state, base, exceptId)) return base;
    for (let suffix = 2; suffix <= MAX_COLLECTIONS + 1; suffix += 1) {
      const suffixText = ` ${suffix}`;
      const candidate = `${base.slice(0, 240 - suffixText.length)}${suffixText}`;
      if (!collectionNameExists(state, candidate, exceptId)) return candidate;
    }
    return "";
  }

  function createCollectionId(state, name, timestamp, requestedId = "") {
    if (requestedId) {
      const id = schema.cleanString(requestedId, 64).toLocaleLowerCase("en-US");
      if (!schema.isUuid(id)) return failure("INVALID_COLLECTION_ID", "Collection ID must be a UUID.");
      if (state.collectionsById[id]) return failure("COLLECTION_ID_EXISTS", "Collection ID already exists.");
      return { ok: true, id };
    }
    for (let ordinal = 0; ordinal <= MAX_COLLECTIONS; ordinal += 1) {
      const id = schema.stableUuidFromSeed(`collection|${name}|${timestamp}|${ordinal}`);
      if (!state.collectionsById[id]) return { ok: true, id };
    }
    return failure("COLLECTION_LIMIT", "Could not allocate a collection ID.");
  }

  function organizationPreferences(state) {
    const root = schema.isPlainObject(state.preferences.replayOrganization)
      ? state.preferences.replayOrganization
      : {};
    return clone(root);
  }

  function writeOrganizationPreferences(state, preferences) {
    state.preferences = { ...state.preferences, replayOrganization: clone(preferences) };
  }

  function createCollectionPlan(state, input = {}, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    if (Object.keys(state.collectionsById).length >= MAX_COLLECTIONS) {
      return failure("COLLECTION_LIMIT", `Blocky Studios supports at most ${MAX_COLLECTIONS} collections.`);
    }
    const requestedName = schema.cleanString(input.name, 240);
    if (!requestedName) return failure("COLLECTION_NAME_REQUIRED", "Collection name is required.");
    if (collectionNameExists(state, requestedName)) {
      return failure("COLLECTION_NAME_EXISTS", "A collection with that name already exists.");
    }
    const color = schema.cleanString(input.color || DEFAULT_COLLECTION_COLOR, 32);
    if (!COLOR_PATTERN.test(color)) return failure("INVALID_COLLECTION_COLOR", "Collection color must be a six-digit hex color.");
    let normalizedRules = null;
    if (input.smartRules !== undefined && input.smartRules !== null) {
      const result = normalizeSmartRules(input.smartRules);
      if (!result.ok) return result;
      normalizedRules = result.value;
    }
    const timestamp = nowIso(options);
    const idResult = createCollectionId(state, requestedName, timestamp, options.id || input.id);
    if (!idResult.ok) return idResult;
    const collection = {
      id: idResult.id,
      name: requestedName,
      color: color.toLocaleLowerCase("en-US"),
      icon: schema.cleanString(input.icon, 128) || (normalizedRules ? "search" : "collection"),
      createdAt: timestamp,
      updatedAt: timestamp,
      sortOrder: Object.values(state.collectionsById).reduce((maximum, candidate) => (
        Math.max(maximum, Number.isInteger(candidate.sortOrder) ? candidate.sortOrder : 0)
      ), -1) + 1,
      manualOrder: [],
      smartRules: normalizedRules,
    };
    const next = clone(state);
    next.collectionsById[collection.id] = collection;
    const preferences = organizationPreferences(next);
    preferences.collectionOrder = deterministicCollectionOrder(next, [
      ...(Array.isArray(preferences.collectionOrder) ? preferences.collectionOrder : []),
      collection.id,
    ]);
    writeOrganizationPreferences(next, preferences);
    return finalize("collection.create", next, { collection: clone(collection) });
  }

  function renameCollectionPlan(state, collectionId, name, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US");
    const collection = state.collectionsById[id];
    if (!collection) return failure("UNKNOWN_COLLECTION", "Collection does not exist.");
    const nextName = schema.cleanString(name, 240);
    if (!nextName) return failure("COLLECTION_NAME_REQUIRED", "Collection name is required.");
    if (collectionNameExists(state, nextName, id)) return failure("COLLECTION_NAME_EXISTS", "A collection with that name already exists.");
    const next = clone(state);
    next.collectionsById[id] = { ...next.collectionsById[id], name: nextName, updatedAt: nowIso(options) };
    return finalize("collection.rename", next, { collection: clone(next.collectionsById[id]) });
  }

  function recolorCollectionPlan(state, collectionId, color, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US");
    if (!state.collectionsById[id]) return failure("UNKNOWN_COLLECTION", "Collection does not exist.");
    const nextColor = schema.cleanString(color, 32).toLocaleLowerCase("en-US");
    if (!COLOR_PATTERN.test(nextColor)) return failure("INVALID_COLLECTION_COLOR", "Collection color must be a six-digit hex color.");
    const next = clone(state);
    next.collectionsById[id] = { ...next.collectionsById[id], color: nextColor, updatedAt: nowIso(options) };
    return finalize("collection.recolor", next, { collection: clone(next.collectionsById[id]) });
  }

  function deterministicCollectionOrder(state, requestedIds = []) {
    const validIds = new Set(Object.keys(state.collectionsById));
    const result = [];
    const seen = new Set();
    const append = (id) => {
      if (validIds.has(id) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    };
    for (const id of orderedUniqueIds(requestedIds, MAX_COLLECTIONS)) append(id);
    const preferences = organizationPreferences(state);
    for (const id of orderedUniqueIds(preferences.collectionOrder, MAX_COLLECTIONS)) append(id);
    Object.values(state.collectionsById)
      .sort((left, right) => (
        (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
        left.id.localeCompare(right.id)
      ))
      .forEach((collection) => append(collection.id));
    return result;
  }

  function reorderCollectionsPlan(state, requestedIds) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const requested = orderedUniqueIds(requestedIds, MAX_COLLECTIONS);
    const unknown = requested.filter((id) => !state.collectionsById[id]);
    if (unknown.length > 0) return failure("UNKNOWN_COLLECTION", `Unknown collection: ${unknown[0]}`);
    const order = deterministicCollectionOrder(state, requested);
    const next = clone(state);
    order.forEach((id, index) => {
      next.collectionsById[id] = { ...next.collectionsById[id], sortOrder: index };
    });
    const preferences = organizationPreferences(next);
    preferences.collectionOrder = order;
    writeOrganizationPreferences(next, preferences);
    return finalize("collection.reorder", next, { collectionOrder: [...order] });
  }

  function duplicateCollectionPlan(state, collectionId, input = {}, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const source = state.collectionsById[schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US")];
    if (!source) return failure("UNKNOWN_COLLECTION", "Collection does not exist.");
    const proposedName = schema.cleanString(input.name, 240) || `${source.name} Copy`;
    const name = uniqueCollectionName(state, proposedName);
    if (!name) return failure("COLLECTION_NAME_UNAVAILABLE", "Could not create a unique collection name.");
    const created = createCollectionPlan(state, {
      name,
      color: input.color || source.color || DEFAULT_COLLECTION_COLOR,
      icon: input.icon || source.icon,
      smartRules: clone(source.smartRules),
    }, options);
    if (!created.ok) return created;
    const duplicated = created.state.collectionsById[created.collection.id];
    if (!source.smartRules) {
      const sourceMembers = Object.values(created.state.replaysById)
        .filter((record) => record.collectionIds.includes(source.id))
        .map((record) => record.id);
      for (const replayId of sourceMembers) {
        created.state.replaysById[replayId].collectionIds = [
          ...created.state.replaysById[replayId].collectionIds,
          duplicated.id,
        ];
      }
      duplicated.manualOrder = deterministicManualOrder(created.state, source.id, source.manualOrder);
    }
    return finalize("collection.duplicate", created.state, {
      sourceCollectionId: source.id,
      collection: clone(duplicated),
    });
  }

  function deleteCollectionPlan(state, collectionId) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US");
    const collection = state.collectionsById[id];
    if (!collection) return failure("UNKNOWN_COLLECTION", "Collection does not exist.");
    const next = clone(state);
    delete next.collectionsById[id];
    const changedReplayIds = [];
    for (const replay of Object.values(next.replaysById)) {
      if (!replay.collectionIds.includes(id)) continue;
      replay.collectionIds = replay.collectionIds.filter((candidate) => candidate !== id);
      changedReplayIds.push(replay.id);
    }
    const preferences = organizationPreferences(next);
    preferences.collectionOrder = deterministicCollectionOrder(next, preferences.collectionOrder);
    preferences.collectionOrder.forEach((collectionId, index) => {
      next.collectionsById[collectionId] = { ...next.collectionsById[collectionId], sortOrder: index };
    });
    writeOrganizationPreferences(next, preferences);
    return finalize("collection.delete", next, {
      collection: clone(collection),
      changedReplayIds,
    });
  }

  function normalizeMetadataPatch(state, patch) {
    if (!schema.isPlainObject(patch)) return failure("INVALID_METADATA_PATCH", "Replay metadata patch must be an object.");
    const allowed = new Set(["displayName", "displayNameOverride", "collectionIds", "tags", "favorite", "rating", "notes"]);
    const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
    if (unknown.length > 0) return failure("UNSUPPORTED_METADATA_FIELD", `Unsupported replay metadata field: ${unknown[0]}`);
    const normalized = {};
    if (Object.prototype.hasOwnProperty.call(patch, "displayName") || Object.prototype.hasOwnProperty.call(patch, "displayNameOverride")) {
      normalized.displayNameOverride = schema.cleanString(
        Object.prototype.hasOwnProperty.call(patch, "displayNameOverride") ? patch.displayNameOverride : patch.displayName,
        240,
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "collectionIds")) {
      const result = existingCollectionIds(state, patch.collectionIds, { manualOnly: true });
      if (!result.ok) return result;
      normalized.collectionIds = result.ids;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) normalized.tags = cleanTags(patch.tags);
    if (Object.prototype.hasOwnProperty.call(patch, "favorite")) {
      if (typeof patch.favorite !== "boolean") return failure("INVALID_FAVORITE", "Favorite must be true or false.");
      normalized.favorite = patch.favorite;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "rating")) {
      const rating = Number(patch.rating);
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) return failure("INVALID_RATING", "Rating must be an integer from 0 to 5.");
      normalized.rating = rating;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
      normalized.notes = schema.cleanString(patch.notes, 16000);
    }
    return { ok: true, patch: normalized };
  }

  function planReplayMetadata(state, replayIds, patch) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const selected = existingReplayIds(state, replayIds);
    if (!selected.ok) return selected;
    if (selected.ids.length === 0) return failure("EMPTY_REPLAY_BATCH", "Select at least one replay.");
    const normalized = normalizeMetadataPatch(state, patch);
    if (!normalized.ok) return normalized;
    if (Object.keys(normalized.patch).length === 0) return failure("EMPTY_METADATA_PATCH", "No replay metadata changes were provided.");
    const next = clone(state);
    for (const id of selected.ids) {
      const previous = next.replaysById[id];
      next.replaysById[id] = { ...previous, ...clone(normalized.patch) };
      if (normalized.patch.collectionIds) {
        synchronizeReplayCollectionOrder(next, id, previous.collectionIds, normalized.patch.collectionIds);
      }
    }
    return finalize("replay.metadata", next, {
      replayIds: selected.ids,
      replayPatches: selected.ids.map((id) => ({ id, patch: clone(normalized.patch) })),
    });
  }

  function applySetMode(current, values, mode, key = (value) => value) {
    const initial = Array.isArray(current) ? [...current] : [];
    const additions = Array.isArray(values) ? values : [];
    if (mode === "set") return [...additions];
    if (mode === "add") {
      const seen = new Set(initial.map(key));
      for (const value of additions) if (!seen.has(key(value))) {
        seen.add(key(value));
        initial.push(value);
      }
      return initial;
    }
    if (mode === "remove") {
      const removed = new Set(additions.map(key));
      return initial.filter((value) => !removed.has(key(value)));
    }
    return null;
  }

  function planBatchReplayAction(state, replayIds, action) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const selected = existingReplayIds(state, replayIds);
    if (!selected.ok) return selected;
    if (selected.ids.length === 0) return failure("EMPTY_REPLAY_BATCH", "Select at least one replay.");
    if (!schema.isPlainObject(action)) return failure("INVALID_BATCH_ACTION", "Batch action must be an object.");
    const next = clone(state);
    const patches = [];
    const mode = schema.cleanString(action.mode, 16) || "set";
    for (const id of selected.ids) {
      const record = next.replaysById[id];
      let patch = null;
      if (action.type === "collection") {
        const collections = existingCollectionIds(state, action.collectionIds, { manualOnly: true });
        if (!collections.ok) return collections;
        const collectionIds = applySetMode(record.collectionIds, collections.ids, mode);
        if (!collectionIds) return failure("INVALID_BATCH_MODE", "Collection mode must be set, add, or remove.");
        patch = { collectionIds };
      } else if (action.type === "tag") {
        const tags = cleanTags(action.tags);
        const merged = applySetMode(record.tags, tags, mode, (value) => value.toLocaleLowerCase("en-US"));
        if (!merged) return failure("INVALID_BATCH_MODE", "Tag mode must be set, add, or remove.");
        patch = { tags: cleanTags(merged) };
      } else if (action.type === "favorite") {
        if (typeof action.value !== "boolean") return failure("INVALID_FAVORITE", "Favorite must be true or false.");
        patch = { favorite: action.value };
      } else if (action.type === "rating") {
        const rating = Number(action.value);
        if (!Number.isInteger(rating) || rating < 0 || rating > 5) return failure("INVALID_RATING", "Rating must be an integer from 0 to 5.");
        patch = { rating };
      } else if (action.type === "archive" || action.type === "restore") {
        patch = { archiveState: action.type === "archive" ? "archived" : "active" };
      } else {
        return failure("UNSUPPORTED_BATCH_ACTION", `Unsupported batch action: ${schema.cleanString(action.type, 32) || "missing"}`);
      }
      next.replaysById[id] = { ...record, ...patch };
      if (patch.collectionIds) synchronizeReplayCollectionOrder(next, id, record.collectionIds, patch.collectionIds);
      patches.push({ id, patch });
    }
    return finalize(`replay.batch.${action.type}`, next, { replayIds: selected.ids, replayPatches: patches });
  }

  function deterministicManualOrder(state, collectionId, requestedIds = []) {
    const collection = state.collectionsById[collectionId];
    if (!collection) return [];
    const members = Object.values(state.replaysById)
      .filter((replay) => replay.collectionIds.includes(collectionId))
      .map((replay) => replay.id);
    const memberSet = new Set(members);
    const result = [];
    const seen = new Set();
    const append = (id) => {
      if (memberSet.has(id) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    };
    orderedUniqueIds(requestedIds).forEach(append);
    orderedUniqueIds(collection.manualOrder).forEach(append);
    members.sort().forEach(append);
    return result;
  }

  function reorderCollectionReplaysPlan(state, collectionId, requestedIds, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US");
    const collection = state.collectionsById[id];
    if (!collection) return failure("UNKNOWN_COLLECTION", "Collection does not exist.");
    if (collection.smartRules) return failure("SMART_COLLECTION_MANUAL_ORDER", "Smart collections use rule order and cannot be manually reordered.");
    const requested = orderedUniqueIds(requestedIds);
    const nonMembers = requested.filter((replayId) => (
      !state.replaysById[replayId] || !state.replaysById[replayId].collectionIds.includes(id)
    ));
    if (nonMembers.length > 0) return failure("REPLAY_NOT_IN_COLLECTION", `Replay is not in this collection: ${nonMembers[0]}`);
    const order = deterministicManualOrder(state, id, requested);
    const next = clone(state);
    next.collectionsById[id] = { ...next.collectionsById[id], manualOrder: order, updatedAt: nowIso(options) };
    return finalize("collection.replay-order", next, { collectionId: id, manualOrder: order });
  }

  function moveCollectionReplaysPlan(state, collectionId, replayIds, targetIndex, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US");
    const collection = state.collectionsById[id];
    if (!collection) return failure("UNKNOWN_COLLECTION", "Collection does not exist.");
    if (collection.smartRules) return failure("SMART_COLLECTION_MANUAL_ORDER", "Smart collections use rule order and cannot be manually reordered.");
    const moved = orderedUniqueIds(replayIds);
    if (moved.length === 0) return failure("EMPTY_REPLAY_BATCH", "Select at least one replay to reorder.");
    const current = deterministicManualOrder(state, id, []);
    const nonMembers = moved.filter((replayId) => !current.includes(replayId));
    if (nonMembers.length > 0) return failure("REPLAY_NOT_IN_COLLECTION", `Replay is not in this collection: ${nonMembers[0]}`);
    const without = current.filter((replayId) => !moved.includes(replayId));
    const index = boundedInteger(targetIndex, without.length, 0, without.length);
    without.splice(index, 0, ...moved);
    return reorderCollectionReplaysPlan(state, id, without, options);
  }

  function normalizeDateRule(rule) {
    const source = ["exportedAt", "firstSeenAt", "modifiedAt"].includes(rule.source) ? rule.source : "exportedAt";
    if (rule.operator === "withinDays") {
      const days = Number(rule.value);
      if (!Number.isFinite(days) || days < 0 || days > 36500) return failure("INVALID_SMART_RULE_VALUE", "Date window must be between 0 and 36500 days.");
      return { ok: true, rule: { field: "date", operator: rule.operator, source, value: days } };
    }
    if (rule.operator === "between") {
      const from = toIso(rule.from, null);
      const to = toIso(rule.to, null);
      if (!from || !to || from > to) return failure("INVALID_SMART_RULE_VALUE", "Date range must contain ordered ISO dates.");
      return { ok: true, rule: { field: "date", operator: rule.operator, source, from, to } };
    }
    const value = toIso(rule.value, null);
    return value
      ? { ok: true, rule: { field: "date", operator: rule.operator, source, value } }
      : failure("INVALID_SMART_RULE_VALUE", "Date rule requires an ISO date.");
  }

  function normalizeDurationRule(rule) {
    if (rule.operator === "between") {
      const minimumMs = Number(rule.minimumMs);
      const maximumMs = Number(rule.maximumMs);
      if (!Number.isFinite(minimumMs) || !Number.isFinite(maximumMs) || minimumMs < 0 || minimumMs > maximumMs) {
        return failure("INVALID_SMART_RULE_VALUE", "Duration range must contain ordered non-negative milliseconds.");
      }
      return { ok: true, rule: { field: "duration", operator: rule.operator, minimumMs, maximumMs } };
    }
    const valueMs = Number(rule.valueMs);
    return Number.isFinite(valueMs) && valueMs >= 0
      ? { ok: true, rule: { field: "duration", operator: rule.operator, valueMs } }
      : failure("INVALID_SMART_RULE_VALUE", "Duration rule requires non-negative milliseconds.");
  }

  function normalizeSmartRule(rule) {
    if (!schema.isPlainObject(rule)) return failure("INVALID_SMART_RULE", "Smart rule must be an object.");
    const field = schema.cleanString(rule.field, 32);
    const operator = schema.cleanString(rule.operator, 32);
    if (!RULE_OPERATORS[field] || !RULE_OPERATORS[field].includes(operator)) {
      return failure("INVALID_SMART_RULE_OPERATOR", `Unsupported ${field || "unknown"} rule operator: ${operator || "missing"}`);
    }
    if (field === "date") return normalizeDateRule({ ...rule, field, operator });
    if (field === "duration") return normalizeDurationRule({ ...rule, field, operator });
    if (field === "root") {
      const path = schema.normalizeWindowsPath(rule.value);
      if (!schema.isAbsoluteWindowsPath(path)) return failure("INVALID_SMART_RULE_VALUE", "Root rule requires an absolute Windows path.");
      return { ok: true, rule: { field, operator, value: path, pathKey: schema.replayPathKey(path) } };
    }
    if (field === "tag" || field === "name") {
      const maximum = field === "tag" ? 240 : 260;
      const value = schema.cleanString(rule.value, maximum);
      if (!value) return failure("INVALID_SMART_RULE_VALUE", `${field === "tag" ? "Tag" : "Name"} rule requires text.`);
      return { ok: true, rule: { field, operator, value } };
    }
    if (field === "favorite" || field === "missing") {
      if (typeof rule.value !== "boolean") return failure("INVALID_SMART_RULE_VALUE", `${field} rule requires true or false.`);
      return { ok: true, rule: { field, operator, value: rule.value } };
    }
    return failure("INVALID_SMART_RULE", "Unsupported smart rule.");
  }

  function normalizeSmartRules(value) {
    if (!schema.isPlainObject(value)) return failure("INVALID_SMART_RULES", "Smart rules must be an object.");
    const match = value.match === "any" ? "any" : value.match === "all" ? "all" : "";
    if (!match) return failure("INVALID_SMART_RULE_MATCH", "Smart rules must match all or any rules.");
    if (!Array.isArray(value.rules) || value.rules.length === 0) return failure("EMPTY_SMART_RULES", "Smart collection requires at least one rule.");
    if (value.rules.length > MAX_RULES) return failure("SMART_RULE_LIMIT", `Smart collections support at most ${MAX_RULES} rules.`);
    const rules = [];
    for (const candidate of value.rules) {
      const normalized = normalizeSmartRule(candidate);
      if (!normalized.ok) return normalized;
      rules.push(normalized.rule);
    }
    return { ok: true, value: { match, rules } };
  }

  function recordDate(record, source) {
    return Date.parse(record[source] || "");
  }

  function evaluateSmartRule(record, rule, options = {}) {
    if (!record || !schema.isPlainObject(rule)) return false;
    if (rule.field === "date") {
      const timestamp = recordDate(record, rule.source || "exportedAt");
      if (!Number.isFinite(timestamp)) return false;
      if (rule.operator === "withinDays") {
        const now = Date.parse(nowIso(options));
        return timestamp <= now && timestamp >= now - Number(rule.value) * 86400000;
      }
      if (rule.operator === "between") return timestamp >= Date.parse(rule.from) && timestamp <= Date.parse(rule.to);
      const boundary = Date.parse(rule.value);
      if (rule.operator === "before") return timestamp < boundary;
      if (rule.operator === "after") return timestamp > boundary;
      if (rule.operator === "onOrBefore") return timestamp <= boundary;
      return timestamp >= boundary;
    }
    if (rule.field === "duration") {
      if (!Number.isFinite(record.durationMs)) return false;
      if (rule.operator === "between") return record.durationMs >= rule.minimumMs && record.durationMs <= rule.maximumMs;
      if (rule.operator === "lessThan") return record.durationMs < rule.valueMs;
      if (rule.operator === "atMost") return record.durationMs <= rule.valueMs;
      if (rule.operator === "greaterThan") return record.durationMs > rule.valueMs;
      return record.durationMs >= rule.valueMs;
    }
    if (rule.field === "root") {
      const pathKey = schema.replayPathKey(record.canonicalPath);
      return rule.operator === "is"
        ? schema.replayPathKey(parentPath(record.canonicalPath)) === rule.pathKey
        : pathKey === rule.pathKey || pathKey.startsWith(`${rule.pathKey}\\`);
    }
    if (rule.field === "tag") {
      const sought = rule.value.toLocaleLowerCase("en-US");
      const present = record.tags.some((tag) => tag.toLocaleLowerCase("en-US") === sought);
      return rule.operator === "contains" ? present : !present;
    }
    if (rule.field === "favorite") return record.favorite === rule.value;
    if (rule.field === "missing") return (record.missingState === "missing") === rule.value;
    if (rule.field === "name") {
      const name = (record.displayNameOverride || record.sourceName || sourceStem(record.canonicalPath)).toLocaleLowerCase("en-US");
      const sought = rule.value.toLocaleLowerCase("en-US");
      if (rule.operator === "contains") return name.includes(sought);
      if (rule.operator === "startsWith") return name.startsWith(sought);
      return name === sought;
    }
    return false;
  }

  function evaluateSmartRules(record, value, options = {}) {
    const normalized = normalizeSmartRules(value);
    if (!normalized.ok) return false;
    const results = normalized.value.rules.map((rule) => evaluateSmartRule(record, rule, options));
    return normalized.value.match === "all" ? results.every(Boolean) : results.some(Boolean);
  }

  function selectSmartCollectionReplayIds(state, collectionId, options = {}) {
    const collection = state.collectionsById[schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US")];
    if (!collection || !collection.smartRules) return [];
    const limit = boundedInteger(options.limit, MAX_REPLAY_BATCH, 1, MAX_REPLAY_BATCH);
    return Object.values(state.replaysById)
      .filter((record) => evaluateSmartRules(record, collection.smartRules, options))
      .sort((left, right) => right.exportedAt.localeCompare(left.exportedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((record) => record.id);
  }

  function createSavedSearchPlan(state, input = {}, options = {}) {
    const normalized = normalizeSmartRules(input.smartRules);
    if (!normalized.ok) return normalized;
    const result = createCollectionPlan(state, {
      name: input.name,
      color: input.color || DEFAULT_COLLECTION_COLOR,
      icon: input.icon || "search",
      smartRules: normalized.value,
    }, options);
    return result.ok ? { ...result, kind: "saved-search.create" } : result;
  }

  function updateSavedSearchPlan(state, collectionId, smartRules, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(collectionId, 64).toLocaleLowerCase("en-US");
    if (!state.collectionsById[id]) return failure("UNKNOWN_COLLECTION", "Saved search does not exist.");
    const normalized = normalizeSmartRules(smartRules);
    if (!normalized.ok) return normalized;
    const next = clone(state);
    next.collectionsById[id] = {
      ...next.collectionsById[id],
      icon: next.collectionsById[id].icon || "search",
      manualOrder: [],
      smartRules: normalized.value,
      updatedAt: nowIso(options),
    };
    return finalize("saved-search.update", next, { collection: clone(next.collectionsById[id]) });
  }

  function listSavedSearches(state) {
    return deterministicCollectionOrder(state)
      .map((id) => state.collectionsById[id])
      .filter((collection) => Boolean(collection && collection.smartRules))
      .map(clone);
  }

  function recentReplayIds(state, options = {}) {
    const now = Date.parse(nowIso(options));
    const days = Math.min(36500, Math.max(0, Number(options.days ?? DEFAULT_RECENT_DAYS)));
    const threshold = now - days * 86400000;
    const limit = boundedInteger(options.limit, MAX_REPLAY_BATCH, 1, MAX_REPLAY_BATCH);
    return Object.values(state.replaysById)
      .filter((record) => options.includeArchived === true || record.archiveState !== "archived")
      .map((record) => ({ record, timestamp: Math.max(Date.parse(record.firstSeenAt), Date.parse(record.exportedAt)) }))
      .filter((entry) => Number.isFinite(entry.timestamp) && entry.timestamp >= threshold && entry.timestamp <= now)
      .sort((left, right) => right.timestamp - left.timestamp || left.record.id.localeCompare(right.record.id))
      .slice(0, limit)
      .map((entry) => entry.record.id);
  }

  function recordReplayUsagePlan(state, replayId, kind, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(replayId, 64).toLocaleLowerCase("en-US");
    if (!state.replaysById[id]) return failure("UNKNOWN_REPLAY", "Replay does not exist.");
    if (!new Set(["opened", "dragged"]).has(kind)) return failure("INVALID_USAGE_KIND", "Usage kind must be opened or dragged.");
    const timestamp = nowIso(options);
    const next = clone(state);
    const field = kind === "opened" ? "lastOpenedAt" : "lastDraggedAt";
    next.replaysById[id][field] = timestamp;
    next.replaysById[id].usageCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, Math.trunc(Number(next.replaysById[id].usageCount) || 0)) + 1,
    );
    const preferences = organizationPreferences(next);
    const usageByReplayId = schema.isPlainObject(preferences.usageByReplayId) ? preferences.usageByReplayId : {};
    const previous = schema.isPlainObject(usageByReplayId[id]) ? usageByReplayId[id] : {};
    usageByReplayId[id] = {
      count: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number(previous.count) || 0)) + 1),
      lastUsedAt: timestamp,
    };
    preferences.usageByReplayId = usageByReplayId;
    writeOrganizationPreferences(next, preferences);
    return finalize("replay.usage", next, {
      replayId: id,
      usage: clone(usageByReplayId[id]),
      replayPatch: { [field]: timestamp, usageCount: next.replaysById[id].usageCount },
    });
  }

  function mostUsedReplayIds(state, options = {}) {
    const preferences = organizationPreferences(state);
    const usage = schema.isPlainObject(preferences.usageByReplayId) ? preferences.usageByReplayId : {};
    const limit = boundedInteger(options.limit, MAX_REPLAY_BATCH, 1, MAX_REPLAY_BATCH);
    return Object.values(state.replaysById)
      .filter((record) => options.includeArchived === true || record.archiveState !== "archived")
      .map((record) => {
        const persisted = schema.isPlainObject(usage[record.id]) ? usage[record.id] : {};
        const fallbackCount = Math.max(
          Math.trunc(Number(record.usageCount) || 0),
          Number(Boolean(record.lastOpenedAt)) + Number(Boolean(record.lastDraggedAt)),
        );
        const lastUsedAt = toIso(persisted.lastUsedAt, null) || [record.lastOpenedAt, record.lastDraggedAt].filter(Boolean).sort().pop() || null;
        return { id: record.id, count: Math.max(fallbackCount, Math.trunc(Number(persisted.count) || 0)), lastUsedAt };
      })
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count || String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((entry) => entry.id);
  }

  function createReplaySelection(order, options = {}) {
    const normalizedOrder = orderedUniqueIds(order, MAX_REPLAY_BATCH);
    const orderSet = new Set(normalizedOrder);
    const selectedIds = orderedUniqueIds(options.selectedIds, MAX_SELECTION).filter((id) => orderSet.has(id));
    const focusId = orderSet.has(options.focusId) ? options.focusId : selectedIds[0] || normalizedOrder[0] || null;
    const anchorId = orderSet.has(options.anchorId) ? options.anchorId : selectedIds[0] || focusId;
    return { order: normalizedOrder, selectedIds, focusId, anchorId, consumed: false };
  }

  function selectionRange(order, fromId, toId) {
    const from = order.indexOf(fromId);
    const to = order.indexOf(toId);
    if (from < 0 || to < 0) return to >= 0 ? [toId] : [];
    return order.slice(Math.min(from, to), Math.max(from, to) + 1).slice(0, MAX_SELECTION);
  }

  function applyReplaySelectionAction(selection, action = {}) {
    const current = createReplaySelection(selection && selection.order, selection || {});
    const order = current.order;
    if (order.length === 0) return { ...current, consumed: false };
    const type = action.type || "pointer";
    if (type === "pointer") {
      const id = schema.cleanString(action.id, 64).toLocaleLowerCase("en-US");
      if (!order.includes(id)) return { ...current, consumed: false };
      if (action.shiftKey) {
        const range = selectionRange(order, current.anchorId || current.focusId || id, id);
        const selectedIds = action.ctrlKey
          ? orderedUniqueIds([...current.selectedIds, ...range], MAX_SELECTION)
          : range;
        return { order, selectedIds, focusId: id, anchorId: current.anchorId || id, consumed: true };
      }
      if (action.ctrlKey) {
        const selectedIds = current.selectedIds.includes(id)
          ? current.selectedIds.filter((candidate) => candidate !== id)
          : orderedUniqueIds([...current.selectedIds, id], MAX_SELECTION);
        return { order, selectedIds, focusId: id, anchorId: id, consumed: true };
      }
      return { order, selectedIds: [id], focusId: id, anchorId: id, consumed: true };
    }
    if (type !== "keyboard") return { ...current, consumed: false };
    const key = String(action.key || "");
    if (action.ctrlKey && key.toLocaleLowerCase("en-US") === "a") {
      return { order, selectedIds: order.slice(0, MAX_SELECTION), focusId: current.focusId || order[0], anchorId: order[0], consumed: true };
    }
    if (key === "Escape") return { order, selectedIds: [], focusId: current.focusId, anchorId: current.focusId, consumed: true };
    const columns = boundedInteger(action.columns, 1, 1, 100);
    const focusIndex = Math.max(0, order.indexOf(current.focusId));
    let nextIndex = focusIndex;
    if (key === "ArrowLeft") nextIndex -= 1;
    else if (key === "ArrowRight") nextIndex += 1;
    else if (key === "ArrowUp") nextIndex -= columns;
    else if (key === "ArrowDown") nextIndex += columns;
    else if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = order.length - 1;
    else if (key === " " || key === "Enter") {
      return applyReplaySelectionAction(current, {
        type: "pointer",
        id: current.focusId || order[0],
        ctrlKey: action.ctrlKey,
        shiftKey: action.shiftKey,
      });
    } else return { ...current, consumed: false };
    nextIndex = Math.min(order.length - 1, Math.max(0, nextIndex));
    const focusId = order[nextIndex];
    if (action.shiftKey) {
      const range = selectionRange(order, current.anchorId || current.focusId || focusId, focusId);
      return {
        order,
        selectedIds: action.ctrlKey ? orderedUniqueIds([...current.selectedIds, ...range], MAX_SELECTION) : range,
        focusId,
        anchorId: current.anchorId || focusId,
        consumed: true,
      };
    }
    if (action.ctrlKey) return { ...current, focusId, consumed: true };
    return { order, selectedIds: [focusId], focusId, anchorId: focusId, consumed: true };
  }

  function validateFileIdentityGuard(expected, observed) {
    const expectedKey = fileIdentityKey(expected);
    const observedKey = fileIdentityKey(observed);
    if (!expectedKey) return failure("FILE_IDENTITY_REQUIRED", "A stable source file identity is required.");
    if (!observedKey || observedKey !== expectedKey) {
      return failure("FILE_IDENTITY_CHANGED", "The source file identity changed before the operation.", { expectedKey, observedKey });
    }
    return { ok: true, key: expectedKey };
  }

  function ensureTargetPathAvailable(state, replayId, targetPath) {
    const targetKey = schema.replayPathKey(targetPath);
    const conflict = Object.values(state.replaysById).find((record) => record.id !== replayId && record.pathKey === targetKey);
    return conflict
      ? failure("TARGET_PATH_IN_LIBRARY", "Another known replay already uses the target path.", { conflictingReplayId: conflict.id })
      : { ok: true };
  }

  function sourceRenamePlan(state, replayId, proposedName, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(replayId, 64).toLocaleLowerCase("en-US");
    const record = state.replaysById[id];
    if (!record) return failure("UNKNOWN_REPLAY", "Replay does not exist.");
    const identity = fileIdentityKey(record.fileIdentity);
    if (!identity) return failure("FILE_IDENTITY_REQUIRED", "Source-file rename requires a stable file identity.");
    const currentExtension = extensionOf(record.canonicalPath);
    const supplied = schema.cleanString(proposedName, 260);
    if (!supplied) return failure("SOURCE_NAME_REQUIRED", "Source filename is required.");
    const suppliedExtension = extensionOf(supplied);
    let targetName = supplied;
    if (options.preserveExtension !== false) {
      if (suppliedExtension && suppliedExtension !== currentExtension) {
        return failure("EXTENSION_CHANGE_NOT_ALLOWED", `Source-file rename must preserve ${currentExtension}.`);
      }
      if (!suppliedExtension) targetName = `${supplied}${currentExtension}`;
    }
    if (!isSafeFilename(targetName)) return failure("INVALID_SOURCE_NAME", "Source filename contains an unsafe or reserved Windows name.");
    if (!SUPPORTED_MEDIA_EXTENSIONS.has(extensionOf(targetName))) return failure("UNSUPPORTED_MEDIA", "Target filename must keep a supported media extension.");
    const targetPath = `${parentPath(record.canonicalPath)}\\${targetName}`;
    if (!schema.isAbsoluteWindowsPath(targetPath)) return failure("INVALID_TARGET_PATH", "Source rename produced an invalid absolute path.");
    if (schema.replayPathKey(targetPath) === record.pathKey) return failure("SOURCE_NAME_UNCHANGED", "Source filename is unchanged.");
    const available = ensureTargetPathAvailable(state, id, targetPath);
    if (!available.ok) return available;
    const premiereReferenceCount = Math.max(0, Math.trunc(Number(options.premiereReferenceCount) || 0));
    const targetRecord = {
      ...clone(record),
      canonicalPath: targetPath,
      pathKey: schema.replayPathKey(targetPath),
      sourceName: sourceStem(targetName),
      modifiedAt: null,
      thumbnailCacheKey: "",
      thumbnailStatus: "pending",
    };
    return {
      ok: true,
      kind: "source.rename",
      replayId: id,
      sourcePath: record.canonicalPath,
      targetPath,
      expectedIdentity: clone(record.fileIdentity),
      identityKey: identity,
      requiresPremiereWarning: premiereReferenceCount > 0,
      premiereReferenceCount,
      readyForMutation: premiereReferenceCount === 0 || (
        options.premiereWarningAccepted === true && options.supportedPremiereRelinkVerified === true
      ),
      preconditions: Object.freeze([
        "release-viewer-and-thumbnail-handles",
        "revalidate-known-record-path",
        "revalidate-regular-file-and-no-unexpected-reparse-point",
        "revalidate-exact-file-identity",
        "verify-target-does-not-exist",
        ...(premiereReferenceCount > 0 ? ["warn-and-verify-supported-premiere-relink"] : []),
      ]),
      commitRecord: targetRecord,
      rollbackRecord: clone(record),
      postCommitEffects: Object.freeze([
        "invalidate-old-thumbnail-cache-key",
        "update-directory-watch-registration",
        "reconcile-bridge-path-and-file-identity",
        ...(premiereReferenceCount > 0 ? ["perform-and-verify-supported-premiere-relink"] : []),
      ]),
    };
  }

  function volumeKey(path) {
    const normalized = schema.normalizeWindowsPath(path);
    const drive = normalized.match(/^(?:\\\\\?\\)?([A-Za-z]:)\\/);
    if (drive) return drive[1].toLocaleLowerCase("en-US");
    const unc = normalized.replace(/^\\\\\?\\UNC\\/i, "\\\\").match(/^\\\\([^\\]+)\\([^\\]+)/);
    return unc ? `\\\\${unc[1].toLocaleLowerCase("en-US")}\\${unc[2].toLocaleLowerCase("en-US")}` : "";
  }

  function normalizeConfiguredRoots(values) {
    const result = [];
    const seen = new Set();
    let truncated = false;
    for (const value of Array.isArray(values) ? values : []) {
      const path = schema.normalizeWindowsPath(value);
      const key = schema.replayPathKey(path);
      if (!schema.isAbsoluteWindowsPath(path) || !key || seen.has(key)) continue;
      if (result.length >= MAX_RELINK_ROOTS) {
        truncated = true;
        continue;
      }
      seen.add(key);
      result.push({ path, pathKey: key });
    }
    return { roots: result, truncated };
  }

  function pathWithinRoots(path, roots) {
    const key = schema.replayPathKey(path);
    return roots.some((root) => key === root.pathKey || key.startsWith(`${root.pathKey}\\`));
  }

  function relinkCandidateScore(record, candidate) {
    let score = 0;
    const reasons = [];
    const recordIdentity = fileIdentityKey(record.fileIdentity);
    const candidateIdentity = fileIdentityKey(candidate.fileIdentity);
    if (recordIdentity && candidateIdentity && recordIdentity === candidateIdentity) {
      score += 120;
      reasons.push("exact-file-identity");
    }
    const sourceName = sourceFilename(record.canonicalPath).toLocaleLowerCase("en-US");
    const candidateName = sourceFilename(candidate.canonicalPath).toLocaleLowerCase("en-US");
    if (sourceName === candidateName) {
      score += 40;
      reasons.push("exact-filename");
    } else if (sourceStem(sourceName) === sourceStem(candidateName)) {
      score += 25;
      reasons.push("matching-name-stem");
    }
    if (extensionOf(record.canonicalPath) === extensionOf(candidate.canonicalPath)) {
      score += 10;
      reasons.push("matching-extension");
    }
    if (Number.isFinite(record.fileSize) && Number.isFinite(candidate.fileSize)) {
      const difference = Math.abs(record.fileSize - candidate.fileSize);
      if (difference === 0) {
        score += 30;
        reasons.push("exact-file-size");
      } else if (record.fileSize > 0 && difference / record.fileSize <= 0.01) {
        score += 10;
        reasons.push("near-file-size");
      }
    }
    if (Number.isFinite(record.durationMs) && Number.isFinite(candidate.durationMs)) {
      const difference = Math.abs(record.durationMs - candidate.durationMs);
      if (difference <= 50) {
        score += 25;
        reasons.push("matching-duration");
      } else if (difference <= 1000) {
        score += 8;
        reasons.push("near-duration");
      }
    }
    const recordModified = Date.parse(record.modifiedAt || "");
    const candidateModified = Date.parse(candidate.modifiedAt || "");
    if (Number.isFinite(recordModified) && Number.isFinite(candidateModified)) {
      const difference = Math.abs(recordModified - candidateModified);
      if (difference <= 1000) {
        score += 15;
        reasons.push("matching-modified-time");
      } else if (difference <= 60000) {
        score += 5;
        reasons.push("near-modified-time");
      }
    }
    const recordFingerprint = schema.cleanString(record.fingerprint || (record.legacy && record.legacy.fingerprint), 512);
    const candidateFingerprint = schema.cleanString(candidate.fingerprint, 512);
    if (recordFingerprint && candidateFingerprint && recordFingerprint === candidateFingerprint) {
      score += 80;
      reasons.push("exact-lightweight-fingerprint");
    }
    return { score, reasons };
  }

  function scoreRelinkCandidates(record, candidates, configuredRoots, options = {}) {
    if (!record || !schema.isUuid(record.id)) return failure("INVALID_REPLAY", "A known replay record is required for relink scoring.");
    const normalizedRoots = normalizeConfiguredRoots(configuredRoots);
    if (normalizedRoots.roots.length === 0) return failure("RELINK_ROOT_REQUIRED", "Relink search requires at least one configured root.");
    const input = Array.isArray(candidates) ? candidates : [];
    const truncated = input.length > MAX_RELINK_CANDIDATES;
    const scored = [];
    for (const candidate of input.slice(0, MAX_RELINK_CANDIDATES)) {
      if (!schema.isPlainObject(candidate)) continue;
      const canonicalPath = schema.normalizeWindowsPath(candidate.canonicalPath || candidate.path);
      if (!isSupportedMediaPath(canonicalPath) || !pathWithinRoots(canonicalPath, normalizedRoots.roots)) continue;
      if (candidate.isDirectory === true || candidate.isReparsePoint === true || candidate.isRegularFile === false) continue;
      const normalized = { ...clone(candidate), canonicalPath, pathKey: schema.replayPathKey(canonicalPath) };
      const result = relinkCandidateScore(record, normalized);
      if (result.score <= 0) continue;
      scored.push({
        candidate: normalized,
        score: result.score,
        reasons: result.reasons,
        sameVolume: volumeKey(record.canonicalPath) === volumeKey(canonicalPath),
      });
    }
    scored.sort((left, right) => right.score - left.score || left.candidate.pathKey.localeCompare(right.candidate.pathKey));
    const maximumResults = boundedInteger(options.maximumResults, 20, 1, 100);
    const results = scored.slice(0, maximumResults);
    const minimumScore = boundedInteger(options.minimumScore, 25, 0, 500);
    const ambiguityDelta = boundedInteger(options.ambiguityDelta, 5, 0, 100);
    const best = results[0] && results[0].score >= minimumScore ? results[0] : null;
    const runnerUp = best ? results[1] : null;
    const identityCertain = Boolean(best && best.reasons.includes("exact-file-identity") && (!runnerUp || !runnerUp.reasons.includes("exact-file-identity")));
    const fingerprintCertain = Boolean(best && best.reasons.includes("exact-lightweight-fingerprint") && (!runnerUp || !runnerUp.reasons.includes("exact-lightweight-fingerprint")));
    const ambiguous = Boolean(best && runnerUp && best.score - runnerUp.score <= ambiguityDelta && !identityCertain && !fingerprintCertain);
    return {
      ok: true,
      roots: normalizedRoots.roots,
      rootsTruncated: normalizedRoots.truncated,
      candidatesTruncated: truncated,
      results,
      best,
      ambiguous,
      requiresConfirmation: ambiguous || Boolean(best && !best.sameVolume),
      honestBoundary: best && !best.sameVolume
        ? "Cross-volume moves require verified relink and cannot be inferred as watcher renames."
        : "Only candidates supplied from configured roots were scored; no drive-wide scan was performed.",
    };
  }

  function relinkPlan(state, replayId, candidate, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const id = schema.cleanString(replayId, 64).toLocaleLowerCase("en-US");
    const record = state.replaysById[id];
    if (!record) return failure("UNKNOWN_REPLAY", "Replay does not exist.");
    if (!schema.isPlainObject(candidate)) return failure("INVALID_RELINK_CANDIDATE", "Relink candidate must be a file record.");
    const canonicalPath = schema.normalizeWindowsPath(candidate.canonicalPath || candidate.path);
    if (!isSupportedMediaPath(canonicalPath)) return failure("UNSUPPORTED_MEDIA", "Relink candidate must be a supported absolute media path.");
    if (candidate.isDirectory === true || candidate.isReparsePoint === true || candidate.isRegularFile === false) {
      return failure("UNSAFE_RELINK_CANDIDATE", "Relink candidate must be a regular non-reparse file.");
    }
    if (!fileIdentityKey(record.fileIdentity)) return failure("FILE_IDENTITY_REQUIRED", "Relink requires the known source identity as a race guard.");
    if (!fileIdentityKey(candidate.fileIdentity)) return failure("CANDIDATE_IDENTITY_REQUIRED", "Relink candidate requires a stable file identity.");
    const available = ensureTargetPathAvailable(state, id, canonicalPath);
    if (!available.ok) return available;
    const sameVolume = volumeKey(record.canonicalPath) === volumeKey(canonicalPath);
    const requiresExplicitConfirmation = options.ambiguous === true || !sameVolume;
    const commitRecord = {
      ...clone(record),
      canonicalPath,
      pathKey: schema.replayPathKey(canonicalPath),
      sourceName: sourceStem(canonicalPath),
      fileIdentity: clone(candidate.fileIdentity),
      fileSize: Number.isFinite(candidate.fileSize) ? candidate.fileSize : record.fileSize,
      modifiedAt: toIso(candidate.modifiedAt, record.modifiedAt),
      durationMs: Number.isFinite(candidate.durationMs) ? candidate.durationMs : record.durationMs,
      missingState: "available",
      thumbnailCacheKey: "",
      thumbnailStatus: "pending",
    };
    return {
      ok: true,
      kind: "replay.relink",
      replayId: id,
      sourcePath: record.canonicalPath,
      targetPath: canonicalPath,
      expectedSourceIdentity: clone(record.fileIdentity),
      candidateIdentity: clone(candidate.fileIdentity),
      sameVolume,
      requiresExplicitConfirmation,
      readyForCommit: !requiresExplicitConfirmation || options.confirmed === true,
      preconditions: Object.freeze([
        "release-viewer-and-thumbnail-handles",
        "revalidate-known-record-and-source-identity",
        "revalidate-candidate-regular-file-and-no-unexpected-reparse-point",
        "revalidate-candidate-identity",
      ]),
      commitRecord,
      rollbackRecord: clone(record),
      postCommitEffects: Object.freeze([
        "invalidate-old-thumbnail-cache-key",
        "update-directory-watch-registration",
        "reconcile-bridge-path-and-file-identity",
      ]),
      honestBoundary: sameVolume
        ? "Same-volume identity can be reconciled with watcher evidence."
        : "Cross-volume moves require this explicit relink; watcher rename inference is not available.",
    };
  }

  function batchRelinkPlan(state, mappings, options = {}) {
    const input = Array.isArray(mappings) ? mappings : [];
    if (input.length === 0) return failure("EMPTY_RELINK_BATCH", "Select at least one replay to relink.");
    if (input.length > MAX_BATCH_RELINK) return failure("RELINK_BATCH_LIMIT", `Batch relink supports at most ${MAX_BATCH_RELINK} explicit mappings.`);
    const seen = new Set();
    const items = [];
    for (const mapping of input) {
      const id = schema.cleanString(mapping && mapping.replayId, 64).toLocaleLowerCase("en-US");
      if (seen.has(id)) return failure("DUPLICATE_RELINK_MAPPING", `Replay has more than one relink mapping: ${id}`);
      seen.add(id);
      const planned = relinkPlan(state, id, mapping && mapping.candidate, {
        ambiguous: mapping && mapping.ambiguous,
        confirmed: options.confirmed === true || Boolean(mapping && mapping.confirmed),
      });
      if (!planned.ok) return planned;
      items.push(planned);
    }
    return { ok: true, kind: "replay.batch.relink", items, count: items.length };
  }

  function commitGuardedReplayMutation(state, plan, result = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    if (!plan || !["source.rename", "replay.relink"].includes(plan.kind) || !schema.isUuid(plan.replayId)) {
      return failure("INVALID_MUTATION_PLAN", "A guarded source rename or relink plan is required.");
    }
    if (result.success !== true) return failure("MUTATION_NOT_SUCCESSFUL", "Filesystem mutation did not report success.");
    if ((plan.kind === "source.rename" && plan.readyForMutation !== true) || (plan.kind === "replay.relink" && plan.readyForCommit !== true)) {
      return failure("MUTATION_CONFIRMATION_REQUIRED", "Required warning, verification, or ambiguity confirmation is incomplete.");
    }
    const current = state.replaysById[plan.replayId];
    if (!current) return failure("UNKNOWN_REPLAY", "Replay no longer exists.");
    const rollback = plan.rollbackRecord;
    if (!rollback || current.pathKey !== rollback.pathKey || fileIdentityKey(current.fileIdentity) !== fileIdentityKey(rollback.fileIdentity)) {
      return failure("STALE_MUTATION_PLAN", "Replay path or identity changed after the mutation was planned.");
    }
    if (plan.kind === "source.rename") {
      const identity = validateFileIdentityGuard(plan.expectedIdentity, result.observedSourceIdentity);
      if (!identity.ok) return identity;
    } else {
      const identity = validateFileIdentityGuard(plan.candidateIdentity, result.observedCandidateIdentity);
      if (!identity.ok) return failure("CANDIDATE_IDENTITY_CHANGED", identity.message, identity);
    }
    const next = clone(state);
    next.replaysById[plan.replayId] = clone(plan.commitRecord);
    return finalize(`${plan.kind}.commit`, next, {
      replayId: plan.replayId,
      replayPatch: clone(plan.commitRecord),
      postCommitEffects: [...plan.postCommitEffects],
    });
  }

  function archiveReplaysPlan(state, replayIds) {
    return planBatchReplayAction(state, replayIds, { type: "archive" });
  }

  function restoreReplaysPlan(state, replayIds) {
    return planBatchReplayAction(state, replayIds, { type: "restore" });
  }

  function createArchiveRestoreConfirmationModel(state, replayIds, action, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    if (!new Set(["archive", "restore"]).has(action)) {
      return failure("INVALID_LIFECYCLE_ACTION", "Lifecycle confirmation action must be archive or restore.");
    }
    const selected = existingReplayIds(state, replayIds);
    if (!selected.ok) return selected;
    if (selected.ids.length === 0) return failure("EMPTY_REPLAY_BATCH", "Select at least one replay.");
    const createdAt = nowIso(options);
    const items = selected.ids.map((id) => {
      const record = state.replaysById[id];
      return {
        replayId: id,
        name: record.displayNameOverride || record.sourceName || sourceStem(record.canonicalPath),
        exactPath: record.canonicalPath,
        currentArchiveState: record.archiveState,
        expectedPathKey: record.pathKey,
      };
    });
    return {
      ok: true,
      kind: `replay.${action}-confirmation`,
      action,
      confirmationId: schema.stableUuidFromSeed(
        `${action}-confirmation|${createdAt}|${selected.ids.slice().sort().join("|")}|${state.revision}`,
      ),
      createdAt,
      count: items.length,
      items,
      requiresExplicitConfirmation: items.length > 1,
    };
  }

  function createArchiveRestorePlan(state, confirmation, choice = {}) {
    if (!confirmation || !["archive", "restore"].includes(confirmation.action) || confirmation.ok !== true) {
      return failure("INVALID_LIFECYCLE_CONFIRMATION", "A current archive or restore confirmation model is required.");
    }
    if (confirmation.requiresExplicitConfirmation && (
      choice.confirmed !== true || choice.confirmationId !== confirmation.confirmationId
    )) {
      return failure("LIFECYCLE_NOT_CONFIRMED", `Batch ${confirmation.action} requires explicit confirmation.`);
    }
    const stale = confirmation.items.find((item) => {
      const record = state.replaysById[item.replayId];
      return !record || record.pathKey !== item.expectedPathKey;
    });
    if (stale) return failure("STALE_LIFECYCLE_CONFIRMATION", "Replay path changed after the confirmation opened.", { replayId: stale.replayId });
    const ids = confirmation.items.map((item) => item.replayId);
    return confirmation.action === "archive" ? archiveReplaysPlan(state, ids) : restoreReplaysPlan(state, ids);
  }

  function createDeleteConfirmationModel(state, replayIds, options = {}) {
    const invalid = validateState(state);
    if (invalid) return invalid;
    const selected = existingReplayIds(state, replayIds);
    if (!selected.ok) return selected;
    if (selected.ids.length === 0) return failure("EMPTY_DELETE_BATCH", "Select at least one replay.");
    const createdAt = nowIso(options);
    const items = selected.ids.map((id) => {
      const record = state.replaysById[id];
      return {
        replayId: id,
        name: record.displayNameOverride || record.sourceName || sourceStem(record.canonicalPath),
        exactPath: record.canonicalPath,
        archiveState: record.archiveState,
        missingState: record.missingState,
        hasStableIdentity: Boolean(fileIdentityKey(record.fileIdentity)),
        expectedPathKey: record.pathKey,
        expectedIdentityKey: fileIdentityKey(record.fileIdentity),
      };
    });
    const confirmationId = schema.stableUuidFromSeed(`delete-confirmation|${createdAt}|${selected.ids.slice().sort().join("|")}|${state.revision}`);
    return {
      ok: true,
      kind: "replay.delete-confirmation",
      confirmationId,
      createdAt,
      count: items.length,
      items,
      defaultAction: "archive",
      moveSourceToRecycleBin: false,
      recycleBinLabel: "Also move the source file to the Windows Recycle Bin",
      metadataOnlyRemovalAvailable: items.every((item) => item.missingState === "missing"),
      warnings: [
        "Only the exact listed source files may be sent to the Recycle Bin.",
        "Adjacent files, sidecars, folders, Premiere ProjectItems, and archived metadata are never removed implicitly.",
      ],
    };
  }

  function createDeletePlan(state, confirmation, choice = {}) {
    if (!confirmation || confirmation.ok !== true || confirmation.kind !== "replay.delete-confirmation") {
      return failure("INVALID_DELETE_CONFIRMATION", "A current delete confirmation model is required.");
    }
    if (choice.confirmed !== true || choice.confirmationId !== confirmation.confirmationId) {
      return failure("DELETE_NOT_CONFIRMED", "Delete action requires explicit confirmation.");
    }
    const ids = confirmation.items.map((item) => item.replayId);
    const selected = existingReplayIds(state, ids);
    if (!selected.ok) return selected;
    const stale = confirmation.items.find((item) => {
      const record = state.replaysById[item.replayId];
      return !record || record.pathKey !== item.expectedPathKey || fileIdentityKey(record.fileIdentity) !== item.expectedIdentityKey;
    });
    if (stale) {
      return failure("STALE_DELETE_CONFIRMATION", "Replay path or file identity changed after the confirmation opened.", {
        replayId: stale.replayId,
      });
    }
    if (choice.removeMetadataOnly === true) {
      const unavailable = ids.filter((id) => state.replaysById[id].missingState !== "missing");
      if (unavailable.length > 0) return failure("METADATA_REMOVAL_REQUIRES_MISSING", "Metadata-only removal is limited to missing media.");
      return {
        ok: true,
        kind: "replay.delete-metadata",
        confirmationId: confirmation.confirmationId,
        items: ids.map((id) => ({ replayId: id, disposition: "remove-metadata" })),
      };
    }
    if (choice.moveSourceToRecycleBin !== true) {
      const archive = archiveReplaysPlan(state, ids);
      return archive.ok ? {
        ...archive,
        kind: "replay.delete-archive",
        confirmationId: confirmation.confirmationId,
        items: ids.map((id) => ({ replayId: id, disposition: "archive", status: "ready" })),
      } : archive;
    }
    const items = ids.map((id) => {
      const record = state.replaysById[id];
      const identity = fileIdentityKey(record.fileIdentity);
      if (record.missingState === "missing") {
        return { replayId: id, exactPath: record.canonicalPath, disposition: "recycle", status: "blocked", code: "SOURCE_MISSING" };
      }
      if (!identity) {
        return { replayId: id, exactPath: record.canonicalPath, disposition: "recycle", status: "blocked", code: "FILE_IDENTITY_REQUIRED" };
      }
      return {
        replayId: id,
        exactPath: record.canonicalPath,
        expectedIdentity: clone(record.fileIdentity),
        disposition: "recycle",
        status: "ready",
        preconditions: [
          "stop-viewer-and-thumbnail-operations",
          "revalidate-known-library-record",
          "reject-directory-and-unexpected-reparse-point",
          "revalidate-exact-file-identity",
          "use-IFileOperation-with-undo",
        ],
      };
    });
    return {
      ok: true,
      kind: "replay.delete-recycle",
      confirmationId: confirmation.confirmationId,
      items,
      readyCount: items.filter((item) => item.status === "ready").length,
      blockedCount: items.filter((item) => item.status === "blocked").length,
      archiveOnlyAfterRecycleSuccess: true,
    };
  }

  function aggregateItemResults(expectedItems, results) {
    const expected = new Map((Array.isArray(expectedItems) ? expectedItems : []).map((item) => [item.replayId, item]));
    const supplied = new Map();
    for (const result of Array.isArray(results) ? results : []) {
      if (!result || !expected.has(result.replayId) || supplied.has(result.replayId)) continue;
      const status = ["success", "failed", "canceled", "skipped"].includes(result.status) ? result.status : "failed";
      supplied.set(result.replayId, {
        replayId: result.replayId,
        status,
        code: schema.cleanString(result.code, 64) || (status === "failed" ? "OPERATION_FAILED" : ""),
        message: schema.cleanString(result.message, 1000),
      });
    }
    const items = [];
    for (const [replayId, item] of expected) {
      if (item.status === "blocked") {
        items.push({
          replayId,
          status: "skipped",
          code: item.code || "BLOCKED",
          message: "Item was blocked before native execution.",
        });
        continue;
      }
      items.push(supplied.get(replayId) || {
        replayId,
        status: "failed",
        code: "NO_RESULT",
        message: "No operation result was returned.",
      });
    }
    const counts = { total: items.length, success: 0, failed: 0, canceled: 0, skipped: 0 };
    for (const item of items) counts[item.status] += 1;
    return {
      ok: counts.failed === 0 && counts.canceled === 0,
      partial: counts.success > 0 && counts.success < counts.total,
      counts,
      items,
    };
  }

  function applyDeleteResults(state, plan, results) {
    if (!plan || !Array.isArray(plan.items)) return failure("INVALID_DELETE_PLAN", "Delete plan is required.");
    const aggregate = aggregateItemResults(plan.items, results);
    const next = clone(state);
    const successful = new Set(aggregate.items.filter((item) => item.status === "success").map((item) => item.replayId));
    if (plan.kind === "replay.delete-recycle") {
      for (const id of successful) {
        if (!next.replaysById[id]) continue;
        next.replaysById[id].archiveState = "archived";
        next.replaysById[id].missingState = "missing";
      }
    } else if (plan.kind === "replay.delete-metadata") {
      for (const id of successful) delete next.replaysById[id];
      for (const collection of Object.values(next.collectionsById)) {
        collection.manualOrder = collection.manualOrder.filter((id) => !successful.has(id));
      }
      const preferences = organizationPreferences(next);
      if (schema.isPlainObject(preferences.usageByReplayId)) {
        for (const id of successful) delete preferences.usageByReplayId[id];
      }
      writeOrganizationPreferences(next, preferences);
    } else {
      return failure("INVALID_DELETE_PLAN", "Delete results can only commit recycle or metadata-removal plans.");
    }
    return finalize("replay.delete-results", next, { aggregate });
  }

  return {
    DEFAULT_COLLECTION_COLOR,
    DEFAULT_RECENT_DAYS,
    MAX_BATCH_RELINK,
    MAX_COLLECTIONS,
    MAX_RELINK_CANDIDATES,
    MAX_RELINK_ROOTS,
    MAX_REPLAY_BATCH,
    MAX_RULES,
    MAX_SELECTION,
    RULE_OPERATORS,
    SMART_RULE_FIELDS,
    SUPPORTED_MEDIA_EXTENSIONS,
    aggregateItemResults,
    applyDeleteResults,
    applyReplaySelectionAction,
    archiveReplaysPlan,
    batchRelinkPlan,
    commitGuardedReplayMutation,
    createArchiveRestoreConfirmationModel,
    createArchiveRestorePlan,
    createCollectionPlan,
    createDeleteConfirmationModel,
    createDeletePlan,
    createReplaySelection,
    createSavedSearchPlan,
    deleteCollectionPlan,
    deterministicCollectionOrder,
    deterministicManualOrder,
    duplicateCollectionPlan,
    evaluateSmartRule,
    evaluateSmartRules,
    fileIdentityKey,
    listSavedSearches,
    mostUsedReplayIds,
    moveCollectionReplaysPlan,
    normalizeConfiguredRoots,
    normalizeSmartRules,
    planBatchReplayAction,
    planReplayMetadata,
    recentReplayIds,
    recolorCollectionPlan,
    recordReplayUsagePlan,
    relinkCandidateScore,
    relinkPlan,
    renameCollectionPlan,
    reorderCollectionReplaysPlan,
    reorderCollectionsPlan,
    restoreReplaysPlan,
    scoreRelinkCandidates,
    selectSmartCollectionReplayIds,
    sourceRenamePlan,
    updateSavedSearchPlan,
    validateFileIdentityGuard,
  };
});
