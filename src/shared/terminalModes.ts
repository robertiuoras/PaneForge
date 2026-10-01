/** DEC modes in the discarded part of a terminal replay, without retaining its text. */
export class TerminalModes {
  private alt = 0
  private mouse = 0
  private sgr = false
  private paste = false
  private state: 'text' | 'escape' | 'csi' | 'ignoreCsi' | 'string' | 'stringEscape' = 'text'
  private params = ''
  private osc = false

  get alternate(): boolean { return this.alt !== 0 }

  consume(data: string): void {
    // Most of a replay is printable output. Let the native regexp scan those runs
    // instead of branching in JavaScript for every character of each capped log.
    const introducer = /[\x1b\x90\x98\x9b\x9d\x9e\x9f]/g
    for (let i = 0; i < data.length; i++) {
      if (this.state === 'text') {
        introducer.lastIndex = i
        const next = introducer.exec(data)
        if (!next) break
        i = next.index
      }
      const ch = data[i]
      const code = data.charCodeAt(i)
      if (ch === '\x18' || ch === '\x1a') {
        this.state = 'text'
        this.params = ''
        continue
      }
      if (this.state === 'string' || this.state === 'stringEscape') {
        if ((this.osc && ch === '\x07') || ch === '\x9c' || (this.state === 'stringEscape' && ch === '\\')) this.state = 'text'
        else this.state = ch === '\x1b' ? 'stringEscape' : 'string'
        continue
      }
      if (ch === '\x1b') { this.state = 'escape'; this.params = ''; continue }
      if (ch === '\x9b') { this.state = 'csi'; this.params = ''; continue }
      if (ch === '\x90' || ch === '\x9d' || ch === '\x98' || ch === '\x9e' || ch === '\x9f') {
        this.state = 'string'
        this.osc = ch === '\x9d'
        continue
      }
      if (this.state === 'escape') {
        if (ch === '[') this.state = 'csi'
        else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') {
          this.state = 'string'
          this.osc = ch === ']'
        }
        else {
          if (ch === 'c') { this.alt = 0; this.mouse = 0; this.sgr = false; this.paste = false }
          this.state = 'text'
        }
      } else if (this.state === 'csi' || this.state === 'ignoreCsi') {
        if (code >= 0x40 && code <= 0x7e) {
          if (this.state === 'csi' && (ch === 'h' || ch === 'l') && /^\?[\d;]+$/.test(this.params)) {
            for (const param of this.params.slice(1).split(';')) {
              const mode = Number(param)
              const on = ch === 'h'
              if (mode === 47 || mode === 1047 || mode === 1049) this.alt = on ? mode : 0
              else if (mode === 9 || mode === 1000 || mode === 1002 || mode === 1003) this.mouse = on ? mode : 0
              else if (mode === 1006) this.sgr = on
              else if (mode === 2004) this.paste = on
            }
          }
          this.state = 'text'
          this.params = ''
        } else if (this.state === 'csi' && code >= 0x20) {
          if (this.params.length < 128) this.params += ch
          else { this.state = 'ignoreCsi'; this.params = '' }
        }
      }
    }
  }

  /** Only mode setters are restored. Queries, OSC and other discarded commands never replay. */
  restorePrefix(tail = ''): string {
    const modes = [this.alt, this.mouse, this.sgr ? 1006 : 0, this.paste ? 2004 : 0].filter(Boolean)
    let prefix = modes.length ? `\x1b[?${modes.join(';')}h` : ''
    // Resume an ignored string using an unsupported command, never its original
    // command (which could be a clipboard operation or a terminal query).
    if (this.state === 'string' || this.state === 'stringEscape') {
      return prefix + (this.osc ? '\x1b]999;' : '\x1bP0z') + (this.state === 'stringEscape' ? '\x1b' : '')
    }
    // A clipping boundary can bisect a mode setter. Complete only a verified, bounded
    // setter (or RIS), otherwise do not revive a discarded query or arbitrary escape.
    const pending = this.state === 'escape' ? '\x1b' : this.state === 'csi' ? `\x1b[${this.params}` : ''
    if (pending) {
      const command = (pending + tail.slice(0, 132)).match(/^\x1b\[\?([\d;]+)[hl]/)
      if ((pending === '\x1b' && tail.startsWith('c')) || (command && command[1].split(';').every((n) => [9, 47, 1047, 1049, 1000, 1002, 1003, 1006, 2004].includes(Number(n))))) prefix += pending
    }
    return prefix
  }
}
