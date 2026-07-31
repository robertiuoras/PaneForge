# Capability research — policy and operation

Phase 2 of the prompt and capability intelligence system. Phase 1 gave PaneForge a way to
*use* knowledge ([KNOWLEDGE-ARCHITECTURE.md](KNOWLEDGE-ARCHITECTURE.md)); this is where the
knowledge comes from and what it had to survive to get there.

Everything below is enforced somewhere, and the enforcement point is named. A rule that
lives only in a prompt is a request, not a control.

## The shape

```
Taskdriver          picks one narrow question, one a day, and queues it
  └─ Codex CLI      reads public pages and writes JSON. No repo, no installs.
       └─ ingest    validates, drops, dedupes, and stores at Discovered
            ├─ Obsidian    a note a person can read and edit
            └─ catalogue   userData/capabilities/*.jsonl, what PaneForge ranks
                 └─ index  vaultindex.py sync — incremental, seconds
                      └─ PaneForge retrieval, labelled by lifecycle stage
```

A capability climbs `Discovered → Evaluated → Tested → Verified → Recommended`, and every
step needs evidence that the previous step produced. Nothing types its way up.

## What may be researched

Free and publicly accessible sources only. No login, no paid API, no scraping service, no
browser extension, nothing that needs a credential.

**Leads** — where you find things. Community posts, Reddit, showcases, award sites,
articles, publicly visible competitor products, corporate design systems.

**Evidence** — where you may believe things. Official documentation, the source
repository, a licence file, a changelog, a security advisory, a published standard, or a
controlled test we ran ourselves.

A finding cited only to a lead is **rejected**, not stored with low confidence. So is one
whose primary source was never opened — a search-result snippet reads exactly like a
citation once it is in a JSON field.

*Enforced in* `src/shared/research.ts` → `parseFinding`, `EVIDENCE_CLASSES`.

Never copy proprietary code, private content, copyrighted assets, branding, or a
competitor's distinctive design. What gets written down is the mechanism, in our own
words. That is also the only part that survives their redesign.

## Security boundaries

| Boundary | How it is actually enforced |
|---|---|
| Research has no repository | `runCli` runs the CLI in an empty scratch dir under userData. A page that says "edit the config" is talking to something with no files. |
| Pages are data, never instructions | `injectionReasons` rejects a finding carrying an imperative aimed at an agent, with the reason recorded. Rejected, never repaired — repairing means deciding which half of a poisoned note was honest. |
| Nothing downloaded is executed | The sandbox bundles with esbuild, which links modules. `--ignore-scripts` on install. There is no code path that runs a candidate. |
| Nothing installs without approval | `capability-sandbox.mjs --install` is the only installer, and without the flag it cannot reach the network. MCP servers are third-party executables and are never installed by this pipeline at all. |
| No credentials reach a candidate | The sandbox child gets a hand-built env: PATH, temp, and `HOME`/`USERPROFILE` pointed at the throwaway directory. |
| No project detail leaves the machine | The research brief carries the task sentence and the framework ids. Not the context pack, not a path, not a dependency list, not the draft verbatim. |
| Restricted knowledge is unreachable | `vaultindex.py` refuses to index it at build time, and `sync` now DELETES a note reclassified to restricted. Two gates, and `applyPolicy` is a third. |
| Untrusted knowledge is labelled | The catalogue renders UNVERIFIED/STALE into the note text itself, and the sheet shows the derived stage word. |
| Everything is auditable | Every run leaves a note in `70 Agent Memory/research-runs/` listing sources opened, findings kept, and every rejection with its reason. |

Removal: delete the record's line from `userData/capabilities/*.jsonl` and its note from the
vault, then `python vaultindex.py sync`. Both stores are plain files on purpose.

## Freshness

Review intervals are per record, by volatility — `REVIEW_DAYS` in `src/shared/capability.ts`.

| Class | Days | What it is |
|---|---|---|
| `fast` | 30 | frameworks, AI tooling, MCP |
| `medium` | 90 | active libraries |
| `slow` | 365 | design principles, accessibility standards |
| `inert` | — | rejected and deprecated: revisited on evidence, never on a clock |

A record is also re-checked on a new major release, a maintenance stop, a licence change, a
security advisory, or when a human sets `needsReview`. `coveredBy` is the cache: a trusted
record that is not due review means the research run does not happen at all.

## Running it

```bash
# Taskdriver agent (PC)
python scripts/capability-research.py --dry-run    # decide and print, write nothing
python scripts/capability-research.py --queue      # create the todo
python scripts/capability-research.py --harvest    # ingest what came back
python scripts/capability-research.py --status     # what the dashboard shows

# PaneForge
npm run capability:list                                   # everything, with its stage
npm run capability:sandbox -- --id motion --install        # Discovered -> Tested
npm run capability:lifecycle -- --id motion --verify       # Tested -> Verified
npm run capability:lifecycle -- --id motion --outcome shipped --project ebb
npm run capability:lifecycle -- --id x --reject --why "unmaintained since 2024-02"
npm run test:research                                      # the gate, model-free

# Index
python vaultindex.py sync      # incremental: 0.09s against 0.24s for a full build
python vaultindex.py health    # freshness, counts, and restricted (must be 0)
```

`--queue` and `--harvest` are separate because a dispatch is not a result. A run is
`dispatched` when a todo exists and only becomes `completed`, `no-finding` or `failed` when
a real file has been through a real validator and returned a receipt. No exit code is ever
read as success.

## Rollback

Nothing here is load-bearing for the app: with the catalogue empty and the vault absent,
prompt improvement works exactly as it did in Phase 1.

1. **Stop the schedule** — `Unregister-ScheduledTask -TaskName TaskdriverWebsiteResearch`,
   or `Disable-ScheduledTask` to keep it for later.
2. **Stop consuming the knowledge** — Settings → prompt improvement → capabilities off, or
   delete `%APPDATA%\claude-orchestrator\capabilities\research.jsonl`. The bundled seed
   remains and the feature keeps working.
3. **Undo the vault** — `git revert` in the vault repo; the notes are ordinary Markdown and
   nothing else links to them.
4. **Undo the index change** — `git revert` in claude-memory, then `python vaultindex.py
   build`. `sync` is additive to the CLI; `build` is untouched behaviour and still the
   nightly path.
5. **Undo the app** — revert commit `fe27666`. `runCli` was extracted, not rewritten; the
   improvement path is byte-identical (proved by `test:improve` reporting the same
   736-token envelope before and after).

## Deferred to Phase 3

Named so they are not mistaken for oversights:

- Evaluation-driven learning and any fine-tuning readiness — a Taskdriver roadmap item.
- Semantic retrieval. The index is SQLite FTS5 over ~130 notes; embeddings are not yet
  worth a dependency, and `sources.json` explains why at that corpus size.
- Automated visual, keyboard and reduced-motion testing. The sandbox has no browser, and
  its evaluation notes say so rather than implying coverage it does not have.
- Mac parity for the scheduled half. The PaneForge and vault-index halves are
  cross-platform already; the Task Scheduler registration is Windows-only.
