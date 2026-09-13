# PaneForge successor research and decision gates

Research baseline checked 13 September 2026. This pack plans the successor; it does not implement it. Mac first, Windows follows; subscriptions first with explicitly budgeted API extras. Taskdriver mobile is the companion surface. Public distribution is a first-class planning constraint.

## Read by decision

| Document | Covers |
| --- | --- |
| [Platform recommendation](assistant-platform-plan.md) | Electron alternatives, Tauri/React candidate, GPT-Live, benchmark corrections, OSS landscape and migration |
| [Experience design](assistant-experience-design.md) | Assistant/workbench layout, voice/task states, login handoff, resource visibility and proof packs |
| [Orchestration and MCP](assistant-orchestration-and-mcp.md) | Tool discovery, token efficiency, shells, provider continuity, ACP and task ownership |
| [Agentic development pipeline](agentic-development-pipeline.md) | Subscribed local workers, public CI separation, tests, reviews, self-improvement and release evidence |
| [Memory, models, mobile and public](agent-memory-models-mobile-public.md) | Durable state/RAG, skills, small models, Taskdriver reuse, public product modes and failure cases |
| [Efficient UI observation](efficient-ui-observation.md) | Structured state first, targeted visual checkpoints, CLI/MCP tradeoffs and measurable efficiency |

## Recommended sequence

1. Establish current whole-process performance and critical behaviour baselines. Lag has not been remeasured in this research.
2. Qualify direct subscription routes and required capabilities, with bounded real requests and no ambient API fallback.
3. Prototype one durable task through worker restart, cancellation and a provider/session reconnection, retaining evidence and ownership.
4. Compare equivalent Electron and Tauri shells with the same terminal/session workload. Decide from measured responsiveness, memory and platform compatibility.
5. Demonstrate one complete private workflow: accepted brief/context → authorised work → Chrome login handoff when needed → verified private proof pack.
6. Add the efficient development loop: deterministic UI fixtures, scoped state/interaction checks, targeted image review and protected CI gates.
7. Prove the Taskdriver phone journey, including stale/double approvals, offline hosts and real executor acknowledgements.
8. Run and improve the harness privately for Robert's own projects and Taskdriver delivery. Public distribution is deferred without a target date; reconsider only if Robert chooses and demand warrants it. Hosted compute and a plugin marketplace remain deferred.

The sequence is a proposed set of experiments, not authority to install frameworks, call paid APIs, change permissions or release an app. Each experiment needs its named preconditions, fixtures, budgets and pass criteria recorded before execution.

## Open decisions and missing evidence

- Tauri remains the leading candidate, not a measured winner. Browser/terminal fidelity, session survival and whole-process memory require the comparative spike.
- Numerical API and device-resource budgets are not yet selected. Default for unbudgeted extras is disabled/deferred.
- The supplied YouTube link's metadata was retrieved, but the requested segment could not be downloaded because the media request returned HTTP 403. Its 4:00 appearance has not been visually reviewed. Antigravity's local concept image was reviewed; final visual direction and high-fidelity mockups remain open.
- Direct CLI help and documentation were checked; subscription authentication, adapters, GPT-Live and computer-use integration were not exercised.
- Taskdriver's relevant server contracts were inspected. A real signed phone build, pairing/approval path and end-to-end host control were not tested.
- Public provider eligibility, redistribution licences, pricing and security need review against the final chosen packaging. No commercial entitlement is inferred from a working local prototype.
- Local small models and RAG are candidates only. Begin with structured state/full-text retrieval and simple rules; adopt extra infrastructure only after measured benefit.

## Coverage and authority

Antigravity's research was read and corrected where primary sources disagreed. This pack covers the requested architecture, assistant orchestration, UI direction, device operation, mobile/public concerns, memory, skills, lightweight models, CI/CD and edge cases. It establishes a research baseline with explicit experiments, not a complete implementation specification for every subsystem. Detailed designs should follow the evidence from those experiments rather than freezing untested assumptions now.

No application code, dependencies, credentials, OS settings, agent schedules or release configuration were changed for this research. Documentation follows the assigned lane workflow; commit, merge/push and release are separate states, established by their Git/tool receipts.

## Design and economics follow-up

- [Three visual directions and animated study](../design/paneforge-directions/README.md)
- [Voice economics and commercial hypotheses](voice-economics-and-opportunities.md)

- [Brezo startup ideas, deferred](../ideas/brezo/README.md): separate from the active Taskdriver agency priority.

## September 13 research and studio revision

- [Taskdriver and PaneForge product boundary](taskdriver-paneforge-product-boundary.md): one business record, personal assistant and dedicated Chat / Work / Code views.
- [100-project research library](open-source-harness-catalogue/index.html): searchable catalogue, source and licence evidence, demo links and source/test dossiers.
- [Feature value decisions](open-source-harness-catalogue/feature-value-matrix.md): measured evidence versus inference, with build/test/defer/cut criteria.
- [Revised studio prototype](../design/paneforge-directions/studio.html): restrained palette and Astra placeholder; simulated interactions only.

- [Grok Bot competitor update](grok-bot-competitor.md): confirmed persistent teammates, marketplace, expanded subscription access, employee workflows and value evidence. Refines the earlier instructions-only treatment of roles.

- [Personal assistant execution, motion and usage plan](personal-assistant-execution-and-motion.md): compact companion, event-driven animations, subscription workers, voice metering and accent settings.
