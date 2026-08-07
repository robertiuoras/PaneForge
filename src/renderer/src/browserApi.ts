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
import { decodeWire, encodeWire } from '@shared/wireJson'

/** How long the stream may be silent before it is treated as gone. Server pings at 15s. */
const STALE_MS = 45_000

type Handler = (...args: unknown[]) => void

class HttpTransport implements Transport {
  private handlers = new Map<string, Set<Handler>>()
  private queue: { channel: string; args: unknown[] }[] = []
  private flushing = false
  private source: EventSource | null = null
  private lastSeen = 0
  private nextId = 1

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
        this.lastSeen = Date.now()
        done()
      }
      source.onmessage = (ev: MessageEvent<string>) => {
        this.lastSeen = Date.now()
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
          this.lastSeen = Date.now()
          this.source?.close()
          void this.open()
        }
      }, STALE_MS / 3)
    })
  }

  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    // Anything already typed goes first: `write` then `sessions:buffer` must not swap.
    await this.flush()
    const id = this.nextId++
    const res = await fetch('/pf/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encodeWire({ id, channel, args })
    })
    if (res.status === 401) {
      location.reload()
      throw new Error('not paired')
    }
    const body = decodeWire(await res.text()) as { value?: unknown; error?: string }
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
    try {
      await fetch('/pf/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encodeWire({ calls })
      })
    } catch {
      /* a dropped batch is a keystroke lost, not a broken app - the next one is sent */
    } finally {
      this.flushing = false
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
    pathForFile: () => ''
  })
  ;(window as unknown as { api: Api }).api = api
  await transport.open()
}
