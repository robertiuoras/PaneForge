// Putting a picture in front of an agent.
//
// The bug this exists for: a screenshot dragged onto a MIRRORED pane typed the path it
// had on this desk, at an agent running on the other machine, which reads as a missing
// file rather than as an error anybody can act on. So the bytes are written where the pty
// is and the path of THAT file is typed. What is pinned here is the half with no window
// in it: what a saved attachment is called, that a name can never become a path, which
// saved files are litter, and that a batch too big for the device link is refused with a
// sentence rather than killing the link.
//
//   node scripts/attach-test.mjs

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-attach-test-'))
const userData = join(work, 'userData')
mkdirSync(userData, { recursive: true })

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData')}}
`
)

const bundle = (entry, out) => {
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(work, out),
    alias: { electron: join(work, 'electron-stub.cjs') }
  })
  return createRequire(join(work, 'x.cjs'))('./' + out)
}

const S = bundle('src/shared/attach.ts', 'attach.shared.cjs')
const M = bundle('src/main/attach.ts', 'attach.main.cjs')

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}

// --------------------------------------------------------------------------- bytes
// Real magic, because the whole point of sniffing is that the NAME lied.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7)
])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16, 1)])
const PDF = Buffer.concat([Buffer.from('%PDF-1.7', 'latin1'), Buffer.alloc(16, 1)])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(16, 1)
])
const TEXT = Buffer.from('hello, this is not an image at all', 'utf8')

const AT = new Date(2026, 7, 14, 18, 5, 33).getTime()

ok(S.sniffExt(PNG) === 'png', 'png is read off the bytes')
ok(S.sniffExt(JPG) === 'jpg', 'jpg is read off the bytes')
ok(S.sniffExt(GIF) === 'gif', 'gif is read off the bytes')
ok(S.sniffExt(PDF) === 'pdf', 'pdf is read off the bytes')
ok(S.sniffExt(WEBP) === 'webp', 'webp needs both halves of the RIFF header')
ok(S.sniffExt(TEXT) === '', 'nothing recognised answers empty rather than guessing')
ok(S.sniffExt(Buffer.from([0x89])) === '', 'a signature cut short is not a match')

// --------------------------------------------------------------------------- the name
const nameOf = (n, bytes = PNG, seq = 1) => S.attachName(n, bytes, AT, seq)

ok(S.ATTACH_RE.test(nameOf('shot.png')), 'every saved name carries the stamp prefix')
ok(nameOf('shot.png') === '20260814-180533-1-shot.png', 'the ordinary case', nameOf('shot.png'))

// A name is TEXT. This is the assertion the whole sanitiser exists for.
for (const evil of [
  '../../.ssh/authorized_keys',
  '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
  'C:\\Windows\\notepad.exe',
  '/etc/passwd',
  'a/b/c.png'
]) {
  const got = nameOf(evil)
  ok(
    !got.includes('/') && !got.includes('\\') && !got.includes(':') && !got.startsWith('.'),
    'a name can never become a path: ' + evil,
    got
  )
}
ok(nameOf('..') === '20260814-180533-1-pasted.png', 'a name that is only dots leaves a usable one', nameOf('..'))
ok(nameOf('') === '20260814-180533-1-pasted.png', 'no name at all still writes something', nameOf(''))

const ctrl = 'sh' + String.fromCharCode(0) + 'o' + String.fromCharCode(0x1f) + 't' + String.fromCharCode(0x7f)
ok(
  nameOf(ctrl + '.png') === '20260814-180533-1-shot.png',
  'control bytes are dropped, not kept and not escaped',
  nameOf(ctrl + '.png')
)

ok(
  nameOf('screenshot.txt') === '20260814-180533-1-screenshot.png',
  'the CONTENT wins when the name disagrees',
  nameOf('screenshot.txt')
)
ok(
  nameOf('download') === '20260814-180533-1-download.png',
  'a browser drag with no extension is given the real one',
  nameOf('download')
)
ok(
  nameOf('notes.md', TEXT) === '20260814-180533-1-notes.md',
  'an extension we cannot verify is kept as it came',
  nameOf('notes.md', TEXT)
)
ok(
  nameOf('a'.repeat(400) + '.png').length < 100,
  'a 400-character name is capped rather than handed to the filesystem'
)
ok(
  nameOf('shot.png', PNG, 1) !== nameOf('shot.png', PNG, 2),
  'two screenshots pasted in the same second cannot collide'
)

// --------------------------------------------------------------------------- pruning
const ours = []
for (let i = 1; i <= 205; i++) ours.push(`2026081${i % 10}-1805${String(i % 60).padStart(2, '0')}-${i}-x.png`)
const foreign = ['my-notes.png', 'README.md']
const doomed = S.pruneList([...foreign, ...ours], 200)
ok(doomed.length === 5, 'pruning keeps exactly the newest N', doomed.length)
ok(
  !doomed.some((n) => foreign.includes(n)),
  'a file a person put in that folder is never deleted',
  doomed.filter((n) => foreign.includes(n))
)
ok(S.pruneList(ours, 400).length === 0, 'under the cap nothing is deleted')

// --------------------------------------------------------------------------- the cap
const b64 = (buf) => buf.toString('base64')
const big = [{ name: 'huge.bin', data: b64(Buffer.alloc(6 * 1024 * 1024, 9)) }]
const small = [{ name: 'shot.png', data: b64(PNG) }]
ok(Math.abs(S.batchBytes(small) - PNG.length) === 0, 'a batch is measured without decoding it')
ok(/6\.0 MB/.test(S.tooBig(big)) && /5\.0 MB/.test(S.tooBig(big)), 'the refusal names both sizes', S.tooBig(big))
ok(S.tooBig(small) === '', 'an ordinary screenshot is not refused')

// --------------------------------------------------------------------------- the disk
const dir = M.attachDir()
// Through realpath on both sides: on a Mac `tmpdir()` is `/var/folders/...`, which is a
// symlink to `/private/var/folders/...`, and the app resolves it. A raw prefix test
// failed here for reasons that have nothing to do with where the file was written.
ok(realpathSync(dir).startsWith(realpathSync(userData) + sep), 'attachments live under userData', dir)

const wrote = M.writeAttachments(small, AT)
ok(wrote.paths.length === 1 && !wrote.error, 'a screenshot is saved', JSON.stringify(wrote))
ok(existsSync(wrote.paths[0]), 'the path answered is a file that is really there')
ok(readFileSync(wrote.paths[0]).equals(PNG), 'the bytes arrive unchanged')

const escaped = M.writeAttachments([{ name: '../../escaped.png', data: b64(PNG) }], AT)
ok(
  escaped.paths.length === 1 && escaped.paths[0].startsWith(dir + sep),
  'a traversing name still writes inside the folder',
  escaped.paths[0]
)

const before = readdirSync(dir).length
const refused = M.writeAttachments(big, AT)
ok(refused.paths.length === 0 && Boolean(refused.error), 'an oversize batch is refused')
ok(readdirSync(dir).length === before, 'and writes nothing on the way to refusing it')

// ------------------------------------------------------- a path on THIS disk, read here
// A macOS screenshot dragged off its thumbnail onto a MIRRORED pane is a file:// URI and
// no bytes; main reads it where the path is true and only the bytes travel.
{
  const shotPath = join(dir, 'drag-from-finder.png')
  writeFileSync(shotPath, PNG)
  const read = M.readAttachIns([shotPath])
  ok(!read.error && read.files.length === 1, 'a path on this disk is read into bytes', JSON.stringify(read.error))
  ok(read.files[0].name === 'drag-from-finder.png', 'named by its basename', read.files[0].name)
  ok(Buffer.from(read.files[0].data, 'base64').equals(PNG), 'the bytes are the file')
  const missing = M.readAttachIns([join(dir, 'not-there.png')])
  ok(missing.files.length === 0 && /Could not read not-there.png/.test(missing.error), 'a missing path refuses, by name', missing.error)
  const mixed = M.readAttachIns([shotPath, join(dir, 'not-there.png')])
  ok(mixed.files.length === 0 && Boolean(mixed.error), 'one bad path refuses the whole batch')
  const folder = M.readAttachIns([dir])
  ok(folder.files.length === 0 && /Not a file/.test(folder.error), 'a folder is refused', folder.error)
  const hugePath = join(dir, 'huge.bin')
  writeFileSync(hugePath, Buffer.alloc(6 * 1024 * 1024, 9))
  const huge = M.readAttachIns([hugePath])
  ok(huge.files.length === 0 && /6.0 MB/.test(huge.error), 'an oversize file is refused with the size', huge.error)
  ok(M.readAttachIns([]).error === 'Nothing to attach', 'no paths is said, not thrown')
  rmSync(shotPath, { force: true }); rmSync(hugePath, { force: true })
}

const empty = M.writeAttachments([], AT)
ok(empty.paths.length === 0 && empty.error === 'Nothing to attach', 'an empty batch says so')

// Many files, then a hard prune: the newest survive and the count is the cap.
for (let i = 0; i < 8; i++) M.writeAttachments([{ name: `s${i}.png`, data: b64(PNG) }], AT + i * 1000)
M.prune(3)
const left = readdirSync(dir).filter((n) => S.ATTACH_RE.test(n))
ok(left.length === 3, 'prune leaves exactly the cap', left.length)
ok(
  left.every((n) => n >= [...left].sort()[0]),
  'and the ones it leaves are the newest'
)

// ---------------------------------------------------------------------------
// A drop that carried URIs and no File objects.
//
// This is the shape that had no code at all: macOS hands a screenshot dragged off its own
// preview thumbnail as `text/uri-list` with `file:///…` in it, the pane's dragover only
// accepted `Files`, so Chromium's default action typed the URL into xterm as a sentence.
// The agent got `file:///var/folders/…/Screenshot%2520….png` - an attachment shaped like
// a link, which nothing here can open.

ok(
  S.pathFromFileUri('file:///Users/r/Screenshot%202026-08-17%20at%2017.48.55.png') ===
    '/Users/r/Screenshot 2026-08-17 at 17.48.55.png',
  'a file: URI comes back percent-decoded'
)
ok(S.pathFromFileUri('file:///C:/Users/r/a.png') === 'C:\\Users\\r\\a.png', 'and as a Windows path')
ok(
  S.pathFromFileUri('file://server/share/a.png') === '\\\\server\\share\\a.png',
  'a host becomes a UNC path'
)
ok(S.pathFromFileUri('file://localhost/Users/r/a.png') === '/Users/r/a.png', 'localhost is this machine')
// A decoded control byte is refused outright. `%0A` is a real newline, the path is typed at a
// pty through `quote` (which escapes double quotes and nothing else), so this would hand the
// agent a torn line with the tail read as its own command. Stripping would name a file that
// does not exist, so it is refused and the drop says nothing was readable.
ok(S.pathFromFileUri('file:///tmp/foo%0Abar.txt') === '', 'a decoded newline is refused, not typed')
ok(S.pathFromFileUri('file:///tmp/foo%0D%0Arm%20-rf.txt') === '', 'and so is a CRLF')
ok(S.pathFromFileUri('file:///tmp/a%09b.txt') === '', 'and a tab')
ok(S.splitDropUris('file:///tmp/foo%0Abar.txt').paths.length === 0, 'so the drop carries no path')
ok(S.pathFromFileUri('https://x.test/a.png') === '', 'an http URI is not a path')
ok(S.pathFromFileUri('a sentence somebody dragged') === '', 'and neither is dragged text')

const split = S.splitDropUris(
  '# a uri-list may carry comments\nfile:///Users/r/a%20b.png\nhttps://x.test/i.png\nmailto:nobody@x.test\n\n'
)
ok(split.paths.length === 1 && split.paths[0] === '/Users/r/a b.png', 'the file goes to the path list')
ok(split.uris.length === 1 && split.uris[0] === 'https://x.test/i.png', 'the http one goes to be fetched')
ok(
  S.splitDropUris('just some words').paths.length === 0 &&
    S.splitDropUris('just some words').uris.length === 0,
  'a plain text drag is claimed by neither - it stays Chromium own paste'
)

console.log('')
console.log(fail.length ? `FAILED ${fail.length}` : 'all attach checks passed')
process.exit(fail.length ? 1 : 0)
