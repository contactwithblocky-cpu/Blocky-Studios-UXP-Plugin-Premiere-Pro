// @ts-nocheck
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const library = require("./src/replays/oracle-replay-library.js");
const mediaApi = require("./src/replays/oracle-replay-media.js");
const viewerApi = require("./src/replays/oracle-replay-viewer.js");

function replay(overrides = {}) {
  return {
    id: "replay-1",
    canonicalPath: "D:\\Blocky Studios Replays\\ProRes Source.mov",
    pathKey: "d:\\oracle replays\\prores source.mov",
    fileSize: 829611679,
    modifiedAt: "2026-07-16T12:00:00.000Z",
    durationMs: 4167,
    fps: 60,
    ...overrides,
  };
}

function nativeHarness(resultOverrides = {}) {
  const requests = [];
  const cancellations = [];
  let nextRequestId = 1;
  const addon = {
    prepareReplayMedia(request) {
      requests.push(request);
      const requestId = nextRequestId++;
      const promise = Promise.resolve({
        requestId,
        ok: true,
        cancelled: false,
        thumbnailReady: true,
        previewReady: request.includePreview,
        thumbnailReused: false,
        previewReused: false,
        hasAudio: true,
        thumbnailPath: `C:\\PluginData\\oracle-thumbnail-v2-${request.cacheKey}.jpg`,
        previewPath: `C:\\PluginData\\oracle-preview-v1-${request.cacheKey}.mp4`,
        cacheKey: request.cacheKey,
        sourceContainer: "mov,mp4,m4a,3gp,3g2,mj2",
        sourceVideoCodec: "prores",
        sourceAudioCodec: "aac",
        sourceWidth: 2560,
        sourceHeight: 1440,
        durationSeconds: 4.166667,
        fps: 60,
        ...resultOverrides,
      });
      promise.requestId = requestId;
      return promise;
    },
    cancelReplayMedia(requestId) {
      cancellations.push(requestId);
      return { ok: true, cancellationRequested: true, requestId };
    },
  };
  return { addon, requests, cancellations };
}

test("ReplayMediaPipeline deduplicates native jobs and preserves the original replay path", async () => {
  const native = nativeHarness();
  const adopted = [];
  const pipeline = new mediaApi.ReplayMediaPipeline({
    nativeAddon: native.addon,
    thumbnailCache: {
      async adoptNative(record, result, options) {
        adopted.push({ record, result, options });
        return { key: result.cacheKey, url: `plugin-data:/oracle-thumbnail-v2-${result.cacheKey}.jpg` };
      },
    },
    getCacheDirectory: async () => "C:\\PluginData",
    getCacheLimitMb: () => 512,
  });
  const source = replay();
  const [first, second] = await Promise.all([
    pipeline.prepare(source, { includePreview: false }),
    pipeline.prepare(source, { includePreview: false }),
  ]);
  assert.equal(native.requests.length, 1);
  assert.equal(adopted.length, 1);
  assert.equal(native.requests[0].sourcePath, source.canonicalPath);
  assert.equal(native.requests[0].cacheDirectory, "C:\\PluginData");
  assert.equal(native.requests[0].includePreview, false);
  assert.equal(native.requests[0].thumbnailPositionSeconds > 2, true);
  assert.equal(first.originalPath, source.canonicalPath);
  assert.equal(first.playbackPath, "");
  assert.equal(first.cacheKey, second.cacheKey);
  assert.equal(first.thumbnail.url, `plugin-data:/oracle-thumbnail-v2-${first.cacheKey}.jpg`);
  assert.equal(source.canonicalPath, "D:\\Blocky Studios Replays\\ProRes Source.mov");
  pipeline.destroy();
});

test("Blocky Studios Viewer automatically opens a managed H.264 preview for ProRes and direct H.264 sources stay direct", async () => {
  const listeners = new Map();
  const media = {
    duration: 4.166667,
    currentTime: 0,
    playbackRate: 1,
    loop: false,
    muted: false,
    volume: 1,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    load() { if (this.src) queueMicrotask(() => listeners.get("loadedmetadata")?.()); },
    async play() {},
    pause() {},
    removeAttribute(name) { if (name === "src") this.src = ""; },
  };
  const phases = [];
  const proresPipeline = {
    calls: [],
    async prepare(record, options) {
      this.calls.push(options.includePreview);
      return {
        ok: true,
        sourceContainer: "mov,mp4,m4a,3gp,3g2,mj2",
        sourceVideoCodec: "prores",
        sourceAudioCodec: "aac",
        hasAudio: true,
        durationSeconds: 4.166667,
        fps: 60,
        previewReady: options.includePreview,
        playbackPath: options.includePreview ? "C:\\PluginData\\oracle-preview-v1-deadbeef.mp4" : "",
      };
    },
    cancelRecord() {},
  };
  const adapter = new viewerApi.HtmlVideoReplayAdapter(media, { mediaPipeline: proresPipeline, timeoutMs: 100 });
  const source = replay();
  const opened = await adapter.open(source, { onPlaybackPhase: (phase) => phases.push(phase) });
  assert.deepEqual(proresPipeline.calls, [false, true]);
  assert.deepEqual(phases, ["probing", "preparing-preview", "preview-ready"]);
  assert.equal(opened.playbackPhase, "preview-ready");
  assert.equal(opened.managedPreview, true);
  assert.equal(opened.hasAudio, true);
  assert.equal(media.src, "file:///C:/PluginData/oracle-preview-v1-deadbeef.mp4");
  assert.equal(source.canonicalPath, "D:\\Blocky Studios Replays\\ProRes Source.mov");
  await adapter.close(opened.ownershipToken);

  const h264Pipeline = {
    calls: [],
    async prepare(record, options) {
      this.calls.push(options.includePreview);
      return {
        sourceContainer: "mov,mp4,m4a,3gp,3g2,mj2",
        sourceVideoCodec: "h264",
        sourceAudioCodec: "aac",
        hasAudio: true,
        durationSeconds: 4,
        fps: 30,
      };
    },
    cancelRecord() {},
  };
  const direct = replay({ canonicalPath: "D:\\Blocky Studios Replays\\H264 Source.mp4" });
  const directAdapter = new viewerApi.HtmlVideoReplayAdapter(media, { mediaPipeline: h264Pipeline, timeoutMs: 100 });
  const directOpened = await directAdapter.open(direct);
  assert.deepEqual(h264Pipeline.calls, [false]);
  assert.equal(directOpened.playbackPhase, "direct-source-ready");
  assert.equal(directOpened.managedPreview, false);
  assert.equal(media.src, "file:///D:/Blocky%20Studios%20Replays/H264%20Source.mp4");
  await directAdapter.close(directOpened.ownershipToken);
});

test("Thumbnail cache native adoption uses the v2 fingerprinted cache URL", async () => {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
  const writes = new Map();
  const fsMock = {
    async readFile(url) {
      if (url === "plugin-data:/oracle-thumbnails.v1.json") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (url.startsWith("plugin-data:/oracle-thumbnail-v2-")) return bytes;
      return writes.get(url) || "";
    },
    async writeFile(url, value) { writes.set(url, value); },
    async rename(from, to) { writes.set(to, writes.get(from)); writes.delete(from); },
    async unlink(url) { writes.delete(url); },
  };
  const cache = new library.ThumbnailCache({ fs: fsMock, concurrency: 1 });
  const source = replay();
  const options = { position: 0.5, width: 640, height: 360, limitMb: 512 };
  const key = library.thumbnailCacheKey(source, options);
  const adopted = await cache.adoptNative(source, {
    ok: true,
    thumbnailReady: true,
    thumbnailReused: false,
    cacheKey: key,
    sourceWidth: 2560,
    sourceHeight: 1440,
  }, options);
  assert.equal(adopted.key, key);
  assert.equal(adopted.url, `plugin-data:/oracle-thumbnail-v2-${key}.jpg`);
  assert.equal(adopted.native, true);
  cache.destroy();
});
