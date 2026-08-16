# Premiere UXP platform audit

Generated: 2026-08-13T17:57:12.675Z

This is a platform audit, not a visual redesign. The JSON sibling contains every declaration and every statically discoverable control. Actual visibility is proven at runtime by the `[Blocky Studios][PLATFORM_RENDER]` record emitted from each measured panel root.

## Release result

- Hard failures: 0
- CSS declarations audited: 4479
- Adobe core-property declarations: 3387
- Adobe CSSNext declarations: 78
- CSSNext capabilities required/enabled: boxShadow, transformFunctions, transformProperties / boxShadow, transformFunctions, transformProperties
- Custom-property declarations: 240
- Undocumented by Adobe's complete property index: 774
- Unsupported display-value declarations: 0
- Known unsupported layout failures: 0
- Untraced Premiere calls: 0
- Untraced native calls: 0

## Control technologies

| Technology | Static/dynamic authored controls |
|---|---:|
| standard-html | 198 |

There are 0 `sp-*` tags, 0 SWC dependencies, and the SWC manifest flag is disabled. With no SWC usage, the disabled flag and absent dependency graph are the compatible configuration.

## Fonts

- Family: Samsung Sharp Sans
- Packaged binaries: 3/3
- @font-face mappings: 4
- Forbidden generic/legacy family declarations: 0
- Static host-controlled text-edit candidates: 22
- Runtime computed-style walker: true
- Native private registration: true

Adobe documents that text edit fields cannot override `font-family`; runtime audit keeps those fields in a separate host-controlled allowlist instead of misreporting ordinary buttons and labels.

## Responsive ownership

- Root ResizeObserver implementation: true
- Source/root breakpoints agree: true
- Compiled width/height media queries remaining: 0
- Test matrix present: true
- Thirty-change coalescing test present: true

## Lifecycle source inventory

Counts are source evidence, while runtime ownership diagnostics, idempotent destroy paths, and repeated-open tests provide duplication proof. A raw count alone is not treated as proof.

| File | listeners add/remove | timers set/clear | rAF request/cancel | observers/disconnect |
|---|---:|---:|---:|---:|
| src/core/oracle-ui-runtime.js | 3 / 1 | 1 / 1 | 0 / 0 | 2 / 2 |
| src/app/oracle-shell.js | 5 / 5 | 0 / 0 | 0 / 0 | 0 / 0 |
| src/settings/oracle-preferences.js | 26 / 26 | 0 / 0 | 0 / 0 | 0 / 0 |
| src/replays/oracle-replay-library.js | 0 / 0 | 2 / 2 | 0 / 0 | 0 / 0 |
| src/replays/oracle-replay-workspace.js | 4 / 4 | 1 / 1 | 0 / 1 | 0 / 0 |
| src/replays/oracle-replay-viewer.js | 3 / 3 | 1 / 1 | 0 / 0 | 0 / 0 |
| src/curves/oracle-premiere-curves-adapter.js | 2 / 2 | 2 / 2 | 0 / 0 | 0 / 0 |
| src/curves/oracle-curves-workspace.js | 1 / 1 | 0 / 0 | 2 / 2 | 0 / 0 |
| src/quick-apply/oracle-premiere-effects-adapter.js | 2 / 2 | 2 / 2 | 0 / 0 | 0 / 0 |
| src/quick-apply/oracle-quick-apply-workspace.js | 5 / 5 | 0 / 0 | 0 / 0 | 0 / 0 |
| main.js | 40 / 40 | 19 / 30 | 3 / 3 | 2 / 2 |

## Declarations absent from Adobe's published property index

- `gap`: 151
- `border`: 116
- `position`: 77
- `line-height`: 59
- `cursor`: 33
- `z-index`: 27
- `text-transform`: 23
- `box-sizing`: 19
- `pointer-events`: 16
- `stroke`: 15
- `padding-inline`: 14
- `outline`: 12
- `appearance`: 10
- `-webkit-appearance`: 10
- `outline-offset`: 10
- `inset`: 10
- `content`: 9
- `transition`: 9
- `animation`: 9
- `fill`: 9
- `object-fit`: 8
- `order`: 7
- `stroke-width`: 7
- `transition-duration`: 6
- `flex-flow`: 6
- `vector-effect`: 6
- `user-select`: 5
- `overscroll-behavior`: 5
- `accent-color`: 5
- `list-style`: 5
- `touch-action`: 5
- `src`: 4
- `font-display`: 4
- `font-synthesis`: 4
- `animation-duration`: 4
- `animation-iteration-count`: 4
- `padding-block`: 4
- `overflow-wrap`: 4
- `image-rendering`: 3
- `scroll-behavior`: 3
- `clip`: 3
- `clip-path`: 3
- `text-shadow`: 3
- `font-variant-numeric`: 3
- `-webkit-user-select`: 2
- `margin-block`: 2
- `will-change`: 2
- `forced-color-adjust`: 2
- `color-scheme`: 2
- `-webkit-font-smoothing`: 1
- `text-rendering`: 1
- `scrollbar-gutter`: 1
- `-webkit-user-drag`: 1
- `backface-visibility`: 1
- `resize`: 1
- `margin-inline-start`: 1
- `shape-rendering`: 1
- `stroke-linecap`: 1
- `filter`: 1
- `stroke-dasharray`: 1
- `isolation`: 1
- `scrollbar-color`: 1
- `row-gap`: 1
- `font`: 1

These declarations are explicitly classified as undocumented, not silently called supported. The release gate blocks known incompatible layout mechanisms (Grid, fixed/sticky positioning, containment, viewport-unit layout, transform scaling, transition-all, and backdrop filters). Adobe's gated CSSNext features are accepted only when every required capability is declared in the manifest.

## Adobe references

- https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-css/styles/
- https://developer.adobe.com/premiere-pro/uxp/uxp-api/changelog3-p
- https://developer.adobe.com/premiere-pro/uxp/resources/fundamentals/user-interfaces/
- https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-css/styles/font-family
- https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-spectrum/swc/
- https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-html/general/unsupported-elements
