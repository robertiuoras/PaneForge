// The only bridge between the renderer and Node. contextIsolation stays on, so the
// UI gets this narrow typed surface instead of ipcRenderer itself.
//
// What each method DOES - its channel and whether it is a request, a fire-and-forget
// or a subscription - is data now, in src/shared/surface.ts, because the phone client
// (src/main/serve.ts + renderer/src/browserApi.ts) has to answer the identical object
// over HTTP. Keeping it here as closures meant a second transport re-typed 141 of them
// and drifted the first time anybody added a channel. `Surface` is keyed by `keyof Api`,
// so an unlisted method is a typecheck error rather than a phone that silently cannot
// do one thing.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { buildApi, type Transport } from '../shared/surface'

const transport: Transport = {
  invoke: (channel, args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, args) => ipcRenderer.send(channel, ...args),
  on: (channel, handler) => {
    // Electron hands the listener an event first; the UI's callbacks never want it.
    const wrapped = (_e: unknown, ...args: unknown[]): void => handler(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  }
}

const api = buildApi(transport, {
  // File.path was removed from Electron's File objects; webUtils is the only way
  // a dropped file's real path reaches the renderer.
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
})

contextBridge.exposeInMainWorld('api', api)

// Whether the window behind this document is real macOS glass, answered before the first
// paint. Deliberately NOT a method on `api`: `surface.ts` is the list of things the phone
// must be able to do too, and a phone is never the window this describes. `glass:off` is
// main correcting itself when the native view failed to attach after all.
contextBridge.exposeInMainWorld('__pfGlass', {
  on: process.argv.includes('--pf-glass'),
  onOff: (fn: () => void) => ipcRenderer.once('glass:off', () => fn())
})
