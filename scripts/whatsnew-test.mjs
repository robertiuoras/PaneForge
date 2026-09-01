// What the "what changed" card may say, and every launch on which it must say nothing.
//
// The load-bearing half is the negatives. A card that appears on a fresh install, on an
// ordinary restart, after a rollback, or with nothing readable in it is worse than no
// card at all - it is the app talking for the sake of talking, on a screen it is not
// allowed to interrupt.
//
//   node scripts/whatsnew-test.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// A bare path is not a URL: on Windows `C:\...` parses as the protocol `c:` and the loader
// refuses it. pathToFileURL is the one spelling that is right on both machines.
const { shouldSpeak, bulletsFrom, compareVersions, MAX_BULLETS, MAX_CHARS } = await import(
  pathToFileURL(join(root, 'src/shared/whatsNew.ts')).href
)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

console.log('which launch is worth speaking about')
{
  ok('the first launch on a newer build speaks', shouldSpeak('0.8.171', '0.8.170'))
  // A FRESH INSTALL has no previous build. Nothing was fixed for this person yet, and a
  // card listing changes they never lived through is noise dressed as news.
  ok('a fresh install says nothing', !shouldSpeak('0.8.171', undefined))
  ok('...and an empty marker is a fresh install too', !shouldSpeak('0.8.171', '  '))
  // The common case, and it must be free: the app restarts for all sorts of reasons.
  ok('an ordinary restart says nothing', !shouldSpeak('0.8.171', '0.8.171'))
  // A rollback - promote to an older stable, or a hand install. "What's new" over a
  // downgrade is a lie.
  ok('a rollback says nothing', !shouldSpeak('0.8.169', '0.8.170'))
  ok('and neither does a nameless build', !shouldSpeak('', '0.8.170'))

  ok('versions compare by number, not by string', compareVersions('0.8.171', '0.8.99') > 0)
  ok('a v prefix is not part of the number', compareVersions('v0.8.171', '0.8.171') === 0)
  // `Number('x') || 0` rather than NaN: a nonsense part must sort, never poison every
  // comparison after it into false.
  ok('a nonsense part sorts as zero rather than NaN', compareVersions('0.8.x', '0.8.0') === 0)
  ok('a longer version outranks its own prefix', compareVersions('0.8.170.1', '0.8.170') > 0)
}

console.log('turning a release body into sentences')
{
  const body = [
    '## What changed',
    '',
    '- **fix(panes):** a pane that was trimmed gets thousands of lines back, not a hundred',
    '* feat: the sessions list groups both machines (#412)',
    '- perf(usage): the memory column is read five times more slowly 1a2b3c4d5e6f',
    '',
    'Full commit history: https://github.com/robertiuoras/PaneForge/compare/v0.8.169...v0.8.170'
  ].join('\n')
  const b = bulletsFrom(body)
  ok('the machine prefix is gone', b[0] === 'A pane that was trimmed gets thousands of lines back, not a hundred', JSON.stringify(b[0]))
  ok('a scope and its emphasis go with it', b[1] === 'The sessions list groups both machines', JSON.stringify(b[1]))
  ok('a trailing sha is not part of the sentence', b[2] === 'The memory column is read five times more slowly', JSON.stringify(b[2]))
  // A heading, a blank and the commit-history fallback are prose ABOUT the release, not
  // things that changed in it.
  ok('only list items become bullets', b.length === 3, JSON.stringify(b))

  // An empty answer is a REFUSAL, and the card draws nothing for it. A body with no list
  // in it (hand-written, or the generator's fallback) has nothing to summarise, and
  // "what's new: nothing" is worse than silence.
  ok('a body with no list says nothing', bulletsFrom('Full commit history: https://x/y').length === 0)
  ok('an absent body says nothing', bulletsFrom(null).length === 0 && bulletsFrom('').length === 0)

  ok('the list is capped', bulletsFrom(Array.from({ length: 20 }, (_, i) => `- fix: thing ${i}`).join('\n')).length === MAX_BULLETS)
  const long = bulletsFrom('- fix: ' + 'word '.repeat(80))[0]
  ok('a paragraph is cut to a line, on a word', long.length <= MAX_CHARS && long.endsWith('…'), String(long.length))
  ok('the same sentence twice is one bullet', bulletsFrom('- fix: same\n- feat: same').length === 1)
}

console.log('it may never take the screen, and never asks twice')
{
  const main = readFileSync(join(root, 'src/main/whatsNew.ts'), 'utf8')
  // Every way the network can fail must land on "no card", never on an error and never
  // on a card with nothing in it.
  ok('a failed fetch is caught and answered null', /catch \{[\s\S]{0,200}?return null/.test(main))
  ok('the request has a timeout', /AbortController/.test(main) && /TIMEOUT_MS/.test(main))
  // The asymmetry that makes an offline launch recoverable: the version is remembered
  // only once a card has actually been produced.
  const speak = main.slice(main.indexOf('export async function whatsNew'))
  ok('a launch with no readable notes does not remember the version', /if \(!bullets\.length\) return null/.test(speak) && speak.indexOf('if (!bullets.length) return null') < speak.indexOf("setConfig({ seenVersion: version })", speak.indexOf('const raw')))

  const card = readFileSync(join(root, 'src/renderer/src/components/WhatsNewCard.tsx'), 'utf8')
  // "Never take the screen": nothing the app decided by itself may be a dialog, raise a
  // window, or take focus.
  ok('the card is drawn in the renderer, not as a dialog', !/showMessageBox|dialog\./.test(card))
  ok('it never focuses or raises anything', !/focus\(|setAlwaysOnTop|moveTop/.test(card))
  ok('it is asked once, not polled', (card.match(/api\.whatsNew\(\)/g) || []).length === 1 && !/setInterval/.test(card))
  ok('an empty answer draws nothing', /!news\.bullets\.length\) return null/.test(card))

  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  // It sits UNDER the update prompt: if a newer build is already downloaded, the offer to
  // take it outranks a summary of the one before.
  const z = /\.update-toast\.whatsnew \{ z-index: (\d+)/.exec(css)?.[1]
  ok('it sits under the update prompt', Number(z) === 59, String(z))
  ok('and it has no animation of its own', !/\.whatsnew[^}]*animation/.test(css))

  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('it is actually mounted', /<WhatsNewCard \/>/.test(app))
}

console.log(failed ? `\n${failed} failed` : '\nwhats new: all good')
process.exit(failed ? 1 : 0)
