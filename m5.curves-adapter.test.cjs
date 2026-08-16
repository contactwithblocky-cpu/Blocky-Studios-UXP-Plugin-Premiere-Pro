"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const curvesApi = require("./src/curves/oracle-premiere-curves-adapter.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick(ticks) {
  return {
    ticks: String(ticks),
    get seconds() { return Number(this.ticks) / 1000; },
    toString() { return this.ticks; },
  };
}

function createKeyframe(ticks, value, mode) {
  return {
    position: tick(ticks),
    value: { value },
    mode,
    async getTemporalInterpolationMode() { return this.mode; },
  };
}

function createParam(options = {}) {
  const keys = new Map();
  for (const entry of options.keys || [
    { ticks: "0", value: 0, mode: 2 },
    { ticks: "1000", value: 1, mode: 2 },
  ]) {
    keys.set(curvesApi.normalizeTickString(entry.ticks), createKeyframe(entry.ticks, entry.value, entry.mode));
  }
  const calls = { createInterpolation: [], add: 0, remove: 0 };
  return {
    displayName: options.displayName || "Position",
    keys,
    calls,
    async areKeyframesSupported() { return options.supported !== false; },
    getKeyframeListAsTickTimes() {
      return Array.from(keys.values()).map((keyframe) => keyframe.position);
    },
    getKeyframePtr(time) { return keys.get(curvesApi.normalizeTickString(time)); },
    async getValueAtTime() {
      const first = Array.from(keys.values())[0];
      return first ? first.value.value : options.currentValue;
    },
    createKeyframe(value) {
      return createKeyframe("0", value, options.defaultLinearMode ?? 2);
    },
    createAddKeyframeAction(keyframe) {
      calls.add += 1;
      return { commit() { keys.set(curvesApi.normalizeTickString(keyframe.position), keyframe); } };
    },
    createSetInterpolationAtKeyframeAction(time, mode, updateUi) {
      const keyframe = keys.get(curvesApi.normalizeTickString(time));
      calls.createInterpolation.push({ ticks: curvesApi.normalizeTickString(time), mode, updateUi });
      if (options.throwOnCreate) throw new Error("action factory failed");
      if (options.nullAction) return null;
      return {
        commit() {
          if (keyframe && !options.ignoreInterpolationCommit) keyframe.mode = mode;
          if (keyframe && options.mutateEndpointOnCommit) keyframe.value.value = 999;
        },
      };
    },
    createRemoveKeyframeAction(time) {
      calls.remove += 1;
      return { commit() { keys.delete(curvesApi.normalizeTickString(time)); } };
    },
  };
}

function createHost(options = {}) {
  const paramA = options.paramA || createParam();
  const paramB = options.paramB || createParam({
    displayName: "Anchor Point",
    keys: [
      { ticks: "0", value: { x: 0, y: 0 }, mode: 2 },
      { ticks: "1000", value: { x: 1, y: 1 }, mode: 2 },
    ],
  });
  const unsupported = createParam({ supported: false, displayName: "Enabled" });
  const componentOne = {
    async getMatchName() { return "AE.ADBE Motion"; },
    async getDisplayName() { return "Motion"; },
    getParamCount() { return 2; },
    getParam(index) { return [paramA, unsupported][index]; },
  };
  const componentTwo = {
    async getMatchName() { return "AE.ADBE Motion"; },
    async getDisplayName() { return "Motion Duplicate"; },
    getParamCount() { return 1; },
    getParam() { return paramB; },
  };
  const chain = {
    getComponentCount() { return 2; },
    getComponentAtIndex(index) { return [componentOne, componentTwo][index]; },
  };
  const trackItem = {
    async getTrackIndex() { return 0; },
    async getStartTime() { return tick(options.startTicks || "0"); },
    async getEndTime() { return tick("10000"); },
    async getInPoint() { return tick(options.inPointTicks || "0"); },
    async getOutPoint() { return tick(options.outPointTicks || "10000"); },
    async getDuration() { return tick(options.durationTicks || "10000"); },
    async getSpeed() { return options.speed ?? 1; },
    async isSpeedReversed() { return options.reversed ? 1 : 0; },
    async getMediaType() { return { toString: () => "video-guid" }; },
    async getProjectItem() { return { getId: () => "project-item-1" }; },
    async getMatchName() { return "video-clip"; },
    async getName() { return "Blocky Studios Replay.mov"; },
    async getType() { return 1; },
    async getComponentChain() { return chain; },
  };

  const calls = {
    getActiveProject: 0,
    getActiveSequence: 0,
    getSelection: 0,
    concurrentSelection: 0,
    maximumConcurrentSelection: 0,
    transactions: 0,
    lockedAccess: 0,
    addAction: 0,
    undoStrings: [],
    eventAdds: [],
    eventRemoves: [],
    videoTrackCount: 0,
    videoTrackReads: [],
    videoTrackItemReads: [],
  };
  const selection = {
    async getTrackItems() { return options.items || [trackItem]; },
  };
  const sequence = {
    guid: { toString: () => options.sequenceGuid || "sequence-guid" },
    name: "Sequence 01",
    async getSelection() {
      calls.getSelection += 1;
      calls.concurrentSelection += 1;
      calls.maximumConcurrentSelection = Math.max(calls.maximumConcurrentSelection, calls.concurrentSelection);
      try {
        if (options.selectionGate) await options.selectionGate.promise;
        if (options.selectionError) throw new Error("selection unavailable");
        return selection;
      } finally {
        calls.concurrentSelection -= 1;
      }
    },
    async getPlayerPosition() { return tick(options.playheadTicks || "500"); },
    async getVideoTrackCount() {
      calls.videoTrackCount += 1;
      return Array.isArray(options.videoTracks) ? options.videoTracks.length : 1;
    },
    async getVideoTrack(index) {
      calls.videoTrackReads.push(index);
      if (Array.isArray(options.videoTracks)) return options.videoTracks[index];
      return {
        async getTrackItems(type, includeEmpty) {
          calls.videoTrackItemReads.push({ index, type, includeEmpty });
          return options.playheadItems || [trackItem];
        },
      };
    },
    async getSettings() {
      if (options.noFrameRate) return {};
      return {
        getVideoFrameRate() {
          return {
            value: options.frameRate || 60,
            ticksPerFrame: options.ticksPerFrame || 250,
          };
        },
      };
    },
  };
  const project = {
    guid: { toString: () => options.projectGuid || "project-guid" },
    name: "Blocky Studios Acceptance.prproj",
    async getActiveSequence() {
      calls.getActiveSequence += 1;
      return options.noSequence ? null : sequence;
    },
    lockedAccess(callback) {
      calls.lockedAccess += 1;
      callback();
    },
    executeTransaction(callback, undoString) {
      calls.transactions += 1;
      calls.undoStrings.push(undoString);
      const actions = [];
      callback({
        addAction(action) {
          calls.addAction += 1;
          if (options.addActionResult === false) return false;
          actions.push(action);
          return true;
        },
      });
      if (options.transactionResult === false) return false;
      for (const action of actions) action.commit();
      return true;
    },
  };
  const api = {
    Project: {
      async getActiveProject() {
        calls.getActiveProject += 1;
        return options.noProject ? null : project;
      },
    },
    Constants: {
      InterpolationMode: { BEZIER: 0, HOLD: 1, LINEAR: 2 },
      TrackItemType: { CLIP: 1 },
      SequenceEvent: { ACTIVATED: 10, CLOSED: 11, SELECTION_CHANGED: 12 },
    },
    EventManager: {
      addEventListener(target, eventName, listener) { calls.eventAdds.push({ target, eventName, listener }); },
      removeEventListener(target, eventName, listener) { calls.eventRemoves.push({ target, eventName, listener }); },
    },
    TickTime: { createWithTicks: (ticks) => tick(ticks) },
  };
  return { api, calls, project, sequence, selection, trackItem, chain, componentOne, componentTwo, paramA, paramB };
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
    async runNext() {
      const first = tasks.entries().next().value;
      if (!first) return false;
      tasks.delete(first[0]);
      first[1]();
      await Promise.resolve();
      await Promise.resolve();
      return true;
    },
  };
}

function createAdapter(host, options = {}) {
  const scheduler = options.scheduler || createScheduler();
  const adapter = new curvesApi.PremiereCurvesAdapter({
    api: host.api,
    visible: options.visible !== false,
    active: options.active !== false,
    minPollIntervalMs: 100,
    maxPollIntervalMs: 250,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    now: () => 1234,
    bakedRuntimeProof: options.bakedRuntimeProof,
  });
  return { adapter, scheduler };
}

function acceptedBakedProof(overrides = {}) {
  return {
    version: 1,
    verified: true,
    hostVersion: "26.3.0",
    verifiedAt: "2026-07-16T02:00:00-04:00",
    source: "m5-disposable-project-live-probe",
    defaultLinearInterpolationMode: 2,
    valueKinds: ["number"],
    detachedKeyframes: true,
    generatedKeyActions: true,
    defaultLinearReadback: true,
    exactEndpointReadback: true,
    oneTransaction: true,
    oneUndoStep: true,
    undoRemovedGeneratedKeys: true,
    ...overrides,
  };
}

async function startAndRefresh(adapter) {
  adapter.start();
  return adapter.requestRefresh("test");
}

test("source is a standalone UXP global plus Node module without fake baked mutation paths", () => {
  const source = fs.readFileSync("./src/curves/oracle-premiere-curves-adapter.js", "utf8");
  assert.match(source, /OraclePremiereCurvesAdapter/);
  assert.match(source, /project\.lockedAccess/);
  assert.match(source, /project\.executeTransaction/);
  assert.doesNotMatch(source, /eval\s*\(|new Function|\.prfpset/i);
  assert.equal(typeof curvesApi.PremiereCurvesAdapter, "function");
});

test("exact TickTime ordering never loses precision and handles signed values", () => {
  assert.equal(curvesApi.compareTickStrings("900719925474099312345", "900719925474099312346"), -1);
  assert.equal(curvesApi.compareTickStrings("-900719925474099312346", "-900719925474099312345"), -1);
  assert.equal(curvesApi.compareTickStrings("+00042", "42"), 0);
  assert.deepEqual(
    curvesApi.sortedUniqueTickStrings(["10", "-2", "00010", "900719925474099312345", "0"]),
    ["-2", "0", "10", "900719925474099312345"],
  );
  assert.equal(curvesApi.tickModulo("8467166132", "4233583066"), 0);
  assert.equal(curvesApi.tickModulo("8467166133", "4233583066"), 1);
  assert.equal(curvesApi.addTickStrings("900719925474099312345", "55"), "900719925474099312400");
  assert.equal(curvesApi.subtractTickStrings("-900719925474099312345", "55"), "-900719925474099312400");
  assert.equal(curvesApi.mediaPlayheadTicks({
    timeBasisProven: true,
    startTicks: "900719925474099312345",
    inPointTicks: "500",
  }, "900719925474099312845"), "1000");
});

test("Premiere float arrays are normalized as readable PointF values", () => {
  assert.equal(curvesApi.valueKind([0.5, 0.25]), "pointf");
  assert.equal(curvesApi.valueFingerprint([0.5, 0.25]), "pointf:0.5,0.25");
});

test("bracketing is deterministic before, on, between, and after keys", () => {
  const keys = ["100", "200", "300"];
  assert.deepEqual(
    { state: curvesApi.bracketTickTimes(keys, "50").state, start: curvesApi.bracketTickTimes(keys, "50").startTicks, end: curvesApi.bracketTickTimes(keys, "50").endTicks },
    { state: "before-first", start: null, end: "100" },
  );
  assert.deepEqual(
    { state: curvesApi.bracketTickTimes(keys, "100").state, start: curvesApi.bracketTickTimes(keys, "100").startTicks, end: curvesApi.bracketTickTimes(keys, "100").endTicks },
    { state: "on-key-forward", start: "100", end: "200" },
  );
  assert.deepEqual(
    { state: curvesApi.bracketTickTimes(keys, "250").state, start: curvesApi.bracketTickTimes(keys, "250").startTicks, end: curvesApi.bracketTickTimes(keys, "250").endTicks },
    { state: "between", start: "200", end: "300" },
  );
  assert.deepEqual(
    { state: curvesApi.bracketTickTimes(keys, "300").state, start: curvesApi.bracketTickTimes(keys, "300").startTicks, end: curvesApi.bracketTickTimes(keys, "300").endTicks },
    { state: "on-key-backward", start: "200", end: "300" },
  );
  assert.deepEqual(
    { state: curvesApi.bracketTickTimes(keys, "400").state, start: curvesApi.bracketTickTimes(keys, "400").startTicks, end: curvesApi.bracketTickTimes(keys, "400").endTicks },
    { state: "after-last", start: "300", end: null },
  );
});

test("the sole segment between exactly two keys remains actionable outside the key range", () => {
  for (const [playhead, state] of [["50", "only-segment-before"], ["250", "only-segment-after"]]) {
    const bracket = curvesApi.bracketTickTimes(["100", "200"], playhead);
    assert.equal(bracket.state, state);
    assert.equal(bracket.hasSegment, true);
    assert.equal(bracket.startTicks, "100");
    assert.equal(bracket.endTicks, "200");
  }
});

test("a single exact key is not misrepresented as an editable segment", () => {
  const bracket = curvesApi.bracketTickTimes(["100"], "100");
  assert.equal(bracket.state, "single-key");
  assert.equal(bracket.hasSegment, false);
  assert.equal(bracket.startTicks, "100");
  assert.equal(bracket.endTicks, "100");
});

test("selection inspection uses matchName occurrence and parameter index/value kind identities", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  assert.equal(snapshot.status.code, curvesApi.REASON.OK);
  assert.equal(snapshot.selection.length, 1);
  assert.equal(snapshot.sequence.frameRate, 60);
  assert.equal(snapshot.sequence.ticksPerFrame, "250");
  assert.equal(snapshot.bindings.length, 2);
  assert.equal(snapshot.bindings[0].identity.component.matchName, "AE.ADBE Motion");
  assert.equal(snapshot.bindings[0].identity.component.occurrence, 0);
  assert.equal(snapshot.bindings[0].identity.parameter.index, 0);
  assert.equal(snapshot.bindings[0].identity.parameter.valueKind, "number");
  assert.equal(snapshot.bindings[0].ticksPerFrame, "250");
  assert.equal(snapshot.bindings[1].identity.component.occurrence, 1);
  assert.equal(snapshot.bindings[1].identity.parameter.valueKind, "pointf");
  assert.notEqual(snapshot.bindings[0].bindingId, snapshot.bindings[1].bindingId);
  assert.equal(snapshot.bindings[0].bracket.state, "between");
  assert.equal(snapshot.bindings[0].endpoints.start.value, 0);
  assert.equal(snapshot.bindings[0].endpoints.end.value, 1);
  assert.equal(snapshot.detectionSource, "selection");
  assert.equal(snapshot.autoDetected, false);
  assert.equal(host.calls.videoTrackCount, 0);
});

test("an empty Premiere selection auto-detects the topmost keyframed clip under the playhead", async (t) => {
  const host = createHost({ items: [] });
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  assert.equal(snapshot.status.code, curvesApi.REASON.OK);
  assert.equal(snapshot.detectionSource, "playhead");
  assert.equal(snapshot.autoDetected, true);
  assert.equal(snapshot.selection.length, 1);
  assert.equal(snapshot.bindings.length, 2);
  assert.match(snapshot.message, /auto-detected at the playhead/i);
  assert.equal(host.calls.videoTrackCount > 0, true);
  assert.ok(host.calls.videoTrackReads.length >= 1);
  assert.ok(host.calls.videoTrackReads.every((index) => index === 0));
  assert.deepEqual(host.calls.videoTrackItemReads[0], { index: 0, type: 1, includeEmpty: false });
});

test("auto-detection reports a clean empty state when no video clip crosses the playhead", async (t) => {
  const host = createHost({ items: [], playheadItems: [] });
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  assert.equal(snapshot.status.code, curvesApi.REASON.NO_CLIP_AT_PLAYHEAD);
  assert.equal(snapshot.state, "empty");
  assert.equal(snapshot.bindings.length, 0);
});

test("missing project and sequence produce reason-coded empty capabilities", async (t) => {
  const noProject = createAdapter(createHost({ noProject: true })).adapter;
  const noSequence = createAdapter(createHost({ noSequence: true })).adapter;
  t.after(() => { noProject.destroy(); noSequence.destroy(); });
  assert.equal((await startAndRefresh(noProject)).status.code, curvesApi.REASON.NO_ACTIVE_PROJECT);
  assert.equal((await startAndRefresh(noSequence)).status.code, curvesApi.REASON.NO_ACTIVE_SEQUENCE);
});

test("observation is visible-only, adaptive, event-assisted, and fully detached on destroy", async () => {
  const host = createHost();
  const scheduler = createScheduler();
  const { adapter } = createAdapter(host, { scheduler, visible: false });
  adapter.start();
  assert.equal(host.calls.getActiveProject, 0);
  assert.equal(scheduler.tasks.size, 0);
  adapter.setVisible(true);
  await adapter.requestRefresh("visible");
  assert.equal(host.calls.eventAdds.length, 3);
  assert.ok(scheduler.delays[scheduler.delays.length - 1] >= 100 && scheduler.delays[scheduler.delays.length - 1] <= 250);
  await scheduler.runNext();
  await adapter.requestRefresh("settle");
  assert.ok(scheduler.delays.some((delay) => delay > 100 && delay <= 250));
  const selectionListener = host.calls.eventAdds.find((entry) => entry.eventName === 12).listener;
  selectionListener();
  assert.equal(adapter.pollIntervalMs, 100);
  await adapter.requestRefresh("event-settle");
  assert.ok(scheduler.delays[scheduler.delays.length - 1] >= 100 && scheduler.delays[scheduler.delays.length - 1] <= 150);
  adapter.setActive(false);
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(host.calls.eventRemoves.length, 3);
  const callsBefore = host.calls.getActiveProject;
  await adapter.requestRefresh("hidden");
  assert.equal(host.calls.getActiveProject, callsBefore);
  adapter.destroy();
  assert.equal(scheduler.tasks.size, 0);
});

test("refresh requests coalesce and never overlap host selection reads", async (t) => {
  const gate = deferred();
  const host = createHost({ selectionGate: gate });
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  adapter.start();
  const one = adapter.requestRefresh("one");
  const two = adapter.requestRefresh("two");
  const three = adapter.requestRefresh("three");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.calls.maximumConcurrentSelection, 1);
  gate.resolve();
  await Promise.all([one, two, three]);
  assert.equal(host.calls.maximumConcurrentSelection, 1);
  assert.ok(host.calls.getSelection <= 2, `expected one read plus at most one coalesced follow-up, got ${host.calls.getSelection}`);
});

test("native planning re-resolves the active selection and rejects a stale snapshot", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  host.paramA.keys.get("0").value.value = 44;
  await assert.rejects(
    adapter.planNativeInterpolation(snapshot.bindings[0], "BEZIER"),
    (error) => error.code === curvesApi.REASON.STALE_BINDING,
  );
  assert.equal(host.calls.transactions, 0);
});

test("forward 1x nonzero starts and trims map sequence playhead time into the keyframe domain", async (t) => {
  const cases = [
    { startTicks: "100", playheadTicks: "600", expectedMediaPlayhead: "500" },
    { inPointTicks: "100", playheadTicks: "400", expectedMediaPlayhead: "500" },
    { startTicks: "100", inPointTicks: "200", playheadTicks: "400", expectedMediaPlayhead: "500" },
    { outPointTicks: "9000", durationTicks: "10000", expectedMediaPlayhead: "500" },
  ];
  for (const options of cases) {
    const host = createHost(options);
    const { adapter } = createAdapter(host);
    t.after(() => adapter.destroy());
    const snapshot = await startAndRefresh(adapter);
    assert.equal(snapshot.bindings[0].capabilities.nativeInterpolation.code, curvesApi.REASON.OK);
    assert.equal(snapshot.bindings[0].bracket.playheadTicks, options.expectedMediaPlayhead);
    const plan = await adapter.planNativeInterpolation(snapshot.bindings[0], "HOLD");
    assert.deepEqual(plan.keyframePolicy, { create: false, remove: false, move: false });
  }
});

test("speed-remapped and reversed clips fail closed as unproven time bases", async (t) => {
  for (const options of [{ speed: 2 }, { reversed: true }]) {
    const host = createHost(options);
    const { adapter } = createAdapter(host);
    t.after(() => adapter.destroy());
    const snapshot = await startAndRefresh(adapter);
    assert.equal(snapshot.bindings[0].capabilities.nativeInterpolation.code, curvesApi.REASON.UNPROVEN_TIME_BASIS);
    await assert.rejects(adapter.planNativeInterpolation(snapshot.bindings[0], "HOLD"),
      (error) => error.code === curvesApi.REASON.UNPROVEN_TIME_BASIS);
    assert.equal(host.calls.transactions, 0);
  }
});

test("native Apply creates all actions synchronously in one locked transaction and verifies readback", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const plan = await adapter.planNativeInterpolation(snapshot.bindings[0], "BEZIER", { undoString: "Blocky Studios Curves Acceptance" });
  assert.deepEqual(plan.keyframePolicy, { create: false, remove: false, move: false });
  assert.deepEqual(plan.temporalShape, { interpolationMode: "BEZIER", customTangentsApplied: false, tangentOwner: "premiere" });
  const receipt = await adapter.applyNativeInterpolation(plan);
  assert.equal(host.calls.lockedAccess, 1);
  assert.equal(host.calls.transactions, 1);
  assert.equal(host.calls.addAction, 1);
  assert.deepEqual(host.calls.undoStrings, ["Blocky Studios Curves Acceptance"]);
  assert.equal(host.paramA.keys.get("0").mode, 0);
  assert.equal(receipt.committed, true);
  assert.equal(receipt.operationCount, 1);
  assert.ok(receipt.operations.every((operation) => operation.endpointTimesPreserved && operation.endpointValuesPreserved));
  assert.deepEqual([receipt.createdKeyCount, receipt.removedKeyCount, receipt.movedKeyCount], [0, 0, 0]);
  assert.equal(receipt.customTangentsApplied, false);
  assert.equal(receipt.tangentOwner, "premiere");
  assert.deepEqual(receipt.keyOwnership.createdKeys, []);
});

test("native Apply works for an exactly-two-key property when the selected clip playhead is outside it", async (t) => {
  const host = createHost({ playheadTicks: "5000" });
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const binding = snapshot.bindings[0];
  assert.equal(binding.keyTicks.length, 2);
  assert.equal(binding.bracket.state, "only-segment-after");
  assert.equal(binding.capabilities.nativeInterpolation.code, curvesApi.REASON.OK);
  const plan = await adapter.planNativeInterpolation(binding, "BEZIER", { undoString: "Blocky Studios Curves Outside Range" });
  const receipt = await adapter.applyNativeInterpolation(plan);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.createdKeyCount, 0);
  assert.equal(host.paramA.keys.get("0").mode, 0);
  assert.equal(host.calls.transactions, 1);
});

test("native Apply supports PointF Motion properties without creating sampled keys", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const pointBinding = snapshot.bindings.find((binding) => binding.identity.parameter.valueKind === "pointf");
  assert.ok(pointBinding);
  assert.equal(pointBinding.capabilities.nativeInterpolation.code, curvesApi.REASON.OK);
  const plan = await adapter.planNativeInterpolation(pointBinding, "BEZIER", { undoString: "Blocky Studios Curves Position" });
  assert.deepEqual(plan.keyframePolicy, { create: false, remove: false, move: false });
  const receipt = await adapter.applyNativeInterpolation(plan);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.createdKeyCount, 0);
  assert.equal(host.paramB.keys.get("0").mode, 0);
  assert.equal(host.paramB.calls.add, 0);
});

test("a no-change native plan avoids creating a meaningless Undo step", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const plan = await adapter.planNativeInterpolation(snapshot.bindings[0], "LINEAR");
  const receipt = await adapter.applyNativeInterpolation(plan);
  assert.equal(host.calls.transactions, 0);
  assert.equal(receipt.changed, false);
  assert.equal(receipt.committed, false);
});

test("Apply rejects stale plans before entering lockedAccess", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const plan = await adapter.planNativeInterpolation(snapshot.bindings[0], "HOLD");
  host.paramA.keys.get("0").value.value = 7;
  await assert.rejects(adapter.applyNativeInterpolation(plan), (error) => error.code === curvesApi.REASON.STALE_BINDING);
  assert.equal(host.calls.lockedAccess, 0);
  assert.equal(host.calls.transactions, 0);
});

test("compound addAction rejection and false transaction results are hard failures", async (t) => {
  const rejectedHost = createHost({ addActionResult: false });
  const failedHost = createHost({ transactionResult: false });
  const rejected = createAdapter(rejectedHost).adapter;
  const failed = createAdapter(failedHost).adapter;
  t.after(() => { rejected.destroy(); failed.destroy(); });
  const rejectedSnapshot = await startAndRefresh(rejected);
  const failedSnapshot = await startAndRefresh(failed);
  const rejectedPlan = await rejected.planNativeInterpolation(rejectedSnapshot.bindings[0], "HOLD");
  const failedPlan = await failed.planNativeInterpolation(failedSnapshot.bindings[0], "HOLD");
  await assert.rejects(rejected.applyNativeInterpolation(rejectedPlan), (error) => error.code === curvesApi.REASON.ACTION_REJECTED);
  await assert.rejects(failed.applyNativeInterpolation(failedPlan), (error) => error.code === curvesApi.REASON.TRANSACTION_FAILED);
  assert.equal(rejectedHost.paramA.keys.get("0").mode, 2);
  assert.equal(failedHost.paramA.keys.get("0").mode, 2);
});

test("readback mismatch is reported instead of being hidden", async (t) => {
  const param = createParam({ ignoreInterpolationCommit: true });
  const host = createHost({ paramA: param });
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const plan = await adapter.planNativeInterpolation(snapshot.bindings[0], "BEZIER");
  await assert.rejects(
    adapter.applyNativeInterpolation(plan),
    (error) => error.code === curvesApi.REASON.INTERPOLATION_READBACK_MISMATCH && error.details.transactionCommitted === true,
  );
});

test("baked planning stays disabled without proof and rejects non-scalar sample generation", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const generated = Object.fromEntries(snapshot.bindings.map((binding) => [binding.bindingId, [{ ticks: "500", value: 0.5 }]]));
  const contract = await adapter.planBakedCurve(snapshot.bindings, generated);
  assert.equal(contract.executable, false);
  assert.equal(contract.destructiveCleanupAllowed, false);
  assert.equal(contract.capability.code, curvesApi.REASON.BAKED_RUNTIME_PROOF_REQUIRED);
  assert.equal(contract.operations[0].capability.code, curvesApi.REASON.BAKED_RUNTIME_PROOF_REQUIRED);
  assert.equal(contract.operations[1].capability.code, curvesApi.REASON.VALUE_KIND_UNSUPPORTED);
  await assert.rejects(adapter.applyBakedCurve(contract), (error) => error.code === curvesApi.REASON.BAKED_RUNTIME_PROOF_REQUIRED);
  assert.equal(host.calls.transactions, 0);
});

test("a validated numeric runtime proof enables one-transaction baked Apply and exact owned-key cleanup", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host, { bakedRuntimeProof: acceptedBakedProof() });
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  assert.equal(snapshot.capabilities.bakedCurve.supported, true);
  assert.equal(snapshot.bindings[0].capabilities.bakedCurve.supported, true);
  assert.equal(snapshot.bindings[1].capabilities.bakedCurve.code, curvesApi.REASON.VALUE_KIND_UNSUPPORTED);
  const binding = snapshot.bindings[0];
  const plan = await adapter.planBakedCurve(binding, [
    { ticks: "0", value: 0 },
    { ticks: "250", value: 0.1 },
    { ticks: "750", value: 0.9 },
    { ticks: "1000", value: 1 },
  ], { undoString: "Blocky Studios Curves Baked Acceptance" });
  assert.equal(plan.executable, true);
  assert.equal(plan.operations[0].candidateKeyCount, 2);
  const receipt = await adapter.applyBakedCurve(plan);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.oneUndoStep, true);
  assert.equal(receipt.createdKeyCount, 2);
  assert.equal(host.calls.transactions, 1);
  assert.equal(host.calls.addAction, 2);
  assert.equal(host.paramA.keys.get("250").mode, 2);
  assert.equal(host.paramA.keys.get("750").value.value, 0.9);
  const cleanup = await adapter.cleanupOwnedKeys(receipt);
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.verified, true);
  assert.equal(cleanup.oneUndoStep, true);
  assert.equal(cleanup.removedKeyCount, 2);
  assert.equal(host.calls.transactions, 2);
  assert.equal(host.paramA.keys.has("250"), false);
  assert.equal(host.paramA.keys.has("750"), false);
  const repeated = await adapter.cleanupOwnedKeys(receipt);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.removedKeyCount, 0);
});

test("baked planning requires the exact host ticks-per-frame grid", async (t) => {
  const missingHost = createHost({ noFrameRate: true });
  const missing = createAdapter(missingHost, { bakedRuntimeProof: acceptedBakedProof() }).adapter;
  const host = createHost();
  const { adapter } = createAdapter(host, { bakedRuntimeProof: acceptedBakedProof() });
  t.after(() => { missing.destroy(); adapter.destroy(); });
  const missingSnapshot = await startAndRefresh(missing);
  assert.equal(missingSnapshot.sequence.ticksPerFrame, null);
  assert.equal(missingSnapshot.capabilities.frameQuantization.code, curvesApi.REASON.FRAME_QUANTIZATION_UNAVAILABLE);
  assert.equal(missingSnapshot.bindings[0].capabilities.bakedCurve.code, curvesApi.REASON.FRAME_QUANTIZATION_UNAVAILABLE);
  const snapshot = await startAndRefresh(adapter);
  await assert.rejects(
    adapter.planBakedCurve(snapshot.bindings[0], []),
    (error) => error.code === curvesApi.REASON.INVALID_PLAN && error.details.emptyBake === true,
  );
  await assert.rejects(
    adapter.planBakedCurve(snapshot.bindings[0], [{ ticks: "333", value: 0.5 }]),
    (error) => error.code === curvesApi.REASON.INVALID_PLAN && error.details.frameAligned === false && error.details.ticksPerFrame === "250",
  );
  assert.equal(host.calls.transactions, 0);
});

test("baked cleanup aborts all removals when any issued key no longer matches its ownership receipt", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host, { bakedRuntimeProof: acceptedBakedProof() });
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const plan = await adapter.planBakedCurve(snapshot.bindings[0], [
    { ticks: "250", value: 0.25 },
    { ticks: "750", value: 0.75 },
  ]);
  const receipt = await adapter.applyBakedCurve(plan);
  host.paramA.keys.get("250").value.value = 99;
  await assert.rejects(
    adapter.cleanupOwnedKeys(receipt),
    (error) => error.code === curvesApi.REASON.CLEANUP_OWNERSHIP_REQUIRED,
  );
  assert.equal(host.paramA.keys.has("250"), true);
  assert.equal(host.paramA.keys.has("750"), true);
  assert.equal(host.paramA.calls.remove, 0);
  assert.equal(host.calls.transactions, 1);
});

test("an identical-looking replacement key is not treated as Blocky Studios-owned", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host, { bakedRuntimeProof: acceptedBakedProof() });
  t.after(() => adapter.destroy());
  const snapshot = await startAndRefresh(adapter);
  const plan = await adapter.planBakedCurve(snapshot.bindings[0], [{ ticks: "500", value: 0.5 }]);
  const receipt = await adapter.applyBakedCurve(plan);
  host.paramA.keys.set("500", createKeyframe("500", 0.5, 2));
  await assert.rejects(
    adapter.cleanupOwnedKeys(receipt),
    (error) => error.code === curvesApi.REASON.CLEANUP_OWNERSHIP_REQUIRED && error.details.keyIdentityChanged === true,
  );
  assert.equal(host.paramA.keys.has("500"), true);
  assert.equal(host.paramA.calls.remove, 0);
});

test("cleanup cannot remove keys because no physically proven ownership receipt issuer exists", async (t) => {
  const host = createHost();
  const { adapter } = createAdapter(host);
  t.after(() => adapter.destroy());
  const result = await adapter.cleanupOwnedKeys({
    kind: "oracle-baked-key-receipt",
    keys: [{ bindingId: "forged", ticks: "500", createdByOracle: true }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.removedKeyCount, 0);
  assert.equal(host.paramA.calls.remove, 0);
  assert.equal(host.calls.transactions, 0);
});
