# Oracle Overdrive M9-8 durable evidence

Recorded: 2026-07-16

Scope: exact private-local `2.0.14-m9-8` source, CCX, normal External install,
installed Premiere smoke matrix, live Minecraft bridge, and preserved user data.
This directory does not claim public-release readiness or replace the pending
physical matrices listed in `docs/oracle-overdrive/M9_RELEASE_EVIDENCE.md`.

`evidence-integrity.log` rechecks 13 acceptance assertions and reports zero
failures. `SHA256SUMS.txt` binds every other file in this directory.

## Automated acceptance

- `javascript-verify.log`: syntax and TypeScript checks plus 441/441 tests.
- `native-tests.log`: 6/6 Release native suites in 10.41 seconds.
- `npm-audit.log`: zero vulnerabilities.
- `m9-benchmark.log`: all six encoded budget booleans are true.
- `paired-mod-java21-build.log`: paired Oracle mod Java 21 clean build, 520 tests
  across 76 suites, zero failures/errors/skips, completed in 2m06s.
- `paired-mod-runtime-proof.log`: rebuilt JAR/profile byte identity, responsive
  Minecraft PID/window, live listener ownership, startup markers, and zero new
  crash/JVM-fatal artifacts.

## Exact private package

- CCX: `com.blocky.oracle.v5_premierepro.ccx`
- CCX size: 5,334,680 bytes
- CCX SHA-256:
  `CA4D4FB48DFD8DF1E73F5543379790664327C54B732ED9EFD7A50418A9D81DAE`
- Inventory: `PRIVATE_LOCAL_INVENTORY.json`
- Inventory SHA-256:
  `5D75AF805EA8261B7AD35325F72842A5791E515581B5AF7AB0242CC2ECF728C7`
- Native addon SHA-256:
  `FAB8477C6273EF1AA4690B9F1A284155ACC61E00FB702574DBAF67ED5FE92407`
- `stage-m9-8.log`, `ccx-verify-m9-8.log`,
  `installed-identity-m9-8.log`, and `artifact-identity-matrix.log` bind source,
  stage, archive, and installed payloads. The final matrix reports zero failures.

## Installed Premiere and bridge

- `m9-8-installed-main-clean.png`: repaired clean Replays default route and full
  Minecraft shell.
- `m9-8-installed-main-drawer.png`, `m9-8-installed-main-curves.png`,
  `m9-8-installed-main-quick-apply-topmost.png`, and
  `m9-8-installed-preferences.png`: main shell navigation and Preferences.
- `m9-8-installed-dedicated-replays.png`,
  `m9-8-installed-dedicated-curves.png`, and
  `m9-8-installed-dedicated-quick-apply.png`: all dedicated entrypoints.
- `m8-command-window-identity.log`: two repeat supported-command invocations,
  zero new or removed Premiere top-level windows.
- `bridge-listener.json`, `bridge-subscription-contract.txt`,
  `bridge-probe.json`, and `bridge-proof.txt`: Minecraft PID 61560 owns
  `127.0.0.1:3001`; protocol-v2 `bridge_hello` and `snapshot` were received.
- `premiere-uxp-full.log` and `premiere-uxp-oracle-slice.log`: exact installed
  host log and scoped analysis. The Oracle slice reports zero attributable
  exception/missing-resource lines.

## UDT scope and user-state preservation

- The requested exact stable-M3 UDT checkpoint is under the sibling
  `../m3-stable-2026-07-16/` directory and passed before M4.
- `m9-7-stable-shell-panel.png` and `m9-7-udt-stable-reload.png` retain the later
  successful source UDT smoke.
- `m9-8-udt-after-cache-refresh.png` and `m9-8-udt-fresh-profile.png` document an
  inconclusive final attempt in which UDT's own application renderer went white;
  they are not represented as an M9-8 product-render pass.
- `user-state-preservation.log` proves the substantive 66-replay Developer
  state remains byte-identical to its preserved backup. No cross-scope or stale
  External restore was performed.
