// Turning raw terminal bytes into something a person - or another agent - can read.
//
// Two callers with two different problems. History has the WHOLE log in a string and
// wants it searchable. A live tee (`pipe.ts`) gets the same bytes in whatever pieces
// the pty hands over, and an escape sequence does not respect those pieces: `\x1b[3` in
// one chunk and `1m` in the next is one colour change, and stripping the halves
// separately leaves `1m` sitting in the file as text. So the streaming half holds an
// unfinished sequence back until the rest of it arrives.

/** Longest tail we will hold waiting for a terminator. */
const MAX_CARRY = 512

/**
 * Terminal output is full of escape sequences and cursor moves. Searching raw bytes
 * would miss "npm install" when the CLI painted it in colour, so strip the control
 * codes for search, for the transcript viewer, and for a text-mode tee.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (window titles)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colour, cursor)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>c]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

/**
 * The same strip, fed a chunk at a time.
 *
 * Everything it holds back is one of the two ways a chunk boundary lies about the
 * bytes: an escape sequence cut in half, and a lone `\r` that is either a carriage
 * return (becomes a newline) or the first half of a `\r\n` (stays put) depending on a
 * byte that has not arrived yet.
 */
export class AnsiStream {
  private carry = ''

  push(chunk: string): string {
    const raw = this.carry + chunk
    let cut = raw.length
    const esc = raw.lastIndexOf('\x1b')
    if (esc >= 0 && incompleteAt(raw, esc)) cut = esc
    // A trailing `\r` is undecidable: `\r\n` is a line ending and a bare `\r` is a
    // cursor return that reads as one. Only ever one character, and only when the
    // escape check did not already cut further back.
    else if (raw.endsWith('\r')) cut = raw.length - 1
    this.carry = raw.slice(cut)
    // A raw ESC byte in a binary stream (or a CLI that never finishes its sequence)
    // must not stall the tee for ever: past this length it is not a sequence.
    if (this.carry.length > MAX_CARRY) {
      const out = stripAnsi(raw)
      this.carry = ''
      return out
    }
    return stripAnsi(raw.slice(0, cut))
  }

  /** Nothing more is coming: emit whatever was being held. */
  end(): string {
    const rest = this.carry
    this.carry = ''
    return rest ? stripAnsi(rest) : ''
  }
}

/**
 * Is the escape sequence starting at `i` still waiting for the rest of itself?
 *
 * Only the last ESC in a chunk can be: any earlier one either finished before this
 * one started or swallowed it as a parameter byte.
 */
function incompleteAt(s: string, i: number): boolean {
  const rest = s.slice(i)
  if (rest.length < 2) return true
  const c = rest[1]
  // OSC - runs until BEL or ESC-backslash.
  if (c === ']') return !/[\x07]|\x1b\\/.test(rest.slice(2))
  // CSI - parameter and intermediate bytes, then one final byte.
  if (c === '[') return !/^\x1b\[[0-9;?]*[ -/]*[@-~]/.test(rest)
  // Character-set selection takes exactly one more byte.
  if (c === '(' || c === ')') return rest.length < 3
  return false
}
