"use strict";

(function exposeOraclePremiereCurvesAdapter(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OraclePremiereCurvesAdapter", api);
})(typeof window !== "undefined" ? window : null, function createOraclePremiereCurvesAdapterApi() {
  const MIN_POLL_INTERVAL_MS = 100;
  const MAX_POLL_INTERVAL_MS = 250;
  const DEFAULT_MIN_POLL_INTERVAL_MS = 125;
  const DEFAULT_MAX_POLL_INTERVAL_MS = 250;
  const MAX_SELECTED_TRACK_ITEMS = 32;
  const MAX_TRACK_SCAN_TRACKS = 64;
  const MAX_TRACK_ITEMS_PER_TRACK = 2048;
  const MAX_PLAYHEAD_CANDIDATES = 16;
  const MAX_COMPONENTS_PER_ITEM = 64;
  const MAX_PARAMS_PER_COMPONENT = 256;
  const MAX_BAKED_KEYS_PER_BINDING = 240;
  const BAKED_RUNTIME_PROOF_VERSION = 1;
  const NATIVE_MODES = Object.freeze(["LINEAR", "HOLD", "BEZIER"]);
  const PARAMETER_NAMES = Object.freeze({
    "AE.ADBE Opacity": Object.freeze({ 0: "Opacity" }),
    "ADBE Opacity": Object.freeze({ 0: "Opacity" }),
    "AE.ADBE Motion": Object.freeze({
      0: "Position", 1: "Scale", 2: "Scale Width", 3: "Scale Height", 4: "Rotation",
      5: "Anchor Point", 7: "Crop Left", 8: "Crop Top", 9: "Crop Right", 10: "Crop Bottom",
    }),
    "ADBE Motion": Object.freeze({
      0: "Position", 1: "Scale", 2: "Scale Width", 3: "Scale Height", 4: "Rotation",
      5: "Anchor Point", 7: "Crop Left", 8: "Crop Top", 9: "Crop Right", 10: "Crop Bottom",
    }),
    "AE.ADBE Geometry2": Object.freeze({
      0: "Transform Anchor Point", 1: "Transform Position", 3: "Transform Scale", 5: "Transform Skew",
      6: "Transform Skew Axis", 7: "Transform Rotation", 8: "Transform Opacity", 10: "Transform Shutter Angle",
    }),
    "ADBE Geometry2": Object.freeze({
      0: "Transform Anchor Point", 1: "Transform Position", 3: "Transform Scale", 5: "Transform Skew",
      6: "Transform Skew Axis", 7: "Transform Rotation", 8: "Transform Opacity", 10: "Transform Shutter Angle",
    }),
    "AE.ADBE AECrop": Object.freeze({ 0: "Crop Left", 1: "Crop Top", 2: "Crop Right", 3: "Crop Bottom" }),
    "ADBE AECrop": Object.freeze({ 0: "Crop Left", 1: "Crop Top", 2: "Crop Right", 3: "Crop Bottom" }),
  });

  const REASON = Object.freeze({
    OK: "OK",
    ADAPTER_DESTROYED: "ADAPTER_DESTROYED",
    OBSERVATION_SUSPENDED: "OBSERVATION_SUSPENDED",
    PREMIERE_API_UNAVAILABLE: "PREMIERE_API_UNAVAILABLE",
    NO_ACTIVE_PROJECT: "NO_ACTIVE_PROJECT",
    NO_ACTIVE_SEQUENCE: "NO_ACTIVE_SEQUENCE",
    NO_SELECTION: "NO_SELECTION",
    NO_CLIP_AT_PLAYHEAD: "NO_CLIP_AT_PLAYHEAD",
    SELECTION_UNREADABLE: "SELECTION_UNREADABLE",
    SELECTION_LIMIT_EXCEEDED: "SELECTION_LIMIT_EXCEEDED",
    TRACK_ITEM_UNREADABLE: "TRACK_ITEM_UNREADABLE",
    COMPONENT_CHAIN_UNAVAILABLE: "COMPONENT_CHAIN_UNAVAILABLE",
    COMPONENT_IDENTITY_UNAVAILABLE: "COMPONENT_IDENTITY_UNAVAILABLE",
    PARAMETER_UNREADABLE: "PARAMETER_UNREADABLE",
    KEYFRAMES_UNSUPPORTED: "KEYFRAMES_UNSUPPORTED",
    NO_KEYFRAMES: "NO_KEYFRAMES",
    NO_BRACKETING_KEYS: "NO_BRACKETING_KEYS",
    INVALID_TICK_TIME: "INVALID_TICK_TIME",
    VALUE_KIND_UNSUPPORTED: "VALUE_KIND_UNSUPPORTED",
    UNPROVEN_TIME_BASIS: "UNPROVEN_TIME_BASIS",
    FRAME_QUANTIZATION_UNAVAILABLE: "FRAME_QUANTIZATION_UNAVAILABLE",
    INTERPOLATION_API_UNAVAILABLE: "INTERPOLATION_API_UNAVAILABLE",
    INTERPOLATION_MODE_UNAVAILABLE: "INTERPOLATION_MODE_UNAVAILABLE",
    INVALID_BINDING: "INVALID_BINDING",
    STALE_BINDING: "STALE_BINDING",
    INVALID_PLAN: "INVALID_PLAN",
    ACTION_CREATION_FAILED: "ACTION_CREATION_FAILED",
    ACTION_REJECTED: "ACTION_REJECTED",
    TRANSACTION_FAILED: "TRANSACTION_FAILED",
    ENDPOINT_READBACK_FAILED: "ENDPOINT_READBACK_FAILED",
    ENDPOINT_CHANGED: "ENDPOINT_CHANGED",
    INTERPOLATION_READBACK_MISMATCH: "INTERPOLATION_READBACK_MISMATCH",
    BAKED_RUNTIME_PROOF_REQUIRED: "BAKED_RUNTIME_PROOF_REQUIRED",
    CLEANUP_OWNERSHIP_REQUIRED: "CLEANUP_OWNERSHIP_REQUIRED",
    PRIOR_BAKE_REPLACEMENT_UNPROVEN: "PRIOR_BAKE_REPLACEMENT_UNPROVEN",
  });

  const REASON_MESSAGES = Object.freeze({
    [REASON.OK]: "Available.",
    [REASON.ADAPTER_DESTROYED]: "The Premiere Curves adapter has been destroyed.",
    [REASON.OBSERVATION_SUSPENDED]: "Curves observation is suspended while the workspace is hidden or inactive.",
    [REASON.PREMIERE_API_UNAVAILABLE]: "The required Premiere UXP API is unavailable.",
    [REASON.NO_ACTIVE_PROJECT]: "Open a Premiere project to use Curves.",
    [REASON.NO_ACTIVE_SEQUENCE]: "Open an active sequence to use Curves.",
    [REASON.NO_SELECTION]: "Select a timeline clip or place the playhead over one to inspect its keyframes.",
    [REASON.NO_CLIP_AT_PLAYHEAD]: "No video clip is selected or under the playhead.",
    [REASON.SELECTION_UNREADABLE]: "Premiere did not expose the active sequence selection.",
    [REASON.SELECTION_LIMIT_EXCEEDED]: "The timeline selection is too large to inspect safely.",
    [REASON.TRACK_ITEM_UNREADABLE]: "A selected timeline clip could not be inspected.",
    [REASON.COMPONENT_CHAIN_UNAVAILABLE]: "Premiere did not expose this clip's component chain.",
    [REASON.COMPONENT_IDENTITY_UNAVAILABLE]: "A component has no stable Premiere match name.",
    [REASON.PARAMETER_UNREADABLE]: "A component property could not be inspected.",
    [REASON.KEYFRAMES_UNSUPPORTED]: "This property does not support Premiere keyframes.",
    [REASON.NO_KEYFRAMES]: "This property has no keyframes.",
    [REASON.NO_BRACKETING_KEYS]: "The playhead is not between two usable keyframes.",
    [REASON.INVALID_TICK_TIME]: "Premiere returned an invalid exact TickTime value.",
    [REASON.VALUE_KIND_UNSUPPORTED]: "This value type is not supported by this Curves operation.",
    [REASON.UNPROVEN_TIME_BASIS]: "Curves Apply requires a forward 1x clip because Premiere does not expose a safe speed-remapped keyframe time-basis conversion.",
    [REASON.FRAME_QUANTIZATION_UNAVAILABLE]: "Premiere did not expose an exact integer ticks-per-frame value, so baked sampling is disabled.",
    [REASON.INTERPOLATION_API_UNAVAILABLE]: "Premiere does not expose the required interpolation action and readback APIs.",
    [REASON.INTERPOLATION_MODE_UNAVAILABLE]: "This Premiere interpolation mode is unavailable at runtime.",
    [REASON.INVALID_BINDING]: "The selected Curves property binding is invalid.",
    [REASON.STALE_BINDING]: "The selected clip, property, or keyframes changed. Refresh Curves and try again.",
    [REASON.INVALID_PLAN]: "The Curves operation plan is invalid or was modified.",
    [REASON.ACTION_CREATION_FAILED]: "Premiere could not create the interpolation action.",
    [REASON.ACTION_REJECTED]: "Premiere rejected an action before the transaction was committed.",
    [REASON.TRANSACTION_FAILED]: "Premiere did not commit the Curves operation.",
    [REASON.ENDPOINT_READBACK_FAILED]: "Premiere could not read back the endpoint keyframes after Apply.",
    [REASON.ENDPOINT_CHANGED]: "An endpoint time or value changed unexpectedly during Apply.",
    [REASON.INTERPOLATION_READBACK_MISMATCH]: "Premiere did not retain the requested interpolation mode.",
    [REASON.BAKED_RUNTIME_PROOF_REQUIRED]: "Baked Blocky Studios curves remain disabled until generated-key actions, interpolation, readback, and one-step Undo pass the runtime proof.",
    [REASON.CLEANUP_OWNERSHIP_REQUIRED]: "Blocky Studios cannot remove keys without an exact ownership receipt.",
    [REASON.PRIOR_BAKE_REPLACEMENT_UNPROVEN]: "A prior Blocky Studios-owned bake overlaps this property segment. Blocky Studios retained its exact receipt, but same-transaction remove-and-replace ordering is not physically proven in this Premiere runtime, so replacement is blocked without changing the project.",
  });

  class CurvesAdapterError extends Error {
    constructor(code, message, details = {}) {
      super(message || REASON_MESSAGES[code] || "Premiere Curves operation failed.");
      this.name = "CurvesAdapterError";
      this.code = code || REASON.PREMIERE_API_UNAVAILABLE;
      this.details = details && typeof details === "object" ? { ...details } : {};
    }
  }

  function cleanText(value, maximum = 1024) {
    return String(value ?? "").trim().slice(0, maximum);
  }

  function parameterDisplayName(componentMatchName, parameterIndex, hostDisplayName) {
    const hostName = cleanText(hostDisplayName, 512);
    if (hostName) return hostName;
    const names = PARAMETER_NAMES[componentMatchName];
    return names && names[parameterIndex] || `Property ${parameterIndex + 1}`;
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
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
    if ([REASON.PREMIERE_API_UNAVAILABLE, REASON.KEYFRAMES_UNSUPPORTED, REASON.INTERPOLATION_API_UNAVAILABLE].includes(code)) {
      return "unsupported";
    }
    if ([REASON.NO_ACTIVE_PROJECT, REASON.NO_ACTIVE_SEQUENCE, REASON.NO_SELECTION, REASON.NO_CLIP_AT_PLAYHEAD, REASON.NO_KEYFRAMES,
      REASON.NO_BRACKETING_KEYS, REASON.OBSERVATION_SUSPENDED].includes(code)) {
      return "empty";
    }
    return "error";
  }

  function guidText(value) {
    if (value === null || value === undefined) return "";
    try {
      return cleanText(typeof value.toString === "function" ? value.toString() : value, 256);
    } catch (error) {
      return "";
    }
  }

  function normalizeTickString(value) {
    const source = cleanText(value && typeof value === "object" ? value.ticks : value, 256);
    const match = /^([+-]?)(\d+)$/.exec(source);
    if (!match) return null;
    const digits = match[2].replace(/^0+(?=\d)/, "");
    if (/^0+$/.test(digits)) return "0";
    return match[1] === "-" ? `-${digits}` : digits;
  }

  function compareTickStrings(leftValue, rightValue) {
    const left = normalizeTickString(leftValue);
    const right = normalizeTickString(rightValue);
    if (left === null || right === null) {
      throw new CurvesAdapterError(REASON.INVALID_TICK_TIME, undefined, { left: leftValue, right: rightValue });
    }
    if (left === right) return 0;
    const leftNegative = left[0] === "-";
    const rightNegative = right[0] === "-";
    if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
    const leftDigits = leftNegative ? left.slice(1) : left;
    const rightDigits = rightNegative ? right.slice(1) : right;
    const magnitude = leftDigits.length === rightDigits.length
      ? (leftDigits < rightDigits ? -1 : 1)
      : (leftDigits.length < rightDigits.length ? -1 : 1);
    return leftNegative ? -magnitude : magnitude;
  }

  function sortedUniqueTickStrings(values) {
    const normalized = [];
    for (const value of Array.isArray(values) ? values : []) {
      const ticks = normalizeTickString(value);
      if (ticks === null) continue;
      normalized.push(ticks);
    }
    normalized.sort(compareTickStrings);
    return normalized.filter((ticks, index) => index === 0 || compareTickStrings(ticks, normalized[index - 1]) !== 0);
  }

  function tickParts(value) {
    const normalized = normalizeTickString(value);
    if (normalized === null) return null;
    return {
      negative: normalized[0] === "-",
      digits: normalized[0] === "-" ? normalized.slice(1) : normalized,
    };
  }

  function compareDigitMagnitudes(left, right) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function addDigitMagnitudes(left, right) {
    let carry = 0;
    let result = "";
    let leftIndex = left.length - 1;
    let rightIndex = right.length - 1;
    while (leftIndex >= 0 || rightIndex >= 0 || carry) {
      const sum = (leftIndex >= 0 ? Number(left[leftIndex--]) : 0) +
        (rightIndex >= 0 ? Number(right[rightIndex--]) : 0) + carry;
      result = String(sum % 10) + result;
      carry = Math.floor(sum / 10);
    }
    return result.replace(/^0+(?=\d)/, "");
  }

  function subtractDigitMagnitudes(larger, smaller) {
    let borrow = 0;
    let result = "";
    let largerIndex = larger.length - 1;
    let smallerIndex = smaller.length - 1;
    while (largerIndex >= 0) {
      let digit = Number(larger[largerIndex--]) - borrow -
        (smallerIndex >= 0 ? Number(smaller[smallerIndex--]) : 0);
      if (digit < 0) {
        digit += 10;
        borrow = 1;
      } else borrow = 0;
      result = String(digit) + result;
    }
    return result.replace(/^0+(?=\d)/, "");
  }

  function addTickStrings(leftValue, rightValue) {
    const left = tickParts(leftValue);
    const right = tickParts(rightValue);
    if (!left || !right) return null;
    if (left.negative === right.negative) {
      const digits = addDigitMagnitudes(left.digits, right.digits);
      return left.negative && digits !== "0" ? `-${digits}` : digits;
    }
    const comparison = compareDigitMagnitudes(left.digits, right.digits);
    if (comparison === 0) return "0";
    const larger = comparison > 0 ? left : right;
    const smaller = comparison > 0 ? right : left;
    const digits = subtractDigitMagnitudes(larger.digits, smaller.digits);
    return larger.negative && digits !== "0" ? `-${digits}` : digits;
  }

  function subtractTickStrings(leftValue, rightValue) {
    const right = normalizeTickString(rightValue);
    if (right === null) return null;
    return addTickStrings(leftValue, right === "0" ? "0" : right[0] === "-" ? right.slice(1) : `-${right}`);
  }

  function mediaPlayheadTicks(trackDescriptor, sequencePlayheadValue) {
    const sequenceTicks = normalizeTickString(sequencePlayheadValue);
    if (sequenceTicks === null) return null;
    if (!trackDescriptor || trackDescriptor.timeBasisProven !== true) return sequenceTicks;
    const elapsed = subtractTickStrings(sequenceTicks, trackDescriptor.startTicks);
    return elapsed === null ? null : addTickStrings(trackDescriptor.inPointTicks, elapsed);
  }

  function exactPositiveIntegerString(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? String(number) : null;
  }

  function tickModulo(tickValue, divisorValue) {
    const ticks = normalizeTickString(tickValue);
    const divisorText = exactPositiveIntegerString(divisorValue);
    if (ticks === null || divisorText === null) return null;
    const divisor = Number(divisorText);
    const digits = ticks[0] === "-" ? ticks.slice(1) : ticks;
    let remainder = 0;
    for (let index = 0; index < digits.length; index += 1) {
      remainder = (remainder * 10 + Number(digits[index])) % divisor;
    }
    return remainder;
  }

  // Exactly on a key, Curves prefers the segment beginning at that key. At the
  // final key it deterministically falls back to the segment ending there.
  // A property with exactly two keys has only one possible segment, so it stays
  // actionable even when a selected clip's playhead is outside those keys.
  // Requiring a bracket in that case only disables Apply without resolving any
  // ambiguity (and is especially surprising when the clip was selected in the
  // Effect Controls panel).
  function bracketTickTimes(values, playheadValue) {
    const keyTicks = sortedUniqueTickStrings(values);
    const playheadTicks = normalizeTickString(playheadValue);
    if (playheadTicks === null) {
      return Object.freeze({
        state: "invalid-playhead",
        hasSegment: false,
        exact: false,
        playheadTicks: null,
        startTicks: null,
        endTicks: null,
        keyTicks,
      });
    }
    if (keyTicks.length === 0) {
      return Object.freeze({
        state: "empty",
        hasSegment: false,
        exact: false,
        playheadTicks,
        startTicks: null,
        endTicks: null,
        keyTicks,
      });
    }

    let insertionIndex = 0;
    while (insertionIndex < keyTicks.length && compareTickStrings(keyTicks[insertionIndex], playheadTicks) < 0) {
      insertionIndex += 1;
    }
    const exact = insertionIndex < keyTicks.length && compareTickStrings(keyTicks[insertionIndex], playheadTicks) === 0;
    if (exact) {
      if (insertionIndex < keyTicks.length - 1) {
        return Object.freeze({
          state: "on-key-forward",
          hasSegment: true,
          exact: true,
          playheadTicks,
          atKeyTicks: keyTicks[insertionIndex],
          startTicks: keyTicks[insertionIndex],
          endTicks: keyTicks[insertionIndex + 1],
          keyTicks,
        });
      }
      if (insertionIndex > 0) {
        return Object.freeze({
          state: "on-key-backward",
          hasSegment: true,
          exact: true,
          playheadTicks,
          atKeyTicks: keyTicks[insertionIndex],
          startTicks: keyTicks[insertionIndex - 1],
          endTicks: keyTicks[insertionIndex],
          keyTicks,
        });
      }
      return Object.freeze({
        state: "single-key",
        hasSegment: false,
        exact: true,
        playheadTicks,
        atKeyTicks: keyTicks[0],
        startTicks: keyTicks[0],
        endTicks: keyTicks[0],
        keyTicks,
      });
    }
    if (insertionIndex === 0) {
      if (keyTicks.length === 2) {
        return Object.freeze({
          state: "only-segment-before",
          hasSegment: true,
          exact: false,
          playheadTicks,
          startTicks: keyTicks[0],
          endTicks: keyTicks[1],
          keyTicks,
        });
      }
      return Object.freeze({
        state: "before-first",
        hasSegment: false,
        exact: false,
        playheadTicks,
        startTicks: null,
        endTicks: keyTicks[0],
        keyTicks,
      });
    }
    if (insertionIndex === keyTicks.length) {
      if (keyTicks.length === 2) {
        return Object.freeze({
          state: "only-segment-after",
          hasSegment: true,
          exact: false,
          playheadTicks,
          startTicks: keyTicks[0],
          endTicks: keyTicks[1],
          keyTicks,
        });
      }
      return Object.freeze({
        state: "after-last",
        hasSegment: false,
        exact: false,
        playheadTicks,
        startTicks: keyTicks[keyTicks.length - 1],
        endTicks: null,
        keyTicks,
      });
    }
    return Object.freeze({
      state: "between",
      hasSegment: true,
      exact: false,
      playheadTicks,
      startTicks: keyTicks[insertionIndex - 1],
      endTicks: keyTicks[insertionIndex],
      keyTicks,
    });
  }

  function unwrapKeyframeValue(keyframe) {
    if (!keyframe || typeof keyframe !== "object") return undefined;
    const wrapper = keyframe.value;
    if (wrapper && typeof wrapper === "object" && Object.prototype.hasOwnProperty.call(wrapper, "value")) {
      return wrapper.value;
    }
    return wrapper;
  }

  function valueKind(value) {
    if (typeof value === "number" && Number.isFinite(value)) return "number";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (value && typeof value === "object") {
      if (Array.isArray(value) && value.length === 2 && value.every((entry) => Number.isFinite(Number(entry)))) return "pointf";
      if (Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) return "pointf";
      if (["red", "green", "blue", "alpha"].every((key) => Number.isFinite(Number(value[key])))) return "color";
    }
    return "unknown";
  }

  function cloneValue(value) {
    const kind = valueKind(value);
    if (kind === "pointf") return Object.freeze({
      x: Number(Array.isArray(value) ? value[0] : value.x),
      y: Number(Array.isArray(value) ? value[1] : value.y),
    });
    if (kind === "color") {
      return Object.freeze({
        red: Number(value.red),
        green: Number(value.green),
        blue: Number(value.blue),
        alpha: Number(value.alpha),
      });
    }
    if (["number", "string", "boolean"].includes(kind)) return value;
    return null;
  }

  function valueFingerprint(value) {
    const kind = valueKind(value);
    if (kind === "number") return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
    if (kind === "string") return `string:${JSON.stringify(value)}`;
    if (kind === "boolean") return `boolean:${value ? "1" : "0"}`;
    if (kind === "pointf") {
      return `pointf:${Number(Array.isArray(value) ? value[0] : value.x)},${Number(Array.isArray(value) ? value[1] : value.y)}`;
    }
    if (kind === "color") return `color:${Number(value.red)},${Number(value.green)},${Number(value.blue)},${Number(value.alpha)}`;
    return "unknown";
  }

  function stableIdentityKey(identity) {
    if (!identity || typeof identity !== "object") return "";
    const track = identity.track || {};
    const component = identity.component || {};
    const parameter = identity.parameter || {};
    return JSON.stringify([
      cleanText(identity.projectGuid, 256),
      cleanText(identity.sequenceGuid, 256),
      cleanText(identity.sequenceTiming && identity.sequenceTiming.ticksPerFrame, 256),
      Number(identity.sequenceTiming && identity.sequenceTiming.frameRate),
      cleanText(track.mediaType, 256),
      Number(track.trackIndex),
      cleanText(track.startTicks, 256),
      cleanText(track.endTicks, 256),
      cleanText(track.inPointTicks, 256),
      cleanText(track.outPointTicks, 256),
      cleanText(track.durationTicks, 256),
      Number(track.speed),
      Boolean(track.reversed),
      cleanText(track.projectItemId, 256),
      cleanText(track.matchName, 512),
      Number(track.type),
      cleanText(component.matchName, 512),
      Number(component.occurrence),
      Number(parameter.index),
      cleanText(parameter.valueKind, 32),
    ]);
  }

  function bindingIdForIdentity(identity) {
    return `oracle-curve-binding:${encodeURIComponent(stableIdentityKey(identity))}`;
  }

  function interpolationModeValue(api, modeName) {
    const name = cleanText(modeName, 32).toUpperCase();
    if (!NATIVE_MODES.includes(name)) return null;
    const enumValue = api && api.Constants && api.Constants.InterpolationMode
      ? api.Constants.InterpolationMode[name]
      : undefined;
    if (typeof enumValue === "number" && Number.isFinite(enumValue)) return enumValue;
    const staticValue = api && api.Keyframe ? api.Keyframe[`INTERPOLATION_MODE_${name}`] : undefined;
    return typeof staticValue === "number" && Number.isFinite(staticValue) ? staticValue : null;
  }

  function availableNativeModes(api) {
    const modes = {};
    for (const name of NATIVE_MODES) {
      const value = interpolationModeValue(api, name);
      modes[name] = Object.freeze(value === null
        ? { ...reason(REASON.INTERPOLATION_MODE_UNAVAILABLE), name, value: null }
        : { ...reason(REASON.OK), name, value });
    }
    return Object.freeze(modes);
  }

  function validateBakedRuntimeProof(api, proof) {
    const requiredFlags = [
      "detachedKeyframes",
      "generatedKeyActions",
      "defaultLinearReadback",
      "exactEndpointReadback",
      "oneTransaction",
      "oneUndoStep",
      "undoRemovedGeneratedKeys",
    ];
    const linearMode = interpolationModeValue(api, "LINEAR");
    const valueKinds = Array.isArray(proof && proof.valueKinds)
      ? Array.from(new Set(proof.valueKinds.map((entry) => cleanText(entry, 32).toLowerCase())))
          .filter((entry) => entry === "number")
      : [];
    const valid = Boolean(
      proof && proof.version === BAKED_RUNTIME_PROOF_VERSION && proof.verified === true &&
      requiredFlags.every((flag) => proof[flag] === true) &&
      typeof proof.defaultLinearInterpolationMode === "number" &&
      proof.defaultLinearInterpolationMode === linearMode &&
      valueKinds.includes("number") &&
      api && api.TickTime && typeof api.TickTime.createWithTicks === "function",
    );
    if (!valid) return null;
    return Object.freeze({
      version: BAKED_RUNTIME_PROOF_VERSION,
      enabled: true,
      verified: true,
      readbackVerified: true,
      oneUndoStep: true,
      ownershipSafe: true,
      hostVersion: cleanText(proof.hostVersion, 64),
      verifiedAt: cleanText(proof.verifiedAt, 64),
      source: cleanText(proof.source, 128) || "premiere-runtime-probe",
      defaultLinearInterpolationMode: linearMode,
      valueKinds: Object.freeze(valueKinds),
      ...Object.fromEntries(requiredFlags.map((flag) => [flag, true])),
    });
  }

  function snapshotRevision(binding) {
    const bracket = binding && binding.bracket || {};
    const start = binding && binding.endpoints && binding.endpoints.start || {};
    const end = binding && binding.endpoints && binding.endpoints.end || {};
    return JSON.stringify([
      binding && binding.bindingId,
      binding && binding.keyTicks || [],
      bracket.startTicks || null,
      bracket.endTicks || null,
      start.valueFingerprint || null,
      start.interpolationMode ?? null,
      end.valueFingerprint || null,
      end.interpolationMode ?? null,
    ]);
  }

  function freezeEndpoint(endpoint) {
    if (!endpoint) return null;
    return Object.freeze({
      ticks: endpoint.ticks,
      valueKind: endpoint.valueKind,
      value: cloneValue(endpoint.value),
      valueFingerprint: endpoint.valueFingerprint,
      interpolationMode: endpoint.interpolationMode,
    });
  }

  function cloneIdentity(identity) {
    return Object.freeze({
      projectGuid: identity.projectGuid,
      sequenceGuid: identity.sequenceGuid,
      sequenceTiming: Object.freeze({ ...identity.sequenceTiming }),
      track: Object.freeze({ ...identity.track }),
      component: Object.freeze({ ...identity.component }),
      parameter: Object.freeze({ ...identity.parameter }),
    });
  }

  function adapterError(error, fallbackCode, details = {}) {
    if (error instanceof CurvesAdapterError) return error;
    return new CurvesAdapterError(
      cleanText(error && error.code, 128) || fallbackCode,
      cleanText(error && error.message, 1024) || REASON_MESSAGES[fallbackCode],
      details,
    );
  }

  async function readTrackDescriptor(api, item) {
    const required = ["getComponentChain", "getTrackIndex", "getStartTime", "getEndTime", "getMediaType"];
    if (!item || !required.every((name) => typeof item[name] === "function")) {
      throw new CurvesAdapterError(REASON.TRACK_ITEM_UNREADABLE);
    }
    const [trackIndex, start, end, inPoint, outPoint, duration, speed, reversed, mediaType, projectItem, matchName, name, type] = await Promise.all([
      item.getTrackIndex(),
      item.getStartTime(),
      item.getEndTime(),
      typeof item.getInPoint === "function" ? item.getInPoint() : null,
      typeof item.getOutPoint === "function" ? item.getOutPoint() : null,
      typeof item.getDuration === "function" ? item.getDuration() : null,
      typeof item.getSpeed === "function" ? item.getSpeed() : Number.NaN,
      typeof item.isSpeedReversed === "function" ? item.isSpeedReversed() : true,
      item.getMediaType(),
      typeof item.getProjectItem === "function" ? item.getProjectItem() : null,
      typeof item.getMatchName === "function" ? item.getMatchName() : "",
      typeof item.getName === "function" ? item.getName() : "",
      typeof item.getType === "function" ? item.getType() : -1,
    ]);
    const startTicks = normalizeTickString(start);
    const endTicks = normalizeTickString(end);
    const inPointTicks = normalizeTickString(inPoint);
    const outPointTicks = normalizeTickString(outPoint);
    const durationTicks = normalizeTickString(duration);
    if (startTicks === null || endTicks === null) throw new CurvesAdapterError(REASON.INVALID_TICK_TIME);
    let projectItemId = "";
    try {
      if (projectItem && typeof projectItem.getId === "function") projectItemId = cleanText(projectItem.getId(), 256);
      if (!projectItemId && api && api.UniqueSerializeable && typeof api.UniqueSerializeable.cast === "function") {
        const serializable = api.UniqueSerializeable.cast(projectItem);
        if (serializable && typeof serializable.getUniqueID === "function") {
          projectItemId = guidText(serializable.getUniqueID());
        }
      }
    } catch (error) {
      projectItemId = "";
    }
    return {
      item,
      chain: await item.getComponentChain(),
      descriptor: Object.freeze({
        mediaType: guidText(mediaType),
        trackIndex: Number(trackIndex),
        startTicks,
        endTicks,
        inPointTicks,
        outPointTicks,
        durationTicks,
        speed: Number(speed),
        reversed: reversed === true || Number(reversed) !== 0,
        // Premiere reports track-item bounds in sequence time and component
        // keyframes in the clip/project-item time domain. A forward 1x item
        // can therefore be mapped exactly as inPoint + (playhead - start),
        // including ordinary trims and non-zero timeline starts.
        timeBasisProven: inPointTicks !== null && Number(speed) === 1 &&
          !(reversed === true || Number(reversed) !== 0),
        projectItemId,
        matchName: cleanText(matchName, 512),
        type: Number(type),
      }),
      display: Object.freeze({ name: cleanText(name, 512) || "Timeline clip" }),
    };
  }

  async function readEndpoint(param, timeRecord) {
    if (!timeRecord || !timeRecord.raw || typeof param.getKeyframePtr !== "function") {
      throw new CurvesAdapterError(REASON.ENDPOINT_READBACK_FAILED);
    }
    const keyframe = param.getKeyframePtr(timeRecord.raw);
    if (!keyframe || typeof keyframe !== "object") {
      throw new CurvesAdapterError(REASON.ENDPOINT_READBACK_FAILED, undefined, { ticks: timeRecord.ticks });
    }
    const value = unwrapKeyframeValue(keyframe);
    let interpolationMode = null;
    if (typeof keyframe.getTemporalInterpolationMode === "function") {
      interpolationMode = await keyframe.getTemporalInterpolationMode();
      if (typeof interpolationMode !== "number" || !Number.isFinite(interpolationMode)) interpolationMode = null;
    }
    return {
      keyframe,
      ticks: timeRecord.ticks,
      value,
      valueKind: valueKind(value),
      valueFingerprint: valueFingerprint(value),
      interpolationMode,
      seconds: Number.isFinite(Number(timeRecord.raw.seconds)) ? Number(timeRecord.raw.seconds) : null,
    };
  }

  function publicBinding(hostBinding, nativeModes, bakedRuntimeProof) {
    const endpoints = hostBinding.endpoints;
    const hasNativeRuntime = Boolean(
      hostBinding.bracket.hasSegment &&
      endpoints && endpoints.start && endpoints.end &&
      typeof hostBinding.param.createSetInterpolationAtKeyframeAction === "function" &&
      endpoints.start.interpolationMode !== null &&
      endpoints.end.interpolationMode !== null &&
      Object.values(nativeModes).some((entry) => entry.supported),
    );
    const nativeCapability = hostBinding.identity.track.timeBasisProven !== true
      ? reason(REASON.UNPROVEN_TIME_BASIS)
      : !hostBinding.bracket.hasSegment
      ? reason(REASON.NO_BRACKETING_KEYS)
      : hasNativeRuntime
        ? reason(REASON.OK)
        : reason(REASON.INTERPOLATION_API_UNAVAILABLE);
    const bakedKindSupported = endpoints && endpoints.start && endpoints.end &&
      endpoints.start.valueKind === endpoints.end.valueKind &&
      endpoints.start.valueKind === "number";
    const frameQuantizationProven = exactPositiveIntegerString(hostBinding.identity.sequenceTiming.ticksPerFrame) !== null;
    const bakedKindProven = hostBinding.identity.track.timeBasisProven === true && frameQuantizationProven &&
      bakedKindSupported && bakedRuntimeProof &&
      bakedRuntimeProof.valueKinds.includes(endpoints.start.valueKind);
    const bakedCapability = bakedKindProven
      ? reason(REASON.OK, { valueKindSupported: true, runtimeProofVersion: bakedRuntimeProof.version })
      : hostBinding.identity.track.timeBasisProven !== true
        ? reason(REASON.UNPROVEN_TIME_BASIS, { valueKindSupported: bakedKindSupported })
        : !frameQuantizationProven
          ? reason(REASON.FRAME_QUANTIZATION_UNAVAILABLE, { valueKindSupported: bakedKindSupported })
        : bakedKindSupported
        ? reason(REASON.BAKED_RUNTIME_PROOF_REQUIRED, { valueKindSupported: true })
        : reason(REASON.VALUE_KIND_UNSUPPORTED, { valueKindSupported: false });
    const identity = cloneIdentity(hostBinding.identity);
    const bindingId = hostBinding.bindingId;
    const supportedInterpolations = Object.freeze(
      Object.values(nativeModes).filter((entry) => entry.supported).map((entry) => entry.name),
    );
    const publicStart = freezeEndpoint(endpoints && endpoints.start);
    const publicEnd = freezeEndpoint(endpoints && endpoints.end);
    const binding = {
      bindingId: hostBinding.bindingId,
      id: bindingId,
      identity,
      display: Object.freeze({ ...hostBinding.display }),
      detectionSource: hostBinding.detectionSource === "playhead" ? "playhead" : "selection",
      autoDetected: hostBinding.detectionSource === "playhead",
      keyTicks: Object.freeze(hostBinding.timeRecords.map((entry) => entry.ticks)),
      keyCount: hostBinding.timeRecords.length,
      bracket: Object.freeze({ ...hostBinding.bracket, keyTicks: Object.freeze([...hostBinding.bracket.keyTicks]) }),
      endpoints: Object.freeze({
        start: publicStart,
        end: publicEnd,
      }),
      capabilities: Object.freeze({
        nativeInterpolation: nativeCapability,
        bakedCurve: bakedCapability,
      }),
      clipId: JSON.stringify(identity.track),
      clipName: hostBinding.display.clip,
      componentId: `${identity.component.matchName}#${identity.component.occurrence}`,
      componentName: hostBinding.display.component,
      propertyId: `${identity.component.matchName}#${identity.component.occurrence}:param:${identity.parameter.index}:${identity.parameter.valueKind}`,
      propertyName: hostBinding.display.property,
      valueType: identity.parameter.valueKind,
      sequenceFrameRate: identity.sequenceTiming.frameRate,
      ticksPerFrame: identity.sequenceTiming.ticksPerFrame,
      compatible: nativeCapability.supported,
      reason: nativeCapability.supported ? null : nativeCapability,
      start: publicStart ? Object.freeze({
        tick: publicStart.ticks,
        ticks: publicStart.ticks,
        timeSeconds: endpoints.start.seconds,
        value: publicStart.value,
        interpolation: publicStart.interpolationMode,
      }) : null,
      end: publicEnd ? Object.freeze({
        tick: publicEnd.ticks,
        ticks: publicEnd.ticks,
        timeSeconds: endpoints.end.seconds,
        value: publicEnd.value,
        interpolation: publicEnd.interpolationMode,
      }) : null,
      interpolation: publicStart && publicStart.interpolationMode,
      supportedInterpolations,
    };
    binding.revision = snapshotRevision(binding);
    return Object.freeze(binding);
  }

  async function inspectTrackItem(api, context, item, nativeModes, bakedRuntimeProof, limits, detectionSource = "selection") {
    const track = await readTrackDescriptor(api, item);
    const chain = track.chain;
    if (!chain || typeof chain.getComponentCount !== "function" || typeof chain.getComponentAtIndex !== "function") {
      throw new CurvesAdapterError(REASON.COMPONENT_CHAIN_UNAVAILABLE);
    }
    const componentCount = Number(chain.getComponentCount());
    if (!Number.isInteger(componentCount) || componentCount < 0 || componentCount > limits.maxComponentsPerItem) {
      throw new CurvesAdapterError(REASON.COMPONENT_CHAIN_UNAVAILABLE, undefined, { componentCount });
    }
    const occurrences = new Map();
    const bindings = [];
    const issues = [];
    const trackPlayheadTicks = mediaPlayheadTicks(track.descriptor, context.playheadTicks);
    if (trackPlayheadTicks === null) throw new CurvesAdapterError(REASON.INVALID_TICK_TIME);
    for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
      try {
        const component = chain.getComponentAtIndex(componentIndex);
        if (!component || typeof component.getMatchName !== "function" || typeof component.getParamCount !== "function") {
          throw new CurvesAdapterError(REASON.COMPONENT_IDENTITY_UNAVAILABLE);
        }
        const [rawMatchName, rawDisplayName] = await Promise.all([
          component.getMatchName(),
          typeof component.getDisplayName === "function" ? component.getDisplayName() : "",
        ]);
        const matchName = cleanText(rawMatchName, 512);
        if (!matchName) throw new CurvesAdapterError(REASON.COMPONENT_IDENTITY_UNAVAILABLE);
        const occurrence = occurrences.get(matchName) || 0;
        occurrences.set(matchName, occurrence + 1);
        const paramCount = Number(component.getParamCount());
        if (!Number.isInteger(paramCount) || paramCount < 0 || paramCount > limits.maxParamsPerComponent) {
          throw new CurvesAdapterError(REASON.PARAMETER_UNREADABLE, undefined, { paramCount });
        }
        for (let paramIndex = 0; paramIndex < paramCount; paramIndex += 1) {
          try {
            const param = component.getParam(paramIndex);
            if (!param || typeof param.areKeyframesSupported !== "function" || typeof param.getKeyframeListAsTickTimes !== "function") {
              throw new CurvesAdapterError(REASON.PARAMETER_UNREADABLE);
            }
            if (await param.areKeyframesSupported() !== true) continue;
            const rawTimes = param.getKeyframeListAsTickTimes();
            const byTicks = new Map();
            let timeList = [];
            try { timeList = Array.isArray(rawTimes) ? rawTimes : rawTimes ? Array.from(rawTimes) : []; }
            catch (error) { timeList = []; }
            for (const raw of timeList) {
              const ticks = normalizeTickString(raw);
              if (ticks !== null && !byTicks.has(ticks)) byTicks.set(ticks, { ticks, raw });
            }
            const timeRecords = Array.from(byTicks.values()).sort((left, right) => compareTickStrings(left.ticks, right.ticks));
            if (timeRecords.length < 2) continue;
            const bracket = bracketTickTimes(timeRecords.map((entry) => entry.ticks), trackPlayheadTicks);
            const startTime = bracket.startTicks ? byTicks.get(bracket.startTicks) : null;
            const endTime = bracket.endTicks ? byTicks.get(bracket.endTicks) : null;
            let start = null;
            let end = null;
            if (bracket.hasSegment && startTime && endTime) {
              [start, end] = await Promise.all([readEndpoint(param, startTime), readEndpoint(param, endTime)]);
            }
            let inferredKind = start && start.valueKind || end && end.valueKind || "unknown";
            if (inferredKind === "unknown" && typeof param.getValueAtTime === "function" && context.playhead) {
              try { inferredKind = valueKind(await param.getValueAtTime(context.playhead)); } catch (error) { /* display-only inference */ }
            }
            const identity = {
              projectGuid: context.projectGuid,
              sequenceGuid: context.sequenceGuid,
              sequenceTiming: Object.freeze({
                frameRate: context.frameRate,
                ticksPerFrame: context.ticksPerFrame,
              }),
              track: track.descriptor,
              component: Object.freeze({ matchName, occurrence }),
              parameter: Object.freeze({ index: paramIndex, valueKind: inferredKind }),
            };
            const bindingId = bindingIdForIdentity(identity);
            bindings.push({
              bindingId,
              identity,
              item,
              chain,
              component,
              param,
              timeRecords,
              bracket,
              detectionSource,
              endpoints: { start, end },
              display: {
                clip: track.display.name,
                component: cleanText(rawDisplayName, 512) || matchName,
                property: parameterDisplayName(matchName, paramIndex, param.displayName),
                componentMatchName: matchName,
                componentOccurrence: occurrence,
                parameterIndex: paramIndex,
                valueKind: inferredKind,
              },
            });
          } catch (error) {
            const normalized = adapterError(error, REASON.PARAMETER_UNREADABLE, { componentIndex, paramIndex });
            issues.push(Object.freeze({ code: normalized.code, message: normalized.message, componentIndex, paramIndex }));
          }
        }
      } catch (error) {
        const normalized = adapterError(error, REASON.COMPONENT_IDENTITY_UNAVAILABLE, { componentIndex });
        issues.push(Object.freeze({ code: normalized.code, message: normalized.message, componentIndex }));
      }
    }
    return {
      descriptor: track.descriptor,
      display: track.display,
      bindings,
      issues,
      publicBindings: bindings.map((entry) => publicBinding(entry, nativeModes, bakedRuntimeProof)),
    };
  }

  function trackItemTypeClip(api) {
    const value = api && api.Constants && api.Constants.TrackItemType
      ? api.Constants.TrackItemType.CLIP
      : null;
    return typeof value === "number" && Number.isFinite(value) ? value : 1;
  }

  async function clipsAtPlayhead(api, sequence, playheadTicks, limits) {
    if (!sequence || typeof sequence.getVideoTrackCount !== "function" || typeof sequence.getVideoTrack !== "function") return [];
    const rawTrackCount = Number(await sequence.getVideoTrackCount());
    if (!Number.isInteger(rawTrackCount) || rawTrackCount <= 0) return [];
    const firstTrack = Math.max(0, rawTrackCount - limits.maxTrackScanTracks);
    const candidates = [];
    const clipType = trackItemTypeClip(api);
    for (let trackIndex = rawTrackCount - 1; trackIndex >= firstTrack; trackIndex -= 1) {
      let track;
      try { track = await sequence.getVideoTrack(trackIndex); } catch (error) { continue; }
      if (!track || typeof track.getTrackItems !== "function") continue;
      let rawItems;
      try { rawItems = await track.getTrackItems(clipType, false); } catch (error) { continue; }
      let items = [];
      try { items = Array.isArray(rawItems) ? rawItems : rawItems ? Array.from(rawItems) : []; }
      catch (error) { items = []; }
      const bounded = items.slice(0, limits.maxTrackItemsPerTrack);
      for (const item of bounded) {
        try {
          if (!item || typeof item.getStartTime !== "function" || typeof item.getEndTime !== "function") continue;
          const [start, end] = await Promise.all([item.getStartTime(), item.getEndTime()]);
          const startTicks = normalizeTickString(start);
          const endTicks = normalizeTickString(end);
          if (startTicks === null || endTicks === null) continue;
          if (compareTickStrings(playheadTicks, startTicks) >= 0 && compareTickStrings(playheadTicks, endTicks) <= 0) {
            candidates.push(item);
            if (candidates.length >= limits.maxPlayheadCandidates) return candidates;
          }
        } catch (error) { /* A broken track item never blocks other candidates. */ }
      }
    }
    return candidates;
  }

  class PremiereCurvesAdapter {
    constructor(options = {}) {
      this.api = options.api || null;
      this.document = options.document || (typeof document !== "undefined" ? document : null);
      this.now = typeof options.now === "function" ? options.now : () => Date.now();
      this.setTimeout = typeof options.setTimeout === "function"
        ? options.setTimeout
        : (callback, delay) => setTimeout(callback, delay);
      this.clearTimeout = typeof options.clearTimeout === "function"
        ? options.clearTimeout
        : (handle) => clearTimeout(handle);
      this.logger = options.logger && typeof options.logger === "object" ? options.logger : null;
      this.bakedRuntimeProof = validateBakedRuntimeProof(this.api, options.bakedRuntimeProof);
      this.minPollIntervalMs = clampInteger(
        options.minPollIntervalMs,
        MIN_POLL_INTERVAL_MS,
        MAX_POLL_INTERVAL_MS,
        DEFAULT_MIN_POLL_INTERVAL_MS,
      );
      this.maxPollIntervalMs = clampInteger(
        options.maxPollIntervalMs,
        this.minPollIntervalMs,
        MAX_POLL_INTERVAL_MS,
        DEFAULT_MAX_POLL_INTERVAL_MS,
      );
      this.pollIntervalMs = this.minPollIntervalMs;
      this.limits = Object.freeze({
        maxSelectedTrackItems: clampInteger(options.maxSelectedTrackItems, 1, MAX_SELECTED_TRACK_ITEMS, MAX_SELECTED_TRACK_ITEMS),
        maxComponentsPerItem: clampInteger(options.maxComponentsPerItem, 1, MAX_COMPONENTS_PER_ITEM, MAX_COMPONENTS_PER_ITEM),
        maxParamsPerComponent: clampInteger(options.maxParamsPerComponent, 1, MAX_PARAMS_PER_COMPONENT, MAX_PARAMS_PER_COMPONENT),
        maxTrackScanTracks: clampInteger(options.maxTrackScanTracks, 1, MAX_TRACK_SCAN_TRACKS, MAX_TRACK_SCAN_TRACKS),
        maxTrackItemsPerTrack: clampInteger(options.maxTrackItemsPerTrack, 1, MAX_TRACK_ITEMS_PER_TRACK, MAX_TRACK_ITEMS_PER_TRACK),
        maxPlayheadCandidates: clampInteger(options.maxPlayheadCandidates, 1, MAX_PLAYHEAD_CANDIDATES, MAX_PLAYHEAD_CANDIDATES),
      });
      this.started = false;
      this.destroyed = false;
      this.visible = options.visible === true;
      this.active = options.active !== false;
      this.timer = null;
      this.refreshPromise = null;
      this.refreshQueued = false;
      this.refreshReasons = new Set();
      this.observationGeneration = 0;
      this.lastFingerprint = "";
      this.subscribers = new Set();
      this.bindingDescriptors = new Map();
      this.issuedOwnershipReceipts = new Map();
      this.ownershipReceiptSequence = 0;
      this.observedSequence = null;
      this.observedSequenceListeners = [];
      this.documentListener = () => this.onDocumentVisibilityChange();
      this.hostEventListener = () => this.onHostEvent();
      this.snapshot = this.makeStatusSnapshot(REASON.OBSERVATION_SUSPENDED);
    }

    makeStatusSnapshot(code, extra = {}) {
      const modes = availableNativeModes(this.api);
      return Object.freeze({
        revision: 0,
        observedAt: this.now(),
        observing: this.shouldObserve(),
        status: reason(code),
        state: stateForReason(code),
        message: REASON_MESSAGES[code] || "",
        error: stateForReason(code) === "error" ? reason(code) : null,
        project: null,
        sequence: null,
        playheadTicks: null,
        detectionSource: null,
        autoDetected: false,
        selection: Object.freeze([]),
        bindings: Object.freeze([]),
        selectedBindings: Object.freeze([]),
        issues: Object.freeze([]),
        capabilities: Object.freeze({
          selection: reason(code),
          nativeInterpolation: code === REASON.OK ? reason(REASON.OK) : reason(code),
          nativeModes: modes,
          frameQuantization: reason(REASON.FRAME_QUANTIZATION_UNAVAILABLE),
          bakedCurve: this.bakedRuntimeProof
            ? reason(REASON.OK, { runtimeProofVersion: this.bakedRuntimeProof.version })
            : reason(REASON.BAKED_RUNTIME_PROOF_REQUIRED),
          ownedKeyCleanup: reason(REASON.CLEANUP_OWNERSHIP_REQUIRED),
        }),
        ...extra,
      });
    }

    start() {
      if (this.destroyed) throw new CurvesAdapterError(REASON.ADAPTER_DESTROYED);
      if (this.started) return this;
      this.started = true;
      if (this.document && typeof this.document.addEventListener === "function") {
        this.document.addEventListener("visibilitychange", this.documentListener);
      }
      this.reconcileObservation("start");
      return this;
    }

    getSnapshot() {
      return this.snapshot;
    }

    subscribe(listener, options = {}) {
      if (typeof listener !== "function") throw new TypeError("Curves snapshot subscriber must be a function.");
      if (this.destroyed) throw new CurvesAdapterError(REASON.ADAPTER_DESTROYED);
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

    documentIsVisible() {
      return !this.document || this.document.visibilityState !== "hidden";
    }

    shouldObserve() {
      return Boolean(this.started && !this.destroyed && this.visible && this.active && this.documentIsVisible());
    }

    onDocumentVisibilityChange() {
      this.reconcileObservation("document-visibility");
    }

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
      if (this.destroyed) return Promise.reject(new CurvesAdapterError(REASON.ADAPTER_DESTROYED));
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

    async refreshOnce(refreshReasons) {
      const generation = this.observationGeneration;
      let inspection;
      try {
        inspection = await this.inspectHost();
      } catch (error) {
        const normalized = adapterError(error, REASON.SELECTION_UNREADABLE);
        inspection = {
          snapshot: this.makeStatusSnapshot(normalized.code, {
            issues: Object.freeze([Object.freeze({ code: normalized.code, message: normalized.message })]),
          }),
          descriptors: new Map(),
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
      this.bindingDescriptors = inspection.descriptors;
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
        snapshot.detectionSource,
        snapshot.project && snapshot.project.guid,
        snapshot.sequence && snapshot.sequence.guid,
        snapshot.playheadTicks,
        snapshot.selection && snapshot.selection.map((entry) => entry.trackKey),
        snapshot.bindings && snapshot.bindings.map((entry) => [entry.bindingId, entry.revision]),
        snapshot.issues && snapshot.issues.map((entry) => entry.code),
      ]);
    }

    publish(snapshot) {
      this.snapshot = snapshot;
      for (const listener of Array.from(this.subscribers)) {
        try { listener(snapshot); } catch (error) {
          if (this.logger && typeof this.logger.error === "function") this.logger.error("[Blocky Studios Curves] Snapshot subscriber failed.", error);
        }
      }
    }

    bindSequenceEvents(sequence) {
      if (this.observedSequence === sequence) return;
      this.unbindSequenceEvents();
      if (!sequence || !this.shouldObserve()) return;
      const manager = this.api && this.api.EventManager;
      const sequenceEvents = this.api && this.api.Constants && this.api.Constants.SequenceEvent;
      if (!manager || typeof manager.addEventListener !== "function" || !sequenceEvents) return;
      const eventNames = [sequenceEvents.SELECTION_CHANGED, sequenceEvents.ACTIVATED, sequenceEvents.CLOSED]
        .filter((value) => value !== null && value !== undefined);
      for (const eventName of eventNames) {
        try {
          manager.addEventListener(sequence, eventName, this.hostEventListener);
          this.observedSequenceListeners.push({ sequence, eventName });
        } catch (error) {
          if (this.logger && typeof this.logger.warn === "function") this.logger.warn("[Blocky Studios Curves] Sequence event unavailable.", error);
        }
      }
      this.observedSequence = sequence;
    }

    unbindSequenceEvents() {
      const manager = this.api && this.api.EventManager;
      if (manager && typeof manager.removeEventListener === "function") {
        for (const entry of this.observedSequenceListeners.splice(0)) {
          try { manager.removeEventListener(entry.sequence, entry.eventName, this.hostEventListener); } catch (error) { /* cleanup is best effort */ }
        }
      } else {
        this.observedSequenceListeners.length = 0;
      }
      this.observedSequence = null;
    }

    async inspectHost() {
      const api = this.api;
      if (!api || !api.Project || typeof api.Project.getActiveProject !== "function") {
        return { snapshot: this.makeStatusSnapshot(REASON.PREMIERE_API_UNAVAILABLE), descriptors: new Map(), refs: new Map(), project: null, sequence: null };
      }
      const project = await api.Project.getActiveProject();
      if (!project) return { snapshot: this.makeStatusSnapshot(REASON.NO_ACTIVE_PROJECT), descriptors: new Map(), refs: new Map(), project: null, sequence: null };
      if (typeof project.getActiveSequence !== "function") {
        return { snapshot: this.makeStatusSnapshot(REASON.NO_ACTIVE_SEQUENCE), descriptors: new Map(), refs: new Map(), project, sequence: null };
      }
      const sequence = await project.getActiveSequence();
      if (!sequence) return { snapshot: this.makeStatusSnapshot(REASON.NO_ACTIVE_SEQUENCE), descriptors: new Map(), refs: new Map(), project, sequence: null };
      let frameRate = null;
      let ticksPerFrame = null;
      try {
        const settings = typeof sequence.getSettings === "function" ? await sequence.getSettings() : null;
        const hostFrameRate = settings && typeof settings.getVideoFrameRate === "function"
          ? settings.getVideoFrameRate()
          : null;
        const candidateFrameRate = Number(hostFrameRate && hostFrameRate.value);
        frameRate = Number.isFinite(candidateFrameRate) && candidateFrameRate > 0 ? candidateFrameRate : null;
        ticksPerFrame = exactPositiveIntegerString(hostFrameRate && hostFrameRate.ticksPerFrame);
      } catch (error) {
        frameRate = null;
        ticksPerFrame = null;
      }
      if (typeof sequence.getPlayerPosition !== "function") {
        return { snapshot: this.makeStatusSnapshot(REASON.SELECTION_UNREADABLE), descriptors: new Map(), refs: new Map(), project, sequence };
      }
      const playhead = await sequence.getPlayerPosition();
      const playheadTicks = normalizeTickString(playhead);
      if (playheadTicks === null) throw new CurvesAdapterError(REASON.INVALID_TICK_TIME);
      let selectedItems = [];
      if (typeof sequence.getSelection === "function") {
        try {
          const selection = await sequence.getSelection();
          if (selection && typeof selection.getTrackItems === "function") {
            const rawSelectedItems = await selection.getTrackItems();
            selectedItems = Array.isArray(rawSelectedItems)
              ? rawSelectedItems
              : rawSelectedItems ? Array.from(rawSelectedItems) : [];
          }
        } catch (error) {
          selectedItems = [];
        }
      }
      if (selectedItems.length > this.limits.maxSelectedTrackItems) {
        const snapshot = this.makeStatusSnapshot(REASON.SELECTION_LIMIT_EXCEEDED, {
          project: Object.freeze({ guid: guidText(project.guid), name: cleanText(project.name, 512) }),
          sequence: Object.freeze({ guid: guidText(sequence.guid), name: cleanText(sequence.name, 512), frameRate, ticksPerFrame }),
          playheadTicks,
        });
        return { snapshot, descriptors: new Map(), refs: new Map(), project, sequence };
      }
      const detectionSource = selectedItems.length > 0 ? "selection" : "playhead";
      const items = detectionSource === "selection"
        ? selectedItems
        : await clipsAtPlayhead(api, sequence, playheadTicks, this.limits);
      if (items.length === 0) {
        const emptyCode = detectionSource === "selection" ? REASON.NO_SELECTION : REASON.NO_CLIP_AT_PLAYHEAD;
        const snapshot = this.makeStatusSnapshot(emptyCode, {
          project: Object.freeze({ guid: guidText(project.guid), name: cleanText(project.name, 512) }),
          sequence: Object.freeze({ guid: guidText(sequence.guid), name: cleanText(sequence.name, 512), frameRate, ticksPerFrame }),
          playheadTicks,
          detectionSource,
          autoDetected: detectionSource === "playhead",
        });
        return { snapshot, descriptors: new Map(), refs: new Map(), project, sequence };
      }
      const context = {
        project,
        sequence,
        projectGuid: guidText(project.guid),
        sequenceGuid: guidText(sequence.guid),
        playhead,
        playheadTicks,
        frameRate,
        ticksPerFrame,
      };
      const nativeModes = availableNativeModes(api);
      const publicItems = [];
      const publicBindings = [];
      const issues = [];
      const refs = new Map();
      const descriptors = new Map();
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        try {
          const inspected = await inspectTrackItem(
            api,
            context,
            items[itemIndex],
            nativeModes,
            this.bakedRuntimeProof,
            this.limits,
            detectionSource,
          );
          const trackKey = JSON.stringify(inspected.descriptor);
          publicItems.push(Object.freeze({
            trackKey,
            identity: inspected.descriptor,
            display: inspected.display,
            detectionSource,
            autoDetected: detectionSource === "playhead",
            bindingIds: Object.freeze(inspected.publicBindings.map((entry) => entry.bindingId)),
          }));
          for (let index = 0; index < inspected.bindings.length; index += 1) {
            const hostBinding = inspected.bindings[index];
            const binding = inspected.publicBindings[index];
            refs.set(binding.bindingId, hostBinding);
            descriptors.set(binding.bindingId, binding);
            publicBindings.push(binding);
          }
          issues.push(...inspected.issues.map((entry) => Object.freeze({ ...entry, itemIndex })));
          // Match OpenCurve's useful auto-detection behavior: the topmost clip at the
          // playhead that actually exposes keyframed properties owns this scan.
          if (detectionSource === "playhead" && inspected.publicBindings.length > 0) break;
        } catch (error) {
          const normalized = adapterError(error, REASON.TRACK_ITEM_UNREADABLE, { itemIndex });
          issues.push(Object.freeze({ code: normalized.code, message: normalized.message, itemIndex }));
        }
      }
      const usableNative = publicBindings.some((entry) => entry.capabilities.nativeInterpolation.supported);
      const selectionStatus = publicBindings.length > 0
        ? reason(REASON.OK, {
          message: detectionSource === "playhead"
            ? `${publicBindings.length} keyframed ${publicBindings.length === 1 ? "property" : "properties"} auto-detected at the playhead.`
            : `${publicBindings.length} keyframed ${publicBindings.length === 1 ? "property" : "properties"} detected on the selected ${publicItems.length === 1 ? "clip" : "clips"}.`,
        })
        : reason(REASON.KEYFRAMES_UNSUPPORTED, {
          message: detectionSource === "playhead"
            ? "The clip under the playhead has no property with two or more keyframes."
            : "The selected clip has no property with two or more keyframes.",
        });
      const snapshot = Object.freeze({
        revision: 0,
        observedAt: this.now(),
        observing: this.shouldObserve(),
        status: selectionStatus,
        state: stateForReason(selectionStatus.code),
        message: selectionStatus.message,
        error: null,
        project: Object.freeze({ guid: context.projectGuid, name: cleanText(project.name, 512) }),
        sequence: Object.freeze({
          guid: context.sequenceGuid,
          name: cleanText(sequence.name, 512),
          frameRate: context.frameRate,
          ticksPerFrame: context.ticksPerFrame,
        }),
        playheadTicks,
        detectionSource,
        autoDetected: detectionSource === "playhead",
        selection: Object.freeze(publicItems),
        bindings: Object.freeze(publicBindings),
        selectedBindings: Object.freeze(publicBindings),
        issues: Object.freeze(issues),
        capabilities: Object.freeze({
          selection: selectionStatus,
          nativeInterpolation: usableNative ? reason(REASON.OK) : reason(REASON.NO_BRACKETING_KEYS),
          nativeModes,
          frameQuantization: ticksPerFrame ? reason(REASON.OK, { frameRate, ticksPerFrame }) : reason(REASON.FRAME_QUANTIZATION_UNAVAILABLE),
          bakedCurve: this.bakedRuntimeProof && ticksPerFrame
            ? reason(REASON.OK, { runtimeProofVersion: this.bakedRuntimeProof.version })
            : reason(REASON.BAKED_RUNTIME_PROOF_REQUIRED),
          ownedKeyCleanup: reason(REASON.CLEANUP_OWNERSHIP_REQUIRED),
        }),
      });
      return { snapshot, descriptors, refs, project, sequence };
    }

    normalizeBindingRequests(bindingOrBindings) {
      const values = Array.isArray(bindingOrBindings) ? bindingOrBindings : [bindingOrBindings];
      if (values.length === 0) throw new CurvesAdapterError(REASON.INVALID_BINDING);
      const seen = new Set();
      return values.map((value) => {
        const bindingId = cleanText(typeof value === "string" ? value : value && value.bindingId, 8192);
        const descriptor = bindingId && this.bindingDescriptors.get(bindingId);
        const suppliedRevision = typeof value === "object" && value ? cleanText(value.revision, 16384) : "";
        if (!bindingId || !descriptor || seen.has(bindingId)) {
          throw new CurvesAdapterError(REASON.INVALID_BINDING, undefined, { bindingId });
        }
        seen.add(bindingId);
        return {
          bindingId,
          expectedRevision: suppliedRevision || descriptor.revision,
          identity: descriptor.identity,
        };
      });
    }

    async resolveRequests(requests) {
      const inspection = await this.inspectHost();
      const currentProjectGuid = inspection.snapshot.project && inspection.snapshot.project.guid;
      const currentSequenceGuid = inspection.snapshot.sequence && inspection.snapshot.sequence.guid;
      const resolved = [];
      for (const request of requests) {
        const publicBinding = inspection.descriptors.get(request.bindingId);
        const hostBinding = inspection.refs.get(request.bindingId);
        if (!publicBinding || !hostBinding ||
            publicBinding.identity.projectGuid !== request.identity.projectGuid ||
            publicBinding.identity.sequenceGuid !== request.identity.sequenceGuid ||
            publicBinding.revision !== request.expectedRevision) {
          throw new CurvesAdapterError(REASON.STALE_BINDING, undefined, {
            bindingId: request.bindingId,
            expectedProjectGuid: request.identity.projectGuid,
            currentProjectGuid,
            expectedSequenceGuid: request.identity.sequenceGuid,
            currentSequenceGuid,
          });
        }
        resolved.push({ request, publicBinding, hostBinding });
      }
      return { ...inspection, resolved };
    }

    async planNativeInterpolation(bindingOrBindings, modeName, options = {}) {
      if (this.destroyed) throw new CurvesAdapterError(REASON.ADAPTER_DESTROYED);
      const name = cleanText(modeName, 32).toUpperCase();
      const modeValue = interpolationModeValue(this.api, name);
      if (modeValue === null) throw new CurvesAdapterError(REASON.INTERPOLATION_MODE_UNAVAILABLE, undefined, { modeName: name });
      const requests = this.normalizeBindingRequests(bindingOrBindings);
      const inspection = await this.resolveRequests(requests);
      const operations = inspection.resolved.map(({ publicBinding, hostBinding }) => {
        if (!publicBinding.capabilities.nativeInterpolation.supported ||
            typeof hostBinding.param.createSetInterpolationAtKeyframeAction !== "function") {
          throw new CurvesAdapterError(
            publicBinding.capabilities.nativeInterpolation.code || REASON.INTERPOLATION_API_UNAVAILABLE,
            undefined,
            { bindingId: publicBinding.bindingId },
          );
        }
        const start = publicBinding.endpoints.start;
        const end = publicBinding.endpoints.end;
        if (!start || !end || start.interpolationMode === null || end.interpolationMode === null) {
          throw new CurvesAdapterError(REASON.ENDPOINT_READBACK_FAILED, undefined, { bindingId: publicBinding.bindingId });
        }
        return Object.freeze({
          bindingId: publicBinding.bindingId,
          identity: publicBinding.identity,
          expectedRevision: publicBinding.revision,
          targetTicks: start.ticks,
          requestedMode: Object.freeze({ name, value: modeValue }),
          before: Object.freeze({
            start,
            end,
            keyTicks: publicBinding.keyTicks,
          }),
          noChange: start.interpolationMode === modeValue,
        });
      });
      const planCore = {
        kind: "oracle-native-interpolation-plan",
        version: 1,
        projectGuid: inspection.snapshot.project.guid,
        sequenceGuid: inspection.snapshot.sequence.guid,
        undoString: cleanText(options.undoString, 128) || `Blocky Studios Curves: ${name[0]}${name.slice(1).toLowerCase()}`,
        keyframePolicy: Object.freeze({ create: false, remove: false, move: false }),
        temporalShape: Object.freeze({
          interpolationMode: name,
          customTangentsApplied: false,
          tangentOwner: name === "BEZIER" ? "premiere" : "not-applicable",
        }),
        operations: Object.freeze(operations),
      };
      const integrity = this.planIntegrity(planCore);
      return Object.freeze({ ...planCore, integrity });
    }

    planIntegrity(plan) {
      return JSON.stringify([
        plan.kind,
        plan.version,
        plan.projectGuid,
        plan.sequenceGuid,
        plan.undoString,
        plan.keyframePolicy && [plan.keyframePolicy.create, plan.keyframePolicy.remove, plan.keyframePolicy.move],
        plan.temporalShape && [plan.temporalShape.interpolationMode, plan.temporalShape.customTangentsApplied, plan.temporalShape.tangentOwner],
        (plan.operations || []).map((operation) => [
          operation.bindingId,
          operation.expectedRevision,
          operation.targetTicks,
          operation.requestedMode && operation.requestedMode.name,
          operation.requestedMode && operation.requestedMode.value,
          operation.noChange,
        ]),
      ]);
    }

    validateNativePlan(plan) {
      if (!plan || plan.kind !== "oracle-native-interpolation-plan" || plan.version !== 1 ||
          !Array.isArray(plan.operations) || plan.operations.length === 0 ||
          !plan.keyframePolicy || plan.keyframePolicy.create !== false || plan.keyframePolicy.remove !== false || plan.keyframePolicy.move !== false ||
          !plan.temporalShape || plan.temporalShape.customTangentsApplied !== false ||
          !plan.operations.every((operation) => operation.requestedMode && operation.requestedMode.name === plan.temporalShape.interpolationMode) ||
          cleanText(plan.integrity, 65536) !== this.planIntegrity(plan)) {
        throw new CurvesAdapterError(REASON.INVALID_PLAN);
      }
    }

    async applyNativeInterpolation(plan) {
      if (this.destroyed) throw new CurvesAdapterError(REASON.ADAPTER_DESTROYED);
      this.validateNativePlan(plan);
      const requests = plan.operations.map((operation) => ({
        bindingId: operation.bindingId,
        expectedRevision: operation.expectedRevision,
        identity: operation.identity,
      }));
      const inspection = await this.resolveRequests(requests);
      if (!inspection.project || inspection.snapshot.project.guid !== plan.projectGuid ||
          inspection.snapshot.sequence.guid !== plan.sequenceGuid) {
        throw new CurvesAdapterError(REASON.STALE_BINDING);
      }
      const byId = new Map(inspection.resolved.map((entry) => [entry.publicBinding.bindingId, entry]));
      const actionable = [];
      for (const operation of plan.operations) {
        const resolved = byId.get(operation.bindingId);
        if (!resolved || resolved.publicBinding.endpoints.start.ticks !== operation.targetTicks ||
            resolved.publicBinding.revision !== operation.expectedRevision) {
          throw new CurvesAdapterError(REASON.STALE_BINDING, undefined, { bindingId: operation.bindingId });
        }
        if (!operation.noChange) actionable.push({ operation, ...resolved });
      }

      if (actionable.length > 0) {
        const project = inspection.project;
        if (typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
          throw new CurvesAdapterError(REASON.INTERPOLATION_API_UNAVAILABLE);
        }
        let transactionCalled = false;
        let transactionResult = false;
        let callbackError = null;
        try {
          project.lockedAccess(() => {
            try {
              transactionCalled = true;
              transactionResult = project.executeTransaction((compoundAction) => {
                if (!compoundAction || typeof compoundAction.addAction !== "function") {
                  throw new CurvesAdapterError(REASON.ACTION_REJECTED);
                }
                for (const entry of actionable) {
                  let action;
                  try {
                    action = entry.hostBinding.param.createSetInterpolationAtKeyframeAction(
                      entry.hostBinding.endpoints.start.keyframe.position || entry.hostBinding.timeRecords.find((time) => time.ticks === entry.operation.targetTicks).raw,
                      entry.operation.requestedMode.value,
                      true,
                    );
                  } catch (error) {
                    throw adapterError(error, REASON.ACTION_CREATION_FAILED, { bindingId: entry.operation.bindingId });
                  }
                  if (!action) throw new CurvesAdapterError(REASON.ACTION_CREATION_FAILED, undefined, { bindingId: entry.operation.bindingId });
                  if (compoundAction.addAction(action) !== true) {
                    throw new CurvesAdapterError(REASON.ACTION_REJECTED, undefined, { bindingId: entry.operation.bindingId });
                  }
                }
              }, plan.undoString);
            } catch (error) {
              callbackError = error;
              throw error;
            }
          });
        } catch (error) {
          throw adapterError(callbackError || error, REASON.TRANSACTION_FAILED);
        }
        if (!transactionCalled || !transactionResult) {
          throw new CurvesAdapterError(REASON.TRANSACTION_FAILED, undefined, { transactionCalled, transactionResult });
        }
      }

      const receiptOperations = [];
      for (const operation of plan.operations) {
        const resolved = byId.get(operation.bindingId);
        let start;
        let end;
        try {
          [start, end] = await Promise.all([
            readEndpoint(resolved.hostBinding.param, resolved.hostBinding.timeRecords.find((time) => time.ticks === operation.before.start.ticks)),
            readEndpoint(resolved.hostBinding.param, resolved.hostBinding.timeRecords.find((time) => time.ticks === operation.before.end.ticks)),
          ]);
        } catch (error) {
          throw adapterError(error, REASON.ENDPOINT_READBACK_FAILED, { bindingId: operation.bindingId, transactionCommitted: actionable.length > 0 });
        }
        if (start.ticks !== operation.before.start.ticks || end.ticks !== operation.before.end.ticks ||
            start.valueFingerprint !== operation.before.start.valueFingerprint ||
            end.valueFingerprint !== operation.before.end.valueFingerprint ||
            end.interpolationMode !== operation.before.end.interpolationMode) {
          throw new CurvesAdapterError(REASON.ENDPOINT_CHANGED, undefined, {
            bindingId: operation.bindingId,
            transactionCommitted: actionable.length > 0,
          });
        }
        if (start.interpolationMode !== operation.requestedMode.value) {
          throw new CurvesAdapterError(REASON.INTERPOLATION_READBACK_MISMATCH, undefined, {
            bindingId: operation.bindingId,
            expectedMode: operation.requestedMode.value,
            actualMode: start.interpolationMode,
            transactionCommitted: actionable.length > 0,
          });
        }
        receiptOperations.push(Object.freeze({
          bindingId: operation.bindingId,
          targetTicks: operation.targetTicks,
          beforeMode: operation.before.start.interpolationMode,
          afterMode: start.interpolationMode,
          endpointValuesPreserved: true,
          endpointTimesPreserved: true,
          changed: !operation.noChange,
        }));
      }
      this.requestRefresh("native-apply-readback").catch(() => undefined);
      return Object.freeze({
        kind: "oracle-native-interpolation-receipt",
        version: 1,
        projectGuid: plan.projectGuid,
        sequenceGuid: plan.sequenceGuid,
        undoString: plan.undoString,
        committed: actionable.length > 0,
        changed: actionable.length > 0,
        ok: true,
        verified: true,
        readbackVerified: true,
        oneUndoStep: actionable.length > 0,
        undoStep: actionable.length > 0 ? 1 : 0,
        operationCount: receiptOperations.length,
        operations: Object.freeze(receiptOperations),
        createdKeyCount: 0,
        removedKeyCount: 0,
        movedKeyCount: 0,
        customTangentsApplied: false,
        tangentOwner: plan.temporalShape.tangentOwner,
        keyOwnership: Object.freeze({ createdKeys: Object.freeze([]), cleanupSupported: false }),
      });
    }

    confirmBakedRuntimeProof(proof) {
      if (this.destroyed) throw new CurvesAdapterError(REASON.ADAPTER_DESTROYED);
      const validated = validateBakedRuntimeProof(this.api, proof);
      if (!validated) {
        this.bakedRuntimeProof = null;
        throw new CurvesAdapterError(REASON.BAKED_RUNTIME_PROOF_REQUIRED);
      }
      this.bakedRuntimeProof = validated;
      if (this.shouldObserve()) this.requestRefresh("baked-runtime-proof").catch(() => undefined);
      return validated;
    }

    getBakedProof() {
      return this.bakedRuntimeProof;
    }

    bakedCandidatesForBinding(generatedKeysByBinding, bindingId, requestCount) {
      if (Array.isArray(generatedKeysByBinding) && requestCount === 1) return generatedKeysByBinding;
      const direct = generatedKeysByBinding && generatedKeysByBinding[bindingId];
      if (Array.isArray(direct)) return direct;
      if (direct && Array.isArray(direct.samples)) return direct.samples;
      return [];
    }

    normalizeBakedCandidates(publicBinding, candidates) {
      const start = publicBinding.endpoints.start;
      const end = publicBinding.endpoints.end;
      if (publicBinding.identity.track.timeBasisProven !== true) {
        throw new CurvesAdapterError(REASON.UNPROVEN_TIME_BASIS, undefined, { bindingId: publicBinding.bindingId });
      }
      const ticksPerFrame = exactPositiveIntegerString(publicBinding.ticksPerFrame);
      if (!ticksPerFrame) {
        throw new CurvesAdapterError(REASON.FRAME_QUANTIZATION_UNAVAILABLE, undefined, { bindingId: publicBinding.bindingId });
      }
      if (!start || !end || start.valueKind !== "number" || end.valueKind !== "number") {
        throw new CurvesAdapterError(REASON.VALUE_KIND_UNSUPPORTED, undefined, { bindingId: publicBinding.bindingId });
      }
      if (!publicBinding.bracket.hasSegment) {
        throw new CurvesAdapterError(REASON.NO_BRACKETING_KEYS, undefined, { bindingId: publicBinding.bindingId });
      }
      if (!Array.isArray(candidates) || candidates.length > MAX_BAKED_KEYS_PER_BINDING + 2) {
        throw new CurvesAdapterError(REASON.INVALID_PLAN, undefined, { bindingId: publicBinding.bindingId });
      }
      const occupied = new Set(publicBinding.keyTicks);
      const seen = new Set();
      const interior = [];
      for (const candidate of candidates) {
        const ticks = normalizeTickString(candidate && (candidate.ticks ?? candidate.tick ?? candidate.timeTicks));
        const value = candidate && Object.prototype.hasOwnProperty.call(candidate, "value") ? candidate.value : undefined;
        if (ticks === null || valueKind(value) !== "number") {
          throw new CurvesAdapterError(REASON.INVALID_PLAN, undefined, { bindingId: publicBinding.bindingId, ticks });
        }
        if (ticks === start.ticks || ticks === end.ticks) {
          const endpoint = ticks === start.ticks ? start : end;
          if (valueFingerprint(value) !== endpoint.valueFingerprint) {
            throw new CurvesAdapterError(REASON.ENDPOINT_CHANGED, undefined, { bindingId: publicBinding.bindingId, ticks });
          }
          continue;
        }
        if (compareTickStrings(ticks, start.ticks) <= 0 || compareTickStrings(ticks, end.ticks) >= 0 ||
            occupied.has(ticks) || seen.has(ticks)) {
          throw new CurvesAdapterError(REASON.INVALID_PLAN, undefined, {
            bindingId: publicBinding.bindingId,
            ticks,
            collision: occupied.has(ticks),
            duplicate: seen.has(ticks),
          });
        }
        if (tickModulo(ticks, ticksPerFrame) !== 0) {
          throw new CurvesAdapterError(REASON.INVALID_PLAN, undefined, {
            bindingId: publicBinding.bindingId,
            ticks,
            ticksPerFrame,
            frameAligned: false,
          });
        }
        seen.add(ticks);
        interior.push(Object.freeze({
          ticks,
          value: Number(value),
          valueKind: "number",
          valueFingerprint: valueFingerprint(value),
        }));
      }
      interior.sort((left, right) => compareTickStrings(left.ticks, right.ticks));
      if (interior.length > MAX_BAKED_KEYS_PER_BINDING) throw new CurvesAdapterError(REASON.INVALID_PLAN);
      if (interior.length === 0) {
        throw new CurvesAdapterError(REASON.INVALID_PLAN, "Baked Blocky Studios curves require at least one new frame-aligned interior key.", {
          bindingId: publicBinding.bindingId,
          emptyBake: true,
        });
      }
      return Object.freeze(interior);
    }

    bakedPlanIntegrity(plan) {
      return JSON.stringify([
        plan.kind,
        plan.version,
        plan.projectGuid,
        plan.sequenceGuid,
        plan.undoString,
        plan.runtimeProofVersion,
        (plan.operations || []).map((operation) => [
          operation.bindingId,
          operation.expectedRevision,
          operation.endpointStartTicks,
          operation.endpointEndTicks,
          operation.beforeStartValueFingerprint,
          operation.beforeEndValueFingerprint,
          operation.beforeStartInterpolationMode,
          operation.beforeEndInterpolationMode,
          operation.ticksPerFrame,
          operation.candidates.map((candidate) => [candidate.ticks, candidate.valueFingerprint]),
        ]),
      ]);
    }

    receiptOverlapsResolvedSegment(receipt, resolvedById) {
      return receipt.operations.some((operation) => {
        const resolved = resolvedById.get(operation.bindingId);
        const start = resolved && resolved.publicBinding && resolved.publicBinding.endpoints.start;
        const end = resolved && resolved.publicBinding && resolved.publicBinding.endpoints.end;
        if (!start || !end) return false;
        return operation.createdKeys.some((key) => (
          compareTickStrings(key.ticks, start.ticks) > 0 && compareTickStrings(key.ticks, end.ticks) < 0
        ));
      });
    }

    async reconcilePriorBakeReceiptsForPlan(inspection) {
      if (!this.issuedOwnershipReceipts.size) return;
      const resolvedById = new Map(inspection.resolved.map((entry) => [entry.publicBinding.bindingId, entry]));
      for (const [ownershipToken, ownershipRecord] of Array.from(this.issuedOwnershipReceipts.entries())) {
        const receipt = ownershipRecord && ownershipRecord.receipt;
        if (!receipt || !this.receiptOverlapsResolvedSegment(receipt, resolvedById)) continue;
        if (receipt.projectGuid !== inspection.snapshot.project.guid || receipt.sequenceGuid !== inspection.snapshot.sequence.guid) {
          throw new CurvesAdapterError(REASON.CLEANUP_OWNERSHIP_REQUIRED, undefined, { ownershipToken, priorBake: true });
        }
        let presentCount = 0;
        let absentCount = 0;
        let unsafe = false;
        for (const operation of receipt.operations) {
          const publicBinding = inspection.descriptors.get(operation.bindingId);
          const hostBinding = inspection.refs.get(operation.bindingId);
          if (!publicBinding || !hostBinding || stableIdentityKey(publicBinding.identity) !== stableIdentityKey(operation.identity)) {
            unsafe = true;
            break;
          }
          const currentTicks = new Set(hostBinding.param.getKeyframeListAsTickTimes()
            .map((time) => normalizeTickString(time)).filter(Boolean));
          for (const ownedKey of operation.createdKeys) {
            if (!currentTicks.has(ownedKey.ticks)) {
              absentCount += 1;
              continue;
            }
            const hostTime = this.api.TickTime.createWithTicks(ownedKey.ticks);
            let current;
            try { current = await readEndpoint(hostBinding.param, { ticks: ownedKey.ticks, raw: hostTime }); } catch (error) {
              unsafe = true;
              break;
            }
            const issuedKeyframe = ownershipRecord.ownedKeyRefs.get(operation.bindingId) &&
              ownershipRecord.ownedKeyRefs.get(operation.bindingId).get(ownedKey.ticks);
            if (current.valueFingerprint !== ownedKey.valueFingerprint ||
                current.interpolationMode !== ownedKey.interpolationMode || current.keyframe !== issuedKeyframe) {
              unsafe = true;
              break;
            }
            presentCount += 1;
          }
          if (unsafe) break;
        }
        if (!unsafe && presentCount === 0 && absentCount > 0) {
          this.issuedOwnershipReceipts.delete(ownershipToken);
          continue;
        }
        if (unsafe || absentCount > 0) {
          throw new CurvesAdapterError(REASON.CLEANUP_OWNERSHIP_REQUIRED, undefined, {
            ownershipToken,
            priorBake: true,
            partialReceipt: absentCount > 0 && presentCount > 0,
          });
        }
        throw new CurvesAdapterError(REASON.PRIOR_BAKE_REPLACEMENT_UNPROVEN, undefined, {
          ownershipToken,
          priorBake: true,
          ownedKeyCount: presentCount,
        });
      }
    }

    async planBakedCurve(bindingOrBindings, generatedKeysByBinding = {}, options = {}) {
      if (this.destroyed) throw new CurvesAdapterError(REASON.ADAPTER_DESTROYED);
      const requests = this.normalizeBindingRequests(bindingOrBindings);
      const inspection = await this.resolveRequests(requests);
      await this.reconcilePriorBakeReceiptsForPlan(inspection);
      const proof = this.bakedRuntimeProof;
      const operations = inspection.resolved.map(({ publicBinding, hostBinding }) => {
        const start = publicBinding.endpoints.start;
        const end = publicBinding.endpoints.end;
        const candidates = this.bakedCandidatesForBinding(generatedKeysByBinding, publicBinding.bindingId, requests.length);
        if (!proof) {
          return Object.freeze({
            bindingId: publicBinding.bindingId,
            identity: publicBinding.identity,
            expectedRevision: publicBinding.revision,
            endpointStartTicks: start && start.ticks || null,
            endpointEndTicks: end && end.ticks || null,
            valueKind: start && start.valueKind || "unknown",
            frameRate: publicBinding.sequenceFrameRate,
            ticksPerFrame: publicBinding.ticksPerFrame,
            candidateKeyCount: Array.isArray(candidates) ? candidates.length : 0,
            capability: start && start.valueKind === "pointf"
              ? reason(REASON.VALUE_KIND_UNSUPPORTED)
              : reason(REASON.BAKED_RUNTIME_PROOF_REQUIRED),
          });
        }
        if (!hostBinding.param || typeof hostBinding.param.createKeyframe !== "function" ||
            typeof hostBinding.param.createAddKeyframeAction !== "function" ||
            typeof hostBinding.param.createRemoveKeyframeAction !== "function") {
          throw new CurvesAdapterError(REASON.INTERPOLATION_API_UNAVAILABLE, undefined, { bindingId: publicBinding.bindingId });
        }
        const normalizedCandidates = this.normalizeBakedCandidates(publicBinding, candidates);
        return Object.freeze({
          bindingId: publicBinding.bindingId,
          identity: publicBinding.identity,
          expectedRevision: publicBinding.revision,
          endpointStartTicks: start.ticks,
          endpointEndTicks: end.ticks,
          beforeStartValueFingerprint: start.valueFingerprint,
          beforeEndValueFingerprint: end.valueFingerprint,
          beforeStartInterpolationMode: start.interpolationMode,
          beforeEndInterpolationMode: end.interpolationMode,
          valueKind: "number",
          frameRate: publicBinding.sequenceFrameRate,
          ticksPerFrame: publicBinding.ticksPerFrame,
          candidates: normalizedCandidates,
          candidateKeyCount: normalizedCandidates.length,
          capability: reason(REASON.OK, { runtimeProofVersion: proof.version }),
        });
      });
      if (!proof) {
        return Object.freeze({
          kind: "oracle-baked-curve-plan-contract",
          version: 1,
          projectGuid: inspection.snapshot.project.guid,
          sequenceGuid: inspection.snapshot.sequence.guid,
          executable: false,
          destructiveCleanupAllowed: false,
          warningThreshold: clampInteger(options.warningThreshold, 1, 100000, 120),
          capability: reason(REASON.BAKED_RUNTIME_PROOF_REQUIRED),
          requiredRuntimeProof: Object.freeze([
            "detached-generated-key-actions",
            "default-linear-readback",
            "exact-endpoint-readback",
            "one-transaction-one-undo",
            "undo-removes-generated-keys",
          ]),
          operations: Object.freeze(operations),
        });
      }
      const planCore = {
        kind: "oracle-baked-curve-plan",
        version: 1,
        projectGuid: inspection.snapshot.project.guid,
        sequenceGuid: inspection.snapshot.sequence.guid,
        undoString: cleanText(options.undoString, 128) || "Blocky Studios Curves: Bake Curve",
        runtimeProofVersion: proof.version,
        executable: true,
        destructiveCleanupAllowed: true,
        warningThreshold: clampInteger(options.warningThreshold, 1, 100000, 120),
        operations: Object.freeze(operations),
      };
      return Object.freeze({ ...planCore, integrity: this.bakedPlanIntegrity(planCore) });
    }

    validateBakedPlan(plan) {
      if (!this.bakedRuntimeProof) throw new CurvesAdapterError(REASON.BAKED_RUNTIME_PROOF_REQUIRED);
      if (!plan || plan.kind !== "oracle-baked-curve-plan" || plan.version !== 1 || plan.executable !== true ||
          plan.runtimeProofVersion !== this.bakedRuntimeProof.version || !Array.isArray(plan.operations) ||
          plan.operations.length === 0 || cleanText(plan.integrity, 65536) !== this.bakedPlanIntegrity(plan)) {
        throw new CurvesAdapterError(REASON.INVALID_PLAN);
      }
    }

    executeLockedActions(project, undoString, actionFactories) {
      if (!project || typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
        throw new CurvesAdapterError(REASON.INTERPOLATION_API_UNAVAILABLE);
      }
      let transactionCalled = false;
      let transactionResult = false;
      let callbackError = null;
      try {
        project.lockedAccess(() => {
          try {
            transactionCalled = true;
            transactionResult = project.executeTransaction((compoundAction) => {
              if (!compoundAction || typeof compoundAction.addAction !== "function") {
                throw new CurvesAdapterError(REASON.ACTION_REJECTED);
              }
              for (const createAction of actionFactories) {
                let action;
                try { action = createAction(); } catch (error) {
                  throw adapterError(error, REASON.ACTION_CREATION_FAILED);
                }
                if (!action) throw new CurvesAdapterError(REASON.ACTION_CREATION_FAILED);
                if (compoundAction.addAction(action) !== true) throw new CurvesAdapterError(REASON.ACTION_REJECTED);
              }
            }, undoString);
          } catch (error) {
            callbackError = error;
            throw error;
          }
        });
      } catch (error) {
        throw adapterError(callbackError || error, REASON.TRANSACTION_FAILED);
      }
      if (!transactionCalled || !transactionResult) {
        throw new CurvesAdapterError(REASON.TRANSACTION_FAILED, undefined, { transactionCalled, transactionResult });
      }
    }

    async applyBakedCurve(plan) {
      if (this.destroyed) throw new CurvesAdapterError(REASON.ADAPTER_DESTROYED);
      this.validateBakedPlan(plan);
      const requests = plan.operations.map((operation) => ({
        bindingId: operation.bindingId,
        expectedRevision: operation.expectedRevision,
        identity: operation.identity,
      }));
      const inspection = await this.resolveRequests(requests);
      if (!inspection.project || inspection.snapshot.project.guid !== plan.projectGuid ||
          inspection.snapshot.sequence.guid !== plan.sequenceGuid) throw new CurvesAdapterError(REASON.STALE_BINDING);
      const byId = new Map(inspection.resolved.map((entry) => [entry.publicBinding.bindingId, entry]));
      const actionFactories = [];
      for (const operation of plan.operations) {
        const resolved = byId.get(operation.bindingId);
        if (!resolved || resolved.publicBinding.revision !== operation.expectedRevision) {
          throw new CurvesAdapterError(REASON.STALE_BINDING, undefined, { bindingId: operation.bindingId });
        }
        for (const candidate of operation.candidates) {
          actionFactories.push(() => {
            const hostTime = this.api.TickTime.createWithTicks(candidate.ticks);
            const keyframe = resolved.hostBinding.param.createKeyframe(candidate.value);
            if (!keyframe || typeof keyframe !== "object") throw new CurvesAdapterError(REASON.ACTION_CREATION_FAILED);
            keyframe.position = hostTime;
            return resolved.hostBinding.param.createAddKeyframeAction(keyframe);
          });
        }
      }
      if (actionFactories.length > 0) this.executeLockedActions(inspection.project, plan.undoString, actionFactories);

      const receiptOperations = [];
      const ownedKeyRefs = new Map();
      for (const operation of plan.operations) {
        const resolved = byId.get(operation.bindingId);
        const startRecord = resolved.hostBinding.timeRecords.find((entry) => entry.ticks === operation.endpointStartTicks);
        const endRecord = resolved.hostBinding.timeRecords.find((entry) => entry.ticks === operation.endpointEndTicks);
        const [start, end] = await Promise.all([
          readEndpoint(resolved.hostBinding.param, startRecord),
          readEndpoint(resolved.hostBinding.param, endRecord),
        ]);
        if (start.valueFingerprint !== operation.beforeStartValueFingerprint ||
            end.valueFingerprint !== operation.beforeEndValueFingerprint ||
            start.interpolationMode !== operation.beforeStartInterpolationMode ||
            end.interpolationMode !== operation.beforeEndInterpolationMode) {
          throw new CurvesAdapterError(REASON.ENDPOINT_CHANGED, undefined, {
            bindingId: operation.bindingId,
            transactionCommitted: actionFactories.length > 0,
          });
        }
        const createdKeys = [];
        const operationKeyRefs = new Map();
        for (const candidate of operation.candidates) {
          const hostTime = this.api.TickTime.createWithTicks(candidate.ticks);
          const added = await readEndpoint(resolved.hostBinding.param, { ticks: candidate.ticks, raw: hostTime });
          if (added.valueFingerprint !== candidate.valueFingerprint ||
              added.interpolationMode !== this.bakedRuntimeProof.defaultLinearInterpolationMode) {
            throw new CurvesAdapterError(REASON.INTERPOLATION_READBACK_MISMATCH, undefined, {
              bindingId: operation.bindingId,
              ticks: candidate.ticks,
              transactionCommitted: actionFactories.length > 0,
            });
          }
          createdKeys.push(Object.freeze({
            ticks: candidate.ticks,
            valueKind: candidate.valueKind,
            value: candidate.value,
            valueFingerprint: candidate.valueFingerprint,
            interpolationMode: added.interpolationMode,
          }));
          operationKeyRefs.set(candidate.ticks, added.keyframe);
        }
        ownedKeyRefs.set(operation.bindingId, operationKeyRefs);
        receiptOperations.push(Object.freeze({
          bindingId: operation.bindingId,
          identity: operation.identity,
          endpointStartTicks: operation.endpointStartTicks,
          endpointEndTicks: operation.endpointEndTicks,
          endpointStartValueFingerprint: operation.beforeStartValueFingerprint,
          endpointEndValueFingerprint: operation.beforeEndValueFingerprint,
          createdKeys: Object.freeze(createdKeys),
        }));
      }
      this.ownershipReceiptSequence += 1;
      const ownershipToken = `oracle-baked-owned:${this.now().toString(36)}:${this.ownershipReceiptSequence.toString(36)}`;
      const receipt = Object.freeze({
        kind: "oracle-baked-key-receipt",
        version: 1,
        ownershipToken,
        runtimeProofVersion: this.bakedRuntimeProof.version,
        projectGuid: plan.projectGuid,
        sequenceGuid: plan.sequenceGuid,
        undoString: plan.undoString,
        ok: true,
        verified: true,
        readbackVerified: true,
        oneUndoStep: actionFactories.length > 0,
        undoStep: actionFactories.length > 0 ? 1 : 0,
        committed: actionFactories.length > 0,
        changed: actionFactories.length > 0,
        createdKeyCount: actionFactories.length,
        operations: Object.freeze(receiptOperations),
      });
      this.issuedOwnershipReceipts.set(ownershipToken, { receipt, ownedKeyRefs });
      this.requestRefresh("baked-apply-readback").catch(() => undefined);
      return receipt;
    }

    validateOwnershipReceipt(receipt) {
      const token = cleanText(receipt && receipt.ownershipToken, 256);
      const stored = token && this.issuedOwnershipReceipts.get(token);
      const valid = Boolean(
        receipt && stored && stored.receipt === receipt && receipt.kind === "oracle-baked-key-receipt" && receipt.version === 1 &&
        this.bakedRuntimeProof && receipt.runtimeProofVersion === this.bakedRuntimeProof.version,
      );
      return Object.freeze({
        valid,
        capability: valid ? reason(REASON.OK) : reason(REASON.CLEANUP_OWNERSHIP_REQUIRED),
      });
    }

    async cleanupOwnedKeys(receipt, options = {}) {
      const validation = this.validateOwnershipReceipt(receipt);
      if (!validation.valid) {
        return Object.freeze({ ok: false, changed: false, removedKeyCount: 0, capability: validation.capability });
      }
      const inspection = await this.inspectHost();
      const ownershipRecord = this.issuedOwnershipReceipts.get(receipt.ownershipToken);
      if (!inspection.project || !inspection.snapshot.project || !inspection.snapshot.sequence ||
          inspection.snapshot.project.guid !== receipt.projectGuid || inspection.snapshot.sequence.guid !== receipt.sequenceGuid) {
        throw new CurvesAdapterError(REASON.STALE_BINDING);
      }
      const resolvedOperations = [];
      for (const operation of receipt.operations) {
        const publicBinding = inspection.descriptors.get(operation.bindingId);
        const hostBinding = inspection.refs.get(operation.bindingId);
        if (!publicBinding || !hostBinding || stableIdentityKey(publicBinding.identity) !== stableIdentityKey(operation.identity) ||
            typeof hostBinding.param.createRemoveKeyframeAction !== "function") {
          throw new CurvesAdapterError(REASON.STALE_BINDING, undefined, { bindingId: operation.bindingId });
        }
        for (const ownedKey of operation.createdKeys) {
          const hostTime = this.api.TickTime.createWithTicks(ownedKey.ticks);
          let current;
          try { current = await readEndpoint(hostBinding.param, { ticks: ownedKey.ticks, raw: hostTime }); } catch (error) {
            throw new CurvesAdapterError(REASON.CLEANUP_OWNERSHIP_REQUIRED, undefined, { bindingId: operation.bindingId, ticks: ownedKey.ticks });
          }
          if (current.valueFingerprint !== ownedKey.valueFingerprint || current.interpolationMode !== ownedKey.interpolationMode) {
            throw new CurvesAdapterError(REASON.CLEANUP_OWNERSHIP_REQUIRED, undefined, { bindingId: operation.bindingId, ticks: ownedKey.ticks });
          }
          const issuedKeyframe = ownershipRecord && ownershipRecord.ownedKeyRefs.get(operation.bindingId) &&
            ownershipRecord.ownedKeyRefs.get(operation.bindingId).get(ownedKey.ticks);
          if (!issuedKeyframe || current.keyframe !== issuedKeyframe) {
            throw new CurvesAdapterError(REASON.CLEANUP_OWNERSHIP_REQUIRED, undefined, {
              bindingId: operation.bindingId,
              ticks: ownedKey.ticks,
              keyIdentityChanged: true,
            });
          }
        }
        resolvedOperations.push({ operation, hostBinding });
      }
      const actionFactories = [];
      for (const entry of resolvedOperations) {
        for (const ownedKey of entry.operation.createdKeys) {
          actionFactories.push(() => entry.hostBinding.param.createRemoveKeyframeAction(
            this.api.TickTime.createWithTicks(ownedKey.ticks),
            true,
          ));
        }
      }
      if (actionFactories.length > 0) {
        this.executeLockedActions(
          inspection.project,
          cleanText(options.undoString, 128) || "Blocky Studios Curves: Remove Baked Keys",
          actionFactories,
        );
      }
      for (const entry of resolvedOperations) {
        const remaining = new Set(entry.hostBinding.param.getKeyframeListAsTickTimes()
          .map((time) => normalizeTickString(time)).filter(Boolean));
        if (entry.operation.createdKeys.some((ownedKey) => remaining.has(ownedKey.ticks))) {
          throw new CurvesAdapterError(REASON.ENDPOINT_READBACK_FAILED, undefined, { transactionCommitted: actionFactories.length > 0 });
        }
      }
      this.issuedOwnershipReceipts.delete(receipt.ownershipToken);
      this.requestRefresh("baked-cleanup-readback").catch(() => undefined);
      return Object.freeze({
        ok: true,
        verified: true,
        oneUndoStep: actionFactories.length > 0,
        changed: actionFactories.length > 0,
        removedKeyCount: actionFactories.length,
        capability: reason(REASON.OK),
      });
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
      this.bindingDescriptors.clear();
      this.issuedOwnershipReceipts.clear();
      this.subscribers.clear();
    }
  }

  return Object.freeze({
    PremiereCurvesAdapter,
    CurvesAdapterError,
    REASON,
    NATIVE_MODES,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    MAX_BAKED_KEYS_PER_BINDING,
    BAKED_RUNTIME_PROOF_VERSION,
    normalizeTickString,
    compareTickStrings,
    addTickStrings,
    subtractTickStrings,
    mediaPlayheadTicks,
    sortedUniqueTickStrings,
    exactPositiveIntegerString,
    tickModulo,
    bracketTickTimes,
    valueKind,
    valueFingerprint,
    interpolationModeValue,
    availableNativeModes,
    validateBakedRuntimeProof,
    bindingIdForIdentity,
  });
});
