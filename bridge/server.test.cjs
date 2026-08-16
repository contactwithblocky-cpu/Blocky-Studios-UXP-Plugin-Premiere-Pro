"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { WebSocket } = require("ws");
const {
  createBridgeServer,
  createOrderedSocketMessageQueue,
  normalizeBridgeMediaPath,
  normalizeJpegThumbnailBase64,
  parseJpegFrame,
} = require("./server.cjs");

const quietLogger = {
  info() {},
  warn() {},
  error() {},
};

function syntheticJpeg(width = 640, height = 360, marker = 0xc0) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, marker, 0x00, 0x0b,
    0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01,
    0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

const VALID_JPEG = syntheticJpeg();
const VALID_JPEG_BASE64 = VALID_JPEG.toString("base64");
const MISSING_SOF_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const TRUNCATED_SOF_JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01,
  0xff, 0xd9,
]);

function createFakeQueueSocket() {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    closes: [],
    pauseCount: 0,
    resumeCount: 0,
    send(value) { this.sent.push(JSON.parse(String(value))); },
    close(code, reason) {
      this.closes.push({ code, reason });
      this.readyState = WebSocket.CLOSING;
    },
    pause() { this.pauseCount += 1; },
    resume() { this.resumeCount += 1; },
  };
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("inbound JPEG validation requires a bounded complete SOF frame", () => {
  assert.equal(normalizeJpegThumbnailBase64(VALID_JPEG_BASE64), VALID_JPEG_BASE64);
  assert.deepEqual(
    { ...parseJpegFrame(VALID_JPEG) },
    { marker: 0xc0, precision: 8, width: 640, height: 360, pixels: 230400, componentCount: 1 },
  );

  for (const [bytes, message] of [
    [MISSING_SOF_JPEG, /supported SOF marker/],
    [TRUNCATED_SOF_JPEG, /truncated SOF/],
    [syntheticJpeg(4097, 360), /side limit/],
    [syntheticJpeg(4096, 4096), /pixel limit/],
  ]) {
    assert.throws(() => parseJpegFrame(bytes), message);
    assert.equal(normalizeJpegThumbnailBase64(bytes.toString("base64")), "");
  }
});

test("per-socket message queue serializes async work and applies pause/resume backpressure", async () => {
  const socket = createFakeQueueSocket();
  const started = [];
  const finished = [];
  const releases = [];
  const queue = createOrderedSocketMessageQueue(socket, async (raw) => {
    const value = String(raw);
    started.push(value);
    await new Promise((resolve) => releases.push(resolve));
    finished.push(value);
  }, {
    logger: quietLogger,
    maxMessages: 4,
    maxBytes: 64,
    pauseMessages: 2,
    pauseBytes: 64,
    resumeMessages: 1,
    resumeBytes: 63,
  });

  assert.equal(queue.enqueue("a"), true);
  assert.equal(queue.enqueue("b"), true);
  assert.equal(queue.enqueue("c"), true);
  await flushTasks();
  assert.deepEqual(started, ["a"]);
  assert.equal(socket.pauseCount, 1);
  assert.equal(queue.snapshot().outstandingCount, 3);

  releases.shift()();
  await flushTasks();
  assert.deepEqual(started, ["a", "b"]);
  releases.shift()();
  await flushTasks();
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.ok(socket.resumeCount >= 1);
  releases.shift()();
  await queue.whenIdle();
  assert.deepEqual(finished, ["a", "b", "c"]);
  const finalState = queue.snapshot();
  assert.deepEqual(
    {
      activeCount: finalState.activeCount,
      pendingCount: finalState.pendingCount,
      outstandingCount: finalState.outstandingCount,
      queuedBytes: finalState.queuedBytes,
      paused: finalState.paused,
      stopped: finalState.stopped,
    },
    {
      activeCount: 0,
      pendingCount: 0,
      outstandingCount: 0,
      queuedBytes: 0,
      paused: false,
      stopped: false,
    },
  );
  assert.equal(finalState.maxMessages, 4);
  assert.equal(finalState.maxBytes, 64);
});

test("per-socket message queue has hard message/byte bounds and drops queued work on overflow", async () => {
  const socket = createFakeQueueSocket();
  let releaseActive;
  const queue = createOrderedSocketMessageQueue(socket, async () => {
    await new Promise((resolve) => { releaseActive = resolve; });
  }, {
    logger: quietLogger,
    maxMessages: 2,
    maxBytes: 8,
    pauseMessages: 1,
    pauseBytes: 4,
    resumeMessages: 0,
    resumeBytes: 0,
  });

  assert.equal(queue.enqueue("aaaa"), true);
  assert.equal(queue.enqueue("bb"), true);
  assert.equal(queue.enqueue("c"), false);
  assert.equal(socket.pauseCount, 1);
  assert.equal(socket.sent.at(-1).code, "MESSAGE_QUEUE_FULL");
  assert.deepEqual(socket.closes, [{ code: 1013, reason: "Bridge input queue full" }]);
  assert.deepEqual(
    { ...queue.snapshot() },
    {
      activeCount: 1,
      pendingCount: 0,
      outstandingCount: 1,
      queuedBytes: 4,
      paused: true,
      stopped: true,
      maxMessages: 2,
      maxBytes: 8,
    },
  );
  releaseActive();
  await queue.whenIdle();
  assert.equal(queue.snapshot().queuedBytes, 0);
});

test("HTTP health check identifies the bridge without a WebSocket", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(payload.status, "ok");
  assert.equal(payload.service, "oracle-bridge");
  assert.equal(payload.mode, "development");
  assert.equal(payload.protocol, 2);
  assert.equal(payload.websocketUrl, `ws://127.0.0.1:${address.port}`);
});

test("development bridge refuses non-loopback bind hosts", () => {
  assert.throws(
    () => createBridgeServer({ host: "0.0.0.0", port: 0, logger: quietLogger }),
    /loopback host/,
  );
});

test("media path normalization preserves valid spaced, Unicode, long, and UNC Windows paths", () => {
  const localPath = "C:\\Blocky Studios Exports\\Unicode 雪\\Replay Final.mp4";
  const longPath = `\\\\?\\C:\\Blocky Studios Exports\\${"nested\\".repeat(50)}Replay.mov`;
  const uncPath = "\\\\render-server\\oracle share\\Replay Final.mkv";
  assert.equal(normalizeBridgeMediaPath(localPath), path.win32.normalize(localPath));
  assert.equal(normalizeBridgeMediaPath(longPath), path.win32.normalize(longPath));
  assert.equal(normalizeBridgeMediaPath(uncPath), path.win32.normalize(uncPath));
});

test("development publisher refuses a non-loopback bridge URL", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "publish.cjs"), "Replay", "C:\\Exports\\Replay.mp4"],
    {
      encoding: "utf8",
      env: { ...process.env, ORACLE_BRIDGE_URL: "ws://example.com:3001" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must use ws:\/\/ on a loopback host/);
  assert.doesNotMatch(result.stderr, /C:\\Exports/);
});

test("bridge hello advertises protocol 2 while retaining protocol 1 compatibility", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const hello = await waitForEvent(socket, "bridge_hello");
  context.after(() => socket.close());

  assert.equal(hello.schema, "com.blocky.oracle.bridge");
  assert.equal(hello.version, 2);
  assert.equal(hello.protocol, 2);
  assert.deepEqual(hello.supportedProtocols, [1, 2]);
  assert.equal(hello.mode, "development");

  socket.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  const snapshot = await waitForEvent(socket, "snapshot");
  assert.equal(snapshot.schema, undefined);
  assert.deepEqual(snapshot.replays, []);
});

test("protocol 2 subscribe validates schema, client, and bounded thumbnail request", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());

  socket.send(JSON.stringify({
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    version: 2,
    schema: "com.blocky.oracle.bridge-subscription",
    thumbnail: { position: 0.35, width: 1280, height: 720 },
  }));
  const snapshot = await waitForEvent(socket, "snapshot");
  assert.equal(snapshot.schema, "com.blocky.oracle.bridge-snapshot");
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.thumbnail, { position: 0.35, width: 1280, height: 720 });

  socket.send(JSON.stringify({
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    version: 2,
    schema: "wrong.schema",
    thumbnail: { position: 0.5, width: 640, height: 360 },
  }));
  const badSchema = await waitForEvent(socket, "bridge_error");
  assert.equal(badSchema.code, "INVALID_SUBSCRIPTION");
  assert.match(badSchema.message, /subscription schema/);

  socket.send(JSON.stringify({
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    version: 2,
    schema: "com.blocky.oracle.bridge-subscription",
    thumbnail: { position: 1.1, width: 640, height: 360 },
  }));
  const badBounds = await waitForEvent(socket, "bridge_error");
  assert.equal(badBounds.code, "INVALID_SUBSCRIPTION");
  assert.match(badBounds.message, /thumbnail\.position/);

  socket.send(JSON.stringify({
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    version: 2,
    schema: "com.blocky.oracle.bridge-subscription",
    thumbnail: { position: 0.5, width: 4096, height: 4096 },
  }));
  const pixelBomb = await waitForEvent(socket, "bridge_error");
  assert.equal(pixelBomb.code, "INVALID_SUBSCRIPTION");
  assert.match(pixelBomb.message, /pixel limit/);
});

test("publisher status messages are acknowledged without becoming renders", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());

  socket.send(JSON.stringify({ event: "status", message: "mod_connected" }));
  const acknowledgement = await waitForEvent(socket, "status_ack");

  assert.equal(acknowledgement.status, "mod_connected");
  assert.equal(bridge.getReplays().length, 0);
});

test("one socket preserves wire order across asynchronous render inspection and later status", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-ordered-bridge-test-"));
  const videoPath = path.join(tempDirectory, "Ordered Render.mp4");
  await fs.writeFile(videoPath, Buffer.from("oracle-ordered-video"));
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(async () => {
    await bridge.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });
  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  const responses = waitForEvents(socket, new Set(["render_accepted", "status_ack"]), 2);

  socket.send(JSON.stringify({
    event: "render_complete",
    title: "Ordered Render",
    filepath: videoPath,
  }));
  socket.send(JSON.stringify({ event: "status", message: "after_render" }));

  assert.deepEqual((await responses).map((message) => message.event), [
    "render_accepted",
    "status_ack",
  ]);
});

test("outputPath is accepted and a missing thumbnail remains non-fatal", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-output-path-test-"));
  const videoPath = path.join(tempDirectory, "Output Alias.mp4");
  await fs.writeFile(videoPath, Buffer.from("oracle-video-test"));

  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(async () => {
    await bridge.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  const address = await bridge.ready;
  const url = `ws://127.0.0.1:${address.port}`;
  const subscriber = await openSocket(url);
  const publisher = await openSocket(url);
  context.after(() => {
    subscriber.close();
    publisher.close();
  });

  subscriber.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  await waitForEvent(subscriber, "snapshot");
  publisher.send(
    JSON.stringify({
      event: "render_complete",
      title: "Output Alias",
      outputPath: videoPath,
      thumbnail: "",
    }),
  );

  const replay = await waitForEvent(subscriber, "render_complete");
  assert.equal(replay.filepath, path.normalize(videoPath));
  assert.equal(replay.thumbnail, "");
  assert.equal(replay.thumbnailDataUrl, "");
  assert.equal(replay.thumbnailError, "Thumbnail was not provided by the renderer.");
});

test("render_complete is broadcast immediately and retained for reconnect", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-test-"));
  const videoPath = path.join(tempDirectory, "Replay One.mp4");
  const thumbnailPath = path.join(tempDirectory, "Replay One.png");
  await fs.writeFile(videoPath, Buffer.from("oracle-video-test"));
  await fs.writeFile(
    thumbnailPath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(async () => {
    await bridge.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  const address = await bridge.ready;
  const url = `ws://127.0.0.1:${address.port}`;
  const subscriber = await openSocket(url);
  const publisher = await openSocket(url);
  context.after(() => {
    subscriber.close();
    publisher.close();
  });

  subscriber.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  const initialSnapshot = await waitForEvent(subscriber, "snapshot");
  assert.deepEqual(initialSnapshot.replays, []);

  publisher.send(
    JSON.stringify({
      event: "render_complete",
      title: "Replay One",
      file_path: videoPath,
      thumb_path: thumbnailPath,
      duration: "1:02.5",
      resolution: { width: 1920, height: 1080 },
      frameRate: 60,
      sourceTimecode: "01:02:03:04",
    }),
  );

  const replay = await waitForEvent(subscriber, "render_complete");
  assert.equal(replay.title, "Replay One");
  assert.equal(replay.filepath, path.normalize(videoPath));
  assert.match(replay.thumbnailDataUrl, /^data:image\/png;base64,/);
  assert.equal(replay.durationSeconds, 62.5);
  assert.equal(replay.resolution, "1920 × 1080");
  assert.equal(replay.fps, 60);
  assert.equal(replay.timecode, "01:02:03:04");
  assert.ok(replay.id);

  const accepted = await waitForEvent(publisher, "render_accepted");
  assert.equal(accepted.id, replay.id);

  const reconnect = await openSocket(url);
  context.after(() => reconnect.close());
  reconnect.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  const snapshot = await waitForEvent(reconnect, "snapshot");
  assert.equal(snapshot.replays.length, 1);
  assert.equal(snapshot.replays[0].title, "Replay One");
  assert.equal(snapshot.replays[0].resolution, "1920 × 1080");
  assert.equal(snapshot.replays[0].timecode, "01:02:03:04");
});

test("protocol 2 render metadata remains exact and repeated physical exports deduplicate", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-v2-dedup-test-"));
  const videoPath = path.join(tempDirectory, "Unicode Replay ☃.mp4");
  await fs.writeFile(videoPath, Buffer.from("oracle-v2-video"));
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(async () => {
    await bridge.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  const payload = {
    event: "render_complete",
    schema: "com.blocky.oracle.replay-event",
    protocol: 2,
    version: 2,
    title: "Exact Metadata",
    filepath: videoPath,
    exportedAt: "2026-07-15T17:18:19.123Z",
    durationMs: 640.25,
    width: 2560,
    height: 1440,
    fps: 59.94,
    timecode: "10:00:00:00",
    fileSize: 987654,
    mtimeMs: 123456789.5,
    fileIdentity: { volume: "A1", fileIndex: "B2" },
    thumbnailPosition: 0.42,
    thumbnailWidth: 1280,
    thumbnailHeight: 720,
  };

  socket.send(JSON.stringify(payload));
  const firstAccepted = await waitForEvent(socket, "render_accepted");
  socket.send(JSON.stringify(payload));
  const secondAccepted = await waitForEvent(socket, "render_accepted");

  assert.equal(firstAccepted.id, secondAccepted.id);
  assert.match(firstAccepted.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(bridge.getReplays().length, 1);
  const [replay] = bridge.getReplays();
  assert.equal(replay.schema, "com.blocky.oracle.replay-event");
  assert.equal(replay.version, 2);
  assert.equal(replay.durationMs, 640.25);
  assert.equal(replay.durationSeconds, 0.64025);
  assert.equal(replay.width, 2560);
  assert.equal(replay.height, 1440);
  assert.equal(replay.fps, 59.94);
  assert.equal(replay.fileSize, 987654);
  assert.equal(replay.mtimeMs, 123456789.5);
  assert.deepEqual(replay.fileIdentity, { fileIndex: "B2", volume: "A1" });
  assert.equal(replay.observedFileSize, Buffer.byteLength("oracle-v2-video"));
  assert.ok(Number.isFinite(replay.observedMtimeMs));
  assert.ok(replay.observedFileIdentity);
  assert.equal(replay.exportedAt, "2026-07-15T17:18:19.123Z");
  assert.equal(replay.thumbnailPosition, 0.42);
  assert.equal(replay.thumbnailWidth, 1280);
  assert.equal(replay.thumbnailHeight, 720);
});

test("protocol 2 rejects wrong replay schema and stable event ID collisions", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-v2-collision-test-"));
  const firstPath = path.join(tempDirectory, "First.mp4");
  const secondPath = path.join(tempDirectory, "Second.mp4");
  await fs.writeFile(firstPath, Buffer.from("first"));
  await fs.writeFile(secondPath, Buffer.from("second"));
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(async () => {
    await bridge.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  socket.send(JSON.stringify({
    event: "render_complete",
    schema: "wrong.schema",
    protocol: 2,
    version: 2,
    title: "Wrong Schema",
    filepath: firstPath,
  }));
  const schemaError = await waitForEvent(socket, "bridge_error");
  assert.match(schemaError.message, /replay-event schema/);
  assert.equal(bridge.getReplays().length, 0);

  const base = {
    event: "render_complete",
    schema: "com.blocky.oracle.replay-event",
    protocol: 2,
    version: 2,
    eventId: "fixed-export-event",
    title: "Stable Event",
  };
  socket.send(JSON.stringify({ ...base, filepath: firstPath }));
  await waitForEvent(socket, "render_accepted");
  socket.send(JSON.stringify({ ...base, filepath: secondPath }));
  const collision = await waitForEvent(socket, "bridge_error");
  assert.match(collision.message, /collides with a different physical export/);
  assert.equal(bridge.getReplays().length, 1);
  assert.equal(bridge.getReplays()[0].filepath, path.normalize(firstPath));
});

test("retained replay history is capped independently from imports", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-replay-cap-test-"));
  const videoPaths = ["One.mp4", "Two.mp4", "Three.mp4"].map((name) => path.join(tempDirectory, name));
  await Promise.all(videoPaths.map((filepath, index) => fs.writeFile(filepath, Buffer.from(`video-${index}`))));
  const bridge = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    logger: quietLogger,
    maxRetainedReplays: 2,
  });
  context.after(async () => {
    await bridge.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });
  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  for (const filepath of videoPaths) {
    socket.send(JSON.stringify({ event: "render_complete", title: path.basename(filepath), filepath }));
    await waitForEvent(socket, "render_accepted");
  }
  assert.deepEqual(bridge.getReplays().map((item) => item.filepath), [
    path.normalize(videoPaths[2]),
    path.normalize(videoPaths[1]),
  ]);
  assert.deepEqual(bridge.getImports(), []);
});

test("IMPORT_CLIP is forwarded immediately without requiring the file to exist yet", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const url = `ws://127.0.0.1:${address.port}`;
  const subscriber = await openSocket(url);
  const publisher = await openSocket(url);
  context.after(() => {
    subscriber.close();
    publisher.close();
  });

  subscriber.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  await waitForEvent(subscriber, "snapshot");

  const futurePath = path.join(os.tmpdir(), "oracle-future-render.mov");
  publisher.send(
    JSON.stringify({
      type: "IMPORT_CLIP",
      payload: {
        absolutePath: futurePath,
        title: "Future Render",
      },
    }),
  );

  const importClip = await waitForEvent(subscriber, "IMPORT_CLIP");
  assert.equal(importClip.absolutePath, path.normalize(futurePath));
  assert.equal(importClip.title, "Future Render");

  const accepted = await waitForEvent(publisher, "import_clip_accepted");
  assert.equal(accepted.absolutePath, importClip.absolutePath);

  const reconnect = await openSocket(url);
  context.after(() => reconnect.close());
  reconnect.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  const snapshot = await waitForEvent(reconnect, "snapshot");
  assert.equal(snapshot.imports.length, 1);
  assert.equal(snapshot.imports[0].absolutePath, importClip.absolutePath);
});

test("IMPORT_CLIP forwards an in-memory JPEG thumbnail without creating an image file", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const url = `ws://127.0.0.1:${address.port}`;
  const subscriber = await openSocket(url);
  const publisher = await openSocket(url);
  context.after(() => {
    subscriber.close();
    publisher.close();
  });

  subscriber.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  await waitForEvent(subscriber, "snapshot");
  const thumbnailBase64 = VALID_JPEG_BASE64;
  publisher.send(
    JSON.stringify({
      type: "IMPORT_CLIP",
      payload: {
        absolutePath: path.join(os.tmpdir(), "oracle-memory-thumbnail.mov"),
        title: "Memory Thumbnail",
        thumbnailBase64,
      },
    }),
  );

  const importClip = await waitForEvent(subscriber, "IMPORT_CLIP");
  assert.equal(importClip.thumbnailBase64, thumbnailBase64);
  assert.equal(importClip.thumbnail, "");
  assert.equal(importClip.thumbnailDataUrl, "");
});

test("IMPORT_CLIP rejects relative paths", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());

  socket.send(JSON.stringify({ event: "IMPORT_CLIP", absolutePath: "renders/clip.mov" }));
  const response = await waitForEvent(socket, "bridge_error");

  assert.match(response.message, /absolute local path/);
  assert.equal(bridge.getImports().length, 0);
});

test("retained import history is bounded and repeated paths deduplicate", async (context) => {
  const bridge = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    logger: quietLogger,
    maxRetainedImports: 2,
  });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  const paths = ["One.mov", "Two.mov", "Three.mov"].map((name) => path.join(os.tmpdir(), name));
  for (const absolutePath of paths) {
    socket.send(JSON.stringify({ event: "IMPORT_CLIP", absolutePath }));
    await waitForEvent(socket, "import_clip_accepted");
  }
  assert.equal(bridge.getImports().length, 2);
  assert.deepEqual(bridge.getImports().map((item) => item.absolutePath), [
    path.normalize(paths[2]),
    path.normalize(paths[1]),
  ]);

  socket.send(JSON.stringify({ event: "IMPORT_CLIP", absolutePath: paths[2] }));
  const duplicate = await waitForEvent(socket, "import_clip_accepted");
  assert.equal(bridge.getImports().length, 2);
  assert.equal(bridge.getImports()[0].id, duplicate.id);
});

test("protocol 2 replay path reconciliation atomically updates guarded replay and import snapshots", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reconcile-test-"));
  const oldReplayPath = path.join(tempDirectory, "Replay Before.mov");
  const newReplayPath = path.join(tempDirectory, "Replay After.mov");
  await fs.writeFile(oldReplayPath, Buffer.from("oracle-reconcile-video"));
  const logEntries = [];
  const logger = {
    info(...values) { logEntries.push(values.join(" ")); },
    warn(...values) { logEntries.push(values.join(" ")); },
    error(...values) { logEntries.push(values.join(" ")); },
  };
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger });
  context.after(async () => {
    await bridge.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  const address = await bridge.ready;
  const url = `ws://127.0.0.1:${address.port}`;
  const subscriber = await openSocket(url);
  const publisher = await openSocket(url);
  context.after(() => {
    subscriber.close();
    publisher.close();
  });
  subscriber.send(JSON.stringify({
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    schema: "com.blocky.oracle.bridge-subscription",
    version: 2,
    thumbnail: { position: 0.5, width: 640, height: 360 },
  }));
  await waitForEvent(subscriber, "snapshot");

  const replayId = "7cb40a18-1cf5-49cb-bf46-03a13ff835d8";
  publisher.send(JSON.stringify({
    event: "render_complete",
    schema: "com.blocky.oracle.replay-event",
    protocol: 2,
    version: 2,
    eventId: replayId,
    title: "Lifecycle Replay",
    filepath: oldReplayPath,
  }));
  await waitForEvent(publisher, "render_accepted");
  publisher.send(JSON.stringify({
    event: "IMPORT_CLIP",
    schema: "com.blocky.oracle.replay-event",
    protocol: 2,
    version: 2,
    eventId: replayId,
    absolutePath: oldReplayPath,
  }));
  await waitForEvent(publisher, "import_clip_accepted");
  await fs.rename(oldReplayPath, newReplayPath);

  const replayReconciliation = {
    event: "replay_path_reconciled",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: "node-replay-reconcile-1",
    revision: 1001,
    replayId,
    oldPath: oldReplayPath,
    newPath: newReplayPath,
    fileIdentity: { key: "volume-7:file-42" },
  };
  subscriber.send(JSON.stringify(replayReconciliation));
  const replayAck = await waitForEvent(subscriber, "replay_path_reconciled_ack");
  assert.equal(replayAck.replayId, replayId);
  assert.equal(replayAck.correlationId, replayReconciliation.correlationId);
  assert.equal(replayAck.revision, replayReconciliation.revision);
  assert.equal(replayAck.applied, true);
  assert.equal(replayAck.updatedReplays, 1);
  assert.equal(replayAck.updatedImports, 1);
  assert.equal(replayAck.oldPath, undefined);
  assert.equal(replayAck.newPath, undefined);
  assert.equal(bridge.getReplays()[0].filepath, path.normalize(newReplayPath));
  assert.equal(bridge.getReplays()[0].canonicalPath, path.normalize(newReplayPath));
  assert.deepEqual(bridge.getReplays()[0].fileIdentity, { key: "volume-7:file-42" });
  assert.deepEqual(bridge.getReplays()[0].observedFileIdentity, { key: "volume-7:file-42" });
  assert.equal(bridge.getImports()[0].canonicalPath, path.normalize(newReplayPath));

  subscriber.send(JSON.stringify(replayReconciliation));
  const retriedReplayAck = await waitForEvent(subscriber, "replay_path_reconciled_ack");
  assert.deepEqual(retriedReplayAck, replayAck, "a retry must receive the cached receipt without remutating state");

  subscriber.send(JSON.stringify({
    ...replayReconciliation,
    revision: replayReconciliation.revision + 1,
  }));
  const correlationCollision = await waitForEvent(subscriber, "replay_path_reconciled_nack");
  assert.equal(correlationCollision.code, "RECONCILIATION_CORRELATION_REUSE");
  assert.equal(correlationCollision.applied, false);

  subscriber.send(JSON.stringify({
    ...replayReconciliation,
    correlationId: "node-replay-reconcile-stale",
    revision: replayReconciliation.revision - 1,
    oldPath: newReplayPath,
    newPath: path.join(tempDirectory, "Replay Stale.mov"),
  }));
  const staleRevision = await waitForEvent(subscriber, "replay_path_reconciled_nack");
  assert.equal(staleRevision.code, "STALE_RECONCILIATION_REVISION");
  assert.equal(bridge.getReplays()[0].canonicalPath, path.normalize(newReplayPath));

  const oldImportPath = path.join(tempDirectory, "Import Before.mp4");
  const newImportPath = path.join(tempDirectory, "Import After.mp4");
  const importId = "5312d732-adf4-424c-b40c-8942dbdd864a";
  publisher.send(JSON.stringify({
    event: "IMPORT_CLIP",
    schema: "com.blocky.oracle.replay-event",
    protocol: 2,
    version: 2,
    eventId: importId,
    absolutePath: oldImportPath,
  }));
  await waitForEvent(publisher, "import_clip_accepted");
  subscriber.send(JSON.stringify({
    event: "replay_path_reconciled",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: "node-import-reconcile-1",
    revision: 2001,
    replayId: importId,
    oldPath: oldImportPath,
    newPath: newImportPath,
    fileIdentity: { key: "volume-9:file-99" },
  }));
  const importAck = await waitForEvent(subscriber, "replay_path_reconciled_ack");
  assert.equal(importAck.applied, true);
  assert.equal(importAck.updatedReplays, 0);
  assert.equal(importAck.updatedImports, 1);
  assert.equal(bridge.getImports()[0].absolutePath, path.normalize(newImportPath));
  assert.equal(bridge.getImports()[0].canonicalPath, path.normalize(newImportPath));

  const reconnect = await openSocket(url);
  context.after(() => reconnect.close());
  reconnect.send(JSON.stringify({
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    schema: "com.blocky.oracle.bridge-subscription",
    version: 2,
    thumbnail: { position: 0.5, width: 640, height: 360 },
  }));
  const snapshot = await waitForEvent(reconnect, "snapshot");
  assert.equal(snapshot.replays[0].canonicalPath, path.normalize(newReplayPath));
  assert.equal(snapshot.imports[0].canonicalPath, path.normalize(newImportPath));
  const serializedSnapshot = JSON.stringify(snapshot);
  assert.equal(serializedSnapshot.includes(path.normalize(oldReplayPath)), false);
  assert.equal(serializedSnapshot.includes(path.normalize(oldImportPath)), false);
  assert.doesNotMatch(logEntries.join("\n"), /Replay Before|Replay After|Import Before|Import After/);
});

test("replay path reconciliation requires a v2 subscriber and rejects schema, identity, and match failures", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());
  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  const valid = {
    event: "replay_path_reconciled",
    schema: "com.blocky.oracle.replay-lifecycle",
    protocol: 2,
    version: 2,
    correlationId: "node-invalid-reconcile-1",
    revision: 3001,
    replayId: "d6b8fd5f-f21f-4d23-a722-748141c0407d",
    oldPath: "C:\\Blocky Studios Tests\\Before.mov",
    newPath: "C:\\Blocky Studios Tests\\After.mov",
    fileIdentity: { key: "volume:file" },
  };

  socket.send(JSON.stringify(valid));
  const unsubscribed = await waitForEvent(socket, "bridge_error");
  assert.equal(unsubscribed.code, "RECONCILIATION_SUBSCRIBER_REQUIRED");

  socket.send(JSON.stringify({ event: "subscribe", client: "oracle-premiere" }));
  await waitForEvent(socket, "snapshot");
  socket.send(JSON.stringify(valid));
  const legacy = await waitForEvent(socket, "bridge_error");
  assert.equal(legacy.code, "RECONCILIATION_SUBSCRIBER_REQUIRED");

  socket.send(JSON.stringify({
    event: "subscribe",
    client: "oracle-premiere",
    protocol: 2,
    schema: "com.blocky.oracle.bridge-subscription",
    version: 2,
    thumbnail: { position: 0.5, width: 640, height: 360 },
  }));
  await waitForEvent(socket, "snapshot");

  socket.send(JSON.stringify({ ...valid, schema: "wrong.schema" }));
  const badSchema = await waitForEvent(socket, "replay_path_reconciled_nack");
  assert.equal(badSchema.code, "INVALID_REPLAY_PATH_RECONCILIATION");
  assert.equal(badSchema.applied, false);

  socket.send(JSON.stringify({ ...valid, fileIdentity: { key: "", extra: "not-allowed" } }));
  const badIdentity = await waitForEvent(socket, "replay_path_reconciled_nack");
  assert.equal(badIdentity.code, "INVALID_REPLAY_PATH_RECONCILIATION");

  socket.send(JSON.stringify({ ...valid, version: 1 }));
  const badVersion = await waitForEvent(socket, "replay_path_reconciled_nack");
  assert.equal(badVersion.code, "INVALID_REPLAY_PATH_RECONCILIATION");

  socket.send(JSON.stringify(valid));
  const guardMismatch = await waitForEvent(socket, "replay_path_reconciled_nack");
  assert.equal(guardMismatch.code, "RECONCILIATION_GUARD_MISMATCH");
  assert.equal(guardMismatch.applied, false);
  assert.deepEqual(bridge.getReplays(), []);
  assert.deepEqual(bridge.getImports(), []);
});

test("media validation rejects image sequences, directories, traversal, and alternate streams", async (context) => {
  const directoryWithMediaSuffix = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-directory.mov-"));
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(async () => {
    await bridge.close();
    await fs.rm(directoryWithMediaSuffix, { recursive: true, force: true });
  });

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  const unsafePaths = [
    path.join(os.tmpdir(), "frame_0001.png"),
    `${path.parse(os.tmpdir()).root}private\\..\\escape.mp4`,
    `${path.join(os.tmpdir(), "clip.mp4")}:metadata`,
  ];
  for (const absolutePath of unsafePaths) {
    socket.send(JSON.stringify({ event: "IMPORT_CLIP", absolutePath }));
    const error = await waitForEvent(socket, "bridge_error");
    assert.match(error.message, /video media|traversal|alternate data stream/);
  }

  const mediaDirectory = `${directoryWithMediaSuffix}.mov`;
  await fs.rename(directoryWithMediaSuffix, mediaDirectory);
  context.after(() => fs.rm(mediaDirectory, { recursive: true, force: true }));
  socket.send(JSON.stringify({ event: "IMPORT_CLIP", absolutePath: mediaDirectory }));
  const directoryError = await waitForEvent(socket, "bridge_error");
  assert.match(directoryError.message, /does not point to a media file/);
});

test("malformed JSON values and binary frames are rejected without retention", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const url = `ws://127.0.0.1:${address.port}`;
  const socket = await openSocket(url);
  context.after(() => socket.close());
  socket.send("[]");
  const invalidShape = await waitForEvent(socket, "bridge_error");
  assert.equal(invalidShape.code, "INVALID_MESSAGE");
  assert.equal(bridge.getReplays().length, 0);

  const binarySocket = await openSocket(url);
  const errorPromise = waitForEvent(binarySocket, "bridge_error");
  binarySocket.send(Buffer.from([1, 2, 3]));
  const binaryError = await errorPromise;
  assert.equal(binaryError.code, "UNSUPPORTED_FRAME");
  const closeCode = await waitForClose(binarySocket);
  assert.equal(closeCode, 1003);
});

test("WebSocket transport closes oversized messages at the 12 MB boundary", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());
  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  const closePromise = waitForClose(socket, 10000);
  socket.send("x".repeat(12 * 1024 * 1024 + 1));
  assert.equal(await closePromise, 1009);
  assert.equal(bridge.getReplays().length, 0);
  assert.equal(bridge.getImports().length, 0);
});

test("normal development logs never include media paths or raw payloads", async (context) => {
  const entries = [];
  const logger = {
    info(...values) { entries.push(values.join(" ")); },
    warn(...values) { entries.push(values.join(" ")); },
    error(...values) { entries.push(values.join(" ")); },
  };
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger });
  context.after(() => bridge.close());
  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());
  const privatePath = path.join(os.tmpdir(), "private-user-folder", "secret-export.mp4");
  socket.send(JSON.stringify({
    event: "render_complete",
    title: "PRIVATE_RAW_TITLE",
    filepath: privatePath,
    privateToken: "PRIVATE_RAW_TOKEN",
  }));
  await waitForEvent(socket, "bridge_error");
  const output = entries.join("\n");
  assert.doesNotMatch(output, /private-user-folder|secret-export|PRIVATE_RAW_TITLE|PRIVATE_RAW_TOKEN/);
});

test("invalid render paths are rejected and never broadcast", async (context) => {
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, logger: quietLogger });
  context.after(() => bridge.close());

  const address = await bridge.ready;
  const socket = await openSocket(`ws://127.0.0.1:${address.port}`);
  context.after(() => socket.close());

  socket.send(
    JSON.stringify({
      event: "render_complete",
      title: "Missing Replay",
      filepath: path.join(os.tmpdir(), "oracle-file-that-does-not-exist.mp4"),
      thumbnail: path.join(os.tmpdir(), "oracle-thumb-that-does-not-exist.png"),
    }),
  );

  const response = await waitForEvent(socket, "bridge_error");
  assert.match(response.message, /Video file was not found/);
  assert.equal(bridge.getReplays().length, 0);
});

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForEvent(socket, eventName, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${eventName}.`));
    }, timeoutMs);

    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.event === eventName) {
        cleanup();
        resolve(message);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };

    socket.on("message", onMessage);
  });
}

function waitForEvents(socket, eventNames, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} ordered bridge events.`));
    }, timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (!eventNames.has(message.event)) return;
      messages.push(message);
      if (messages.length >= count) {
        cleanup();
        resolve(messages);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

function waitForClose(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve(socket._closeCode);
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for socket close."));
    }, timeoutMs);
    const onClose = (code) => {
      cleanup();
      resolve(code);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", onClose);
    };
    socket.on("close", onClose);
  });
}
