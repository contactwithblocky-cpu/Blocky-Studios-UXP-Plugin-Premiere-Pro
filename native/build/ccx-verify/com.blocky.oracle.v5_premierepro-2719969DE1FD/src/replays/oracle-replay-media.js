"use strict";

(function exposeOracleReplayMedia(globalScope, factory) {
  const library = typeof module === "object" && module && module.exports
    ? require("./oracle-replay-library.js")
    : globalScope && Reflect.get(globalScope, "OracleReplayLibrary");
  const api = factory(library);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleReplayMedia", api);
})(typeof window !== "undefined" ? window : null, function createOracleReplayMediaApi(library) {
  if (!library || typeof library.thumbnailCacheKey !== "function") {
    throw new Error("Blocky Studios replay media requires the replay library module.");
  }

  const DEFAULT_CACHE_LIMIT_MB = 512;
  const THUMBNAIL_WIDTH = 640;
  const THUMBNAIL_HEIGHT = 360;
  const MANAGED_PREVIEW_PREFIX = "oracle-preview-v1-";

  function cleanText(value, maximum = 4096) {
    return String(value == null ? "" : value).trim().slice(0, maximum);
  }

  function finite(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function replayPath(record) {
    return cleanText(record && (
      record.canonicalPath || record.canonicalMediaPath || record.filepath ||
      record.filePath || record.mediaPath || record.path
    ));
  }

  function replayPathKey(record) {
    const existing = cleanText(record && record.pathKey).toLocaleLowerCase("en-US");
    return existing || replayPath(record).replace(/\//g, "\\").toLocaleLowerCase("en-US");
  }

  function normalizedRecord(record) {
    return {
      ...(record && typeof record === "object" ? record : {}),
      pathKey: replayPathKey(record),
      canonicalPath: replayPath(record),
    };
  }

  function replayDurationSeconds(record) {
    const seconds = Number(record && record.durationSeconds);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const milliseconds = Number(record && record.durationMs);
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : 0;
  }

  function createMediaError(result, fallback) {
    const message = cleanText(result && result.errorMessage, 1024) || fallback;
    return Object.assign(new Error(message), {
      code: cleanText(result && result.errorCode, 128) || "MEDIA_PREPARATION_FAILED",
      cancelled: Boolean(result && result.cancelled),
    });
  }

  class ReplayMediaPipeline {
    constructor(options = {}) {
      this.nativeAddon = options.nativeAddon || null;
      this.thumbnailCache = options.thumbnailCache || null;
      this.fs = options.fs || null;
      this.getCacheDirectory = typeof options.getCacheDirectory === "function"
        ? options.getCacheDirectory
        : null;
      this.getCacheLimitMb = typeof options.getCacheLimitMb === "function"
        ? options.getCacheLimitMb
        : () => DEFAULT_CACHE_LIMIT_MB;
      this.onDiagnostic = typeof options.onDiagnostic === "function"
        ? options.onDiagnostic
        : () => undefined;
      this.jobs = new Map();
      this.activeRequests = new Map();
      this.destroyed = false;
      this.generation = 0;
    }

    isAvailable() {
      return Boolean(
        !this.destroyed &&
        this.nativeAddon &&
        typeof this.nativeAddon.prepareReplayMedia === "function" &&
        typeof this.nativeAddon.cancelReplayMedia === "function" &&
        this.getCacheDirectory,
      );
    }

    variantOptions(record, options = {}) {
      const legacy = record && record.legacy && typeof record.legacy === "object" ? record.legacy : {};
      return {
        position: finite(options.position ?? legacy.thumbnailPosition, 0.5, 0, 1),
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_HEIGHT,
        limitMb: Math.round(finite(options.limitMb ?? this.getCacheLimitMb(), DEFAULT_CACHE_LIMIT_MB, 128, 4096)),
      };
    }

    key(record, options = {}) {
      return library.thumbnailCacheKey(normalizedRecord(record), this.variantOptions(record, options));
    }

    prepare(record, options = {}) {
      if (!this.isAvailable()) {
        return Promise.reject(createMediaError(
          { errorCode: "MEDIA_PREPARATION_UNAVAILABLE" },
          "the Blocky Studios local replay preview service is unavailable.",
        ));
      }
      const source = normalizedRecord(record);
      if (!source.canonicalPath || !source.pathKey) {
        return Promise.reject(createMediaError(
          { errorCode: "REPLAY_MEDIA_MISSING" },
          "The replay does not have a valid local media path.",
        ));
      }
      const variant = this.variantOptions(source, options);
      const cacheKey = library.thumbnailCacheKey(source, variant);
      const includePreview = options.includePreview === true;
      const jobKey = `${cacheKey}:${includePreview ? "preview" : "thumbnail"}`;
      const existing = this.jobs.get(jobKey);
      if (existing) return existing;
      const generation = this.generation;
      const job = this.run(source, cacheKey, variant, includePreview, generation)
        .finally(() => {
          if (this.jobs.get(jobKey) === job) this.jobs.delete(jobKey);
        });
      this.jobs.set(jobKey, job);
      return job;
    }

    async run(record, cacheKey, variant, includePreview, generation) {
      const directory = cleanText(await this.getCacheDirectory(), 4096).replace(/[\\/]+$/, "");
      if (this.destroyed || generation !== this.generation) {
        throw createMediaError({ errorCode: "MEDIA_PREPARATION_CANCELLED", cancelled: true }, "Replay preview preparation was cancelled.");
      }
      const durationSeconds = replayDurationSeconds(record);
      const thumbnailPositionSeconds = durationSeconds > 0
        ? Math.min(Math.max(0, durationSeconds - 0.001), durationSeconds * variant.position)
        : 0;
      let pending;
      try {
        pending = this.nativeAddon.prepareReplayMedia({
          sourcePath: record.canonicalPath,
          cacheDirectory: directory,
          cacheKey,
          includePreview,
          thumbnailPositionSeconds,
          cacheLimitMb: variant.limitMb,
        });
      } catch (error) {
        throw createMediaError(error, "Blocky Studios could not start local replay preview preparation.");
      }
      const requestId = Number(pending && pending.requestId);
      if (Number.isSafeInteger(requestId) && requestId > 0) {
        this.activeRequests.set(requestId, { requestId, replayPath: record.canonicalPath, cacheKey });
      }
      let result;
      try {
        result = await pending;
      } finally {
        if (Number.isSafeInteger(requestId)) this.activeRequests.delete(requestId);
      }
      if (this.destroyed || generation !== this.generation) {
        throw createMediaError({ errorCode: "MEDIA_PREPARATION_CANCELLED", cancelled: true }, "Replay preview preparation was cancelled.");
      }
      if (!result || result.ok !== true || result.cancelled === true) {
        throw createMediaError(result, "Blocky Studios could not prepare this replay for its internal viewer.");
      }
      if (cleanText(result.cacheKey, 64).toLowerCase() !== cacheKey.toLowerCase()) {
        throw createMediaError({ errorCode: "MEDIA_CACHE_IDENTITY_MISMATCH" }, "Blocky Studios rejected a mismatched replay preview cache result.");
      }
      let thumbnail = null;
      if (result.thumbnailReady === true && this.thumbnailCache && typeof this.thumbnailCache.adoptNative === "function") {
        thumbnail = await this.thumbnailCache.adoptNative(record, result, variant);
      }
      const output = {
        ...result,
        cacheKey,
        thumbnail,
        originalPath: record.canonicalPath,
        playbackPath: includePreview && result.previewReady === true ? cleanText(result.previewPath) : "",
      };
      try {
        this.onDiagnostic("info", "REPLAY_MEDIA_PREPARED", {
          includePreview,
          thumbnailReused: result.thumbnailReused === true,
          previewReused: result.previewReused === true,
          sourceContainer: cleanText(result.sourceContainer, 128),
          sourceVideoCodec: cleanText(result.sourceVideoCodec, 128),
          sourceAudioCodec: cleanText(result.sourceAudioCodec, 128),
          elapsedMs: Math.max(0, Number(result.elapsedMs) || 0),
        });
      } catch (error) {
        // Diagnostics are isolated from media preparation.
      }
      return output;
    }

    cancelRecord(record) {
      const target = replayPath(record);
      let cancelled = false;
      for (const request of Array.from(this.activeRequests.values())) {
        if (target && request.replayPath !== target) continue;
        try {
          const result = this.nativeAddon.cancelReplayMedia(request.requestId);
          cancelled = Boolean(result && (result.ok || result.cancellationRequested)) || cancelled;
        } catch (error) {
          // Teardown remains best-effort; the native service also cancels on shutdown.
        }
      }
      return cancelled;
    }

    cancelAll() {
      for (const request of Array.from(this.activeRequests.values())) {
        try { this.nativeAddon.cancelReplayMedia(request.requestId); } catch (error) { /* Best-effort cancellation. */ }
      }
      return this.activeRequests.size;
    }

    async clearManagedPreviews() {
      this.cancelAll();
      if (!this.fs || typeof this.fs.readdir !== "function" || typeof this.fs.unlink !== "function" || !this.getCacheDirectory) {
        return { removed: 0 };
      }
      const directory = cleanText(await this.getCacheDirectory(), 4096).replace(/[\\/]+$/, "");
      let names = [];
      try { names = await this.fs.readdir(directory); } catch (error) { return { removed: 0 }; }
      let removed = 0;
      for (const nameValue of Array.isArray(names) ? names : []) {
        const name = cleanText(nameValue && (nameValue.name || nameValue), 512);
        if (!name.startsWith(MANAGED_PREVIEW_PREFIX) || !name.toLowerCase().endsWith(".mp4")) continue;
        try {
          await this.fs.unlink(`${directory}\\${name}`);
          removed += 1;
        } catch (error) {
          // A preview may still be open; the next bounded native cache pass can evict it.
        }
      }
      return { removed };
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.generation += 1;
      this.cancelAll();
      this.jobs.clear();
      this.activeRequests.clear();
    }
  }

  return {
    DEFAULT_CACHE_LIMIT_MB,
    MANAGED_PREVIEW_PREFIX,
    ReplayMediaPipeline,
    THUMBNAIL_HEIGHT,
    THUMBNAIL_WIDTH,
    replayPath,
  };
});
