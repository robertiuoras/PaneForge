/**
 * Putting an image in front of the agent, from wherever the image is.
 *
 * A screenshot on the clipboard has no path, and a CLI reads its images off the disk -
 * so every agent here takes "look at this picture" as a path typed at the prompt. Claude
 * Code can read the OS clipboard itself when it sees a raw ^V, which is why the pane used
 * to forward that key and stop there. Two things that does not survive:
 *
 *  - **Codex, and every other agent on the list of thirteen**, which has no clipboard
 *    reader at all. ^V arrives as a literal control byte and nothing happens.
 *  - **A mirrored pane.** The clipboard is on the device you are sitting at and the pty is
 *    on the other one, so the agent reads the WRONG machine's clipboard - and a file
 *    dragged onto that pane typed a path the far machine has never heard of. That is the
 *    whole bug: a Mac screenshot path handed to an agent running on the PC, which reads as
 *    a missing file rather than as an error anybody can act on.
 *
 * So the bytes are written as a real file **on the machine that owns the pty**, and the
 * path of THAT file is what gets typed. This module is the part with no Electron and no
 * Node in it: what a saved attachment is called, and which of them are litter.
 */

/**
 * The largest attachment that goes over the device link in one frame.
 *
 * `MAX_FRAME` in `main/remote/wire.ts` is 8 MB and the bytes travel base64'd, which is
 * 4/3 of the size - so 5 MB raw is the biggest that cannot possibly overrun it. A phone
 * screenshot is ~200 KB and a 4K PNG of a full desktop is ~2 MB, so this is not a limit
 * anybody meets by accident; the point of having one is that a 90 MB video dropped on a
 * pane fails with a sentence rather than killing the link.
 */
export const ATTACH_MAX_BYTES = 5 * 1024 * 1024

/** How many saved attachments are kept. Older ones are deleted on the next write. */
export const ATTACH_KEEP = 200

/** A file on its way to a pane. `data` is base64 - JSON is the only wire there is. */
export interface AttachIn {
  name: string
  data: string
}

/** What came of one. `path` is on the pane's machine; `error` is a sentence for a person. */
export interface AttachResult {
  paths: string[]
  error?: string
}

/** Magic bytes, in the order they are tested. Long signatures first. */
const MAGIC: [string, number[]][] = [
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['pdf', [0x25, 0x50, 0x44, 0x46]],
  ['jpg', [0xff, 0xd8, 0xff]],
  ['bmp', [0x42, 0x4d]]
]

/**
 * The extension the CONTENT says it is, or '' when nothing is recognised.
 *
 * Off the bytes rather than off the name because the name is the least trustworthy thing
 * about a drop: a clipboard image arrives with no name at all, a browser drag names an
 * image `download`, and an agent that opens a file by extension gets it wrong for both.
 */
export function sniffExt(bytes: Uint8Array): string {
  for (const [ext, sig] of MAGIC) {
    if (bytes.length < sig.length) continue
    let ok = true
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) {
        ok = false
        break
      }
    }
    if (ok) return ext
  }
  // RIFF....WEBP - the only one that needs two windows.
  if (bytes.length >= 12) {
    const riff = [0x52, 0x49, 0x46, 0x46]
    const webp = [0x57, 0x45, 0x42, 0x50]
    if (riff.every((b, i) => bytes[i] === b) && webp.every((b, i) => bytes[8 + i] === b)) {
      return 'webp'
    }
  }
  return ''
}

/** `20260814-180533` - sortable, so pruning by name is pruning by age. */
export function stamp(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** The prefix every attachment this app writes carries, and nothing else does. */
export const ATTACH_RE = /^\d{8}-\d{6}-\d+-/

/** Punctuation no filesystem here takes. Separators are gone by then - basename only. */
const BAD_IN_NAME = ':*?"<>|'

/**
 * What one attachment is saved as.
 *
 * The incoming name is treated as TEXT, never as a path: a drop can name itself
 * `../../.ssh/authorized_keys` and the only thing standing between that and a write is
 * this function, so separators, drive letters, `..` and control bytes all come out as
 * `_` and only the basename survives. The stamp and a sequence number make collisions
 * impossible without a stat, which matters because two screenshots pasted a second apart
 * are the ordinary case.
 */
export function attachName(name: string, bytes: Uint8Array, at: number, seq: number): string {
  const raw = String(name ?? '')
  // Basename only - both separators, whichever machine the drop came from.
  const base = raw.split(/[\\/]/).pop() ?? ''
  // Control bytes are dropped and the reserved punctuation becomes _. Written as a
  // loop rather than a regex: a class of raw control characters in a source file is
  // invisible to every later grep over it, which is its own kind of trap.
  let safe = ''
  for (const ch of base) {
    const c = ch.charCodeAt(0)
    if (c < 0x20 || c === 0x7f) continue
    safe += BAD_IN_NAME.includes(ch) ? '_' : ch
  }
  safe = safe.replace(/\s+/g, ' ').trim()
  // A name that was nothing but punctuation, or `..`, leaves nothing usable.
  if (!safe || /^\.+$/.test(safe)) safe = 'pasted'
  const dot = safe.lastIndexOf('.')
  const named = dot > 0 ? safe.slice(dot + 1).toLowerCase() : ''
  const stem = (dot > 0 ? safe.slice(0, dot) : safe).slice(0, 60) || 'pasted'
  const real = sniffExt(bytes)
  // The content wins when it disagrees, and supplies one when the name has none. A name
  // whose extension we cannot verify (`.txt`, `.md`) is kept as given.
  const ext = real || named
  return `${stamp(at)}-${seq}-${stem}${ext ? `.${ext}` : ''}`
}

/**
 * Which saved attachments to delete, newest kept.
 *
 * Only files this app wrote are considered: anything without the stamp prefix was put in
 * that folder by a person and deleting it would be the app tidying up after somebody who
 * did not ask.
 */
export function pruneList(names: string[], keep = ATTACH_KEEP): string[] {
  const ours = names.filter((n) => ATTACH_RE.test(n)).sort()
  return ours.length <= keep ? [] : ours.slice(0, ours.length - keep)
}

/**
 * A dropped `file://` URI as a path on the machine the drop happened on, or '' when the
 * URI is not one.
 *
 * This is the half of a drop that had no code at all, and the gap was silent: macOS hands
 * a screenshot dragged from its own preview thumbnail (and Finder hands a file dragged
 * with the Option key) as `text/uri-list` carrying `file:///…` and NO `File` object, so
 * the pane's dragover - which only accepted a drop when `types` held `Files` - never
 * claimed the drag, Chromium ran its default action, and the URL was typed into xterm's
 * helper textarea as text. What reached the agent was the sentence
 * `file:///var/folders/…/Screenshot%202026-08-17%20at%2017.48.55.png`, which is a link
 * shaped like an attachment: it looks handled and no agent here can open it.
 *
 * Percent-decoded (a screenshot's name is full of `%20`), and Windows' extra leading slash
 * before a drive letter removed. A `file://host/share` URI keeps its host as a UNC path,
 * which is what Windows means by it; `localhost` is spelled out in URIs and means this
 * machine, so it is dropped rather than turned into `\\localhost\…`.
 */
export function pathFromFileUri(uri: string): string {
  const raw = String(uri ?? '').trim()
  if (!/^file:\/\//i.test(raw)) return ''
  let rest = raw.slice('file://'.length)
  // Strip a query/fragment nothing on disk has, then decode.
  rest = rest.replace(/[?#].*$/, '')
  let host = ''
  if (!rest.startsWith('/')) {
    const cut = rest.indexOf('/')
    host = cut === -1 ? rest : rest.slice(0, cut)
    rest = cut === -1 ? '' : rest.slice(cut)
    if (/^localhost$/i.test(host)) host = ''
  }
  let path = ''
  try {
    path = decodeURIComponent(rest)
  } catch {
    // A stray `%` that is not an escape - the raw text is still a better guess than nothing.
    path = rest
  }
  if (host) return `\\\\${host}${path.replace(/\//g, '\\')}`
  // `file:///C:/x` is `C:\x`; on POSIX the leading slash is the path.
  if (/^\/[a-zA-Z]:[\\/]/.test(path)) return path.slice(1).replace(/\//g, '\\')
  return path
}

/**
 * Split what a drop's `text/uri-list` carried into the two things a pane does with them:
 * files already on this disk (typed as a path, nothing copied), and remote or inline URIs
 * whose bytes have to be fetched first.
 *
 * Anything else - a dragged word, a `mailto:`, a bare sentence - is left out entirely
 * rather than passed on as text: a drop is "put this in front of the agent", and a drag of
 * plain text is Chromium's own paste, which still works because the pane never claims that
 * drag.
 */
export function splitDropUris(list: string): { paths: string[]; uris: string[] } {
  const paths: string[] = []
  const uris: string[] = []
  for (const line of String(list ?? '').split(/\r?\n/)) {
    const uri = line.trim()
    // A uri-list may carry comment lines, by its own spec.
    if (!uri || uri.startsWith('#')) continue
    const path = pathFromFileUri(uri)
    if (path) {
      paths.push(path)
      continue
    }
    if (/^(https?:|data:)/i.test(uri)) uris.push(uri)
  }
  return { paths, uris }
}

/** Total size of a batch, from the base64 without decoding it. */
export function batchBytes(files: AttachIn[]): number {
  let total = 0
  for (const f of files) {
    const b64 = String(f?.data ?? '')
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
    total += Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
  }
  return total
}

/** The refusal, worded for the person who dropped it, or '' when the batch is fine. */
export function tooBig(files: AttachIn[]): string {
  const size = batchBytes(files)
  if (size <= ATTACH_MAX_BYTES) return ''
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`
  return `That is ${mb(size)}; a pane takes up to ${mb(ATTACH_MAX_BYTES)} at once.`
}
