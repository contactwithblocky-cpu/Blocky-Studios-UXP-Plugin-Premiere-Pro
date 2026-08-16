// @ts-nocheck -- This release-only Node benchmark is outside the UXP runtime.
"use strict";

const os = require("node:os");
const { performance } = require("node:perf_hooks");
const replayApi = require("../src/replays/oracle-replay-library.js");
const effectApi = require("../src/quick-apply/oracle-effect-index.js");
const curveApi = require("../src/curves/oracle-curve-math.js");

function elapsed(operation) {
  const startedAt = performance.now();
  const value = operation();
  return { value, elapsedMs: performance.now() - startedAt };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function replayMessage(index) {
  const suffix = String(index).padStart(5, "0");
  return {
    type: "IMPORT_CLIP",
    schema: replayApi.BRIDGE_EVENT_SCHEMA,
    version: replayApi.BRIDGE_EVENT_VERSION,
    payload: {
      eventId: `m9-benchmark-${suffix}`,
      absolutePath: `D:\\Blocky Studios M9 Synthetic\\shot-${suffix}.mp4`,
      fileName: `shot-${suffix}.mp4`,
      timestamp: new Date(Date.UTC(2026, 6, 15, 18, 0, 0) + index).toISOString(),
      durationMs: 1000 + index,
      width: 1920,
      height: 1080,
      fps: 60,
      fileSize: 100000 + index,
      modifiedAt: new Date(Date.UTC(2026, 6, 15, 18, 0, 0) + index).toISOString(),
      fileIdentity: { key: `m9-benchmark-identity-${suffix}` },
      thumbnailBase64: "",
      displayNameOverride: index === 4321 ? "Needle Hero Orbit" : "",
    },
  };
}

async function main() {
  const memoryBefore = process.memoryUsage();
  const store = new replayApi.ReplayLibraryStore();
  const messages = Array.from({ length: 5000 }, (_, index) => replayMessage(index));
  const ingest = elapsed(() => store.replaceSnapshot(messages));
  const replaySearch = elapsed(() => store.select({ query: "needle hero orbit" }));

  const virtualizer = new replayApi.ReplayVirtualWindow({ overscanRows: 3, maximumItems: 180 });
  const virtualScroll = elapsed(() => {
    let maximumCommitted = 0;
    for (let frame = 0; frame < 1000; frame += 1) {
      const result = virtualizer.calculate({
        itemCount: 1000,
        columns: 3,
        rowHeight: 240,
        scrollTop: frame * 96,
        viewportHeight: 800,
      });
      maximumCommitted = Math.max(maximumCommitted, result.end - result.start);
    }
    return maximumCommitted;
  });

  const videoDisplayNames = [];
  const videoMatchNames = [];
  for (let index = 0; index < 4000; index += 1) {
    videoDisplayNames.push(`Installed Video Effect ${String(index).padStart(4, "0")}`);
    videoMatchNames.push(`ORACLE.M9.Video.${index}`);
  }
  const audioDisplayNames = Array.from(
    { length: 1000 },
    (_, index) => `Installed Audio Effect ${String(index).padStart(4, "0")}`,
  );
  const effectIndex = effectApi.createEffectIndex({
    hostVersion: "26.3.0",
    videoDisplayNames,
    videoMatchNames,
    audioDisplayNames,
  });
  effectApi.searchEffectIndex(effectIndex, "video effect 3999", { limit: 60 });
  const effectSearch = elapsed(() => effectApi.searchEffectIndex(
    effectIndex,
    "video effect 3999",
    { limit: 60 },
  ));

  const graphRefresh = elapsed(() => {
    let last = "";
    for (let index = 0; index < 1000; index += 1) {
      const offset = (index % 20) / 100;
      last = curveApi.createCurvePathData(
        [0.2 + offset, 0.1, 0.8 - offset, 0.9],
        { width: 960, height: 420, samples: 96 },
      );
    }
    return last.length;
  });

  const queue = new replayApi.BoundedTaskQueue(4);
  let active = 0;
  let maximumActive = 0;
  const thumbnailStartedAt = performance.now();
  const thumbnailConcurrency = Promise.all(Array.from({ length: 64 }, (_, index) =>
    queue.submit(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return index;
    })));
  await thumbnailConcurrency;
  const thumbnailTotalMs = performance.now() - thumbnailStartedAt;
  const queueShutdown = elapsed(() => queue.destroy());
  store.destroy();

  const memoryAfter = process.memoryUsage();
  const report = {
    schema: "com.blocky.oracle.m9-benchmark",
    version: 1,
    generatedAt: new Date().toISOString(),
    machine: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0] ? os.cpus()[0].model : "unknown",
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    measurements: {
      replaySnapshot5000Ms: round(ingest.elapsedMs),
      replaySearch5000Ms: round(replaySearch.elapsedMs),
      replaySearchResults: replaySearch.value.length,
      virtualScroll1000FramesTotalMs: round(virtualScroll.elapsedMs),
      virtualScrollMeanFrameMs: round(virtualScroll.elapsedMs / 1000, 6),
      virtualMaximumCommittedCards: virtualScroll.value,
      effectSearch5000Ms: round(effectSearch.elapsedMs),
      effectSearchFirst: effectSearch.value[0] ? effectSearch.value[0].displayName : "",
      graphRefresh1000TotalMs: round(graphRefresh.elapsedMs),
      graphRefreshMeanMs: round(graphRefresh.elapsedMs / 1000, 6),
      graphLastPathCharacters: graphRefresh.value,
      thumbnailTasks: 64,
      thumbnailMaximumConcurrency: maximumActive,
      thumbnailQueueTotalMs: round(thumbnailTotalMs),
      queueDestroyMs: round(queueShutdown.elapsedMs),
      heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    },
  };
  report.budgets = {
    replaySearchUnder50Ms: report.measurements.replaySearch5000Ms < 50,
    effectSearchUnder50Ms: report.measurements.effectSearch5000Ms < 50,
    virtualMeanFrameUnder16_7Ms: report.measurements.virtualScrollMeanFrameMs < 16.7,
    graphMeanRefreshUnder16_7Ms: report.measurements.graphRefreshMeanMs < 16.7,
    virtualDomAtMost180Cards: report.measurements.virtualMaximumCommittedCards <= 180,
    thumbnailConcurrencyAtMost4: maximumActive <= 4,
  };
  if (Object.values(report.budgets).some((passed) => passed !== true)) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack || error)}\n`);
  process.exitCode = 1;
});
