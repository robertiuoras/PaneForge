# Every prompt this app writes, and what it leaves out

2026-09-02. A prompt-producing site is any place PaneForge (or the hooks it ships with)
composes text that an agent will read as its instructions. This file lists all of them,
quotes what each sends today, and scores it against the definition-of-done items
`claude-config/promptlib` asks of Robert's own prompts:

| item | what it means |
|---|---|
| **anchor** | names a file, symbol, path or URL the agent should start from |
| **done** | says what finished looks like — a command, a flow, a shape |
| **scope** | fences what may be changed |
| **not** | says what must NOT be done |
| **output** | says where the answer goes and in what form |

promptlab (trained on 564 of Robert's prompts) flags exactly two failure shapes:
`no_anchor` and `multi_item`. Both are visible below.

## The sites

### 1. `src/shared/splitPlan.ts` → `splitInstruction()` — the planner brief

Sent to a headless agent CLI to break a long ask into panes.

```
Split the request below into the parts that can be worked on AT THE SAME TIME by
separate agents in separate checkouts - parts that do not need each other's output
and do not edit the same files.

Answer with JSON only, no prose, no code fence: {"tasks":[{"title":"","prompt":"","project":""}]}

- At most 4 tasks. If the request is really one job, answer with one task.
- Each "prompt" must stand alone: it is the ONLY thing its agent will be given, so it
  repeats whatever context it needs and never refers to the other tasks.
- Rewrite each prompt to be specific about what done looks like, but ADD NO WORK: no
  task, file, test or refactor that the request did not ask for.
- "project" is the repo name the part names, or "" when it names none.
- "title" is at most six words.

The request:
<text>
```

anchor ✗ · done ✗ · scope ✓ (`ADD NO WORK`) · not ✓ (`no prose, no code fence`) ·
output ✓ (the JSON shape)

Missing: nothing tells the reader what a good split LOOKS like. It is asked for a
shape and a refusal, never shown one. This is the single site where an exemplar is
cheapest — the answer is a fixed schema, so one worked example costs ~400 chars and
removes the whole class of "it split by topic instead of by checkout".

### 2. `src/shared/splitPlan.ts` → `SplitTask.prompt` — the pane brief

The prompt each of up to 4 panes is actually opened with. **It is written by the
model, not by this app.** `parseSplit` checks that it is a non-empty string and
nothing else.

anchor ✗ · done ✗ · scope ✗ · not ✗ · output ✗ — *none of them are guaranteed.*

This is the largest gap in the app. Four panes, each ~190 MB of CLI, are started on
prompts nothing has checked for an anchor or a definition of done. The instruction in
(1) asks for "specific about what done looks like"; nothing enforces it, and a brief
that lacks it is opened anyway.

### 3. `claude-config/autoclear.mjs` → `RESUME_PROMPT`

Typed into a pane after an automatic `/clear`.

```
Continue the handoff: work its Next steps in order, and do not re-do finished items.
```

anchor ~ (says "the handoff", never its path) · done ✗ · scope ✓ · not ✓ · output ✗

23 words carrying a whole session's continuation. The handoff file's own path is known
at the moment this is typed (`handoff-state.mjs` computed it) and is not in the prompt.

### 4. `claude-config/weekly-log-review.mjs` → `buildPrompt()`

The best prompt in the estate, and the only one with a schema.

```
You are reviewing one week of logs from PaneForge, an Electron app hosting coding-agent
panes, on the <device>.
Only lines added since <date> are included. Find defects worth a developer's hour:
- the same error or wedge recurring (count it), a recovery that keeps firing, ...
Ignore one-off noise, expected lines (ok, ready, checked, no update), ...
Answer ONLY with the JSON object described by the schema: findings[] of at most 8 items ...
An empty findings array is the right answer when nothing recurs.
```

anchor ✓ (each log named as its own `##` section) · done ✓ (`An empty findings array is
the right answer`) · scope ✓ · not ✓ · output ✓

### 5. `claude-config/weekly-log-review.mjs` → `openPane()` — the fix brief

```
Weekly PaneForge log review (<device>, <date>) found N recurring problems in the app's own logs.
They are listed under "PaneForge weekly log review <date>" in claude-config/machine-todo/<DEVICE>.md.
Fix each in this lane, one commit per item, tick the line off when verified.
1. <title>: <fix>
...
```

anchor ✓ · done ~ (`when verified` — never says verified how) · scope ✓ (`in this lane`)
· not ✗ · output ✗

### 6. `scripts/pf-ctl.mjs --prompt`

A passthrough. Whatever the caller hands it is typed into the pane verbatim; the app
adds nothing. anchor ✗ · done ✗ · scope ✗ · not ✗ · output ✗

Every automated caller in the estate reaches a pane through this, so it is the right
place for a floor — but it must stay a passthrough for a hand-typed prompt, so the
shaping belongs at the CALLERS, not here.

### 7. `src/main/splitPrompt.ts`

Transport, not a prompt: it holds the headless flags and calls `splitInstruction`. Its
one prompt-shaped decision — the empty `cwd` and `--settings '{"hooks":{},"outputStyle":
"default"}'` — exists so the desk's own hooks stop answering the split. Nothing to add.

### Not prompt sites (the spec listed them; they are not)

- `src/shared/handoff.ts` — moves a conversation, a repo commit and a screen. It
  composes no instruction text at all.
- `src/shared/mascot.ts` — parses what Robert types INTO the app; it writes no prompt
  for an agent.

## The numbers

Six real prompt-producing sites (1-6).

| item | sites carrying it | sites missing it |
|---|---|---|
| anchor | 2 (+1 partial) | 3 |
| done | 1 (+1 partial) | 4 |
| scope | 4 | 2 |
| not | 3 | 3 |
| output | 2 | 4 |

**Nothing but `buildPrompt` carries all five.** Four of six say nothing about what
finished looks like — including the one that opens four panes at once.

Zero sites show an example. Robert's corpus of good prompts
(`claude-config/promptlib`, 12 templates over 1,482 mined prompts) is on disk on both
machines and is read by nothing the app does.

## What this review produced

`src/shared/promptForge.ts` — one pure function every site composes through, which
cannot emit a prompt without a `Done means:` block, carries anchors and scope when the
caller has them, and can borrow at most two promptlib exemplars. Sites 1, 3 and 5 are
moved onto it; site 2 is forged from the model's own rows, so a pane brief now has a
`Done means:` block whether the model wrote one or not.
