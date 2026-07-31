# Prompt Improvement — what is built, what it is worth, what is next

Short version: the feature exists and has shipped. It went in as
`feat(prompts): improve a draft before it is sent, off by default` and has had three
changes since. This document is the investigation, the design as built, the architecture,
the evaluation design — which was named in the code but had never been written — and the
plan for the part of the original brief that is still missing: generating a prompt rather
than improving one.

## 1. Investigation — what is actually there

| Piece | Where | State |
|---|---|---|
| Offer + sheet | `src/renderer/src/components/ImproveSheet.tsx` | shipped, off by default |
| Runner | `src/main/improve.ts` | shipped |
| Request assembly | `src/shared/improveRequest.ts` | shipped |
| Classifier | `src/shared/classify.ts` | shipped |
| Redaction envelope | `src/shared/redact.ts` | shipped |
| Answer validator | `src/shared/promptSchema.ts` | shipped |
| Budgets | `src/shared/promptBudget.ts` | shipped |
| Knowledge retrieval | `src/main/knowledge/*` | shipped |
| Telemetry | `src/main/promptAudit.ts` | shipped, opt-in |
| Invariant tests | `scripts/prompt-*-test.mjs` | shipped |
| **Quality evaluation** | `scripts/prompt-eval.mjs` | **added by this pass** |

`prompt-improve-test.mjs` says in its own header that the rewrite itself is "what
`prompt-eval` (stage 2) is for". That file did not exist. Neither did a golden set, though
the `telemetryText` setting describes itself as being there "so a golden case can be
contributed". The evaluation half was designed and never built; that is the gap this pass
closes.

## 2. Product design, as built

- **Optional.** `mode: 'off' | 'suggest' | 'auto'`, and `off` is the default. Nothing runs
  until a person clicks.
- **The offer is where the eye already is** — the pane footer, after `idleMs` of quiet.
  Quiet triggers the *offer*, never the generation, so idling never spends anything.
- **Nothing is replaced silently.** The sheet shows the rewrite against the original, the
  provenance of any note used, what was held back, and the assumptions the model took. The
  original comes back byte for byte if it is rejected.
- **It can be argued with.** A `tweak` line ("shorter", "keep the file names") re-runs the
  rewrite; removing a retrieved note re-runs it without that note.
- **It may ask, barely.** One question at `minimal`, three at `balanced`, and the ceiling
  is enforced in code, not by instruction.
- **Cheap to reject.** Results cache per project + draft + settings, so Reject → Improve
  again costs nothing.

## 3. Architecture

```
draft ─▶ tooSmallToImprove ─▶ envelope ─▶ classify ─▶ context pack ─▶ knowledge
                 │ (free refusal)            │ secrets/long code held back
                 ▼                           ▼
            no model call          buildImproveRequest (budgeted)
                                             │
                                  the pane's own CLI, headless,
                                  scratch cwd, 90 s deadline
                                             │
                              extractJson ─▶ parseImprovement ─▶ placeholdersMatch
                                             │
                                    restore ─▶ the sheet
```

Four decisions carry the design:

1. **The model runs on the CLI the user already has.** No new API key, no second auth
   surface, no new billing. The improver is `claude -p`, `codex exec`, `gemini -p`… chosen
   per pane, overridable in Settings.
2. **The scratch cwd is the security control.** The improver reads untrusted text with no
   repository under it, so a successful injection has nothing to act on. This is
   load-bearing precisely because it does not depend on a CLI flag staying named the same.
3. **The answer is never trusted.** It is JSON, schema-validated, sanitised, and checked
   against the placeholders it was issued. Dropping one means the user's key vanished from
   their prompt; inventing one means a strange token gets typed into an agent. Both refuse.
4. **Budgets are fixed and pinned by a test.** `balanced` is 2500 tokens in, of which the
   rules leg is capped at 600 and currently measures 551 — so prose that "reads better"
   cannot quietly cost tokens forever.

### Threat model, in one table

| Threat | Control |
|---|---|
| A pasted API key reaching a CLI | `envelope()` holds secrets before anything else runs |
| A whole file being shipped as "context" | fenced blocks ≥ 15 lines are held; short snippets are the question and are sent |
| Prompt injection inside the draft | draft is fenced as DATA; the improver runs in an empty cwd with no tools |
| A poisoned knowledge note recommending itself | notes carry `UNVERIFIED`; retrieval is capped and cited; the ingest validates on arrival |
| The rewrite silently losing the user's key | `placeholdersMatch` refuses the answer |
| Telemetry becoming the leak | hashes and counts only by default; a line that looks like a credential is refused, not redacted |

## 4. Evaluation design

Three loops, because they answer different questions and only one of them costs anything.

**Loop 1 — invariants.** `npm run test:improve`. Deterministic, free, must always pass.
Classification, retrieval, ranking, budgets, the untrusted boundary, the question ceiling.

**Loop 2 — quality, against a golden set.** `npm run eval:prompts` (offline) and
`eval:prompts:live`. 16 cases in `evals/prompt-cases.jsonl` covering every task type, plus
a secret-bearing draft, a code-block draft, an injection draft and three that must be
refused without a model call. Offline it scores what can be decided for free:

- the free refusal agrees with the case (`gate`)
- the envelope round trip is byte-identical
- no secret reaches the request payload
- the request fits the budget and the rules leg fits its ceiling
- the validator coerces what is survivable (an unlabelled answer, a fourth question) and
  refuses what is not (prose, a dropped placeholder, an invented one)
- classification accuracy against the labels, with a 60% floor

Live it runs the real `improve()` — same envelope, same sandbox, same validator — and
scores the rewrite on what is checkable rather than on taste: did a fact the person put in
the draft survive (`mustKeep`), did an answer come back at all, how long it took (p50/p95),
did it stay inside the question ceiling, and did the injection case stay a rewrite about a
README badge. Results land in `evals/results/`.

**Loop 3 — the person.** `npm run eval:prompts:report` reads `prompt-audit.log` and prints
accept rate, median characters edited after accepting, and latency. This is the only
unbiased signal in the system; everything above is the eval marking its own homework.

### What the first run measured

Classification was **62%** on the golden set, with five disagreements. Two were the
classifier being right and the label being sloppy. Three were real:

- a cron that stopped sending a heartbeat had no ops keyword at all → `other`
- "rotate the key that is in the deployed env" scored as a **feature**, on the word "want"
- "fix the scroll without breaking the desktop **layout**" → `design`

The first two are now fixed (`deploy\w*`, plus cron/scheduler/heartbeat/rotate/credentials
in the ops rule); accuracy is **77%**, and the existing suite still passes. The remaining
three are recorded rather than papered over:

| Case | Labelled | Classified | Verdict |
|---|---|---|---|
| `feature-signup` | feature | design | arguable — it is a page and a look |
| `bugfix-scroll` | bugfix | design | real miss; a symptom-only defect has no keyword |
| `question-build` | question | bugfix | real miss; the question rule needs the whole draft to be one sentence |

None of them is fatal: the type is sent to the model as a *guess it is told it may
disagree with*. It picks which single set of task rules is attached, so a miss makes the
rewrite generic rather than wrong.

## 5. What is left, in the order worth doing it

**A. Latency is the product problem, not quality.** A real 661-token payload through
`claude -p` measured **22,540 ms**. The deadline had to be raised from 20 s to 90 s because
20 s was under the time the work takes. Nothing else in this app makes a person wait 22
seconds. Order: measure per engine and per model with `eval:prompts:live`, then default the
improver to the cheapest tier that holds its `mustKeep` score, and only then consider
speculative start on idle with cancel-on-keystroke.

**B. Generation, which is the brief's real target.** Today `tooSmallToImprove` refuses
anything under 40 characters — which is exactly the shape of the input generation would
take. The pipeline is otherwise already correct for it: same classifier, same task rules,
same context pack, same retrieval, same schema.

    improve:   draft ──▶ better draft
    generate:  intent + task type ──▶ draft

The changes are narrow: a `generate` mode that swaps the rules leg (write, don't rewrite),
forces `clarify: 'balanced'` because it has far less to go on, and raises the assumption
ceiling. Its evaluation is already designed by the golden set: run each case with the draft
replaced by its one-line intent and score the generated prompt on the same `mustKeep`
facts. That gives a number for "did generation reach the same prompt a person would have
written", which is otherwise unfalsifiable.

**C. There is no `plan` task type.** Planning drafts currently land on `ops` or `refactor`.
Either add one with its own rules, or say plainly that planning is ops.

**D. Close the telemetry loop.** `telemetryText` exists so a case can be contributed and
nothing consumes it. A "add this to the golden set" action on a rejected improvement would
make the eval grow from real rejections instead of from imagination.

**E. Long drafts are still refused** ("too long to improve safely", over 1200 tokens on
`balanced`). Structural editing of a long draft is a different feature and should stay
refused until it is one.
