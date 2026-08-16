"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const viewerApi = require("./src/replays/oracle-replay-viewer.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function fakeElement(tagName = "DIV") {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  const element = {
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
    isConnected: true,
    focusCount: 0,
    parentElement: null,
    focus() { this.focusCount += 1; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type);
      if (!entries) return;
      entries.delete(listener);
      if (entries.size === 0) listeners.delete(type);
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    appendChild(child) {
      children.push(child);
      child.parentElement = this;
      return child;
    },
    contains(candidate) {
      if (candidate === this) return true;
      return children.some((child) => child.contains ? child.contains(candidate) : child === candidate);
    },
    dispatch(type, init = {}) {
      const event = {
        type,
        target: init.target || this,
        currentTarget: this,
        relatedTarget: init.relatedTarget || null,
        key: init.key || "",
        repeat: Boolean(init.repeat),
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...init,
      };
      for (const listener of Array.from(listeners.get(type) || [])) listener(event);
      return event;
    },
    listenerCount(type) { return (listeners.get(type) || new Set()).size; },
  };
  return element;
}

function createElements() {
  const root = fakeElement("SECTION");
  const elements = {
    replayViewerTray: root,
    replayViewerTitle: fakeElement("H2"),
    replayViewerMode: fakeElement("SPAN"),
    replayViewerClose: fakeElement("BUTTON"),
    replayViewerPoster: fakeElement("IMG"),
    replayViewerPlayPause: fakeElement("BUTTON"),
    replayViewerStepBack: fakeElement("BUTTON"),
    replayViewerStepForward: fakeElement("BUTTON"),
    replayViewerCurrentTime: fakeElement("SPAN"),
    replayViewerDuration: fakeElement("SPAN"),
    replayViewerScrub: fakeElement("INPUT"),
    replayViewerMute: fakeElement("BUTTON"),
    replayViewerVolume: fakeElement("INPUT"),
    replayViewerRate: fakeElement("SELECT"),
    replayViewerLoop: fakeElement("BUTTON"),
    replayViewerStatus: fakeElement("P"),
    replayViewerError: fakeElement("P"),
    replayViewerSupport: fakeElement("P"),
  };
  for (const [key, element] of Object.entries(elements)) {
    if (key !== "replayViewerTray") root.appendChild(element);
  }
  return elements;
}

function replay(id, options = {}) {
  return {
    id,
    displayName: options.displayName || `Replay ${id}`,
    canonicalPath: options.path || `D:\\Blocky Studios Exports\\${id}.mov`,
    durationMs: options.durationMs,
    fps: options.fps,
  };
}

function createScheduler() {
  let nextId = 1;
  const callbacks = new Map();
  const cleared = [];
  return {
    callbacks,
    cleared,
    setInterval(callback, delay) {
      const id = nextId++;
      callbacks.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      cleared.push(id);
      callbacks.delete(id);
    },
    async tick() {
      for (const entry of Array.from(callbacks.values())) entry.callback();
      await flush();
    },
  };
}

function createAdapter(options = {}) {
  const calls = {
    open: [],
    play: [],
    getPosition: 0,
    seek: [],
    close: [],
    destroy: 0,
  };
  let currentToken = "";
  let position = options.position || 0;
  const adapter = {
    calls,
    available: options.available !== false,
    isAvailable() { return this.available; },
    async open(record) {
      calls.open.push(record.id);
      if (options.open) {
        const result = await options.open(record, calls.open.length);
        currentToken = result && result.ownershipToken || currentToken;
        return result;
      }
      currentToken = `token-${record.id}`;
      const durationMs = Number(record.durationMs);
      const fps = Number(record.fps);
      return {
        mode: "source-monitor",
        ownershipToken: currentToken,
        durationSeconds: Number.isFinite(durationMs) ? durationMs / 1000 : null,
        fps: Number.isFinite(fps) ? fps : null,
        supports: {
          playPause: true,
          seek: Number.isFinite(durationMs),
          frameStep: Number.isFinite(fps),
          mute: false,
          volume: false,
          speed: false,
          loop: false,
        },
      };
    },
    async play(playing) {
      calls.play.push(Boolean(playing));
      if (options.play) return options.play(Boolean(playing));
      return true;
    },
    async getPosition() {
      calls.getPosition += 1;
      if (options.getPosition) return options.getPosition(calls.getPosition);
      return position;
    },
    async seek(seconds) {
      calls.seek.push(seconds);
      if (options.seek) return options.seek(seconds, calls.seek.length);
      position = seconds;
      return position;
    },
    async close(token) {
      calls.close.push(token);
      if (options.close) return options.close(token, currentToken);
      const closed = Boolean(token && token === currentToken);
      if (closed) currentToken = "";
      return { ok: true, closed, ownershipLost: Boolean(token && !closed) };
    },
    async destroy() { calls.destroy += 1; },
  };
  return adapter;
}

function createHarness(options = {}) {
  const elements = createElements();
  const adapter = options.adapter || createAdapter();
  const scheduler = createScheduler();
  const usage = [];
  const toasts = [];
  const announcements = [];
  const states = [];
  const document = { activeElement: null };
  const controller = new viewerApi.ReplayViewerController(elements, {
    adapter,
    document,
    now: () => 123456,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
    pollIntervalMs: options.pollIntervalMs || 150,
    onUsage: (event) => usage.push(event),
    onToast: (...args) => toasts.push(args),
    onAnnounce: (message) => announcements.push(message),
    onStateChange: (state) => states.push(state),
  });
  return { controller, elements, adapter, scheduler, usage, toasts, announcements, states, document };
}

test("M4 viewer exports a bounded Source Monitor contract and precise time formatting", () => {
  assert.equal(viewerApi.SOURCE_MONITOR_MODE, "source-monitor");
  assert.equal(typeof viewerApi.ReplayViewerController, "function");
  assert.equal(viewerApi.formatViewerTime(null), "--:--");
  assert.equal(viewerApi.formatViewerTime(0), "00:00.00");
  assert.equal(viewerApi.formatViewerTime(12.089), "00:12.08");
  assert.equal(viewerApi.formatViewerTime(3723.459), "1:02:03.45");
  assert.deepEqual([...viewerApi.normalizeReplayIds([" a ", "", "a", "b"])], ["a", "b"]);
});

test("M4 viewer starts hidden, accepts integration element aliases, and explains every unsupported control", async () => {
  const harness = createHarness();
  harness.controller.start();
  assert.equal(harness.elements.replayViewerTray.hidden, true);
  assert.equal(harness.elements.replayViewerTray.listenerCount("keydown"), 1);
  assert.equal(harness.elements.replayViewerPlayPause.listenerCount("click"), 1);

  const unsupported = [
    [harness.elements.replayViewerMute, "mute"],
    [harness.elements.replayViewerVolume, "volume"],
    [harness.elements.replayViewerRate, "speed"],
    [harness.elements.replayViewerLoop, "loop"],
  ];
  for (const [control, name] of unsupported) {
    assert.equal(control.disabled, true);
    assert.equal(control.getAttribute("aria-disabled"), "true");
    assert.equal(control.title, viewerApi.UNSUPPORTED_SOURCE_MONITOR_CONTROLS[name]);
    assert.equal(control.getAttribute("data-disabled-reason"), control.title);
  }
  await harness.controller.destroy();
  assert.equal(harness.elements.replayViewerTray.listenerCount("keydown"), 0);
  assert.equal(harness.elements.replayViewerPlayPause.listenerCount("click"), 0);
});

test("M4 viewer opens only a verified Source Monitor session and publishes honest capabilities", async () => {
  const harness = createHarness();
  const opened = await harness.controller.openReplay(replay("hero", { durationMs: 12080, fps: 24 }));
  assert.equal(opened, true);
  assert.deepEqual(harness.adapter.calls.open, ["hero"]);
  const state = harness.controller.getState();
  assert.equal(state.phase, "open");
  assert.equal(state.mode, "source-monitor");
  assert.equal(state.ownershipToken, "token-hero");
  assert.equal(state.durationSeconds, 12.08);
  assert.equal(state.fps, 24);
  assert.equal(state.canSeek, true);
  assert.equal(state.canFrameStep, true);
  assert.equal(harness.elements.replayViewerTray.hidden, false);
  assert.equal(harness.elements.replayViewerTray.dataset.viewerEntering, "true");
  assert.equal(harness.elements.replayViewerTitle.textContent, "Replay hero");
  assert.equal(harness.elements.replayViewerDuration.textContent, "00:12.08");
  assert.equal(harness.elements.replayViewerScrub.disabled, false);
  assert.equal(harness.elements.replayViewerStepForward.disabled, false);
  assert.equal(harness.elements.replayViewerPlayPause.title, "");
  assert.equal(harness.elements.replayViewerScrub.title, "");
  assert.equal(harness.elements.replayViewerStepForward.title, "");
  assert.equal(harness.usage.length, 1);
  assert.deepEqual(harness.usage[0], {
    action: "open",
    replayId: "hero",
    replay: harness.controller.getState().replay,
    at: 123456,
  });
  await harness.controller.destroy();
});

test("M4 viewer polls position only while its verified source is open and playing", async () => {
  let position = 0;
  const adapter = createAdapter({ getPosition: () => { position += 0.25; return position; } });
  const harness = createHarness({ adapter });
  await harness.controller.openReplay(replay("poll", { durationMs: 5000, fps: 20 }));
  assert.equal(adapter.calls.getPosition, 0);
  assert.equal(harness.scheduler.callbacks.size, 0);

  assert.equal(await harness.controller.play(), true);
  assert.deepEqual(adapter.calls.play, [true]);
  assert.equal(harness.scheduler.callbacks.size, 1);
  await flush();
  assert.equal(adapter.calls.getPosition, 1, "play performs one immediate position poll");
  await harness.scheduler.tick();
  assert.equal(adapter.calls.getPosition, 2);
  assert.equal(harness.controller.getState().positionSeconds, 0.5);

  assert.equal(await harness.controller.pause(), true);
  assert.deepEqual(adapter.calls.play, [true, false]);
  assert.equal(harness.scheduler.callbacks.size, 0);
  await flush();
  const readsAfterPause = adapter.calls.getPosition;
  await harness.scheduler.tick();
  assert.equal(adapter.calls.getPosition, readsAfterPause, "no interval position reads occur while paused");
  await harness.controller.destroy();
});

test("M4 seek is duration-gated, clamps real host seeks, and coalesces rapid scrub input", async () => {
  const firstSeek = deferred();
  const adapter = createAdapter({
    seek: (seconds, call) => call === 1 ? firstSeek.promise : seconds,
  });
  const harness = createHarness({ adapter });
  await harness.controller.openReplay(replay("seek", { durationMs: 10000 }));

  const first = harness.controller.seek(3);
  await flush();
  const second = harness.controller.seek(4);
  const third = harness.controller.seek(99);
  assert.equal(harness.controller.getState().positionSeconds, 10, "scrub feedback updates immediately and clamps to duration");
  firstSeek.resolve(3.1);
  assert.equal(await first, true);
  await second;
  await third;
  assert.deepEqual(adapter.calls.seek, [3, 10], "intermediate scrub positions are coalesced");
  assert.equal(harness.controller.getState().positionSeconds, 10);

  await harness.controller.openReplay(replay("unknown-duration", { fps: 30 }));
  assert.equal(harness.controller.getState().canSeek, false);
  assert.equal(harness.elements.replayViewerScrub.disabled, true);
  const seekCount = adapter.calls.seek.length;
  assert.equal(await harness.controller.seek(1), false);
  assert.equal(adapter.calls.seek.length, seekCount);
  await harness.controller.destroy();
});

test("M4 frame stepping is fps-gated, pauses playback, reads live position, and clamps bounds", async () => {
  let position = 1;
  const adapter = createAdapter({
    getPosition: () => position,
    seek: (seconds) => { position = seconds; return seconds; },
  });
  const harness = createHarness({ adapter });
  await harness.controller.openReplay(replay("frames", { durationMs: 2000, fps: 25 }));
  await harness.controller.play();
  assert.equal(await harness.controller.stepFrames(1), true);
  assert.equal(adapter.calls.seek.at(-1), 1.04);
  assert.equal(harness.controller.getState().playing, false);
  assert.equal(adapter.calls.play.at(-1), false);

  position = 0.01;
  assert.equal(await harness.controller.stepFrames(-2), true);
  assert.equal(adapter.calls.seek.at(-1), 0);

  await harness.controller.openReplay(replay("unknown-fps", { durationMs: 2000 }));
  const seekCount = adapter.calls.seek.length;
  assert.equal(harness.controller.getState().canFrameStep, false);
  assert.equal(await harness.controller.stepFrames(1), false);
  assert.equal(adapter.calls.seek.length, seekCount);
  await harness.controller.destroy();
});

test("M4 keyboard transport operates only while viewer focus is owned and ignores form controls", async () => {
  const harness = createHarness();
  await harness.controller.openReplay(replay("keys", { durationMs: 3000, fps: 30 }));
  const root = harness.elements.replayViewerTray;
  harness.document.activeElement = root;

  let event = root.dispatch("keydown", { key: " ", target: root });
  await flush();
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.adapter.calls.play.length, 0);

  root.dispatch("focusin", { target: root });
  event = root.dispatch("keydown", { key: " ", target: root });
  await harness.controller.hostQueue;
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.adapter.calls.play, [true]);

  const input = harness.elements.replayViewerScrub;
  harness.document.activeElement = input;
  event = root.dispatch("keydown", { key: "ArrowRight", target: input });
  await flush();
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.adapter.calls.seek.length, 0);

  root.dispatch("focusout", { target: root, relatedTarget: null });
  harness.document.activeElement = null;
  event = root.dispatch("keydown", { key: "Escape", target: root });
  await flush();
  assert.equal(event.defaultPrevented, false);
  assert.equal(harness.controller.getState().phase, "open");
  await harness.controller.destroy();
});

test("M4 rapid replay switching serializes host opens and releases the stale ownership token", async () => {
  const openA = deferred();
  const adapter = createAdapter({
    open: async (record) => {
      if (record.id === "a") return openA.promise;
      return {
        mode: "source-monitor",
        ownershipToken: `token-${record.id}`,
        durationSeconds: 2,
        fps: 20,
        supports: { seek: true, frameStep: true },
      };
    },
  });
  const harness = createHarness({ adapter });
  const first = harness.controller.openReplay(replay("a", { durationMs: 2000, fps: 20 }));
  await flush();
  assert.deepEqual(adapter.calls.open, ["a"]);
  const second = harness.controller.openReplay(replay("b", { durationMs: 2000, fps: 20 }));
  await flush();
  assert.deepEqual(adapter.calls.open, ["a"], "the global Source Monitor is never opened concurrently");

  openA.resolve({
    mode: "source-monitor",
    ownershipToken: "token-a",
    durationSeconds: 2,
    fps: 20,
    supports: { seek: true, frameStep: true },
  });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(adapter.calls.close, ["token-a"]);
  assert.deepEqual(adapter.calls.open, ["a", "b"]);
  assert.equal(harness.controller.getState().replayId, "b");
  assert.equal(harness.controller.getState().ownershipToken, "token-b");
  await harness.controller.destroy();
});

test("M4 failed A-to-B switch cannot retain A ownership or poster under B state", async () => {
  const adapter = createAdapter({
    open: async (record) => {
      if (record.id === "b") {
        throw Object.assign(new Error("Unsupported codec profile"), { code: "UNSUPPORTED_CODEC" });
      }
      return {
        mode: "source-monitor",
        ownershipToken: `token-${record.id}`,
        durationSeconds: 2,
        fps: 24,
        supports: { seek: true, frameStep: true },
      };
    },
  });
  const harness = createHarness({ adapter });
  assert.equal(await harness.controller.openReplay(replay("a", { durationMs: 2000, fps: 24 })), true);
  harness.elements.replayViewerPoster.setAttribute("src", "plugin-data:/stale-a.jpg");
  harness.elements.replayViewerPoster.hidden = false;

  assert.equal(await harness.controller.openReplay(replay("b", { durationMs: 2000, fps: 24 })), false);
  const state = harness.controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.replayId, "b");
  assert.equal(state.title, "Replay b");
  assert.equal(state.replay.id, "b");
  assert.equal(state.ownershipToken, "");
  assert.equal(state.open, false);
  assert.deepEqual(adapter.calls.close, ["token-a", undefined]);
  assert.equal(harness.elements.replayViewerPoster.getAttribute("src"), undefined);
  assert.equal(harness.elements.replayViewerPoster.hidden, true);
  assert.match(harness.elements.replayViewerError.textContent, /compatible internal preview/i);
  assert.match(harness.elements.replayViewerError.textContent, /Retry/i);
  await harness.controller.destroy();
});

test("M4 rejected switch preserves A only when its verified release itself fails", async () => {
  const adapter = createAdapter({
    close: async (token) => {
      if (token === "token-a") throw Object.assign(new Error("Source Monitor is busy"), { code: "SOURCE_MONITOR_RELEASE_FAILED" });
      return { ok: true, closed: false, ownershipLost: false };
    },
  });
  const harness = createHarness({ adapter });
  assert.equal(await harness.controller.openReplay(replay("a", { durationMs: 2000, fps: 24 })), true);
  harness.elements.replayViewerPoster.setAttribute("src", "plugin-data:/staged-b.jpg");
  harness.elements.replayViewerPoster.hidden = false;
  assert.equal(await harness.controller.openReplay(replay("b", { durationMs: 2000, fps: 24 })), false);
  const state = harness.controller.getState();
  assert.equal(state.phase, "open");
  assert.equal(state.replayId, "a");
  assert.equal(state.replay.id, "a");
  assert.equal(state.ownershipToken, "token-a");
  assert.equal(state.playing, false);
  assert.match(state.status, /previous replay remains open/i);
  assert.deepEqual(adapter.calls.open, ["a"]);
  assert.equal(harness.elements.replayViewerPoster.getAttribute("src"), undefined);
  assert.equal(harness.elements.replayViewerPoster.hidden, true);
  await harness.controller.destroy();
});

test("M4 releaseReplayIds closes only the matching active or in-flight replay with its ownership token", async () => {
  const harness = createHarness();
  await harness.controller.openReplay(replay("owned", { durationMs: 1000, fps: 24 }));
  assert.equal(await harness.controller.releaseReplayIds(["other"]), false);
  assert.deepEqual(harness.adapter.calls.close, []);
  assert.equal(harness.controller.getState().phase, "open");

  assert.equal(await harness.controller.releaseReplayIds(new Set(["owned"])), true);
  assert.deepEqual(harness.adapter.calls.close, ["token-owned"]);
  assert.equal(harness.controller.getState().phase, "idle");
  assert.equal(harness.elements.replayViewerTray.hidden, true);

  const pendingOpen = deferred();
  const pendingAdapter = createAdapter({ open: () => pendingOpen.promise });
  const pendingHarness = createHarness({ adapter: pendingAdapter });
  const opening = pendingHarness.controller.openReplay(replay("pending", { durationMs: 1000 }));
  await flush();
  const release = pendingHarness.controller.releaseReplayIds("pending");
  pendingOpen.resolve({
    mode: "source-monitor",
    ownershipToken: "token-pending",
    durationSeconds: 1,
    fps: null,
    supports: { seek: true, frameStep: false },
  });
  assert.equal(await opening, false);
  assert.equal(await release, true);
  assert.deepEqual(pendingAdapter.calls.close, ["token-pending"]);
  assert.equal(pendingHarness.controller.getState().phase, "idle");
  await pendingHarness.controller.destroy();
  await harness.controller.destroy();
});

test("M4 ownership loss fails closed and never asks the controller to close an unowned token", async () => {
  const ownershipError = Object.assign(
    new Error("Premiere Source Monitor changed outside Blocky Studios. Reopen the replay to restore viewer control."),
    { code: "SOURCE_MONITOR_OWNERSHIP_LOST" },
  );
  const adapter = createAdapter({ play: () => { throw ownershipError; } });
  const harness = createHarness({ adapter });
  await harness.controller.openReplay(replay("external", { durationMs: 1000 }));
  assert.equal(await harness.controller.play(), false);
  assert.equal(harness.controller.getState().phase, "error");
  assert.equal(harness.controller.getState().ownershipToken, "");
  assert.match(harness.elements.replayViewerError.textContent, /changed outside Blocky Studios/i);
  assert.equal(harness.toasts.length, 1);
  await harness.controller.close();
  assert.deepEqual(adapter.calls.close, [], "lost ownership is never closed by stale controller state");
  await harness.controller.destroy();
});

test("M4 invalid, unavailable, and malformed sessions stay visible as actionable errors", async () => {
  const unavailable = createHarness({ adapter: createAdapter({ available: false }) });
  assert.equal(await unavailable.controller.openReplay(replay("offline")), false);
  assert.equal(unavailable.controller.getState().phase, "error");
  assert.match(unavailable.elements.replayViewerError.textContent, /unavailable/i);
  assert.equal(unavailable.elements.replayViewerTray.hidden, false);
  await unavailable.controller.destroy();

  const malformedAdapter = createAdapter({
    open: async () => ({ mode: "html-video", ownershipToken: "bad-token" }),
  });
  const malformed = createHarness({ adapter: malformedAdapter });
  assert.equal(await malformed.controller.openReplay(replay("malformed")), false);
  assert.equal(malformed.controller.getState().phase, "error");
  assert.deepEqual(malformedAdapter.calls.close, ["bad-token"]);
  assert.match(malformed.elements.replayViewerError.textContent, /verifiable Source Monitor session/i);
  await malformed.controller.destroy();
});

test("M4 missing media and codec failures expose distinct recovery actions", async () => {
  const missingAdapter = createAdapter({
    open: async () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); },
  });
  const missing = createHarness({ adapter: missingAdapter });
  assert.equal(await missing.controller.openReplay(replay("missing")), false);
  assert.match(missing.elements.replayViewerError.textContent, /Relink from the replay context menu/i);
  assert.equal(missing.controller.getState().error.code, "ENOENT");
  await missing.controller.destroy();

  const codecAdapter = createAdapter({
    open: async () => { throw Object.assign(new Error("decoder rejected unsupported codec"), { code: "MEDIA_DECODE_FAILED" }); },
  });
  const codec = createHarness({ adapter: codecAdapter });
  assert.equal(await codec.controller.openReplay(replay("codec")), false);
  assert.match(codec.elements.replayViewerError.textContent, /compatible internal preview/i);
  assert.match(codec.elements.replayViewerError.textContent, /Retry/i);
  await codec.controller.destroy();
});

test("M4 close and teardown clear poster sources and restore the focus that opened the tray", async () => {
  const harness = createHarness();
  const trigger = fakeElement("BUTTON");
  harness.document.activeElement = trigger;
  await harness.controller.openReplay(replay("focus", { durationMs: 1000, fps: 24 }));
  harness.elements.replayViewerPoster.setAttribute("src", "plugin-data:/focus.jpg");
  harness.elements.replayViewerPoster.hidden = false;
  assert.equal(await harness.controller.close(), true);
  assert.equal(trigger.focusCount, 1);
  assert.equal(harness.elements.replayViewerPoster.getAttribute("src"), undefined);
  assert.equal(harness.elements.replayViewerPoster.hidden, true);

  harness.document.activeElement = trigger;
  await harness.controller.openReplay(replay("destroy-focus", { durationMs: 1000, fps: 24 }));
  harness.elements.replayViewerPoster.setAttribute("src", "plugin-data:/destroy.jpg");
  assert.equal(await harness.controller.destroy(), true);
  assert.equal(trigger.focusCount, 2);
  assert.equal(harness.elements.replayViewerPoster.getAttribute("src"), undefined);
  assert.equal(harness.elements.replayViewerPoster.hidden, true);
});

test("M4 teardown is idempotent, cancels polling/listeners, and releases before adapter destruction", async () => {
  const adapter = createAdapter();
  const harness = createHarness({ adapter });
  harness.controller.start();
  await harness.controller.openReplay(replay("teardown", { durationMs: 3000, fps: 30 }));
  await harness.controller.play();
  assert.equal(harness.scheduler.callbacks.size, 1);
  const first = harness.controller.destroy();
  const second = harness.controller.destroy();
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(harness.scheduler.callbacks.size, 0);
  assert.deepEqual(adapter.calls.close, ["token-teardown"]);
  assert.equal(adapter.calls.destroy, 1);
  assert.equal(harness.elements.replayViewerTray.listenerCount("keydown"), 0);
  assert.equal(harness.elements.replayViewerPlayPause.listenerCount("click"), 0);
  assert.equal(harness.controller.getState().phase, "destroyed");
  assert.equal(await harness.controller.openReplay(replay("late")), false);
  assert.deepEqual(adapter.calls.open, ["teardown"]);
});

test("M4 viewer implementation contains no fake blob media, grid, or UXP-unsafe child replacement path", () => {
  const source = fs.readFileSync("./src/replays/oracle-replay-viewer.js", "utf8");
  assert.doesNotMatch(source, /\.replaceChildren\s*\(/);
  assert.doesNotMatch(source, /createObjectURL|revokeObjectURL|new\s+Blob|<video/i);
  assert.doesNotMatch(source, /display\s*:\s*grid|grid-template/i);
  assert.match(source, /Premiere Source Monitor/);
  assert.match(source, /preparing-preview/);
  assert.match(source, /managedPreview/);
});
