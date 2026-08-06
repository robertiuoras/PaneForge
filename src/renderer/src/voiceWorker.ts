// Whisper, in this window, with nothing installed.
//
// This is the `inapp` engine of `shared/voicePick.ts`: ONNX Runtime's WebAssembly
// build running a quantised Whisper. It lives in a worker because a `base` clip
// takes seconds of solid CPU and the alternative is a frozen window - the same
// reason the pty layer never calls spawnSync.
//
// Two things are deliberate and easy to undo by accident:
//
//   * The wasm binaries are OURS, shipped in `out/renderer/ort/`, not the CDN
//     transformers.js defaults to. `wasmBase` arrives in the load message rather
//     than being computed here, because a worker's `import.meta.url` and the
//     page's base differ in a packaged app and only the page knows the truth.
//     The non-asyncify build is the one the library uses on Safari - it is half
//     the size of the default and does plain CPU inference exactly as well.
//   * The MODEL is downloaded once from Hugging Face and kept in the browser
//     cache. That is the only network this feature ever does, and it is why
//     index.html's connect-src names huggingface.co.

import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { modelId, type VoiceWorkerIn, type VoiceWorkerLoad, type VoiceWorkerOut } from '@shared/voiceModels'

/**
 * Which weights to load, measured on this ONNX Runtime rather than chosen from a
 * README. Every 8-bit build of these repos - 'q8', 'int8', 'uint8' - downloads and
 * then refuses to build a session:
 *
 *   qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits
 *   Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale
 *
 * 'fp32' works and costs 151 MB for `tiny`; 'bnb4' works, is the smallest thing that
 * does, and is what ships. If a future runtime fixes the 8-bit path this is the one
 * line to revisit - the sizes in shared/voiceModels.ts move with it.
 */
const DTYPE = 'bnb4'

const post = (m: VoiceWorkerOut): void => self.postMessage(m)

let asr: AutomaticSpeechRecognitionPipeline | null = null
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let loadedId = ''

async function load(msg: VoiceWorkerLoad): Promise<AutomaticSpeechRecognitionPipeline> {
  const id = msg.repo || modelId(msg.size)
  if (asr && loadedId === id) return asr
  if (loading && loadedId === id) return loading

  // Local model files are a packaged-app concept we do not use; without this the
  // library probes for /models/... first and every load eats a 404 round trip.
  env.allowLocalModels = false
  const wasm = env.backends.onnx.wasm
  if (wasm) {
    wasm.wasmPaths = {
      mjs: `${msg.wasmBase}ort-wasm-simd-threaded.mjs`,
      wasm: `${msg.wasmBase}ort-wasm-simd-threaded.wasm`
    }
  }

  loadedId = id
  // Progress arrives per file, and a percentage that restarts at 0 four times
  // reads as a stuck download - so it is folded into one number across the set.
  const seen = new Map<string, { loaded: number; total: number }>()
  loading = pipeline('automatic-speech-recognition', id, {
    dtype: (msg.dtype ?? DTYPE) as 'q8',
    device: 'wasm',
    progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && p.total) {
        seen.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
        let loaded = 0
        let total = 0
        for (const v of seen.values()) {
          loaded += v.loaded
          total += v.total
        }
        post({
          type: 'progress',
          pct: total ? Math.min(99, Math.round((loaded / total) * 100)) : 0,
          note: 'Downloading the model, once'
        })
      }
    }
  }) as Promise<AutomaticSpeechRecognitionPipeline>

  asr = await loading
  loading = null
  post({ type: 'ready' })
  return asr
}

self.onmessage = async (e: MessageEvent<VoiceWorkerIn>): Promise<void> => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await load(msg)
      return
    }
    if (msg.type === 'run') {
      if (!asr) {
        post({ type: 'error', error: 'The transcriber was asked to run before it loaded.' })
        return
      }
      const opts: { language?: string; task: 'transcribe' } = { task: 'transcribe' }
      if (msg.language && msg.language !== 'auto') opts.language = msg.language
      const out = (await asr(msg.pcm, opts)) as { text?: string } | { text?: string }[]
      const text = Array.isArray(out) ? (out[0]?.text ?? '') : (out.text ?? '')
      post({ type: 'text', text: text.trim() })
    }
  } catch (err) {
    post({ type: 'error', error: (err as Error)?.message || String(err) })
  }
}
