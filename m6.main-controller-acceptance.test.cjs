"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const featureFlags = fs.readFileSync(path.join(root, "src", "core", "feature-flags.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const jsconfig = JSON.parse(fs.readFileSync(path.join(root, "jsconfig.json"), "utf8"));
const workspaceApi = require("./src/quick-apply/oracle-quick-apply-workspace.js");

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(source, pattern) {
  return Array.from(source.matchAll(pattern)).length;
}

function topLevelClassSource(name) {
  const start = main.indexOf(`class ${name}`);
  assert.ok(start >= 0, `${name} must be present in main.js`);
  const nextClass = main.indexOf("\nclass ", start + 1);
  const nextFunction = main.indexOf("\nfunction ", start + 1);
  const candidates = [nextClass, nextFunction].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : main.length;
  return main.slice(start, end);
}

function oracleControllerSource() {
  const start = main.indexOf("class OraclePanelController");
  const end = main.indexOf("function injectOracleProfiler", start);
  assert.ok(start >= 0 && end > start, "OraclePanelController must be present");
  return main.slice(start, end);
}

function classMethodSource(classSource, methodName) {
  const signature = new RegExp(`\\n  (?:async\\s+)?${regexEscape(methodName)}\\s*\\(`);
  const match = signature.exec(classSource);
  assert.ok(match, `${methodName} must be present on the inspected class`);
  const start = match.index;
  const remainder = classSource.slice(start + match[0].length);
  const next = /\n  (?:async\s+)?[A-Za-z_$][\w$]*\s*\(/.exec(remainder);
  return classSource.slice(start, next ? start + match[0].length + next.index : classSource.length);
}

function htmlNodesById(source) {
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const nodes = new Map();
  const stack = [];
  const tags = /<!--[^]*?-->|<![^>]*>|<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
  let match;
  while ((match = tags.exec(source))) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    const tag = String(match[1] || "").toLowerCase();
    if (token.startsWith("</")) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag !== tag) continue;
        stack.splice(index);
        break;
      }
      continue;
    }
    const idMatch = token.match(/\bid=["']([^"']+)["']/);
    const node = { tag, id: idMatch ? idMatch[1] : "", parent: stack.at(-1) || null, index: match.index };
    if (node.id) nodes.set(node.id, node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return nodes;
}

test("M6 dependencies remain ordered before main with one current stable cachebuster", () => {
  const ordered = [
    "src/quick-apply/oracle-effect-index.js",
    "src/quick-apply/oracle-premiere-effects-adapter.js",
    "src/quick-apply/oracle-quick-apply-domain.js",
    "src/quick-apply/oracle-quick-apply-workspace.js",
    "main.js",
  ];
  const revision = html.match(/main\.js\?blocky-ui=([^"']+)/)?.[1];
  assert.match(revision || "", /^[a-f0-9]{16}$/, "the runtime cache key is derived from the verified content digest");
  let previous = -1;
  for (const asset of ordered) {
    const match = html.match(new RegExp(`<script[^>]+src=["']${regexEscape(asset)}\\?blocky-ui=([^"']+)["']`));
    assert.ok(match, `${asset} must load with a Blocky Studios cachebuster`);
    assert.equal(match[1], revision, `${asset} must use the current content-derived cachebuster`);
    const index = html.indexOf(match[0]);
    assert.ok(index > previous, `${asset} is out of dependency order`);
    previous = index;
  }
  assert.ok(html.includes(`dist/blocky-studios-ui.css?blocky-ui=${revision}`));
  const cachebusters = Array.from(html.matchAll(/\?blocky-ui=([^"']+)/g), (match) => match[1]);
  assert.ok(cachebusters.length >= 20, "the complete shell asset stack must be cache-busted");
  assert.equal(new Set(cachebusters).size, 1, "a stable revision must never mix cachebusters");
  assert.equal(cachebusters[0], revision);
});

test("M6 Quick Apply route is enabled and its complete workspace contract is mounted", () => {
  const routeButton = html.match(/<button\b[^>]*data-oracle-route=["']quick-apply["'][^>]*>[\s\S]*?<\/button>/);
  assert.ok(routeButton, "Quick Apply navigation must be present");
  assert.doesNotMatch(routeButton[0], /\bdisabled\b|aria-disabled=["']true["']/);
  assert.match(routeButton[0], />Quick Apply</);
  assert.match(html, /<section\b[^>]*id=["']quickApplyWorkspace["'][^>]*data-oracle-view=["']quick-apply["']/);

  const ids = Object.values(workspaceApi.DOM_IDS);
  assert.equal(new Set(ids).size, ids.length, "Quick Apply controller IDs must remain unique");
  for (const id of ids) {
    assert.equal(
      countMatches(html, new RegExp(`\\bid=["']${regexEscape(id)}["']`, "g")),
      1,
      `${id} must be mounted exactly once`,
    );
  }
  for (const scope of ["all", "video", "audio", "favorites", "recent", "recipes"]) {
    assert.equal(
      countMatches(html, new RegExp(`\\bdata-quick-apply-scope=["']${scope}["']`, "g")),
      1,
      `Quick Apply scope ${scope} must be mounted exactly once`,
    );
  }
  assert.match(html, /id=["']quickApplyStateTitle["'][^>]*>\s*[^<\s][^<]*</, "startup state title must never be blank");
  assert.match(html, /id=["']quickApplyStateMessage["'][^>]*>\s*[^<\s][^<]*</, "startup state message must never be blank");

  const nodes = htmlNodesById(html);
  const backdrop = nodes.get("quickApplyRecipeBackdrop");
  const dialog = nodes.get("quickApplyRecipeEditor");
  assert.ok(backdrop && dialog, "recipe backdrop and dialog must both exist");
  assert.equal(backdrop.tag, "button", "the recipe backdrop must be an independently clickable control");
  assert.equal(dialog.tag, "section", "the recipe editor must be a real dialog section");
  assert.equal(backdrop.parent, dialog.parent, "recipe backdrop and dialog must be siblings, not nested");
  assert.ok(backdrop.index < dialog.index, "recipe backdrop must precede its dialog in paint order");
  assert.match(html.match(/<section\b[^>]*id=["']quickApplyRecipeEditor["'][^>]*>/)?.[0] || "", /role=["']dialog["']/);
  assert.match(html.match(/<section\b[^>]*id=["']quickApplyRecipeEditor["'][^>]*>/)?.[0] || "", /aria-modal=["']true["']/);
});

test("M6 main validates every Quick Apply global and constructs real services only after v3 hydration", () => {
  const globals = [
    ["OracleEffectIndex", "createEffectIndex"],
    ["OraclePremiereEffectsAdapter", "PremiereQuickApplyAdapter"],
    ["OracleQuickApplyDomain", "QuickApplyDomain"],
    ["OracleQuickApplyWorkspace", "QuickApplyWorkspaceController"],
  ];
  const locals = new Map();
  for (const [globalName, member] of globals) {
    const declaration = new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*oracleWindow\\.${globalName}\\s*;`).exec(main);
    assert.ok(declaration, `${globalName} must be read from the panel realm`);
    const local = declaration[1];
    locals.set(globalName, local);
    assert.match(main, new RegExp(`if\\s*\\(\\s*!${local}[^)]*typeof\\s+${local}\\.${member}\\s*!==\\s*["']function["']`));
  }
  assert.match(main, new RegExp(`this\\.quickApplyAdapter\\s*=\\s*new ${locals.get("OraclePremiereEffectsAdapter")}\\.PremiereQuickApplyAdapter\\s*\\(`));
  assert.match(main, new RegExp(`this\\.quickApplyDomain\\s*=\\s*new ${locals.get("OracleQuickApplyDomain")}\\.QuickApplyDomain\\s*\\(`));
  assert.match(main, new RegExp(`this\\.quickApplyWorkspace\\s*=\\s*new ${locals.get("OracleQuickApplyWorkspace")}\\.QuickApplyWorkspaceController\\s*\\(`));

  const controller = oracleControllerSource();
  const constructorStart = controller.indexOf("constructor()");
  const constructorEnd = controller.indexOf("\n  initializeQuickApply()", constructorStart);
  assert.ok(constructorStart >= 0 && constructorEnd > constructorStart);
  const constructorSource = controller.slice(constructorStart, constructorEnd);
  assert.doesNotMatch(
    constructorSource,
    /this\.quickApply(?:Adapter|Domain|Workspace)\s*=\s*new/,
    "Quick Apply must not read unhydrated v3 facades from the controller constructor",
  );

  const startSource = classMethodSource(controller, "start");
  const hydrateIndex = startSource.indexOf("this.store.hydrate(recovered.state)");
  assert.ok(hydrateIndex >= 0, "v3 state must hydrate in controller start");
  const initializer = startSource.match(/this\.[A-Za-z]*(?:initialize|create|mount|start)[A-Za-z]*QuickApply[A-Za-z]*\s*\(/i);
  assert.ok(initializer, "controller start must initialize Quick Apply explicitly");
  assert.ok(startSource.indexOf(initializer[0]) > hydrateIndex, "Quick Apply initialization must occur after v3 hydration");
});

test("M6 v3 facades are distinct, preserve sibling domains, and are wired to the correct consumers", () => {
  const stateStore = topLevelClassSource("QuickApplyStateDomainStore");
  const recipeStore = topLevelClassSource("QuickApplyRecipeDomainStore");
  const indexStore = topLevelClassSource("QuickApplyEffectIndexStore");

  assert.match(stateStore, /getState\s*\(/);
  assert.match(stateStore, /async\s+(?:commit|setState)\s*\(/);
  assert.match(stateStore, /cloneOracleDomainValue\(this\.store\.state\)/);
  assert.match(stateStore, /nextState\.quickApplyState/);
  assert.match(stateStore, /effectIndex/, "Quick Apply state commits must preserve the sibling effect-index cache");
  assert.match(stateStore, /replaceDomainState\s*\(/);

  assert.match(recipeStore, /getLibrary\s*\(/);
  assert.match(recipeStore, /async\s+(?:commit|setLibrary)\s*\(/);
  assert.match(recipeStore, /cloneOracleDomainValue\(this\.store\.state\)/);
  assert.match(recipeStore, /nextState\.recipesById/);
  assert.match(recipeStore, /replaceDomainState\s*\(/);

  assert.match(indexStore, /async\s+load\s*\(/);
  assert.match(indexStore, /async\s+save\s*\(/);
  assert.match(indexStore, /async\s+clear\s*\(/);
  assert.match(indexStore, /cloneOracleDomainValue\(this\.store\.state\)/);
  assert.match(indexStore, /nextState\.quickApplyState/);
  assert.match(indexStore, /\.\.\.(?:this\.rootState\(\)|[A-Za-z]*quickApplyState)/, "effect-index writes must preserve favorites and Recent history");
  assert.match(indexStore, /replaceDomainState\s*\(/);

  assert.match(main, /this\.quickApplyStateStore\s*=\s*new QuickApplyStateDomainStore\s*\(/);
  assert.match(main, /this\.quickApplyRecipeStore\s*=\s*new QuickApplyRecipeDomainStore\s*\(/);
  assert.match(main, /this\.quickApplyEffectIndexStore\s*=\s*new QuickApplyEffectIndexStore\s*\(/);
  assert.match(main, /effectIndexStore:\s*this\.quickApplyEffectIndexStore/);
  assert.match(main, /stateStore:\s*this\.quickApplyStateStore/);
  assert.match(main, /recipeStore:\s*this\.quickApplyRecipeStore/);
  assert.doesNotMatch(main, /effectIndexStore:\s*this\.quickApplyStateStore|stateStore:\s*this\.quickApplyEffectIndexStore/);
});

test("M6 persistence is awaitable and propagates failures to adapters and domain actions", () => {
  for (const name of ["QuickApplyStateDomainStore", "QuickApplyRecipeDomainStore", "QuickApplyEffectIndexStore"]) {
    const source = topLevelClassSource(name);
    assert.match(source, /await\s+this\.persist\s*\(|return\s+this\.persist\s*\(/, `${name} mutations must await shared v3 persistence`);
    assert.doesNotMatch(source, /void\s+this\.persist\s*\(/, `${name} must not detach persistence failures`);
  }

  const source = classMethodSource(oracleControllerSource(), "persistOracleState");
  assert.match(source, /async\s+persistOracleState\s*\(/);
  assert.match(source, /await\s+this\.persistence\.save\s*\(|return\s+this\.persistence\.save\s*\(/);
  assert.doesNotMatch(source, /void\s+this\.persistence\.save\s*\(/);
  assert.match(source, /catch\s*\([^)]*error[^)]*\)[\s\S]*throw\s+error\s*;/, "persistence errors must be reported and rethrown");
});

test("M6 forwards route and preferences lifecycle and wires real JSON and confirmation hooks", () => {
  assert.match(main, /const\s+quickApplyActive\s*=\s*panelVisible\s*&&\s*nextRoute\s*===\s*["']quick-apply["']/);
  assert.match(main, /this\.quickApplyWorkspace\.setVisible\(quickApplyActive\)/);
  assert.match(main, /this\.quickApplyWorkspace\.setActive\(quickApplyActive\)/);
  assert.match(main, /this\.quickApplyWorkspace\.setPreferences\(normalized\.quickApply\)/);
  assert.match(main, /this\.quickApplyWorkspace\.start\(\)/);

  assert.match(main, /requestRecipeName:\s*\(request\)\s*=>\s*this\.requestQuickApplyRecipeName\(request\)/);
  assert.match(main, /confirmRecipeAction:\s*\(request\)\s*=>\s*this\.confirmQuickApplyRecipeAction\(request\)/);
  assert.match(main, /importRecipeFile:\s*\(request\)\s*=>\s*this\.importQuickApplyRecipes\(request\)/);
  assert.match(main, /exportRecipeFile:\s*\(request\)\s*=>\s*this\.exportQuickApplyRecipes\(request\)/);
  for (const method of [
    "requestQuickApplyRecipeName",
    "confirmQuickApplyRecipeAction",
    "importQuickApplyRecipes",
    "exportQuickApplyRecipes",
  ]) {
    assert.match(main, new RegExp(`(?:async\\s+)?${method}\\s*\\(`), `${method} must be implemented`);
  }
  assert.match(main, /getFileForOpening\(\{\s*types:\s*\[["']json["']\],\s*allowMultiple:\s*false\s*\}\)/);
  assert.match(main, /getFileForSaving\([^)]*\{\s*types:\s*\[["']json["']\]\s*\}\)/);
  assert.match(main, /await\s+[A-Za-z][\w]*\.read\s*\(/);
  assert.match(main, /await\s+[A-Za-z][\w]*\.write\s*\(/);
  assert.match(main, /confirmQuickApplyRecipeAction[\s\S]{0,900}\.confirm\s*\(/);
  assert.doesNotMatch(main, /window\.prompt|window\.confirm/);
});

test("M6 UXP recipe import verifies file size before reading and rechecks true UTF-8 bytes", () => {
  const source = classMethodSource(oracleControllerSource(), "importQuickApplyRecipes");
  const metadataIndex = source.indexOf("entry.getMetadata");
  const readIndex = source.indexOf("entry.read");
  assert.ok(metadataIndex >= 0, "UXP Entry metadata must be inspected before a recipe JSON read");
  assert.ok(readIndex > metadataIndex, "oversized JSON must be rejected before UXP allocates the text payload");
  assert.match(source, /Number\.isSafeInteger\(entrySize\)/, "unknown or malformed UXP sizes must fail closed");
  assert.match(source, /entrySize\s*>\s*importLimit/);
  assert.match(source, /utf8ByteLength\(text\)\s*>\s*importLimit/, "the decoded payload must be checked by UTF-8 bytes, not UTF-16 character count");
  assert.match(source, /Blocky Studios Recipe JSON exceeds the 2 MB import limit/);
});

test("M6 controller teardown releases each Quick Apply owner and shared-adapter lease exactly once", () => {
  const source = classMethodSource(oracleControllerSource(), "destroy");
  assert.match(source, /if\s*\(this\.destroyPromise\)\s*return this\.destroyPromise/, "controller teardown must share one awaitable result");
  assert.match(source, /this\.destroyPromise\s*=\s*\(async\s*\(\)\s*=>/, "controller teardown must await asynchronous owners");
  for (const property of ["quickApplyWorkspace", "quickApplyDomain"]) {
    assert.equal(
      countMatches(source, new RegExp(`this\\.${property}\\.destroy\\s*\\(`, "g")),
      1,
      `${property} must be destroyed exactly once by its explicit owner`,
    );
  }
  assert.equal(countMatches(source, /this\.quickApplyAdapterLease\.release\s*\(/g), 1);
  assert.equal(countMatches(source, /this\.quickApplyAdapterCoordinator\.destroy\s*\(/g), 1);
  assert.equal(countMatches(source, /this\.quickApplyAdapter\.destroy\s*\(/g), 0);
  assert.match(main, /new quickApplyDomainApi\.QuickApplyDomain\s*\(\{[\s\S]{0,1200}ownsAdapter:\s*false/);
  assert.match(main, /new quickApplyWorkspaceApi\.QuickApplyWorkspaceController\s*\([^,]+,\s*\{[\s\S]{0,1600}ownsDomain:\s*false/);
});

test("M6 feature flag and every focused module/test participate in the full verification stack", () => {
  assert.match(featureFlags, /quickApplyWorkspace:\s*true/);
  const modules = [
    "src/quick-apply/oracle-effect-index.js",
    "src/quick-apply/oracle-premiere-effects-adapter.js",
    "src/quick-apply/oracle-quick-apply-domain.js",
    "src/quick-apply/oracle-quick-apply-workspace.js",
  ];
  const tests = [
    "m6.effect-index.test.cjs",
    "m6.premiere-effects-adapter.test.cjs",
    "m6.quick-apply-domain.test.cjs",
    "m6.quick-apply-workspace.test.cjs",
    "m6.main-controller-acceptance.test.cjs",
  ];
  for (const filename of modules) {
    assert.match(packageJson.scripts.check, new RegExp(regexEscape(filename)), `${filename} must be syntax-checked`);
    assert.ok(!(jsconfig.exclude || []).some((entry) => entry === filename || filename.startsWith(`${entry.replace(/\/$/, "")}/`)), `${filename} must remain in checkJs coverage`);
  }
  for (const filename of tests) {
    assert.match(packageJson.scripts.check, new RegExp(regexEscape(filename)), `${filename} must be syntax-checked`);
    assert.match(packageJson.scripts.test, new RegExp(regexEscape(filename)), `${filename} must run in npm test`);
    assert.ok((jsconfig.exclude || []).includes(filename), `${filename} must be excluded from production checkJs while node:test owns it`);
  }
  assert.equal(packageJson.scripts.verify, "npm run ui:verify && npm run test:platform && npm test");
});
