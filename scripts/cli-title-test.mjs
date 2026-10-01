// What a pane is called when the name comes from the agent's own title for the chat.
//
// Every title below is a REAL one, read off Claude Code transcripts on the Mac and the PC
// on 2026-09-28 (`"type":"ai-title"` records), with the folder the pane was in.
//
//   node scripts/cli-title-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-cli-title-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'cliTitle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/cliTitle.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { titlesIn, cardTitle, nextTitle } = createRequire(import.meta.url)(out)
const chainOut = join(work, 'cliChain.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/cliChain.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: chainOut
})
const { earlierTitles } = createRequire(import.meta.url)(chainOut)

let n = 0
const check = (name, fn) => {
  fn()
  n++
  console.log(`ok - ${name}`)
}

check('a transcript gives its newest title of each kind, and a torn line is skipped', () => {
  const lines = [
    '{"type":"user","message":{"role":"user","content":"type \\"ai-title\\" in a prompt is not a title"}}',
    '{"type":"ai-title","aiTitle":"Brief pane naming","sessionId":"75a6"}',
    '{"type":"ai-title","aiTitle":"Pane naming review","sessionId":"75a6"}',
    '{"type":"custom-title","customTitle":"Names","sessionId":"75a6"}',
    '{"type":"ai-title","aiTitle":"half a li'
  ].join('\n')
  assert.deepEqual(titlesIn(lines), { ai: 'Pane naming review', custom: 'Names' })
  assert.deepEqual(titlesIn(''), {})
  // A `/rename` back to nothing clears the person's name rather than keeping the old one -
  // kept as '' so it also overwrites what an EARLIER read found (the sweep merges reads).
  assert.deepEqual(titlesIn('{"type":"custom-title","customTitle":"","sessionId":"x"}'), { custom: '' })
  const merged = { ...{ custom: 'Names' }, ...titlesIn('{"type":"custom-title","customTitle":"  ","sessionId":"x"}') }
  assert.deepEqual(merged, { custom: '' })
})

check('a title about the work is worn as the CLI wrote it', () => {
  for (const [t, p] of [
    ['Guarddeck report tuning', 'guarddeck'],
    ['Growth call sheet optimization', 'taskdriver.ai'],
    ['Codex reset timing and subscription sync', 'research-lab'],
    ['McGregors estate agents SEO audit', 'mcgregorrealestate'],
    ['Toolstash custom 404 page and real status', 'toolstash'],
    ['Resume builder for Upwork', 'assistant'],
    // Housekeeping words count only as whole words, and `session` only as the handoff's.
    ['SessionManager sweep performance', 'PaneForge'],
    ['Supabase session auth fix', 'taskdriver.ai'],
    ['Continuous deploy checks', 'toolstash'],
    ['Sessions list search', 'PaneForge']
  ]) {
    assert.deepEqual(cardTitle(t, p), { title: t, continuing: false }, t)
  }
})

check('a handoff title keeps the job and drops the housekeeping', () => {
  const cases = [
    ['Taskdriver mobile launch optimization handoff', 'taskdriver-mobile', 'Taskdriver mobile launch optimization'],
    ['PaneForge Discord tab handoff next steps', 'PaneForge', 'PaneForge Discord tab'],
    ['Growth lead research handoff next steps', 'taskdriver.ai', 'Growth lead research'],
    ['Toolstash deployment handoff continuation', 'Toolstash', 'Toolstash deployment'],
    ['SEO agents in Taskdriver (cont.)', 'taskdriver.ai', 'SEO agents in Taskdriver'],
    ['Taskdriver growth sheet probe and release handoff', 'taskdriver.ai', 'Taskdriver growth sheet probe and release']
  ]
  for (const [t, p, want] of cases) assert.deepEqual(cardTitle(t, p), { title: want, continuing: true }, t)
})

check('a title that is only housekeeping, or only the project again, names nothing', () => {
  for (const [t, p] of [
    ['Session handoff next steps', 'PaneForge'],
    ['PaneForge handoff next steps', 'PaneForge'],
    ['Taskdriver.ai handoff next steps', 'taskdriver.ai'],
    ['Taskdriver AI handoff next steps', 'taskdriver.ai'],
    ['Car handoff continuation', 'Car'],
    ['Research lab lane B handoff continuation', 'research-lab-b'],
    ['Taskdriver mobile handoff continuation', 'taskdriver-mobile'],
    ['Claude-memory handoff continuation', 'claude-memory'],
    // The lane folder is the project too (a real title, PaneForge, 2026-09-29).
    ['PaneForge-a handoff next steps', 'PaneForge'],
    ['Taskdriver-ai-c handoff continuation', 'taskdriver.ai'],
    ['PaneForge-w2 handoff continuation', 'PaneForge'],
    ['PaneForge lane-a handoff continuation', 'PaneForge']
  ]) {
    assert.deepEqual(cardTitle(t, p), { title: '', continuing: true }, t)
  }
})

check('a long title is cut at a whole word, never mid-word', () => {
  const t = 'PaneForge pf tell auto-answering AskUserQuestion prompts on another machine entirely'
  const got = cardTitle(t, 'PaneForge').title
  assert.ok(got.length <= 60, got)
  assert.ok(t.startsWith(got) && t[got.length] === ' ', got)
})

check('the CLI title lands only on a name the app chose, once per conversation', () => {
  const folder = { title: 'taskdriver.ai', appDefault: true }
  const read = { ai: 'Growth call sheet optimization' }
  // A pane still on its folder name takes the title the first time it is read...
  assert.deepEqual(nextTitle(folder, read, undefined, 'taskdriver.ai'), {
    title: 'Growth call sheet optimization',
    by: 'agent'
  })
  // ...and the same title read again changes nothing.
  const named = { title: 'Growth call sheet optimization', autoTitled: 'agent', appDefault: false }
  assert.equal(nextTitle(named, read, read, 'taskdriver.ai'), undefined)
  // After a /clear the next conversation's own title replaces the last one's.
  assert.deepEqual(nextTitle(named, { ai: 'SEO agents in Taskdriver' }, undefined, 'taskdriver.ai'), {
    title: 'SEO agents in Taskdriver',
    by: 'agent'
  })
  // A title that is only the project again, or only housekeeping, leaves the folder name.
  assert.equal(nextTitle(folder, { ai: 'Taskdriver.ai handoff next steps' }, undefined, 'taskdriver.ai'), undefined)
})

check('a name a person typed, an opener gave, or the roster found is never replaced', () => {
  const read = { ai: 'Growth call sheet optimization' }
  for (const pane of [
    { title: 'Robert typed this', appDefault: false },
    { title: 'Growth sheet: call, speed, status', appDefault: false },
    { title: 'Angie C. | clients', autoTitled: 'client', appDefault: false }
  ]) {
    assert.equal(nextTitle(pane, read, undefined, 'taskdriver.ai'), undefined, pane.title)
    assert.equal(nextTitle(pane, read, {}, 'taskdriver.ai'), undefined, pane.title)
  }
})

check('an automatic handoff keeps the name the pane already earned', () => {
  const earned = { title: 'Growth call sheet optimization', autoTitled: 'agent', appDefault: false }
  const cont = { ai: 'Growth lead research handoff next steps' }
  assert.equal(nextTitle(earned, cont, undefined, 'taskdriver.ai'), undefined)
  // ...but a pane that has earned nothing yet is named for the job the handoff carries.
  assert.deepEqual(nextTitle({ title: 'taskdriver.ai', appDefault: true }, cont, undefined, 'taskdriver.ai'), {
    title: 'Growth lead research',
    by: 'agent'
  })
})

check('a /rename in the CLI wins when it is new, never an old one over a name typed since', () => {
  const typed = { title: 'Invoices', appDefault: false }
  const renamed = { ai: 'Growth call sheet optimization', custom: 'Growth sheet' }
  // First read since the pane started: that /rename may be older than the name typed into
  // the app, so the app's name stands...
  assert.equal(nextTitle(typed, renamed, undefined, 'taskdriver.ai'), undefined)
  // ...but a pane still wearing an app-chosen name takes it, over the CLI's own title.
  assert.deepEqual(nextTitle({ title: 'taskdriver.ai', appDefault: true }, renamed, undefined, 'taskdriver.ai'), {
    title: 'Growth sheet',
    by: 'person'
  })
  // A /rename that CHANGES since the last read is a person acting now, and beats even a
  // name typed into the app or a client from the roster.
  const client = { title: 'Angie C. | clients', autoTitled: 'client', appDefault: false }
  for (const pane of [typed, client]) {
    assert.deepEqual(
      nextTitle(pane, renamed, { ai: renamed.ai }, 'taskdriver.ai'),
      { title: 'Growth sheet', by: 'person' },
      pane.title
    )
  }
  // The same /rename read again, or one the card already wears, changes nothing; and while
  // it stands, the CLI's own title never takes the card back.
  const wearing = { title: 'Growth sheet', appDefault: false }
  assert.equal(nextTitle(wearing, renamed, renamed, 'taskdriver.ai'), undefined)
  assert.equal(nextTitle(wearing, renamed, { ai: renamed.ai }, 'taskdriver.ai'), undefined)
  const agent = { title: 'x', autoTitled: 'agent', appDefault: false }
  assert.equal(nextTitle(agent, { ...renamed, ai: 'Other' }, renamed, 'taskdriver.ai'), undefined)
  // A /rename taken back to nothing stops holding the CLI's own title off an app-chosen name.
  assert.deepEqual(
    nextTitle({ title: 'taskdriver.ai', appDefault: true }, { ai: renamed.ai, custom: '' }, { custom: 'x' }, 'taskdriver.ai'),
    { title: renamed.ai, by: 'agent' }
  )
  assert.deepEqual(
    nextTitle({ title: 'taskdriver.ai', appDefault: true }, { ai: renamed.ai, custom: '' }, undefined, 'taskdriver.ai'),
    { title: renamed.ai, by: 'agent' }
  )
})

// Card 3 on the Mac, 2026-09-29: one Claude process in `taskdriver.ai-a` ran three
// conversations - `/clear` twice - and the card said `taskdriver.ai` because the one it is on
// now is titled for the handoff alone. The ids, titles and record shapes below are that
// pane's real transcripts (100b6a8b -> 01670992 -> be6d5f8a), cut to the lines that matter.
const T = {
  first: '100b6a8b-eac9-47f6-b610-336ce692c864',
  middle: '01670992-fe13-4160-a1dc-df4cb4a06a69',
  now: 'be6d5f8a-a2af-420f-83bd-3ea12f3d8fda',
  other: '12d2ce6d-f7e1-4ca0-a233-13f8cf6e6f41'
}
const aiTitle = (id, title) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id })
// The attachment record the CLI stamps with the id it was STARTED under (real keys; its
// rendered CLAUDE.md is dropped). A real one sits ~265 KB in, behind the SessionStart hook
// output - the filler puts it past the 256 KB a title read takes.
const stamped = (id, processId) =>
  JSON.stringify({
    parentUuid: '10600850-7e35-4f14-ad42-96bf1836997d',
    isSidechain: false,
    attachment: { type: 'instructions' },
    type: 'attachment',
    uuid: '0a40d4fc-a491-4b4d-89a3-9f6eb4b8a094',
    timestamp: '2026-09-28T22:48:16.902Z',
    rendered: [],
    session_id: processId,
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/Users/robertiuoras/Projects/taskdriver.ai-a',
    sessionId: id,
    version: '2.1.284',
    gitBranch: 'lane-a'
  })
// Not plain ASCII, as the real one is not (`—`, `·`): the head is scanned as bytes.
const hookOutput = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', content: '— '.repeat(70 * 1024) } })
const cleared = '{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}'
const folder = join(work, '-Users-robertiuoras-Projects-taskdriver-ai-a')
mkdirSync(folder, { recursive: true })
const transcript = (id, at, lines) => {
  const p = join(folder, `${id}.jsonl`)
  writeFileSync(p, lines.join('\n') + '\n')
  utimesSync(p, at / 1000, at / 1000)
  return p
}
const t0 = Date.parse('2026-09-28T22:10:00Z')
transcript(T.first, t0 + 18 * 60e3, [hookOutput, stamped(T.first, T.first), aiTitle(T.first, 'TaskDriver site UI improvements')])
transcript(T.middle, t0 + 38 * 60e3, [
  hookOutput,
  stamped(T.middle, T.first),
  cleared,
  aiTitle(T.middle, 'Taskdriver.ai release check and render validation')
])
// Another pane's conversation in the same folder, written in between: not this process.
transcript(T.other, t0 + 40 * 60e3, [hookOutput, stamped(T.other, T.other), aiTitle(T.other, 'Growth call sheet optimization')])
const now = transcript(T.now, t0 + 71 * 60e3, [
  hookOutput,
  stamped(T.now, T.first),
  cleared,
  aiTitle(T.now, 'Taskdriver AI handoff next steps')
])

check('a handoff-only conversation is named for the conversation it continues', () => {
  assert.deepEqual(
    earlierTitles(now).map((t) => t.ai),
    ['Taskdriver.ai release check and render validation', 'TaskDriver site UI improvements']
  )
  // The first conversation of a process continues nothing.
  assert.deepEqual(earlierTitles(join(folder, `${T.first}.jsonl`)), [])
  assert.deepEqual(earlierTitles(join(folder, 'gone.jsonl')), [])
  const read = titlesIn(aiTitle(T.now, 'Taskdriver AI handoff next steps'))
  const card = { title: 'taskdriver.ai', appDefault: true }
  assert.deepEqual(nextTitle(card, read, undefined, 'taskdriver.ai', () => earlierTitles(now)), {
    title: 'Taskdriver.ai release check and render validation',
    by: 'agent'
  })
  // Card 4 the same morning: three handoffs in a row after the work, in `PaneForge-a`.
  const card4 = [
    { ai: 'PaneForge handoff next steps' },
    { ai: 'PaneForge handoff continuation' },
    { ai: 'Session auto close prevention' }
  ]
  assert.deepEqual(
    nextTitle({ title: 'PaneForge', appDefault: true }, { ai: 'PaneForge handoff next steps' }, undefined, 'PaneForge', () => card4),
    { title: 'Session auto close prevention', by: 'agent' }
  )
  // A lane folder's name is not a job's: the look back goes past it (real chain, 887ad38e).
  assert.deepEqual(
    nextTitle({ title: 'PaneForge', appDefault: true }, { ai: 'PaneForge handoff next steps' }, undefined, 'PaneForge', () => [
      { ai: 'PaneForge-a handoff next steps' },
      { ai: 'PaneForge stale handoff and pf tidy exclusions' }
    ]),
    { title: cardTitle('PaneForge stale handoff and pf tidy exclusions', 'PaneForge').title, by: 'agent' }
  )
  // A person's `/rename` of an earlier conversation is that job's name.
  assert.deepEqual(
    nextTitle(card, read, undefined, 'taskdriver.ai', () => [{ ai: 'Taskdriver handoff', custom: 'Offer band' }]),
    { title: 'Offer band', by: 'agent' }
  )
  // Nothing earlier says what the work is: the folder name stays.
  assert.equal(nextTitle(card, read, undefined, 'taskdriver.ai', () => [{ ai: 'Taskdriver handoff continuation' }]), undefined)
})

check('the look back is only for a card on its folder name, and only for a handoff title', () => {
  const read = { ai: 'Taskdriver AI handoff next steps' }
  const never = () => {
    throw new Error('looked back')
  }
  for (const pane of [
    { title: 'Growth call sheet optimization', autoTitled: 'agent', appDefault: false },
    { title: 'AI caller + cleaners leads', appDefault: false },
    { title: 'Angie C. | clients', autoTitled: 'client', appDefault: false }
  ]) {
    assert.equal(nextTitle(pane, read, undefined, 'taskdriver.ai', never), undefined, pane.title)
  }
  const card = { title: 'taskdriver.ai', appDefault: true }
  // A title about the work needs no look back; the same title read again asks nothing.
  assert.deepEqual(nextTitle(card, { ai: 'Agent page text visibility and localhost performance' }, undefined, 'taskdriver.ai', never), {
    title: 'Agent page text visibility and localhost performance',
    by: 'agent'
  })
  assert.equal(nextTitle(card, read, read, 'taskdriver.ai', never), undefined)
  // Only the project again is not a handoff: nothing to continue.
  assert.equal(nextTitle(card, { ai: 'Taskdriver' }, undefined, 'taskdriver.ai', never), undefined)
})

console.log(`\n${n} checks passed`)
