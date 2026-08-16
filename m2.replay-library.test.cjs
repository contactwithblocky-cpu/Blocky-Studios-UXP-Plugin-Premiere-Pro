"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const test = require("node:test");

const schema = require("./src/data/oracle-data-schema.js");
const migrations = require("./src/data/oracle-migrations.js");
const library = require("./src/replays/oracle-replay-library.js");

function syntheticJpegBase64(width = 640, height = 360, marker = 0xc0) {
  const bytes = Buffer.from([
    0xff, 0xd8,
    0xff, marker, 0x00, 0x0b,
    0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01,
    0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return bytes.toString("base64");
}

const VALID_JPEG_BASE64 = syntheticJpegBase64();
const VALID_JPEG_BYTES = Buffer.from(VALID_JPEG_BASE64, "base64").byteLength;
const MISSING_SOF_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const TRUNCATED_SOF_JPEG_BASE64 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01,
  0xff, 0xd9,
]).toString("base64");

function passthroughThumbnailEncoder(request) {
  request.signal.throwIfCancelled();
  return request.bytes;
}

function replayMessage(overrides = {}) {
  return {
    type: "IMPORT_CLIP",
    schema: library.BRIDGE_EVENT_SCHEMA,
    version: library.BRIDGE_EVENT_VERSION,
    payload: {
      eventId: "export-17",
      absolutePath: "D:\\Blocky Studios Exports\\Unicode 雪\\Hero Orbit.mp4",
      fileName: "Hero Orbit.mp4",
      timestamp: "2026-07-15T18:00:00.000Z",
      durationMs: 12080,
      width: 3840,
      height: 2160,
      fps: 60,
      fileSize: 123456789,
      modifiedAt: "2026-07-15T18:00:01.000Z",
      fileIdentity: { volumeSerial: "ABCD", fileIndex: "1234" },
      thumbnailPosition: 0.5,
      thumbnailWidth: 640,
      thumbnailHeight: 360,
      thumbnailBase64: VALID_JPEG_BASE64,
      ...overrides,
    },
  };
}

class MemoryFs {
  constructor() {
    this.files = new Map();
    this.failRename = null;
  }

  async readFile(url) {
    if (!this.files.has(url)) throw Object.assign(new Error("ENOENT not found"), { code: "ENOENT" });
    return this.files.get(url);
  }

  async writeFile(url, value) {
    this.files.set(url, value instanceof Uint8Array ? new Uint8Array(value) : String(value));
  }

  async rename(source, destination) {
    if (this.failRename && this.failRename(source, destination)) {
      throw new Error("injected rename failure");
    }
    if (!this.files.has(source)) throw Object.assign(new Error("ENOENT not found"), { code: "ENOENT" });
    const value = this.files.get(source);
    this.files.delete(source);
    this.files.set(destination, value);
  }

  async unlink(url) {
    if (!this.files.has(url)) throw Object.assign(new Error("ENOENT not found"), { code: "ENOENT" });
    this.files.delete(url);
  }
}

class AuditedMemoryFs extends MemoryFs {
  constructor() {
    super();
    this.mutations = [];
  }

  async writeFile(url, value) {
    this.mutations.push({ operation: "writeFile", url });
    return super.writeFile(url, value);
  }

  async rename(source, destination) {
    this.mutations.push({ operation: "rename", source, destination });
    return super.rename(source, destination);
  }

  async unlink(url) {
    this.mutations.push({ operation: "unlink", url });
    return super.unlink(url);
  }
}

test("M2 bridge ingest accepts valid local/UNC Unicode media and rejects unsafe paths and versions", () => {
  const valid = library.normalizeBridgeReplay(replayMessage());
  assert.equal(valid.ok, true);
  assert.equal(valid.protocol, 2);
  assert.equal(valid.record.canonicalPath, "D:\\Blocky Studios Exports\\Unicode 雪\\Hero Orbit.mp4");
  assert.equal(valid.record.durationMs, 12080);
  assert.equal(valid.record.fileSize, 123456789);
  assert.deepEqual(valid.record.fileIdentity, { fileIndex: "1234", volumeSerial: "ABCD" });
  assert.equal(valid.record.legacy.resolution, "3840 × 2160");
  assert.equal(valid.record.legacy.fps, 60);
  assert.equal(valid.record.legacy.thumbnailPosition, 0.5);
  assert.equal(valid.record.legacy.thumbnailWidth, 640);
  assert.equal(valid.record.legacy.thumbnailHeight, 360);

  const unc = library.normalizeBridgeReplay(replayMessage({
    eventId: "unc",
    absolutePath: "\\\\render-server\\oracle share\\long path\\clip.mov",
  }));
  assert.equal(unc.ok, true);

  for (const [path, code] of [
    ["renders\\relative.mp4", "INVALID_PATH"],
    ["D:\\renders\\..\\secret.mp4", "INVALID_PATH"],
    ["D:\\renders\\clip.mp4:secret", "INVALID_PATH"],
    ["\\\\.\\PhysicalDrive0", "INVALID_PATH"],
    ["D:\\renders\\notes.txt", "UNSUPPORTED_MEDIA"],
  ]) {
    const result = library.normalizeBridgeReplay(replayMessage({ absolutePath: path }));
    assert.equal(result.ok, false, path);
    assert.equal(result.code, code, path);
  }
  assert.equal(library.normalizeBridgeReplay({ ...replayMessage(), version: 99 }).ok, false);
  assert.equal(library.normalizeBridgeReplay({ ...replayMessage(), schema: "wrong" }).ok, false);
});

test("v1 compatibility is explicit and malformed thumbnail data cannot enter v3 state", () => {
  const legacy = replayMessage({ thumbnailBase64: "not-image-data" });
  delete legacy.schema;
  delete legacy.version;
  const result = library.normalizeBridgeReplay(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.legacyProtocol, true);
  assert.equal(result.thumbnailBase64, "");
  assert.match(result.thumbnailError, /Invalid JPEG/);
  const serialized = JSON.stringify(result.record);
  assert.doesNotMatch(serialized, /not-image-data|thumbnailBase64|data:image/);
});

test("versioned replay metadata export deep-clones valid v3 state and excludes live-only thumbnail payloads", () => {
  const store = new library.ReplayLibraryStore();
  const ingested = store.ingest(replayMessage());
  store.updateById(ingested.record.id, {
    favorite: true,
    tags: ["hero"],
    notes: "Preserve metadata",
  }, { domain: true });
  store.state.preferences.metadataProbe = {
    thumbnailBase64: VALID_JPEG_BASE64,
    thumbnail_data_url: `data:image/jpeg;base64,${VALID_JPEG_BASE64}`,
    retained: "yes",
  };

  const exported = library.createReplayMetadataExport(store.state, {
    pluginVersion: "2.0.15",
    exportedAt: "2026-07-16T15:30:00.000Z",
  });
  assert.equal(exported.schema, library.REPLAY_METADATA_EXPORT_SCHEMA);
  assert.equal(exported.version, library.REPLAY_METADATA_EXPORT_VERSION);
  assert.equal(exported.pluginVersion, "2.0.15");
  assert.equal(exported.exportedAt, "2026-07-16T15:30:00.000Z");
  assert.deepEqual(schema.validateOracleState(exported.state), { ok: true, errors: [] });
  assert.equal(exported.state.preferences.metadataProbe.retained, "yes");
  assert.equal(Object.hasOwn(exported.state.preferences.metadataProbe, "thumbnailBase64"), false);
  assert.equal(Object.hasOwn(exported.state.preferences.metadataProbe, "thumbnail_data_url"), false);
  assert.doesNotMatch(JSON.stringify(exported), new RegExp(VALID_JPEG_BASE64));
  assert.equal(store.state.preferences.metadataProbe.thumbnailBase64, VALID_JPEG_BASE64, "export must not mutate live state");

  exported.state.preferences.metadataProbe.retained = "changed";
  exported.state.replaysById[ingested.record.id].notes = "changed";
  assert.equal(store.state.preferences.metadataProbe.retained, "yes");
  assert.equal(store.state.replaysById[ingested.record.id].notes, "Preserve metadata");

  assert.throws(
    () => library.createReplayMetadataExport({ schema: schema.ORACLE_STATE_SCHEMA, version: 3 }),
    (error) => error && error.code === "INVALID_METADATA_STATE",
  );
  assert.throws(
    () => library.createReplayMetadataExport(store.state, { exportedAt: "not-a-date" }),
    (error) => error && error.code === "INVALID_METADATA_EXPORTED_AT",
  );
});

test("metadata export recursively strips raw thumbnail and image aliases without mutating permissive v3 fields", () => {
  const state = schema.createEmptyOracleState({
    writtenAt: "2026-07-16T15:30:00.000Z",
    writerId: "m2-adversarial-export",
  });
  state.preferences.payloadProbe = {
    retained: { theme: "minecraft" },
    thumbnailBytes: [0xff, 0xd8, 0xff, 0xd9],
    imageData: VALID_JPEG_BASE64,
    thumbData: "AQIDBA==",
    thumbnailDataUrl: `data:image/jpeg;base64,${VALID_JPEG_BASE64}`,
    nested: {
      thumbnail: VALID_JPEG_BASE64,
      image: { mimeType: "image/jpeg", data: [0xff, 0xd8, 0xff, 0xd9] },
      harmlessThumbnail: {
        cacheKey: "thumbnail-cache-key",
        width: 640,
        height: 360,
      },
    },
  };
  const before = JSON.parse(JSON.stringify(state));

  const exported = library.createReplayMetadataExport(state, {
    pluginVersion: "2.0.15",
    exportedAt: "2026-07-16T15:31:00.000Z",
  });
  const probe = exported.state.preferences.payloadProbe;
  assert.deepEqual(probe.retained, { theme: "minecraft" });
  assert.deepEqual(probe.nested.harmlessThumbnail, {
    cacheKey: "thumbnail-cache-key",
    width: 640,
    height: 360,
  });
  assert.equal(Object.hasOwn(probe, "thumbnailBytes"), false);
  assert.equal(Object.hasOwn(probe, "imageData"), false);
  assert.equal(Object.hasOwn(probe, "thumbData"), false);
  assert.equal(Object.hasOwn(probe, "thumbnailDataUrl"), false);
  assert.equal(Object.hasOwn(probe.nested, "thumbnail"), false);
  assert.deepEqual(probe.nested.image, { mimeType: "image/jpeg" });
  assert.doesNotMatch(JSON.stringify(exported), /data:image|\/9j\/|255,216,255,217/);
  assert.deepEqual(state, before, "sanitizing an export must not mutate the live v3 state");
});

test("replay metadata import preserves current v3 snapshots and completely migrates supported legacy state", () => {
  const store = new library.ReplayLibraryStore();
  const ingested = store.ingest(replayMessage({ thumbnailBase64: "" }));
  store.updateById(ingested.record.id, { favorite: true, rating: 4 }, { domain: true });
  const envelope = library.createReplayMetadataExport(store.state, {
    pluginVersion: "2.0.15",
    exportedAt: "2026-07-16T15:30:00.000Z",
  });
  const current = library.normalizeReplayMetadataImport(envelope);
  assert.equal(current.ok, true);
  assert.equal(current.migrated, false);
  assert.deepEqual(current.diagnostics, []);
  assert.deepEqual(current.state, envelope.state);
  assert.notEqual(current.state, envelope.state);
  current.state.replaysById[ingested.record.id].rating = 1;
  assert.equal(envelope.state.replaysById[ingested.record.id].rating, 4, "import result must not alias the envelope");

  const legacyState = {
    version: 2,
    savedAt: "2026-07-15T18:00:00.000Z",
    replays: [{
      id: "legacy-hero",
      absolutePath: "D:\\Blocky Studios Exports\\Legacy Hero.mp4",
      title: "Legacy Hero",
      durationSeconds: 12.08,
      exportedAt: "2026-07-15T18:00:00.000Z",
      tags: ["hero"],
      favorite: true,
      rating: 5,
    }],
  };
  const legacyBefore = JSON.parse(JSON.stringify(legacyState));
  const migrated = library.normalizeReplayMetadataImport({
    schema: library.REPLAY_METADATA_EXPORT_SCHEMA,
    version: library.REPLAY_METADATA_EXPORT_VERSION,
    pluginVersion: "1.9.0",
    exportedAt: "2026-07-16T15:30:00.000Z",
    state: legacyState,
  }, { writerId: "m2-metadata-import" });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migrated, true);
  assert.deepEqual(migrated.diagnostics.map((entry) => entry.code), ["LEGACY_STATE_MIGRATED"]);
  assert.deepEqual(schema.validateOracleState(migrated.state), { ok: true, errors: [] });
  assert.equal(migrated.state.writerId, "m2-metadata-import");
  assert.equal(Object.values(migrated.state.replaysById)[0].displayNameOverride, "Legacy Hero");
  assert.equal(Object.values(migrated.state.replaysById)[0].durationMs, 12080);
  assert.deepEqual(legacyState, legacyBefore, "migration must not mutate the imported envelope");

  const fromJson = library.normalizeReplayMetadataImport(JSON.stringify(envelope));
  assert.equal(fromJson.ok, true);
  assert.deepEqual(fromJson.state, envelope.state);
});

test("replay metadata import rejects malformed, unsupported, incomplete, and lossy envelopes", () => {
  const validState = schema.createEmptyOracleState({
    writtenAt: "2026-07-16T15:30:00.000Z",
    writerId: "m2-envelope",
  });
  const base = {
    schema: library.REPLAY_METADATA_EXPORT_SCHEMA,
    version: library.REPLAY_METADATA_EXPORT_VERSION,
    pluginVersion: "2.0.15",
    exportedAt: "2026-07-16T15:30:00.000Z",
    state: validState,
  };
  for (const [payload, code] of [
    [null, "MALFORMED_METADATA_EXPORT"],
    ["{broken-json", "MALFORMED_METADATA_EXPORT"],
    [{ ...base, schema: "wrong" }, "UNSUPPORTED_METADATA_SCHEMA"],
    [{ ...base, version: 99 }, "UNSUPPORTED_METADATA_VERSION"],
    [{ ...base, pluginVersion: "" }, "MALFORMED_METADATA_EXPORT"],
    [{ ...base, exportedAt: "yesterday" }, "MALFORMED_METADATA_EXPORT"],
    [Object.fromEntries(Object.entries(base).filter(([key]) => key !== "state")), "MALFORMED_METADATA_EXPORT"],
    [{ ...base, state: { schema: schema.ORACLE_STATE_SCHEMA, version: 99 } }, "INVALID_METADATA_STATE"],
    [{ ...base, state: { ...validState, revision: -1 } }, "INVALID_METADATA_STATE"],
  ]) {
    const result = library.normalizeReplayMetadataImport(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.code, code, JSON.stringify(payload));
  }

  const incomplete = library.normalizeReplayMetadataImport({
    ...base,
    state: {
      version: 2,
      savedAt: "2026-07-15T18:00:00.000Z",
      replays: [
        { absolutePath: "D:\\Blocky Studios Exports\\Good.mp4" },
        { id: "missing-path", title: "Cannot migrate" },
      ],
    },
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, "LOSSY_METADATA_IMPORT");
  assert.ok(incomplete.diagnostics.some((entry) => entry.code === "REPLAY_SKIPPED"));

  const rawThumbnail = library.normalizeReplayMetadataImport({
    ...base,
    state: {
      version: 2,
      savedAt: "2026-07-15T18:00:00.000Z",
      replays: [{
        absolutePath: "D:\\Blocky Studios Exports\\Raw Thumbnail.mp4",
        thumbnailBase64: VALID_JPEG_BASE64,
      }],
    },
  });
  assert.equal(rawThumbnail.ok, false);
  assert.equal(rawThumbnail.code, "LOSSY_METADATA_IMPORT");
  assert.deepEqual(rawThumbnail.diagnostics.map((entry) => entry.code), ["RAW_THUMBNAIL_DROPPED"]);
});

test("metadata import rejects recursive raw image aliases with the exact offending path", () => {
  const validState = schema.createEmptyOracleState({
    writtenAt: "2026-07-16T15:30:00.000Z",
    writerId: "m2-adversarial-import",
  });
  const base = {
    schema: library.REPLAY_METADATA_EXPORT_SCHEMA,
    version: library.REPLAY_METADATA_EXPORT_VERSION,
    pluginVersion: "2.0.15",
    exportedAt: "2026-07-16T15:30:00.000Z",
  };
  const attacks = [
    ["thumbnailBytes", [0xff, 0xd8, 0xff, 0xd9]],
    ["imageData", VALID_JPEG_BASE64],
    ["thumbnail", `data:image/jpeg;base64,${VALID_JPEG_BASE64}`],
    ["thumbnail", VALID_JPEG_BASE64],
    ["thumbnail", "AQIDBA=="],
    ["thumbnail", [0xff, 0xd8, 0xff, 0xd9]],
  ];

  for (const [field, value] of attacks) {
    const state = JSON.parse(JSON.stringify(validState));
    state.preferences.deep = { payload: { [field]: value } };
    const result = library.normalizeReplayMetadataImport({ ...base, state });
    assert.equal(result.ok, false, field);
    assert.equal(result.code, "LOSSY_METADATA_IMPORT", field);
    assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["RAW_THUMBNAIL_DROPPED"], field);
    assert.equal(
      result.diagnostics[0].path,
      `$.state.preferences.deep.payload.${field}`,
      field,
    );
    assert.match(result.diagnostics[0].message, new RegExp(`\\$\\.state\\.preferences\\.deep\\.payload\\.${field}`));
  }

  const imageContainer = JSON.parse(JSON.stringify(validState));
  imageContainer.quickApplyState.preview = {
    mimeType: "image/jpeg",
    data: { type: "Buffer", data: [0xff, 0xd8, 0xff, 0xd9] },
  };
  const nested = library.normalizeReplayMetadataImport({ ...base, state: imageContainer });
  assert.equal(nested.ok, false);
  assert.equal(nested.code, "LOSSY_METADATA_IMPORT");
  assert.equal(nested.diagnostics[0].path, "$.state.quickApplyState.preview.data");

  const topLevel = library.normalizeReplayMetadataImport({
    ...base,
    state: validState,
    thumbnailBytes: [0xff, 0xd8, 0xff, 0xd9],
  });
  assert.equal(topLevel.ok, false);
  assert.equal(topLevel.code, "LOSSY_METADATA_IMPORT");
  assert.equal(topLevel.diagnostics[0].path, "$.thumbnailBytes");

  const replayStore = new library.ReplayLibraryStore();
  const replay = replayStore.ingest(replayMessage({ thumbnailBase64: "" })).record;
  const permissiveReplayState = JSON.parse(JSON.stringify(replayStore.state));
  permissiveReplayState.replaysById[replay.id].imageData = VALID_JPEG_BASE64;
  assert.deepEqual(schema.validateOracleState(permissiveReplayState), { ok: true, errors: [] });
  const replayField = library.normalizeReplayMetadataImport({ ...base, state: permissiveReplayState });
  assert.equal(replayField.ok, false);
  assert.equal(
    replayField.diagnostics[0].path,
    `$.state.replaysById[${JSON.stringify(replay.id)}].imageData`,
  );
});

test("metadata import rejects executable and non-replay paths but accepts every supported replay extension", () => {
  const base = {
    schema: library.REPLAY_METADATA_EXPORT_SCHEMA,
    version: library.REPLAY_METADATA_EXPORT_VERSION,
    pluginVersion: "2.0.15",
    exportedAt: "2026-07-16T15:30:00.000Z",
  };
  const store = new library.ReplayLibraryStore();
  const ingested = store.ingest(replayMessage({ thumbnailBase64: "" }));
  const malicious = JSON.parse(JSON.stringify(store.state));
  malicious.replaysById[ingested.record.id].canonicalPath = "C:\\Windows\\System32\\cmd.exe";
  malicious.replaysById[ingested.record.id].pathKey = schema.replayPathKey("C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(schema.validateOracleState(malicious), { ok: true, errors: [] }, "the envelope boundary owns extension validation");
  const currentResult = library.normalizeReplayMetadataImport({ ...base, state: malicious });
  assert.equal(currentResult.ok, false);
  assert.equal(currentResult.code, "UNSUPPORTED_METADATA_MEDIA");
  assert.deepEqual(currentResult.diagnostics.map((entry) => entry.code), ["UNSUPPORTED_REPLAY_MEDIA"]);
  assert.equal(
    currentResult.diagnostics[0].path,
    `$.state.replaysById[${JSON.stringify(ingested.record.id)}].canonicalPath`,
  );

  for (const path of [
    "D:\\Blocky Studios Exports\\notes.txt",
    "D:\\Blocky Studios Exports\\script.cmd",
    "D:\\Blocky Studios Exports\\clip.mp4.exe",
  ]) {
    const result = library.normalizeReplayMetadataImport({
      ...base,
      state: {
        version: 2,
        savedAt: "2026-07-15T18:00:00.000Z",
        replays: [{ absolutePath: path }],
      },
    });
    assert.equal(result.ok, false, path);
    assert.equal(result.code, "UNSUPPORTED_METADATA_MEDIA", path);
    assert.equal(result.diagnostics[0].code, "UNSUPPORTED_REPLAY_MEDIA", path);
    assert.match(result.diagnostics[0].path, /^\$\.state\.replaysById\[/, path);
  }

  for (const [index, extension] of Array.from(library.SUPPORTED_MEDIA_EXTENSIONS).entries()) {
    const path = index === 0
      ? `\\\\render-server\\oracle share\\Replay-${index}${extension.toUpperCase()}`
      : `D:\\Blocky Studios Exports\\Replay-${index}${extension.toUpperCase()}`;
    const result = library.normalizeReplayMetadataImport({
      ...base,
      state: {
        version: 2,
        savedAt: "2026-07-15T18:00:00.000Z",
        replays: [{
          id: `positive-${index}`,
          absolutePath: path,
          exportedAt: "2026-07-15T18:00:00.000Z",
        }],
      },
    });
    assert.equal(result.ok, true, path);
    assert.equal(result.migrated, true, path);
    assert.equal(Object.values(result.state.replaysById)[0].canonicalPath, path, path);
  }
});

test("ReplayLibraryStore uses immutable v3 records and deduplicates stable events and physical identity", () => {
  const changes = [];
  const store = new library.ReplayLibraryStore({
    now: () => "2026-07-15T18:00:02.000Z",
    onChange: (items, change) => changes.push({ count: items.length, type: change.type }),
  });
  const first = store.ingest(replayMessage());
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(schema.isUuid(first.record.id), true);
  assert.equal(store.items.length, 1);
  assert.equal(store.consumeThumbnail(first.record.id), VALID_JPEG_BASE64);
  assert.equal(store.consumeThumbnail(first.record.id), "");
  assert.equal(JSON.stringify(store.state).includes(VALID_JPEG_BASE64), false);
  assert.deepEqual(schema.validateOracleState(store.state), { ok: true, errors: [] });

  const repeated = store.ingest(replayMessage());
  assert.equal(repeated.duplicate, true);
  assert.equal(store.items.length, 1);

  const sameFileNewEvent = store.ingest(replayMessage({ eventId: "delivery-duplicate" }));
  assert.equal(sameFileNewEvent.duplicate, true);
  assert.equal(store.items.length, 1);

  const overwritten = store.ingest(replayMessage({
    eventId: "export-18",
    modifiedAt: "2026-07-15T18:05:00.000Z",
    fileSize: 123456790,
    fileIdentity: null,
  }));
  assert.equal(overwritten.duplicate, false);
  assert.equal(store.items.length, 2);
  assert.ok(changes.some((entry) => entry.type === "upsert"));
});

test("same canonical path and stable file identity converge across later size and mtime observations", () => {
  const store = new library.ReplayLibraryStore();
  const first = store.ingest(replayMessage({
    eventId: "stable-identity-first",
    fileSize: 1024,
    modifiedAt: "2026-07-15T18:00:01.000Z",
    fileIdentity: { volumeSerial: "ABCD", fileIndex: "1234" },
    thumbnailBase64: "",
  }));
  const laterEvent = store.ingest(replayMessage({
    eventId: "stable-identity-later",
    fileSize: 4096,
    modifiedAt: "2026-07-15T18:00:04.000Z",
    fileIdentity: { fileIndex: "1234", volumeSerial: "ABCD" },
    thumbnailBase64: "",
  }));
  assert.equal(laterEvent.ok, true);
  assert.equal(laterEvent.duplicate, true);
  assert.equal(laterEvent.record.id, first.record.id);
  assert.equal(store.items.length, 1);
  assert.equal(store.getRecord(first.record.id).fileSize, 4096);
  assert.equal(store.getRecord(first.record.id).modifiedAt, "2026-07-15T18:00:04.000Z");

  const repeatedEvent = store.ingest(replayMessage({
    eventId: "stable-identity-later",
    fileSize: 8192,
    modifiedAt: "2026-07-15T18:00:08.000Z",
    fileIdentity: { volumeSerial: "ABCD", fileIndex: "1234" },
    thumbnailBase64: "",
  }));
  assert.equal(repeatedEvent.ok, true);
  assert.equal(repeatedEvent.duplicate, true);
  assert.equal(repeatedEvent.record.id, first.record.id);
  assert.equal(store.items.length, 1);
  assert.equal(store.getRecord(first.record.id).fileSize, 8192);
  assert.equal(store.getRecord(first.record.id).modifiedAt, "2026-07-15T18:00:08.000Z");

  const restarted = new library.ReplayLibraryStore();
  restarted.hydrate(JSON.parse(JSON.stringify(store.state)));
  const afterRestart = restarted.ingest(replayMessage({
    eventId: "stable-identity-after-restart",
    fileSize: 16384,
    modifiedAt: "2026-07-15T18:00:16.000Z",
    fileIdentity: { fileIndex: "1234", volumeSerial: "ABCD" },
    thumbnailBase64: "",
  }));
  assert.equal(afterRestart.ok, true);
  assert.equal(afterRestart.duplicate, true);
  assert.equal(afterRestart.record.id, first.record.id);
  assert.equal(restarted.items.length, 1);
  assert.equal(restarted.getRecord(first.record.id).fileSize, 16384);
});

test("event ID reuse still rejects changed paths, identities, and unproven observations", () => {
  const stableStore = new library.ReplayLibraryStore();
  stableStore.ingest(replayMessage({ eventId: "collision-stable", thumbnailBase64: "" }));
  for (const overrides of [
    { absolutePath: "D:\\Blocky Studios Exports\\Different.mp4" },
    { fileIdentity: { volumeSerial: "ABCD", fileIndex: "DIFFERENT" } },
  ]) {
    const result = stableStore.ingest(replayMessage({
      eventId: "collision-stable",
      thumbnailBase64: "",
      ...overrides,
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, "EVENT_ID_COLLISION");
  }

  const observationStore = new library.ReplayLibraryStore();
  observationStore.ingest(replayMessage({
    eventId: "collision-observation",
    fileIdentity: null,
    thumbnailBase64: "",
  }));
  for (const overrides of [
    { fileSize: 123456790 },
    { modifiedAt: "2026-07-15T18:00:09.000Z" },
  ]) {
    const result = observationStore.ingest(replayMessage({
      eventId: "collision-observation",
      fileIdentity: null,
      thumbnailBase64: "",
      ...overrides,
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, "EVENT_ID_COLLISION");
  }
});

test("domain patches validate by replay ID while runtime handles stay outside persistent state", () => {
  const store = new library.ReplayLibraryStore();
  const ingested = store.ingest(replayMessage());
  const id = ingested.record.id;
  const originalState = store.state;
  const runtimeHandle = { opaque: true };
  store.updateById(id, { status: "ready", projectItem: runtimeHandle, projectItemId: "premiere-1" });
  assert.equal(store.getById(id).projectItem, runtimeHandle);
  assert.equal(store.state, originalState, "runtime patch must not replace persistent state");
  assert.doesNotMatch(JSON.stringify(store.state), /premiere-1|opaque/);

  store.updateById(id, { favorite: true, tags: ["hero"], rating: 5 }, { domain: true });
  assert.notEqual(store.state, originalState);
  assert.equal(store.getRecord(id).favorite, true);
  assert.deepEqual(store.getRecord(id).tags, ["hero"]);
  assert.deepEqual(schema.validateOracleState(store.state), { ok: true, errors: [] });
});

test("panel subscriptions can skip eager O(n) presentation snapshots and identify domain fields", () => {
  const changes = [];
  const store = new library.ReplayLibraryStore({
    emitItems: false,
    onChange: (items, change) => changes.push({ items, change }),
  });
  const ingested = store.ingest(replayMessage({ thumbnailBase64: "" }));
  store.updateById(ingested.record.id, { status: "ready" });
  store.updateById(ingested.record.id, { durationMs: 640 }, { domain: true });
  assert.equal(changes.every((entry) => entry.items === null), true);
  assert.equal(changes[1].change.domain, false);
  assert.deepEqual(changes[1].change.fields, ["status"]);
  assert.equal(changes[2].change.domain, true);
  assert.deepEqual(changes[2].change.fields, ["durationMs"]);
});

test("stable event replay after restart preserves user metadata and rejects event ID collisions", () => {
  const firstStore = new library.ReplayLibraryStore();
  const first = firstStore.ingest(replayMessage());
  firstStore.updateById(first.record.id, { favorite: true, tags: ["hero"], notes: "Keep this" }, { domain: true });
  const restarted = new library.ReplayLibraryStore();
  restarted.hydrate(JSON.parse(JSON.stringify(firstStore.state)));
  const replayed = restarted.ingest(replayMessage());
  assert.equal(replayed.ok, true);
  assert.equal(replayed.duplicate, true);
  assert.equal(restarted.getRecord(first.record.id).favorite, true);
  assert.deepEqual(restarted.getRecord(first.record.id).tags, ["hero"]);
  assert.equal(restarted.getRecord(first.record.id).notes, "Keep this");
  const collision = restarted.ingest(replayMessage({ absolutePath: "D:\\Blocky Studios Exports\\different.mp4" }));
  assert.equal(collision.ok, false);
  assert.equal(collision.code, "EVENT_ID_COLLISION");
});

test("5,000-record snapshot ingestion batches state and emits once", () => {
  let emits = 0;
  const store = new library.ReplayLibraryStore({ onChange: () => { emits += 1; } });
  const messages = Array.from({ length: 5000 }, (_, index) => replayMessage({
    eventId: `batch-${index}`,
    absolutePath: `D:\\Blocky Studios Exports\\batch-${index}.mp4`,
    fileIdentity: { key: `batch-identity-${index}` },
    fileSize: 1000 + index,
    modifiedAt: new Date(Date.UTC(2026, 6, 15, 18, 0, 0) + index).toISOString(),
    thumbnailBase64: "",
  }));
  const started = performance.now();
  const touched = store.replaceSnapshot(messages);
  const elapsed = performance.now() - started;
  assert.equal(touched.length, 5000);
  assert.equal(Object.keys(store.state.replaysById).length, 5000);
  assert.equal(emits, 1);
  assert.ok(elapsed < 1000, `5,000-record snapshot ingestion took ${elapsed.toFixed(2)} ms`);
});

test("duration formatting preserves useful centiseconds across seconds, minutes, and hours", () => {
  assert.equal(library.formatReplayDuration(null), "--");
  assert.equal(library.formatReplayDuration(640), "0.64s");
  assert.equal(library.formatReplayDuration(12080), "12.08s");
  assert.equal(library.formatReplayDuration(60010), "1:00.01");
  assert.equal(library.formatReplayDuration(3661230), "1:01:01.23");
});

test("selectors cover views, filters, chronological groups, and 5,000-record search under 50 ms", () => {
  const state = schema.createEmptyOracleState({
    writtenAt: "2026-07-15T18:00:00.000Z",
    writerId: "m2-benchmark",
  });
  for (let index = 0; index < 5000; index += 1) {
    const id = schema.stableUuidFromSeed(`m2-record-${index}`);
    const canonicalPath = `D:\\Blocky Studios Exports\\shot-${String(index).padStart(4, "0")}.mp4`;
    state.replaysById[id] = {
      id,
      canonicalPath,
      pathKey: schema.replayPathKey(canonicalPath),
      fileIdentity: { key: `identity-${index}` },
      sourceName: `shot-${index}`,
      displayNameOverride: index === 4321 ? "Needle Hero Orbit" : "",
      fileSize: 1000 + index,
      modifiedAt: "2026-07-15T18:00:00.000Z",
      exportedAt: new Date(Date.UTC(2026, 6, 15, 18, 0, 0) - index * 1000).toISOString(),
      firstSeenAt: "2026-07-15T18:00:00.000Z",
      durationMs: 1000 + index,
      thumbnailCacheKey: "",
      thumbnailStatus: "unavailable",
      archiveState: index % 11 === 0 ? "archived" : "active",
      missingState: index % 13 === 0 ? "missing" : "available",
      collectionIds: [],
      tags: index % 7 === 0 ? ["hero"] : [],
      favorite: index % 17 === 0,
      rating: index % 6,
      notes: "",
      usageCount: index % 9,
      lastOpenedAt: null,
      lastDraggedAt: null,
      legacy: { id: "", thumbnailPath: "", thumbnailError: "", resolution: "1920 × 1080", fps: 60, timecode: "" },
    };
  }
  assert.deepEqual(schema.validateOracleState(state), { ok: true, errors: [] });
  const start = performance.now();
  const found = library.selectReplayIds(state, { query: "needle hero orbit" });
  const elapsed = performance.now() - start;
  assert.equal(found.length, 1);
  assert.ok(elapsed < 50, `5,000-record search took ${elapsed.toFixed(2)} ms`);
  assert.ok(library.selectReplayIds(state, { view: "favorites" }).length > 0);
  assert.ok(library.selectReplayIds(state, { view: "missing" }).length > 0);
  assert.ok(library.selectReplayIds(state, { tag: "hero" }).length > 0);
  assert.equal(library.selectReplayIds(state, {
    root: "D:\\Blocky Studios",
    query: "needle hero orbit",
  }).length, 0, "path-root matching must stop at a directory boundary");
  assert.equal(library.selectReplayIds(state, {
    root: "D:\\Blocky Studios Exports",
    query: "needle hero orbit",
  }).length, 1);
  assert.ok(library.selectReplayIds(state, {
    view: "recent",
    now: "2026-07-15T20:00:00.000Z",
  }).length > 0);
  const entries = library.chronologicalEntries(state, library.selectReplayIds(state).slice(0, 100), new Date("2026-07-15T20:00:00Z"));
  assert.equal(entries[0].kind, "header");
  assert.equal(entries[0].label, "Today");
});

test("virtual windows cap DOM work for 100, 1,000, and 5,000 records while retaining spacers", () => {
  const virtualizer = new library.ReplayVirtualWindow({ overscanRows: 3, maximumItems: 180 });
  for (const itemCount of [100, 1000, 5000]) {
    for (const columns of [1, 3, 6]) {
      for (const scrollTop of [0, 5000, 100000]) {
        const window = virtualizer.calculate({ itemCount, columns, rowHeight: 240, scrollTop, viewportHeight: 800 });
        assert.ok(window.start >= 0 && window.end <= itemCount);
        assert.ok(window.end - window.start <= 180);
        assert.ok(window.topSpacer >= 0 && window.bottomSpacer >= 0);
        assert.equal(window.totalHeight, Math.ceil(itemCount / columns) * 240);
        assert.ok(window.topSpacer <= window.totalHeight);
        assert.ok(window.bottomSpacer <= window.totalHeight);
      }
    }
  }
});

test("bounded task queue enforces concurrency and cancels pending work", async () => {
  const queue = new library.BoundedTaskQueue(2);
  let active = 0;
  let maximumActive = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => queue.submit(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return index;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 2);
  queue.cancelPending();
  for (const release of releases) release();
  const settled = await Promise.allSettled(tasks);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 0);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 5);
  queue.destroy();
});

test("thumbnail cache keys invalidate on identity/mtime/position changes and permanent JPEG bytes survive restart", async () => {
  const normalized = library.normalizeBridgeReplay(replayMessage());
  const record = normalized.record;
  const base = library.thumbnailCacheKey(record, { position: 0.5, width: 640, height: 360 });
  assert.notEqual(base, library.thumbnailCacheKey({ ...record, modifiedAt: "2026-07-15T19:00:00.000Z" }, { position: 0.5, width: 640, height: 360 }));
  assert.notEqual(base, library.thumbnailCacheKey(record, { position: 0.25, width: 640, height: 360 }));
  assert.notEqual(base, library.thumbnailCacheKey(record, { position: 0.5, width: 1280, height: 720 }));
  assert.throws(() => library.decodeBase64("invalid"), /valid bounded JPEG/);
  assert.throws(() => library.decodeBase64("/9j/AAAA"), /complete JPEG/);
  assert.throws(() => library.decodeBase64(MISSING_SOF_JPEG_BASE64), /supported SOF marker/);
  assert.throws(() => library.decodeBase64(TRUNCATED_SOF_JPEG_BASE64), /truncated SOF/);
  const decoded = library.decodeBase64(VALID_JPEG_BASE64);
  assert.equal(decoded.byteLength, VALID_JPEG_BYTES);
  assert.deepEqual(
    { ...library.parseJpegFrame(decoded) },
    { marker: 0xc0, precision: 8, width: 640, height: 360, pixels: 230400, componentCount: 1 },
  );

  const fs = new MemoryFs();
  const cache = new library.ThumbnailCache({
    fs,
    encoder: passthroughThumbnailEncoder,
    now: () => "2026-07-15T18:00:03.000Z",
  });
  const stored = await cache.store(record, VALID_JPEG_BASE64, { position: 0.5, width: 640, height: 360, limitMb: 1 });
  assert.equal(fs.files.has(stored.url), true);
  assert.deepEqual(cache.usage(), { totalBytes: VALID_JPEG_BYTES, count: 1 });
  const secondRecord = { ...record, canonicalPath: "D:\\Blocky Studios Exports\\second.mp4", pathKey: schema.replayPathKey("D:\\Blocky Studios Exports\\second.mp4"), fileIdentity: { key: "second" } };
  const [, second] = await Promise.all([
    cache.store(record, VALID_JPEG_BASE64, { position: 0.5, width: 640, height: 360, limitMb: 1 }),
    cache.store(secondRecord, VALID_JPEG_BASE64, { position: 0.5, width: 640, height: 360, limitMb: 1 }),
  ]);
  assert.equal(fs.files.has(second.url), true);
  assert.equal(Array.from(fs.files.keys()).some((key) => key.endsWith(".tmp")), false);
  const restarted = new library.ThumbnailCache({ fs });
  await restarted.load();
  assert.deepEqual(restarted.usage(), { totalBytes: VALID_JPEG_BYTES * 2, count: 2 });
  await restarted.clear();
  assert.deepEqual(restarted.usage(), { totalBytes: 0, count: 0 });
});

test("production thumbnail encoder decodes, center-crops, resamples, and emits verified JPEG bytes through the UXP canvas seam", async () => {
  const drawCalls = [];
  const dataUrlCalls = [];
  const objectUrls = [];
  const revoked = [];
  class FakeImage {
    constructor() {
      this.naturalWidth = 800;
      this.naturalHeight = 600;
      this.onload = null;
      this.onerror = null;
      this.currentSource = "";
    }

    set src(value) {
      this.currentSource = value;
      if (value) queueMicrotask(() => {
        if (this.onload) this.onload();
      });
    }

    get src() {
      return this.currentSource;
    }
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext(kind) {
      assert.equal(kind, "2d");
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage(...args) {
          drawCalls.push(args.slice(1));
        },
      };
    },
    toDataURL(type, quality) {
      dataUrlCalls.push({ type, quality, width: this.width, height: this.height });
      return `data:image/jpeg;base64,${syntheticJpegBase64(this.width, this.height)}`;
    },
  };
  const runtime = {
    Blob: class FakeBlob {
      constructor(parts, options) {
        this.parts = parts;
        this.options = options;
      }
    },
    Image: FakeImage,
    URL: {
      createObjectURL(blob) {
        objectUrls.push(blob);
        return "blob:oracle-thumbnail-test";
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    document: {
      createElement(name) {
        assert.equal(name, "canvas");
        return canvas;
      },
    },
  };
  const output = await library.encodeJpegVariantWithCanvas({
    bytes: Buffer.from(syntheticJpegBase64(800, 600), "base64"),
    width: 640,
    height: 360,
    runtime,
  });

  assert.deepEqual(
    { ...library.parseJpegFrame(output) },
    { marker: 0xc0, precision: 8, width: 640, height: 360, pixels: 230400, componentCount: 1 },
  );
  assert.deepEqual(drawCalls, [[0, 75, 800, 450, 0, 0, 640, 360]]);
  assert.deepEqual(dataUrlCalls, [{ type: "image/jpeg", quality: 0.86, width: 640, height: 360 }]);
  assert.equal(objectUrls.length, 1);
  assert.equal(objectUrls[0].options.type, "image/jpeg");
  assert.deepEqual(revoked, ["blob:oracle-thumbnail-test"]);
});

test("thumbnail cache generates and verifies real requested 1x/high-DPI JPEG dimensions with reusable bounded variants", async () => {
  const fs = new MemoryFs();
  const record = library.normalizeBridgeReplay(replayMessage({
    thumbnailWidth: 1280,
    thumbnailHeight: 720,
    thumbnailBase64: syntheticJpegBase64(1280, 720),
  })).record;
  const calls = [];
  const encoder = async (request) => {
    request.signal.throwIfCancelled();
    calls.push({
      source: { ...request.sourceFrame },
      width: request.width,
      height: request.height,
      quality: request.quality,
    });
    return Buffer.from(syntheticJpegBase64(request.width, request.height), "base64");
  };
  const cache = new library.ThumbnailCache({ fs, encoder, concurrency: 2 });
  const source = syntheticJpegBase64(1280, 720);

  const oneX = await cache.store(record, source, { width: 640, height: 360, limitMb: 16 });
  const highDpi = await cache.store(record, source, { width: 1280, height: 720, limitMb: 16 });
  assert.notEqual(oneX.key, highDpi.key);
  assert.deepEqual(
    { ...library.parseJpegFrame(fs.files.get(oneX.url)) },
    { marker: 0xc0, precision: 8, width: 640, height: 360, pixels: 230400, componentCount: 1 },
  );
  assert.deepEqual(
    { ...library.parseJpegFrame(fs.files.get(highDpi.url)) },
    { marker: 0xc0, precision: 8, width: 1280, height: 720, pixels: 921600, componentCount: 1 },
  );
  assert.deepEqual(calls.map(({ width, height }) => ({ width, height })), [
    { width: 640, height: 360 },
    { width: 1280, height: 720 },
  ]);
  assert.equal(oneX.sourceWidth, 1280);
  assert.equal(oneX.sourceHeight, 720);
  assert.equal(highDpi.sourceWidth, 1280);
  assert.equal(highDpi.sourceHeight, 720);

  const reused = await cache.store(record, source, { width: 640, height: 360, limitMb: 16 });
  assert.equal(reused.reused, true);
  assert.equal(calls.length, 2, "a verified unchanged cache entry must bypass decoding/resampling work");

  fs.files.set(oneX.url, Buffer.from(syntheticJpegBase64(1280, 720), "base64"));
  const repaired = await cache.store(record, source, { width: 640, height: 360, limitMb: 16 });
  assert.equal(repaired.reused, false, "wrong-dimension cache bytes must be discarded, not trusted by key alone");
  assert.equal(calls.length, 3);
  assert.deepEqual(
    { ...library.parseJpegFrame(fs.files.get(repaired.url)) },
    { marker: 0xc0, precision: 8, width: 640, height: 360, pixels: 230400, componentCount: 1 },
  );
  cache.destroy();
});

test("thumbnail variant encoding fails closed on unavailable UXP encoding, bad output dimensions, and unsafe requests", async () => {
  const record = library.normalizeBridgeReplay(replayMessage()).record;
  const highDpiSource = syntheticJpegBase64(1280, 720);
  const unavailableFs = new AuditedMemoryFs();
  const unavailable = new library.ThumbnailCache({ fs: unavailableFs });
  await assert.rejects(
    unavailable.store(record, highDpiSource, { width: 640, height: 360 }),
    /UXP runtime did not expose its canvas image encoder/,
  );
  assert.equal(Array.from(unavailableFs.files.keys()).some((url) => url.endsWith(".jpg")), false);
  unavailable.destroy();

  let encodeCalls = 0;
  const badFs = new AuditedMemoryFs();
  const wrongDimensions = new library.ThumbnailCache({
    fs: badFs,
    encoder: async () => {
      encodeCalls += 1;
      return Buffer.from(syntheticJpegBase64(320, 180), "base64");
    },
  });
  await assert.rejects(
    wrongDimensions.store(record, highDpiSource, { width: 640, height: 360 }),
    /expected exactly 640 x 360/,
  );
  for (const options of [
    { width: library.MAX_THUMBNAIL_DIMENSION + 1, height: 360 },
    { width: 4096, height: 2305 },
    { width: 640.5, height: 360 },
    { width: library.MIN_THUMBNAIL_DIMENSION - 1, height: 360 },
  ]) {
    await assert.rejects(wrongDimensions.store(record, highDpiSource, options), /Thumbnail (?:width|variant)/);
  }
  assert.equal(encodeCalls, 1, "unsafe target dimensions must be rejected before the encoder runs");
  assert.equal(Array.from(badFs.files.keys()).some((url) => url.endsWith(".jpg")), false);
  wrongDimensions.destroy();
});

test("thumbnail resampling observes clear/invalidation cancellation and cannot commit late variant bytes", async () => {
  const record = library.normalizeBridgeReplay(replayMessage()).record;
  const source = syntheticJpegBase64(1280, 720);
  for (const cancellation of ["clear", "invalidate"]) {
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    let observedCancellation = false;
    const fs = new MemoryFs();
    const cache = new library.ThumbnailCache({
      fs,
      encoder: (request) => new Promise((resolve, reject) => {
        const unsubscribe = request.signal.onCancel(() => {
          observedCancellation = true;
          unsubscribe();
          try {
            request.signal.throwIfCancelled();
          } catch (error) {
            reject(error);
          }
        });
        startedResolve();
      }),
    });
    const pending = cache.store(record, source, { width: 640, height: 360 });
    await started;
    const cancelling = cancellation === "clear" ? cache.clear() : cache.invalidate(record);
    await assert.rejects(pending, /cancelled/);
    await cancelling;
    assert.equal(observedCancellation, true, `${cancellation} must signal an active encoder`);
    assert.equal(Array.from(fs.files.keys()).some((url) => url.endsWith(".jpg") || url.endsWith(".jpg.tmp")), false);
    assert.deepEqual(cache.usage(), { totalBytes: 0, count: 0 });
    cache.destroy();
  }
});

test("thumbnail cache rejects missing, truncated, oversized, and decompression-bomb SOF dimensions before persistence", async () => {
  const fs = new AuditedMemoryFs();
  const cache = new library.ThumbnailCache({ fs, encoder: passthroughThumbnailEncoder });
  const record = library.normalizeBridgeReplay(replayMessage()).record;
  const invalid = [
    [MISSING_SOF_JPEG_BASE64, /supported SOF marker/],
    [TRUNCATED_SOF_JPEG_BASE64, /truncated SOF/],
    [syntheticJpegBase64(library.MAX_THUMBNAIL_DIMENSION + 1, 360), /side limit/],
    [syntheticJpegBase64(4096, 4096), /pixel limit/],
  ];
  for (const [payload, message] of invalid) {
    await assert.rejects(cache.store(record, payload), message);
  }
  assert.deepEqual(fs.mutations, []);
  assert.deepEqual(Array.from(fs.files.entries()), []);
  assert.deepEqual(cache.usage(), { totalBytes: 0, count: 0 });
  cache.destroy();
});

test("thumbnail index loading whitelists bounded canonical metadata and rejects aggregate poisoning", async () => {
  const indexUrl = "plugin-data:/oracle-thumbnails.v1.json";
  const valid = {
    key: "a".repeat(32),
    bytes: 4096,
    lastAccessedAt: "2026-07-15T18:00:00.000Z",
    pathKeyHash: "b".repeat(32),
    sourceFingerprint: "c".repeat(32),
    injectedPath: "C:\\private\\clip.mov",
  };
  const fs = new MemoryFs();
  fs.files.set(indexUrl, JSON.stringify({
    schema: "oracle-thumbnail-cache",
    version: library.THUMBNAIL_SCHEMA_VERSION,
    entries: [
      valid,
      { ...valid, key: "d".repeat(32), bytes: library.MAX_THUMBNAIL_INDEX_TOTAL_BYTES },
      { ...valid, key: "e".repeat(32), lastAccessedAt: "not-a-time" },
    ],
  }));
  const cache = new library.ThumbnailCache({ fs });
  await cache.load();
  assert.equal(cache.entries.size, 1);
  assert.deepEqual(cache.entries.get("a".repeat(32)), {
    key: "a".repeat(32),
    bytes: 4096,
    lastAccessedAt: "2026-07-15T18:00:00.000Z",
    pathKeyHash: "b".repeat(32),
    sourceFingerprint: "c".repeat(32),
  });
  assert.equal(JSON.stringify(cache.entries.get("a".repeat(32))).includes("private"), false);
  cache.destroy();

  const aggregateFs = new MemoryFs();
  aggregateFs.files.set(indexUrl, JSON.stringify({
    schema: "oracle-thumbnail-cache",
    version: library.THUMBNAIL_SCHEMA_VERSION,
    entries: Array.from({ length: 513 }, (_, index) => ({
      key: index.toString(16).padStart(32, "0"),
      bytes: 8 * 1024 * 1024,
      lastAccessedAt: "2026-07-15T18:00:00.000Z",
      pathKeyHash: "b".repeat(32),
      sourceFingerprint: "c".repeat(32),
    })),
  }));
  const poisoned = new library.ThumbnailCache({ fs: aggregateFs });
  await poisoned.load();
  assert.equal(poisoned.entries.size, 0, "an over-budget aggregate index is rejected atomically");
  poisoned.destroy();
});

test("thumbnail cancellation removes staged bytes and cannot poison the permanent cache", async () => {
  let releaseWrite;
  let writeStarted;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const released = new Promise((resolve) => { releaseWrite = resolve; });
  class GatedMemoryFs extends MemoryFs {
    async writeFile(url, value) {
      await super.writeFile(url, value);
      if (url.endsWith(".jpg.tmp")) {
        writeStarted();
        await released;
      }
    }
  }
  const fs = new GatedMemoryFs();
  const cache = new library.ThumbnailCache({ fs, encoder: passthroughThumbnailEncoder });
  const pendingStore = cache.store(
    library.normalizeBridgeReplay(replayMessage()).record,
    VALID_JPEG_BASE64,
  );
  await started;
  const clearing = cache.clear();
  releaseWrite();
  await assert.rejects(pendingStore, /cancelled/);
  await clearing;
  assert.equal(Array.from(fs.files.keys()).some((key) => key.endsWith(".tmp")), false);
  assert.equal(Array.from(fs.files.keys()).some((key) => key.endsWith(".jpg")), false);
  assert.deepEqual(cache.usage(), { totalBytes: 0, count: 0 });
  cache.destroy();
});

test("v3 state writes stage, verify, rotate last-known-good, and recover primary on replace failure", async () => {
  const fs = new MemoryFs();
  let clock = 0;
  const repository = new library.OracleStateRepository({
    fs,
    writerId: "m2-test",
    now: () => new Date(Date.UTC(2026, 6, 15, 18, 0, clock++)).toISOString(),
  });
  const store = new library.ReplayLibraryStore();
  store.ingest(replayMessage());
  const first = await repository.save(store.state);
  assert.equal(first.revision, 1);
  assert.equal(fs.files.has(library.STATE_URL), true);
  const firstPrimary = fs.files.get(library.STATE_URL);

  const id = Object.keys(first.replaysById)[0];
  first.replaysById[id].favorite = true;
  const second = await repository.save(first);
  assert.equal(second.revision, 2);
  assert.equal(fs.files.has(library.STATE_BACKUP_URL), true);
  assert.equal(fs.files.get(library.STATE_BACKUP_URL), firstPrimary);

  const committedBeforeFailure = fs.files.get(library.STATE_URL);
  fs.failRename = (source, destination) => source === library.STATE_TEMP_URL && destination === library.STATE_URL;
  second.replaysById[id].rating = 5;
  await assert.rejects(repository.save(second), /injected rename failure/);
  assert.equal(fs.files.get(library.STATE_URL), committedBeforeFailure);

  fs.failRename = null;
  const recovered = await new library.OracleStateRepository({ fs, writerId: "recovery" }).load();
  assert.equal(recovered.source, "primary");
  assert.equal(recovered.state.revision, 2);
  assert.deepEqual(schema.validateOracleState(recovered.state), { ok: true, errors: [] });
});

test("all-present-invalid state candidates stop hydration and healing without any write or rotation", async () => {
  const fs = new AuditedMemoryFs();
  fs.files.set(library.STATE_URL, "");
  fs.files.set(library.STATE_TEMP_URL, "{not-json");
  fs.files.set(library.STATE_BACKUP_URL, JSON.stringify({ schema: schema.ORACLE_STATE_SCHEMA, version: 99 }));
  const before = Array.from(fs.files.entries());
  const repository = new library.OracleStateRepository({ fs, writerId: "corrupt-recovery-test" });
  let hydrated = false;
  let healed = false;

  await assert.rejects((async () => {
    const recovered = await repository.load();
    hydrated = true;
    const store = new library.ReplayLibraryStore();
    store.hydrate(recovered.state);
    await repository.save(store.state);
    healed = true;
  })(), (error) => {
    assert.equal(error.name, "OracleStateRecoveryError");
    assert.equal(error.code, "STATE_RECOVERY_REQUIRED");
    assert.equal(error.details.candidateCount, 3, "the successfully read empty primary must count");
    assert.equal(error.details.rejectedCount, 3);
    assert.deepEqual(error.details.sources, ["primary", "temp", "backup"]);
    assert.ok(error.diagnostics.some((entry) => entry.code === "STATE_RECOVERY_REQUIRED"));
    return true;
  });

  assert.equal(hydrated, false);
  assert.equal(healed, false);
  assert.deepEqual(fs.mutations, []);
  assert.deepEqual(Array.from(fs.files.entries()), before);
  assert.ok(repository.diagnostics.some((entry) => entry.code === "STATE_RECOVERY_REQUIRED"));
});

test("true first run remains writable and a valid backup can still heal the primary", async () => {
  const firstRunFs = new AuditedMemoryFs();
  const firstRunRepository = new library.OracleStateRepository({ fs: firstRunFs, writerId: "first-run-test" });
  const firstRun = await firstRunRepository.load();
  assert.equal(firstRun.firstRun, true);
  assert.equal(firstRun.candidateCount, 0);
  assert.deepEqual(firstRunFs.mutations, []);
  const firstSave = await firstRunRepository.save(firstRun.state);
  assert.equal(firstSave.revision, 1);
  assert.equal(firstRunFs.files.has(library.STATE_URL), true);

  const backupFs = new AuditedMemoryFs();
  const backup = schema.createEmptyOracleState({
    revision: 7,
    writtenAt: "2026-07-15T19:00:00.000Z",
    writerId: "backup-writer",
  });
  backupFs.files.set(library.STATE_URL, "{corrupt-primary");
  backupFs.files.set(library.STATE_BACKUP_URL, JSON.stringify(backup));
  const backupRepository = new library.OracleStateRepository({ fs: backupFs, writerId: "backup-healer" });
  const recovered = await backupRepository.load();
  assert.equal(recovered.source, "backup");
  assert.equal(recovered.state.revision, 7);
  assert.deepEqual(backupFs.mutations, [], "loading a valid backup must remain read-only");

  const healed = await backupRepository.save(recovered.state);
  assert.equal(healed.revision, 8);
  const primary = migrations.migrateOracleState(backupFs.files.get(library.STATE_URL));
  assert.equal(primary.sourceValid, true);
  assert.equal(primary.complete, true);
  assert.equal(primary.state.revision, 8);
});

test("native durable writer takes precedence and receives the validated staged state contract", async () => {
  const calls = [];
  const fs = new MemoryFs();
  fs.writeFile = async () => {
    throw new Error("UXP fallback must not run when the native writer is available");
  };
  const repository = new library.OracleStateRepository({
    fs,
    writerId: "native-writer-test",
    atomicWriter: async (request) => {
      calls.push(request);
      return { ok: true, bytesWritten: request.text.length };
    },
  });
  const state = schema.createEmptyOracleState({ writerId: "native-writer-test" });
  const saved = await repository.save(state);
  assert.equal(saved.revision, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].primary, library.STATE_URL);
  assert.equal(calls[0].temp, library.STATE_TEMP_URL);
  assert.equal(calls[0].backup, library.STATE_BACKUP_URL);
  assert.equal(JSON.parse(calls[0].text).revision, 1);
  assert.equal(repository.diagnostics.at(-1).writer, "native-atomic");
});
