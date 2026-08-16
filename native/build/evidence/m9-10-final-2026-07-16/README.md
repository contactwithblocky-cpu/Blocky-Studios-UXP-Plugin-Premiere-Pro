# Oracle Overdrive M9-10 durable evidence

Recorded: 2026-07-16

Scope: exact private-local `2.0.14-m9-10` source, canonical UDT package,
verified extraction, normal External install, and installed Premiere shell/route
smoke. This bundle preserves the older M9-8 evidence unchanged.

Verdict: the exact M9-10 private engineering package is verified, but the
public release is **NOT READY**. The human physical matrices and public-release
prerequisites listed below remain mandatory.

## Exact package and installed identity

- Canonical packager: Adobe UXP Developer Tools 2.2.1,
  `PluginPackageCommand.package`.
- CCX: `com.blocky.oracle.v5_premierepro.ccx`, 5,334,157 bytes.
- CCX SHA-256:
  `68082DCB170289A28453278A318CCC9577D742B75AB5E303F85DD7979F0C14A7`.
- Package outcome SHA-256:
  `B7677EF71AA5DFC9C8D6D4C142EA3402E56654C6700F674BAC5B31732EE4EEEE`.
- Private inventory SHA-256:
  `E6C9F3E8C0252029B0EFD82484A4244007B4A4D9781F5AADA49D4FBA6991A4CF`.
- Native addon SHA-256:
  `FAB8477C6273EF1AA4690B9F1A284155ACC61E00FB702574DBAF67ED5FE92407`.
- Main source/stage SHA-256:
  `8604BAFD9FF3E92E96B50B41DDA9D6DE2F367841E0FBAE2B3FF2449034A20F34`.
- HTML source/stage SHA-256:
  `F4EA6CD62C583291662792CE3368C8E4F1CECD0CB42A1268315DB57ECF74EA96`.
- Stage, CCX verified extraction, and installed External payload each contain
  50 files totaling 6,933,658 bytes. The per-file comparison reports zero
  extraction differences and zero install differences.
- The installed HTML contains 29 `2.0.14-m9-10` cache references and zero
  `2.0.14-m9-9` references.
- Installed path:
  `C:\Program Files\Common Files\Adobe\UXP\Plugins\salim\External\com.blocky.oracle.v5_2.0.14`.
- `UDT_PACKAGE_OUTCOME.json`, `PRIVATE_LOCAL_INVENTORY.json`, and
  `artifact-identity-m9-10.log` are the machine-readable records. The inventory
  intentionally marks this package `releaseEligible: false` and private-local
  only.

## Installed Premiere shell and routes

Exact installed M9-10 visibly passed the shell/route smoke in Premiere Pro
26.3. The M9-9 white/blank result was traced to the main shell not being
attached to the lifecycle `rootNode`; M9-10 attaches the canonical shell during
prepare/create and repeats the operation idempotently on show before async
bootstrap.

- `m9-10-premiere-oracle-command-submenu-open-real.png` shows the Oracle panel
  docked and fully painted in the real Premiere window.
- `m9-10-installed-oracle-hamburger-open.png` shows Replays, Curves Premiere,
  and Quick Apply Premiere navigation.
- `m9-10-installed-oracle-route-replays.png` shows the real waiting-for-export
  default state.
- `m9-10-installed-oracle-route-curves.png` shows the real animated-property
  selection state and Refresh action.
- `m9-10-installed-oracle-route-quick-apply.png` shows the real 240-result
  effect list, selection-required reasons, actions, and recipes.
- `m9-10-installed-oracle-profile-menu.png` records the profile control.
- `m9-10-oracle-panel-closed-normal.png` and
  `m9-10-installed-oracle-main-shell-after-normal-reopen.png` prove a normal
  tab close followed by `Window > UXP Plugins > Oracle > Oracle` restored the
  same nonblank shell.
- `m9-10-entrypoint-oracle-replays.png`,
  `m9-10-entrypoint-oracle-curves.png`, and
  `m9-10-entrypoint-oracle-quick-apply.png` show all three dedicated panel
  entrypoints painted with real content.

The visible shell includes the dark Minecraft styling, centered Oracle
branding, hamburger, bridge status, and profile control. The captured routes
are populated application states, not placeholder or empty panels. Capture
artifacts and screenshots that exposed unrelated desktop applications were
discarded before the evidence bundle was sealed.

The final frozen host log is
`UXPLogs_2026-07-16_14-14-07_521512.log`. It records
`com.blocky.oracle.v5` as enabled and contains no Oracle-attributable exception
or missing-resource line. `uxp-log-audit-m9-10.txt` itemizes all 41 global
missing-resource matches and all 15 global Error-record prefixes. The first
global missing-resource entries are
unrelated Spell Book icon failures at lines 13-14; the first global Error is
unrelated Adobe export-queue icon metadata at line 65. Two unscoped host
warnings, `Setting focus failed on node: input`, occurred during automated
input focus at lines 283 and 316 and do not identify Oracle. Premiere accepted
a normal main-window close request after the smoke and exited within six
seconds; it was not force-terminated.

## Exact automated acceptance

- Full JavaScript verification: syntax and TypeScript checks plus 449/449
  tests passed.
- Release native verification: 6/6 Release native suites passed.
- Dependency audit: zero vulnerabilities.
- Exact combined log: `verify-release-m9-10.log` (`VERIFY_RELEASE_EXIT=0`).
- All encoded benchmark budgets passed:
  - replay snapshot, 5,000 records: 278.061 ms;
  - replay search: 2.809 ms;
  - virtual scroll, 1,000 records: 0.478 ms total, 0.000478 ms mean,
    maximum 30 mounted cards;
  - effect search: 0.520 ms;
  - graph refresh, 1,000 iterations: 37.781 ms total, 0.037781 ms mean;
  - thumbnail maximum concurrency: 4;
  - heap delta: 27,190,032 bytes;
  - RSS delta: 57,434,112 bytes.

## Evidence boundaries and remaining gates

Earlier M4-M8 UDT/Premiere evidence remains relevant to the implemented host
flows, but it does not substitute for the remaining exact-M9-10 physical
matrix. Before a release-ready verdict, complete and record:

- real hand/mouse OLE drag threshold cancel, Escape cancel, invalid target,
  exact marker versus playhead placement, main/dedicated/viewer origins, and
  repeat after ProjectItem deletion;
- physical keyboard/focus behavior and Narrator/assistive-technology review;
- human dock, float, collapse, and resize visual/smoothness review;
- a physical UXP performance trace and ordered leak/restart/normal-close
  samples;
- a real paired Minecraft export covering production duration and thumbnail
  persistence;
- UNC-path and third-party-effect cases when their prerequisites are available.

Public distribution also remains blocked on font/logo redistribution rights,
successor semver confirmation (a true upgrade from `2.0.14`), and the required
signing/distribution policy.

## Final seal

`SHA256SUMS.txt` covers every other evidence file after the frozen UXP log,
exact final verification log, and final smoke artifacts were added. The
checksum manifest intentionally excludes itself.
