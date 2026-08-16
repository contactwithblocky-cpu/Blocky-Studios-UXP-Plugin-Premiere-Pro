"use strict";

(function exposeOracleQuickApplyDomain(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleQuickApplyDomain", api);
})(typeof window !== "undefined" ? window : null, function createOracleQuickApplyDomainApi() {
  const QUICK_APPLY_STATE_SCHEMA = "com.blocky.oracle.quick-apply-state";
  const QUICK_APPLY_STATE_VERSION = 1;
  const RECIPE_LIBRARY_SCHEMA = "com.blocky.oracle.quick-apply-recipes";
  const RECIPE_LIBRARY_VERSION = 1;
  const WORKSPACE_STATES = Object.freeze(["loading", "empty", "error", "unsupported", "ready"]);
  const RESULT_SCOPES = Object.freeze(["all", "video", "audio", "favorites", "recent", "recipes"]);
  const MEDIA_TYPES = Object.freeze(["video", "audio"]);
  const MAX_INDEX_EFFECTS = 20000;
  const MAX_RESULTS = 240;
  const MAX_RECENT = 100;
  const MAX_RECIPES = 512;
  const MAX_RECIPE_STEPS = 32;
  const MAX_PARAMETERS_PER_STEP = 64;
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

  function cleanText(value, maximum = 1024) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maximum);
  }

  function finiteInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function isoTimestamp(value, fallback = null) {
    const date = new Date(value == null ? "" : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
  }

  function normalizeMediaType(value) {
    const mediaType = cleanText(value, 16).toLocaleLowerCase("en-US");
    return MEDIA_TYPES.includes(mediaType) ? mediaType : "";
  }

  function hash32(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function normalizedSearchText(value) {
    let text = cleanText(value, 4096).toLocaleLowerCase("en-US");
    if (typeof text.normalize === "function") {
      text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    }
    return text.replace(/[^a-z0-9]+/g, " ").trim();
  }

  function uniqueStrings(values, maximum = 256, maximumLength = 1024) {
    const output = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const text = cleanText(value, maximumLength);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      output.push(text);
      if (output.length >= maximum) break;
    }
    return output;
  }

  function normalizeEffectIdentity(value = {}, fallbackOrdinal = 0) {
    const mediaType = normalizeMediaType(value.mediaType || value.type || value.kind);
    const displayName = cleanText(value.displayName || value.name, 512);
    const matchName = cleanText(value.matchName || value.match, 1024);
    const ordinal = finiteInteger(value.ordinal != null ? value.ordinal : value.occurrence, fallbackOrdinal, 0, MAX_INDEX_EFFECTS);
    if (!mediaType || !displayName) return null;
    return { mediaType, displayName, matchName, ordinal };
  }

  function effectIdentityKey(value = {}, fallbackOrdinal = 0) {
    const identity = normalizeEffectIdentity(value, fallbackOrdinal);
    if (!identity) return "";
    return `${identity.mediaType}\u001f${identity.matchName}\u001f${identity.displayName}\u001f${identity.ordinal}`;
  }

  function stableEffectId(value = {}, fallbackOrdinal = 0) {
    const identity = normalizeEffectIdentity(value, fallbackOrdinal);
    if (!identity) return "";
    const supplied = cleanText(value.id || value.effectId, 256);
    if (supplied) return supplied;
    return `fx-${identity.mediaType}-${hash32(effectIdentityKey(identity))}`;
  }

  function normalizeEffectRecord(value = {}, index = 0) {
    const identity = normalizeEffectIdentity(value.identity || value, index);
    if (!identity) return null;
    const id = stableEffectId({ ...identity, id: value.id || value.effectId }, index);
    const category = cleanText(value.category || value.categoryName, 256);
    const aliases = uniqueStrings(value.aliases, 32, 256);
    const searchText = normalizedSearchText([
      identity.displayName,
      identity.matchName,
      category,
      identity.mediaType,
      ...aliases,
    ].join(" "));
    return {
      id,
      effectId: id,
      identity,
      type: identity.mediaType,
      mediaType: identity.mediaType,
      displayName: identity.displayName,
      matchName: identity.matchName,
      ordinal: identity.ordinal,
      occurrence: identity.ordinal,
      category,
      categoryAvailable: Boolean(category),
      source: cleanText(value.source, 128) || "host",
      aliases,
      searchText,
    };
  }

  function normalizeEffectIndex(input = {}) {
    const sourceEffects = Array.isArray(input.effects)
      ? input.effects
      : Array.isArray(input.entries) ? input.entries
        : Array.isArray(input.records) ? input.records : [];
    const effects = [];
    const ids = new Set();
    for (let index = 0; index < sourceEffects.length && effects.length < MAX_INDEX_EFFECTS; index += 1) {
      const effect = normalizeEffectRecord(sourceEffects[index], index);
      if (!effect) continue;
      let id = effect.id;
      let collision = 1;
      while (ids.has(id)) {
        id = `${effect.id}-${collision}`;
        collision += 1;
      }
      ids.add(id);
      effects.push(id === effect.id ? effect : { ...effect, id });
    }
    const corrupt = input.corrupt === true || input.valid === false;
    return {
      schema: cleanText(input.schema, 128) || "com.blocky.oracle.effect-index",
      version: finiteInteger(input.version, 1, 1, 1000),
      premiereVersion: cleanText(input.premiereVersion || input.hostVersion, 128),
      generatedAt: isoTimestamp(input.generatedAt, null),
      recoveredAt: isoTimestamp(input.recoveredAt, null),
      corrupt,
      corruptionReason: corrupt ? cleanText(input.corruptionReason || input.error, 1024) || "The cached effect index is invalid." : "",
      effects,
    };
  }

  function boundedEditDistance(leftValue, rightValue, maximum = 2) {
    const left = String(leftValue);
    const right = String(rightValue);
    if (left === right) return 0;
    if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row += 1) {
      const current = [row];
      let rowMinimum = current[0];
      for (let column = 1; column <= right.length; column += 1) {
        const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
        const insertion = current[column - 1] + 1;
        const deletion = previous[column] + 1;
        current[column] = Math.min(substitution, insertion, deletion);
        rowMinimum = Math.min(rowMinimum, current[column]);
      }
      if (rowMinimum > maximum) return maximum + 1;
      previous = current;
    }
    return previous[right.length] <= maximum ? previous[right.length] : maximum + 1;
  }

  function searchScore(record, query) {
    if (!query) return 1;
    const name = normalizedSearchText(record.displayName || record.name);
    const match = normalizedSearchText(record.matchName);
    const category = normalizedSearchText(record.category);
    const haystack = cleanText(record.searchText, 8192) || normalizedSearchText([name, match, category].join(" "));
    if (name === query) return 1000;
    if (name.startsWith(query)) return 850 - Math.min(200, name.length - query.length);
    const namePosition = name.indexOf(query);
    if (namePosition >= 0) return 700 - Math.min(200, namePosition);
    const matchPosition = match.indexOf(query);
    if (matchPosition >= 0) return 560 - Math.min(200, matchPosition);
    const categoryPosition = category.indexOf(query);
    if (categoryPosition >= 0) return 430 - Math.min(200, categoryPosition);
    if (haystack.includes(query)) return 320;
    if (query.length < 3 || query.length > 48) return -1;
    const maximumDistance = query.length >= 7 ? 2 : 1;
    const tokens = name.split(" ").concat(match.split(" ")).filter((token) => Math.abs(token.length - query.length) <= maximumDistance);
    for (const token of tokens.slice(0, 24)) {
      const distance = boundedEditDistance(token, query, maximumDistance);
      if (distance <= maximumDistance) return 220 - distance * 50;
    }
    return -1;
  }

  function normalizeCompatibility(value, fallback = {}) {
    if (value === true) return { compatible: true, reason: "", compatibleCount: null, skippedCount: null };
    if (value === false) return { compatible: false, reason: cleanText(fallback.reason, 1024) || "This item is not compatible with the active selection.", compatibleCount: 0, skippedCount: null };
    const source = isPlainObject(value) ? value : fallback;
    const compatible = source.compatible !== false && source.supported !== false;
    return {
      compatible,
      reason: compatible ? cleanText(source.reason || source.message, 1024) : cleanText(source.reason || source.message || source.code, 1024) || "This item is not compatible with the active selection.",
      compatibleCount: Number.isInteger(source.compatibleCount) && source.compatibleCount >= 0 ? source.compatibleCount : null,
      skippedCount: Number.isInteger(source.skippedCount) && source.skippedCount >= 0 ? source.skippedCount : null,
    };
  }

  function normalizeSelectionSummary(input = {}) {
    if (Array.isArray(input)) {
      const videoCount = input.filter((entry) => entry && entry.mediaKind === "video").length;
      const audioCount = input.filter((entry) => entry && entry.mediaKind === "audio").length;
      const unknownCount = Math.max(0, input.length - videoCount - audioCount);
      const revision = cleanText(JSON.stringify(input.map((entry) => entry && [entry.trackItemId, entry.revision])), 4096);
      const parts = [];
      if (videoCount) parts.push(`${videoCount} video`);
      if (audioCount) parts.push(`${audioCount} audio`);
      if (unknownCount) parts.push(`${unknownCount} unresolved media type`);
      return {
        totalCount: input.length,
        videoCount,
        audioCount,
        unknownCount,
        unsupportedCount: 0,
        revision,
        message: input.length
          ? `${input.length} selected clip${input.length === 1 ? "" : "s"}: ${parts.join(", ") || "exact compatibility pending preflight"}.`
          : "Select one or more timeline clips to apply an effect or Oracle Recipe.",
      };
    }
    const videoCount = finiteInteger(input.videoCount || input.selectedVideoCount, 0, 0, 100000);
    const audioCount = finiteInteger(input.audioCount || input.selectedAudioCount, 0, 0, 100000);
    const totalCount = finiteInteger(input.totalCount || input.selectedCount, videoCount + audioCount, 0, 100000);
    const unknownCount = finiteInteger(input.unknownCount, 0, 0, 100000);
    const unsupportedCount = finiteInteger(input.unsupportedCount, Math.max(0, totalCount - videoCount - audioCount), 0, 100000);
    const revision = cleanText(input.revision || input.selectionRevision, 4096);
    let message = cleanText(input.message, 1024);
    if (!message) {
      if (totalCount === 0) message = "Select one or more timeline clips to apply an effect or Oracle Recipe.";
      else {
        const parts = [];
        if (videoCount) parts.push(`${videoCount} video`);
        if (audioCount) parts.push(`${audioCount} audio`);
        if (unsupportedCount) parts.push(`${unsupportedCount} unsupported`);
        message = `${totalCount} selected clip${totalCount === 1 ? "" : "s"}: ${parts.join(", ") || "no supported media"}.`;
      }
    }
    return { totalCount, videoCount, audioCount, unknownCount, unsupportedCount, revision, message };
  }

  function fallbackEffectCompatibility(effect, selection) {
    if (!selection.totalCount) return { compatible: false, reason: "Select at least one timeline clip before applying this effect.", compatibleCount: 0, skippedCount: 0 };
    const knownCompatibleCount = effect.mediaType === "video" ? selection.videoCount : selection.audioCount;
    const compatibleCount = knownCompatibleCount + (selection.unknownCount || 0);
    const skippedCount = Math.max(0, selection.totalCount - compatibleCount);
    if (!compatibleCount) {
      return {
        compatible: false,
        reason: `The active selection contains no compatible ${effect.mediaType} TrackItems.`,
        compatibleCount,
        skippedCount,
      };
    }
    return {
      compatible: true,
      reason: `${compatibleCount} potential ${effect.mediaType} target${compatibleCount === 1 ? "" : "s"}; exact factory and component-chain compatibility is preflighted before commit${skippedCount ? `, with ${skippedCount} known incompatible item${skippedCount === 1 ? "" : "s"} reported` : ""}.`,
      compatibleCount,
      skippedCount,
    };
  }

  function safeJsonValue(value, depth = 0) {
    if (depth > 12) return null;
    if (value === null || typeof value === "boolean" || typeof value === "string") return typeof value === "string" ? cleanText(value, 16384) : value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.slice(0, 512).map((entry) => safeJsonValue(entry, depth + 1));
    if (!isPlainObject(value)) return null;
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 512)) {
      const safeKey = cleanText(key, 256);
      if (safeKey) output[safeKey] = safeJsonValue(entry, depth + 1);
    }
    return output;
  }

  function normalizeRecipeParameter(value = {}) {
    const index = Number(value.index != null ? value.index : value.paramIndex);
    const id = cleanText(value.id || value.parameterId || value.matchName || value.name || (Number.isInteger(index) && index >= 0 ? String(index) : ""), 1024);
    if (!id) return null;
    const valueType = cleanText(value.valueType || typeof value.value, 64).toLocaleLowerCase("en-US") || "unknown";
    return {
      id,
      index: Number.isInteger(index) && index >= 0 ? index : null,
      displayName: cleanText(value.displayName || value.name, 512) || id,
      valueType,
      value: safeJsonValue(value.value),
    };
  }

  function recipeSourceSteps(value = {}) {
    return Array.isArray(value.steps)
      ? value.steps
      : Array.isArray(value.effects) ? value.effects : [];
  }

  function recipeSourceParameters(value = {}) {
    if (Array.isArray(value.parameters)) return value.parameters;
    return isPlainObject(value.parameters) ? Object.entries(value.parameters) : [];
  }

  function recipeLimitErrors(value = {}) {
    const errors = [];
    const steps = recipeSourceSteps(value);
    if (steps.length > MAX_RECIPE_STEPS) errors.push(`Recipe exceeds the ${MAX_RECIPE_STEPS}-effect limit.`);
    steps.slice(0, MAX_RECIPE_STEPS + 1).forEach((step, index) => {
      if (recipeSourceParameters(step || {}).length > MAX_PARAMETERS_PER_STEP) {
        errors.push(`Recipe effect ${index + 1} exceeds the ${MAX_PARAMETERS_PER_STEP}-parameter limit.`);
      }
    });
    return errors;
  }

  function normalizeRecipeStep(value = {}, index = 0, options = {}) {
    const effectSource = value.effect || value.effectIdentity || value;
    const identity = normalizeEffectIdentity(effectSource, finiteInteger(value.ordinal, index, 0, MAX_INDEX_EFFECTS));
    if (!identity) return null;
    const effectId = cleanText(value.effectId || effectSource.id, 256) || stableEffectId(identity, identity.ordinal);
    const parameters = [];
    const sourceParameters = Array.isArray(value.parameters)
      ? value.parameters
      : isPlainObject(value.parameters)
        ? Object.entries(value.parameters).map(([id, parameterValue]) => ({ id, value: parameterValue }))
        : [];
    for (const parameter of sourceParameters.slice(0, MAX_PARAMETERS_PER_STEP + 1)) {
      const normalized = normalizeRecipeParameter(parameter);
      if (normalized) parameters.push(normalized);
    }
    return {
      id: cleanText(value.id || value.stepId, 256) || `step-${index + 1}-${hash32(`${effectId}:${index}`)}`,
      effectId,
      effectIdentity: identity,
      mediaType: identity.mediaType,
      displayName: identity.displayName,
      matchName: identity.matchName,
      ordinal: identity.ordinal,
      applyOnce: Object.prototype.hasOwnProperty.call(value, "applyOnce")
        ? value.applyOnce !== false
        : options.defaultApplyOnce !== false,
      parameters,
    };
  }

  function normalizeRecipe(value = {}, index = 0, options = {}) {
    const sourceSteps = recipeSourceSteps(value);
    const applyOnce = value.applyOnce !== false;
    const steps = [];
    for (let stepIndex = 0; stepIndex < sourceSteps.length && steps.length < MAX_RECIPE_STEPS + 1; stepIndex += 1) {
      const step = normalizeRecipeStep(sourceSteps[stepIndex], stepIndex, { defaultApplyOnce: applyOnce });
      if (step) steps.push(step);
    }
    const id = cleanText(value.id || value.recipeId, 256) || (typeof options.idFactory === "function" ? cleanText(options.idFactory(), 256) : "") || `recipe-${Date.now().toString(36)}-${hash32(`${value.name}:${index}:${Math.random()}`)}`;
    const createdAt = isoTimestamp(value.createdAt, options.now || new Date().toISOString());
    const updatedAt = isoTimestamp(value.updatedAt, createdAt);
    const mediaTypes = uniqueStrings(steps.map((step) => step.mediaType), 2, 16).filter((entry) => MEDIA_TYPES.includes(entry));
    const compatibilitySource = isPlainObject(value.compatibility) ? value.compatibility : {};
    return {
      id,
      name: cleanText(value.name, 256) || `Oracle Recipe ${index + 1}`,
      favorite: value.favorite === true,
      applyOnce,
      steps,
      compatibility: {
        mediaTypes,
        premiereMinVersion: cleanText(compatibilitySource.premiereMinVersion, 128),
        effectIndexVersion: finiteInteger(compatibilitySource.effectIndexVersion, null, 1, 1000),
        notes: cleanText(compatibilitySource.notes, 1024),
      },
      createdAt,
      updatedAt,
      sortOrder: finiteInteger(value.sortOrder, index, 0, MAX_RECIPES * 4),
    };
  }

  function validateRecipe(value) {
    const errors = [];
    if (!isPlainObject(value)) return { valid: false, errors: ["Recipe must be an object."] };
    errors.push(...recipeLimitErrors(value));
    if (!cleanText(value.id, 256)) errors.push("Recipe id is required.");
    if (!cleanText(value.name, 256)) errors.push("Recipe name is required.");
    if (!Array.isArray(value.steps) || value.steps.length === 0) errors.push("Recipe must contain at least one supported effect.");
    for (const [index, step] of (Array.isArray(value.steps) ? value.steps : []).entries()) {
      if (!normalizeRecipeStep(step, index)) errors.push(`Recipe effect ${index + 1} is invalid.`);
      if (Array.isArray(step && step.parameters) && step.parameters.some((parameter) => !Number.isInteger(parameter && parameter.index) || parameter.index < 0)) {
        errors.push(`Recipe effect ${index + 1} contains a parameter without a verified component parameter index.`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  function recipeLibrarySourceRecipes(input = {}) {
    return Array.isArray(input.recipes)
      ? input.recipes
      : isPlainObject(input.recipesById) ? Object.values(input.recipesById) : [];
  }

  function normalizeRecipeLibrary(input = {}, options = {}) {
    const sourceRecipes = recipeLibrarySourceRecipes(input);
    const recipes = [];
    const ids = new Set();
    const now = typeof options.now === "function" ? options.now() : new Date().toISOString();
    for (let index = 0; index < sourceRecipes.length && recipes.length < MAX_RECIPES; index += 1) {
      const recipe = normalizeRecipe(sourceRecipes[index], index, { now, idFactory: options.idFactory });
      const validation = validateRecipe(recipe);
      if (!validation.valid || ids.has(recipe.id)) continue;
      ids.add(recipe.id);
      recipes.push(recipe);
    }
    recipes.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
    recipes.forEach((recipe, index) => { recipe.sortOrder = index; });
    return {
      schema: RECIPE_LIBRARY_SCHEMA,
      version: RECIPE_LIBRARY_VERSION,
      revision: finiteInteger(input.revision, 0, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: isoTimestamp(input.updatedAt, now),
      recipes,
    };
  }

  function exportRecipeLibrary(input, options = {}) {
    const sourceRecipes = recipeLibrarySourceRecipes(input);
    if (sourceRecipes.length > MAX_RECIPES) throw new TypeError(`Oracle Recipe export exceeds the ${MAX_RECIPES}-recipe limit.`);
    for (const recipe of sourceRecipes) {
      const limitErrors = recipeLimitErrors(recipe);
      if (limitErrors.length) throw new TypeError(limitErrors[0]);
    }
    const library = normalizeRecipeLibrary(input, options);
    const payload = {
      schema: RECIPE_LIBRARY_SCHEMA,
      version: RECIPE_LIBRARY_VERSION,
      exportedAt: typeof options.now === "function" ? options.now() : new Date().toISOString(),
      recipes: library.recipes,
    };
    return JSON.stringify(payload, null, 2);
  }

  function importRecipeLibrary(serialized, options = {}) {
    const filename = cleanText(options.filename, 1024).toLocaleLowerCase("en-US");
    if (filename.endsWith(".prfpset")) throw new TypeError("Premiere .prfpset files are proprietary and are not Oracle Recipe files.");
    const text = String(serialized == null ? "" : serialized);
    if (!text || text.length > MAX_IMPORT_BYTES) throw new TypeError("Oracle Recipe import is empty or exceeds the 2 MB limit.");
    let parsed;
    try { parsed = JSON.parse(text); } catch (error) { throw new TypeError("Oracle Recipe JSON is invalid."); }
    if (!isPlainObject(parsed) || cleanText(parsed.schema, 128) !== RECIPE_LIBRARY_SCHEMA) throw new TypeError("This file is not an Oracle Recipe library.");
    if (finiteInteger(parsed.version, 0, 0, 1000) > RECIPE_LIBRARY_VERSION) throw new TypeError("This Oracle Recipe library was created by a newer version of Oracle.");
    const importedRecipes = recipeLibrarySourceRecipes(parsed);
    if (importedRecipes.length > MAX_RECIPES) {
      throw new TypeError(`Oracle Recipe import exceeds the ${MAX_RECIPES}-recipe limit.`);
    }
    for (const recipe of importedRecipes) {
      const limitErrors = recipeLimitErrors(recipe);
      if (limitErrors.length) throw new TypeError(limitErrors[0]);
    }
    const library = normalizeRecipeLibrary(parsed, options);
    if (!library.recipes.length && importedRecipes.length) throw new TypeError("The Oracle Recipe library contains no valid recipes.");
    return library;
  }

  function normalizePersistedState(input = {}, options = {}) {
    const recentLimit = finiteInteger(options.recentLimit, 20, 5, MAX_RECENT);
    const favorites = uniqueStrings(input.favoriteEffectIds || input.favorites, MAX_INDEX_EFFECTS, 256);
    const recent = [];
    const seen = new Set();
    for (const value of Array.isArray(input.recent) ? input.recent : []) {
      const source = value && typeof value === "object" ? value : { effectId: value };
      const suppliedTargetId = cleanText(source.targetId, 512);
      const suppliedKind = cleanText(source.kind, 16).toLocaleLowerCase("en-US");
      const legacyId = cleanText(source.id, 256);
      const effectId = cleanText(source.effectId || (suppliedTargetId.startsWith("effect:") ? suppliedTargetId.slice(7) : suppliedKind !== "recipe" ? legacyId : ""), 256);
      const recipeId = cleanText(source.recipeId || (suppliedTargetId.startsWith("recipe:") ? suppliedTargetId.slice(7) : suppliedKind === "recipe" ? source.id : ""), 256);
      const kind = recipeId ? "recipe" : effectId ? "effect" : "";
      const targetId = kind === "recipe" ? `recipe:${recipeId}` : kind === "effect" ? `effect:${effectId}` : "";
      if (!targetId || seen.has(targetId)) continue;
      seen.add(targetId);
      recent.push({
        kind,
        targetId,
        effectId: kind === "effect" ? effectId : "",
        recipeId: kind === "recipe" ? recipeId : "",
        usedAt: isoTimestamp(source.usedAt, null),
        verifiedCount: finiteInteger(source.verifiedCount, 1, 1, 1000000),
      });
      if (recent.length >= recentLimit) break;
    }
    return {
      schema: QUICK_APPLY_STATE_SCHEMA,
      version: QUICK_APPLY_STATE_VERSION,
      favoriteEffectIds: favorites,
      recent,
    };
  }

  function recipeCompatibility(recipe, selection, explicitValue) {
    if (explicitValue !== undefined) return normalizeCompatibility(explicitValue);
    if (!selection.totalCount) return { compatible: false, reason: "Select at least one timeline clip before applying this Oracle Recipe.", compatibleCount: 0, skippedCount: 0 };
    const mediaTypes = uniqueStrings(recipe.steps.map((step) => step.mediaType), 2, 16);
    const missing = mediaTypes.filter((mediaType) => mediaType === "video" ? !selection.videoCount : !selection.audioCount);
    if (missing.length) return { compatible: false, reason: `This recipe requires selected ${missing.join(" and ")} TrackItems.`, compatibleCount: 0, skippedCount: selection.totalCount };
    return { compatible: true, reason: "Every recipe stage has a compatible selected media type.", compatibleCount: selection.totalCount, skippedCount: 0 };
  }

  function normalizeAdapterSnapshot(input = {}) {
    const stateValue = cleanText(input.state || input.phase, 32).toLocaleLowerCase("en-US");
    const index = normalizeEffectIndex(input.index || input.effectIndex || { effects: input.effects, premiereVersion: input.premiereVersion });
    const selection = normalizeSelectionSummary(input.selection || input.selectionSummary);
    const errorSource = input.error && typeof input.error === "object" ? input.error : null;
    let state = WORKSPACE_STATES.includes(stateValue) ? stateValue : "";
    if (errorSource) state = "error";
    else if (index.corrupt) state = "error";
    else if (!state) state = index.effects.length ? "ready" : "empty";
    const error = errorSource
      ? { code: cleanText(errorSource.code || errorSource.name, 128) || "QUICK_APPLY_ERROR", message: cleanText(errorSource.message || errorSource.reason, 1024) || "Quick Apply could not inspect Premiere." }
      : index.corrupt ? { code: "CORRUPT_EFFECT_INDEX", message: index.corruptionReason } : null;
    return {
      state,
      message: cleanText(input.message, 1024),
      error,
      index,
      selection,
      compatibilityByEffectId: isPlainObject(input.compatibilityByEffectId) ? input.compatibilityByEffectId : isPlainObject(input.compatibility) ? input.compatibility : {},
      compatibilityByRecipeId: isPlainObject(input.compatibilityByRecipeId) ? input.compatibilityByRecipeId : {},
      capabilities: isPlainObject(input.capabilities) ? clone(input.capabilities) : {},
      revision: cleanText(input.revision, 4096),
    };
  }

  function readStore(store, fallback) {
    try {
      if (store && typeof store.getState === "function") return store.getState();
      if (store && typeof store.getLibrary === "function") return store.getLibrary();
      if (store && typeof store.getSnapshot === "function") return store.getSnapshot();
      if (store && Object.prototype.hasOwnProperty.call(store, "state")) return store.state;
    } catch (error) {
      return fallback;
    }
    return fallback;
  }

  async function writeStore(store, value, reason) {
    if (!store) return;
    if (typeof store.commit === "function") return store.commit(clone(value), reason);
    if (typeof store.replace === "function") return store.replace(clone(value), reason);
    if (typeof store.setState === "function") return store.setState(clone(value), reason);
    if (typeof store.setLibrary === "function") return store.setLibrary(clone(value), reason);
  }

  function adapterOperationDetails(value) {
    const source = value && typeof value === "object" ? value : {};
    const output = isPlainObject(source) ? safeJsonValue(source) || {} : {};
    const details = isPlainObject(source.details) ? safeJsonValue(source.details) || {} : {};
    const preservedFields = [
      "transactionCommitted", "committed", "partialFailure", "partialFailureBoundary",
      "stage", "failedStage", "undo", "undoSteps", "skipped", "skippedCount",
      "targets", "changed", "addedCount", "addedCountVerified", "committedComponentActionCount",
      "atomicity", "fullRollbackSupported", "historyEligible", "capability", "report",
    ];
    for (const field of preservedFields) {
      if (!Object.prototype.hasOwnProperty.call(output, field) && Object.prototype.hasOwnProperty.call(details, field)) output[field] = details[field];
    }
    if (Object.keys(details).length) output.details = details;
    return output;
  }

  function persistenceFailure(error, message) {
    return {
      ok: false,
      code: "PERSISTENCE_FAILED",
      message: cleanText(error && error.message, 2048) || message || "Oracle could not save this Quick Apply change.",
      persistence: { ok: false, code: "PERSISTENCE_FAILED" },
    };
  }

  class QuickApplyDomain {
    constructor(options = {}) {
      if (!options.adapter) throw new TypeError("QuickApplyDomain requires a verified Premiere effect adapter.");
      this.adapter = options.adapter;
      this.stateStore = options.stateStore || null;
      this.recipeStore = options.recipeStore || null;
      this.ownsAdapter = options.ownsAdapter === true;
      this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
      this.idFactory = typeof options.idFactory === "function" ? options.idFactory : null;
      this.preferences = {
        favoritesFirst: options.preferences && options.preferences.favoritesFirst !== false,
        defaultMedia: ["auto", "video", "audio"].includes(options.preferences && options.preferences.defaultMedia) ? options.preferences.defaultMedia : "auto",
        recentLimit: finiteInteger(options.preferences && options.preferences.recentLimit, 20, 5, MAX_RECENT),
      };
      this.maxResults = finiteInteger(options.maxResults, MAX_RESULTS, 20, MAX_RESULTS);
      this.persisted = normalizePersistedState(readStore(this.stateStore, {}), this.preferences);
      this.library = normalizeRecipeLibrary(readStore(this.recipeStore, {}), { now: this.now, idFactory: this.idFactory });
      this.adapterSnapshot = normalizeAdapterSnapshot(typeof this.adapter.getSnapshot === "function" ? this.adapter.getSnapshot() : {});
      this.query = "";
      this.scope = this.preferences.defaultMedia === "auto" ? "all" : this.preferences.defaultMedia;
      this.selectedTargetId = "";
      this.actionStatus = null;
      this.pendingTargetIds = new Set();
      this.listeners = new Set();
      this.started = false;
      this.destroyed = false;
      this.visible = options.visible === true;
      this.active = options.active === true;
      this.unsubscribeAdapter = null;
      this.unsubscribeState = null;
      this.unsubscribeRecipes = null;
      this.persistChain = Promise.resolve();
    }

    start() {
      if (this.started || this.destroyed) return this;
      this.started = true;
      if (typeof this.adapter.start === "function") this.adapter.start();
      if (typeof this.adapter.subscribe === "function") {
        this.unsubscribeAdapter = this.adapter.subscribe((snapshot) => {
          this.adapterSnapshot = normalizeAdapterSnapshot(snapshot);
          this.ensureSelectedTarget();
          this.emit();
        });
      }
      if (this.stateStore && typeof this.stateStore.subscribe === "function") {
        this.unsubscribeState = this.stateStore.subscribe((state) => {
          this.persisted = normalizePersistedState(state, this.preferences);
          this.emit();
        });
      }
      if (this.recipeStore && typeof this.recipeStore.subscribe === "function") {
        this.unsubscribeRecipes = this.recipeStore.subscribe((library) => {
          this.library = normalizeRecipeLibrary(library, { now: this.now, idFactory: this.idFactory });
          this.ensureSelectedTarget();
          this.emit();
        });
      }
      this.forwardLifecycle();
      this.ensureSelectedTarget();
      this.emit();
      return this;
    }

    subscribe(listener) {
      if (typeof listener !== "function") return () => undefined;
      this.listeners.add(listener);
      listener(this.getSnapshot());
      return () => this.listeners.delete(listener);
    }

    emit() {
      if (this.destroyed) return;
      const snapshot = this.getSnapshot();
      for (const listener of Array.from(this.listeners)) listener(snapshot);
    }

    setVisible(value) {
      this.visible = Boolean(value);
      this.forwardLifecycle();
      this.emit();
    }

    setActive(value) {
      this.active = Boolean(value);
      this.forwardLifecycle();
      this.emit();
    }

    forwardLifecycle() {
      if (typeof this.adapter.setVisible === "function") this.adapter.setVisible(this.visible);
      if (typeof this.adapter.setActive === "function") this.adapter.setActive(this.active);
    }

    setPreferences(value = {}) {
      this.preferences = {
        favoritesFirst: value.favoritesFirst !== false,
        defaultMedia: ["auto", "video", "audio"].includes(value.defaultMedia) ? value.defaultMedia : this.preferences.defaultMedia,
        recentLimit: finiteInteger(value.recentLimit, this.preferences.recentLimit, 5, MAX_RECENT),
      };
      this.persisted = normalizePersistedState(this.persisted, this.preferences);
      this.ensureSelectedTarget();
      this.emit();
    }

    setQuery(value) {
      this.query = cleanText(value, 240);
      this.ensureSelectedTarget(true);
      this.emit();
    }

    setScope(value) {
      const scope = cleanText(value, 32).toLocaleLowerCase("en-US");
      if (!RESULT_SCOPES.includes(scope)) return;
      this.scope = scope;
      this.ensureSelectedTarget(true);
      this.emit();
    }

    effectTargets() {
      const favoriteIds = new Set(this.persisted.favoriteEffectIds);
      const recentMap = new Map(this.persisted.recent.map((entry, index) => [entry.targetId, { ...entry, index }]));
      const compatibilityMap = this.adapterSnapshot.compatibilityByEffectId;
      return this.adapterSnapshot.index.effects.map((effect) => {
        const targetId = `effect:${effect.id}`;
        const explicit = Object.prototype.hasOwnProperty.call(compatibilityMap, effect.id)
          ? normalizeCompatibility(compatibilityMap[effect.id])
          : fallbackEffectCompatibility(effect, this.adapterSnapshot.selection);
        return {
          kind: "effect",
          id: targetId,
          effectId: effect.id,
          recipeId: "",
          name: effect.displayName,
          displayName: effect.displayName,
          matchName: effect.matchName,
          mediaType: effect.mediaType,
          category: effect.category,
          categoryAvailable: effect.categoryAvailable,
          identity: effect.identity,
          effect,
          recipe: null,
          favorite: favoriteIds.has(effect.id),
          recent: recentMap.has(targetId),
          recentIndex: recentMap.has(targetId) ? recentMap.get(targetId).index : null,
          compatibility: explicit,
          compatible: explicit.compatible,
          searchText: effect.searchText,
        };
      });
    }

    recipeTargets() {
      const compatibilityMap = this.adapterSnapshot.compatibilityByRecipeId;
      const recentMap = new Map(this.persisted.recent.map((entry, index) => [entry.targetId, { ...entry, index }]));
      return this.library.recipes.map((recipe) => {
        const targetId = `recipe:${recipe.id}`;
        const compatibility = recipeCompatibility(recipe, this.adapterSnapshot.selection, Object.prototype.hasOwnProperty.call(compatibilityMap, recipe.id) ? compatibilityMap[recipe.id] : undefined);
        const mediaType = recipe.compatibility.mediaTypes.length === 1 ? recipe.compatibility.mediaTypes[0] : "mixed";
        return {
          kind: "recipe",
          id: targetId,
          effectId: "",
          recipeId: recipe.id,
          name: recipe.name,
          displayName: recipe.name,
          matchName: "",
          mediaType,
          category: "",
          categoryAvailable: false,
          identity: null,
          effect: null,
          recipe,
          favorite: recipe.favorite,
          recent: recentMap.has(targetId),
          recentIndex: recentMap.has(targetId) ? recentMap.get(targetId).index : null,
          compatibility,
          compatible: compatibility.compatible,
          searchText: normalizedSearchText(`${recipe.name} ${recipe.steps.map((step) => `${step.displayName} ${step.matchName}`).join(" ")} oracle recipe`),
        };
      });
    }

    visibleTargets() {
      const query = normalizedSearchText(this.query);
      const targets = [...this.effectTargets(), ...this.recipeTargets()];
      const scoped = targets.filter((target) => {
        if (this.scope === "video" || this.scope === "audio") return target.kind === "effect" && target.mediaType === this.scope;
        if (this.scope === "favorites") return target.favorite;
        if (this.scope === "recent") return target.recent;
        if (this.scope === "recipes") return target.kind === "recipe";
        return true;
      });
      const scored = [];
      for (const target of scoped) {
        const score = searchScore(target, query);
        if (score < 0) continue;
        scored.push({ target, score });
      }
      scored.sort((left, right) => {
        if (query && left.score !== right.score) return right.score - left.score;
        if (this.scope === "recent" && left.target.recentIndex !== right.target.recentIndex) return left.target.recentIndex - right.target.recentIndex;
        if (this.preferences.favoritesFirst && left.target.favorite !== right.target.favorite) return left.target.favorite ? -1 : 1;
        if (left.target.kind !== right.target.kind) return left.target.kind === "effect" ? -1 : 1;
        return left.target.name.localeCompare(right.target.name) || left.target.id.localeCompare(right.target.id);
      });
      return scored.slice(0, this.maxResults).map((entry) => entry.target);
    }

    ensureSelectedTarget(reset = false) {
      const targets = this.visibleTargets();
      if (reset || !targets.some((target) => target.id === this.selectedTargetId)) {
        this.selectedTargetId = targets[0] ? targets[0].id : "";
      }
    }

    selectTarget(id) {
      const targetId = cleanText(id, 512);
      if (!this.visibleTargets().some((target) => target.id === targetId)) return false;
      this.selectedTargetId = targetId;
      this.emit();
      return true;
    }

    moveSelection(delta) {
      const targets = this.visibleTargets();
      if (!targets.length) return null;
      const current = Math.max(0, targets.findIndex((target) => target.id === this.selectedTargetId));
      const next = (current + (delta < 0 ? -1 : 1) + targets.length) % targets.length;
      this.selectedTargetId = targets[next].id;
      this.emit();
      return targets[next];
    }

    getTarget(id = this.selectedTargetId) {
      return [...this.effectTargets(), ...this.recipeTargets()].find((target) => target.id === id) || null;
    }

    getSnapshot() {
      const targets = this.visibleTargets();
      const selectedTarget = targets.find((target) => target.id === this.selectedTargetId) || null;
      let state = this.adapterSnapshot.state;
      let message = this.adapterSnapshot.message;
      if (state === "ready" && !this.adapterSnapshot.index.effects.length && !this.library.recipes.length) state = "empty";
      if (state === "ready" && this.adapterSnapshot.selection.totalCount > 0 && targets.length && !targets.some((target) => target.compatible)) state = "unsupported";
      if (!message) {
        message = ({
          loading: "Building the supported Premiere effect index…",
          empty: "No supported effects are indexed yet. Refresh after Premiere finishes loading its effect factories.",
          error: this.adapterSnapshot.error && this.adapterSnapshot.error.message || "Quick Apply could not inspect Premiere.",
          unsupported: "The current selection cannot use any result in this view.",
          ready: `${targets.length} supported effect${targets.length === 1 ? "" : "s"} and Oracle Recipe result${targets.length === 1 ? "" : "s"}.`,
        })[state] || "Quick Apply is ready.";
      }
      return {
        state,
        message,
        error: clone(this.adapterSnapshot.error),
        query: this.query,
        scope: this.scope,
        targets,
        selectedTarget,
        selectedTargetId: selectedTarget ? selectedTarget.id : "",
        selection: clone(this.adapterSnapshot.selection),
        index: { ...this.adapterSnapshot.index, effects: this.adapterSnapshot.index.effects.slice() },
        library: clone(this.library),
        actionStatus: clone(this.actionStatus),
        pendingTargetIds: Array.from(this.pendingTargetIds),
        capabilities: clone(this.adapterSnapshot.capabilities),
        visible: this.visible,
        active: this.active,
      };
    }

    persistState(reason) {
      const value = normalizePersistedState(this.persisted, this.preferences);
      const operation = this.persistChain.then(() => writeStore(this.stateStore, value, reason));
      this.persistChain = operation.catch(() => undefined);
      return operation;
    }

    persistRecipes(reason) {
      const value = normalizeRecipeLibrary({ ...this.library, revision: this.library.revision + 1, updatedAt: this.now() }, { now: this.now, idFactory: this.idFactory });
      this.library = value;
      const operation = this.persistChain.then(() => writeStore(this.recipeStore, value, reason));
      this.persistChain = operation.catch(() => undefined);
      return operation;
    }

    toggleFavorite(id = this.selectedTargetId) {
      const target = this.getTarget(id);
      if (!target) return false;
      if (target.kind === "recipe") {
        const previousLibrary = clone(this.library);
        const recipe = this.library.recipes.find((entry) => entry.id === target.recipeId);
        if (!recipe) return false;
        recipe.favorite = !recipe.favorite;
        recipe.updatedAt = this.now();
        void this.persistRecipes("quick-apply-recipe-favorite").catch((error) => {
          this.library = previousLibrary;
          this.actionStatus = { ...persistenceFailure(error, "Oracle could not save this recipe favorite."), tone: "error", targetId: target.id, at: this.now() };
          this.emit();
        });
      } else {
        const previousPersisted = clone(this.persisted);
        const favorites = new Set(this.persisted.favoriteEffectIds);
        if (favorites.has(target.effectId)) favorites.delete(target.effectId);
        else favorites.add(target.effectId);
        this.persisted.favoriteEffectIds = Array.from(favorites).slice(0, MAX_INDEX_EFFECTS);
        void this.persistState("quick-apply-effect-favorite").catch((error) => {
          this.persisted = previousPersisted;
          this.actionStatus = { ...persistenceFailure(error, "Oracle could not save this effect favorite."), tone: "error", targetId: target.id, at: this.now() };
          this.emit();
        });
      }
      this.emit();
      return true;
    }

    async recordVerifiedUse(target, result) {
      const targetId = target.id;
      const previousPersisted = clone(this.persisted);
      const previous = this.persisted.recent.find((entry) => entry.targetId === targetId);
      this.persisted.recent = [
        {
          kind: target.kind,
          targetId,
          effectId: target.kind === "effect" ? target.effectId : "",
          recipeId: target.kind === "recipe" ? target.recipeId : "",
          usedAt: this.now(),
          verifiedCount: (previous ? previous.verifiedCount : 0) + Math.max(1, finiteInteger(result && result.addedCount, 1, 1, 100000)),
        },
        ...this.persisted.recent.filter((entry) => entry.targetId !== targetId),
      ].slice(0, this.preferences.recentLimit);
      try {
        await this.persistState("quick-apply-verified-history");
      } catch (error) {
        this.persisted = previousPersisted;
        throw error;
      }
    }

    async applyTarget(id = this.selectedTargetId) {
      const target = this.getTarget(id);
      if (!target) return { ok: false, code: "NO_TARGET", message: "Choose a supported effect or Oracle Recipe first." };
      if (!target.compatible) {
        const result = { ok: false, code: "INCOMPATIBLE_SELECTION", message: target.compatibility.reason };
        this.actionStatus = { ...result, tone: "error", targetId: target.id, at: this.now() };
        this.emit();
        return result;
      }
      if (this.pendingTargetIds.has(target.id)) return { ok: false, code: "APPLY_IN_PROGRESS", message: `${target.name} is already being applied.` };
      this.pendingTargetIds.add(target.id);
      this.actionStatus = { ok: true, pending: true, tone: "progress", targetId: target.id, message: `Applying ${target.name}…`, at: this.now() };
      this.emit();
      const request = {
        targetId: target.id,
        selectionRevision: this.adapterSnapshot.selection.revision,
        applyOnce: target.kind === "recipe" ? target.recipe.applyOnce : true,
        effect: target.kind === "effect" ? clone(target.effect) : null,
        recipe: target.kind === "recipe" ? clone(target.recipe) : null,
      };
      try {
        let result;
        if (target.kind === "effect") {
          if (typeof this.adapter.planEffectApplication !== "function" || typeof this.adapter.applyEffect !== "function") {
            throw new Error("Verified effect application is unavailable in this Premiere runtime.");
          }
          const plan = await this.adapter.planEffectApplication(target.effect, {
            applyOnce: true,
            undoString: `Oracle Quick Apply: ${target.name}`,
            selectionRevision: request.selectionRevision,
          });
          result = await this.adapter.applyEffect(plan);
        } else {
          if (typeof this.adapter.planRecipeApplication !== "function" || typeof this.adapter.applyRecipe !== "function") {
            throw new Error("Transactional Oracle Recipe application is unavailable in this Premiere runtime.");
          }
          const plan = await this.adapter.planRecipeApplication(target.recipe, {
            applyOnce: request.applyOnce,
            undoString: `Oracle Recipe: ${target.name}`,
            parameterUndoString: `Oracle Recipe Parameters: ${target.name}`,
            selectionRevision: request.selectionRevision,
          });
          result = await this.adapter.applyRecipe(plan);
        }
        const receipt = adapterOperationDetails(result);
        const verified = Boolean(result && result.ok === true && result.verified === true);
        if (!verified) {
          const failure = {
            ...receipt,
            ok: false,
            verified: false,
            code: cleanText(result && (result.code || result.error && result.error.code || result.capability && result.capability.code), 128) || "UNVERIFIED_APPLY",
            message: cleanText(result && (result.message || result.reason || result.error && result.error.message || result.capability && result.capability.message), 2048) || `${target.name} was not recorded because Premiere did not verify every requested component.`,
          };
          this.actionStatus = { ...failure, tone: "error", targetId: target.id, at: this.now() };
          return failure;
        }
        let historyPersistence = null;
        if (result.historyEligible === true) {
          try {
            await this.recordVerifiedUse(target, result);
          } catch (error) {
            historyPersistence = persistenceFailure(error, `${target.name} was applied and verified, but Oracle could not save its Recent history.`).persistence;
          }
        }
        const skippedCount = finiteInteger(result.skippedCount, 0, 0, 100000);
        const success = {
          ...receipt,
          ok: true,
          verified: true,
          ...(historyPersistence ? { persistence: historyPersistence } : {}),
          message: cleanText(result.message, 2048) || `${target.name} applied and verified${skippedCount ? `; ${skippedCount} incompatible item${skippedCount === 1 ? " was" : "s were"} skipped and reported` : ""}${historyPersistence ? "; Recent history could not be saved" : ""}.`,
        };
        this.actionStatus = { ...success, tone: skippedCount || historyPersistence ? "warning" : "success", targetId: target.id, at: this.now() };
        return success;
      } catch (error) {
        const failure = {
          ...adapterOperationDetails(error),
          ok: false,
          code: cleanText(error && error.code, 128) || "APPLY_FAILED",
          message: cleanText(error && error.message, 2048) || `Premiere could not apply ${target.name}.`,
        };
        this.actionStatus = { ...failure, tone: "error", targetId: target.id, at: this.now() };
        return failure;
      } finally {
        this.pendingTargetIds.delete(target.id);
        this.emit();
      }
    }

    async refreshIndex(reason = "user") {
      const refresh = typeof this.adapter.refreshEffectIndex === "function"
        ? (options) => this.adapter.refreshEffectIndex(options)
        : typeof this.adapter.refreshIndex === "function"
          ? (options) => this.adapter.refreshIndex(options)
          : null;
      if (!refresh) {
        const result = { ok: false, code: "REFRESH_UNAVAILABLE", message: "The installed host adapter cannot refresh the supported effect index." };
        this.actionStatus = { ...result, tone: "error", at: this.now() };
        this.emit();
        return result;
      }
      try {
        await refresh({ force: true, reason: cleanText(reason, 128) || "user" });
        if (typeof this.adapter.requestRefresh === "function") await this.adapter.requestRefresh("effect-index-refresh");
        const snapshot = typeof this.adapter.getSnapshot === "function" ? this.adapter.getSnapshot() : null;
        if (snapshot) this.adapterSnapshot = normalizeAdapterSnapshot(snapshot);
        this.ensureSelectedTarget();
        this.actionStatus = { ok: true, verified: true, tone: "success", message: "Supported Premiere effects refreshed.", at: this.now() };
        this.emit();
        return { ok: true, snapshot: this.getSnapshot() };
      } catch (error) {
        const result = { ok: false, code: cleanText(error && error.code, 128) || "REFRESH_FAILED", message: cleanText(error && error.message, 2048) || "The supported effect index could not be refreshed." };
        this.actionStatus = { ...result, tone: "error", at: this.now() };
        this.emit();
        return result;
      }
    }

    async getSupportedParameters(effectId) {
      const target = this.getTarget(effectId && String(effectId).startsWith("effect:") ? effectId : `effect:${effectId}`);
      if (!target || target.kind !== "effect") return [];
      if (typeof this.adapter.getSupportedParameters !== "function") return [];
      const response = await this.adapter.getSupportedParameters(clone(target.effect));
      const values = Array.isArray(response) ? response : response && Array.isArray(response.parameters) ? response.parameters : [];
      return (Array.isArray(values) ? values : [])
        .filter((value) => value && value.supported !== false)
        .slice(0, MAX_PARAMETERS_PER_STEP)
        .map((value) => ({
          id: cleanText(value.id || value.parameterId || value.matchName || value.name, 1024),
          index: Number.isInteger(Number(value.index != null ? value.index : value.paramIndex)) && Number(value.index != null ? value.index : value.paramIndex) >= 0
            ? Number(value.index != null ? value.index : value.paramIndex)
            : null,
          displayName: cleanText(value.displayName || value.name, 512),
          valueType: cleanText(value.valueType || value.type, 64).toLocaleLowerCase("en-US") || "unknown",
          value: safeJsonValue(value.value != null ? value.value : value.defaultValue),
          minimum: Number.isFinite(Number(value.minimum)) ? Number(value.minimum) : null,
          maximum: Number.isFinite(Number(value.maximum)) ? Number(value.maximum) : null,
          options: Array.isArray(value.options) ? value.options.slice(0, 256).map((entry) => ({ value: safeJsonValue(isPlainObject(entry) ? entry.value : entry), label: cleanText(isPlainObject(entry) ? entry.label : entry, 256) })) : [],
          reason: cleanText(value.reason, 1024),
        }))
        .filter((value) => value.id && value.displayName && Number.isInteger(value.index) && value.index >= 0);
    }

    async saveRecipe(draft = {}, existingId = "") {
      const existingIndex = this.library.recipes.findIndex((entry) => entry.id === existingId);
      const now = this.now();
      const source = {
        ...draft,
        id: existingIndex >= 0 ? this.library.recipes[existingIndex].id : cleanText(draft.id, 256),
        createdAt: existingIndex >= 0 ? this.library.recipes[existingIndex].createdAt : now,
        updatedAt: now,
        sortOrder: existingIndex >= 0 ? existingIndex : this.library.recipes.length,
      };
      const sourceLimitErrors = recipeLimitErrors(source);
      if (sourceLimitErrors.length) return { ok: false, code: "INVALID_RECIPE", message: sourceLimitErrors[0], errors: sourceLimitErrors };
      const recipe = normalizeRecipe(source, source.sortOrder, { now, idFactory: this.idFactory });
      const validation = validateRecipe(recipe);
      if (!validation.valid) return { ok: false, code: "INVALID_RECIPE", message: validation.errors[0], errors: validation.errors };
      if (this.library.recipes.some((entry, index) => index !== existingIndex && entry.name.toLocaleLowerCase("en-US") === recipe.name.toLocaleLowerCase("en-US"))) {
        return { ok: false, code: "DUPLICATE_RECIPE_NAME", message: "An Oracle Recipe already uses this name." };
      }
      const previousLibrary = clone(this.library);
      if (existingIndex >= 0) this.library.recipes.splice(existingIndex, 1, recipe);
      else this.library.recipes.push(recipe);
      try {
        await this.persistRecipes(existingIndex >= 0 ? "quick-apply-recipe-update" : "quick-apply-recipe-create");
      } catch (error) {
        this.library = previousLibrary;
        const failure = persistenceFailure(error, "Oracle could not save this recipe.");
        this.actionStatus = { ...failure, tone: "error", targetId: `recipe:${recipe.id}`, at: this.now() };
        this.emit();
        return failure;
      }
      this.selectedTargetId = `recipe:${recipe.id}`;
      this.emit();
      return { ok: true, recipe: clone(recipe) };
    }

    async renameRecipe(recipeId, name) {
      const recipe = this.library.recipes.find((entry) => entry.id === recipeId);
      if (!recipe) return { ok: false, code: "RECIPE_NOT_FOUND", message: "The Oracle Recipe no longer exists." };
      return this.saveRecipe({ ...recipe, name: cleanText(name, 256) }, recipeId);
    }

    async duplicateRecipe(recipeId, name) {
      const recipe = this.library.recipes.find((entry) => entry.id === recipeId);
      if (!recipe) return { ok: false, code: "RECIPE_NOT_FOUND", message: "The Oracle Recipe no longer exists." };
      return this.saveRecipe({ ...clone(recipe), id: "", name: cleanText(name, 256) || `${recipe.name} Copy`, createdAt: this.now(), updatedAt: this.now() }, "");
    }

    async deleteRecipe(recipeId) {
      const index = this.library.recipes.findIndex((entry) => entry.id === recipeId);
      if (index < 0) return { ok: false, code: "RECIPE_NOT_FOUND", message: "The Oracle Recipe no longer exists." };
      const previousLibrary = clone(this.library);
      const [removed] = this.library.recipes.splice(index, 1);
      try {
        await this.persistRecipes("quick-apply-recipe-delete");
      } catch (error) {
        this.library = previousLibrary;
        const failure = persistenceFailure(error, "Oracle could not delete this recipe.");
        this.actionStatus = { ...failure, tone: "error", targetId: `recipe:${recipeId}`, at: this.now() };
        this.emit();
        return failure;
      }
      this.ensureSelectedTarget(true);
      this.emit();
      return { ok: true, recipe: clone(removed) };
    }

    async moveRecipe(recipeId, delta) {
      const index = this.library.recipes.findIndex((entry) => entry.id === recipeId);
      if (index < 0) return { ok: false, code: "RECIPE_NOT_FOUND", message: "The Oracle Recipe no longer exists." };
      const next = Math.min(this.library.recipes.length - 1, Math.max(0, index + (delta < 0 ? -1 : 1)));
      if (next === index) return { ok: true, unchanged: true };
      const previousLibrary = clone(this.library);
      const [recipe] = this.library.recipes.splice(index, 1);
      this.library.recipes.splice(next, 0, recipe);
      this.library.recipes.forEach((entry, order) => { entry.sortOrder = order; });
      try {
        await this.persistRecipes("quick-apply-recipe-reorder");
      } catch (error) {
        this.library = previousLibrary;
        const failure = persistenceFailure(error, "Oracle could not save the recipe order.");
        this.actionStatus = { ...failure, tone: "error", targetId: `recipe:${recipeId}`, at: this.now() };
        this.emit();
        return failure;
      }
      this.emit();
      return { ok: true, recipe: clone(recipe) };
    }

    async importRecipes(serialized, options = {}) {
      try {
        const incoming = importRecipeLibrary(serialized, { ...options, now: this.now, idFactory: this.idFactory });
        if (this.library.recipes.length + incoming.recipes.length > MAX_RECIPES) {
          throw new TypeError(`Import would exceed the ${MAX_RECIPES}-recipe library limit.`);
        }
        const previousLibrary = clone(this.library);
        const existingIds = new Set(this.library.recipes.map((recipe) => recipe.id));
        const existingNames = new Set(this.library.recipes.map((recipe) => recipe.name.toLocaleLowerCase("en-US")));
        let imported = 0;
        for (const recipe of incoming.recipes) {
          let candidate = recipe;
          if (existingIds.has(candidate.id)) candidate = normalizeRecipe({ ...candidate, id: "", name: `${candidate.name} Imported` }, this.library.recipes.length, { now: this.now(), idFactory: this.idFactory });
          let name = candidate.name;
          let suffix = 2;
          while (existingNames.has(name.toLocaleLowerCase("en-US"))) name = `${candidate.name} ${suffix++}`;
          candidate.name = name;
          candidate.sortOrder = this.library.recipes.length;
          existingIds.add(candidate.id);
          existingNames.add(candidate.name.toLocaleLowerCase("en-US"));
          this.library.recipes.push(candidate);
          imported += 1;
        }
        try {
          await this.persistRecipes("quick-apply-recipe-import");
        } catch (error) {
          this.library = previousLibrary;
          const failure = persistenceFailure(error, "Oracle could not save the imported recipes.");
          this.actionStatus = { ...failure, tone: "error", at: this.now() };
          this.emit();
          return failure;
        }
        this.actionStatus = { ok: true, verified: true, tone: "success", message: `${imported} Oracle Recipe${imported === 1 ? "" : "s"} imported.`, at: this.now() };
        this.emit();
        return { ok: true, imported };
      } catch (error) {
        const result = { ok: false, code: "RECIPE_IMPORT_FAILED", message: cleanText(error && error.message, 2048) || "Oracle Recipe import failed." };
        this.actionStatus = { ...result, tone: "error", at: this.now() };
        this.emit();
        return result;
      }
    }

    exportRecipes(recipeIds = null) {
      const selected = Array.isArray(recipeIds) && recipeIds.length
        ? this.library.recipes.filter((recipe) => recipeIds.includes(recipe.id))
        : this.library.recipes;
      return exportRecipeLibrary({ ...this.library, recipes: selected }, { now: this.now });
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (typeof this.unsubscribeAdapter === "function") this.unsubscribeAdapter();
      if (typeof this.unsubscribeState === "function") this.unsubscribeState();
      if (typeof this.unsubscribeRecipes === "function") this.unsubscribeRecipes();
      this.unsubscribeAdapter = null;
      this.unsubscribeState = null;
      this.unsubscribeRecipes = null;
      this.listeners.clear();
      if (this.ownsAdapter && this.adapter && typeof this.adapter.destroy === "function") this.adapter.destroy();
    }
  }

  return Object.freeze({
    QUICK_APPLY_STATE_SCHEMA,
    QUICK_APPLY_STATE_VERSION,
    RECIPE_LIBRARY_SCHEMA,
    RECIPE_LIBRARY_VERSION,
    WORKSPACE_STATES: WORKSPACE_STATES.slice(),
    RESULT_SCOPES: RESULT_SCOPES.slice(),
    MAX_INDEX_EFFECTS,
    MAX_RESULTS,
    MAX_RECIPES,
    MAX_RECIPE_STEPS,
    MAX_PARAMETERS_PER_STEP,
    cleanText,
    normalizeMediaType,
    normalizeEffectIdentity,
    effectIdentityKey,
    stableEffectId,
    normalizeEffectRecord,
    normalizeEffectIndex,
    boundedEditDistance,
    searchScore,
    normalizeCompatibility,
    normalizeSelectionSummary,
    normalizeRecipeParameter,
    normalizeRecipeStep,
    normalizeRecipe,
    validateRecipe,
    normalizeRecipeLibrary,
    exportRecipeLibrary,
    importRecipeLibrary,
    normalizePersistedState,
    normalizeAdapterSnapshot,
    QuickApplyDomain,
  });
});
