# Orchestration scaling and agent-count claim

## Catalogue boundary

`orchestration.json` contains **35 canonical distinct repositories**. `geekan/MetaGPT` redirects to `FoundationAgents/MetaGPT`, so it is recorded once under the canonical owner. `SWE-agent/mini-swe-agent` is excluded because it overlaps the separate coding-agent/UI research stream. Source URLs and observed licence identifiers are carried in each record; `NOASSERTION` is a licence gate, not a permission to reuse.

The three source-inspected candidates are deliberately narrow: LangGraph includes a checkpoint conformance package at [`libs/checkpoint-conformance/langgraph/checkpoint/conformance`](https://github.com/langchain-ai/langgraph/tree/main/libs/checkpoint-conformance/langgraph/checkpoint/conformance); Graphiti keeps graph-driver and reranker code in [`graphiti_core`](https://github.com/getzep/graphiti/tree/main/graphiti_core); Temporal has history-service code and integration-workflow coverage in [`service/history`](https://github.com/temporalio/temporal/tree/main/service/history). This establishes relevant implementation/test surfaces, not suitability or performance on PaneForge.

## The alleged “1,500 Hugging Face agents found a vulnerability” story

I could not establish that exact claim from a primary Hugging Face security advisory, blog, repository, benchmark paper, or CVE record in this research. Treat it as **unverified** until the original publication supplies: the harness/repository, date, target and authorisation, vulnerability report/CVE or vendor acknowledgement, exact model/tooling, and definitions of spawned agents, concurrent agents and subagents.

These measures are materially different:

- **Total spawned agents** counts every attempt over a run. It does not state simultaneous load.
- **Concurrent agents** determines compute, provider quota, rate limits, shared-state and coordination pressure.
- **Subagents** can be nested accounting units; adding their count to top-level workers can double-count work.
- A **benchmark finding** only shows performance under its fixture. A **real vulnerability** needs reproducibility and responsible-disclosure evidence.

No reliable source supports “more agents is better.” At scale, correlated model errors, repeated context mistakes, quota contention, duplicate effects, prompt injection exposure, and review overload can increase faster than useful coverage.

## Recommendation for PaneForge

Do not target 100+ concurrent autonomous agents now. Start one owner-authorised worker per task, with bounded independent reviewers only where separate evidence is available. Use the durable task ID, lease/fencing token, effect receipt, resource budget and cancellation/reconciliation rules already proposed in the research pack.

A future scaling experiment should ramp 1 → 2 → 5 → 10 → 25 independently reproducible, non-side-effecting fixture tasks. For each level measure queue delay, cost, memory/CPU, provider errors, duplicate attempts, correct completion, citation/authority leakage, reviewer agreement and human intervention. Stop promotion when marginal correct work decreases or recovery/review cost rises. Only after an isolated load test, tenant and secret isolation, rate-limit controls, central scheduling, idempotent effect handling and an independently reviewed incident model should 100+ concurrent work be considered.

Open-weight serving does not remove these constraints. Weights can be permissively licensed while GPU/CPU/RAM, energy, model-hosting security, update provenance, throughput and reliability remain costs. A local Mac-first assistant should keep local small models to evaluated extraction/classification/retrieval helpers. Subscribed Claude/Codex remain the primary planning/coding routes, with no silent paid API fallback. Serving a public multi-user system is a separate isolation, licensing, abuse-control and operating-cost project.

## Sources

- [GitHub REST repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository), used for current canonical owner, description, default branch, pushed date and licence field.
- [LangGraph repository](https://github.com/langchain-ai/langgraph) and [checkpoint conformance source](https://github.com/langchain-ai/langgraph/tree/main/libs/checkpoint-conformance/langgraph/checkpoint/conformance).
- [Graphiti repository](https://github.com/getzep/graphiti) and [`graphiti_core`](https://github.com/getzep/graphiti/tree/main/graphiti_core).
- [Temporal repository](https://github.com/temporalio/temporal) and [history service](https://github.com/temporalio/temporal/tree/main/service/history).
- [SWE-bench repository](https://github.com/SWE-bench/SWE-bench), a benchmark reference only.

No security testing, model runs, clones or third-party code execution occurred.
