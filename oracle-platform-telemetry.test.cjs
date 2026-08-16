// @ts-nocheck -- Node test harness is outside the UXP type surface.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createOraclePlatformTelemetry } = require("./src/core/oracle-platform-telemetry.js");

function harness() {
  let clock = 10;
  const diagnostics = [];
  const captures = [];
  const windowValue = {
    performance: { now: () => clock },
    oracleDiagnostics: { record: (level, code, details) => diagnostics.push({ level, code, details }) },
    oracleUiRuntime: { capture: (root, reason) => captures.push({ root, reason }) },
  };
  return {
    telemetry: createOraclePlatformTelemetry({ window: windowValue, capacity: 100, now: () => clock }),
    diagnostics,
    captures,
    advance(value) { clock += value; },
  };
}

test("platform calls preserve synchronous return values and record bounded completion", () => {
  const state = harness();
  const result = state.telemetry.invoke("premiere", "Project.getActiveProject", () => {
    state.advance(4);
    return 42;
  }, { panelId: "oraclePanel" });
  assert.equal(result, 42);
  const audit = state.telemetry.audit();
  assert.equal(audit.activeCallCount, 0);
  assert.equal(audit.completedCallCount, 1);
  assert.equal(audit.callCategoryCounts.premiere, 1);
  const completion = audit.records.find((entry) => entry.kind === "platform-call");
  assert.equal(completion.details.status, "succeeded");
  assert.equal(completion.details.durationMs, 4);
  assert.ok(state.diagnostics.some((entry) => entry.code === "PLATFORM_CALL_SUCCEEDED"));
});

test("asynchronous platform calls remain active until the original promise settles", async () => {
  const state = harness();
  let resolve;
  const pending = new Promise((complete) => { resolve = complete; });
  const result = state.telemetry.invoke("native-addon", "prepareReplayMedia", () => pending);
  assert.equal(state.telemetry.audit().activeCallCount, 1);
  state.advance(9);
  resolve("ready");
  assert.equal(await result, "ready");
  const audit = state.telemetry.audit();
  assert.equal(audit.activeCallCount, 0);
  assert.equal(audit.callCategoryCounts["native-addon"], 1);
  assert.equal(audit.records.find((entry) => entry.kind === "platform-call").details.durationMs, 9);
});

test("platform failures preserve the exact thrown error and record failure", async () => {
  const state = harness();
  const failure = new Error("host rejected transaction");
  await assert.rejects(
    state.telemetry.invoke("premiere", "Project.executeTransaction", () => Promise.reject(failure)),
    (error) => error === failure,
  );
  const completion = state.telemetry.audit().records.find((entry) => entry.kind === "platform-call");
  assert.equal(completion.details.status, "failed");
  assert.equal(completion.details.error, failure.message);
});

test("tab tracing captures the measured panel root and ignores no-op transitions", () => {
  const state = harness();
  const root = {};
  assert.equal(state.telemetry.tabSwitch({ panelId: "oraclePanel", group: "workspace-route", from: "replays", to: "curves", root }).kind, "tab-switch");
  assert.equal(state.telemetry.tabSwitch({ panelId: "oraclePanel", group: "workspace-route", from: "curves", to: "curves", root }), null);
  assert.deepEqual(state.captures, [{ root, reason: "tab:workspace-route:curves" }]);
  assert.equal(state.telemetry.audit().tabSwitchCount, 1);
});

test("UI interactions record immediate intent and a bounded settled measurement", async () => {
  const state = harness();
  const root = {};
  const entry = state.telemetry.interaction({
    panelId: "oraclePanel",
    name: "preferences",
    action: "open",
    state: "profile",
    root,
  });
  assert.equal(entry.kind, "ui-interaction");
  state.advance(6);
  await Promise.resolve();
  const audit = state.telemetry.audit();
  assert.equal(audit.uiInteractionCount, 1);
  const settled = audit.records.find((record) => record.kind === "ui-interaction-settled");
  assert.equal(settled.details.durationMs, 6);
  assert.ok(state.diagnostics.some((record) => record.code === "PLATFORM_UI_INTERACTION"));
});

test("resource ownership reports duplicates and idempotently releases each claim", () => {
  const state = harness();
  const first = state.telemetry.claimResource("first", "resize-observer", "oraclePanel");
  const second = state.telemetry.claimResource("second", "resize-observer", "oraclePanel");
  assert.equal(state.telemetry.audit().duplicateResources.length, 1);
  assert.ok(state.diagnostics.some((entry) => entry.code === "PLATFORM_DUPLICATE_RESOURCE"));
  assert.equal(first.release(), true);
  assert.equal(first.release(), false);
  assert.equal(state.telemetry.audit().duplicateResources.length, 0);
  assert.equal(second.release(), true);
  assert.equal(state.telemetry.audit().activeResourceCount, 0);
});

test("telemetry retention is bounded under repeated host calls", () => {
  const state = harness();
  for (let index = 0; index < 120; index += 1) {
    state.telemetry.invoke("premiere", `call-${index}`, () => index);
  }
  const audit = state.telemetry.audit();
  assert.equal(audit.bounded, true);
  assert.equal(audit.capacity, 100);
  assert.equal(audit.retained, 100);
  assert.equal(audit.activeCallCount, 0);
});
