// The facts about the in-window Whisper that the UI needs, in a file that imports
// nothing.
//
// This exists because of a measurement: when `MODEL_MB` lived beside the worker,
// importing that one constant into useVoice pulled transformers.js and all of
// onnxruntime-web into the MAIN renderer chunk - 1.01 MB to 2.23 MB - for a number.
// A worker is only lazy if nothing on the page imports its module.

/**
 * What the first use of each size costs to download, so the UI can say so up front.
 * Encoder + merged decoder at the quantisation voiceWorker.ts actually loads ('bnb4'
 * - the 8-bit builds of these repos do not run, see the note there), rounded up.
 */
export const MODEL_MB: Record<string, number> = { tiny: 95, base: 140, small: 287 }

export function modelId(size: string): string {
  const s = MODEL_MB[size] ? size : 'base'
  return `onnx-community/whisper-${s}`
}

export interface VoiceWorkerLoad {
  type: 'load'
  /** absolute URL of the directory holding ort-wasm-simd-threaded.{mjs,wasm} */
  wasmBase: string
  /** tiny | base | small */
  size: string
  /** override the repo, for scripts/voice-test.mjs to try one that is not the default */
  repo?: string
  /** override the quantisation, same reason */
  dtype?: unknown
}

export interface VoiceWorkerRun {
  type: 'run'
  pcm: Float32Array
  /** ISO code, or 'auto' */
  language: string
}

export type VoiceWorkerIn = VoiceWorkerLoad | VoiceWorkerRun

export type VoiceWorkerOut =
  | { type: 'progress'; pct: number; note: string }
  | { type: 'ready' }
  | { type: 'text'; text: string }
  | { type: 'error'; error: string }
