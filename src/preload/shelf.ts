// The overlay's bridge. Deliberately smaller than the main window's: this window floats
// over every other app, so it gets the clipboard history and nothing else - no sessions,
// no config writes, no shell.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { RecentItem, ShelfApi, ShelfEdge, StashConfig } from '../shared/types'

const api: ShelfApi = {
  list: () => ipcRenderer.invoke('recents:list'),
  copy: (id) => ipcRenderer.send('recents:copy', id),
  remove: (id) => ipcRenderer.send('recents:remove', id),
  clear: () => ipcRenderer.send('recents:clear'),
  pin: (id, on) => ipcRenderer.send('recents:pin', id, on),
  drag: (id) => ipcRenderer.send('recents:drag', id),
  add: (paths) => ipcRenderer.invoke('stash:add', paths),
  addData: (name, data) => ipcRenderer.invoke('stash:addData', name, data),
  text: (id) => ipcRenderer.invoke('recents:text', id),
  pick: () => ipcRenderer.invoke('stash:pick'),
  // Electron took File.path away; the real path is only reachable from a preload.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  toPane: (id, focus) => ipcRenderer.send('recents:toPane', id, focus ?? false),
  focusApp: () => ipcRenderer.send('shelf:focusApp'),
  openSearch: () => ipcRenderer.send('recents:openSearch'),
  touch: () => ipcRenderer.send('shelf:touch'),
  reveal: () => ipcRenderer.send('stash:reveal'),
  setExpanded: (open) => ipcRenderer.send('shelf:setExpanded', open),
  setTall: (tall) => ipcRenderer.send('shelf:setTall', tall),
  dragWindow: {
    start: () => ipcRenderer.send('shelf:dragStart'),
    lift: () => ipcRenderer.invoke('shelf:dragLift'),
    move: (dx, dy) => ipcRenderer.send('shelf:dragMove', dx, dy),
    shown: () => ipcRenderer.send('shelf:dragShown'),
    drop: (dx, dy) => ipcRenderer.invoke('shelf:dragDrop', dx, dy),
    end: () => ipcRenderer.send('shelf:dragEnd')
  },
  resizeWindow: {
    start: (edge: ShelfEdge) => ipcRenderer.send('shelf:resizeStart', edge),
    move: (dx, dy) => ipcRenderer.send('shelf:resizeMove', dx, dy),
    end: () => ipcRenderer.send('shelf:resizeEnd')
  },
  getConfig: () => ipcRenderer.invoke('shelf:config'),
  setConfig: (patch) => ipcRenderer.invoke('shelf:setConfig', patch),
  onItems: (cb) => {
    const h = (_e: unknown, items: RecentItem[]): void => cb(items)
    ipcRenderer.on('shelf:items', h)
    return () => ipcRenderer.off('shelf:items', h)
  },
  onExpanded: (cb) => {
    const h = (_e: unknown, open: boolean): void => cb(open)
    ipcRenderer.on('shelf:expanded', h)
    return () => ipcRenderer.off('shelf:expanded', h)
  },
  onConfig: (cb) => {
    const h = (_e: unknown, config: StashConfig): void => cb(config)
    ipcRenderer.on('shelf:config', h)
    return () => ipcRenderer.off('shelf:config', h)
  }
}

contextBridge.exposeInMainWorld('shelf', api)
