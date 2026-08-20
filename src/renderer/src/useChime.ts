// The thing that actually makes the noise.
//
// This used to BE the three sounds - three hand-written functions, one per alert. The
// recipes moved to `shared/sounds.ts` when they stopped being three; what is left here
// is the renderer for them, plus the one job the shared file cannot do: playing a file
// the user uploaded.
//
// Still Web Audio rather than an `<audio>` tag for the built-ins: nothing to bundle, no
// codec to rely on, and the whole catalogue is a few kilobytes of numbers. Uploaded
// sounds go the other way - the bytes come over IPC once, get decoded once, and are
// cached as an AudioBuffer, because reading a file off disk is not something to do while
// deciding whether to interrupt somebody.

import {
  MAX_SOUND_BYTES,
  soundFor,
  clampVolume,
  resolveSound,
  type SoundConfig,
  type SoundDef,
  type SoundEvent,
  type SoundVoice
} from '@shared/sounds'

const api = window.api

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)!()
    // Chromium suspends a context created before any interaction; resuming is a
    // no-op when it is already running.
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    // No audio device at all - the toast and the taskbar flash still happen.
    return null
  }
}

/**
 * Two seconds of white noise, made once.
 *
 * Every percussive sound in the catalogue is a filtered slice of this. Regenerating it
 * per bark would allocate ~350 KB each time an alert fires, which is a lot of garbage
 * for a sound that lasts 70 milliseconds.
 */
let noiseBuf: AudioBuffer | null = null
function noise(ac: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ac.sampleRate) return noiseBuf
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * 2), ac.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  noiseBuf = buf
  return buf
}

/** Lay a voice's pitch contour onto an AudioParam, scaled by a partial's multiplier. */
function pitch(param: AudioFrequencyParam, v: SoundVoice, at: number, mult: number): void {
  if (v.glide?.length) {
    const [, first] = v.glide[0]
    param.setValueAtTime(Math.max(1, first * mult), at)
    for (const [frac, hz] of v.glide.slice(1)) {
      // Linear rather than exponential: a meow's contour is heard as a shape, and an
      // exponential ramp between two close frequencies is indistinguishable from it
      // while being wrong for the ones far apart (the laser sweep).
      param.linearRampToValueAtTime(Math.max(1, hz * mult), at + v.dur * Math.max(0, Math.min(1, frac)))
    }
    return
  }
  param.setValueAtTime(Math.max(1, (v.freq ?? 440) * mult), at)
}

type AudioFrequencyParam = AudioParam

/**
 * One layer, once. `at` is absolute context time.
 *
 * Everything is scheduled ahead rather than driven by timers: an alert competes with a
 * renderer that is drawing eight terminals, and a `setTimeout`-driven envelope in that
 * environment is audibly uneven.
 */
function voice(ac: AudioContext, v: SoundVoice, at: number, level: number): void {
  const end = at + v.dur
  const env = ac.createGain()
  const attack = Math.max(0.001, v.attack ?? 0.008)
  const holdUntil = at + attack + Math.max(0, Math.min(1, v.hold ?? 0)) * v.dur
  env.gain.setValueAtTime(0.0001, at)
  env.gain.linearRampToValueAtTime(level, at + attack)
  if (holdUntil > at + attack) env.gain.setValueAtTime(level, Math.min(holdUntil, end))
  if ((v.decay ?? 'exp') === 'exp') {
    // exponentialRamp never reaches 0, so land on a near-zero floor and stop.
    env.gain.exponentialRampToValueAtTime(0.0001, end)
  } else {
    env.gain.linearRampToValueAtTime(0.0001, end)
  }

  let tail: AudioNode = env
  if (v.filter) {
    const f = ac.createBiquadFilter()
    f.type = v.filter.type
    f.Q.value = v.filter.q ?? 1
    f.frequency.setValueAtTime(Math.max(20, v.filter.freq), at)
    if (v.filter.to !== undefined) f.frequency.linearRampToValueAtTime(Math.max(20, v.filter.to), end)
    env.connect(f)
    tail = f
  }
  tail.connect(ac.destination)

  const stopAt = end + 0.03
  if (v.wave === 'noise') {
    const src = ac.createBufferSource()
    src.buffer = noise(ac)
    src.loop = true
    src.connect(env)
    src.start(at)
    src.stop(stopAt)
    return
  }

  // The fundamental plus whatever overtones the recipe asks for. A bell IS its partials;
  // an arcade blip has none and is one oscillator.
  const parts: [number, number][] = [[1, 1], ...(v.partials ?? [])]
  for (const [mult, plevel] of parts) {
    const osc = ac.createOscillator()
    osc.type = v.wave
    pitch(osc.frequency, v, at, mult)
    if (v.vibrato) {
      const lfo = ac.createOscillator()
      const depth = ac.createGain()
      lfo.frequency.value = v.vibrato.rate
      depth.gain.value = v.vibrato.depth * mult
      lfo.connect(depth).connect(osc.frequency)
      lfo.start(at)
      lfo.stop(stopAt)
    }
    if (plevel === 1) {
      osc.connect(env)
    } else {
      const g = ac.createGain()
      g.gain.value = plevel
      osc.connect(g).connect(env)
    }
    osc.start(at)
    osc.stop(stopAt)
  }
}

/** Render a whole recipe, honouring each voice's own repeat. */
function render(ac: AudioContext, def: SoundDef, volume: number): void {
  const master = clampVolume(volume) * def.gain
  if (!master) return
  const now = ac.currentTime + 0.02
  for (const v of def.voices) {
    const times = Math.max(1, Math.min(8, v.repeat?.times ?? 1))
    const every = v.repeat?.every ?? 0
    for (let i = 0; i < times; i++) voice(ac, v, now + v.at + i * every, master * v.gain)
  }
}

// ---------------------------------------------------------------------------
// Uploaded sounds

const decoded = new Map<string, AudioBuffer | null>()
const decoding = new Map<string, Promise<AudioBuffer | null>>()

/**
 * The user's file, decoded once and kept.
 *
 * A `null` in the cache is a real answer - the file is gone, or Chromium refused the
 * container - and is remembered so a broken sound is one failed decode rather than one
 * per alert for the rest of the session. The caller falls back to a built-in either way.
 */
async function customBuffer(id: string): Promise<AudioBuffer | null> {
  if (decoded.has(id)) return decoded.get(id)!
  const pending = decoding.get(id)
  if (pending) return pending
  const job = (async (): Promise<AudioBuffer | null> => {
    const ac = audio()
    if (!ac) return null
    try {
      const bytes = await api.soundData(id)
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_SOUND_BYTES) return null
      // decodeAudioData wants a plain ArrayBuffer and DETACHES it, so copy the bytes
      // out of the view IPC handed over rather than passing its buffer through - the
      // same id previewed twice would otherwise decode an emptied buffer the second time.
      const raw = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(raw).set(bytes)
      return await ac.decodeAudioData(raw)
    } catch {
      return null
    }
  })()
  decoding.set(id, job)
  const buf = await job
  decoding.delete(id)
  decoded.set(id, buf)
  return buf
}

/** Drop a decoded file so a replaced or removed upload is not still playing from memory. */
export function forgetSound(id: string): void {
  decoded.delete(id)
  decoding.delete(id)
}

function playBuffer(buf: AudioBuffer, volume: number): void {
  const ac = audio()
  if (!ac) return
  const g = ac.createGain()
  // Uploads are already normalised by whoever made them, and a recording at full scale
  // beside a synthesised bell at 0.13 is a jump-scare. 0.5 puts the two in the same room.
  g.gain.value = clampVolume(volume) * 0.5
  const src = ac.createBufferSource()
  src.buffer = buf
  src.connect(g).connect(ac.destination)
  src.start()
}

// ---------------------------------------------------------------------------

let lastPlayed = 0

/**
 * A swarm finishing together would otherwise pile four bells on top of each other,
 * which sounds like an alarm rather than a nudge. Shared by every sound: two different
 * alerts landing in the same instant have the same problem.
 */
function tooSoon(): boolean {
  const wall = Date.now()
  if (wall - lastPlayed < 900) return true
  lastPlayed = wall
  return false
}

function playBuiltin(def: SoundDef, volume: number): void {
  const ac = audio()
  if (ac) render(ac, def, volume)
}

/**
 * Play whatever a saved id points at.
 *
 * `instead` is what rings when an uploaded file will not decode - gone from disk, or a
 * container Chromium refuses. Falling silent there is the one outcome that must not
 * happen: silence is what a switched-off alert sounds like, so the person would go
 * looking for a toggle rather than for the broken file, and in the meantime miss turns.
 */
function playResolved(
  id: string,
  sounds: Partial<SoundConfig> | undefined,
  volume: number,
  instead: SoundDef | null
): void {
  const r = resolveSound(id, sounds?.custom ?? [])
  if (!r) {
    if (instead) playBuiltin(instead, volume)
    return
  }
  if (r.kind === 'builtin') {
    playBuiltin(r.def, volume)
    return
  }
  void customBuffer(r.sound.id).then((buf) => {
    if (buf) playBuffer(buf, volume)
    else if (instead) playBuiltin(instead, volume)
  })
}

/** An alert firing for real. Throttled, and silent when the volume is at zero. */
export function playEvent(event: SoundEvent, sounds: Partial<SoundConfig> | undefined): void {
  if (tooSoon()) return
  const volume = clampVolume(sounds?.volume ?? 1)
  if (!volume) return
  // What this event falls back to is its OWN default, never a generic beep: a stalled
  // turn and a finished one must stay tellable apart even when the pick is broken.
  const fallback = soundFor(undefined, event)
  const backup = fallback.kind === 'builtin' ? fallback.def : null
  playResolved(sounds?.[event] ?? '', sounds, volume, backup)
}

/**
 * One second of an auto-answer countdown.
 *
 * Deliberately NOT throttled and deliberately not `playEvent`: the 900ms guard exists so
 * two alerts landing together do not stack, and a metronome is exactly the case it would
 * suppress at one a second - and worse, a tick that touched `lastPlayed` would swallow the
 * finished-turn chime that follows the answer. It is quieter than an alert for the same
 * reason: this is a clock, not an interruption.
 */
export function playTick(sounds: Partial<SoundConfig> | undefined): void {
  // A probe cannot hear a sound, and the countdown's whole promise is that it is audible
  // once a second. This is the only thing a test can read back, the same way `__pfRenders`
  // is what makes "which panes re-rendered" answerable at all.
  const w = window as unknown as { __pfTicks?: number }
  w.__pfTicks = (w.__pfTicks ?? 0) + 1
  const volume = clampVolume(sounds?.volume ?? 1)
  if (!volume) return
  const fallback = soundFor(undefined, 'tick')
  playResolved(sounds?.tick ?? '', sounds, volume, fallback.kind === 'builtin' ? fallback.def : null)
}

/**
 * The Settings preview button.
 *
 * Deliberately not throttled: clicking down a list of twenty-four sounds is exactly the
 * case the 900ms guard exists to suppress, and suppressing it there makes the picker
 * look broken. It also plays at the saved volume, because "is this too loud" is half of
 * what the button is being asked.
 */
export function previewSound(id: string, sounds: Partial<SoundConfig> | undefined): void {
  // A preview at volume 0 would look like a dead button, so the slider's floor is
  // ignored here only - the real alerts above still honour it exactly.
  playResolved(id, sounds, clampVolume(sounds?.volume ?? 1) || 0.6, null)
}
