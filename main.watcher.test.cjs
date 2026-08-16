"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const pollerStart = mainSource.indexOf("class ExportDirectoryPoller");
const pollerEnd = mainSource.indexOf("class ThemePreferences", pollerStart);
assert.ok(pollerStart >= 0 && pollerEnd > pollerStart, "export poller source must be present");

test("filesystem fallback emits one stable new video without overlapping timers", async () => {
  let entries = [];
  const emitted = [];
  const timers = new Map();
  let timerId = 0;
  let modifiedAt = Date.now();
  let fileSize = 1024;
  const context = {
    Array,
    Date,
    Map,
    Math,
    Number,
    Promise,
    Set,
    String,
    EXPORT_DIRECTORY_POLL_MS: 3000,
    EXPORT_DIRECTORY_HIDDEN_POLL_MS: 10000,
    EXPORT_DIRECTORY_MAX_COUNT: 4,
    EXPORT_FILE_STABLE_SCANS: 2,
    document: { hidden: false },
    uxpFs: {
      async readdir() {
        return entries.slice();
      },
      async lstat() {
        return { size: fileSize, mtimeMs: modifiedAt, isFile: () => true };
      },
    },
    setTimeout(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    defaultExportDirectory: () => "C:/exports",
    isAbsoluteLocalPath: (value) => /^[A-Za-z]:\//.test(String(value || "")),
    parentLocalDirectory: (value) => String(value).replace(/\/[^/]+$/, ""),
    localBasename: (value) => String(value).replace(/\\/g, "/").split("/").at(-1),
    normalizeLocalDirectory: (value) => String(value).replace(/\\/g, "/").replace(/\/$/, ""),
    pathKey: (value) => String(value).replace(/\\/g, "/").toLowerCase(),
    resolveDirectoryEntryPath: (directory, entry) => `${directory}/${entry}`,
    isSupportedReplayVideo: (value) => /\.mov$/i.test(value),
    fileModifiedAt: (stats) => stats.mtimeMs,
    normalizeCompletedAt: (value) => new Date(value).toISOString(),
    replayTitleFromFilepath: (value) => path.basename(value, path.extname(value)),
    siblingThumbnailPath: () => "",
    yieldToHost: () => Promise.resolve(),
  };

  vm.runInNewContext(
    `${mainSource.slice(pollerStart, pollerEnd)}\nthis.ExportDirectoryPoller = ExportDirectoryPoller;`,
    context,
    { filename: "main.js#ExportDirectoryPoller" },
  );

  const poller = new context.ExportDirectoryPoller((payload) => emitted.push(payload));
  poller.start([]);
  await waitFor(() => timers.size === 1);
  assert.equal(timers.values().next().value.delay, 3000);

  entries = ["new-shot.mov"];
  await runOnlyTimer(timers);
  assert.equal(emitted.length, 0, "first observation must wait for file stability");
  await runOnlyTimer(timers);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].filepath, "C:/exports/new-shot.mov");
  assert.equal(emitted[0].sourceEvent, "FILESYSTEM_POLL");
  assert.equal(emitted[0].fileSize, 1024);
  assert.equal(timers.size, 1, "poller must own exactly one future timer");

  fileSize = 2048;
  modifiedAt += 1000;
  await runOnlyTimer(timers);
  assert.equal(emitted.length, 1, "same-name overwrite must also stabilize");
  await runOnlyTimer(timers);
  assert.equal(emitted.length, 2, "same-name physical overwrite must be rediscovered");
  assert.equal(emitted[1].filepath, "C:/exports/new-shot.mov");
  assert.equal(emitted[1].fileSize, 2048);
  assert.notEqual(emitted[1].id, emitted[0].id);

  poller.destroy();
  assert.equal(timers.size, 0);
});

async function runOnlyTimer(timers) {
  await waitFor(() => timers.size === 1);
  const [id, timer] = timers.entries().next().value;
  timers.delete(id);
  timer.callback();
  await waitFor(() => timers.size === 1);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for watcher state.");
}
