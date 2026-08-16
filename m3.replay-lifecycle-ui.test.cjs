"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const lifecycleApi = require("./src/replays/oracle-replay-lifecycle-ui.js");

const root = __dirname;
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const lifecycleSource = fs.readFileSync(
  path.join(root, "src", "replays", "oracle-replay-lifecycle-ui.js"),
  "utf8",
);
const css = fs.readFileSync(path.join(root, "styles", "overdrive-m3.css"), "utf8");

const REPLAY_CONTEXT_ACTIONS = Object.freeze([
  "play",
  "source-monitor",
  "rename-display",
  "collections",
  "tags",
  "reveal",
  "relink",
  "delete",
]);

function dataProperty(attribute) {
  return String(attribute)
    .slice(5)
    .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function createClassList(node) {
  const values = new Set();
  const sync = () => { node._className = [...values].join(" "); };
  return {
    values,
    add(...names) {
      names.filter(Boolean).forEach((name) => values.add(String(name)));
      sync();
    },
    remove(...names) {
      names.forEach((name) => values.delete(String(name)));
      sync();
    },
    contains(name) { return values.has(String(name)); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(String(name));
      else values.delete(String(name));
      sync();
      return enabled;
    },
    replaceFrom(value) {
      values.clear();
      String(value || "").split(/\s+/).filter(Boolean).forEach((name) => values.add(name));
      sync();
    },
    [Symbol.iterator]() { return values[Symbol.iterator](); },
  };
}

function createStyle() {
  const values = new Map();
  return {
    setProperty(name, value) { values.set(String(name), String(value)); },
    removeProperty(name) { values.delete(String(name)); },
    getPropertyValue(name) { return values.get(String(name)) || ""; },
    values,
  };
}

function selectorMatches(node, selector) {
  let value = String(selector || "").trim();
  if (!value) return false;
  if (value.includes(",")) return value.split(",").some((part) => selectorMatches(node, part));

  if (value.includes(":not([disabled])") && node.disabled) return false;
  if (value.includes(':not([tabindex="-1"])') && String(node.tabIndex) === "-1") return false;
  value = value.replace(/:not\(\[[^\]]+\]\)/g, "");

  const tag = value.match(/^[a-z][a-z0-9-]*/i);
  if (tag && node.tagName !== tag[0].toUpperCase()) return false;
  const className = value.match(/\.([a-z0-9_-]+)/i);
  if (className && !node.classList.contains(className[1])) return false;

  for (const match of value.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
    const attribute = match[1];
    const expected = match[2];
    let actual;
    if (attribute.startsWith("data-")) actual = node.dataset[dataProperty(attribute)];
    else if (attribute === "name") actual = node.name;
    else if (attribute === "role") actual = node.getAttribute("role");
    else if (attribute === "tabindex") actual = node.tabIndex;
    else if (attribute === "disabled") actual = node.disabled ? "" : undefined;
    else actual = node.getAttribute(attribute);
    if (actual === undefined || actual === null || (expected !== undefined && String(actual) !== expected)) {
      return false;
    }
  }
  return true;
}

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.dataset = {};
    this.style = createStyle();
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = createClassList(this);
    this._className = "";
    this._textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.name = "";
    this.title = "";
    this.type = "";
    this.tabIndex = 0;
    this.pointerCapture = null;
    this.rect = { left: 0, top: 0, width: 100, height: 40, bottom: 40 };
  }

  get className() { return this._className; }
  set className(value) { this.classList.replaceFrom(value); }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._textContent = String(value === undefined || value === null ? "" : value);
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }

  get innerHTML() { return ""; }

  set innerHTML(value) {
    if (String(value) !== "") throw new TypeError("Fake DOM supports innerHTML clearing only.");
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._textContent = "";
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    if (!(node instanceof FakeNode)) throw new TypeError("Fake DOM accepts element nodes only.");
    if (node.parentElement) {
      node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
    }
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
      }
      node.parentElement = this;
      this.children.unshift(node);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (String(name).startsWith("data-")) this.dataset[dataProperty(name)] = String(value);
    if (name === "tabindex") this.tabIndex = Number(value);
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  addEventListener(type, listener) { this.listeners.set(String(type), listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(String(type)) === listener) this.listeners.delete(String(type));
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selectorMatches(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    let current = this;
    while (current) {
      if (selectorMatches(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { ...this.rect }; }
  setPointerCapture(pointerId) { this.pointerCapture = pointerId; }
  releasePointerCapture(pointerId) {
    if (this.pointerCapture === pointerId) this.pointerCapture = null;
  }
}

function createDocument() {
  const listeners = new Map();
  const ids = new Map();
  const document = {
    activeElement: null,
    hitTarget: null,
    listeners,
    ids,
    createElement(tagName) { return new FakeNode(tagName, document); },
    addEventListener(type, listener) { listeners.set(String(type), listener); },
    removeEventListener(type, listener) {
      if (listeners.get(String(type)) === listener) listeners.delete(String(type));
    },
    getElementById(id) { return ids.get(String(id)) || null; },
    elementFromPoint() { return document.hitTarget; },
  };
  return document;
}

function installAnimationHarness() {
  let nextId = 1;
  const frames = new Map();
  const canceled = new Set();
  global.requestAnimationFrame = (callback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  };
  global.cancelAnimationFrame = (id) => {
    canceled.add(id);
    frames.delete(id);
  };
  return { frames, canceled };
}

function createLifecycleHarness(callbacks = {}) {
  const document = createDocument();
  global.document = document;
  const animation = installAnimationHarness();
  const make = (tag = "div") => document.createElement(tag);
  const elements = {
    replayLifecycleBackdrop: make(),
    replayLifecycleDialog: make("section"),
    replayLifecycleKicker: make("p"),
    replayLifecycleTitle: make("h2"),
    replayLifecycleClose: make("button"),
    replayLifecycleBody: make("div"),
    replayLifecycleError: make("p"),
    replayLifecycleSecondary: make("button"),
    replayLifecycleCancel: make("button"),
    replayLifecycleApply: make("button"),
  };
  elements.replayLifecycleBackdrop.hidden = true;
  elements.replayLifecycleDialog.append(
    elements.replayLifecycleKicker,
    elements.replayLifecycleTitle,
    elements.replayLifecycleClose,
    elements.replayLifecycleBody,
    elements.replayLifecycleError,
    elements.replayLifecycleSecondary,
    elements.replayLifecycleCancel,
    elements.replayLifecycleApply,
  );
  elements.replayLifecycleBackdrop.append(elements.replayLifecycleDialog);
  const controller = new lifecycleApi.ReplayLifecycleDialogController(elements, callbacks);
  return { controller, elements, document, animation };
}

function replay(id = "replay-1", extension = ".mov") {
  return {
    id,
    title: `Replay ${id}`,
    filepath: `D:\\Disposable Blocky Studios Tests\\Replay ${id}${extension}`,
    canonicalPath: `D:\\Disposable Blocky Studios Tests\\Replay ${id}${extension}`,
  };
}

test("M3 collection drafts stay manual when optional smart fields are blank and close date bounds include the full day", () => {
  assert.deepEqual(lifecycleApi.normalizeCollectionDraft({}), {
    name: "",
    color: "#D948D7",
    smartRules: null,
  });
  assert.equal(lifecycleApi.normalizeCollectionDraft({
    name: "No duration",
    minimumDurationSeconds: "",
    maximumDurationSeconds: "",
  }).smartRules, null);

  const dateOnly = lifecycleApi.normalizeCollectionDraft({ name: "July 15", dateTo: "2026-07-15" });
  assert.deepEqual(dateOnly.smartRules.rules, [
    { field: "date", operator: "onOrBefore", value: "2026-07-15T23:59:59.999Z" },
  ]);
  const range = lifecycleApi.normalizeCollectionDraft({
    name: "July",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-15",
  });
  assert.equal(range.smartRules.rules[0].from, "2026-07-01T00:00:00.000Z");
  assert.equal(range.smartRules.rules[0].to, "2026-07-15T23:59:59.999Z");
});

test("M3 source-name validation accepts every supported video extension while preserving it", () => {
  for (const extension of [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"]) {
    const result = lifecycleApi.validateSourceStem("Hero Final", `D:\\Renders\\Hero${extension.toUpperCase()}`);
    assert.deepEqual(result, {
      ok: true,
      stem: "Hero Final",
      extension,
      filename: `Hero Final${extension}`,
    });
  }
  assert.equal(lifecycleApi.validateSourceStem("Hero", "D:\\Renders\\Hero.txt").ok, false);
  assert.equal(lifecycleApi.validateSourceStem("Hero/Final", "D:\\Renders\\Hero.mov").ok, false);
});

test("M3 modal chrome clears a prior rename blocker and smart membership is visibly rule-driven", () => {
  const harness = createLifecycleHarness();
  harness.controller.open("rename-source", {
    replays: [replay()],
    premiereReferenceCount: 1,
  });
  assert.equal(harness.elements.replayLifecycleApply.disabled, true);
  assert.match(harness.elements.replayLifecycleApply.title, /Premiere currently references/);

  harness.controller.open("collections", {
    replays: [replay()],
    sharedCollectionIds: ["manual", "smart"],
    collections: [
      { id: "manual", name: "Manual", color: "#123456", smartRules: null },
      {
        id: "smart",
        name: "Favorites",
        color: "#D948D7",
        smartRules: { match: "all", rules: [{ field: "favorite", operator: "is", value: true }] },
      },
    ],
  });
  assert.equal(harness.elements.replayLifecycleApply.disabled, false);
  assert.equal(harness.elements.replayLifecycleApply.title, "");
  const manual = harness.elements.replayLifecycleBody.querySelector('[data-collection-id="manual"]');
  const smart = harness.elements.replayLifecycleBody.querySelector('[data-collection-id="smart"]');
  assert.equal(manual.querySelector("input").disabled, false);
  assert.equal(smart.querySelector("input").disabled, true);
  assert.equal(smart.title, "Smart collection membership is controlled by its visible rules.");
  assert.match(smart.textContent, /Rule-driven/);
  assert.match(smart.textContent, /Match all: Favorite is yes/);
  harness.controller.destroy();
});

test("M3 ambiguous relink confirmation exposes the exact source, candidate, score, and reason before apply", () => {
  const harness = createLifecycleHarness();
  const source = replay("source");
  harness.controller.open("relink", {
    replays: [source],
    relinkSelection: {
      ambiguous: true,
      assignments: [{
        replayId: source.id,
        newPath: "E:\\Recovered Blocky Studios\\Replay source.mov",
        candidate: { canonicalPath: "E:\\Recovered Blocky Studios\\Replay source.mov" },
        score: 55,
        reasons: ["matching-name-stem", "matching-extension"],
        ambiguous: true,
        ambiguityReason: "Two candidates finished within the five-point ambiguity window.",
      }],
    },
  });

  const assignment = harness.elements.replayLifecycleBody.querySelector('[data-relink-assignment="source"]');
  assert.ok(assignment);
  assert.match(assignment.textContent, /Replay source/);
  assert.match(assignment.textContent, /D:\\Disposable Blocky Studios Tests\\Replay source\.mov/);
  assert.match(assignment.textContent, /E:\\Recovered Blocky Studios\\Replay source\.mov/);
  assert.match(assignment.textContent, /Score 55/);
  assert.match(assignment.textContent, /Two candidates finished within the five-point ambiguity window/);
  assert.match(assignment.textContent, /matching name stem, matching extension/);
  const confirmation = harness.elements.replayLifecycleBody.querySelector('[name="confirmAmbiguous"]');
  assert.ok(confirmation);
  assert.equal(harness.elements.replayLifecycleApply.disabled, true);
  confirmation.checked = true;
  harness.controller.onBodyChange({ target: confirmation });
  assert.equal(harness.elements.replayLifecycleApply.disabled, false);

  harness.controller.open("relink", {
    replays: [source],
    relinkSelection: {
      ambiguous: true,
      assignments: [{ replayId: source.id, newPath: "E:\\Recovered Blocky Studios\\Replay source.mov", ambiguous: true }],
    },
  });
  assert.match(harness.elements.replayLifecycleBody.textContent, /Score unavailable/);
  assert.match(harness.elements.replayLifecycleBody.textContent, /cannot apply this ambiguous relink/);
  assert.equal(harness.elements.replayLifecycleBody.querySelector('[name="confirmAmbiguous"]'), null);
  assert.equal(harness.elements.replayLifecycleApply.disabled, true);
  assert.throws(() => harness.controller.serialize(), /details are incomplete/);
  harness.controller.destroy();
});

test("M3 existing smart collections show rule details and save every supported rule field and operator", async () => {
  const calls = [];
  const collection = {
    id: "smart",
    name: "Review queue",
    color: "#D948D7",
    smartRules: {
      match: "any",
      rules: [
        { field: "date", operator: "withinDays", source: "modifiedAt", value: 14 },
        { field: "duration", operator: "between", minimumMs: 1000, maximumMs: 9000 },
        { field: "root", operator: "is", value: "D:\\Blocky Studios Replays" },
        { field: "tag", operator: "notContains", value: "reject" },
        { field: "favorite", operator: "is", value: false },
        { field: "missing", operator: "is", value: true },
        { field: "name", operator: "startsWith", value: "Hero" },
      ],
    },
  };
  const harness = createLifecycleHarness({
    async onCollectionCommand(command, payload) {
      calls.push({ command, payload });
      return [collection];
    },
  });
  harness.controller.open("collection-manager", { replays: [], collections: [collection] });
  const collectionRow = harness.elements.replayLifecycleBody.querySelector('[data-collection-id="smart"]');
  assert.ok(collectionRow);
  assert.match(collectionRow.textContent, /Smart collection · Match any · 7 rules/);
  assert.match(collectionRow.textContent, /Source modified date within the last 14 days/);
  assert.match(collectionRow.textContent, /Duration between 1s and 9s/);
  assert.match(collectionRow.textContent, /Path root is direct parent D:\\Blocky Studios Replays/);
  assert.match(collectionRow.textContent, /Tag does not contain reject/);
  assert.match(collectionRow.textContent, /Favorite is no/);
  assert.match(collectionRow.textContent, /Missing media is yes/);
  assert.match(collectionRow.textContent, /Name starts with Hero/);

  const toggle = collectionRow.querySelector('[data-lifecycle-command="smart-rules-toggle"]');
  const editor = collectionRow.querySelector("[data-smart-rules-editor]");
  assert.equal(editor.hidden, true);
  await harness.controller.handleBodyCommand({ target: toggle, preventDefault() {} });
  assert.equal(editor.hidden, false);

  const expectedOperators = {
    date: ["before", "after", "onOrBefore", "onOrAfter", "between", "withinDays"],
    duration: ["lessThan", "atMost", "greaterThan", "atLeast", "between"],
    root: ["is", "isUnder"],
    tag: ["contains", "notContains"],
    favorite: ["is"],
    missing: ["is"],
    name: ["contains", "startsWith", "equals"],
  };
  const add = editor.querySelector('[data-lifecycle-command="smart-rule-add"]');
  await harness.controller.handleBodyCommand({ target: add, preventDefault() {} });
  const rows = editor.querySelectorAll("[data-smart-rule-row]");
  assert.equal(rows.length, 8);
  const added = rows[rows.length - 1];
  const fieldControl = added.querySelector('[name="smartRuleField"]');
  for (const [fieldName, operators] of Object.entries(expectedOperators)) {
    fieldControl.value = fieldName;
    harness.controller.onBodyChange({ target: fieldControl });
    assert.deepEqual(
      added.querySelector('[name="smartRuleOperator"]').querySelectorAll("option").map((option) => option.value),
      operators,
    );
  }
  fieldControl.value = "date";
  harness.controller.onBodyChange({ target: fieldControl });
  const operatorControl = added.querySelector('[name="smartRuleOperator"]');
  operatorControl.value = "withinDays";
  harness.controller.onBodyChange({ target: operatorControl });
  added.querySelector('[name="smartRuleDateSource"]').value = "firstSeenAt";
  added.querySelector('[name="smartRuleDays"]').value = "7";

  const save = collectionRow.querySelector('[data-lifecycle-command="collection-save"]');
  await harness.controller.handleBodyCommand({ target: save, preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "collection-save");
  assert.equal(calls[0].payload.id, "smart");
  assert.equal(calls[0].payload.draft.smartRules.match, "any");
  assert.deepEqual(calls[0].payload.draft.smartRules.rules.slice(0, 7), collection.smartRules.rules);
  assert.deepEqual(calls[0].payload.draft.smartRules.rules[7], {
    field: "date",
    operator: "withinDays",
    source: "firstSeenAt",
    value: 7,
  });
  harness.controller.destroy();
});

test("M3 delete UI defaults to archive, opts into danger explicitly, and renders partial recycle results", () => {
  const harness = createLifecycleHarness();
  const replays = [replay("one"), replay("two")];
  harness.controller.open("delete", { replays, allMissing: false });
  const recycle = harness.elements.replayLifecycleBody.querySelector('[name="recycle"]');
  assert.ok(recycle);
  assert.equal(recycle.checked, false);
  assert.equal(harness.controller.serialize().recycle, false);
  assert.equal(harness.elements.replayLifecycleApply.textContent, "Archive");
  assert.equal(harness.elements.replayLifecycleApply.classList.contains("oracle-button--primary"), true);
  assert.equal(harness.elements.replayLifecycleApply.classList.contains("oracle-button--danger"), false);

  recycle.checked = true;
  harness.controller.onBodyChange({ target: recycle });
  assert.equal(harness.controller.serialize().recycle, true);
  assert.equal(harness.elements.replayLifecycleApply.textContent, "Archive and recycle 2 sources");
  assert.equal(harness.elements.replayLifecycleApply.classList.contains("oracle-button--danger"), true);

  harness.controller.context.operationResult = {
    ok: false,
    partial: true,
    counts: { total: 2, success: 1, failed: 1, canceled: 0, skipped: 0 },
    items: [
      { replayId: "one", name: "Replay one", status: "success", path: replays[0].filepath },
      { replayId: "two", name: "Replay two", status: "failed", code: "ACCESS_DENIED" },
    ],
  };
  harness.controller.render();
  assert.equal(harness.elements.replayLifecycleApply.textContent, "Done");
  assert.equal(harness.elements.replayLifecycleCancel.hidden, true);
  assert.match(harness.elements.replayLifecycleBody.textContent, /1 succeeded · 1 failed · 0 canceled · 0 skipped/);
  assert.match(harness.elements.replayLifecycleBody.textContent, /ACCESS_DENIED/);
  assert.deepEqual(harness.controller.serialize(), { done: true });
  harness.controller.destroy();

  const unavailable = createLifecycleHarness();
  unavailable.controller.open("delete", { replays: [replay("offline")], nativeRecycleAvailable: false });
  const disabledRecycle = unavailable.elements.replayLifecycleBody.querySelector('[name="recycle"]');
  assert.equal(disabledRecycle.disabled, true);
  assert.match(unavailable.elements.replayLifecycleBody.textContent, /Recycle Bin.*unavailable/);
  assert.equal(unavailable.elements.replayLifecycleApply.textContent, "Archive");
  unavailable.controller.destroy();
});

test("M3 pending focus frames are canceled on close and destroy", () => {
  const first = createLifecycleHarness();
  first.controller.open("rename-display", { replays: [replay()] });
  const closeFrame = first.controller.focusFrame;
  assert.equal(first.animation.frames.has(closeFrame), true);
  first.controller.close(false);
  assert.equal(first.controller.focusFrame, null);
  assert.equal(first.animation.canceled.has(closeFrame), true);

  const second = createLifecycleHarness();
  second.controller.open("rename-display", { replays: [replay("two")] });
  const destroyFrame = second.controller.focusFrame;
  second.controller.destroy();
  assert.equal(second.controller.focusFrame, null);
  assert.equal(second.animation.canceled.has(destroyFrame), true);
  assert.equal(second.document.listeners.size, 0);
});

test("M3 six-dot collection reorder commits the exact before/after order without invoking file work", async () => {
  const calls = [];
  const harness = createLifecycleHarness({
    async onCollectionCommand(command, payload) {
      calls.push({ command, payload });
      return payload.order.map((id) => ({ id, name: id.toUpperCase(), manualOrder: [] }));
    },
  });
  harness.controller.open("collection-manager", {
    replays: [],
    collections: [
      { id: "a", name: "A", manualOrder: [] },
      { id: "b", name: "B", manualOrder: [] },
      { id: "c", name: "C", manualOrder: [] },
    ],
  });
  const rows = harness.elements.replayLifecycleBody.querySelectorAll("[data-collection-id]");
  const source = rows.find((row) => row.dataset.collectionId === "a");
  const target = rows.find((row) => row.dataset.collectionId === "b");
  const handle = source.querySelector("[data-collection-reorder-handle]");
  target.rect = { left: 0, top: 100, width: 200, height: 40, bottom: 140 };
  harness.document.hitTarget = target;
  let prevented = 0;
  const event = (overrides = {}) => ({
    button: 0,
    isPrimary: true,
    pointerId: 41,
    clientX: 20,
    clientY: 130,
    target: handle,
    preventDefault() { prevented += 1; },
    stopPropagation() {},
    ...overrides,
  });
  assert.equal(harness.controller.beginCollectionReorder(event()), true);
  assert.equal(handle.pointerCapture, 41);
  assert.equal(harness.controller.updateCollectionReorder(event()), true);
  assert.equal(harness.controller.collectionDrag.placement, "after");
  assert.equal(harness.controller.finishCollectionReorder(event(), false), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ command: "collection-reorder", payload: { order: ["b", "a", "c"] } }]);
  assert.ok(prevented >= 2);
  assert.equal(handle.pointerCapture, null);
  assert.equal(harness.controller.busy, false);
  assert.doesNotMatch(lifecycleSource, /startNativeFileDrag|DoDragDrop|IFileOperation/);
  harness.controller.destroy();
});

test("M9 collection reorder handles support keyboard transactions, focus restoration, announcements, and rollback", async () => {
  const calls = [];
  const announcements = [];
  let fail = false;
  const harness = createLifecycleHarness({
    onAnnounce(message) { announcements.push(message); },
    async onCollectionCommand(command, payload) {
      calls.push({ command, payload });
      if (fail) throw new Error("Synthetic collection conflict");
      return payload.order.map((id) => ({ id, name: id.toUpperCase(), manualOrder: [] }));
    },
  });
  harness.controller.open("collection-manager", {
    replays: [],
    collections: [
      { id: "a", name: "A", manualOrder: [] },
      { id: "b", name: "B", manualOrder: [] },
      { id: "c", name: "C", manualOrder: [] },
    ],
  });
  const keyboardEvent = (target, key) => ({
    target,
    key,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  });
  let row = harness.elements.replayLifecycleBody.querySelectorAll("[data-collection-id]")
    .find((entry) => entry.dataset.collectionId === "a");
  let handle = row.querySelector("[data-collection-reorder-handle]");
  assert.match(handle.title, /Arrow keys, Home, and End/);
  let event = keyboardEvent(handle, "ArrowDown");
  assert.equal(harness.controller.handleCollectionReorderKeyDown(event), true);
  assert.equal(event.defaultPrevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], { command: "collection-reorder", payload: { order: ["b", "a", "c"] } });
  assert.deepEqual(harness.controller.context.collections.map((entry) => entry.id), ["b", "a", "c"]);
  assert.match(announcements.at(-1), /A moved to position 2 of 3/);
  assert.equal(harness.document.activeElement.dataset.collectionReorderHandle, "true");
  assert.equal(harness.document.activeElement.closest("[data-collection-id]").dataset.collectionId, "a");

  fail = true;
  row = harness.elements.replayLifecycleBody.querySelectorAll("[data-collection-id]")
    .find((entry) => entry.dataset.collectionId === "a");
  handle = row.querySelector("[data-collection-reorder-handle]");
  event = keyboardEvent(handle, "End");
  assert.equal(harness.controller.handleCollectionReorderKeyDown(event), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[1], { command: "collection-reorder", payload: { order: ["b", "c", "a"] } });
  assert.deepEqual(harness.controller.context.collections.map((entry) => entry.id), ["b", "a", "c"], "failed reorder leaves the committed order unchanged");
  assert.match(harness.elements.replayLifecycleError.textContent, /Synthetic collection conflict/);
  assert.match(announcements.at(-1), /A order was unchanged/);
  assert.equal(harness.controller.busy, false);
  harness.controller.destroy();
});

function createGridHarness(options = {}) {
  const viewStart = mainSource.indexOf("class ReplayGridView");
  const viewEnd = mainSource.indexOf("class GridScaleControl", viewStart);
  assert.ok(viewStart >= 0 && viewEnd > viewStart, "ReplayGridView source boundaries changed");
  const listeners = new Map();
  const documentListeners = new Map();
  const layers = new Map([
    ["replayLifecycleBackdrop", { hidden: true }],
    ["preferencesBackdrop", { hidden: true }],
    ["navigationBackdrop", { hidden: true }],
  ]);
  const document = {
    activeElement: null,
    hitTarget: null,
    createElement(tagName) { return new FakeNode(tagName, document); },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (documentListeners.get(type) === listener) documentListeners.delete(type);
    },
    getElementById(id) { return layers.get(id) || null; },
    elementFromPoint() { return document.hitTarget; },
  };
  const grid = {
    clientWidth: 760,
    clientHeight: 720,
    scrollTop: 0,
    offsetTop: 0,
    children: [],
    attributes: new Map(),
    get innerHTML() { return ""; },
    set innerHTML(value) {
      assert.equal(String(value), "");
      this.children = [];
    },
    appendChild(node) { this.children.push(node); return node; },
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); },
    getAttribute(name) { return this.attributes.get(String(name)) || null; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    contains(node) { return Boolean(node && node.isReplayNode); },
  };
  const nativeCalls = [];
  const contextActions = [];
  const imports = [];
  const opens = [];
  const announcements = [];
  const contextMenuItems = REPLAY_CONTEXT_ACTIONS.map((action) => ({
    tagName: "BUTTON",
    dataset: { replayContextAction: action },
    attributes: new Map([["role", "menuitem"]]),
    hidden: false,
    disabled: false,
    title: "",
    textContent: action,
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); },
    getAttribute(name) { return this.attributes.get(String(name)) || null; },
    closest(selector) { return selector === "[data-replay-context-action]" ? this : null; },
    focus() { document.activeElement = this; },
  }));
  const contextMenu = {
    hidden: true,
    style: {},
    rect: { left: 0, top: 0, width: 240, height: 420, bottom: 420 },
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    },
    contains(target) { return contextMenuItems.includes(target); },
    querySelectorAll(selector) {
      return selector === "[data-replay-context-action]" || selector === '[role="menuitem"]'
        ? contextMenuItems
        : [];
    },
    getBoundingClientRect() { return { ...this.rect }; },
  };
  const context = {
    Array,
    Date,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    console,
    document,
    window: {
      innerWidth: 1000,
      innerHeight: 700,
      devicePixelRatio: 1,
      matchMedia() { return { matches: Boolean(options.systemReducedMotion) }; },
    },
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    NATIVE_DRAG_DEBUG: false,
    REPLAY_NATIVE_DRAG_THRESHOLD_PX: 5,
    REPLAY_NATIVE_DRAG_SUPPRESSION_MS: 650,
    closestReplayCard(target, rootNode) {
      const card = target && typeof target.closest === "function" ? target.closest(".replay-card") : null;
      return card && rootNode.contains(card) ? card : null;
    },
    isInteractiveCardTarget(target) { return Boolean(target && target.interactive); },
    getReplayCanonicalMediaPath(value) { return value.filepath; },
    normalizeError(error) { return error; },
    statusLabel(value) { return value.status || "Available"; },
    formatReplayTimestamp() { return "Today"; },
    replayCardSignature(value) { return String(value && value.id || ""); },
    oracleWindow: {
      OracleReplayLibrary: null,
      oracleWorkspacePreferences: {
        appearance: { reducedMotion: options.reducedMotion || "system" },
      },
    },
    UserFacingError: class UserFacingError extends Error {},
    logTimelineLabelTelemetry() {},
  };
  vm.runInNewContext(
    `${mainSource.slice(viewStart, viewEnd)}\nthis.ReplayGridView = ReplayGridView;`,
    context,
    { filename: "main.js#M3ReplayGrid" },
  );
  const view = new context.ReplayGridView(
    {
      grid,
      replayScroller: grid,
      empty: { hidden: true },
      recentExports: { hidden: false },
      exportCount: { textContent: "", setAttribute() {} },
      replayContextMenu: contextMenu,
    },
    {
      onOpen(value) { opens.push(value.id); },
      onInsert(value) { imports.push(value.id); },
      onNativeDragResult() {},
      onBlockedDrag() {},
      onContextAction(action, replayValue, selected) {
        contextActions.push(action);
        if (typeof options.onContextAction === "function") {
          options.onContextAction(action, replayValue, selected);
        }
      },
      onAnnounce(message) { announcements.push(message); },
      getContextActionState(action, replayValue, selected) {
        return typeof options.getContextActionState === "function"
          ? options.getContextActionState(action, replayValue, selected)
          : {};
      },
      nativeAddon: {
        startNativeFileDrag(pathValue) {
          nativeCalls.push(pathValue);
          return Promise.resolve({ ok: true, cancelled: true });
        },
      },
    },
  );
  const makeCard = (id, rect = { left: 0, top: 0, width: 100, height: 80, bottom: 80 }) => {
    const card = {
      isReplayNode: true,
      dataset: { replayId: id },
      attributes: new Map(),
      classList: createClassList({ _className: "" }),
      style: createStyle(),
      rect,
      closest(selector) { return selector === ".replay-card" ? this : null; },
      getBoundingClientRect() { return { ...this.rect }; },
      setAttribute(name, value) { this.attributes.set(String(name), String(value)); },
      getAttribute(name) { return this.attributes.get(String(name)) || null; },
      focus() { document.activeElement = this; },
      remove() {},
      get innerHTML() { return ""; },
      set innerHTML(value) {
        assert.equal(String(value), "");
      },
    };
    return card;
  };
  const replay = { id: "one", title: "One", filepath: "D:\\Renders\\One.mov", status: "ready" };
  const card = makeCard("one");
  view.replayById.set(replay.id, replay);
  view.sourceIds = [replay.id];
  const event = (overrides = {}) => ({
    key: "",
    button: 0,
    buttons: 1,
    isPrimary: true,
    pointerId: 7,
    clientX: 10,
    clientY: 10,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: card,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    ...overrides,
  });
  return {
    view,
    card,
    makeCard,
    event,
    document,
    layers,
    nativeCalls,
    contextActions,
    imports,
    opens,
    announcements,
    contextMenu,
    contextMenuItems,
    contextMenuItem(action) {
      return contextMenuItems.find((item) => item.dataset.replayContextAction === action) || null;
    },
  };
}

function createPanelControllerMethodHarness(nativeAddon = null) {
  const start = mainSource.indexOf("class OraclePanelController");
  const end = mainSource.indexOf("class OracleDedicatedPanelMount", start);
  assert.ok(start >= 0 && end > start, "OraclePanelController source boundaries changed");
  const context = {
    console,
    nativeDragAddon: nativeAddon,
    oracleWindow: {
      oracleWorkspacePreferences: {
        replay: { deleteFromDisk: false },
      },
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(start, end)}\nthis.OraclePanelController = OraclePanelController;`,
    context,
    { filename: "main.js#M3OraclePanelController" },
  );
  return { context, prototype: context.OraclePanelController.prototype };
}

test("M3 grid sends Ctrl/Shift clicks to selection and Escape never steals an open overlay", () => {
  const harness = createGridHarness();
  const gestures = [];
  harness.view.applySelectionGesture = (id, options) => gestures.push({ id, options });

  const ctrl = harness.event({ ctrlKey: true });
  harness.view.onReplayClickCapture(ctrl);
  assert.equal(ctrl.defaultPrevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(gestures[0])), {
    id: "one",
    options: { toggle: true, range: false, additive: true },
  });
  const shift = harness.event({ shiftKey: true });
  harness.view.onReplayClickCapture(shift);
  assert.deepEqual(JSON.parse(JSON.stringify(gestures[1])), {
    id: "one",
    options: { toggle: false, range: true, additive: false },
  });

  let clearCalls = 0;
  harness.view.selectedReplayIds = new Set(["one"]);
  harness.view.clearSelection = () => { clearCalls += 1; harness.view.selectedReplayIds.clear(); };
  harness.layers.get("replayLifecycleBackdrop").hidden = false;
  const blockedEscape = harness.event({ key: "Escape", target: null, buttons: 0 });
  harness.view.onDocumentKeyDown(blockedEscape);
  assert.equal(clearCalls, 0);
  assert.equal(blockedEscape.defaultPrevented, false);

  harness.layers.get("replayLifecycleBackdrop").hidden = true;
  const availableEscape = harness.event({ key: "Escape", target: null, buttons: 0 });
  harness.view.onDocumentKeyDown(availableEscape);
  assert.equal(clearCalls, 1);
  assert.equal(availableEscape.defaultPrevented, true);
  harness.view.destroy();
});

test("M3 replay FLIP motion honors the canonical reducedMotion preference", () => {
  assert.equal(
    createGridHarness({ reducedMotion: "reduce", systemReducedMotion: false }).view.prefersReducedMotion(),
    true,
    "the explicit Reduce preference suppresses reorder motion even when the OS allows it",
  );
  assert.equal(
    createGridHarness({ reducedMotion: "allow", systemReducedMotion: true }).view.prefersReducedMotion(),
    false,
    "the explicit Allow preference wins over the OS setting",
  );
  assert.equal(
    createGridHarness({ reducedMotion: "system", systemReducedMotion: true }).view.prefersReducedMotion(),
    true,
    "Follow system delegates to prefers-reduced-motion",
  );
});

test("M9 virtual replay grid exposes complete row and column position semantics", () => {
  const harness = createGridHarness();
  harness.view.getGridColumns = () => 2;
  harness.view.renderExportCard = (_title, _path, replay) => {
    const card = new FakeNode("article", harness.document);
    card.isReplayNode = true;
    card.dataset.replayId = replay.id;
    card.remove = () => {};
    return card;
  };
  const second = { id: "two", title: "Two", filepath: "D:\\Renders\\Two.mov", status: "ready" };
  harness.view.renderCards([
    { id: "one", title: "One", filepath: "D:\\Renders\\One.mov", status: "ready" },
    second,
  ]);

  assert.equal(harness.view.grid.getAttribute("aria-rowcount"), "2", "date header and card row are counted");
  assert.equal(harness.view.grid.getAttribute("aria-colcount"), "2");
  const dateRow = harness.view.grid.children.find((node) => node.className === "replay-date-row");
  const cardRow = harness.view.grid.children.find((node) => node.className === "replay-virtual-card-row");
  assert.equal(dateRow.getAttribute("role"), "row");
  assert.equal(dateRow.getAttribute("aria-rowindex"), "1");
  assert.equal(dateRow.children[0].getAttribute("role"), "rowheader");
  assert.equal(dateRow.children[0].getAttribute("aria-colspan"), "2");
  assert.equal(cardRow.getAttribute("aria-rowindex"), "2");
  assert.deepEqual(cardRow.children.map((card) => card.getAttribute("aria-colindex")), ["1", "2"]);
  harness.view.destroy();
});

test("M3 replay reorder handles own their pointer sequence and never enter native OLE", () => {
  const harness = createGridHarness();
  const target = harness.makeCard("two", { left: 120, top: 0, width: 100, height: 80, bottom: 80 });
  harness.view.replayById.set("two", { id: "two", title: "Two", filepath: "D:\\Renders\\Two.mov" });
  harness.view.sourceIds = ["one", "two"];
  harness.view.manualOrderCollectionId = "collection-1";
  harness.view.captureFlipRects = () => new Map();
  harness.view.applySelectionGesture = () => undefined;
  const reorderCalls = [];
  harness.view.onReorder = (value) => reorderCalls.push(value);
  harness.view.cardRecords.set("one", { card: harness.card });
  harness.view.cardRecords.set("two", { card: target });
  const handle = {
    isReplayNode: true,
    pointerCapture: null,
    closest(selector) {
      if (selector === "[data-replay-reorder-handle]") return this;
      if (selector === ".replay-card") return harness.card;
      return null;
    },
    setPointerCapture(id) { this.pointerCapture = id; },
    releasePointerCapture(id) { if (this.pointerCapture === id) this.pointerCapture = null; },
  };
  const down = harness.event({ target: handle, ctrlKey: true });
  harness.view.onReplayPointerDown(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(harness.view.dragState, null);
  assert.equal(harness.view.reorderState.replayId, "one");
  assert.equal(harness.nativeCalls.length, 0);

  harness.document.hitTarget = target;
  harness.view.updateInternalReorder(harness.event({ target: handle, clientX: 190, clientY: 20 }));
  assert.equal(harness.view.reorderState.targetId, "two");
  assert.equal(harness.view.reorderState.placement, "after");
  harness.view.finishInternalReorder(harness.event({ target: handle }), false);
  assert.deepEqual(JSON.parse(JSON.stringify(reorderCalls)), [{
    collectionId: "collection-1",
    replayId: "one",
    targetId: "two",
    placement: "after",
  }]);
  assert.equal(handle.pointerCapture, null);
  assert.equal(harness.nativeCalls.length, 0);
  harness.view.destroy();
});

test("M9 replay reorder buttons support keyboard placement and instructions without invoking import or native OLE", () => {
  const harness = createGridHarness();
  const second = harness.makeCard("two", { left: 120, top: 0, width: 100, height: 80, bottom: 80 });
  const third = harness.makeCard("three", { left: 240, top: 0, width: 100, height: 80, bottom: 80 });
  harness.view.replayById.set("two", { id: "two", title: "Two", filepath: "D:\\Renders\\Two.mov" });
  harness.view.replayById.set("three", { id: "three", title: "Three", filepath: "D:\\Renders\\Three.mov" });
  harness.view.sourceIds = ["one", "two", "three"];
  harness.view.manualOrderCollectionId = "collection-1";
  harness.view.getGridColumns = () => 2;
  harness.view.cardRecords.set("one", { card: harness.card });
  harness.view.cardRecords.set("two", { card: second });
  harness.view.cardRecords.set("three", { card: third });
  const reorderCalls = [];
  harness.view.onReorder = (value) => reorderCalls.push(value);
  const handle = {
    interactive: true,
    closest(selector) {
      if (selector === "[data-replay-reorder-handle]") return this;
      if (selector === ".replay-card") return harness.card;
      return null;
    },
  };

  let event = harness.event({ target: handle, key: "ArrowDown", buttons: 0 });
  harness.view.onReplayKeyDown(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(reorderCalls)), [{
    collectionId: "collection-1",
    replayId: "one",
    targetId: "three",
    placement: "after",
    input: "keyboard",
  }]);
  assert.equal(harness.nativeCalls.length, 0);
  assert.equal(harness.imports.length, 0);

  event = harness.event({ target: handle, key: "Enter", buttons: 0 });
  harness.view.onReplayKeyDown(event);
  assert.equal(event.defaultPrevented, true);
  assert.match(harness.announcements.at(-1), /position 1 of 3.*Arrow keys, Home, or End/i);
  assert.equal(reorderCalls.length, 1);
  assert.equal(harness.nativeCalls.length, 0);
  harness.view.destroy();
});

test("M3 context-action inventory and parameterized routing cover every rendered command without OLE", () => {
  const renderedActions = Array.from(
    indexSource.matchAll(/data-replay-context-action="([^"]+)"/g),
    (match) => match[1],
  );
  assert.deepEqual(renderedActions, REPLAY_CONTEXT_ACTIONS);

  const routed = [];
  const harness = createGridHarness({
    onContextAction(action, replayValue, selected) {
      routed.push({ action, replayId: replayValue.id, selectedIds: selected.map((entry) => entry.id) });
    },
  });
  harness.view.setSelection(["one"], "one", "one");

  for (const action of REPLAY_CONTEXT_ACTIONS) {
    harness.view.openContextMenu("one", 40, 60, harness.card);
    const item = harness.contextMenuItem(action);
    assert.ok(item, `missing context item for ${action}`);
    const event = harness.event({ target: item, buttons: 0 });
    harness.view.onContextMenuClick(event);
    assert.equal(event.defaultPrevented, true, `${action} must consume its menu activation`);
    assert.equal(harness.contextMenu.hidden, true, `${action} must close the menu`);
    assert.equal(harness.document.activeElement, harness.card, `${action} must restore card focus`);
    assert.equal(harness.nativeCalls.length, 0, `${action} must not invoke native OLE`);
  }

  assert.deepEqual(harness.opens, ["one"]);
  assert.deepEqual(harness.imports, []);
  assert.deepEqual(
    routed,
    REPLAY_CONTEXT_ACTIONS
      .filter((action) => action !== "play")
      .map((action) => ({ action, replayId: "one", selectedIds: ["one"] })),
  );
  harness.view.destroy();
});

test("M3 context menu exposes exact disabled reasons and labels, supports keyboard movement, Escape, and focus restoration", () => {
  const actionStates = new Map([
    ["play", { disabled: true, reason: "Playback applies to one replay at a time." }],
    ["relink", { hidden: true }],
  ]);
  const harness = createGridHarness({
    getContextActionState(action) { return actionStates.get(action) || {}; },
  });
  harness.view.openContextMenu("one", 980, 690, harness.card);

  const play = harness.contextMenuItem("play");
  const sourceMonitor = harness.contextMenuItem("source-monitor");
  const relink = harness.contextMenuItem("relink");
  const rename = harness.contextMenuItem("rename-display");
  const last = harness.contextMenuItem("delete");
  assert.equal(play.disabled, true);
  assert.equal(play.title, "Playback applies to one replay at a time.");
  assert.equal(play.getAttribute("aria-disabled"), "true");
  assert.equal(relink.hidden, true);
  assert.equal(harness.document.activeElement, sourceMonitor, "first enabled visible action receives focus");
  assert.equal(harness.contextMenu.style.left, "752px", "menu remains horizontally viewport-bounded");
  assert.equal(harness.contextMenu.style.top, "272px", "menu remains vertically viewport-bounded");

  const key = (value) => harness.event({
    target: harness.document.activeElement,
    key: value,
    buttons: 0,
  });
  let event = key("ArrowDown");
  harness.view.onContextMenuKeyDown(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(harness.document.activeElement, rename, "keyboard navigation skips hidden and disabled items");

  event = key("End");
  harness.view.onContextMenuKeyDown(event);
  assert.equal(harness.document.activeElement, last);
  event = key("Home");
  harness.view.onContextMenuKeyDown(event);
  assert.equal(harness.document.activeElement, sourceMonitor);

  event = key("Escape");
  harness.view.onContextMenuKeyDown(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(harness.contextMenu.hidden, true);
  assert.equal(harness.document.activeElement, harness.card);
  assert.equal(harness.view.contextReplayId, "");
  harness.view.destroy();
});

test("M3 right-click preserves a selected batch, selects an unselected card, and routes the exact selection", () => {
  const routed = [];
  const harness = createGridHarness({
    onContextAction(action, replayValue, selected) {
      routed.push({ action, replayId: replayValue.id, selectedIds: selected.map((entry) => entry.id) });
    },
  });
  const second = harness.makeCard("two", { left: 120, top: 0, width: 100, height: 80, bottom: 80 });
  const third = harness.makeCard("three", { left: 240, top: 0, width: 100, height: 80, bottom: 80 });
  harness.view.replayById.set("two", { id: "two", title: "Two", filepath: "D:\\Renders\\Two.mov" });
  harness.view.replayById.set("three", { id: "three", title: "Three", filepath: "D:\\Renders\\Three.mov" });
  harness.view.sourceIds = ["one", "two", "three"];
  harness.view.setSelection(["one", "two"], "one", "one");

  let event = harness.event({ target: harness.card, button: 2, buttons: 0, clientX: 20, clientY: 20 });
  harness.view.onReplayContextMenu(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.deepEqual(harness.view.getSelectedReplayIds(), ["one", "two"], "right-click on a selected card preserves the batch");
  harness.view.onContextMenuClick(harness.event({ target: harness.contextMenuItem("tags"), buttons: 0 }));
  assert.deepEqual(routed[0], { action: "tags", replayId: "one", selectedIds: ["one", "two"] });

  event = harness.event({ target: third, button: 2, buttons: 0, clientX: 260, clientY: 20 });
  harness.view.onReplayContextMenu(event);
  assert.deepEqual(harness.view.getSelectedReplayIds(), ["three"], "right-click on an unselected card makes it the sole selection");
  harness.view.onContextMenuClick(harness.event({ target: harness.contextMenuItem("collections"), buttons: 0 }));
  assert.deepEqual(routed[1], { action: "collections", replayId: "three", selectedIds: ["three"] });
  assert.equal(harness.nativeCalls.length, 0);
  harness.view.destroy();
});

test("M3 context action capability states fail closed with exact reasons and enable only proven host adapters", () => {
  const panel = createPanelControllerMethodHarness(null);
  const one = { ...replay("one"), favorite: false, archiveState: "active", missingState: "missing" };
  const two = { ...replay("two"), favorite: true, archiveState: "archived" };
  const receiver = {
    viewerAdapter: { isAvailable: () => true },
    sourceMonitorPlaying: false,
    sourceMonitorReplayId: "",
  };
  const viewer = { getState: () => ({ phase: "closed", replayId: "", playing: false }) };
  const state = (action, selected = [one]) => panel.prototype.getReplayContextActionState.call(
    receiver,
    action,
    one,
    selected,
    viewer,
  );

  for (const action of ["play", "collections", "tags", "delete"]) {
    assert.notEqual(state(action).disabled, true, `${action} should remain enabled without an unnecessary host gate`);
  }
  assert.deepEqual(
    { disabled: state("play", [one, two]).disabled, reason: state("play", [one, two]).reason },
    { disabled: true, reason: "Playback applies to one replay at a time." },
  );
  for (const action of ["rename-display", "reveal"]) {
    assert.deepEqual(
      { disabled: state(action, [one, two]).disabled, reason: state(action, [one, two]).reason },
      { disabled: true, reason: "This action applies to one replay at a time." },
    );
  }

  receiver.viewerAdapter = null;
  assert.deepEqual(
    { disabled: state("source-monitor").disabled, reason: state("source-monitor").reason },
    { disabled: true, reason: "Premiere Source Monitor is unavailable." },
  );
  assert.deepEqual(
    { disabled: state("reveal").disabled, reason: state("reveal").reason },
    { disabled: true, reason: "The native Explorer service is unavailable." },
  );
  assert.deepEqual(
    { disabled: state("relink").disabled, reason: state("relink").reason },
    { disabled: true, reason: "The file-identity service required for relinking is unavailable." },
  );
  panel.context.nativeDragAddon = {
    revealFileInExplorer() {},
    inspectReplayFileIdentity() {},
  };
  for (const action of ["reveal", "relink"]) {
    assert.notEqual(state(action).disabled, true, `${action} should enable with its exact native adapter`);
    assert.equal(state(action).reason || "", "");
  }
});

test("M3 routed context actions invoke the exact viewer, gateway, organization, and lifecycle effects", async () => {
  const panel = createPanelControllerMethodHarness(null);
  const effects = [];
  const lifecycleOpens = [];
  const one = { ...replay("one"), favorite: false, archiveState: "active", missingState: "available" };
  const two = { ...replay("two"), favorite: false, archiveState: "active", missingState: "available" };
  const byId = new Map([[one.id, one], [two.id, two]]);
  let viewerState = { phase: "open", replayId: one.id, playing: false };
  const viewer = {
    getState() { return { ...viewerState }; },
    async togglePlayback() {
      viewerState = { ...viewerState, playing: !viewerState.playing };
      effects.push(["viewer-toggle", viewerState.replayId, viewerState.playing]);
    },
  };
  const lifecycleUi = {
    open(mode, context) {
      lifecycleOpens.push({ mode, replayIds: context.replays.map((entry) => entry.id), context });
    },
  };
  const receiver = {
    viewer,
    lifecycleUi,
    elements: {},
    store: {
      state: { marker: "state" },
      getById(id) { return byId.get(id) || null; },
    },
    gateway: {
      async findExactProjectItemsByMediaPath(filepath) {
        effects.push(["gateway-exact-path", filepath]);
        return [{ id: "project-item-1" }];
      },
    },
    replayOrganizationApi: {
      planBatchReplayAction(_state, ids, payload) { return { kind: "batch", ids, payload }; },
      archiveReplaysPlan(_state, ids) { return { kind: "archive", ids }; },
      createDeleteConfirmationModel(_state, ids) { return { ok: true, kind: "delete-confirmation", ids }; },
    },
    async openReplayViewer(replayValue) {
      effects.push(["viewer-open", replayValue.id]);
      return true;
    },
    async revealReplayInExplorer(replayValue) { effects.push(["explorer-reveal", replayValue.id]); },
    commitOrganizationPlan(plan, label) { effects.push(["organization-commit", label, plan]); },
    async releaseReplayMutationHandles(ids) { effects.push(["release-handles", ids]); },
    openLifecycleConfirmation(replays, action) {
      effects.push(["lifecycle-confirmation", action, replays.map((entry) => entry.id)]);
    },
    requireOrganizationPlan(plan) { return plan; },
    replayDialogContext(replays, extra = {}) { return { replays, ...extra }; },
    showToast(message, kind) { effects.push(["toast", kind, message]); },
  };
  const hostContext = {
    viewer,
    lifecycleUi,
    elements: receiver.elements,
    showToast(message, kind) { effects.push(["toast", kind, message]); },
  };
  const invoke = (action, selected = [one]) => panel.prototype.handleReplayContextAction.call(
    receiver,
    action,
    one,
    selected,
    hostContext,
  );

  await invoke("play-pause");
  await invoke("reveal");
  await invoke("favorite", [one, two]);
  await invoke("archive");
  await invoke("delete", [one, two]);
  await invoke("rename-source");
  for (const action of ["rename-display", "collections", "tags", "rating-notes", "relink"]) {
    await invoke(action, [one, two]);
  }

  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(effects.find((entry) => entry[0] === "viewer-toggle"), ["viewer-toggle", "one", true]);
  assert.deepEqual(effects.find((entry) => entry[0] === "explorer-reveal"), ["explorer-reveal", "one"]);
  const favoriteCommit = effects.find((entry) => entry[0] === "organization-commit" && entry[1] === "replay-favorite");
  assert.deepEqual(plain(favoriteCommit[2]), {
    kind: "batch",
    ids: ["one", "two"],
    payload: { type: "favorite", value: true },
  });
  assert.deepEqual(plain(effects.find((entry) => entry[0] === "release-handles")), ["release-handles", ["one"]]);
  assert.deepEqual(
    plain(effects.find((entry) => entry[0] === "organization-commit" && entry[1] === "replay-archive")),
    ["organization-commit", "replay-archive", { kind: "archive", ids: ["one"] }],
  );
  assert.deepEqual(
    effects.find((entry) => entry[0] === "gateway-exact-path"),
    ["gateway-exact-path", one.filepath],
  );

  assert.deepEqual(
    plain(lifecycleOpens.map((entry) => [entry.mode, entry.replayIds])),
    [
      ["delete", ["one", "two"]],
      ["rename-source", ["one"]],
      ["rename-display", ["one"]],
      ["collections", ["one", "two"]],
      ["tags", ["one", "two"]],
      ["rating-notes", ["one"]],
      ["relink", ["one", "two"]],
    ],
  );
  const deleteOpen = lifecycleOpens.find((entry) => entry.mode === "delete");
  assert.deepEqual(plain(deleteOpen.context.deleteConfirmation.ids), ["one", "two"]);
  assert.equal(deleteOpen.context.nativeRecycleAvailable, false);
  const renameOpen = lifecycleOpens.find((entry) => entry.mode === "rename-source");
  assert.equal(renameOpen.context.premiereReferenceCount, 1);
});

test("M3 context menu remains panel-root-bounded and OLE dispatch is absent from reorder and context handlers", () => {
  assert.match(css, /\.oracle-context-menu\s*\{[^}]*max-height:\s*calc\(100%\s*-\s*16px\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.replay-card\[data-flip\][^}]*transition:\s*none\s*!important/);

  const pointerStart = mainSource.indexOf("  onReplayPointerDown(event) {");
  const pointerEnd = mainSource.indexOf("  onReplayPointerMove(event) {", pointerStart);
  const contextStart = mainSource.indexOf("  onContextMenuClick(event) {");
  const contextEnd = mainSource.indexOf("  onContextMenuKeyDown(event) {", contextStart);
  const reorderStart = mainSource.indexOf("  beginInternalReorder(event) {");
  const reorderEnd = mainSource.indexOf("  onReplayPointerDown(event) {", reorderStart);
  assert.ok(pointerStart >= 0 && pointerEnd > pointerStart);
  assert.ok(contextStart >= 0 && contextEnd > contextStart);
  assert.ok(reorderStart >= 0 && reorderEnd > reorderStart);
  const pointerSource = mainSource.slice(pointerStart, pointerEnd);
  assert.match(pointerSource, /^\s*onReplayPointerDown\(event\)\s*\{\s*if\s*\(this\.beginInternalReorder\(event\)\)\s*return;/s);
  assert.doesNotMatch(mainSource.slice(contextStart, contextEnd), /startNativeFileDrag|beginNativeReplayDrag|DoDragDrop/);
  assert.doesNotMatch(mainSource.slice(reorderStart, reorderEnd), /startNativeFileDrag|beginNativeReplayDrag|DoDragDrop/);
  assert.match(mainSource, /reorderHandle\.dataset\.replayReorderHandle\s*=\s*"true"/);
});
