// Which transcriber a dictation clip goes to, and why.
//
// There are three, and none of them is right everywhere:
//
//   system   a whisper CLI on PATH. Fastest and fully offline, and it is the one
//            that needs `pip install` - so it is preferred when present and never
//            demanded.
//   inapp    Whisper compiled to WebAssembly, running in this window. Nothing to
//            install; the model is fetched once (tens of MB) and cached, after
//            which it is as offline as `system` and several times slower.
//   browser  the browser's own speech service (Web Speech API). Instant, streams
//            words as you say them, needs no download at all - and it is the one
//            that sends audio off the device, so it is never chosen silently on a
//            machine where a local engine exists.
//
// The one hard fact here is measured rather than assumed: in Electron the
// `webkitSpeechRecognition` CONSTRUCTOR exists and every session ends
// `error: "network"`, because Chromium's speech endpoint needs a Google API key
// that Electron builds do not carry. So feature-detecting the constructor is not
// enough - `browser` is only real when the renderer is being served to an actual
// browser, which is what `isElectron` distinguishes.

export type VoiceEngineId = 'system' | 'inapp' | 'browser'

export interface VoiceEngineFacts {
  /** a whisper CLI was found on PATH by the main process */
  hasSystem: boolean
  /** running inside Electron rather than served to a browser (B2) */
  isElectron: boolean
  /** window.SpeechRecognition or the webkit-prefixed one exists */
  hasSpeechRecognition: boolean
  /** WebAssembly is usable - false only on very locked-down hosts */
  hasWasm: boolean
  /** a touch screen, which is also where a 40 MB model download hurts most */
  touch: boolean
  /** what the user asked for in Settings; 'auto' lets the rules below decide */
  prefer: VoiceEngineId | 'auto'
}

export interface VoiceEngineChoice {
  /** the engine to use now, '' when there is none */
  engine: VoiceEngineId | ''
  /** every engine that would work here, best first */
  order: VoiceEngineId[]
  /** one sentence naming why, for Settings and for the error when there is none */
  why: string
}

/** True for the engines that put a recording on somebody else's server. */
export function leavesDevice(engine: VoiceEngineId | ''): boolean {
  return engine === 'browser'
}

export function engineLabel(engine: VoiceEngineId | ''): string {
  if (engine === 'system') return 'Whisper on this machine'
  if (engine === 'inapp') return 'Whisper in this window'
  if (engine === 'browser') return "the browser's speech service"
  return 'nothing'
}

/**
 * The ladder. Returns every engine that would work here, best first, so the
 * caller can fall down it when one fails at run time rather than at pick time.
 */
export function pickVoiceEngine(f: VoiceEngineFacts): VoiceEngineChoice {
  const order: VoiceEngineId[] = []

  // `browser` is a lie inside Electron: the constructor is there and it always
  // fails. Measured, not assumed - see the note at the top of this file.
  const browserReal = f.hasSpeechRecognition && !f.isElectron

  if (f.hasSystem) order.push('system')

  // On a phone the download is the expensive part and the browser's recognizer is
  // both free and instant, so it goes above the in-window model there. On a
  // desktop the ordering is the other way round: the local model costs one
  // download and then never leaves the machine.
  if (f.touch) {
    if (browserReal) order.push('browser')
    if (f.hasWasm) order.push('inapp')
  } else {
    if (f.hasWasm) order.push('inapp')
    if (browserReal) order.push('browser')
  }

  if (f.prefer !== 'auto' && order.includes(f.prefer)) {
    const rest = order.filter((e) => e !== f.prefer)
    return { engine: f.prefer, order: [f.prefer, ...rest], why: chosenBecause(f.prefer, f, true) }
  }

  const engine = order[0] ?? ''
  return { engine, order, why: engine ? chosenBecause(engine, f, false) : noEngineWhy(f) }
}

function chosenBecause(engine: VoiceEngineId, f: VoiceEngineFacts, asked: boolean): string {
  if (asked) return `${engineLabel(engine)}, because Settings asks for it.`
  if (engine === 'system') return 'Whisper on this machine - fastest, and nothing leaves it.'
  if (engine === 'inapp')
    return 'Whisper in this window - nothing to install, and nothing leaves this device once the model is downloaded.'
  if (engine === 'browser')
    return f.touch
      ? "The browser's speech service - instant, and no model to download over mobile data. It sends the audio to the browser vendor."
      : "The browser's speech service. It sends the audio to the browser vendor."
  return ''
}

function noEngineWhy(f: VoiceEngineFacts): string {
  if (!f.hasWasm) return 'No transcriber: WebAssembly is unavailable here and nothing is on PATH.'
  return 'No transcriber available.'
}
