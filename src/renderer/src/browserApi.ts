/**
 * `window.api`, over HTTP, for the copy of this UI a phone loads.
 *
 * The same object the preload exposes, built from the same list (`shared/surface.ts`) -
 * so there is no second surface to keep in step and no method a phone quietly cannot
 * reach. What differs is only the wire:
 *
 * - **Events arrive on one EventSource** (`/pf/events`). It reconnects by itself, which
 *   is the whole reason for choosing it: a phone locks its screen, drops the socket, and
 *   comes back to a live desk without anything here noticing.
 * - **`send` is queued, never fired straight off.** Typing is one `send` per keystroke and
 *   they must land in order; separate `fetch` calls do not promise that. So sends go into
 *   a batch, one request is in flight at a time, and everything typed while it flies rides
 *   the next one - which also collapses a burst of keystrokes into a single POST.
 * - **`invoke` is its own request** and resolves with what main returned, or rejects with
 *   the sentence main threw.
 *
 * `install()` resolves once the event stream is open, so the UI does not paint a desk
 * before the first `sessions:changed` could arrive.
 */

import type { Api } from '@shared/types'
import { buildApi, type Transport } from '@shared/surface'
import type { LinkState } from '@shared/linkState'
import { decodeWire, encodeWire } from '@shared/wireJson'
import { unlock } from './passkeyClient'

/** How long the stream may be silent before it is treated as gone. Server pings at 15s. */
const STALE_MS = 45_000

type Handler = (...args: unknown[]) => void

class HttpTransport implements Transport {
  private handlers = new Map<string, Set<Handler>>()
  private queue: { channel: string; args: unknown[] }[] = []
  private flushing = false
  private source: EventSource | null = null
  private lastSeen = 0
  /** Has a stream ever been up? The second one onwards has a gap behind it. */
  private opened = false
  private nextId = 1
  /** Is the stream carrying anything? Pushed to the UI - see shared/linkState.ts. */
  private up = false

  /**
   * Tell this screen whether the desk is still answering.
   *
   * Sent on the transport's own `link:state` channel rather than over the wire, because
   * the whole point is the moments when nothing is coming over the wire. The desk build
   * registers the same channel on IPC, where nothing ever sends it - a window looking at
   * its own machine has no link to lose.
   */
  private sayLink(up: boolean): void {
    if (up) this.lastSeen = Date.now()
    // Deduped both ways: the stale timer says "still down" every 15s and the banner
    // keeps its own clock, so re-emitting the same verdict only costs renders.
    if (up === this.up) return
    this.up = up
    const state: LinkState = { up, lastSeen: this.lastSeen }
    for (const h of this.handlers.get('link:state') ?? []) h(state)
  }

  /** Open the event stream. Resolves on the server's hello, or on its first failure. */
  async open(): Promise<void> {
    await new Promise<void>((resolve) => {
      const source = new EventSource('/pf/events')
      this.source = source
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      source.onopen = () => {
        this.sayLink(true)
        // A reconnect starts a NEW stream, and every event sent while the old one was
        // down is gone - a phone in a pocket loses its stream constantly. Nothing re-read
        // the list afterwards, so a pane closed at the desk stayed on the phone's screen
        // for ever, and pressing Close on it asked main to kill an id it no longer has:
        // nothing happened, and nothing could. The truth is one call away, so ask for it
        // every time the stream comes up rather than trusting a stream that was down.
        // Not `settled`: the stale timer opens a BRAND NEW EventSource whose first open is
        // also a reconnect, and that is exactly the case this exists for.
        if (this.opened) void this.resync()
        this.opened = true
        done()
      }
      source.onmessage = (ev: MessageEvent<string>) => {
        this.sayLink(true)
        done()
        let frame: { channel?: string; args?: unknown[] }
        try {
          frame = decodeWire(ev.data) as { channel?: string; args?: unknown[] }
        } catch {
          return
        }
        if (!frame.channel) return
        for (const h of this.handlers.get(frame.channel) ?? []) h(...(frame.args ?? []))
      }
      // A 401 arrives as an error, not a message: the cookie expired mid-session, which
      // means the code was rotated. The pairing page is what should be on screen.
      source.onerror = () => {
        this.sayLink(false)
        if (!settled) {
          void fetch('/pf/events', { method: 'HEAD' }).then((r) => {
            if (r.status === 401) location.reload()
          })
        }
        done()
      }
      // The browser reconnects on its own, but a stream that is up and silent is worse
      // than one that is down - nothing repaints and nothing says why.
      setInterval(() => {
        if (this.lastSeen && Date.now() - this.lastSeen > STALE_MS) {
          // Say it BEFORE the reopen: a phone whose desk has gone to sleep loops through
          // here for as long as the machine is out, and this is the only moment anything
          // knows the rows on screen are a photograph.
          this.sayLink(false)
          this.lastSeen = Date.now()
          this.source?.close()
          void this.open()
        }
      }, STALE_MS / 3)
      // The banner offers a Reconnect button, and the honest thing for it to do is what
      // the stale timer does: throw this stream away and open a new one, which re-runs
      // `resync` on the way up. Exposed on `window` rather than through the api object
      // because the api is built from `shared/surface.ts`, which is the list of channels
      // that reach MAIN - and this one never leaves the browser.
      ;(window as unknown as { __pfReconnect?: () => void }).__pfReconnect = () => {
        this.sayLink(false)
        this.source?.close()
        void this.open()
      }
      // A phone does not close its tab, it BACKGROUNDS it - and iOS then suspends both
      // the EventSource and the timer above, so the stale check that was meant to notice
      // is itself asleep. Coming back to the tab is the one moment a handset is certainly
      // running, so it re-reads the desk on the spot rather than waiting up to 15s for a
      // throttled timer to fire. That is "lag, not running mobile refresh".
      if (typeof document !== 'undefined') {
        const woke = (): void => {
          if (document.visibilityState !== 'visible') return
          if (this.lastSeen && Date.now() - this.lastSeen > STALE_MS / 3) {
            this.source?.close()
            void this.open()
            return
          }
          void this.resync()
        }
        document.addEventListener('visibilitychange', woke)
        window.addEventListener('pageshow', woke)
        window.addEventListener('online', woke)
      }
    })
  }

  /**
   * Re-read what the desk actually has, after a gap in the event stream.
   *
   * Only the session list: it is the one piece of state that decides what is on screen
   * AND that every other view is keyed by, and it is small. A failure is silent on
   * purpose - the stream that just came up will carry the next change anyway.
   */
  private async resync(): Promise<void> {
    try {
      const list = await this.invoke('sessions:list', [])
      if (!Array.isArray(list)) return
      for (const h of this.handlers.get('sessions:changed') ?? []) h(list)
      // The session list is not the whole of what a phone counts. The sidebar's groups and
      // its badge count the OTHER machine's panes too, and those arrive on `remote:changed`
      // - an event, like the rest, so every one sent while the stream was down is gone and
      // the phone kept drawing rows from a device it had stopped hearing about. Reported
      // 2026-08-31 as "numbers/sessions may be wrong". Failure is silent and separate: a
      // desk with no paired device answers this fine and has nothing to say.
      const remote = await this.invoke('remote:state', [])
      if (remote) for (const h of this.handlers.get('remote:changed') ?? []) h(remote)
    } catch {
      // The list is the cheapest possible probe, so a failure here is also the fastest
      // proof the desk is not answering - and on a phone it is regularly the FIRST proof,
      // because a suspended EventSource never fires an error at all.
      this.sayLink(false)
    }
  }

  async invoke(channel: string, args: unknown[], retried = false): Promise<unknown> {
    // Anything already typed goes first: `write` then `sessions:buffer` must not swap.
    await this.flush()
    const id = this.nextId++
    let res: Response
    try {
      res = await fetch('/pf/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encodeWire({ id, channel, args })
      })
    } catch (e) {
      // The desk is not answering. Said out loud before the throw, or a phone whose Mac
      // went to sleep gets a failed button and no explanation anywhere on screen.
      this.sayLink(false)
      throw e
    }
    if (res.status === 401) {
      location.reload()
      throw new Error('not paired')
    }
    const body = decodeWire(await res.text()) as { value?: unknown; error?: string; locked?: boolean }
    // The typing gate. Answered in the envelope rather than as a status, because this reply
    // has an id the caller is waiting on. One retry and no more: if the touch was cancelled
    // the honest outcome is the error, not a second sheet.
    if (body.locked) {
      if (retried || !(await unlock())) throw new Error('locked')
      return await this.invoke(channel, args, true)
    }
    if (body.error) throw new Error(body.error)
    return body.value
  }

  send(channel: string, args: unknown[]): void {
    this.queue.push({ channel, args })
    void this.flush()
  }

  on(channel: string, handler: Handler): () => void {
    const set = this.handlers.get(channel) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(channel, set)
    return () => set.delete(handler)
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      // One request in flight at a time; the caller's items are already in the queue and
      // will ride the batch this one starts when it returns.
      while (this.flushing) await new Promise((r) => setTimeout(r, 4))
      if (!this.queue.length) return
    }
    if (!this.queue.length) return
    this.flushing = true
    const calls = this.queue
    this.queue = []
    let locked = false
    try {
      const res = await fetch('/pf/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encodeWire({ calls })
      })
      // 423 means the desk ran NOTHING in this batch - it refuses the whole thing rather
      // than the gated calls inside it. So the batch goes back on the FRONT of the queue,
      // ahead of anything typed since, and is re-sent intact once the touch lands. Dropping
      // it would deliver a word with letters missing; keeping order matters as much here as
      // it does on the way out.
      if (res.status === 423) {
        this.queue = [...calls, ...this.queue]
        locked = true
      }
    } catch {
      /* a dropped batch is a keystroke lost, not a broken app - the next one is sent */
    } finally {
      this.flushing = false
    }
    if (locked) {
      // A refused touch drops the batch on purpose: the user said no, and holding their
      // keystrokes to replay at some later unlock would type them at a moment they did not
      // choose. `unlock()` is shared, so a burst of refused batches raises one sheet.
      if (!(await unlock())) this.queue = this.queue.filter((c) => !calls.includes(c))
    }
    if (this.queue.length) await this.flush()
  }
}

/**
 * Put the object on `window` and open the stream. Called before anything imports App:
 * three modules read `window.api` at module scope, so the api has to exist first.
 */
export async function installBrowserApi(): Promise<void> {
  const transport = new HttpTransport()
  const api: Api = buildApi(transport, {
    // A browser has no path for a dropped file, and an empty string is what the desktop
    // answers when it cannot resolve one either.
    pathForFile: () => '',
    /**
     * The clipboard is the PHONE's, never the desk's.
     *
     * `copyText` is an ordinary channel, so over this transport it ran
     * `clipboard.writeText` in the main process - on the machine you are not holding.
     * Every copy made from a phone (the pane's "Copy output", a selection, a prompt)
     * silently landed on the Mac's clipboard and the phone's stayed as it was, which is
     * "I can't copy text from the output on mobile": the button worked, the bytes went
     * to the wrong device. A browser has its own clipboard and this is the one call that
     * must not cross the wire.
     *
     * `navigator.clipboard` needs a secure context, which the tunnel and Funnel paths
     * give and plain http over the LAN does not, so the fallback is the old
     * `execCommand('copy')` over an off-screen textarea - deprecated, still the only
     * thing that works on http, and it needs the user gesture that a copy button is.
     */
    copyText: (text: string) => {
      if (!text) return
      void (async () => {
        try {
          await navigator.clipboard.writeText(text)
          return
        } catch {
          /* insecure context, or permission refused - fall through */
        }
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
        document.body.appendChild(ta)
        ta.select()
        ta.setSelectionRange(0, text.length)
        try {
          document.execCommand('copy')
        } catch {
          /* nothing else to try; the text is still selectable in the sheet */
        }
        ta.remove()
      })()
    },
    /** ...and the same the other way: a paste on the phone is the phone's clipboard. */
    readClipboard: async () => {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return ''
      }
    }
  })
  ;(window as unknown as { api: Api }).api = api
  // This copy of the UI is a browser on somebody's phone, not the desk. A few things are
  // the DESK's to answer and must not be drawn here at all: see `isPhoneClient`.
  ;(window as unknown as { __pfPhone?: boolean }).__pfPhone = true
  await transport.open()
}
