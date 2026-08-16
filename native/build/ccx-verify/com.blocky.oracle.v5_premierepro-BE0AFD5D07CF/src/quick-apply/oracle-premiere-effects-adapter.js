"use strict";

(function exposeOraclePremiereEffectsAdapter(globalScope, factory) {
  const effectIndexApi = typeof module === "object" && module && module.exports
    ? require("./oracle-effect-index.js")
    : globalScope && Reflect.get(globalScope, "OracleEffectIndex");
  const api = factory(effectIndexApi, globalScope);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OraclePremiereEffectsAdapter", api);
})(typeof window !== "undefined" ? window : null, function createOraclePremiereEffectsAdapterApi(effectIndexApi, globalScope) {
  if (!effectIndexApi) throw new Error("OracleEffectIndex must load before OraclePremiereEffectsAdapter.");

  function tracePremiereCall(name, operation, details = {}) {
    const telemetry = globalScope && Reflect.get(globalScope, "oraclePlatformTelemetry");
    return telemetry && typeof telemetry.invoke === "function"
      ? telemetry.invoke("premiere", name, operation, details)
      : operation();
  }

  const MIN_POLL_INTERVAL_MS = 100;
  const MAX_POLL_INTERVAL_MS = 250;
  const DEFAULT_MIN_POLL_INTERVAL_MS = 125;
  const DEFAULT_MAX_POLL_INTERVAL_MS = 250;
  const MAX_SELECTED_TRACK_ITEMS = 64;
  const MAX_COMPONENTS_PER_ITEM = 256;
  const MAX_RECIPE_STEPS = 32;
  const MAX_PARAMETERS_PER_STEP = 64;
  const MAX_ISSUED_PLANS = 32;
  const MAX_RECIPE_NAME_LENGTH = 128;
  const MAX_PARAMETER_STRING_LENGTH = 4096;

  const REASON = Object.freeze({
    OK: "OK",
    ADAPTER_DESTROYED: "ADAPTER_DESTROYED",
    OBSERVATION_SUSPENDED: "OBSERVATION_SUSPENDED",
    PREMIERE_API_UNAVAILABLE: "PREMIERE_API_UNAVAILABLE",
    HOST_VERSION_UNAVAILABLE: "HOST_VERSION_UNAVAILABLE",
    EFFECT_FACTORY_UNAVAILABLE: "EFFECT_FACTORY_UNAVAILABLE",
    EFFECT_INDEX_UNAVAILABLE: "EFFECT_INDEX_UNAVAILABLE",
    EFFECT_INDEX_INVALID: "EFFECT_INDEX_INVALID",
    EFFECT_NOT_FOUND: "EFFECT_NOT_FOUND",
    NO_ACTIVE_PROJECT: "NO_ACTIVE_PROJECT",
    NO_ACTIVE_SEQUENCE: "NO_ACTIVE_SEQUENCE",
    NO_SELECTION: "NO_SELECTION",
    SELECTION_UNREADABLE: "SELECTION_UNREADABLE",
    SELECTION_LIMIT_EXCEEDED: "SELECTION_LIMIT_EXCEEDED",
    TRACK_ITEM_UNREADABLE: "TRACK_ITEM_UNREADABLE",
    COMPONENT_CHAIN_UNAVAILABLE: "COMPONENT_CHAIN_UNAVAILABLE",
    COMPONENT_IDENTITY_UNAVAILABLE: "COMPONENT_IDENTITY_UNAVAILABLE",
    AMBIGUOUS_AUDIO_DISPLAY_NAME: "AMBIGUOUS_AUDIO_DISPLAY_NAME",
    MEDIA_TYPE_UNPROVEN: "MEDIA_TYPE_UNPROVEN",
    MEDIA_TYPE_INCOMPATIBLE: "MEDIA_TYPE_INCOMPATIBLE",
    EFFECT_CREATION_FAILED: "EFFECT_CREATION_FAILED",
    ACTION_CREATION_FAILED: "ACTION_CREATION_FAILED",
    ACTION_REJECTED: "ACTION_REJECTED",
    DUPLICATE_PREVENTED: "DUPLICATE_PREVENTED",
    NO_COMPATIBLE_TARGETS: "NO_COMPATIBLE_TARGETS",
    INVALID_PLAN: "INVALID_PLAN",
    STALE_PLAN: "STALE_PLAN",
    INVALID_RECIPE: "INVALID_RECIPE",
    RECIPE_PREMIERE_VERSION_UNSUPPORTED: "RECIPE_PREMIERE_VERSION_UNSUPPORTED",
    RECIPE_EFFECT_INDEX_VERSION_UNSUPPORTED: "RECIPE_EFFECT_INDEX_VERSION_UNSUPPORTED",
    PARAMETER_UNSUPPORTED: "PARAMETER_UNSUPPORTED",
    PARAMETER_METADATA_UNAVAILABLE: "PARAMETER_METADATA_UNAVAILABLE",
    TIME_VARYING_PARAMETER_UNSUPPORTED: "TIME_VARYING_PARAMETER_UNSUPPORTED",
    TRANSACTION_FAILED: "TRANSACTION_FAILED",
    COMPONENT_READBACK_FAILED: "COMPONENT_READBACK_FAILED",
    PARAMETER_READBACK_FAILED: "PARAMETER_READBACK_FAILED",
    PARTIAL_FAILURE: "PARTIAL_FAILURE",
  });

  const REASON_MESSAGES = Object.freeze({
    [REASON.OK]: "Available.",
    [REASON.ADAPTER_DESTROYED]: "The Premiere Quick Apply adapter has been destroyed.",
    [REASON.OBSERVATION_SUSPENDED]: "Quick Apply observation is suspended while the workspace is hidden or inactive.",
    [REASON.PREMIERE_API_UNAVAILABLE]: "The required Premiere UXP API is unavailable.",
    [REASON.HOST_VERSION_UNAVAILABLE]: "Premiere's host version is unavailable, so Blocky Studios will not create an unversioned effect cache.",
    [REASON.EFFECT_FACTORY_UNAVAILABLE]: "Premiere did not expose the required effect factory APIs.",
    [REASON.EFFECT_INDEX_UNAVAILABLE]: "The installed Premiere effect index is unavailable.",
    [REASON.EFFECT_INDEX_INVALID]: "The cached Premiere effect index was invalid.",
    [REASON.EFFECT_NOT_FOUND]: "This effect is not present in the current installed Premiere effect index.",
    [REASON.NO_ACTIVE_PROJECT]: "Open a Premiere project to use Quick Apply.",
    [REASON.NO_ACTIVE_SEQUENCE]: "Open an active sequence to use Quick Apply.",
    [REASON.NO_SELECTION]: "Select one or more timeline clips to use Quick Apply.",
    [REASON.SELECTION_UNREADABLE]: "Premiere did not expose the active sequence selection.",
    [REASON.SELECTION_LIMIT_EXCEEDED]: "The timeline selection is too large to modify safely in one Quick Apply operation.",
    [REASON.TRACK_ITEM_UNREADABLE]: "A selected timeline item could not be inspected.",
    [REASON.COMPONENT_CHAIN_UNAVAILABLE]: "Premiere did not expose this timeline item's component chain.",
    [REASON.COMPONENT_IDENTITY_UNAVAILABLE]: "An existing or newly created effect has no verifiable Premiere identity.",
    [REASON.AMBIGUOUS_AUDIO_DISPLAY_NAME]: "Premiere exposes more than one installed audio effect with this display name, but its documented factory accepts only the display name. Blocky Studios will not guess which duplicate to apply.",
    [REASON.MEDIA_TYPE_UNPROVEN]: "Premiere returned an opaque media type. Compatibility must be proven by the requested effect factory and component-chain action.",
    [REASON.MEDIA_TYPE_INCOMPATIBLE]: "This timeline item is not compatible with the requested effect type.",
    [REASON.EFFECT_CREATION_FAILED]: "Premiere could not create this effect for the selected timeline item.",
    [REASON.ACTION_CREATION_FAILED]: "Premiere could not create a supported component-chain action.",
    [REASON.ACTION_REJECTED]: "Premiere rejected an action before the transaction was committed.",
    [REASON.DUPLICATE_PREVENTED]: "Apply Once skipped this item because the effect is already present.",
    [REASON.NO_COMPATIBLE_TARGETS]: "None of the selected timeline items can accept this effect.",
    [REASON.INVALID_PLAN]: "The Quick Apply operation plan is invalid or was already used.",
    [REASON.STALE_PLAN]: "The project, selection, or effect stack changed. Search or refresh and try again.",
    [REASON.INVALID_RECIPE]: "The Blocky Studios Recipe is invalid or exceeds supported limits.",
    [REASON.RECIPE_PREMIERE_VERSION_UNSUPPORTED]: "This Blocky Studios Recipe requires a newer Premiere version.",
    [REASON.RECIPE_EFFECT_INDEX_VERSION_UNSUPPORTED]: "This Blocky Studios Recipe targets a different Premiere effect-index version.",
    [REASON.PARAMETER_UNSUPPORTED]: "A recipe parameter cannot be set through Premiere's documented action API.",
    [REASON.PARAMETER_METADATA_UNAVAILABLE]: "Premiere 26.3 does not expose documented generic parameter names, ranges, or enum options for effect discovery. Blocky Studios will not invent them.",
    [REASON.TIME_VARYING_PARAMETER_UNSUPPORTED]: "Blocky Studios Recipes do not overwrite an already keyframed parameter.",
    [REASON.TRANSACTION_FAILED]: "Premiere did not commit the Quick Apply transaction.",
    [REASON.COMPONENT_READBACK_FAILED]: "Premiere did not expose the exact added effect during readback.",
    [REASON.PARAMETER_READBACK_FAILED]: "Premiere did not retain a recipe parameter value during readback.",
    [REASON.PARTIAL_FAILURE]: "The effect stack was added, but a later parameter stage failed. Blocky Studios has reported the committed boundary exactly.",
  });

  class QuickApplyAdapterError extends Error {
    constructor(code, message, details = {}) {
      super(message || REASON_MESSAGES[code] || "Premiere Quick Apply failed.");
      this.name = "QuickApplyAdapterError";
      this.code = code || REASON.PREMIERE_API_UNAVAILABLE;
      this.details = details && typeof details === "object" ? { ...details } : {};
    }
  }

  function cleanText(value, maximum = 1024) {
    return String(value ?? "").trim().slice(0, maximum);
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
  }

  function guidText(value) {
    if (value === null || value === undefined) return "";
    try { return cleanText(typeof value.toString === "function" ? value.toString() : value, 256); } catch (error) { return ""; }
  }

  function tickText(value) {
    const text = cleanText(value && typeof value === "object" ? value.ticks : value, 256);
    const match = /^([+-]?)(\d+)$/.exec(text);
    if (!match) return null;
    const digits = match[2].replace(/^0+(?=\d)/, "");
    if (/^0+$/.test(digits)) return "0";
    return match[1] === "-" ? `-${digits}` : digits;
  }

  function reason(code, extra = {}) {
    return Object.freeze({
      supported: code === REASON.OK,
      code,
      message: REASON_MESSAGES[code] || "Unavailable.",
      ...extra,
    });
  }

  function stateForReason(code) {
    if (code === REASON.OK) return "ready";
    if ([REASON.NO_ACTIVE_PROJECT, REASON.NO_ACTIVE_SEQUENCE, REASON.NO_SELECTION, REASON.OBSERVATION_SUSPENDED].includes(code)) {
      return "empty";
    }
    if ([REASON.PREMIERE_API_UNAVAILABLE, REASON.EFFECT_FACTORY_UNAVAILABLE].includes(code)) return "unsupported";
    return "error";
  }

  function adapterError(error, fallbackCode, details = {}) {
    const sourceDetails = error && typeof error === "object" && error.details && typeof error.details === "object"
      ? error.details
      : {};
    if (error instanceof QuickApplyAdapterError) {
      return new QuickApplyAdapterError(error.code, error.message, { ...sourceDetails, ...details });
    }
    return new QuickApplyAdapterError(
      cleanText(error && error.code, 128) || fallbackCode,
      cleanText(error && error.message, 1024) || REASON_MESSAGES[fallbackCode],
      { ...sourceDetails, ...details },
    );
  }

  function numericVersion(value) {
    const text = cleanText(value, 64);
    if (!/^\d+(?:\.\d+){0,3}$/.test(text)) return null;
    const parts = text.split(".").map((entry) => Number(entry));
    return parts.every((entry) => Number.isSafeInteger(entry) && entry >= 0) ? parts : null;
  }

  function compareNumericVersions(leftValue, rightValue) {
    const left = numericVersion(leftValue);
    const right = numericVersion(rightValue);
    if (!left || !right) return null;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (left[index] || 0) - (right[index] || 0);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    return 0;
  }

  function unwrapKeyframeValue(keyframe) {
    if (!keyframe || typeof keyframe !== "object") return undefined;
    if (keyframe.value && typeof keyframe.value === "object" &&
        Object.prototype.hasOwnProperty.call(keyframe.value, "value")) return keyframe.value.value;
    return keyframe.value;
  }

  function parameterValueKind(value) {
    if (typeof value === "number" && Number.isFinite(value)) return "number";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (Array.isArray(value) && value.length === 2 && value.every((entry) => Number.isFinite(Number(entry)))) return "pointf";
    if (value && typeof value === "object" && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) return "pointf";
    if (value && typeof value === "object" && ["red", "green", "blue", "alpha"].every((key) => Number.isFinite(Number(value[key])))) {
      return "color";
    }
    return "unsupported";
  }

  function cloneParameterValue(value) {
    const kind = parameterValueKind(value);
    if (kind === "number" || kind === "boolean") return value;
    if (kind === "string") return cleanText(value, MAX_PARAMETER_STRING_LENGTH);
    if (kind === "pointf") return Object.freeze({
      x: Number(Array.isArray(value) ? value[0] : value.x),
      y: Number(Array.isArray(value) ? value[1] : value.y),
    });
    if (kind === "color") return Object.freeze({
      red: Number(value.red),
      green: Number(value.green),
      blue: Number(value.blue),
      alpha: Number(value.alpha),
    });
    throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
  }

  function parameterFingerprint(value) {
    const kind = parameterValueKind(value);
    if (kind === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
    if (kind === "string") return `string:${JSON.stringify(value)}`;
    if (kind === "boolean") return `boolean:${value ? "1" : "0"}`;
    if (kind === "pointf") return `pointf:${Number(Array.isArray(value) ? value[0] : value.x)},${Number(Array.isArray(value) ? value[1] : value.y)}`;
    if (kind === "color") return `color:${Number(value.red)},${Number(value.green)},${Number(value.blue)},${Number(value.alpha)}`;
    return "unsupported";
  }

  function createHostParameterValue(api, value) {
    const normalized = cloneParameterValue(value);
    const kind = parameterValueKind(normalized);
    if (kind === "pointf") {
      if (!api || typeof api.PointF !== "function") throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
      const point = tracePremiereCall("PointF", () => api.PointF());
      point.x = normalized.x;
      point.y = normalized.y;
      return point;
    }
    if (kind === "color") {
      if (!api || typeof api.Color !== "function") throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
      const color = tracePremiereCall("Color", () => api.Color());
      color.red = normalized.red;
      color.green = normalized.green;
      color.blue = normalized.blue;
      color.alpha = normalized.alpha;
      return color;
    }
    return normalized;
  }

  function componentMatchKey(matchName) {
    return cleanText(matchName, 512);
  }

  function componentIdFor(trackItemId, matchName, occurrence) {
    return `oracle-component:${encodeURIComponent(JSON.stringify([trackItemId, componentMatchKey(matchName), Number(occurrence)]))}`;
  }

  function trackItemIdFor(identity) {
    return `oracle-track-item:${encodeURIComponent(JSON.stringify([
      identity.projectGuid,
      identity.sequenceGuid,
      identity.mediaTypeIdentity,
      identity.trackIndex,
      identity.startTicks,
      identity.endTicks,
      identity.projectItemId,
      identity.matchName,
      identity.type,
    ]))}`;
  }

  async function readProjectItemId(api, projectItem) {
    if (!projectItem) return "";
    try {
      if (typeof projectItem.getId === "function") {
        const id = await Promise.resolve(tracePremiereCall("ProjectItem.getId", () => projectItem.getId()));
        if (cleanText(id, 256)) return cleanText(id, 256);
      }
      if (api && api.UniqueSerializeable && typeof api.UniqueSerializeable.cast === "function") {
        const serializable = tracePremiereCall("UniqueSerializeable.cast", () => api.UniqueSerializeable.cast(projectItem));
        if (serializable && typeof serializable.getUniqueID === "function") {
          return guidText(tracePremiereCall("UniqueSerializeable.getUniqueID", () => serializable.getUniqueID()));
        }
      }
    } catch (error) { /* identity remains bounded and fail-closed at apply */ }
    return "";
  }

  async function readComponent(component, chainIndex, occurrences) {
    if (!component || typeof component.getMatchName !== "function" || typeof component.getDisplayName !== "function") {
      throw new QuickApplyAdapterError(REASON.COMPONENT_IDENTITY_UNAVAILABLE);
    }
    const [matchNameValue, displayNameValue] = await Promise.all([
      tracePremiereCall("Component.getMatchName", () => component.getMatchName()),
      tracePremiereCall("Component.getDisplayName", () => component.getDisplayName()),
    ]);
    const matchName = componentMatchKey(matchNameValue);
    const displayName = cleanText(displayNameValue, 512);
    if (!matchName || !displayName) throw new QuickApplyAdapterError(REASON.COMPONENT_IDENTITY_UNAVAILABLE);
    const occurrence = occurrences.get(matchName) || 0;
    occurrences.set(matchName, occurrence + 1);
    return { component, chainIndex, matchName, displayName, occurrence };
  }

  async function readComponentChain(chain, maximum) {
    if (!chain || typeof chain.getComponentCount !== "function" || typeof chain.getComponentAtIndex !== "function") {
      throw new QuickApplyAdapterError(REASON.COMPONENT_CHAIN_UNAVAILABLE);
    }
    const count = Number(await Promise.resolve(tracePremiereCall("ComponentChain.getComponentCount", () => chain.getComponentCount())));
    if (!Number.isInteger(count) || count < 0 || count > maximum) {
      throw new QuickApplyAdapterError(REASON.COMPONENT_CHAIN_UNAVAILABLE, undefined, { count, maximum });
    }
    const occurrences = new Map();
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      const component = await Promise.resolve(tracePremiereCall("ComponentChain.getComponentAtIndex", () => chain.getComponentAtIndex(index), { index }));
      entries.push(await readComponent(component, index, occurrences));
    }
    return entries;
  }

  function componentRevision(components) {
    return JSON.stringify((components || []).map((entry) => [entry.matchName, entry.displayName, entry.occurrence, entry.chainIndex]));
  }

  async function inferMediaKind(api, resolver, mapping, context) {
    if (typeof resolver === "function") {
      const resolved = cleanText(await resolver(context), 16).toLowerCase();
      if (resolved === "video" || resolved === "audio") return resolved;
    }
    const rawValue = context.rawMediaType;
    const rawIdentity = context.mediaTypeIdentity;
    const constants = api && api.Constants && api.Constants.MediaType;
    if (typeof rawValue === "number" && constants) {
      if (rawValue === constants.VIDEO) return "video";
      if (rawValue === constants.AUDIO) return "audio";
    }
    if (mapping.video.has(rawIdentity)) return "video";
    if (mapping.audio.has(rawIdentity)) return "audio";
    const lower = rawIdentity.toLowerCase();
    if (["video", "mediatype.video", "constants.mediatype.video"].includes(lower)) return "video";
    if (["audio", "mediatype.audio", "constants.mediatype.audio"].includes(lower)) return "audio";
    const itemConstructor = context.item && context.item.constructor && cleanText(context.item.constructor.name, 128);
    const chainConstructor = context.chain && context.chain.constructor && cleanText(context.chain.constructor.name, 128);
    if (itemConstructor === "VideoClipTrackItem" || chainConstructor === "VideoComponentChain") return "video";
    if (itemConstructor === "AudioClipTrackItem" || chainConstructor === "AudioComponentChain") return "audio";
    return "unknown";
  }

  function normalizeIdentitySet(value) {
    return new Set((Array.isArray(value) ? value : []).map((entry) => guidText(entry)).filter(Boolean));
  }

  function publicComponent(trackItemId, entry) {
    return Object.freeze({
      componentId: componentIdFor(trackItemId, entry.matchName, entry.occurrence),
      matchName: entry.matchName,
      displayName: entry.displayName,
      occurrence: entry.occurrence,
      chainIndex: entry.chainIndex,
    });
  }

  async function readTrackItem(api, context, item, itemIndex, options) {
    const required = ["getComponentChain", "getTrackIndex", "getStartTime", "getEndTime", "getMediaType"];
    if (!item || !required.every((name) => typeof item[name] === "function")) {
      throw new QuickApplyAdapterError(REASON.TRACK_ITEM_UNREADABLE);
    }
    const [chain, trackIndexValue, startValue, endValue, rawMediaType, projectItem, matchNameValue, nameValue, typeValue] = await Promise.all([
      tracePremiereCall("TrackItem.getComponentChain", () => item.getComponentChain()),
      tracePremiereCall("TrackItem.getTrackIndex", () => item.getTrackIndex()),
      tracePremiereCall("TrackItem.getStartTime", () => item.getStartTime()),
      tracePremiereCall("TrackItem.getEndTime", () => item.getEndTime()),
      tracePremiereCall("TrackItem.getMediaType", () => item.getMediaType()),
      typeof item.getProjectItem === "function" ? tracePremiereCall("TrackItem.getProjectItem", () => item.getProjectItem()) : null,
      typeof item.getMatchName === "function" ? tracePremiereCall("TrackItem.getMatchName", () => item.getMatchName()) : "",
      typeof item.getName === "function" ? tracePremiereCall("TrackItem.getName", () => item.getName()) : "",
      typeof item.getType === "function" ? tracePremiereCall("TrackItem.getType", () => item.getType()) : -1,
    ]);
    const startTicks = tickText(startValue);
    const endTicks = tickText(endValue);
    const trackIndex = Number(trackIndexValue);
    if (startTicks === null || endTicks === null || !Number.isInteger(trackIndex) || trackIndex < 0) {
      throw new QuickApplyAdapterError(REASON.TRACK_ITEM_UNREADABLE);
    }
    const mediaTypeIdentity = guidText(rawMediaType);
    const identity = Object.freeze({
      projectGuid: context.projectGuid,
      sequenceGuid: context.sequenceGuid,
      mediaTypeIdentity,
      trackIndex,
      startTicks,
      endTicks,
      projectItemId: await readProjectItemId(api, projectItem),
      matchName: cleanText(matchNameValue, 512),
      type: Number(typeValue),
    });
    const trackItemId = trackItemIdFor(identity);
    const components = await readComponentChain(chain, options.maxComponentsPerItem);
    const mediaKind = await inferMediaKind(api, options.mediaTypeResolver, options.mediaTypeMapping, {
      item,
      chain,
      rawMediaType,
      mediaTypeIdentity,
      identity,
      api,
    });
    const publicComponents = Object.freeze(components.map((entry) => publicComponent(trackItemId, entry)));
    const revision = JSON.stringify([trackItemId, componentRevision(components)]);
    const publicItem = Object.freeze({
      trackItemId,
      revision,
      itemIndex,
      identity,
      display: Object.freeze({ name: cleanText(nameValue, 512) || "Timeline clip" }),
      mediaTypeIdentity,
      mediaKind,
      mediaTypeCapability: mediaKind === "unknown"
        ? reason(REASON.MEDIA_TYPE_UNPROVEN, { rawIdentity: mediaTypeIdentity })
        : reason(REASON.OK, { mediaKind, rawIdentity: mediaTypeIdentity }),
      components: publicComponents,
    });
    return {
      publicItem,
      item,
      chain,
      components,
      mediaKind,
      revision,
      identity,
    };
  }

  function selectionFingerprint(projectGuid, sequenceGuid, publicItems) {
    return JSON.stringify([projectGuid, sequenceGuid, publicItems.map((entry) => [entry.trackItemId, entry.revision])]);
  }

  function effectPublicCopy(effect) {
    if (!effect) return null;
    return Object.freeze({
      effectId: effect.effectId,
      type: effect.type,
      displayName: effect.displayName,
      matchName: effect.matchName,
      occurrence: effect.occurrence,
      identity: Object.freeze({ ...effect.identity }),
    });
  }

  function publicError(error, fallbackCode) {
    const normalized = adapterError(error, fallbackCode);
    return Object.freeze({ code: normalized.code, message: normalized.message, details: Object.freeze({ ...normalized.details }) });
  }

  function freezeSkip(skip) {
    return Object.freeze({
      trackItemId: skip.trackItemId || null,
      itemName: cleanText(skip.itemName, 512) || "Timeline clip",
      stepIndex: Number.isInteger(skip.stepIndex) ? skip.stepIndex : null,
      effectId: skip.effectId || null,
      effectName: cleanText(skip.effectName, 512),
      code: skip.code,
      message: skip.message || REASON_MESSAGES[skip.code] || "Skipped.",
      mediaTypeIdentity: cleanText(skip.mediaTypeIdentity, 256),
      mediaKind: skip.mediaKind || "unknown",
    });
  }

  function normalizeRecipe(recipeValue) {
    const recipe = recipeValue && typeof recipeValue === "object" ? recipeValue : null;
    const stepsValue = recipe && (Array.isArray(recipe.steps) ? recipe.steps : recipe.effects);
    const name = cleanText(recipe && recipe.name, MAX_RECIPE_NAME_LENGTH);
    if (!recipe || !name || !Array.isArray(stepsValue) || stepsValue.length === 0 || stepsValue.length > MAX_RECIPE_STEPS) {
      throw new QuickApplyAdapterError(REASON.INVALID_RECIPE);
    }
    const compatibilityTypes = Array.isArray(recipe.compatibility && recipe.compatibility.mediaTypes)
      ? Array.from(new Set(recipe.compatibility.mediaTypes.map((entry) => cleanText(entry, 16).toLowerCase())))
      : [];
    if (compatibilityTypes.some((entry) => entry !== "video" && entry !== "audio")) {
      throw new QuickApplyAdapterError(REASON.INVALID_RECIPE);
    }
    const premiereMinVersion = cleanText(recipe.compatibility && recipe.compatibility.premiereMinVersion, 64);
    if (premiereMinVersion && !numericVersion(premiereMinVersion)) {
      throw new QuickApplyAdapterError(REASON.INVALID_RECIPE, undefined, { field: "compatibility.premiereMinVersion" });
    }
    const effectIndexVersionValue = recipe.compatibility && recipe.compatibility.effectIndexVersion;
    const hasEffectIndexVersion = effectIndexVersionValue !== null && effectIndexVersionValue !== undefined && effectIndexVersionValue !== "";
    const effectIndexVersion = hasEffectIndexVersion ? Number(effectIndexVersionValue) : null;
    if (hasEffectIndexVersion && (!Number.isInteger(effectIndexVersion) || effectIndexVersion < 1 || effectIndexVersion > 1000)) {
      throw new QuickApplyAdapterError(REASON.INVALID_RECIPE, undefined, { field: "compatibility.effectIndexVersion" });
    }
    const steps = stepsValue.map((step, stepIndex) => {
      if (!step || typeof step !== "object") throw new QuickApplyAdapterError(REASON.INVALID_RECIPE, undefined, { stepIndex });
      const effectRef = step.effectId || step.effect || step.effectRef;
      if (!effectRef) throw new QuickApplyAdapterError(REASON.INVALID_RECIPE, undefined, { stepIndex });
      const parameterValues = Array.isArray(step.parameters) ? step.parameters : [];
      if (parameterValues.length > MAX_PARAMETERS_PER_STEP) throw new QuickApplyAdapterError(REASON.INVALID_RECIPE, undefined, { stepIndex });
      const parameterIndexes = new Set();
      const parameters = parameterValues.map((parameter) => {
        const index = Number(parameter && (parameter.index ?? parameter.paramIndex));
        if (!Number.isInteger(index) || index < 0 || parameterIndexes.has(index)) {
          throw new QuickApplyAdapterError(REASON.INVALID_RECIPE, undefined, { stepIndex, paramIndex: index });
        }
        parameterIndexes.add(index);
        const value = cloneParameterValue(parameter.value);
        return Object.freeze({ index, value, valueFingerprint: parameterFingerprint(value) });
      });
      return Object.freeze({
        stepIndex,
        effectRef,
        applyOnce: step.applyOnce !== undefined ? step.applyOnce === true : recipe.applyOnce !== false,
        parameters: Object.freeze(parameters),
      });
    });
    return Object.freeze({
      recipeId: cleanText(recipe.recipeId || recipe.id, 256) || null,
      name,
      compatibility: Object.freeze({
        mediaTypes: Object.freeze(compatibilityTypes),
        premiereMinVersion,
        effectIndexVersion,
      }),
      steps: Object.freeze(steps),
    });
  }

  function factoryCapabilityCode(api, type) {
    const factory = api && (type === "video" ? api.VideoFilterFactory : api.AudioFilterFactory);
    const requiredMethods = type === "video"
      ? ["getDisplayNames", "getMatchNames", "createComponent"]
      : ["getDisplayNames", "createComponentByDisplayName"];
    return factory && requiredMethods.every((method) => typeof factory[method] === "function")
      ? REASON.OK
      : REASON.EFFECT_FACTORY_UNAVAILABLE;
  }

  class PremiereQuickApplyAdapter {
    constructor(options = {}) {
      this.api = options.api || null;
      this.document = options.document || (typeof document !== "undefined" ? document : null);
      this.now = typeof options.now === "function" ? options.now : () => Date.now();
      this.setTimeout = typeof options.setTimeout === "function" ? options.setTimeout : (callback, delay) => setTimeout(callback, delay);
      this.clearTimeout = typeof options.clearTimeout === "function" ? options.clearTimeout : (handle) => clearTimeout(handle);
      this.logger = options.logger && typeof options.logger === "object" ? options.logger : null;
      this.hostVersion = cleanText(options.hostVersion || (this.api && this.api.Application && this.api.Application.version), 64);
      this.effectIndexStore = options.effectIndexStore && typeof options.effectIndexStore === "object" ? options.effectIndexStore : null;
      this.mediaTypeResolver = typeof options.mediaTypeResolver === "function" ? options.mediaTypeResolver : null;
      this.mediaTypeMapping = Object.freeze({
        video: normalizeIdentitySet(options.mediaTypeIdentities && options.mediaTypeIdentities.video),
        audio: normalizeIdentitySet(options.mediaTypeIdentities && options.mediaTypeIdentities.audio),
      });
      this.minPollIntervalMs = clampInteger(options.minPollIntervalMs, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, DEFAULT_MIN_POLL_INTERVAL_MS);
      this.maxPollIntervalMs = clampInteger(options.maxPollIntervalMs, this.minPollIntervalMs, MAX_POLL_INTERVAL_MS, DEFAULT_MAX_POLL_INTERVAL_MS);
      this.pollIntervalMs = this.minPollIntervalMs;
      this.limits = Object.freeze({
        maxSelectedTrackItems: clampInteger(options.maxSelectedTrackItems, 1, MAX_SELECTED_TRACK_ITEMS, MAX_SELECTED_TRACK_ITEMS),
        maxComponentsPerItem: clampInteger(options.maxComponentsPerItem, 1, MAX_COMPONENTS_PER_ITEM, MAX_COMPONENTS_PER_ITEM),
      });
      this.started = false;
      this.destroyed = false;
      this.visible = options.visible === true;
      this.active = options.active !== false;
      this.timer = null;
      this.refreshPromise = null;
      this.refreshQueued = false;
      this.refreshReasons = new Set();
      this.indexPromise = null;
      this.effectIndex = null;
      this.indexCacheState = "not-loaded";
      this.indexIssue = null;
      this.indexOperationalFailure = null;
      this.observationGeneration = 0;
      this.lastFingerprint = "";
      this.subscribers = new Set();
      this.observedSequence = null;
      this.observedSequenceListeners = [];
      this.planRecords = new Map();
      this.planSequence = 0;
      this.documentListener = () => this.onDocumentVisibilityChange();
      this.hostEventListener = () => this.onHostEvent();
      this.snapshot = this.makeStatusSnapshot(REASON.OBSERVATION_SUSPENDED);
    }

    makeStatusSnapshot(code, extra = {}) {
      const indexCode = this.effectIndexCapabilityCode();
      const indexCapability = indexCode === REASON.OK
        ? reason(REASON.OK, { hostVersion: this.effectIndex.hostVersion, count: this.effectIndex.entries.length })
        : reason(indexCode);
      return Object.freeze({
        revision: 0,
        observedAt: this.now(),
        observing: this.shouldObserve(),
        state: stateForReason(code),
        status: reason(code),
        message: REASON_MESSAGES[code] || "",
        project: null,
        sequence: null,
        selection: Object.freeze([]),
        issues: Object.freeze(this.indexIssue ? [this.indexIssue] : []),
        capabilities: Object.freeze({
          selection: reason(code),
          effectIndex: indexCapability,
          videoEffects: reason(factoryCapabilityCode(this.api, "video")),
          audioEffects: reason(factoryCapabilityCode(this.api, "audio")),
          recipeParameters: reason(REASON.OK, {
            atomicity: "two-stage",
            fullRollbackSupported: false,
            configuration: "explicit-index-and-value-only",
            metadata: reason(REASON.PARAMETER_METADATA_UNAVAILABLE),
          }),
        }),
        effectIndex: this.effectIndex,
        indexCacheState: this.indexCacheState,
        ...extra,
      });
    }

    start() {
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      if (this.started) return this;
      this.started = true;
      if (this.document && typeof this.document.addEventListener === "function") {
        this.document.addEventListener("visibilitychange", this.documentListener);
      }
      this.reconcileObservation("start");
      return this;
    }

    getSnapshot() { return this.snapshot; }
    getEffectIndex() { return this.effectIndex; }

    effectIndexCapabilityCode() {
      if (factoryCapabilityCode(this.api, "video") !== REASON.OK || factoryCapabilityCode(this.api, "audio") !== REASON.OK) {
        return REASON.EFFECT_FACTORY_UNAVAILABLE;
      }
      if (!this.hostVersion) return REASON.HOST_VERSION_UNAVAILABLE;
      if (this.indexOperationalFailure) return this.indexOperationalFailure.code;
      if (this.effectIndex) return REASON.OK;
      return cleanText(this.indexIssue && this.indexIssue.code, 128) || REASON.EFFECT_INDEX_UNAVAILABLE;
    }

    subscribe(listener, options = {}) {
      if (typeof listener !== "function") throw new TypeError("Quick Apply snapshot subscriber must be a function.");
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      this.subscribers.add(listener);
      if (options.immediate !== false) listener(this.snapshot);
      return () => this.subscribers.delete(listener);
    }

    setVisible(visible) {
      const next = Boolean(visible);
      if (next === this.visible || this.destroyed) return;
      this.visible = next;
      this.reconcileObservation("visibility");
    }

    setActive(active) {
      const next = Boolean(active);
      if (next === this.active || this.destroyed) return;
      this.active = next;
      this.reconcileObservation("active-state");
    }

    documentIsVisible() { return !this.document || this.document.visibilityState !== "hidden"; }
    shouldObserve() { return Boolean(this.started && !this.destroyed && this.visible && this.active && this.documentIsVisible()); }

    onDocumentVisibilityChange() { this.reconcileObservation("document-visibility"); }

    onHostEvent() {
      if (!this.shouldObserve()) return;
      this.pollIntervalMs = this.minPollIntervalMs;
      this.requestRefresh("host-event");
    }

    reconcileObservation(reasonName) {
      this.observationGeneration += 1;
      this.clearObservationTimer();
      if (!this.shouldObserve()) {
        this.unbindSequenceEvents();
        if (!this.destroyed) this.publish(this.makeStatusSnapshot(REASON.OBSERVATION_SUSPENDED));
        return;
      }
      this.pollIntervalMs = this.minPollIntervalMs;
      this.requestRefresh(reasonName);
    }

    clearObservationTimer() {
      if (this.timer === null) return;
      this.clearTimeout(this.timer);
      this.timer = null;
    }

    scheduleObservation() {
      this.clearObservationTimer();
      if (!this.shouldObserve()) return;
      const generation = this.observationGeneration;
      this.timer = this.setTimeout(() => {
        this.timer = null;
        if (generation !== this.observationGeneration || !this.shouldObserve()) return;
        this.requestRefresh("poll");
      }, this.pollIntervalMs);
    }

    requestRefresh(reasonName = "manual") {
      if (this.destroyed) return Promise.reject(new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED));
      if (!this.shouldObserve()) return Promise.resolve(this.snapshot);
      this.refreshReasons.add(cleanText(reasonName, 128) || "manual");
      this.refreshQueued = true;
      if (this.refreshPromise) return this.refreshPromise;
      const generation = this.observationGeneration;
      this.refreshPromise = (async () => {
        let latest = this.snapshot;
        while (this.refreshQueued && !this.destroyed) {
          this.refreshQueued = false;
          const reasons = Array.from(this.refreshReasons);
          this.refreshReasons.clear();
          latest = await this.refreshOnce(reasons);
        }
        return latest;
      })().finally(() => {
        this.refreshPromise = null;
        if (generation === this.observationGeneration) this.scheduleObservation();
      });
      return this.refreshPromise;
    }

    async loadCachedIndex() {
      if (!this.effectIndexStore || typeof this.effectIndexStore.load !== "function") return null;
      let cached;
      try { cached = await this.effectIndexStore.load(); } catch (error) {
        this.indexIssue = publicError(error, REASON.EFFECT_INDEX_INVALID);
        this.indexCacheState = "load-failed";
        return null;
      }
      if (cached === null || cached === undefined) return null;
      const validated = effectIndexApi.validateEffectIndex(cached, { hostVersion: this.hostVersion });
      if (validated) {
        this.indexCacheState = "cache-hit";
        return validated;
      }
      this.indexIssue = Object.freeze({ code: REASON.EFFECT_INDEX_INVALID, message: REASON_MESSAGES[REASON.EFFECT_INDEX_INVALID] });
      this.indexCacheState = "corrupt-cache-recovered";
      if (typeof this.effectIndexStore.clear === "function") {
        try { await this.effectIndexStore.clear(); } catch (error) { /* rebuild remains authoritative */ }
      }
      return null;
    }

    async buildHostEffectIndex() {
      if (!this.hostVersion) throw new QuickApplyAdapterError(REASON.HOST_VERSION_UNAVAILABLE);
      const videoFactory = this.api && this.api.VideoFilterFactory;
      const audioFactory = this.api && this.api.AudioFilterFactory;
      if (!videoFactory || typeof videoFactory.getDisplayNames !== "function" || typeof videoFactory.getMatchNames !== "function" ||
          !audioFactory || typeof audioFactory.getDisplayNames !== "function") {
        throw new QuickApplyAdapterError(REASON.EFFECT_FACTORY_UNAVAILABLE);
      }
      let videoDisplayNames;
      let videoMatchNames;
      let audioDisplayNames;
      try {
        [videoDisplayNames, videoMatchNames, audioDisplayNames] = await Promise.all([
          tracePremiereCall("VideoFilterFactory.getDisplayNames", () => videoFactory.getDisplayNames()),
          tracePremiereCall("VideoFilterFactory.getMatchNames", () => videoFactory.getMatchNames()),
          tracePremiereCall("AudioFilterFactory.getDisplayNames", () => audioFactory.getDisplayNames()),
        ]);
      } catch (error) {
        throw adapterError(error, REASON.EFFECT_FACTORY_UNAVAILABLE);
      }
      try {
        return effectIndexApi.createEffectIndex({
          hostVersion: this.hostVersion,
          generatedAt: this.now(),
          videoDisplayNames,
          videoMatchNames,
          audioDisplayNames,
        });
      } catch (error) {
        throw adapterError(error, REASON.EFFECT_INDEX_INVALID);
      }
    }

    async ensureEffectIndex(options = {}) {
      if (this.effectIndex && options.force !== true) {
        if (this.indexOperationalFailure) {
          throw new QuickApplyAdapterError(
            this.indexOperationalFailure.code,
            this.indexOperationalFailure.message,
            this.indexOperationalFailure.details,
          );
        }
        return this.effectIndex;
      }
      if (this.indexPromise) return this.indexPromise;
      this.indexPromise = (async () => {
        let index = options.force === true ? null : await this.loadCachedIndex();
        if (!index) {
          index = await this.buildHostEffectIndex();
          this.indexCacheState = this.indexCacheState === "corrupt-cache-recovered" ? "corrupt-cache-rebuilt" : "host-refreshed";
          if (this.effectIndexStore && typeof this.effectIndexStore.save === "function") {
            try { await this.effectIndexStore.save(index); } catch (error) {
              this.indexIssue = publicError(error, REASON.EFFECT_INDEX_INVALID);
              this.indexCacheState = "host-refreshed-cache-save-failed";
            }
          }
        }
        this.effectIndex = index;
        this.indexOperationalFailure = null;
        return index;
      })().catch((error) => {
        const normalized = adapterError(error, REASON.EFFECT_INDEX_UNAVAILABLE);
        this.indexOperationalFailure = publicError(normalized, normalized.code);
        throw normalized;
      }).finally(() => { this.indexPromise = null; });
      return this.indexPromise;
    }

    async refreshEffectIndex(options = {}) {
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      try {
        const index = await this.ensureEffectIndex({ force: options.force !== false });
        this.indexIssue = null;
        this.publish(Object.freeze({
          ...this.snapshot,
          revision: Number(this.snapshot.revision || 0) + 1,
          observedAt: this.now(),
          effectIndex: index,
          indexCacheState: this.indexCacheState,
          capabilities: Object.freeze({
            ...this.snapshot.capabilities,
            effectIndex: reason(REASON.OK, { hostVersion: index.hostVersion, count: index.entries.length }),
          }),
        }));
        return index;
      } catch (error) {
        const normalized = adapterError(error, REASON.EFFECT_INDEX_UNAVAILABLE);
        this.indexIssue = publicError(normalized, normalized.code);
        throw normalized;
      }
    }

    searchEffects(query, options = {}) {
      if (!this.effectIndex) return Object.freeze([]);
      return effectIndexApi.searchEffectIndex(this.effectIndex, query, options);
    }

    async getSupportedParameters(effectRef) {
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      await this.ensureEffectIndex({ force: false });
      const request = effectRef && typeof effectRef === "object" && Object.prototype.hasOwnProperty.call(effectRef, "effect")
        ? effectRef
        : null;
      const effect = this.resolveEffect(request ? request.effect : effectRef);
      return Object.freeze({
        effect: effectPublicCopy(effect),
        parameters: Object.freeze([]),
        capability: reason(REASON.PARAMETER_METADATA_UNAVAILABLE),
        configuration: "explicit-index-and-value-only",
      });
    }

    async refreshOnce(refreshReasons) {
      const generation = this.observationGeneration;
      try { await this.ensureEffectIndex({ force: false }); } catch (error) {
        const normalized = adapterError(error, REASON.EFFECT_INDEX_UNAVAILABLE);
        this.indexIssue = publicError(normalized, normalized.code);
      }
      let inspection;
      try { inspection = await this.inspectHost(); } catch (error) {
        const normalized = adapterError(error, REASON.SELECTION_UNREADABLE);
        inspection = {
          snapshot: this.makeStatusSnapshot(normalized.code, {
            issues: Object.freeze([publicError(normalized, normalized.code)]),
          }),
          refs: new Map(),
          sequence: null,
        };
      }
      if (this.destroyed || generation !== this.observationGeneration || !this.shouldObserve()) return this.snapshot;
      this.bindSequenceEvents(inspection.sequence);
      const fingerprint = this.fingerprint(inspection.snapshot);
      this.pollIntervalMs = fingerprint && fingerprint === this.lastFingerprint
        ? Math.min(this.maxPollIntervalMs, this.pollIntervalMs + 25)
        : this.minPollIntervalMs;
      this.lastFingerprint = fingerprint;
      const next = Object.freeze({
        ...inspection.snapshot,
        revision: Number(this.snapshot.revision || 0) + 1,
        observedAt: this.now(),
        observing: true,
        refreshReasons: Object.freeze([...refreshReasons]),
      });
      this.publish(next);
      return next;
    }

    fingerprint(snapshot) {
      return JSON.stringify([
        snapshot.status && snapshot.status.code,
        snapshot.project && snapshot.project.guid,
        snapshot.sequence && snapshot.sequence.guid,
        snapshot.selection && snapshot.selection.map((entry) => [entry.trackItemId, entry.revision]),
        snapshot.effectIndex && [snapshot.effectIndex.hostVersion, snapshot.effectIndex.generatedAt],
        snapshot.issues && snapshot.issues.map((entry) => entry.code),
      ]);
    }

    publish(snapshot) {
      this.snapshot = snapshot;
      for (const listener of Array.from(this.subscribers)) {
        try { listener(snapshot); } catch (error) {
          if (this.logger && typeof this.logger.error === "function") this.logger.error("[Blocky Studios Quick Apply] Snapshot subscriber failed.", error);
        }
      }
    }

    bindSequenceEvents(sequence) {
      if (this.observedSequence === sequence) return;
      this.unbindSequenceEvents();
      if (!sequence || !this.shouldObserve()) return;
      const manager = this.api && this.api.EventManager;
      const events = this.api && this.api.Constants && this.api.Constants.SequenceEvent;
      if (!manager || typeof manager.addEventListener !== "function" || !events) return;
      const eventNames = [events.SELECTION_CHANGED, events.ACTIVATED, events.CLOSED]
        .filter((entry) => entry !== null && entry !== undefined);
      for (const eventName of eventNames) {
        try {
          tracePremiereCall("EventManager.addEventListener", () => manager.addEventListener(sequence, eventName, this.hostEventListener), { eventName: guidText(eventName) });
          this.observedSequenceListeners.push({ sequence, eventName });
        } catch (error) { /* bounded polling remains authoritative */ }
      }
      this.observedSequence = sequence;
    }

    unbindSequenceEvents() {
      const manager = this.api && this.api.EventManager;
      if (manager && typeof manager.removeEventListener === "function") {
        for (const entry of this.observedSequenceListeners.splice(0)) {
          try {
            tracePremiereCall("EventManager.removeEventListener", () => manager.removeEventListener(entry.sequence, entry.eventName, this.hostEventListener), { eventName: guidText(entry.eventName) });
          } catch (error) { /* best effort cleanup */ }
        }
      } else this.observedSequenceListeners.length = 0;
      this.observedSequence = null;
    }

    async inspectHost() {
      const api = this.api;
      if (!api || !api.Project || typeof api.Project.getActiveProject !== "function") {
        return { snapshot: this.makeStatusSnapshot(REASON.PREMIERE_API_UNAVAILABLE), refs: new Map(), project: null, sequence: null, selectionFingerprint: "" };
      }
      const project = await tracePremiereCall("Project.getActiveProject", () => api.Project.getActiveProject());
      if (!project) return { snapshot: this.makeStatusSnapshot(REASON.NO_ACTIVE_PROJECT), refs: new Map(), project: null, sequence: null, selectionFingerprint: "" };
      if (typeof project.getActiveSequence !== "function") {
        return { snapshot: this.makeStatusSnapshot(REASON.NO_ACTIVE_SEQUENCE), refs: new Map(), project, sequence: null, selectionFingerprint: "" };
      }
      const sequence = await tracePremiereCall("Project.getActiveSequence", () => project.getActiveSequence());
      if (!sequence) return { snapshot: this.makeStatusSnapshot(REASON.NO_ACTIVE_SEQUENCE), refs: new Map(), project, sequence: null, selectionFingerprint: "" };
      if (typeof sequence.getSelection !== "function") {
        return { snapshot: this.makeStatusSnapshot(REASON.SELECTION_UNREADABLE), refs: new Map(), project, sequence, selectionFingerprint: "" };
      }
      const selection = await tracePremiereCall("Sequence.getSelection", () => sequence.getSelection());
      if (!selection || typeof selection.getTrackItems !== "function") {
        return { snapshot: this.makeStatusSnapshot(REASON.SELECTION_UNREADABLE), refs: new Map(), project, sequence, selectionFingerprint: "" };
      }
      const items = await tracePremiereCall("Selection.getTrackItems", () => selection.getTrackItems());
      if (!Array.isArray(items)) {
        return { snapshot: this.makeStatusSnapshot(REASON.SELECTION_UNREADABLE), refs: new Map(), project, sequence, selectionFingerprint: "" };
      }
      const projectGuid = guidText(project.guid);
      const sequenceGuid = guidText(sequence.guid);
      const base = {
        project: Object.freeze({ guid: projectGuid, name: cleanText(project.name, 512) }),
        sequence: Object.freeze({ guid: sequenceGuid, name: cleanText(sequence.name, 512) }),
        effectIndex: this.effectIndex,
        indexCacheState: this.indexCacheState,
      };
      if (items.length === 0) {
        return { snapshot: this.makeStatusSnapshot(REASON.NO_SELECTION, base), refs: new Map(), project, sequence, selectionFingerprint: selectionFingerprint(projectGuid, sequenceGuid, []) };
      }
      if (items.length > this.limits.maxSelectedTrackItems) {
        return { snapshot: this.makeStatusSnapshot(REASON.SELECTION_LIMIT_EXCEEDED, base), refs: new Map(), project, sequence, selectionFingerprint: "" };
      }
      const publicItems = [];
      const refs = new Map();
      const issues = this.indexIssue ? [this.indexIssue] : [];
      const readOptions = {
        maxComponentsPerItem: this.limits.maxComponentsPerItem,
        mediaTypeResolver: this.mediaTypeResolver,
        mediaTypeMapping: this.mediaTypeMapping,
      };
      for (let index = 0; index < items.length; index += 1) {
        try {
          const inspected = await readTrackItem(api, { projectGuid, sequenceGuid }, items[index], index, readOptions);
          publicItems.push(inspected.publicItem);
          refs.set(inspected.publicItem.trackItemId, inspected);
        } catch (error) {
          const normalized = adapterError(error, REASON.TRACK_ITEM_UNREADABLE, { itemIndex: index });
          issues.push(Object.freeze({ ...publicError(normalized, normalized.code), itemIndex: index }));
        }
      }
      const indexCode = this.effectIndexCapabilityCode();
      const statusCode = publicItems.length > 0 ? indexCode : REASON.TRACK_ITEM_UNREADABLE;
      const indexCapability = indexCode === REASON.OK
        ? reason(REASON.OK, { hostVersion: this.effectIndex.hostVersion, count: this.effectIndex.entries.length })
        : reason(indexCode);
      const snapshot = Object.freeze({
        revision: 0,
        observedAt: this.now(),
        observing: this.shouldObserve(),
        state: stateForReason(statusCode),
        status: reason(statusCode),
        message: REASON_MESSAGES[statusCode],
        ...base,
        selection: Object.freeze(publicItems),
        issues: Object.freeze(issues),
        capabilities: Object.freeze({
          selection: reason(statusCode, { count: publicItems.length }),
          effectIndex: indexCapability,
          videoEffects: reason(factoryCapabilityCode(this.api, "video")),
          audioEffects: reason(factoryCapabilityCode(this.api, "audio")),
          recipeParameters: reason(REASON.OK, {
            atomicity: "two-stage",
            fullRollbackSupported: false,
            configuration: "explicit-index-and-value-only",
            metadata: reason(REASON.PARAMETER_METADATA_UNAVAILABLE),
          }),
        }),
      });
      return {
        snapshot,
        refs,
        project,
        sequence,
        selectionFingerprint: selectionFingerprint(projectGuid, sequenceGuid, publicItems),
      };
    }

    resolveEffect(effectRef) {
      if (!this.effectIndex) throw new QuickApplyAdapterError(REASON.EFFECT_INDEX_UNAVAILABLE);
      const id = typeof effectRef === "string"
        ? cleanText(effectRef, 4096)
        : cleanText(effectRef && effectRef.effectId, 4096);
      let effect = id ? this.effectIndex.entries.find((entry) => entry.effectId === id) : null;
      if (!effect && effectRef && typeof effectRef === "object") {
        const type = effectRef.type;
        const displayName = cleanText(effectRef.displayName, 512);
        const matchName = type === "video" ? cleanText(effectRef.matchName, 512) : null;
        const occurrence = Number(effectRef.occurrence || 0);
        effect = this.effectIndex.entries.find((entry) => entry.type === type && entry.displayName === displayName &&
          entry.matchName === matchName && entry.occurrence === occurrence);
      }
      if (!effect) throw new QuickApplyAdapterError(REASON.EFFECT_NOT_FOUND);
      return effect;
    }

    async createEffectCandidate(effect, ref) {
      if (ref.mediaKind !== "unknown" && ref.mediaKind !== effect.type) {
        throw new QuickApplyAdapterError(REASON.MEDIA_TYPE_INCOMPATIBLE);
      }
      if (effect.type === "audio" && this.effectIndex &&
          this.effectIndex.entries.filter((entry) => entry.type === "audio" && entry.displayName === effect.displayName).length !== 1) {
        throw new QuickApplyAdapterError(REASON.AMBIGUOUS_AUDIO_DISPLAY_NAME, undefined, { displayName: effect.displayName });
      }
      let component;
      try {
        if (effect.type === "video") {
          const factory = this.api && this.api.VideoFilterFactory;
          if (!factory || typeof factory.createComponent !== "function") throw new QuickApplyAdapterError(REASON.EFFECT_FACTORY_UNAVAILABLE);
          component = await tracePremiereCall("VideoFilterFactory.createComponent", () => factory.createComponent(effect.matchName), { matchName: effect.matchName });
        } else {
          const factory = this.api && this.api.AudioFilterFactory;
          if (!factory || typeof factory.createComponentByDisplayName !== "function") throw new QuickApplyAdapterError(REASON.EFFECT_FACTORY_UNAVAILABLE);
          component = await tracePremiereCall("AudioFilterFactory.createComponentByDisplayName", () => factory.createComponentByDisplayName(effect.displayName, ref.item), { displayName: effect.displayName });
        }
      } catch (error) {
        throw adapterError(error, REASON.EFFECT_CREATION_FAILED);
      }
      if (!component) throw new QuickApplyAdapterError(REASON.EFFECT_CREATION_FAILED);
      let identity;
      if (effect.type === "video") {
        // Premiere 26.3 documents VideoFilterComponent as an opaque factory
        // token. Identity accessors exist only on the Component returned by a
        // committed chain readback, so planning uses the exact validated
        // match/display-name pair from the installed-host effect index. Final
        // success still requires both values and the occurrence to match the
        // post-commit chain readback below.
        identity = {
          matchName: effect.matchName,
          displayName: effect.displayName,
          provisional: true,
        };
      } else {
        try {
          identity = await readComponent(component, -1, new Map());
        } catch (error) {
          // Audio creation is display-name-only, so it keeps the stricter
          // pre-commit identity requirement.
          throw adapterError(error, REASON.COMPONENT_IDENTITY_UNAVAILABLE);
        }
      }
      if ((effect.type === "video" && identity.matchName !== effect.matchName) ||
          (effect.type === "audio" && identity.displayName !== effect.displayName)) {
        throw new QuickApplyAdapterError(REASON.COMPONENT_IDENTITY_UNAVAILABLE, undefined, {
          expectedMatchName: effect.matchName,
          actualMatchName: identity.matchName,
          expectedDisplayName: effect.displayName,
          actualDisplayName: identity.displayName,
        });
      }
      return { component, identity };
    }

    preflightAppendComponent(project, ref, component) {
      if (!project || typeof project.lockedAccess !== "function") {
        throw new QuickApplyAdapterError(REASON.PREMIERE_API_UNAVAILABLE);
      }
      if (!ref.chain || typeof ref.chain.createAppendComponentAction !== "function") {
        throw new QuickApplyAdapterError(REASON.COMPONENT_CHAIN_UNAVAILABLE);
      }
      let action = null;
      let callbackError = null;
      try {
        tracePremiereCall("Project.lockedAccess", () => project.lockedAccess(() => {
          try { action = tracePremiereCall("ComponentChain.createAppendComponentAction", () => ref.chain.createAppendComponentAction(component)); } catch (error) {
            callbackError = error;
            throw error;
          }
        }), { purpose: "quick-apply-preflight-component" });
      } catch (error) {
        throw adapterError(callbackError || error, REASON.MEDIA_TYPE_INCOMPATIBLE);
      }
      if (!action) throw new QuickApplyAdapterError(REASON.ACTION_CREATION_FAILED);
      return true;
    }

    preflightParameter(project, component, parameter) {
      if (!project || typeof project.lockedAccess !== "function") {
        throw new QuickApplyAdapterError(REASON.PREMIERE_API_UNAVAILABLE);
      }
      let callbackError = null;
      try {
        tracePremiereCall("Project.lockedAccess", () => project.lockedAccess(() => {
          try {
            if (!component || typeof component.getParamCount !== "function" || typeof component.getParam !== "function") {
              throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
            }
            const count = Number(tracePremiereCall("Component.getParamCount", () => component.getParamCount()));
            if (!Number.isInteger(count) || parameter.index < 0 || parameter.index >= count) {
              throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED, undefined, { paramIndex: parameter.index, paramCount: count });
            }
            const param = tracePremiereCall("Component.getParam", () => component.getParam(parameter.index), { index: parameter.index });
            if (!param || typeof param.createKeyframe !== "function" || typeof param.createSetValueAction !== "function") {
              throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED, undefined, { paramIndex: parameter.index });
            }
            if (typeof param.isTimeVarying === "function" && tracePremiereCall("Param.isTimeVarying", () => param.isTimeVarying(), { index: parameter.index }) === true) {
              throw new QuickApplyAdapterError(REASON.TIME_VARYING_PARAMETER_UNSUPPORTED, undefined, { paramIndex: parameter.index });
            }
            const keyframe = tracePremiereCall("Param.createKeyframe", () => param.createKeyframe(createHostParameterValue(this.api, parameter.value)), { index: parameter.index });
            const action = tracePremiereCall("Param.createSetValueAction", () => param.createSetValueAction(keyframe, true), { index: parameter.index });
            if (!action) throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
          } catch (error) {
            callbackError = error;
            throw error;
          }
        }), { purpose: "quick-apply-preflight-parameter", paramIndex: parameter.index });
      } catch (error) {
        throw adapterError(callbackError || error, REASON.PARAMETER_UNSUPPORTED, { paramIndex: parameter.index });
      }
    }

    async preflightOperation(effect, ref, options, plannedCounts, project) {
      const countKey = `${ref.publicItem.trackItemId}\u0000${effect.type}\u0000${effect.matchName || effect.displayName}`;
      const plannedBefore = plannedCounts.get(countKey) || 0;
      const candidate = await this.createEffectCandidate(effect, ref);
      this.preflightAppendComponent(project, ref, candidate.component);
      const existingCount = ref.components.filter((entry) => entry.matchName === candidate.identity.matchName).length;
      if (options.applyOnce && existingCount + plannedBefore > 0) {
        throw new QuickApplyAdapterError(REASON.DUPLICATE_PREVENTED);
      }
      for (const parameter of options.parameters || []) this.preflightParameter(project, candidate.component, parameter);
      const expectedOccurrence = existingCount + plannedBefore;
      plannedCounts.set(countKey, plannedBefore + 1);
      return {
        effect,
        ref,
        componentMatchName: candidate.identity.matchName,
        componentDisplayName: candidate.identity.displayName,
        expectedOccurrence,
        expectedFinalCount: existingCount + plannedBefore + 1,
        stepIndex: Number.isInteger(options.stepIndex) ? options.stepIndex : null,
        parameters: options.parameters || Object.freeze([]),
      };
    }

    skipFor(error, ref, effect, stepIndex = null) {
      const normalized = adapterError(error, REASON.MEDIA_TYPE_INCOMPATIBLE);
      return freezeSkip({
        trackItemId: ref && ref.publicItem.trackItemId,
        itemName: ref && ref.publicItem.display.name,
        stepIndex,
        effectId: effect && effect.effectId,
        effectName: effect && effect.displayName,
        code: normalized.code,
        message: normalized.message,
        mediaTypeIdentity: ref && ref.publicItem.mediaTypeIdentity,
        mediaKind: ref && ref.publicItem.mediaKind,
      });
    }

    issuePlan(kind, inspection, planCore, hostRecord) {
      this.planSequence += 1;
      const planToken = `oracle-quick-apply-plan:${this.now().toString(36)}:${this.planSequence.toString(36)}`;
      const plan = Object.freeze({ ...planCore, kind, version: 1, planToken });
      this.planRecords.set(planToken, { ...hostRecord, plan, selectionFingerprint: inspection.selectionFingerprint });
      while (this.planRecords.size > MAX_ISSUED_PLANS) {
        const oldest = this.planRecords.keys().next().value;
        this.planRecords.delete(oldest);
      }
      return plan;
    }

    async planEffectApplication(effectRef, options = {}) {
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      await this.ensureEffectIndex({ force: false });
      const effect = this.resolveEffect(effectRef);
      const inspection = await this.inspectHost();
      const refs = Array.from(inspection.refs.values());
      const targets = [];
      const skipped = [];
      const plannedCounts = new Map();
      for (const ref of refs) {
        try {
          targets.push(await this.preflightOperation(effect, ref, {
            applyOnce: options.applyOnce === true,
            parameters: Object.freeze([]),
          }, plannedCounts, inspection.project));
        } catch (error) { skipped.push(this.skipFor(error, ref, effect)); }
      }
      const executable = targets.length > 0;
      const capability = executable ? reason(REASON.OK) : reason(refs.length ? REASON.NO_COMPATIBLE_TARGETS :
        (inspection.snapshot.status && inspection.snapshot.status.code) || REASON.NO_SELECTION);
      const publicTargets = Object.freeze(targets.map((target) => Object.freeze({
        trackItemId: target.ref.publicItem.trackItemId,
        itemName: target.ref.publicItem.display.name,
        mediaKind: target.ref.publicItem.mediaKind,
        mediaTypeIdentity: target.ref.publicItem.mediaTypeIdentity,
        expectedComponent: Object.freeze({
          matchName: target.componentMatchName,
          displayName: target.componentDisplayName,
          occurrence: target.expectedOccurrence,
        }),
      })));
      return this.issuePlan("oracle-effect-application-plan", inspection, {
        executable,
        capability,
        projectGuid: inspection.snapshot.project && inspection.snapshot.project.guid,
        sequenceGuid: inspection.snapshot.sequence && inspection.snapshot.sequence.guid,
        undoString: cleanText(options.undoString, 128) || `Blocky Studios Quick Apply: ${effect.displayName}`,
        effect: effectPublicCopy(effect),
        applyOnce: options.applyOnce === true,
        targets: publicTargets,
        skipped: Object.freeze(skipped),
        targetCount: publicTargets.length,
        skippedCount: skipped.length,
      }, { inspection, targets, skipped, type: "effect" });
    }

    async planRecipeApplication(recipeValue, options = {}) {
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      await this.ensureEffectIndex({ force: false });
      const recipe = normalizeRecipe(recipeValue);
      if (recipe.compatibility.premiereMinVersion) {
        const comparison = compareNumericVersions(this.hostVersion, recipe.compatibility.premiereMinVersion);
        if (comparison === null) {
          throw new QuickApplyAdapterError(REASON.HOST_VERSION_UNAVAILABLE, undefined, {
            hostVersion: this.hostVersion,
            requiredPremiereVersion: recipe.compatibility.premiereMinVersion,
          });
        }
        if (comparison < 0) {
          throw new QuickApplyAdapterError(REASON.RECIPE_PREMIERE_VERSION_UNSUPPORTED, undefined, {
            hostVersion: this.hostVersion,
            requiredPremiereVersion: recipe.compatibility.premiereMinVersion,
          });
        }
      }
      if (recipe.compatibility.effectIndexVersion !== null) {
        const actualVersion = Number(this.effectIndex && this.effectIndex.version);
        if (!Number.isInteger(actualVersion)) {
          throw new QuickApplyAdapterError(REASON.EFFECT_INDEX_INVALID, undefined, {
            requiredEffectIndexVersion: recipe.compatibility.effectIndexVersion,
            actualEffectIndexVersion: this.effectIndex && this.effectIndex.version,
          });
        }
        if (actualVersion !== recipe.compatibility.effectIndexVersion) {
          throw new QuickApplyAdapterError(REASON.RECIPE_EFFECT_INDEX_VERSION_UNSUPPORTED, undefined, {
            requiredEffectIndexVersion: recipe.compatibility.effectIndexVersion,
            actualEffectIndexVersion: actualVersion,
          });
        }
      }
      const resolvedSteps = recipe.steps.map((step) => Object.freeze({ ...step, effect: this.resolveEffect(step.effectRef) }));
      const inspection = await this.inspectHost();
      const refs = Array.from(inspection.refs.values());
      const targets = [];
      const skipped = [];
      const plannedCounts = new Map();
      for (const step of resolvedSteps) {
        for (const ref of refs) {
          if (recipe.compatibility.mediaTypes.length > 0 && !recipe.compatibility.mediaTypes.includes(step.effect.type)) {
            skipped.push(this.skipFor(new QuickApplyAdapterError(REASON.MEDIA_TYPE_INCOMPATIBLE), ref, step.effect, step.stepIndex));
            continue;
          }
          try {
            targets.push(await this.preflightOperation(step.effect, ref, {
              applyOnce: step.applyOnce,
              parameters: step.parameters,
              stepIndex: step.stepIndex,
            }, plannedCounts, inspection.project));
          } catch (error) { skipped.push(this.skipFor(error, ref, step.effect, step.stepIndex)); }
        }
      }
      const executable = targets.length > 0;
      const capability = executable ? reason(REASON.OK) : reason(refs.length ? REASON.NO_COMPATIBLE_TARGETS :
        (inspection.snapshot.status && inspection.snapshot.status.code) || REASON.NO_SELECTION);
      const publicTargets = Object.freeze(targets.map((target) => Object.freeze({
        trackItemId: target.ref.publicItem.trackItemId,
        itemName: target.ref.publicItem.display.name,
        stepIndex: target.stepIndex,
        effect: effectPublicCopy(target.effect),
        expectedComponent: Object.freeze({
          matchName: target.componentMatchName,
          displayName: target.componentDisplayName,
          occurrence: target.expectedOccurrence,
        }),
        parameterCount: target.parameters.length,
      })));
      const hasParameters = targets.some((target) => target.parameters.length > 0);
      return this.issuePlan("oracle-recipe-application-plan", inspection, {
        executable,
        capability,
        projectGuid: inspection.snapshot.project && inspection.snapshot.project.guid,
        sequenceGuid: inspection.snapshot.sequence && inspection.snapshot.sequence.guid,
        undoString: cleanText(options.undoString, 128) || `Blocky Studios Recipe: ${recipe.name}`,
        parameterUndoString: cleanText(options.parameterUndoString, 128) || `Blocky Studios Recipe Parameters: ${recipe.name}`,
        recipe: Object.freeze({
          recipeId: recipe.recipeId,
          name: recipe.name,
          stepCount: recipe.steps.length,
          compatibility: recipe.compatibility,
        }),
        targets: publicTargets,
        skipped: Object.freeze(skipped),
        targetCount: publicTargets.length,
        skippedCount: skipped.length,
        hasParameters,
        atomicity: hasParameters ? "two-stage" : "single-transaction",
        fullRollbackSupported: false,
        partialFailureBoundary: hasParameters ? "component-stack-committed-before-parameter-values" : null,
      }, { inspection, targets, skipped, type: "recipe", recipe });
    }

    consumePlan(plan, expectedKind) {
      const token = cleanText(plan && plan.planToken, 256);
      const record = token && this.planRecords.get(token);
      if (!record || record.plan !== plan || plan.kind !== expectedKind || plan.version !== 1) {
        throw new QuickApplyAdapterError(REASON.INVALID_PLAN);
      }
      this.planRecords.delete(token);
      return record;
    }

    async validatePlanState(plan, record) {
      const current = await this.inspectHost();
      if (!current.project || !current.sequence || plan.projectGuid !== (current.snapshot.project && current.snapshot.project.guid) ||
          plan.sequenceGuid !== (current.snapshot.sequence && current.snapshot.sequence.guid) ||
          current.selectionFingerprint !== record.selectionFingerprint) {
        throw new QuickApplyAdapterError(REASON.STALE_PLAN);
      }
      for (const target of record.targets) {
        const currentRef = current.refs.get(target.ref.publicItem.trackItemId);
        if (!currentRef || currentRef.revision !== target.ref.revision) throw new QuickApplyAdapterError(REASON.STALE_PLAN);
      }
      return current;
    }

    async prepareExecutionTargets(current, plannedTargets) {
      const targets = [];
      for (const planned of plannedTargets) {
        const ref = current.refs.get(planned.ref.publicItem.trackItemId);
        if (!ref || ref.revision !== planned.ref.revision) throw new QuickApplyAdapterError(REASON.STALE_PLAN);
        const candidate = await this.createEffectCandidate(planned.effect, ref);
        if (candidate.identity.matchName !== planned.componentMatchName ||
            candidate.identity.displayName !== planned.componentDisplayName) {
          throw new QuickApplyAdapterError(REASON.COMPONENT_IDENTITY_UNAVAILABLE, undefined, {
            expectedMatchName: planned.componentMatchName,
            actualMatchName: candidate.identity.matchName,
            expectedDisplayName: planned.componentDisplayName,
            actualDisplayName: candidate.identity.displayName,
          });
        }
        targets.push({ ...planned, ref, component: candidate.component });
      }
      return targets;
    }

    appendActionFactory(target) {
      return () => {
        if (!target.ref.chain || typeof target.ref.chain.createAppendComponentAction !== "function") {
          throw new QuickApplyAdapterError(REASON.COMPONENT_CHAIN_UNAVAILABLE);
        }
        let action;
        try {
          action = tracePremiereCall("ComponentChain.createAppendComponentAction", () => target.ref.chain.createAppendComponentAction(target.component));
        } catch (error) {
          throw adapterError(error, REASON.MEDIA_TYPE_INCOMPATIBLE, {
            trackItemId: target.ref.publicItem.trackItemId,
            effectId: target.effect.effectId,
          });
        }
        if (!action) throw new QuickApplyAdapterError(REASON.ACTION_CREATION_FAILED);
        return action;
      };
    }

    executeLockedActions(project, undoString, actionFactories) {
      if (!project || typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
        throw new QuickApplyAdapterError(REASON.PREMIERE_API_UNAVAILABLE);
      }
      if (!Array.isArray(actionFactories) || actionFactories.length === 0) return false;
      let transactionCalled = false;
      let transactionResult = false;
      let callbackError = null;
      try {
        tracePremiereCall("Project.lockedAccess", () => project.lockedAccess(() => {
          try {
            const actions = actionFactories.map((createAction) => {
              if (typeof createAction !== "function") throw new QuickApplyAdapterError(REASON.ACTION_CREATION_FAILED);
              const action = createAction();
              if (!action) throw new QuickApplyAdapterError(REASON.ACTION_CREATION_FAILED);
              return action;
            });
            transactionCalled = true;
            transactionResult = tracePremiereCall("Project.executeTransaction", () => project.executeTransaction((compoundAction) => {
              if (!compoundAction || typeof compoundAction.addAction !== "function") {
                throw new QuickApplyAdapterError(REASON.ACTION_REJECTED);
              }
              for (const action of actions) {
                if (tracePremiereCall("CompoundAction.addAction", () => compoundAction.addAction(action)) !== true) {
                  throw new QuickApplyAdapterError(REASON.ACTION_REJECTED);
                }
              }
            }, undoString), { undoString });
          } catch (error) {
            callbackError = error;
            throw error;
          }
        }), { purpose: "quick-apply-transaction", undoString });
      } catch (error) {
        throw adapterError(callbackError || error, REASON.TRANSACTION_FAILED, { transactionCalled, transactionResult });
      }
      if (!transactionCalled || !transactionResult) {
        throw new QuickApplyAdapterError(REASON.TRANSACTION_FAILED, undefined, { transactionCalled, transactionResult });
      }
      return true;
    }

    async readbackComponents(current, targets) {
      const chainCache = new Map();
      const expectedFinalCounts = new Map();
      for (const target of targets) {
        const key = `${target.ref.publicItem.trackItemId}\u0000${target.componentMatchName}`;
        expectedFinalCounts.set(key, Math.max(expectedFinalCounts.get(key) || 0, target.expectedFinalCount));
      }
      for (const target of targets) {
        const trackItemId = target.ref.publicItem.trackItemId;
        if (!chainCache.has(trackItemId)) {
          const ref = current.refs.get(trackItemId);
          if (!ref) throw new QuickApplyAdapterError(REASON.COMPONENT_READBACK_FAILED);
          chainCache.set(trackItemId, await readComponentChain(ref.chain, this.limits.maxComponentsPerItem));
        }
      }
      for (const [key, expectedCount] of expectedFinalCounts) {
        const separator = key.indexOf("\u0000");
        const trackItemId = key.slice(0, separator);
        const matchName = key.slice(separator + 1);
        const actualCount = chainCache.get(trackItemId).filter((entry) => entry.matchName === matchName).length;
        if (actualCount !== expectedCount) {
          throw new QuickApplyAdapterError(REASON.COMPONENT_READBACK_FAILED, undefined, {
            trackItemId,
            matchName,
            expectedCount,
            actualCount,
          });
        }
      }
      return targets.map((target) => {
        const components = chainCache.get(target.ref.publicItem.trackItemId);
        const component = components.find((entry) => entry.matchName === target.componentMatchName &&
          entry.occurrence === target.expectedOccurrence && entry.displayName === target.componentDisplayName);
        if (!component) {
          throw new QuickApplyAdapterError(REASON.COMPONENT_READBACK_FAILED, undefined, {
            trackItemId: target.ref.publicItem.trackItemId,
            matchName: target.componentMatchName,
            occurrence: target.expectedOccurrence,
          });
        }
        return { target, component };
      });
    }

    receiptTargets(readback) {
      return Object.freeze(readback.map(({ target, component }) => Object.freeze({
        trackItemId: target.ref.publicItem.trackItemId,
        itemName: target.ref.publicItem.display.name,
        stepIndex: target.stepIndex,
        effect: effectPublicCopy(target.effect),
        component: Object.freeze({
          componentId: componentIdFor(target.ref.publicItem.trackItemId, component.matchName, component.occurrence),
          matchName: component.matchName,
          displayName: component.displayName,
          occurrence: component.occurrence,
          chainIndex: component.chainIndex,
        }),
        parameterCount: target.parameters.length,
      })));
    }

    async applyEffect(plan) {
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      const record = this.consumePlan(plan, "oracle-effect-application-plan");
      if (!plan.executable) {
        return Object.freeze({
          ok: false, verified: false, changed: false, committed: false, historyEligible: false,
          addedCount: 0, skippedCount: plan.skippedCount, targets: Object.freeze([]), skipped: plan.skipped,
          partialFailure: false, capability: plan.capability,
        });
      }
      const current = await this.validatePlanState(plan, record);
      const executionTargets = await this.prepareExecutionTargets(current, record.targets);
      this.executeLockedActions(current.project, plan.undoString, executionTargets.map((target) => this.appendActionFactory(target)));
      let readback;
      try {
        const readbackCurrent = await this.inspectHost();
        readback = await this.readbackComponents(readbackCurrent, executionTargets);
      } catch (error) {
        const normalized = adapterError(error, REASON.COMPONENT_READBACK_FAILED, { transactionCommitted: true });
        normalized.details.transactionCommitted = true;
        normalized.details.partialFailure = true;
        throw normalized;
      }
      const targets = this.receiptTargets(readback);
      const receipt = Object.freeze({
        ok: true,
        verified: true,
        changed: targets.length > 0,
        committed: targets.length > 0,
        historyEligible: targets.length > 0,
        addedCount: targets.length,
        skippedCount: plan.skippedCount,
        targets,
        skipped: plan.skipped,
        partialFailure: false,
        undoSteps: targets.length > 0 ? 1 : 0,
        capability: reason(REASON.OK),
      });
      if (this.shouldObserve()) this.requestRefresh("effect-apply-readback").catch(() => undefined);
      return receipt;
    }

    makePartialRecipeReceipt(plan, readback, error, stage, options = {}) {
      const normalized = adapterError(error, stage === "component-readback" ? REASON.COMPONENT_READBACK_FAILED : REASON.PARAMETER_READBACK_FAILED);
      const componentReadbackVerified = stage !== "component-readback";
      const parameterTransactionCommitted = options.parameterTransactionCommitted === true;
      const partialFailureBoundary = stage === "component-readback"
        ? "component-actions-committed-readback-unverified"
        : "component-stack-committed-before-parameter-values";
      return Object.freeze({
        ok: false,
        verified: false,
        changed: true,
        committed: true,
        historyEligible: false,
        addedCount: componentReadbackVerified ? readback.length : 0,
        addedCountVerified: componentReadbackVerified,
        committedComponentActionCount: plan.targetCount,
        skippedCount: plan.skippedCount,
        targets: this.receiptTargets(readback),
        skipped: plan.skipped,
        partialFailure: true,
        partialFailureBoundary,
        failedStage: stage,
        undoSteps: parameterTransactionCommitted ? 2 : 1,
        atomicity: plan.hasParameters ? "two-stage" : "single-transaction",
        fullRollbackSupported: false,
        error: publicError(normalized, normalized.code),
        capability: reason(REASON.PARTIAL_FAILURE),
      });
    }

    createParameterActionFactories(readback) {
      const actionFactories = [];
      const readbackRecords = [];
      for (const entry of readback) {
        const component = entry.component.component;
        for (const parameter of entry.target.parameters) {
          if (!component || typeof component.getParamCount !== "function" || typeof component.getParam !== "function") {
            throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
          }
          const count = Number(tracePremiereCall("Component.getParamCount", () => component.getParamCount()));
          if (parameter.index >= count) throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
          const param = tracePremiereCall("Component.getParam", () => component.getParam(parameter.index), { index: parameter.index });
          if (!param || typeof param.createKeyframe !== "function" || typeof param.createSetValueAction !== "function") {
            throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
          }
          if (typeof param.isTimeVarying === "function" && tracePremiereCall("Param.isTimeVarying", () => param.isTimeVarying(), { index: parameter.index }) === true) {
            throw new QuickApplyAdapterError(REASON.TIME_VARYING_PARAMETER_UNSUPPORTED);
          }
          actionFactories.push(() => {
            const keyframe = tracePremiereCall("Param.createKeyframe", () => param.createKeyframe(createHostParameterValue(this.api, parameter.value)), { index: parameter.index });
            const action = tracePremiereCall("Param.createSetValueAction", () => param.createSetValueAction(keyframe, true), { index: parameter.index });
            if (!action) throw new QuickApplyAdapterError(REASON.PARAMETER_UNSUPPORTED);
            return action;
          });
          readbackRecords.push({ param, parameter, target: entry.target });
        }
      }
      return { actionFactories, readbackRecords };
    }

    async verifyParameterReadback(records) {
      for (const record of records) {
        if (!record.param || typeof record.param.getStartValue !== "function") {
          throw new QuickApplyAdapterError(REASON.PARAMETER_READBACK_FAILED, undefined, { paramIndex: record.parameter.index });
        }
        const keyframe = await tracePremiereCall("Param.getStartValue", () => record.param.getStartValue(), { index: record.parameter.index });
        const actual = unwrapKeyframeValue(keyframe);
        if (parameterFingerprint(actual) !== record.parameter.valueFingerprint) {
          throw new QuickApplyAdapterError(REASON.PARAMETER_READBACK_FAILED, undefined, {
            paramIndex: record.parameter.index,
            expected: record.parameter.valueFingerprint,
            actual: parameterFingerprint(actual),
          });
        }
      }
    }

    async applyRecipe(plan) {
      if (this.destroyed) throw new QuickApplyAdapterError(REASON.ADAPTER_DESTROYED);
      const record = this.consumePlan(plan, "oracle-recipe-application-plan");
      if (!plan.executable) {
        return Object.freeze({
          ok: false, verified: false, changed: false, committed: false, historyEligible: false,
          addedCount: 0, skippedCount: plan.skippedCount, targets: Object.freeze([]), skipped: plan.skipped,
          partialFailure: false, capability: plan.capability,
        });
      }
      const current = await this.validatePlanState(plan, record);
      const executionTargets = await this.prepareExecutionTargets(current, record.targets);
      this.executeLockedActions(current.project, plan.undoString, executionTargets.map((target) => this.appendActionFactory(target)));
      let readback;
      try {
        const readbackCurrent = await this.inspectHost();
        readback = await this.readbackComponents(readbackCurrent, executionTargets);
      } catch (error) {
        return this.makePartialRecipeReceipt(plan, [], error, "component-readback");
      }
      let parameterStage = { actionFactories: [], readbackRecords: [] };
      if (plan.hasParameters) {
        try {
          parameterStage = this.createParameterActionFactories(readback);
        } catch (error) {
          return this.makePartialRecipeReceipt(plan, readback, error, "parameter-action-creation");
        }
        try {
          this.executeLockedActions(current.project, plan.parameterUndoString, parameterStage.actionFactories);
        } catch (error) {
          return this.makePartialRecipeReceipt(plan, readback, error, "parameter-transaction");
        }
        try {
          await this.verifyParameterReadback(parameterStage.readbackRecords);
        } catch (error) {
          return this.makePartialRecipeReceipt(plan, readback, error, "parameter-readback", {
            parameterTransactionCommitted: true,
          });
        }
      }
      const targets = this.receiptTargets(readback);
      const receipt = Object.freeze({
        ok: true,
        verified: true,
        changed: targets.length > 0,
        committed: targets.length > 0,
        historyEligible: targets.length > 0,
        addedCount: targets.length,
        skippedCount: plan.skippedCount,
        targets,
        skipped: plan.skipped,
        partialFailure: false,
        atomicity: plan.hasParameters ? "two-stage" : "single-transaction",
        fullRollbackSupported: false,
        partialFailureBoundary: plan.partialFailureBoundary,
        undoSteps: targets.length > 0 ? (plan.hasParameters ? 2 : 1) : 0,
        parameterActionCount: parameterStage.actionFactories.length,
        capability: reason(REASON.OK),
      });
      if (this.shouldObserve()) this.requestRefresh("recipe-apply-readback").catch(() => undefined);
      return receipt;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.observationGeneration += 1;
      this.clearObservationTimer();
      this.unbindSequenceEvents();
      if (this.document && typeof this.document.removeEventListener === "function") {
        this.document.removeEventListener("visibilitychange", this.documentListener);
      }
      this.refreshQueued = false;
      this.refreshReasons.clear();
      this.planRecords.clear();
      this.subscribers.clear();
    }
  }

  return Object.freeze({
    PremiereQuickApplyAdapter,
    QuickApplyAdapterError,
    REASON,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    MAX_SELECTED_TRACK_ITEMS,
    MAX_COMPONENTS_PER_ITEM,
    MAX_RECIPE_STEPS,
    MAX_PARAMETERS_PER_STEP,
    MAX_ISSUED_PLANS,
    tickText,
    parameterValueKind,
    parameterFingerprint,
    normalizeRecipe,
    trackItemIdFor,
    componentIdFor,
  });
});
