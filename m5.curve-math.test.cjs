// @ts-nocheck
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const math = require("./src/curves/oracle-curve-math.js");

test("cubic Bezier solver solves x before evaluating y, including flat slopes", () => {
  assert.equal(math.solveCubicBezierY(0, [0.42, 0, 0.58, 1]), 0);
  assert.equal(math.solveCubicBezierY(1, [0.42, 0, 0.58, 1]), 1);
  assert.ok(Math.abs(math.solveCubicBezierY(0.5, [0.42, 0, 0.58, 1]) - 0.5) < 1e-9);
  assert.ok(Math.abs(math.solveCubicBezierY(0.5, [1, 0, 0, 1]) - 0.5) < 1e-8);
  assert.ok(math.solveCubicBezierY(0.8, [0.34, 1.56, 0.64, 1]) > 1);
  assert.throws(() => math.solveCubicBezierY(0.5, [-0.1, 0, 1, 1]), /between 0 and 1/);
});

test("numeric and PointF interpolation preserve endpoint types and reject unsafe types", () => {
  assert.equal(math.interpolateValue(10, 20, 0.25), 12.5);
  assert.deepEqual(math.interpolateValue({ x: 2, y: -4 }, { x: 10, y: 8 }, 0.25), { x: 4, y: -1 });
  assert.deepEqual(math.interpolateValue({ x: 2, y: -4 }, { x: 10, y: 8 }, 0), { x: 2, y: -4 });
  assert.throws(() => math.interpolateValue(true, false, 0.5), /numeric or PointF/);
  assert.throws(() => math.interpolateValue(1, { x: 1, y: 2 }, 0.5), /numeric or PointF/);
});

test("TickTime comparison remains exact beyond Number.MAX_SAFE_INTEGER", () => {
  assert.equal(math.canonicalTickString({ ticks: "+00090071992547409930002" }), "90071992547409930002");
  assert.equal(math.compareTickTimes("90071992547409930001", "90071992547409930002"), -1);
  assert.equal(math.compareTickTimes("-90071992547409930002", "-90071992547409930001"), -1);
  assert.equal(math.compareTickTimes({ position: { ticks: "42" } }, { ticks: "42" }), 0);
  assert.throws(() => math.canonicalTickString(Number.MAX_SAFE_INTEGER + 10), /safe integers/);
  assert.throws(() => math.canonicalTickString("1".repeat(129)), /precision bound/);
});

test("keyframe bracketing is deterministic before, on, between, and after unsorted keys", () => {
  const base = "9007199254740993000";
  const first = { name: "first", position: { ticks: `${base}1` } };
  const middle = { name: "middle", position: { ticks: `${base}3` } };
  const last = { name: "last", position: { ticks: `${base}5` } };
  const keys = [last, first, middle];
  assert.equal(math.bracketKeyframes(keys, `${base}0`).kind, "before");
  assert.equal(math.bracketKeyframes(keys, `${base}3`).exact, middle);
  const between = math.bracketKeyframes(keys, `${base}4`);
  assert.equal(between.kind, "between");
  assert.equal(between.previous, middle);
  assert.equal(between.next, last);
  assert.equal(between.progress, 0.5);
  assert.equal(math.bracketKeyframes(keys, `${base}6`).kind, "after");
  assert.equal(math.bracketKeyframes([], "0").kind, "empty");
});

test("tick quantization uses exact integer arithmetic and deterministic tie handling", () => {
  assert.equal(math.quantizeTick("90071992547409930006", "10", "90071992547409930000"), "90071992547409930010");
  assert.equal(math.quantizeTick("15", "10"), "20");
  assert.equal(math.quantizeTick("-15", "10"), "-20");
  assert.equal(math.quantizeTick("-11", "10", "0", "floor"), "-20");
  assert.equal(math.quantizeTick("11", "10", "0", "ceil"), "20");
});

test("adaptive sample planning is bounded, quantized, deterministic, and collision free", () => {
  const lowBudget = math.planAdaptiveSamples({
    startTick: "90071992547409930000",
    endTick: "90071992547409930700",
    quantizationTicks: "10",
    budget: 2,
    controlPoints: [0.42, 0, 0.58, 1],
  });
  assert.equal(lowBudget.budget, math.MIN_SAMPLE_COUNT);
  assert.ok(lowBudget.plannedSamples >= 2 && lowBudget.plannedSamples <= math.MIN_SAMPLE_COUNT);
  assert.equal(new Set(lowBudget.sampleTicks).size, lowBudget.sampleTicks.length);
  assert.equal(lowBudget.sampleTicks[0], "90071992547409930000");
  assert.equal(lowBudget.sampleTicks.at(-1), "90071992547409930700");
  assert.ok(lowBudget.sampleTicks.slice(1, -1).every((tick) => BigInt(tick) % 10n === 0n));

  const highBudget = math.planAdaptiveSamples({
    startTick: "0",
    endTick: "1000000",
    quantizationTicks: "1",
    budget: 1000,
    controlPoints: [0.34, 1.56, 0.64, 1],
  });
  assert.equal(highBudget.budget, math.MAX_SAMPLE_COUNT);
  assert.ok(highBudget.plannedSamples <= math.MAX_SAMPLE_COUNT);
  assert.ok(highBudget.complexity > lowBudget.complexity);
  assert.deepEqual(highBudget, math.planAdaptiveSamples({
    startTick: "0",
    endTick: "1000000",
    quantizationTicks: "1",
    budget: 1000,
    controlPoints: [0.34, 1.56, 0.64, 1],
  }));
});

test("short quantized ranges retain exact endpoints without duplicate TickTimes", () => {
  const plan = math.planAdaptiveSamples({
    startTick: "100",
    endTick: "105",
    quantizationTicks: "10",
    budget: 32,
    controlPoints: [0.42, 0, 0.58, 1],
  });
  assert.deepEqual(plan.sampleTicks, ["100", "105"]);
  assert.equal(plan.limitedByQuantization, true);
  assert.equal(plan.addedKeyCount, 0);
});

test("baked samples preserve endpoints and occupied user keys", () => {
  const result = math.createBakedCurveSamples({
    startTick: "0",
    endTick: "70",
    quantizationTicks: "10",
    budget: 8,
    minimumSamples: 8,
    controlPoints: [0, 0, 1, 1],
    startValue: { x: 0, y: 10 },
    endValue: { x: 70, y: 80 },
    occupiedTicks: ["30"],
  });
  assert.deepEqual(result.samples[0], {
    ticks: "0", timeProgress: 0, curveProgress: 0, value: { x: 0, y: 10 }, endpoint: true,
  });
  assert.deepEqual(result.samples.at(-1), {
    ticks: "70", timeProgress: 1, curveProgress: 1, value: { x: 70, y: 80 }, endpoint: true,
  });
  assert.equal(result.samples.some((sample) => sample.ticks === "30"), false);
  assert.deepEqual(result.collisions, [{ ticks: "30", reason: "occupied-user-key-preserved" }]);
  assert.equal(new Set(result.samples.map((sample) => sample.ticks)).size, result.samples.length);
});

test("curve thumbnails are deterministic vector path data with no bitmap payload", () => {
  const first = math.createCurvePathData([0.42, 0, 0.58, 1], { width: 120, height: 72, padding: 0, samples: 24 });
  const second = math.createCurvePathData([0.42, 0, 0.58, 1], { width: 120, height: 72, padding: 0, samples: 24 });
  assert.equal(first, second);
  assert.match(first, /^M0 /);
  assert.match(first, /^M\d/);
  assert.match(first, / L/);
  assert.doesNotMatch(first, /data:|base64|blob:/i);
});
