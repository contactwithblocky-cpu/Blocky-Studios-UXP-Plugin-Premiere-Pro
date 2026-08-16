// @ts-nocheck
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const presets = require("./src/curves/oracle-curve-presets.js");

const NOW = "2026-07-16T04:00:00.000Z";

function draft(name, points = [0.42, 0, 0.58, 1]) {
  return { name, cubicControlPoints: points };
}

test("built-in presets have the exact accepted names and are deeply immutable", () => {
  assert.deepEqual(presets.BUILTIN_CURVE_PRESETS.map((preset) => preset.name), [
    "Linear",
    "Ease In",
    "Ease Out",
    "Ease In Out",
    "Fast In Slow Out",
    "Slow In Fast Out",
    "Overshoot",
    "Back",
    "Anticipation",
    "Smooth Step",
    "Sharp Impact",
    "Soft Settle",
  ]);
  assert.equal(Object.isFrozen(presets.BUILTIN_CURVE_PRESETS), true);
  assert.equal(Object.isFrozen(presets.BUILTIN_CURVE_PRESETS[0]), true);
  assert.equal(Object.isFrozen(presets.BUILTIN_CURVE_PRESETS[0].cubicControlPoints), true);
  assert.ok(presets.BUILTIN_CURVE_PRESETS.every((preset) => preset.applyMode === "native-interpolation"));
  assert.throws(() => { presets.BUILTIN_CURVE_PRESETS[0].name = "Changed"; }, TypeError);
});

test("user preset normalization validates curves and bounds settings, tags, and identity", () => {
  const normalized = presets.normalizeUserPreset({
    id: "legacy unsafe id",
    name: "  Hero Move  ",
    cubicControlPoints: [0.2, -0.5, 0.8, 1.5],
    applyMode: "baked",
    sampleSettings: { budget: 10000, warningThreshold: -2, quantizationTicks: "00010" },
    tags: ["Action", "action", "  hero  ", ...Array.from({ length: 40 }, (_, index) => `tag-${index}`)],
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.match(normalized.id, /^[0-9a-f-]{36}$/);
  assert.equal(normalized.name, "Hero Move");
  assert.equal(normalized.applyMode, "baked-oracle-curve");
  assert.deepEqual(normalized.sampleSettings, { budget: 240, warningThreshold: 1, quantizationTicks: "10" });
  assert.equal(normalized.tags.length, presets.MAX_TAGS_PER_PRESET);
  assert.deepEqual(normalized.tags.slice(0, 2), ["Action", "hero"]);
  assert.equal(presets.normalizeUserPreset(draft("Broken", [-1, 0, 1, 1])), null);
  assert.equal(presets.normalizeUserPreset(draft("Unbounded", [0, -9, 1, 1])), null);
});

test("CRUD is copy-on-write, confirms destructive operations, and preserves ordering", () => {
  const empty = presets.createEmptyPresetLibrary();
  const first = presets.createUserPreset(empty, draft("First"), { now: NOW });
  assert.equal(first.ok, true);
  assert.equal(empty.presets.length, 0);
  const firstId = first.preset.id;
  const second = presets.createUserPreset(first.library, draft("Second", [0, 0, 0.58, 1]), { now: NOW });
  assert.equal(first.library.presets.length, 1);
  assert.equal(second.library.presets.length, 2);
  assert.equal(presets.createUserPreset(second.library, draft("second"), { now: NOW }).code, "DUPLICATE_NAME");

  const unconfirmed = presets.overwriteUserPreset(second.library, firstId, { cubicControlPoints: [0, 0, 1, 1] }, { now: NOW });
  assert.equal(unconfirmed.code, "CONFIRMATION_REQUIRED");
  const overwritten = presets.overwriteUserPreset(
    second.library,
    firstId,
    { cubicControlPoints: [0, 0, 1, 1] },
    { now: NOW, confirmed: true },
  );
  assert.deepEqual(overwritten.preset.cubicControlPoints, [0, 0, 1, 1]);

  const renamed = presets.renameUserPreset(overwritten.library, firstId, "Opening", { now: NOW });
  assert.equal(renamed.preset.name, "Opening");
  const duplicated = presets.duplicateUserPreset(renamed.library, firstId, { now: NOW, name: "Opening Alt" });
  assert.equal(duplicated.ok, true);
  assert.notEqual(duplicated.preset.id, firstId);
  const copiedBuiltIn = presets.copyPresetToUser(
    duplicated.library,
    presets.BUILTIN_CURVE_PRESETS[1].id,
    { now: NOW, name: "Ease In Copy" },
  );
  assert.equal(copiedBuiltIn.ok, true);
  assert.equal(copiedBuiltIn.preset.applyMode, "native-interpolation");
  assert.deepEqual(copiedBuiltIn.preset.cubicControlPoints, presets.BUILTIN_CURVE_PRESETS[1].cubicControlPoints);
  const reordered = presets.reorderUserPreset(copiedBuiltIn.library, duplicated.preset.id, 0, { now: NOW });
  assert.equal(reordered.library.presets[0].id, duplicated.preset.id);
  assert.deepEqual(reordered.library.presets.map((preset) => preset.manualOrder), [0, 1, 2, 3]);

  assert.equal(presets.deleteUserPreset(reordered.library, firstId, { now: NOW }).code, "CONFIRMATION_REQUIRED");
  const deleted = presets.deleteUserPreset(reordered.library, firstId, { now: NOW, confirmed: true });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.library.presets.some((preset) => preset.id === firstId), false);
});

test("favorites keep built-ins immutable and user tags remain bounded", () => {
  const created = presets.createUserPreset(presets.createEmptyPresetLibrary(), draft("Tagged"), { now: NOW });
  const builtInId = presets.BUILTIN_CURVE_PRESETS[1].id;
  const favoriteBuiltIn = presets.setPresetFavorite(created.library, builtInId, true, { now: NOW });
  assert.equal(favoriteBuiltIn.ok, true);
  assert.deepEqual(favoriteBuiltIn.library.builtInFavorites, [builtInId]);
  assert.equal(Object.prototype.hasOwnProperty.call(presets.BUILTIN_CURVE_PRESETS[1], "favorite"), false);
  const favoriteUser = presets.setPresetFavorite(favoriteBuiltIn.library, created.preset.id, true, { now: NOW });
  assert.equal(favoriteUser.preset.favorite, true);
  const tagged = presets.setUserPresetTags(favoriteUser.library, created.preset.id, ["Hero", "hero", "Impact"], { now: NOW });
  assert.deepEqual(tagged.preset.tags, ["Hero", "Impact"]);
});

test("folder operations assign, reorder, and safely unfile presets on confirmed delete", () => {
  let result = presets.createUserPreset(presets.createEmptyPresetLibrary(), draft("Move"), { now: NOW });
  const presetId = result.preset.id;
  const action = presets.createFolder(result.library, "Action", { now: NOW });
  const settle = presets.createFolder(action.library, "Settle", { now: NOW });
  const assigned = presets.assignPresetFolder(settle.library, presetId, action.folder.id, { now: NOW });
  assert.equal(assigned.preset.folderId, action.folder.id);
  const reordered = presets.reorderFolders(assigned.library, [settle.folder.id, action.folder.id], { now: NOW });
  assert.deepEqual(reordered.library.folders.map((folder) => folder.name), ["Settle", "Action"]);
  assert.equal(presets.deleteFolder(reordered.library, action.folder.id, { now: NOW }).code, "CONFIRMATION_REQUIRED");
  const deleted = presets.deleteFolder(reordered.library, action.folder.id, { now: NOW, confirmed: true });
  assert.equal(deleted.library.presets[0].folderId, null);
});

test("user preset organization updates tags and folder in one bounded library revision", () => {
  const created = presets.createUserPreset(presets.createEmptyPresetLibrary(), draft("Organize"), { now: NOW });
  const folder = presets.createFolder(created.library, "Action", { now: NOW });
  const beforeRevision = folder.library.revision;
  const organized = presets.updateUserPresetOrganization(folder.library, created.preset.id, {
    folderId: folder.folder.id,
    tags: ["Hero", "hero", "Impact"],
  }, { now: NOW });
  assert.equal(organized.ok, true);
  assert.equal(organized.library.revision, beforeRevision + 1);
  assert.equal(organized.preset.folderId, folder.folder.id);
  assert.deepEqual(organized.preset.tags, ["Hero", "Impact"]);
  assert.equal(presets.updateUserPresetOrganization(folder.library, created.preset.id, { folderId: "folder:missing" }).code, "FOLDER_NOT_FOUND");
});

test("search keeps Built-in/User groups distinct and returns generated path thumbnails", () => {
  let result = presets.createUserPreset(
    presets.createEmptyPresetLibrary(),
    { ...draft("Hero Impact"), tags: ["Impact", "Hero"], favorite: true },
    { now: NOW },
  );
  const found = presets.searchPresets(result.library, "impact", { tab: "all" });
  assert.ok(found.builtIns.some((preset) => preset.name === "Sharp Impact"));
  assert.deepEqual(found.users.map((preset) => preset.name), ["Hero Impact"]);
  assert.equal(found.users[0].thumbnail.kind, "path-data");
  assert.match(found.users[0].thumbnail.pathData, /^M\d/);
  assert.doesNotMatch(JSON.stringify(found.users[0].thumbnail), /base64|blob:/i);
  const usersOnly = presets.searchPresets(result.library, "", { tab: "user", favoritesOnly: true, tags: ["hero"] });
  assert.equal(usersOnly.builtIns.length, 0);
  assert.deepEqual(usersOnly.users.map((preset) => preset.name), ["Hero Impact"]);
});

test("legacy preset documents migrate to the current version", () => {
  const legacy = [{
    id: "old-ease",
    title: "Legacy Ease",
    controlPoints: [0.1, 0, 0.9, 1],
    applyMode: "native",
    tags: ["Legacy"],
  }];
  const migrated = presets.migratePresetDocument(legacy);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.fromVersion, 0);
  assert.equal(migrated.migrated, true);
  const library = presets.normalizePresetLibrary(migrated.document);
  assert.equal(library.version, presets.PRESET_LIBRARY_VERSION);
  assert.equal(library.presets[0].name, "Legacy Ease");
  assert.deepEqual(library.presets[0].cubicControlPoints, [0.1, 0, 0.9, 1]);

  const imported = presets.importPresetLibrary(JSON.stringify(legacy), presets.createEmptyPresetLibrary(), { now: NOW });
  assert.equal(imported.ok, true);
  assert.equal(imported.importedCount, 1);
  assert.equal(imported.fromVersion, 0);

  const applicationStateImport = presets.importPresetLibrary({
    schema: "com.blocky.oracle.state",
    version: 3,
    replaysById: {},
    preferences: {},
    curvePresetsById: {
      [library.presets[0].id]: library.presets[0],
    },
  }, presets.createEmptyPresetLibrary(), { now: NOW });
  assert.equal(applicationStateImport.ok, true);
  assert.equal(applicationStateImport.importedCount, 1);
});

test("versioned JSON export is deterministic, excludes generated thumbnails, and rejects Premiere preset formats", () => {
  const created = presets.createUserPreset(presets.createEmptyPresetLibrary(), draft("Export Me"), { now: NOW });
  const first = presets.exportPresetLibrary(created.library, { now: NOW, filename: "curves.json" });
  const second = presets.exportPresetLibrary(created.library, { now: NOW, filename: "curves.json" });
  assert.equal(first.ok, true);
  assert.equal(first.text, second.text);
  const document = JSON.parse(first.text);
  assert.equal(document.schema, presets.PRESET_LIBRARY_SCHEMA);
  assert.equal(document.version, presets.PRESET_LIBRARY_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(document.presets[0], "thumbnail"), false);
  assert.doesNotMatch(first.text, /pathData|base64|blob:/i);
  assert.equal(presets.exportPresetLibrary(created.library, { filename: "curves.prfpset" }).code, "UNSUPPORTED_FORMAT");
  assert.equal(presets.importPresetLibrary("{}", created.library, { filename: "curves.prfpset" }).code, "UNSUPPORTED_FORMAT");
});

test("import merge never overwrites colliding user presets and replace is explicit", () => {
  const base = presets.createUserPreset(presets.createEmptyPresetLibrary(), draft("Base"), { now: NOW });
  const collision = {
    ...base.library.presets[0],
    name: "Imported Different",
    cubicControlPoints: [0, 0, 1, 1],
  };
  const exported = presets.serializePresetLibrary({
    ...presets.createEmptyPresetLibrary(),
    presets: [collision],
  }, { now: NOW });
  const merged = presets.importPresetLibrary(exported, base.library, { now: NOW });
  assert.equal(merged.ok, true);
  assert.equal(merged.importedCount, 1);
  assert.equal(merged.library.presets.length, 2);
  assert.notEqual(merged.library.presets[0].id, merged.library.presets[1].id);
  assert.equal(merged.library.presets.find((preset) => preset.id === base.preset.id).name, "Base");

  const replaced = presets.importPresetLibrary(exported, base.library, { now: NOW, strategy: "replace" });
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.library.presets.map((preset) => preset.name), ["Imported Different"]);
  const future = presets.importPresetLibrary(JSON.stringify({
    schema: presets.PRESET_LIBRARY_SCHEMA,
    version: presets.PRESET_LIBRARY_VERSION + 1,
    presets: [],
  }), base.library, { now: NOW });
  assert.equal(future.code, "UNSUPPORTED_VERSION");
  const refusedMutation = presets.createUserPreset({
    schema: presets.PRESET_LIBRARY_SCHEMA,
    version: presets.PRESET_LIBRARY_VERSION + 1,
    presets: [base.preset],
  }, draft("Must Not Replace"), { now: NOW });
  assert.equal(refusedMutation.code, "UNSUPPORTED_VERSION");
});

test("preset JSON limits use true UTF-8 bytes and expose a fail-closed file preflight", () => {
  assert.equal(presets.MAX_IMPORT_BYTES, 1000000);
  assert.equal(presets.utf8ByteLength("Aé😀"), 7);
  assert.deepEqual(presets.validatePresetImportByteLength(999999), { ok: true, byteLength: 999999 });
  assert.equal(presets.validatePresetImportByteLength(undefined).code, "IMPORT_SIZE_UNVERIFIED");
  assert.equal(presets.validatePresetImportByteLength(1000001).code, "IMPORT_TOO_LARGE");

  const multiByteSource = "é".repeat(500001);
  assert.ok(multiByteSource.length < presets.MAX_IMPORT_BYTES);
  const refused = presets.importPresetLibrary(multiByteSource, presets.createEmptyPresetLibrary());
  assert.equal(refused.code, "IMPORT_TOO_LARGE");
  assert.equal(refused.byteLength > presets.MAX_IMPORT_BYTES, true);
});
