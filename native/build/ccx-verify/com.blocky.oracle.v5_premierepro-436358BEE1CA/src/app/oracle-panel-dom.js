"use strict";

(function exposeOraclePanelDom(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) Reflect.set(globalScope, "OraclePanelDom", api);
})(typeof window !== "undefined" ? window : null, function createOraclePanelDomApi() {
  const blueprintSnapshots = new WeakMap();
  let mountSequence = 0;

  const TOKEN_IDREF_ATTRIBUTES = Object.freeze([
    "aria-labelledby",
    "aria-describedby",
    "aria-controls",
    "aria-owns",
    "headers",
  ]);
  const SINGLE_IDREF_ATTRIBUTES = Object.freeze([
    "for",
    "list",
    "form",
    "aria-activedescendant",
    "aria-details",
    "aria-errormessage",
  ]);
  const URL_IDREF_ATTRIBUTES = Object.freeze([
    "style",
    "fill",
    "stroke",
    "clip-path",
    "mask",
    "filter",
    "marker-start",
    "marker-mid",
    "marker-end",
  ]);

  function cleanText(value, maximum = 1024) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maximum);
  }

  function isDomNode(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.appendChild === "function",
    );
  }

  /**
   * Premiere UXP may pass a panel root directly or wrap it as `{ node }`.
   * Resolve wrappers without depending on a browser-specific Node constructor.
   */
  function resolvePanelRoot(value) {
    let candidate = value;
    const visited = new Set();
    for (let depth = 0; depth < 8; depth += 1) {
      if (isDomNode(candidate)) return candidate;
      if (!candidate || typeof candidate !== "object" || visited.has(candidate)) return null;
      visited.add(candidate);
      if (!("node" in candidate)) return null;
      try {
        candidate = Reflect.get(candidate, "node");
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  function childNodes(value) {
    if (!value || typeof value !== "object") return [];
    const children = value.children || value.childNodes;
    if (!children) return [];
    try {
      return Array.from(children);
    } catch (error) {
      const output = [];
      const length = Math.max(0, Number(children.length) || 0);
      for (let index = 0; index < length; index += 1) output.push(children[index]);
      return output;
    }
  }

  function isElement(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.getAttribute === "function" &&
      typeof value.setAttribute === "function",
    );
  }

  function elementsWithin(root) {
    const output = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (isElement(node)) output.push(node);
      for (const child of childNodes(node)) visit(child);
    };
    visit(root);
    return output;
  }

  function findElementById(root, id) {
    const targetId = String(id || "");
    if (!targetId) return null;
    if (root && typeof root.getElementById === "function") {
      const direct = root.getElementById(targetId);
      if (direct) return direct;
    }
    return elementsWithin(root).find((element) => element.getAttribute("id") === targetId) || null;
  }

  function ownerDocument(value, fallback = null) {
    if (value && value.ownerDocument) return value.ownerDocument;
    if (value && typeof value.createElement === "function") return value;
    return fallback;
  }

  function sanitizeIdPart(value, fallback = "oracle-panel") {
    const normalized = cleanText(value, 160)
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized || fallback;
  }

  function duplicateIdDetails(nodes) {
    const counts = new Map();
    for (const node of nodes) {
      for (const element of elementsWithin(node)) {
        const id = cleanText(element.getAttribute("id"), 512);
        if (id) counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .filter((entry) => entry[1] > 1)
      .map(([id, count]) => ({ id, count }));
  }

  function findDuplicateIds(root) {
    return duplicateIdDetails([root]);
  }

  function assertNoDuplicateIds(root, label = "Oracle panel DOM") {
    const duplicates = findDuplicateIds(root);
    if (!duplicates.length) return true;
    const summary = duplicates.map((entry) => `${entry.id} (${entry.count})`).join(", ");
    throw new Error(`${label} contains duplicate IDs: ${summary}`);
  }

  function resolveBlueprintSource(documentRef, source, sourceRoot) {
    if (typeof source === "string") {
      return findElementById(sourceRoot || documentRef, source);
    }
    return resolvePanelRoot(source);
  }

  /**
   * Capture detached clones immediately. Later runtime mutations of the source
   * DOM cannot leak into dedicated panel mounts.
   */
  function capturePristineBlueprint(documentRef, sources, options = {}) {
    if (!documentRef || typeof documentRef.createElement !== "function") {
      throw new TypeError("capturePristineBlueprint requires a document.");
    }
    const sourceList = Array.isArray(sources) ? sources : [sources];
    if (!sourceList.length || sourceList.some((source) => source == null || source === "")) {
      throw new TypeError("A panel blueprint requires at least one source node.");
    }
    const sourceRoot = resolvePanelRoot(options.sourceRoot) || documentRef;
    const snapshots = sourceList.map((source, index) => {
      const node = resolveBlueprintSource(documentRef, source, sourceRoot);
      if (!node || typeof node.cloneNode !== "function") {
        throw new Error(`Oracle panel blueprint source ${index + 1} is unavailable.`);
      }
      return node.cloneNode(true);
    });
    const duplicates = duplicateIdDetails(snapshots);
    if (duplicates.length) {
      const summary = duplicates.map((entry) => `${entry.id} (${entry.count})`).join(", ");
      throw new Error(`Oracle panel blueprint contains duplicate IDs: ${summary}`);
    }
    const originalIds = [];
    for (const snapshot of snapshots) {
      for (const element of elementsWithin(snapshot)) {
        const id = cleanText(element.getAttribute("id"), 512);
        if (id) originalIds.push(id);
      }
    }
    const blueprint = Object.freeze({
      name: cleanText(options.name, 120) || "oracle-panel",
      sourceCount: snapshots.length,
      originalIds: Object.freeze(originalIds.slice()),
    });
    blueprintSnapshots.set(blueprint, {
      document: documentRef,
      snapshots,
    });
    return blueprint;
  }

  function documentHasPrefixedId(documentRef, prefix, originalIds) {
    if (!documentRef) return false;
    return originalIds.some((id) => Boolean(findElementById(documentRef, `${prefix}--${id}`)));
  }

  function createUniqueMountPrefix(base, documentRef, originalIds = []) {
    const safeBase = sanitizeIdPart(base);
    let prefix;
    do {
      mountSequence += 1;
      prefix = `${safeBase}--m${mountSequence.toString(36)}`;
    } while (documentHasPrefixedId(documentRef, prefix, originalIds));
    return prefix;
  }

  function rewriteTokenIdRefs(value, idMap) {
    const tokens = String(value || "").split(/\s+/).filter(Boolean);
    return tokens.map((token) => idMap.get(token) || token).join(" ");
  }

  function rewriteUrlIdRefs(value, idMap) {
    return String(value || "").replace(/url\(\s*(["']?)#([^\s)"']+)\1\s*\)/g, (match, quote, id) => {
      const replacement = idMap.get(id);
      return replacement ? `url(${quote}#${replacement}${quote})` : match;
    });
  }

  function rewriteElementIdRefs(element, idMap) {
    for (const attribute of SINGLE_IDREF_ATTRIBUTES) {
      if (!element.hasAttribute || !element.hasAttribute(attribute)) continue;
      const value = element.getAttribute(attribute);
      if (idMap.has(value)) element.setAttribute(attribute, idMap.get(value));
    }
    for (const attribute of TOKEN_IDREF_ATTRIBUTES) {
      if (!element.hasAttribute || !element.hasAttribute(attribute)) continue;
      element.setAttribute(attribute, rewriteTokenIdRefs(element.getAttribute(attribute), idMap));
    }
    for (const attribute of ["href", "xlink:href"]) {
      if (!element.hasAttribute || !element.hasAttribute(attribute)) continue;
      const value = String(element.getAttribute(attribute) || "");
      if (value.startsWith("#") && idMap.has(value.slice(1))) {
        element.setAttribute(attribute, `#${idMap.get(value.slice(1))}`);
      }
    }
    for (const attribute of URL_IDREF_ATTRIBUTES) {
      if (!element.hasAttribute || !element.hasAttribute(attribute)) continue;
      element.setAttribute(attribute, rewriteUrlIdRefs(element.getAttribute(attribute), idMap));
    }
  }

  function createRootScopedElementMap(root, options = {}) {
    const resolvedRoot = resolvePanelRoot(root);
    if (!resolvedRoot) throw new TypeError("createRootScopedElementMap requires a DOM root.");
    const includeIds = options.includeIds !== false;
    const strict = options.strict !== false;
    const output = Object.create(null);
    for (const element of elementsWithin(resolvedRoot)) {
      const sourceId = cleanText(element.getAttribute("data-oracle-element"), 512);
      const id = includeIds ? cleanText(element.getAttribute("id"), 512) : "";
      const key = sourceId || id;
      if (!key) continue;
      if (strict && output[key] && output[key] !== element) {
        throw new Error(`Oracle panel root contains duplicate element key: ${key}`);
      }
      output[key] = element;
    }
    return output;
  }

  function activateDedicatedWorkspace(elements, originalId) {
    const workspace = elements && elements[originalId];
    if (!workspace) return null;
    const route = cleanText(workspace.getAttribute("data-oracle-view"), 80);
    if (route) {
      workspace.setAttribute("data-oracle-workspace", route);
      workspace.removeAttribute("data-oracle-view");
    }
    workspace.hidden = false;
    return workspace;
  }

  function instantiatePanelBlueprint(blueprint, options = {}) {
    const captured = blueprintSnapshots.get(blueprint);
    if (!captured) throw new TypeError("instantiatePanelBlueprint requires an Oracle panel blueprint.");
    const target = resolvePanelRoot(options.target);
    const documentRef = options.document || ownerDocument(target, captured.document);
    const nodes = captured.snapshots.map((snapshot) => snapshot.cloneNode(true));
    const duplicates = duplicateIdDetails(nodes);
    if (duplicates.length) throw new Error("Oracle panel blueprint clone contains duplicate IDs.");
    const prefix = createUniqueMountPrefix(
      options.prefixBase || blueprint.name,
      documentRef,
      blueprint.originalIds,
    );
    const idMap = new Map();
    for (const id of blueprint.originalIds) idMap.set(id, `${prefix}--${id}`);
    for (const node of nodes) {
      for (const element of elementsWithin(node)) {
        const originalId = cleanText(element.getAttribute("id"), 512);
        if (originalId) {
          element.setAttribute("data-oracle-element", originalId);
          element.setAttribute("id", idMap.get(originalId));
        }
      }
    }
    for (const node of nodes) {
      for (const element of elementsWithin(node)) rewriteElementIdRefs(element, idMap);
    }
    if (target) {
      for (const node of nodes) target.appendChild(node);
    }
    const mapRoot = target || (nodes.length === 1 ? nodes[0] : null);
    let elements;
    if (mapRoot) {
      elements = createRootScopedElementMap(mapRoot);
    } else {
      elements = Object.create(null);
      for (const node of nodes) Object.assign(elements, createRootScopedElementMap(node));
    }
    if (options.activateWorkspaceId) activateDedicatedWorkspace(elements, options.activateWorkspaceId);
    return {
      prefix,
      nodes,
      elements,
      idMap,
    };
  }

  function appendElement(documentRef, parent, tagName, className, text) {
    const element = documentRef.createElement(tagName);
    if (className) element.setAttribute("class", className);
    if (text !== undefined) element.textContent = String(text);
    parent.appendChild(element);
    return element;
  }

  function createDedicatedPanelShell(documentRef, options = {}) {
    if (!documentRef || typeof documentRef.createElement !== "function") {
      throw new TypeError("createDedicatedPanelShell requires a document.");
    }
    const entrypointId = cleanText(options.entrypointId, 160) || "oracleDedicatedPanel";
    const kind = cleanText(options.kind, 80) || "workspace";
    const root = documentRef.createElement("div");
    root.setAttribute("class", "oracle-panel oracle-panel--entrypoint");
    root.setAttribute("data-oracle-panel-root", entrypointId);
    root.setAttribute("data-oracle-panel-kind", kind);
    root.setAttribute("data-oracle-panel-state", "loading");
    root.setAttribute("data-oracle-panel-density", "regular");

    const state = appendElement(
      documentRef,
      root,
      "section",
      "oracle-startup-state oracle-startup-state--entrypoint",
    );
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    state.setAttribute("data-state", "loading");
    const card = appendElement(documentRef, state, "div", "oracle-startup-state__card");
    const pixel = appendElement(documentRef, card, "div", "oracle-startup-state__pixel");
    pixel.setAttribute("aria-hidden", "true");
    appendElement(documentRef, pixel, "span");
    appendElement(documentRef, card, "span", "oracle-kicker", cleanText(options.kicker, 120) || "Oracle workspace");
    const title = appendElement(
      documentRef,
      card,
      "h2",
      "",
      cleanText(options.title, 160) || "Loading cinematic tools",
    );
    const message = appendElement(
      documentRef,
      card,
      "p",
      "",
      cleanText(options.message, 500) || "Connecting the Oracle workspace.",
    );
    const content = appendElement(documentRef, root, "div", "oracle-panel-entrypoint__content");
    content.hidden = true;

    const shell = { root, state, title, message, content };
    const target = resolvePanelRoot(options.target);
    if (target) target.appendChild(root);
    return shell;
  }

  function setDedicatedPanelShellState(shell, state, error = null) {
    if (!shell || !shell.root || !shell.state || !shell.title || !shell.message || !shell.content) {
      throw new TypeError("A valid Oracle dedicated panel shell is required.");
    }
    const next = state === "ready" ? "ready" : state === "error" ? "error" : "loading";
    shell.root.setAttribute("data-oracle-panel-state", next);
    shell.state.setAttribute("data-state", next);
    if (next === "ready") {
      shell.state.hidden = true;
      shell.content.hidden = false;
      return next;
    }
    shell.state.hidden = false;
    shell.content.hidden = true;
    shell.state.setAttribute("role", next === "error" ? "alert" : "status");
    shell.title.textContent = next === "error" ? "Oracle could not start" : "Loading cinematic tools";
    if (next === "error") {
      const detail = cleanText(error && error.message ? error.message : error, 500);
      shell.message.textContent = detail
        ? `${detail} Reload Oracle in UDT after checking the first UXP Console exception.`
        : "The workspace bootstrap failed. Reload Oracle in UDT after checking the first UXP Console exception.";
    } else {
      shell.message.textContent = "Connecting the Oracle workspace.";
    }
    return next;
  }

  return Object.freeze({
    TOKEN_IDREF_ATTRIBUTES,
    SINGLE_IDREF_ATTRIBUTES,
    capturePristineBlueprint,
    instantiatePanelBlueprint,
    createDedicatedPanelShell,
    setDedicatedPanelShellState,
    createRootScopedElementMap,
    activateDedicatedWorkspace,
    createUniqueMountPrefix,
    findDuplicateIds,
    assertNoDuplicateIds,
    resolvePanelRoot,
  });
});
