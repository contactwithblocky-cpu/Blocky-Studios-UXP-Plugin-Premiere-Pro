# Blocky Studios Overdrive M9 Release Evidence

Recorded: 2026-07-16  
Verdict: **NOT READY — EXACT PRIVATE-LOCAL M9-10 PACKAGE VERIFIED; PHYSICAL AND PUBLIC RELEASE GATES REMAIN**

This dossier is bound to cache revision `2.0.14-m9-10`. The public manifest
version remains `2.0.14` until the project owner confirms a successor. Exact
source files, stage, UDT-produced CCX, verified extraction, and the normal
External installation were compared across 50 files with zero payload
differences. The installed package visibly renders the repaired Minecraft-style
main shell and every main route. That is strong private engineering and package
evidence; it is not a public-release verdict because the mandatory human
physical matrix and three public-policy gates remain open.

The checkout is not a Git working tree. The hashes below, the cache revision,
the package inventory, and the recorded screenshots therefore bind the evidence
to the completed M9-10 snapshot.

## Host and toolchain

| Item | Recorded value |
| --- | --- |
| OS | Windows `10.0.26200`, x64 |
| CPU | AMD Ryzen 7 7800X3D, 16 logical processors |
| Memory | 67,818,041,344 bytes |
| Premiere | `26.3.0.93` |
| Node | `v24.18.0` |
| Java | Eclipse Adoptium Java 21 at `C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot` |
| Native toolchain | MSVC `14.51.36231`, CMake/CTest Release x64 |
| M9-10 disposable project | `C:\Users\salim\AppData\Local\Temp\oracle-m9-final\m9-9-matrix\project\Blocky Studios-M9-9-Disposable.prproj` |
| M9-10 installed UXP log | `C:\Users\salim\AppData\Roaming\Adobe\Premiere Pro\Logs\UXPLogs_2026-07-16_14-14-07_521512.log` |

All destructive acceptance used generated disposable data/media. No destructive
operation was performed on the user's real Premiere project or replay files.

## Exact M9-10 automated acceptance

| Command / gate | Result |
| --- | --- |
| `npm run verify` | **PASS** — JavaScript syntax, `tsc --noEmit`, and 449/449 JavaScript tests passed for exact `2.0.14-m9-10`. |
| Focused lifecycle/shell regression | **PASS** — 86/86 focused M7/M1/M3 tests passed after the root-attachment repair. |
| `npm run native:test` | **PASS** — 6/6 Release native suites. |
| `npm audit --omit=dev --audit-level=high` | **PASS** — 0 vulnerabilities. |
| `npm run benchmark:m9` | **PASS** — every encoded budget boolean was true. |
| `npm run verify:release` | **PASS** — the complete JavaScript/type, native, audit, and benchmark stack above passed as one release-verification run. |

The paired Blocky Studios mod evidence predates only the panel-root repair, which did
not change the mod or bridge protocol: the fresh Java 21 clean build completed
with 520 tests across 76 suites and zero failures/errors/skips. Its
`oracle-0.40.0.jar` was 219,970,864 bytes, SHA-256
`785252F0AE853626F736809776ABE71196129E5675A73C45D6FCE4150C5700F1`,
and byte-identical to the live profile copy. A new real Minecraft export was not
performed on exact M9-10 and remains a release gate.

### Performance snapshot

| Workload | Measured result | Evidence status |
| --- | ---: | --- |
| 5,000-record snapshot hydration | 278.061 ms | Recorded only; no encoded hydration threshold |
| 5,000-record replay search | 2.809 ms | Encoded budget PASS |
| 1,000 virtual-scroll updates | 0.478 ms total; 0.000478 ms mean; max 30 cards | Model budget PASS; not physical UXP DOM/frame timing |
| 5,000-effect search | 0.520 ms | Encoded budget PASS |
| 1,000 graph refreshes | 37.781 ms total; 0.037781 ms mean | Model budget PASS; not physical graph paint timing |
| Thumbnail queue | Maximum concurrency 4 | Concurrency cap PASS |
| Process memory delta | Heap +27,190,032 bytes; RSS +57,434,112 bytes | Recorded only; not an ordered leak conclusion |

These Node/model results do not establish a physical 16.7 ms UXP frame target,
pointer-threshold latency, or resource-leak closure. Those require physical host
traces and ordered before/after samples.

## M9-9 white-panel diagnosis and M9-10 repair

The exact installed M9-9 package reproduced a white/empty main Blocky Studios panel.
This was not missing CSS, fonts, images, scripts, or a partial install:

- M9-9 source/stage, extracted CCX, and Program Files installation were
  byte-identical across 50 files.
- Static HTML/CSS/source and resource-reference checks were clean.
- UDT/CDT load and unload operations succeeded. The captured passes contained
  no runtime exception, console exception, missing-resource, 404, font,
  stylesheet, image, or script error attributable to Blocky Studios.
- UDT did not expose a default execution context, so no DOM snapshot is claimed
  from that diagnostic attempt.
- Runtime side effects showed that bootstrap progressed, but the main lifecycle
  root never owned the canonical main shell.

The root cause was in the current M7 multi-panel lifecycle architecture. The
dedicated panels appended their DOM to the `rootNode` supplied by UXP, while the
main panel's `prepare("oraclePanel", rootNode)` returned without attaching the
canonical shell and `show("oraclePanel", rootNode)` only toggled controller
visibility. The document-body shell could therefore exist and bootstrap while
the host-owned main panel root painted empty.

M9-10 repairs that integration point without reverting M1-M9 work:

- main `create`/`prepare` synchronously attaches the canonical shell to the
  supplied lifecycle root before asynchronous bootstrap;
- main `show` repeats the attachment idempotently and then hands visibility to
  the controller;
- repeated calls, late-controller handoff, and replacement lifecycle roots are
  covered by behavior tests;
- invalid, missing, or circular attachment renders the existing
  Minecraft-styled emergency state and records
  `MAIN_PANEL_ROOT_ATTACH_FAILED` instead of leaving a blank panel;
- successful attachment records privacy-safe `MAIN_PANEL_ROOT_ATTACHED` and the
  shell stays attached while hidden.

The exact stable-M3 UI checkpoint remains valid and was not restarted: its UDT
reload had already rendered the full shell and passed 118/118 focused M1-M3
checks plus the then-complete 420/420 JavaScript/type stack before M4 began. The
M9-9 issue was a later lifecycle-root regression; M9-10 fixed it surgically in
the current architecture.

## Exact M9-10 package and installed identity

| Property | Result |
| --- | --- |
| Cache revision | `2.0.14-m9-10` |
| Public manifest version | `2.0.14` |
| Stage | `native/build/ccx-stage/com.blocky.oracle.v5-m9-10` |
| Stage total | 50 files; 6,933,658 bytes |
| Inventory SHA-256 | `E6C9F3E8C0252029B0EFD82484A4244007B4A4D9781F5AADA49D4FBA6991A4CF` |
| CCX | `native/build/ccx-output-m9-10/com.blocky.oracle.v5_premierepro.ccx` |
| CCX size | 5,334,157 bytes |
| CCX SHA-256 | `68082DCB170289A28453278A318CCC9577D742B75AB5E303F85DD7979F0C14A7` |
| UDT package outcome | `native/build/ccx-output-m9-10/UDT_PACKAGE_OUTCOME.json` |
| Package-outcome SHA-256 | `B7677EF71AA5DFC9C8D6D4C142EA3402E56654C6700F674BAC5B31732EE4EEEE` |
| Verified extraction | `native/build/ccx-verify/com.blocky.oracle.v5_premierepro-68082DCB1702` |
| Verifier result | `Verified=true`, `PrivateLocalAcceptance=true`, `ReleaseEligible=false`, 50 entries |
| Installed path | `C:\Program Files\Common Files\Adobe\UXP\Plugins\salim\External\com.blocky.oracle.v5_2.0.14` |
| Installed identity | Source/stage/extraction/install: 50 files, zero payload differences |
| `main.js` SHA-256 | `8604BAFD9FF3E92E96B50B41DDA9D6DE2F367841E0FBAE2B3FF2449034A20F34` |
| `index.html` SHA-256 | `F4EA6CD62C583291662792CE3368C8E4F1CECD0CB42A1268315DB57ECF74EA96` |
| Native addon SHA-256 | `FAB8477C6273EF1AA4690B9F1A284155ACC61E00FB702574DBAF67ED5FE92407` |
| Cache references | 29 exact `m9-10` references; zero `m9-9` references |

UDT 2.2.1 produced the canonical private CCX. The supported Adobe
UnifiedPluginInstallerAgent removal and installation ultimately succeeded. Two
earlier remove attempts returned `-646`/timed out without changing the installed
payload; restarting only Adobe Desktop Service released the installer endpoint.

Before the successful install, the live External state was copied exactly (7
files, 466,766 bytes). The uninstall removed External scope, and the pristine
six-file, 466,609-byte baseline was restored before Premiere launched with zero
content differences. No Developer-scope state was overlaid or replaced.

## Exact installed M9-10 shell and route smoke

Premiere 26.3 loaded the normal External installation and established a Blocky Studios
bridge connection to `127.0.0.1:3001`. The exact installed panel visibly showed:

- the dark Minecraft-style shell rather than a blank/white panel;
- the centered Blocky Studios logo/wordmark, hamburger, bridge indicator, and `OE`
  profile control;
- the hamburger destinations Replays, Curves Premiere, and Quick Apply
  Premiere;
- the real Replays `Waiting for an export` state;
- the real Curves unsupported/no-animated-property state and Refresh action;
- the real Quick Apply 240-result list, selection-required explanations,
  actions, and recipes;
- the real Preferences surface opened from the profile control;
- a normal panel-tab close followed by a menu-driven reopen, with the repaired
  shell still fully painted;
- dedicated Blocky Studios Replays, Blocky Studios Curves, and Blocky Studios Quick Apply panels, each
  with real nonblank content.

Durable screenshots already present under
`native/build/evidence/m9-10-final-2026-07-16/`:

- `m9-10-premiere-oracle-command-submenu-open-real.png`
- `m9-10-installed-oracle-main-primary-monitor.png`
- `m9-10-installed-oracle-hamburger-open.png`
- `m9-10-installed-oracle-profile-menu.png`
- `m9-10-installed-oracle-route-replays.png`
- `m9-10-installed-oracle-route-curves.png`
- `m9-10-installed-oracle-route-quick-apply.png`
- `m9-10-installed-oracle-main-shell-close.png`
- `m9-10-oracle-panel-closed-normal.png`
- `m9-10-installed-oracle-main-shell-after-normal-reopen.png`
- `m9-10-entrypoint-oracle-replays.png`
- `m9-10-entrypoint-oracle-curves.png`
- `m9-10-entrypoint-oracle-quick-apply.png`

The bottom-monitor black crop is a capture artifact and is not used as
acceptance evidence. The fresh UXP log at
`C:\Users\salim\AppData\Roaming\Adobe\Premiere Pro\Logs\UXPLogs_2026-07-16_14-14-07_521512.log`
records `com.blocky.oracle.v5` added and enabled. No Blocky Studios-attributable
exception or missing-resource line was found. The first global missing-resource
records are unrelated Spell Book icons at lines 13-14; all 41 global
missing-resource matches are itemized in `uxp-log-audit-m9-10.txt` and belong
to Spell Book, Preset Pilot, OpenCurve, Adobe Frame.io, or Adobe Discover
Panel/DP. The first global Error
is unrelated Adobe export-queue icon metadata at line 65. Two unscoped host
warnings, `Setting focus failed on node: input`, appeared during automated
input focus at lines 283 and 316 and do not identify Blocky Studios. Other Adobe and
third-party errors are not attributed to Blocky Studios. After the smoke, Premiere
accepted a normal main-window close request and exited within six seconds; no
force termination was used.

This smoke proves the exact M9-10 lifecycle-root repair, main shell, assets,
Preferences, three main routes, normal panel close/reopen, and all three
dedicated entrypoints. It does not stand in for the unperformed exact-package
physical feature, accessibility, performance, or leak matrix.

## Native Release addon

Canonical path:
`native/build/stage/win/x64/oracle-native-drag.uxpaddon`

| Property | Result |
| --- | --- |
| Size | 553,984 bytes |
| SHA-256 | `FAB8477C6273EF1AA4690B9F1A284155ACC61E00FB702574DBAF67ED5FE92407` |
| PE architecture | `0x8664` / Windows x64 DLL |
| Exports | `uxp_addon_init`, `uxp_addon_terminate` |
| Imports | `GDI32.dll`, `ole32.dll`, `SHELL32.dll`, `KERNEL32.dll`, `USER32.dll` only |
| Signature | Not Authenticode-signed; private local acceptance only |

Fresh Release output, stage, extracted CCX, and installed addon are
byte-identical at the hash above. The 6/6 native suites cover the writer,
identity inspector, directory watcher, file operations, native drag core,
worker termination, and OLE cleanup at the automated/core level. They are not a
substitute for a real-hand Windows OLE drag, physical Escape/cancel behavior,
exact Timeline placement, or ordered host teardown/leak sampling.

## Historical M4-M8 host acceptance retained

The following earlier stable-revision physical evidence remains useful because
M9-10 changed only main-panel lifecycle-root ownership and cache references:

- **M4:** UXP video rejected the available ProRes/AAC MOV with `MEDIA_ERROR_4`;
  the real Source Monitor fallback then passed ownership, play/pause, media
  switching, and release checks.
- **M5:** real Hold interpolation applied through Premiere actions and one
  Premiere Undo restored the prior interpolation.
- **M6:** Gamma Correction, Apply Once no-op, two-effect recipe, readback, and
  one-step Undo behavior passed against disposable host data.
- **M7:** four UXP panel roots shared one runtime/service set and close/reopen
  retained service identities without duplicate mounts.
- **M8:** the supported `Open Blocky Studios Quick Apply` command repeatedly revealed
  one dedicated panel without duplicate host windows; Premiere exposed no
  assignable UXP keyboard shortcut.

These runs preserve vertical-slice evidence but do not certify the same actions
on exact installed M9-10. Historical M9-8 package evidence remains under
`native/build/evidence/m9-final-2026-07-16/`; it is superseded for current
artifact identity and cannot close an M9-10 physical gate.

## Architecture and implementation scope

| Milestone | Current production architecture |
| --- | --- |
| M1 | `index.html`, shared shell/design tokens, Preferences, feature flags, persistence, and visible loading/emergency surfaces |
| M2 | Protocol-v2 bridge with v1 compatibility, v3 schema/migrations/recovery, replay library/workspace, selectors, JPEG cache, and paired in-memory thumbnail export |
| M3 | Replay organization/lifecycle UI plus atomic writer, safe file identity, directory watch, file operations, packaged-font registration, rollback, and teardown |
| M4 | Replay viewer coordinator and real Source Monitor integration with honest capability gating |
| M5 | Curve math/presets/workspace and Premiere action adapter with TickTime quantization, readback, and one-transaction application |
| M6 | Cached effect index, Quick Apply domain/workspace, Premiere effects adapter, favorites/recents, recipes, readback, and one-transaction application |
| M7 | Root-scoped panel DOM, one shared runtime registry, four manifest panels, reference-counted coordinators, duplicate-ID/root guards, and emergency states |
| M8 | Supported manifest command using exact plugin lookup and `Plugin.showPanel()`; no fake/global hotkey |
| M9 | Diagnostics/redaction, native teardown hardening, package allowlist/verifier, benchmark/release scripts, security/accessibility tests, real color controls, virtual-grid ARIA semantics, and exact M9-10 main lifecycle-root attachment |

The M9-10 root repair is implemented in `main.js`; behavior coverage is in
`m7.multi-panel.test.cjs`; exact cache identity is in `index.html`; and the M8
revision contract is updated in `m8.quick-apply-command.test.cjs`. No schema,
migration, replay, bridge, native drag, or user-data contract was reverted.

Shared runtime services remain one controller/store, persistence layer,
Premiere gateway, bridge client, native addon, and reference-counted
viewer/Curves/Quick Apply coordinators. The native boundary continues to expose
the atomic writer, safe identity inspection, directory watcher, Explorer/file
operations, packaged-font registration, and synchronous exact-path OLE drag.

## Security and accessibility evidence

| Area | Current control and remaining evidence |
| --- | --- |
| Package boundary | Exact allowlist and size/hash inventory; archive boundary, traversal, alternate-path, reparse/symlink, unexpected-file, private-path, dev-content, permission, host, module, and inventory drift rejection remain automated. |
| Bridge | Loopback runtime endpoint, protocol/version validation, stable identity/deduplication, JPEG validation, 12 MB image ceiling, per-socket serialization, and bounded queues/backpressure remain in force. |
| User data | Deterministic v3 migration/recovery, atomic replacement, identity revalidation, rollback, and no raw thumbnail bytes in durable state. Diagnostics redact full paths, media, thumbnails/avatar bytes, and payloads. |
| Native lifecycle | 6/6 Release suites and byte-identical x64 addon; physical OLE and ordered host teardown still pending. |
| Keyboard/focus | Automated roles, names, state, roving focus, restoration, Escape hierarchy, and route/dialog coverage pass; real keyboard and Narrator/assistive-technology traversal on installed M9-10 is pending. |
| Visual accessibility | Automated visible focus, high-contrast/system-color, reduced-motion, custom-color contrast, and Curves/grid semantics pass; physical installed theme/contrast/motion verification is pending. |

Premiere 26.3 required manifest `domains: "all"` for the physical loopback
WebSocket connection. Runtime code remains fixed to
`ws://127.0.0.1:3001`; the broader host permission is documented as a residual
permission risk.

## Engineering gates before any release verdict

| Gate | Status | Exact remaining work |
| --- | --- | --- |
| JavaScript/syntax/TypeScript/native/audit/benchmark stack | **PASS** | 449/449 JavaScript tests, syntax and `tsc --noEmit`; 6/6 Release native; zero audit vulnerabilities; all encoded budgets true. |
| Stage, UDT package, verifier, normal install, and identity | **PASS — PRIVATE LOCAL** | Exact M9-10 50-file identity and zero payload differences; `PrivateLocalAcceptance=true`, `ReleaseEligible=false`. |
| Installed shell and panel entrypoints | **PASS — SMOKE SCOPE** | Exact M9-10 main shell, hamburger, profile/Preferences, Replays, Curves, and Quick Apply visibly rendered; normal panel close/reopen and all three dedicated entrypoints also stayed nonblank. |
| Full clean-installed feature/data matrix | **PENDING** | Exercise disposable v3 migration/corruption recovery, cache restart, metadata/thumbnail persistence, organization/file operations, viewer, Curves apply/one-step Undo, Quick Apply effect/recipe apply/Undo, and shared-lifecycle mutation on exact M9-10. |
| Native OLE physical matrix | **PENDING** | With a real mouse: pre-threshold cancel, post-threshold Escape, invalid target, exact marker drop versus playhead, main/dedicated/viewer-open states, and repetition after ProjectItem deletion. |
| Physical keyboard and assistive technology | **PENDING** | Complete keyboard/focus traversal and Narrator/AT roles, names, states, announcements, and Escape restoration on installed M9-10. |
| Physical geometry and paint | **PENDING** | Human dock/float/collapse/resize/restart inspection, including smooth paint and no blank/intermediate shell. |
| Physical performance and leak closure | **PENDING** | Capture UXP large-grid/graph traces and ordered process/listener/socket/resource samples across repeated panel/Premiere open-close cycles and normal shutdown. |
| Real paired-Minecraft export | **PENDING** | Run a production-duration export through the live bridge and verify exact metadata, thumbnail arrival, persistence/restart behavior, and no durable thumbnail-payload leak. |
| Recovery runbook | **PENDING** | Exercise `STATE_RECOVERY_REQUIRED`, valid-backup healing, data preservation, and CCX rollback stop conditions on disposable data. |
| Conditional environment coverage | **PENDING WHEN AVAILABLE** | UNC replay paths and a third-party effect/recipe target require suitable real test inputs. |

Because these physical gates are mandatory, the engineering verdict remains
**NOT READY** even though the exact M9-10 private package and installed shell
pass.

## External/public-distribution blockers and host boundaries

1. **Asset rights:** redistribution/commercial-use provenance is not documented
   for the supplied Minecraft Regular, Five, and Ten fonts or Blocky Studios logo/icon
   artwork. Local acceptance may use them; they are not release-cleared assets.
2. **Version/upgrade:** project policy has not identified the successor semantic
   version. `2.0.14` is intentionally retained, so this same-version install is
   not a true upgrade from a `2.0.14` baseline.
3. **Signing/distribution:** the native addon is not Authenticode-signed and the
   private CCX is not a signed Marketplace artifact. Signing and distribution
   policy must be applied after rights and version decisions.
4. **Premiere codec boundary:** the available Apple ProRes 4444/AAC MOV returned
   UXP `MEDIA_ERROR_4`; Blocky Studios uses the verified Source Monitor path and disables
   unsupported viewer controls instead of faking playback.
5. **Shortcut boundary:** Premiere UXP exposes no assignable plugin keyboard
   shortcut. Blocky Studios ships the supported command/`Plugin.showPanel()` path and no
   global hook or simulated input.

Only after the engineering matrix passes should the owner document or replace
the assets, confirm and bump the successor version, sign/package it under the
chosen distribution policy, and run a true installed upgrade from the retained
`2.0.14` baseline.
