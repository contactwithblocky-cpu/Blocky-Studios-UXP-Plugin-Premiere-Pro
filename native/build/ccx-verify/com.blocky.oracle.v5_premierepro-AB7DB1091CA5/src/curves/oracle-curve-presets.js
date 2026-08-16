"use strict";

(function exposeOracleCurvePresets(globalScope, factory) {
  const curveMath = typeof module === "object" && module && module.exports
    ? require("./oracle-curve-math.js")
    : globalScope && Reflect.get(globalScope, "OracleCurveMath");
  const api = factory(curveMath);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleCurvePresets", api);
})(typeof window !== "undefined" ? window : null, function createOracleCurvePresetsApi(curveMath) {
  if (!curveMath) throw new Error("Blocky Studios curve math did not load before curve presets.");

  const PRESET_LIBRARY_SCHEMA = "com.blocky.oracle.curve-presets";
  const PRESET_LIBRARY_VERSION = 2;
  const MAX_USER_PRESETS = 500;
  const MAX_FOLDERS = 64;
  const MAX_TAGS_PER_PRESET = 24;
  const MAX_IMPORT_BYTES = 1000000;
  // Kept as a public compatibility alias for older callers. Import enforcement
  // is byte-based because a JavaScript character count underestimates UTF-8.
  const MAX_IMPORT_CHARACTERS = MAX_IMPORT_BYTES;
  const MAX_ABSOLUTE_CONTROL_Y = 8;
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SAFE_FOLDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/i;
  const APPLY_MODES = Object.freeze(["native-interpolation", "baked-oracle-curve"]);

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.keys(value).forEach((key) => deepFreeze(value[key]));
    return value;
  }

  function builtin(id, name, cubicControlPoints, category) {
    return deepFreeze({
      id: `builtin:${id}`,
      kind: "built-in",
      name,
      cubicControlPoints: cubicControlPoints.slice(),
      category,
      applyMode: "native-interpolation",
      tags: [category.toLocaleLowerCase("en-US")],
    });
  }

  const BUILTIN_CURVE_PRESETS = deepFreeze([
    builtin("linear", "Linear", [0, 0, 1, 1], "Essentials"),
    builtin("ease-in", "Ease In", [0.42, 0, 1, 1], "Essentials"),
    builtin("ease-out", "Ease Out", [0, 0, 0.58, 1], "Essentials"),
    builtin("ease-in-out", "Ease In Out", [0.42, 0, 0.58, 1], "Essentials"),
    builtin("fast-in-slow-out", "Fast In Slow Out", [0.12, 0.78, 0.28, 1], "Dynamics"),
    builtin("slow-in-fast-out", "Slow In Fast Out", [0.72, 0, 0.88, 0.22], "Dynamics"),
    builtin("overshoot", "Overshoot", [0.34, 1.56, 0.64, 1], "Dynamics"),
    builtin("back", "Back", [0.36, 0, 0.66, -0.56], "Dynamics"),
    builtin("anticipation", "Anticipation", [0.36, -0.42, 0.64, 1], "Dynamics"),
    builtin("smooth-step", "Smooth Step", [0.4, 0, 0.2, 1], "Stylized"),
    builtin("sharp-impact", "Sharp Impact", [0.05, 0.92, 0.18, 1], "Stylized"),
    builtin("soft-settle", "Soft Settle", [0.2, 0.72, 0.38, 1.08], "Stylized"),
  ]);
  const BUILTIN_BY_ID = new Map(BUILTIN_CURVE_PRESETS.map((preset) => [preset.id, preset]));

  function cleanString(value, maximum = 160) {
    return String(value == null ? "" : value).trim().slice(0, maximum);
  }

  function normalizeTimestamp(value, fallback = EPOCH) {
    const parsed = new Date(value == null ? "" : value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
  }

  function timestampFrom(options = {}, fallback = null) {
    const value = typeof options.now === "function" ? options.now() : options.now;
    return normalizeTimestamp(value, fallback || new Date().toISOString());
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, Math.trunc(number)))
      : fallback;
  }

  function uniqueStrings(values, maximumItems = MAX_TAGS_PER_PRESET, maximumLength = 48) {
    const result = [];
    const keys = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const item = cleanString(value, maximumLength);
      const key = item.toLocaleLowerCase("en-US");
      if (!item || keys.has(key)) continue;
      keys.add(key);
      result.push(item);
      if (result.length >= maximumItems) break;
    }
    return result;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function utf8ByteLength(value) {
    const source = String(value == null ? "" : value);
    let bytes = 0;
    for (let index = 0; index < source.length; index += 1) {
      const unit = source.charCodeAt(index);
      if (unit <= 0x7f) bytes += 1;
      else if (unit <= 0x7ff) bytes += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = source.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      } else bytes += 3;
      if (bytes > MAX_IMPORT_BYTES) return bytes;
    }
    return bytes;
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
    const input = cleanString(seed, 131072) || "oracle-curve-preset";
    const words = [
      hash32(`0:${input}`, 0x811c9dc5),
      hash32(`1:${input}`, 0x9e3779b9),
      hash32(`2:${input}`, 0x85ebca6b),
      hash32(`3:${input}`, 0xc2b2ae35),
    ];
    const bytes = [];
    for (const word of words) {
      bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizeApplyMode(value) {
    const mode = cleanString(value, 64).toLocaleLowerCase("en-US");
    if (mode === "baked" || mode === "baked-curve" || mode === "oracle-baked") return "baked-oracle-curve";
    if (mode === "native" || mode === "native-interpolation") return "native-interpolation";
    return APPLY_MODES.includes(mode) ? mode : "baked-oracle-curve";
  }

  function normalizeSampleSettings(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    let quantizationTicks = "1";
    try {
      quantizationTicks = curveMath.canonicalTickString(cleanString(
        source.quantizationTicks == null ? "1" : source.quantizationTicks,
        64,
      ));
      if (curveMath.compareTickTimes(quantizationTicks, "1") < 0) quantizationTicks = "1";
    } catch (error) {
      quantizationTicks = "1";
    }
    return {
      budget: boundedInteger(source.budget, 96, curveMath.MIN_SAMPLE_COUNT, curveMath.MAX_SAMPLE_COUNT),
      warningThreshold: boundedInteger(source.warningThreshold, 120, 1, curveMath.MAX_SAMPLE_COUNT),
      quantizationTicks,
    };
  }

  function normalizeFolderId(value) {
    const id = cleanString(value, 96);
    return SAFE_FOLDER_ID_PATTERN.test(id) && !id.startsWith("builtin:") ? id : "";
  }

  function folderIdFromSeed(seed) {
    return `folder:${hash32(seed, 0x811c9dc5).toString(16).padStart(8, "0")}`;
  }

  function normalizeFolder(record, ordinal = 0) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const name = cleanString(record.name, 80);
    if (!name) return null;
    const id = normalizeFolderId(record.id) || folderIdFromSeed(`${name}|${ordinal}`);
    return {
      id,
      name,
      manualOrder: boundedInteger(record.manualOrder, ordinal, 0, MAX_FOLDERS - 1),
    };
  }

  function controlPointsFrom(record) {
    if (!record || typeof record !== "object") return null;
    return record.cubicControlPoints || record.controlPoints || (
      record.x1 !== undefined ? [record.x1, record.y1, record.x2, record.y2] : null
    );
  }

  function normalizeUserPreset(record, options = {}) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const name = cleanString(record.name || record.title, 100);
    if (!name) return null;
    let cubicControlPoints;
    try {
      cubicControlPoints = curveMath.normalizeControlPoints(controlPointsFrom(record));
    } catch (error) {
      return null;
    }
    if (Math.abs(cubicControlPoints[1]) > MAX_ABSOLUTE_CONTROL_Y || Math.abs(cubicControlPoints[3]) > MAX_ABSOLUTE_CONTROL_Y) {
      return null;
    }
    const ordinal = boundedInteger(options.ordinal, 0, 0, MAX_USER_PRESETS - 1);
    const originalId = cleanString(record.id, 128).toLocaleLowerCase("en-US");
    const id = UUID_PATTERN.test(originalId)
      ? originalId
      : stableUuidFromSeed(originalId
        ? `legacy-id|${originalId}`
        : `name|${name.toLocaleLowerCase("en-US")}|${ordinal}`);
    const fallbackTime = normalizeTimestamp(options.fallbackTime, EPOCH);
    const createdAt = normalizeTimestamp(record.createdAt, fallbackTime);
    const folderId = normalizeFolderId(record.folderId || (record.sampleSettings && record.sampleSettings.folderId));
    return {
      id,
      kind: "user",
      name,
      cubicControlPoints,
      applyMode: normalizeApplyMode(record.applyMode),
      sampleSettings: normalizeSampleSettings(record.sampleSettings),
      tags: uniqueStrings(record.tags),
      favorite: record.favorite === true,
      folderId: folderId || null,
      createdAt,
      updatedAt: normalizeTimestamp(record.updatedAt, createdAt),
      manualOrder: boundedInteger(record.manualOrder, ordinal, 0, MAX_USER_PRESETS - 1),
    };
  }

  function recordsFrom(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).map(([id, record]) => (
      record && typeof record === "object" && !Array.isArray(record) && !record.id
        ? { ...record, id }
        : record
    ));
  }

  function createEmptyPresetLibrary(options = {}) {
    return {
      schema: PRESET_LIBRARY_SCHEMA,
      version: PRESET_LIBRARY_VERSION,
      revision: 0,
      updatedAt: normalizeTimestamp(options.updatedAt, EPOCH),
      presets: [],
      folders: [],
      builtInFavorites: [],
    };
  }

  /** @returns {any} */
  function migratePresetDocument(input) {
    const source = Array.isArray(input) ? { version: 0, presets: input } : input;
    if (!source || typeof source !== "object") {
      return { ok: false, code: "INVALID_DOCUMENT", message: "Curve preset data must be an object or array." };
    }
    const isOracleApplicationState = source.schema === "com.blocky.oracle.state" || (
      source.curvePresetsById && source.replaysById && source.preferences
    );
    const version = isOracleApplicationState
      ? 0
      : boundedInteger(source.version, 0, 0, Number.MAX_SAFE_INTEGER);
    if (version > PRESET_LIBRARY_VERSION) {
      return {
        ok: false,
        code: "UNSUPPORTED_VERSION",
        message: `Curve preset library version ${version} is newer than version ${PRESET_LIBRARY_VERSION}.`,
      };
    }
    const presets = recordsFrom(
      source.presets || source.items || source.userPresets || source.curvePresets || source.curvePresetsById,
    ).map((record) => {
      if (!record || typeof record !== "object") return record;
      if (version <= 1) {
        return {
          ...record,
          cubicControlPoints: record.cubicControlPoints || record.controlPoints,
          folderId: record.folderId || record.categoryId || null,
        };
      }
      return record;
    });
    return {
      ok: true,
      fromVersion: version,
      migrated: version !== PRESET_LIBRARY_VERSION,
      document: {
        schema: PRESET_LIBRARY_SCHEMA,
        version: PRESET_LIBRARY_VERSION,
        revision: boundedInteger(source.revision, 0, 0, Number.MAX_SAFE_INTEGER),
        updatedAt: normalizeTimestamp(source.updatedAt || source.exportedAt, EPOCH),
        presets,
        folders: recordsFrom(source.folders || source.categories),
        builtInFavorites: uniqueStrings(source.builtInFavorites || source.favoriteBuiltIns, BUILTIN_CURVE_PRESETS.length, 128),
      },
    };
  }

  function normalizePresetLibrary(input, options = {}) {
    const migration = migratePresetDocument(input || createEmptyPresetLibrary(options));
    if (!migration.ok) return createEmptyPresetLibrary(options);
    const source = migration.document;
    const folderIds = new Set();
    const folders = [];
    recordsFrom(source.folders).slice(0, MAX_FOLDERS * 2).forEach((record, ordinal) => {
      const folder = normalizeFolder(record, ordinal);
      if (!folder || folderIds.has(folder.id)) return;
      folderIds.add(folder.id);
      folders.push(folder);
    });
    folders.sort((left, right) => left.manualOrder - right.manualOrder || left.name.localeCompare(right.name));
    folders.forEach((folder, index) => { folder.manualOrder = index; });

    const usedIds = new Set();
    const presets = [];
    recordsFrom(source.presets).slice(0, MAX_USER_PRESETS * 2).forEach((record, ordinal) => {
      if (presets.length >= MAX_USER_PRESETS) return;
      const preset = normalizeUserPreset(record, { ordinal, fallbackTime: source.updatedAt });
      if (!preset || usedIds.has(preset.id)) return;
      usedIds.add(preset.id);
      if (preset.folderId && !folderIds.has(preset.folderId)) preset.folderId = null;
      presets.push(preset);
    });
    presets.sort((left, right) => left.manualOrder - right.manualOrder || left.name.localeCompare(right.name));
    presets.forEach((preset, index) => { preset.manualOrder = index; });
    const builtInFavorites = uniqueStrings(source.builtInFavorites, BUILTIN_CURVE_PRESETS.length, 128)
      .filter((id) => BUILTIN_BY_ID.has(id));
    return {
      schema: PRESET_LIBRARY_SCHEMA,
      version: PRESET_LIBRARY_VERSION,
      revision: boundedInteger(source.revision, 0, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: normalizeTimestamp(source.updatedAt, EPOCH),
      presets,
      folders,
      builtInFavorites,
    };
  }

  function validatePresetLibrary(input) {
    const errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) errors.push("Library must be an object.");
    if (input && input.schema && input.schema !== PRESET_LIBRARY_SCHEMA) errors.push("Library schema is not a Blocky Studios curve preset library.");
    if (input && Number(input.version) > PRESET_LIBRARY_VERSION) errors.push("Library version is newer than this Blocky Studios build.");
    const rawPresets = recordsFrom(input && (input.presets || input.curvePresetsById));
    if (rawPresets.length > MAX_USER_PRESETS) errors.push(`Library exceeds ${MAX_USER_PRESETS} user presets.`);
    rawPresets.forEach((preset, index) => {
      if (!normalizeUserPreset(preset, { ordinal: index })) errors.push(`Preset ${index + 1} is invalid.`);
    });
    const rawFolders = recordsFrom(input && input.folders);
    if (rawFolders.length > MAX_FOLDERS) errors.push(`Library exceeds ${MAX_FOLDERS} folders.`);
    return { ok: errors.length === 0, errors };
  }

  /** @returns {any} */
  function failure(code, message, details = {}) {
    return { ok: false, code, message, ...details };
  }

  function commitLibrary(input, options, operation) {
    const migration = migratePresetDocument(input || createEmptyPresetLibrary(options));
    if (!migration.ok) return failure(migration.code, migration.message);
    const library = normalizePresetLibrary(migration.document);
    const result = operation(library);
    if (result && result.ok === false) return result;
    library.revision += 1;
    library.updatedAt = timestampFrom(options);
    return { ok: true, library, ...(result || {}) };
  }

  function hasDuplicateName(library, name, exceptId = "") {
    const key = cleanString(name, 100).toLocaleLowerCase("en-US");
    return library.presets.some((preset) => preset.id !== exceptId && preset.name.toLocaleLowerCase("en-US") === key);
  }

  function uniquePresetId(library, seed) {
    let attempt = 0;
    let id;
    do {
      id = stableUuidFromSeed(`${seed}|${attempt}`);
      attempt += 1;
    } while (library.presets.some((preset) => preset.id === id));
    return id;
  }

  function createUserPreset(input, draft, options = {}) {
    return commitLibrary(input, options, (library) => {
      if (library.presets.length >= MAX_USER_PRESETS) {
        return failure("PRESET_LIMIT", `Blocky Studios supports at most ${MAX_USER_PRESETS} user curve presets.`);
      }
      const name = cleanString(draft && (draft.name || draft.title), 100);
      if (!name) return failure("NAME_REQUIRED", "Curve preset name is required.");
      if (hasDuplicateName(library, name) && options.allowDuplicateName !== true) {
        return failure("DUPLICATE_NAME", "A user curve preset already uses that name.");
      }
      const now = timestampFrom(options);
      const id = uniquePresetId(library, `${name}|${now}|${library.revision}|${library.presets.length}`);
      const preset = normalizeUserPreset({
        ...draft,
        id,
        createdAt: now,
        updatedAt: now,
        manualOrder: library.presets.length,
      }, { ordinal: library.presets.length, fallbackTime: now });
      if (!preset) return failure("INVALID_PRESET", "Curve preset control points are invalid.");
      library.presets.push(preset);
      return { preset: clone(preset) };
    });
  }

  function saveAsUserPreset(input, source, name, options = {}) {
    return createUserPreset(input, { ...source, id: undefined, name }, options);
  }

  function overwriteUserPreset(input, id, updates, options = {}) {
    if (options.confirmed !== true) {
      return failure("CONFIRMATION_REQUIRED", "Overwriting a curve preset requires explicit confirmation.");
    }
    return commitLibrary(input, options, (library) => {
      const index = library.presets.findIndex((preset) => preset.id === id);
      if (index < 0) return failure("NOT_FOUND", "User curve preset was not found.");
      const current = library.presets[index];
      const now = timestampFrom(options);
      const replacement = normalizeUserPreset({
        ...current,
        ...updates,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: now,
        manualOrder: current.manualOrder,
      }, { ordinal: index, fallbackTime: now });
      if (!replacement) return failure("INVALID_PRESET", "Curve preset changes are invalid.");
      if (hasDuplicateName(library, replacement.name, id) && options.allowDuplicateName !== true) {
        return failure("DUPLICATE_NAME", "A user curve preset already uses that name.");
      }
      library.presets[index] = replacement;
      return { preset: clone(replacement) };
    });
  }

  function renameUserPreset(input, id, name, options = {}) {
    const library = normalizePresetLibrary(input);
    const current = library.presets.find((preset) => preset.id === id);
    if (!current) return failure("NOT_FOUND", "User curve preset was not found.");
    return overwriteUserPreset(library, id, { name }, { ...options, confirmed: true });
  }

  function duplicateUserPreset(input, id, options = {}) {
    const library = normalizePresetLibrary(input);
    const current = library.presets.find((preset) => preset.id === id);
    if (!current) return failure("NOT_FOUND", "User curve preset was not found.");
    const desiredName = cleanString(options.name, 100) || `${current.name} Copy`;
    return createUserPreset(library, { ...current, id: undefined, name: desiredName, favorite: false }, options);
  }

  function copyPresetToUser(input, id, options = {}) {
    const library = normalizePresetLibrary(input);
    const userPreset = library.presets.find((preset) => preset.id === id);
    const builtInPreset = BUILTIN_BY_ID.get(id);
    const current = userPreset || builtInPreset;
    if (!current) return failure("NOT_FOUND", "Curve preset was not found.");
    const desiredName = cleanString(options.name, 100) || `${current.name} Copy`;
    return createUserPreset(library, {
      ...current,
      id: undefined,
      kind: undefined,
      name: desiredName,
      favorite: false,
      applyMode: userPreset ? current.applyMode : "native-interpolation",
    }, options);
  }

  function deleteUserPreset(input, id, options = {}) {
    if (options.confirmed !== true) {
      return failure("CONFIRMATION_REQUIRED", "Deleting a curve preset requires explicit confirmation.");
    }
    return commitLibrary(input, options, (library) => {
      const index = library.presets.findIndex((preset) => preset.id === id);
      if (index < 0) return failure("NOT_FOUND", "User curve preset was not found.");
      const [deleted] = library.presets.splice(index, 1);
      library.presets.forEach((preset, ordinal) => { preset.manualOrder = ordinal; });
      return { deleted: clone(deleted) };
    });
  }

  function reorderUserPreset(input, id, targetIndex, options = {}) {
    return commitLibrary(input, options, (library) => {
      const sourceIndex = library.presets.findIndex((preset) => preset.id === id);
      if (sourceIndex < 0) return failure("NOT_FOUND", "User curve preset was not found.");
      const destination = boundedInteger(targetIndex, sourceIndex, 0, Math.max(0, library.presets.length - 1));
      const [preset] = library.presets.splice(sourceIndex, 1);
      library.presets.splice(destination, 0, preset);
      library.presets.forEach((entry, ordinal) => { entry.manualOrder = ordinal; });
      return { preset: clone(preset), index: destination };
    });
  }

  function setPresetFavorite(input, id, favorite, options = {}) {
    return commitLibrary(input, options, (library) => {
      if (BUILTIN_BY_ID.has(id)) {
        const favorites = new Set(library.builtInFavorites);
        if (favorite === true) favorites.add(id);
        else favorites.delete(id);
        library.builtInFavorites = BUILTIN_CURVE_PRESETS.map((preset) => preset.id).filter((presetId) => favorites.has(presetId));
        return { presetId: id, favorite: favorite === true, kind: "built-in" };
      }
      const preset = library.presets.find((entry) => entry.id === id);
      if (!preset) return failure("NOT_FOUND", "Curve preset was not found.");
      preset.favorite = favorite === true;
      preset.updatedAt = timestampFrom(options);
      return { preset: clone(preset), favorite: preset.favorite, kind: "user" };
    });
  }

  function setUserPresetTags(input, id, tags, options = {}) {
    return commitLibrary(input, options, (library) => {
      const preset = library.presets.find((entry) => entry.id === id);
      if (!preset) return failure("NOT_FOUND", "User curve preset was not found.");
      preset.tags = uniqueStrings(tags);
      preset.updatedAt = timestampFrom(options);
      return { preset: clone(preset) };
    });
  }

  function updateUserPresetOrganization(input, id, updates = {}, options = {}) {
    return commitLibrary(input, options, (library) => {
      const preset = library.presets.find((entry) => entry.id === id);
      if (!preset) return failure("NOT_FOUND", "User curve preset was not found.");
      const normalizedFolderId = updates.folderId == null || updates.folderId === ""
        ? null
        : normalizeFolderId(updates.folderId);
      if (normalizedFolderId && !library.folders.some((folder) => folder.id === normalizedFolderId)) {
        return failure("FOLDER_NOT_FOUND", "Curve folder was not found.");
      }
      preset.tags = uniqueStrings(updates.tags);
      preset.folderId = normalizedFolderId;
      preset.updatedAt = timestampFrom(options);
      return { preset: clone(preset) };
    });
  }

  function uniqueFolderId(library, seed) {
    let attempt = 0;
    let id;
    do {
      id = folderIdFromSeed(`${seed}|${attempt}`);
      attempt += 1;
    } while (library.folders.some((folder) => folder.id === id));
    return id;
  }

  function createFolder(input, name, options = {}) {
    return commitLibrary(input, options, (library) => {
      if (library.folders.length >= MAX_FOLDERS) return failure("FOLDER_LIMIT", `Blocky Studios supports at most ${MAX_FOLDERS} curve folders.`);
      const cleanName = cleanString(name, 80);
      if (!cleanName) return failure("NAME_REQUIRED", "Curve folder name is required.");
      if (library.folders.some((folder) => folder.name.toLocaleLowerCase("en-US") === cleanName.toLocaleLowerCase("en-US"))) {
        return failure("DUPLICATE_NAME", "A curve folder already uses that name.");
      }
      const folder = { id: uniqueFolderId(library, cleanName), name: cleanName, manualOrder: library.folders.length };
      library.folders.push(folder);
      return { folder: clone(folder) };
    });
  }

  function renameFolder(input, id, name, options = {}) {
    return commitLibrary(input, options, (library) => {
      const folder = library.folders.find((entry) => entry.id === id);
      if (!folder) return failure("NOT_FOUND", "Curve folder was not found.");
      const cleanName = cleanString(name, 80);
      if (!cleanName) return failure("NAME_REQUIRED", "Curve folder name is required.");
      if (library.folders.some((entry) => entry.id !== id && entry.name.toLocaleLowerCase("en-US") === cleanName.toLocaleLowerCase("en-US"))) {
        return failure("DUPLICATE_NAME", "A curve folder already uses that name.");
      }
      folder.name = cleanName;
      return { folder: clone(folder) };
    });
  }

  function deleteFolder(input, id, options = {}) {
    if (options.confirmed !== true) return failure("CONFIRMATION_REQUIRED", "Deleting a curve folder requires explicit confirmation.");
    return commitLibrary(input, options, (library) => {
      const index = library.folders.findIndex((folder) => folder.id === id);
      if (index < 0) return failure("NOT_FOUND", "Curve folder was not found.");
      const [deleted] = library.folders.splice(index, 1);
      library.folders.forEach((folder, ordinal) => { folder.manualOrder = ordinal; });
      library.presets.forEach((preset) => {
        if (preset.folderId === id) preset.folderId = null;
      });
      return { deleted: clone(deleted) };
    });
  }

  function assignPresetFolder(input, presetId, folderId, options = {}) {
    return commitLibrary(input, options, (library) => {
      const preset = library.presets.find((entry) => entry.id === presetId);
      if (!preset) return failure("NOT_FOUND", "User curve preset was not found.");
      const normalizedFolderId = folderId == null || folderId === "" ? null : normalizeFolderId(folderId);
      if (normalizedFolderId && !library.folders.some((folder) => folder.id === normalizedFolderId)) {
        return failure("FOLDER_NOT_FOUND", "Curve folder was not found.");
      }
      preset.folderId = normalizedFolderId;
      preset.updatedAt = timestampFrom(options);
      return { preset: clone(preset) };
    });
  }

  function reorderFolders(input, orderedIds, options = {}) {
    return commitLibrary(input, options, (library) => {
      const requested = uniqueStrings(orderedIds, MAX_FOLDERS, 96);
      const byId = new Map(library.folders.map((folder) => [folder.id, folder]));
      const reordered = requested.map((id) => byId.get(id)).filter(Boolean);
      library.folders.forEach((folder) => {
        if (!reordered.includes(folder)) reordered.push(folder);
      });
      library.folders = reordered;
      library.folders.forEach((folder, ordinal) => { folder.manualOrder = ordinal; });
      return { folders: clone(library.folders) };
    });
  }

  function presetThumbnail(preset, options = {}) {
    const width = Math.min(4096, Math.max(16, Number(options.width) || 160));
    const height = Math.min(4096, Math.max(16, Number(options.height) || 96));
    return {
      kind: "path-data",
      viewBox: `0 0 ${width} ${height}`,
      pathData: curveMath.createCurvePathData(preset.cubicControlPoints, { ...options, width, height }),
    };
  }

  function allPresets(input, options = {}) {
    const library = normalizePresetLibrary(input);
    const favoriteBuiltIns = new Set(library.builtInFavorites);
    const includeThumbnails = options.thumbnails !== false;
    const builtIns = BUILTIN_CURVE_PRESETS.map((preset) => {
      const result = { ...preset, cubicControlPoints: preset.cubicControlPoints.slice(), tags: preset.tags.slice(), favorite: favoriteBuiltIns.has(preset.id) };
      if (includeThumbnails) result.thumbnail = presetThumbnail(result, options.thumbnailOptions);
      return result;
    });
    const users = library.presets.map((preset) => {
      const result = clone(preset);
      if (includeThumbnails) result.thumbnail = presetThumbnail(result, options.thumbnailOptions);
      return result;
    });
    return { builtIns, users };
  }

  function searchPresets(input, query = "", filters = {}) {
    const library = normalizePresetLibrary(input);
    const groups = allPresets(library, { thumbnails: filters.thumbnails !== false, thumbnailOptions: filters.thumbnailOptions });
    const folderNames = new Map(library.folders.map((folder) => [folder.id, folder.name]));
    const needle = cleanString(query, 200).toLocaleLowerCase("en-US");
    const requestedTags = uniqueStrings(filters.tags).map((tag) => tag.toLocaleLowerCase("en-US"));
    const tab = ["all", "built-in", "user"].includes(filters.tab) ? filters.tab : "all";
    const matches = (preset) => {
      if (filters.favoritesOnly === true && preset.favorite !== true) return false;
      if (filters.folderId != null && preset.folderId !== filters.folderId) return false;
      const tags = preset.tags.map((tag) => tag.toLocaleLowerCase("en-US"));
      if (requestedTags.some((tag) => !tags.includes(tag))) return false;
      if (!needle) return true;
      return [preset.name, ...preset.tags, folderNames.get(preset.folderId) || ""]
        .some((value) => value.toLocaleLowerCase("en-US").includes(needle));
    };
    return {
      builtIns: tab === "user" ? [] : groups.builtIns.filter(matches),
      users: tab === "built-in" ? [] : groups.users.filter(matches),
    };
  }

  function portablePreset(preset) {
    return {
      id: preset.id,
      name: preset.name,
      cubicControlPoints: preset.cubicControlPoints.slice(),
      applyMode: preset.applyMode,
      sampleSettings: clone(preset.sampleSettings),
      tags: preset.tags.slice(),
      favorite: preset.favorite === true,
      folderId: preset.folderId,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
      manualOrder: preset.manualOrder,
    };
  }

  function stableJson(value, indentation = 0) {
    const ordered = (entry) => {
      if (Array.isArray(entry)) return entry.map(ordered);
      if (!entry || typeof entry !== "object") return entry;
      const result = {};
      Object.keys(entry).sort().forEach((key) => { result[key] = ordered(entry[key]); });
      return result;
    };
    return JSON.stringify(ordered(value), null, indentation);
  }

  function isPremierePresetFilename(value) {
    return cleanString(value, 260).toLocaleLowerCase("en-US").endsWith(".prfpset");
  }

  function serializePresetLibrary(input, options = {}) {
    const library = normalizePresetLibrary(input);
    const document = {
      schema: PRESET_LIBRARY_SCHEMA,
      version: PRESET_LIBRARY_VERSION,
      exportedAt: timestampFrom(options, library.updatedAt),
      presets: library.presets.map(portablePreset),
      folders: clone(library.folders),
      builtInFavorites: library.builtInFavorites.slice(),
    };
    return stableJson(document, options.pretty === false ? 0 : 2);
  }

  /** @returns {any} */
  function exportPresetLibrary(input, options = {}) {
    if (isPremierePresetFilename(options.filename) || cleanString(options.format, 32).toLocaleLowerCase("en-US") === "prfpset") {
      return failure(
        "UNSUPPORTED_FORMAT",
        "Blocky Studios curve libraries use versioned JSON and cannot be exported as Premiere preset files.",
      );
    }
    return {
      ok: true,
      filename: cleanString(options.filename, 260) || "Blocky-Studios-Curve-Presets.json",
      mimeType: "application/json",
      text: serializePresetLibrary(input, options),
    };
  }

  /** @returns {any} */
  function parseImportSource(source) {
    if (typeof source !== "string") return { ok: true, value: source };
    const byteLength = utf8ByteLength(source);
    if (byteLength > MAX_IMPORT_BYTES) {
      return failure("IMPORT_TOO_LARGE", `Curve preset JSON exceeds ${MAX_IMPORT_BYTES} UTF-8 bytes.`, { byteLength });
    }
    try {
      return { ok: true, value: JSON.parse(source) };
    } catch (error) {
      return failure("INVALID_JSON", `Curve preset JSON could not be parsed: ${error.message}`);
    }
  }

  function validatePresetImportByteLength(value) {
    const byteLength = Number(value);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      return failure("IMPORT_SIZE_UNVERIFIED", "Blocky Studios could not verify the curve preset file size before reading it.");
    }
    if (byteLength > MAX_IMPORT_BYTES) {
      return failure("IMPORT_TOO_LARGE", `Curve preset JSON exceeds ${MAX_IMPORT_BYTES} UTF-8 bytes.`, { byteLength });
    }
    return { ok: true, byteLength };
  }

  /** @returns {any} */
  function importPresetLibrary(source, currentInput, options = {}) {
    if (isPremierePresetFilename(options.filename)) {
      return failure("UNSUPPORTED_FORMAT", "Premiere preset files are not Blocky Studios curve libraries.");
    }
    const parsed = parseImportSource(source);
    if (!parsed.ok) return parsed;
    if (
      parsed.value &&
      parsed.value.schema &&
      parsed.value.schema !== PRESET_LIBRARY_SCHEMA &&
      parsed.value.schema !== "com.blocky.oracle.state"
    ) {
      return failure("INVALID_SCHEMA", "The selected JSON is not a Blocky Studios curve preset library.");
    }
    const migration = migratePresetDocument(parsed.value);
    if (!migration.ok) return migration;
    const validation = validatePresetLibrary(migration.document);
    if (!validation.ok) return failure("INVALID_LIBRARY", validation.errors.join(" "), { errors: validation.errors });
    const imported = normalizePresetLibrary(migration.document);
    const strategy = options.strategy === "replace" ? "replace" : "merge";
    if (strategy === "replace") {
      imported.revision = normalizePresetLibrary(currentInput).revision + 1;
      imported.updatedAt = timestampFrom(options);
      return {
        ok: true,
        library: imported,
        importedCount: imported.presets.length,
        skippedCount: 0,
        migrated: migration.migrated,
        fromVersion: migration.fromVersion,
      };
    }

    const library = normalizePresetLibrary(currentInput);
    const folderRemap = new Map();
    imported.folders.forEach((folder) => {
      const sameId = library.folders.find((entry) => entry.id === folder.id);
      const sameName = library.folders.find((entry) => entry.name.toLocaleLowerCase("en-US") === folder.name.toLocaleLowerCase("en-US"));
      if (sameName) {
        folderRemap.set(folder.id, sameName.id);
        return;
      }
      if (library.folders.length >= MAX_FOLDERS) return;
      const id = sameId ? uniqueFolderId(library, `${folder.id}|${folder.name}`) : folder.id;
      const added = { ...folder, id, manualOrder: library.folders.length };
      library.folders.push(added);
      folderRemap.set(folder.id, id);
    });
    let importedCount = 0;
    let skippedCount = 0;
    imported.presets.forEach((preset) => {
      if (library.presets.length >= MAX_USER_PRESETS) {
        skippedCount += 1;
        return;
      }
      const portable = portablePreset(preset);
      portable.folderId = portable.folderId ? (folderRemap.get(portable.folderId) || null) : null;
      const sameId = library.presets.find((entry) => entry.id === portable.id);
      if (sameId && stableJson(portablePreset(sameId)) === stableJson(portable)) {
        skippedCount += 1;
        return;
      }
      if (sameId) portable.id = uniquePresetId(library, `${portable.id}|${portable.name}|import`);
      portable.manualOrder = library.presets.length;
      const normalized = normalizeUserPreset(portable, { ordinal: portable.manualOrder, fallbackTime: imported.updatedAt });
      if (!normalized) {
        skippedCount += 1;
        return;
      }
      library.presets.push(normalized);
      importedCount += 1;
    });
    const favorites = new Set([...library.builtInFavorites, ...imported.builtInFavorites]);
    library.builtInFavorites = BUILTIN_CURVE_PRESETS.map((preset) => preset.id).filter((id) => favorites.has(id));
    library.revision += 1;
    library.updatedAt = timestampFrom(options);
    return {
      ok: true,
      library,
      importedCount,
      skippedCount,
      migrated: migration.migrated,
      fromVersion: migration.fromVersion,
    };
  }

  return {
    PRESET_LIBRARY_SCHEMA,
    PRESET_LIBRARY_VERSION,
    MAX_USER_PRESETS,
    MAX_FOLDERS,
    MAX_TAGS_PER_PRESET,
    MAX_IMPORT_BYTES,
    MAX_IMPORT_CHARACTERS,
    MAX_ABSOLUTE_CONTROL_Y,
    APPLY_MODES,
    BUILTIN_CURVE_PRESETS,
    normalizeSampleSettings,
    normalizeUserPreset,
    normalizeFolder,
    createEmptyPresetLibrary,
    migratePresetDocument,
    normalizePresetLibrary,
    validatePresetLibrary,
    createUserPreset,
    saveAsUserPreset,
    overwriteUserPreset,
    renameUserPreset,
    duplicateUserPreset,
    copyPresetToUser,
    deleteUserPreset,
    reorderUserPreset,
    setPresetFavorite,
    setUserPresetTags,
    updateUserPresetOrganization,
    createFolder,
    renameFolder,
    deleteFolder,
    assignPresetFolder,
    reorderFolders,
    presetThumbnail,
    allPresets,
    searchPresets,
    utf8ByteLength,
    validatePresetImportByteLength,
    serializePresetLibrary,
    exportPresetLibrary,
    importPresetLibrary,
  };
});
