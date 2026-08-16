// @ts-nocheck -- Node-only release audit; UXP never loads this file.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { inputPaths, outputPath } = require("./build-ui.cjs");
const { responsiveBreakpoints } = require("../src/core/oracle-ui-runtime.js");
const { RESPONSIVE_BREAKPOINTS: compilerBreakpoints } = require("./uxp-responsive-compiler.cjs");

const root = path.resolve(__dirname, "..");
const checkMode = process.argv.includes("--check");
const docsDirectory = path.join(root, "docs");
const jsonPath = path.join(docsDirectory, "uxp-platform-audit.json");
const markdownPath = path.join(docsDirectory, "uxp-platform-audit.md");

const ADOBE_CSS_REFERENCE = "https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-css/styles/";
const ADOBE_CSS_NEXT_REFERENCE = "https://developer.adobe.com/premiere-pro/uxp/uxp-api/changelog3-p";
const ADOBE_UI_REFERENCE = "https://developer.adobe.com/premiere-pro/uxp/resources/fundamentals/user-interfaces/";
const ADOBE_FONT_REFERENCE = "https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-css/styles/font-family";
const ADOBE_SWC_REFERENCE = "https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-spectrum/swc/";
const ADOBE_UNSUPPORTED_HTML_REFERENCE = "https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-html/general/unsupported-elements";

// The complete property index published by Adobe for Premiere UXP on 2026-08-13.
const SUPPORTED_CSS_PROPERTIES = Object.freeze([
  "align-content", "align-items", "align-self", "background-attachment", "background-color",
  "background-image", "background-repeat", "background-size", "background", "border-bottom-color",
  "border-bottom-left-radius", "border-bottom-right-radius", "border-bottom-style", "border-bottom-width",
  "border-bottom", "border-color", "border-left-color", "border-left-style", "border-left-width", "border-left",
  "border-radius", "border-right-color", "border-right-style", "border-right-width", "border-right", "border-style",
  "border-top-color", "border-top-left-radius", "border-top-style", "border-top-width", "border-top", "border-width",
  "bottom", "color", "display", "flex-basis", "flex-direction", "flex-grow", "flex-shrink", "flex-wrap", "flex",
  "font-family", "font-size", "font-style", "font-weight", "height", "justify-content", "left", "letter-spacing",
  "margin-bottom", "margin-left", "margin-right", "margin-top", "margin", "max-height", "max-width", "min-height",
  "min-width", "opacity", "overflow-x", "overflow-y", "overflow", "padding-bottom", "padding-left", "padding-right",
  "padding-top", "padding", "right", "text-align", "text-overflow", "top", "visibility", "white-space", "width",
]);
const SUPPORTED_SET = new Set(SUPPORTED_CSS_PROPERTIES);
const CSS_NEXT_PROPERTY_CAPABILITIES = Object.freeze({
  "box-shadow": "boxShadow",
  transform: "transformFunctions",
  "transform-origin": "transformProperties",
  translate: "transformProperties",
});
const SUPPORTED_DISPLAY_VALUES = new Set(["none", "inline", "block", "inline-block", "flex", "inline-flex"]);
const UNSUPPORTED_LIST_TAGS = new Set(["ul", "ol", "li"]);
const CONTROL_TAGS = new Set(["button", "input", "select", "textarea", "video"]);
const TEXT_EDIT_TYPES = new Set(["text", "search", "number", "email", "password", "tel", "url"]);

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/^\uFEFF/, "");
}

function lineAt(source, offset) {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function maskComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, " "));
}

function maskStringsAndComments(source) {
  const output = source.split("");
  let state = "code";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n" || character === "\r") state = "code";
      else output[index] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        output[index] = output[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (character !== "\n" && character !== "\r") output[index] = " ";
      continue;
    }
    if (state === "string") {
      if (character === "\\") {
        output[index] = " ";
        if (index + 1 < source.length) output[++index] = " ";
      } else if (character === quote) {
        output[index] = " ";
        state = "code";
      } else if (character !== "\n" && character !== "\r") output[index] = " ";
      continue;
    }
    if (character === "/" && next === "/") {
      output[index] = output[index + 1] = " ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      output[index] = output[index + 1] = " ";
      index += 1;
      state = "block-comment";
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output[index] = " ";
      state = "string";
    }
  }
  return output.join("");
}

function callRanges(source, functionName) {
  const masked = maskStringsAndComments(source);
  const ranges = [];
  const expression = new RegExp(`\\b${functionName}\\s*\\(`, "g");
  let match;
  while ((match = expression.exec(masked))) {
    const open = masked.indexOf("(", match.index);
    let depth = 0;
    for (let index = open; index < masked.length; index += 1) {
      if (masked[index] === "(") depth += 1;
      else if (masked[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          ranges.push([match.index, index + 1]);
          expression.lastIndex = index + 1;
          break;
        }
      }
    }
  }
  return ranges;
}

function insideRanges(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

function cssDeclarations(relativePath) {
  const source = read(relativePath);
  const masked = maskComments(source);
  const declarations = [];
  const expression = /(?:^|[;{])\s*((?:--)?[-a-zA-Z][\w-]*)\s*:\s*([^;{}]*)(?=;|})/gm;
  let match;
  while ((match = expression.exec(masked))) {
    const property = match[1].toLocaleLowerCase("en-US");
    const value = match[2].trim();
    const normalizedValue = value.replace(/\s*!important\s*$/i, "").trim().toLocaleLowerCase("en-US");
    const propertyOffset = match.index + match[0].indexOf(match[1]);
    let status = property.startsWith("--")
      ? "custom-property"
      : SUPPORTED_SET.has(property)
        ? "documented-supported"
        : Object.prototype.hasOwnProperty.call(CSS_NEXT_PROPERTY_CAPABILITIES, property)
          ? "documented-css-next"
          : "undocumented-by-adobe-reference";
    if (property === "display" && !normalizedValue.includes("var(") && !SUPPORTED_DISPLAY_VALUES.has(normalizedValue)) {
      status = "unsupported-display-value";
    }
    declarations.push({
      file: relativePath,
      line: lineAt(source, propertyOffset),
      property,
      value,
      status,
    });
  }
  return declarations;
}

function knownLayoutFailures(relativePath, source) {
  const results = [];
  const checks = [
    ["CSS_GRID", /\bdisplay\s*:\s*(?:inline-)?grid\b|\bgrid-(?:template|area|column|row|auto)\b/gi],
    ["FIXED_OR_STICKY_POSITION", /\bposition\s*:\s*(?:fixed|sticky)\b/gi],
    ["CSS_CONTAINMENT", /(?:^|[;{])\s*contain(?:er(?:-type|-name)?)?\s*:/gim],
    ["VIEWPORT_UNIT_LAYOUT", /(?:^|[;{])\s*(?:width|height|min-width|max-width|min-height|max-height|inset|top|right|bottom|left)\s*:[^;{}]*(?:\d|\))v(?:w|h|min|max)\b/gim],
    ["TRANSFORM_SCALE_LAYOUT", /\btransform\s*:[^;{}]*\bscale(?:3d|x|y)?\s*\(/gi],
    ["TRANSITION_ALL", /\btransition\s*:[^;{}]*\ball\b/gi],
    ["BACKDROP_FILTER", /\b(?:-webkit-)?backdrop-filter\s*:/gi],
  ];
  const masked = maskComments(source);
  for (const [code, expression] of checks) {
    let match;
    while ((match = expression.exec(masked))) {
      results.push({ code, file: relativePath, line: lineAt(source, match.index), excerpt: match[0].trim().slice(0, 180) });
    }
  }
  return results;
}

function knownScriptLayoutFailures(relativePath, source) {
  const results = [];
  const checks = [
    ["CSS_GRID_SCRIPT", /\.style\.setProperty\s*\(\s*["']grid-(?:template|area|column|row|auto)[^"']*["']|\.style\.grid(?:Template|Area|Column|Row|Auto)\b|\bdisplay\s*:\s*["'](?:inline-)?grid["']/gi],
  ];
  const masked = maskComments(source);
  for (const [code, expression] of checks) {
    for (const match of masked.matchAll(expression)) {
      results.push({ code, file: relativePath, line: lineAt(source, match.index), excerpt: match[0] });
    }
  }
  return results;
}

function parseAttributes(source) {
  const result = {};
  const expression = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = expression.exec(source))) result[match[1].toLocaleLowerCase("en-US")] = match[2] ?? match[3] ?? match[4] ?? true;
  return result;
}

function staticControls(htmlSource, swcUsed) {
  const controls = [];
  const expression = /<([a-zA-Z][\w-]*)(\s[^<>]*?)?>/g;
  let match;
  while ((match = expression.exec(htmlSource))) {
    const tag = match[1].toLocaleLowerCase("en-US");
    const attributes = parseAttributes(match[2] || "");
    if (!CONTROL_TAGS.has(tag) && !tag.startsWith("sp-") && attributes.role !== "button" && attributes.role !== "tab") continue;
    controls.push({
      source: "static-html",
      file: "index.html",
      line: lineAt(htmlSource, match.index),
      tag,
      id: typeof attributes.id === "string" ? attributes.id : "",
      type: typeof attributes.type === "string" ? attributes.type : "",
      role: typeof attributes.role === "string" ? attributes.role : "",
      hiddenAtAuthoringTime: Object.prototype.hasOwnProperty.call(attributes, "hidden"),
      technology: tag.startsWith("sp-") ? (swcUsed ? "spectrum-web-component" : "spectrum-uxp-widget") : "standard-html",
      fontOverride: tag === "textarea" || (tag === "input" && TEXT_EDIT_TYPES.has(String(attributes.type || "text").toLocaleLowerCase("en-US")))
        ? "host-controlled-text-edit"
        : "author-controlled",
    });
  }
  return controls;
}

function dynamicControls(scriptPaths) {
  const controls = [];
  for (const relativePath of scriptPaths) {
    const source = read(relativePath);
    const expression = /\.createElement\(\s*["'](button|input|select|textarea|video|sp-[\w-]+)["']\s*\)/gi;
    let match;
    while ((match = expression.exec(source))) {
      const tag = match[1].toLocaleLowerCase("en-US");
      controls.push({
        source: "dynamic-createElement",
        file: relativePath,
        line: lineAt(source, match.index),
        tag,
        id: "dynamic",
        type: "runtime-defined",
        role: "",
        hiddenAtAuthoringTime: false,
        technology: tag.startsWith("sp-") ? "unresolved-spectrum-tag" : "standard-html",
        fontOverride: tag === "textarea" || tag === "input" ? "host-controlled-when-text-edit" : "author-controlled",
      });
    }
  }
  return controls;
}

function loadedScripts(htmlSource) {
  return Array.from(htmlSource.matchAll(/<script\s+[^>]*src=["']([^"'?]+)(?:\?[^"']*)?["'][^>]*>/gi))
    .map((match) => match[1].replace(/\\/g, "/"))
    .filter((value) => value.endsWith(".js") && !value.startsWith("src/generated/"));
}

function lifecycleInventory(scriptPaths) {
  const patterns = {
    addEventListener: /\.addEventListener\s*\(/g,
    removeEventListener: /\.removeEventListener\s*\(/g,
    setTimeout: /\bsetTimeout\s*\(/g,
    clearTimeout: /\bclearTimeout\s*\(/g,
    setInterval: /\bsetInterval\s*\(/g,
    clearInterval: /\bclearInterval\s*\(/g,
    requestAnimationFrame: /\brequestAnimationFrame\s*\(/g,
    cancelAnimationFrame: /\bcancelAnimationFrame\s*\(/g,
    resizeObserver: /\bnew\s+(?:this\.)?(?:ResizeObserver[A-Za-z_$\w$]*|[A-Za-z_$][\w$]+ResizeObserver[A-Za-z_$\w$]*)\s*\(/g,
    mutationObserver: /\bnew\s+(?:this\.)?(?:MutationObserver[A-Za-z_$\w$]*|[A-Za-z_$][\w$]+MutationObserver[A-Za-z_$\w$]*)\s*\(/g,
    intersectionObserver: /\bnew\s+(?:this\.)?(?:IntersectionObserver[A-Za-z_$\w$]*|[A-Za-z_$][\w$]+IntersectionObserver[A-Za-z_$\w$]*)\s*\(/g,
    disconnect: /\.disconnect\s*\(/g,
  };
  return scriptPaths.map((relativePath) => {
    const source = read(relativePath);
    const masked = maskStringsAndComments(source);
    const counts = {};
    const sites = [];
    for (const [name, expression] of Object.entries(patterns)) {
      const matches = Array.from(masked.matchAll(expression));
      counts[name] = matches.length;
      for (const match of matches) {
        const line = lineAt(source, match.index);
        sites.push({
          kind: name,
          line,
          excerpt: source.split(/\r?\n/)[line - 1].trim().slice(0, 240),
        });
      }
    }
    const observerCount = counts.resizeObserver + counts.mutationObserver + counts.intersectionObserver;
    const singletonLifetimeListeners = relativePath === "src/core/oracle-ui-runtime.js" ? 2 : 0;
    return {
      file: relativePath,
      counts,
      sites,
      idempotencyEvidence: {
        destroyedGuard: /\bdestroyed\b/.test(masked),
        destroyMethod: /\bdestroy\s*\(/.test(masked),
        startGuard: /\b(?:started|bound|mounted|active)\b/.test(masked),
        setBackedSubscriptions: /new\s+Set\s*\(/.test(masked),
      },
      cleanupProof: {
        listenerSitesBalanced: counts.addEventListener - counts.removeEventListener === singletonLifetimeListeners,
        singletonLifetimeListeners,
        intervalSitesBalanced: counts.setInterval === counts.clearInterval,
        frameCancellationCovered: counts.requestAnimationFrame <= counts.cancelAnimationFrame,
        observerDisconnectCovered: observerCount <= counts.disconnect,
      },
    };
  }).filter((entry) => Object.values(entry.counts).some((value) => value > 0));
}

const HOST_METHODS = new Set([
  "PointF", "Color", "cast", "getUniqueID", "getActiveProject", "getActiveSequence", "getRootItem", "importFiles",
  "lockedAccess", "executeTransaction", "addAction", "getItems", "createBinAction", "getMediaFilePath",
  "getColorLabelIndex", "createSetColorLabelAction", "getId", "getEditor", "getPlayerPosition", "getVideoTrackCount",
  "getAudioTrackCount", "getVideoTrack", "getAudioTrack", "createInsertProjectItemAction", "getTrackItems", "getProjectItem",
  "getStartTime", "getEndTime", "getName", "getMatchName", "getType", "getMediaType", "getTrackIndex",
  "getComponentChain", "getComponentCount", "getComponentAtIndex", "getDisplayName", "getSettings", "getSelection",
  "getParamCount", "getParam", "isTimeVarying", "createKeyframe", "createSetValueAction", "createAppendComponentAction",
  "getStartValue", "createWithTicks", "createWithSeconds", "openProjectItem", "openFilePath", "play", "closeClip",
  "getPosition", "setPosition", "getDisplayNames", "getMatchNames", "createComponent", "createComponentByDisplayName",
  "getKeyframeCount", "getKeyframeAtIndex", "getKeyframe", "getValue", "getValueAtKey", "getValueAtTime",
  "getInterpolationType", "createSetInterpolationTypeAction", "createAddKeyframeAction", "createRemoveKeyframeAction",
  "createSetValueAtKeyAction", "getParamName", "getSequence", "getItemCount", "getItemAtIndex",
]);

function untracedCalls(scriptPaths, wrapperName, methodSet, receiverPattern) {
  const results = [];
  for (const relativePath of scriptPaths) {
    const source = read(relativePath);
    const masked = maskStringsAndComments(source);
    const ranges = callRanges(source, wrapperName);
    const expression = /((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = expression.exec(masked))) {
      const receiver = match[1];
      const method = match[2];
      if (!methodSet.has(method) || !receiverPattern.test(receiver) || insideRanges(match.index, ranges)) continue;
      results.push({ file: relativePath, line: lineAt(source, match.index), receiver, method });
    }
  }
  return results;
}

function fontAudit(cssEntries, controls) {
  const files = [
    "assets/fonts/samsung_sharp_sans_regular.otf",
    "assets/fonts/samsung_sharp_sans_medium.otf",
    "assets/fonts/samsung_sharp_sans_bold.otf",
  ].map((relativePath) => {
    const absolute = path.join(root, relativePath);
    return {
      file: relativePath,
      exists: fs.existsSync(absolute),
      bytes: fs.existsSync(absolute) ? fs.statSync(absolute).size : 0,
      sha256: fs.existsSync(absolute) ? sha256(absolute) : "",
    };
  });
  const forbidden = cssEntries.filter((entry) => entry.property === "font-family" && /\b(?:arial|helvetica|system-ui|sans-serif|serif|monospace)\b/i.test(entry.value));
  const css = inputPaths.map(read).join("\n");
  const faces = Array.from(css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)).map((match) => ({
    family: (match[1].match(/font-family\s*:\s*([^;]+)/i) || [null, ""])[1].trim(),
    weight: (match[1].match(/font-weight\s*:\s*([^;]+)/i) || [null, ""])[1].trim(),
    source: (match[1].match(/src\s*:\s*([^;]+)/i) || [null, ""])[1].trim(),
  }));
  return {
    expectedFamily: "Samsung Sharp Sans",
    packagedFiles: files,
    faces,
    forbiddenDeclarations: forbidden,
    hostControlledTextEditCandidates: controls.filter((entry) => entry.fontOverride.startsWith("host-controlled")),
    runtimeProof: {
      documentFontApiProbePresent: /document\.fonts|\.fonts\.load/.test(read("main.js")),
      nativePrivateRegistration: /registerPackagedFonts/.test(read("main.js")) && /AddFontResourceExW/.test(read("native/src/PackagedFontRegistrationService.cpp")),
      computedStyleWalker: /visibleTextElements/.test(read("src/core/oracle-ui-runtime.js")),
    },
    adobeException: "UXP does not allow font-family overrides on text edit fields; those controls are reported separately at runtime.",
  };
}

function countBy(values, key) {
  const result = {};
  for (const value of values) {
    const name = typeof key === "function" ? key(value) : value[key];
    result[name] = (result[name] || 0) + 1;
  }
  return result;
}

function authoredSwitchGroups(html, scripts) {
  const definitions = [
    { group: "workspace-route", attribute: "data-oracle-route" },
    { group: "preferences", attribute: "data-preferences-tab" },
    { group: "replay-view", attribute: "data-replay-view" },
    { group: "quick-apply-scope", attribute: "data-quick-apply-scope" },
  ];
  const scriptText = scripts.map(read).join("\n");
  return definitions.map((definition) => {
    const expression = new RegExp(`${definition.attribute}\\s*=\\s*["']([^"']+)["']`, "gi");
    const values = Array.from(html.matchAll(expression), (match) => match[1]);
    return {
      group: definition.group,
      attribute: definition.attribute,
      authoredValues: Array.from(new Set(values)),
      instrumented: new RegExp(`group:\\s*["']${definition.group}["']`).test(scriptText),
    };
  }).filter((entry) => entry.authoredValues.length > 0);
}

function markdown(report) {
  const undocumented = Object.entries(report.css.summary.undocumentedPropertyCounts).sort((a, b) => b[1] - a[1]);
  const lifecycleRows = report.lifecycle.files.map((entry) => `| ${entry.file} | ${entry.counts.addEventListener} / ${entry.counts.removeEventListener} | ${entry.counts.setTimeout} / ${entry.counts.clearTimeout} | ${entry.counts.requestAnimationFrame} / ${entry.counts.cancelAnimationFrame} | ${entry.counts.resizeObserver + entry.counts.mutationObserver + entry.counts.intersectionObserver} / ${entry.counts.disconnect} |`).join("\n");
  const technologyRows = Object.entries(report.controls.technologyCounts).map(([name, count]) => `| ${name} | ${count} |`).join("\n");
  return `# Premiere UXP platform audit\n\nGenerated: ${report.generatedAt}\n\nThis is a platform audit, not a visual redesign. The JSON sibling contains every declaration and every statically discoverable control. Actual visibility is proven at runtime by the \`[Blocky Studios][PLATFORM_RENDER]\` record emitted from each measured panel root.\n\n## Release result\n\n- Hard failures: ${report.hardFailures.length}\n- CSS declarations audited: ${report.css.summary.totalDeclarations}\n- Adobe core-property declarations: ${report.css.summary.statusCounts["documented-supported"] || 0}\n- Adobe CSSNext declarations: ${report.css.summary.statusCounts["documented-css-next"] || 0}\n- CSSNext capabilities required/enabled: ${report.css.cssNext.requiredCapabilities.join(", ") || "none"} / ${report.css.cssNext.enabledCapabilities.join(", ") || "none"}\n- Custom-property declarations: ${report.css.summary.statusCounts["custom-property"] || 0}\n- Undocumented by Adobe's complete property index: ${report.css.summary.statusCounts["undocumented-by-adobe-reference"] || 0}\n- Unsupported display-value declarations: ${report.css.summary.statusCounts["unsupported-display-value"] || 0}\n- Known unsupported layout failures: ${report.css.knownLayoutFailures.length}\n- Untraced Premiere calls: ${report.instrumentation.untracedPremiereCalls.length}\n- Untraced native calls: ${report.instrumentation.untracedNativeCalls.length}\n\n## Control technologies\n\n| Technology | Static/dynamic authored controls |\n|---|---:|\n${technologyRows}\n\nThere are ${report.swc.tags.length} \`sp-*\` tags, ${report.swc.dependencies.length} SWC dependencies, and the SWC manifest flag is ${report.swc.manifestFlag === true ? "enabled" : "disabled"}. With no SWC usage, the disabled flag and absent dependency graph are the compatible configuration.\n\n## Fonts\n\n- Family: ${report.fonts.expectedFamily}\n- Packaged binaries: ${report.fonts.packagedFiles.filter((entry) => entry.exists).length}/${report.fonts.packagedFiles.length}\n- @font-face mappings: ${report.fonts.faces.length}\n- Forbidden generic/legacy family declarations: ${report.fonts.forbiddenDeclarations.length}\n- Static host-controlled text-edit candidates: ${report.fonts.hostControlledTextEditCandidates.length}\n- Runtime computed-style walker: ${report.fonts.runtimeProof.computedStyleWalker}\n- Native private registration: ${report.fonts.runtimeProof.nativePrivateRegistration}\n\nAdobe documents that text edit fields cannot override \`font-family\`; runtime audit keeps those fields in a separate host-controlled allowlist instead of misreporting ordinary buttons and labels.\n\n## Responsive ownership\n\n- Root ResizeObserver implementation: ${report.responsive.rootResizeObserver}\n- Source/root breakpoints agree: ${report.responsive.breakpointsMatch}\n- Compiled width/height media queries remaining: ${report.responsive.compiledViewportMediaQueries}\n- Test matrix present: ${report.responsive.requestedMatrixTest}\n- Thirty-change coalescing test present: ${report.responsive.thirtyResizeTest}\n\n## Lifecycle source inventory\n\nCounts are source evidence, while runtime ownership diagnostics, idempotent destroy paths, and repeated-open tests provide duplication proof. A raw count alone is not treated as proof.\n\n| File | listeners add/remove | timers set/clear | rAF request/cancel | observers/disconnect |\n|---|---:|---:|---:|---:|\n${lifecycleRows}\n\n## Declarations absent from Adobe's published property index\n\n${undocumented.map(([property, count]) => `- \`${property}\`: ${count}`).join("\n") || "None."}\n\nThese declarations are explicitly classified as undocumented, not silently called supported. The release gate blocks known incompatible layout mechanisms (Grid, fixed/sticky positioning, containment, viewport-unit layout, transform scaling, transition-all, and backdrop filters). Adobe's gated CSSNext features are accepted only when every required capability is declared in the manifest.\n\n## Adobe references\n\n- ${ADOBE_CSS_REFERENCE}\n- ${ADOBE_CSS_NEXT_REFERENCE}\n- ${ADOBE_UI_REFERENCE}\n- ${ADOBE_FONT_REFERENCE}\n- ${ADOBE_SWC_REFERENCE}\n- ${ADOBE_UNSUPPORTED_HTML_REFERENCE}\n`;
}

function buildReport() {
  const html = read("index.html");
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));
  const scripts = loadedScripts(html);
  const dependencyEntries = Object.entries({ ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) });
  const swcDependencies = dependencyEntries.filter(([name]) => name.startsWith("@spectrum-web-components/") || name.startsWith("@swc-uxp-wrappers/"));
  const swcImports = [];
  for (const script of scripts) {
    const source = read(script);
    for (const match of source.matchAll(/["'](@(?:spectrum-web-components|swc-uxp-wrappers)\/[^"']+)["']/g)) swcImports.push({ file: script, line: lineAt(source, match.index), module: match[1] });
  }
  const spTags = Array.from(new Set(Array.from(html.matchAll(/<\/?(sp-[\w-]+)/gi), (match) => match[1].toLocaleLowerCase("en-US"))));
  const swcUsed = swcDependencies.length > 0 || swcImports.length > 0;
  const controls = [...staticControls(html, swcUsed), ...dynamicControls(scripts)];
  const declarations = inputPaths.flatMap(cssDeclarations);
  const layoutFailures = [
    ...inputPaths.flatMap((file) => knownLayoutFailures(file, read(file))),
    ...scripts.flatMap((file) => knownScriptLayoutFailures(file, read(file))),
  ];
  const distCss = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  const compiledViewportMediaQueries = Array.from(distCss.matchAll(/@media\s*\([^)]*(?:min|max)-(?:width|height)\s*:/gi)).length;
  const unsupportedTags = Array.from(html.matchAll(/<\/?([a-zA-Z][\w-]*)\b/g))
    .map((match) => ({ tag: match[1].toLocaleLowerCase("en-US"), line: lineAt(html, match.index) }))
    .filter((entry) => UNSUPPORTED_LIST_TAGS.has(entry.tag));

  const hostScripts = scripts.filter((file) => file === "main.js" || /oracle-premiere-(?:curves|effects)-adapter\.js$/.test(file));
  const receiverPattern = /^(?:this\.api|api|premiere|project|sequence|selection|track|trackItem|item|projectItem|baseItem|clipItem|clip|editor|sourceMonitor|manager|component|param|chain|rootFolder|parent|factory|videoFactory|audioFactory|serializable|compoundAction|ref\.chain|target\.ref\.chain)$/;
  const untracedPremiereCalls = untracedCalls(hostScripts, "tracePremiereCall", HOST_METHODS, receiverPattern);
  const nativeMethods = new Set();
  for (const script of scripts) {
    const source = read(script);
    for (const match of source.matchAll(/traceNativeCall\(\s*["']([^"']+)["']/g)) nativeMethods.add(match[1]);
  }
  const untracedNativeCalls = untracedCalls(scripts, "traceNativeCall", nativeMethods, /^(?:addon|nativeDragAddon|this\.nativeAddon)$/);

  const lifecycle = lifecycleInventory(scripts);
  const switchGroups = authoredSwitchGroups(html, scripts);
  const testCorpus = fs.readdirSync(root).filter((name) => name.endsWith(".test.cjs")).map(read).join("\n");
  const cssStatusCounts = countBy(declarations, "status");
  const undocumentedPropertyCounts = countBy(declarations.filter((entry) => entry.status === "undocumented-by-adobe-reference"), "property");
  const cssNextRequiredCapabilities = Array.from(new Set(
    declarations
      .filter((entry) => entry.status === "documented-css-next" && entry.value.toLocaleLowerCase("en-US") !== "none")
      .map((entry) => CSS_NEXT_PROPERTY_CAPABILITIES[entry.property]),
  )).sort();
  const cssNextSetting = manifest.featureFlags?.CSSNextSupport;
  const cssNextEnabledCapabilities = manifest.featureFlags?.enableSWCSupport === true || cssNextSetting === true
    ? ["boxShadow", "transformFunctions", "transformProperties"]
    : Array.isArray(cssNextSetting)
      ? Array.from(new Set(cssNextSetting.map(String))).sort()
      : [];
  const missingCssNextCapabilities = cssNextRequiredCapabilities.filter((name) => !cssNextEnabledCapabilities.includes(name));
  const fonts = fontAudit(declarations, controls);
  const breakpointsMatch = JSON.stringify(responsiveBreakpoints) === JSON.stringify(compilerBreakpoints);
  const hardFailures = [];
  for (const failure of layoutFailures) hardFailures.push(`${failure.code}:${failure.file}:${failure.line}`);
  for (const declaration of declarations.filter((entry) => entry.status === "unsupported-display-value")) {
    hardFailures.push(`UNSUPPORTED_DISPLAY_VALUE:${declaration.file}:${declaration.line}:${declaration.value}`);
  }
  if (compiledViewportMediaQueries > 0) hardFailures.push(`COMPILED_VIEWPORT_MEDIA_QUERIES:${compiledViewportMediaQueries}`);
  for (const entry of unsupportedTags) hardFailures.push(`UNSUPPORTED_HTML_TAG:${entry.tag}:index.html:${entry.line}`);
  for (const entry of untracedPremiereCalls) hardFailures.push(`UNTRACED_PREMIERE_CALL:${entry.file}:${entry.line}:${entry.receiver}.${entry.method}`);
  for (const entry of untracedNativeCalls) hardFailures.push(`UNTRACED_NATIVE_CALL:${entry.file}:${entry.line}:${entry.receiver}.${entry.method}`);
  for (const entry of lifecycle) {
    for (const [proof, passed] of Object.entries(entry.cleanupProof)) {
      if (proof === "singletonLifetimeListeners" || passed === true) continue;
      hardFailures.push(`LIFECYCLE_CLEANUP_UNPROVEN:${entry.file}:${proof}`);
    }
  }
  for (const entry of switchGroups.filter((group) => !group.instrumented)) hardFailures.push(`UNINSTRUMENTED_TAB_GROUP:${entry.group}`);
  for (const entry of fonts.packagedFiles.filter((font) => !font.exists)) hardFailures.push(`MISSING_FONT:${entry.file}`);
  for (const entry of fonts.forbiddenDeclarations) hardFailures.push(`FORBIDDEN_FONT:${entry.file}:${entry.line}:${entry.value}`);
  if (!breakpointsMatch) hardFailures.push("RESPONSIVE_BREAKPOINT_DRIFT");
  if (swcDependencies.some(([, version]) => String(version) !== "0.37.0")) hardFailures.push("SWC_VERSION_NOT_0.37.0");
  if (swcUsed && manifest.featureFlags?.enableSWCSupport !== true) hardFailures.push("SWC_MANIFEST_FLAG_MISSING");
  for (const capability of missingCssNextCapabilities) hardFailures.push(`CSS_NEXT_CAPABILITY_MISSING:${capability}`);

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    target: { premiere: manifest.host?.minVersion || "unknown", manifestVersion: manifest.manifestVersion, pluginVersion: manifest.version },
    references: { css: ADOBE_CSS_REFERENCE, cssNext: ADOBE_CSS_NEXT_REFERENCE, ui: ADOBE_UI_REFERENCE, fonts: ADOBE_FONT_REFERENCE, swc: ADOBE_SWC_REFERENCE, unsupportedHtml: ADOBE_UNSUPPORTED_HTML_REFERENCE },
    controls: { technologyCounts: countBy(controls, "technology"), totalAuthoredCandidates: controls.length, inventory: controls },
    swc: { dependencies: swcDependencies.map(([name, version]) => ({ name, version })), imports: swcImports, tags: spTags, manifestFlag: manifest.featureFlags?.enableSWCSupport === true, requiredVersion: "0.37.0" },
    css: {
      supportedPropertyCount: SUPPORTED_CSS_PROPERTIES.length,
      supportedProperties: SUPPORTED_CSS_PROPERTIES,
      cssNext: {
        propertyCapabilities: CSS_NEXT_PROPERTY_CAPABILITIES,
        requiredCapabilities: cssNextRequiredCapabilities,
        enabledCapabilities: cssNextEnabledCapabilities,
        missingCapabilities: missingCssNextCapabilities,
      },
      summary: { totalDeclarations: declarations.length, statusCounts: cssStatusCounts, undocumentedPropertyCounts },
      knownLayoutFailures: layoutFailures,
      declarations,
    },
    html: { unsupportedTags },
    fonts,
    responsive: {
      rootResizeObserver: /rootDimensions\(record\.root\)/.test(read("src/core/oracle-ui-runtime.js")) && /resizeObserver\.observe\(root\)/.test(read("src/core/oracle-ui-runtime.js")),
      compilerBreakpoints,
      runtimeBreakpoints: responsiveBreakpoints,
      breakpointsMatch,
      compiledViewportMediaQueries,
      requestedMatrixTest: ["240,500", "280,600", "320,700", "380,800", "420,600", "480,800", "600,700", "720,900", "900,900", "1200,900"].every((pair) => {
        const [width, height] = pair.split(",");
        return new RegExp(`width:\\s*${width},\\s*height:\\s*${height}`).test(read("oracle-ui-runtime.test.cjs"));
      }),
      thirtyResizeTest: /30 rapid resize|30 continuous|for \(let index = 0; index < 30/i.test(read("oracle-ui-runtime.test.cjs")),
    },
    lifecycle: {
      files: lifecycle,
      runtimeOwnershipAudit: /duplicateResources/.test(read("src/core/oracle-platform-telemetry.js")) && /repeatedPanelIds/.test(read("src/core/oracle-ui-runtime.js")),
      coalescedResizeGuard: /record\.destroyed \|\| record\.frame !== null/.test(read("src/core/oracle-ui-runtime.js")),
      repeatedLifecycleTests: /listener count|listeners.*(?:close|destroy|reopen)|does not duplicate|coalesc/i.test(testCorpus),
    },
    instrumentation: {
      premiereTraceCount: scripts.reduce((sum, file) => sum + Array.from(read(file).matchAll(/tracePremiereCall\s*\(/g)).length, 0),
      nativeTraceCount: scripts.reduce((sum, file) => sum + Array.from(read(file).matchAll(/traceNativeCall\s*\(/g)).length, 0),
      tabTraceCount: scripts.reduce((sum, file) => sum + Array.from(read(file).matchAll(/\.tabSwitch\s*\(|\btraceTabSwitch\s*\(/g)).length, 0),
      switchGroups,
      untracedPremiereCalls,
      untracedNativeCalls,
      runtimeAuditGlobal: "window.oraclePlatformAudit()",
    },
    hardFailures,
  };
}

function run() {
  const report = buildReport();
  fs.mkdirSync(docsDirectory, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdown(report), "utf8");
  const summary = {
    ok: report.hardFailures.length === 0,
    hardFailures: report.hardFailures.length,
    declarations: report.css.summary.totalDeclarations,
    controls: report.controls.totalAuthoredCandidates,
    technologies: report.controls.technologyCounts,
    untracedPremiereCalls: report.instrumentation.untracedPremiereCalls.length,
    untracedNativeCalls: report.instrumentation.untracedNativeCalls.length,
    json: relative(jsonPath),
    markdown: relative(markdownPath),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (checkMode && report.hardFailures.length > 0) {
    for (const failure of report.hardFailures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  }
  return report;
}

if (require.main === module) run();

module.exports = { buildReport, run, SUPPORTED_CSS_PROPERTIES };
