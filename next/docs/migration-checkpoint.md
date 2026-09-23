# Stage 4 history migration checkpoint

## Standalone Next profile transition

The older standalone Next launcher uses a separate profile from the packaged app. Its active conversations must be copied with `scripts/migrate-next-profile.mjs`, not the legacy history importer below. With the owning supervisor stopped, run `node scripts/migrate-next-profile.mjs --source OLD_NEXT_PROFILE --target NEW_PROFILE` to validate and inspect counts, then add `--apply` to copy. The target parent must exist and the target itself must not exist. Packaged Next uses its Tauri app-data directory's `supervisor` subdirectory; verify that exact destination on the device before activating it.

The command stages every regular file and directory, preserves bytes, and verifies SHA-256 inventories of both copy and source. It then reserves the target with an exclusive directory creation and transfers the verified contents. An incomplete transfer fails and leaves the target for inspection, never reporting success. Do not start the destination supervisor until the command succeeds. It rejects links, special files, malformed session lists, duplicate or empty session IDs, nested destinations and existing destinations. Private files remain local with restrictive permissions; reports contain counts only. The source is retained unchanged as the recovery copy. Concurrent source writes cause failure when observed by the final inventory check; this is not a filesystem snapshot, so stopping the source supervisor is a required precondition. Do not run it against an active profile or publish profile artifacts.

This command does not switch or start either app. If the new profile needs recovery, stop its supervisor and preserve its newer work before returning to the original launcher/profile. Returning to the original profile alone does not merge work created since the transition. Installed activation and recovery still require separate verification.

`scripts/migrate-history.mjs` imports only legacy PaneForge's `history/*.json` metadata and `history/*.log` terminal bytes. It streams raw files in 1 MiB chunks while hashing and staging them, so large transcripts are preserved without loading them into process memory. Orphan logs are staged as explicit read-only orphan-transcript records with no fabricated metadata or native identity. It never changes the legacy profile, starts providers, alters `sessions.json`, activates a data directory, or copies `config.json`; the latter can contain credentials.

Run a reviewed plan first:

```sh
node scripts/migrate-history.mjs --source /path/to/old-user-data --target /path/to/next-data
```

`--apply` is required before it writes. It creates an exact raw backup under `migration-backups/` and an additive staging import under `migration-staging/`. Each record has a stable SHA-256 migration key based on its legacy pane ID and raw metadata/transcript hashes. The importer reopens and hashes its staged copies before reporting success. Repeating the same plan reports the record as already present.

Imported records remain read-only because a history row alone cannot verify both native provider identity and provider transcript evidence. The raw metadata retains `resumeId` unchanged as an observed native identifier, but continuation is deliberately unavailable. Orphan logs have no metadata or native identity and stay read-only. Bad metadata and non-regular files are reported without replacements.

Verification used synthetic fixtures only:

```sh
node --test tests/migrate-history.test.mjs
```

Acceptance evidence on 2026-09-21 also used one temporary copy of a PaneForge-profile metadata/log pair. The importer staged and backed up both files with matching SHA-256 values, the second apply reported it already present, and the source hash remained unchanged. The temporary source, staging, backup, and reports were then removed. No live profile was written, activated, or copied into this repository.

The runtime does not currently read `migration-staging/`: `GET /api/history` calls `Sessions.historyMetadata()`, which only lists active `sessions` state. A later reviewed activation phase therefore needs a read-only staged-history index (records and import report), an explicit user-approved destination switch, and UI/API display that keeps imported entries non-resumable. The current importer intentionally has no activation or rollback-pointer switch; deletion of an unactivated temporary staging directory was the bounded rollback exercise.

`server/imported-history.mjs` now supplies that read-only index without changing the active session store. `listImportedHistory({ dataDir, query, limit })` returns `{ items, malformed, total, truncated }`; `malformed` is an array of safe diagnostic records, while `total` counts every matching valid record and `truncated` says whether the `limit` shortened `items`. An item is `{ id, title, provider, model, nativeSessionId, startedAt, endedAt, sourceKind, readOnly: true, resumable: false, detailId, transcript: { available, bytes }, report: { runId, available } }`; IDs are opaque stable migration-key references, never paths. `readImportedHistoryDetail({ dataDir, id, maxBytes })` returns the same item plus bounded leading transcript text and `truncated`. It rejects malformed manifests, mismatched or missing staged files, and symlinks, including linked staging ancestors and transcript substitution after lookup. It never exposes an on-disk path or provides a resume action.

Repeated imports now hash the staged files before reporting already present, and verify existing backup bytes without overwriting them. A damaged staging file or backup fails verification; manifest conflicts are counted explicitly. Empty history produces a readable report. These cases pass with the full 102-test Next suite. Activation and data-pointer rollback remain unimplemented.
