# Second-brain use audit

**Scope.** Read-only source/configuration audit of shared `claude-memory`, Claude and Codex hook paths, the local vault index, and Assistant's documented recall route. It does not inspect private client notes or raw transcripts, run a fresh-provider session, rebuild an index, or change configuration. The requested 13 September instruction-debt material is in the separate `assistant-g` worktree, so this report deliberately does not re-audit that work or provider-handoff formatting.

## Evidence terms

| Term | Meaning in this audit |
|---|---|
| **Configured** | A documented route or installed hook points to a component. |
| **Injected** | Source or a focused test shows text can be supplied to a provider session. |
| **Retrieved** | A query/context package returns source references. |
| **Used** | A provider response or action cites and applies retrieved material. |
| **Verified** | A controlled, current end-to-end exercise proves the expected result. |

## What is established

| Path | State supported by the evidence | Limit |
|---|---|---|
| Codex project recall | **Configured.** SessionStart emits the shared Codex index, identifies a matching project index, and tells the session to search it narrowly before dependent repository work. [memory-inject.sh](/Users/robertiuoras/Projects/claude-memory/codex/hooks/memory-inject.sh:45) [project pointer](/Users/robertiuoras/Projects/claude-memory/codex/hooks/memory-inject.sh:59) | The project material is advertised, not automatically retrieved. |
| Claude project recall | **Configured.** Assistant instructions require searching the active and archived project indexes, then reading matching notes and later corrections. [AGENTS.md](/Users/robertiuoras/Projects/assistant/AGENTS.md:20) [project-recall.md](/Users/robertiuoras/Projects/assistant/docs/operations/project-recall.md:16) | This is a prescribed agent procedure; it is not a per-task receipt. |
| Claude and Codex handoff | **Injected.** Claude's configured hook emits a scoped handoff and defers retirement until the first prompt; Codex's SessionStart hook emits the shared project handoff. [Claude hook](/Users/robertiuoras/Projects/claude-memory/claude-config/handoff-inject.sh:164) [Codex hook](/Users/robertiuoras/Projects/claude-memory/codex/hooks/handoff.mjs:259) | This audit did not run a cross-provider handoff, so successful use by the receiver remains unverified. |
| Vault retrieval | **Retrieved when the CLI is invoked.** The index enforces restricted/private controls, returns cited bounded packages, and records a small local retrieval receipt. [README](/Users/robertiuoras/Projects/claude-memory/claude-config/vault-index/README.md:10) [context package](/Users/robertiuoras/Projects/claude-memory/claude-config/vault-index/vaultindex.py:767) [receipt](/Users/robertiuoras/Projects/claude-memory/claude-config/vault-index/vaultindex.py:595) | Neither inspected provider SessionStart route invokes this retrieval package automatically. |

## Material gaps

1. **P1: the shared vault is an available tool, not a common provider retrieval step.** Codex injects a shared index and a project-memory *pointer*, then relies on the agent to run a targeted search. Claude's Assistant route likewise prescribes `rg` over the project indexes. The vault CLI can produce a bounded cited package, but no inspected Claude or Codex injection path calls it. This does not mean agents never retrieve it; it means routine retrieval cannot currently be measured or relied on as a common pre-work contract.

   Safe validation: create one synthetic, non-client canary note with a stable reference and run matched fresh Claude and Codex tasks that require it. Record only provider, task ID, returned source reference, policy, and whether the final output applies the canary. Repeat once with retrieval explicitly required and once with only normal startup. That separates injection, retrieval, and use without exposing content.

2. **P1: there is no cross-provider evidence chain from retrieval to use.** The index's receipt stores timestamp, mode, result count, and note references only. It has no provider/session/task identifier, query-policy hash, acknowledgement, output citation, or action/result link. Handoff output similarly supplies prior state but has no receiver acknowledgement record. Therefore the current sources can establish configured/injected and some CLI retrieval, but cannot answer which facts improve outcomes or which provider ignored them.

   Safe validation: define a minimal append-only receipt schema outside note bodies: `provider`, opaque session/task ID, retrieval mode, policy/version, source refs, handoff ID, and an explicit `used_refs` field asserted by the agent. Test it with synthetic facts, missing-result and revoked-fact cases. Treat agent self-report as a signal, then compare it with final-output citations and task success rather than treating it as proof alone.

3. **P2: Codex silently truncates its injected global index at 220 lines.** The SessionStart helper reads only lines 1–220 of `codex/MEMORY.md` and does not emit a truncation marker or a continuation lookup instruction for material beyond that limit. [memory-inject.sh](/Users/robertiuoras/Projects/claude-memory/codex/hooks/memory-inject.sh:35) This is a sensible context-budget guard, but it makes ordering an implicit recall policy: a recent or critical item after the cap is neither injected nor visibly absent.

   Safe validation: use a disposable index with a distinct canary below line 220 and start a fresh Codex task. Confirm the startup text signals the cap and gives an exact narrow retrieval route. Then test a task whose answer depends on that lower canary. Preserve the cap; add observability before considering a larger context budget.

4. **P2: bounded context packages can omit a later correction in the same note.** `context_package()` selects the beginning of each retrieved body and truncates to its character budget. [vaultindex.py](/Users/robertiuoras/Projects/claude-memory/claude-config/vault-index/vaultindex.py:767) Assistant's manual recall procedure correctly requires reading matching notes and dated corrections, rather than trusting a snippet. [project-recall.md](/Users/robertiuoras/Projects/assistant/docs/operations/project-recall.md:23) A future automated package must preserve correction/supersession visibility or it can surface an earlier statement without its qualification.

   Safe validation: add a disposable fixture whose relevant correction occurs after the initial excerpt and assert that its context package includes a correction/supersession signal or a required full-note reference. Run it beside the existing sensitivity and retrieval tests. Do not solve it by indiscriminately enlarging every package.

## Recommended operating contract

Keep durable project memory separate from provider-native summaries, as current Codex policy requires. [AGENTS.md](/Users/robertiuoras/.codex/AGENTS.md:159) Add one small shared retrieval contract rather than another broad memory layer:

1. Before work that depends on prior facts, retrieve a cited, project-scoped package or explicitly record `no relevant result`.
2. Carry stable source references, policy/version and handoff ID across Claude and Codex.
3. Require final outputs to cite the references actually used when the task depended on memory.
4. Gate any automatic confidence claim on synthetic cross-provider canary tests, including update/revocation and a no-result case.

This preserves bounded startup context and existing sensitivity gates. It would make the desired distinction measurable: configured, injected, retrieved, used, then verified.
