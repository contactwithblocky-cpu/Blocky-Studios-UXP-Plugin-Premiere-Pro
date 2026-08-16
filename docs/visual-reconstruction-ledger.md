# Blocky Studios Premiere UI reconstruction ledger

This ledger records defects observed in the installed Premiere Pro 26.3.2 panel before the production reconstruction. Dimensions are the measured panel widths used during the live capture; screenshots are stored outside the package in the Codex visualization workspace for this task.

## Before-state evidence

| Route / state | Width | Screenshot | Observed defect | Exact cause | Implemented correction |
|---|---:|---|---|---|---|
| Curves / ready | 240 | `baseline-240-curves.png` | Graph is first, but presets and actions become large gray slabs; status/footer content clips. | A late product-wide raw `button`/`.oracle-button` surface defeated the earlier quiet variants; narrow composition retained competing fixed-height regions. | Raw button is now a reset only; semantic button variants own surface and 500/13px metrics; root width classes stack graph, inspector, presets, and a fixed apply footer with one scroll owner. |
| Navigation drawer | 240 | `baseline-240-drawer.png` | Drawer reaches the route, but old transition-dependent shell styling delays or obscures ownership. | Legacy transform/transition presentation remained under the synchronous shell controller. | Shell opens/closes synchronously, restores focus in a microtask, and the final navigation primitive owns static selected/inactive states. |
| Quick Apply / populated | 240 | `baseline-240-quick-apply.png` | Search, scopes, status, results, and actions compete for width; nested scrolling and clipped metadata. | Desktop flex composition and nested results scroller survived below the correct root measurement. | Narrow classes use context → search → scopes → status → results → actions, full-width field rows, wrapping scopes, one outer vertical scroll, and a below-content inspector. |
| Preferences / Profile | 240 | `baseline-240-preferences.png` | Tabs render as six full-width gray bars and close icon is blank. | Tabs inherited the generic filled button surface; pseudo/glyph close treatment was unreliable in UXP; centered transform exceeded the root. | Tabs are explicit `.oracle-tab` controls in one scrollable row, close is a packaged image, and micro/narrow dialog geometry is inset from the measured root with no centering transform. |
| Replays / empty | 240 | `baseline-240-replays.png` | Toolbar density is high at minimum width. | Toolbar children retained desktop intrinsic widths. | Root classes wrap toolbar groups, preserve full-width search, and leave the native replay scroller as the single content scroll owner. |
| Curves / ready | 320 | `baseline-320-curves-real.png` | Same gray preset/actions leak and excessive secondary chrome. | Same cascade defect; nested native buttons in preset cards also flattened in UXP. | Preset cards are stable ARIA option containers with real action controls, not nested buttons; shared quiet/selected variants are authoritative. |
| Quick Apply / populated | 320 | `baseline-320-quick-apply-real.png` | Search and actions remain compressed. | Same ancestor flex/shrink chain as 240px. | Same root-class single-column composition; result nodes are cached and receive targeted selection/pending updates. |
| Preferences / Profile | 320 | `baseline-320-preferences.png` | Identical gray tabs and cramped action footer. | Generic button surface and fixed tab column. | Semantic horizontal tabs and wrapping, reachable footer actions. |
| Replays / empty | 320 | `baseline-320-replays.png` | Toolbar hierarchy is weak. | Legacy toolbar presentation. | Bounded tabs/search/density groups with explicit tab roles. |
| Curves / ready | 412 | `baseline-412-curves.png` | Secondary controls visually outweigh the graph. | Filled quiet buttons and unbounded preset action surfaces. | Quiet actions are transparent; graph-first composition retains a centered useful graph and compact actions. |
| Preferences / Profile | 412 | `baseline-412-preferences.png` | Tabs still appear as stacked gray slabs. | Same shared cascade defect. | Same semantic tab primitive correction. |
| Quick Apply / populated | 600 | `baseline-600-quick-apply.png` | Results/inspector relationship is uneven. | Inspector minimums and inherited button surfaces compete with the browser. | Standard/wide browser flexes while inspector remains bounded to 240–320px; shared controls keep fixed metrics. |
| Curves / ready | 600 | `baseline-600-curves.png` | `LinearBlocky Studios` text collision in preset rail. | Invalid nested native button composition is flattened by Premiere UXP. | Preset cards are non-button ARIA options; favorites/actions remain separate real controls. |
| Preferences / Profile | 600 | `baseline-600-preferences.png` | Tab column is visually dominant and button-like. | Legacy vertical button column. | One subordinate tab row and content-first settings surface. |
| Replays / empty | 600 | `baseline-600-replays.png` | Large toolbar surface relative to empty content. | Desktop spacing persisted without role hierarchy. | Bounded toolbar/card surface tokens and stable empty state. |
| Curves / ready | 900 | `baseline-900-curves-final.png` | Overall split is usable, but preset actions remain gray and icon controls can be blank. | Same late blanket button rule plus glyph/pseudo icon paths. | Explicit quiet/icon variants and packaged icon images; wide graph/inspector split remains bounded. |
| Preferences / Profile | 900 | `baseline-900-preferences.png` | Six gray tab slabs persist at wide width. | Same cascade defect. | Explicit tab primitive and selected underline/tint. |
| Replays / empty | 900 | `baseline-900-replays-final3.png` | Empty state is valid; populated card/player state unavailable because no replay exports existed. | No product defect can be inferred from absent data. | Card geometry, virtual-node reuse, thumbnail cache, and player responsive rules are verified in source/tests; populated live proof remains conditional on real replay data. |

## Systemic repairs

- Button cascade: safe raw reset → `.oracle-button` primitive → primary/quiet/segment/danger/icon/tab/menu variants → component-only sizing.
- Button typography: packaged Samsung Sharp Sans Medium, weight 500, 13px, 36px control height, `0 13px` padding, zero letter spacing.
- Root responsiveness: every workspace consumes `micro`, `narrow`, `compact`, `standard`, and `wide` attributes emitted from its own mounted panel root.
- Vertical ownership: fixed shell/header/footer regions and a single `min-height: 0` content owner; overlays remain out of flow.
- Rendering: Quick Apply caches result structure and targets selection/pending updates; Curves skips unchanged overlay SVG work and no longer persists on every graph frame; hidden/inactive workspaces suspend expensive rendering/host observation.
- Lifecycle: route transitions call atomic `setLifecycle` methods; shell focus restoration is microtask-based; no new wheel interception, permanent graph loop, or animation timer was introduced.
- Telemetry: route/tab switches, drawer/preferences/viewer actions, Quick Apply search, and Curves drag start emit bounded interaction records and settled layout captures; Premiere/native calls remain wrapped by the platform telemetry boundary.

## Honest evidence boundaries

- The before-state used the installed production plugin in Premiere, not a browser mockup.
- The library had no real replay exports during capture. A populated replay-card/player screenshot was therefore not fabricated.
- `oracleUiHealth()` is available for a debug-loaded instance; production validation uses installed hashes, UXP logs, mounted build identity, platform audit, deterministic responsive tests, and actual Premiere screenshots.
