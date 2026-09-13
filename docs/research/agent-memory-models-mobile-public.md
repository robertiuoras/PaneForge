# Memory, model routing, mobile and public distribution

Research and proposed design, 13 September 2026. Companion to the [platform plan](assistant-platform-plan.md), [orchestration design](assistant-orchestration-and-mcp.md) and [development pipeline](agentic-development-pipeline.md). Requirements below are not claims of implemented functionality.

## A small durable core before a large agent framework

The essential system needs identity, durable tasks, authority, scoped context, executors, evidence and recovery. It does not inherently require a vector database, knowledge graph, permanent agent swarm, local LLM or training pipeline. Add each only against a demonstrated failure or measurable benefit.

Start with a transactional task/event store and artifact references, reusing existing Assistant/Taskdriver contracts where compatible. Preserve one canonical task ID across desktop, mobile, provider conversations and worker attempts. Keep provider-specific state alongside that ID; do not try to convert opaque reasoning into a universal transcript.

## Memory and retrieval

| Memory class | Contents | Authority and lifecycle |
| --- | --- | --- |
| Active task | Objective, constraints, plan, completed/pending work, executor IDs | Durable checkpoints; survives disconnect and view closure |
| Working context | Selected excerpts, tool summaries and provider conversation state | Rebuildable; compact using supported provider semantics |
| Project/client facts | Confirmed decisions, entities, briefs, source references | Scoped, dated, correctable; no cross-client default retrieval |
| Preferences/procedures | Explicit user preferences and approved reusable skills | Versioned; distinguish personal preference from global product policy |
| Evidence | Source artifacts, revision IDs, screenshots, readbacks and receipts | Access-controlled retention; exact provenance and deletion propagation |
| Authority | Approved action/scope, account/device, expiry and revocation | Deterministic ledger; never inferred from similar past text |

Store source ID, revision/hash, source location, account/project, timestamp, sensitivity and retention with each fact or excerpt. Mark observations, user statements and model inferences distinctly. Contradictions create a conflict to resolve, not a silent overwrite. Freshness is domain-specific: a previous sign-in, price, worker status or approval may have expired even when an old note remains useful history.

Retrieval order: exact task/entity IDs → metadata and full-text search → optional semantic candidates → selected excerpts with citations. Enforce access filters before candidate retrieval, including account, tenant, project and retention. A final access check remains necessary when opening an artifact. OpenAI's retrieval documentation supports attribute filtering and configurable chunking; that is a useful pattern, not a reason to require its hosted store.[^1]

If exact/full-text search misses paraphrased concepts in real project material, compare a local hybrid keyword/embedding index. Chunk by meaningful document sections and retain the parent reference. Rerank only when baseline quality justifies its latency. Retrieved content is data, never permission to install a skill, run a command or change policy. Rebuild derived indexes from canonical artifacts; they are not the source of truth.

Deletion and expiry must remove or tombstone derived chunks, embeddings, summaries and cached excerpts as appropriate, and respect a documented backup-retention process. Do not promise instantaneous erasure from immutable backups. Forgetting tests must establish that deleted material no longer retrieves or influences new context. Retaining all raw sessions forever is not a proper memory strategy.

Proposed evaluation fixtures: 50 representative project questions with expected source IDs, stale/contradictory decoys and forbidden client data. Measure correct-source recall, citation correctness, leakage, grounded answers and lookup latency. Record index/embedder/document versions. Access-control leakage must be zero; retrieval quality thresholds need a measured baseline and agreed tolerance. These counts are experimental starting points, not measured outcomes.

## Skills, decisions and agent setup

A skill is an inspectable procedure with a clear trigger, required inputs, bounded tools, expected artifacts and meaningful completion check. Start with the current useful procedures for research, implementation, browser login handoff and proof packs. Keep small metadata in the catalogue, load full instructions only for the selected task, and record the exact version/content hash used.

For public packages, add publisher provenance, pinned dependencies, integrity verification, review status and revocation. A signature proves origin/integrity, not safety or quality. Skill updates are candidate changes tested against fixtures; they cannot broaden their own permissions. Scripts run in the same enforced scope as every other tool. Do not create a marketplace or generic plugin abstraction before the second real integration needs one.

| Code should decide | A model may judge or propose |
| --- | --- |
| Identity, tenant/project access, permitted devices/tools | Relevant authorised tool or source selection |
| Budgets, quotas, concurrency and lifecycle transitions | Work decomposition and priority within those limits |
| Approval validity and irreversible-effect dispatch | Whether an ambiguous task needs clarification |
| Schema validation, idempotency and receipt correlation | Extraction, classification, drafting and code changes |
| Secret handling, revocation and retention | Candidate memories/skills and evidence-backed improvements |

Use an orchestrator responsibility, bounded task workers and evidence-based review. They can be sequential provider sessions; a permanent multi-agent topology is not required. Delegate only independent work with explicit inputs, ownership, stop conditions and output contracts. Agent output must pass schema/policy checks. A confidence number from a model is not a calibrated probability or a capability grant.

## Free and lightweight models

Subscriptions remain the primary planning/coding route. Test deterministic rules first for small jobs. A local model is an optional narrow worker for classification, structured extraction or retrieval-query drafting. It must earn its CPU, memory and battery usage, particularly because responsiveness is the original concern.

| Candidate | Documented facts | Proposed test and limitation |
| --- | --- | --- |
| Qwen3-4B | Apache-2.0 weights; 4B class; native 32K context; local runtimes including MLX/Ollama supported by its card | Compare bounded extraction/classification with thinking disabled; cap context and measure real memory/latency [^2] |
| Phi-4-mini-instruct | MIT weights; 3.8B; long-context support; card requires downstream evaluation | Alternative extraction baseline; pin/review runtime artifacts rather than blindly enabling remote model code [^3] |
| nomic-embed-text-v1.5 | Apache-2.0; embedding model with query/document prefixes | Optional retrieval index, not a planner or factual answerer; version embeddings and evaluate the actual corpus [^4] |

These are test candidates, not claims to be the best current small models. A quantized download size is not runtime RAM. MLX uses Apple Silicon's unified memory, so local inference competes with the desktop and browsers.[^5] Ollama is a convenient experimental runtime, not a required daemon. Keep it unloadable and do not install anything during planning. Windows can choose its own supported runtime when its hardware/workload is tested.

Use 100 redacted real classification/extraction examples, fixed schemas and a simple rules baseline. Compare schema validity, field accuracy, false confident outputs, latency, peak memory and impact on interaction responsiveness against the subscribed route. Escalate ambiguous results to the subscribed model or user. Do not entrust permission decisions, security judgement, final client facts or effect execution to a small model merely to save tokens.

Free weights still cost compute and energy. Cloud free tiers are bounded offers that can change; Hugging Face documents a small included allowance and usage pricing.[^6] Do not make them availability dependencies, send client data to them without the selected data policy, or silently cross into paid usage. API extras need explicit budgets, including voice and any backend computer-use route that cannot run under the chosen subscription surface.

## Taskdriver mobile companion

Taskdriver should expose the same tasks on the phone: start an authorised task, read progress, steer scope, review a request, pause/cancel, and inspect artifacts. Execution belongs on the selected Mac/PC or an explicitly provisioned hosted worker. Mobile voice is another conversational connection to the same task, not a separate assistant with a second memory.

Read-only Taskdriver source reconnaissance found reusable contracts:

| Existing path in `taskdriver.ai` | Observed capability | Limit |
| --- | --- | --- |
| `app/api/app/mobile/start`, `authorize`, `token`; `mobileAuth.ts` | Device-bound PKCE pairing, owner approval, expiring scoped grants and revocation | Does not grant generic computer control |
| `app/api/app/mobile/dashboard` | Bounded mobile read model, including Needs You and bot status | Does not enumerate PaneForge sessions |
| `app/api/app/mobile/devices` | APNs device registration/unregistration | Registration is not delivery proof |
| `app/api/app/admin/agent-runs` and `events` | Durable lifecycle reporting, run identity, sequence deduplication | Reporting is not remote process execution/cancellation |
| `app/api/app/admin/learn/approvals` | Durable human decision receipts | Needs action-specific capability binding for this use |
| `app/api/app/admin/lid` | Mac health/heartbeat observations | No CPU/RAM allocation or desktop input control |

Existing phone draft-send functionality is a separate explicit effect. Do not inherit it as blanket approval for the public companion. The native mobile framework/release status was not revalidated directly in this research; test the actual app and signed build before committing implementation details.

Recommended command contract: authenticated user/device, task ID, unique command ID, expected task revision, requested operation and bounded scope. An approval also binds the exact action digest, account, target device, artifact/version and expiry. Recheck it at execution time; reject stale or changed actions. A tap submits a command, and an executor receipt establishes its acceptance/result. Show `requested`, `acknowledged`, `running`, `completed` and `unknown` distinctly. Cancellation is not complete until the worker confirms its state and pending effects are reconciled.

The phone subscribes to compact task events while foregrounded and refreshes canonical state after reconnect. Push is a wake/status hint, never the only ledger: Apple does not guarantee background notification delivery; FCM may expire or collapse pending messages.[^7][^8] Use opaque task/request IDs and minimal lock-screen text, then authenticate to fetch private details. Do not place credentials, full briefs or screenshot evidence in notification payloads.

If the Mac sleeps or goes offline, preserve the command as pending. Do not claim wake-on-demand or silently move work to the PC. Only a capable authorised host can claim the task, using a lease/fencing token to prevent both devices executing it. Jobs tied to a local browser/profile stay on that host unless an explicit supported handoff exists. A remote phone approval cannot satisfy a macOS password, TCC prompt or other OS action that requires local interaction.

Reconcile the existing Taskdriver backend and local engine around one authority for each datum. A cloud relay can carry scoped commands/events over outbound authenticated connections; do not expose raw shell, CDP or MCP ports to the internet. Pair and revoke each device, authenticate both directions, expire sessions, minimise relay data and enforce task/account scope at the host. Transport and key-management design require a focused security review before implementation; no relay was configured here.

## Public harness model

**Recommended first public shape: a local desktop harness with users connecting their own supported providers and devices.** Sell the product/workflow value independently of inference access. Do not pool Robert's subscriptions, distribute his credentials or assume a subscription can be resold as hosted inference. Verify provider integration eligibility and commercial terms for the exact distribution mode before launch. Document capability differences and quota states honestly.

| Mode | Execution and credentials | Product implication |
| --- | --- | --- |
| Personal prototype | Robert's Mac, existing eligible PC worker, his accounts | Validate end-to-end reliability and resources |
| Public local app | Each user's computer and own provider login | Lowest initial hosting scope; install/update/support and OS permissions still required |
| Optional companion sync | Scoped identity, command/status relay, private artifacts as selected | Device security, retention, operating cost and tenant isolation become required |
| Managed hosted agents | Explicit hosted compute and properly budgeted provider access | Separate pricing, billing, isolation, abuse limits and availability work; defer until demanded |

Computer assistance defaults off in the initial public mode. Enabling it selects capture/control capabilities and devices; disabling revokes handles and stops the executor, not just the UI. Keep settings per user/device. The app should remain useful as a coding/task workbench without desktop control or always-on recording.

Before public release: remove personal hooks/paths/accounts, make onboarding/repair/uninstall reliable, inventory dependency and bundled model licences, separate tenant storage/retrieval, secure update signing, minimise telemetry, support export/deletion, disclose paid routes, and test fresh-user permission denial/revocation. Public plugins need provenance and revocation. Subscription auth belongs in the supported provider flow/local protected storage, never in shared Taskdriver tables or logs. These are actual public distribution requirements, not reasons to build a large hosted platform now.

## PaneForge failure cases to turn into fixtures

| Case | Required behaviour/proof |
| --- | --- |
| App/window closes while a task runs | Worker survives where intended; reattach using durable IDs without another launch |
| Heartbeat disappears but process lives | State becomes unknown; inspect lease/process ownership before reclaiming |
| Mac and PC claim the same command | Only current fenced owner may execute; reconcile any effect with a receipt |
| Provider quota, expired login or changed CLI version | Clear eligible route/capability error; defer or authorised subscription overflow |
| Worker exited without a result | Preserve output; exit does not equal success; task remains unresolved |
| UI button pause versus actual process pause | Show requested state until executor acknowledgement; never fake control |
| Desktop automation collides with user/another agent | Release/queue ownership, refresh target identity; never steal a peer's input lock |
| Screen/window/tab identity changes | Re-observe before action; coordinates and element refs are not durable identity |
| Terminal renderer lags or huge scrollback grows | Bound rendering/log resources without discarding canonical output; measure process tree |
| Task is retried after uncertain external effect | Read back/reconcile before retry; idempotency where supported, no exactly-once promise |
| Approval notification is stale or double-tapped | Deduplicate command; reject expired/revised scope; return existing result |
| A tool server changes schema/account or is revoked | Bind invocation to approved integration/version/transport/account and current authority |
| MCP connection dies while long job continues | Persist job identity/result location independently; reconnect and inspect, do not restart blindly |
| Malicious brief, page, skill or terminal output | Treat as data; cannot grant capabilities, expose secrets or change global instructions |
| Memory retrieves wrong client or obsolete fact | Filter by identity and provenance; uncertainty/contradiction stays visible |
| Voice is muted/interrupted/disconnected | Conversation state changes separately from task cancellation |
| Update occurs during active work | Checkpoint/compatibility path, preserve native session IDs and owned artifacts |
| Mobile loses connection during command | Reconnect by ID/revision; refresh canonical state; do not infer failure from silence |
| Proof image contains another client's data | Detect/scrub before sharing; keep recipient/account tied to the deliverable |

Do not claim these guarantees from architecture alone. The initial evaluation must exercise the real provider, worker, native UI and mobile boundaries with failure injection and recorded results.

## Sources

[^1]: OpenAI, [Retrieval](https://developers.openai.com/api/docs/guides/retrieval).
[^2]: Qwen, [Qwen3-4B model card and licence](https://huggingface.co/Qwen/Qwen3-4B/blob/main/README.md).
[^3]: Microsoft, [Phi-4-mini-instruct model card and licence](https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/main/README.md).
[^4]: Nomic, [nomic-embed-text-v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/main/README.md).
[^5]: Apple, [MLX](https://github.com/ml-explore/mlx).
[^6]: Hugging Face, [Inference Providers pricing](https://huggingface.co/docs/inference-providers/pricing).
[^7]: Apple, [Background updates](https://developer.apple.com/documentation/UserNotifications/pushing-background-updates-to-your-app).
[^8]: Google, [FCM message lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan).
