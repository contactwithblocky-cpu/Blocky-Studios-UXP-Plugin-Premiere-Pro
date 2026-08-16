// @ts-nocheck
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const domainApi = require("./src/quick-apply/oracle-quick-apply-domain.js");

function effect(effectId, type, displayName, matchName = null, occurrence = 0, category = "") {
  return { effectId, type, displayName, matchName, occurrence, category };
}

function effectIndex(entries = []) {
  return {
    schema: "oracle-premiere-effect-index",
    version: 1,
    hostVersion: "26.3.0",
    generatedAt: Date.now(),
    entries,
  };
}

function selection(mediaKinds = ["video"]) {
  return mediaKinds.map((mediaKind, index) => ({
    trackItemId: `clip-${index}`,
    revision: `revision-${index}`,
    mediaKind,
    display: { name: `Clip ${index + 1}` },
  }));
}

function adapterSnapshot(options = {}) {
  return {
    revision: 1,
    state: options.state || "ready",
    message: options.message || "Premiere selection ready.",
    selection: options.selection || selection(),
    effectIndex: options.index || effectIndex([
      effect("blur-video", "video", "Gaussian Blur", "AE.ADBE Gaussian Blur 2"),
      effect("gain-audio", "audio", "Audio Gain"),
    ]),
    capabilities: { effectIndex: { supported: true } },
  };
}

function createAdapter(snapshot = adapterSnapshot()) {
  const subscribers = new Set();
  const calls = { start: 0, visible: [], active: [], refresh: [], planEffect: [], applyEffect: [], planRecipe: [], applyRecipe: [], destroy: 0 };
  const adapter = {
    snapshot,
    calls,
    start() { calls.start += 1; return this; },
    subscribe(listener) { subscribers.add(listener); listener(this.snapshot); return () => subscribers.delete(listener); },
    getSnapshot() { return this.snapshot; },
    setVisible(value) { calls.visible.push(Boolean(value)); },
    setActive(value) { calls.active.push(Boolean(value)); },
    async refreshEffectIndex(options) { calls.refresh.push(["index", options]); return this.snapshot.effectIndex; },
    async requestRefresh(reason) { calls.refresh.push(["selection", reason]); return this.snapshot; },
    async planEffectApplication(effectEntry, options) {
      const plan = { kind: "effect-plan", effectEntry, options, executable: true };
      calls.planEffect.push(plan);
      return plan;
    },
    async applyEffect(plan) {
      calls.applyEffect.push(plan);
      return { ok: true, verified: true, historyEligible: true, addedCount: 1, skippedCount: 0 };
    },
    async planRecipeApplication(recipe, options) {
      const plan = { kind: "recipe-plan", recipe, options, executable: true };
      calls.planRecipe.push(plan);
      return plan;
    },
    async applyRecipe(plan) {
      calls.applyRecipe.push(plan);
      return { ok: true, verified: true, historyEligible: true, addedCount: plan.recipe.steps.length, skippedCount: 0 };
    },
    emit(next) { this.snapshot = next; for (const listener of subscribers) listener(next); },
    destroy() { calls.destroy += 1; },
  };
  return adapter;
}

function memoryStore(initial) {
  const calls = [];
  let state = initial;
  return {
    calls,
    getState() { return state; },
    getLibrary() { return state; },
    async commit(next, reason) { state = next; calls.push({ next, reason }); },
  };
}

function rejectingStore(initial, message = "disk unavailable") {
  let state = initial;
  return {
    getState() { return state; },
    getLibrary() { return state; },
    async commit() { throw new Error(message); },
  };
}

test("M6 effect normalization preserves host mapping, duplicate occurrence, grouping, and absent category truth", () => {
  const input = effectIndex([
    effect("video-a", "video", "Blur", "AE.Blur", 0, "Blur & Sharpen"),
    effect("video-b", "video", "Blur", "AE.Blur", 1, "Blur & Sharpen"),
    effect("audio-a", "audio", "Dynamics", null, 0),
    effect("audio-b", "audio", "Dynamics", null, 1),
  ]);
  const normalized = domainApi.normalizeEffectIndex(input);
  assert.equal(normalized.premiereVersion, "26.3.0");
  assert.equal(normalized.effects.length, 4);
  assert.deepEqual(normalized.effects.map((entry) => [entry.id, entry.mediaType, entry.matchName, entry.occurrence]), [
    ["video-a", "video", "AE.Blur", 0],
    ["video-b", "video", "AE.Blur", 1],
    ["audio-a", "audio", "", 0],
    ["audio-b", "audio", "", 1],
  ]);
  assert.equal(normalized.effects[2].category, "");
  assert.equal(normalized.effects[2].categoryAvailable, false, "Blocky Studios does not invent effect categories absent from the host index");
});

test("M6 grouping preference drives stable domain groups without inventing missing Premiere categories", () => {
  const adapter = createAdapter(adapterSnapshot({ index: effectIndex([
    effect("blur-video", "video", "Gaussian Blur", "AE.Blur", 0, "Blur & Sharpen"),
    effect("gain-audio", "audio", "Audio Gain"),
    effect("crop-video", "video", "Crop", "AE.Crop", 0, "Transform"),
  ]) }));
  const domain = new domainApi.QuickApplyDomain({ adapter, preferences: { grouping: "type" } });
  domain.start();
  let snapshot = domain.getSnapshot();
  assert.equal(snapshot.grouping, "type");
  assert.deepEqual(snapshot.targetGroups.map((group) => [group.id, group.label, group.targets.length]), [
    ["video", "Video effects", 2],
    ["audio", "Audio effects", 1],
  ]);

  domain.setPreferences({ grouping: "category" });
  snapshot = domain.getSnapshot();
  assert.equal(snapshot.grouping, "category");
  assert.deepEqual(snapshot.targetGroups.map((group) => group.label), [
    "Blur & Sharpen",
    "Transform",
    "Category unavailable from Premiere",
  ]);
  assert.equal(snapshot.targetGroups.at(-1).targets[0].effectId, "gain-audio");

  domain.setPreferences({ grouping: "none" });
  snapshot = domain.getSnapshot();
  assert.equal(snapshot.grouping, "none");
  assert.deepEqual(snapshot.targetGroups, []);
  domain.destroy();
});

test("M6 bounded typo-tolerant search returns 5,000-record results within the 50 ms local budget", () => {
  const effects = [];
  for (let index = 0; index < 4999; index += 1) effects.push(effect(`effect-${index}`, index % 2 ? "video" : "audio", `Installed Effect ${index}`, index % 2 ? `AE.Effect.${index}` : null));
  effects.push(effect("gaussian", "video", "Gaussian Blur", "AE.ADBE Gaussian Blur 2"));
  const adapter = createAdapter(adapterSnapshot({ index: effectIndex(effects) }));
  const domain = new domainApi.QuickApplyDomain({ adapter, maxResults: 240 });
  domain.start();
  domain.setQuery("gausian");
  domain.getSnapshot();
  const started = performance.now();
  const snapshot = domain.getSnapshot();
  const elapsed = performance.now() - started;
  assert.equal(snapshot.targets[0].effectId, "gaussian");
  assert.ok(elapsed < 50, `search took ${elapsed.toFixed(2)} ms`);
  assert.ok(snapshot.targets.length <= 240);
  domain.destroy();
});

test("M6 selection normalization exposes mixed and unresolved media without silently claiming compatibility", () => {
  const normalized = domainApi.normalizeSelectionSummary(selection(["video", "audio", "unknown"]));
  assert.deepEqual({ total: normalized.totalCount, video: normalized.videoCount, audio: normalized.audioCount, unknown: normalized.unknownCount }, { total: 3, video: 1, audio: 1, unknown: 1 });
  assert.match(normalized.message, /unresolved media type/i);

  const domain = new domainApi.QuickApplyDomain({ adapter: createAdapter(adapterSnapshot({ selection: selection(["video", "audio", "unknown"]) })) });
  domain.start();
  const target = domain.getSnapshot().targets.find((entry) => entry.effectId === "blur-video");
  assert.equal(target.compatible, true);
  assert.match(target.compatibility.reason, /exact factory and component-chain compatibility is preflighted/i);
  domain.destroy();
});

test("M6 verified effect application uses plan then apply and records Recent only after receipt verification", async () => {
  const stateStore = memoryStore({ favoriteEffectIds: [], recent: [] });
  const adapter = createAdapter();
  const domain = new domainApi.QuickApplyDomain({ adapter, stateStore, now: () => "2026-07-16T02:00:00.000Z" });
  domain.start();
  const result = await domain.applyTarget("effect:blur-video");
  assert.equal(result.ok, true);
  assert.equal(adapter.calls.planEffect.length, 1);
  assert.equal(adapter.calls.applyEffect[0], adapter.calls.planEffect[0]);
  await domain.persistChain;
  assert.equal(stateStore.calls.at(-1).reason, "quick-apply-verified-history");
  assert.equal(stateStore.calls.at(-1).next.recent[0].effectId, "blur-video");
  domain.destroy();
});

test("M6 unverified apply reports failure and never records history", async () => {
  const stateStore = memoryStore({ favoriteEffectIds: [], recent: [] });
  const adapter = createAdapter();
  adapter.applyEffect = async (plan) => {
    adapter.calls.applyEffect.push(plan);
    return { ok: true, verified: false, historyEligible: false, message: "Readback did not match." };
  };
  const domain = new domainApi.QuickApplyDomain({ adapter, stateStore });
  domain.start();
  const result = await domain.applyTarget("effect:blur-video");
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNVERIFIED_APPLY");
  await domain.persistChain;
  assert.equal(stateStore.calls.length, 0);
  assert.match(domain.getSnapshot().actionStatus.message, /readback did not match/i);
  domain.destroy();
});

test("M6 favorites and Recent stay bounded and durable through the provided v3-state facades", async () => {
  assert.equal(domainApi.normalizePersistedState({ recent: [{ id: "legacy-effect" }] }).recent[0].targetId, "effect:legacy-effect", "legacy effect-only history remains readable");
  const stateStore = memoryStore({ favoriteEffectIds: [], recent: [] });
  const adapter = createAdapter();
  const domain = new domainApi.QuickApplyDomain({ adapter, stateStore, preferences: { recentLimit: 5 } });
  domain.start();
  assert.equal(domain.toggleFavorite("effect:blur-video"), true);
  await domain.persistChain;
  assert.deepEqual(stateStore.calls.at(-1).next.favoriteEffectIds, ["blur-video"]);
  assert.equal(domain.getSnapshot().targets.find((entry) => entry.effectId === "blur-video").favorite, true);
  domain.destroy();
});

test("M6 Blocky Studios Recipes validate ordered host effects, indexed values, migration, and JSON-only import/export", () => {
  const recipe = domainApi.normalizeRecipe({
    id: "recipe-one",
    name: "Cinematic Punch",
    favorite: true,
    applyOnce: true,
    effects: [
      { effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2", parameters: [{ index: 0, value: 24 }] },
      { effectId: "gain-audio", type: "audio", displayName: "Audio Gain", parameters: [] },
    ],
  }, 0, { now: "2026-07-16T02:00:00.000Z" });
  assert.equal(domainApi.validateRecipe(recipe).valid, true);
  assert.deepEqual(recipe.steps.map((step) => step.effectId), ["blur-video", "gain-audio"]);
  assert.deepEqual(recipe.steps[0].parameters[0], { id: "0", index: 0, displayName: "0", valueType: "number", value: 24 });
  const serialized = domainApi.exportRecipeLibrary({ recipes: [recipe] }, { now: () => "2026-07-16T02:01:00.000Z" });
  const imported = domainApi.importRecipeLibrary(serialized, { filename: "Blocky Studios-Recipes.json", now: () => "2026-07-16T02:02:00.000Z" });
  assert.equal(imported.recipes.length, 1);
  assert.throws(() => domainApi.importRecipeLibrary(serialized, { filename: "Looks-Like-Recipes.prfpset" }), /proprietary/i);
  const invalid = domainApi.normalizeRecipe({ id: "bad", name: "Unsafe", steps: [{ effectId: "blur-video", type: "video", displayName: "Blur", parameters: [{ id: "opacity", value: 10 }] }] });
  assert.equal(domainApi.validateRecipe(invalid).valid, false, "semantic parameter names without a proven index are rejected");
});

test("M6 recipe Apply Once defaults flow into every step while explicit step overrides win", async () => {
  const inheritedOff = domainApi.normalizeRecipe({
    id: "recipe-apply-once-off",
    name: "Repeat Stack",
    applyOnce: false,
    steps: [
      { effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" },
      { effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2", applyOnce: true },
    ],
  });
  assert.deepEqual(inheritedOff.steps.map((step) => step.applyOnce), [false, true]);

  const inheritedOn = domainApi.normalizeRecipe({
    id: "recipe-apply-once-on",
    name: "Unique Stack",
    applyOnce: true,
    steps: [
      { effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" },
      { effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2", applyOnce: false },
    ],
  });
  assert.deepEqual(inheritedOn.steps.map((step) => step.applyOnce), [true, false]);

  const adapter = createAdapter();
  const recipeStore = memoryStore({ recipes: [inheritedOff] });
  const domain = new domainApi.QuickApplyDomain({ adapter, recipeStore });
  domain.start();
  const applied = await domain.applyTarget("recipe:recipe-apply-once-off");
  assert.equal(applied.ok, true);
  assert.deepEqual(adapter.calls.planRecipe[0].recipe.steps.map((step) => step.applyOnce), [false, true], "the inherited values must survive the domain-to-adapter boundary");
  domain.destroy();
});

test("M6 supported-parameter discovery requires explicit host and descriptor proof", async () => {
  const adapter = createAdapter();
  let received = null;
  adapter.getSupportedParameters = async (effectRef) => {
    received = effectRef;
    return {
      effect: effectRef,
      parameters: [
        { id: "amount", index: 2, displayName: "Amount", valueType: "number", value: 12, minimum: 0, maximum: 100, supported: true },
        { id: "unsafe", index: 3, displayName: "Unsafe", supported: false },
      ],
      capability: { supported: false, code: "PARAMETER_METADATA_UNAVAILABLE" },
      configuration: "explicit-index-and-value-only",
    };
  };
  const domain = new domainApi.QuickApplyDomain({ adapter });
  domain.start();
  const parameters = await domain.getSupportedParameters("blur-video");
  assert.equal(received.effectId, "blur-video");
  assert.equal(received.effect, undefined, "the domain must not wrap the effect ref in an unresolvable { effect } envelope");
  assert.deepEqual(parameters, [], "a PARAMETER_METADATA_UNAVAILABLE host response cannot leak semantic controls");

  adapter.getSupportedParameters = async () => ({
    capability: { supported: true, code: "OK" },
    parameters: [
      { id: "amount", index: 2, displayName: "Amount", valueType: "number", value: 12, minimum: 0, maximum: 100, supported: true },
      { id: "unproven", index: 3, displayName: "Unproven", valueType: "number", value: 5 },
    ],
  });
  assert.deepEqual(await domain.getSupportedParameters("blur-video"), [{
    id: "amount", index: 2, displayName: "Amount", valueType: "number", value: 12,
    minimum: 0, maximum: 100, options: [], reason: "",
  }]);
  domain.destroy();
});

test("M6 recipe JSON import enforces the 2 MB limit on UTF-8 bytes, not JavaScript characters", () => {
  assert.equal(domainApi.utf8ByteLength("Aé😀"), 7);
  assert.equal(domainApi.utf8ByteLength("\ud800"), 3, "an unpaired surrogate encodes as a UTF-8 replacement character");
  const multibyte = "é".repeat(Math.floor(domainApi.MAX_IMPORT_BYTES / 2) + 1);
  assert.ok(multibyte.length < domainApi.MAX_IMPORT_BYTES);
  assert.ok(domainApi.utf8ByteLength(multibyte) > domainApi.MAX_IMPORT_BYTES);
  assert.throws(() => domainApi.importRecipeLibrary(multibyte, { filename: "Blocky Studios-Recipes.json" }), /2 MB limit/i);
});

test("M6 strict recipe bounds match the adapter and oversized JSON imports are rejected, never truncated", () => {
  assert.equal(domainApi.MAX_RECIPE_STEPS, 32);
  assert.equal(domainApi.MAX_PARAMETERS_PER_STEP, 64);
  const baseStep = { effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" };
  const tooManyEffects = { id: "too-many-effects", name: "Too Many Effects", steps: Array.from({ length: 33 }, () => ({ ...baseStep })) };
  const normalizedEffects = domainApi.normalizeRecipe(tooManyEffects);
  assert.equal(normalizedEffects.steps.length, 33, "normalization retains the sentinel overflow so validation cannot silently pass a sliced recipe");
  assert.equal(domainApi.validateRecipe(normalizedEffects).valid, false);

  const tooManyParameters = {
    id: "too-many-parameters",
    name: "Too Many Parameters",
    steps: [{ ...baseStep, parameters: Array.from({ length: 65 }, (_, index) => ({ index, value: index })) }],
  };
  assert.equal(domainApi.validateRecipe(domainApi.normalizeRecipe(tooManyParameters)).valid, false);

  const serialized = JSON.stringify({
    schema: domainApi.RECIPE_LIBRARY_SCHEMA,
    version: domainApi.RECIPE_LIBRARY_VERSION,
    recipes: [domainApi.normalizeRecipe({ id: "valid", name: "Valid", steps: [baseStep] }), tooManyEffects],
  });
  assert.throws(() => domainApi.importRecipeLibrary(serialized, { filename: "Blocky Studios-Recipes.json" }), /32-effect limit/i, "one valid record must not make an oversized sibling disappear through slicing/filtering");
  assert.throws(() => domainApi.exportRecipeLibrary({ recipes: [tooManyParameters] }), /64-parameter limit/i);
});

test("M6 recipe CRUD persists ordered stacks and applies through the honest two-stage adapter boundary", async () => {
  let id = 0;
  const recipeStore = memoryStore({ recipes: [] });
  const adapter = createAdapter(adapterSnapshot({ selection: selection(["video", "audio"]) }));
  const domain = new domainApi.QuickApplyDomain({
    adapter,
    recipeStore,
    idFactory: () => `recipe-${++id}`,
    now: () => "2026-07-16T02:00:00.000Z",
  });
  domain.start();
  const created = await domain.saveRecipe({
    name: "Video + Sound",
    steps: [
      { effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" },
      { effectId: "gain-audio", type: "audio", displayName: "Audio Gain" },
    ],
  });
  assert.equal(created.ok, true);
  assert.equal(recipeStore.calls.at(-1).reason, "quick-apply-recipe-create");
  const applied = await domain.applyTarget(`recipe:${created.recipe.id}`);
  assert.equal(applied.ok, true);
  assert.equal(adapter.calls.planRecipe[0].recipe.steps.length, 2);
  assert.equal(adapter.calls.applyRecipe[0], adapter.calls.planRecipe[0]);
  const duplicate = await domain.duplicateRecipe(created.recipe.id, "Video + Sound Copy");
  assert.equal(duplicate.ok, true);
  assert.equal((await domain.moveRecipe(duplicate.recipe.id, -1)).ok, true);
  assert.equal((await domain.deleteRecipe(created.recipe.id)).ok, true);
  domain.destroy();
});

test("M6 adapter receipts retain committed, partial-failure, stage, Undo, and skipped boundaries", async () => {
  const adapter = createAdapter();
  adapter.applyEffect = async () => ({
    ok: true,
    verified: true,
    historyEligible: true,
    addedCount: 1,
    skippedCount: 1,
    skipped: [{ code: "MEDIA_TYPE_INCOMPATIBLE", trackItemId: "clip-audio" }],
    transactionCommitted: true,
    partialFailure: false,
    partialFailureBoundary: null,
    stage: "complete",
    undoSteps: 1,
  });
  const domain = new domainApi.QuickApplyDomain({ adapter, stateStore: memoryStore({ recent: [] }) });
  domain.start();
  const success = await domain.applyTarget("effect:blur-video");
  assert.deepEqual({
    transactionCommitted: success.transactionCommitted,
    partialFailure: success.partialFailure,
    boundary: success.partialFailureBoundary,
    stage: success.stage,
    undoSteps: success.undoSteps,
    skipped: success.skipped,
  }, {
    transactionCommitted: true,
    partialFailure: false,
    boundary: null,
    stage: "complete",
    undoSteps: 1,
    skipped: [{ code: "MEDIA_TYPE_INCOMPATIBLE", trackItemId: "clip-audio" }],
  });

  adapter.applyEffect = async () => {
    const error = new Error("Component readback failed after commit.");
    error.code = "COMPONENT_READBACK_FAILED";
    error.details = {
      transactionCommitted: true,
      partialFailure: true,
      partialFailureBoundary: "component-actions-committed-readback-unverified",
      stage: "component-readback",
      undoSteps: 1,
      skipped: [{ code: "MEDIA_TYPE_INCOMPATIBLE", trackItemId: "clip-audio" }],
    };
    throw error;
  };
  const thrown = await domain.applyTarget("effect:blur-video");
  assert.equal(thrown.ok, false);
  assert.equal(thrown.transactionCommitted, true);
  assert.equal(thrown.partialFailure, true);
  assert.equal(thrown.partialFailureBoundary, "component-actions-committed-readback-unverified");
  assert.equal(thrown.stage, "component-readback");
  assert.equal(thrown.undoSteps, 1);
  assert.deepEqual(thrown.skipped, [{ code: "MEDIA_TYPE_INCOMPATIBLE", trackItemId: "clip-audio" }]);
  assert.deepEqual(thrown.details, errorDetails(thrown), "the original adapter details remain available as a nested receipt too");
  domain.destroy();
});

function errorDetails(result) {
  return {
    transactionCommitted: result.transactionCommitted,
    partialFailure: result.partialFailure,
    partialFailureBoundary: result.partialFailureBoundary,
    stage: result.stage,
    undoSteps: result.undoSteps,
    skipped: result.skipped,
  };
}

test("M6 returned partial recipe receipts remain exact instead of collapsing to a generic unverified error", async () => {
  const recipeStore = memoryStore({ recipes: [{
    id: "partial-recipe",
    name: "Partial Recipe",
    steps: [{ effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" }],
  }] });
  const adapter = createAdapter();
  adapter.applyRecipe = async () => ({
    ok: false,
    verified: false,
    changed: true,
    committed: true,
    historyEligible: false,
    partialFailure: true,
    partialFailureBoundary: "component-stack-committed-before-parameter-values",
    failedStage: "parameter-readback",
    undoSteps: 2,
    skippedCount: 1,
    skipped: [{ code: "DUPLICATE_PREVENTED", stepIndex: 0 }],
    error: { code: "PARAMETER_READBACK_FAILED", message: "Parameter did not retain the requested value." },
  });
  const domain = new domainApi.QuickApplyDomain({ adapter, recipeStore });
  domain.start();
  const result = await domain.applyTarget("recipe:partial-recipe");
  assert.equal(result.ok, false);
  assert.equal(result.code, "PARAMETER_READBACK_FAILED");
  assert.equal(result.committed, true);
  assert.equal(result.partialFailure, true);
  assert.equal(result.partialFailureBoundary, "component-stack-committed-before-parameter-values");
  assert.equal(result.failedStage, "parameter-readback");
  assert.equal(result.undoSteps, 2);
  assert.deepEqual(result.skipped, [{ code: "DUPLICATE_PREVENTED", stepIndex: 0 }]);
  domain.destroy();
});

test("M6 persistence rejection is reported and rolled back without misreporting host mutation truth", async () => {
  const adapter = createAdapter();
  const failedRecipeDomain = new domainApi.QuickApplyDomain({ adapter, recipeStore: rejectingStore({ recipes: [] }, "recipe store denied") });
  failedRecipeDomain.start();
  const saved = await failedRecipeDomain.saveRecipe({
    name: "Cannot Persist",
    steps: [{ effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" }],
  });
  assert.equal(saved.ok, false);
  assert.equal(saved.code, "PERSISTENCE_FAILED");
  assert.match(saved.message, /recipe store denied/i);
  assert.equal(failedRecipeDomain.getSnapshot().library.recipes.length, 0, "the rejected optimistic recipe must be rolled back");
  const importPayload = domainApi.exportRecipeLibrary({ recipes: [domainApi.normalizeRecipe({
    id: "import-rejected",
    name: "Import Rejected",
    steps: [{ effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" }],
  })] });
  const imported = await failedRecipeDomain.importRecipes(importPayload, { filename: "Blocky Studios-Recipes.json" });
  assert.equal(imported.ok, false);
  assert.equal(imported.code, "PERSISTENCE_FAILED");
  assert.equal(failedRecipeDomain.getSnapshot().library.recipes.length, 0, "a rejected import must not survive in the in-memory library");
  failedRecipeDomain.destroy();

  const failedHistoryDomain = new domainApi.QuickApplyDomain({ adapter: createAdapter(), stateStore: rejectingStore({ recent: [] }, "history store denied") });
  failedHistoryDomain.start();
  const applied = await failedHistoryDomain.applyTarget("effect:blur-video");
  assert.equal(applied.ok, true, "Premiere's already-verified host mutation remains truthful");
  assert.deepEqual(applied.persistence, { ok: false, code: "PERSISTENCE_FAILED" });
  assert.match(applied.message, /Recent history could not be saved/i);
  assert.equal(failedHistoryDomain.getSnapshot().targets.find((entry) => entry.effectId === "blur-video").recent, false);
  failedHistoryDomain.destroy();
});

test("M6 verified Blocky Studios Recipe applications participate in durable Recent history", async () => {
  const stateStore = memoryStore({ recent: [] });
  const recipeStore = memoryStore({ recipes: [{
    id: "recent-recipe",
    name: "Recent Recipe",
    steps: [{ effectId: "blur-video", type: "video", displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" }],
  }] });
  const domain = new domainApi.QuickApplyDomain({ adapter: createAdapter(), stateStore, recipeStore, now: () => "2026-07-16T03:00:00.000Z" });
  domain.start();
  const result = await domain.applyTarget("recipe:recent-recipe");
  assert.equal(result.ok, true);
  assert.deepEqual(stateStore.calls.at(-1).next.recent[0], {
    kind: "recipe",
    targetId: "recipe:recent-recipe",
    effectId: "",
    recipeId: "recent-recipe",
    usedAt: "2026-07-16T03:00:00.000Z",
    verifiedCount: 1,
  });
  domain.setScope("recent");
  assert.deepEqual(domain.getSnapshot().targets.map((target) => target.id), ["recipe:recent-recipe"]);
  domain.destroy();
});

test("M6 explicit refresh uses the host-derived index rebuild and selection refresh APIs", async () => {
  const adapter = createAdapter();
  const domain = new domainApi.QuickApplyDomain({ adapter });
  domain.start();
  const result = await domain.refreshIndex("user");
  assert.equal(result.ok, true);
  assert.equal(adapter.calls.refresh[0][0], "index");
  assert.equal(adapter.calls.refresh[0][1].force, true);
  assert.deepEqual(adapter.calls.refresh[1], ["selection", "effect-index-refresh"]);
  domain.destroy();
});

test("M6 lifecycle forwards visibility/activation and owned teardown without duplicate services", () => {
  const adapter = createAdapter();
  const domain = new domainApi.QuickApplyDomain({ adapter, ownsAdapter: true });
  domain.start();
  let emissions = 0;
  const unsubscribe = domain.subscribe(() => { emissions += 1; });
  const beforeLifecycle = emissions;
  domain.setLifecycle({ visible: true, active: true });
  assert.equal(emissions, beforeLifecycle + 1, "one atomic route transition produces one domain emission");
  unsubscribe();
  domain.destroy();
  domain.destroy();
  assert.equal(adapter.calls.start, 1);
  assert.equal(adapter.calls.destroy, 1);
  assert.equal(adapter.calls.visible.at(-1), true);
  assert.equal(adapter.calls.active.at(-1), true);
});
