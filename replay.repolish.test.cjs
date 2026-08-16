// @ts-nocheck
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const baseCss = fs.readFileSync(path.join(root, "style.css"), "utf8");
const replayCss = fs.readFileSync(path.join(root, "styles", "overdrive-m2.css"), "utf8");
const viewerCss = fs.readFileSync(path.join(root, "styles", "overdrive-m4.css"), "utf8");
const library = require("./src/replays/oracle-replay-library.js");
const viewer = require("./src/replays/oracle-replay-viewer.js");

function replay(id, overrides = {}) {
  return {
    id,
    canonicalPath: `D:\\Blocky Studios Replays\\${id}.mov`,
    pathKey: `d:\\oracle replays\\${id}.mov`,
    sourceName: id,
    displayNameOverride: id,
    collectionIds: [],
    tags: [],
    exportedAt: "2026-07-16T12:00:00.000Z",
    archiveState: "active",
    missingState: "available",
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

test("Replay repolish exposes only All, Recent, Collections, and Archive tabs", () => {
  const tabs = Array.from(html.matchAll(/data-replay-view="([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(tabs, ["all", "recent", "collections", "archived"]);
  const toolbar = html.slice(html.indexOf('id="replayToolbar"'), html.indexOf('class="recent-exports__content"'));
  assert.doesNotMatch(toolbar, />\s*(?:Favorites|Missing|Most used)\s*</i);
});

test("Replay repolish removes visible filters and replay-count copy", () => {
  assert.doesNotMatch(html, /id="replayFilterToggle"|id="replayFilterPanel"|data-replay-filter=/);
  assert.doesNotMatch(html, /id="replayResultSummary"|recent-exports__count-wrap/);
  assert.match(html, /id="replaySearch"[^>]*placeholder="Search replays"/);
  assert.match(html, /id="replaySearchClear"[^>]*aria-label="Clear replay search"/);
});

test("Archive selector owns unresolved records while active views exclude them", () => {
  const active = replay("active");
  const missing = replay("missing", { missingState: "missing" });
  const unresolved = replay("unresolved", { missingState: "unknown" });
  const archived = replay("archived", { archiveState: "archived" });
  const state = {
    replaysById: { active, missing, unresolved, archived },
    collectionsById: {},
  };
  assert.deepEqual(library.selectReplayIds(state, { view: "all" }), [active.id]);
  assert.deepEqual(
    new Set(library.selectReplayIds(state, { view: "archived" })),
    new Set([missing.id, unresolved.id, archived.id]),
  );
});

test("Replay toolbar keeps density beside bounded tabs/search without horizontal tab scrolling", () => {
  assert.match(html, /class="replay-workspace__primary"[\s\S]*class="replay-workspace__tabs"[\s\S]*class="grid-scale"/);
  assert.match(replayCss, /\.replay-workspace__tabs\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;/s);
  assert.doesNotMatch(replayCss, /\.replay-workspace__tabs\s*\{[^}]*overflow-x:\s*auto;/s);
});

test("Cards use the concept hierarchy and keep the reorder handle inside the thumbnail", () => {
  const createStart = main.indexOf("  createCard(replay) {");
  const createEnd = main.indexOf("\n  updateCardState(", createStart);
  const source = main.slice(createStart, createEnd);
  const thumbnail = source.indexOf('thumbnail.className = "replay-thumbnail"');
  const handle = source.indexOf("replay-reorder-handle");
  const handleMount = source.indexOf("thumbnail.appendChild(reorderHandle)");
  const duration = source.indexOf('timecodeMetadata.className = "replay-timecode-badge"');
  const metadata = source.indexOf('metadataRow.className = "replay-card__metadata"');
  const title = source.indexOf('title.className = "replay-title"');
  const specs = source.indexOf('resolution.className = "replay-specs"');
  const date = source.indexOf('details.className = "replay-details"');
  assert.ok(thumbnail >= 0 && handle > thumbnail && handleMount > handle && duration > handleMount);
  assert.ok(metadata > duration && title > metadata && specs > title && date > specs);
  assert.match(source, /reorderHandle\.className = "[^"]*oracle-icon-button[^"]*replay-reorder-handle"/);
  assert.match(source, /formatReplaySpecs\(replay\)/);
  assert.match(source, /createReplayCollectionChip|createReplayTagChip|createReplayTagOverflow/);
});

test("Replay cards wrap titles and use exact Blocky Studios font tokens", () => {
  assert.match(baseCss, /\.replay-title\s*\{[^}]*font-family:\s*var\(--oracle-font-heading[^}]*white-space:\s*normal;[^}]*display:\s*block;[^}]*max-height:\s*2\.4em;/s);
  assert.doesNotMatch(baseCss, /-webkit-box|-webkit-line-clamp/);
  assert.match(replayCss, /\.replay-card__metadata[^}]*font-family:\s*var\(--oracle-font-compact/s);
  assert.match(baseCss, /\.replay-specs,[\s\S]*\.replay-details\s*\{[^}]*font-family:\s*var\(--oracle-font-body/s);
});

test("Density writes the exact equal flex basis used by virtual rows", () => {
  const applyStart = main.indexOf("  applyLayout() {", main.indexOf("class GridScaleControl"));
  const applyEnd = main.indexOf("\n  destroy() {", applyStart);
  const source = main.slice(applyStart, applyEnd);
  assert.match(source, /--replay-grid-columns/);
  assert.match(source, /--replay-card-flex-basis/);
  assert.match(source, /availableWidth[\s\S]*gap \* \(columns - 1\)[\s\S]*\/ columns/);
  assert.match(replayCss, /\.replay-virtual-card-row\s*\{[^}]*display:\s*flex;/s);
  assert.doesNotMatch(replayCss, /\.replay-(?:grid-container|virtual-card-row)\s*\{[^}]*display:\s*grid;/s);
});

test("Single click selects only while double-click and Enter open Blocky Studios Viewer", () => {
  const click = main.slice(main.indexOf("  onReplayClickCapture(event) {"), main.indexOf("\n  onReplayDoubleClickCapture", main.indexOf("  onReplayClickCapture(event) {")));
  const doubleClick = main.slice(main.indexOf("  onReplayDoubleClickCapture(event) {"), main.indexOf("\n  onReplayReorderKeyDown", main.indexOf("  onReplayDoubleClickCapture(event) {")));
  const keydown = main.slice(main.indexOf("  onReplayKeyDown(event) {"), main.indexOf("\n  setActiveReplay", main.indexOf("  onReplayKeyDown(event) {")));
  assert.match(click, /setActiveReplay\(replayId, true\)/);
  assert.doesNotMatch(click, /onOpen\(|onInsert\(|setTimeout\(/);
  assert.match(doubleClick, /this\.onOpen\(replay\)/);
  assert.doesNotMatch(doubleClick, /this\.onInsert\(/);
  assert.match(keydown, /event\.key !== "Enter"[\s\S]*this\.onOpen\(replay\)/);
  assert.doesNotMatch(keydown, /explicit-import-activation|this\.onInsert\(/);
});

test("Context menu contains only the exact retained actions in order", () => {
  const menu = html.slice(html.indexOf('id="replayContextMenu"'), html.indexOf('id="replayLifecycleBackdrop"'));
  const actions = Array.from(menu.matchAll(/data-replay-context-action="([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(actions, ["play", "source-monitor", "rename-display", "collections", "tags", "reveal", "relink", "delete"]);
  assert.doesNotMatch(menu, /Import to Project|Rename source|Favorite|Rating|Notes|Archive|Restore/i);
});

test("Relink is conditional and routine native-drag completion emits no bottom toast", () => {
  const actionState = main.slice(main.indexOf("  getReplayContextActionState("), main.indexOf("\n  replayDialogContext", main.indexOf("  getReplayContextActionState(")));
  assert.match(actionState, /action === "relink"[\s\S]*hidden:\s*!replayRequiresRelink\(replay\)/);
  const result = main.slice(main.indexOf("  handleNativeDragResult(replay"), main.indexOf("\n  scheduleLabelReconciliation", main.indexOf("  handleNativeDragResult(replay")));
  const success = result.slice(result.indexOf("if (result && result.ok && result.dropped)"), result.indexOf("if (result && result.ok && result.cancelled)"));
  assert.doesNotMatch(success, /showToast\(/);
  assert.match(success, /scheduleLabelReconciliation/);
});

test("The viewer is media-first and keeps Source Monitor explicit", () => {
  const tray = html.slice(html.indexOf('id="replayViewerTray"'), html.indexOf('id="replayContextMenu"'));
  assert.match(tray, /id="replayViewerMedia"/);
  assert.match(tray, /id="replayViewerClose"/);
  assert.match(tray, /id="replayViewerTitle"/);
  assert.match(tray, /id="replayViewerCurrentTime"[\s\S]*id="replayViewerDuration"[\s\S]*id="replayViewerFrame"/);
  assert.match(tray, /id="replayViewerScrub"/);
  assert.match(tray, /id="replayViewerPlayPause"[\s\S]*id="replayViewerStop"[\s\S]*id="replayViewerStepBack"[\s\S]*id="replayViewerStepForward"[\s\S]*id="replayViewerLoop"/);
  assert.match(tray, /id="replayViewerMute"[\s\S]*id="replayViewerVolume"[\s\S]*id="replayViewerRate"[\s\S]*id="replayViewerRateMenu"/);
  assert.match(tray, /id="replayViewerProgress"[\s\S]*id="replayViewerRetry"/);
  assert.doesNotMatch(tray, /id="replayViewerOpenSource"|Preview in Premiere/);
  assert.match(html, /data-replay-context-action="source-monitor"/);
  assert.equal(typeof viewer.HtmlVideoReplayAdapter, "function");
  assert.match(viewerCss, /\.replay-viewer__media\s*\{[^}]*box-sizing:\s*content-box;[^}]*width:\s*100%;[^}]*height:\s*0;[^}]*padding-top:\s*56\.25%;/s);
  assert.match(viewerCss, /\.replay-viewer__media video,[\s\S]*?\.replay-viewer__media img\s*\{[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*0/s);
  assert.doesNotMatch(viewerCss, /\.replay-viewer__media\s*\{[^}]*aspect-ratio:/s);
});

test("HTML video adapter opens the original local path and wires real transport state", async () => {
  const listeners = new Map();
  const media = {
    duration: 12.08,
    currentTime: 0,
    playbackRate: 1,
    loop: false,
    paused: true,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    load() { if (this.src) queueMicrotask(() => listeners.get("loadedmetadata")?.()); },
    async play() { this.paused = false; },
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === "src") this.src = ""; },
  };
  const adapter = new viewer.HtmlVideoReplayAdapter(media, { timeoutMs: 100 });
  const opened = await adapter.open({ id: "hero", filepath: "D:\\Blocky Studios Replays\\Hero Shot.mov", fps: 60 });
  assert.equal(opened.mode, "internal-video");
  assert.equal(opened.durationSeconds, 12.08);
  assert.equal(opened.fps, 60);
  assert.equal(media.src, "file:///D:/Blocky%20Studios%20Replays/Hero%20Shot.mov");
  await adapter.play(true);
  assert.equal(media.paused, false);
  assert.equal(adapter.setRate(2), 2);
  assert.equal(adapter.setLoop(true), true);
  media.currentTime = 4;
  assert.equal(adapter.stop(), 0);
  assert.equal(media.currentTime, 0);
  await adapter.close(opened.ownershipToken);
  assert.equal(media.src, "");
});

test("HTML video adapter prepares unsupported UXP codecs without a silent Source Monitor redirect", async () => {
  const listeners = new Map();
  const media = {
    duration: 4.167,
    currentTime: 0,
    playbackRate: 1,
    loop: false,
    paused: true,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    load() { if (this.src) queueMicrotask(() => listeners.get("loadedmetadata")?.()); },
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === "src") this.src = ""; },
  };
  const calls = [];
  const mediaPipeline = {
    async prepare(replay, options) {
      calls.push({ replay, options });
      return options.includePreview
        ? { sourceVideoCodec: "prores", sourceContainer: "mov", playbackPath: "D:\\Blocky Studios Cache\\ProRes.mp4", managedPreview: true, previewReady: true }
        : { sourceVideoCodec: "prores", sourceContainer: "mov", playbackPath: replay.filepath, managedPreview: false };
    },
  };
  const adapter = new viewer.HtmlVideoReplayAdapter(media, { timeoutMs: 100, mediaPipeline });
  const opened = await adapter.open({ id: "prores", filepath: "D:\\Blocky Studios Replays\\ProRes.mov", fps: 60 });
  assert.equal(opened.mode, "internal-video");
  assert.equal(opened.managedPreview, true);
  assert.equal(opened.originalPath, "D:\\Blocky Studios Replays\\ProRes.mov");
  assert.equal(media.src, "file:///D:/Blocky%20Studios%20Cache/ProRes.mp4");
  assert.deepEqual(calls.map((entry) => entry.options.includePreview), [false, true]);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "src", "replays", "oracle-replay-viewer.js"), "utf8"), /createObjectURL|new Blob/i);
});

test("Both Replay mounts instantiate one captured shared blueprint and one controller family", () => {
  assert.match(main, /instantiatePanelBlueprint\(this\.blueprint/);
  assert.match(main, /activateWorkspaceId:[\s\S]*"replayScroller"/);
  assert.match(main, /this\.view = new ReplayGridView\(this\.elements/);
  assert.match(main, /this\.workspace = new replayWorkspaceApi\.ReplayWorkspaceController\(this\.elements/);
  assert.doesNotMatch(main, /class DedicatedReplayGridView|class DedicatedReplayWorkspaceController/);
});

test("Replay wheel input is owned by the native UXP scroll container", () => {
  const source = main.slice(main.indexOf("class SmoothWheelScroller"), main.indexOf("class ReplayGridView"));
  assert.match(source, /Premiere\/UXP owns wheel propagation/);
  assert.doesNotMatch(source, /addEventListener\(["']wheel["']/);
  assert.doesNotMatch(source, /preventDefault\s*\(/);
});

test("main hamburger uses bounded Blocky Studios alignment without CSS motion dependence", () => {
  const navigation = fs.readFileSync(path.join(root, "styles", "overdrive-m1.css"), "utf8");
  assert.match(html, /id="navigationToggle"[\s\S]*?<img[^>]*src="assets\/icons\/menu\.png"/s);
  assert.doesNotMatch(navigation, /#navigationToggle\s*\{[^}]*font-size:/s);
  assert.match(navigation, /\.navigation-item\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(navigation, /\.navigation-item > span:not\(\.navigation-item__icon\)\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.doesNotMatch(navigation, /\.navigation-drawer\s*\{[^}]*transition:/s);
});
