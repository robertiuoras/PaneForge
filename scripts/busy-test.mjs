// Test for "the turn clock stopped ticking mid-turn".
//
// Measured, not guessed. A test copy was driven through a real Claude Code turn over
// CDP (scripts/probe.mjs) and the bottom of the frame was sampled every five seconds.
// Claude Code 2.1.220 never prints "esc to interrupt" any more - its working line is
// "✢ Smooshing… (8s · ↓ 282 tokens)". The old footer regex matched none of it, so no
// pane ever reported busy: 33 of 33 raises in attention-audit.log say sawFooter:false,
// the run clock stopped 4s after the last frame (IDLE_AFTER_MS), and the sidebar sat on
// a frozen "last turn" number while the agent was still working.
//
// Every frame below is a verbatim capture. Add one whenever a CLI changes its footer.
//
//   node scripts/busy-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-busy-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'busy.bundle.cjs')
// esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
// Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/busy.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { readsBusy, readsElapsedMs, anchoredStart, busyReason, composerHeld } = createRequire(import.meta.url)(out)

/** The statusline and input box that sit BELOW the working line on this machine. */
const CHROME = [
  '────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────',
  '  [CAVEMAN] ◆ Opus 5 (1M context) | claude-orchestrator-c |  lane-c | ⟳ 68↑ | ░░░░░░░░░░ 0% | +0/-0',
  '  5h 48% · wk 69% · Fable 10%',
  '  ⏵⏵ bypass permissions on · 1 shell · ← for agents'
].join('\n')

/**
 * Antigravity's chrome BELOW its working line: a rule, the composer, a rule and its
 * model row. Deliberately without the `esc to cancel` status row - that row is what
 * used to carry these frames, and it is not painted on every one of them.
 */
const AGY = [
  '────────────────────────────────────────────────────────────',
  '>',
  '────────────────────────────────────────────────────────────',
  '                                                    Gemini 3.7 Flash · high'
].join('\n')

/** The right-hand end of grok's working line: its own clock, tokens and stop hint. */
const GROK_TAIL = '                    3.9s ⇣7.72k [stop]'

/** Grok's idle frame, key hints included - `Esc:cancel` is on screen permanently. */
const GROK = [
  '  ╭──────────────────────────────────────────────────────────╮',
  '  │ ❯                                                        │',
  '  ╰────────────────────────────────── Grok 4.6 (high) ───────╯',
  '  Shift+Tab:mode  │  Esc:cancel  │  Ctrl+x:shortcuts'
].join('\n')

const cases = [
  // Torn repaints, off THIS desk's own log on 2026-08-26 (pane `pizzasrus`, 159 cols).
  // Claude Code writes its footer a character at a time with absolute cursor moves - the
  // spinner glyph, then the gerund's letters one by one, then the ellipsis, then the
  // counter - so the screen between those writes is a frame no reader can call busy. These
  // read FALSE on purpose, and they are here to say why TerminalPane's `offSince` debounce
  // exists: main treats one reported `false` as the turn boundary, so a torn frame reported
  // straight through would drop a working pane into "Your move" mid-turn.
  // These read FALSE, and the renderer's own `offSince` debounce (TerminalPane, 1200ms) is
  // what stops one of them being reported as the end of a turn.
  ['a footer caught mid-repaint, no ellipsis yet', '✽ Bootstrappin\n' + CHROME, false],
  ['...and the spinner alone, before the word', '✽\n' + CHROME, false],
  ['...and the settled frame those two become', '✽ Bootstrapping… (1m 18s · ↓ 3.7k tokens)\n' + CHROME, true],
  // Claude Code 2.1.220, mid-turn. Both shapes were on screen during the same turn.
  ['claude 2.1 spinner with counter', '✢ Smooshing… (8s · ↓ 282 tokens)\n' + CHROME, true],
  ['claude 2.1 spinner, no counter yet', '✶ Cultivating…\n' + CHROME, true],
  ['claude 2.1 spinner under tool output', '● Bash(sleep 25; echo done)\n⎿  Running in the background (↓ to manage)\n✻ Herding…\n' + CHROME, true],
  // Captured 2026-08-01 from claude 2.1.220 in a real pty, while the Stop hooks ran.
  // The glyph is an ASCII asterisk (U+002A), which SPINNING refuses on purpose, and
  // the duration is no longer the first segment in the bracket. This frame read as
  // FINISHED for as long as the hooks took, which cut the turn clock in half.
  [
    'claude 2.1 running a stop hook',
    '* Considering… (running stop hooks… 0/4 · 52s · ↓ 5.2k tokens)\n' + CHROME,
    true
  ],
  // Same capture, the first repaint of the turn: no glyph and no counter yet.
  ['claude 2.1 bare gerund', 'Considering…\n' + CHROME, true],
  // Older Claude Code and Codex, which still say how to stop themselves.
  ['legacy esc-to-interrupt', '✻ Thinking… (esc to interrupt)\n' + CHROME, true],
  ['codex footer', 'Esc to interrupt · 12s\n' + CHROME, true],
  // The same line in the past tense is how Claude Code reports a turn that ENDED.
  ['finished turn summary', '✻ Sautéed for 10s · 1 shell still running\n' + CHROME, false],
  ['idle pane', '▝▜█████▛▘  Opus 5 (1M context) with high effort · Claude Max\n' + CHROME, false],
  // A markdown list in an answer sits in exactly these rows.
  ['bullet list in an answer', '* one of the things we tried…\n- and another…\n' + CHROME, false],
  // A duration in brackets is only a run counter when it sits in a `·`-separated
  // footer group. An answer or a tool summary quoting one is a finished thing.
  ['duration quoted in prose', 'The whole run took (2m 14s) end to end.\n' + CHROME, false],
  // A question outranks a spinner: the CLI is mid-turn but nothing moves until you answer.
  ['permission prompt over a spinner', '✢ Smooshing… (8s · ↓ 282 tokens)\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n', false],

  // ---- Antigravity CLI (`agy`), captured off this desk's own pane log on 2026-08-26
  // (userData/history/s5-mta1hyqm.log, replayed through a real xterm). Its spinner is
  // an EIGHT-dot braille glyph and its ellipsis is three ASCII periods, so the old
  // SPINNING - a six-glyph list plus U+2026 - matched none of it. Measured over that
  // log: 94 of 171 spinner frames read as NOT busy, and the 77 that did got there only
  // through the `esc to cancel` status row, which is not painted on every frame. So a
  // running antigravity pane flickered out of Running and mostly sat in Your move.
  ['antigravity working', '⣯  Working...\n' + AGY, true],
  ['antigravity generating', '⣷  Generating...\n' + AGY, true],
  ['antigravity running a command', '⣽  Running command...\n' + AGY, true],
  ['antigravity waiting', '⣟  Waiting...\n' + AGY, true],
  ['antigravity background task execution', '[02:11:07] vercel inspect --wait https://taskdriver-qt6yyf90e-robertiuoras-projects.vercel.app running\n' + AGY, true],
  // Torn repaints: it draws the word a character at a time, same as Claude Code.
  ['antigravity mid-repaint, no dots yet', '⣟  Workin\n' + AGY, false],
  ['antigravity mid-repaint, one dot', '⡿  Working.\n' + AGY, false],
  // Its own idle frame, and the line it prints when a turn ENDS.
  ['antigravity idle', '  Press up to edit queued messages\n' + AGY, false],
  ['antigravity finished thought', '▸ Thought for 2s, 269 tokens\n' + AGY, false],
  // A question outranks the spinner here too - this frame carries both.
  [
    'antigravity permission prompt',
    '⣯  Running command...\nDo you want to proceed?\n> 1. Yes\n  4. No\nesc to cancel',
    false
  ],

  // ---- Grok CLI, captured 2026-08-26 by driving a real `grok` pty for 25s
  // (18 of 25 sampled seconds read busy; the first 7 were before it answered).
  ['grok waiting for response', '⠴ Waiting for response… 3.9s' + GROK_TAIL + '\n' + GROK, true],
  ['grok thinking', '⠋ Thinking… 0.4s' + GROK_TAIL + '\n' + GROK, true],
  ['grok responding', '⠙ Responding… 2.1s' + GROK_TAIL + '\n' + GROK, true],
  // The load-bearing negative: grok's key hints are on screen at ALL times, and
  // `Esc:cancel` must not be read as the `esc to cancel` an agent prints while running.
  ['grok idle', GROK, false]
]

let bad = 0
for (const [name, frame, want] of cases) {
  const got = readsBusy(frame)
  if (got !== want) {
    bad++
    console.error(`FAIL ${name}: readsBusy = ${got}, expected ${want}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

// The agent prints how long IT thinks the turn has been running, and that number is
// the one Robert compares against. PaneForge's own clock is a guess at when the turn
// started - a turn boundary the app read wrong, a pane opened mid-turn, or a session
// restored from disk all leave it low, which is how a 24 minute turn showed as 12.
// Claude Code's formatter is `8s` / `24m 3s` / `24m` / `1h 2m 3s` / `1h 2m` / `1h`.
const S = 1000
const M = 60 * S
const H = 60 * M
const clocks = [
  ['codex raw footer', 'Esc to interrupt · 12s\n' + CHROME, 12 * S],
  [
    'codex footer wins below a quoted duration',
    'Previous step took (2m 14s)\nEsc to interrupt · 12s\n' + CHROME,
    12 * S
  ],
  [
    'codex footer wins above a quoted duration',
    'Esc to interrupt · 12s\nQueued note (2m)\n' + CHROME,
    12 * S
  ],
  ['seconds only', '✢ Smooshing… (8s · ↓ 282 tokens)\n' + CHROME, 8 * S],
  ['minutes and seconds', '✢ Smooshing… (24m 3s · ↓ 282 tokens)\n' + CHROME, 24 * M + 3 * S],
  // The duration is not the first segment when a hook is running - read past it.
  [
    'counter behind a hook progress segment',
    '* Considering… (running stop hooks… 0/4 · 52s · ↓ 5.2k tokens)\n' + CHROME,
    52 * S
  ],
  ['whole minutes', '✻ Herding… (24m · ↑ 1.2k tokens)\n' + CHROME, 24 * M],
  ['hours', '✻ Herding… (1h 2m 3s · ↓ 91 tokens)\n' + CHROME, H + 2 * M + 3 * S],
  ['legacy interrupt hint carries it', '✻ Thinking… (esc to interrupt · 2m 14s)\n' + CHROME, 2 * M + 14 * S],
  // Everything that must NOT be mistaken for a turn clock.
  ['no counter yet', '✶ Cultivating…\n' + CHROME, null],
  ['statusline percentages', '✶ Cultivating…\n' + CHROME.replace('5h 48%', '5h 48% (wk 69%)'), null],
  ['model name in parens', '✶ Cultivating…\n' + CHROME, null],
  ['finished turn summary', '✻ Sautéed for 10s · 1 shell still running\n' + CHROME, null]
]
for (const [name, frame, want] of clocks) {
  const got = readsElapsedMs(frame)
  if (got !== want) {
    bad++
    console.error(`FAIL clock ${name}: readsElapsedMs = ${got}, expected ${want}`)
  } else {
    console.log(`ok   clock ${name}`)
  }
}

// The precision the reading was printed at, so the run clock only re-anchors when the
// gap is bigger than the rounding the CLI itself did.
const grains = [
  ['seconds', '✢ Smooshing… (8s · ↓ 282 tokens)', S],
  ['minutes and seconds', '✢ Smooshing… (24m 3s · ↓ 2 tokens)', S],
  ['whole minutes', '✻ Herding… (24m · ↑ 2 tokens)', M],
  ['whole hours', '✻ Herding… (1h · ↑ 2 tokens)', H]
]
for (const [name, frame, want] of grains) {
  const got = readsElapsedMs(frame, true)?.grain
  if (got !== want) {
    bad++
    console.error(`FAIL grain ${name}: ${got}, expected ${want}`)
  } else {
    console.log(`ok   grain ${name}`)
  }
}

// The bug itself, reproduced: a turn Claude Code had been running for 24 minutes read
// as 12 in the sidebar, because the app started its own clock over halfway through -
// which is what any missed turn boundary does, silently and for the rest of the turn.
const NOW = 1_700_000_000_000
const anchors = [
  [
    'a Codex clock restarted 5m late is pulled back to the agent',
    NOW - 12 * S,
    readsElapsedMs('Esc to interrupt · 5m 12s', true),
    NOW - (5 * M + 12 * S)
  ],
  [
    'a clock started 12m late is pulled back to the agent',
    NOW - 12 * M,
    readsElapsedMs('✻ Herding… (24m 3s · ↓ 91 tokens)', true),
    NOW - (24 * M + 3 * S)
  ],
  [
    'a clock left running from a turn that ended is pulled forward',
    NOW - 40 * M,
    readsElapsedMs('✢ Smooshing… (8s · ↓ 282 tokens)', true),
    NOW - 8 * S
  ],
  // Most ticks: already right, so the readout must not twitch.
  ['agreement leaves it alone', NOW - 24 * M, readsElapsedMs('✻ Herding… (24m 1s · ↑ 2 tokens)', true), null],
  // "24m" could be anything up to 24m59s; correcting inside that would walk the number
  // backwards every minute.
  ['a coarse reading does not fight its own rounding', NOW - (24 * M + 40 * S), readsElapsedMs('✻ Herding… (24m · ↑ 2 tokens)', true), null]
]
for (const [name, runSince, clock, want] of anchors) {
  const got = anchoredStart(NOW, runSince, clock)
  if (got !== want) {
    bad++
    console.error(`FAIL anchor ${name}: ${got}, expected ${want}`)
  } else {
    console.log(`ok   anchor ${name}`)
  }
}

// WHICH rule read the frame, and the one that must never be trusted on its own.
//
// Claude Code's finished line keeps the turn's number - "✻ Baked for 7m 57s · done
// 3:08 PM" - and the app used to take a bare duration as evidence of a running agent.
// That is not merely a green dot: `anchoredStart` re-anchors the run clock to the
// number it just read, so a pane that had gone quiet started a phantom turn already
// 7m57s old and counted on from there. Measured on this desk 2026-08-26:
// attention-audit.log has PaneForge stalled at quietMs 1507149 with busyOnScreen:true
// and runMs 476436 - 7m 56s - over exactly that frame.
const reasons = [
  ['✢ Smooshing… (8s · ↓ 282 tokens)', 'spin'],
  ['some output\n  ⎿  Running…\n(esc to interrupt)', 'interrupt'],
  ['Considering…', 'gerund'],
  ['✻ Baked for 7m 57s · done 3:08 PM', null],
  ['✻ Sautéed for 10s · 1 shell still running', null]
]
for (const [frame, want] of reasons) {
  const got = busyReason(frame)
  if (got !== want) {
    bad++
    console.error(`FAIL reason ${JSON.stringify(frame.slice(0, 40))}: ${got}, expected ${want}`)
  } else console.log(`ok   reason ${JSON.stringify(frame.slice(0, 40))} -> ${got}`)
}

// The pane must CONFIRM a counter-only `true` the way it confirms a `false`. Source
// assertion because the timing lives in a React effect a node test cannot mount, and a
// green rules test over a pane that reports the first frame it sees proves nothing.
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
for (const [needle, why] of [
  ["reason === 'counter'", 'the counter-only reading is singled out'],
  ['settle2 = window.setTimeout(checkBusy, BUSY_SETTLE_MS', 'the confirming tick is ARMED, not left to output that never comes']
]) {
  if (!pane.includes(needle)) {
    bad++
    console.error(`FAIL source: ${why} (${needle})`)
  } else console.log(`ok   source ${why}`)
}

const total = cases.length + reasons.length + 2 + clocks.length + grains.length + anchors.length
if (bad) {
  console.error(`\n${bad} of ${total} frames read wrong. A pane that cannot see its`)
  console.error('agent working freezes the turn clock and rings the bell mid-turn.')
  process.exit(1)
}
// Remote Control re-bridging after /clear: the composer is up, nothing runs, and a
// return goes nowhere. Real footer from s14-mtm9ecfi, 2026-09-04.
const rc = '❯ \n───────\n⏵⏵ bypass permissions on (shift+tab to cycle) · ⏎ for agents\n/rc connecting…'
if (readsBusy(rc)) { console.error('rc connecting must not read as busy'); process.exit(1) }
if (!composerHeld(rc)) { console.error('rc connecting must hold the composer'); process.exit(1) }
if (composerHeld('❯ \n5h 42% · wk 38% · Fable 41%/rc\n⏵⏵ bypass permissions on')) { console.error('a connected /rc badge is not a hold'); process.exit(1) }
console.log('composer hold: 3 ok')
console.log(`\nall ${total} frames read correctly`)
