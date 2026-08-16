// @ts-nocheck -- release verification executes in Node, outside the UXP jsconfig.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ROOT = path.resolve(__dirname, "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function stripQuery(value) {
  return String(value || "").split(/[?#]/, 1)[0];
}

function collectHtmlReferences(html, attribute) {
  const values = [];
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, "gi");
  for (const match of html.matchAll(pattern)) values.push(match[1]);
  return values;
}

function collectCssReferences(css) {
  const values = [];
  const pattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  for (const match of css.matchAll(pattern)) values.push(match[1].trim());
  return values;
}

function assertLocalFile(failures, ownerPath, rawReference) {
  const reference = stripQuery(rawReference).trim();
  if (!reference || /^(?:data:|https?:|ws:|wss:|#)/i.test(reference)) return;
  const pluginMatch = /^plugin:\/\/(.+)$/i.exec(reference);
  const ownerDirectory = path.dirname(path.join(PLUGIN_ROOT, ownerPath));
  const resolved = pluginMatch
    ? path.resolve(PLUGIN_ROOT, pluginMatch[1].split("/").join(path.sep))
    : path.resolve(ownerDirectory, reference.split("/").join(path.sep));
  const rootPrefix = `${PLUGIN_ROOT}${path.sep}`.toLowerCase();
  if (!resolved.toLowerCase().startsWith(rootPrefix)) {
    failures.push(`${ownerPath} contains an escaping local reference: ${rawReference}`);
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    failures.push(`${ownerPath} references a missing local asset: ${rawReference}`);
  }
}

function runUiVerification() {
  const failures = [];
  const manifest = JSON.parse(readText("manifest.json"));
  const packageJson = JSON.parse(readText("package.json"));
  const html = readText(manifest.main);

  if (manifest.name !== "Blocky Studios" || manifest.id !== "com.blocky.oracle.v5") {
    failures.push("manifest identity is not the canonical Blocky Studios Premiere plugin");
  }
  if (manifest.version !== packageJson.version) {
    failures.push(`manifest/package version mismatch: ${manifest.version} vs ${packageJson.version}`);
  }
  if (!Array.isArray(manifest.entrypoints) || manifest.entrypoints.length !== 5) {
    failures.push("manifest must declare the four panels and Quick Apply command");
  }
  const panels = (manifest.entrypoints || []).filter((entry) => entry.type === "panel");
  if (panels.length !== 4 || panels.some((entry) => Number(entry.minimumSize && entry.minimumSize.width) > 240)) {
    failures.push("every panel minimum width must permit the verified 240px responsive floor");
  }

  const ids = new Map();
  for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
    const id = match[1];
    ids.set(id, (ids.get(id) || 0) + 1);
  }
  const duplicateIds = [...ids.entries()].filter(([, count]) => count > 1);
  if (duplicateIds.length) {
    failures.push(`duplicate authored DOM ids: ${duplicateIds.map(([id]) => id).join(", ")}`);
  }
  if (/\bstyle\s*=/i.test(html)) failures.push("index.html contains ordinary inline style attributes");

  const stylesheetReferences = collectHtmlReferences(html, "href")
    .map(stripQuery)
    .filter((value) => value.toLowerCase().endsWith(".css"));
  const scriptReferences = collectHtmlReferences(html, "src")
    .map(stripQuery)
    .filter((value) => value.toLowerCase().endsWith(".js"));
  if (stylesheetReferences.length !== 1 || stylesheetReferences[0] !== "dist/blocky-studios-ui.css") {
    failures.push(`index.html must load exactly one generated UI stylesheet; found: ${stylesheetReferences.join(", ")}`);
  }
  for (const reference of [...collectHtmlReferences(html, "href"), ...collectHtmlReferences(html, "src")]) {
    assertLocalFile(failures, manifest.main, reference);
  }

  const forbiddenFont = /(?:\bArial\b|\bHelvetica\b|\bsystem-ui\b|font-family\s*:\s*[^;]*(?:ui-sans-serif|sans-serif))/i;
  const forbiddenCss = [
    [/\b(?:100vw|100vh)\b/i, "viewport units (100vw/100vh)"],
    [/\bbackdrop-filter\s*:/i, "backdrop-filter"],
    [/\btransition(?:-property)?\s*:[^;]*\ball\b/i, "transition: all"],
    [/\btransform\s*:[^;]*\bscale(?:3d|X|Y)?\s*\(/i, "transform scaling"],
    [/\bdisplay\s*:\s*(?:inline-)?grid\b|\bgrid-template(?:-columns|-rows)?\s*:/i, "CSS Grid"],
  ];
  for (const relativePath of stylesheetReferences) {
    const css = readText(relativePath);
    if (forbiddenFont.test(css)) failures.push(`${relativePath} contains a forbidden fallback/legacy font declaration`);
    for (const [pattern, label] of forbiddenCss) {
      if (pattern.test(css)) failures.push(`${relativePath} contains unsupported or prohibited ${label}`);
    }
    for (const reference of collectCssReferences(css)) assertLocalFile(failures, relativePath, reference);
  }

  const authoredRuntimeText = [html, ...scriptReferences.map(readText)].join("\n");
  const iconGlyphs = ["&#8801;", "&#9889;", "≡", "☰", "⚡", "★", "☆", "▲", "▼", "✕", "✖", "❌"];
  const remainingGlyphs = iconGlyphs.filter((glyph) => authoredRuntimeText.includes(glyph));
  if (remainingGlyphs.length) failures.push(`Unicode icon glyphs remain: ${remainingGlyphs.join(" ")}`);

  const baseCss = readText("style.css");
  for (const [weight, file] of [
    ["400", "assets/fonts/samsung_sharp_sans_regular.otf"],
    ["500", "assets/fonts/samsung_sharp_sans_medium.otf"],
    ["600", "assets/fonts/samsung_sharp_sans_medium.otf"],
    ["700", "assets/fonts/samsung_sharp_sans_bold.otf"],
  ]) {
    if (!baseCss.includes(`font-weight: ${weight}`)) failures.push(`Samsung Sharp Sans weight ${weight} is not declared`);
    if (!fs.existsSync(path.join(PLUGIN_ROOT, file))) failures.push(`packaged font is missing: ${file}`);
  }
  if (!/font-family\s*:\s*["']Samsung Sharp Sans["']/i.test(baseCss)) {
    failures.push("the exact Samsung Sharp Sans family is not declared");
  }

  if (!scriptReferences.includes("src/generated/oracle-build-info.js")) {
    failures.push("index.html does not load the generated build identity");
  }
  if (!scriptReferences.includes("src/core/oracle-ui-runtime.js")) {
    failures.push("index.html does not load the central per-root UI runtime");
  }
  if (!scriptReferences.includes("src/core/oracle-platform-telemetry.js")) {
    failures.push("index.html does not load platform telemetry for tabs and host/native calls");
  }
  const diagnosticsIndex = scriptReferences.indexOf("src/core/oracle-diagnostics.js");
  const telemetryIndex = scriptReferences.indexOf("src/core/oracle-platform-telemetry.js");
  const uiRuntimeIndex = scriptReferences.indexOf("src/core/oracle-ui-runtime.js");
  if (!(diagnosticsIndex >= 0 && telemetryIndex > diagnosticsIndex && uiRuntimeIndex > telemetryIndex)) {
    failures.push("diagnostics, platform telemetry, and UI runtime must load in ownership order");
  }
  const buildInfoPath = path.join(PLUGIN_ROOT, "src", "generated", "oracle-build-info.js");
  if (!fs.existsSync(buildInfoPath)) {
    failures.push("generated build identity is missing");
  } else {
    delete require.cache[require.resolve(buildInfoPath)];
    const buildInfo = require(buildInfoPath);
    if (!buildInfo || buildInfo.version !== manifest.version || !/^[0-9.]+\+[a-f0-9]{16}$/.test(String(buildInfo.id || ""))) {
      failures.push("generated build identity does not match manifest version");
    }
  }

  const finalCss = readText("styles/blocky-studios.css");
  for (const requiredFragment of [
    '[data-width-class="micro"]',
    '[data-width-class="narrow"]',
    '[data-width-class="compact"]',
    '[data-height-class="short"]',
    ".curves-main-row",
  ]) {
    if (!finalCss.includes(requiredFragment)) failures.push(`responsive design contract is missing ${requiredFragment}`);
  }

  if (failures.length) {
    const error = new Error(`Blocky Studios UI verification failed:\n- ${failures.join("\n- ")}`);
    error.failures = failures;
    throw error;
  }
  return {
    version: manifest.version,
    panels: panels.length,
    stylesheets: stylesheetReferences.length,
    scripts: scriptReferences.length,
    authoredIds: ids.size,
  };
}

if (require.main === module) {
  try {
    const result = runUiVerification();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runUiVerification };
