// @ts-nocheck
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const workspaceApi = require("./src/quick-apply/oracle-quick-apply-workspace.js");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function dataKey(name) {
  return name.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function matches(element, selector) {
  if (!element) return false;
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  const dataMatch = selector.match(/^\[data-([a-z0-9-]+)(?:=['\"]?([^'\"\]]+)['\"]?)?\]$/i);
  if (dataMatch) {
    const key = dataKey(dataMatch[1]);
    if (!Object.prototype.hasOwnProperty.call(element.dataset, key)) return false;
    return dataMatch[2] === undefined || element.dataset[key] === dataMatch[2];
  }
  return element.tagName === selector.toUpperCase();
}

function fakeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    },
    contains(name) { return values.has(name); },
  };
}

function fakeDocument() {
  const listeners = new Map();
  const document = {
    activeElement: null,
    createElement(tagName) { return fakeElement(tagName, document); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { if (listeners.has(type)) listeners.get(type).delete(handler); },
    listenerCount(type) { return (listeners.get(type) || new Set()).size; },
    dispatch(type, init = {}) {
      const event = eventObject(type, document, init);
      for (const handler of Array.from(listeners.get(type) || [])) handler(event);
      return event;
    },
  };
  return document;
}

function eventObject(type, target, init = {}) {
  return {
    type,
    target,
    currentTarget: target,
    key: "",
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...init,
  };
}

function fakeElement(tagName = "DIV", ownerDocument = null) {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  let html = "";
  const element = {
    tagName: String(tagName).toUpperCase(),
    ownerDocument,
    parentElement: null,
    children,
    id: "",
    type: "",
    value: "",
    textContent: "",
    title: "",
    className: "",
    dataset: {},
    classList: fakeClassList(),
    style: {},
    hidden: false,
    disabled: false,
    checked: false,
    tabIndex: 0,
    appendChild(child) {
      child.parentElement = element;
      if (!child.ownerDocument) child.ownerDocument = ownerDocument;
      children.push(child);
      return child;
    },
    setAttribute(name, value) {
      const text = String(value);
      attributes.set(name, text);
      if (name === "id") element.id = text;
      if (name === "class") element.className = text;
      if (name.startsWith("data-")) element.dataset[dataKey(name.slice(5))] = text;
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { if (listeners.has(type)) listeners.get(type).delete(handler); },
    listenerCount(type) { return (listeners.get(type) || new Set()).size; },
    dispatch(type, init = {}) {
      const event = eventObject(type, element, init);
      for (const handler of Array.from(listeners.get(type) || [])) handler(event);
      return event;
    },
    closest(selector) {
      if (matches(element, selector)) return element;
      return element.parentElement && typeof element.parentElement.closest === "function" ? element.parentElement.closest(selector) : null;
    },
    querySelectorAll(selector) {
      const output = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (matches(child, selector)) output.push(child);
          visit(child);
        }
      };
      visit(element);
      return output;
    },
    querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    focus() { if (ownerDocument) ownerDocument.activeElement = element; },
  };
  Object.defineProperty(element, "innerHTML", {
    get() { return html; },
    set(value) { html = String(value); if (html === "") children.splice(0); },
  });
  return element;
}

function createElements(document = fakeDocument()) {
  const buttonNames = new Set([
    "refresh", "searchClear", "apply", "favorite", "recipeCreate", "recipeAddEffect", "recipeRename",
    "recipeDuplicate", "recipeMoveUp", "recipeMoveDown", "recipeDelete", "recipeImport", "recipeExport",
    "recipeBackdrop", "recipeBack", "recipeNext", "recipeSave", "recipeCancel",
  ]);
  const inputNames = new Set(["search", "recipeName", "recipeCatalogSearch", "recipeApplyOnce"]);
  const elements = {};
  for (const name of Object.keys(workspaceApi.ELEMENT_ALIASES)) {
    let tag = "DIV";
    if (buttonNames.has(name)) tag = "BUTTON";
    if (inputNames.has(name)) tag = "INPUT";
    if (["results", "recipeStack", "recipeCatalog", "recipeParameterList"].includes(name)) tag = "UL";
    elements[name] = document.createElement(tag);
    elements[name].id = workspaceApi.DOM_IDS[name] || name;
  }
  elements.search.type = "search";
  elements.recipeName.type = "text";
  elements.recipeCatalogSearch.type = "search";
  elements.recipeApplyOnce.type = "checkbox";
  for (const [name, element] of Object.entries(elements)) {
    if (name !== "root") elements.root.appendChild(element);
  }
  for (const [scope, label] of [["all", "All"], ["video", "Video"], ["audio", "Audio"], ["favorites", "Favorites"], ["recent", "Recent"], ["recipes", "Recipes"]]) {
    const button = document.createElement("button");
    button.dataset.quickApplyScope = scope;
    button.textContent = label;
    elements.root.appendChild(button);
  }
  elements.recipeBackdrop.hidden = true;
  elements.recipeEditor.hidden = true;
  return elements;
}

function effectTarget(id = "blur-video", options = {}) {
  const effect = {
    id,
    effectId: id,
    identity: { mediaType: "video", displayName: options.name || "Gaussian Blur", matchName: "AE.Blur", ordinal: 0 },
    mediaType: "video",
    displayName: options.name || "Gaussian Blur",
    matchName: "AE.Blur",
    category: options.category || "",
    categoryAvailable: Boolean(options.category),
  };
  return {
    kind: "effect",
    id: `effect:${id}`,
    effectId: id,
    name: effect.displayName,
    displayName: effect.displayName,
    matchName: effect.matchName,
    mediaType: "video",
    category: effect.category,
    categoryAvailable: effect.categoryAvailable,
    identity: effect.identity,
    effect,
    favorite: options.favorite === true,
    recent: options.recent === true,
    compatible: options.compatible !== false,
    compatibility: { compatible: options.compatible !== false, reason: options.reason || (options.compatible === false ? "No compatible video TrackItems." : "Exact preflight runs before commit.") },
  };
}

function recipeTarget(id = "recipe-one") {
  const recipe = {
    id,
    name: "Cinematic Punch",
    favorite: false,
    applyOnce: true,
    sortOrder: 0,
    steps: [{ effectId: "blur-video", type: "video", mediaType: "video", displayName: "Gaussian Blur", matchName: "AE.Blur", parameters: [] }],
    compatibility: { mediaTypes: ["video"] },
  };
  return {
    kind: "recipe",
    id: `recipe:${id}`,
    recipeId: id,
    name: recipe.name,
    mediaType: "video",
    recipe,
    favorite: false,
    recent: false,
    compatible: true,
    compatibility: { compatible: true, reason: "Recipe preflight ready." },
  };
}

function readySnapshot(extra = {}) {
  const targets = extra.targets || [effectTarget("blur-video", { favorite: true, recent: true }), effectTarget("gain-audio", { name: "Audio Gain", compatible: false, reason: "No compatible audio TrackItems." })];
  const selectedTargetId = extra.selectedTargetId || (targets[0] && targets[0].id) || "";
  return {
    state: extra.state || "ready",
    message: extra.message || "Quick Apply is ready.",
    query: extra.query || "",
    scope: extra.scope || "all",
    grouping: extra.grouping || "none",
    targets,
    targetGroups: extra.targetGroups || [],
    selectedTarget: targets.find((target) => target.id === selectedTargetId) || null,
    selectedTargetId,
    selection: { totalCount: 1, videoCount: 1, audioCount: 0, unknownCount: 0, message: "1 selected clip: 1 video." },
    index: { effects: [effectTarget().effect, effectTarget("gain-audio", { name: "Audio Gain" }).effect] },
    library: { recipes: targets.filter((target) => target.kind === "recipe").map((target) => target.recipe) },
    actionStatus: extra.actionStatus || null,
    pendingTargetIds: extra.pendingTargetIds || [],
  };
}

function createDomain(snapshot = readySnapshot(), options = {}) {
  const subscribers = new Set();
  const calls = { start: 0, visible: [], active: [], queries: [], scopes: [], selected: [], moved: [], applied: 0, refreshed: 0, favorites: 0, parameters: [], saved: [], destroyed: 0 };
  const domain = {
    snapshot,
    calls,
    start() { calls.start += 1; return this; },
    subscribe(listener) { subscribers.add(listener); listener(this.snapshot); return () => subscribers.delete(listener); },
    setVisible(value) { calls.visible.push(Boolean(value)); },
    setActive(value) { calls.active.push(Boolean(value)); },
    setPreferences() {},
    setQuery(value) { calls.queries.push(value); this.snapshot = { ...this.snapshot, query: value }; this.emit(); },
    setScope(value) { calls.scopes.push(value); this.snapshot = { ...this.snapshot, scope: value }; this.emit(); },
    selectTarget(id) { calls.selected.push(id); this.snapshot = { ...this.snapshot, selectedTargetId: id, selectedTarget: this.snapshot.targets.find((target) => target.id === id) }; this.emit(); return true; },
    moveSelection(delta) {
      calls.moved.push(delta);
      const current = this.snapshot.targets.findIndex((target) => target.id === this.snapshot.selectedTargetId);
      const next = (current + (delta < 0 ? -1 : 1) + this.snapshot.targets.length) % this.snapshot.targets.length;
      this.selectTarget(this.snapshot.targets[next].id);
      return this.snapshot.targets[next];
    },
    async applyTarget() {
      calls.applied += 1;
      const result = options.applyResult || { ok: true, verified: true, message: "Gaussian Blur applied and verified." };
      this.snapshot = { ...this.snapshot, actionStatus: { ...result, tone: result.ok ? "success" : "error" } };
      this.emit();
      return result;
    },
    async refreshIndex() { calls.refreshed += 1; return { ok: true }; },
    toggleFavorite() { calls.favorites += 1; return true; },
    async getSupportedParameters(effectId) { calls.parameters.push(effectId); return options.parameters || []; },
    async saveRecipe(draft, existingId) { calls.saved.push({ draft, existingId }); return { ok: true, recipe: { ...draft, id: existingId || "saved-recipe" } }; },
    async renameRecipe() { return { ok: true }; },
    async duplicateRecipe() { return { ok: true }; },
    async moveRecipe() { return { ok: true }; },
    async deleteRecipe() { return { ok: true }; },
    async importRecipes() { return { ok: true, imported: 1 }; },
    exportRecipes() { return "{\"schema\":\"com.blocky.oracle.quick-apply-recipes\"}"; },
    emit() { for (const listener of subscribers) listener(this.snapshot); },
    destroy() { calls.destroyed += 1; },
  };
  return domain;
}

function harness(options = {}) {
  const document = fakeDocument();
  const elements = createElements(document);
  const domain = options.domain || createDomain(options.snapshot || readySnapshot(), options);
  const toasts = [];
  const announcements = [];
  const closed = [];
  const exports = [];
  const controller = new workspaceApi.QuickApplyWorkspaceController(elements, {
    domain,
    ownsDomain: options.ownsDomain,
    document,
    visible: options.visible !== false,
    active: options.active !== false,
    requestRecipeName: options.requestRecipeName,
    confirmRecipeAction: options.confirmRecipeAction,
    importRecipeFile: options.importRecipeFile,
    exportRecipeFile: options.exportRecipeFile || (options.withExport ? async (value) => exports.push(value) : null),
    onToast: (...args) => toasts.push(args),
    onAnnounce: (message) => announcements.push(message),
    onRequestCloseTopLayer: (layer) => closed.push(layer),
  });
  return { controller, domain, document, elements, toasts, announcements, closed, exports };
}

test("M6 workspace exposes stable integration IDs and aliases", () => {
  assert.equal(workspaceApi.DOM_IDS.root, "quickApplyWorkspace");
  assert.equal(workspaceApi.DOM_IDS.recipeParameterList, "quickApplyRecipeParameterList");
  const root = fakeElement("section");
  const normalized = workspaceApi.normalizeElements({ quickApplyWorkspace: root });
  assert.equal(normalized.root, root);
  assert.equal(typeof workspaceApi.QuickApplyWorkspaceController, "function");
});

test("M6 canonical elements protect the main Replays empty state from Quick Apply clean snapshots", () => {
  const document = fakeDocument();
  const quickApplyElements = createElements(document);
  quickApplyElements.root.hidden = true;
  const replayEmpty = document.createElement("section");
  replayEmpty.id = "emptyState";
  replayEmpty.hidden = false;
  replayEmpty.textContent = "Waiting for an export";

  const sharedMainPanelMap = { ...quickApplyElements, empty: replayEmpty };
  for (const [name, canonicalId] of Object.entries(workspaceApi.DOM_IDS)) {
    sharedMainPanelMap[canonicalId] = quickApplyElements[name];
  }

  const normalized = workspaceApi.normalizeElements(sharedMainPanelMap);
  assert.equal(normalized.empty, quickApplyElements.empty);
  assert.notEqual(normalized.empty, replayEmpty);

  const domain = createDomain(readySnapshot({
    state: "empty",
    message: "No supported effects are available.",
    targets: [],
  }));
  const controller = new workspaceApi.QuickApplyWorkspaceController(sharedMainPanelMap, {
    domain,
    ownsDomain: false,
    document,
    visible: false,
    active: false,
  });
  controller.start();
  controller.setVisible(false);
  controller.setActive(false);

  assert.equal(replayEmpty.hidden, false);
  assert.equal(replayEmpty.textContent, "Waiting for an export");
  assert.equal(quickApplyElements.root.hidden, true);
  assert.equal(quickApplyElements.empty.hidden, false);
  assert.equal(quickApplyElements.empty.textContent, "No supported result is available in this view.");
  controller.destroy();
});

test("M6 always renders a nonblank state and host-truth result presentation", () => {
  const h = harness();
  h.controller.start();
  assert.equal(h.elements.state.hidden, false);
  assert.equal(h.elements.stateTitle.textContent, "Quick Apply ready");
  assert.equal(h.elements.stateMessage.textContent, "Quick Apply is ready.");
  assert.equal(h.elements.content.hidden, false);
  assert.equal(h.elements.results.children.length, 2);
  assert.equal(h.elements.results.children[0].tagName, "DIV", "UXP result cards use layout-safe listbox options instead of native buttons");
  assert.equal(h.elements.results.children[0].getAttribute("role"), "option");
  assert.match(h.elements.results.children[0].getAttribute("aria-label"), /Video: Gaussian Blur/);
  const firstText = JSON.stringify(h.elements.results.children[0], (key, value) => key === "parentElement" || key === "ownerDocument" ? undefined : value);
  assert.match(firstText, /Category unavailable from Premiere/);
  assert.match(firstText, /Favorite/);
  assert.match(firstText, /Recent/);
  assert.equal(h.elements.apply.disabled, false);
  const firstResultNode = h.elements.results.children[0];
  h.domain.selectTarget("effect:gain-audio");
  assert.equal(h.elements.results.children[0], firstResultNode, "selection-only state reuses the rendered result structure");
  assert.equal(h.elements.apply.disabled, true);
  assert.match(h.elements.apply.title, /No compatible audio TrackItems/);
  h.controller.destroy();
});

test("M6 renders domain grouping as labeled ARIA groups without changing option behavior", () => {
  const video = effectTarget("blur-video", { name: "Gaussian Blur", category: "Blur & Sharpen" });
  const audio = effectTarget("gain-audio", { name: "Audio Gain" });
  audio.mediaType = "audio";
  audio.effect.mediaType = "audio";
  audio.effect.identity.mediaType = "audio";
  const snapshot = readySnapshot({
    targets: [video, audio],
    grouping: "type",
    targetGroups: [
      { id: "video", label: "Video effects", targets: [video] },
      { id: "audio", label: "Audio effects", targets: [audio] },
    ],
  });
  const h = harness({ snapshot });
  h.controller.start();
  assert.equal(h.elements.results.children.length, 2);
  assert.equal(h.elements.results.children[0].getAttribute("role"), "group");
  assert.equal(h.elements.results.children[0].getAttribute("aria-label"), "Video effects, 1 result");
  assert.equal(h.elements.results.children[1].getAttribute("aria-label"), "Audio effects, 1 result");
  const options = h.elements.results.querySelectorAll("[data-quick-apply-target-id]");
  assert.equal(options.length, 2);
  assert.equal(options[0].getAttribute("role"), "option");
  h.controller.destroy();
});

test("M6 lifecycle auto-focuses search only while visible and active and cleans listeners once", async () => {
  const h = harness({ visible: false, active: false, ownsDomain: true });
  h.controller.start();
  await flush();
  assert.notEqual(h.document.activeElement, h.elements.search);
  h.controller.setVisible(true);
  h.controller.setActive(true);
  await flush();
  assert.equal(h.document.activeElement, h.elements.search);
  assert.equal(h.document.listenerCount("keydown"), 1);
  h.controller.destroy();
  h.controller.destroy();
  assert.equal(h.document.listenerCount("keydown"), 0);
  assert.equal(h.domain.calls.destroyed, 1);
});

test("M6 keyboard search supports Up/Down, Enter apply, and layered Escape", async () => {
  const h = harness();
  h.controller.start();
  let event = h.elements.root.dispatch("keydown", { target: h.elements.search, key: "ArrowDown" });
  await flush();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.domain.calls.moved, [1]);
  event = h.elements.root.dispatch("keydown", { target: h.elements.search, key: "Enter" });
  await flush();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.domain.calls.applied, 1);
  assert.match(h.elements.status.textContent, /applied and verified/i);
  h.domain.setQuery("blur");
  event = h.document.dispatch("keydown", { target: h.elements.search, key: "Escape" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.domain.calls.queries.at(-1), "");
  h.elements.root.dispatch("keydown", { target: h.elements.search, key: "Escape" });
  assert.deepEqual(h.closed, ["quick-apply"]);
  h.controller.destroy();
});

test("M9 Quick Apply scopes use one roving tab stop with Arrow, Home, End, Enter, and Space activation", () => {
  const h = harness();
  h.controller.start();
  const scopes = h.elements.root.querySelectorAll("[data-quick-apply-scope]");
  assert.equal(scopes.length, 6);
  assert.deepEqual(scopes.map((scope) => scope.tabIndex), [0, -1, -1, -1, -1, -1]);

  let event = h.elements.root.dispatch("keydown", { target: scopes[0], key: "ArrowLeft" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.document.activeElement, scopes[5]);
  assert.deepEqual(scopes.map((scope) => scope.tabIndex), [-1, -1, -1, -1, -1, 0]);
  assert.deepEqual(h.domain.calls.scopes, [], "roving focus does not activate a scope prematurely");

  event = h.elements.root.dispatch("keydown", { target: scopes[5], key: "Home" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.document.activeElement, scopes[0]);
  event = h.elements.root.dispatch("keydown", { target: scopes[0], key: "End" });
  assert.equal(h.document.activeElement, scopes[5]);

  event = h.elements.root.dispatch("keydown", { target: scopes[5], key: "Enter" });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.domain.calls.scopes, ["recipes"]);
  assert.equal(scopes[5].getAttribute("aria-pressed"), "true");
  event = h.elements.root.dispatch("keydown", { target: scopes[4], key: " " });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.domain.calls.scopes, ["recipes", "recent"]);
  assert.equal(scopes[4].getAttribute("aria-pressed"), "true");
  h.controller.destroy();
});

test("M6 Apply status is immediate, verified, and does not blank or disable unrelated results", async () => {
  const h = harness({ applyResult: { ok: false, verified: false, message: "Component readback did not match." } });
  h.controller.start();
  h.elements.root.dispatch("click", { target: h.elements.apply });
  await flush();
  assert.equal(h.domain.calls.applied, 1);
  assert.equal(h.elements.results.children.length, 2);
  assert.equal(h.elements.status.hidden, false);
  assert.equal(h.elements.status.dataset.tone, "error");
  assert.match(h.elements.status.textContent, /readback did not match/i);
  assert.equal(h.elements.search.disabled, false);
  h.controller.destroy();
});

test("M6 recipe editor is a real two-stage ordered-effect and supported-parameter contract", async () => {
  const h = harness({ parameters: [{ id: "0", index: 0, displayName: "Amount", valueType: "number", value: 12, minimum: 0, maximum: 100, options: [] }] });
  h.controller.start();
  h.elements.root.dispatch("click", { target: h.elements.recipeAddEffect });
  await flush();
  assert.equal(h.elements.recipeEditor.hidden, false);
  assert.equal(h.controller.recipeStage, 1);
  assert.equal(h.controller.recipeDraft.steps.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(h.controller.recipeDraft.steps[0], "applyOnce"), false, "a UI-created step inherits the recipe-level Apply Once value");
  h.elements.recipeApplyOnce.checked = false;
  h.elements.root.dispatch("change", { target: h.elements.recipeApplyOnce });
  assert.match(h.elements.recipeStageLabel.textContent, /Step 1 of 2/);
  h.elements.root.dispatch("click", { target: h.elements.recipeNext });
  await flush();
  await flush();
  assert.equal(h.controller.recipeStage, 2);
  assert.match(h.elements.recipeStageLabel.textContent, /Step 2 of 2/);
  assert.equal(h.domain.calls.parameters[0], "blur-video");
  assert.equal(h.elements.recipeParameterList.children.length, 1);
  const toggle = h.elements.recipeParameterList.querySelector("[data-recipe-parameter-toggle]");
  toggle.checked = true;
  h.elements.root.dispatch("change", { target: toggle });
  h.elements.recipeName.value = "Cinematic Blur";
  h.elements.root.dispatch("input", { target: h.elements.recipeName });
  h.elements.root.dispatch("click", { target: h.elements.recipeSave });
  await flush();
  await flush();
  assert.equal(h.domain.calls.saved.length, 1);
  assert.equal(h.domain.calls.saved[0].draft.applyOnce, false);
  assert.equal(Object.prototype.hasOwnProperty.call(h.domain.calls.saved[0].draft.steps[0], "applyOnce"), false);
  assert.equal(h.domain.calls.saved[0].draft.steps[0].parameters[0].index, 0);
  assert.equal(h.elements.recipeEditor.hidden, true);
  h.controller.destroy();
});

test("M6 parameter stage stays useful and honest when Premiere exposes no semantic descriptors", async () => {
  const h = harness({ parameters: [] });
  h.controller.start();
  h.controller.openRecipeEditor(null, true);
  await h.controller.advanceRecipeEditor();
  assert.equal(h.controller.recipeStage, 2);
  assert.match(h.elements.recipeEditorStatus.textContent, /No optional parameter values are proven safe/i);
  const serialized = JSON.stringify(h.elements.recipeParameterList, (key, value) => key === "parentElement" || key === "ownerDocument" ? undefined : value);
  assert.match(serialized, /No parameter value is proven safe/i);
  h.controller.destroy();
});

test("M6 Recipe import/export controls are wired only when UXP file hooks exist", async () => {
  const noHooks = harness();
  noHooks.controller.start();
  assert.equal(noHooks.elements.recipeImport.disabled, true);
  assert.match(noHooks.elements.recipeImport.title, /UXP file picker integration/);
  noHooks.controller.destroy();

  const h = harness({
    withExport: true,
    importRecipeFile: async () => ({ text: "{\"schema\":\"com.blocky.oracle.quick-apply-recipes\",\"version\":1,\"recipes\":[]}", filename: "Blocky Studios-Recipes.json" }),
  });
  h.controller.start();
  h.elements.root.dispatch("click", { target: h.elements.recipeImport });
  await flush();
  h.elements.root.dispatch("click", { target: h.elements.recipeExport });
  await flush();
  assert.equal(h.elements.recipeImport.disabled, false);
  assert.equal(h.exports.length, 1);
  assert.equal(h.exports[0].suggestedName, "Blocky-Studios-Recipes.json");
  h.controller.destroy();
});

test("M6 source remains UXP-safe, responsive, and contains no fake preset or hotkey surface", () => {
  const workspaceSource = fs.readFileSync("./src/quick-apply/oracle-quick-apply-workspace.js", "utf8");
  const domainSource = fs.readFileSync("./src/quick-apply/oracle-quick-apply-domain.js", "utf8");
  const css = fs.readFileSync("./styles/overdrive-m6.css", "utf8");
  assert.doesNotMatch(workspaceSource, /replaceChildren\s*\(/);
  assert.doesNotMatch(workspaceSource, /\bBlob\b|URL\.createObjectURL/);
  assert.doesNotMatch(css, /display\s*:\s*grid/i);
  assert.doesNotMatch(workspaceSource, /hotkey|keyboard shortcut/i);
  assert.match(domainSource, /\.prfpset files are proprietary/i);
  assert.match(css, /@media \(max-width: 500px\)/);
  assert.match(css, /prefers-reduced-motion/);
});
