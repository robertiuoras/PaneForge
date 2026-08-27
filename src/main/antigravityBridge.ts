// Where Antigravity CLI's context size comes from, because it comes from nowhere else.
//
// Antigravity CLI (1.1.19) writes no token counts anywhere on disk: not in
// `~/.gemini/antigravity-cli/conversations`, not in its logs, not in `state.json`. The
// only place the number exists outside the TUI is the JSON it pipes to the user's
// statusline hook on every redraw - `.context_window.total_input_tokens`,
// `.context_window.used_percentage`, `.context_window.context_window_size`.
//
// A statusline hook CONSUMES that stdin. Whatever reads it first is the only thing that
// ever sees it, so PaneForge cannot simply run its own hook alongside: there is one
// stdin and one hook. Hence a tee, spliced into the front of whatever script is already
// there, writing one line per redraw to a file the app polls. The original script's
// output is untouched - stdin is handed back to it byte for byte - which is the whole
// contract here: this edits somebody else's file, on their machine, that draws their
// prompt, and a bridge that breaks the status line to save some tokens is not a trade
// anybody agreed to.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the CLI keeps its state, and so where its statusline hook lives. */
export function antigravityDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli')
}

/** The file the tee appends to, and the file `autoclearWatch.ts` reads. */
export const PF_CONTEXT_FILE = 'pf-context.jsonl'

const START = '# >>> paneforge autoclear bridge >>>'
const END = '# <<< paneforge autoclear bridge <<<'

/**
 * The spliced block, generated fresh every time so an install that predates a fix to it
 * is REPLACED rather than left to rot. Everything in it is bash 3.2, which is what macOS
 * ships as /bin/bash, and it spawns nothing in the common path - no jq, no date, no cat
 * of the log - because it runs on every single redraw of somebody's prompt.
 */
function block(): string {
  return [
    START,
    '# PaneForge reads this session\'s context size from the JSON below and clears the pane',
    '# itself once it is past the line. Antigravity CLI publishes that number nowhere else,',
    '# and a statusline hook CONSUMES its stdin - so it is teed here and handed straight',
    '# back. Everything below this block runs exactly as it did before.',
    '# Managed: `node scripts/antigravity-bridge.mjs` rewrites between these two markers.',
    '__pf_dir="${BASH_SOURCE[0]}"',
    'case "$__pf_dir" in */*) __pf_dir="${__pf_dir%/*}" ;; *) __pf_dir="." ;; esac',
    `__pf_log="$__pf_dir/${PF_CONTEXT_FILE}"`,
    '__pf_json="$(cat)"',
    "if ! printf -v __pf_s '%(%s)T' -1 2>/dev/null || [ -z \"$__pf_s\" ]; then __pf_s=$(date +%s); fi",
    '# One object per line. A raw newline cannot appear inside a JSON string - it has to be',
    "# escaped - so flattening the input is safe, and it means no jq spawn on a redraw.",
    '__pf_one="${__pf_json//$\'\\n\'/}"',
    'case "$__pf_one" in',
    "  '{'*)",
    '    __pf_rest="${__pf_one#\\{}"',
    '    case "$__pf_rest" in',
    "      ''|\\}*) printf '{\"pf_ts\":%s000}\\n' \"$__pf_s\" >> \"$__pf_log\" 2>/dev/null ;;",
    "      *) printf '{\"pf_ts\":%s000,%s\\n' \"$__pf_s\" \"$__pf_rest\" >> \"$__pf_log\" 2>/dev/null ;;",
    '    esac',
    '    # Trimmed at 400 down to 200, not at 200: nothing reads past the newest row, and',
    '    # this way the rewrite costs two spawns once every 200 redraws instead of every one.',
    '    __pf_n=$(wc -l < "$__pf_log" 2>/dev/null || echo 0)',
    '    if [ "${__pf_n:-0}" -gt 400 ] 2>/dev/null; then',
    '      tail -n 200 "$__pf_log" > "$__pf_log.pf-tmp" 2>/dev/null && mv "$__pf_log.pf-tmp" "$__pf_log"',
    '    fi',
    '    ;;',
    'esac',
    '# The same bytes, handed back: `cat` above emptied stdin and every line below still',
    '# expects to read the session JSON from it.',
    'exec 0< <(printf \'%s\' "$__pf_json")',
    END
  ].join('\n')
}

/** What a machine with no statusline hook at all gets: the tee, and no output. */
function minimal(): string {
  return ['#!/usr/bin/env bash', '# Written by PaneForge - there was no statusline hook here.', block(), ''].join(
    '\n'
  )
}

export interface BridgeResult {
  path: string
  /** There was no statusline hook and one was written. */
  created: boolean
  /** The file on disk changed. False on the second run - that is the idempotency. */
  changed: boolean
  /** A `.pf-backup` was taken this time round. Only ever happens once. */
  backedUp: boolean
  /** Why nothing was done, when nothing was done. */
  skipped?: string
}

/**
 * Splice the tee into the front of the statusline hook, or leave it exactly as it is.
 *
 * Idempotent by construction: the block is delimited by markers and the region between
 * them is REPLACED, never appended to, so running this at every app start cannot stack
 * copies of it - which is the failure this shape exists to prevent, given the alternative
 * is somebody's prompt script growing a new tee every launch.
 *
 * The original is copied to `statusline.sh.pf-backup` before the first edit and never
 * overwritten afterwards, so the backup stays the file the user wrote rather than the
 * file we wrote last week.
 */
export function ensureAntigravityBridge(dir = antigravityDir()): BridgeResult {
  const path = join(dir, 'statusline.sh')
  const out: BridgeResult = { path, created: false, changed: false, backedUp: false }
  // Only where the CLI is actually installed. Creating `~/.gemini/antigravity-cli` on a
  // machine that has never run Antigravity would leave a folder that looks like state for
  // a tool that is not there.
  if (!existsSync(dir)) {
    out.skipped = 'antigravity is not installed here'
    return out
  }
  let before = ''
  if (existsSync(path)) {
    try {
      before = readFileSync(path, 'utf8')
    } catch {
      out.skipped = 'the statusline hook could not be read'
      return out
    }
  }

  let next: string
  if (!before.trim()) {
    next = minimal()
    out.created = true
  } else if (before.includes(START) && before.includes(END)) {
    const head = before.slice(0, before.indexOf(START))
    const tail = before.slice(before.indexOf(END) + END.length)
    next = head + block() + tail
  } else {
    // After the shebang, never before it: a `#!` line that is not the first two bytes of
    // the file is not a shebang, and the hook would then run under whatever shell called
    // it. Everything else goes in at the top, because the tee has to reach stdin before
    // the original script's own `read` does.
    const lines = before.split('\n')
    const at = lines[0]?.startsWith('#!') ? 1 : 0
    lines.splice(at, 0, block())
    next = lines.join('\n')
  }
  if (next === before) return out

  try {
    mkdirSync(dir, { recursive: true })
    if (before && !existsSync(path + '.pf-backup')) {
      copyFileSync(path, path + '.pf-backup')
      out.backedUp = true
    }
    // Write-then-rename, and the mode is carried over: a statusline hook that loses its
    // execute bit is a prompt that prints an error on every redraw.
    const mode = before ? statSync(path).mode : 0o755
    const tmp = path + '.pf-tmp'
    writeFileSync(tmp, next, 'utf8')
    chmodSync(tmp, mode)
    renameSync(tmp, path)
    out.changed = true
  } catch (e) {
    out.skipped = `could not write the statusline hook: ${String(e)}`
  }
  return out
}
