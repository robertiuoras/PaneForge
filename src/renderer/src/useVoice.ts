// Push-to-talk dictation, with nothing to install.
//
// Three transcribers, picked by `shared/voicePick.ts` and fallen down in order
// when one fails at run time:
//
//   system   a whisper CLI on PATH, via the main process. Fastest, fully offline,
//            and the one that needs `pip install` - so it is used when it happens
//            to be there and never asked for.
//   inapp    Whisper in a worker in this window (voiceWorker.ts). No install; one
//            model download, cached for ever after. This is the default, and it is
//            what makes the feature work on a machine with no Python.
//   browser  the browser's own recogniser. Only real when the renderer is SERVED
//            to a browser - inside Electron the constructor exists and every
//            session ends `error: "network"`, measured, because Chromium's speech
//            endpoint wants a key Electron does not ship. It streams words as you
//            say them, which is why it wins on a phone.
//
// MediaRecorder gives webm/opus and Whisper wants PCM, so the clip is decoded with
// WebAudio and resampled to 16 kHz mono here. `system` gets it as a WAV over IPC;
// `inapp` gets the Float32Array straight, with no encode/decode round trip.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  pickVoiceEngine,
  type VoiceEngineId,
  type VoiceEngineChoice
} from '@shared/voicePick'
import { MODEL_MB, type VoiceWorkerIn, type VoiceWorkerOut } from '@shared/voiceModels'

const api = window.api

export type VoicePhase = 'idle' | 'recording' | 'thinking' | 'loading'

export interface Voice {
  phase: VoicePhase
  error: string
  /** The pane this clip is being dictated into, '' when the target is whatever is focused. */
  target: string
  /** which transcriber this window is using, and the sentence explaining it */
  choice: VoiceEngineChoice
  /** 0..1 loudness while recording - what the mic on a phone fills with */
  level: number
  /** words heard so far; only the streaming engine has these */
  interim: string
  /** 0..100 while a model downloads, -1 when nothing is downloading */
  progress: number
  /** how many MB the first use of the in-window engine costs */
  modelMb: number
  start: (target?: string) => Promise<void>
  stop: () => void
  cancel: () => void
  toggle: (target?: string) => void
}

const SAMPLE_RATE = 16_000

/** Electron's Chromium has the constructor and no key behind it. Only the UA can tell. */
const IS_ELECTRON = /electron/i.test(navigator.userAgent)

type SpeechCtor = new () => SpeechRecognitionLike
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

function speechCtor(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

/**
 * One recorder, but it remembers which pane asked for it. There is a mic on every pane
 * header, and a clip started from one pane has to land in that pane even if the pointer
 * has moved on by the time Whisper answers - which takes seconds.
 */
export function useVoice(
  onText: (text: string, target: string) => void,
  cfg?: { model: string; language: string; engine?: VoiceEngineId | 'auto' }
): Voice {
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [error, setError] = useState('')
  const [target, setTarget] = useState('')
  const [level, setLevel] = useState(0)
  const [interim, setInterim] = useState('')
  const [progress, setProgress] = useState(-1)
  const [hasSystem, setHasSystem] = useState(false)

  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const phaseRef = useRef<VoicePhase>('idle')
  const targetRef = useRef('')
  const worker = useRef<Worker | null>(null)
  const workerReady = useRef(false)
  const speech = useRef<SpeechRecognitionLike | null>(null)
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null)
  const heard = useRef('')
  const cancelled = useRef(false)

  phaseRef.current = phase

  const model = cfg?.model || 'base'
  const language = cfg?.language || 'auto'
  const prefer = cfg?.engine || 'auto'

  useEffect(() => {
    let live = true
    api.voiceStatus().then((s) => live && setHasSystem(s.available))
    return () => {
      live = false
    }
  }, [])

  const choice = pickVoiceEngine({
    hasSystem,
    isElectron: IS_ELECTRON,
    hasSpeechRecognition: !!speechCtor(),
    hasWasm: typeof WebAssembly !== 'undefined',
    touch: matchMedia('(pointer: coarse)').matches,
    prefer
  })
  const choiceRef = useRef(choice)
  choiceRef.current = choice

  const done = useCallback(() => {
    setPhase('idle')
    setLevel(0)
    setInterim('')
    setProgress(-1)
    targetRef.current = ''
    setTarget('')
  }, [])

  const deliver = useCallback(
    (text: string) => {
      if (cancelled.current) return
      const t = text.trim()
      if (t) onText(t, targetRef.current)
    },
    [onText]
  )

  /** Spin the in-window model up, reusing it across clips. Resolves when it can run. */
  const ensureWorker = useCallback((): Promise<Worker> => {
    if (worker.current && workerReady.current) return Promise.resolve(worker.current)
    if (!worker.current) {
      worker.current = new Worker(new URL('./voiceWorker.ts', import.meta.url), { type: 'module' })
    }
    const w = worker.current
    return new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent<VoiceWorkerOut>): void => {
        const m = e.data
        if (m.type === 'progress') setProgress(m.pct)
        else if (m.type === 'ready') {
          workerReady.current = true
          setProgress(-1)
          w.removeEventListener('message', onMsg)
          resolve(w)
        } else if (m.type === 'error') {
          w.removeEventListener('message', onMsg)
          reject(new Error(m.error))
        }
      }
      w.addEventListener('message', onMsg)
      const load: VoiceWorkerIn = {
        type: 'load',
        wasmBase: new URL('ort/', location.href).href,
        size: model
      }
      w.postMessage(load)
    })
  }, [model])

  const runInApp = useCallback(
    async (pcm: Float32Array): Promise<string> => {
      const w = await ensureWorker()
      return await new Promise<string>((resolve, reject) => {
        const onMsg = (e: MessageEvent<VoiceWorkerOut>): void => {
          const m = e.data
          if (m.type === 'text') {
            w.removeEventListener('message', onMsg)
            resolve(m.text)
          } else if (m.type === 'error') {
            w.removeEventListener('message', onMsg)
            reject(new Error(m.error))
          }
        }
        w.addEventListener('message', onMsg)
        const run: VoiceWorkerIn = { type: 'run', pcm, language }
        w.postMessage(run, [pcm.buffer])
      })
    },
    [ensureWorker, language]
  )

  /** Fall down the ladder: the chosen engine, then whatever else would work here. */
  const transcribe = useCallback(
    async (blob: Blob): Promise<void> => {
      const pcm = await toPcm(blob)
      const problems: string[] = []
      for (const engine of choiceRef.current.order) {
        if (engine === 'browser') continue // streaming; it never reaches here
        try {
          const text =
            engine === 'system'
              ? await (async () => {
                  const r = await api.transcribe(encodeWav(pcm, SAMPLE_RATE))
                  if (r.error) throw new Error(r.error)
                  return r.text
                })()
              : await runInApp(pcm.slice())
          deliver(text)
          return
        } catch (e) {
          problems.push(`${engine}: ${(e as Error).message || String(e)}`)
        }
      }
      setError(
        problems.length
          ? `Could not transcribe. ${problems.join(' · ')}`
          : 'No transcriber available. Settings > Voice.'
      )
    },
    [deliver, runInApp]
  )

  /** Loudness for the mic to fill with. Cheap: one analyser, one rAF. */
  const startMeter = useCallback((stream: MediaStream) => {
    const ctx = new AudioContext()
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 512
    src.connect(an)
    const buf = new Uint8Array(an.frequencyBinCount)
    const tick = (): void => {
      an.getByteTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128)
      // Speech sits well below full scale, so the bar is scaled to what a voice
      // actually reaches rather than to the headroom above it.
      setLevel(Math.min(1, peak * 2.6))
      meter.current = { ctx, raf: requestAnimationFrame(tick) }
    }
    meter.current = { ctx, raf: requestAnimationFrame(tick) }
  }, [])

  const stopMeter = useCallback(() => {
    if (!meter.current) return
    cancelAnimationFrame(meter.current.raf)
    void meter.current.ctx.close()
    meter.current = null
    setLevel(0)
  }, [])

  const startBrowser = useCallback(
    (to: string): boolean => {
      const Ctor = speechCtor()
      if (!Ctor) return false
      const r = new Ctor()
      r.lang = language === 'auto' ? navigator.language || 'en-US' : language
      r.continuous = true
      r.interimResults = true
      heard.current = ''
      r.onresult = (e): void => {
        let live = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const alt = e.results[i][0].transcript
          if (e.results[i].isFinal) heard.current += alt
          else live += alt
        }
        setInterim((heard.current + live).trim())
      }
      r.onerror = (e): void => {
        // Falling back needs a clip, and a streaming engine never made one, so the
        // honest move is to say which engine failed rather than pretend to retry.
        setError(`Speech service: ${e.error}. Settings > Voice can pick another.`)
        speech.current = null
        stopMeter()
        done()
      }
      r.onend = (): void => {
        if (speech.current) {
          speech.current = null
          stopMeter()
          deliver(heard.current || interimRef.current)
          done()
        }
      }
      targetRef.current = to
      setTarget(to)
      speech.current = r
      r.start()
      setPhase('recording')
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(startMeter)
        .catch(() => {
          /* the recogniser holds its own mic; a missing meter is cosmetic */
        })
      return true
    },
    [deliver, done, language, startMeter, stopMeter]
  )

  const interimRef = useRef('')
  interimRef.current = interim

  const start = useCallback(
    async (to = '') => {
      if (phaseRef.current !== 'idle') return
      setError('')
      setInterim('')
      cancelled.current = false

      if (choiceRef.current.engine === 'browser' && startBrowser(to)) return

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
          stopMeter()
          if (cancelled.current) {
            done()
            return
          }
          setPhase(workerReady.current || choiceRef.current.engine === 'system' ? 'thinking' : 'loading')
          try {
            await transcribe(new Blob(chunks.current, { type: rec.mimeType }))
          } catch (e) {
            setError(String(e))
          } finally {
            done()
          }
        }
        rec.start()
        recorder.current = rec
        startMeter(stream)
        setPhase('recording')
        // Load the in-window model WHILE the clip is being spoken, not after it.
        // `runInApp` used to be the first thing that ever called `ensureWorker`,
        // so the ORT init (and, once, the model download) was serialised behind
        // the recording instead of overlapping it - every clip paid it, not just
        // the first. Failures are ignored here on purpose: `transcribe` walks the
        // same ladder afterwards and reports properly.
        if (choiceRef.current.engine === 'inapp') void ensureWorker().catch(() => {})
      } catch (e) {
        setError(`Microphone unavailable: ${String(e)}`)
        done()
      }
    },
    [done, ensureWorker, startBrowser, startMeter, stopMeter, transcribe]
  )

  const stop = useCallback(() => {
    if (phaseRef.current !== 'recording') return
    if (speech.current) {
      const r = speech.current
      speech.current = null
      stopMeter()
      try {
        r.stop()
      } catch {
        /* already stopped */
      }
      deliver(heard.current || interimRef.current)
      done()
      return
    }
    try {
      recorder.current?.stop()
    } catch {
      done()
    }
  }, [deliver, done, stopMeter])

  /** Throw the clip away. The overlay needs this; a misheard paragraph is worse than none. */
  const cancel = useCallback(() => {
    cancelled.current = true
    if (speech.current) {
      const r = speech.current
      speech.current = null
      try {
        r.abort()
      } catch {
        /* already gone */
      }
      stopMeter()
      done()
      return
    }
    if (phaseRef.current === 'recording') {
      try {
        recorder.current?.stop()
      } catch {
        done()
      }
    }
  }, [done, stopMeter])

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

  useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = null
    },
    []
  )

  return {
    phase,
    error,
    target,
    choice,
    level,
    interim,
    progress,
    modelMb: MODEL_MB[model] ?? MODEL_MB.base,
    start,
    stop,
    cancel,
    toggle
  }
}

/** webm/opus blob -> 16 kHz mono float samples, which is what Whisper eats. */
async function toPcm(blob: Blob): Promise<Float32Array> {
  const raw = await blob.arrayBuffer()
  const ctx = new AudioContext()
  const decoded = await ctx.decodeAudioData(raw)
  await ctx.close()

  const frames = Math.ceil(decoded.duration * SAMPLE_RATE)
  const offline = new OfflineAudioContext(1, Math.max(frames, 1), SAMPLE_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
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
