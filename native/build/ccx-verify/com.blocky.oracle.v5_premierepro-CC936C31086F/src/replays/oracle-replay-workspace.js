"use strict";

(function exposeOracleReplayWorkspace(globalScope, factory) {
  const api = factory(globalScope);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleReplayWorkspace", api);
})(typeof window !== "undefined" ? window : null, function createOracleReplayWorkspaceApi(globalScope) {
  const VIEW_NAMES = new Set(["all", "recent", "collections", "archived"]);

  function cleanText(value, maximum = 512) {
    return String(value ?? "").trim().slice(0, maximum);
  }

  function finiteSeconds(value) {
    if (value === "" || value === null || value === undefined) return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  }

  function dateBoundary(value, endOfDay) {
    const text = cleanText(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function normalizeQueryState(value = {}) {
    const view = cleanText(value.view, 32).toLocaleLowerCase("en-US");
    const minimumSource = value.minimumDurationSeconds !== undefined
      ? value.minimumDurationSeconds
      : value.minimumDurationMs === null || value.minimumDurationMs === undefined
        ? null
        : Number(value.minimumDurationMs) / 1000;
    const maximumSource = value.maximumDurationSeconds !== undefined
      ? value.maximumDurationSeconds
      : value.maximumDurationMs === null || value.maximumDurationMs === undefined
        ? null
        : Number(value.maximumDurationMs) / 1000;
    const minimumDurationMs = finiteSeconds(minimumSource);
    const maximumDurationMs = finiteSeconds(maximumSource);
    return {
      view: VIEW_NAMES.has(view) ? view : "all",
      query: cleanText(value.query, 240),
      collectionId: cleanText(value.collectionId, 128),
      tag: cleanText(value.tag, 128),
      root: cleanText(value.root, 1024),
      minimumDurationMs,
      maximumDurationMs,
      dateFrom: dateBoundary(value.dateFrom, false),
      dateTo: dateBoundary(value.dateTo, true),
      favorite: value.favorite === true ? true : null,
    };
  }

  function replaceElementChildren(element, nodes = []) {
    element.innerHTML = "";
    for (const node of nodes) element.appendChild(node);
  }

  class ReplayWorkspaceController {
    constructor(elements, options = {}) {
      this.elements = elements;
      this.document = options.document || (typeof document !== "undefined" ? document : null);
      this.interactionRoot = options.root || elements.replayScroller || elements.replayToolbar || null;
      this.onQueryChange = typeof options.onQueryChange === "function"
        ? options.onQueryChange
        : () => undefined;
      this.state = normalizeQueryState({ view: "all" });
      this.started = false;
      this.destroyed = false;
      this.frame = null;
      this.handleClick = (event) => this.onClick(event);
      this.handleInput = () => this.scheduleEmit();
      this.handleKeyDown = (event) => this.onKeyDown(event);
    }

    ownsInteraction(event) {
      const root = this.interactionRoot;
      if (!root || typeof root.contains !== "function") return true;
      const target = event && event.target;
      if (target) return target === root || root.contains(target);
      const active = this.document && this.document.activeElement;
      return !active || active === root || root.contains(active);
    }

    start() {
      if (this.started || this.destroyed) return;
      this.started = true;
      const root = this.elements.replayToolbar;
      root.addEventListener("click", this.handleClick);
      root.addEventListener("input", this.handleInput);
      root.addEventListener("change", this.handleInput);
      root.addEventListener("keydown", this.handleKeyDown);
      this.syncTabs();
      this.syncControls();
      this.emit();
    }

    readControls() {
      return normalizeQueryState({
        view: this.state.view,
        query: this.elements.replaySearch ? this.elements.replaySearch.value : "",
        collectionId: this.state.view === "collections" ? this.state.collectionId : "",
      });
    }

    emit() {
      if (this.destroyed) return;
      this.state = this.readControls();
      if (this.elements.replaySearchClear) {
        this.elements.replaySearchClear.disabled = !this.state.query;
      }
      this.onQueryChange({ ...this.state });
    }

    scheduleEmit() {
      if (this.frame !== null || this.destroyed) return;
      const schedule = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 0);
      this.frame = schedule(() => {
        this.frame = null;
        this.emit();
      });
    }

    selectView(view, focus = false) {
      const normalized = cleanText(view, 32).toLocaleLowerCase("en-US");
      if (!VIEW_NAMES.has(normalized)) return;
      const previousView = this.state.view;
      this.state.view = normalized;
      if (normalized !== "collections") this.state.collectionId = "";
      this.syncTabs();
      this.syncCollections();
      if (focus) {
        const tab = this.elements.replayToolbar.querySelector(`[data-replay-view="${normalized}"]`);
        if (tab && typeof tab.focus === "function") tab.focus();
      }
      const telemetry = globalScope && Reflect.get(globalScope, "oraclePlatformTelemetry");
      if (previousView !== normalized && telemetry && typeof telemetry.tabSwitch === "function") {
        telemetry.tabSwitch({
          root: this.interactionRoot && this.interactionRoot.closest
            ? this.interactionRoot.closest("[data-oracle-panel-root], .oracle-panel") || this.interactionRoot
            : this.interactionRoot,
          panelId: this.interactionRoot && this.interactionRoot.dataset && this.interactionRoot.dataset.oraclePanelRoot || "oracleReplaysPanel",
          group: "replay-view",
          from: previousView,
          to: normalized,
          trigger: focus ? "keyboard" : "interaction-or-controller",
        });
      }
      this.emit();
    }

    syncTabs() {
      for (const tab of this.elements.replayToolbar.querySelectorAll("[data-replay-view]")) {
        const active = tab.dataset.replayView === this.state.view;
        tab.setAttribute("aria-selected", active ? "true" : "false");
        tab.tabIndex = active ? 0 : -1;
        tab.classList.toggle("is-active", active);
      }
    }

    syncControls() {
      if (this.elements.replaySearch) this.elements.replaySearch.value = this.state.query;
      if (this.elements.replaySearchClear) this.elements.replaySearchClear.disabled = !this.state.query;
      this.syncCollections();
    }

    onClick(event) {
      const view = event.target.closest("[data-replay-view]");
      if (view) {
        event.preventDefault();
        this.selectView(view.dataset.replayView);
        return;
      }
      if (event.target.closest("[data-replay-search-clear]")) {
        event.preventDefault();
        this.elements.replaySearch.value = "";
        this.elements.replaySearch.focus();
        this.emit();
        return;
      }
      const collection = event.target.closest("[data-replay-collection]");
      if (collection) {
        event.preventDefault();
        const previousView = this.state.view;
        this.state.view = "collections";
        this.state.collectionId = cleanText(collection.dataset.replayCollection, 128);
        this.syncTabs();
        this.syncCollections();
        const telemetry = globalScope && Reflect.get(globalScope, "oraclePlatformTelemetry");
        if (previousView !== "collections" && telemetry && typeof telemetry.tabSwitch === "function") {
          telemetry.tabSwitch({
            root: this.interactionRoot && this.interactionRoot.closest
              ? this.interactionRoot.closest("[data-oracle-panel-root], .oracle-panel") || this.interactionRoot
              : this.interactionRoot,
            panelId: this.interactionRoot && this.interactionRoot.dataset && this.interactionRoot.dataset.oraclePanelRoot || "oracleReplaysPanel",
            group: "replay-view",
            from: previousView,
            to: "collections",
            trigger: "collection-control",
          });
        }
        this.emit();
      }
    }

    onKeyDown(event) {
      const tab = event.target.closest && event.target.closest("[data-replay-view]");
      if (!tab) return;
      const tabs = Array.from(this.elements.replayToolbar.querySelectorAll("[data-replay-view]"));
      const current = tabs.indexOf(tab);
      if (current < 0) return;
      let next = null;
      if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      this.selectView(tabs[next].dataset.replayView, true);
    }

    setFacets(facets = {}) {
      this.setCollections(facets.collections);
    }

    setCollections(values = []) {
      const strip = this.elements.replayCollectionStrip;
      if (!strip || !this.document) return;
      const collections = Array.isArray(values) ? values : [];
      const nodes = [];
      const overview = this.document.createElement("button");
      overview.type = "button";
      overview.className = "oracle-button oracle-button--segment replay-collection-nav";
      overview.dataset.replayCollection = "";
      overview.textContent = "Overview";
      nodes.push(overview);
      for (const value of collections) {
        const id = cleanText(value && value.id, 128);
        const name = cleanText(value && value.name, 240);
        if (!id || !name) continue;
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "oracle-button oracle-button--segment replay-collection-nav";
        button.dataset.replayCollection = id;
        if (value.color) button.style.setProperty("--replay-collection-color", cleanText(value.color, 32));
        const dot = this.document.createElement("span");
        dot.className = "replay-collection-nav__dot";
        dot.setAttribute("aria-hidden", "true");
        const label = this.document.createElement("span");
        label.textContent = name;
        button.appendChild(dot);
        button.appendChild(label);
        nodes.push(button);
      }
      replaceElementChildren(strip, nodes);
      this.syncCollections();
    }

    syncCollections() {
      const strip = this.elements.replayCollectionStrip;
      if (!strip) return;
      strip.hidden = this.state.view !== "collections";
      for (const button of strip.querySelectorAll("[data-replay-collection]")) {
        const active = this.state.view === "collections" && button.dataset.replayCollection === this.state.collectionId;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
    }

    setArchiveAttentionCount(value) {
      const count = Math.max(0, Number(value) || 0);
      const badge = this.elements.replayArchiveAttentionCount;
      if (!badge) return;
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.setAttribute("aria-label", `${count} unresolved ${count === 1 ? "replay" : "replays"}`);
    }

    setResultCount(visible, total) {
      const count = Math.max(0, Number(visible) || 0);
      const all = Math.max(0, Number(total) || 0);
      if (this.elements.replayResultSummary) {
        this.elements.replayResultSummary.textContent = count === all
          ? `${count} ${count === 1 ? "replay" : "replays"}`
          : `${count} of ${all} replays`;
      }
    }

    destroy() {
      if (!this.started) return;
      this.started = false;
      this.destroyed = true;
      const root = this.elements.replayToolbar;
      root.removeEventListener("click", this.handleClick);
      root.removeEventListener("input", this.handleInput);
      root.removeEventListener("change", this.handleInput);
      root.removeEventListener("keydown", this.handleKeyDown);
      if (this.frame !== null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
        else clearTimeout(this.frame);
        this.frame = null;
      }
    }
  }

  return {
    ReplayWorkspaceController,
    VIEW_NAMES,
    dateBoundary,
    normalizeQueryState,
  };
});
