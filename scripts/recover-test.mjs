// Finishing a turn the transport cut in half - and, far more importantly, every case
// where the app must keep its hands off.
//
// This is a feature that TYPES INTO somebody's agent without being asked, so the refusals
// are the whole file and the happy path is four lines of it. Every error string below was
// taken out of the 557 MB of real pane logs on this desk rather than invented, including
// the two that are a person quoting the error at an agent - which is the case that makes
// naive matching answer a question about the bug by causing it.
//
//   node scripts/recover-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-recover-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'recover.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/recover.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { recover, truncatedLine, DEFAULT_RECOVER, INCOMPLETE, TAIL_CHARS } = createRequire(
  import.meta.url
)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

// Every first sentence this desk has actually seen, with its real count in the logs.
// The point of the list is that it is FIVE spellings of one thing: the module keys on the
// second sentence precisely because the first one is a moving target.
const REAL = [
  'API Error: Connection closed mid-response. The response above may be incomplete.',
  'API Error: Response stalled mid-stream. The response above may be incomplete.',
  'API Error: Connection lost mid-response. The response above may be incomplete.',
  'API Error: The response stopped arriving. The response above may be incomplete.',
  'API Error: Server error mid-response. The response above may be incomplete.'
]

const screen = (...rows) => rows.join('\n')
const idle = (painted, tries = 0) => ({ painted, busy: false, tries })

{
  // The five real ones, each as the CLI paints it: its own bullet, then the error, then the
  // composer redrawn underneath.
  for (const line of REAL) {
    const out = recover(idle(screen('  the answer so far', `⏺ ${line}`, '', '╭───────╮', '│ > ', '╰───────╯')))
    check(`recovers: ${line.slice(11, 40)}`, out !== null && out.text === 'continue', out)
  }
  eq('the sentence itself is the contract', INCOMPLETE, 'The response above may be incomplete.')
}

{
  // A vendor wording nobody has shipped yet still works, because only the second sentence
  // is matched. This is the case the module exists in this shape for.
  const out = recover(
    idle(screen('⏺ API Error: Something entirely new happened. The response above may be incomplete.'))
  )
  check('an unseen first sentence still recovers', out !== null, out)
}

// ---------------------------------------------------------------- the refusals

{
  // THE case. Robert pasted the error into a pane to ask for this feature; the CLI echoed
  // it back into the transcript as a user message, with no box left around it. Taken
  // verbatim from this machine's logs.
  const echoed =
    '> API Error: Connection lost mid-response. The response above may be incomplete. if possible auto continue can you make that a'
  eq('a person quoting the error is not the error', truncatedLine(screen('', echoed, '')), null)
  eq('and Codex draws a different marker', truncatedLine(`› ${REAL[0]}`), null)

  // The same quote a moment earlier, still being typed inside the composer box.
  eq(
    'nor is one still sitting in the composer',
    truncatedLine(screen('╭──────────╮', `│ > ${REAL[2]}`, '╰──────────╯')),
    null
  )
}

{
  // An agent WRITING about the error. Also taken from the logs - it is this session's own
  // reply, rendered into the pane it was typed in.
  const prose =
    "st sentences already, but every one ends The response above may be incomplete. - that's the"
  eq('prose containing the sentence is not an error', truncatedLine(prose), null)
  eq('and neither is the sentence alone', truncatedLine(INCOMPLETE), null)
}

{
  // Retrying these makes them worse, or loops forever. The CLI handles the ones that
  // deserve a retry and says so.
  const never = [
    'API Error: 429 rate limit exceeded. The response above may be incomplete.',
    'API Error: usage limit reached. The response above may be incomplete.',
    'API Error: Your credit balance is too low. The response above may be incomplete.',
    'API Error: 401 authentication failed. The response above may be incomplete.',
    'API Error: overloaded_error. The response above may be incomplete.'
  ]
  for (const line of never) {
    eq(`never auto-continues: ${line.slice(11, 34)}`, truncatedLine(`⏺ ${line}`), null)
  }
}

{
  eq('a busy pane is never interrupted', recover({ painted: `⏺ ${REAL[0]}`, busy: true, tries: 0 }), null)
  eq(
    'nor is one past its budget',
    recover(idle(`⏺ ${REAL[0]}`, DEFAULT_RECOVER.maxTries)),
    null
  )
  check(
    'the last try still fires',
    recover(idle(`⏺ ${REAL[0]}`, DEFAULT_RECOVER.maxTries - 1)) !== null
  )
  eq('off is off', recover(idle(`⏺ ${REAL[0]}`), { ...DEFAULT_RECOVER, enabled: false }), null)
  eq(
    'and nothing to send is nothing sent',
    recover(idle(`⏺ ${REAL[0]}`), { ...DEFAULT_RECOVER, text: '' }),
    null
  )
}

{
  // Only the newest output is read. An error further back than the tail has been dealt
  // with - the caller slices to output since the last look for the same reason.
  const buried = screen(`⏺ ${REAL[0]}`, 'x'.repeat(TAIL_CHARS + 200))
  eq('an error older than the tail is not re-fired', truncatedLine(buried), null)
  // The newest one wins when there are two.
  const both = screen(`⏺ ${REAL[0]}`, 'work happened', `⏺ ${REAL[3]}`)
  check('the newest error is the one reported', truncatedLine(both).includes('stopped arriving'))
}

{
  // The reason is quoted from the screen, never composed. A log line that invented its
  // own wording would be the one thing in the pane nobody could search for.
  const out = recover(idle(`⏺ ${REAL[1]}`))
  check('the reason is the line itself, verbatim', out.because === `⏺ ${REAL[1]}`, out.because)
}

console.log(`recover: ${checks} checks passed`)
