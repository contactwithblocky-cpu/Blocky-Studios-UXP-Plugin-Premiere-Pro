// @ts-nocheck -- deterministic build generator executes in Node, outside UXP.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..");
const generatedRelativePath = "src/generated/oracle-build-info.js";
const generatedPath = path.join(pluginRoot, generatedRelativePath);
const entrypointRelativePath = "index.html";
const entrypointPath = path.join(pluginRoot, entrypointRelativePath);
const cacheKeyPattern = /blocky-ui=[^"'&<>\s]+/g;
const excludedPrefixes = [
  ".git/",
  "native/build/",
  "node_modules/",
  "src/generated/",
];
const excludedFiles = new Set([
  generatedRelativePath,
]);
const includedExtensions = new Set([
  ".cjs", ".css", ".dll", ".exe", ".html", ".js", ".json", ".otf", ".png", ".svg", ".ttf", ".txt", ".uxpaddon",
]);

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isRuntimeInput(relativePath) {
  const value = portable(relativePath);
  if (excludedFiles.has(value) || excludedPrefixes.some((prefix) => value.startsWith(prefix))) return false;
  return includedExtensions.has(path.extname(value).toLocaleLowerCase("en-US"));
}

function walk(directory, results = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "variant" }));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = portable(path.relative(pluginRoot, absolutePath));
    if (entry.isDirectory()) {
      if (!excludedPrefixes.some((prefix) => `${relativePath}/`.startsWith(prefix))) walk(absolutePath, results);
    } else if (entry.isFile() && isRuntimeInput(relativePath)) {
      results.push(relativePath);
    }
  }
  return results;
}

function readManifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "manifest.json"), "utf8"));
  const packageManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
  const version = String(manifest.version || "");
  if (!version || version !== String(packageManifest.version || "")) {
    throw new Error("manifest.json and package.json versions must match before generating UI build identity.");
  }
  return version;
}

function localReference(sourceRelativePath, rawReference) {
  const reference = String(rawReference || "").trim();
  if (!reference || /^(?:data:|https?:|wss?:|plugin-data:|file:|#)/i.test(reference)) return null;
  const pluginRootReference = /^plugin:\/\//i.test(reference);
  const referencePath = pluginRootReference ? reference.slice("plugin://".length) : reference;
  const clean = referencePath.split(/[?#]/, 1)[0];
  if (!clean) return null;
  const referenceBase = pluginRootReference
    ? pluginRoot
    : path.resolve(pluginRoot, path.dirname(sourceRelativePath));
  const absolutePath = path.resolve(referenceBase, clean.split("/").join(path.sep));
  const rootPrefix = `${pluginRoot}${path.sep}`.toLocaleLowerCase("en-US");
  if (!absolutePath.toLocaleLowerCase("en-US").startsWith(rootPrefix)) {
    throw new Error(`${sourceRelativePath} contains a runtime reference outside the plugin: ${reference}`);
  }
  const relativePath = portable(path.relative(pluginRoot, absolutePath));
  if (excludedFiles.has(relativePath)) return null;
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`${sourceRelativePath} references a missing runtime input: ${relativePath}`);
  }
  return relativePath;
}

function addDirectoryFiles(relativeDirectory, inputs) {
  const absoluteDirectory = path.join(pluginRoot, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory) || !fs.statSync(absoluteDirectory).isDirectory()) {
    throw new Error(`Missing runtime directory: ${relativeDirectory}`);
  }
  for (const relativePath of walk(absoluteDirectory)) inputs.add(relativePath);
}

function referencedRuntimeInputs() {
  const manifestPath = path.join(pluginRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const mainRelativePath = portable(String(manifest.main || "index.html"));
  const inputs = new Set(["manifest.json", mainRelativePath]);
  const queue = [mainRelativePath];
  const parsed = new Set();

  while (queue.length) {
    const sourceRelativePath = queue.shift();
    if (parsed.has(sourceRelativePath) || excludedFiles.has(sourceRelativePath)) continue;
    parsed.add(sourceRelativePath);
    const extension = path.extname(sourceRelativePath).toLocaleLowerCase("en-US");
    if (![".css", ".html", ".js"].includes(extension)) continue;
    const source = fs.readFileSync(path.join(pluginRoot, sourceRelativePath), "utf8");
    const references = [];
    if (extension === ".html") {
      for (const match of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) references.push(match[1]);
    }
    if (extension === ".css") {
      for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) references.push(match[1]);
    }
    if (extension === ".js") {
      for (const match of source.matchAll(/["']((?:\.\.\/|\.\/)?(?:assets|icons)\/[^"']+\.(?:json|otf|png|svg|ttf))["']/gi)) {
        references.push(match[1]);
      }
    }
    for (const reference of references) {
      // JavaScript asset URLs are resolved by the UXP document, not by the
      // source module's filesystem directory. HTML/CSS retain URL-relative
      // semantics.
      const referenceOwner = extension === ".js" ? mainRelativePath : sourceRelativePath;
      const relativePath = localReference(referenceOwner, reference);
      if (!relativePath || !isRuntimeInput(relativePath)) continue;
      if (!inputs.has(relativePath)) {
        inputs.add(relativePath);
        queue.push(relativePath);
      }
    }
  }

  const addonName = String(manifest.addon && manifest.addon.name || "");
  if (!addonName || /[\\/]/.test(addonName)) throw new Error("Manifest contains an invalid hybrid addon name.");
  const addonPath = `win/x64/${addonName}`;
  if (!fs.existsSync(path.join(pluginRoot, addonPath))) throw new Error(`Missing canonical hybrid addon: ${addonPath}`);
  inputs.add(addonPath);
  addDirectoryFiles("win/x64/media", inputs);
  return Array.from(inputs).sort((left, right) => left.localeCompare(right, "en", { sensitivity: "variant" }));
}

function digestInputs(relativePaths) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of relativePaths) {
    let bytes = fs.readFileSync(path.join(pluginRoot, relativePath));
    if (portable(relativePath) === entrypointRelativePath) {
      bytes = Buffer.from(
        bytes.toString("utf8").replace(cacheKeyPattern, "blocky-ui=CONTENT_DIGEST"),
        "utf8",
      );
    }
    const name = Buffer.from(relativePath, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(name);
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex").toUpperCase();
}

function stampEntrypointCacheKey(digest) {
  const key = String(digest || "").slice(0, 16).toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{16}$/.test(key)) throw new Error("UI build digest cannot produce a cache key.");
  const source = fs.readFileSync(entrypointPath, "utf8");
  const matches = source.match(cacheKeyPattern) || [];
  if (!matches.length) throw new Error("index.html contains no blocky-ui runtime cache keys.");
  const stamped = source.replace(cacheKeyPattern, `blocky-ui=${key}`);
  if (stamped !== source) fs.writeFileSync(entrypointPath, stamped, "utf8");
  return Object.freeze({ key, referenceCount: matches.length });
}

function build(options = {}) {
  const version = readManifestVersion();
  const inputs = referencedRuntimeInputs();
  if (!inputs.length) throw new Error("No runtime inputs were discovered for the UI build identity.");
  const digest = digestInputs(inputs);
  const cache = stampEntrypointCacheKey(digest);
  const generatedAt = options.generatedAt
    ? new Date(options.generatedAt).toISOString()
    : new Date().toISOString();
  const id = `${version}+${digest.slice(0, 16).toLocaleLowerCase("en-US")}`;
  const buildInfo = Object.freeze({
    schema: "com.blocky.oracle.ui-build",
    version,
    generatedAt,
    digest,
    id,
    inputCount: inputs.length,
    cacheKey: cache.key,
    cacheReferenceCount: cache.referenceCount,
  });
  const source = [
    '"use strict";',
    "",
    "// GENERATED FILE. Run node release/generate-ui-build.cjs; do not edit manually.",
    "(function exposeOracleBuildInfo(globalScope) {",
    `  const buildInfo = Object.freeze(${JSON.stringify(buildInfo, null, 2).replace(/\n/g, "\n  ")});`,
    '  if (typeof module === "object" && module && module.exports) module.exports = buildInfo;',
    '  if (globalScope) Reflect.set(globalScope, "OracleBuildInfo", buildInfo);',
    '})(typeof window !== "undefined" ? window : null);',
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, source, "utf8");
  return Object.freeze({ ...buildInfo, output: generatedRelativePath });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(build())}\n`);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  build,
  digestInputs,
  generatedPath,
  generatedRelativePath,
  stampEntrypointCacheKey,
  isRuntimeInput,
  referencedRuntimeInputs,
  walk,
});
