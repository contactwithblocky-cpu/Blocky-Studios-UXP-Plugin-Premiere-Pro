"use strict";

(function exposeOraclePlatformTelemetry(globalScope, factory) {
  const api = factory(globalScope);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (!globalScope) return;
  Reflect.set(globalScope, "OraclePlatformTelemetry", api);
  if (!Reflect.get(globalScope, "oraclePlatformTelemetry")) {
    Reflect.set(globalScope, "oraclePlatformTelemetry", api.createOraclePlatformTelemetry({ window: globalScope }));
  }
  if (!Reflect.get(globalScope, "oraclePlatformAudit")) {
    Reflect.set(globalScope, "oraclePlatformAudit", () => Reflect.get(globalScope, "oraclePlatformTelemetry").audit());
  }
})(typeof window !== "undefined" ? window : null, function createOraclePlatformTelemetryApi(globalScope) {
  const DEFAULT_CAPACITY = 1000;

  function clean(value, maximum = 240) {
    let text = "";
    try { text = String(value == null ? "" : value); } catch (error) { text = "[unavailable]"; }
    return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maximum);
  }

  function finiteTime(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function freezeDetail(value, depth = 0, seen = null) {
    if (value === null || value === undefined) return value === undefined ? null : value;
    if (["string", "number", "boolean"].includes(typeof value)) {
      return typeof value === "string" ? clean(value, 320) : value;
    }
    if (typeof value !== "object" || depth >= 3) return "[unavailable]";
    const visited = seen || new Set();
    if (visited.has(value)) return "[circular]";
    visited.add(value);
    let output;
    if (Array.isArray(value)) {
      output = value.slice(0, 32).map((entry) => freezeDetail(entry, depth + 1, visited));
    } else {
      output = {};
      for (const key of Object.keys(value).sort().slice(0, 32)) {
        output[clean(key, 80)] = freezeDetail(value[key], depth + 1, visited);
      }
    }
    visited.delete(value);
    return Object.freeze(output);
  }

  function createOraclePlatformTelemetry(options = {}) {
    const runtimeWindow = options.window || globalScope || null;
    const capacity = Math.max(100, Math.min(5000, Number(options.capacity) || DEFAULT_CAPACITY));
    const records = [];
    const activeCalls = new Map();
    const resourceOwners = new Map();
    let nextSequence = 1;
    let nextCallId = 1;
    let nextResourceId = 1;

    const now = typeof options.now === "function"
      ? options.now
      : () => {
          const performanceObject = runtimeWindow && runtimeWindow.performance;
          return performanceObject && typeof performanceObject.now === "function"
            ? performanceObject.now()
            : Date.now();
        };

    function diagnostic(level, code, details) {
      const buffer = runtimeWindow && runtimeWindow.oracleDiagnostics;
      if (!buffer || typeof buffer.record !== "function") return;
      try { buffer.record(level, code, details); } catch (error) { /* Diagnostics never own call behavior. */ }
    }

    function append(kind, details = {}) {
      const entry = Object.freeze({
        sequence: nextSequence++,
        at: finiteTime(Date.now()),
        kind: clean(kind, 80),
        details: freezeDetail(details),
      });
      records.push(entry);
      if (records.length > capacity) records.splice(0, records.length - capacity);
      return entry;
    }

    function completeCall(callId, status, startedAt, category, name, details, error) {
      activeCalls.delete(callId);
      const payload = {
        callId,
        category,
        name,
        status,
        durationMs: Math.max(0, finiteTime(now()) - finiteTime(startedAt)),
        details,
      };
      if (error) payload.error = clean(error && error.message || error, 320);
      append("platform-call", payload);
      diagnostic(status === "failed" ? "error" : "info", `PLATFORM_CALL_${status.toLocaleUpperCase("en-US")}`, payload);
    }

    function invoke(category, name, operation, details = {}) {
      if (typeof operation !== "function") throw new TypeError("Platform telemetry requires a callable operation.");
      const safeCategory = clean(category, 40) || "unknown";
      const safeName = clean(name, 160) || "unnamed";
      const callId = nextCallId++;
      const startedAt = finiteTime(now());
      const safeDetails = freezeDetail(details);
      activeCalls.set(callId, Object.freeze({ callId, category: safeCategory, name: safeName, startedAt, details: safeDetails }));
      append("platform-call-start", { callId, category: safeCategory, name: safeName, details: safeDetails });
      diagnostic("info", "PLATFORM_CALL_START", { callId, category: safeCategory, name: safeName });
      let result;
      try {
        result = operation();
      } catch (error) {
        completeCall(callId, "failed", startedAt, safeCategory, safeName, safeDetails, error);
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result.then(
          (value) => {
            completeCall(callId, "succeeded", startedAt, safeCategory, safeName, safeDetails, null);
            return value;
          },
          (error) => {
            completeCall(callId, "failed", startedAt, safeCategory, safeName, safeDetails, error);
            throw error;
          },
        );
      }
      completeCall(callId, "succeeded", startedAt, safeCategory, safeName, safeDetails, null);
      return result;
    }

    function tabSwitch(details = {}) {
      const startedAt = finiteTime(now());
      const payload = {
        panelId: clean(details.panelId, 96),
        group: clean(details.group, 96),
        from: clean(details.from, 96),
        to: clean(details.to, 96),
        trigger: clean(details.trigger, 48) || "programmatic",
      };
      if (!payload.to || payload.from === payload.to) return null;
      const entry = append("tab-switch", payload);
      diagnostic("info", "PLATFORM_TAB_SWITCH", payload);
      const root = details.root;
      const uiRuntime = runtimeWindow && runtimeWindow.oracleUiRuntime;
      if (root && uiRuntime) {
        try {
          if (typeof uiRuntime.captureAfterLayout === "function") {
            uiRuntime.captureAfterLayout(root, `tab-settled:${payload.group}:${payload.to}`);
          } else if (typeof uiRuntime.capture === "function") {
            uiRuntime.capture(root, `tab:${payload.group}:${payload.to}`);
          }
        } catch (error) { /* Tab behavior remains authoritative. */ }
      }
      settleInteraction("tab-switch", payload, startedAt);
      return entry;
    }

    function settleInteraction(kind, payload, startedAt) {
      const complete = () => {
        const details = {
          ...payload,
          durationMs: Math.max(0, finiteTime(now()) - finiteTime(startedAt)),
        };
        const entry = append(`${kind}-settled`, details);
        const runtimeConsole = runtimeWindow && runtimeWindow.console;
        if (runtimeConsole && typeof runtimeConsole.info === "function") {
          try {
            runtimeConsole.info("[Blocky Studios][UI_SETTLED]", {
              kind: entry.kind,
              ...details,
            });
          } catch (error) { /* Production interaction behavior never depends on logging. */ }
        }
        return entry;
      };
      const schedule = runtimeWindow && runtimeWindow.requestAnimationFrame;
      if (typeof schedule === "function") {
        schedule(() => schedule(complete));
      } else {
        Promise.resolve().then(complete);
      }
    }

    function interaction(details = {}) {
      const payload = {
        panelId: clean(details.panelId, 96),
        name: clean(details.name, 120) || "ui-interaction",
        action: clean(details.action, 80),
        trigger: clean(details.trigger, 48) || "interaction-or-controller",
        state: clean(details.state, 160),
      };
      const startedAt = finiteTime(now());
      const entry = append("ui-interaction", payload);
      diagnostic("info", "PLATFORM_UI_INTERACTION", payload);
      const root = details.root;
      const uiRuntime = runtimeWindow && runtimeWindow.oracleUiRuntime;
      if (root && uiRuntime && typeof uiRuntime.captureAfterLayout === "function") {
        try { uiRuntime.captureAfterLayout(root, `interaction-settled:${payload.name}:${payload.action}`); } catch (error) { /* UI behavior remains authoritative. */ }
      }
      settleInteraction("ui-interaction", payload, startedAt);
      return entry;
    }

    function claimResource(owner, type, key) {
      const ownerName = clean(owner, 120) || "unknown-owner";
      const resourceType = clean(type, 80) || "resource";
      const resourceKey = clean(key, 160) || "default";
      const identity = `${resourceType}|${resourceKey}`;
      const resourceId = nextResourceId++;
      if (!resourceOwners.has(identity)) resourceOwners.set(identity, new Map());
      const owners = resourceOwners.get(identity);
      owners.set(resourceId, ownerName);
      if (owners.size > 1) {
        const payload = { type: resourceType, key: resourceKey, owners: Array.from(owners.values()) };
        append("duplicate-resource", payload);
        diagnostic("error", "PLATFORM_DUPLICATE_RESOURCE", payload);
      }
      let active = true;
      return Object.freeze({
        id: resourceId,
        release() {
          if (!active) return false;
          active = false;
          owners.delete(resourceId);
          if (owners.size === 0) resourceOwners.delete(identity);
          return true;
        },
      });
    }

    function audit() {
      const duplicateResources = [];
      let resourceCount = 0;
      for (const [identity, owners] of resourceOwners) {
        resourceCount += owners.size;
        if (owners.size > 1) {
          duplicateResources.push(Object.freeze({ identity, owners: Object.freeze(Array.from(owners.values())) }));
        }
      }
      const callRecords = records.filter((entry) => entry.kind === "platform-call");
      const tabs = records.filter((entry) => entry.kind === "tab-switch");
      const interactions = records.filter((entry) => entry.kind === "ui-interaction");
      const categoryCounts = {};
      for (const entry of callRecords) {
        const category = clean(entry.details && entry.details.category, 40) || "unknown";
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      }
      return Object.freeze({
        available: true,
        bounded: true,
        capacity,
        retained: records.length,
        activeCallCount: activeCalls.size,
        activeCalls: Object.freeze(Array.from(activeCalls.values())),
        completedCallCount: callRecords.length,
        callCategoryCounts: Object.freeze(categoryCounts),
        tabSwitchCount: tabs.length,
        uiInteractionCount: interactions.length,
        activeResourceCount: resourceCount,
        duplicateResources: Object.freeze(duplicateResources),
        records: Object.freeze(records.slice()),
      });
    }

    return Object.freeze({ invoke, tabSwitch, interaction, claimResource, audit });
  }

  return Object.freeze({ createOraclePlatformTelemetry });
});
