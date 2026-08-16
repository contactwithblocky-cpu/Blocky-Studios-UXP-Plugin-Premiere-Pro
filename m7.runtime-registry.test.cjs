// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const runtimeApi = require("./src/app/oracle-runtime-registry.js");
const viewerApi = require("./src/replays/oracle-replay-viewer.js");

function viewerElement(tagName = "DIV") {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  return {
    tagName,
    hidden: false,
    disabled: false,
    value: "",
    min: "",
    max: "",
    step: "",
    title: "",
    textContent: "",
    dataset: {},
    isContentEditable: false,
    parentElement: null,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type);
      if (entries) entries.delete(listener);
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    appendChild(child) { children.push(child); child.parentElement = this; return child; },
    contains(candidate) {
      return candidate === this || children.some((child) => child.contains ? child.contains(candidate) : child === candidate);
    },
  };
}

function viewerElements() {
  const root = viewerElement("SECTION");
  const elements = {
    replayViewerTray: root,
    replayViewerTitle: viewerElement("H2"),
    replayViewerMode: viewerElement("SPAN"),
    replayViewerClose: viewerElement("BUTTON"),
    replayViewerPoster: viewerElement("IMG"),
    replayViewerPlayPause: viewerElement("BUTTON"),
    replayViewerStepBack: viewerElement("BUTTON"),
    replayViewerStepForward: viewerElement("BUTTON"),
    replayViewerCurrentTime: viewerElement("SPAN"),
    replayViewerDuration: viewerElement("SPAN"),
    replayViewerScrub: viewerElement("INPUT"),
    replayViewerMute: viewerElement("BUTTON"),
    replayViewerVolume: viewerElement("INPUT"),
    replayViewerRate: viewerElement("SELECT"),
    replayViewerLoop: viewerElement("BUTTON"),
    replayViewerStatus: viewerElement("P"),
    replayViewerError: viewerElement("P"),
    replayViewerSupport: viewerElement("P"),
  };
  for (const [key, element] of Object.entries(elements)) {
    if (key !== "replayViewerTray") root.appendChild(element);
  }
  return elements;
}

function viewerReplay(id) {
  return {
    id,
    displayName: `Replay ${id}`,
    canonicalPath: `D:\\Blocky Studios Exports\\${id}.mov`,
  };
}

test("activation leases aggregate visible-and-active observation and start the raw adapter once", async () => {
  const lifecycle = [];
  let starts = 0;
  let destroys = 0;
  const adapter = {
    marker: "raw-adapter",
    start() {
      starts += 1;
      return this;
    },
    setVisible(value) { lifecycle.push(["visible", value]); },
    setActive(value) { lifecycle.push(["active", value]); },
    requestRefresh(reason) { return { reason, receiver: this.marker }; },
    destroy() { destroys += 1; },
  };
  const coordinator = new runtimeApi.ActivationLeaseCoordinator(adapter, { now: () => 10 });
  const main = coordinator.acquireLease("main-curves");
  const dedicated = coordinator.acquireLease("dedicated-curves");

  assert.equal(main.start(), adapter);
  assert.equal(dedicated.start(), adapter);
  assert.equal(starts, 1);
  lifecycle.length = 0;

  main.setVisible(true);
  dedicated.setActive(true);
  assert.deepEqual(lifecycle, []);
  assert.equal(coordinator.getState().observe, false);

  main.setActive(true);
  assert.deepEqual(lifecycle, [["visible", true], ["active", true]]);
  assert.equal(coordinator.getState().observe, true);

  dedicated.setVisible(true);
  dedicated.setActive(true);
  assert.equal(main.release(), true);
  assert.equal(coordinator.getState().observe, true);
  assert.deepEqual(lifecycle, [["visible", true], ["active", true]]);

  dedicated.setActive(false);
  assert.equal(coordinator.getState().observe, false);
  assert.deepEqual(lifecycle, [
    ["visible", true],
    ["active", true],
    ["active", false],
    ["visible", false],
  ]);
  assert.deepEqual(dedicated.requestRefresh("lease-forward"), {
    reason: "lease-forward",
    receiver: "raw-adapter",
  });
  assert.equal(destroys, 0);

  assert.equal(dedicated.destroy(), true);
  assert.equal(dedicated.release(), false);
  assert.equal(coordinator.getState().leaseCount, 0);
  assert.ok(coordinator.getDiagnostics().some((entry) =>
    entry.code === "ACTIVATION_LEASE_RELEASE_ALREADY_RELEASED" && entry.leaseCount === 0));
  assert.equal(destroys, 0, "a panel lease must not destroy the raw adapter");

  assert.equal(await coordinator.destroy(), true);
  assert.equal(await coordinator.destroy(), true);
  assert.equal(destroys, 1);
});

test("concurrent activation lease starts share one asynchronous raw start", async () => {
  let starts = 0;
  let resolveStart;
  const started = new Promise((resolve) => { resolveStart = resolve; });
  const adapter = {
    start() { starts += 1; return started; },
    setVisible() {},
    setActive() {},
  };
  const coordinator = runtimeApi.createActivationLeaseCoordinator(adapter);
  const first = coordinator.acquireLease("first");
  const second = coordinator.acquireLease("second");
  const firstStart = first.start();
  const secondStart = second.start();
  assert.equal(firstStart, secondStart);
  assert.equal(starts, 1);
  resolveStart("ready");
  assert.equal(await firstStart, "ready");
  await coordinator.destroy();
});

test("activation coordinator teardown destroys the raw adapter even when deactivation throws", async () => {
  let destroys = 0;
  let failDeactivation = false;
  const adapter = {
    setVisible() {},
    setActive(value) { if (value === false && failDeactivation) throw new Error("deactivation failed"); },
    destroy() { destroys += 1; },
  };
  const coordinator = new runtimeApi.ActivationLeaseCoordinator(adapter);
  const lease = coordinator.acquireLease("throwing-activation");
  lease.setVisible(true);
  lease.setActive(true);
  assert.equal(coordinator.getState().observe, true);
  failDeactivation = true;
  assert.equal(await coordinator.destroy(), true);
  assert.equal(destroys, 1);
  assert.equal(coordinator.getState().destroyed, true);
  assert.equal(coordinator.getState().leaseCount, 0);
  assert.ok(coordinator.getDiagnostics().some((entry) => entry.code === "ACTIVATION_DESTROY_DEACTIVATE_FAILED"));
});

test("Source Monitor leases serialize opens, revoke the prior owner, and gate every owned operation", async () => {
  const calls = [];
  const revoked = [];
  let destroys = 0;
  const adapter = {
    isAvailable() { return this === adapter; },
    async open(replay) {
      calls.push(["open", replay.id]);
      await Promise.resolve();
      return { ownershipToken: `token-${replay.id}`, replayId: replay.id };
    },
    async close(token) {
      calls.push(["close", token]);
      return { ok: true, closed: true, ownershipLost: false };
    },
    async play(value) {
      calls.push(["play", value]);
      return true;
    },
    async getPosition() {
      calls.push(["position"]);
      return 12.5;
    },
    destroy() { destroys += 1; },
  };
  const coordinator = new runtimeApi.SourceMonitorViewerLeaseCoordinator(adapter, { now: () => 20 });
  const main = coordinator.acquireLease("main-replays", {
    onRevoked(event) { revoked.push(event); },
  });
  const dedicated = coordinator.acquireLease("dedicated-replays");

  assert.equal(main.isAvailable(), true);
  const firstOpen = main.open({ id: "one" });
  const secondOpen = dedicated.open({ id: "two" });
  assert.equal((await firstOpen).ownershipToken, "token-one");
  assert.equal((await secondOpen).ownershipToken, "token-two");
  assert.deepEqual(calls, [
    ["open", "one"],
    ["close", "token-one"],
    ["open", "two"],
  ]);
  assert.equal(main.isOwner(), false);
  assert.equal(dedicated.isOwner(), true);
  assert.equal(dedicated.ownershipToken, "token-two");
  assert.equal(coordinator.getState().ownerId, "dedicated-replays");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].reason, "superseded");
  assert.equal(revoked[0].ownershipToken, "token-one");

  await assert.rejects(
    main.play(true),
    (error) => error && error.code === "VIEWER_LEASE_NOT_OWNER",
  );
  assert.equal(await dedicated.play(true), true);
  assert.equal(await dedicated.getPosition(), 12.5);
  assert.deepEqual(calls.slice(-2), [["play", true], ["position"]]);

  assert.equal(await main.destroy(), true);
  assert.equal(destroys, 0);
  assert.equal(await dedicated.destroy(), true);
  assert.deepEqual(calls.slice(-1), [["close", "token-two"]]);
  assert.equal(destroys, 0, "panel teardown must not destroy the raw Source Monitor adapter");
  assert.equal(await dedicated.release(), false);
  assert.equal(coordinator.getState().leaseCount, 0);
  assert.ok(coordinator.getDiagnostics().some((entry) =>
    entry.code === "VIEWER_LEASE_RELEASE_ALREADY_RELEASED" && entry.leaseCount === 0));

  assert.equal(await coordinator.destroy(), true);
  assert.equal(await coordinator.destroy(), true);
  assert.equal(destroys, 1);
});

test("a failed prior-owner close blocks the next open and preserves exact ownership", async () => {
  const calls = [];
  let rejectClose = true;
  const adapter = {
    async open(replay) {
      calls.push(["open", replay.id]);
      return { ownershipToken: `token-${replay.id}` };
    },
    async close(token) {
      calls.push(["close", token]);
      if (rejectClose) throw new Error("Premiere refused close");
      return { ok: true, closed: true };
    },
  };
  const coordinator = runtimeApi.createSourceMonitorViewerLeaseCoordinator(adapter, { now: () => 30 });
  const first = coordinator.acquireLease("first-viewer");
  const second = coordinator.acquireLease("second-viewer");
  await first.open({ id: "one" });

  await assert.rejects(second.open({ id: "two" }), /Premiere refused close/);
  assert.deepEqual(calls, [["open", "one"], ["close", "token-one"]]);
  assert.equal(first.isOwner(), true);
  assert.equal(second.isOwner(), false);
  assert.equal(coordinator.getState().ownerId, "first-viewer");
  assert.ok(coordinator.getDiagnostics().some((entry) => entry.code === "VIEWER_OWNER_CLOSE_FAILED"));

  rejectClose = false;
  assert.equal(await first.release(), true);
  assert.equal(await second.release(), true);
  assert.equal(coordinator.getState().leaseCount, 0);
  await coordinator.destroy();
});

test("tokenless viewer opens are cleaned up and never create an owner", async () => {
  const calls = [];
  const adapter = {
    async open() { calls.push(["open"]); return { mode: "source-monitor" }; },
    async close(token) { calls.push(["close", token]); return { ok: true, closed: true }; },
  };
  const coordinator = new runtimeApi.SourceMonitorViewerLeaseCoordinator(adapter);
  const lease = coordinator.acquireLease("tokenless");
  await assert.rejects(
    lease.open({ id: "missing-token" }),
    (error) => error && error.code === "VIEWER_OWNERSHIP_TOKEN_MISSING",
  );
  assert.deepEqual(calls, [["open"], ["close", undefined]]);
  assert.equal(coordinator.getState().ownerLeaseId, "");
  await lease.release();
  await coordinator.destroy();
});

test("viewer coordinator teardown destroys the raw adapter even when owner close fails", async () => {
  let destroys = 0;
  const adapter = {
    async open() { return { ownershipToken: "token-owned" }; },
    async close() { throw new Error("close failed"); },
    async destroy() { destroys += 1; },
  };
  const coordinator = new runtimeApi.SourceMonitorViewerLeaseCoordinator(adapter);
  const lease = coordinator.acquireLease("throwing-viewer");
  await lease.open({ id: "owned" });
  assert.equal(await coordinator.destroy(), true);
  assert.equal(destroys, 1);
  assert.equal(coordinator.getState().destroyed, true);
  assert.equal(coordinator.getState().leaseCount, 0);
  assert.equal(coordinator.getState().ownerLeaseId, "");
  assert.ok(coordinator.getDiagnostics().some((entry) => entry.code === "VIEWER_DESTROY_OWNER_CLOSE_FAILED"));
});

test("same-panel replay replacement ignores a normal close revocation and reaches the second raw open", async () => {
  const calls = [];
  const revocations = [];
  const rawAdapter = {
    isAvailable() { return true; },
    async open(replay) {
      calls.push(["open", replay.id]);
      return {
        mode: "source-monitor",
        ownershipToken: `token-${replay.id}`,
        supports: { playPause: true, seek: false, frameStep: false, mute: false, volume: false, speed: false, loop: false },
      };
    },
    async close(token) {
      calls.push(["close", token]);
      return { ok: true, closed: true, ownershipLost: false };
    },
    async play() { return true; },
    async getPosition() { return 0; },
    async seek(value) { return value; },
    async destroy() {},
  };
  const coordinator = new runtimeApi.SourceMonitorViewerLeaseCoordinator(rawAdapter);
  let viewer = null;
  const lease = coordinator.acquireLease("main-replays", {
    onRevoked(event) {
      revocations.push(event.reason);
      if (event.reason === "superseded" && viewer) void viewer.close("superseded");
    },
  });
  viewer = new viewerApi.ReplayViewerController(viewerElements(), {
    adapter: lease,
    document: { activeElement: null },
    setInterval: () => 1,
    clearInterval() {},
  });
  viewer.start();

  const firstOpened = await viewer.openReplay(viewerReplay("one"));
  assert.equal(firstOpened, true, JSON.stringify({ state: viewer.getState(), calls, revocations }));
  assert.equal(await viewer.openReplay(viewerReplay("two")), true);
  assert.equal(viewer.getState().replayId, "two");
  assert.deepEqual(calls, [["open", "one"], ["close", "token-one"], ["open", "two"]]);
  assert.deepEqual(revocations, ["closed"]);

  await viewer.destroy();
  await coordinator.destroy();
});
