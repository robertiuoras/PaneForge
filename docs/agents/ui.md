# UI: theme, names, clocks, lists, find, copy, cursor, cards

Verbatim sections moved out of the repo's always-loaded instructions (`AGENTS.md`),
same headings as `docs/design-notes.md` (the why). Paths: `shared/` = `src/shared/`, `main/` =
`src/main/`. `test:x` = `npm run test:x`.

## Every colour is derived, and every pane says which project it is in

`src/shared/theme.ts` from one accent, `applyTheme` -> `:root`, `paletteFor` only; Oklab,
`inGamut`; light >~0.9, Paper 0.98; default `#f0a868`. `test:theme` 4.5:1/3:1.
`test:contrast` proves the RENDERED window both themes (SAMPLED backdrop, TEXT NODE boxes,
worst pixel minus 5%, pet hidden, animation killed, 3:1 vs `--muted`, LOGOTYPE exempt,
`readableOn`). `var()` on a missing token never errors: `test:tokens` (only `--agent`,
`--level`, `--mono` absent).

`src/shared/place.ts` (`test:place`): project name never omitted; trunk -> `PaneForge`;
generated branch (`pf/w2`, `lane-a`, `worktree-<slug>`) dropped; `copy 2` = second checkout,
`pane 3` = third card (Ctrl+3); `-a` stripped only when lane known; no `git status`.

## A pane says which client it is working for

`shared/clientName.ts`, `main/clients.ts`; `test:clientname`. Roster =
`clients/<who>/README.md` walking UP; first heading, contact stripped; parenthetical kept
only for a person, not an org; `Client` off. Prompt name matches ONE client, word boundary,
`MIN_ALIAS`, not `GENERIC`. Replace only on STRONG reading (`topicReading`, `repeatedTopic`);
`/clear` empties `topicAsks`. Others get `topicTitle` where `mayTopicName` (client tree,
`Desktop`/`Downloads`/root); real repo waits three agreeing asks, EARLIEST names. Rename is
SILENT: no card, Activity row only (`test:activity`). Pointing ask (`$50 task`) named off the REPLY
(`shared/resolvedName.ts` `handleOf`/`resolvedName`, `sweepResolved` once, app-given names
only; `The agent found what you meant.`; `test:resolvedname`).

## A pane says how long it has been open

Header clock = TURN; `.pt-open` = `openedAt ?? createdAt` (off on phone); History freezes at
`endedAt`. `stepFor` (`src/shared/elapsed.ts`) 1s/<1h, 60s, `Infinity`; one interval; buckets
from the clock's OWN start; not in `Elapsed.tsx`; `formatElapsed` carries days. `test:elapsed`.

## The sessions list is the whole desk, both machines

Your move / Running / Ready / Ended (`shared/fleet.ts`), Ctrl+Shift+F dragged order;
`shared/desk.ts`; `test:desk`. Listing (`remote:changed`) vs mirroring; `openListed`. Listed
row has no NUMBER; real panes all wear one (`.num.far`); grid fits 440x240 tiles
(`gridRoom`/`gridPick`: needs-you first, asleep last, active always), counts the rest. Mirror
listed once; device off/connecting/error = nothing; badge counts both. `Running` = `runSince`
(submit, busy footer, shell command) until `endRun`, or `FleetPane.backJob`; never `status ===
'working'`. `Ready` ≠ `!engaged` (`/clear` drops it; `/compact`/`/resume` don't). Empty Return
engages nothing (`slashTurn.isBareReturn`, `test:slash`). Shell turn ends with its COMMAND,
POSIX. `doneGlow` once (`DONE_GLOW_MS` 1.9s).

## A prompt tag says how long ago it was asked

Rail tip `echo rail  (5 min ago)`, hover-HOLD exact; `whenWords`. Minute clock; no tags =
`Infinity`; offset = NEWEST; `railNow` on bucket turnover; negative = date; `Math.max(railNow,
m.at)`. Restored tag: no clock. Prompts list keeps position. Codex seeding: `›` on
indexed-235, wrapped joined, composer/quotes excluded. Remote history: `replay` (<=4 MiB) then
deltas, both peers; 400 KB buffer fast path; `paneLog` alone never resets. Typed events wait
for output parse; no duplicate to submitter.

## Finding something in a pane

Ctrl/Cmd+F, ⌕, phone `Find in this pane` -> `paneFind`; `3/10`, ↑ ↓, Enter/Shift-Enter; live
buffer only.

## Finding a setting

Finds the SETTING (rows tinted, best edged, rail follows); switch stays in its group. Index
generated (`scripts/settings-index.mjs` -> `src/shared/settingsIndex.ts`, `npm run
gen:settings`; `test:settingsearch`). Hint matches, LABEL outranks; DOM marking;
`scrollIntoView` `nearest`; no animation.

## A card answers a right-click, and can say what it is

`SessionMenu.tsx` desktop menu (pointer, clamped, arrows, Escape); `PaneMenu.tsx` phone sheet
52px. `SessionInfo.tsx` `Open for` from `createdAt` (`useNow`); header stays TURN; polls
nothing. Right-click never wakes (`e.button !== 2` into `touchPane`; `test:autohandoff`).

## Copying a prompt, or the answer it got

Header button beside ⌕: `Last reply`/`Last prompt`/`Last prompt + reply`/`Everything on
screen` with previews; rail-tag right-click = same for THAT turn + `Go to it`. `CopyMenu.tsx`,
`.copy-menu` per `design-vault/linear.app.md`. `shared/replyText.ts` `cleanReply` drops chrome
(`⏺`/`⎿` keep text); real-log fixtures (`test:replytext`). Reply = `rowsOf` + `unwrapCopy`;
left-margin text = paragraphs. Ctrl/Cmd+Shift+C `copyReply` highlight first; `Copy last
reply` on phone/right-click. Every copy toasts a line count (`sayCopied`); select silent.

## A click puts the cursor where you clicked

Click -> arrows to the same cell only (`src/shared/cursorMove.ts`); shell up-arrow is history.
`keysAlongLine` left/right, own line, mouseup, no travel. `composerAt` (`shared/promptBox.ts`):
rule above, SAME-width rule below, marker + U+00A0 (`BLANKS`); `test:promptbox`; only a drawn
box allows up/down. `keysForDelete` one backspace/char, wrapped rows. Swallowed only toward an
AGENT with mouse reporting (`test:stickyselect`). Alt-click other lines, `rowLimit`, clamped.

## A picture goes in front of the agent

Image off DISK on the pty's machine, path typed (`shared/attach.ts`, `main/attach.ts`,
`test:attach`). ^V raw only same-machine; `@device/id`/browser send bytes; `attachOn`. Name =
clean basename, ext from MAGIC BYTES; 5MB/batch; never auto-submitted. macOS drop
`text/uri-list` (`splitDropUris`; `text/plain` unclaimed). Uncovered: phone paste.

## History says what each session was working on

Row = FIRST ask + count (`shared/gist.ts`, `test:gist`) from relayed keystrokes. Newest closed
top (`endedAt ?? startedAt`); `closed 5 min ago`/date; green `open since`, red `closed …`.
`View all` = `summaryFull`. Closed before recording = archive line or none. `/clear` ends a
job (`noteAskInto`); three shown, WORK asks counted, twelve chapters; `recordStart` reruns.
Transcript RENDERED (`renderer/src/termRender.ts`).

## The app remembers what has been asked

`src/main/promptArchive.ts` fed from `shared/draft.ts`. Chip only; `QUIET_MS` 6h is the rule;
submitted lines only. `src/shared/promptKey.ts` MIRRORS three copies (claude-memory hook,
TaskDriver, Discord bot); `test:recall` recomputes canonical answers. `outcome` null.

## Dictation needs nothing installed

Mic per pane, Ctrl/Cmd Shift Space. `shared/voicePick.ts`; `useVoice.ts`: whisper CLI ->
Whisper worker (`voiceWorker.ts`, ONNX wasm) -> phone recogniser (`test:voice`).
`webkitSpeechRecognition` in Electron = `error: "network"`; `bnb4`; wasm via
`electron.vite.config.ts`. Phone `VoiceOverlay.tsx`, ring = level.

## ...and a card nobody touched goes away by itself

`shared/cardIdle.ts` `CARD_IDLE_MS` 5 min, `renderer/src/idleDismiss.ts`; pointer/focus HOLDS
(`idleLeft` `null`); one timeout. Only `WhatsNewCard`; `MoveSoon`, `OffloadSoon`,
`AutoClearToast`, `StopServer`, `LoginCard`, `UpdateToast`, `TourCard` end at their own
deadline. `test:cardidle`.

## Every card the app puts in the corner is in ONE column

`.corner-stack` (`App.tsx`/`styles.css`, `test:activity`): `column-reverse`, FIRST = corner;
AutoClear, MoveSoon, Update, WhatsNew, Tips; children `position: static`;
`.beside-pet` lifts 108px once; `pointer-events: none`, `max-height`.

## ...and what it did on its own is a list, not just a card that vanished

Bell -> `ActivityFlyout.tsx`; `shared/activity.ts`, `main/activity.ts` `activity.json`. Fed by
`reclaim:log`, `clientNamed`, `armclear`; `armed` not a row; verb column `KIND_WORDS`; a
READING, nothing pressable; opening marks seen. `activity:list`/`seen` `REVIEWED_SAFE`
(`scripts/passkey-test.mjs`).

## ...and one card says what this app can even do

`shared/tips.ts`, `components/Tips.tsx`, `test:tips`. Silent during dialog/update/question/
minimised/`FIRST_MS` 4 min; `EVERY_MS` 40 min; first and every fourth `offersOff` (Settings
re-enables); each once before any twice; `seen` resets.
