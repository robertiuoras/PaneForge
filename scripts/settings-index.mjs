// Reads every setting out of the Settings dialog's own source, so the search index can
// never drift from the settings it is meant to find.
//
// A hand-written index is the obvious way to do this and it is the wrong one: a setting
// added six months from now is simply missing from search, silently, and the way anybody
// finds out is by searching for it and being told nothing matches. The index is GENERATED
// (`npm run gen:settings`) and `npm run test:settingsearch` regenerates it in memory and
// refuses a checked-in copy that disagrees.
//
// The parse is deliberately shallow - a label is `label="..."` on a Switch or the text of
// a `<label>` - because a real JSX parse would buy nothing here: a label the scan cannot
// see is a label that fails the test, which is the outcome that matters.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS = resolve(root, 'src/renderer/src/components')

/** Files whose whole contents belong to one tab. */
const WHOLE_FILE = [
  ['AppearanceTab.tsx', 'appearance'],
  ['SoundsTab.tsx', 'sounds'],
  ['DiscordTab.tsx', 'discord']
]

/** Turn a JSX string literal back into the words a person sees. */
function plain(s) {
  return s
    .replace(/\\'/g, "'")
    .replace(/&apos;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The words of the `hint=` that belongs to the label on `at`, whatever shape it is in.
 *
 * A literal is read directly; an expression is read for the words INSIDE it - every
 * quoted or backticked run, with `${...}` cut out - because a hint like
 * "a pane nobody has typed into for ${IDLE_CLOSE_MINUTES} minutes" is a sentence with one
 * number in it, not a computation. Anything that is not a string (a bare identifier, a
 * function name) contributes nothing, which is right: it is not what is drawn.
 */
function hintAfter(lines, at) {
  // The hint of THIS control: stop at the next label, which starts the next one.
  let text = ''
  for (let j = at; j < Math.min(at + 12, lines.length); j++) {
    if (j > at && /\blabel="/.test(lines[j].line)) break
    text += lines[j].line + '\n'
  }
  const start = text.search(/\bhint=/)
  if (start < 0) return ''
  const open = text[text.indexOf('=', start) + 1]
  if (open === '"') {
    const m = text.slice(start).match(/\bhint="([^"]*)"/)
    return m ? plain(m[1]) : ''
  }
  if (open !== '{') return ''

  // Walk to the brace that closes it, so a template's own `${}` cannot end the scan early.
  let depth = 0
  let end = -1
  const from = text.indexOf('{', start)
  for (let k = from; k < text.length; k++) {
    if (text[k] === '{') depth++
    else if (text[k] === '}') {
      depth--
      if (!depth) {
        end = k
        break
      }
    }
  }
  if (end < 0) return ''
  const expr = text.slice(from + 1, end)
  const parts = [...expr.matchAll(/`([^`]*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? ''
  )
  return plain(parts.join(' ').replace(/\$\{[^}]*\}/g, ' '))
}

/**
 * The lines of a file, each tagged with the tab it is drawn on.
 * In SettingsDialog the tab blocks are sequential, so the last `tab === 'x'` marker at or
 * above a line is that line's tab.
 */
function taggedLines(text, fixedTab) {
  const out = []
  let tab = fixedTab ?? ''
  for (const line of text.split('\n')) {
    if (!fixedTab) {
      const m = line.match(/tab === '([a-z]+)'/)
      if (m) tab = m[1]
    }
    out.push({ tab, line })
  }
  return out
}

/**
 * Every setting in the dialog: `{ tab, label, find }`, in the order they are drawn.
 *
 * `find` is the label plus its hint - the sentence under a switch saying what it does -
 * because that sentence is where a setting's real vocabulary lives. "Close a pane nobody
 * has touched for a while" is not a phrase anybody types; "idle" and "memory" are, and
 * both are in its hint.
 */
export function readSettings() {
  const found = []
  const seen = new Set()

  const push = (tab, label, hint) => {
    if (!tab || !label) return
    if (label.length > 90) return // a paragraph rendered in a <label> is not a setting name
    const key = tab + '|' + label
    if (seen.has(key)) return
    seen.add(key)
    found.push({ tab, label, find: hint ? `${label} ${hint}` : label })
  }

  const files = [['SettingsDialog.tsx', null], ...WHOLE_FILE]
  for (const [name, fixedTab] of files) {
    const text = readFileSync(resolve(COMPONENTS, name), 'utf8')
    const lines = taggedLines(text, fixedTab)

    for (let i = 0; i < lines.length; i++) {
      const { tab, line } = lines[i]

      // <Switch label="..." hint=... />. The hint follows the label, usually on the next
      // line, and is as often an EXPRESSION as a literal - a template string carrying a
      // number, `keyLabel('...')`, a concatenation. Reading only `hint="..."` dropped nine
      // of them, which is not a smaller index but a wrong one: the words that make a
      // setting findable ("idle", "memory", "offload") live in exactly those sentences.
      const lab = line.match(/\blabel="([^"]+)"/)
      if (lab) {
        push(tab, plain(lab[1]), hintAfter(lines, i))
        continue
      }

      // <label>Some words</label>, the heading of a `.setting` block. It may carry an
      // expression - `Terminal font size ({config.fontSize}px)` - and the whole word
      // "font" is inside one of those, so the braces are cut out rather than the label.
      const tag = line.match(/<label>(.*)<\/label>/)
      if (tag) {
        const words = tag[1]
          .replace(/\([^)]*\{[^}]*\}[^)]*\)/g, '') // "(12px)" is a reading, not part of the name
          .replace(/\{[^}]*\}/g, '')
        push(tab, plain(words), '')
      }
    }
  }
  return found
}

/** The generated module, as text. */
export function render(settings) {
  const rows = settings
    .map((s) => `  { tab: '${s.tab}', label: ${JSON.stringify(s.label)}, find: ${JSON.stringify(s.find)} }`)
    .join(',\n')
  return `// GENERATED by scripts/settings-index.mjs - run \`npm run gen:settings\` after adding a
// setting. \`npm run test:settingsearch\` fails when this disagrees with the dialog's source.
//
// One entry per setting the Settings dialog draws: which tab it is on, the words on it,
// and the words it can be found by (its label plus the sentence under it).

export interface SettingEntry {
  tab: string
  label: string
  find: string
}

export const SETTINGS: SettingEntry[] = [
${rows}
]

/**
 * The settings a query hits, best first.
 *
 * Every word has to appear somewhere in the entry - AND, the same rule the tab rail uses -
 * so a second word narrows. A hit on the LABEL outranks one that only matched the
 * explaining sentence underneath: the label is what the person is looking at.
 */
export function findSettings(query: string): SettingEntry[] {
  const words = query.toLowerCase().split(/\\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: { entry: SettingEntry; score: number }[] = []
  for (const entry of SETTINGS) {
    const label = entry.label.toLowerCase()
    const find = entry.find.toLowerCase()
    if (!words.every((w) => find.includes(w))) continue
    const inLabel = words.filter((w) => label.includes(w)).length
    scored.push({ entry, score: inLabel })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.entry)
}
`
}
