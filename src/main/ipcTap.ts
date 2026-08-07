/**
 * A second caller for the handlers the window already talks to.
 *
 * The phone client (`phone.ts`) answers the identical `window.api`, so every one of its
 * calls has to reach the same `ipcMain.handle` / `ipcMain.on` body the window's would -
 * not a copy of it. Electron has no public way to call your own handler: `ipcMain` is an
 * EventEmitter for `on`, but `handle` keeps its map private (`_invokeHandlers`), and
 * reaching into that is a rename away from breaking in silence.
 *
 * So this records the registrations as they happen. `tapIpc()` has to run BEFORE the
 * handlers register - it is called at the top of `index.ts`, above them - and after that
 * `callInvoke`/`callSend` are the door in for anything that is not a renderer.
 *
 * The event object: 134 of the 135 handlers here ignore it (`_e`). The one that does not
 * is `recents:drag`, which hands a file to the OS drag layer through `e.sender` - a
 * desktop gesture with no meaning on a phone. It gets a sender that says it is gone, so
 * it refuses rather than throwing into the request.
 */

import { ipcMain } from 'electron'

type Invoker = (event: unknown, ...args: unknown[]) => unknown
type Listener = (event: unknown, ...args: unknown[]) => void

const invokers = new Map<string, Invoker>()
const listeners = new Map<string, Listener[]>()
let tapped = false

/** Patch ipcMain so every registration is also remembered here. Idempotent. */
export function tapIpc(): void {
  if (tapped) return
  tapped = true

  const realHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, fn: Invoker) => {
    invokers.set(channel, fn)
    return realHandle(channel, fn as never)
  }) as typeof ipcMain.handle

  const realOn = ipcMain.on.bind(ipcMain)
  ipcMain.on = ((channel: string, fn: Listener) => {
    const list = listeners.get(channel)
    if (list) list.push(fn)
    else listeners.set(channel, [fn])
    return realOn(channel, fn as never)
  }) as typeof ipcMain.on
}

/** Channels a non-renderer caller can reach - what the tap actually saw register. */
export function tappedChannels(): { invoke: string[]; send: string[] } {
  return { invoke: [...invokers.keys()], send: [...listeners.keys()] }
}

/**
 * A stand-in for `IpcMainInvokeEvent`. Everything on it reports "no window": a handler
 * that reaches for the sender is doing something to a window, and this call has none.
 */
function fakeEvent(): unknown {
  return {
    processId: 0,
    frameId: 0,
    sender: {
      isDestroyed: () => true,
      send: () => {},
      startDrag: () => {
        throw new Error('drag is a desktop gesture')
      }
    },
    senderFrame: null,
    reply: () => {}
  }
}

export async function callInvoke(channel: string, args: unknown[]): Promise<unknown> {
  const fn = invokers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return await fn(fakeEvent(), ...args)
}

export function callSend(channel: string, args: unknown[]): void {
  const list = listeners.get(channel)
  if (!list) throw new Error(`no listener for ${channel}`)
  for (const fn of list) fn(fakeEvent(), ...args)
}
