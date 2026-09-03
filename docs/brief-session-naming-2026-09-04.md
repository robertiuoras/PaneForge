# Brief: a pane's name says the subject, then which project

Robert, 2026-09-04, after being shown what the shipped rule answers for this session's own
asks. Two defects and one addition.

## The defects (measured, `node scripts/title-demo.mjs` is the harness)

| the first ask | card says today | why it is wrong |
|---|---|---|
| `whenever you open dev window please tell me whats different...` | `Whenever You Open Dev` | the opener ate the four-word budget; the subject never arrives |
| `can you measure right now why im lagging?` | `Measure Right Now Why` | ends on a dangling `Why` |
| `we need to tune the naming of session as well, broken like...` | `Tune Naming Of As` | `Of As` is not words |
| `when pressing on sidebar icon everything breaks` | `Fixing Pressing On Sidebar` | two verbs, subject pushed out |

1. **A runway opener may not spend the budget.** `whenever you`, `we need to`, `can you`,
   `could you`, `i want to`, `i need`, `please`, `lets`, `also`, `right now`, `as well`,
   `for me` carry no subject. `RUNWAY` in `src/shared/clientName.ts` already does some of
   this - it is not catching these, and that is the bug to fix, not a second list.
2. **A name may not END on a filler word.** Trim any trailing `of`, `as`, `to`, `for`,
   `with`, `and`, `or`, `in`, `on`, `at`, `is`, `why`, `what`, `how`, `the`, `a`, `an`
   before the name is returned - and if trimming empties it, answer `''` (keep the folder
   name) rather than a stub.
3. **Two verbs is one too many.** After `DOING` has taken the leading verb, a second
   gerund-able verb immediately following it (`Fixing Pressing On Sidebar`) is part of the
   shape, not the subject: drop it. Expected: `Fixing The Sidebar` / `Fixing Sidebar`.

## The addition Robert asked for

A name must say WHICH PROJECT it belongs to, appended after the subject:

- `Dev Window Testing · PF`
- `Sidebar And Naming Fixes · PF`
- `Chasing Invoices · Cars`

Rules, and put the arithmetic in `src/shared/place.ts` next to `copyNumber` (it is the one
place a project becomes words), exported as `projectTag(project: string): string`:

- A SHORT project name is shown whole: 8 characters or fewer -> `Cars`, `Momin`.
- A longer name that has internal capitals or separators is its initials, uppercased:
  `PaneForge` -> `PF`, `taskdriver.ai` -> `TD` (split on capitals, `.`, `-`, `_`, space).
  A name with only one part and no humps is its first 8 characters.
- Never invent a tag for a pane whose name is ALREADY the project (a card called
  `PaneForge` must not become `PaneForge · PF`).
- The separator is ` · ` (U+00B7 with spaces). Not `|`, not `-`.
- The tag never counts against the subject's word budget, and a subject that would be
  empty gets no tag either - the folder name stands alone, exactly as today.

## Rules

- Words on screen are read by somebody who has never used git (CLAUDE.md). The tag is a
  project name, never a lane, slot, branch or checkout.
- Extend `scripts/client-name-test.mjs` and `scripts/place-test.mjs`: every row of the
  table above as an exact assertion, plus `projectTag` for `Cars`, `Momin`, `PaneForge`,
  `taskdriver.ai`, `clients`, and a name that is already the project.
- Update `scripts/title-demo.mjs` so its printed table shows the new answers - Robert reads
  that output.
- `npm run typecheck`, `npm run test:clientname` (or whatever the suite name is in
  package.json for client-name-test.mjs), `npm run test:place` must pass.
- Do NOT touch: src/shared/tour.ts, src/main/tour.ts, src/renderer/src/components/TourCard.tsx,
  src/shared/surface.ts, src/renderer/src/App.tsx, scripts/test-all.mjs, package.json -
  another agent is editing those right now. If you need a new suite, say so in your report
  instead of editing those two files.
- Commit on master, subject a sentence about behaviour, ending with:
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017v5QbYLvT75ydjv1NJuWxb
- Budget about 70 tool calls, one verification pass at the end.

## ...and a rename needs more than one ask

Robert, 2026-09-04, minutes later: "it renamed way too early / too confident, now this
session is called name like `Cars` which is wrong because we only said 1 prompt, needs
multiple at least to get enough info for a rename".

That session is a PaneForge chat. The word `Cars` appeared ONCE, inside a sentence about
naming rules - and the card took it. One mention of a word that happens to match a client
alias is not evidence about what a pane is for.

- **A pane that already wears a name may only be renamed by AGREEMENT**: the same subject
  reached by `repeatedTopic` across at least three asks, which is the reading
  `mayTopicName` / `repeatedTopic` already implement for a real repo. Extend that bar to
  the client-alias path: a client name lifted from PROMPT TEXT (`clientOf` on the words,
  not the folder) needs the same three agreeing asks.
- **The folder still outranks it.** A pane inside `clients/<who>/` is named from the ROSTER
  on sight - that is a fact about where it is running, not a guess about what was typed,
  and it keeps naming on the first ask exactly as today.
- The first ask may still name a pane that has NO name yet in a folder that names no
  project (`Desktop`, `Downloads`, the projects root) - that is today's behaviour and is
  not what he is complaining about.
- Add the exact case as a test: three asks in a PaneForge checkout where only ONE contains
  a client alias must leave the card called `PaneForge`.
