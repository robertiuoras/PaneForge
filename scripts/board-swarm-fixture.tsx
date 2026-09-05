import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import BoardDialog from '../src/renderer/src/components/BoardDialog'
import SwarmDialog from '../src/renderer/src/components/SwarmDialog'

let root: ReturnType<typeof createRoot> | null = null
let key = 0

function render(host: HTMLElement, node: ReturnType<typeof createElement>): void {
  root ??= createRoot(host)
  root.render(node)
}

export function mountBoard(host: HTMLElement, props: React.ComponentProps<typeof BoardDialog>): void {
  render(host, createElement(BoardDialog, { ...props, key: ++key }))
}

export function mountSwarm(host: HTMLElement, props: React.ComponentProps<typeof SwarmDialog>): void {
  render(host, createElement(SwarmDialog, { ...props, key: ++key }))
}
