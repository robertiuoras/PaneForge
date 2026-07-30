# Knowledge architecture

Written 2026-07-31, and **verified against the machine rather than described from
memory**. The version this replaces was drafted without access to the system it was
describing, and it proposed building four things that already exist while missing the one
thing that is actually absent.

Every claim below was checked by running the thing it describes. Where a number appears,
the command that produced it is next to it.

---

## 0. What was already true, and what the earlier draft got wrong

| The earlier draft said | What is actually on disk |
|---|---|
| "Obsidian stores curated capability summaries… PaneForge retrieves relevant knowledge" — as work to be done | Retrieval **already exists**: `claude-memory/claude-config/vault-index/vaultindex.py`. Standard-library Python over SQLite FTS5, `build / query / context / doctor / stats`, 19 tests. What did not exist was any PaneForge code that calls it. |
| A lifecycle of `Discovered → Evaluated → Tested → Verified → Recommended` | The vault's real lifecycle is `inbox draft reviewed verified superseded archived`, declared in `90 System/schemas/frontmatter.md` and weighted by `sources.json`'s `status_weight`. A second vocabulary would score as unknown in every one of those places. |
| "Agents propose new knowledge as drafts" | Already built and stricter than described: `proposals.py propose → review → promote`. A proposal whose only evidence is `inferred` can never be promoted. |
| "Exclude private or restricted information unless the active project is authorised" — as a retrieval rule | Stronger than that already: `restricted` notes are refused **at index build time**, so their text is never in the database. `test_vaultindex.py` asserts the text's absence, not merely the row's. A query-time rule is one forgotten flag from a leak; this is not a query-time rule. |
| "Never inject the entire vault into a prompt" | `context` already returns a budgeted package — `budget_chars: 6000` — with `cite`, `conflicts` and `stale` on every hit. |
| "Large raw datasets… stored outside the Markdown vault" | Roughly right, but the real rule is sharper and worth keeping literally: `60 Datasets` is excluded **so an agent cannot quote its own test answers back as knowledge**, and `80 Archive` is excluded because superseded material that still answers a query is worse than no answer. |

Measured, 2026-07-31 (`py -3 vaultindex.py stats`):

```
notes      128
vault      agent-memory=103, knowledge=25
sensitivity internal=124, private=4
status     (none)=103, verified=18, reviewed=4, draft=3
type       (none)=102, playbook=10, index=6, lesson=4, project=3, decision=2, research=1
restricted 0   (must be 0)
```

**The real gap is in that last block.** There is no `capability` type and there are zero
capability records. The knowledge architecture is built; the capability catalogue it was
supposed to serve has never had a single row. That is what Phase 1 addresses, and it is
why the fixtures in `src/shared/capabilitySeed.ts` all ship as `draft`.

---

## 1. Where knowledge lives, and who owns each layer

Three stores, and the rule that keeps them from arguing (from
`90 System/schemas/agent-memory.md`, `status: verified`):

| Layer | Home | Written by | Lifetime |
|---|---|---|---|
| Code truth | the repo | code | tracks the code |
| Operational memory | `Projects/claude-memory` | agents, continuously | churns |
| Durable knowledge | `~/Documents/Obsidian Vault` | humans, after review | years |

A fact belongs in the repo if the code is its authority. It belongs in `claude-memory` if
it is how the machine is wired. It belongs in the vault if it stays true after this
project ends. **The same fact is never written twice** — `70 Agent Memory/` in the vault
holds pointers and policy, not copies.

Both vaults are indexed by one `vault-index`; `sources.json` names the folders and the
exclusions.

---

## 2. Lifecycle, and where the earlier draft's words map to

```
inbox → draft → reviewed → verified
                    ↓
              superseded / archived
```

Only `reviewed` and `verified` are trusted by agents. Everything else needs
`--include-untrusted`, which means "this has not been checked" and must be said out loud
wherever the result is shown.

The earlier draft's vocabulary maps onto this rather than replacing it:

- **"Recommended"** = `verified` **and** at least one recorded outcome that shipped.
  Expressed on the record (`Capability.outcomes`), not as a status.
- **"Rejected" / "deprecated"** = `superseded`, with `whyNot` and `supersededBy` filled
  in. It stays searchable on purpose: a capability that has been ruled out must answer
  the query that would otherwise make somebody reconsider it from scratch.

Sensitivity is `public | internal | private | restricted`. `restricted` is unreachable.
`private` requires a matching `--project` and is invisible from any other project.

---

## 3. What PaneForge does with it

PaneForge is a **consumer**. It reads, it never writes.

```
draft prompt
   → envelope (secrets and long code held back)
   → classify (30-rule keyword table, local, free)
   → project context pack (this cwd only, ≤700 tokens)
   → retrieve  ──► vault-index provider   (preferred: build-time sensitivity guarantee)
                └─► markdown provider      (fallback: no Python, no index)
                └─► capability catalogue   (bundled seed + userData/*.jsonl)
   → assemble within budget, notes as quoted DATA
   → one headless CLI run, tool-less, in an empty folder, 20s deadline
   → validate → sanitise → un-envelope
   → a sheet the user reads
```

The interface is `src/shared/knowledge.ts` and it mentions neither Obsidian nor Markdown
nor Python. A provider implements `search(query)`. That is the whole coupling.

**Writes go through `proposals.py`, never through PaneForge.** Nothing in this feature
installs software, edits a file, spends money, sends a message or submits a prompt. The
only write it performs at all is a bracketed paste into a terminal the user is looking at.

---

## 4. Retrieval rules, as implemented

| Rule | Where it is enforced | Test |
|---|---|---|
| Relevant to this task and project only | `KnowledgeQuery.project`, assembled per request from one `cwd`; no global corpus, no cross-project cache | "project A's private note is invisible from project B" |
| Prefer verified and recently checked | `status_weight` × freshness decay in both providers | ranking checks in `prompt-improve-test.mjs` |
| Always cite | `KnowledgeNote.source`, shown in the sheet, separate from the prompt | end-to-end block |
| Never the whole vault | `budgetChars`, `mergeNotes`, per-leg token budgets | "the character budget is enforced" |
| Deduplicate | `mergeNotes` keys on normalised text, not id — the same fact from two providers reads as corroboration otherwise | "the same fact from two providers is counted once" |
| Stale and conflicting are flagged, not hidden | `stale` on every note, rendered as `STALE` | "a record past its review window is stale" |
| Imported content is untrusted | notes are delimited DATA; descriptions are truncated and quoted attributes, never instructions | the hostile-content block |
| Cache before researching | Phase 1 does no external research at all | — |

---

## 5. The learning rule, kept

More data is not better. What improves this system is organised knowledge, verified
outcomes and corrections.

Two things follow, and both are enforced rather than asserted:

- **Popularity is not an input to ranking.** `Capability` has no star count, no download
  count, and no field one could be put in. `prompt-improve-test.mjs` asserts the absence.
  What raises a score is a verified outcome, a status a human moved, and fitting the
  stack in front of us.
- **Fine-tuning is not on the roadmap yet, and the vault already says why.**
  `90 System/schemas/training-example.md` (`status: verified`) makes `60 Datasets` the
  only trainable folder, excludes unverified AI output by name — "training on it teaches
  the model its own guesses" — and requires an eval that the example would improve before
  a row is eligible. Retrieval has to be proven first. The realistic step after that is a
  distilled classifier, where the label set is closed and the exposure is one token.

---

## 6. Using it, on either machine

```bash
cd "$PROJECTS/claude-memory/claude-config/vault-index"

py -3 vaultindex.py context "<the task>" --project <slug> --json   # Windows
python3 vaultindex.py context "<the task>" --project <slug> --json # macOS
```

Two things that cost real time to find and are now handled in code:

- **`python` on Windows is the Microsoft Store alias stub**, not an interpreter. It prints
  an advert and exits non-zero, which reads exactly like a missing script.
  `pythonCommand()` in `src/main/knowledge/vaultIndex.ts` uses `py -3`.
- **Windows Python defaults stdout to cp1252**, and the vault's notes contain arrows and
  curly quotes, so `json.dumps` dies with a `UnicodeEncodeError` and it looks like an
  empty vault. The provider sets `PYTHONIOENCODING=utf-8`.

Path handling is `expandHome()` plus `node:path`; `~`, `~/`, `~\`, drive letters and
POSIX absolutes are all covered by tests. Nothing under a home directory is hardcoded in
shipped code — the vault path and the index path are settings, empty by default, and
Settings *offers* a detected candidate rather than assuming one.
