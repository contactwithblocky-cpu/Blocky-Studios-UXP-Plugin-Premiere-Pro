// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const panelDom = require("./src/app/oracle-panel-dom.js");

class FakeNode {
  constructor(ownerDocument, nodeType) {
    this.ownerDocument = ownerDocument || null;
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }

  get children() {
    return this.childNodes.filter((child) => child && child.nodeType === 1);
  }

  appendChild(child) {
    if (!child) throw new TypeError("A child node is required.");
    if (child.nodeType === 11) {
      for (const nested of Array.from(child.childNodes)) this.appendChild(nested);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
}

class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument, 1);
    this.tagName = String(tagName || "div").toUpperCase();
    this.attributes = new Map();
    this.hidden = false;
    this.textContent = "";
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  cloneNode(deep = false) {
    const clone = new FakeElement(this.ownerDocument, this.tagName);
    clone.hidden = this.hidden;
    clone.textContent = this.textContent;
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
    return clone;
  }
}

class FakeDocumentFragment extends FakeNode {
  constructor(ownerDocument) {
    super(ownerDocument, 11);
  }

  cloneNode(deep = false) {
    const clone = new FakeDocumentFragment(this.ownerDocument);
    if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
    return clone;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.body = new FakeElement(this, "body");
    this.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createDocumentFragment() {
    return new FakeDocumentFragment(this);
  }

  getElementById(id) {
    const wanted = String(id);
    const visit = (node) => {
      if (node && node.nodeType === 1 && node.getAttribute("id") === wanted) return node;
      for (const child of node && node.childNodes || []) {
        const match = visit(child);
        if (match) return match;
      }
      return null;
    };
    return visit(this);
  }

  cloneNode() {
    throw new Error("The test document is not cloned.");
  }
}

function appendElement(documentRef, parent, tagName, attributes = {}, text = "") {
  const element = documentRef.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

test("M7 resolves direct UXP roots and value.node wrappers without accepting arbitrary objects", () => {
  const documentRef = new FakeDocument();
  const root = documentRef.createElement("div");
  assert.equal(panelDom.resolvePanelRoot(root), root);
  assert.equal(panelDom.resolvePanelRoot({ node: root }), root);
  assert.equal(panelDom.resolvePanelRoot({ node: { node: root } }), root);
  assert.equal(panelDom.resolvePanelRoot(Object.create({ node: root })), root);
  assert.equal(panelDom.resolvePanelRoot({}), null);
  const cycle = {};
  cycle.node = cycle;
  assert.equal(panelDom.resolvePanelRoot(cycle), null);
});

test("M7 dedicated shells render loading or actionable error copy synchronously and never blank", () => {
  const documentRef = new FakeDocument();
  const hostRoot = documentRef.createElement("div");
  documentRef.body.appendChild(hostRoot);
  const shell = panelDom.createDedicatedPanelShell(documentRef, {
    target: { node: hostRoot },
    entrypointId: "oracleCurvesPanel",
    kind: "curves",
    kicker: "Blocky Studios Curves",
  });

  assert.equal(hostRoot.children[0], shell.root);
  assert.equal(shell.root.getAttribute("class"), "oracle-panel oracle-panel--entrypoint");
  assert.equal(shell.root.getAttribute("data-oracle-panel-state"), "loading");
  assert.equal(shell.state.hidden, false);
  assert.equal(shell.content.hidden, true);
  assert.ok(shell.title.textContent.trim());
  assert.ok(shell.message.textContent.trim());

  panelDom.setDedicatedPanelShellState(shell, "error", new Error("Effect index failed\u0000"));
  assert.equal(shell.root.getAttribute("data-oracle-panel-state"), "error");
  assert.equal(shell.state.getAttribute("role"), "alert");
  assert.equal(shell.state.hidden, false);
  assert.equal(shell.content.hidden, true);
  assert.match(shell.message.textContent, /Effect index failed/);
  assert.match(shell.message.textContent, /first UXP Console exception/);
  assert.doesNotMatch(shell.message.textContent, /\u0000/);

  panelDom.setDedicatedPanelShellState(shell, "ready");
  assert.equal(shell.state.hidden, true);
  assert.equal(shell.content.hidden, false);
});

test("M7 pristine blueprints ignore later runtime render mutations and rewrite every local IDREF", () => {
  const documentRef = new FakeDocument();
  const source = appendElement(documentRef, documentRef.body, "section", {
    id: "quickApplyWorkspace",
    "data-oracle-view": "quick-apply",
    "aria-labelledby": "quickApplyWorkspaceTitle",
  });
  source.hidden = true;
  const title = appendElement(documentRef, source, "h2", { id: "quickApplyWorkspaceTitle" }, "Quick Apply");
  const description = appendElement(documentRef, source, "p", { id: "quickApplyDescription" }, "Verified host effects");
  const label = appendElement(documentRef, source, "label", { for: "quickApplySearch" }, "Search");
  const input = appendElement(documentRef, source, "input", {
    id: "quickApplySearch",
    "aria-describedby": "quickApplyDescription",
    "aria-controls": "quickApplyResults",
    "aria-activedescendant": "quickApplyResultOne",
  });
  const results = appendElement(documentRef, source, "div", {
    id: "quickApplyResults",
    "aria-owns": "quickApplyResultOne quickApplyResultTwo",
  });
  appendElement(documentRef, results, "div", { id: "quickApplyResultOne" }, "Gamma Correction");
  appendElement(documentRef, results, "div", { id: "quickApplyResultTwo" }, "Crop");
  const link = appendElement(documentRef, source, "a", { href: "#quickApplyWorkspaceTitle" }, "Jump");
  const clip = appendElement(documentRef, source, "span", { id: "quickApplyClip" });
  const styled = appendElement(documentRef, source, "span", {
    style: "clip-path: url('#quickApplyClip')",
    "clip-path": "url(#quickApplyClip)",
  });

  const blueprint = panelDom.capturePristineBlueprint(documentRef, ["quickApplyWorkspace"], {
    name: "oracleQuickApplyPanel",
  });
  title.textContent = "MUTATED AFTER CAPTURE";
  source.setAttribute("data-runtime-mutated", "true");
  appendElement(documentRef, results, "div", { id: "runtimeOnlyResult" }, "Runtime result");

  const targetOne = appendElement(documentRef, documentRef.body, "div");
  const first = panelDom.instantiatePanelBlueprint(blueprint, {
    target: { node: targetOne },
    prefixBase: "oracleQuickApplyPanel",
    activateWorkspaceId: "quickApplyWorkspace",
  });
  const targetTwo = appendElement(documentRef, documentRef.body, "div");
  const second = panelDom.instantiatePanelBlueprint(blueprint, {
    target: targetTwo,
    prefixBase: "oracleQuickApplyPanel",
    activateWorkspaceId: "quickApplyWorkspace",
  });

  assert.notEqual(first.prefix, second.prefix);
  assert.equal(first.elements.quickApplyWorkspaceTitle.textContent, "Quick Apply");
  assert.equal(first.elements.runtimeOnlyResult, undefined);
  assert.equal(first.elements.quickApplyWorkspace.hasAttribute("data-runtime-mutated"), false);
  assert.equal(first.elements.quickApplyWorkspace.hidden, false);
  assert.equal(first.elements.quickApplyWorkspace.hasAttribute("data-oracle-view"), false);
  assert.equal(first.elements.quickApplyWorkspace.getAttribute("data-oracle-workspace"), "quick-apply");

  assert.equal(label.getAttribute("for"), "quickApplySearch", "the main source remains untouched");
  assert.equal(first.elements.quickApplyWorkspace.getAttribute("aria-labelledby"), first.elements.quickApplyWorkspaceTitle.getAttribute("id"));
  assert.equal(first.elements.quickApplySearch.getAttribute("aria-describedby"), first.elements.quickApplyDescription.getAttribute("id"));
  assert.equal(first.elements.quickApplySearch.getAttribute("aria-controls"), first.elements.quickApplyResults.getAttribute("id"));
  assert.equal(first.elements.quickApplySearch.getAttribute("aria-activedescendant"), first.elements.quickApplyResultOne.getAttribute("id"));
  assert.equal(
    first.elements.quickApplyResults.getAttribute("aria-owns"),
    `${first.elements.quickApplyResultOne.getAttribute("id")} ${first.elements.quickApplyResultTwo.getAttribute("id")}`,
  );
  const firstLabel = targetOne.children[0].children.find((entry) => entry.tagName === "LABEL");
  const firstLink = targetOne.children[0].children.find((entry) => entry.tagName === "A");
  assert.equal(firstLabel.getAttribute("for"), first.elements.quickApplySearch.getAttribute("id"));
  assert.equal(firstLink.getAttribute("href"), `#${first.elements.quickApplyWorkspaceTitle.getAttribute("id")}`);
  assert.equal(styled.getAttribute("style"), "clip-path: url('#quickApplyClip')", "the captured source is never rewritten");
  const firstStyled = targetOne.children[0].children.at(-1);
  assert.equal(firstStyled.getAttribute("style"), `clip-path: url('#${first.elements.quickApplyClip.getAttribute("id")}')`);
  assert.equal(firstStyled.getAttribute("clip-path"), `url(#${first.elements.quickApplyClip.getAttribute("id")})`);

  const scoped = panelDom.createRootScopedElementMap(targetTwo);
  assert.equal(scoped.quickApplySearch, second.elements.quickApplySearch);
  assert.notEqual(scoped.quickApplySearch, first.elements.quickApplySearch);
  assert.equal(panelDom.assertNoDuplicateIds(documentRef), true);
});

test("M7 blueprint capture and document validation reject duplicate IDs with exact evidence", () => {
  const documentRef = new FakeDocument();
  const source = appendElement(documentRef, documentRef.body, "section", { id: "replays" });
  appendElement(documentRef, source, "div", { id: "duplicateControl" });
  appendElement(documentRef, source, "div", { id: "duplicateControl" });
  assert.throws(
    () => panelDom.capturePristineBlueprint(documentRef, source, { name: "replays" }),
    /duplicate IDs: duplicateControl \(2\)/,
  );
  assert.deepEqual(panelDom.findDuplicateIds(documentRef), [{ id: "duplicateControl", count: 2 }]);
  assert.throws(() => panelDom.assertNoDuplicateIds(documentRef), /duplicateControl \(2\)/);
});
