"use strict";

(function exposeOracleDiagnostics(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (globalScope) {
    Reflect.set(globalScope, "OracleDiagnostics", api);
    if (!Reflect.get(globalScope, "oracleDiagnostics")) {
      Reflect.set(globalScope, "oracleDiagnostics", new api.OracleDiagnosticBuffer({
        console: Reflect.get(globalScope, "console"),
      }));
    }
  }
})(typeof window !== "undefined" ? window : null, function createOracleDiagnosticsApi() {
  const DEFAULT_LIMIT = 200;
  const MAX_LIMIT = 500;
  const MAX_DEPTH = 3;
  const MAX_KEYS = 32;
  const MAX_ARRAY = 24;
  const MAX_STRING = 320;
  const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\s]+|\\\\\?\\)/;
  const DATA_BYTES = /^(?:data:[^;,]+;base64,|[A-Za-z0-9+/]{160,}={0,2}$)/i;
  const SENSITIVE_KEY = /^(?:absolutePath|canonicalPath|filePath|filepath|path|paths|sourcePath|targetPath|directory|directories|replayRoot|replayRoots|relinkRoot|relinkRoots|projectPath|media|mediaBytes|payload|rawPayload|thumbnail|thumbnailBase64|thumbnailDataUrl|avatar|avatarUrl|avatarBytes|token|secret|password)$/i;
  const SAFE_SENSITIVE_SUFFIX = /(?:Count|Size|Length|Present|Included|Available|Type|State|Code|Hash)$/i;

  function cleanText(value, maximum = MAX_STRING) {
    let text = "";
    try { text = String(value == null ? "" : value); } catch (error) { text = "[unprintable]"; }
    return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maximum);
  }

  function redactString(value) {
    const text = cleanText(value);
    if (!text) return "";
    if (WINDOWS_PATH.test(text) || DATA_BYTES.test(text)) return "[redacted]";
    return text;
  }

  function sensitiveKey(key) {
    const normalized = cleanText(key, 96);
    return SENSITIVE_KEY.test(normalized) && !SAFE_SENSITIVE_SUFFIX.test(normalized);
  }

  function sanitizeDiagnosticValue(value, depth = 0, seen = null) {
    if (value === null || value === undefined) return value === undefined ? null : value;
    if (typeof value === "string") return redactString(value);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return cleanText(value, 80);
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (depth >= MAX_DEPTH) return "[bounded]";

    const visited = seen || new Set();
    if (visited.has(value)) return "[circular]";
    visited.add(value);
    try {
      if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY)
          .map((entry) => sanitizeDiagnosticValue(entry, depth + 1, visited))
          .filter((entry) => entry !== undefined);
      }
      const output = {};
      const keys = Object.keys(value).sort().slice(0, MAX_KEYS);
      for (const key of keys) {
        const cleanKey = cleanText(key, 96);
        if (!cleanKey) continue;
        if (sensitiveKey(cleanKey)) {
          output[cleanKey] = "[redacted]";
          continue;
        }
        const sanitized = sanitizeDiagnosticValue(value[key], depth + 1, visited);
        if (sanitized !== undefined) output[cleanKey] = sanitized;
      }
      return output;
    } catch (error) {
      return { error: "[unavailable]" };
    } finally {
      visited.delete(value);
    }
  }

  function normalizeLevel(value) {
    const level = cleanText(value, 16).toLocaleLowerCase("en-US");
    return ["debug", "info", "warn", "error"].includes(level) ? level : "info";
  }

  function normalizeCode(value) {
    return cleanText(value, 96)
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLocaleUpperCase("en-US") || "ORACLE_DIAGNOSTIC";
  }

  class OracleDiagnosticBuffer {
    constructor(options = {}) {
      const requested = Number(options.limit);
      this.limit = Number.isFinite(requested)
        ? Math.max(16, Math.min(MAX_LIMIT, Math.round(requested)))
        : DEFAULT_LIMIT;
      this.now = typeof options.now === "function" ? options.now : () => Date.now();
      this.console = options.console && typeof options.console === "object" ? options.console : null;
      this.consoleEnabled = options.consoleEnabled === true;
      this.records = [];
      this.sequence = 0;
    }

    setConsoleEnabled(value) {
      this.consoleEnabled = value === true;
      return this.consoleEnabled;
    }

    record(level, code, details = {}) {
      const entry = Object.freeze({
        sequence: ++this.sequence,
        at: Number(this.now()) || 0,
        level: normalizeLevel(level),
        code: normalizeCode(code),
        details: Object.freeze(sanitizeDiagnosticValue(details) || {}),
      });
      this.records.push(entry);
      if (this.records.length > this.limit) {
        this.records.splice(0, this.records.length - this.limit);
      }
      if (this.consoleEnabled && this.console) {
        const method = typeof this.console[entry.level] === "function"
          ? this.console[entry.level]
          : this.console.log;
        if (typeof method === "function") {
          try { method.call(this.console, `[Blocky Studios][${entry.code}]`, entry); } catch (error) { /* diagnostics stay non-fatal */ }
        }
      }
      return { ...entry, details: sanitizeDiagnosticValue(entry.details) };
    }

    snapshot(options = {}) {
      const requested = Number(options.limit);
      const limit = Number.isFinite(requested)
        ? Math.max(0, Math.min(this.limit, Math.round(requested)))
        : this.limit;
      return this.records.slice(Math.max(0, this.records.length - limit)).map((entry) => ({
        ...entry,
        details: sanitizeDiagnosticValue(entry.details),
      }));
    }

    summary(options = {}) {
      const records = this.snapshot({ limit: options.limit == null ? 20 : options.limit });
      const counts = {};
      for (const entry of this.records) counts[entry.code] = (counts[entry.code] || 0) + 1;
      return {
        bounded: true,
        capacity: this.limit,
        totalRetained: this.records.length,
        latestSequence: this.sequence,
        counts,
        records,
        privacy: {
          fullPathsIncluded: false,
          mediaIncluded: false,
          thumbnailsIncluded: false,
          avatarBytesIncluded: false,
          payloadBytesIncluded: false,
        },
      };
    }

    clear() {
      this.records.length = 0;
    }
  }

  return {
    OracleDiagnosticBuffer,
    sanitizeDiagnosticValue,
    normalizeCode,
  };
});
