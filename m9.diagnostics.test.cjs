// @ts-nocheck -- Node's test globals are intentionally outside the UXP jsconfig.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  OracleDiagnosticBuffer,
  sanitizeDiagnosticValue,
} = require("./src/core/oracle-diagnostics.js");
const preferencesApi = require("./src/settings/oracle-preferences.js");

test("M9 diagnostics remain bounded and production-console silent by default", () => {
  const calls = [];
  const diagnostics = new OracleDiagnosticBuffer({
    limit: 16,
    now: (() => { let value = 0; return () => ++value; })(),
    console: { info(...args) { calls.push(args); }, log(...args) { calls.push(args); } },
  });
  for (let index = 0; index < 40; index += 1) {
    diagnostics.record("info", "cycle", { index });
  }
  const summary = diagnostics.summary();
  assert.equal(summary.capacity, 16);
  assert.equal(summary.totalRetained, 16);
  assert.equal(summary.latestSequence, 40);
  assert.equal(summary.records[0].sequence, 25);
  assert.equal(summary.counts.CYCLE, 16);
  assert.equal(calls.length, 0);
});

test("M9 diagnostics redact paths, payloads, thumbnails, avatars, and byte-like strings", () => {
  const sanitized = sanitizeDiagnosticValue({
    canonicalPath: "C:\\Users\\salim\\private.mov",
    nested: {
      sourcePath: "\\\\server\\share\\private.mov",
      message: "Could not read C:\\private\\clip.mov",
      thumbnailBase64: "/9j/" + "A".repeat(400),
      avatarBytes: [1, 2, 3],
      mediaType: "video",
      fileCount: 3,
    },
    payload: { private: true },
  });
  assert.equal(sanitized.canonicalPath, "[redacted]");
  assert.equal(sanitized.nested.sourcePath, "[redacted]");
  assert.equal(sanitized.nested.message, "[redacted]");
  assert.equal(sanitized.nested.thumbnailBase64, "[redacted]");
  assert.equal(sanitized.nested.avatarBytes, "[redacted]");
  assert.equal(sanitized.nested.mediaType, "video");
  assert.equal(sanitized.nested.fileCount, 3);
  assert.equal(sanitized.payload, "[redacted]");
  assert.doesNotMatch(JSON.stringify(sanitized), /salim|private\.mov|\/9j\//i);
});

test("M9 diagnostic console mirroring is explicit and receives only sanitized records", () => {
  const calls = [];
  const diagnostics = new OracleDiagnosticBuffer({
    consoleEnabled: true,
    console: { warn(...args) { calls.push(args); } },
  });
  diagnostics.record("warn", "path rejected", { path: "D:\\secret\\clip.mov", code: "INVALID_PATH" });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /PATH_REJECTED/);
  assert.equal(calls[0][1].details.path, "[redacted]");
  assert.doesNotMatch(JSON.stringify(calls), /secret|clip\.mov/i);
});

test("M9 support summaries expose bounded structured codes and explicit privacy flags", () => {
  const diagnostics = new OracleDiagnosticBuffer({ limit: 20 });
  diagnostics.record("error", "state_recovery_required", { candidateCount: 3, path: "C:\\private\\state.json" });
  const summary = diagnostics.summary({ limit: 5 });
  assert.deepEqual(summary.privacy, {
    fullPathsIncluded: false,
    mediaIncluded: false,
    thumbnailsIncluded: false,
    avatarBytesIncluded: false,
    payloadBytesIncluded: false,
  });
  assert.equal(summary.records.length, 1);
  assert.equal(summary.records[0].code, "STATE_RECOVERY_REQUIRED");
  assert.equal(summary.records[0].details.path, "[redacted]");
});

test("M9 Preferences re-whitelists support diagnostics and cannot export provider details", () => {
  const summary = preferencesApi.normalizeDiagnosticsSummary({
    capacity: 9999,
    totalRetained: 9999,
    latestSequence: 8,
    counts: { "state recovery required": 2 },
    records: [{
      sequence: 8,
      at: 100,
      level: "error",
      code: "state recovery required",
      details: {
        canonicalPath: "C:\\Users\\private\\state.json",
        thumbnailBase64: "/9j/" + "A".repeat(400),
      },
    }],
    privacy: { fullPathsIncluded: true, mediaIncluded: true },
  });
  assert.equal(summary.capacity, 500);
  assert.equal(summary.totalRetained, 500);
  assert.deepEqual(summary.counts, { STATE_RECOVERY_REQUIRED: 2 });
  assert.deepEqual(summary.records[0], {
    sequence: 8,
    at: 100,
    level: "error",
    code: "STATE_RECOVERY_REQUIRED",
  });
  assert.deepEqual(summary.nativeDragEvidence, []);
  assert.equal(JSON.stringify(summary).includes("private"), false);
  assert.deepEqual(summary.privacy, {
    fullPathsIncluded: false,
    mediaIncluded: false,
    thumbnailsIncluded: false,
    avatarBytesIncluded: false,
    payloadBytesIncluded: false,
  });
});

test("M9 support bundle retains only allowlisted native-drag evidence across the full bounded buffer", () => {
  const records = Array.from({ length: 60 }, (_, index) => ({
    sequence: index + 1,
    at: index + 1,
    level: "info",
    code: "routine_record",
    details: { path: `C:\\private\\${index}.mov` },
  }));
  records.splice(2, 0, {
    sequence: 100,
    at: 100,
    level: "info",
    code: "native_drag_invocation_latency",
    details: { gestureId: "gesture-100-1", replayId: "private-replay", latencyMs: 3.125, canonicalPath: "C:\\private\\clip.mov" },
  });
  records.splice(3, 0, {
    sequence: 101,
    at: 101,
    level: "info",
    code: "native_drag_completed",
    details: {
      gestureId: "gesture-100-1",
      replayId: "private-replay",
      requestId: 17,
      ok: true,
      dropped: true,
      cancelled: false,
      totalElapsedMs: 734.25,
      nativeDispatchMs: 2.75,
      nativeSnapshotElapsedMs: 733,
      effect: 1,
      finalEffect: 1,
      hresult: 262400,
      stage: "promise_resolved",
      requestReceived: true,
      pathValidated: true,
      leftButtonConfirmed: true,
      workerDispatched: true,
      oleInitialized: true,
      doDragDropEntered: true,
      doDragDropReturned: true,
      queryContinueDragCalls: 9,
      giveFeedbackCalls: 4,
      escapeObserved: false,
      promiseCreated: true,
      promiseResolved: true,
      promiseRejected: false,
      cancellationHookInstalled: true,
      errorCode: "",
      absolutePath: "C:\\private\\clip.mov",
      errorMessage: "private provider detail",
    },
  });

  const summary = preferencesApi.normalizeDiagnosticsSummary({ records, totalRetained: records.length }, 20);
  assert.equal(summary.records.length, 20, "ordinary support records remain compact");
  assert.equal(summary.nativeDragEvidence.length, 2, "early native evidence survives unrelated later records");
  assert.equal(summary.nativeDragEvidence[0].details.latencyMs, 3.125);
  assert.equal(summary.nativeDragEvidence[1].details.totalElapsedMs, 734.25);
  assert.equal(summary.nativeDragEvidence[1].details.nativeDispatchMs, 2.75);
  assert.equal(summary.nativeDragEvidence[1].details.stage, "PROMISE_RESOLVED");
  assert.equal(summary.nativeDragEvidence[1].details.doDragDropEntered, true);
  assert.equal(summary.nativeDragEvidence[1].details.promiseResolved, true);
  assert.doesNotMatch(JSON.stringify(summary.nativeDragEvidence), /private|replayId|absolutePath|errorMessage|clip\.mov/i);
});

test("M9 diagnostics load before application modules and Data & Diagnostics has a real bounded view", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const preferencesSource = fs.readFileSync(
    path.join(__dirname, "src", "settings", "oracle-preferences.js"),
    "utf8",
  );
  assert.ok(html.indexOf("src/core/oracle-diagnostics.js") < html.indexOf("src/app/oracle-shell.js"));
  assert.match(html, /data-diagnostics-summary/);
  assert.match(html, /data-diagnostics-records/);
  assert.match(preferencesSource, /diagnostics:\s*this\.readDiagnosticsSummary\(\)/);
  assert.match(preferencesSource, /normalizeDiagnosticsSummary\(this\.getDiagnosticsSummary\(\),\s*20\)/);
  assert.match(fs.readFileSync(path.join(__dirname, "main.js"), "utf8"), /oracleDiagnostics\.summary\(\{ limit: 200 \}\)/);
  assert.doesNotMatch(preferencesSource, /diagnostics:\s*\{\s*fullPathsIncluded/);
});

test("M9 production UI contains no stale milestone-gate copy", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const curvesAdapterSource = fs.readFileSync(
    path.join(__dirname, "src", "curves", "oracle-premiere-curves-adapter.js"),
    "utf8",
  );
  assert.doesNotMatch(html, /activates in Milestone|coming soon|future milestone/i);
  assert.doesNotMatch(curvesAdapterSource, /Milestone 9 matrix|future milestone/i);
  assert.match(html, /verified Premiere effect index/i);
  assert.match(curvesAdapterSource, /Premiere does not expose a safe speed-remapped keyframe time-basis conversion/i);
});
