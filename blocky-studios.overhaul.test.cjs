// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles", "blocky-studios.css"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const preferences = require("./src/settings/oracle-preferences.js");

function sha256(relativePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relativePath))).digest("hex");
}

function assertReferenceRoleContrast(appearance) {
  const report = preferences.themeContrastReport(appearance);
  const persistentSurfaceRoles = ["background", "header", "surface", "raised"];
  for (const theme of Object.values(report.themes)) {
    for (const [role, ratio] of Object.entries(theme.textRatios)) {
      assert.ok(ratio >= 4.5, `${theme.mode} primary text is readable on ${role}`);
    }
    for (const role of persistentSurfaceRoles) {
      assert.ok(theme.mutedRatios[role] >= 4.5, `${theme.mode} secondary text is readable on ${role}`);
      assert.ok(theme.focusRatios[role] >= 3, `${theme.mode} focus is visible against the owning ${role}`);
    }
  }
  return report;
}

function productionJavaScriptFiles() {
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory()
      ? walk(path.join(directory, entry.name))
      : [path.join(directory, entry.name)]
  ));
  return [
    path.join(root, "main.js"),
    ...walk(path.join(root, "src")).filter((filename) => filename.endsWith(".js")),
    path.join(root, "bridge", "server.cjs"),
    path.join(root, "bridge", "publish.cjs"),
  ];
}

test("Blocky Studios branding is complete while stable host IDs remain compatible", () => {
  assert.equal(manifest.name, "Blocky Studios");
  assert.deepEqual(
    manifest.entrypoints.map((entry) => entry.label.default),
    [
      "Blocky Studios",
      "Blocky Studios Replays",
      "Blocky Studios Curves",
      "Blocky Studios Quick Apply",
      "Open Blocky Studios Quick Apply",
    ],
  );
  assert.equal(manifest.id, "com.blocky.oracle.v5", "the installed Adobe identity remains upgrade-compatible");
  assert.match(html, /<title>Blocky Studios<\/title>/);
  assert.match(html, /data-blocky-studios-ui="2"/);
  assert.doesNotMatch(html, /\bOracle\b/);
  for (const filename of productionJavaScriptFiles()) {
    const source = fs.readFileSync(filename, "utf8");
    // Oracle-prefixed API/ABI symbols remain upgrade-compatible host
    // contracts. Reject user-facing Oracle product copy, not stable symbols.
    assert.doesNotMatch(source, /["'`]Oracle(?: Overdrive)?(?: for Premiere| workspace| panel| Replays| Curves| Quick Apply| operation| completed| encountered)/, `${filename} has no stale product copy`);
  }
});

test("supplied light and dark logos are preserved byte-for-byte and wired into the shell", () => {
  assert.equal(
    sha256(path.join("assets", "logo", "blocky-studios-light-mode.png")),
    "6163aca8d939ee290e08c43fd100dca5a48db28a0f83d9e722b5826ba3fed660",
  );
  assert.equal(
    sha256(path.join("assets", "logo", "blocky-studios-dark-mode.png")),
    "0c00f7a3cbbec54b317cb01da457e8da5d89234f934501a8ec1813687688b8d0",
  );
  assert.equal((html.match(/data-blocky-brand-logo/g) || []).length, 2);
  assert.match(html, /assets\/logo\/blocky-studios-dark-mode\.png/);
  const logoController = main.slice(main.indexOf("class OracleLogoAnimator"), main.indexOf("function updateBridgeStatus"));
  assert.doesNotMatch(logoController, /requestAnimationFrame|setInterval|addEventListener/);
});

test("dark, light, and system themes share one persisted model and swap the exact logo", () => {
  const defaults = preferences.createDefaultPreferences();
  assertReferenceRoleContrast(defaults.appearance);
  assert.deepEqual(
    [defaults.appearance.theme, defaults.appearance.background, defaults.appearance.lightBackground],
    ["dark", "#111318", "#F5F3EE"],
  );
  assert.match(html, /data-pref="appearance\.theme"/);
  assert.match(html, /data-color-token="appearance\.lightFocus"/);

  const style = new Map();
  const logos = [0, 1].map(() => ({
    src: "",
    getAttribute(name) { return this[name] || null; },
    setAttribute(name, value) { this[name] = String(value); },
  }));
  let listener = null;
  let listenerRegistrations = 0;
  const mediaQuery = {
    matches: true,
    addEventListener(type, callback) {
      assert.equal(type, "change");
      listenerRegistrations += 1;
      listener = callback;
    },
  };
  const document = {
    documentElement: {
      dataset: {},
      style: { setProperty(name, value) { style.set(name, String(value)); } },
    },
    defaultView: { matchMedia() { return mediaQuery; } },
    getElementById() { return null; },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-blocky-brand-logo]");
      return logos;
    },
  };

  const system = preferences.normalizePreferences({
    ...defaults,
    appearance: { ...defaults.appearance, theme: "system" },
  });
  preferences.applyPreferencesToDocument(system, document);
  preferences.applyPreferencesToDocument(system, document);
  assert.equal(listenerRegistrations, 1, "system theme installs one bounded listener per document");
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(style.get("--bg-color"), "#F5F3EE");
  assert.ok(logos.every((logo) => logo.src.endsWith("blocky-studios-light-mode.png")));

  mediaQuery.matches = false;
  listener();
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(style.get("--bg-color"), "#111318");
  assert.ok(logos.every((logo) => logo.src.endsWith("blocky-studios-dark-mode.png")));
});

test("every authored button remains an explicit real control", () => {
  const buttons = Array.from(html.matchAll(/<button\b([^>]*)>/g), (match) => match[1]);
  assert.ok(buttons.length >= 130, "the complete Replays, Curves, Quick Apply, and Preferences surfaces remain present");
  for (const attributes of buttons) {
    assert.match(attributes, /\btype="button"/);
    assert.match(attributes, /\bid=|\bdata-[\w-]+(?:=|\b)/, "button has direct or delegated controller identity");
    const className = (attributes.match(/\bclass="([^"]+)"/) || [])[1] || "";
    assert.match(
      className,
      /\b(?:oracle-button|oracle-icon-button|profile-button|navigation-item|oracle-tab|oracle-layer-backdrop|oracle-menu-item)\b/,
      "button has an intentional semantic visual role",
    );
  }
  assert.doesNotMatch(html, /\bdraggable\s*=\s*["']true["']/i, "browser-native drag is never substituted for OLE Timeline drag");
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "controller IDs remain unique after the overhaul");
});

test("the final visual layer owns responsive, accessible, low-overhead rendering", () => {
  assert.match(html, /dist\/blocky-studios-ui\.css\?blocky-ui=/, "the release-owned CSS bundle is the only runtime stylesheet entrypoint");
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /html\[data-theme="light"\]/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /@media \(max-height: 420px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /font-family: var\(--bs-font-body\) !important/);
  assert.match(css, /\.oracle-button\s*\{[^}]*min-height:\s*var\(--bs-control-height\)[^}]*padding:\s*0 13px !important[^}]*font-size:\s*var\(--bs-type-small\) !important[^}]*font-weight:\s*500 !important/s);
  assert.match(css, /button\s*\{[^}]*background-color:\s*transparent !important[^}]*background-image:\s*none !important/s);
  assert.match(css, /\.oracle-button--quiet\s*\{[^}]*background-color:\s*transparent !important[^}]*background-image:\s*none !important/s);
  assert.match(css, /\.oracle-button--danger\s*\{[^}]*background-color:\s*transparent !important[^}]*background-image:\s*none !important/s);
  assert.match(css, /\.oracle-button--primary,[\s\S]*?\{[^}]*background-color:\s*var\(--bs-accent\) !important[^}]*background-image:\s*none !important/s);
  assert.match(css, /Premiere 26\.3's UXP compositor[\s\S]*\.oracle-button > \.oracle-button-paint,[\s\S]*?background-color:\s*var\(--bs-uxp-button-fill\) !important/s);
  assert.match(css, /\.navigation-item\s*\{[^}]*--bs-uxp-button-fill:\s*var\(--bs-paper\)/s);
  assert.doesNotMatch(css, /(?:^|\n)button\s*\{[^}]*background:\s*var\(--bs-paper\)/s, "raw buttons never receive a product filled surface");
  assert.match(css, /\.oracle-header\s*\{[^}]*display:\s*flex !important/s);
  assert.doesNotMatch(css, /display:\s*grid|grid-template/i, "Premiere UXP does not support CSS Grid");
  assert.match(css, /\.curves-preset-actions \.oracle-button\s*\{[^}]*min-height: 30px !important/s);
  assert.doesNotMatch(css, /backdrop-filter|filter:\s*blur|animation:\s*[^n]/i);
});
