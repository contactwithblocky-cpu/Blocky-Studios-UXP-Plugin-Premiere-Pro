"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const styleSource = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");
const m1StyleSource = fs.readFileSync(path.join(__dirname, "styles", "overdrive-m1.css"), "utf8");
const smoothStart = mainSource.indexOf("class SmoothWheelScroller");
const smoothEnd = mainSource.indexOf("class ReplayGridView", smoothStart);
const gridStart = mainSource.indexOf("class GridScaleControl");
const gridEnd = mainSource.indexOf("class OraclePanelController", gridStart);

test("Replay scrolling remains native and does not intercept wheel input", () => {
  const source = mainSource.slice(smoothStart, smoothEnd);
  assert.match(source, /Premiere\/UXP owns wheel propagation/);
  assert.doesNotMatch(source, /addEventListener\(["']wheel["']/);
  assert.doesNotMatch(source, /preventDefault\s*\(/);
  assert.doesNotMatch(source, /requestAnimationFrame|scrollTop\s*=/);
  assert.match(source, /start\(\)[\s\S]*this\.started = true/);
  assert.match(source, /destroy\(\)[\s\S]*this\.started = false/);
});

function createGridHarness() {
  const frames = new Map();
  let nextFrame = 1;
  let observer = null;
  const properties = new Map();
  const removedProperties = [];
  const cards = Array.from({ length: 7 }, () => ({
    style: {
      removeProperty(name) {
        removedProperties.push(name);
      },
    },
  }));
  const grid = {
    clientWidth: 900,
    style: {
      getPropertyValue(name) {
        return properties.get(name) || "";
      },
      setProperty(name, value) {
        properties.set(name, value);
      },
      removeProperty(name) {
        properties.delete(name);
        removedProperties.push(name);
      },
    },
    querySelectorAll() {
      return cards;
    },
  };
  const input = {
    min: "1",
    max: "6",
    step: "1",
    value: "3",
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
  };
  class MockResizeObserver {
    constructor(callback) {
      observer = { callback, disconnected: false };
    }
    observe(target) {
      observer.target = target;
    }
    disconnect() {
      observer.disconnected = true;
    }
  }
  const context = {
    Array,
    Math,
    Number,
    GRID_SCALE_STORAGE_KEY: "oracle-grid-scale",
    ResizeObserver: MockResizeObserver,
    window: {
      localStorage: { getItem: () => null, setItem() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };
  vm.runInNewContext(
    `${mainSource.slice(gridStart, gridEnd)}\nthis.GridScaleControl = GridScaleControl;`,
    context,
    { filename: "main.js#GridScaleControl" },
  );
  const control = new context.GridScaleControl(input, grid, { textContent: "" });
  control.start();
  function flushFrame() {
    const pending = Array.from(frames.values());
    frames.clear();
    pending.forEach((callback) => callback(16.667));
  }
  return { control, grid, cards, properties, removedProperties, frames, observer: () => observer, flushFrame };
}

test("responsive grid coalesces resize work and keeps every track exactly equal", () => {
  const harness = createGridHarness();
  harness.observer().callback();
  harness.observer().callback();
  assert.equal(harness.frames.size, 1);
  harness.flushFrame();
  assert.equal(harness.properties.get("--replay-grid-columns"), "3");

  for (const width of [500, 200, 900, 500, 900]) {
    harness.grid.clientWidth = width;
    harness.observer().callback();
    harness.flushFrame();
    const columns = Number(harness.properties.get("--replay-grid-columns"));
    const cardWidth = (width - (columns - 1) * 20) / columns;
    assert.equal(harness.properties.get("--replay-card-flex-basis"), `${cardWidth}px`);
    const widths = Array.from({ length: Math.min(columns, harness.cards.length) }, () => cardWidth);
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1);
    assert.ok(widths[0] - widths.at(-1) <= 1, "the first card must not grow wider");
  }
  assert.equal(harness.properties.get("--replay-grid-columns"), "3");
  assert.equal(harness.removedProperties.includes("--replay-card-basis"), false);
  harness.control.destroy();
  assert.equal(harness.observer().disconnected, true);
});

test("card CSS uses deterministic equal flex tracks without intrinsic image growth", () => {
  assert.match(m1StyleSource, /\.replay-grid-container\s*\{[^}]*--replay-card-basis:[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s);
  assert.match(m1StyleSource, /\.replay-card\s*\{[^}]*width:\s*var\(--replay-card-basis\);[^}]*min-width:\s*0;[^}]*flex:\s*0 0 var\(--replay-card-basis\);/s);
  assert.doesNotMatch(styleSource, /\.replay-card--dragging\s*\{[^}]*scale\(/);
  const thumbnailImageRule = m1StyleSource.match(/\.replay-thumbnail img\s*\{([^}]*)\}/s);
  assert.ok(thumbnailImageRule);
  assert.match(thumbnailImageRule[1], /position:\s*absolute;/);
  assert.match(thumbnailImageRule[1], /top:\s*0;/);
  assert.match(thumbnailImageRule[1], /right:\s*0;/);
  assert.match(thumbnailImageRule[1], /bottom:\s*0;/);
  assert.match(thumbnailImageRule[1], /left:\s*0;/);
  assert.doesNotMatch(thumbnailImageRule[1], /inset:/);
  assert.match(thumbnailImageRule[1], /min-width:\s*0;/);
  assert.match(thumbnailImageRule[1], /min-height:\s*0;/);
});
