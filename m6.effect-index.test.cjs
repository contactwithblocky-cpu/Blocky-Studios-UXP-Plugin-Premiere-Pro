// @ts-nocheck -- This focused harness runs in Node; jsconfig targets the UXP browser runtime.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { performance } = require("node:perf_hooks");

const indexApi = require("./src/quick-apply/oracle-effect-index.js");

test("effect index preserves the exact host video mapping, audio grouping, and duplicate occurrences", () => {
  const index = indexApi.createEffectIndex({
    hostVersion: "26.3.0",
    generatedAt: 100,
    videoDisplayNames: ["Gaussian Blur", "Gaussian Blur", "Crop"],
    videoMatchNames: ["AE.ADBE Gaussian Blur 2", "AE.ADBE Gaussian Blur 2", "AE.ADBE Crop"],
    audioDisplayNames: ["DeNoise", "DeNoise"],
  });

  assert.deepEqual(index.counts, { total: 5, video: 3, audio: 2 });
  assert.deepEqual(index.entries.map((entry) => [entry.type, entry.displayName, entry.matchName, entry.occurrence]), [
    ["video", "Gaussian Blur", "AE.ADBE Gaussian Blur 2", 0],
    ["video", "Gaussian Blur", "AE.ADBE Gaussian Blur 2", 1],
    ["video", "Crop", "AE.ADBE Crop", 0],
    ["audio", "DeNoise", null, 0],
    ["audio", "DeNoise", null, 1],
  ]);
  assert.equal(new Set(index.entries.map((entry) => entry.effectId)).size, 5);
  assert.equal(index.hostVersion, "26.3.0");
});

test("effect index refuses to guess a mismatched video display/match mapping", () => {
  assert.throws(() => indexApi.createEffectIndex({
    hostVersion: "26.3.0",
    videoDisplayNames: ["Crop", "Blur"],
    videoMatchNames: ["AE.ADBE Crop"],
    audioDisplayNames: [],
  }), (error) => error.code === "VIDEO_EFFECT_MAPPING_MISMATCH");
});

test("cache validation rejects stale host versions, forged IDs, and broken duplicate ordering", () => {
  const index = indexApi.createEffectIndex({
    hostVersion: "26.3.0",
    generatedAt: 100,
    videoDisplayNames: ["Crop", "Crop"],
    videoMatchNames: ["AE.ADBE Crop", "AE.ADBE Crop"],
    audioDisplayNames: [],
  });
  const serialized = JSON.parse(JSON.stringify(index));
  assert.ok(indexApi.validateEffectIndex(serialized, { hostVersion: "26.3.0" }));
  assert.equal(indexApi.validateEffectIndex(serialized, { hostVersion: "26.4.0" }), null);

  const forged = JSON.parse(JSON.stringify(index));
  forged.entries[0].effectId = "forged";
  assert.equal(indexApi.validateEffectIndex(forged, { hostVersion: "26.3.0" }), null);

  const duplicateGap = JSON.parse(JSON.stringify(index));
  duplicateGap.entries[1].occurrence = 9;
  duplicateGap.entries[1].effectId = indexApi.effectIdFor("video", "Crop", "AE.ADBE Crop", 9);
  assert.equal(indexApi.validateEffectIndex(duplicateGap, { hostVersion: "26.3.0" }), null);
});

test("bounded typo-tolerant search finds host effects without inventing categories", () => {
  const index = indexApi.createEffectIndex({
    hostVersion: "26.3.0",
    videoDisplayNames: ["Gaussian Blur", "Lumetri Color", "Crop"],
    videoMatchNames: ["AE.ADBE Gaussian Blur 2", "AE.ADBE Lumetri", "AE.ADBE Crop"],
    audioDisplayNames: ["DeNoise", "Studio Reverb"],
  });
  const typo = indexApi.searchEffectIndex(index, "gausian blr", { limit: 10 });
  assert.equal(typo[0].displayName, "Gaussian Blur");
  assert.equal(Object.prototype.hasOwnProperty.call(typo[0], "category"), false);
  assert.deepEqual(indexApi.searchEffectIndex(index, "reverb", { type: "audio" }).map((entry) => entry.displayName), ["Studio Reverb"]);
  assert.equal(indexApi.searchEffectIndex(index, "reverb", { type: "video" }).length, 0);
});

test("5,000-effect local search stays inside the Milestone 6 keystroke budget", () => {
  const videoDisplayNames = [];
  const videoMatchNames = [];
  for (let index = 0; index < 4000; index += 1) {
    videoDisplayNames.push(`Installed Video Effect ${String(index).padStart(4, "0")}`);
    videoMatchNames.push(`ORACLE.TEST.Video.${index}`);
  }
  const audioDisplayNames = Array.from({ length: 1000 }, (_, index) => `Installed Audio Effect ${String(index).padStart(4, "0")}`);
  const effectIndex = indexApi.createEffectIndex({ hostVersion: "26.3.0", videoDisplayNames, videoMatchNames, audioDisplayNames });
  indexApi.searchEffectIndex(effectIndex, "video effect 3999", { limit: 60 });
  const start = performance.now();
  const results = indexApi.searchEffectIndex(effectIndex, "video effect 3999", { limit: 60 });
  const elapsedMs = performance.now() - start;
  assert.equal(results[0].displayName, "Installed Video Effect 3999");
  assert.ok(elapsedMs < 50, `expected search under 50 ms, measured ${elapsedMs.toFixed(2)} ms`);
});
