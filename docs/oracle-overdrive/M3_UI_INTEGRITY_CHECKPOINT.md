# M3 Stable UI-Integrity Checkpoint

Recorded: 2026-07-16 10:41 EDT  
Verdict: **PASS**

This checkpoint was performed only after the focused M3 lifecycle,
reconciliation, rollback, and persistence work had finished. UDT was registered
against the checkout manifest itself:

`D:\Blocky HQ\Oracle Plugin (Premiere Pro)\com.blocky.oracle.v5\manifest.json`

The stale `native/build/ccx-stage` registration was removed before acceptance.
The exact accepted M3 asset revision was `2.0.14-m9-2`. A deterministic manifest
over the 32 runtime HTML/manifest/JavaScript/CSS files had SHA-256:

`b3905d0e55c44438f99b23bfd6b9613a262ec15392b5c98a1f20cf25a5c2165e`

The per-file hash manifest is retained with the screenshots under
`native/build/evidence/m3-stable-2026-07-16/`.

## Physical result

- A clean UDT reload rendered the real Minecraft-styled shell, never an empty
  panel: centered Blocky Studios branding, logo, hamburger, bridge status, profile
  control, replay toolbar, search, filters, and replay cards were present.
- The drawer rendered all three real routes and each route opened successfully:
  Replays, Curves, and Quick Apply.
- Preferences opened from the profile control. Data & Diagnostics rendered its
  bounded runtime records plus the real settings/support/metadata actions.
- The packaged Minecraft font faces and Blocky Studios artwork rendered. The installed
  system-font compatibility probe remained a progressive warning only; it did
  not replace the packaged faces or blank startup.
- Startup retained the tested Minecraft-styled loading and fatal-error states,
  so asynchronous bootstrap cannot intentionally expose a blank panel.

The physical pass found one UXP-specific defect: promoted replay form controls
painted above the navigation drawer and intercepted the Curves row. The current
architecture was preserved. Shell overlays now make routed workspaces inert and
temporarily suppress promoted form controls for the complete overlay lifetime;
focus restoration waits until those controls are visible again. The drawer and
all routes then passed the repeated physical check.

## Logs and automated acceptance

- UDT Debug Console after the final exact-revision reload: empty console and
  `No Issues`.
- Premiere UXP log:
  `C:\Users\salim\AppData\Roaming\Adobe\Premiere Pro\Logs\UXPLogs_2026-07-16_09-15-43_884573.log`.
  The final reload slice beginning at `2026-07-16_10-37-21` contains the runtime
  reload marker and bridge `pong` records only. It contains no Blocky Studios exception,
  fatal/error severity, missing-resource failure, script/style/font/image load
  failure, duplicate bootstrap, or focus-restoration warning.
- Focused M1-M3 acceptance: **118/118 passed**.
- Complete JavaScript/type verification: **420/420 passed**, including syntax
  checks and `tsc --noEmit`.

The earlier empty panel occurred while files were actively changing and while
UDT still referenced an old staged copy. It did not reproduce on the exact
stable root revision. No shell rewrite or historical-file restore was used.

## Evidence

- `native/build/evidence/m3-stable-2026-07-16/shell-replays.png`
- `native/build/evidence/m3-stable-2026-07-16/navigation-drawer.png`
- `native/build/evidence/m3-stable-2026-07-16/route-curves.png`
- `native/build/evidence/m3-stable-2026-07-16/route-quick-apply.png`
- `native/build/evidence/m3-stable-2026-07-16/preferences-data-diagnostics.png`
- `native/build/evidence/m3-stable-2026-07-16/udt-debug-console-no-issues.png`
- `native/build/evidence/m3-stable-2026-07-16/runtime-hash-manifest.tsv`
