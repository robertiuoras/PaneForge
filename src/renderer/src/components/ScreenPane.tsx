/**
 * A pane showing another machine's screen, in the grid beside the terminals.
 *
 * The picture is a WebRTC connection this component owns (recvonly, H.264 preferred),
 * signalled through main over the encrypted peer channel - src/main/screenStream.ts. What
 * state it is in and what it says come from src/shared/screenStream.ts; this file is the
 * browser half: the connection, the zoom box, the quality line and the card shown when
 * there is no picture. View-only: nothing typed or clicked here reaches the other machine.
 */

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import {
  STATS_EVERY_MS,
  anchorScroll,
  clampZoom,
  fitZoom,
  offersRetry,
  offersWake,
  qualityLine,
  qualityOf,
  sampleOf,
  screenMessage,
  screenStart,
  stepScreen,
  wheelZoom,
  zoomLabel,
  zoomStep,
  type Quality,
  type ScreenEvent,
  type ScreenState,
  type StatsSample
} from '@shared/screenStream'
import { isPhoneClient } from '../client'

const api = window.api

/** Cmd/Ctrl +/-/0 on the active pane: App's key handler calls in here. */
export const paneZoom = new Map<string, (dir: 1 | -1 | 0) => void>()

type Signal = { t: string; [k: string]: unknown }

interface Props {
  session: Session
  visible: boolean
  control: { ok: boolean; title: string } | null
  flash: (msg: string) => void
}

function reducer(s: ScreenState, e: ScreenEvent): ScreenState {
  return stepScreen(s, e, Date.now())
}

export default function ScreenPane({ session, visible, control, flash }: Props): JSX.Element {
  const id = session.id
  const machine = session.screen?.machine ?? 'The other machine'
  const role = session.screen?.role ?? 'sink'
  const [state, dispatch] = useReducer(reducer, Date.now(), screenStart)
  const [quality, setQuality] = useState<Quality | null>(null)
  const [pic, setPic] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(true)
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [waking, setWaking] = useState(false)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const frozenRef = useRef<HTMLCanvasElement | null>(null)
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)
  const phone = isPhoneClient()

  // --- the connection -------------------------------------------------------------

  const hangUp = useCallback(() => {
    const pc = pcRef.current
    pcRef.current = null
    if (!pc) return
    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    pc.ontrack = null
    pc.close()
  }, [])

  /** Keep the last frame on screen while the link is down (`Reconnecting…`). */
  const freeze = useCallback(() => {
    const v = videoRef.current
    const c = frozenRef.current
    if (!v || !c || !v.videoWidth) return
    c.width = v.videoWidth
    c.height = v.videoHeight
    try {
      c.getContext('2d')?.drawImage(v, 0, 0)
    } catch {
      /* a tainted or empty frame: nothing to keep */
    }
  }, [])

  const connect = useCallback(async () => {
    hangUp()
    const pc = new RTCPeerConnection({ iceServers: [] })
    pcRef.current = pc
    const tr = pc.addTransceiver('video', { direction: 'recvonly' })
    // H.264 first: hardware decode on the Mac, the design's safe codec. AV1 is the
    // measured second try (docs/superpowers/specs/2026-09-23-pc-screen-design.md).
    try {
      const caps = RTCRtpReceiver.getCapabilities('video')
      if (caps) {
        const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType))
        if (h264.length) tr.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !/h264/i.test(c.mimeType))])
      }
    } catch {
      /* preferences are a nicety; the default negotiation still works */
    }
    pc.ontrack = (e) => {
      const v = videoRef.current
      if (!v) return
      v.srcObject = e.streams[0] ?? new MediaStream([e.track])
      void v.play().catch(() => {})
    }
    pc.onicecandidate = (e) => {
      if (!e.candidate || pcRef.current !== pc) return
      void api.screenSignal(id, {
        t: 'screen:ice',
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex
      })
    }
    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        freeze()
        dispatch({ t: 'drop' })
      }
    }
    try {
      await pc.setLocalDescription(await pc.createOffer())
      if (pcRef.current !== pc) return
      const res = await api.screenSignal(id, { t: 'screen:offer', sdp: pc.localDescription?.sdp ?? '' })
      if (res === 'offline') dispatch({ t: 'refuse', why: 'offline' })
      else if (res === 'old') dispatch({ t: 'refuse', why: 'old' })
    } catch (err) {
      dispatch({ t: 'refuse', why: 'refused', detail: `Could not start the view: ${(err as Error).message}` })
    }
  }, [id, hangUp, freeze])

  // Start on mount; ask again whenever the state machine says so (a retry bumps
  // `retries` or moves `since` while offering; a drop moves to reconnecting).
  useEffect(() => {
    if (role !== 'sink' || phone) return
    if (state.phase === 'idle') dispatch({ t: 'start' })
    else if (state.phase === 'offering' || state.phase === 'reconnecting') void connect()
    // `since` changes on every retry and on every new drop: that is the trigger.
  }, [role, phone, state.phase, state.retries, state.phase === 'offering' ? state.since : 0, connect]) // eslint-disable-line react-hooks/exhaustive-deps

  // Deadlines are judged on a clock tick, never inside an event.
  useEffect(() => {
    if (state.phase !== 'offering' && state.phase !== 'reconnecting') return
    const t = setInterval(() => dispatch({ t: 'tick' }), 1000)
    return () => clearInterval(t)
  }, [state.phase])

  // A failed or ended view holds no connection open.
  useEffect(() => {
    if (state.phase === 'failed' || state.phase === 'ended') hangUp()
  }, [state.phase, hangUp])

  useEffect(() => () => hangUp(), [hangUp])

  // Frames from the other machine.
  useEffect(() => {
    if (role !== 'sink') return
    return api.onScreenSignal((view, m: Signal) => {
      if (view !== id) return
      const pc = pcRef.current
      switch (m.t) {
        case 'screen:answer':
          if (pc && typeof m.sdp === 'string') void pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => {})
          return
        case 'screen:ice':
          if (pc && typeof m.candidate === 'string') {
            void pc
              .addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid as string | null, sdpMLineIndex: m.sdpMLineIndex as number | null })
              .catch(() => {})
          }
          return
        case 'screen:locked':
          dispatch({ t: 'locked' })
          return
        case 'screen:refused':
          dispatch({ t: 'refuse', why: 'refused', detail: typeof m.message === 'string' ? m.message : undefined })
          return
        case 'screen:stop':
          if (m.by === 'source') dispatch({ t: 'stop', by: 'source' })
          return
      }
    })
  }, [id, role])

  // The first frame (and every frame after a drop) is what `connected` means.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onFrame = (): void => {
      if (!v.videoWidth) return
      setPic((p) => (p && p.w === v.videoWidth && p.h === v.videoHeight ? p : { w: v.videoWidth, h: v.videoHeight }))
      dispatch({ t: 'picture' })
    }
    v.addEventListener('playing', onFrame)
    v.addEventListener('resize', onFrame)
    return () => {
      v.removeEventListener('playing', onFrame)
      v.removeEventListener('resize', onFrame)
    }
  }, [])

  // The quality line: two getStats() samples a second apart.
  useEffect(() => {
    if (state.phase !== 'connected') {
      setQuality(null)
      return
    }
    let prev: StatsSample | null = null
    const t = setInterval(() => {
      const pc = pcRef.current
      if (!pc) return
      void pc.getStats().then((report) => {
        const rows: Record<string, unknown>[] = []
        report.forEach((r) => rows.push(r as Record<string, unknown>))
        const now = sampleOf(rows, performance.now())
        const q = qualityOf(prev, now)
        prev = now
        if (q) setQuality(q)
      })
    }, STATS_EVERY_MS)
    return () => clearInterval(t)
  }, [state.phase])

  // --- zoom ------------------------------------------------------------------------

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const shown = fit && pic ? fitZoom(box.w, box.h, pic.w, pic.h) : zoom

  /** Zoom to `to`, keeping the picture point under `anchor` (box coordinates) still. */
  const zoomTo = useCallback(
    (to: number, anchor?: { x: number; y: number }) => {
      const el = boxRef.current
      const next = clampZoom(to)
      if (el && pic) {
        const a = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
        // From Fit the picture is centred with margins, so its origin is not the box's.
        const offX = Math.max(0, (el.clientWidth - pic.w * shown) / 2)
        const offY = Math.max(0, (el.clientHeight - pic.h * shown) / 2)
        pendingScroll.current = anchorScroll(
          { left: el.scrollLeft - offX, top: el.scrollTop - offY },
          a,
          shown,
          next
        )
      }
      setFit(false)
      setZoom(next)
    },
    [pic, shown]
  )

  useLayoutEffect(() => {
    const el = boxRef.current
    const s = pendingScroll.current
    if (!el || !s) return
    pendingScroll.current = null
    el.scrollLeft = s.left
    el.scrollTop = s.top
  }, [zoom, fit])

  const step = useCallback(
    (dir: 1 | -1 | 0) => {
      if (dir === 0) {
        setFit(true)
        return
      }
      zoomTo(zoomStep(shown, dir))
    },
    [shown, zoomTo]
  )

  useEffect(() => {
    paneZoom.set(id, step)
    return () => {
      if (paneZoom.get(id) === step) paneZoom.delete(id)
    }
  }, [id, step])

  // Pinch arrives as a wheel with ctrlKey; Cmd/Ctrl+wheel is the mouse's way to the same.
  // Listened for directly: React's wheel handler is passive and cannot stop the page.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(wheelZoom(shown, e.deltaY, e.deltaMode), { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [shown, zoomTo])

  // Test hook, read by scripts/screen-stream-window-test.mjs through ui-lab.
  useEffect(() => {
    const w = window as unknown as { __pfScreen?: Record<string, unknown> }
    w.__pfScreen = w.__pfScreen ?? {}
    w.__pfScreen[id] = { phase: state.phase, failure: state.failure, zoom: shown, fit, pic, line: qualityLine(quality), step, zoomTo }
  }, [id, state.phase, state.failure, shown, fit, pic, quality, step, zoomTo])

  // --- actions ---------------------------------------------------------------------

  const wake = async (): Promise<void> => {
    setWaking(true)
    const r = await api.screenWake(id)
    setWaking(false)
    flash(r.message)
    if (r.ok) setTimeout(() => dispatch({ t: 'retry' }), 1500)
  }

  // --- drawing ---------------------------------------------------------------------

  if (role === 'source') {
    return (
      <div className="screen-pane source">
        <div className="screen-card">
          <div className="screen-card-title">{session.title}</div>
          <div className="screen-card-body">
            This machine&apos;s screen is showing in a pane on {machine}. They can see it but cannot type or click.
            Close this pane to stop.
          </div>
        </div>
      </div>
    )
  }

  const message = phone ? `Open this on the desk: ${machine}'s screen shows there, not on a phone yet.` : screenMessage(state, machine)
  const live = state.phase === 'connected' || state.phase === 'reconnecting'
  const w = pic ? Math.round(pic.w * shown) : undefined
  const h = pic ? Math.round(pic.h * shown) : undefined

  return (
    <div className={'screen-pane' + (visible ? '' : ' off')}>
      <div className={'screen-box' + (fit ? ' fit' : '')} ref={boxRef}>
        <div className="screen-stage" style={w && h ? { width: w, height: h } : undefined}>
          <video
            ref={videoRef}
            className={'screen-video' + (state.phase === 'connected' ? '' : ' hidden')}
            autoPlay
            muted
            playsInline
            style={w && h ? { width: w, height: h } : undefined}
          />
          <canvas
            ref={frozenRef}
            className={'screen-video' + (state.phase === 'reconnecting' ? '' : ' hidden')}
            style={w && h ? { width: w, height: h } : undefined}
          />
        </div>
      </div>
      {message && (
        <div className={'screen-card' + (live ? ' over' : '')}>
          <div className="screen-card-title">{message}</div>
          {state.phase === 'failed' && state.failure === 'locked' && (
            <div className="screen-card-body">
              Nothing to show until the desktop is back on {machine}&apos;s own screen. Wake the desktop moves it back; a
              locked screen still needs its password, typed there or through Take control.
            </div>
          )}
          <div className="screen-card-actions">
            {offersWake(state) && (
              <button className="primary" disabled={waking} onClick={() => void wake()}>
                {waking ? 'Waking…' : 'Wake the desktop'}
              </button>
            )}
            {offersRetry(state) && <button onClick={() => dispatch({ t: 'retry' })}>Try again</button>}
            {state.phase === 'failed' && control?.ok && (
              <button title={control.title} onClick={() => api.screenTakeControl()}>
                Take control
              </button>
            )}
          </div>
        </div>
      )}
      <div className="screen-bar">
        <span className="screen-zoom" role="group" aria-label="Zoom">
          <button className="icon" aria-label="Zoom out" title="Zoom out (Ctrl -)" onClick={() => step(-1)}>
            −
          </button>
          <button className="screen-pct" title="Actual size" onClick={() => zoomTo(1)}>
            {zoomLabel(shown)}
          </button>
          <button className="icon" aria-label="Zoom in" title="Zoom in (Ctrl +)" onClick={() => step(1)}>
            +
          </button>
          <button className={'screen-fit' + (fit ? ' on' : '')} title="Fit the whole screen in the pane (Ctrl 0)" onClick={() => step(0)}>
            Fit
          </button>
        </span>
        <span className="screen-quality" title="Pictures per second, data rate, and the round trip to the other machine">
          {qualityLine(quality)}
        </span>
        {control?.ok && state.phase !== 'failed' && (
          <button className="screen-control" title={control.title} onClick={() => api.screenTakeControl()}>
            Take control
          </button>
        )}
      </div>
    </div>
  )
}
