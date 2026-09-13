# Harness research library

Open [the catalogue](index.html) to browse 100 distinct repositories with primary sources, observed licences, planning fit and demo/visual links. Open [the feature-value matrix](feature-value-matrix.md) for the actual proposed scope, and [the product boundary](../taskdriver-paneforge-product-boundary.md) for Taskdriver versus PaneForge.

Coverage: 35 assistant/coding/browser projects, 35 orchestration/memory/evaluation projects, and 30 serving/voice/interface support projects. These are not 100 comparable complete harnesses. Some entries are proprietary-product reference repositories or source-available/restricted projects, explicitly labelled. Fit is an engineering judgement, not measured runtime ranking.

Evidence tiers: catalogue entries use primary documentation/licence/metadata checks; selected dossiers inspect specific implementation and test sources. No third-party agent was installed, executed or benchmarked. Mutable branches may change; pin and recheck the exact licence before adoption. No third-party animation code has been copied. Original prototype motion is local CSS.

- [Assistant source/test dossiers](assistant-dossiers.md): OpenHands, Goose, AIRI.
- [Visual reuse dossiers](visual-reuse-dossiers.md): Motion, Magentic-UI, React Bits restrictions and performance tradeoffs.
- [Scaling and claim check](scaling-and-claim.md): concurrency, checkpointing and the unverified 1,500-agent Hugging Face story.
- `catalogue.json` and `catalogue.csv`: combined data; the three source JSON files retain research ownership.
- `build.py`: deterministic local viewer/CSV generator, asserts exactly 100 distinct repository identifiers.

Validation: JSON count and case-insensitive uniqueness, viewer count, recommendation filtering, empty search, local link destinations, desktop screenshot review, 390px overflow and JavaScript error checks passed. This validates the research viewer, not any listed project's reliability or a hundred-worker runtime.
