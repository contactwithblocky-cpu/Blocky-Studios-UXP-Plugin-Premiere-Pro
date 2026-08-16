// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

const commandStart = main.indexOf('const ORACLE_M8_PLUGIN_ID = "com.blocky.oracle.v5";');
const commandEnd = main.indexOf("\nfunction setupOracleM7PanelEntrypoints", commandStart);
assert.ok(commandStart >= 0 && commandEnd > commandStart, "M8 command implementation must be extractable");

const context = {
  Array,
  Error,
  Object,
  Promise,
  Reflect,
  String,
  console: { error() {} },
};
vm.runInNewContext(
  `${main.slice(commandStart, commandEnd)}\nthis.commandApi = { showOracleQuickApplyPanel, handleOracleQuickApplyCommand };`,
  context,
);
const commandApi = context.commandApi;

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error && error.name, "OracleQuickApplyCommandError");
    assert.equal(error && error.code, code);
    assert.ok(String(error && error.message || "").length > 0);
    return true;
  });
}

function oraclePlugin(overrides = {}) {
  return {
    id: "com.blocky.oracle.v5",
    enabled: true,
    showPanel() { return Promise.resolve(); },
    ...overrides,
  };
}

function flushAsyncHandlers() {
  return new Promise((resolve) => setImmediate(resolve));
}

function collectProductionSources(directory, extensions) {
  const sources = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...collectProductionSources(entryPath, extensions));
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      sources.push(entryPath);
    }
  }
  return sources;
}

test("M8 manifest exposes one honest Quick Apply command and no shortcut", () => {
  const panels = manifest.entrypoints.filter((entry) => entry.type === "panel");
  const commands = manifest.entrypoints.filter((entry) => entry.type === "command");
  assert.deepEqual(panels.map((entry) => entry.id), [
    "oraclePanel",
    "oracleReplaysPanel",
    "oracleCurvesPanel",
    "oracleQuickApplyPanel",
  ]);
  assert.deepEqual(commands, [{
    id: "oracleQuickApplyCommand",
    type: "command",
    label: { default: "Open Blocky Studios Quick Apply" },
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(commands[0], "shortcut"), false);
});

test("M8 extends the sole entrypoints setup with a synchronous handled command wrapper", () => {
  assert.equal((main.match(/entrypoints\.setup\s*\(/g) || []).length, 1);
  const setupStart = main.indexOf("function setupOracleM7PanelEntrypoints");
  const setup = main.slice(setupStart);
  assert.match(setup, /function oracleQuickApplyCommandHandler\(\)\s*\{[\s\S]*?handleOracleQuickApplyCommand\(uxpRuntime && uxpRuntime\.pluginManager\);[\s\S]*?\}/);
  assert.doesNotMatch(setup, /async\s+function\s+oracleQuickApplyCommandHandler/);
  assert.match(setup, /commands:\s*\{\s*\[ORACLE_M8_COMMAND_ID\]: oracleQuickApplyCommandHandler/);
  assert.match(main, /const operation = showOracleQuickApplyPanel\(pluginManager\);[\s\S]*?operation\.catch\(/);
  assert.doesNotMatch(main, /pluginManager\.plugins\.find\s*\(/);
});

test("M8 normalizes Premiere's array-like plugin collection and targets the exact panel", async () => {
  const calls = [];
  const decoy = {
    id: "some.other.plugin",
    enabled: true,
    showPanel() { throw new Error("The decoy plugin must never be used."); },
  };
  const exact = oraclePlugin({
    showPanel(panelId) {
      calls.push({ panelId, receiver: this });
      return Promise.resolve();
    },
  });
  const arrayLikeWithoutFind = { 0: decoy, 1: exact, length: 2 };
  assert.equal(typeof arrayLikeWithoutFind.find, "undefined");

  assert.equal(await commandApi.showOracleQuickApplyPanel({ plugins: arrayLikeWithoutFind }), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].panelId, "oracleQuickApplyPanel");
  assert.equal(calls[0].receiver, exact);
});

test("M8 accepts Premiere's documented Set plugin collection", async () => {
  const calls = [];
  const exact = oraclePlugin({
    showPanel(panelId) {
      calls.push({ panelId, receiver: this });
      return Promise.resolve();
    },
  });
  const plugins = new Set([{ id: "some.other.plugin", enabled: true }, exact]);

  assert.equal(await commandApi.showOracleQuickApplyPanel({ plugins }), undefined);
  assert.deepEqual(calls.map((call) => call.panelId), ["oracleQuickApplyPanel"]);
  assert.equal(calls[0].receiver, exact);
});

test("M8 helper always returns a Promise and converts synchronous host throws", async () => {
  let operation;
  assert.doesNotThrow(() => {
    operation = commandApi.showOracleQuickApplyPanel({
      plugins: { 0: oraclePlugin({ showPanel() { throw new Error("host exploded"); } }), length: 1 },
    });
  });
  assert.equal(typeof operation.then, "function");
  await expectCode(operation, "SHOW_PANEL_THROW");
});

test("M8 rejects every unsupported plugin-manager and showPanel outcome", async () => {
  await expectCode(commandApi.showOracleQuickApplyPanel(null), "PLUGIN_MANAGER_UNAVAILABLE");
  await expectCode(commandApi.showOracleQuickApplyPanel({}), "PLUGIN_LIST_UNAVAILABLE");
  await expectCode(commandApi.showOracleQuickApplyPanel({ plugins: { length: 0 } }), "ORACLE_PLUGIN_NOT_FOUND");
  await expectCode(commandApi.showOracleQuickApplyPanel({
    plugins: { 0: oraclePlugin({ enabled: false }), length: 1 },
  }), "ORACLE_PLUGIN_DISABLED");
  await expectCode(commandApi.showOracleQuickApplyPanel({
    plugins: { 0: oraclePlugin({ showPanel: null }), length: 1 },
  }), "SHOW_PANEL_UNAVAILABLE");
  await expectCode(commandApi.showOracleQuickApplyPanel({
    plugins: { 0: oraclePlugin({ showPanel() { return "host refused"; } }), length: 1 },
  }), "SHOW_PANEL_REJECTED");
  await expectCode(commandApi.showOracleQuickApplyPanel({
    plugins: { 0: oraclePlugin({ showPanel() { return undefined; } }), length: 1 },
  }), "SHOW_PANEL_INVALID_RESULT");
  await expectCode(commandApi.showOracleQuickApplyPanel({
    plugins: { 0: oraclePlugin({ showPanel() { return Promise.resolve("host refused later"); } }), length: 1 },
  }), "SHOW_PANEL_REJECTED");
  await expectCode(commandApi.showOracleQuickApplyPanel({
    plugins: { 0: oraclePlugin({ showPanel() { return Promise.reject(new Error("async refusal")); } }), length: 1 },
  }), "SHOW_PANEL_REJECTED");

  const unreadable = {};
  Object.defineProperty(unreadable, "plugins", {
    get() { throw new Error("plugin list getter failed"); },
  });
  await expectCode(commandApi.showOracleQuickApplyPanel(unreadable), "PLUGIN_LIST_UNAVAILABLE");
});

test("M8 synchronous wrapper reports rejection once and never throws through the host", async () => {
  const diagnostics = [];
  const result = commandApi.handleOracleQuickApplyCommand({
    plugins: { 0: oraclePlugin({ showPanel() { return Promise.reject(new Error("blocked")); } }), length: 1 },
  }, {
    error(message, diagnostic) { diagnostics.push({ message, diagnostic }); },
  });
  assert.equal(result, undefined);
  await flushAsyncHandlers();
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /oracleQuickApplyCommand/);
  assert.equal(diagnostics[0].diagnostic.code, "SHOW_PANEL_REJECTED");

  assert.doesNotThrow(() => commandApi.handleOracleQuickApplyCommand(null, {
    error() { throw new Error("logger failure"); },
  }));
  await flushAsyncHandlers();
});

test("M8 ships no simulated-key or native global-hotkey mechanism", () => {
  const productionSources = [
    path.join(root, "main.js"),
    ...collectProductionSources(path.join(root, "src"), new Set([".js"])),
    ...collectProductionSources(path.join(root, "bridge"), new Set([".cjs", ".js"])),
    ...collectProductionSources(path.join(root, "native", "src"), new Set([".cpp", ".h"])),
  ];
  const forbiddenKeyboardPrimitive = /RegisterHotKey|UnregisterHotKey|WH_KEYBOARD(?:_LL)?|SendInput|keybd_event|mouse_event/;
  for (const sourcePath of productionSources) {
    assert.doesNotMatch(fs.readFileSync(sourcePath, "utf8"), forbiddenKeyboardPrimitive, sourcePath);
  }
  assert.doesNotMatch(main, /oracleQuickApplyCommand[^\n]*shortcut/i);
  assert.match(html, /Premiere 26\.3 does not expose assignable UXP shortcuts\./);
});

test("asset cache revision is exact and uniform", () => {
  const revision = html.match(/main\.js\?blocky-ui=([^"']+)/)?.[1];
  assert.match(revision || "", /^[a-f0-9]{16}$/, "cache identity is the verified content digest prefix");
  const revisions = Array.from(html.matchAll(/\?blocky-ui=([^"']+)/g), (match) => match[1]);
  assert.deepEqual(new Set(revisions), new Set([revision]));
});
