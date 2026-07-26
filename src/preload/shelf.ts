// The overlay's bridge. Deliberately smaller than the main window's: this window floats
// over every other app, so it gets the clipboard history and nothing else - no sessions,
// no config writes, no shell.

import { contextBridge, ipcRenderer } from 'electron'
import type { RecentItem, ShelfApi } from '../shared/types'

const api: ShelfApi = {
  list: () => ipcRenderer.invoke('recents:list'),
  copy: (id) => ipcRenderer.send('recents:copy', id),
  remove: (id) => ipcRenderer.send('recents:remove', id),
  clear: () => ipcRenderer.send('recents:clear'),
  drag: (id) => ipcRenderer.send('recents:drag', id),
  toPane: (id) => ipcRenderer.send('recents:toPane', id),
  focusApp: () => ipcRenderer.send('shelf:focusApp'),
  setExpanded: (open) => ipcRenderer.send('shelf:setExpanded', open),
  onItems: (cb) => {
    const h = (_e: unknown, items: RecentItem[]): void => cb(items)
    ipcRenderer.on('shelf:items', h)
    return () => ipcRenderer.off('shelf:items', h)
  },
  onExpanded: (cb) => {
    const h = (_e: unknown, open: boolean): void => cb(open)
    ipcRenderer.on('shelf:expanded', h)
    return () => ipcRenderer.off('shelf:expanded', h)
  }
}

contextBridge.exposeInMainWorld('shelf', api)
