# Live conversation economics and commercial hypotheses

Research date: 2026-09-13. Proposed architecture and experiments, not an implemented connection, approved spend or revenue forecast.

## Recommendation

Use GPT-Live 1 as Robert's preferred conversational surface. PaneForge owns durable tasks, provider routing, approvals, evidence and recovery. Eligible subscribed Claude/Codex workers handle project work; paid API calls have an explicit independent budget. The client-side delegation bridge must be tested for authentication, latency, interruption and resume before relying on it.

GPT-Live 1 is not just TTS. It is full-duplex conversation with listening, speaking, interruption and delegation to a backend agent. It takes audio/text, not image/video input. Computer observation belongs to a suitable backend model or structured tool. See [model capabilities and pricing](https://developers.openai.com/api/docs/models/gpt-live-1) and [delegation](https://developers.openai.com/api/docs/guides/live-delegation).

## Transcript ownership and alternatives

Managed Responses delegation passes conversation context to the configured API backend. For client delegation, the delegation event contains metadata rather than the full request text. PaneForge must collect `session.input_transcript.delta` and `session.output_transcript.delta`, associate them with the task/delegation, and construct context. Preserve corrections and event identity. Live conversation history is not a substitute for durable project memory. Silent thinking updates and speakable commentary have different purposes; acknowledging an update does not prove speech or task completion. Speech interruption does not cancel background work. [Client delegation documentation](https://developers.openai.com/api/docs/guides/live-delegation).

[ElevenLabs Speech Engine](https://elevenlabs.io/docs/overview/capabilities/speech-engine) is a relevant comparison because it handles speech and turn-taking while a customer's server provides reasoning. Its comparable all-in price was not established in this pass. [Deepgram Voice Agent](https://developers.deepgram.com/docs/voice-agent) combines a voice loop with backend/tool integrations. Its [launch article](https://deepgram.com/learn/deepgram-launches-voice-agent-api) advertised US$4.50 per hour for an integrated stack; this historical vendor figure is not a verified current quote and is not directly comparable to Live's voice-only US$3 per hour.

A separate STT + text model + TTS chain or local speech models can reduce some component charges, but may add latency, turn-taking engineering and desktop resource use. No source establishes equivalent naturalness at a lower complete cost. Keep GPT-Live as the preferred first prototype. Compare alternatives using the same real utterances, Australian names/accents, interruption tests, task success, correction burden and actual complete bill before changing that choice. GPT-Live 1, GPT-Live Transcribe and GPT-Realtime are distinct products; prices and capabilities must not be mixed.

## Voice-only cost

Live sessions cost US$0.05 per connected minute, billed per second. Backend models and tools are separate. Calculations below assume five days per week and exclude currency conversion, taxes, subscriptions and backend usage.

| Connected time each weekday | Live voice per week |
| --- | ---: |
| 15 minutes | US$3.75 |
| 30 minutes | US$7.50 |
| 60 minutes | US$15.00 |
| 8 hours | US$120.00 |

The main voice-cost control is connection duration. Do not promise that muting stops billing. Offer an explicit end-voice action, reconnect with a concise task summary, and keep worker execution independent. An all-day listening product has a different cost model from a readily available assistant.

For backend efficiency: select relevant client facts and task state, discover MCP tools just in time, filter results before model input, retain provider-native sessions where supported, and use exact assertions before screenshots. Keep full evidence outside the conversational context and link to it. Use deterministic code for routing rules and arithmetic when possible. Introduce a small local model only if measured quality and resource use beat the simpler option. Never compress away authority, scope or unresolved failures.

Evaluate cost per successfully completed workflow, including human correction time. Cheap failed attempts can cost more than one strong-model pass. A two-week pilot should record connected minutes, paid backend cost, subscription limits, task completion, corrections and actual time returned to Robert. Choose a hard extras budget before enabling billing; this document does not authorise one.

## Business ideas worth testing

These are hypotheses from Robert's existing service work, not market-demand findings or income promises. The strongest starting point is to make existing delivery more profitable, then sell the repeatable part.

1. **Client delivery desk for small agencies.** Buyer: an agency owner losing time between brief, files, execution and client review. Product: one scoped request becomes tracked work plus a private proof pack and approval. Charge for a narrow implementation and monitored service first; learn the recurring workflow before offering SaaS. Validate paid interest with existing contacts and measure correction time and retention.
2. **Voice brief to reviewed job pack for service teams.** Buyer: a small service business capturing work while away from a desk. Voice plus selected photos becomes a draft scope, checklist and client update. Differentiate on the completed job pack and evidence, not generic transcription. Validate names, quantities and missing details; humans approve commitments and delivery.
3. **Proof-backed retainer reporting.** Buyer: agencies that struggle to demonstrate work performed. Connect completed tasks and selected analytics to a client-readable report with source links and clear next decisions. Begin as a module in current delivery, not a separate app. Validate whether clients read it and whether it reduces report preparation or review friction.

Proposed product split: PaneForge is Robert's local execution workbench; Taskdriver is the mobile/control and client-work surface. A Brezo brand could package one proven service workflow if Robert intends that name. Public retrieval of brezo.ai did not establish an operating product in this pass, so no existing Brezo features or domain ownership are assumed.

Avoid starting with a general assistant sold as capable of every computer task. Select one paid workflow, define completion and exception handling, then widen only after repeated delivery evidence. No autonomous selling, external messages or publication is authorised by these ideas.
