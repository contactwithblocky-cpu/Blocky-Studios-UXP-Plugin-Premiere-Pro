"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const schema = require("./src/data/oracle-data-schema.js");
const organization = require("./src/replays/oracle-replay-organization.js");

const NOW = "2026-07-15T20:00:00.000Z";

function replay(index, overrides = {}) {
  const id = schema.stableUuidFromSeed(`m3-replay-${index}`);
  const canonicalPath = `D:\\Disposable Blocky Studios Tests\\Root ${index % 2}\\Shot ${index}.mp4`;
  return {
    id,
    canonicalPath,
    pathKey: schema.replayPathKey(canonicalPath),
    fileIdentity: { volumeSerial: "D-VOLUME", fileIndex: String(1000 + index) },
    sourceName: `Shot ${index}`,
    displayNameOverride: "",
    fileSize: 1000000 + index,
    modifiedAt: `2026-07-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
    exportedAt: `2026-07-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
    firstSeenAt: `2026-07-${String(10 + index).padStart(2, "0")}T12:00:01.000Z`,
    durationMs: 10000 + index * 1000,
    thumbnailCacheKey: `thumb-${index}`,
    thumbnailStatus: "ready",
    archiveState: "active",
    missingState: "available",
    collectionIds: [],
    tags: [],
    favorite: false,
    rating: 0,
    notes: "",
    usageCount: 0,
    lastOpenedAt: null,
    lastDraggedAt: null,
    legacy: {},
    ...overrides,
  };
}

function stateWithReplays(count = 4) {
  const state = schema.createEmptyOracleState({ writtenAt: NOW, writerId: "m3-tests" });
  for (let index = 0; index < count; index += 1) {
    const record = replay(index);
    state.replaysById[record.id] = record;
  }
  assert.deepEqual(schema.validateOracleState(state), { ok: true, errors: [] });
  return state;
}

function createCollection(state, name, options = {}) {
  const result = organization.createCollectionPlan(state, { name, color: options.color || "#aa33cc", smartRules: options.smartRules }, {
    id: options.id,
    now: options.now || NOW,
  });
  assert.equal(result.ok, true, result.message);
  return result;
}

test("M3 collection plans create, rename, recolor, reorder, duplicate, and delete immutably", () => {
  const original = stateWithReplays(3);
  const originalJson = JSON.stringify(original);
  const first = createCollection(original, "Heroes");
  assert.equal(JSON.stringify(original), originalJson, "collection creation must not mutate input state");
  assert.equal(Object.keys(first.state.collectionsById).length, 1);

  const second = createCollection(first.state, "B-Roll", { now: "2026-07-15T20:00:01.000Z" });
  const firstId = first.collection.id;
  const secondId = second.collection.id;
  const reordered = organization.reorderCollectionsPlan(second.state, [secondId, firstId]);
  assert.equal(reordered.ok, true);
  assert.deepEqual(reordered.collectionOrder, [secondId, firstId]);

  const renamed = organization.renameCollectionPlan(reordered.state, firstId, "Principal Heroes", { now: "2026-07-15T20:00:02.000Z" });
  assert.equal(renamed.state.collectionsById[firstId].name, "Principal Heroes");
  assert.equal(organization.renameCollectionPlan(renamed.state, firstId, "B-Roll").code, "COLLECTION_NAME_EXISTS");

  const recolored = organization.recolorCollectionPlan(renamed.state, firstId, "#102030", { now: "2026-07-15T20:00:03.000Z" });
  assert.equal(recolored.state.collectionsById[firstId].color, "#102030");
  assert.equal(organization.recolorCollectionPlan(recolored.state, firstId, "magenta").code, "INVALID_COLLECTION_COLOR");

  const replayId = Object.keys(recolored.state.replaysById)[0];
  const member = organization.planReplayMetadata(recolored.state, [replayId], { collectionIds: [firstId] });
  const ordered = organization.reorderCollectionReplaysPlan(member.state, firstId, [replayId], { now: "2026-07-15T20:00:04.000Z" });
  const duplicate = organization.duplicateCollectionPlan(ordered.state, firstId, {}, { now: "2026-07-15T20:00:05.000Z" });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.collection.name, "Principal Heroes Copy");
  assert.deepEqual(duplicate.collection.manualOrder, [replayId]);
  assert.equal(duplicate.state.replaysById[replayId].collectionIds.includes(duplicate.collection.id), true);

  const removed = organization.deleteCollectionPlan(duplicate.state, firstId);
  assert.equal(removed.ok, true);
  assert.equal(removed.state.collectionsById[firstId], undefined);
  assert.deepEqual(removed.state.replaysById[replayId].collectionIds, [duplicate.collection.id]);
  assert.equal(removed.changedReplayIds.includes(replayId), true);
  assert.deepEqual(schema.validateOracleState(removed.state), { ok: true, errors: [] });
});

test("M3 replay metadata and bounded batch actions preserve schema and case-insensitive tag identity", () => {
  const base = stateWithReplays(4);
  const collection = createCollection(base, "Selects");
  const ids = Object.keys(collection.state.replaysById);
  const sourceJson = JSON.stringify(collection.state);
  const metadata = organization.planReplayMetadata(collection.state, [ids[0]], {
    displayName: "Hero Take",
    collectionIds: [collection.collection.id],
    tags: ["Hero", "hero", " Night "],
    favorite: true,
    rating: 5,
    notes: "Final select",
  });
  assert.equal(metadata.ok, true);
  assert.equal(JSON.stringify(collection.state), sourceJson);
  assert.deepEqual(metadata.state.replaysById[ids[0]].tags, ["Hero", "Night"]);
  assert.equal(metadata.state.replaysById[ids[0]].displayNameOverride, "Hero Take");

  const addTags = organization.planBatchReplayAction(metadata.state, ids.slice(0, 3), {
    type: "tag",
    mode: "add",
    tags: ["Action", "HERO"],
  });
  assert.equal(addTags.ok, true);
  assert.deepEqual(addTags.state.replaysById[ids[0]].tags, ["Hero", "Night", "Action"]);
  assert.deepEqual(addTags.state.replaysById[ids[1]].tags, ["Action", "HERO"]);

  const addCollection = organization.planBatchReplayAction(addTags.state, ids.slice(1, 3), {
    type: "collection",
    mode: "add",
    collectionIds: [collection.collection.id],
  });
  assert.equal(addCollection.ok, true);
  assert.equal(addCollection.state.replaysById[ids[2]].collectionIds.includes(collection.collection.id), true);
  const favorite = organization.planBatchReplayAction(addCollection.state, ids.slice(0, 3), { type: "favorite", value: true });
  const archived = organization.archiveReplaysPlan(favorite.state, ids.slice(0, 2));
  const restored = organization.restoreReplaysPlan(archived.state, [ids[0]]);
  assert.equal(restored.state.replaysById[ids[0]].archiveState, "active");
  assert.equal(restored.state.replaysById[ids[1]].archiveState, "archived");
  assert.equal(organization.planReplayMetadata(restored.state, [ids[0]], { rating: 2.5 }).code, "INVALID_RATING");
  assert.deepEqual(schema.validateOracleState(restored.state), { ok: true, errors: [] });
});

test("M3 collection replay order is deterministic and isolated from smart collections", () => {
  const base = stateWithReplays(5);
  const manual = createCollection(base, "Manual");
  const ids = Object.keys(manual.state.replaysById);
  const members = organization.planBatchReplayAction(manual.state, ids.slice(0, 4), {
    type: "collection",
    mode: "add",
    collectionIds: [manual.collection.id],
  });
  const firstOrder = organization.reorderCollectionReplaysPlan(members.state, manual.collection.id, [ids[2], ids[0]]);
  assert.deepEqual(firstOrder.manualOrder, [ids[2], ids[0], ...[ids[1], ids[3]].sort()]);
  const moved = organization.moveCollectionReplaysPlan(firstOrder.state, manual.collection.id, [ids[3], ids[0]], 0);
  assert.deepEqual(moved.manualOrder.slice(0, 2), [ids[3], ids[0]]);
  assert.equal(organization.reorderCollectionReplaysPlan(members.state, manual.collection.id, [ids[4]]).code, "REPLAY_NOT_IN_COLLECTION");

  const smart = createCollection(moved.state, "Smart", {
    smartRules: { match: "all", rules: [{ field: "favorite", operator: "is", value: true }] },
    now: "2026-07-15T20:01:00.000Z",
  });
  assert.equal(organization.reorderCollectionReplaysPlan(smart.state, smart.collection.id, []).code, "SMART_COLLECTION_MANUAL_ORDER");
  assert.equal(organization.planBatchReplayAction(smart.state, [ids[0]], {
    type: "collection",
    mode: "add",
    collectionIds: [smart.collection.id],
  }).code, "SMART_COLLECTION_RULE_DRIVEN");
});

test("M3 smart rules validate and evaluate every required user-visible field", () => {
  const record = replay(1, {
    displayNameOverride: "Night Hero Orbit",
    tags: ["Hero", "Night"],
    favorite: true,
    missingState: "missing",
    durationMs: 11000,
  });
  const rules = [
    { field: "date", operator: "withinDays", source: "exportedAt", value: 10 },
    { field: "duration", operator: "between", minimumMs: 10000, maximumMs: 12000 },
    { field: "root", operator: "isUnder", value: "D:\\Disposable Blocky Studios Tests" },
    { field: "tag", operator: "contains", value: "hero" },
    { field: "favorite", operator: "is", value: true },
    { field: "missing", operator: "is", value: true },
    { field: "name", operator: "contains", value: "orbit" },
  ];
  const normalized = organization.normalizeSmartRules({ match: "all", rules });
  assert.equal(normalized.ok, true);
  assert.equal(organization.evaluateSmartRules(record, normalized.value, { now: NOW }), true);
  assert.equal(organization.evaluateSmartRules({ ...record, favorite: false }, normalized.value, { now: NOW }), false);
  assert.equal(organization.evaluateSmartRules(record, {
    match: "any",
    rules: [
      { field: "tag", operator: "contains", value: "nope" },
      { field: "name", operator: "startsWith", value: "Night" },
    ],
  }, { now: NOW }), true);
  assert.equal(organization.normalizeSmartRules({ match: "all", rules: [] }).code, "EMPTY_SMART_RULES");
  assert.equal(organization.normalizeSmartRules({ match: "all", rules: [{ field: "root", operator: "isUnder", value: "relative" }] }).code, "INVALID_SMART_RULE_VALUE");
  assert.equal(organization.SMART_RULE_FIELDS.length, 7);
});

test("M3 recent, persisted most-used, and saved-search helpers remain deterministic", () => {
  const base = stateWithReplays(4);
  const ids = Object.keys(base.replaysById);
  base.replaysById[ids[0]].exportedAt = "2026-01-01T00:00:00.000Z";
  base.replaysById[ids[0]].firstSeenAt = "2026-01-01T00:00:00.000Z";
  assert.deepEqual(organization.recentReplayIds(base, { now: NOW, days: 30 }), ids.slice(1).reverse());

  const usedOnce = organization.recordReplayUsagePlan(base, ids[1], "opened", { now: "2026-07-15T19:00:00.000Z" });
  const usedTwice = organization.recordReplayUsagePlan(usedOnce.state, ids[2], "opened", { now: "2026-07-15T19:01:00.000Z" });
  const usedAgain = organization.recordReplayUsagePlan(usedTwice.state, ids[2], "dragged", { now: "2026-07-15T19:02:00.000Z" });
  assert.deepEqual(organization.mostUsedReplayIds(usedAgain.state), [ids[2], ids[1]]);

  const saved = organization.createSavedSearchPlan(usedAgain.state, {
    name: "Favorites",
    smartRules: { match: "all", rules: [{ field: "favorite", operator: "is", value: true }] },
  }, { now: NOW });
  assert.equal(saved.ok, true);
  assert.equal(organization.listSavedSearches(saved.state).length, 1);
  const favorites = organization.planBatchReplayAction(saved.state, [ids[1], ids[3]], { type: "favorite", value: true });
  assert.deepEqual(organization.selectSmartCollectionReplayIds(favorites.state, saved.collection.id), [ids[3], ids[1]]);
});

test("M3 selection reducer covers plain, Ctrl, Shift, arrows, keyboard range, Ctrl+A, and Escape", () => {
  const ids = Object.keys(stateWithReplays(5).replaysById);
  let selection = organization.createReplaySelection(ids);
  selection = organization.applyReplaySelectionAction(selection, { type: "pointer", id: ids[1] });
  assert.deepEqual(selection.selectedIds, [ids[1]]);
  selection = organization.applyReplaySelectionAction(selection, { type: "pointer", id: ids[3], ctrlKey: true });
  assert.deepEqual(selection.selectedIds, [ids[1], ids[3]]);
  selection = organization.applyReplaySelectionAction(selection, { type: "pointer", id: ids[4], shiftKey: true });
  assert.deepEqual(selection.selectedIds, [ids[3], ids[4]]);
  selection = organization.applyReplaySelectionAction(selection, { type: "keyboard", key: "ArrowUp", columns: 2, shiftKey: true });
  assert.deepEqual(selection.selectedIds, [ids[2], ids[3]]);
  const focusBefore = selection.focusId;
  selection = organization.applyReplaySelectionAction(selection, { type: "keyboard", key: "ArrowLeft", ctrlKey: true });
  assert.notEqual(selection.focusId, focusBefore);
  assert.deepEqual(selection.selectedIds, [ids[2], ids[3]]);
  selection = organization.applyReplaySelectionAction(selection, { type: "keyboard", key: "a", ctrlKey: true });
  assert.deepEqual(selection.selectedIds, ids);
  selection = organization.applyReplaySelectionAction(selection, { type: "keyboard", key: "Escape" });
  assert.deepEqual(selection.selectedIds, []);
});

test("M3 source rename plan preserves extension, guards exact identity, and requires Premiere warning", () => {
  const base = stateWithReplays(2);
  const id = Object.keys(base.replaysById)[0];
  const originalJson = JSON.stringify(base);
  const plan = organization.sourceRenamePlan(base, id, "Hero Final", { premiereReferenceCount: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.targetPath.endsWith("\\Hero Final.mp4"), true);
  assert.equal(plan.requiresPremiereWarning, true);
  assert.equal(plan.readyForMutation, false);
  assert.equal(plan.commitRecord.canonicalPath, plan.targetPath);
  assert.equal(plan.commitRecord.thumbnailStatus, "pending");
  assert.equal(JSON.stringify(base), originalJson);
  assert.equal(organization.sourceRenamePlan(base, id, "Hero.mov").code, "EXTENSION_CHANGE_NOT_ALLOWED");
  assert.equal(organization.sourceRenamePlan(base, id, "CON").code, "INVALID_SOURCE_NAME");
  assert.equal(organization.validateFileIdentityGuard(base.replaysById[id].fileIdentity, { volumeSerial: "D-VOLUME", fileIndex: "changed" }).code, "FILE_IDENTITY_CHANGED");
  assert.equal(organization.validateFileIdentityGuard(base.replaysById[id].fileIdentity, cloneIdentity(base.replaysById[id].fileIdentity)).ok, true);
  const authorized = organization.sourceRenamePlan(base, id, "Hero Final", {
    premiereReferenceCount: 2,
    premiereWarningAccepted: true,
    supportedPremiereRelinkVerified: true,
  });
  assert.equal(authorized.readyForMutation, true);
  assert.equal(organization.commitGuardedReplayMutation(base, authorized, {
    success: true,
    observedSourceIdentity: cloneIdentity(base.replaysById[id].fileIdentity),
  }).state.replaysById[id].canonicalPath, authorized.targetPath);
  assert.equal(organization.commitGuardedReplayMutation(base, authorized, {
    success: true,
    observedSourceIdentity: { volumeSerial: "D-VOLUME", fileIndex: "race" },
  }).code, "FILE_IDENTITY_CHANGED");

  const withoutIdentity = stateWithReplays(1);
  const noIdentityId = Object.keys(withoutIdentity.replaysById)[0];
  withoutIdentity.replaysById[noIdentityId].fileIdentity = null;
  assert.equal(organization.sourceRenamePlan(withoutIdentity, noIdentityId, "Safe Name").code, "FILE_IDENTITY_REQUIRED");
});

function cloneIdentity(value) {
  return JSON.parse(JSON.stringify(value));
}

test("M3 relink scoring is root-bounded, deterministic, ambiguity-aware, and honest across volumes", () => {
  const base = stateWithReplays(1);
  const record = Object.values(base.replaysById)[0];
  const roots = ["D:\\Disposable Relink", ...Array.from({ length: 40 }, (_, index) => `E:\\Configured ${index}`)];
  assert.equal(organization.normalizeConfiguredRoots(roots).roots.length, organization.MAX_RELINK_ROOTS);
  assert.equal(organization.normalizeConfiguredRoots(roots).truncated, true);
  const common = {
    fileSize: record.fileSize,
    durationMs: record.durationMs,
    modifiedAt: record.modifiedAt,
    isRegularFile: true,
  };
  const candidates = [
    { ...common, canonicalPath: "D:\\Disposable Relink\\A\\Shot 0.mp4", fileIdentity: { volumeSerial: "D-VOLUME", fileIndex: "A" } },
    { ...common, canonicalPath: "D:\\Disposable Relink\\B\\Shot 0.mp4", fileIdentity: { volumeSerial: "D-VOLUME", fileIndex: "B" } },
    { ...common, canonicalPath: "C:\\Outside Root\\Shot 0.mp4", fileIdentity: { volumeSerial: "C-VOLUME", fileIndex: "C" } },
    { ...common, canonicalPath: "D:\\Disposable Relink\\Unsafe\\Shot 0.mp4", isReparsePoint: true },
  ];
  const ambiguous = organization.scoreRelinkCandidates(record, candidates, ["D:\\Disposable Relink"]);
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.results.length, 2);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.requiresConfirmation, true);

  const exact = organization.scoreRelinkCandidates(record, [
    ...candidates.slice(0, 2),
    { ...common, canonicalPath: "D:\\Disposable Relink\\Exact\\Shot 0.mp4", fileIdentity: cloneIdentity(record.fileIdentity) },
  ], ["D:\\Disposable Relink"]);
  assert.equal(exact.best.reasons.includes("exact-file-identity"), true);
  assert.equal(exact.ambiguous, false);

  const cross = organization.relinkPlan(base, record.id, {
    ...common,
    canonicalPath: "E:\\Configured 0\\Shot 0.mp4",
    fileIdentity: { volumeSerial: "E-VOLUME", fileIndex: "2000" },
  });
  assert.equal(cross.ok, true);
  assert.equal(cross.sameVolume, false);
  assert.equal(cross.requiresExplicitConfirmation, true);
  assert.equal(cross.readyForCommit, false);
  assert.match(cross.honestBoundary, /Cross-volume/);
  assert.equal(organization.relinkPlan(base, record.id, { canonicalPath: "D:\\Disposable Relink\\bad.txt", fileIdentity: { fileIndex: "x" } }).code, "UNSUPPORTED_MEDIA");
});

test("M3 batch relink requires explicit unique mappings", () => {
  const base = stateWithReplays(2);
  const ids = Object.keys(base.replaysById);
  const mappings = ids.map((id, index) => ({
    replayId: id,
    candidate: {
      canonicalPath: `D:\\Disposable Relink\\Mapped ${index}.mp4`,
      fileIdentity: { volumeSerial: "D-VOLUME", fileIndex: `new-${index}` },
      fileSize: 2000 + index,
      modifiedAt: NOW,
      isRegularFile: true,
    },
  }));
  const batch = organization.batchRelinkPlan(base, mappings);
  assert.equal(batch.ok, true);
  assert.equal(batch.count, 2);
  assert.equal(organization.batchRelinkPlan(base, [mappings[0], mappings[0]]).code, "DUPLICATE_RELINK_MAPPING");
});

test("M3 delete confirmation defaults to archive and recycle plans expose blocked and partial results", () => {
  const base = stateWithReplays(3);
  const ids = Object.keys(base.replaysById);
  base.replaysById[ids[1]].fileIdentity = null;
  base.replaysById[ids[2]].missingState = "missing";
  const model = organization.createDeleteConfirmationModel(base, ids, { now: NOW });
  assert.equal(model.ok, true);
  assert.equal(model.defaultAction, "archive");
  assert.equal(model.moveSourceToRecycleBin, false);
  assert.equal(model.items[0].exactPath, base.replaysById[ids[0]].canonicalPath);
  assert.equal(organization.createDeletePlan(base, model, { confirmed: true, confirmationId: "wrong" }).code, "DELETE_NOT_CONFIRMED");
  const archiveModel = organization.createArchiveRestoreConfirmationModel(base, ids.slice(0, 2), "archive", { now: NOW });
  assert.equal(archiveModel.requiresExplicitConfirmation, true);
  assert.equal(organization.createArchiveRestorePlan(base, archiveModel, {}).code, "LIFECYCLE_NOT_CONFIRMED");
  const archiveBatch = organization.createArchiveRestorePlan(base, archiveModel, {
    confirmed: true,
    confirmationId: archiveModel.confirmationId,
  });
  assert.equal(archiveBatch.ok, true);
  const restoreModel = organization.createArchiveRestoreConfirmationModel(archiveBatch.state, ids.slice(0, 2), "restore", { now: NOW });
  assert.equal(organization.createArchiveRestorePlan(archiveBatch.state, restoreModel, {
    confirmed: true,
    confirmationId: restoreModel.confirmationId,
  }).state.replaysById[ids[0]].archiveState, "active");
  const raced = JSON.parse(JSON.stringify(base));
  raced.replaysById[ids[0]].fileIdentity.fileIndex = "changed-after-modal";
  assert.equal(organization.createDeletePlan(raced, model, {
    confirmed: true,
    confirmationId: model.confirmationId,
    moveSourceToRecycleBin: true,
  }).code, "STALE_DELETE_CONFIRMATION");

  const archived = organization.createDeletePlan(base, model, { confirmed: true, confirmationId: model.confirmationId });
  assert.equal(archived.ok, true);
  assert.equal(archived.kind, "replay.delete-archive");
  assert.equal(ids.every((id) => archived.state.replaysById[id].archiveState === "archived"), true);

  const recycle = organization.createDeletePlan(base, model, {
    confirmed: true,
    confirmationId: model.confirmationId,
    moveSourceToRecycleBin: true,
  });
  assert.equal(recycle.readyCount, 1);
  assert.equal(recycle.blockedCount, 2);
  const aggregate = organization.aggregateItemResults(recycle.items, [{ replayId: ids[0], status: "success" }]);
  assert.deepEqual(aggregate.counts, { total: 3, success: 1, failed: 0, canceled: 0, skipped: 2 });
  assert.equal(aggregate.partial, true);
  const committed = organization.applyDeleteResults(base, recycle, aggregate.items);
  assert.equal(committed.ok, true);
  assert.equal(committed.state.replaysById[ids[0]].archiveState, "archived");
  assert.equal(committed.state.replaysById[ids[0]].missingState, "missing");
  assert.equal(committed.state.replaysById[ids[1]].archiveState, "active");
});

test("M3 metadata-only removal is limited to missing media and cleans collection order and usage", () => {
  let base = stateWithReplays(2);
  const ids = Object.keys(base.replaysById);
  base.replaysById[ids[0]].missingState = "missing";
  base.replaysById[ids[1]].missingState = "missing";
  const collection = createCollection(base, "Missing");
  const members = organization.planBatchReplayAction(collection.state, ids, {
    type: "collection",
    mode: "add",
    collectionIds: [collection.collection.id],
  });
  const ordered = organization.reorderCollectionReplaysPlan(members.state, collection.collection.id, ids);
  const used = organization.recordReplayUsagePlan(ordered.state, ids[0], "opened", { now: NOW });
  const model = organization.createDeleteConfirmationModel(used.state, ids, { now: NOW });
  assert.equal(model.metadataOnlyRemovalAvailable, true);
  const plan = organization.createDeletePlan(used.state, model, {
    confirmed: true,
    confirmationId: model.confirmationId,
    removeMetadataOnly: true,
  });
  assert.equal(plan.ok, true);
  const applied = organization.applyDeleteResults(used.state, plan, [
    { replayId: ids[0], status: "success" },
    { replayId: ids[1], status: "failed", code: "INJECTED" },
  ]);
  assert.equal(applied.ok, true);
  assert.equal(applied.state.replaysById[ids[0]], undefined);
  assert.ok(applied.state.replaysById[ids[1]]);
  assert.deepEqual(applied.state.collectionsById[collection.collection.id].manualOrder, [ids[1]]);
  assert.equal(applied.state.preferences.replayOrganization.usageByReplayId[ids[0]], undefined);
  assert.equal(applied.aggregate.partial, true);
  assert.deepEqual(schema.validateOracleState(applied.state), { ok: true, errors: [] });
});
