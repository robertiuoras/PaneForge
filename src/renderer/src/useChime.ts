// The "your agent stopped and wants you" sound.
//
// Synthesised with Web Audio rather than shipped as a file: nothing to bundle,
// no codec to rely on, and the character of the sound is tunable in one place.
// It is deliberately a soft glass-bell arpeggio, not a system beep - this fires
// several times an hour while you are working next to it.

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
 * One bell note: a sine fundamental with a quiet octave above it, a few
 * milliseconds of attack so it cannot click, and an exponential tail.
 */
function note(ac: AudioContext, freq: number, at: number, gain: number, dur: number): void {
  for (const [mult, level] of [
    [1, 1],
    [2, 0.22],
    [3, 0.07]
  ] as const) {
    const osc = ac.createOscillator()
    const amp = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq * mult
    amp.gain.setValueAtTime(0.0001, at)
    amp.gain.linearRampToValueAtTime(gain * level, at + 0.012)
    // exponentialRamp never reaches 0, so land on a near-zero floor and stop.
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(amp).connect(ac.destination)
    osc.start(at)
    osc.stop(at + dur + 0.02)
  }
}

/** Two rising notes, about half a second end to end. `volume` is 0..1. */
export function playChime(volume = 1): void {
  const ac = audio()
  if (!ac) return
  const g = Math.max(0, Math.min(1, volume)) * 0.13
  if (!g) return
  const now = ac.currentTime + 0.02
  note(ac, 783.99, now, g, 0.9) // G5
  note(ac, 1174.66, now + 0.13, g * 0.85, 1.2) // D6
}
