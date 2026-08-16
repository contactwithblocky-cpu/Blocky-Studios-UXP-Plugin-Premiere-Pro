"use strict";

(function exposeOracleReplayWorkspace(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OracleReplayWorkspace", api);
})(typeof window !== "undefined" ? window : null, function createOracleReplayWorkspaceApi() {
  const VIEW_NAMES = new Set(["all", "recent", "most-used", "collections", "favorites", "archived", "missing"]);

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

  function option(documentRef, value, label) {
    const entry = documentRef.createElement("option");
    entry.value = value;
    entry.textContent = label;
    return entry;
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
      this.filterOpen = false;
      this.frame = null;
      this.restoreFocus = null;
      this.handleClick = (event) => this.onClick(event);
      this.handleInput = () => this.scheduleEmit();
      this.handleKeyDown = (event) => this.onKeyDown(event);
      this.handleDocumentKeyDown = (event) => this.onDocumentKeyDown(event);
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
      this.document.addEventListener("keydown", this.handleDocumentKeyDown, true);
      this.syncTabs();
      this.syncControls();
      this.emit();
    }

    readControls() {
      const value = (name) => {
        const control = this.elements.replayToolbar.querySelector(`[data-replay-filter="${name}"]`);
        return control ? control.value : "";
      };
      const favorite = this.elements.replayToolbar.querySelector('[data-replay-filter="favorite"]');
      return normalizeQueryState({
        view: this.state.view,
        query: this.elements.replaySearch ? this.elements.replaySearch.value : "",
        collectionId: value("collection"),
        tag: value("tag"),
        root: value("root"),
        minimumDurationSeconds: value("duration-min"),
        maximumDurationSeconds: value("duration-max"),
        dateFrom: value("date-from"),
        dateTo: value("date-to"),
        favorite: Boolean(favorite && favorite.checked),
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
      this.state.view = normalized;
      this.syncTabs();
      if (focus) {
        const tab = this.elements.replayToolbar.querySelector(`[data-replay-view="${normalized}"]`);
        if (tab && typeof tab.focus === "function") tab.focus();
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
      this.setFilterOpen(false, false);
    }

    setFilterOpen(open, restore = true) {
      this.filterOpen = Boolean(open);
      const panel = this.elements.replayFilterPanel;
      const toggle = this.elements.replayFilterToggle;
      if (panel) panel.hidden = !this.filterOpen;
      if (toggle) toggle.setAttribute("aria-expanded", this.filterOpen ? "true" : "false");
      if (this.filterOpen) {
        this.restoreFocus = this.document.activeElement;
        const first = panel && panel.querySelector("input:not([disabled]), select:not([disabled]), button:not([disabled])");
        if (first && typeof first.focus === "function") first.focus();
      } else if (restore && this.restoreFocus && typeof this.restoreFocus.focus === "function") {
        this.restoreFocus.focus();
        this.restoreFocus = null;
      }
    }

    resetFilters() {
      for (const control of this.elements.replayToolbar.querySelectorAll("[data-replay-filter]")) {
        if (control.type === "checkbox") control.checked = false;
        else control.value = "";
      }
      if (this.elements.replaySearch) this.elements.replaySearch.value = "";
      this.emit();
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
      if (event.target.closest("[data-replay-filter-toggle]")) {
        event.preventDefault();
        this.setFilterOpen(!this.filterOpen, true);
        return;
      }
      if (event.target.closest("[data-replay-filter-reset]")) {
        event.preventDefault();
        this.resetFilters();
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

    onDocumentKeyDown(event) {
      if (
        !this.filterOpen ||
        event.defaultPrevented ||
        event.key !== "Escape" ||
        !this.ownsInteraction(event)
      ) return;
      event.preventDefault();
      event.stopPropagation();
      this.setFilterOpen(false, true);
    }

    setFacets(facets = {}) {
      this.replaceSelect("collection", "All collections", facets.collections, "id", "name");
      this.replaceSelect("tag", "All tags", facets.tags, "value", "label");
      this.replaceSelect("root", "All path roots", facets.roots, "value", "label");
    }

    replaceSelect(name, emptyLabel, values, valueKey, labelKey) {
      const select = this.elements.replayToolbar.querySelector(`[data-replay-filter="${name}"]`);
      if (!select || !this.document) return;
      const previous = select.value;
      replaceElementChildren(select, [option(this.document, "", emptyLabel)]);
      for (const value of Array.isArray(values) ? values : []) {
        const optionValue = cleanText(typeof value === "string" ? value : value && value[valueKey], 1024);
        const optionLabel = cleanText(typeof value === "string" ? value : value && value[labelKey], 240);
        if (optionValue && optionLabel) select.appendChild(option(this.document, optionValue, optionLabel));
      }
      const hasValues = select.options ? select.options.length > 1 : select.children.length > 1;
      select.disabled = !hasValues;
      select.title = hasValues ? "" : `${emptyLabel.replace(/^All /, "No ")} are available yet.`;
      if (Array.from(select.children).some((entry) => entry.value === previous)) select.value = previous;
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
      this.document.removeEventListener("keydown", this.handleDocumentKeyDown, true);
      if (this.frame !== null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
        else clearTimeout(this.frame);
        this.frame = null;
      }
      this.setFilterOpen(false, false);
    }
  }

  return {
    ReplayWorkspaceController,
    VIEW_NAMES,
    dateBoundary,
    normalizeQueryState,
  };
});
