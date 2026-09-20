# Stage 4 history migration checkpoint

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

No real profile has been imported. Activation, rollback-pointer switching, and any bounded non-client provider-resume test require the later reviewed migration phase and explicit cutover authority.
