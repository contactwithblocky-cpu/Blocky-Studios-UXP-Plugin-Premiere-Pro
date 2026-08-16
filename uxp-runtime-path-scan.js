/*
 * Paste this entire file into the Premiere Pro UXP console.
 * It does not modify the plugin registry or any files.
 */

// @ts-nocheck This standalone script runs inside the UXP console, not Node/tsc.

(async function scanPremiereUxpRuntime() {
  "use strict";

  const TARGET_IDS = new Set(["com.blocky.oracle.v4", "com.blocky.oracle.v5"]);
  const uxp = require("uxp");
  const localFileSystem = uxp.storage.localFileSystem;
  let plugins = [];

  try {
    plugins = Array.from(uxp.pluginManager.plugins || []);
  } catch (error) {
    console.error("Unable to enumerate pluginManager.plugins:", error);
  }

  console.log("========== PREMIERE UXP RUNTIME SCAN ==========");
  console.log("window.location.protocol:", window.location && window.location.protocol);
  console.log("window.location.href:", window.location && window.location.href);
  console.log("UXP module keys:", Object.keys(uxp).sort().join(", "));

  let extensionsPath = "(process.env is unavailable in this UXP runtime)";
  try {
    if (typeof process !== "undefined" && process && process.env) {
      extensionsPath = process.env.UXP_EXTENSIONS_PATH || "(not set)";
      console.log("process.env.UXP_EXTENSIONS_PATH:", extensionsPath);
      console.log(
        "process.env keys containing UXP/EXTENSION/PLUGIN:",
        Object.keys(process.env)
          .filter((key) => /UXP|EXTENSION|PLUGIN/i.test(key))
          .sort()
          .map((key) => `${key}=${process.env[key]}`)
          .join("\n") || "(none)",
      );
    } else {
      console.log("process.env.UXP_EXTENSIONS_PATH:", extensionsPath);
    }
  } catch (error) {
    console.error("Unable to inspect process.env:", error);
  }

  console.log("Active PluginManager entries:", plugins.length);
  plugins
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .forEach((plugin, index) => {
      const manifest = plugin.manifest || {};
      console.log(`[UXP PLUGIN ${index + 1}/${plugins.length}]`);
      console.log("  id:", plugin.id);
      console.log("  name:", plugin.name);
      console.log("  version:", plugin.version);
      console.log("  enabled:", plugin.enabled);
      console.log("  manifest:", JSON.stringify(manifest));
      console.log(
        "  physicalManifestPath:",
        "(not exposed by the public PluginManager Plugin object)",
      );
    });

  const targets = plugins.filter((plugin) => TARGET_IDS.has(String(plugin.id)));
  console.log(
    "Blocky Studios target entries:",
    targets.length
      ? targets.map((plugin) => `${plugin.id}@${plugin.version}`).join(", ")
      : "NONE",
  );

  async function recursivelyFindManifests(folder, nativeFolderPath, results) {
    const entries = await folder.getEntries();
    for (const entry of entries) {
      const separator = nativeFolderPath.includes("\\") ? "\\" : "/";
      const nativePath = `${nativeFolderPath.replace(/[\\/]+$/, "")}${separator}${entry.name}`;
      if (entry.isFolder) {
        await recursivelyFindManifests(entry, nativePath, results);
      } else if (String(entry.name).toLowerCase() === "manifest.json") {
        let manifest = null;
        try {
          manifest = JSON.parse(await entry.read());
        } catch (error) {
          manifest = { parseError: String(error) };
        }
        results.push({ path: nativePath, manifest });
      }
    }
  }

  try {
    const pluginFolder = await localFileSystem.getPluginFolder();
    const nativePluginFolder = localFileSystem.getNativePath(pluginFolder);
    const manifestResults = [];
    await recursivelyFindManifests(pluginFolder, nativePluginFolder, manifestResults);

    console.log("Current UXP sandbox plugin folder:", nativePluginFolder);
    for (const result of manifestResults) {
      console.log("CURRENT SANDBOX MANIFEST PATH:", result.path);
      console.log("CURRENT SANDBOX MANIFEST:", JSON.stringify(result.manifest));
      if (result.manifest && TARGET_IDS.has(String(result.manifest.id))) {
        console.log("ORACLE ACTIVE MANIFEST MATCH:", result.path);
      }
    }
  } catch (error) {
    console.error("Unable to resolve the current plugin folder:", error);
  }

  console.log(
    "NOTE: PluginManager exposes every loaded plugin and its manifest, but only",
    "getPluginFolder() exposes a native path, and that path is scoped to the",
    "console's current plugin sandbox. Other plugins' physical paths are not",
    "available through Premiere's public UXP JavaScript API.",
  );
  console.log("========== END PREMIERE UXP RUNTIME SCAN ==========");
})();
