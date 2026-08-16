# Blocky Studios Overdrive Milestone 0

Status: **automation complete; physical acceptance still gated**  
Plugin version: `2.0.14` (unchanged)  
Baseline date: 2026-07-15

Milestone 0 establishes evidence, boundaries, disabled rollout switches, and a
versioned data contract. It does not ship the Overdrive shell, replay lifecycle,
viewer, Curves, Quick Apply, multiple panels, or destructive file operations.

## Verified baseline

- `npm run verify`: 60/60 pre-change tests passed with JavaScript syntax and
  TypeScript declaration checks.
- Release Hybrid addon build: passed. Staged and deployed binaries were both
  338,944 bytes with SHA-256
  `AAB609E2AA099FDE30EB5277FE2AE846480FED882639220E6BFBDE59075DC3A2`.
- `npm run native:test`: CTest 1/1 passed in 1.19 seconds before the patch.
- `npm audit` and `npm audit --omit=dev`: zero known vulnerabilities.
- Premiere Pro 26.3, UXP Developer Tool, and Minecraft were running. Premiere
  PID 27800 had an established loopback WebSocket connection to Java PID 27112
  on `127.0.0.1:3001`.
- A read-only subscriber received `bridge_hello` followed by `snapshot`.
- Premiere had loaded the addon from this checkout's exact `win/x64` path.
- The active Premiere project was real user work, so no media insertion,
  destructive file operation, panel unload, or active-drag shutdown test was
  performed.
- `.git` is an empty directory, not a working repository. Current files are
  treated as user-owned source truth; Git cannot provide a clean-tree baseline.

## Root causes corrected in the foundation patch

### Native drag ordering

`ReplayGridView.beginNativeReplayDrag` awaited `prepareReplaySource`, ProjectItem
label verification, and a timeline snapshot before calling
`startNativeFileDrag`. Release or Escape during that wait prevented OLE entry.
That contradicted the required immediate gesture contract.

The view now calls the existing native addon synchronously at the threshold,
before its first `await` and before every ProjectItem, import, label, timeline,
self-test, or file-inspection operation. Existing asynchronous prewarming remains
independent. A successful native drop schedules exact-path ProjectItem label-9
reconciliation afterward. There is still no HTML drag or active-playhead fallback.
The proven C++ STA/OLE worker was not changed.

The immutable canonical path captured at pointerdown is also carried through the
native result and used for reconciliation, so a bridge snapshot cannot retarget
label work while OLE is active.

### Permanent history hydration

`restorePersisted` and `replaceSnapshot` repeatedly scanned growing arrays.
Measured pre-change restore time was 7.8 ms for 100 records, 625.0 ms for 1,000,
and 19,235.7 ms for 5,000.

`ReplayIdentityIndex` now indexes stable IDs plus path/timestamp buckets for the
15-second duplicate window. Restore and snapshot reconciliation are linear for
valid state. The automated 5,000-record measurement is retained as a regression
test.

### Bridge event stability

`IMPORT_CLIP` discarded the exporter timestamp and regenerated `completedAt` on
every reconnect. The normalization path now preserves `timestamp` and stable
`eventId`/`exportId` aliases. Replay acceptance also requires an absolute local
path instead of a nonempty string. Windows path checks retain drive, Unicode,
extended-length, and UNC paths while rejecting POSIX/relative paths, traversal,
device namespaces, reserved device names, control characters, and alternate
data streams.

## Post-patch verification

- `npm run verify`: 73/73 tests passed, including syntax and installed
  Premiere 26.3 declaration checks.
- Latest full-suite 5,000-record hydration: 85.7 ms under parallel test load;
  the focused run measured 66.9 ms.
- `npm run native:build`: Release build passed and safely skipped replacing the
  identical loaded destination hash.
- `npm run native:test`: rebuilt Release targets, then CTest passed 1/1 (1.23
  seconds for the test, 1.31 seconds total).
- The restarted Minecraft client (Java PID 20252) owned a `LISTEN` socket on
  `127.0.0.1:3001`; a final read-only subscriber received `bridge_hello` and
  `snapshot` without publishing media.
- UDT's workspace still points at this exact manifest. Load & Watch recorded
  successful reload commands during the edit sequence, but Premiere disconnected
  before the final source revision. Premiere later reconnected with a real user
  project open, but UDT did not reload the plugin after reconnect. Final-revision
  reload and physical drag therefore remain pending rather than inferred.

## Current architecture and target boundaries

| Boundary | Current implementation | Incremental target |
| --- | --- | --- |
| Bootstrap/addon load | `main.js` async Hybrid `require` | `OracleBootstrap` plus versioned capability negotiation |
| Native dragging | Proven `NativeDragWorker` STA + Shell `IDataObject` | `NativeDragService` adapter; preserve exports and worker |
| Bridge | `OracleBridgeClient` in `main.js` | Versioned `BridgeClient` with hello/schema/size validation |
| Premiere access | `PremiereGateway` | `PremiereAdapter` services with transaction/readback contracts |
| Replay state | Mutable `ReplayStore` | Immutable/selectable `ReplayRepository` using state v3 |
| Persistence | v2 JSON/localStorage union | Complete snapshots, atomic replace, backup/recovery, tombstones |
| View | `ReplayGridView` and static single-panel DOM | Shared shell/router/layer manager and virtualized keyed views |
| Preferences | Theme-only local state | Versioned `PreferencesStore` and section-level reset/export |
| Native metadata | None | Bounded MTA `MediaMetadataService`, capability-gated |
| Directory changes | JavaScript polling | IOCP watcher service with polling fallback |
| File lifecycle | None | Dedicated STA `FileOperationService`, identity guarded |

New pure modules under `src/` are not loaded by the UXP runtime yet. This keeps
the current plugin load path stable while their contracts are tested.

## Premiere Pro 26.3 capability matrix

| Capability | Classification | Supported integration |
| --- | --- | --- |
| Multiple panel/command entrypoints | Supported, runtime probe required | Manifest v6 entrypoints; panels share one JS context per Adobe guidance |
| Active project/sequence/selection/player position | Supported | Installed `@adobe/premierepro@26.3.0` declarations |
| Video/audio component parameters | Supported | Component chains and parameter keyframe CRUD |
| Interpolation modes | Supported, bounded | Documented enum only; no invented tangent/influence controls |
| Video effects | Supported | `VideoFilterFactory` match names plus transaction/readback |
| Audio effects | Supported with weaker identity | Display-name factory; compatibility probe required |
| Source Monitor open/seek/play | Supported, bounded | No documented loop/mute/volume/duration API |
| Relink | Supported, non-undoable | `canChangeMediaPath` and `changeMediaFilePath` with confirmation |
| Native file identity/metadata/watch/file operations | Requires Hybrid | Separate bounded services; not the drag worker thread |
| Arbitrary Bezier tangents/influence | Impossible in supported 26.3 API | Do not expose; bounded baked-key mode may be offered later |
| `.prfpset` enumeration/application | Not supported | No fake preset browser or undocumented payloads |
| TrackItem color label action | Not supported | ProjectItem label index 9 only; no undocumented TrackItem write |
| Manifest keyboard shortcut registration | Not available in Premiere | Experimental command/hotkey spike remains off |
| Full Program Monitor viewer control | Not supported | Source Monitor or HTML media capability probe with honest fallback |

## State v3 contract

`src/data/oracle-data-schema.js` defines `com.blocky.oracle.state` version 3:

- Snapshot metadata: revision, written time, writer ID.
- `replaysById`: stable UUID, canonical path/path key, optional file identity,
  source/display names, size/mtime/export/first-seen times, duration, thumbnail
  cache status/key, archive/missing state, collections, tags, favorite, rating,
  notes, and usage timestamps.
- `collectionsById`: presentation, timestamps, manual order, and optional smart
  rules.
- `curvePresetsById`: cubic points, apply mode, sampling settings, tags,
  favorite, timestamps, and manual order.
- Preferences, Quick Apply state, recipes, and tombstones.

`src/data/oracle-migrations.js` deterministically migrates legacy arrays and v1/v2
documents, produces stable UUIDs, preserves known legacy metadata, omits raw image
bytes, rewrites collection membership/manual order through migrated UUIDs, validates
all references, is idempotent for v3, and chooses the newest valid complete recovery
candidate by revision and timestamp. Incomplete v3, unsupported future versions,
partially skipped legacy files, malformed paths, and corrupt JSON cannot outrank a
valid backup. Runtime v3 reads/writes
remain disabled until Milestone 2 adds temp-write, flush, atomic replace, durable
last-known-good recovery, and restart/interrupt tests.

## Feature flags

The following invariants remain on: `nativeOleDrag`, `legacyReplayLibrary`.

Everything new remains off: bridge protocol v2, state-v3 read/write, virtual
grid, native metadata/watch/file operations/diagnostics, Overdrive shell, replay
lifecycle/viewer, Curves, Quick Apply, multi-panel synchronization, and the
experimental hotkey service.

## Acceptance matrix

| Gate | Result |
| --- | --- |
| Existing JavaScript/type/native baseline captured | Pass |
| Existing C++ OLE worker preserved | Pass |
| Addon invoked before ProjectItem/awaited work | Automated pass; physical retest pending |
| No HTML/playhead drag fallback | Automated pass |
| Post-drop exact-path label-9 reconciliation retained | Automated pass |
| 5,000-record hydration no longer quadratic | Automated pass; physical grid test pending |
| Deterministic/idempotent migrations and corrupt recovery | Automated pass |
| New product surfaces disabled | Pass |
| Final-revision UDT reload after this patch | Pending; host reconnected but plugin was not reloaded |
| Disposable-project native Timeline drag | Pending |
| Active-drag unload/reload | Pending |
| Installed CCX/clean-machine path | Pending; no package pipeline yet |

Milestone 0 must remain **gated** until the pending UDT and disposable-project
physical checks are performed. It is not evidence that later milestones or final
Blocky Studios Overdrive acceptance are complete.
