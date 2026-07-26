// Push-to-talk dictation, entirely local.
//
// MediaRecorder gives us webm/opus, but Whisper wants PCM. Rather than shipping
// ffmpeg, the clip is decoded with WebAudio, resampled to the 16 kHz mono that
// Whisper uses internally, and written out as a plain WAV here in the renderer.
// That keeps the whole feature dependency-free.

import { useCallback, useEffect, useRef, useState } from 'react'

const api = window.api

export type VoicePhase = 'idle' | 'recording' | 'thinking'

export interface Voice {
  phase: VoicePhase
  error: string
  /** The pane this clip is being dictated into, '' when the target is whatever is focused. */
  target: string
  start: (target?: string) => Promise<void>
  stop: () => void
  toggle: (target?: string) => void
}

const SAMPLE_RATE = 16_000

/**
 * One recorder, but it remembers which pane asked for it. There is a mic on every pane
 * header, and a clip started from one pane has to land in that pane even if the pointer
 * has moved on by the time Whisper answers - which takes seconds.
 */
export function useVoice(onText: (text: string, target: string) => void): Voice {
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [error, setError] = useState('')
  const [target, setTarget] = useState('')
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const phaseRef = useRef<VoicePhase>('idle')
  const targetRef = useRef('')

  phaseRef.current = phase

  const start = useCallback(async (to = '') => {
    if (phaseRef.current !== 'idle') return
    setError('')
    targetRef.current = to
    setTarget(to)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
      chunks.current = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      rec.onstop = async () => {
        // Release the mic immediately; the OS shows a recording indicator otherwise.
        stream.getTracks().forEach((t) => t.stop())
        setPhase('thinking')
        try {
          const wav = await toWav(new Blob(chunks.current, { type: rec.mimeType }))
          const r = await api.transcribe(wav)
          if (r.error) setError(r.error)
          else if (r.text.trim()) onText(r.text.trim(), targetRef.current)
        } catch (e) {
          setError(String(e))
        } finally {
          setPhase('idle')
          targetRef.current = ''
          setTarget('')
        }
      }
      rec.start()
      recorder.current = rec
      setPhase('recording')
    } catch (e) {
      setError(`Microphone unavailable: ${String(e)}`)
      setPhase('idle')
      targetRef.current = ''
      setTarget('')
    }
  }, [onText])

  const stop = useCallback(() => {
    if (phaseRef.current !== 'recording') return
    try {
      recorder.current?.stop()
    } catch {
      setPhase('idle')
    }
  }, [])

  const toggle = useCallback(
    (to = '') => {
      if (phaseRef.current === 'recording') stop()
      else if (phaseRef.current === 'idle') void start(to)
    },
    [start, stop]
  )

  // The global hotkey is a toggle rather than hold-to-talk: a held global key would
  // keep firing repeats, and Electron gives no key-up for global shortcuts. It carries no
  // target - the focused pane is the one it means, and only App knows which that is.
  useEffect(() => api.onVoiceHotkey(() => toggle()), [toggle])

  return { phase, error, target, start, stop, toggle }
}

/** webm/opus blob -> 16 kHz mono 16-bit WAV. */
async function toWav(blob: Blob): Promise<ArrayBuffer> {
  const raw = await blob.arrayBuffer()
  const ctx = new AudioContext()
  const decoded = await ctx.decodeAudioData(raw)
  await ctx.close()

  const frames = Math.ceil((decoded.duration * SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, Math.max(frames, 1), SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return encodeWav(rendered.getChannelData(0), SAMPLE_RATE)
}

function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const str = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}
