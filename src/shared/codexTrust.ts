// Codex opens on "Do you trust the contents of this directory?" in any folder its
// config.toml does not list, and a pane this app was asked to open is a folder the person
// already chose - the same reasoning as `shared/agyTrust.ts`. On a new machine there is no
// config.toml at all, so the first Codex pane of all sits on that question.
//
// Codex keeps the answer as one table per folder in `$CODEX_HOME/config.toml`:
//   Mac/Linux  [projects."/Users/me/Projects/app"]      path as given
//   Windows    [projects.'c:\users\me\projects\app']    lowercased, literal string
// (read off both machines' real files on 2026-09-24, Codex 0.156.1.) Only
// `trust_level = "trusted"` is written; everything else in the file is left byte for byte,
// because Codex rewrites this file itself and a parse-and-reserialise would reformat it.
//
// Pure here so the rules can be asserted without a file; `main/codexTrust.ts` touches disk.
// No imports: the test bundles this file on its own.

/** The folder as Codex keys it, or null for a path Codex could never match. */
export function codexProjectKey(cwd: string, win: boolean): string | null {
  if (!cwd || !cwd.trim() || /[\u0000-\u001f]/.test(cwd)) return null
  if (win) {
    const p = cwd.replace(/\//g, '\\')
    if (!/^[a-zA-Z]:\\/.test(p)) return null
    return (p.length > 3 ? p.replace(/\\+$/, '') : p).toLowerCase()
  }
  if (!cwd.startsWith('/')) return null
  return cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
}

/** The table header Codex would write for this folder. */
export function codexProjectHeader(key: string, win: boolean): string {
  // A literal string cannot hold a quote, so a folder with one gets the escaped form.
  if (win && !key.includes("'")) return `[projects.'${key}']`
  return `[projects."${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

const HEADER = /^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/

/** Every `[projects.X]` table in the file with the trust level it sets, if any. */
function projects(text: string): { key: string; trust: string | null }[] {
  const out: { key: string; trust: string | null }[] = []
  let current: { key: string; trust: string | null } | null = null
  for (const line of text.split(/\r?\n/)) {
    const h = HEADER.exec(line)
    if (h) {
      const q = h[1]
      const key = q.startsWith("'") ? q.slice(1, -1) : q.slice(1, -1).replace(/\\(["\\])/g, '$1')
      current = { key, trust: null }
      out.push(current)
      continue
    }
    if (/^\s*\[/.test(line)) {
      current = null
      continue
    }
    const t = current && /^\s*trust_level\s*=\s*["']([^"']*)["']/.exec(line)
    if (t && current) current.trust = t[1]
  }
  return out
}

/**
 * The config.toml text that trusts `cwd`, or null when nothing should be written.
 *
 * `text` is the file as it is now, or null when there is no file (a machine Codex has
 * never run on) - then the answer is a file holding just this folder.
 *
 * Null, and the file stays as it is, when:
 *  - the folder already has a table, trusted OR untrusted: an "untrusted" there is the
 *    person's own answer and is never overridden;
 *  - a folder above it is explicitly untrusted (Codex refuses anything inside one);
 *  - the file keeps projects in a form an appended table would collide with
 *    (`projects = {...}` or a bare `[projects]` table);
 *  - the path is not one Codex could match.
 */
export function withCodexTrust(text: string | null, cwd: string, win: boolean): string | null {
  const key = codexProjectKey(cwd, win)
  if (!key) return null
  const body = text ?? ''
  if (/^\s*projects\s*=/m.test(body) || /^\s*\[\s*projects\s*\]/m.test(body)) return null
  const same = (k: string): string => (win ? k.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : k.replace(/\/+$/, ''))
  const sep = win ? '\\' : '/'
  for (const p of projects(body)) {
    const k = same(p.key)
    if (k === key) return null
    if (p.trust === 'untrusted' && key.startsWith(k.endsWith(sep) ? k : k + sep)) return null
  }
  const nl = body.includes('\r\n') ? '\r\n' : '\n'
  const section = `${codexProjectHeader(key, win)}${nl}trust_level = "trusted"${nl}`
  const kept = body.replace(/\s+$/, '')
  return kept ? `${kept}${nl}${nl}${section}` : section
}
