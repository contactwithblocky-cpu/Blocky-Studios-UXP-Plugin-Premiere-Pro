// @ts-nocheck -- release build script executes in Node, outside the UXP jsconfig.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { compilePanelResponsiveCss } = require("./uxp-responsive-compiler.cjs");

const pluginRoot = path.resolve(__dirname, "..");
const outputDirectory = path.join(pluginRoot, "dist");
const outputPath = path.join(outputDirectory, "blocky-studios-ui.css");
const inputPaths = [
  "style.css",
  "styles/overdrive-m1.css",
  "styles/overdrive-m2.css",
  "styles/overdrive-m3.css",
  "styles/overdrive-m4.css",
  "styles/overdrive-m5.css",
  "styles/overdrive-m6.css",
  "styles/overdrive-m7.css",
  "styles/blocky-studios.css",
];

function normalizeReference(sourceRelativePath, rawReference) {
  const value = String(rawReference || "").trim();
  if (!value || /^(?:data:|https?:|#)/i.test(value)) return value;
  const queryIndex = value.search(/[?#]/);
  const suffix = queryIndex >= 0 ? value.slice(queryIndex) : "";
  const cleanValue = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  const absolute = path.resolve(path.dirname(path.join(pluginRoot, sourceRelativePath)), cleanValue.split("/").join(path.sep));
  const rootPrefix = `${pluginRoot}${path.sep}`.toLowerCase();
  if (!absolute.toLowerCase().startsWith(rootPrefix)) {
    throw new Error(`${sourceRelativePath} contains an escaping CSS asset reference: ${value}`);
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${sourceRelativePath} references a missing CSS asset: ${value}`);
  }
  const pluginRelative = path.relative(pluginRoot, absolute).split(path.sep).join("/");
  return `plugin://${pluginRelative}${suffix}`;
}

function compileSource(relativePath) {
  const absolutePath = path.join(pluginRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Missing UI stylesheet source: ${relativePath}`);
  const source = fs.readFileSync(absolutePath, "utf8").replace(/^\uFEFF/, "");
  const responsive = compilePanelResponsiveCss(source, relativePath);
  const rewritten = responsive.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (_match, quote, reference) => `url(${quote}${normalizeReference(relativePath, reference)}${quote})`,
  );
  return `\n/* source: ${relativePath} */\n${rewritten.trim()}\n`;
}

function build() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
  const css = [
    "/* GENERATED FILE. Edit the source stylesheets and run npm run ui:build. */",
    ...inputPaths.map(compileSource),
  ].join("\n");
  fs.writeFileSync(outputPath, `${css.trim()}\n`, "utf8");
  const digest = crypto.createHash("sha256").update(css).digest("hex").toUpperCase();
  return {
    output: path.relative(pluginRoot, outputPath).split(path.sep).join("/"),
    bytes: fs.statSync(outputPath).size,
    sha256: digest,
    sources: inputPaths.length,
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(build())}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { build, inputPaths, outputPath };
