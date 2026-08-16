"use strict";

(function exposeOracleReplayViewer(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleReplayViewer", api);
})(typeof window !== "undefined" ? window : null, function createOracleReplayViewerApi() {
  const SOURCE_MONITOR_MODE = "source-monitor";
  const DEFAULT_POLL_INTERVAL_MS = 200;
  const MINIMUM_POLL_INTERVAL_MS = 100;
  const MAXIMUM_POLL_INTERVAL_MS = 1000;

  const UNSUPPORTED_SOURCE_MONITOR_CONTROLS = Object.freeze({
    mute: "Premiere Source Monitor does not expose mute control.",
    volume: "Premiere Source Monitor does not expose volume control.",
    speed: "Premiere Source Monitor does not expose reliable playback-speed control or readback.",
    loop: "Premiere Source Monitor does not expose loop control.",
  });

  function cleanText(value, maximum = 1024) {
    return String(value ?? "").trim().slice(0, maximum);
  }

  function finiteNonNegative(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function finitePositive(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatViewerTime(value) {
    const seconds = finiteNonNegative(value);
    if (seconds === null) return "--:--";
    const centiseconds = Math.floor((seconds + 0.000001) * 100) % 100;
    const wholeSeconds = Math.floor(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainder = wholeSeconds % 60;
    const body = hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    return `${body}.${String(centiseconds).padStart(2, "0")}`;
  }

  function replayPath(replay) {
    return cleanText(
      replay && (
        replay.canonicalPath ||
        replay.canonicalMediaPath ||
        replay.mediaPath ||
        replay.filePath ||
        replay.filepath ||
        replay.path
      ),
      4096,
    );
  }

  function replayIdentity(replay) {
    return cleanText(
      replay && (replay.id || replay.uuid || replay.replayId || replay.pathKey),
      512,
    ) || replayPath(replay);
  }

  function replayTitle(replay) {
    const explicit = cleanText(
      replay && (replay.displayName || replay.title || replay.sourceName || replay.name || replay.fileName),
      512,
    );
    if (explicit) return explicit;
    const path = replayPath(replay).replace(/\\/g, "/");
    return cleanText(path.split("/").pop(), 512) || "Replay";
  }

  function normalizeReplay(replay) {
    const id = replayIdentity(replay);
    const path = replayPath(replay);
    if (!replay || typeof replay !== "object" || !id || !path) return null;
    return {
      record: replay,
      id,
      path,
      title: replayTitle(replay),
    };
  }

  function normalizeReplayIds(values) {
    const source = values instanceof Set
      ? Array.from(values)
      : Array.isArray(values)
        ? values
        : [values];
    return new Set(source.map((value) => cleanText(value, 512)).filter(Boolean));
  }

  function errorDetails(error, fallbackMessage) {
    const message = cleanText(error && error.message, 1024) || fallbackMessage;
    const code = cleanText(error && (error.code || error.name), 128) || "REPLAY_VIEWER_ERROR";
    return { code, message };
  }

  function actionableOpenError(error, fallbackMessage) {
    const details = errorDetails(error, fallbackMessage);
    const signature = `${details.code} ${details.message}`;
    if (/ENOENT|not\s+found|does\s+not\s+exist|no\s+such\s+file|media[_\s-]*missing/i.test(signature)) {
      return {
        code: details.code === "Error" ? "REPLAY_MEDIA_MISSING" : details.code,
        message: "The replay source file is missing. Use Relink from the replay context menu, then open it again.",
      };
    }
    if (/unsupported|codec|decoder|decode|media\s+format|invalid\s+format/i.test(signature)) {
      return {
        code: details.code === "Error" ? "REPLAY_CODEC_UNSUPPORTED" : details.code,
        message: "Premiere Source Monitor cannot decode this replay codec. Re-export it with a Premiere-supported codec, relink the replacement, and try again. Oracle will not convert media silently.",
      };
    }
    return details;
  }

  function isOwnershipError(error) {
    const details = errorDetails(error, "");
    return details.code === "SOURCE_MONITOR_OWNERSHIP_LOST" || /ownership|changed outside oracle/i.test(details.message);
  }

  function setDisabled(control, disabled, reason = "") {
    if (!control) return;
    control.disabled = Boolean(disabled);
    if (typeof control.setAttribute === "function") {
      control.setAttribute("aria-disabled", disabled ? "true" : "false");
      if (reason) control.setAttribute("data-disabled-reason", reason);
      else if (typeof control.removeAttribute === "function") control.removeAttribute("data-disabled-reason");
    }
    control.title = reason || "";
  }

  function normalizeElements(elements = {}) {
    return {
      root: elements.root || elements.replayViewerTray || null,
      title: elements.title || elements.replayViewerTitle || null,
      mode: elements.mode || elements.replayViewerMode || null,
      close: elements.close || elements.replayViewerClose || null,
      poster: elements.poster || elements.replayViewerPoster || null,
      playPause: elements.playPause || elements.replayViewerPlayPause || null,
      stepBackward: elements.stepBackward || elements.replayViewerStepBack || null,
      stepForward: elements.stepForward || elements.replayViewerStepForward || null,
      currentTime: elements.currentTime || elements.replayViewerCurrentTime || null,
      duration: elements.duration || elements.replayViewerDuration || null,
      seek: elements.seek || elements.replayViewerScrub || null,
      mute: elements.mute || elements.replayViewerMute || null,
      volume: elements.volume || elements.replayViewerVolume || null,
      speed: elements.speed || elements.replayViewerRate || null,
      loop: elements.loop || elements.replayViewerLoop || null,
      status: elements.status || elements.replayViewerStatus || null,
      error: elements.error || elements.replayViewerError || null,
      support: elements.support || elements.replayViewerSupport || null,
    };
  }

  function supportsMethod(adapter, name) {
    return Boolean(adapter && typeof adapter[name] === "function");
  }

  class ReplayViewerController {
    constructor(elements, options = {}) {
      this.elements = normalizeElements(elements);
      if (!this.elements.root) throw new TypeError("ReplayViewerController requires a viewer root element.");
      this.adapter = options.adapter || null;
      this.document = options.document || (typeof document !== "undefined" ? document : null);
      this.onUsage = typeof options.onUsage === "function" ? options.onUsage : () => undefined;
      this.onToast = typeof options.onToast === "function" ? options.onToast : () => undefined;
      this.onAnnounce = typeof options.onAnnounce === "function" ? options.onAnnounce : () => undefined;
      this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : () => undefined;
      this.now = typeof options.now === "function" ? options.now : () => Date.now();
      this.setInterval = typeof options.setInterval === "function"
        ? options.setInterval
        : (callback, delay) => setInterval(callback, delay);
      this.clearInterval = typeof options.clearInterval === "function"
        ? options.clearInterval
        : (handle) => clearInterval(handle);
      this.pollIntervalMs = clamp(
        finitePositive(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS,
        MINIMUM_POLL_INTERVAL_MS,
        MAXIMUM_POLL_INTERVAL_MS,
      );

      this.started = false;
      this.destroyed = false;
      this.focusOwned = false;
      this.restoreFocusTarget = null;
      this.viewerVisible = false;
      this.generation = 0;
      this.ownershipToken = "";
      this.activeReplay = null;
      this.requestedReplay = null;
      this.hostQueue = Promise.resolve();
      this.pollTimer = null;
      this.pollInFlight = false;
      this.pendingSeek = null;
      this.seekDrain = null;
      this.listeners = [];
      this.destroyPromise = null;
      this.state = {
        phase: "idle",
        mode: SOURCE_MONITOR_MODE,
        replayId: "",
        title: "No replay open",
        playing: false,
        positionSeconds: 0,
        durationSeconds: null,
        fps: null,
        canSeek: false,
        canFrameStep: false,
        status: "No replay open.",
        error: null,
      };

      this.handlePlayPause = () => { void this.togglePlayback(); };
      this.handleClose = () => { void this.close("user"); };
      this.handleStepBackward = () => { void this.stepFrames(-1); };
      this.handleStepForward = () => { void this.stepFrames(1); };
      this.handleSeekInput = (event) => this.onSeekInput(event);
      this.handleFocusIn = () => { this.focusOwned = true; };
      this.handleFocusOut = (event) => this.onFocusOut(event);
      this.handleKeyDown = (event) => this.onKeyDown(event);
    }

    start() {
      if (this.started || this.destroyed) return this;
      this.started = true;
      this.listen(this.elements.playPause, "click", this.handlePlayPause);
      this.listen(this.elements.close, "click", this.handleClose);
      this.listen(this.elements.stepBackward, "click", this.handleStepBackward);
      this.listen(this.elements.stepForward, "click", this.handleStepForward);
      this.listen(this.elements.seek, "input", this.handleSeekInput);
      this.listen(this.elements.root, "focusin", this.handleFocusIn);
      this.listen(this.elements.root, "focusout", this.handleFocusOut);
      this.listen(this.elements.root, "keydown", this.handleKeyDown);
      this.sync();
      return this;
    }

    listen(target, type, handler) {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(type, handler);
      this.listeners.push({ target, type, handler });
    }

    removeListeners() {
      for (const entry of this.listeners.splice(0)) {
        entry.target.removeEventListener(entry.type, entry.handler);
      }
    }

    adapterAvailable() {
      if (!this.adapter) return false;
      const required = ["open", "play", "getPosition", "seek", "close"];
      if (!required.every((name) => supportsMethod(this.adapter, name))) return false;
      if (!supportsMethod(this.adapter, "isAvailable")) return true;
      try {
        return this.adapter.isAvailable() !== false;
      } catch (error) {
        return false;
      }
    }

    getState() {
      return {
        ...this.state,
        open: this.state.phase === "open" && Boolean(this.ownershipToken),
        error: this.state.error ? { ...this.state.error } : null,
        replay: this.activeReplay ? this.activeReplay.record : this.requestedReplay && this.requestedReplay.record,
        ownershipToken: this.ownershipToken,
        generation: this.generation,
      };
    }

    commit(patch = {}, announce = "") {
      if (this.destroyed && patch.phase !== "destroyed") return;
      Object.assign(this.state, patch);
      this.sync();
      const snapshot = this.getState();
      try { this.onStateChange(snapshot); } catch (error) { /* Consumer callbacks cannot break transport. */ }
      if (announce) {
        try { this.onAnnounce(announce); } catch (error) { /* Accessibility callbacks are isolated. */ }
      }
    }

    sync() {
      const state = this.state;
      const visible = state.phase !== "idle" && state.phase !== "destroyed";
      this.elements.root.hidden = !visible;
      if (this.elements.root.dataset) {
        this.elements.root.dataset.viewerState = state.phase;
        if (visible && !this.viewerVisible) this.elements.root.dataset.viewerEntering = "true";
        if (!visible) delete this.elements.root.dataset.viewerEntering;
      }
      this.viewerVisible = visible;
      if (!visible) this.clearPoster();
      if (this.elements.title) this.elements.title.textContent = state.title;
      if (this.elements.mode) this.elements.mode.textContent = "Premiere Source Monitor";
      if (this.elements.status) this.elements.status.textContent = state.status;
      if (this.elements.error) {
        this.elements.error.hidden = !state.error;
        this.elements.error.textContent = state.error ? state.error.message : "";
      }
      if (this.elements.currentTime) this.elements.currentTime.textContent = formatViewerTime(state.positionSeconds);
      if (this.elements.duration) this.elements.duration.textContent = formatViewerTime(state.durationSeconds);

      const open = state.phase === "open";
      const playDisabled = !open;
      setDisabled(this.elements.playPause, playDisabled, playDisabled ? "Open a replay to use playback controls." : "");
      if (this.elements.playPause) {
        this.elements.playPause.textContent = state.playing ? "Pause" : "Play";
        if (typeof this.elements.playPause.setAttribute === "function") {
          this.elements.playPause.setAttribute("aria-pressed", state.playing ? "true" : "false");
          this.elements.playPause.setAttribute("aria-label", state.playing ? "Pause replay" : "Play replay");
        }
      }

      const seekReason = state.durationSeconds === null
        ? "Scrubbing requires replay duration metadata."
        : "Open a replay to scrub.";
      setDisabled(this.elements.seek, !open || !state.canSeek, !open || !state.canSeek ? seekReason : "");
      if (this.elements.seek) {
        this.elements.seek.min = "0";
        this.elements.seek.max = state.durationSeconds === null ? "1" : String(state.durationSeconds);
        this.elements.seek.step = state.fps ? String(1 / state.fps) : "0.01";
        this.elements.seek.value = String(state.positionSeconds);
      }

      const frameReason = state.fps === null
        ? "Frame stepping requires replay frame-rate metadata."
        : "Open a replay to step frames.";
      setDisabled(this.elements.stepBackward, !open || !state.canFrameStep, !open || !state.canFrameStep ? frameReason : "");
      setDisabled(this.elements.stepForward, !open || !state.canFrameStep, !open || !state.canFrameStep ? frameReason : "");

      setDisabled(this.elements.mute, true, UNSUPPORTED_SOURCE_MONITOR_CONTROLS.mute);
      setDisabled(this.elements.volume, true, UNSUPPORTED_SOURCE_MONITOR_CONTROLS.volume);
      setDisabled(this.elements.speed, true, UNSUPPORTED_SOURCE_MONITOR_CONTROLS.speed);
      setDisabled(this.elements.loop, true, UNSUPPORTED_SOURCE_MONITOR_CONTROLS.loop);
      if (this.elements.support) {
        this.elements.support.textContent = "Oracle uses Premiere Source Monitor for replay playback. Mute, volume, speed, and loop remain disabled because Premiere does not expose reliable controls for them.";
      }
    }

    clearPoster() {
      const poster = this.elements.poster;
      if (!poster) return;
      if (typeof poster.removeAttribute === "function") poster.removeAttribute("src");
      poster.hidden = true;
    }

    captureRestoreFocus() {
      if (this.viewerVisible || this.restoreFocusTarget) return;
      const target = this.document && this.document.activeElement;
      const root = this.elements.root;
      if (!target || target === root || typeof target.focus !== "function") return;
      if (typeof root.contains === "function" && root.contains(target)) return;
      this.restoreFocusTarget = target;
    }

    restoreFocus() {
      const target = this.restoreFocusTarget;
      this.restoreFocusTarget = null;
      if (!target || target.isConnected === false || typeof target.focus !== "function") return false;
      try {
        target.focus();
        return true;
      } catch (error) {
        return false;
      }
    }

    enqueue(operation) {
      const result = this.hostQueue.then(operation, operation);
      this.hostQueue = result.catch(() => undefined);
      return result;
    }

    isCurrent(generation, ownershipToken = this.ownershipToken) {
      return !this.destroyed && generation === this.generation && ownershipToken === this.ownershipToken;
    }

    isOpen() {
      return !this.destroyed && this.state.phase === "open" && Boolean(this.ownershipToken);
    }

    reportUsage(action, replay = this.activeReplay) {
      if (!replay) return;
      try {
        this.onUsage({
          action,
          replayId: replay.id,
          replay: replay.record,
          at: this.now(),
        });
      } catch (error) {
        // Usage bookkeeping is non-critical and cannot take down playback.
      }
    }

    reportError(error, fallbackMessage, options = {}) {
      const details = options.openFailure
        ? actionableOpenError(error, fallbackMessage)
        : errorDetails(error, fallbackMessage);
      const ownershipLost = isOwnershipError(error);
      this.stopPolling();
      if (options.openFailure || ownershipLost) {
        this.ownershipToken = "";
        this.activeReplay = null;
        this.pendingSeek = null;
        this.clearPoster();
      }
      const phase = options.openFailure || ownershipLost ? "error" : this.state.phase;
      this.commit({
        phase,
        replayId: this.requestedReplay ? this.requestedReplay.id : this.state.replayId,
        title: this.requestedReplay ? this.requestedReplay.title : this.state.title,
        playing: false,
        canSeek: phase === "error" ? false : this.state.canSeek,
        canFrameStep: phase === "error" ? false : this.state.canFrameStep,
        status: details.message,
        error: details,
      }, details.message);
      try { this.onToast(details.message, { tone: "error", code: details.code }); } catch (callbackError) { /* Isolated. */ }
      return false;
    }

    reportRejectedSwitch(error, fallbackMessage) {
      const details = actionableOpenError(error, fallbackMessage);
      this.commit({
        status: `${details.message} The current replay remains open.`,
        error: details,
      }, details.message);
      try { this.onToast(details.message, { tone: "error", code: details.code }); } catch (callbackError) { /* Isolated. */ }
      return false;
    }

    async releaseToken(token) {
      if (!token || !supportsMethod(this.adapter, "close")) return { ok: true, closed: false, ownershipLost: false };
      return this.adapter.close(token);
    }

    async openReplay(replay) {
      if (this.destroyed) return false;
      if (!this.started) this.start();
      this.captureRestoreFocus();
      const normalized = normalizeReplay(replay);
      if (!normalized) {
        if (this.isOpen()) {
          return this.reportRejectedSwitch(
            { code: "INVALID_REPLAY", message: "This replay does not have a stable identity and local media path." },
            "Choose a valid replay.",
          );
        }
        return this.reportError(
          { code: "INVALID_REPLAY", message: "This replay does not have a stable identity and local media path." },
          "Choose a valid replay.",
          { openFailure: true },
        );
      }
      if (!this.adapterAvailable()) {
        if (this.isOpen()) {
          return this.reportRejectedSwitch(
            { code: "SOURCE_MONITOR_UNAVAILABLE", message: "Premiere Source Monitor viewer controls are unavailable in this host." },
            "Premiere Source Monitor viewer controls are unavailable.",
          );
        }
        this.requestedReplay = normalized;
        return this.reportError(
          { code: "SOURCE_MONITOR_UNAVAILABLE", message: "Premiere Source Monitor viewer controls are unavailable in this host." },
          "Premiere Source Monitor viewer controls are unavailable.",
          { openFailure: true },
        );
      }

      const generation = ++this.generation;
      const previousToken = this.ownershipToken;
      const previousReplay = this.activeReplay;
      const previousState = { ...this.state, error: this.state.error ? { ...this.state.error } : null };
      this.requestedReplay = normalized;
      this.stopPolling();
      this.pendingSeek = null;
      this.commit({
        phase: "opening",
        replayId: normalized.id,
        title: normalized.title,
        playing: false,
        positionSeconds: 0,
        durationSeconds: null,
        fps: null,
        canSeek: false,
        canFrameStep: false,
        status: "Opening replay in Premiere Source Monitor…",
        error: null,
      }, `Opening ${normalized.title} in Premiere Source Monitor.`);

      return this.enqueue(async () => {
        if (this.destroyed || generation !== this.generation) return false;
        if (previousToken) {
          try {
            await this.releaseToken(previousToken);
          } catch (error) {
            if (generation === this.generation) {
              const details = errorDetails(error, "Premiere could not release the previous Source Monitor replay.");
              this.requestedReplay = previousReplay;
              this.activeReplay = previousReplay;
              this.ownershipToken = previousToken;
              // The integration may already have staged B's thumbnail. Do not
              // show it alongside the restored A session after a failed release.
              this.clearPoster();
              this.commit({
                ...previousState,
                phase: previousReplay ? "open" : "error",
                playing: false,
                status: `${details.message} The previous replay remains open.`,
                error: details,
              }, details.message);
              try { this.onToast(details.message, { tone: "error", code: details.code }); } catch (callbackError) { /* Isolated. */ }
              return false;
            }
            return false;
          }
          if (this.ownershipToken === previousToken) this.ownershipToken = "";
          if (this.activeReplay === previousReplay) this.activeReplay = null;
        }
        if (this.destroyed || generation !== this.generation) return false;

        let opened = null;
        try {
          opened = await this.adapter.open(normalized.record);
        } catch (error) {
          try { await this.adapter.close(); } catch (cleanupError) { /* Adapter closes only proven ownership. */ }
          if (generation !== this.generation || this.destroyed) return false;
          return this.reportError(
            error,
            "Premiere could not open this replay in Source Monitor. Verify the source file still exists; if it does, re-export it with a Premiere-supported codec and relink it. Oracle does not convert media silently.",
            { openFailure: true },
          );
        }

        const token = cleanText(opened && opened.ownershipToken, 2048);
        const mode = cleanText(opened && opened.mode, 64);
        if (generation !== this.generation || this.destroyed) {
          if (token) {
            try { await this.releaseToken(token); } catch (error) { /* A later generation remains authoritative. */ }
          }
          return false;
        }
        if (mode !== SOURCE_MONITOR_MODE || !token) {
          if (token) {
            try { await this.releaseToken(token); } catch (error) { /* Invalid result is already fatal. */ }
          }
          return this.reportError(
            { code: "INVALID_SOURCE_MONITOR_SESSION", message: "Premiere did not return a verifiable Source Monitor session for this replay." },
            "Premiere did not return a verifiable Source Monitor session.",
            { openFailure: true },
          );
        }

        const durationSeconds = finiteNonNegative(opened.durationSeconds);
        const fps = finitePositive(opened.fps);
        const supports = opened && opened.supports && typeof opened.supports === "object" ? opened.supports : {};
        this.ownershipToken = token;
        this.activeReplay = normalized;
        this.requestedReplay = normalized;
        this.commit({
          phase: "open",
          mode: SOURCE_MONITOR_MODE,
          replayId: normalized.id,
          title: normalized.title,
          playing: false,
          positionSeconds: 0,
          durationSeconds,
          fps,
          canSeek: durationSeconds !== null && supports.seek !== false,
          canFrameStep: fps !== null && supports.frameStep !== false,
          status: "Open in Premiere Source Monitor.",
          error: null,
        }, `${normalized.title} opened in Premiere Source Monitor.`);
        this.reportUsage("open", normalized);
        return true;
      });
    }

    play() {
      return this.setPlaying(true);
    }

    pause() {
      return this.setPlaying(false);
    }

    togglePlayback() {
      return this.setPlaying(!this.state.playing);
    }

    setPlaying(playing) {
      if (!this.isOpen()) return Promise.resolve(false);
      const next = Boolean(playing);
      const generation = this.generation;
      const token = this.ownershipToken;
      if (!next) {
        this.stopPolling();
        this.commit({ playing: false, status: "Pausing in Premiere Source Monitor…", error: null });
      }
      return this.enqueue(async () => {
        if (!this.isCurrent(generation, token) || this.state.phase !== "open") return false;
        try {
          await this.adapter.play(next);
        } catch (error) {
          if (!this.isCurrent(generation, token)) return false;
          return this.reportError(error, `Premiere could not ${next ? "play" : "pause"} this replay.`);
        }
        if (!this.isCurrent(generation, token)) {
          if (next) {
            try { await this.adapter.play(false); } catch (error) { /* The queued source transition will release it. */ }
          }
          return false;
        }
        this.commit({
          playing: next,
          status: next ? "Playing in Premiere Source Monitor." : "Paused in Premiere Source Monitor.",
          error: null,
        }, next ? "Replay playing." : "Replay paused.");
        if (next) {
          this.reportUsage("play");
          this.startPolling();
          void this.pollPosition();
        } else {
          this.stopPolling();
          void this.readPositionOnce(generation, token);
        }
        return true;
      });
    }

    startPolling() {
      if (this.pollTimer !== null || !this.isOpen() || !this.state.playing) return;
      this.pollTimer = this.setInterval(() => { void this.pollPosition(); }, this.pollIntervalMs);
    }

    stopPolling() {
      if (this.pollTimer === null) return;
      this.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    async readPositionOnce(generation = this.generation, token = this.ownershipToken) {
      if (!this.isCurrent(generation, token) || this.state.phase !== "open") return false;
      try {
        const position = finiteNonNegative(await this.adapter.getPosition());
        if (!this.isCurrent(generation, token) || this.state.phase !== "open" || position === null) return false;
        const maximum = this.state.durationSeconds === null ? Number.MAX_SAFE_INTEGER : this.state.durationSeconds;
        this.commit({ positionSeconds: clamp(position, 0, maximum), error: null });
        return true;
      } catch (error) {
        if (!this.isCurrent(generation, token)) return false;
        return this.reportError(error, "Premiere could not read the Source Monitor position.");
      }
    }

    async pollPosition() {
      if (this.pollInFlight || !this.isOpen() || !this.state.playing) return false;
      const generation = this.generation;
      const token = this.ownershipToken;
      this.pollInFlight = true;
      try {
        if (!this.isCurrent(generation, token) || !this.state.playing) return false;
        const position = finiteNonNegative(await this.adapter.getPosition());
        if (!this.isCurrent(generation, token) || !this.state.playing || position === null) return false;
        const maximum = this.state.durationSeconds === null ? Number.MAX_SAFE_INTEGER : this.state.durationSeconds;
        const bounded = clamp(position, 0, maximum);
        const reachedEnd = this.state.durationSeconds !== null && bounded >= this.state.durationSeconds;
        this.commit({
          positionSeconds: bounded,
          playing: reachedEnd ? false : true,
          status: reachedEnd ? "Playback reached the end of the replay." : this.state.status,
          error: null,
        }, reachedEnd ? "Replay playback finished." : "");
        if (reachedEnd) this.stopPolling();
        return true;
      } catch (error) {
        if (!this.isCurrent(generation, token)) return false;
        return this.reportError(error, "Premiere could not read the Source Monitor position.");
      } finally {
        this.pollInFlight = false;
      }
    }

    seek(seconds) {
      if (!this.isOpen() || !this.state.canSeek || this.state.durationSeconds === null) return Promise.resolve(false);
      const numeric = finiteNonNegative(seconds);
      if (numeric === null) return Promise.resolve(false);
      const request = {
        generation: this.generation,
        token: this.ownershipToken,
        seconds: clamp(numeric, 0, this.state.durationSeconds),
      };
      this.pendingSeek = request;
      this.commit({ positionSeconds: request.seconds, error: null });
      if (this.seekDrain) return this.seekDrain;
      this.seekDrain = this.enqueue(async () => {
        let changed = false;
        while (this.pendingSeek) {
          const pending = this.pendingSeek;
          this.pendingSeek = null;
          if (!this.isCurrent(pending.generation, pending.token) || this.state.phase !== "open") continue;
          try {
            const actual = finiteNonNegative(await this.adapter.seek(pending.seconds));
            if (!this.isCurrent(pending.generation, pending.token) || this.state.phase !== "open") continue;
            const position = actual === null ? pending.seconds : clamp(actual, 0, this.state.durationSeconds);
            this.commit({
              positionSeconds: position,
              status: this.state.playing ? "Playing in Premiere Source Monitor." : "Paused in Premiere Source Monitor.",
              error: null,
            });
            changed = true;
          } catch (error) {
            if (this.isCurrent(pending.generation, pending.token)) {
              this.reportError(error, "Premiere could not seek this replay.");
            }
          }
        }
        return changed;
      }).finally(() => {
        this.seekDrain = null;
        if (this.pendingSeek && !this.destroyed) void this.seek(this.pendingSeek.seconds);
      });
      return this.seekDrain;
    }

    seekTo(seconds) {
      return this.seek(seconds);
    }

    stepFrames(delta) {
      if (!this.isOpen() || !this.state.canFrameStep || this.state.fps === null) return Promise.resolve(false);
      const frames = Number(delta);
      if (!Number.isFinite(frames) || frames === 0) return Promise.resolve(false);
      const generation = this.generation;
      const token = this.ownershipToken;
      const frameDuration = 1 / this.state.fps;
      this.stopPolling();
      return this.enqueue(async () => {
        if (!this.isCurrent(generation, token) || this.state.phase !== "open") return false;
        try {
          if (this.state.playing) await this.adapter.play(false);
          if (!this.isCurrent(generation, token)) return false;
          const current = finiteNonNegative(await this.adapter.getPosition());
          if (!this.isCurrent(generation, token)) return false;
          const base = current === null ? this.state.positionSeconds : current;
          const maximum = this.state.durationSeconds === null ? Number.MAX_SAFE_INTEGER : this.state.durationSeconds;
          const target = clamp(base + Math.trunc(frames) * frameDuration, 0, maximum);
          const actual = finiteNonNegative(await this.adapter.seek(target));
          if (!this.isCurrent(generation, token)) return false;
          this.commit({
            playing: false,
            positionSeconds: actual === null ? target : clamp(actual, 0, maximum),
            status: `${Math.abs(Math.trunc(frames))} ${Math.abs(Math.trunc(frames)) === 1 ? "frame" : "frames"} ${frames > 0 ? "forward" : "back"}.`,
            error: null,
          });
          return true;
        } catch (error) {
          if (!this.isCurrent(generation, token)) return false;
          return this.reportError(error, "Premiere could not step this replay by frame.");
        }
      });
    }

    onSeekInput(event) {
      if (!this.isOpen() || !this.state.canSeek) return;
      const value = event && event.target ? event.target.value : this.elements.seek && this.elements.seek.value;
      void this.seek(value);
    }

    onFocusOut(event) {
      const related = event && event.relatedTarget;
      const root = this.elements.root;
      this.focusOwned = Boolean(related && typeof root.contains === "function" && root.contains(related));
    }

    ownsKeyboard(event) {
      if (!this.focusOwned) return false;
      const root = this.elements.root;
      const target = event && event.target;
      if (target && target !== root && typeof root.contains === "function" && !root.contains(target)) return false;
      const active = this.document && this.document.activeElement;
      if (active && active !== root && typeof root.contains === "function" && !root.contains(active)) return false;
      return true;
    }

    onKeyDown(event) {
      if (!this.ownsKeyboard(event) || !event || event.defaultPrevented) return;
      const target = event.target;
      const tagName = cleanText(target && target.tagName, 32).toUpperCase();
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tagName) || Boolean(target && target.isContentEditable)) return;
      let action = null;
      if ((event.key === " " || event.key === "Spacebar" || event.key === "k" || event.key === "K") && !event.repeat) {
        action = () => this.togglePlayback();
      } else if (event.key === "ArrowLeft" && this.state.canFrameStep) {
        action = () => this.stepFrames(-1);
      } else if (event.key === "ArrowRight" && this.state.canFrameStep) {
        action = () => this.stepFrames(1);
      } else if (event.key === "Escape") {
        action = () => this.close("keyboard");
      }
      if (!action) return;
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      void action();
    }

    close(reason = "user") {
      if (this.destroyed) return Promise.resolve(false);
      const generation = ++this.generation;
      const token = this.ownershipToken;
      this.requestedReplay = null;
      this.stopPolling();
      this.pendingSeek = null;
      if (this.state.phase !== "idle") {
        this.commit({ playing: false, status: "Closing replay viewer…", error: null });
      }
      return this.enqueue(async () => {
        if (token) {
          try {
            await this.releaseToken(token);
          } catch (error) {
            if (generation === this.generation && !this.destroyed) {
              return this.reportError(error, "Premiere could not release the Source Monitor replay.");
            }
            return false;
          }
        }
        if (generation !== this.generation || this.destroyed) return false;
        if (this.ownershipToken === token) this.ownershipToken = "";
        this.activeReplay = null;
        this.commit({
          phase: "idle",
          replayId: "",
          title: "No replay open",
          playing: false,
          positionSeconds: 0,
          durationSeconds: null,
          fps: null,
          canSeek: false,
          canFrameStep: false,
          status: reason === "released" ? "Replay source released." : "No replay open.",
          error: null,
        }, reason === "released" ? "Replay viewer released the changed source." : "Replay viewer closed.");
        this.restoreFocus();
        return true;
      });
    }

    releaseReplayIds(values) {
      if (this.destroyed) return Promise.resolve(false);
      const ids = normalizeReplayIds(values);
      const activeId = this.activeReplay && this.activeReplay.id;
      const requestedId = this.requestedReplay && this.requestedReplay.id;
      if ((!activeId || !ids.has(activeId)) && (!requestedId || !ids.has(requestedId))) {
        return Promise.resolve(false);
      }
      return this.close("released");
    }

    destroy() {
      if (this.destroyPromise) return this.destroyPromise;
      this.destroyed = true;
      this.started = false;
      this.focusOwned = false;
      ++this.generation;
      const token = this.ownershipToken;
      this.stopPolling();
      this.pendingSeek = null;
      this.removeListeners();
      this.state = {
        ...this.state,
        phase: "destroyed",
        playing: false,
        status: "Replay viewer closed.",
        error: null,
      };
      this.sync();
      this.restoreFocus();
      this.destroyPromise = this.enqueue(async () => {
        if (token) {
          try { await this.releaseToken(token); } catch (error) { /* Teardown remains idempotent. */ }
        }
        this.ownershipToken = "";
        this.activeReplay = null;
        this.requestedReplay = null;
        if (supportsMethod(this.adapter, "destroy")) {
          try { await this.adapter.destroy(); } catch (error) { /* Adapter teardown cannot resurrect UI. */ }
        }
        return true;
      });
      return this.destroyPromise;
    }
  }

  return {
    DEFAULT_POLL_INTERVAL_MS,
    ReplayViewerController,
    SOURCE_MONITOR_MODE,
    UNSUPPORTED_SOURCE_MONITOR_CONTROLS,
    formatViewerTime,
    normalizeReplayIds,
    replayIdentity,
  };
});
