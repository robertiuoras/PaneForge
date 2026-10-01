// A dropped screenshot reaches the agent as a PICTURE, not as a path it has to open.
//
// The bug: dragging a screenshot onto a Claude Code pane typed
// `/Users/.../Screenshot 2026-08-18 at 18.45.04.png ` at the prompt. That works, but only
// after the agent is asked to go and read it, and only if it bothers - it is a filename,
// not an image. Claude Code reads an image off the OS clipboard when a raw ^V arrives, so
// for that CLI the bytes go on the clipboard and the paste puts the picture in the turn.
//
// What is pinned here is the DECISION, which is the part that can silently go wrong: a
// paste sent to an agent that does not read the clipboard is a control byte that does
// nothing at all, and that failure looks exactly like a drop that was ignored.
//
//   node scripts/drop-image-test.mjs

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-drop-image-test-'))

const bundle = (entry, out) => {
  buildSync({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(work, out)
  })
  return createRequire(import.meta.url)(join(work, out))
}

const { pasteImageDrop, IMAGE_NAME } = bundle('src/shared/attach.ts', 'attach.cjs')
const { pastesClipboardImage } = bundle('src/shared/agents.ts', 'agents.cjs')

let failed = 0
const ok = (name, cond) => {
  if (cond) return
  failed++
  console.error('FAIL', name)
}

const drop = (over) =>
  pasteImageDrop(
    { agent: 'claude', sessionId: 'abc', items: [{ name: 'shot.png', type: 'image/png' }], ...over },
    pastesClipboardImage
  )

// --- who reads a clipboard image ------------------------------------------------------
ok('claude pastes', drop({}))
ok('claude code alias pastes', drop({ agent: 'claude-code' }))
ok('openrouter is claude code, so it pastes', drop({ agent: 'openrouter' }))
ok('codex pastes', drop({ agent: 'codex' }))
ok('antigravity pastes', drop({ agent: 'antigravity' }))
// Custom and unknown agents take the path so a CLI that does not read clipboard is not broken.
ok('a custom agent takes the path', !drop({ agent: 'my-own-cli' }))
ok('an unknown agent takes the path', !drop({ agent: undefined }))

// --- a mirrored pane reads the OTHER desk's clipboard ---------------------------------
ok('a mirrored pane takes the path', !drop({ sessionId: '@pc/abc' }))

// --- what was dropped -----------------------------------------------------------------
ok('a typed image pastes', drop({ items: [{ name: 'a.png', type: 'image/png' }] }))
// A macOS screenshot dragged off its own preview thumbnail carries no MIME type at all.
ok('an untyped .png pastes on its name', drop({ items: [{ name: 'Screen Shot.png' }] }))
ok('an untyped .jpeg pastes on its name', drop({ items: [{ name: 'a.JPEG' }] }))
ok('a pdf takes the path', !drop({ items: [{ name: 'spec.pdf', type: 'application/pdf' }] }))
ok('a folder-ish name takes the path', !drop({ items: [{ name: 'screenshots' }] }))
// Mixed: splitting one drop across two mechanisms leaves the prompt in an order nobody
// can predict, so the whole batch takes the path.
ok(
  'a mixed drop takes the path',
  !drop({ items: [{ name: 'a.png', type: 'image/png' }, { name: 'b.pdf' }] })
)
ok('an empty drop pastes nothing', !drop({ items: [] }))
// Several images is still a paste - the pane sends them one ^V at a time.
ok('two images paste', drop({ items: [{ name: 'a.png' }, { name: 'b.jpg' }] }))

// --- the name test itself -------------------------------------------------------------
ok('.png matches', IMAGE_NAME.test('a.png'))
ok('.webp matches', IMAGE_NAME.test('a.webp'))
ok('a name that merely CONTAINS png does not', !IMAGE_NAME.test('png-notes.txt'))
ok('a trailing dot does not', !IMAGE_NAME.test('a.png.txt'))

// Cmd+V uses a separate handler from drop. Exercise that shipped handler too: checking
// the capability list alone cannot catch an accidental path fallback in this branch.
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
const start = pane.indexOf('    const pasteClipboard = (): void => {')
const end = pane.indexOf('\n    t.attachCustomKeyEventHandler', start)
if (start < 0 || end < 0) throw new Error('pasteClipboard handler not found')
const handler = pane.slice(start, end).replace('(): void =>', '() =>')
const paste = async (agent, sessionId, text = '') => {
  const calls = []
  const pasteClipboard = runInNewContext(`(() => { ${handler}; return pasteClipboard })()`, {
    api: {
      readClipboard: async () => text,
      write: (id, data) => calls.push(['write', id, data]),
      attachClipboardImage: async (id) => {
        calls.push(['attach', id])
        return { paths: ['/fixture/clipboard.png'] }
      }
    },
    t: { paste: (data) => calls.push(['text', data]) },
    agentRef: { current: agent }, sessionId, pastesClipboardImage,
    RAW_PASTE: '\u0016', NO_IMAGE: 'No image on the clipboard',
    typePaths: (paths) => calls.push(['paths', ...paths]), toast: { current: null }
  })
  pasteClipboard()
  // Both asynchronous branches settle through promises, with no real clipboard/CLI.
  await new Promise((resolve) => setImmediate(resolve))
  return calls
}
ok('Codex Cmd+V sends native image paste, with no path',
  JSON.stringify(await paste('codex', 'local')) === JSON.stringify([['write', 'local', '\u0016']]))
ok('text still uses bracketed terminal paste',
  JSON.stringify(await paste('codex', 'local', 'hello')) === JSON.stringify([['text', 'hello']]))
ok('a custom CLI still receives a saved image path',
  JSON.stringify(await paste('custom', 'local')) === JSON.stringify([['attach', 'local'], ['paths', '/fixture/clipboard.png']]))
ok('a remote Codex pane still receives its own saved image path',
  JSON.stringify(await paste('codex', '@pc/remote')) === JSON.stringify([['attach', '@pc/remote'], ['paths', '/fixture/clipboard.png']]))

writeFileSync(join(work, 'done'), 'ok')
if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('drop-image: ok')
