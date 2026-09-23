# Question cards, auto-answer, providers/models, forged prompts

Verbatim sections moved out of the repo's always-loaded instructions (`AGENTS.md`),
same headings as `docs/design-notes.md` (the why). Paths: `shared/` = `src/shared/`, `main/` =
`src/main/`. `test:x` = `npm run test:x`.

## One long ask is several panes

`shared/splitPlan.ts`, `main/splitPrompt.ts`, `SplitDialog.tsx`; `test:splitplan`. One headless
CLI run (`HEADLESS` only), EMPTY folder under userData, `--setting-sources ""`,
`--strict-mcp-config`, `--settings '{"hooks":{},"outputStyle":"default"}'` (`--settings` alone
MERGES; `--bare` = `Not logged in`). Not a plan = `null`, quotes 160 chars; every `{` tried.
`MAX_TASKS` 4, overflow in `dropped`. Nothing opens until rows edited.

## A long rough prompt is shown back as a brief before it is sent

`shared/promptExpand.ts`, `main/promptExpand.ts`, `ExpandCard.tsx`, `TerminalPane.tsx`
`holdForExpand`; `test:promptexpand`, replay `scripts/promptexpand-replay.mjs <out.md>` (real
haiku calls; `--dry-run` none). Gate = promptlab's own numbers (`scopeOf` mirrors `score.mjs`,
parity over the corpus): `shouldExpand` = 60+ words, or 25+ with 3+ items; never `/` `!` `#`.
Held Enter only: keyboard, agent pane, certain draft, no paste/question/sleep/sync, NOT a mirror
(`@device/id`), not a `\`-Enter (new line), not the text a card was just put away on (Esc then
Enter = send as typed); a question arriving under the card takes the key. Model run budget =
`EXPAND_WAIT_MS`; runner errors never carry `err.message` (Node's holds the whole argv). Starts early on a 1500 ms typing pause; main shares a run per text, kills a
superseded one, caches 10 min. Model: `expandArgs` - Claude Code only (never the desk's default
agent), haiku, rules as `--system-prompt`
(the ask is DATA: in the user message an imperative ask hijacked it), `--tools ''` LAST (list
flag swallows what follows; agents run with bypass). Paid-key env vars deleted. Where = code
search (`.codegraph` + `code-map.mjs where`, else `git ls-files`), never the model. Send full
brief = `replaceDraft` (MAIN writes the wipe and resets `typed`/`draft`: `typeLine` ignores
Ctrl-U, a renderer wipe left the brief queued behind nobody). Error / `EXPAND_WAIT_MS` = the
held Enter goes as typed + one toast. `prompt-expand.log`: per run ms/ok, per card the choice;
never prompt text. `config.promptExpand` (on).

## A pane can run on somebody else's model

`shared/agents.ts` (`test:agentenv`): `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` only; base
URL NO `/v1` (OpenRouter `https://openrouter.ai/api`). Provider = `KEY_PROVIDERS` + `env`
naming `keyVar(id)`. Probed: DeepSeek/Z.ai 401 in Anthropic shape; xAI no; Grok own CLI
(`~/.grok/bin`, `which.ts`). `siblingModels` under PROVIDER, SAVED key, same `bin`;
`config:set` clears 20s cache; blank key drops token (`missingKeyFor`). `HEADLESS` by id; Grok
absent, `drivable()` refuses. Gemini CLI removed (`GEMINI_DEFAULT_AUTH_TYPE: oauth-personal`
in `~/.gemini/settings.json` dead). Antigravity `agy` (`~/.local/bin` /
`%LOCALAPPDATA%\agy\bin`; `--continue`/`--conversation <id>`; `/model` in TUI; no `uninstall`)
asks `Yes, I trust this folder` unless in `trustedWorkspaces` of
`~/.gemini/antigravity-cli/settings.json`: `main/agyTrust.ts` writes it pre-spawn,
`shared/agyTrust.ts` refusals write nothing (`test:agytrust`).

## ...and the model list is not this build's opinion of what exists

`main/orModels.ts` keeps OpenRouter's list on disk beside `OPENROUTER_MODELS`;
`shared/orCatalogue.ts` (`test:orcatalogue`). `listAgents` sync from MEMORY, fetch via `void`;
any failure leaves the app as is; empty = FAILED. Tool-calling only; both prices; free first;
`Select` searches VALUE (`labelFor`); newest first; stealth says so. Model addressed via the
CLI's own `env`.

## An agent's question is a row of buttons

`shared/choices.ts`; card RIGHT 260px (full width coarse); `test:askrender`. Needs `Enter to
select` footer, options 1..N, one arrow row. Multi-question end: no footer, `REVIEW` above,
`readReview` DOWN. Refusals: one `❯` over blanks/rules, `don't ask again` (`WIDENS`); RULE =
blank. Arrows + return never digit, `CHOOSE_GAP_MS`; left question REFUSES. `pty:choose` on
the SESSION. RED: `.row.asking`; stop/waiting sounds only with `soundOnIdle` (OFF,
`quietIdleSounds` moved saved `true` once, `test:sounds`);
Questions: desk + GuardDeck, NEVER Telegram; `askNotify.ts` = stopping ERRORS
(`telegramAsk`). Click types NOTHING (`askRef`; `test:askclick`, `test:choices`).

## Arrowing through a question may not cost the whole desk

One sessions array; `TerminalPane` `memo` + `samePaneProps` (`ask`, `termTheme`, `mirror`,
`grid` BY VALUE). Assertion = BYSTANDER count (`test:askrender`, `window.__pfRenders`). New
`Props` need a `samePaneProps` line.

## ...and a pane that is only PRINTING may not talk to React at all

Same-value `setState` still costs `requestUpdateLane`. `useQuietState`
(`renderer/src/quietState.ts`) compares in a ref before dispatch; `geom`, `selChip`,
`scrolledUp`. Source test `test:quietstate`; `npm run type-profile -- --blame yi`;
`window.__pfDeskRenders`.

## ...and a question with an obvious answer is answered

`shared/autoAnswer.ts`, on, 30s (`test:autoanswer`). BEST: `(recommended)`/`[default]`/`-
suggested` > yes-shaped/arrow; two marked = choice; never past a refusal. Refusals: exactly
ONE yes-shaped, arrow on REFUSED, `don't ask again`/`always`/self-questioning; `anyQuestion`
wider. AWAY wait: `holdWhileWatching` `askHold`, `startOf` = later of it and `askSince`; held
= no countdown (`autoAnswerHeld`); `useNow(1000, at)`. `dueForAuto` two signatures
(`askKeyOf`); one press/identity, `PRESS_COOLDOWN_MS` 4s; `maxRun` clears on BUSY; hold sets
`autoAnswerAt = 0`. Countdown row/chip, `playTick`, `.auto`, `window.__pfTicks`; `defaultsV2`
+ `migrateAutoAnswer` once.

## Every prompt this app writes says what done means

`src/shared/promptForge.ts`: task, anchors, scope, done, exemplars; `Done means:` LAST; over
`MAX_PROMPT_CHARS` 6000 drop examples, guidance, tail, never done. Exemplars from
`claude-config/promptlib` (`main/promptForge.ts`, `PF_PROMPTLIB`), `MAX_EXAMPLES` 2 x
`EXAMPLE_CHARS` 600. Users `splitInstruction` (`SPLIT_BUDGET_CHARS` 40,000), `paneBrief`
(idempotent), `resumeBrief` (`noResume` forges nothing). `claude-config/promptlib/harvest.mjs`
(`MIN_FIELDS` 3, no `no_anchor`/`multi_item`). `docs/prompt-review-2026-09-02.md`. `test:promptforge`.

## A pane opened on a task is briefed from the task

`pf open <cwd> --task <id>`: `shared/taskBrief.ts`, `main/backlogStore.ts` reads
`claude-config/ledger/backlog.jsonl` (`PF_BACKLOG`) READ ONLY (`test:taskbrief`). `Done
means:` = `success` + gates; attempts/last refusal carried. No pane on
unknown/ambiguous/finished/no title/no backlog/`--task`+`--prompt`.

## ...and the app counts how often a person had to step in

`shared/interventions.ts`, `main/interventions.ts` -> `Session.interventions`,
`interventions.log`, one `SessionInfo.tsx` line (`test:interventions`). `app` writes never
count (`choose()` -> `write()`, auto-answer `'app'`); unsent typing is nothing.
`docs/agentic-backlog-2026-09-02.md`.
