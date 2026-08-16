// @ts-nocheck -- release packaging executes in Node, outside the UXP jsconfig.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const pluginRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "manifest.json"), "utf8"));

function parseArguments(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid package argument: ${key}`);
    values[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function discoverCoreRoot(explicitRoot) {
  const candidates = [];
  if (explicitRoot) candidates.push(path.resolve(explicitRoot));
  if (process.env.UXP_DEVTOOLS_CORE_ROOT) candidates.push(path.resolve(process.env.UXP_DEVTOOLS_CORE_ROOT));
  const tempRoot = os.tmpdir();
  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("oracle-udt-package-core-")) {
      candidates.push(path.join(tempRoot, entry.name));
    }
  }
  candidates.sort((left, right) => {
    try { return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs; } catch (_) { return 0; }
  });
  const relativeCommand = path.join(
    "node_modules", "@adobe", "uxp-devtools-core", "src", "core", "client", "plugin", "actions", "PluginPackageCommand.js",
  );
  for (const root of candidates) {
    const commandPath = path.join(root, relativeCommand);
    if (fs.existsSync(commandPath)) return { root, commandPath };
  }
  throw new Error(
    "Adobe UXP Developer Tools 2.2.1 packaging core was not found. Set UXP_DEVTOOLS_CORE_ROOT to an extracted UDT application root.",
  );
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const stageRoot = path.resolve(pluginRoot, "native", "build", "ccx-stage");
  const outputRoot = path.resolve(pluginRoot, "native", "build");
  const stage = path.resolve(args.stage || path.join(stageRoot, "com.blocky.oracle.v5"));
  const packageDir = path.resolve(args.out || path.join(outputRoot, `ccx-output-${manifest.version}`));
  if (!isWithin(stage, stageRoot) || !isWithin(packageDir, outputRoot)) {
    throw new Error("Private CCX stage/output must remain inside the plugin native/build release roots.");
  }
  const stageManifestPath = path.join(stage, "manifest.json");
  const privateNoticePath = path.join(stage, "PRIVATE_LOCAL_ACCEPTANCE_ONLY.txt");
  if (!fs.existsSync(stageManifestPath) || !fs.existsSync(privateNoticePath)) {
    throw new Error("The exact private-local stage is incomplete. Run release/stage-private-ccx.ps1 first.");
  }
  const stageManifest = JSON.parse(fs.readFileSync(stageManifestPath, "utf8"));
  if (stageManifest.id !== manifest.id || stageManifest.version !== manifest.version) {
    throw new Error("The staged manifest does not match the current source identity/version.");
  }

  const core = discoverCoreRoot(args["core-root"]);
  const PluginPackageCommand = require(core.commandPath);
  fs.mkdirSync(packageDir, { recursive: true });
  const ccxPath = path.join(packageDir, `${manifest.id}_premierepro.ccx`);
  if (fs.existsSync(ccxPath)) fs.rmSync(ccxPath);

  const startedAt = new Date().toISOString();
  const command = new PluginPackageCommand(null, {
    manifest: stageManifestPath,
    packageDir,
    apps: ["premierepro"],
  });
  const result = await command.package();
  if (!Array.isArray(result) || result.length !== 1 || result[0].success !== true || !fs.existsSync(ccxPath)) {
    throw new Error(`UDT packaging failed: ${JSON.stringify(result)}`);
  }
  const outcome = {
    schema: "blocky-studios-udt-private-package-v1",
    startedAt,
    completedAt: new Date().toISOString(),
    implementation: core.commandPath,
    stage,
    packageDir,
    result: result.map((entry) => ({
      success: Boolean(entry.success),
      host: String(entry.host || ""),
      error: entry.error ? String(entry.error.message || entry.error) : null,
    })),
    ccx: {
      path: ccxPath,
      bytes: fs.statSync(ccxPath).size,
      sha256: sha256(ccxPath),
    },
  };
  fs.writeFileSync(path.join(packageDir, "UDT_PACKAGE_OUTCOME.json"), `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(outcome.ccx)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
