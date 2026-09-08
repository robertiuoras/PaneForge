import { useEffect, useRef, useState } from 'react'
import type { VaultGraph, VaultInfo, VaultNode } from '@shared/types'

const api = window.api

interface Props {
  onClose: () => void
}

interface SimNode extends VaultNode {
  x: number
  y: number
  vx: number
  vy: number
}

/**
 * The vault's notes and `[[links]]`, drawn as a force-directed graph: pan, zoom, click a
 * note to open it in Obsidian. Canvas rather than SVG - a few thousand notes is a few
 * thousand DOM nodes React would otherwise diff every simulation tick.
 */
export default function VaultDialog({ onClose }: Props): JSX.Element {
  const [info, setInfo] = useState<VaultInfo | null | undefined>(undefined)
  const [graph, setGraph] = useState<VaultGraph | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<SimNode[]>([])
  const camera = useRef({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ mode: 'pan' | 'node'; id?: string; lastX: number; lastY: number } | null>(
    null
  )
  const hoverId = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    void api.vaultInfo('').then((i) => {
      if (live) setInfo(i)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!info || info.error) return
    let live = true
    void api.vaultGraph(info.path).then((g) => {
      if (!live) return
      setGraph(g)
      nodesRef.current = g.nodes.map((n, i) => {
        const angle = (i / Math.max(1, g.nodes.length)) * Math.PI * 2
        const radius = 40 + Math.sqrt(g.nodes.length) * 12
        return { ...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 }
      })
    })
    return () => {
      live = false
    }
  }, [info])

  // Force simulation + draw, one rAF loop. Repulsion between every pair is O(n^2), which
  // stays cheap through the low thousands of notes this is built for; a bigger vault would
  // need a spatial grid, which is not the vault a person actually keeps.
  useEffect(() => {
    if (!graph) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    const nodes = nodesRef.current
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const tick = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }

      // Repulsion.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) d2 = 1
          const force = 1800 / d2
          const d = Math.sqrt(d2)
          dx = (dx / d) * force
          dy = (dy / d) * force
          a.vx += dx
          a.vy += dy
          b.vx -= dx
          b.vy -= dy
        }
      }
      // Springs along links.
      for (const [from, to] of graph.links) {
        const a = byId.get(from)
        const b = byId.get(to)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const stretch = (d - 90) * 0.02
        const fx = (dx / d) * stretch
        const fy = (dy / d) * stretch
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
      // Pull toward centre so the graph doesn't drift off, damping so it settles.
      for (const n of nodes) {
        if (drag.current?.mode === 'node' && drag.current.id === n.id) continue
        n.vx += -n.x * 0.002
        n.vy += -n.y * 0.002
        n.vx *= 0.85
        n.vy *= 0.85
        n.x += n.vx
        n.y += n.vy
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.save()
      ctx.translate(w / 2 + camera.current.x, h / 2 + camera.current.y)
      ctx.scale(camera.current.zoom, camera.current.zoom)

      ctx.strokeStyle = 'rgba(140, 140, 150, 0.35)'
      ctx.lineWidth = 1 / camera.current.zoom
      for (const [from, to] of graph.links) {
        const a = byId.get(from)
        const b = byId.get(to)
        if (!a || !b) continue
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      for (const n of nodes) {
        const r = 3 + Math.min(10, Math.sqrt(n.degree + 1) * 2.2)
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = hoverId.current === n.id ? '#f0a868' : 'rgba(160, 170, 190, 0.85)'
        ctx.fill()
        if (camera.current.zoom > 0.6) {
          ctx.fillStyle = 'rgba(220, 220, 225, 0.85)'
          ctx.font = `${11 / camera.current.zoom}px sans-serif`
          ctx.fillText(n.title, n.x + r + 3, n.y + 3)
        }
      }
      ctx.restore()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [graph])

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    return {
      x: (clientX - rect.left - w / 2 - camera.current.x) / camera.current.zoom,
      y: (clientY - rect.top - h / 2 - camera.current.y) / camera.current.zoom
    }
  }

  const nodeAt = (clientX: number, clientY: number): SimNode | null => {
    const p = toWorld(clientX, clientY)
    let best: SimNode | null = null
    let bestD = 14
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - p.x, n.y - p.y)
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    return best
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    const hit = nodeAt(e.clientX, e.clientY)
    drag.current = hit
      ? { mode: 'node', id: hit.id, lastX: e.clientX, lastY: e.clientY }
      : { mode: 'pan', lastX: e.clientX, lastY: e.clientY }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    const d = drag.current
    if (!d) {
      hoverId.current = nodeAt(e.clientX, e.clientY)?.id ?? null
      return
    }
    const dx = e.clientX - d.lastX
    const dy = e.clientY - d.lastY
    d.lastX = e.clientX
    d.lastY = e.clientY
    if (d.mode === 'pan') {
      camera.current.x += dx
      camera.current.y += dy
    } else if (d.id) {
      const n = nodesRef.current.find((x) => x.id === d.id)
      if (n) {
        n.x += dx / camera.current.zoom
        n.y += dy / camera.current.zoom
        n.vx = 0
        n.vy = 0
      }
    }
  }
  const onMouseUp = (e: React.MouseEvent): void => {
    const wasClick =
      drag.current?.mode === 'node' &&
      Math.abs(e.clientX - drag.current.lastX) < 3 &&
      Math.abs(e.clientY - drag.current.lastY) < 3
    if (wasClick && drag.current?.id && info) {
      void api.vaultOpen(info.path, drag.current.id)
    }
    drag.current = null
  }
  const onWheel = (e: React.WheelEvent): void => {
    e.preventDefault()
    const factor = Math.exp(-e.deltaY * 0.001)
    camera.current.zoom = Math.min(4, Math.max(0.15, camera.current.zoom * factor))
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide tall vault" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Vault</strong>
          <span className="hint">
            {info === undefined
              ? 'Reading…'
              : info === null
                ? 'No Obsidian vault set - add one in Settings.'
                : info.error
                  ? info.error
                  : `${info.name} · ${info.notes} note${info.notes === 1 ? '' : 's'}`}
          </span>
        </div>

        <div className="vault-body">
          {info && !info.error ? (
            <canvas
              ref={canvasRef}
              className="vault-canvas"
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={() => (drag.current = null)}
              onWheel={onWheel}
            />
          ) : (
            <div className="empty">
              {info === undefined
                ? 'Reading the vault…'
                : (info?.error ?? 'Point Settings at your Obsidian vault folder to see it here.')}
            </div>
          )}
        </div>

        <div className="dialog-row">
          <span className="hint">Drag to pan, scroll to zoom, click a note to open it in Obsidian.</span>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
