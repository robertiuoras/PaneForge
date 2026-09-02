# Rework for a public user - 2026-09-03

Robert's ask (verbatim, phone): "my goal is for public user to use paneforge for their own
development work but theres a lot of issues with optimisation, too much custom to me? if you
can figure out how to keep custom for me but still enable public to use? ... [Devices] this
whole things needs rework way to complicated for any user, too hard to figure out how to
connect, step by step would be nicer, too much random stuff that might not be needed? ...
you need a full rework of worktrees/lanes since i know they help but not everyone uses them
so how could we inform them or teach and can it work for anyone or is it like a custom setup.
way too much clutter in settings? ... more minimalist only keep whats necessary?"

## The one rule that keeps it custom for Robert and plain for everyone else

**Nothing in the app is Robert-specific; it is prerequisite-specific.** A feature is drawn
only once the FACT it needs exists on this machine, and the facts are read, never asked:

| feature | fact that reveals it | where Robert's version lives |
|---|---|---|
| Devices, handoff, offload, `Hand off all` | a paired device (`config.remote.peers` non-empty) | pairing his PC, once |
| Copies of a project (lanes) | a second chat opened on the same repo, or `.lanes.json` in it | `.lanes.json` per repo, lane hook in claude-memory |
| Telegram cards (ask, faults) | `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` | his env |
| Discord presence | Discord running + `discord.enabled` | his config |
| Client naming | a `clients/<who>/README.md` tree | his clients repo |
| Autoclear / handoff steps | `claude-config/autoclear.mjs` present | claude-memory |

A fresh install with none of those facts shows: panes, sidebar, History, Settings with
five tabs, and a Devices page that is ONE button ("Connect a phone or another computer").
No lane words, no PC words, no Telegram words, no "copy 6". Robert's machines have every
fact, so they lose nothing.

The custom half stays where it already is - claude-memory hooks, `.lanes.json`, env vars,
config.json - and the app reads it. Nothing moves INTO the app to make it his.

## Workstreams (one pane each, one lane each)

1. `devices.md` - Devices page as a step-by-step connect; mock first.
2. `settings.md` - Settings: fewer tabs, shorter hints, prerequisite-gated rows.
3. `lanes.md` - Copies of a project: default pool 3 not 8, explain once, plain numbers,
   holds that expire on the fact.
4. `idle-cost.md` - measure what the app costs when nothing is happening; cut nothing.

Every workstream: `npm run typecheck`, `npm test`, the suite named in its brief, and the
plain-words test `npm run test:laneplain` (no machinery word reaches the screen). No
release - commit, `lane.mjs ready`, report numbers, stop.

## What is NOT in scope (and why)

- A "public mode" switch. A switch is a thing to explain; a fact is not.
- Removing lanes. They are the reason two chats can work on one repo; the ask is that
  nobody who runs one chat per repo ever meets them.
- Performance work inside the CLI. 190 MB per Claude pane is the CLI's, not ours;
  measured 2026-09-02 the app was 2.9% of a lagging desk. Workstream 4 measures the app's
  OWN idle cost before anybody optimises a number that has not been read.
