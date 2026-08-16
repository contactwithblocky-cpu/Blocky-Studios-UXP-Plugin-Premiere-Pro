// @ts-nocheck -- release-only CSS compiler executes in Node, outside UXP.

"use strict";

const RESPONSIVE_BREAKPOINTS = Object.freeze({
  maxWidth: Object.freeze([340, 360, 380, 460, 476, 480, 500, 520, 560, 600, 620, 700, 720]),
  minWidth: Object.freeze([601, 900]),
  maxHeight: Object.freeze([420, 520]),
  minHeight: Object.freeze([]),
});

function matchingBrace(source, openingIndex) {
  let depth = 0;
  let quote = "";
  let comment = false;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (comment) {
      if (character === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      comment = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unbalanced CSS block while compiling panel-root responsiveness.");
}

function splitSelectors(value) {
  const selectors = [];
  let start = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "," && parenthesisDepth === 0 && bracketDepth === 0) {
      selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(value.slice(start).trim());
  return selectors.filter(Boolean);
}

function breakpointAttribute(dimension, comparison, pixels) {
  const axis = dimension === "width" ? "width" : "height";
  return `data-oracle-${comparison}-${axis}-${pixels}`;
}

function responsiveRootSelector(condition, sourcePath = "stylesheet") {
  const terms = [];
  const pattern = /\(\s*(max|min)-(width|height)\s*:\s*(\d+)px\s*\)/gi;
  let match;
  while ((match = pattern.exec(condition))) {
    const comparison = match[1].toLocaleLowerCase("en-US");
    const dimension = match[2].toLocaleLowerCase("en-US");
    const pixels = Number(match[3]);
    terms.push(`[${breakpointAttribute(dimension, comparison, pixels)}="true"]`);
  }
  const residue = condition
    .replace(pattern, "")
    .replace(/\band\b/gi, "")
    .replace(/[\s,]+/g, "")
    .trim();
  if (!terms.length || residue) {
    throw new Error(`${sourcePath} contains a viewport media condition that cannot be compiled per panel root: ${condition}`);
  }
  return `.oracle-panel${terms.join("")}`;
}

function prefixSelector(selector, rootSelector) {
  const value = selector.trim();
  if (!value) return value;
  if (value === ":root" || value === "html" || value === "body") return rootSelector;
  if (/^\.oracle-panel(?=$|[\s.#:\[])/.test(value)) {
    return value.replace(/^\.oracle-panel/, rootSelector);
  }
  return `${rootSelector} ${value}`;
}

function compileFlatRules(body, rootSelector, sourcePath) {
  let output = "";
  let cursor = 0;
  while (cursor < body.length) {
    const openingIndex = body.indexOf("{", cursor);
    if (openingIndex < 0) {
      output += body.slice(cursor);
      break;
    }
    const closingIndex = matchingBrace(body, openingIndex);
    const rawHeader = body.slice(cursor, openingIndex);
    const leadingMatch = /^(\s*(?:\/\*[\s\S]*?\*\/\s*)*)/.exec(rawHeader);
    const leading = leadingMatch ? leadingMatch[1] : "";
    const selectorHeader = rawHeader.slice(leading.length).trim();
    if (!selectorHeader || selectorHeader.startsWith("@")) {
      throw new Error(`${sourcePath} contains a nested at-rule in a responsive block; make it explicit before release.`);
    }
    const selectors = splitSelectors(selectorHeader).map((selector) => prefixSelector(selector, rootSelector));
    output += `${leading}${selectors.join(",\n")} {${body.slice(openingIndex + 1, closingIndex)}}`;
    cursor = closingIndex + 1;
  }
  return output;
}

function compilePanelResponsiveCss(source, sourcePath = "stylesheet") {
  let output = "";
  let cursor = 0;
  const mediaPattern = /@media\s*([^\{]+)\{/gi;
  while (true) {
    mediaPattern.lastIndex = cursor;
    const match = mediaPattern.exec(source);
    if (!match) {
      output += source.slice(cursor);
      break;
    }
    const condition = match[1].trim();
    const openingIndex = mediaPattern.lastIndex - 1;
    const closingIndex = matchingBrace(source, openingIndex);
    output += source.slice(cursor, match.index);
    if (/\b(?:max|min)-(?:width|height)\b/i.test(condition)) {
      const rootSelector = responsiveRootSelector(condition, sourcePath);
      const body = source.slice(openingIndex + 1, closingIndex);
      output += `/* Premiere panel-root responsive rule: ${condition} */\n`;
      output += compileFlatRules(body, rootSelector, sourcePath);
    } else {
      output += source.slice(match.index, closingIndex + 1);
    }
    cursor = closingIndex + 1;
  }
  return output;
}

module.exports = {
  RESPONSIVE_BREAKPOINTS,
  breakpointAttribute,
  compilePanelResponsiveCss,
  responsiveRootSelector,
};
