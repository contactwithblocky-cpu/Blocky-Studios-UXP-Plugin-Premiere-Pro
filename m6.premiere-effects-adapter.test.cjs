// @ts-nocheck -- This focused harness runs in Node; jsconfig targets the UXP browser runtime.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const indexApi = require("./src/quick-apply/oracle-effect-index.js");
const adapterApi = require("./src/quick-apply/oracle-premiere-effects-adapter.js");

function tick(ticks) {
  return { ticks: String(ticks), toString() { return this.ticks; } };
}

function createParam(initialValue = 0, options = {}) {
  let currentValue = initialValue;
  let actionLockGuard = null;
  const calls = { keyframes: 0, actions: 0, commits: 0 };
  return {
    calls,
    setActionLockGuard(guard) { actionLockGuard = typeof guard === "function" ? guard : null; },
    isTimeVarying() { return options.timeVarying === true; },
    createKeyframe(value) {
      calls.keyframes += 1;
      if (options.rejectValue) throw new Error("value rejected");
      return { value: { value } };
    },
    createSetValueAction(keyframe) {
      calls.actions += 1;
      if (actionLockGuard && !actionLockGuard()) throw new Error("createSetValueAction requires project lockedAccess");
      if (options.nullAction) return null;
      return {
        commit() {
          calls.commits += 1;
          if (!options.ignoreCommit) currentValue = keyframe.value.value;
        },
      };
    },
    async getStartValue() { return { value: { value: currentValue } }; },
    get value() { return currentValue; },
  };
}

function createComponent(kind, matchName, displayName, options = {}) {
  const params = options.params || [createParam(0, options.paramOptions)];
  let attached = options.identityAvailableAfterAttach !== true;
  const reportedMatchName = options.reportedMatchName || matchName;
  const reportedDisplayName = options.reportedDisplayName || displayName;
  return {
    kind,
    params,
    async getMatchName() {
      if (!attached) throw new Error("component identity is unavailable before append");
      return reportedMatchName;
    },
    async getDisplayName() {
      if (!attached) throw new Error("component identity is unavailable before append");
      return reportedDisplayName;
    },
    markAttached() { attached = true; },
    setActionLockGuard(guard) {
      for (const param of params) if (typeof param.setActionLockGuard === "function") param.setActionLockGuard(guard);
    },
    getParamCount() { return params.length; },
    getParam(index) { return params[index]; },
  };
}

function createChain(kind, initialComponents = [], options = {}) {
  const components = [...initialComponents];
  const calls = { appendActions: 0, commits: 0 };
  let actionLockGuard = null;
  return {
    kind,
    components,
    calls,
    getComponentCount() { return components.length; },
    getComponentAtIndex(index) { return components[index]; },
    setActionLockGuard(guard) { actionLockGuard = typeof guard === "function" ? guard : null; },
    createAppendComponentAction(component) {
      calls.appendActions += 1;
      if (actionLockGuard && !actionLockGuard()) throw new Error("createAppendComponentAction requires project lockedAccess");
      if (!component || component.kind !== kind || options.rejectAppend ||
          (Array.isArray(options.rejectAppendCalls) && options.rejectAppendCalls.includes(calls.appendActions))) {
        throw new Error(`${kind} chain rejected component`);
      }
      return {
        commit() {
          calls.commits += 1;
          if (typeof component.markAttached === "function") component.markAttached();
          components.push(component);
        },
      };
    },
  };
}

function createTrackItem(kind, id, options = {}) {
  const chain = options.chain || createChain(kind, options.initialComponents || []);
  return {
    kind,
    id,
    chain,
    async getComponentChain() { return chain; },
    async getTrackIndex() { return options.trackIndex || 0; },
    async getStartTime() { return tick(options.startTicks || "0"); },
    async getEndTime() { return tick(options.endTicks || "1000"); },
    async getMediaType() { return { toString: () => options.mediaTypeIdentity || `opaque-${kind}-guid` }; },
    async getProjectItem() { return { getId: () => `project-item-${id}` }; },
    async getMatchName() { return `${kind}-clip`; },
    async getName() { return options.name || `${kind} clip ${id}`; },
    async getType() { return 1; },
  };
}

function createHost(options = {}) {
  const items = options.items || [createTrackItem("video", "v1")];
  let lockDepth = 0;
  const calls = {
    videoDisplayNames: 0,
    videoMatchNames: 0,
    audioDisplayNames: 0,
    videoCreates: [],
    audioCreates: [],
    transactions: 0,
    lockedAccess: 0,
    addActions: 0,
    undoStrings: [],
    eventAdds: [],
    eventRemoves: [],
  };
  const effectOptions = options.effectOptions || {};
  const videoDefinitions = options.videoDefinitions || [
    { displayName: "Crop", matchName: "AE.ADBE Crop" },
    { displayName: "Gaussian Blur", matchName: "AE.ADBE Gaussian Blur 2" },
  ];
  const audioDefinitions = options.audioDefinitions || [
    { displayName: "DeNoise", matchName: "AUD.ADBE DeNoise" },
  ];
  const sequence = {
    guid: { toString: () => "sequence-guid" },
    name: "Blocky Studios M6 Disposable",
    selectionItems: items,
    async getSelection() {
      if (options.selectionError) throw new Error("selection unavailable");
      return { getTrackItems: async () => sequence.selectionItems };
    },
  };
  const project = {
    guid: { toString: () => "project-guid" },
    name: "Blocky Studios M6 Disposable.prproj",
    async getActiveSequence() { return options.noSequence ? null : sequence; },
    lockedAccess(callback) {
      calls.lockedAccess += 1;
      lockDepth += 1;
      try { callback(); } finally { lockDepth -= 1; }
    },
    executeTransaction(callback, undoString) {
      calls.transactions += 1;
      calls.undoStrings.push(undoString);
      const actions = [];
      callback({
        addAction(action) {
          calls.addActions += 1;
          if (options.rejectAddAction) return false;
          actions.push(action);
          return true;
        },
      });
      if (options.transactionResult === false) return false;
      for (const action of actions) action.commit();
      return true;
    },
  };
  if (options.enforceActionLock !== false) {
    const guard = () => lockDepth > 0;
    for (const item of items) {
      item.chain.setActionLockGuard(guard);
      for (const component of item.chain.components) {
        if (typeof component.setActionLockGuard === "function") component.setActionLockGuard(guard);
      }
    }
  }
  const guardFactoryComponent = (component) => {
    if (component && options.enforceActionLock !== false && typeof component.setActionLockGuard === "function") {
      component.setActionLockGuard(() => lockDepth > 0);
    }
    return component;
  };
  const api = {
    Application: { version: "26.3.0" },
    Project: { async getActiveProject() { return options.noProject ? null : project; } },
    VideoFilterFactory: {
      async getDisplayNames() {
        calls.videoDisplayNames += 1;
        return videoDefinitions.map((entry) => entry.displayName);
      },
      async getMatchNames() {
        calls.videoMatchNames += 1;
        return videoDefinitions.map((entry) => entry.matchName);
      },
      async createComponent(matchName) {
        calls.videoCreates.push(matchName);
        const definition = videoDefinitions.find((entry) => entry.matchName === matchName);
        if (!definition) throw new Error("unknown video effect");
        const componentOptions = effectOptions[definition.matchName] || {};
        if (componentOptions.nullComponent === true) return null;
        return guardFactoryComponent(createComponent("video", definition.matchName, definition.displayName, componentOptions));
      },
    },
    AudioFilterFactory: {
      async getDisplayNames() {
        calls.audioDisplayNames += 1;
        return audioDefinitions.map((entry) => entry.displayName);
      },
      async createComponentByDisplayName(displayName, item) {
        calls.audioCreates.push({ displayName, item });
        if (!item || item.kind !== "audio") throw new Error("not an audio item");
        const definition = audioDefinitions.find((entry) => entry.displayName === displayName);
        if (!definition) throw new Error("unknown audio effect");
        return guardFactoryComponent(createComponent("audio", definition.matchName, definition.displayName, effectOptions[definition.matchName]));
      },
    },
    Constants: {
      MediaType: { VIDEO: 2, AUDIO: 3 },
      SequenceEvent: { ACTIVATED: 10, CLOSED: 11, SELECTION_CHANGED: 12 },
    },
    EventManager: {
      addEventListener(target, eventName, listener) { calls.eventAdds.push({ target, eventName, listener }); },
      removeEventListener(target, eventName, listener) { calls.eventRemoves.push({ target, eventName, listener }); },
    },
    PointF() { return { x: 0, y: 0 }; },
    Color() { return { red: 0, green: 0, blue: 0, alpha: 0 }; },
  };
  return { api, calls, project, sequence, items, videoDefinitions, audioDefinitions };
}

function createScheduler() {
  let nextId = 1;
  const tasks = new Map();
  const delays = [];
  return {
    tasks,
    delays,
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
  };
}

function createAdapter(host, options = {}) {
  const scheduler = options.scheduler || createScheduler();
  const adapter = new adapterApi.PremiereQuickApplyAdapter({
    api: host.api,
    hostVersion: options.hostVersion === undefined ? "26.3.0" : options.hostVersion,
    visible: options.visible === true,
    active: options.active !== false,
    minPollIntervalMs: 100,
    maxPollIntervalMs: 250,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    now: () => 1234,
    effectIndexStore: options.effectIndexStore,
    mediaTypeResolver: options.mediaTypeResolver,
  });
  return { adapter, scheduler };
}

async function effectByName(adapter, name) {
  await adapter.refreshEffectIndex({ force: true });
  return adapter.getEffectIndex().entries.find((entry) => entry.displayName === name);
}

test("corrupt cache is cleared and rebuilt from the exact installed host factories", async () => {
  const host = createHost();
  const calls = { load: 0, clear: 0, save: 0, saved: null };
  const store = {
    async load() { calls.load += 1; return { schema: "corrupt" }; },
    async clear() { calls.clear += 1; },
    async save(value) { calls.save += 1; calls.saved = value; },
  };
  const { adapter } = createAdapter(host, { effectIndexStore: store });
  const index = await adapter.refreshEffectIndex({ force: false });
  assert.equal(calls.load, 1);
  assert.equal(calls.clear, 1);
  assert.equal(calls.save, 1);
  assert.equal(index.hostVersion, "26.3.0");
  assert.deepEqual(index.entries.map((entry) => [entry.type, entry.displayName, entry.matchName]), [
    ["video", "Crop", "AE.ADBE Crop"],
    ["video", "Gaussian Blur", "AE.ADBE Gaussian Blur 2"],
    ["audio", "DeNoise", null],
  ]);
  assert.equal(adapter.getSnapshot().indexCacheState, "corrupt-cache-rebuilt");
});

test("inspectHost reports missing and failed effect discovery honestly instead of ready Available", async (t) => {
  await t.test("an index has not been loaded", async () => {
    const host = createHost();
    const { adapter } = createAdapter(host);
    const inspection = await adapter.inspectHost();
    assert.equal(inspection.snapshot.state, "error");
    assert.equal(inspection.snapshot.status.code, adapterApi.REASON.EFFECT_INDEX_UNAVAILABLE);
    assert.equal(inspection.snapshot.capabilities.effectIndex.supported, false);
    assert.notEqual(inspection.snapshot.message, "Available.");
  });

  await t.test("an installed factory method is missing", async () => {
    const host = createHost();
    delete host.api.VideoFilterFactory.getMatchNames;
    const { adapter } = createAdapter(host);
    await assert.rejects(adapter.refreshEffectIndex({ force: true }), (error) => error.code === adapterApi.REASON.EFFECT_FACTORY_UNAVAILABLE);
    const inspection = await adapter.inspectHost();
    assert.equal(inspection.snapshot.state, "unsupported");
    assert.equal(inspection.snapshot.status.code, adapterApi.REASON.EFFECT_FACTORY_UNAVAILABLE);
    assert.equal(inspection.snapshot.capabilities.videoEffects.supported, false);
    assert.notEqual(inspection.snapshot.message, "Available.");
  });

  await t.test("a factory call fails while rebuilding the index", async () => {
    const host = createHost();
    const { adapter } = createAdapter(host);
    const installedIndex = await adapter.refreshEffectIndex({ force: true });
    host.api.AudioFilterFactory.getDisplayNames = async () => { throw new Error("factory enumeration failed"); };
    await assert.rejects(adapter.refreshEffectIndex({ force: true }), (error) => error.code === adapterApi.REASON.EFFECT_FACTORY_UNAVAILABLE);
    assert.equal(adapter.getEffectIndex(), installedIndex, "the last index may remain available for diagnostics, but must not mask the failed rebuild");
    const inspection = await adapter.inspectHost();
    assert.equal(inspection.snapshot.state, "unsupported");
    assert.equal(inspection.snapshot.status.code, adapterApi.REASON.EFFECT_FACTORY_UNAVAILABLE);
    assert.equal(inspection.snapshot.issues[0].message, "factory enumeration failed");
    assert.notEqual(inspection.snapshot.message, "Available.");
  });
});

test("observation is visible-only, bounded to 100-250 ms, and removes host listeners on hide", async () => {
  const host = createHost();
  const scheduler = createScheduler();
  const { adapter } = createAdapter(host, { scheduler, visible: false });
  adapter.start();
  assert.equal(adapter.getSnapshot().observing, false);
  assert.equal(scheduler.tasks.size, 0);

  adapter.setVisible(true);
  await adapter.requestRefresh("test-visible");
  assert.equal(adapter.getSnapshot().observing, true);
  assert.ok(scheduler.delays.every((delay) => delay >= 100 && delay <= 250));
  assert.ok(host.calls.eventAdds.length > 0);

  adapter.setVisible(false);
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(adapter.getSnapshot().observing, false);
  assert.equal(host.calls.eventRemoves.length, host.calls.eventAdds.length);
});

test("opaque media identity is exposed while factory plus chain action proves exact video compatibility", async () => {
  const videoOne = createTrackItem("video", "v1", { trackIndex: 0, mediaTypeIdentity: "{OPAQUE-VIDEO-GUID}" });
  const videoTwo = createTrackItem("video", "v2", { trackIndex: 1, mediaTypeIdentity: "{OPAQUE-VIDEO-GUID}" });
  const audio = createTrackItem("audio", "a1", { trackIndex: 0, mediaTypeIdentity: "{OPAQUE-AUDIO-GUID}" });
  const host = createHost({ items: [videoOne, videoTwo, audio] });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const inspection = await adapter.inspectHost();
  assert.deepEqual(inspection.snapshot.selection.map((item) => [item.mediaTypeIdentity, item.mediaKind]), [
    ["{OPAQUE-VIDEO-GUID}", "unknown"],
    ["{OPAQUE-VIDEO-GUID}", "unknown"],
    ["{OPAQUE-AUDIO-GUID}", "unknown"],
  ]);

  const plan = await adapter.planEffectApplication(effect, { applyOnce: true });
  assert.equal(plan.executable, true);
  assert.equal(plan.targetCount, 2);
  assert.equal(plan.skippedCount, 1);
  assert.equal(plan.skipped[0].code, adapterApi.REASON.MEDIA_TYPE_INCOMPATIBLE);

  const receipt = await adapter.applyEffect(plan);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.historyEligible, true);
  assert.equal(receipt.addedCount, 2);
  assert.equal(receipt.skippedCount, 1);
  assert.equal(host.calls.transactions, 1);
  assert.equal(host.calls.lockedAccess, 4, "three compatibility proofs plus one committed transaction are lock-scoped");
  assert.equal(host.calls.addActions, 2);
  assert.equal(videoOne.chain.components.at(-1).kind, "video");
  assert.equal(videoTwo.chain.components.at(-1).kind, "video");
  assert.equal(audio.chain.components.length, 0);
});

test("Apply Once is duplicate-safe by stable match identity and records no false history", async () => {
  const existing = createComponent("video", "AE.ADBE Crop", "Crop");
  const item = createTrackItem("video", "v1", { initialComponents: [existing] });
  const host = createHost({ items: [item] });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect, { applyOnce: true });
  assert.equal(plan.executable, false);
  assert.equal(plan.skipped[0].code, adapterApi.REASON.DUPLICATE_PREVENTED);
  const receipt = await adapter.applyEffect(plan);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.changed, false);
  assert.equal(receipt.historyEligible, false);
  assert.equal(host.calls.transactions, 0);
  assert.equal(item.chain.components.length, 1);
});

test("video factory identity may publish only after append while exact chain readback remains mandatory", async () => {
  const item = createTrackItem("video", "v1");
  const host = createHost({
    items: [item],
    effectOptions: {
      "AE.ADBE Crop": { identityAvailableAfterAttach: true },
    },
  });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect, { applyOnce: true });

  assert.equal(plan.executable, true);
  assert.deepEqual(plan.targets[0].expectedComponent, {
    matchName: "AE.ADBE Crop",
    displayName: "Crop",
    occurrence: 0,
  });
  const receipt = await adapter.applyEffect(plan);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.addedCount, 1);
  assert.equal(receipt.targets[0].component.matchName, "AE.ADBE Crop");
  assert.equal(item.chain.components.length, 1);
});

test("Premiere 26.3 append actions are created only inside project lockedAccess and recreated for apply", async () => {
  const item = createTrackItem("video", "v1");
  const host = createHost({ items: [item] });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const outsideComponent = createComponent("video", effect.matchName, effect.displayName);

  assert.throws(
    () => item.chain.createAppendComponentAction(outsideComponent),
    /requires project lockedAccess/,
  );
  const plan = await adapter.planEffectApplication(effect);
  assert.equal(plan.executable, true);
  const hiddenRecord = adapter.planRecords.get(plan.planToken);
  assert.ok(hiddenRecord);
  assert.equal(Object.prototype.hasOwnProperty.call(hiddenRecord.targets[0], "action"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(hiddenRecord.targets[0], "component"), false);
  assert.equal(host.calls.transactions, 0);
  const receipt = await adapter.applyEffect(plan);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.equal(host.calls.transactions, 1);
  assert.equal(host.calls.videoCreates.length, 2, "planning and apply use separate short-lived factory tokens");
  assert.equal(item.chain.components.length, 1);
});

test("wrong committed video identity fails exact readback after the transaction and reports the partial boundary", async () => {
  const item = createTrackItem("video", "v1");
  const host = createHost({
    items: [item],
    effectOptions: {
      "AE.ADBE Crop": {
        identityAvailableAfterAttach: true,
        reportedMatchName: "AE.ADBE Not Crop",
        reportedDisplayName: "Not Crop",
      },
    },
  });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect, { applyOnce: true });

  assert.equal(plan.executable, true, "the opaque factory token can be planned from the validated installed index");
  await assert.rejects(adapter.applyEffect(plan), (error) => {
    assert.equal(error.code, adapterApi.REASON.COMPONENT_READBACK_FAILED);
    assert.equal(error.details.transactionCommitted, true);
    assert.equal(error.details.partialFailure, true);
    assert.equal(error.details.matchName, "AE.ADBE Crop");
    assert.equal(error.details.expectedCount, 1);
    assert.equal(error.details.actualCount, 0);
    return true;
  });
  assert.equal(host.calls.transactions, 1);
  assert.equal(item.chain.components.length, 1, "the committed host mutation is reported rather than hidden");
  assert.equal(await item.chain.components[0].getMatchName(), "AE.ADBE Not Crop");
});

test("a null video factory token fails before action creation or transaction", async () => {
  const item = createTrackItem("video", "v1");
  const host = createHost({
    items: [item],
    effectOptions: { "AE.ADBE Crop": { nullComponent: true } },
  });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect);

  assert.equal(plan.executable, false);
  assert.equal(plan.skipped[0].code, adapterApi.REASON.EFFECT_CREATION_FAILED);
  assert.equal(host.calls.transactions, 0);
  assert.equal(item.chain.calls.appendActions, 0);
});

test("a stale effect stack invalidates a preflight plan before any transaction", async () => {
  const item = createTrackItem("video", "v1");
  const host = createHost({ items: [item] });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect);
  assert.equal(host.calls.videoCreates.length, 1, "only the planning token exists before stale-plan validation");
  item.chain.components.push(createComponent("video", "AE.ADBE Mosaic", "Mosaic"));
  await assert.rejects(adapter.applyEffect(plan), (error) => error.code === adapterApi.REASON.STALE_PLAN);
  assert.equal(host.calls.transactions, 0);
  assert.equal(host.calls.videoCreates.length, 1, "a stale plan aborts before any apply-time factory call");
});

test("a second append-action creation failure starts no recipe transaction and mutates no component", async () => {
  const chain = createChain("video", [], { rejectAppendCalls: [4] });
  const item = createTrackItem("video", "v1", { chain });
  const host = createHost({ items: [item] });
  const { adapter } = createAdapter(host);
  await adapter.refreshEffectIndex({ force: true });
  const crop = adapter.getEffectIndex().entries.find((entry) => entry.displayName === "Crop");
  const blur = adapter.getEffectIndex().entries.find((entry) => entry.displayName === "Gaussian Blur");
  const plan = await adapter.planRecipeApplication({
    name: "Atomic pair",
    steps: [{ effectId: crop.effectId }, { effectId: blur.effectId }],
  });

  assert.equal(plan.executable, true);
  await assert.rejects(adapter.applyRecipe(plan), (error) => {
    assert.equal(error.code, adapterApi.REASON.MEDIA_TYPE_INCOMPATIBLE);
    assert.equal(error.details.transactionCalled, false);
    return true;
  });
  assert.equal(host.calls.transactions, 0);
  assert.equal(item.chain.components.length, 0);
});

test("transaction rejection does not commit components or claim verified history", async () => {
  const item = createTrackItem("video", "v1");
  const host = createHost({ items: [item], transactionResult: false });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect);
  await assert.rejects(adapter.applyEffect(plan), (error) => error.code === adapterApi.REASON.TRANSACTION_FAILED);
  assert.equal(item.chain.components.length, 0);
  assert.equal(host.calls.transactions, 1);
});

test("transaction action rejection retains the exact transaction boundary details", async () => {
  const item = createTrackItem("video", "v1");
  const host = createHost({ items: [item], rejectAddAction: true });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect);
  await assert.rejects(adapter.applyEffect(plan), (error) => {
    assert.equal(error.code, adapterApi.REASON.ACTION_REJECTED);
    assert.deepEqual(error.details, { transactionCalled: true, transactionResult: false });
    return true;
  });
  assert.equal(item.chain.components.length, 0);
  assert.equal(host.calls.transactions, 1);
});

test("audio application uses createComponentByDisplayName and skips incompatible video items explicitly", async () => {
  const video = createTrackItem("video", "v1");
  const audio = createTrackItem("audio", "a1");
  const host = createHost({ items: [video, audio] });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "DeNoise");
  const plan = await adapter.planEffectApplication(effect);
  assert.equal(plan.targetCount, 1);
  assert.equal(plan.skippedCount, 1);
  assert.equal(host.calls.audioCreates.length, 2);
  const receipt = await adapter.applyEffect(plan);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.targets[0].component.matchName, "AUD.ADBE DeNoise");
  assert.equal(audio.chain.components.length, 1);
  assert.equal(video.chain.components.length, 0);
});

test("empty selection returns a non-executable exact report without a transaction", async () => {
  const host = createHost({ items: [] });
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const plan = await adapter.planEffectApplication(effect);
  assert.equal(plan.executable, false);
  assert.equal(plan.capability.code, adapterApi.REASON.NO_SELECTION);
  const receipt = await adapter.applyEffect(plan);
  assert.equal(receipt.changed, false);
  assert.equal(host.calls.transactions, 0);
});

test("Blocky Studios Recipe applies ordered components, then parameters, with exact two-stage readback", async () => {
  const cropParam = createParam(0);
  const blurParam = createParam(5);
  const item = createTrackItem("video", "v1");
  const host = createHost({
    items: [item],
    effectOptions: {
      "AE.ADBE Crop": { params: [cropParam] },
      "AE.ADBE Gaussian Blur 2": { params: [blurParam] },
    },
  });
  const { adapter } = createAdapter(host);
  await adapter.refreshEffectIndex({ force: true });
  const crop = adapter.getEffectIndex().entries.find((entry) => entry.displayName === "Crop");
  const blur = adapter.getEffectIndex().entries.find((entry) => entry.displayName === "Gaussian Blur");
  const plan = await adapter.planRecipeApplication({
    id: "recipe-1",
    name: "Blocky Studios Punch",
    applyOnce: true,
    steps: [
      { effectId: crop.effectId, parameters: [{ index: 0, value: 42 }] },
      { effect: blur },
    ],
  });
  assert.equal(plan.executable, true);
  assert.equal(plan.targetCount, 2);
  assert.equal(plan.atomicity, "two-stage");
  assert.equal(plan.fullRollbackSupported, false);
  assert.throws(
    () => cropParam.createSetValueAction(cropParam.createKeyframe(99), true),
    /requires project lockedAccess/,
    "Premiere 26.3 parameter actions cannot be retained outside their lock",
  );

  const receipt = await adapter.applyRecipe(plan);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.historyEligible, true);
  assert.equal(receipt.addedCount, 2);
  assert.equal(receipt.parameterActionCount, 1);
  assert.equal(receipt.undoSteps, 2);
  assert.equal(host.calls.transactions, 2);
  assert.deepEqual(item.chain.components.map((component) => component.kind), ["video", "video"]);
  assert.deepEqual(await item.chain.components[0].getMatchName(), "AE.ADBE Crop");
  assert.equal(cropParam.value, 42);
  assert.equal(cropParam.calls.commits, 1);
});

test("recipe compatibility metadata is enforced before any effect candidate or transaction", async (t) => {
  const createRecipe = (effectId, compatibility) => ({
    name: "Versioned Blocky Studios Recipe",
    compatibility,
    steps: [{ effectId }],
  });

  await t.test("minimum Premiere version", async () => {
    const host = createHost();
    const { adapter } = createAdapter(host, { hostVersion: "26.3.0" });
    const effect = await effectByName(adapter, "Crop");
    await assert.rejects(
      adapter.planRecipeApplication(createRecipe(effect.effectId, { premiereMinVersion: "26.4.0" })),
      (error) => {
        assert.equal(error.code, adapterApi.REASON.RECIPE_PREMIERE_VERSION_UNSUPPORTED);
        assert.deepEqual(error.details, { hostVersion: "26.3.0", requiredPremiereVersion: "26.4.0" });
        return true;
      },
    );
    assert.equal(host.calls.videoCreates.length, 0);
    assert.equal(host.calls.transactions, 0);
  });

  await t.test("effect-index version", async () => {
    const host = createHost();
    const { adapter } = createAdapter(host);
    const effect = await effectByName(adapter, "Crop");
    await assert.rejects(
      adapter.planRecipeApplication(createRecipe(effect.effectId, { effectIndexVersion: indexApi.EFFECT_INDEX_VERSION + 1 })),
      (error) => {
        assert.equal(error.code, adapterApi.REASON.RECIPE_EFFECT_INDEX_VERSION_UNSUPPORTED);
        assert.deepEqual(error.details, {
          requiredEffectIndexVersion: indexApi.EFFECT_INDEX_VERSION + 1,
          actualEffectIndexVersion: indexApi.EFFECT_INDEX_VERSION,
        });
        return true;
      },
    );
    assert.equal(host.calls.videoCreates.length, 0);
    assert.equal(host.calls.transactions, 0);
  });

  await t.test("matching metadata remains executable", async () => {
    const host = createHost();
    const { adapter } = createAdapter(host);
    const effect = await effectByName(adapter, "Crop");
    const plan = await adapter.planRecipeApplication(createRecipe(effect.effectId, {
      premiereMinVersion: "26.3",
      effectIndexVersion: indexApi.EFFECT_INDEX_VERSION,
    }));
    assert.equal(plan.executable, true);
    assert.equal(plan.recipe.compatibility.premiereMinVersion, "26.3");
    assert.equal(plan.recipe.compatibility.effectIndexVersion, indexApi.EFFECT_INDEX_VERSION);
    assert.equal(host.calls.transactions, 0);
  });
});

test("recipe parameter readback failure reports the unavoidable committed boundary honestly", async () => {
  const cropParam = createParam(0, { ignoreCommit: true });
  const item = createTrackItem("video", "v1");
  const host = createHost({
    items: [item],
    effectOptions: { "AE.ADBE Crop": { params: [cropParam] } },
  });
  const { adapter } = createAdapter(host);
  const crop = await effectByName(adapter, "Crop");
  const plan = await adapter.planRecipeApplication({
    name: "Known Parameter Failure",
    steps: [{ effectId: crop.effectId, parameters: [{ index: 0, value: 50 }] }],
  });
  const receipt = await adapter.applyRecipe(plan);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.changed, true);
  assert.equal(receipt.committed, true);
  assert.equal(receipt.historyEligible, false);
  assert.equal(receipt.partialFailure, true);
  assert.equal(receipt.partialFailureBoundary, "component-stack-committed-before-parameter-values");
  assert.equal(receipt.failedStage, "parameter-readback");
  assert.equal(receipt.undoSteps, 2);
  assert.equal(receipt.committedComponentActionCount, 1);
  assert.equal(receipt.addedCountVerified, true);
  assert.equal(receipt.error.code, adapterApi.REASON.PARAMETER_READBACK_FAILED);
  assert.deepEqual(receipt.error.details, {
    paramIndex: 0,
    expected: "number:50",
    actual: "number:0",
  });
  assert.equal(item.chain.components.length, 1);
  assert.equal(host.calls.transactions, 2);
});

test("recipe preflight rejects time-varying parameters before adding any component", async () => {
  const keyedParam = createParam(0, { timeVarying: true });
  const item = createTrackItem("video", "v1");
  const host = createHost({ items: [item], effectOptions: { "AE.ADBE Crop": { params: [keyedParam] } } });
  const { adapter } = createAdapter(host);
  const crop = await effectByName(adapter, "Crop");
  const plan = await adapter.planRecipeApplication({
    name: "Unsafe Keyframe Overwrite",
    steps: [{ effectId: crop.effectId, parameters: [{ index: 0, value: 25 }] }],
  });
  assert.equal(plan.executable, false);
  assert.equal(plan.skipped[0].code, adapterApi.REASON.TIME_VARYING_PARAMETER_UNSUPPORTED);
  assert.equal(host.calls.transactions, 0);
  assert.equal(item.chain.components.length, 0);
});

test("duplicate audio display names remain indexed but application fails closed instead of guessing", async () => {
  const audio = createTrackItem("audio", "a1");
  const host = createHost({
    items: [audio],
    audioDefinitions: [
      { displayName: "Duplicate Audio", matchName: "AUD.First" },
      { displayName: "Duplicate Audio", matchName: "AUD.Second" },
    ],
  });
  const { adapter } = createAdapter(host);
  await adapter.refreshEffectIndex({ force: true });
  const duplicates = adapter.getEffectIndex().entries.filter((entry) => entry.displayName === "Duplicate Audio");
  assert.equal(duplicates.length, 2);
  const plan = await adapter.planEffectApplication(duplicates[0]);
  assert.equal(plan.executable, false);
  assert.equal(plan.skipped[0].code, adapterApi.REASON.AMBIGUOUS_AUDIO_DISPLAY_NAME);
  assert.equal(host.calls.transactions, 0);
});

test("generic parameter metadata is honestly unavailable while explicit recipe values remain supported", async () => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  const effect = await effectByName(adapter, "Crop");
  const metadata = await adapter.getSupportedParameters(effect);
  assert.equal(metadata.capability.supported, false);
  assert.equal(metadata.capability.code, adapterApi.REASON.PARAMETER_METADATA_UNAVAILABLE);
  assert.deepEqual(metadata.parameters, []);
  assert.equal(metadata.configuration, "explicit-index-and-value-only");

  const domainRequestMetadata = await adapter.getSupportedParameters({
    effect: { ...effect },
    selectionRevision: "selection-revision-from-domain",
  });
  assert.equal(domainRequestMetadata.effect.effectId, effect.effectId);
  assert.equal(domainRequestMetadata.capability.code, adapterApi.REASON.PARAMETER_METADATA_UNAVAILABLE);
  assert.deepEqual(domainRequestMetadata.parameters, []);
});

test("destroy cancels timers/listeners and makes issued plans unusable", async () => {
  const host = createHost();
  const scheduler = createScheduler();
  const { adapter } = createAdapter(host, { scheduler, visible: true });
  adapter.start();
  await adapter.requestRefresh("before-destroy");
  const effect = adapter.getEffectIndex().entries[0];
  const plan = await adapter.planEffectApplication(effect);
  adapter.destroy();
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(host.calls.eventRemoves.length, host.calls.eventAdds.length);
  await assert.rejects(adapter.applyEffect(plan), (error) => error.code === adapterApi.REASON.ADAPTER_DESTROYED);
});

test("public effect IDs remain stable across JSON cache validation", () => {
  const original = indexApi.createEffectIndex({
    hostVersion: "26.3.0",
    videoDisplayNames: ["Crop"],
    videoMatchNames: ["AE.ADBE Crop"],
    audioDisplayNames: ["DeNoise"],
  });
  const restored = indexApi.validateEffectIndex(JSON.parse(JSON.stringify(original)), { hostVersion: "26.3.0" });
  assert.deepEqual(restored.entries.map((entry) => entry.effectId), original.entries.map((entry) => entry.effectId));
});
