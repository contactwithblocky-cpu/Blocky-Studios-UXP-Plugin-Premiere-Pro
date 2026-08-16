# Blocky Studios Overdrive Operator Recovery Runbook

This runbook covers Blocky Studios state recovery and private CCX rollback for plugin ID
`com.blocky.oracle.v5`. It is an operator procedure, not an instruction to reset
user data. Close Premiere Pro and unload Blocky Studios from UDT before copying,
restoring, uninstalling, or replacing anything.

## Data that must be preserved

Blocky Studios' durable domain state is stored in the UXP `plugin-data:` folder returned
by `require("uxp").storage.localFileSystem.getDataFolder()`. Resolve that folder
from the affected Blocky Studios installation; do not guess an AppData path or use the
installed CCX directory as the data folder. In UDT, an operator can resolve the
native path without modifying it:

```javascript
require("uxp").storage.localFileSystem.getDataFolder()
  .then((entry) => console.log(entry.nativePath));
```

Preserve the **entire** returned folder before an upgrade, uninstall, reinstall,
binary rollback, or manual state repair. At minimum it can contain:

- `oracle-state.v3.json`, `oracle-state.v3.tmp.json`, and
  `oracle-state.v3.backup.json`;
- legacy read-only migration inputs `oracle-replay-history.v2.json` and
  `oracle-replay-history.v2.backup.json`;
- `oracle-thumbnails.v1.json`, its temporary file, and
  `oracle-thumbnail-v1-*.jpg` cache entries;
- `oracle-profile-avatar.v1.png` and its temporary/backup files.

Use a new timestamped destination and retain file names, sizes, timestamps, and
hashes. Copying is safe; moving or deleting the live folder is not.

```powershell
$OracleData = 'C:\absolute\path\returned-by-getDataFolder'
$Preserved = 'D:\Blocky Studios Recovery\2026-07-16-before-change'
$Snapshot = Join-Path $Preserved 'plugin-data'
New-Item -ItemType Directory -Path $Preserved -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $OracleData -Destination $Snapshot -Recurse -ErrorAction Stop
Get-ChildItem -LiteralPath $OracleData -File -Recurse |
  ForEach-Object {
    [pscustomobject]@{
      RelativePath = $_.FullName.Substring($OracleData.Length).TrimStart([char]'\')
      Length = $_.Length
      LastWriteTimeUtc = $_.LastWriteTimeUtc.ToString('o')
      SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  } |
  Export-Csv -LiteralPath (Join-Path $Preserved 'SHA256.csv') -NoTypeInformation
```

The Preferences store also uses host-managed `localStorage`, which is not
guaranteed to be inside the `plugin-data:` folder. Before a planned change, use
**Preferences > Data & Diagnostics > Export Settings** as a second recovery
artifact. That privacy-safe export intentionally excludes avatar bytes and
private replay/relink roots; preserve the plugin-data folder for the avatar and
record those roots separately if the owner wants them restored. Never assume
that Adobe uninstall/reinstall preserves either storage area.

## Automatic state and backup semantics

At startup Blocky Studios reads the v3 primary, temporary, and backup files, then any
available legacy v2 inputs. Each candidate must migrate and pass the complete v3
schema validator. Merely being parseable JSON, having a newer filesystem time,
or having a larger revision number is not sufficient.

- With no candidates, Blocky Studios treats the session as a true first run and creates
  an empty in-memory v3 state. The first successful save creates revision 1.
- With one or more valid complete candidates, Blocky Studios chooses the highest
  revision, then the newest `writtenAt` value. A valid incomplete/future-schema
  candidate cannot outrank a valid backup.
- If the winner is not the primary, Blocky Studios hydrates from it and attempts a new
  atomic save to heal the primary. A failed heal leaves the recovered in-memory
  data available but shows an error; stop and preserve the folder before making
  further changes.
- Each successful replacement stages and flushes a temporary file, makes the
  previous primary the single last-known-good backup, replaces the primary, and
  verifies/flushes the committed file. The backup is one generation, not an
  unlimited history.
- A failed replace retains or restores the prior primary. A failed state save is
  reported and is not silently treated as committed.

## `STATE_RECOVERY_REQUIRED`

Blocky Studios raises `STATE_RECOVERY_REQUIRED` only when state candidates exist but
every candidate is invalid or incomplete. In this state Blocky Studios deliberately
does **not** hydrate an empty store, write a replacement, rotate a backup, or
convert the condition into a first run.

When it appears:

1. Stop. Do not import, archive, relink, rename, delete, reset Preferences,
   uninstall, reinstall, or repeatedly reload Blocky Studios.
2. Close Premiere and unload UDT. Confirm the Blocky Studios panel and native addon are
   no longer loaded before touching the files.
3. Preserve the entire plugin-data folder as described above. Keep the original
   primary, temp, and backup even if they appear corrupt.
4. Record the installed plugin version, CCX SHA-256, manifest/inventory hashes,
   the error code, and the privacy-safe support bundle if the UI can still
   export it. Do not paste state JSON or private media paths into a support log.
5. Prefer an untouched, known-good folder snapshot from before the failure. Do
   not select a candidate only because `ConvertFrom-Json` accepts it; it must
   pass Blocky Studios' complete v3 migration/schema validation.
6. With Premiere still closed, restore the known-good snapshot to the exact
   plugin-data folder. Preserve the failed live folder under a different name;
   do not overwrite the only copy. If a valid in-place backup exists, normally
   let Blocky Studios select and heal it automatically instead of renaming files by
   hand.
7. Launch the same package revision, or a newer revision proven to support that
   schema. Verify expected replay/collection/preset counts and metadata before
   accepting the healed primary or deleting any preservation copy.

If no candidate or preserved snapshot passes current validation, stop and
escalate. Deleting all candidates to force first-run behavior is a destructive
metadata reset and requires explicit owner approval after preservation; it is
not recovery.

## CCX binary rollback

A package rollback and a data rollback are separate operations. Replacing the
CCX must not replace, delete, or "clean" plugin data.

1. Preserve plugin data and export settings before uninstalling the current
   package.
2. Record the current CCX, manifest, inventory, and native-addon hashes. Retain
   the exact current CCX so the binary change itself is reversible.
3. Confirm the target rollback CCX has the same plugin ID, a verified package
   inventory, and explicit support for the live state's schema. Do not open an
   older package against newer state merely to see whether it works.
4. Close Premiere and UDT. Uninstall the current package through Adobe's
   installer, confirm its installed directory is gone, then install the retained
   rollback CCX. Do not manually merge package directories.
5. Before opening Blocky Studios, restore plugin data only if the rollback package
   requires the matching preserved snapshot. Keep the newer-state snapshot in a
   separate immutable location so returning to the newer package remains
   possible.
6. Launch Premiere and verify package identity, non-empty shell, expected state
   revision/counts, bridge reconnect, and the critical workflow that motivated
   rollback. A successful binary launch alone is not a successful rollback.

Stop the rollback and return to preservation/escalation if any of these occurs:

- Premiere or UDT still has the plugin/addon loaded;
- package, manifest, inventory, or addon hashes do not match the retained
  artifact;
- the target package does not explicitly support the preserved schema;
- Adobe uninstall leaves a conflicting installed copy, or install resolution is
  ambiguous;
- `STATE_RECOVERY_REQUIRED`, a future-schema error, a state-write error, or a
  primary-heal error appears;
- expected records, collections, presets, preferences, thumbnails, or avatar
  data are missing;
- the bridge/addon duplicates services, fails teardown, or requires forced
  termination.

Do not continue testing through a stop condition. Re-close Premiere, preserve
the new evidence, and restore the last package/data pair that was independently
verified.

## Recovery acceptance record

Record all of the following before declaring recovery or rollback successful:

- source and destination package versions and hashes;
- preserved data-folder location and SHA-256 inventory;
- state candidate chosen, revision, and `writtenAt` value without private media
  payloads;
- whether Blocky Studios selected/healed a non-primary candidate;
- shell/startup result and first Blocky Studios-specific UXP exception, if any;
- expected replay, collection, preset, recipe, and preference counts;
- thumbnail/avatar presence without attaching their bytes;
- bridge/native service count and clean unload result;
- whether any user changes after the restored snapshot were knowingly lost.

Keep the preservation copy until the owner has accepted the recovered data and
at least one later atomic save/restart has succeeded.
