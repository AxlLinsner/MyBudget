# MyBudget v4.12.77 — Backup and Restore Compatibility

## Portable backup format

- Backup envelope: `MYBUDGET_ENCRYPTED_BACKUP`, format version 1.
- Database schema version: 1 (stored independently from the app and backup-format versions).
- Encryption: AES-256-GCM with a 96-bit random IV and a 128-bit GCM authentication tag. Backup header metadata is authenticated as additional authenticated data, so changes to metadata are rejected as tampering.
- Password key derivation: PBKDF2-HMAC-SHA-256, 310,000 iterations, 128-bit random salt, 256-bit AES key.
- Passwords are requested at the time of export/import and are never persisted by the application.
- New portable backups are encrypted; the app does not offer an unencrypted JSON backup export.

## Included persisted data

The snapshot includes categories, all persisted record collections (`incomes`, `transactions`, `bills`, `billOccurrences`, `paychecks`, `paycheckOccurrences`, `assignments`, `budgets`, `debts`, `goals`, `deletedGoalHistory`, `assets`, `liabilities`, and `investments`), Dashboard goal selections, and all financial/general settings except the device-local exclusions below. Derived dashboard charts, report totals, forecasts, and calendar views are recomputed from their underlying records.

## Portable appearance and device-local exclusions

- `settings.appearance` is included in new portable backups. Theme, icon preset and individual icon choices, icon shape/weight/size, card style, density, and other saved appearance customizations are restored from the backup. Older v4.12.74 encrypted backups did not contain this object; when one is imported, the app explicitly warns the user and preserves the destination device appearance because the original appearance cannot be recovered from that backup.
- New backups exclude obsolete cloud-sync and custom-updater preferences. When importing older v4.12.76 backups, those legacy settings are validated when present and then discarded; they are not restored or retained on the device.
- Sidebar collapse state remains in its existing device-local storage key because it is a separate navigation convenience preference, not part of the saved appearance configuration.

## Compatibility and migrations

- Existing unencrypted v4.12.73 JSON exports are detected as legacy imports and require explicit user confirmation.
- Legacy exports without `schemaVersion` are treated as database schema 0 and pass through the explicit 0 -> 1 compatibility step. This step only stamps schema version 1; it does not create, normalize, reconcile, or delete financial records.
- Encrypted backups must contain a schema version matching the envelope metadata.
- Schema versions newer than the installed app are rejected before the live database is replaced.
- Future schema changes must add explicit sequential migration functions to `backupMigrations`.

## Validation and restore safety

- Structural checks cover settings, categories, all persisted collections, record shapes, required IDs, duplicate IDs, supported transaction types, and numeric financial values.
- Relationship checks identify dangling historical references. They are shown to the user and preserved rather than silently discarded.
- Authentication failure, tampering, unsupported formats, newer schemas, and validation failures stop the import before the live database is replaced.
- A password-encrypted pre-restore snapshot is written to IndexedDB before replacement.
- The replacement database is staged in memory and written as one localStorage value only after validation and confirmation.
- A restore session marker ensures a reload enters read-only verification mode only when the restored database write completed.
- During initial verification, startup migrations, debt-ledger recalculation, bill occurrence generation, paycheck occurrence generation, and normal saves are gated. The user can navigate and inspect modules but cannot edit financial records.
- The recovery backup remains available for download or rollback until the user explicitly confirms verification. Only then is it deleted and normal operation resumes.

## Important scope note

The existing transaction CSV export remains a separate, partial spreadsheet export and is not a backup. It is not encrypted. The JSON backup/restore path is always encrypted for new backups. In v4.12.77, cloud synchronization and its authentication/client code have been removed. The local financial database remains the source of truth; encrypted backup/restore is the supported data portability path.

## Historical v4.12.75 appearance restoration correction

- Appearance preferences are now included in encrypted backup snapshots.
- Restore replaces the destination appearance configuration with the backup appearance configuration.
- At the time of v4.12.75, local cloud connection settings remained device-local and excluded. This behavior was superseded by v4.12.77, which removes those settings entirely.
- At the time of v4.12.75, rollback retained the current device's cloud connection settings; v4.12.77 now strips obsolete sync settings during rollback.

## Verification performed for this build

- JavaScript syntax check (`node --check script.js`).
- HTML parser check.
- Isolated helper tests for legacy schema stamping, relationship warnings, preference/credential exclusion, AES-GCM round trip, incorrect-password rejection, tamper rejection, and newer-schema rejection.
- No browser, iPhone, MacBook, or full end-to-end restore test has yet been performed.


## v4.12.76 validation hardening

- Encrypted schema-1 backups must contain a complete, supported `settings.appearance` object. Theme, icon preset, card style, icon shape/weight/size, density, icon customization slots/values, and custom-accent data are checked before restore. Unsupported appearance values are rejected with an actionable compatibility message; they are not silently normalized to defaults during import.
- Legacy unencrypted schema-0 JSON imports may omit appearance preferences. The app clearly asks whether to preserve the destination device appearance in that specific case. Encrypted backups missing appearance preferences are rejected.
- Record validation now checks schema version, settings timestamps, unique categories, numeric fields across additional financial collections, schedule types/frequencies, flags, goal history structures, custom paycheck dates, and known debt/goal status values.
- Relationship validation checks missing references and mismatched two-way links between transactions, bill occurrences, paycheck occurrences, and allocations. Historical relationship issues are warnings; the original records and references are preserved. No records are automatically deleted or rewritten to make validation pass.
- Password entry continues to use the existing browser prompts; password masking was intentionally not changed in this release.
- At v4.12.76, no encryption parameters, database schema version, financial calculations, occurrence generation rules, or cloud-sync behavior were changed. Cloud-sync behavior was subsequently removed in v4.12.77.

## v4.12.76 verification performed

- JavaScript syntax check (`node --check script.js`).
- HTML parser check.
- ZIP integrity check.
- Isolated validator tests for a valid schema-1 payload, required appearance validation, unsupported appearance values, invalid record values, and preservation warnings for inconsistent historical links.
- These are source/helper-level checks only. No browser, iPhone, MacBook, or full end-to-end restore test has been performed for v4.12.76.


## v4.12.77 cloud-sync and updater removal

- Removed the Supabase client import, authentication, upload/download operations, automatic cloud-upload listener, and Settings interface. The `pbos-data-changed` event was removed from `save()` because its only consumer was the cloud-sync listener. Financial bill/paycheck relationship synchronization helpers remain intact.
- Removed the legacy in-app update checker, its Settings controls, stored updater preferences, and startup check. The installed app version remains visible in Settings.
- Preserved `version.json`, service-worker registration, and the existing service-worker install/activate/fetch behavior. Only the service-worker cache identifier was advanced to `budget-os-v4-12-77`.
- On startup, obsolete `settings.sync` and `settings.updates` fields are removed from the live database without changing financial records. Known project-scoped Supabase auth-token keys (`sb-*-auth-token`) are removed from this app origin's localStorage; unrelated localStorage keys are left untouched.
- v4.12.76 encrypted backups remain compatible. Their legacy updater preferences are validated if present and then discarded during restore. New backups omit both obsolete settings. No database schema or backup-format version change was needed.
- The restore confirmation text and recovery rollback path no longer preserve obsolete cloud settings.
- Verification for v4.12.77 includes JavaScript syntax, HTML parsing/ID checks, ZIP integrity, version alignment, and isolated backup-compatibility tests. These are source/helper-level checks; no browser or device end-to-end test has been performed.
