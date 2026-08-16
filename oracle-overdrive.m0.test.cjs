"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ORACLE_OVERDRIVE_FEATURE_FLAGS,
  isOracleFeatureEnabled,
} = require("./src/core/feature-flags.js");
const {
  ORACLE_STATE_SCHEMA,
  ORACLE_STATE_VERSION,
  createEmptyOracleState,
  isUuid,
  validateOracleState,
} = require("./src/data/oracle-data-schema.js");
const {
  migrateOracleState,
  recoverOracleState,
} = require("./src/data/oracle-migrations.js");

test("frozen Milestone 0 invariants stay on while accepted product milestones advance", () => {
  assert.equal(Object.isFrozen(ORACLE_OVERDRIVE_FEATURE_FLAGS), true);
  const accepted = new Set([
    "nativeOleDrag",
    "overdriveShell",
    "bridgeProtocolV2",
    "replayStoreV3Read",
    "replayStoreV3Write",
    "virtualReplayGrid",
    "nativeDirectoryWatch",
    "nativeFileOperations",
    "replayLifecycle",
    "replayViewer",
    "curvesWorkspace",
    "quickApplyWorkspace",
    "multiPanelSync",
  ]);
  for (const [name, enabled] of Object.entries(ORACLE_OVERDRIVE_FEATURE_FLAGS)) {
    assert.equal(enabled, accepted.has(name), `${name} has the wrong product milestone gate`);
  }
  assert.equal(isOracleFeatureEnabled("legacyReplayLibrary"), false);
  assert.equal(isOracleFeatureEnabled("unknownFeature"), false);
});

test("empty Blocky Studios state is versioned, deterministic, and valid", () => {
  const state = createEmptyOracleState({ writerId: "test", writtenAt: "2026-07-15T12:00:00Z" });
  assert.equal(state.schema, ORACLE_STATE_SCHEMA);
  assert.equal(state.version, ORACLE_STATE_VERSION);
  assert.equal(state.writtenAt, "2026-07-15T12:00:00.000Z");
  assert.deepEqual(validateOracleState(state), { ok: true, errors: [] });
});

test("legacy v2 migration preserves replay metadata without persisting image bytes", () => {
  const legacy = {
    version: 2,
    savedAt: "2026-07-15T14:30:00.000Z",
    replays: [{
      id: "legacy-render-17",
      title: "Hero Orbit",
      filepath: "D:/Blocky Studios Renders/Unicode 雪/Hero Orbit.mov",
      completedAt: "2026-07-15T14:00:00.000Z",
      durationSeconds: 12.345,
      resolution: "3840 × 2160",
      fps: 60,
      timecode: "01:00:12:20",
      thumbnailPath: "iVBORw0KGgoAAA_PRIVATE",
      thumbnailBase64: "private-image-bytes",
      tags: ["hero", "orbit", "hero"],
      favorite: true,
      rating: 4,
      notes: "Keep this take",
    }],
    preferences: { gridColumns: 4 },
  };

  const first = migrateOracleState(legacy);
  const second = migrateOracleState(legacy);
  assert.equal(first.sourceValid, true);
  assert.equal(first.migrated, true);
  assert.deepEqual(first.state, second.state, "migration is not deterministic");
  const replay = Object.values(first.state.replaysById)[0];
  assert.equal(isUuid(replay.id), true);
  assert.equal(replay.canonicalPath, "D:\\Blocky Studios Renders\\Unicode 雪\\Hero Orbit.mov");
  assert.equal(replay.pathKey, "d:\\blocky studios renders\\unicode 雪\\hero orbit.mov");
  assert.equal(replay.displayNameOverride, "Hero Orbit");
  assert.equal(replay.durationMs, 12345);
  assert.deepEqual(replay.tags, ["hero", "orbit"]);
  assert.equal(replay.favorite, true);
  assert.equal(replay.rating, 4);
  assert.equal(replay.notes, "Keep this take");
  assert.equal(replay.legacy.resolution, "3840 × 2160");
  assert.equal(replay.legacy.fps, 60);
  assert.equal(replay.legacy.timecode, "01:00:12:20");
  assert.equal(replay.legacy.thumbnailPath, "");
  assert.equal(JSON.stringify(first.state).includes("private-image-bytes"), false);
  assert.equal(JSON.stringify(first.state).includes("iVBORw0KGgoAAA_PRIVATE"), false);
  assert.ok(first.diagnostics.some((entry) => entry.code === "RAW_THUMBNAIL_DROPPED"));
  assert.deepEqual(validateOracleState(first.state), { ok: true, errors: [] });
});

test("v3 migration is idempotent and retains collections, curve presets, and preferences", () => {
  const legacy = {
    version: 2,
    savedAt: "2026-07-15T15:00:00.000Z",
    replays: [{ title: "Clip", filepath: "C:\\renders\\clip.mp4" }],
    collections: [{ id: "favorites", name: "Favorites", color: "#D948D7", manualOrder: ["one"] }],
    curvePresets: [{
      id: "ease",
      name: "Ease",
      cubicControlPoints: [0.2, 0.1, 0.8, 1],
      tags: ["soft"],
      folderId: "folder:cinematic",
    }],
    preferences: { appearance: { accent: "#D948D7" } },
    quickApplyState: { recent: ["ADBE Gaussian Blur 2"] },
  };
  const migrated = migrateOracleState(legacy).state;
  migrated.revision = 7;
  const again = migrateOracleState(JSON.stringify(migrated));
  assert.equal(again.sourceValid, true);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.state, migrated);
  assert.equal(Object.values(again.state.collectionsById)[0].name, "Favorites");
  assert.equal(Object.values(again.state.curvePresetsById)[0].name, "Ease");
  assert.equal(Object.values(again.state.curvePresetsById)[0].folderId, "folder:cinematic");
  assert.equal(again.state.preferences.appearance.accent, "#D948D7");
  assert.deepEqual(again.state.quickApplyState.recent, ["ADBE Gaussian Blur 2"]);
});

test("recovery rejects corrupt input and selects the newest valid complete snapshot", () => {
  const older = migrateOracleState({
    version: 2,
    savedAt: "2026-07-15T10:00:00.000Z",
    replays: [{ title: "Older", filepath: "C:\\renders\\older.mp4" }],
  }).state;
  older.revision = 2;
  const newer = migrateOracleState({
    version: 2,
    savedAt: "2026-07-15T11:00:00.000Z",
    replays: [{ title: "Newer", filepath: "C:\\renders\\newer.mp4" }],
  }).state;
  newer.revision = 3;
  const recovered = recoverOracleState([
    { source: "primary", value: "{not-json" },
    { source: "backup", value: JSON.stringify(older) },
    { source: "last-known-good", value: newer },
  ]);
  assert.equal(recovered.source, "last-known-good");
  assert.equal(recovered.recovered, true);
  assert.equal(Object.values(recovered.state.replaysById)[0].displayNameOverride, "Newer");

  assert.throws(() => recoverOracleState([{ source: "primary", value: "broken" }]), (error) => {
    assert.equal(error.name, "OracleStateRecoveryError");
    assert.equal(error.code, "STATE_RECOVERY_REQUIRED");
    assert.deepEqual(error.details.sources, ["primary"]);
    assert.equal(error.details.candidateCount, 1);
    assert.ok(error.diagnostics.some((entry) => entry.code === "STATE_RECOVERY_REQUIRED"));
    return true;
  });

  const firstRun = recoverOracleState([], {
    writtenAt: "2026-07-15T12:00:00.000Z",
    writerId: "first-run",
  });
  assert.equal(firstRun.source, null);
  assert.equal(firstRun.firstRun, true);
  assert.equal(firstRun.recovered, false);
  assert.equal(firstRun.candidateCount, 0);
  assert.ok(firstRun.diagnostics.some((entry) => entry.code === "NO_STATE_CANDIDATES"));
  assert.deepEqual(validateOracleState(firstRun.state), { ok: true, errors: [] });
});

test("migration rejects relative records without weakening the valid snapshot", () => {
  const result = migrateOracleState({
    version: 2,
    replays: [
      { title: "Unsafe", filepath: "renders\\relative.mp4" },
      { title: "Device", filepath: "\\\\.\\PhysicalDrive0" },
      { title: "ADS", filepath: "C:\\renders\\clip.mp4:secret" },
      { title: "UNC", filepath: "\\\\render-server\\oracle\\safe.mp4" },
    ],
  });
  assert.equal(result.sourceValid, true);
  assert.equal(Object.keys(result.state.replaysById).length, 1);
  assert.equal(Object.values(result.state.replaysById)[0].displayNameOverride, "UNC");
  assert.ok(result.diagnostics.some((entry) => entry.code === "REPLAY_SKIPPED"));
});

test("legacy entity ids stay stable when mutable metadata changes", () => {
  const first = migrateOracleState({
    version: 2,
    replays: [{ id: "clip-stable", title: "Old", filepath: "C:\\renders\\old.mp4" }],
    collections: [{ id: "collection-stable", name: "Old Collection" }],
    curvePresets: [{ id: "curve-stable", name: "Old Curve" }],
  }).state;
  const second = migrateOracleState({
    version: 2,
    replays: [{ id: "clip-stable", title: "New", filepath: "D:\\moved\\new.mp4" }],
    collections: [{ id: "collection-stable", name: "Renamed Collection" }],
    curvePresets: [{ id: "curve-stable", name: "Renamed Curve" }],
  }).state;
  assert.deepEqual(Object.keys(first.replaysById), Object.keys(second.replaysById));
  assert.deepEqual(Object.keys(first.collectionsById), Object.keys(second.collectionsById));
  assert.deepEqual(Object.keys(first.curvePresetsById), Object.keys(second.curvePresetsById));
});

test("legacy UUIDs are order-independent and collection references are rewritten", () => {
  const source = {
    version: 2,
    savedAt: "2026-07-15T16:00:00.000Z",
    replays: [
      { id: "clip-a", title: "A", filepath: "C:\\renders\\a.mp4", collectionIds: ["collection-a"] },
      { id: "clip-b", title: "B", filepath: "C:\\renders\\b.mp4", collectionIds: ["collection-a"] },
    ],
    collections: [{
      id: "collection-a",
      name: "Selects",
      manualOrder: ["clip-b", "clip-a"],
    }],
    curvePresets: [
      { id: "curve-a", name: "A", cubicControlPoints: [0.1, 0.2, 0.3, 0.4], manualOrder: 0 },
      { id: "curve-b", name: "B", cubicControlPoints: [0.2, 0.3, 0.4, 0.5], manualOrder: 1 },
    ],
  };
  const reversed = {
    ...source,
    replays: [...source.replays].reverse(),
    curvePresets: [...source.curvePresets].reverse(),
  };
  const first = migrateOracleState(source).state;
  const second = migrateOracleState(reversed).state;
  assert.deepEqual(Object.keys(first.replaysById).sort(), Object.keys(second.replaysById).sort());
  assert.deepEqual(Object.keys(first.collectionsById), Object.keys(second.collectionsById));
  assert.deepEqual(Object.keys(first.curvePresetsById).sort(), Object.keys(second.curvePresetsById).sort());

  const collection = Object.values(first.collectionsById)[0];
  const replayIdByLegacyId = Object.fromEntries(
    Object.values(first.replaysById).map((replay) => [replay.legacy.id, replay.id]),
  );
  assert.deepEqual(collection.manualOrder, [replayIdByLegacyId["clip-b"], replayIdByLegacyId["clip-a"]]);
  for (const replay of Object.values(first.replaysById)) {
    assert.deepEqual(replay.collectionIds, [collection.id]);
  }
  assert.deepEqual(validateOracleState(first), { ok: true, errors: [] });
});

test("recovery never lets incomplete or future high-revision input beat a valid backup", () => {
  const backup = migrateOracleState({
    version: 2,
    savedAt: "2026-07-15T17:00:00.000Z",
    replays: [{ id: "safe", title: "Safe", filepath: "C:\\renders\\safe.mp4" }],
  }).state;
  backup.revision = 5;
  const incompleteV3 = {
    schema: ORACLE_STATE_SCHEMA,
    version: ORACLE_STATE_VERSION,
    revision: 999,
    writtenAt: "2026-07-15T18:00:00.000Z",
    writerId: "broken",
    replaysById: {},
  };
  const recovered = recoverOracleState([
    { source: "primary", value: { revision: 1001, foo: "bar" } },
    { source: "future", value: { schema: ORACLE_STATE_SCHEMA, version: 99, revision: 1000 } },
    { source: "incomplete-v3", value: incompleteV3 },
    { source: "partial-legacy", value: { version: 2, revision: 999, replays: [{ filepath: "relative.mp4" }] } },
    { source: "backup", value: backup },
  ]);
  assert.equal(recovered.source, "backup");
  assert.equal(Object.values(recovered.state.replaysById)[0].displayNameOverride, "Safe");
  assert.equal(
    recovered.diagnostics.filter((entry) => entry.code === "RECOVERY_CANDIDATE_REJECTED").length,
    4,
  );
});
