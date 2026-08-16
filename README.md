# Blocky Studios for Premiere Pro 2026

Blocky Studios is a Hybrid UXP workspace that receives completed replay renders over localhost, validates and persists them in a versioned library, and exposes explicit Premiere actions plus native Windows OLE Timeline dragging.

The shared shell ships the real Replays, Curves, and Quick Apply workspaces plus shared application, preferences, persistence, bridge, and native-service infrastructure. Blocky Studios does not expose placeholder controls or unsupported host actions.

## Architecture

```text
Minecraft renderer + embedded bridge server ──► ws://127.0.0.1:3001
                                                        │
                                                        ▼
Premiere UXP panel ◄──────── WebSocket subscriber ───────┘
        │
        ├── Project.importFiles() ──► active Premiere project/bin
        │
        └── oracle-native-drag.uxpaddon ──► Windows OLE CF_HDROP ──► Timeline
```

Premiere's UXP runtime is the WebSocket client. The production Blocky Studios Minecraft companion owns the deterministic loopback endpoint `ws://127.0.0.1:3001`, while the panel automatically reconnects when it launches. `bridge/server.cjs` remains a development/legacy protocol harness; it is not an extra production runtime requirement.

Premiere 26.3's UXP 9.3 URL validator rejects both host-only and exact-port loopback WebSocket allowlist entries before the handshake. A clean UDT unload/load with `ws://127.0.0.1` or `ws://127.0.0.1:3001` produced no socket, while Adobe's documented `requiredPermissions.network.domains: "all"` compatibility mode immediately established the loopback connection. The panel still hard-codes `ws://127.0.0.1:3001` in `main.js`; it never accepts a destination from a message, project, preference, or UI field. Permission changes require a true plugin unload/load and may require a host restart if Premiere retains the prior registration.

## Requirements

- Adobe Premiere Pro 26.3 or newer
- UXP Developer Tool 2.2 or newer
- Node.js 20 or newer for development checks and the optional bridge harness
- Windows x64 for the native Timeline-drag build in this checkout

## Install and run

1. Install the one bridge dependency:

   ```powershell
   npm install
   ```

2. For protocol development without the Blocky Studios Minecraft companion, optionally start the development-only localhost harness:

   ```powershell
   npm run bridge
   ```

3. Build the Release x64 addon with Visual Studio Build Tools 2026 and the installed Adobe Hybrid SDK:

   ```powershell
   & "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" -S native -B native/build -G "Visual Studio 18 2026" -A x64 -DADOBE_UXP_HYBRID_SDK_ROOT="D:/Adobe SDKs/UXP Hybrid Plugin SDK/uxp-hybrid-plugin-sdk-main"
   & "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" --build native/build --config Release --parallel
   & "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\ctest.exe" --test-dir native/build -C Release --output-on-failure
   ```

   The production binary is written to `win/x64/oracle-native-drag.uxpaddon`, matching Adobe's Hybrid SDK directory layout. The addon uses the static MSVC Release runtime; its remaining dependencies are Windows system libraries.

4. In Premiere, enable Developer Mode under **Settings → Plugins**, then restart Premiere.

5. In UXP Developer Tool, choose **Add Plugin**, select this folder's `manifest.json`, and click **Load** or **Load & Watch**. Confirm the UDT Logs tab reports no manifest or addon-load rejection.

6. Open **Window → UXP Plugins → Blocky Studios**. The header status changes from `CONNECTING` to `CONNECTED` when the bridge is connected.

## Render handoff protocol

The production Minecraft mod owns `ws://127.0.0.1:3001`. It advertises bridge protocol 2, validates a versioned subscription, negotiates a bounded representative JPEG frame, and broadcasts a versioned replay event only after the video file has been closed and finalized. Protocol 1 remains an explicit compatibility path. The optional `npm run bridge` development harness also accepts this legacy publisher shape:

```json
{
  "event": "render_complete",
  "title": "Replay_Name",
  "filepath": "C:/path/to/video.mp4",
  "thumbnail": "C:/path/to/thumb.png",
  "durationSeconds": 62.5,
  "resolution": { "width": 1920, "height": 1080 },
  "fps": 60,
  "timecode": "01:02:03:04"
}
```

`filepath` is required and must be the absolute path produced by the Blocky Studios renderer. The bridge also accepts `file_path`, `outputPath`, `output_path`, and `outputFile`, including those fields under `export`, `render`, or `data`. `thumbnail` is optional; the publisher may instead provide a supported image as `thumbnailDataUrl`, or raw in-memory JPEG data as `thumbnailBase64`. Duration may be supplied as seconds, milliseconds, or a colon-delimited time string. Resolution may be a string or width/height object, while `fps`/`frameRate` and `timecode`/`sourceTimecode` aliases are normalized and retained for the card and drag payload.

The zero-configuration import contract may be sent before the file becomes visible to Premiere:

```json
{
  "type": "IMPORT_CLIP",
  "payload": {
    "absolutePath": "C:/absolute/path/to/render.mov",
    "title": "Optional display title"
  }
}
```

`event`, `type`, or `action` may identify `IMPORT_CLIP`. `absolutePath` and the optional raw-JPEG `thumbnailBase64` can be at the top level or inside `payload`/`data`; the media path must be an accepted absolute Windows video path. On connection the panel sends the protocol-2 subscription, validates the retained snapshot, and keeps raw JPEG bytes in memory only until they are validated and committed to the separate thumbnail cache.

As a missed-event fallback, the panel asynchronously polls the user's Downloads folder and up to three recently used export folders. Polls never overlap, run every 3 seconds while visible and every 10 seconds while hidden, and require a new video file to remain unchanged for two scans before it is appended.

The development bridge binds only to loopback, validates schema/version/path/media/file identity, bounds incoming messages to 12 MB, caps retained replay/import events at 5,000/1,000, and evicts retained thumbnail bytes under a separate memory budget. Normal logs never print media paths or raw payloads. It returns either:

```json
{ "event": "render_accepted", "id": "...", "filepath": "..." }
```

or a concrete validation failure:

```json
{ "event": "bridge_error", "message": "Video file was not found: ..." }
```

For a local end-to-end test with real files:

```powershell
npm run publish -- "Replay Name" "C:\path\to\video.mp4" "C:\path\to\thumb.png"
```

## Premiere behavior

- A received replay appears promptly in a processing state while bounded metadata and thumbnail work continues asynchronously.
- `Project.importFiles([filepath], true, replayBin, false)` imports it silently into a reused or newly created `Minecraft Replays` bin.
- Existing project media is matched by normalized absolute media path and reused rather than imported again.
- Existing media paths are detected before import to avoid duplicate project items after reconnecting.
- Durable domain state uses the deterministic v3 schema and is committed through a native temp/write-through/flush/verified atomic replace with last-known-good recovery. Legacy v2 files and `oracle.recentExports.v1` are read-only migration inputs. Raw `thumbnailBase64` image bytes never enter state JSON.
- Replay history has no automatic count cap. Stable event IDs and observed physical identity deduplicate repeated delivery, while a same-name physical overwrite remains a new replay.
- If no project is open, the card clearly says `Open a Premiere project to import` and retries in the background.
- Clicking a ready card opens its imported ProjectItem in Premiere's Source Monitor.
- Pressing a ready card's non-interactive body records one delegated pointer gesture. Moving at least five physical pixels dispatches the exact stored absolute path to the native addon without querying Premiere or importing media first.
- A persistent native STA worker owns OLE initialization and exposes a real Explorer-style `CF_HDROP` copy drag. Premiere owns the drop target, target track/time, import, and insertion behavior. Escape and invalid drops insert nothing.
- Native dragging never falls back to an active-playhead insertion and never inserts a second copy programmatically after the native drop. The existing explicit double-click/Enter action remains separate from drag behavior.
- Browser card/image dragging, HTML drag payloads, custom browser ghosts, and release-outside-panel inference are disabled.
- Imported/reused ProjectItems receive Premiere's zero-based color label index `9` (the 10th visible Label-menu entry) through `ProjectItem.createSetColorLabelAction(9)`. Blocky Studios does not attempt to recolor TrackItems because Premiere Pro 26.3 exposes no supported TrackItem label action.
- At the drag threshold Blocky Studios calls `startNativeFileDrag()` immediately, before ProjectItem scans/imports, label work, timeline queries, native self-test diagnostics, file inspection, or the first awaited Promise. After a successful drop, exact-path ProjectItem label-9 reconciliation runs as recovery/verification and never inserts a second Timeline item.
- A live Premiere Pro 26.3 A/B test confirmed that a native `CF_HDROP` can create a cyan Timeline clip even when `TrackItem.getProjectItem()` resolves to the same ProjectItem verified as label index `9` before OLE entry. Premiere applies its Movie Label Default to that Timeline instance. Since UXP 26.3 has no supported TrackItem label action, the only supported guaranteed Timeline color is obtained by setting Premiere's Movie Label Default to the desired custom label; that preference affects every imported movie file.
- Versioned Preferences cover appearance, replay behavior/cache, Curves defaults, Quick Apply defaults, and profile settings with Apply/Cancel transaction semantics.

The addon follows Adobe's installed Hybrid Plugin SDK initialization, termination, manifest, `require()`, and `win/x64` binary-layout patterns. High-volume JavaScript drag telemetry is disabled by default and user-visible structured errors remain enabled. The bounded, path-redacted `%TEMP%\oracle-native-drag.log` trace is compiled only when `ORACLE_NATIVE_DEVELOPMENT_TRACE` is explicitly enabled. The Release CTest guard rejects the trace strings and its debug-path API imports from the packaged addon.

## Timeline-safe scheduling

- WebSocket payloads are parsed once and delivered directly to the targeted single-card update path.
- Reconnects use exactly one guarded 2-second timer and destroy all prior socket handlers before creating a replacement.
- Filesystem fallback polling uses one non-overlapping asynchronous timer and pauses between directory scans.
- Premiere project-tree searches yield after 24 items or 4 ms and use an indexed queue instead of repeatedly shifting a large array.
- Live card updates are targeted by replay ID. Snapshot/query rendering remains ID-driven and commits only a bounded virtual row window (at most 180 cards in the 5,000-record harness), preserving date rows, scroll anchors, roving focus, and selection.
- Permanent history writes use the native atomic state writer. Permanent JPEG thumbnails are keyed separately by path/identity/size/mtime/frame/dimensions/schema and use bounded asynchronous work, cancellation, invalidation, and LRU eviction.
- The responsive brand image performs no continuous animation or resize-listener work.

Premiere UXP is not a full browser runtime, so the panel does not assume Web Worker availability. Cooperative `setTimeout(..., 0)` yielding keeps the implementation compatible with Premiere 26 / UXP 9.3 while preventing long uninterrupted JavaScript turns.

## Blocky Studios design assets

The supplied light- and dark-mode logo masters are preserved byte-for-byte:

- `assets/logo/blocky-studios-light-mode.png`
- `assets/logo/blocky-studios-dark-mode.png`

The panel uses the same Samsung Sharp Sans files as the Blocky Studios desktop
application. All three faces are packaged and registered process-private by the
hybrid native addon; they are never copied into the Windows Fonts directory:

- `assets/fonts/samsung_sharp_sans_regular.otf`
- `assets/fonts/samsung_sharp_sans_medium.otf`
- `assets/fonts/samsung_sharp_sans_bold.otf`

The persisted appearance preference selects the correct logo and complete token palette for dark, light, or system mode.

## Verification

```powershell
npm run verify
```

This syntax-checks the panel, bridge, and Milestone 0 schema modules, then runs localhost WebSocket, history/performance, migration, UI, and JavaScript native-drag integration tests. `npm run native:test` now rebuilds the Release targets before CTest; use `npm run native:build` to deploy, which safely skips replacement when the loaded destination already has the identical hash.

The exact `2.0.14-m9-8` private-package hashes, installed-CCX smoke scope,
remaining physical engineering gates, security review, and public-release blockers are recorded in
`docs/oracle-overdrive/M9_RELEASE_EVIDENCE.md`.

Operator procedures for preserving plugin data, handling
`STATE_RECOVERY_REQUIRED`, and stopping or reversing a CCX rollback are in
`docs/oracle-overdrive/RECOVERY_RUNBOOK.md`. A package rollback and a state
rollback are intentionally treated as separate operations.
