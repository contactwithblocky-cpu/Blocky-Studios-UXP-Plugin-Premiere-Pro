"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3001;
const FALLBACK_PORTS = [DEFAULT_PORT];
const BRIDGE_PROTOCOL = 2;
const BRIDGE_SCHEMA = "com.blocky.oracle.bridge";
const SUBSCRIPTION_SCHEMA = "com.blocky.oracle.bridge-subscription";
const SNAPSHOT_SCHEMA = "com.blocky.oracle.bridge-snapshot";
const REPLAY_EVENT_SCHEMA = "com.blocky.oracle.replay-event";
const REPLAY_LIFECYCLE_SCHEMA = "com.blocky.oracle.replay-lifecycle";
const MAX_INCOMING_BYTES = 12 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_REPLAYS = 5000;
const MAX_RETAINED_IMPORTS = 1000;
const MAX_LIFECYCLE_RECEIPTS = 1024;
const MAX_LIFECYCLE_REVISIONS = 5000;
const MAX_RETAINED_THUMBNAIL_BYTES = 64 * 1024 * 1024;
const MAX_THUMBNAIL_DIMENSION = 4096;
const MAX_THUMBNAIL_PIXELS = 4096 * 2304;
const MAX_SOCKET_PENDING_MESSAGES = 32;
const MAX_SOCKET_PENDING_BYTES = MAX_INCOMING_BYTES * 2;
const SOCKET_PAUSE_MESSAGES = 8;
const SOCKET_PAUSE_BYTES = 4 * 1024 * 1024;
const SOCKET_RESUME_MESSAGES = 2;
const SOCKET_RESUME_BYTES = 1024 * 1024;
const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".webm",
  ".wmv",
]);

function boundedQueueLimit(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function incomingMessageBytes(raw) {
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (Array.isArray(raw)) {
    return raw.reduce((total, entry) => total + incomingMessageBytes(entry), 0);
  }
  return Buffer.byteLength(String(raw));
}

function createOrderedSocketMessageQueue(socket, handler, options = {}) {
  if (!socket || typeof socket !== "object") throw new TypeError("Ordered socket queue requires a WebSocket.");
  if (typeof handler !== "function") throw new TypeError("Ordered socket queue requires a message handler.");
  const logger = options.logger || console;
  const maxMessages = boundedQueueLimit(
    options.maxMessages,
    MAX_SOCKET_PENDING_MESSAGES,
    1,
    1024,
  );
  const maxBytes = boundedQueueLimit(
    options.maxBytes,
    MAX_SOCKET_PENDING_BYTES,
    1,
    MAX_SOCKET_PENDING_BYTES,
  );
  const pauseMessages = Math.min(maxMessages, boundedQueueLimit(
    options.pauseMessages,
    Math.min(SOCKET_PAUSE_MESSAGES, maxMessages),
    1,
    maxMessages,
  ));
  const pauseBytes = Math.min(maxBytes, boundedQueueLimit(
    options.pauseBytes,
    Math.min(SOCKET_PAUSE_BYTES, maxBytes),
    1,
    maxBytes,
  ));
  const resumeMessages = Math.min(pauseMessages - 1, boundedQueueLimit(
    options.resumeMessages,
    Math.min(SOCKET_RESUME_MESSAGES, Math.max(0, pauseMessages - 1)),
    0,
    Math.max(0, pauseMessages - 1),
  ));
  const resumeBytes = Math.min(pauseBytes - 1, boundedQueueLimit(
    options.resumeBytes,
    Math.min(SOCKET_RESUME_BYTES, Math.max(0, pauseBytes - 1)),
    0,
    Math.max(0, pauseBytes - 1),
  ));
  const pending = [];
  const idleWaiters = [];
  let active = null;
  let queuedBytes = 0;
  let draining = false;
  let paused = false;
  let stopped = false;

  function outstandingMessages() {
    return pending.length + (active ? 1 : 0);
  }

  function settleIdle() {
    if (active || pending.length) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function updateBackpressure() {
    if (stopped) return;
    const count = outstandingMessages();
    if (!paused && (count >= pauseMessages || queuedBytes >= pauseBytes)) {
      try {
        if (typeof socket.pause === "function") socket.pause();
        paused = true;
      } catch (error) {
        try { logger.warn("[Blocky Studios bridge] Could not pause an overloaded socket."); } catch (loggingError) {}
      }
      return;
    }
    if (paused && count <= resumeMessages && queuedBytes <= resumeBytes) {
      try {
        if (typeof socket.resume === "function") socket.resume();
        paused = false;
      } catch (error) {
        try { logger.warn("[Blocky Studios bridge] Could not resume a drained socket."); } catch (loggingError) {}
      }
    }
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    for (const entry of pending.splice(0)) queuedBytes -= entry.bytes;
    queuedBytes = Math.max(0, queuedBytes);
    settleIdle();
    return true;
  }

  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped && pending.length) {
        active = pending.shift();
        try {
          await handler(active.raw, active.isBinary);
        } catch (error) {
          try { logger.error("[Blocky Studios bridge] Ordered message handling failed."); } catch (loggingError) {}
          safeSend(socket, {
            event: "bridge_error",
            code: "MESSAGE_HANDLER_FAILED",
            message: "The bridge could not process this message safely.",
          });
        } finally {
          queuedBytes = Math.max(0, queuedBytes - active.bytes);
          active = null;
          updateBackpressure();
        }
      }
    } finally {
      draining = false;
      settleIdle();
    }
  }

  function enqueue(raw, isBinary = false) {
    if (stopped) return false;
    const bytes = incomingMessageBytes(raw);
    if (outstandingMessages() >= maxMessages || queuedBytes + bytes > maxBytes) {
      safeSend(socket, {
        event: "bridge_error",
        code: "MESSAGE_QUEUE_FULL",
        message: "The bridge input queue is full; reconnect and retry after pending work completes.",
      });
      try { socket.close(1013, "Bridge input queue full"); } catch (error) {}
      stop();
      return false;
    }
    pending.push({ raw, isBinary: Boolean(isBinary), bytes });
    queuedBytes += bytes;
    updateBackpressure();
    void drain();
    return true;
  }

  function whenIdle() {
    if (!active && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function snapshot() {
    return Object.freeze({
      activeCount: active ? 1 : 0,
      pendingCount: pending.length,
      outstandingCount: outstandingMessages(),
      queuedBytes,
      paused,
      stopped,
      maxMessages,
      maxBytes,
    });
  }

  return Object.freeze({ enqueue, snapshot, stop, whenIdle });
}

function createBridgeServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error("The development bridge can bind only to a loopback host.");
  }
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  const logger = options.logger || console;
  const maxRetainedReplays = boundedRetentionLimit(
    options.maxRetainedReplays,
    MAX_RETAINED_REPLAYS,
  );
  const maxRetainedImports = boundedRetentionLimit(
    options.maxRetainedImports,
    MAX_RETAINED_IMPORTS,
  );
  const replays = [];
  const imports = [];
  const lifecycleReceipts = new Map();
  const lifecycleRevisions = new Map();
  const httpServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);
    response.setHeader("Cache-Control", "no-store");

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      const address = httpServer.address();
      const listeningPort = address && typeof address === "object" ? address.port : port;
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          status: "ok",
          service: "oracle-bridge",
          mode: "development",
          protocol: BRIDGE_PROTOCOL,
          websocketUrl: `ws://${host}:${listeningPort}`,
        }),
      );
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "not_found" }));
  });
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_INCOMING_BYTES,
    verifyClient(info, done) {
      done(isLoopbackAddress(info.req && info.req.socket && info.req.socket.remoteAddress), 403);
    },
  });
  wss.on("error", (error) => {
    // The HTTP server's ready promise reports bind conflicts to the CLI. Keep a
    // listener here as well because ws mirrors that event on WebSocketServer.
    if (!error || error.code !== "EADDRINUSE") {
      logger.error("[Blocky Studios bridge] WebSocket server error.", error);
    }
  });

  const ready = new Promise((resolve, reject) => {
    httpServer.once("listening", () => resolve(httpServer.address()));
    httpServer.once("error", reject);
  });
  httpServer.listen(port, host);

  wss.on("connection", (socket) => {
    socket.isOracleSubscriber = false;
    socket.oracleSubscription = null;
    socket.isAlive = true;
    socket.on("error", () => {
      logger.warn("[Blocky Studios bridge][development] WebSocket client closed after a transport error.");
    });
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    safeSend(socket, {
      event: "bridge_hello",
      schema: BRIDGE_SCHEMA,
      version: BRIDGE_PROTOCOL,
      protocol: BRIDGE_PROTOCOL,
      supportedProtocols: [1, BRIDGE_PROTOCOL],
      mode: "development",
      message: "Blocky Studios localhost development bridge ready",
    });

    const messageQueue = createOrderedSocketMessageQueue(socket, async (raw, isBinary) => {
      const rawBytes = incomingMessageBytes(raw);
      if (isBinary) {
        safeSend(socket, { event: "bridge_error", code: "UNSUPPORTED_FRAME", message: "Binary WebSocket frames are not supported." });
        socket.close(1003, "Text JSON messages required");
        return;
      }
      if (rawBytes > MAX_INCOMING_BYTES) {
        safeSend(socket, { event: "bridge_error", code: "MESSAGE_TOO_LARGE", message: "Message exceeds the 12 MB bridge limit." });
        socket.close(1009, "Message too large");
        return;
      }
      const rawString = raw.toString("utf8");

      let message;
      try {
        message = JSON.parse(rawString);
      } catch (error) {
        safeSend(socket, { event: "bridge_error", code: "INVALID_JSON", message: "Payload must be valid JSON." });
        return;
      }
      if (!isPlainObject(message)) {
        safeSend(socket, { event: "bridge_error", code: "INVALID_MESSAGE", message: "Payload must be a JSON object." });
        return;
      }
      let eventName;
      try {
        eventName = validateMessageEventName(message);
      } catch (error) {
        safeSend(socket, {
          event: "bridge_error",
          code: "INVALID_EVENT",
          message: error && error.message ? error.message : "Invalid event name.",
        });
        return;
      }

      if (eventName === "SUBSCRIBE") {
        try {
          const subscription = validateSubscription(message);
          socket.oracleSubscription = subscription;
          socket.isOracleSubscriber = true;
          safeSend(socket, createSnapshot(subscription, replays, imports));
        } catch (error) {
          socket.isOracleSubscriber = false;
          socket.oracleSubscription = null;
          safeSend(socket, {
            event: "bridge_error",
            code: "INVALID_SUBSCRIPTION",
            message: error && error.message ? error.message : "Invalid subscription.",
          });
        }
        return;
      }

      if (eventName === "STATUS") {
        const publisherStatus = cleanOptionalString(message.message, 240) || "unknown";
        logger.info("[Blocky Studios bridge][development] Publisher status received.");
        safeSend(socket, { event: "status_ack", status: publisherStatus });
        return;
      }

      if (eventName === "IMPORT_CLIP") {
        try {
          const importClip = await prepareImportClip(message);
          const retainedImport = upsertImport(imports, importClip, maxRetainedImports);
          trimRetainedThumbnailPayloads(replays, imports);
          broadcastToSubscribers(wss, retainedImport);
          safeSend(socket, {
            event: "import_clip_accepted",
            id: retainedImport.id,
            eventId: retainedImport.eventId,
            absolutePath: retainedImport.absolutePath,
          });
          logger.info("[Blocky Studios bridge][development] Import queued.");
        } catch (error) {
          const reason = error && error.message ? error.message : "Invalid IMPORT_CLIP payload.";
          logger.warn(`[Blocky Studios bridge][development] Rejected IMPORT_CLIP: ${reason}`);
          safeSend(socket, { event: "bridge_error", message: reason });
        }
        return;
      }

      if (eventName === "REPLAY_PATH_RECONCILED") {
        if (
          !socket.isOracleSubscriber ||
          !socket.oracleSubscription ||
          socket.oracleSubscription.version !== BRIDGE_PROTOCOL
        ) {
          safeSend(socket, {
            event: "bridge_error",
            code: "RECONCILIATION_SUBSCRIBER_REQUIRED",
            message: "Replay lifecycle reconciliation requires an active protocol 2 Blocky Studios Premiere subscription.",
          });
          return;
        }
        try {
          const reconciliation = validateReplayPathReconciliation(message);
          const response = applyReplayPathReconciliation(
            replays,
            imports,
            reconciliation,
            lifecycleReceipts,
            lifecycleRevisions,
          );
          safeSend(socket, response);
          if (response.applied) {
            logger.info("[Blocky Studios bridge][development] Replay path reconciliation accepted.");
          } else {
            logger.warn("[Blocky Studios bridge][development] Replay path reconciliation rejected.");
          }
        } catch (error) {
          const code = error && error.code
            ? error.code
            : "INVALID_REPLAY_PATH_RECONCILIATION";
          const messageText = error && error.message
            ? error.message
            : "Invalid replay path reconciliation.";
          const nack = createReplayPathReconciliationNack(message, code, messageText);
          safeSend(socket, nack || { event: "bridge_error", code, message: messageText });
          logger.warn("[Blocky Studios bridge][development] Replay path reconciliation rejected.");
        }
        return;
      }

      if (!message || eventName !== "RENDER_COMPLETE") {
        const ignoredEvent = cleanOptionalString(
          (message && (message.event || message.type || message.action)) || "",
          120,
        ) || "missing";
        logger.warn("[Blocky Studios bridge][development] Ignored unsupported event.");
        safeSend(socket, { event: "event_ignored", ignoredEvent });
        return;
      }

      const mappedMessage = {
        title: firstNonEmptyString([
          message.title,
          message.payload && message.payload.title,
          message.data && message.data.title,
          message.export && message.export.title,
          message.render && message.render.title,
        ]) || "Untitled Render",
        filepath: resolveRenderFilepath(message),
        thumbnail: resolveThumbnailPath(message),
        thumbnailBase64: resolveRawThumbnailBase64(message),
        thumbnailDataUrl: resolveRawThumbnailDataUrl(message),
        durationSeconds: resolveReplayDurationSeconds(message),
        resolution: resolveReplayResolution(message),
        fps: resolveReplayFps(message),
        timecode: resolveReplayTimecode(message),
      };

      if (!mappedMessage.filepath) {
        logger.warn("[Blocky Studios bridge][development] Rejected render without an output filepath.");
        safeSend(socket, {
          event: "bridge_error",
          message:
            "render_complete requires filepath, file_path, outputPath, output_path, or outputFile.",
        });
        return;
      }

      try {
        const replay = await prepareReplay({ ...message, ...mappedMessage });
        const retainedReplay = upsertReplay(replays, replay, maxRetainedReplays);
        trimRetainedThumbnailPayloads(replays, imports);
        broadcastToSubscribers(wss, retainedReplay);
        safeSend(socket, {
          event: "render_accepted",
          id: retainedReplay.id,
          eventId: retainedReplay.eventId,
          filepath: retainedReplay.filepath,
        });
        logger.info("[Blocky Studios bridge][development] Render ready.");
      } catch (error) {
        const reason = error && error.message ? error.message : "Invalid render payload.";
        logger.warn(`[Blocky Studios bridge][development] Rejected render: ${reason}`);
        safeSend(socket, { event: "bridge_error", message: reason });
      }
    }, { logger });
    socket.on("message", (raw, isBinary) => {
      messageQueue.enqueue(raw, isBinary);
    });
    socket.once("close", () => messageQueue.stop());
  });

  let heartbeat = null;
  wss.once("listening", () => {
    heartbeat = setInterval(() => {
      for (const socket of wss.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30000);
  });

  wss.on("close", () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }
  });

  return {
    wss,
    httpServer,
    ready,
    getReplays: () => replays.slice(),
    getImports: () => imports.slice(),
    async close() {
      for (const socket of wss.clients) {
        socket.close(1001, "Blocky Studios bridge shutting down");
      }
      await new Promise((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function prepareImportClip(message) {
  const envelope = validateReplayEnvelope(message);
  const absolutePath = requiredAbsolutePath(resolveImportAbsolutePath(message), "absolutePath");
  assertSupportedMediaPath(absolutePath, "absolutePath");
  const sourceStat = await statFileIfPresent(absolutePath);
  if (sourceStat && !sourceStat.isFile()) {
    throw new Error("Import path does not point to a media file.");
  }
  const title = firstNonEmptyString([
    message.title,
    message.name,
    message.payload && message.payload.title,
    message.data && message.data.title,
  ]);
  const suppliedThumbnailBase64 = rawOptionalString(
    resolveRawThumbnailBase64(message),
    "thumbnailBase64",
    encodedThumbnailLimit(),
  );
  const thumbnailBase64 = normalizeJpegThumbnailBase64(suppliedThumbnailBase64);
  const suppliedThumbnailDataUrl = rawOptionalString(
    resolveRawThumbnailDataUrl(message),
    "thumbnailDataUrl",
    encodedThumbnailLimit() + 64,
  );
  const thumbnailDataUrl = normalizeThumbnailDataUrl(suppliedThumbnailDataUrl);
  const receivedAt = new Date().toISOString();
  const metadata = resolveExactMetadata(message, sourceStat, receivedAt);
  const eventId = resolveStableEventId(message, "IMPORT_CLIP", absolutePath, metadata);

  return {
    event: "IMPORT_CLIP",
    schema: REPLAY_EVENT_SCHEMA,
    version: envelope.version,
    protocol: envelope.version,
    id: eventId,
    eventId,
    absolutePath,
    canonicalPath: absolutePath,
    title: title || path.win32.basename(absolutePath, path.win32.extname(absolutePath)),
    sourceName: resolveReplaySourceName(message, absolutePath),
    thumbnail: resolveThumbnailPath(message),
    thumbnailBase64,
    thumbnailDataUrl,
    thumbnailError:
      suppliedThumbnailBase64 && !thumbnailBase64
        ? "thumbnailBase64 must contain complete JPEG base64 data."
        : suppliedThumbnailDataUrl && !thumbnailDataUrl
          ? "Thumbnail data URL must contain a supported image under 8 MB."
          : "",
    ...metadata,
    receivedAt,
  };
}

function validateReplayPathReconciliation(message) {
  const allowedFields = new Set([
    "event",
    "schema",
    "protocol",
    "version",
    "correlationId",
    "revision",
    "replayId",
    "oldPath",
    "newPath",
    "fileIdentity",
  ]);
  const unknownField = Object.keys(message).find((field) => !allowedFields.has(field));
  if (unknownField) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "Replay lifecycle reconciliation contains an unsupported field.",
    );
  }
  if (message.schema !== REPLAY_LIFECYCLE_SCHEMA) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "Replay lifecycle reconciliation schema is invalid.",
    );
  }
  try {
    validateConsistentVersionFields(message.protocol, message.version, "Replay lifecycle reconciliation");
  } catch (error) {
    throw reconciliationError("INVALID_REPLAY_PATH_RECONCILIATION", error.message);
  }
  if (message.protocol !== BRIDGE_PROTOCOL || message.version !== BRIDGE_PROTOCOL) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "Replay lifecycle reconciliation requires protocol and version 2.",
    );
  }

  const correlationId = requiredBoundedString(message.correlationId, "correlationId", 160);
  if (/[\u0000-\u001f\u007f]/.test(correlationId)) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "correlationId contains unsupported control characters.",
    );
  }
  let revision;
  try {
    revision = requiredInteger(message.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    throw reconciliationError("INVALID_REPLAY_PATH_RECONCILIATION", error.message);
  }
  const replayId = requiredBoundedString(message.replayId, "replayId", 240);
  if (/[\u0000-\u001f\u007f]/.test(replayId)) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "replayId contains unsupported control characters.",
    );
  }
  let oldPath;
  let newPath;
  try {
    oldPath = normalizeBridgeMediaPath(message.oldPath, "oldPath");
    newPath = normalizeBridgeMediaPath(message.newPath, "newPath");
  } catch (error) {
    throw reconciliationError("INVALID_REPLAY_PATH_RECONCILIATION", error.message);
  }
  if (oldPath === newPath) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "Replay lifecycle reconciliation requires a changed path.",
    );
  }
  if (!isPlainObject(message.fileIdentity) ||
      Object.keys(message.fileIdentity).length !== 1 ||
      !Object.hasOwn(message.fileIdentity, "key")) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "fileIdentity must contain exactly one bounded key.",
    );
  }
  const identityKey = requiredBoundedString(message.fileIdentity.key, "fileIdentity.key", 512);
  if (/[\u0000-\u001f\u007f]/.test(identityKey)) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      "fileIdentity.key contains unsupported control characters.",
    );
  }
  return Object.freeze({
    correlationId,
    revision,
    replayId,
    oldPath,
    newPath,
    oldPathKey: pathKey(oldPath),
    fileIdentity: Object.freeze({ key: identityKey }),
  });
}

function applyReplayPathReconciliation(
  replays,
  imports,
  reconciliation,
  lifecycleReceipts,
  lifecycleRevisions,
) {
  const fingerprint = replayPathReconciliationFingerprint(reconciliation);
  const priorReceipt = lifecycleReceipts.get(reconciliation.correlationId);
  if (priorReceipt) {
    // Refresh a valid retry in the bounded LRU without running the mutation a
    // second time. A correlation ID can never be reused for another request.
    rememberBounded(
      lifecycleReceipts,
      reconciliation.correlationId,
      priorReceipt,
      MAX_LIFECYCLE_RECEIPTS,
    );
    if (priorReceipt.fingerprint !== fingerprint) {
      return createReplayPathReconciliationNack(
        reconciliation,
        "RECONCILIATION_CORRELATION_REUSE",
        "Replay lifecycle correlation ID was already used for a different request.",
      );
    }
    return priorReceipt.response;
  }

  let response;
  const latestRevision = lifecycleRevisions.get(reconciliation.replayId);
  if (Number.isSafeInteger(latestRevision) && reconciliation.revision <= latestRevision) {
    response = createReplayPathReconciliationNack(
      reconciliation,
      "STALE_RECONCILIATION_REVISION",
      "Replay lifecycle reconciliation revision is not newer than the retained revision.",
    );
  } else {
    try {
      const result = reconcileRetainedReplayPaths(replays, imports, reconciliation);
      response = Object.freeze({
        event: "replay_path_reconciled_ack",
        schema: REPLAY_LIFECYCLE_SCHEMA,
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL,
        correlationId: reconciliation.correlationId,
        revision: reconciliation.revision,
        replayId: reconciliation.replayId,
        applied: true,
        updatedReplays: result.updatedReplays,
        updatedImports: result.updatedImports,
      });
      rememberBounded(
        lifecycleRevisions,
        reconciliation.replayId,
        reconciliation.revision,
        MAX_LIFECYCLE_REVISIONS,
      );
    } catch (error) {
      response = createReplayPathReconciliationNack(
        reconciliation,
        error && error.code ? error.code : "REPLAY_PATH_RECONCILIATION_FAILED",
        error && error.message
          ? error.message
          : "Replay lifecycle reconciliation could not be applied.",
      );
    }
  }

  rememberBounded(
    lifecycleReceipts,
    reconciliation.correlationId,
    Object.freeze({ fingerprint, response }),
    MAX_LIFECYCLE_RECEIPTS,
  );
  return response;
}

function createReplayPathReconciliationNack(value, code, message) {
  const correlationId = value && value.correlationId;
  const revision = value && value.revision;
  const replayId = value && value.replayId;
  if (
    typeof correlationId !== "string" ||
    !correlationId.trim() ||
    correlationId.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(correlationId) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof replayId !== "string" ||
    !replayId.trim() ||
    replayId.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(replayId)
  ) return null;
  return Object.freeze({
    event: "replay_path_reconciled_nack",
    schema: REPLAY_LIFECYCLE_SCHEMA,
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL,
    correlationId: correlationId.trim(),
    revision,
    replayId: replayId.trim(),
    applied: false,
    updatedReplays: 0,
    updatedImports: 0,
    code: cleanOptionalString(code, 120) || "REPLAY_PATH_RECONCILIATION_FAILED",
    message: cleanOptionalString(message, 240) || "Replay lifecycle reconciliation could not be applied.",
  });
}

function replayPathReconciliationFingerprint(reconciliation) {
  return JSON.stringify([
    reconciliation.revision,
    reconciliation.replayId,
    reconciliation.oldPathKey,
    pathKey(reconciliation.newPath),
    reconciliation.fileIdentity.key,
  ]);
}

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

function reconcileRetainedReplayPaths(replays, imports, reconciliation) {
  const replayResult = reconcileRetainedGroup(replays, reconciliation);
  const importResult = reconcileRetainedGroup(imports, reconciliation);
  const updatedReplays = replayResult.updated;
  const updatedImports = importResult.updated;
  if (updatedReplays + updatedImports === 0) {
    throw reconciliationError(
      "RECONCILIATION_GUARD_MISMATCH",
      "Replay lifecycle reconciliation did not match the retained replay ID and old path.",
    );
  }

  // Both replacement arrays are prepared before either retained group is
  // changed. The JavaScript turn cannot interleave a snapshot between splices.
  replays.splice(0, replays.length, ...replayResult.items);
  imports.splice(0, imports.length, ...importResult.items);
  return { updatedReplays, updatedImports };
}

function reconcileRetainedGroup(items, reconciliation) {
  let updated = 0;
  const nextItems = items.map((item) => {
    const itemId = String(item && (item.id || item.eventId) || "");
    const currentPath = item && (item.canonicalPath || item.filepath || item.absolutePath) || "";
    if (itemId !== reconciliation.replayId || pathKey(currentPath) !== reconciliation.oldPathKey) {
      return item;
    }
    updated += 1;
    const next = {
      ...item,
      canonicalPath: reconciliation.newPath,
      sourceName: path.win32.basename(
        reconciliation.newPath,
        path.win32.extname(reconciliation.newPath),
      ),
      fileIdentity: { ...reconciliation.fileIdentity },
      observedFileIdentity: { ...reconciliation.fileIdentity },
    };
    if (Object.hasOwn(item, "filepath")) next.filepath = reconciliation.newPath;
    if (Object.hasOwn(item, "absolutePath")) next.absolutePath = reconciliation.newPath;
    if (Object.hasOwn(item, "fileName")) next.fileName = path.win32.basename(reconciliation.newPath);
    return next;
  });
  return { items: nextItems, updated };
}

function reconciliationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function prepareReplay(payload) {
  const envelope = validateReplayEnvelope(payload);
  const title = requiredString(payload.title, "title", 240);
  const filepath = requiredAbsolutePath(payload.filepath, "filepath");
  assertSupportedMediaPath(filepath, "filepath");
  const thumbnailValue = cleanOptionalString(payload.thumbnail, 32767);
  const suppliedThumbnailBase64 = rawOptionalString(
    payload.thumbnailBase64,
    "thumbnailBase64",
    encodedThumbnailLimit(),
  );
  const suppliedThumbnailDataUrl = rawOptionalString(
    payload.thumbnailDataUrl,
    "thumbnailDataUrl",
    encodedThumbnailLimit() + 64,
  );

  const videoStat = await statFile(filepath, "Video file");
  if (!videoStat.isFile()) {
    throw new Error("Video filepath does not point to a file.");
  }

  let thumbnail = "";
  let thumbnailBase64 = "";
  let thumbnailDataUrl = "";
  let thumbnailError = "";
  if (suppliedThumbnailBase64) {
    thumbnailBase64 = normalizeJpegThumbnailBase64(suppliedThumbnailBase64);
    if (!thumbnailBase64) {
      thumbnailError = "thumbnailBase64 must contain raw JPEG base64 data.";
    }
  } else if (suppliedThumbnailDataUrl) {
    const normalizedDataUrl = normalizeThumbnailDataUrl(suppliedThumbnailDataUrl);
    if (normalizedDataUrl) {
      thumbnailDataUrl = normalizedDataUrl;
    } else {
      thumbnailError = "Thumbnail data URL must contain a supported image under 8 MB.";
    }
  } else if (thumbnailValue) {
    try {
      thumbnail = requiredAbsolutePath(thumbnailValue, "thumbnail");
      const thumbnailStat = await statFile(thumbnail, "Thumbnail");
      if (!thumbnailStat.isFile()) {
        throw new Error("Thumbnail path does not point to a file.");
      }
      if (thumbnailStat.size > MAX_THUMBNAIL_BYTES) {
        throw new Error("Thumbnail is larger than 8 MB.");
      }

      const mimeType = thumbnailMimeType(thumbnail);
      if (!mimeType) {
        throw new Error("Thumbnail must be PNG, JPEG, WebP, or GIF.");
      }
      const bytes = await fs.readFile(thumbnail);
      if (!hasSupportedImageSignature(bytes, mimeType)) {
        throw new Error("Thumbnail contents do not match its image extension.");
      }
      thumbnailDataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
    } catch (error) {
      thumbnailError = error && error.message ? error.message : "Thumbnail unavailable.";
    }
  } else {
    thumbnailError = "Thumbnail was not provided by the renderer.";
  }

  const completedAt = new Date().toISOString();
  const metadata = resolveExactMetadata(payload, videoStat, completedAt);
  const eventId = resolveStableEventId(payload, "RENDER_COMPLETE", filepath, metadata);

  return {
    event: "render_complete",
    schema: REPLAY_EVENT_SCHEMA,
    version: envelope.version,
    protocol: envelope.version,
    id: eventId,
    eventId,
    title,
    filepath,
    canonicalPath: filepath,
    sourceName: resolveReplaySourceName(payload, filepath),
    thumbnail,
    thumbnailBase64,
    thumbnailDataUrl,
    thumbnailError,
    ...metadata,
    completedAt: metadata.exportedAt || completedAt,
  };
}

function upsertReplay(replays, replay, limit = MAX_RETAINED_REPLAYS) {
  return upsertRetainedEvent(replays, replay, limit, "replay");
}

function upsertImport(imports, importClip, limit = MAX_RETAINED_IMPORTS) {
  return upsertRetainedEvent(imports, importClip, limit, "import");
}

function upsertRetainedEvent(items, incoming, limit, label) {
  const incomingFingerprint = physicalFingerprint(incoming);
  const idIndex = items.findIndex((item) => item.id === incoming.id);
  if (idIndex >= 0 && physicalFingerprint(items[idIndex]) !== incomingFingerprint) {
    throw new Error(`Stable ${label} event ID collides with a different physical export.`);
  }
  const physicalIndex = items.findIndex(
    (item) => physicalFingerprint(item) === incomingFingerprint,
  );
  const index = idIndex >= 0 ? idIndex : physicalIndex;
  const retained = index >= 0
    ? { ...items[index], ...incoming, id: items[index].id, eventId: items[index].id }
    : incoming;
  if (index >= 0) {
    items.splice(index, 1);
  }
  items.unshift(retained);
  if (items.length > limit) {
    items.splice(limit);
  }
  return retained;
}

function createSnapshot(subscription, replays, imports) {
  const bounded = boundedSnapshotPayload(replays, imports);
  const snapshot = {
    event: "snapshot",
    replays: bounded.replays,
    imports: bounded.imports,
    totalReplays: replays.length,
    totalImports: imports.length,
    truncated: bounded.truncated,
  };
  if (subscription.version === BRIDGE_PROTOCOL) {
    return {
      ...snapshot,
      schema: SNAPSHOT_SCHEMA,
      version: BRIDGE_PROTOCOL,
      protocol: BRIDGE_PROTOCOL,
      thumbnail: subscription.thumbnail,
    };
  }
  return snapshot;
}

function boundedSnapshotPayload(replays, imports) {
  let remainingBytes = MAX_INCOMING_BYTES - 128 * 1024;
  let truncated = false;
  const copyGroup = (items) => {
    const output = [];
    for (const item of items) {
      let candidate = item;
      let size = serializedBytes(candidate);
      if (size > remainingBytes && (item.thumbnailBase64 || item.thumbnailDataUrl)) {
        candidate = {
          ...item,
          thumbnailBase64: "",
          thumbnailDataUrl: "",
          thumbnailError: item.thumbnailError || "Thumbnail omitted from bounded reconnect snapshot.",
        };
        size = serializedBytes(candidate);
      }
      if (!Number.isFinite(size) || size > remainingBytes) {
        truncated = true;
        continue;
      }
      output.push(candidate);
      remainingBytes -= size + 1;
    }
    return output;
  };
  const boundedReplays = copyGroup(replays);
  const boundedImports = copyGroup(imports);
  return {
    replays: boundedReplays,
    imports: boundedImports,
    truncated: truncated || boundedReplays.length !== replays.length || boundedImports.length !== imports.length,
  };
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function validateSubscription(message) {
  validateConsistentVersionFields(message.protocol, message.version, "Subscription");
  const rawProtocol = message.protocol ?? message.version;
  if (rawProtocol === undefined || rawProtocol === null || rawProtocol === "") {
    return { version: 1, client: cleanOptionalString(message.client, 64), thumbnail: null };
  }
  if (typeof rawProtocol !== "number" || !Number.isInteger(rawProtocol)) {
    throw new Error("Subscription protocol/version must be an integer.");
  }
  if (rawProtocol === 1) {
    if (message.schema !== undefined && message.schema !== "") {
      throw new Error("Legacy protocol 1 subscriptions cannot declare a protocol-2 schema.");
    }
    return { version: 1, client: cleanOptionalString(message.client, 64), thumbnail: null };
  }
  if (rawProtocol !== BRIDGE_PROTOCOL || message.version !== BRIDGE_PROTOCOL) {
    throw new Error("Only subscription protocol versions 1 and 2 are supported.");
  }
  if (message.schema !== SUBSCRIPTION_SCHEMA) {
    throw new Error("Protocol 2 requires the Blocky Studios bridge subscription schema.");
  }
  const client = requiredString(message.client, "client", 64);
  if (client !== "oracle-premiere") {
    throw new Error("Protocol 2 subscriptions require the oracle-premiere client identity.");
  }
  if (!isPlainObject(message.thumbnail)) {
    throw new Error("Protocol 2 subscriptions require a thumbnail request object.");
  }
  const position = requiredFiniteNumber(message.thumbnail.position, "thumbnail.position", 0, 1);
  const width = requiredInteger(message.thumbnail.width, "thumbnail.width", 1, MAX_THUMBNAIL_DIMENSION);
  const height = requiredInteger(message.thumbnail.height, "thumbnail.height", 1, MAX_THUMBNAIL_DIMENSION);
  if (width * height > MAX_THUMBNAIL_PIXELS) {
    throw new Error("Requested thumbnail dimensions exceed the bridge pixel limit.");
  }
  return { version: BRIDGE_PROTOCOL, client, thumbnail: { position, width, height } };
}

function validateReplayEnvelope(message) {
  const declaredVersions = [];
  for (const container of replayMetadataContainers(message)) {
    if (!isPlainObject(container)) continue;
    if (container.schema !== undefined && typeof container.schema !== "string") {
      throw new Error("Replay event schema must be a string.");
    }
    validateConsistentVersionFields(container.protocol, container.version, "Replay event");
    for (const value of [container.protocol, container.version]) {
      if (value !== undefined && value !== null && value !== "") declaredVersions.push(value);
    }
  }
  if (new Set(declaredVersions).size > 1) {
    throw new Error("Replay event protocol/version declarations must agree.");
  }
  const declaredSchemas = [
    message && message.schema,
    message && message.payload && message.payload.schema,
    message && message.data && message.data.schema,
    message && message.export && message.export.schema,
    message && message.render && message.render.schema,
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
  if (new Set(declaredSchemas).size > 1) {
    throw new Error("Replay event schema declarations must agree.");
  }
  const schema = declaredSchemas[0] || "";
  const rawVersion = firstDefined([
    message && message.version,
    message && message.protocol,
    message && message.payload && (message.payload.version ?? message.payload.protocol),
    message && message.data && (message.data.version ?? message.data.protocol),
    message && message.export && (message.export.version ?? message.export.protocol),
    message && message.render && (message.render.version ?? message.render.protocol),
  ]);
  if (!schema && (rawVersion === undefined || rawVersion === null || rawVersion === "")) {
    return { version: 1 };
  }
  if (rawVersion !== undefined && (typeof rawVersion !== "number" || !Number.isInteger(rawVersion))) {
    throw new Error("Replay event version/protocol must be an integer.");
  }
  const version = rawVersion === undefined || rawVersion === null || rawVersion === ""
    ? BRIDGE_PROTOCOL
    : rawVersion;
  if (version === 1 && !schema) {
    return { version: 1 };
  }
  if (version !== BRIDGE_PROTOCOL) {
    throw new Error("Unsupported replay event version.");
  }
  if (schema !== REPLAY_EVENT_SCHEMA) {
    throw new Error("Protocol 2 replay events require the Blocky Studios replay-event schema.");
  }
  return { version };
}

function validateConsistentVersionFields(protocol, version, label) {
  for (const [field, value] of [["protocol", protocol], ["version", version]]) {
    if (value !== undefined && value !== null && value !== "" &&
      (typeof value !== "number" || !Number.isInteger(value))) {
      throw new Error(`${label} ${field} must be an integer.`);
    }
  }
  if (protocol !== undefined && version !== undefined && protocol !== version) {
    throw new Error(`${label} protocol and version must match.`);
  }
}

function resolveExactMetadata(message, sourceStat, fallbackTimestamp) {
  const durationMs = resolveReplayDurationMs(message);
  const dimensions = resolveReplayDimensions(message);
  const exportedAt = resolveReplayTimestamp(message, [
    "exportedAt",
    "completedAt",
    "timestamp",
    "receivedAt",
  ], fallbackTimestamp);
  const declaredModifiedAt = resolveReplayValue(message, ["modifiedAt", "mtime"]);
  const declaredMtimeMs = resolveReplayFinite(message, ["modifiedAtEpochMs", "mtimeMs"], null, 0);
  let modifiedAt = "";
  let mtimeMs = declaredMtimeMs;
  if (declaredModifiedAt !== undefined) {
    modifiedAt = resolveReplayTimestamp(message, ["modifiedAt", "mtime"], "");
    if (mtimeMs === null) mtimeMs = Date.parse(modifiedAt);
  } else if (mtimeMs !== null) {
    modifiedAt = new Date(mtimeMs).toISOString();
  } else if (sourceStat) {
    mtimeMs = finiteNumber(sourceStat.mtimeMs, null, 0);
    modifiedAt = sourceStat.mtime instanceof Date ? sourceStat.mtime.toISOString() : "";
  }
  const declaredFileSize = resolveReplayFinite(message, ["fileSize", "sizeBytes"], null, 0);
  const fileSize = declaredFileSize === null && sourceStat
    ? finiteNumber(sourceStat.size, null, 0)
    : declaredFileSize;
  const declaredIdentity = resolveReplayValue(message, ["fileIdentity", "fileKey"]);
  const fileIdentity = normalizeFileIdentity(declaredIdentity) || fileIdentityFromStat(sourceStat);
  const observedFileSize = sourceStat ? finiteNumber(sourceStat.size, null, 0) : null;
  const observedMtimeMs = sourceStat ? finiteNumber(sourceStat.mtimeMs, null, 0) : null;
  const observedModifiedAt = sourceStat && sourceStat.mtime instanceof Date
    ? sourceStat.mtime.toISOString()
    : "";
  const observedFileIdentity = fileIdentityFromStat(sourceStat);
  const thumbnailPosition = resolveReplayFinite(message, ["thumbnailPosition"], 0.5, 0, 1);
  const thumbnailWidth = resolveReplayFinite(
    message,
    ["thumbnailWidth"],
    640,
    1,
    MAX_THUMBNAIL_DIMENSION,
  );
  const thumbnailHeight = resolveReplayFinite(
    message,
    ["thumbnailHeight"],
    360,
    1,
    MAX_THUMBNAIL_DIMENSION,
  );
  return {
    exportedAt,
    modifiedAt,
    mtimeMs,
    fileSize,
    sizeBytes: fileSize,
    fileIdentity,
    observedFileSize,
    observedMtimeMs,
    observedModifiedAt,
    observedFileIdentity,
    durationMs,
    durationSeconds: durationMs === null ? null : durationMs / 1000,
    width: dimensions.width,
    height: dimensions.height,
    resolution: dimensions.width && dimensions.height
      ? `${dimensions.width} × ${dimensions.height}`
      : resolveReplayResolution(message),
    fps: resolveReplayFps(message),
    timecode: resolveReplayTimecode(message),
    thumbnailPosition,
    thumbnailWidth,
    thumbnailHeight,
  };
}

function resolveReplaySourceName(message, filepath) {
  const declared = resolveReplayValue(message, ["sourceName", "fileName"]);
  return cleanOptionalString(declared, 260) || path.win32.basename(filepath);
}

function resolveStableEventId(message, eventName, filepath, metadata) {
  const supplied = rawOptionalString(firstRawString([
    message && message.eventId,
    message && message.id,
    message && message.exportId,
    message && message.event_id,
    message && message.export_id,
    message && message.payload && (message.payload.eventId || message.payload.id),
    message && message.data && (message.data.eventId || message.data.id),
    message && message.export && (message.export.eventId || message.export.id),
    message && message.render && (message.render.eventId || message.render.id),
  ]), "eventId", 240);
  if (supplied) {
    return supplied;
  }
  return stableUuid([
    eventName,
    pathKey(filepath),
    fileIdentityKey(metadata.observedFileIdentity || metadata.fileIdentity),
    metadata.observedFileSize ?? metadata.fileSize ?? "",
    metadata.observedMtimeMs ?? metadata.mtimeMs ?? metadata.modifiedAt ?? "",
  ].join("|"));
}

function physicalFingerprint(event) {
  const filepath = event.canonicalPath || event.filepath || event.absolutePath || "";
  return [
    pathKey(filepath),
    fileIdentityKey(event.observedFileIdentity || event.fileIdentity),
    event.observedFileSize ?? event.fileSize ?? event.sizeBytes ?? "",
    event.observedMtimeMs ?? event.mtimeMs ?? event.modifiedAt ?? "",
  ].join("|");
}

function trimRetainedThumbnailPayloads(replays, imports) {
  const events = [...replays, ...imports];
  let retainedBytes = events.reduce((total, event) => total + thumbnailPayloadBytes(event), 0);
  if (retainedBytes <= MAX_RETAINED_THUMBNAIL_BYTES) {
    return;
  }
  for (let index = events.length - 1; index >= 0 && retainedBytes > MAX_RETAINED_THUMBNAIL_BYTES; index -= 1) {
    const event = events[index];
    const bytes = thumbnailPayloadBytes(event);
    if (!bytes) continue;
    event.thumbnailBase64 = "";
    event.thumbnailDataUrl = "";
    if (!event.thumbnailError) {
      event.thumbnailError = "Thumbnail evicted from the bounded development bridge cache.";
    }
    retainedBytes -= bytes;
  }
}

function thumbnailPayloadBytes(event) {
  return Buffer.byteLength(String(event.thumbnailBase64 || "")) +
    Buffer.byteLength(String(event.thumbnailDataUrl || ""));
}

function broadcastToSubscribers(wss, message) {
  for (const client of wss.clients) {
    if (client.isOracleSubscriber && client.readyState === WebSocket.OPEN) {
      safeSend(client, message);
    }
  }
}

function safeSend(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.warn("[Blocky Studios bridge] Failed to send WebSocket message.", error);
  }
}

function requiredString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim().slice(0, maxLength);
}

function requiredBoundedString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      `${field} must be a non-empty string.`,
    );
  }
  if (value.length > maxLength) {
    throw reconciliationError(
      "INVALID_REPLAY_PATH_RECONCILIATION",
      `${field} exceeds the bridge size limit.`,
    );
  }
  return value.trim();
}

function cleanOptionalString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function rawOptionalString(value, field, maxLength) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} exceeds the bridge size limit.`);
  }
  return value.trim();
}

function firstNonEmptyString(values) {
  for (const value of values) {
    const clean = cleanOptionalString(value, 32767);
    if (clean) {
      return clean;
    }
  }
  return "";
}

function firstRawString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function firstDefined(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredFiniteNumber(value, field, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be a finite number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requiredInteger(value, field, minimum, maximum) {
  const number = requiredFiniteNumber(value, field, minimum, maximum);
  if (!Number.isInteger(number)) {
    throw new Error(`${field} must be an integer.`);
  }
  return number;
}

function boundedRetentionLimit(value, maximum) {
  if (value === undefined) return maximum;
  return requiredInteger(value, "retention limit", 1, maximum);
}

function validateMessageEventName(message) {
  for (const field of ["event", "type", "action"]) {
    if (message[field] !== undefined && typeof message[field] !== "string") {
      throw new Error(`${field} must be a string.`);
    }
  }
  const eventName = firstRawString([message.event, message.type, message.action]);
  if (!eventName) throw new Error("Message event/type/action is required.");
  if (eventName.length > 120) throw new Error("Message event name is too long.");
  return eventName.toLocaleUpperCase("en-US");
}

function resolveImportAbsolutePath(message) {
  return firstNonEmptyString([
    message.canonicalPath,
    message.absolutePath,
    message.absolute_path,
    message.filePath,
    message.filepath,
    message.outputPath,
    message.payload && message.payload.canonicalPath,
    message.payload && message.payload.absolutePath,
    message.payload && message.payload.absolute_path,
    message.payload && message.payload.filePath,
    message.payload && message.payload.filepath,
    message.payload && message.payload.outputPath,
    message.data && message.data.canonicalPath,
    message.data && message.data.absolutePath,
    message.data && message.data.absolute_path,
    message.data && message.data.filePath,
    message.data && message.data.filepath,
    message.data && message.data.outputPath,
  ]);
}

function resolveRenderFilepath(message) {
  return firstNonEmptyString([
    message.canonicalPath,
    message.absolutePath,
    message.filePath,
    message.filepath,
    message.file_path,
    message.outputPath,
    message.output_path,
    message.outputFile,
    message.output_file,
    message.payload && message.payload.canonicalPath,
    message.payload && message.payload.absolutePath,
    message.payload && message.payload.filePath,
    message.payload && message.payload.filepath,
    message.payload && message.payload.outputPath,
    message.export && message.export.filepath,
    message.export && message.export.canonicalPath,
    message.export && message.export.absolutePath,
    message.export && message.export.filePath,
    message.export && message.export.file_path,
    message.export && message.export.outputPath,
    message.export && message.export.outputFile,
    message.render && message.render.filepath,
    message.render && message.render.canonicalPath,
    message.render && message.render.absolutePath,
    message.render && message.render.filePath,
    message.render && message.render.outputPath,
    message.data && message.data.filepath,
    message.data && message.data.canonicalPath,
    message.data && message.data.absolutePath,
    message.data && message.data.filePath,
    message.data && message.data.outputPath,
  ]);
}

function resolveThumbnailPath(message) {
  return firstNonEmptyString([
    message.thumbnail,
    message.thumb_path,
    message.thumbnailPath,
    message.thumbnail_path,
    message.export && message.export.thumbnail,
    message.render && message.render.thumbnail,
  ]);
}

function resolveRawThumbnailDataUrl(message) {
  return firstRawString([
    message.thumbnailDataUrl,
    message.thumbnail_data_url,
    message.payload && message.payload.thumbnailDataUrl,
    message.payload && message.payload.thumbnail_data_url,
    message.data && message.data.thumbnailDataUrl,
    message.data && message.data.thumbnail_data_url,
    message.export && message.export.thumbnailDataUrl,
    message.render && message.render.thumbnailDataUrl,
  ]);
}

function resolveRawThumbnailBase64(message) {
  return firstRawString([
    message.thumbnailBase64,
    message.thumbnail_base64,
    message.payload && message.payload.thumbnailBase64,
    message.payload && message.payload.thumbnail_base64,
    message.data && message.data.thumbnailBase64,
    message.data && message.data.thumbnail_base64,
    message.export && message.export.thumbnailBase64,
    message.render && message.render.thumbnailBase64,
  ]);
}

function resolveReplayDurationSeconds(message) {
  const containers = replayMetadataContainers(message);
  for (const value of containers) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const seconds = normalizeDurationSeconds(value.durationSeconds ?? value.duration);
    if (seconds !== null) {
      return seconds;
    }
    const milliseconds = normalizeDurationSeconds(value.durationMs);
    if (milliseconds !== null) {
      return milliseconds / 1000;
    }
  }
  return null;
}

function resolveReplayDurationMs(message) {
  for (const value of replayMetadataContainers(message)) {
    if (!isPlainObject(value)) continue;
    const milliseconds = finiteNumber(value.durationMs, null, 0);
    if (milliseconds !== null) return milliseconds;
    const seconds = normalizeDurationSeconds(value.durationSeconds ?? value.duration);
    if (seconds !== null) return seconds * 1000;
  }
  return null;
}

function resolveReplayDimensions(message) {
  for (const value of replayMetadataContainers(message)) {
    if (!isPlainObject(value)) continue;
    const resolution = isPlainObject(value.resolution) ? value.resolution : {};
    let width = finiteNumber(
      value.width ?? value.videoWidth ?? value.renderWidth ?? value.resolutionWidth ?? resolution.width,
      null,
      1,
    );
    let height = finiteNumber(
      value.height ?? value.videoHeight ?? value.renderHeight ?? value.resolutionHeight ?? resolution.height,
      null,
      1,
    );
    if ((!width || !height) && typeof value.resolution === "string") {
      const match = value.resolution.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
      if (match) {
        width = finiteNumber(match[1], null, 1);
        height = finiteNumber(match[2], null, 1);
      }
    }
    if (width && height) {
      return { width: Math.round(width), height: Math.round(height) };
    }
  }
  return { width: null, height: null };
}

function resolveReplayValue(message, fieldNames) {
  for (const container of replayMetadataContainers(message)) {
    if (!isPlainObject(container)) continue;
    for (const field of fieldNames) {
      if (container[field] !== undefined && container[field] !== null && container[field] !== "") {
        return container[field];
      }
    }
  }
  return undefined;
}

function resolveReplayFinite(message, fieldNames, fallback, minimum, maximum = Infinity) {
  return finiteNumber(resolveReplayValue(message, fieldNames), fallback, minimum, maximum);
}

function resolveReplayTimestamp(message, fieldNames, fallback) {
  const candidate = resolveReplayValue(message, fieldNames);
  if (candidate === undefined || candidate === null || candidate === "") {
    return validIsoTimestamp(fallback) || "";
  }
  const timestamp = validIsoTimestamp(candidate);
  if (!timestamp) {
    throw new Error(`${fieldNames[0]} must be a valid timestamp.`);
  }
  return timestamp;
}

function validIsoTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" && typeof value !== "number") return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function finiteNumber(value, fallback = null, minimum = -Infinity, maximum = Infinity) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function resolveReplayResolution(message) {
  for (const value of replayMetadataContainers(message)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    if (typeof value.resolution === "string" && value.resolution.trim()) {
      return cleanOptionalString(value.resolution, 64).replace(/\s*[xX]\s*/g, " × ");
    }
    const resolutionObject =
      value.resolution && typeof value.resolution === "object" ? value.resolution : {};
    const width = Number(
      value.width ?? value.videoWidth ?? value.renderWidth ?? value.resolutionWidth ?? resolutionObject.width,
    );
    const height = Number(
      value.height ?? value.videoHeight ?? value.renderHeight ?? value.resolutionHeight ?? resolutionObject.height,
    );
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return `${Math.round(width)} × ${Math.round(height)}`;
    }
  }
  return "";
}

function resolveReplayFps(message) {
  for (const value of replayMetadataContainers(message)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const fps = Number(
      value.fps ?? value.frameRate ?? value.framerate ?? value.framesPerSecond ?? value.frame_rate,
    );
    if (Number.isFinite(fps) && fps > 0) {
      return fps;
    }
  }
  return null;
}

function resolveReplayTimecode(message) {
  for (const value of replayMetadataContainers(message)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const timecode = firstNonEmptyString([
      value.timecode,
      value.sourceTimecode,
      value.startTimecode,
      value.timecodeStart,
      value.source_timecode,
      value.start_timecode,
    ]);
    if (timecode) {
      return cleanOptionalString(timecode, 64);
    }
  }
  return "";
}

function replayMetadataContainers(message) {
  return [
    message,
    message && message.payload,
    message && message.export,
    message && message.render,
    message && message.data,
  ];
}

function normalizeDurationSeconds(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(0, numeric);
  }
  if (typeof value === "string" && value.includes(":")) {
    const parts = value.split(":").map((part) => Number(part));
    if (parts.length <= 3 && parts.every((part) => Number.isFinite(part) && part >= 0)) {
      return parts.reduce((total, part) => total * 60 + part, 0);
    }
  }
  return null;
}

function encodedThumbnailLimit() {
  return Math.ceil(MAX_THUMBNAIL_BYTES * 4 / 3) + 8;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpegFrame(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("JPEG validation requires a Buffer.");
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    throw new Error("JPEG bytes are not a complete image.");
  }
  let offset = 2;
  const markerLimit = bytes.length - 2;
  while (offset < markerLimit) {
    if (bytes[offset] !== 0xff) {
      throw new Error("JPEG contains malformed marker data before its frame header.");
    }
    while (offset < markerLimit && bytes[offset] === 0xff) offset += 1;
    if (offset >= markerLimit) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00) throw new Error("JPEG contains an escaped marker before its frame header.");
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8) throw new Error("JPEG contains an unexpected nested start marker.");
    if (offset + 2 > markerLimit) throw new Error("JPEG contains a truncated marker length.");
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2) throw new Error("JPEG contains an invalid marker length.");
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > markerLimit) {
      throw new Error(JPEG_SOF_MARKERS.has(marker)
        ? "JPEG contains a truncated SOF segment."
        : "JPEG contains a truncated marker segment.");
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) throw new Error("JPEG contains a truncated SOF segment.");
      const componentCount = bytes[offset + 7];
      const expectedLength = 8 + (componentCount * 3);
      if (componentCount < 1 || segmentLength < expectedLength) {
        throw new Error("JPEG contains a truncated SOF component table.");
      }
      if (segmentLength !== expectedLength) {
        throw new Error("JPEG contains a malformed SOF component table.");
      }
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width < 1 || height < 1) throw new Error("JPEG SOF dimensions must be positive.");
      if (width > MAX_THUMBNAIL_DIMENSION || height > MAX_THUMBNAIL_DIMENSION) {
        throw new Error(`JPEG dimensions exceed the ${MAX_THUMBNAIL_DIMENSION} px side limit.`);
      }
      const pixels = width * height;
      if (pixels > MAX_THUMBNAIL_PIXELS) {
        throw new Error(`JPEG dimensions exceed the ${MAX_THUMBNAIL_PIXELS} pixel limit.`);
      }
      return Object.freeze({
        marker,
        precision: bytes[offset + 2],
        width,
        height,
        pixels,
        componentCount,
      });
    }
    offset = segmentEnd;
  }
  throw new Error("JPEG does not contain a supported SOF marker with dimensions.");
}

function normalizeThumbnailDataUrl(value) {
  const match = String(value || "").trim().match(
    /^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=\s]+)$/i,
  );
  if (!match) return "";
  const base64 = match[2].replace(/\s+/g, "");
  if (
    !base64 ||
    base64.length > encodedThumbnailLimit() ||
    base64.length % 4 !== 0 ||
    !/^[a-z0-9+/]+={0,2}$/i.test(base64)
  ) {
    return "";
  }
  const bytes = Buffer.from(base64, "base64");
  const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  if (bytes.length > MAX_THUMBNAIL_BYTES || !hasSupportedImageSignature(bytes, mimeType)) {
    return "";
  }
  return `data:${mimeType};base64,${base64}`;
}

function normalizeJpegThumbnailBase64(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (
    !normalized ||
    normalized.length > encodedThumbnailLimit() ||
    normalized.length % 4 !== 0 ||
    !/^[a-z0-9+/]+={0,2}$/i.test(normalized)
  ) {
    return "";
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length > MAX_THUMBNAIL_BYTES || !hasSupportedImageSignature(bytes, "image/jpeg")) {
    return "";
  }
  return normalized;
}

function hasSupportedImageSignature(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (mimeType === "image/jpeg") {
    try {
      parseJpegFrame(bytes);
      return true;
    } catch (error) {
      return false;
    }
  }
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
  }
  if (mimeType === "image/gif") {
    const header = bytes.length >= 6 ? bytes.toString("ascii", 0, 6) : "";
    return header === "GIF87a" || header === "GIF89a";
  }
  return false;
}

function requiredAbsolutePath(value, field) {
  const filepath = requiredString(value, field, 32767);
  if (!path.win32.isAbsolute(filepath)) {
    throw new Error(`${field} must be an absolute local path.`);
  }
  const separated = filepath.replace(/\//g, "\\");
  if (/^\\\\\.\\/i.test(separated) || separated.includes("\0")) {
    throw new Error(`${field} uses an unsupported Windows device path.`);
  }
  if (separated.split("\\").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${field} cannot contain traversal segments.`);
  }
  const withoutExtendedPrefix = separated.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
  const pathAfterDrive = /^[a-z]:\\/i.test(withoutExtendedPrefix)
    ? withoutExtendedPrefix.slice(2)
    : withoutExtendedPrefix;
  if (pathAfterDrive.includes(":")) {
    throw new Error(`${field} cannot address an alternate data stream.`);
  }
  return path.win32.normalize(filepath);
}

function assertSupportedMediaPath(filepath, field) {
  const extension = path.win32.extname(filepath).toLowerCase();
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`${field} must reference a supported video media file, not a directory or image sequence.`);
  }
}

function normalizeBridgeMediaPath(value, field = "filepath") {
  const filepath = requiredAbsolutePath(value, field);
  assertSupportedMediaPath(filepath, field);
  return filepath;
}

async function statFile(filepath, label) {
  try {
    return await fs.stat(filepath);
  } catch (error) {
    throw new Error(`${label} was not found.`);
  }
}

async function statFileIfPresent(filepath) {
  try {
    return await fs.stat(filepath);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw new Error("Media path could not be inspected.");
  }
}

function thumbnailMimeType(filepath) {
  switch (path.win32.extname(filepath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "";
  }
}

function pathKey(filepath) {
  return path.win32.normalize(String(filepath || ""))
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .toLocaleLowerCase("en-US");
}

function normalizeFileIdentity(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const key = cleanOptionalString(String(value), 512);
    return key ? { key } : null;
  }
  if (!isPlainObject(value)) return null;
  const normalized = {};
  for (const key of Object.keys(value).sort().slice(0, 16)) {
    const normalizedKey = cleanOptionalString(key, 64);
    const normalizedValue = cleanOptionalString(String(value[key] ?? ""), 256);
    if (normalizedKey && normalizedValue) normalized[normalizedKey] = normalizedValue;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function fileIdentityFromStat(stat) {
  if (!stat) return null;
  const identity = {};
  if (stat.dev !== undefined) identity.device = String(stat.dev);
  if (stat.ino !== undefined) identity.inode = String(stat.ino);
  return Object.keys(identity).length ? identity : null;
}

function fileIdentityKey(value) {
  const identity = normalizeFileIdentity(value);
  if (!identity) return "";
  return JSON.stringify(identity).toLocaleLowerCase("en-US");
}

function stableUuid(seed) {
  const bytes = crypto.createHash("sha256").update(String(seed), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLocaleLowerCase("en-US");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").trim().toLocaleLowerCase("en-US");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

async function runFromCommandLine() {
  const configuredPort = Number.parseInt(process.env.ORACLE_BRIDGE_PORT || "", 10);
  const ports = Number.isInteger(configuredPort) ? [configuredPort] : FALLBACK_PORTS;
  let server = null;
  let address = null;

  for (const port of ports) {
    const candidate = createBridgeServer({ port });
    try {
      address = await candidate.ready;
      server = candidate;
      break;
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        console.error(`[Blocky Studios bridge] Required port ${port} is already in use.`);
        continue;
      }
      console.error("[Blocky Studios bridge] Failed to start.", error);
      process.exitCode = 1;
      return;
    }
  }

  if (!server || !address) {
    console.error(`[Blocky Studios bridge] Ports ${ports.join(", ")} are all in use.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[Blocky Studios bridge][development-only] Listening on ws://${address.address}:${address.port}`);
  console.log("[Blocky Studios bridge][development-only] Waiting for render_complete and IMPORT_CLIP payloads.");

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  runFromCommandLine();
}

module.exports = {
  createOrderedSocketMessageQueue,
  createBridgeServer,
  normalizeBridgeMediaPath,
  normalizeJpegThumbnailBase64,
  parseJpegFrame,
  prepareImportClip,
  prepareReplay,
};
