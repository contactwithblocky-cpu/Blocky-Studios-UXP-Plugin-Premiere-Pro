"use strict";

(function exposeOracleCurveMath(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleCurveMath", api);
})(typeof window !== "undefined" ? window : null, function createOracleCurveMathApi() {
  const MIN_SAMPLE_COUNT = 8;
  const MAX_SAMPLE_COUNT = 240;
  const DEFAULT_SAMPLE_BUDGET = 96;
  const DEFAULT_CONTROL_POINTS = Object.freeze([0.25, 0.1, 0.25, 1]);
  const DECIMAL_INTEGER_PATTERN = /^[+-]?\d+$/;

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, Math.trunc(number)))
      : fallback;
  }

  function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number.`);
    return number;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  /** @param {any} value */
  function normalizeControlPoints(value = DEFAULT_CONTROL_POINTS) {
    const source = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? [value.x1, value.y1, value.x2, value.y2]
        : null;
    if (!source || source.length !== 4) {
      throw new TypeError("Cubic control points must contain x1, y1, x2, and y2.");
    }
    const points = source.map((entry, index) => finiteNumber(entry, `Control point ${index + 1}`));
    if (points[0] < 0 || points[0] > 1 || points[2] < 0 || points[2] > 1) {
      throw new RangeError("Cubic x control points must remain between 0 and 1.");
    }
    if (Math.abs(points[1]) > 1000 || Math.abs(points[3]) > 1000) {
      throw new RangeError("Cubic y control points exceed the Blocky Studios safe range.");
    }
    return points;
  }

  function cubicCoordinate(t, first, second) {
    const inverse = 1 - t;
    return (3 * inverse * inverse * t * first) +
      (3 * inverse * t * t * second) +
      (t * t * t);
  }

  function cubicDerivative(t, first, second) {
    const inverse = 1 - t;
    return (3 * inverse * inverse * first) +
      (6 * inverse * t * (second - first)) +
      (3 * t * t * (1 - second));
  }

  /**
   * Solve a CSS-style cubic Bezier's x coordinate for t, then evaluate y.
   * The hybrid Newton/bisection solver stays deterministic around flat slopes.
   */
  function solveCubicBezierY(progress, controlPoints = DEFAULT_CONTROL_POINTS, options = {}) {
    const x = clamp(finiteNumber(progress, "Progress"), 0, 1);
    if (x === 0 || x === 1) return x;
    const [x1, y1, x2, y2] = normalizeControlPoints(controlPoints);
    const epsilon = clamp(Number(options.epsilon) || 1e-10, 1e-13, 1e-4);
    let lower = 0;
    let upper = 1;
    let t = x;

    for (let iteration = 0; iteration < 14; iteration += 1) {
      const currentX = cubicCoordinate(t, x1, x2);
      const error = currentX - x;
      if (Math.abs(error) <= epsilon) return cubicCoordinate(t, y1, y2);
      if (error > 0) upper = t;
      else lower = t;
      const derivative = cubicDerivative(t, x1, x2);
      const candidate = Math.abs(derivative) > 1e-12 ? t - (error / derivative) : NaN;
      t = Number.isFinite(candidate) && candidate > lower && candidate < upper
        ? candidate
        : (lower + upper) / 2;
    }

    for (let iteration = 0; iteration < 48; iteration += 1) {
      t = (lower + upper) / 2;
      const error = cubicCoordinate(t, x1, x2) - x;
      if (Math.abs(error) <= epsilon) break;
      if (error > 0) upper = t;
      else lower = t;
    }
    return cubicCoordinate(t, y1, y2);
  }

  function isPointF(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Number.isFinite(Number(value.x)) &&
      Number.isFinite(Number(value.y)),
    );
  }

  function valueKind(value) {
    if (typeof value === "number" && Number.isFinite(value)) return "number";
    if (isPointF(value)) return "point";
    return "unsupported";
  }

  function interpolateValue(startValue, endValue, progress) {
    const amount = finiteNumber(progress, "Interpolation progress");
    const startKind = valueKind(startValue);
    const endKind = valueKind(endValue);
    if (startKind !== endKind || startKind === "unsupported") {
      throw new TypeError("Blocky Studios baked curves support matching numeric or PointF endpoint values only.");
    }
    if (amount === 0) {
      return startKind === "point" ? { x: Number(startValue.x), y: Number(startValue.y) } : startValue;
    }
    if (amount === 1) {
      return endKind === "point" ? { x: Number(endValue.x), y: Number(endValue.y) } : endValue;
    }
    if (startKind === "number") return startValue + ((endValue - startValue) * amount);
    return {
      x: Number(startValue.x) + ((Number(endValue.x) - Number(startValue.x)) * amount),
      y: Number(startValue.y) + ((Number(endValue.y) - Number(startValue.y)) * amount),
    };
  }

  function tickCandidate(value) {
    if (value && typeof value === "object") {
      if (Object.prototype.hasOwnProperty.call(value, "ticks") || "ticks" in value) return value.ticks;
      if (Object.prototype.hasOwnProperty.call(value, "position") || "position" in value) return tickCandidate(value.position);
      if (Object.prototype.hasOwnProperty.call(value, "time") || "time" in value) return tickCandidate(value.time);
      if (Object.prototype.hasOwnProperty.call(value, "tickTime") || "tickTime" in value) return tickCandidate(value.tickTime);
    }
    return value;
  }

  function canonicalTickString(value) {
    const candidate = tickCandidate(value);
    let raw;
    if (typeof candidate === "bigint") raw = candidate.toString();
    else if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate)) {
        throw new RangeError("Numeric ticks must be safe integers; pass Premiere TickTime.ticks instead.");
      }
      raw = String(candidate);
    } else {
      raw = String(candidate == null ? "" : candidate).trim();
    }
    if (raw.length > 128) throw new RangeError("TickTime ticks exceed the Blocky Studios safe precision bound.");
    if (!DECIMAL_INTEGER_PATTERN.test(raw)) throw new TypeError("TickTime ticks must be a decimal integer string.");
    let negative = raw[0] === "-";
    const unsigned = raw.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
    if (unsigned === "0") negative = false;
    return `${negative ? "-" : ""}${unsigned}`;
  }

  function compareTickTimes(left, right) {
    const a = canonicalTickString(left);
    const b = canonicalTickString(right);
    if (a === b) return 0;
    const aNegative = a[0] === "-";
    const bNegative = b[0] === "-";
    if (aNegative !== bNegative) return aNegative ? -1 : 1;
    const aDigits = aNegative ? a.slice(1) : a;
    const bDigits = bNegative ? b.slice(1) : b;
    let comparison = aDigits.length === bDigits.length
      ? (aDigits < bDigits ? -1 : 1)
      : (aDigits.length < bDigits.length ? -1 : 1);
    if (aNegative) comparison *= -1;
    return comparison;
  }

  /** @returns {BigIntConstructor} */
  function requireBigInt() {
    if (typeof BigInt !== "function") {
      throw new Error("This UXP runtime does not expose exact BigInt tick arithmetic.");
    }
    return BigInt;
  }

  /** @returns {bigint} */
  function tickBigInt(value) {
    return requireBigInt()(canonicalTickString(value));
  }

  function ratioOfTickRange(value, start, end) {
    const startTick = tickBigInt(start);
    const endTick = tickBigInt(end);
    const valueTick = tickBigInt(value);
    if (endTick === startTick) return 0;
    const scale = requireBigInt()(1000000000000);
    const scaled = ((valueTick - startTick) * scale) / (endTick - startTick);
    return Number(scaled) / 1000000000000;
  }

  function sortKeyframes(keyframes) {
    return (Array.isArray(keyframes) ? keyframes : [])
      .map((keyframe, originalIndex) => ({
        keyframe,
        originalIndex,
        ticks: canonicalTickString(keyframe),
      }))
      .sort((left, right) => compareTickTimes(left.ticks, right.ticks) || (left.originalIndex - right.originalIndex));
  }

  function bracketKeyframes(keyframes, targetTime) {
    const entries = sortKeyframes(keyframes);
    const targetTicks = canonicalTickString(targetTime);
    if (entries.length === 0) return { kind: "empty", targetTicks, previous: null, next: null };

    let lower = 0;
    let upper = entries.length;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (compareTickTimes(entries[middle].ticks, targetTicks) < 0) lower = middle + 1;
      else upper = middle;
    }

    if (lower < entries.length && compareTickTimes(entries[lower].ticks, targetTicks) === 0) {
      return {
        kind: "on",
        targetTicks,
        previous: entries[lower].keyframe,
        next: entries[lower].keyframe,
        exact: entries[lower].keyframe,
        exactIndex: entries[lower].originalIndex,
        progress: 0,
      };
    }
    if (lower === 0) {
      return { kind: "before", targetTicks, previous: null, next: entries[0].keyframe, progress: 0 };
    }
    if (lower === entries.length) {
      return { kind: "after", targetTicks, previous: entries[entries.length - 1].keyframe, next: null, progress: 1 };
    }
    const previous = entries[lower - 1];
    const next = entries[lower];
    return {
      kind: "between",
      targetTicks,
      previous: previous.keyframe,
      next: next.keyframe,
      previousTicks: previous.ticks,
      nextTicks: next.ticks,
      progress: ratioOfTickRange(targetTicks, previous.ticks, next.ticks),
    };
  }

  /** @param {bigint} value */
  function absoluteBigInt(value) {
    const zero = requireBigInt()(0);
    return value < zero ? -value : value;
  }

  function quantizeTick(value, quantum = "1", origin = "0", mode = "nearest") {
    const tick = tickBigInt(value);
    const unit = tickBigInt(quantum);
    const base = tickBigInt(origin);
    const zero = requireBigInt()(0);
    const one = requireBigInt()(1);
    const two = requireBigInt()(2);
    if (unit <= zero) throw new RangeError("Tick quantization must be greater than zero.");
    const relative = tick - base;
    let quotient = relative / unit;
    const remainder = relative % unit;
    if (mode === "floor" && remainder !== zero && relative < zero) quotient -= one;
    else if (mode === "ceil" && remainder !== zero && relative > zero) quotient += one;
    else if (mode === "nearest") {
      if (absoluteBigInt(remainder) * two >= unit) quotient += relative < zero ? -one : one;
    } else if (mode !== "floor" && mode !== "ceil" && mode !== "toward-zero") {
      throw new RangeError("Tick quantization mode must be nearest, floor, ceil, or toward-zero.");
    }
    return (base + (quotient * unit)).toString();
  }

  function estimateCurveComplexity(controlPoints) {
    const points = normalizeControlPoints(controlPoints);
    const values = [];
    const segments = 24;
    for (let index = 0; index <= segments; index += 1) {
      values.push(solveCubicBezierY(index / segments, points));
    }
    let variation = 0;
    let curvature = 0;
    let overshoot = 0;
    for (let index = 1; index < values.length; index += 1) {
      variation += Math.abs(values[index] - values[index - 1]);
      if (index < values.length - 1) {
        curvature += Math.abs(values[index + 1] - (2 * values[index]) + values[index - 1]);
      }
      overshoot = Math.max(overshoot, Math.max(0, -values[index], values[index] - 1));
    }
    return clamp(((Math.max(0, variation - 1) * 0.8) + (curvature * 1.5) + (overshoot * 1.5)), 0, 8);
  }

  /**
   * @param {bigint} span
   * @param {bigint} quantum
   * @param {number} cap
   */
  function cappedSlotCount(span, quantum, cap) {
    const BigIntConstructor = requireBigInt();
    const zero = BigIntConstructor(0);
    const one = BigIntConstructor(1);
    const capBigInt = BigIntConstructor(cap);
    if (span < zero) return 0;
    const slots = (span / quantum) + one;
    return slots > capBigInt ? cap : Number(slots);
  }

  /**
   * @param {bigint} numerator
   * @param {bigint} denominator
   * @returns {bigint}
   */
  function roundedDivision(numerator, denominator) {
    const BigIntConstructor = requireBigInt();
    const zero = BigIntConstructor(0);
    const one = BigIntConstructor(1);
    const two = BigIntConstructor(2);
    if (denominator <= zero) throw new RangeError("The divisor must be positive.");
    let quotient = numerator / denominator;
    const remainder = numerator % denominator;
    if (absoluteBigInt(remainder) * two >= denominator) quotient += numerator < zero ? -one : one;
    return quotient;
  }

  function planAdaptiveSamples(options = {}) {
    const points = normalizeControlPoints(options.controlPoints || options.cubicControlPoints || DEFAULT_CONTROL_POINTS);
    const startTick = tickBigInt(options.startTick == null ? "0" : options.startTick);
    const endTick = tickBigInt(options.endTick == null ? "1" : options.endTick);
    const quantum = tickBigInt(options.quantizationTicks == null ? "1" : options.quantizationTicks);
    const zero = requireBigInt()(0);
    if (endTick <= startTick) throw new RangeError("The baked curve end TickTime must be after its start TickTime.");
    if (quantum <= zero) throw new RangeError("Tick quantization must be greater than zero.");
    const budget = boundedInteger(options.budget, DEFAULT_SAMPLE_BUDGET, MIN_SAMPLE_COUNT, MAX_SAMPLE_COUNT);
    const minimum = Math.min(
      budget,
      boundedInteger(options.minimumSamples, MIN_SAMPLE_COUNT, MIN_SAMPLE_COUNT, MAX_SAMPLE_COUNT),
    );
    const span = endTick - startTick;
    const availableSlots = cappedSlotCount(span, quantum, budget);
    const complexity = estimateCurveComplexity(points);
    const durationTarget = Math.min(40, Math.max(minimum, Math.ceil(Math.sqrt(availableSlots) * 3)));
    const curvatureTarget = minimum + Math.ceil(complexity * 22);
    const requestedSamples = Math.min(budget, Math.max(minimum, durationTarget, curvatureTarget));
    const targetSamples = Math.max(2, Math.min(requestedSamples, availableSlots));
    const divisions = requireBigInt()(Math.max(1, targetSamples - 1));
    const ticks = [];
    const seen = new Set();
    let duplicateCount = 0;

    /** @param {bigint} tick */
    function addTick(tick) {
      const key = tick.toString();
      if (seen.has(key)) {
        duplicateCount += 1;
        return;
      }
      seen.add(key);
      ticks.push(key);
    }

    addTick(startTick);
    for (let index = 1; index < targetSamples - 1; index += 1) {
      const rawOffset = roundedDivision(span * requireBigInt()(index), divisions);
      const quantizedOffset = roundedDivision(rawOffset, quantum) * quantum;
      const tick = startTick + quantizedOffset;
      if (tick <= startTick || tick >= endTick) {
        duplicateCount += 1;
        continue;
      }
      addTick(tick);
    }
    addTick(endTick);
    ticks.sort(compareTickTimes);
    return {
      startTick: startTick.toString(),
      endTick: endTick.toString(),
      quantizationTicks: quantum.toString(),
      budget,
      minimumSamples: minimum,
      requestedSamples,
      plannedSamples: ticks.length,
      addedKeyCount: Math.max(0, ticks.length - 2),
      duplicateCount,
      limitedByQuantization: availableSlots < requestedSamples,
      complexity,
      sampleTicks: ticks,
    };
  }

  function createBakedCurveSamples(options = {}) {
    const points = normalizeControlPoints(options.controlPoints || options.cubicControlPoints || DEFAULT_CONTROL_POINTS);
    const startValue = options.startValue;
    const endValue = options.endValue;
    if (valueKind(startValue) === "unsupported" || valueKind(startValue) !== valueKind(endValue)) {
      throw new TypeError("Baked curve endpoints must be matching numeric or PointF values.");
    }
    const plan = planAdaptiveSamples({ ...options, controlPoints: points });
    const occupied = new Set((Array.isArray(options.occupiedTicks) ? options.occupiedTicks.slice(0, 10000) : [])
      .map(canonicalTickString));
    const collisions = [];
    const samples = [];
    const lastIndex = plan.sampleTicks.length - 1;
    for (let index = 0; index < plan.sampleTicks.length; index += 1) {
      const ticks = plan.sampleTicks[index];
      const endpoint = index === 0 || index === lastIndex;
      if (!endpoint && occupied.has(ticks)) {
        collisions.push({ ticks, reason: "occupied-user-key-preserved" });
        continue;
      }
      const timeProgress = endpoint
        ? (index === 0 ? 0 : 1)
        : ratioOfTickRange(ticks, plan.startTick, plan.endTick);
      const curveProgress = endpoint ? timeProgress : solveCubicBezierY(timeProgress, points);
      samples.push({
        ticks,
        timeProgress,
        curveProgress,
        value: endpoint
          ? interpolateValue(startValue, endValue, timeProgress)
          : interpolateValue(startValue, endValue, curveProgress),
        endpoint,
      });
    }
    return {
      controlPoints: points.slice(),
      samples,
      addedKeyCount: samples.filter((sample) => !sample.endpoint).length,
      collisions,
      collisionCount: collisions.length + plan.duplicateCount,
      plan,
    };
  }

  function formatPathNumber(value) {
    const rounded = Math.round(value * 1000) / 1000;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }

  function createCurvePathData(controlPoints, options = {}) {
    const points = normalizeControlPoints(controlPoints);
    const width = clamp(Number(options.width) || 160, 16, 4096);
    const height = clamp(Number(options.height) || 96, 16, 4096);
    const suppliedPadding = Number(options.padding);
    const padding = clamp(Number.isFinite(suppliedPadding) ? suppliedPadding : 6, 0, Math.min(width, height) / 3);
    const samples = boundedInteger(options.samples, 48, 16, 256);
    const minimumY = Number.isFinite(Number(options.minimumY)) ? Number(options.minimumY) : -0.25;
    const maximumY = Number.isFinite(Number(options.maximumY)) ? Number(options.maximumY) : 1.25;
    if (maximumY <= minimumY) throw new RangeError("Thumbnail maximumY must be greater than minimumY.");
    const drawWidth = width - (padding * 2);
    const drawHeight = height - (padding * 2);
    const commands = [];
    for (let index = 0; index <= samples; index += 1) {
      const xProgress = index / samples;
      const yProgress = solveCubicBezierY(xProgress, points);
      const x = padding + (xProgress * drawWidth);
      const normalizedY = (yProgress - minimumY) / (maximumY - minimumY);
      const y = padding + ((1 - normalizedY) * drawHeight);
      commands.push(`${index === 0 ? "M" : "L"}${formatPathNumber(x)} ${formatPathNumber(y)}`);
    }
    return commands.join(" ");
  }

  return {
    MIN_SAMPLE_COUNT,
    MAX_SAMPLE_COUNT,
    DEFAULT_SAMPLE_BUDGET,
    DEFAULT_CONTROL_POINTS,
    normalizeControlPoints,
    cubicCoordinate,
    solveCubicBezierY,
    isPointF,
    valueKind,
    interpolateValue,
    canonicalTickString,
    compareTickTimes,
    ratioOfTickRange,
    sortKeyframes,
    bracketKeyframes,
    quantizeTick,
    estimateCurveComplexity,
    planAdaptiveSamples,
    createBakedCurveSamples,
    createCurvePathData,
  };
});
