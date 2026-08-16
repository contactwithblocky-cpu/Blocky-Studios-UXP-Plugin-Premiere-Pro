"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const workspaceApi = require("./src/replays/oracle-replay-workspace.js");

function classList() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); },
  };
}

function control(options = {}) {
  const attributes = new Map();
  return {
    dataset: { ...(options.dataset || {}) },
    value: options.value || "",
    type: options.type || "text",
    checked: Boolean(options.checked),
    disabled: Boolean(options.disabled),
    hidden: Boolean(options.hidden),
    tabIndex: options.tabIndex || 0,
    title: "",
    classList: classList(),
    children: [],
    options: [],
    focusCount: 0,
    focus() { this.focusCount += 1; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    get innerHTML() { return ""; },
    set innerHTML(value) {
      if (String(value) !== "") throw new TypeError("Fake control accepts innerHTML clearing only.");
      this.children = [];
      this.options = this.children;
    },
    appendChild(value) {
      this.children.push(value);
      this.options = this.children;
      return value;
    },
    querySelector() { return null; },
  };
}

function createHarness() {
  const tabs = ["all", "recent", "collections", "archived"]
    .map((view, index) => control({ dataset: { replayView: view }, tabIndex: index ? -1 : 0 }));
  const filters = {
    collection: control({ dataset: { replayFilter: "collection" }, type: "select-one" }),
    tag: control({ dataset: { replayFilter: "tag" }, type: "select-one" }),
    root: control({ dataset: { replayFilter: "root" }, type: "select-one" }),
    "date-from": control({ dataset: { replayFilter: "date-from" }, type: "date" }),
    "date-to": control({ dataset: { replayFilter: "date-to" }, type: "date" }),
    "duration-min": control({ dataset: { replayFilter: "duration-min" }, type: "number" }),
    "duration-max": control({ dataset: { replayFilter: "duration-max" }, type: "number" }),
    favorite: control({ dataset: { replayFilter: "favorite" }, type: "checkbox" }),
  };
  const listeners = new Map();
  const root = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    querySelectorAll(selector) {
      if (selector === "[data-replay-view]") return tabs;
      if (selector === "[data-replay-filter]") return Object.values(filters);
      return [];
    },
    querySelector(selector) {
      const view = selector.match(/^\[data-replay-view="([^"]+)"\]$/);
      if (view) return tabs.find((entry) => entry.dataset.replayView === view[1]) || null;
      const filter = selector.match(/^\[data-replay-filter="([^"]+)"\]$/);
      return filter ? filters[filter[1]] || null : null;
    },
  };
  const documentListeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (documentListeners.get(type) === listener) documentListeners.delete(type);
    },
    createElement(tagName) {
      const entry = control();
      entry.tagName = tagName;
      entry.style = { setProperty() {} };
      return entry;
    },
  };
  const filterPanel = control({ hidden: true });
  filterPanel.querySelector = () => filters.collection;
  const collectionStrip = control({ hidden: true });
  collectionStrip.querySelectorAll = (selector) => selector === "[data-replay-collection]"
    ? collectionStrip.children
    : [];
  const elements = {
    replayToolbar: root,
    replaySearch: control({ type: "search" }),
    replaySearchClear: control({ type: "button", disabled: true }),
    replayFilterToggle: control({ type: "button" }),
    replayFilterPanel: filterPanel,
    replayResultSummary: control(),
    replayCollectionStrip: collectionStrip,
    replayArchiveAttentionCount: control({ hidden: true }),
  };
  const queries = [];
  const controller = new workspaceApi.ReplayWorkspaceController(elements, {
    document,
    onQueryChange: (query) => queries.push(query),
  });
  return { controller, elements, tabs, filters, listeners, documentListeners, document, queries };
}

test("Replay query normalization is bounded and preserves supported view semantics", () => {
  const normalized = workspaceApi.normalizeQueryState({
    view: "ARCHIVED",
    query: `  hero ${"x".repeat(400)}  `,
    minimumDurationSeconds: "0.64",
    maximumDurationSeconds: "12.08",
    dateFrom: "2026-07-14",
    dateTo: "2026-07-15",
    favorite: true,
  });
  assert.equal(normalized.view, "archived");
  assert.equal(normalized.query.length, 240);
  assert.equal(normalized.minimumDurationMs, 640);
  assert.equal(normalized.maximumDurationMs, 12080);
  assert.equal(normalized.dateFrom, new Date("2026-07-14T00:00:00.000").toISOString());
  assert.equal(normalized.dateTo, new Date("2026-07-15T23:59:59.999").toISOString());
  assert.equal(normalized.favorite, true);
  assert.equal(workspaceApi.normalizeQueryState({ view: "unsafe" }).view, "all");
  assert.equal(workspaceApi.normalizeQueryState({ minimumDurationMs: null }).minimumDurationMs, null);
});

test("replay workspace uses four APG tabs, collection navigation, and deterministic cleanup", () => {
  const harness = createHarness();
  harness.controller.start();
  assert.equal(harness.queries.length, 1);
  assert.deepEqual([...harness.listeners.keys()].sort(), ["change", "click", "input", "keydown"]);
  assert.equal(harness.documentListeners.has("keydown"), false);

  harness.controller.selectView("recent", true);
  assert.equal(harness.tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(harness.tabs[1].tabIndex, 0);
  assert.equal(harness.tabs[1].focusCount, 1);
  assert.equal(harness.queries.at(-1).view, "recent");

  let prevented = false;
  harness.controller.onKeyDown({
    target: { closest: () => harness.tabs[1] },
    key: "End",
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(harness.queries.at(-1).view, "archived");

  harness.controller.setFacets({
    collections: [{ id: "collection-1", name: "Hero shots" }],
    tags: [{ value: "hero", label: "hero" }],
    roots: [{ value: "D:\\Blocky Studios Exports", label: "D:\\Blocky Studios Exports" }],
  });
  assert.equal(harness.elements.replayCollectionStrip.children.length, 2);
  assert.equal(harness.elements.replayCollectionStrip.children[1].children[1].textContent, "Hero shots");

  harness.controller.setResultCount(7, 20);
  assert.equal(harness.elements.replayResultSummary.textContent, "7 of 20 replays");
  harness.controller.destroy();
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.documentListeners.size, 0);
});
