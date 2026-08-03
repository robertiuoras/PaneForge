// What an alert is allowed to sound like, checked without a speaker.
//
// The catalogue is data now, which buys one thing that mattered enough to build it that
// way: a sound can be WRONG in a checkable sense long before anybody hears it. The two
// failures worth catching here are the two nobody would report as bugs -
//
//   - **A recipe that plays nothing.** A voice with no pitch, a duration of zero, a
//     renamed id that a default still points at. Silence is exactly what a switched-off
//     alert sounds like, so the person goes looking for a toggle and never files it.
//   - **A recipe that clips.** Four voices at full gain landing in the same 40ms sum past
//     1.0, and Web Audio's answer to that is a crackle on top of the sound. It is
//     inaudible on one bell and obvious on a swarm, which is the worst possible place to
//     find out.
//
// Plus the upload rules, which are the ones with a filesystem behind them: an alert
// sound is the only thing in this app that takes a path from outside it.
//
//   node scripts/sound-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-sound-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'sounds.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/sounds.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const {
  CUSTOM_PREFIX,
  DEFAULT_SOUNDS,
  MAX_SOUND_BYTES,
  SOUNDS,
  SOUND_EXTS,
  builtinSound,
  clampVolume,
  isSoundFile,
  pruneSounds,
  resolveSound,
  soundExt,
  soundFileName,
  soundFor,
  soundLabel,
  soundNameFrom,
  soundOptions
} = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

// ---------------------------------------------------------------------------
// Every recipe is playable

ok(SOUNDS.length >= 20, `the catalogue is worth having a picker for (${SOUNDS.length} sounds)`)

const ids = new Set()
const labels = new Set()
const WAVES = new Set(['sine', 'triangle', 'square', 'sawtooth', 'noise'])

for (const s of SOUNDS) {
  const at = `sound "${s.id}"`
  ok(/^[a-z][a-z0-9]*$/.test(s.id), `${at}: id is a plain lowercase token`)
  ok(!ids.has(s.id), `${at}: id is unique`)
  ids.add(s.id)
  ok(s.label && s.label.length <= 24, `${at}: has a label that fits a picker row`)
  ok(!labels.has(s.label), `${at}: two sounds cannot share a name`)
  labels.add(s.label)
  ok(s.group, `${at}: belongs to a group`)
  ok(s.gain > 0 && s.gain <= 0.6, `${at}: master gain is set and not deafening (${s.gain})`)
  ok(s.voices.length > 0, `${at}: has at least one voice`)

  for (const [i, v] of s.voices.entries()) {
    const vat = `${at} voice ${i}`
    ok(WAVES.has(v.wave), `${vat}: wave is one the synth knows (${v.wave})`)
    ok(v.dur > 0, `${vat}: lasts longer than no time at all`)
    ok(v.at >= 0, `${vat}: does not start before the sound does`)
    ok(v.gain > 0 && v.gain <= 1, `${vat}: gain is a real fraction (${v.gain})`)
    // The silent-voice trap: a tonal oscillator with neither a frequency nor a contour
    // renders at whatever the default is, which is not what the recipe meant.
    if (v.wave !== 'noise') ok(v.freq > 0 || v.glide?.length > 0, `${vat}: has a pitch or a glide`)
    if (v.glide) {
      ok(v.glide.length >= 2, `${vat}: a glide needs somewhere to go`)
      let last = -1
      for (const [frac, hz] of v.glide) {
        ok(frac >= 0 && frac <= 1, `${vat}: glide waypoint sits inside the voice (${frac})`)
        ok(frac > last, `${vat}: glide waypoints move forwards`)
        ok(hz > 0 && hz < 20000, `${vat}: glide stays inside hearing (${hz} Hz)`)
        last = frac
      }
    }
    if (v.partials)
      for (const [mult, level] of v.partials) {
        ok(mult > 0, `${vat}: a partial is a multiple of the fundamental`)
        ok(level > 0 && level <= 1, `${vat}: a partial is quieter than the fundamental`)
      }
    if (v.filter) {
      ok(v.filter.freq > 20, `${vat}: filter is somewhere audible`)
      ok(!v.filter.q || v.filter.q > 0, `${vat}: Q is positive`)
    }
    if (v.repeat) {
      ok(v.repeat.times >= 2 && v.repeat.times <= 8, `${vat}: repeats a sane number of times`)
      ok(v.repeat.every > 0, `${vat}: repeats are spaced apart`)
    }
    // An attack longer than the voice never reaches full level and then ramps down from
    // a value it never had - which is how a "sound" becomes a click.
    ok((v.attack ?? 0.008) < v.dur, `${vat}: attack fits inside the voice`)
  }
}

// ---------------------------------------------------------------------------
// Nothing clips, and nothing turns into a ringtone
//
// Peak level is checked by walking the timeline: at every instant, add up every voice
// that is sounding. Envelope shape is ignored on purpose - this is the worst case, which
// is the number that matters for clipping.

/** Every [start, end, level] a recipe schedules, repeats expanded. */
function spans(def) {
  const out = []
  for (const v of def.voices) {
    const times = v.repeat?.times ?? 1
    const every = v.repeat?.every ?? 0
    // The synth sums the fundamental and every partial into one envelope, so the layer's
    // real peak is their total, not its nominal gain.
    const level = def.gain * v.gain * (1 + (v.partials ?? []).reduce((n, [, l]) => n + l, 0))
    for (let i = 0; i < times; i++) out.push([v.at + i * every, v.at + i * every + v.dur, level])
  }
  return out
}

for (const s of SOUNDS) {
  const list = spans(s)
  let peak = 0
  for (const [start] of list) {
    let sum = 0
    for (const [a, b, level] of list) if (start >= a && start < b) sum += level
    peak = Math.max(peak, sum)
  }
  ok(peak <= 1, `sound "${s.id}" cannot clip (worst-case peak ${peak.toFixed(3)})`)

  const total = Math.max(...list.map(([, end]) => end))
  ok(total <= 2.6, `sound "${s.id}" is an alert, not a ringtone (${total.toFixed(2)}s)`)
}

// The three the app has always made must keep their exact character: an upgrade that
// silently re-tunes the sound somebody has been hearing for months is a bug report.
is(builtinSound('chime').voices[0].freq, 783.99, 'the turn chime still starts on G5')
is(builtinSound('fall').voices[0].freq, 587.33, 'the stall sound still starts on D5')
is(builtinSound('ping').voices[0].freq, 1567.98, 'the bell is still one note on G6')

// ---------------------------------------------------------------------------
// Resolution, and the fact that an alert always makes a noise

for (const ev of ['done', 'stall', 'bell'])
  ok(builtinSound(DEFAULT_SOUNDS[ev]), `the default for "${ev}" names a real sound`)

is(soundFor(undefined, 'done').def.id, 'chime', 'a config with no sounds block still chimes')
is(soundFor(undefined, 'stall').def.id, 'fall', 'and still falls')
is(soundFor(undefined, 'bell').def.id, 'ping', 'and still pings')

is(soundFor({ done: 'bark' }, 'done').def.id, 'bark', 'a picked sound is used')
// The important one: every way of being wrong lands on a WORKING sound, and on the one
// belonging to that event - a stalled turn and a finished turn stay tellable apart.
is(soundFor({ done: 'nope' }, 'done').def.id, 'chime', 'an id from a newer version falls back')
is(soundFor({ stall: 'custom:gone' }, 'stall').def.id, 'fall', 'a deleted upload falls back per event')
is(soundFor({ bell: '' }, 'bell').def.id, 'ping', 'an empty pick falls back')

const mine = [{ id: 'abc', name: 'Airhorn', file: 'abc.wav', addedAt: 1 }]
is(resolveSound('meow').kind, 'builtin', 'a catalogue id resolves to a recipe')
is(resolveSound(CUSTOM_PREFIX + 'abc', mine).kind, 'custom', 'a custom id resolves to the file')
is(resolveSound(CUSTOM_PREFIX + 'abc', mine).sound.name, 'Airhorn', 'and carries its name')
is(resolveSound(CUSTOM_PREFIX + 'abc', []), null, 'a custom id with nothing behind it resolves to nothing')
is(resolveSound('not-a-sound'), null, 'an unknown id resolves to nothing')

is(soundLabel('meow'), 'Cat meow', 'the picker can name a built-in')
is(soundLabel(CUSTOM_PREFIX + 'abc', mine), 'Airhorn', 'and an upload')
is(soundLabel('gone'), 'Missing sound', 'and says so when it cannot')

const opts = soundOptions(mine)
is(opts.length, SOUNDS.length + 1, 'the picker offers every built-in plus the uploads')
is(opts[opts.length - 1].group, 'Yours', 'uploads sit in their own group')
is(opts[opts.length - 1].value, CUSTOM_PREFIX + 'abc', 'and are picked by their prefixed id')

// ---------------------------------------------------------------------------
// Volume

is(clampVolume(0.5), 0.5, 'a normal volume is left alone')
is(clampVolume(2), 1, 'and is capped')
is(clampVolume(-1), 0, 'and floored')
is(clampVolume('x'), 1, 'and a corrupted one reads as full rather than as silence')
is(clampVolume(undefined), 1, 'as does a missing one')
is(clampVolume(0), 0, 'but a deliberate zero IS silence')

// ---------------------------------------------------------------------------
// Uploads: the only thing here that takes a path from outside the app

ok(SOUND_EXTS.includes('.wav') && SOUND_EXTS.includes('.mp3'), 'the obvious formats are allowed')
is(MAX_SOUND_BYTES, 8 * 1024 * 1024, 'the size cap is 8 MB')

is(soundExt('C:\\x\\thing.WAV'), '.wav', 'extensions are compared in one case')
ok(isSoundFile('/home/rob/meow.ogg'), 'an ogg is a sound')
ok(!isSoundFile('/home/rob/meow.exe'), 'an exe is not')
ok(!isSoundFile('/home/rob/meow'), 'nor is a file with no extension')
ok(!isSoundFile('/home/rob/meow.wav.exe'), 'nor is one dressed as one')

is(soundNameFrom('C:\\Users\\Gamer\\Downloads\\Cat Meow (loud).mp3'), 'Cat Meow (loud)', 'the name is the file, minus the extension')
is(soundNameFrom('/tmp/bark.ogg'), 'bark', 'on either separator')
is(soundNameFrom('/tmp/.wav'), 'Sound', 'a nameless file still gets a name')
ok(soundNameFrom('/tmp/' + 'x'.repeat(200) + '.wav').length <= 48, 'a very long name is cut to fit a row')

// The one with teeth. The stored file name is built from the id we generated, never from
// the text that came in, so no amount of ../ in the source can decide where the write
// lands - the result is always one flat file name in the sounds folder.
const evil = soundFileName('a1b2c3', '..\\..\\..\\Windows\\System32\\evil.exe')
ok(!/[\\/]/.test(evil), 'a traversal in the source path cannot reach the stored name')
ok(evil.endsWith('.wav'), 'and an extension off the allowlist is replaced, not honoured')
is(soundFileName('a1b2c3', '/tmp/meow.mp3'), 'a1b2c3.mp3', 'an allowed extension is kept')
ok(!/[\\/.]/.test(soundFileName('../../x', '/tmp/a.wav').replace('.wav', '')), 'and a poisoned id is scrubbed too')

// ---------------------------------------------------------------------------
// Pruning: the config and the folder drift apart on their own

const drifted = {
  done: CUSTOM_PREFIX + 'gone',
  stall: CUSTOM_PREFIX + 'here',
  bell: 'ping',
  volume: 3,
  custom: [
    { id: 'gone', name: 'Deleted', file: 'gone.wav', addedAt: 1 },
    { id: 'here', name: 'Kept', file: 'here.wav', addedAt: 2 }
  ]
}
const pruned = pruneSounds(drifted, (f) => f === 'here.wav')
is(pruned.custom.length, 1, 'an upload whose file vanished is dropped')
is(pruned.done, 'chime', 'and the alert that used it goes back to its own default')
is(pruned.stall, CUSTOM_PREFIX + 'here', 'while an alert whose file survived is untouched')
is(pruned.bell, 'ping', 'and a built-in pick is never rewritten')
is(pruned.volume, 1, 'a corrupted volume is clamped on the way through')

const intact = pruneSounds({ ...drifted, volume: 0.4 }, () => true)
is(intact.custom.length, 2, 'nothing is dropped when every file is there')
is(intact.done, CUSTOM_PREFIX + 'gone', 'and no pick is rewritten')

// ---------------------------------------------------------------------------
// The upload path, against a real folder
//
// Everything above is arithmetic on strings. This half runs `main/sounds.ts` itself with
// electron stubbed out and a throwaway userData folder underneath it, because the rules
// only matter if the code that copies files actually applies them - and because "the
// config says you have a sound, the disk disagrees" is the failure this whole module
// exists to survive.

const userData = join(work, 'userData')
mkdirSync(userData, { recursive: true })

const mainOut = join(work, 'main-sounds.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/sounds.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['electron'],
  outfile: mainOut
})

const electron = {
  app: { getPath: () => userData, setLoginItemSettings() {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}
const mod = { exports: {} }
new Function('require', 'module', 'exports', '__filename', '__dirname', readFileSync(mainOut, 'utf8'))(
  (id) => (id === 'electron' ? electron : createRequire(import.meta.url)(id)),
  mod,
  mod.exports,
  mainOut,
  work
)
const { addSoundFile, orphanSoundFiles, pruneCustomSounds, removeSound, renameSound, soundData, sounds } =
  mod.exports

// A file that is not audio, and one that is (as far as this layer is concerned - decoding
// is the renderer's problem, and its failure path is a fallback, not a crash).
const notAudio = join(work, 'thing.exe')
const real = join(work, 'My Cat.wav')
writeFileSync(notAudio, 'MZ')
writeFileSync(real, Buffer.alloc(2048, 7))
writeFileSync(join(work, 'empty.wav'), '')

is(addSoundFile(notAudio).ok, false, 'a non-audio file is refused')
ok(addSoundFile(notAudio).error?.includes('.wav'), 'and the refusal names what would work')
is(addSoundFile(join(work, 'empty.wav')).ok, false, 'an empty file is refused')
is(addSoundFile(join(work, 'nothing-here.wav')).ok, false, 'an unreadable path is refused, not thrown on')

const added = addSoundFile(real)
is(added.ok, true, 'a real audio file is taken')
is(added.sound.name, 'My Cat', 'and is named after the file, not its path')
ok(existsSync(join(userData, 'sounds', added.sound.file)), 'the bytes are COPIED into userData')
is(sounds().custom.length, 1, 'and the config knows about it')

// The copy is the point: the alert has to survive the original being moved or tidied.
rmSync(real, { force: true })
is(soundData(added.sound.id).length, 2048, 'the sound still reads back after the original is deleted')
is(soundData('nope'), null, 'an unknown id reads back as nothing rather than throwing')

renameSound(added.sound.id, '  Loud Cat  ')
is(sounds().custom[0].name, 'Loud Cat', 'renaming trims and sticks')
is(sounds().custom[0].file, added.sound.file, 'and does not move the file')

// An alert pointing at an upload whose file is then removed OUT FROM UNDER the app - a
// tidied userData, a profile copied without its sounds folder.
const file = join(userData, 'sounds', added.sound.file)
const cfgPath = join(userData, 'config.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
cfg.sounds.done = 'custom:' + added.sound.id
writeFileSync(cfgPath, JSON.stringify(cfg))
rmSync(file, { force: true })
// getConfig caches, so this is checked through the prune the app runs at startup with the
// in-memory copy it already has - the same call in the same order the app makes it.
pruneCustomSounds()
is(sounds().custom.length, 0, 'an upload whose file vanished is forgotten at startup')
is(sounds().done, 'chime', 'and the alert that used it is audible again')

writeFileSync(join(work, 'thing2.wav'), Buffer.alloc(64, 1))
const second = addSoundFile(join(work, 'thing2.wav'))
is(second.ok, true, 'a second upload is taken')
ok(second.sound.id !== added.sound.id, 'and never reuses an id')
removeSound(second.sound.id)
is(sounds().custom.length, 0, 'removing an upload forgets it')
ok(!existsSync(join(userData, 'sounds', second.sound.file)), 'and deletes its copy')
is(orphanSoundFiles().length, 0, 'leaving nothing behind in the folder')

rmSync(work, { recursive: true, force: true })
console.log(`sounds: ${checks} checks passed (${SOUNDS.length} sounds in the catalogue)`)
