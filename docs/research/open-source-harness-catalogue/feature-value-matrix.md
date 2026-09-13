# PaneForge and Taskdriver feature-value matrix

This is a prioritisation decision, not implementation authority. The desired outcome is fewer human minutes per accepted client deliverable, with evidence and recovery preserved. It is not an ever-larger fleet of bots.

## Product boundary

| Product | Owns | Does not own |
| --- | --- | --- |
| **PaneForge** | Robert's desktop workbench: private project context, provider sessions, local worktree/worker ownership, execution state, evidence and recovery | Client portal, public inference service, phone executor or a generic business CRM |
| **Taskdriver** | Agency-facing request, brief, approvals, client-facing progress/proof and phone companion commands/status | Mac desktop automation, provider conversation state or a second independent memory |

Taskdriver may submit a scoped command and show `requested → acknowledged → running → completed/unknown`; PaneForge's selected host owns execution. A phone acknowledgement is not an external effect, a desktop login, or evidence of completion.

## Prioritise for implementation after plan approval

| Capability | Why it earns a place | Acceptance metric |
| --- | --- | --- |
| Durable task, work-owner and recovery record | Stops lost work, double execution and false completion across restarts/hand-offs | Recovery success; duplicate-effect rate; unresolved-run age |
| Evidence/proof pack with source, commit/run and approval references | Makes agency output reviewable before delivery | Accepted outputs; human review minutes; missing-proof rate |
| Scoped project/client context with provenance and full-text lookup | Avoids repeat briefing and cross-client memory mistakes | Correct-source recall; zero unauthorised retrieval; correction rate |
| Dynamic capability discovery behind deterministic allow-lists | Avoids wasting context on irrelevant tools while preserving policy | Tool-selection success; invalid-call rate; context/tool overhead |

OpenAI’s internal harness report says its repository knowledge, legible app/log/metric tooling and feedback loops were central to its own setup; this is a specific repository and team case study, not a controlled demonstration of general productivity gains. [OpenAI](https://openai.com/index/harness-engineering/) Anthropic’s long-running harness likewise found compaction insufficient alone and used incremental progress artifacts, tests and explicit feature state. [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

## Test before adopting

| Candidate | Test design | Promote only if |
| --- | --- | --- |
| Parallel workers | Match a single-worker and multi-worker run on the same budget and independent fixtures | Accepted output rises after human review, with a worthwhile cost per accepted result and no unacceptable leakage, duplicate effects or recovery failures |
| RAG/graph memory | Compare structured IDs + metadata/full-text against hybrid retrieval on redacted real queries, including stale/forbidden decoys | Citation quality and task completion improve; access leakage stays zero |
| Small local models | Rules baseline versus local model versus subscribed route for schema-bounded extraction/classification | Field accuracy and confidence calibration justify measured RAM/latency impact |
| Screenshot review | Semantic-only versus selected visual checkpoints on visual, terminal and native defects | Added image review catches defects that state assertions miss, at acceptable latency/cost |

Anthropic reports a **90.2% internal research-eval improvement**, not an accuracy guarantee or a coding result. Its multi-agent approach used roughly **15× chat token use** and is weakest where work shares context or has dependencies. [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system) This supports limited parallel research, not a default swarm.

## Defer until a measured need

- A vector database, knowledge graph, always-on local model daemon, public plugin marketplace, hosted agent fleet, and public provider relay.
- Windows-native serving and a separate Taskdriver execution engine, until Mac-first task recovery and phone acknowledgement work end-to-end.
- Any cloud API fallback. Subscription routes remain primary; API extras need a separate explicit budget.

## Cut from the current plan

- **100+ concurrent agents as a default.** More concurrent work amplifies shared quota, coordination, duplicate-effect and review failures. Scale only through controlled fixture ramps.
- **Always-on orb/listening.** It is a privacy, resource and paid-voice decision, not a UI flourish. Use explicit voice connection/end state.
- **Screenshot after every click.** Inspect structured state first and capture images when appearance, terminal/canvas, unexplained failure or final visual acceptance requires it.
- **CEO/department role theatre.** A role label without distinct authority, input, stop condition and measurable output is prompt decoration.

## Evidence ledger and operating rule

Anthropic’s advanced-tool-use article describes on-demand tool loading as a response to large up-front tool-definition context; it describes API features at publication time, not proof for PaneForge’s subscription routes. [Anthropic](https://www.anthropic.com/engineering/advanced-tool-use) OpenAI’s cited internal case study is valuable design evidence but not causal general evidence: it reports a specific internal product, team and environment. [OpenAI](https://openai.com/index/harness-engineering/)

For every candidate, retain: task and fixture version, provider/model/route, budget, duration, accepted output, human correction/review minutes, cost, regression result, recovery outcome and evidence links. Build only where this ledger shows a repeatable improvement. Human approval remains required for external delivery, credentials, paid spend, releases and irreversible actions.
