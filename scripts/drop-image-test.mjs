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

const { pasteImageDrop, IMAGE_NAME, imagePathsInText, splitDropUris } = bundle('src/shared/attach.ts', 'attach.cjs')
const { pastesClipboardImage, imagePasteKey } = bundle('src/shared/agents.ts', 'agents.cjs')

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

// --- a pasted PATH to an image is the image (Robert 2026-10-01: "shouldn't ever be a path") --
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
ok('a plain path is an image path', same(imagePathsInText('/Users/r/Desktop/shot.png'), ['/Users/r/Desktop/shot.png']))
ok('a quoted path with spaces', same(imagePathsInText('"/Users/r/Screen Shot 1.png"'), ['/Users/r/Screen Shot 1.png']))
ok("a terminal's escaped spaces come off", same(imagePathsInText('/Users/r/Screen\\ Shot.png'), ['/Users/r/Screen Shot.png']))
ok('a file:// link', same(imagePathsInText('file:///Users/r/a%20b.jpg'), ['/Users/r/a b.jpg']))
ok('a Windows path keeps its backslashes', same(imagePathsInText('C:\\Users\\Gamer\\a.png'), ['C:\\Users\\Gamer\\a.png']))
ok('one path per line, all of them', same(imagePathsInText('/a/1.png\n/a/2.webp\n'), ['/a/1.png', '/a/2.webp']))
ok('a sentence mentioning a png stays text', imagePathsInText('look at /a/1.png please') === null)
ok('a relative name stays text', imagePathsInText('shot.png') === null)
ok('a pdf path stays text', imagePathsInText('/a/spec.pdf') === null)
ok('one non-image line keeps the whole paste as text', imagePathsInText('/a/1.png\nhello') === null)
ok('empty is not a path', imagePathsInText('   ') === null)
ok('a control byte is refused', imagePathsInText('file:///a/x%0A.png') === null)
// A text drag of an image path (a popup's label, an editor) is a dropped file too.
ok('a plain image path dropped as text is a path', same(splitDropUris('/Users/r/shot.png').paths, ['/Users/r/shot.png']))
ok('plain non-image text dropped is not a path', same(splitDropUris('/Users/r/notes').paths, []))

// --- the image key is the agent's own, on the machine the pty is on --------------------
ok('Claude Code on a Mac is ^V', imagePasteKey('claude', false) === '\u0016')
ok('Claude Code on Windows is Alt+V', imagePasteKey('claude', true) === '\u001bv')
ok('openrouter is Claude Code: Alt+V on Windows', imagePasteKey('openrouter', true) === '\u001bv')
ok('Codex on Windows stays ^V', imagePasteKey('codex', true) === '\u0016')

// Cmd+V uses a separate handler from drop. Exercise that shipped handler too: checking
// the capability list alone cannot catch an accidental path fallback in this branch.
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
const start = pane.indexOf('    const pasteClipboard = (): void => {')
const end = pane.indexOf('\n    t.attachCustomKeyEventHandler', start)
if (start < 0 || end < 0) throw new Error('pasteClipboard handler not found')
const handler = pane.slice(start, end).replace('(): void =>', '() =>')
const paste = async (agent, sessionId, text = '', { windows = false, decodes = true, far = { paths: ['/fixture/clipboard.png'] } } = {}) => {
  const calls = []
  const pasteClipboard = runInNewContext(`(() => { ${handler}; return pasteClipboard })()`, {
    api: {
      readClipboard: async () => text,
      write: (id, data) => calls.push(['write', id, data]),
      attachClipboardImage: async (id) => {
        calls.push(['attach', id])
        return far
      },
      attachPaths: async (id, paths) => {
        calls.push(['attachPaths', id, ...paths])
        return { paths: [] }
      }
    },
    t: { paste: (data) => calls.push(['text', data]) },
    agentRef: { current: agent }, sessionId, pastesClipboardImage, imagePathsInText, imagePasteKey,
    isWindows: windows,
    pasteImages: async (items, instead) => {
      calls.push(['images', ...items.map((i) => i.path)])
      if (!decodes) instead()
    },
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
ok('a screenshot pasted into a mirrored pane that the other desk pasted sends no second ^V',
  same(await paste('claude', '@pc/remote', '', { far: { paths: [], pasted: 1 } }), [['attach', '@pc/remote']]))
ok('Claude Code on Windows gets Alt+V, the key it reads images on',
  same(await paste('claude', 'local', '', { windows: true }), [['write', 'local', '\u001bv']]))
ok('a pasted image PATH goes in as the image on Claude Code',
  same(await paste('claude', 'local', '/Users/r/shot.png'), [['images', '/Users/r/shot.png']]))
ok('a pasted image PATH goes in as the image on Codex',
  same(await paste('codex', 'local', '"/Users/r/Screen Shot.png"'), [['images', '/Users/r/Screen Shot.png']]))
ok('a path that will not decode is pasted back as the text it was',
  same(await paste('claude', 'local', '/Users/r/gone.png', { decodes: false }), [['images', '/Users/r/gone.png'], ['text', '/Users/r/gone.png']]))
ok('a custom CLI still gets the path text',
  same(await paste('custom', 'local', '/Users/r/shot.png'), [['text', '/Users/r/shot.png']]))
ok('a mirrored pane sends the image over rather than a path from this desk',
  same(await paste('claude', '@pc/remote', '/Users/r/shot.png'), [['attachPaths', '@pc/remote', '/Users/r/shot.png']]))
ok('a sentence is still text',
  same(await paste('claude', 'local', 'see /Users/r/shot.png'), [['text', 'see /Users/r/shot.png']]))

// --- the other desk pastes a mirrored pane's image, never answers with a path -----------
const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const hs = main.indexOf('async function pasteImagesHere(')
const he = main.indexOf('\n}\n', hs)
if (hs < 0 || he < 0) throw new Error('pasteImagesHere not found')
const hereSrc = main.slice(hs, he + 2).replace(/: Promise<AttachResult>/, '').replace(/\(id: string, files: AttachIn\[\]\)/, '(id, files)')
  .replace(/const imgs: Electron\.NativeImage\[\] = \[\]/, 'const imgs = []')
  .replace(/\(f\) => f && typeof f\.data === 'string'\)/, "(f) => f && typeof f.data === 'string')")
  .replace(/\(s\) => s\.id === id\)/, '(s) => s.id === id)')
const here = async (agent, files, { platform = 'darwin' } = {}) => {
  const calls = []
  const fn = runInNewContext(`(() => { ${hereSrc}; return pasteImagesHere })()`, {
    manager: { list: () => [{ id: 'p1', agent }], write: (id, data, origin) => calls.push(['write', id, data, origin]) },
    pastesClipboardImage, imagePasteKey, tooBig: () => '', PASTE_GAP_MS: 0, setTimeout, Buffer,
    process: { platform },
    nativeImage: { createFromBuffer: (b) => ({ isEmpty: () => b.toString() === 'pdf' }) },
    putClipboardImage: () => { calls.push(['clipboard']); return true },
    writeAttachments: (f) => { calls.push(['saved', f.length]); return { paths: ['/saved/x.png'] } }
  })
  const res = await fn('p1', files)
  return { calls, res }
}
const png = { name: 'a.png', data: Buffer.from('png').toString('base64') }
const pdf = { name: 'a.pdf', data: Buffer.from('pdf').toString('base64') }
{
  const r = await here('claude', [png])
  ok('mirrored image: clipboard then ^V, no path', same(r.calls, [['clipboard'], ['write', 'p1', '\u0016', 'phone']]) && same(r.res, { paths: [], pasted: 1 }))
  const w = await here('claude', [png], { platform: 'win32' })
  ok('mirrored image on a Windows desk: Alt+V', same(w.calls, [['clipboard'], ['write', 'p1', '\u001bv', 'phone']]))
  const two = await here('codex', [png, png])
  ok('two images: two pastes', two.calls.filter((c) => c[0] === 'write').length === 2)
  const mixed = await here('claude', [png, pdf])
  ok('a mixed batch is saved whole and answered with paths', same(mixed.calls, [['saved', 2]]) && same(mixed.res, { paths: ['/saved/x.png'] }))
  const custom = await here('my-cli', [png])
  ok('an agent that does not read the clipboard gets the path', same(custom.calls, [['saved', 1]]))
}

writeFileSync(join(work, 'done'), 'ok')
if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('drop-image: ok')
