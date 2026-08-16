"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const library = require("./src/replays/oracle-replay-library.js");

function replayMessage(overrides = {}) {
  return {
    type: "IMPORT_CLIP",
    schema: library.BRIDGE_EVENT_SCHEMA,
    version: library.BRIDGE_EVENT_VERSION,
    payload: {
      eventId: "history-export-1",
      absolutePath: "D:\\Blocky Studios Renders\\Unicode 雪 (take 1).mov",
      fileName: "Unicode 雪 (take 1).mov",
      timestamp: "2026-07-15T18:00:00.000Z",
      durationMs: 12080,
      width: 1920,
      height: 1080,
      fps: 60,
      fileSize: 123456,
      modifiedAt: "2026-07-15T18:00:01.000Z",
      fileIdentity: { volumeSerial: "ABCD", fileIndex: "1234" },
      thumbnailBase64: "/9j/2Q==",
      ...overrides,
    },
  };
}

test("M2 has one v3 replay store and keeps v2 storage strictly as a migration input", () => {
  assert.doesNotMatch(mainSource, /class ReplayStore\b/);
  assert.doesNotMatch(mainSource, /class ReplayHistoryPersistence\b/);
  assert.doesNotMatch(mainSource, /function writeReplayHistoryFiles\b/);
  assert.doesNotMatch(mainSource, /function persistLocalReplayHistory\b/);
  assert.match(mainSource, /new replayLibraryApi\.ReplayLibraryStore\(/);
  assert.match(mainSource, /new replayLibraryApi\.OracleStateRepository\(/);
  assert.match(mainSource, /atomicWriter:\s*createNativeStateAtomicWriter\(nativeDragAddon\)/);
  assert.match(mainSource, /getDataFolder\(\)/);
  assert.match(mainSource, /addon\.writeAtomicStateFile\(/);
  assert.match(mainSource, /legacyLoader:\s*async \(\) =>/);
  assert.match(mainSource, /readReplayHistoryFile\(REPLAY_HISTORY_FILE_URL\)/);
  assert.match(mainSource, /readReplayHistoryFile\(REPLAY_HISTORY_BACKUP_FILE_URL\)/);
});

test("permanent v3 history is uncapped and preserves exact export metadata", () => {
  const store = new library.ReplayLibraryStore();
  const messages = Array.from({ length: 250 }, (_, index) => replayMessage({
    eventId: `history-${index}`,
    absolutePath: `D:\\Blocky Studios Renders\\replay-${index}.mov`,
    fileName: `replay-${index}.mov`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    durationMs: index * 1000 + 500,
    fileIdentity: { key: `identity-${index}` },
    fileSize: 1000 + index,
    thumbnailBase64: "",
  }));

  const touched = store.replaceSnapshot(messages);
  assert.equal(touched.length, 250);
  assert.equal(store.items.length, 250);
  const last = store.getRecord(touched[249].id);
  assert.equal(last.durationMs, 249500);
  assert.equal(last.fileSize, 1249);
  assert.equal(last.legacy.resolution, "1920 × 1080");
  assert.equal(last.legacy.fps, 60);
});

test("stable event delivery deduplicates while a physical overwrite remains a new replay", () => {
  const store = new library.ReplayLibraryStore();
  const first = store.ingest(replayMessage());
  const repeated = store.ingest(replayMessage());
  assert.equal(first.ok, true);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.duplicate, true);
  assert.equal(store.items.length, 1);

  const overwrite = store.ingest(replayMessage({
    eventId: "history-export-2",
    fileIdentity: null,
    fileSize: 654321,
    modifiedAt: "2026-07-15T19:00:00.000Z",
  }));
  assert.equal(overwrite.ok, true);
  assert.equal(overwrite.duplicate, false);
  assert.equal(store.items.length, 2);
});

test("raw thumbnail bytes are live-only and never enter persistent v3 state", () => {
  const store = new library.ReplayLibraryStore();
  const result = store.ingest(replayMessage());
  assert.equal(result.ok, true);
  assert.equal(store.consumeThumbnail(result.record.id), "/9j/2Q==");
  assert.equal(store.consumeThumbnail(result.record.id), "");
  assert.doesNotMatch(JSON.stringify(store.state), /thumbnailBase64|\/9j\/2Q==|data:image/);
});

test("v3 ingest accepts exact local and UNC paths and rejects device, ADS, traversal, and relative forms", () => {
  for (const absolutePath of [
    "C:\\renders\\Unicode 雪\\clip.mov",
    "\\\\render-server\\oracle share\\clip.mov",
    "\\\\?\\C:\\very-long\\clip.mov",
    "\\\\?\\UNC\\server\\share\\clip.mov",
  ]) {
    assert.equal(library.normalizeBridgeReplay(replayMessage({
      eventId: `path-${absolutePath}`,
      absolutePath,
      fileIdentity: { key: absolutePath },
    })).ok, true, absolutePath);
  }

  for (const absolutePath of [
    "renders\\relative.mov",
    "C:\\renders\\..\\secret.mov",
    "C:\\renders\\clip.mov:secret",
    "\\\\.\\PhysicalDrive0",
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1",
  ]) {
    assert.equal(library.normalizeBridgeReplay(replayMessage({ absolutePath })).ok, false, absolutePath);
  }
});

test("raw Base64 bridge thumbnails normalize in memory without becoming a stored URL", () => {
  const normalized = library.normalizeBridgeReplay(replayMessage());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.thumbnailBase64, "/9j/2Q==");
  assert.equal(normalized.record.thumbnailCacheKey, "");
  assert.equal(normalized.record.thumbnailStatus, "processing");
  assert.doesNotMatch(JSON.stringify(normalized.record), /\/9j\/2Q==|data:image/);
});
