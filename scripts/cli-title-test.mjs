// What a pane is called when the name comes from the agent's own title for the chat.
//
// Every title below is a REAL one, read off Claude Code transcripts on the Mac and the PC
// on 2026-09-28 (`"type":"ai-title"` records), with the folder the pane was in.
//
//   node scripts/cli-title-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
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
    ['Claude-memory handoff continuation', 'claude-memory']
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

console.log(`\n${n} checks passed`)
