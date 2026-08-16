"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = __dirname;
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles", "overdrive-m4.css"), "utf8");

const adapterStart = mainSource.indexOf("class PremiereSourceMonitorViewerAdapter");
const adapterEnd = mainSource.indexOf("class SmoothWheelScroller", adapterStart);
const controllerStart = mainSource.indexOf("class OraclePanelController");
const controllerEnd = mainSource.indexOf("function injectOracleProfiler", controllerStart);
assert.ok(adapterStart >= 0 && adapterEnd > adapterStart, "M4 Source Monitor adapter must be present");
assert.ok(controllerStart >= 0 && controllerEnd > controllerStart, "OraclePanelController must be present");

function pathKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

class UserFacingError extends Error {
  constructor(message, recoverable = true, code = "ORACLE_ERROR") {
    super(message);
    this.recoverable = recoverable;
    this.code = code;
  }
}

function createAdapterHarness() {
  const calls = [];
  const replayPath = "D:\\Blocky Studios Exports\\Unicode 雪\\Hero.mov";
  const owned = {
    id: "project-item-owned",
    path: replayPath,
    getId() { return this.id; },
    getMediaFilePath() { return Promise.resolve(this.path); },
  };
  let current = owned;
  let position = 0;
  const api = {
    SourceMonitor: {
      async openFilePath(filepath) {
        calls.push(["open", filepath]);
        current = owned;
        return true;
      },
      async getProjectItem() { return current; },
      async getPosition() { return { seconds: position }; },
      async setPosition(value) {
        position = value.seconds;
        calls.push(["seek", position]);
        return true;
      },
      async play(speed) {
        calls.push(["play", speed]);
        return true;
      },
      async closeClip() {
        calls.push(["close"]);
        current = null;
        return true;
      },
    },
    TickTime: {
      createWithSeconds(seconds) { return { seconds }; },
    },
    ClipProjectItem: {
      cast(projectItem) { return projectItem; },
    },
  };
  const runtime = {
    Boolean,
    Error,
    Number,
    Promise,
    String,
    UserFacingError,
    delay() { return Promise.resolve(); },
    getReplayCanonicalMediaPath(replay) { return replay.canonicalPath || replay.filepath; },
    normalizeReplayPath(value) { return String(value || "").replace(/\//g, "\\"); },
    pathKey,
    tracePremiereCall(_name, operation) { return operation(); },
    traceNativeCall(_name, operation) { return operation(); },
    validateImportFilePath(value) {
      const candidate = String(value || "");
      if (!/^[A-Za-z]:\\/.test(candidate)) throw new Error("invalid path");
      return candidate;
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(adapterStart, adapterEnd)}\nthis.Adapter = PremiereSourceMonitorViewerAdapter;`,
    runtime,
    { filename: "main.js#M4SourceMonitorAdapter" },
  );
  return {
    adapter: new runtime.Adapter(api),
    api,
    calls,
    owned,
    replay: { id: "replay-1", filepath: replayPath, durationMs: 12_000, fps: 60 },
    setCurrent(value) { current = value; },
  };
}

function createControllerPrototype() {
  const runtime = {
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Reflect,
    RegExp,
    Set,
    String,
    tracePremiereCall(_name, operation) { return operation(); },
    traceNativeCall(_name, operation) { return operation(); },
  };
  vm.runInNewContext(
    `${mainSource.slice(controllerStart, controllerEnd)}\nthis.Controller = OraclePanelController;`,
    runtime,
    { filename: "main.js#M4Controller" },
  );
  return runtime.Controller.prototype;
}

test("M4 Source Monitor adapter waits for exact host identity publication without trusting open success", async () => {
  const harness = createAdapterHarness();
  const previous = {
    id: "editor-previous-item",
    path: "D:\\Editorial\\Previous.mov",
    getId() { return this.id; },
    getMediaFilePath() { return Promise.resolve(this.path); },
  };
  harness.setCurrent(previous);
  harness.api.SourceMonitor.openFilePath = async (filepath) => {
    harness.calls.push(["open", filepath]);
    return true;
  };
  const readCurrent = harness.api.SourceMonitor.getProjectItem;
  let reads = 0;
  harness.api.SourceMonitor.getProjectItem = async () => {
    reads += 1;
    if (reads === 4) harness.setCurrent(harness.owned);
    return readCurrent();
  };

  const opened = await harness.adapter.open(harness.replay);
  assert.equal(Boolean(opened.ownershipToken), true);
  assert.equal(reads, 4);
  assert.equal(harness.calls.filter(([kind]) => kind === "close").length, 0);
});

test("M4 Source Monitor adapter leaves the editor's prior clip untouched when identity publication times out", async () => {
  const harness = createAdapterHarness();
  harness.setCurrent({
    id: "editor-previous-item",
    path: "D:\\Editorial\\Previous.mov",
    getId() { return this.id; },
    getMediaFilePath() { return Promise.resolve(this.path); },
  });
  harness.api.SourceMonitor.openFilePath = async () => true;

  await assert.rejects(
    harness.adapter.open(harness.replay),
    (error) => error && error.code === "SOURCE_MONITOR_IDENTITY_MISMATCH",
  );
  assert.equal(harness.calls.filter(([kind]) => kind === "close").length, 0);
});

test("M4 Source Monitor adapter owns the exact replay and exposes only physically supported controls", async () => {
  const harness = createAdapterHarness();
  const opened = await harness.adapter.open(harness.replay);

  assert.equal(opened.mode, "source-monitor");
  assert.equal(opened.durationSeconds, 12);
  assert.equal(opened.fps, 60);
  assert.deepEqual(
    JSON.parse(JSON.stringify(opened.supports)),
    {
      playPause: true,
      position: true,
      seek: true,
      frameStep: true,
      mute: false,
      volume: false,
      speed: false,
      loop: false,
    },
  );
  assert.equal(harness.calls[0][0], "open");

  await harness.adapter.play(true);
  await harness.adapter.play(false);
  assert.equal(await harness.adapter.seek(3.25), 3.25);
  assert.deepEqual(harness.calls.filter(([kind]) => kind === "play").map(([, speed]) => speed), [1, 0]);
  assert.deepEqual(harness.calls.find(([kind]) => kind === "seek"), ["seek", 3.25]);

  const released = await harness.adapter.close(opened.ownershipToken);
  assert.deepEqual(JSON.parse(JSON.stringify(released)), { ok: true, closed: true, ownershipLost: false });
  assert.equal(harness.calls.filter(([kind]) => kind === "close").length, 1);
});

test("M4 Source Monitor adapter never drives or closes a clip the editor selected afterward", async () => {
  const harness = createAdapterHarness();
  const opened = await harness.adapter.open(harness.replay);
  harness.setCurrent({
    id: "user-selected-item",
    path: "D:\\Editorial\\Interview.mov",
    getId() { return this.id; },
    getMediaFilePath() { return Promise.resolve(this.path); },
  });

  await assert.rejects(
    harness.adapter.play(true),
    (error) => error && error.code === "SOURCE_MONITOR_OWNERSHIP_LOST",
  );
  const release = await harness.adapter.close(opened.ownershipToken);
  assert.equal(release.closed, false);
  assert.equal(harness.calls.filter(([kind]) => kind === "close").length, 0);
});

test("M4 Source Monitor adapter exposes actionable missing and codec recovery without fake conversion", async () => {
  const missing = createAdapterHarness();
  missing.replay.missingState = "missing";
  await assert.rejects(
    missing.adapter.open(missing.replay),
    (error) => error && error.code === "SOURCE_MONITOR_MEDIA_MISSING" && /Relink from the replay context menu/i.test(error.message),
  );
  assert.equal(missing.calls.filter(([kind]) => kind === "open").length, 0);

  const codec = createAdapterHarness();
  codec.api.SourceMonitor.openFilePath = async () => {
    throw Object.assign(new Error("decoder rejected unsupported codec"), { code: "MEDIA_DECODE_FAILED" });
  };
  await assert.rejects(
    codec.adapter.open(codec.replay),
    (error) => error && error.code === "SOURCE_MONITOR_CODEC_UNSUPPORTED" && /Premiere-supported codec/i.test(error.message) && /will not convert media silently/i.test(error.message),
  );

  const unknown = createAdapterHarness();
  unknown.api.SourceMonitor.openFilePath = async () => false;
  await assert.rejects(
    unknown.adapter.open(unknown.replay),
    (error) => error && error.code === "SOURCE_MONITOR_OPEN_FAILED" && /Verify the source file still exists/i.test(error.message),
  );
});

test("Replay viewer tray is a docked media-first replay-scroller sibling with bounded controls", () => {
  const scrollerEnd = html.indexOf("</main>", html.indexOf('id="replayScroller"'));
  const viewerStart = html.indexOf('id="replayViewerTray"');
  const contextStart = html.indexOf('id="replayContextMenu"');
  assert.ok(scrollerEnd >= 0 && viewerStart > scrollerEnd && contextStart > viewerStart);
  assert.match(html, /id="replayViewerTray"[\s\S]*role="region"[\s\S]*aria-labelledby="replayViewerTitle"/);
  assert.match(html, /id="replayViewerMode"[^>]*>Blocky Studios Viewer</);
  assert.match(html, /id="replayViewerMedia"/);
  assert.match(html, /id="replayViewerPlayPause"[\s\S]*id="replayViewerStop"[\s\S]*id="replayViewerStepBack"[\s\S]*id="replayViewerStepForward"[\s\S]*id="replayViewerLoop"/);
  assert.match(html, /id="replayViewerMute"[\s\S]*id="replayViewerVolume"[\s\S]*id="replayViewerRate"[\s\S]*id="replayViewerRateMenu"/);
  assert.doesNotMatch(html, /id="replayViewerOpenSource"/);
  assert.match(html, /data-replay-context-action="source-monitor"/);
  assert.match(css, /\.replay-viewer\s*\{[\s\S]*display:\s*flex/);
  assert.match(css, /\.replay-viewer__media\s*\{[^}]*box-sizing:\s*content-box;[^}]*height:\s*0;[^}]*padding-top:\s*56\.25%/s);
  assert.match(css, /\.replay-viewer__media video,[\s\S]*?\.replay-viewer__media img\s*\{[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*0/s);
  assert.doesNotMatch(css, /\.replay-viewer__media\s*\{[^}]*aspect-ratio:/s);
  assert.match(css, /\.replay-viewer__progress > span[\s\S]*animation:\s*oracle-viewer-spin/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.replay-viewer__progress > span\s*\{\s*animation:\s*none/);
  assert.doesNotMatch(css, /\.replay-viewer(?:__body)?\s*\{[^}]*animation:/s);
  assert.doesNotMatch(css, /display:\s*grid/);
  assert.match(css, /@media \(max-height:\s*520px\) and \(min-width:\s*601px\)/);
  assert.doesNotMatch(css, /@media \(max-height:\s*520px\)\s*\{[\s\S]*?flex-wrap:\s*nowrap/);
});

test("main integration routes activation to Blocky Studios Viewer, preserves explicit Source Monitor, and releases before mutations", () => {
  assert.match(mainSource, /onOpen:\s*\(replay\)\s*=>\s*this\.openReplayViewer\(replay\)/);
  assert.match(mainSource, /new PremiereSourceMonitorViewerAdapter\(premiere\)/);
  assert.match(mainSource, /new replayViewerApi\.HtmlVideoReplayAdapter/);
  assert.match(mainSource, /new replayViewerApi\.ReplayViewerController/);
  const releaseStart = mainSource.indexOf("async releaseReplayMutationHandles");
  const releaseEnd = mainSource.indexOf("pauseNativeDirectoryWatchForMutation", releaseStart);
  const releaseSource = mainSource.slice(releaseStart, releaseEnd);
  assert.ok(
    releaseSource.indexOf("this.viewer.releaseReplayIds(ids)") < releaseSource.indexOf("this.gateway.closeSourceMonitorClip()"),
    "viewer ownership must release before legacy Source Monitor ownership",
  );
  assert.match(mainSource, /await this\.releaseReplayMutationHandles\(\[replayId\]\);[\s\S]{0,500}registerKnownReplayFile/);
  assert.match(mainSource, /if \(mode === "remove-metadata"\) \{\s*await this\.releaseReplayMutationHandles\(ids\)/);
  assert.match(mainSource, /if \(payload\.recycle !== true\) \{\s*await this\.releaseReplayMutationHandles\(ids\)/);
});

test("M4 missing-path release attempts every viewer mount without awaiting its own processing task", async () => {
  const prototype = createControllerPrototype();
  const calls = [];
  const neverSettles = new Promise(() => undefined);
  const mainViewer = {
    async releaseReplayIds(ids) {
      calls.push(["main", Array.from(ids)]);
      throw new Error("main release failed");
    },
  };
  const dedicatedViewer = {
    async releaseReplayIds(ids) {
      calls.push(["dedicated", Array.from(ids)]);
      return true;
    },
  };
  const controller = Object.assign(Object.create(prototype), {
    viewer: mainViewer,
    dedicatedMounts: new Set([{ viewer: mainViewer }, { viewer: dedicatedViewer }]),
    processingTasks: new Map([["missing", new Set([neverSettles])]]),
  });

  await assert.rejects(controller.releaseReplayViewerMounts(["missing"]), /main release failed/);
  assert.deepEqual(calls, [
    ["main", ["missing"]],
    ["dedicated", ["missing"]],
  ]);

  const watcherStart = mainSource.indexOf("scheduleNativeMissingVerification(replayId, observedPath)");
  const watcherEnd = mainSource.indexOf("async reconcileNativeWatcherRename", watcherStart);
  const processingStart = mainSource.indexOf("scheduleReplayProcessing(replayId, origin)");
  const processingEnd = mainSource.indexOf("queueImport(filepath)", processingStart);
  assert.match(mainSource.slice(watcherStart, watcherEnd), /await this\.releaseReplayViewerMounts\(\[id\]\)/);
  assert.match(mainSource.slice(processingStart, processingEnd), /await this\.releaseReplayViewerMounts\(\[replayId\]\)/);
  assert.doesNotMatch(mainSource.slice(processingStart, processingEnd), /await this\.releaseReplayMutationHandles\(\[replayId\]\)/);
});

test("M4 integration clears the old poster before assigning a new replay poster", () => {
  const openStart = mainSource.indexOf("async openReplayViewer(");
  const openEnd = mainSource.indexOf("async openInSourceMonitor", openStart);
  const source = mainSource.slice(openStart, openEnd);
  const clearIndex = source.indexOf('poster.removeAttribute("src")');
  const setIndex = source.indexOf('poster.setAttribute("src", source)');
  assert.ok(clearIndex >= 0 && setIndex > clearIndex);
  assert.match(source, /poster\.hidden = true;[\s\S]*poster\.hidden = false;/);
});

test("M4 production prepares incompatible media through the native service without Blob memory", () => {
  const production = [
    mainSource,
    fs.existsSync(path.join(root, "src", "replays", "oracle-replay-viewer.js"))
      ? fs.readFileSync(path.join(root, "src", "replays", "oracle-replay-viewer.js"), "utf8")
      : "",
    fs.readFileSync(path.join(root, "src", "replays", "oracle-replay-media.js"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(production, /new\s+Blob\s*\(/);
  assert.doesNotMatch(production, /\.replaceChildren\s*\(/);
  assert.match(production, /prepareReplayMedia/);
  assert.match(production, /includePreview/);
  assert.match(production, /managedPreview/);
});
