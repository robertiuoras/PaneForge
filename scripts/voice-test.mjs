// Dictation, proved twice: the choice of transcriber, and a real clip through the
// real one.
//
//   npm run build && npm run try -- --keep --show --remote-debugging-port=9333
//   npm run test:voice
//   npm run try -- --close
//
// The first half is arithmetic and runs anywhere. The second half needs a window,
// because the whole point of the feature is that Whisper runs IN one: it speaks a
// sentence with the OS voice, hands the samples to the shipped worker exactly as a
// recorded clip would arrive, and asserts the words come back. That is the only
// check that can fail for the reasons this feature actually fails for - a wasm path
// that resolves to nothing, a CSP that blocks the model, a worker format the
// packaged app cannot load - none of which a unit test can see.
//
// It SKIPS out loud rather than passing when there is no window up or no `say`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = process.env.PF_PORT ?? '9333'

let failed = 0
let checks = 0
const ok = (cond, what) => {
  checks++
  if (!cond) {
    failed++
    console.error(`  FAIL  ${what}`)
  }
}

// --- the ladder ------------------------------------------------------------
// Loaded through esbuild rather than run as TypeScript: the same reason every other
// test script here does it, and `node` on esbuild's bin is a Windows-only shim.
const out = buildSync({
  entryPoints: [join(root, 'src/shared/voicePick.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral'
})
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
)
const { pickVoiceEngine, leavesDevice } = mod

const facts = (over = {}) => ({
  hasSystem: false,
  isElectron: true,
  hasSpeechRecognition: true,
  hasWasm: true,
  touch: false,
  prefer: 'auto',
  ...over
})

console.log('engine choice')
{
  // The measured fact this whole file exists to protect: inside Electron the Web
  // Speech constructor is present and every session ends `error: "network"`, so a
  // plain feature-detect would pick an engine that can never work.
  const desktop = pickVoiceEngine(facts())
  ok(desktop.engine === 'inapp', 'Electron with no CLI runs Whisper in the window')
  ok(!desktop.order.includes('browser'), 'Electron never offers the browser recogniser')

  const withCli = pickVoiceEngine(facts({ hasSystem: true }))
  ok(withCli.engine === 'system', 'a whisper CLI on PATH is preferred when it is there')
  ok(withCli.order[1] === 'inapp', 'and the in-window engine is the fallback under it')

  // A phone: the browser's recogniser is instant and free, and 95-287 MB over mobile
  // data to say one sentence is the version of this nobody uses twice.
  const phone = pickVoiceEngine(facts({ isElectron: false, touch: true }))
  ok(phone.engine === 'browser', 'a touch screen uses the browser recogniser first')
  ok(phone.order.includes('inapp'), 'and can still fall back to the in-window model')

  const servedDesktop = pickVoiceEngine(facts({ isElectron: false }))
  ok(servedDesktop.engine === 'inapp', 'a served DESKTOP browser still prefers the local model')

  const pinned = pickVoiceEngine(facts({ isElectron: false, prefer: 'browser' }))
  ok(pinned.engine === 'browser', 'Settings can pin an engine')
  const impossible = pickVoiceEngine(facts({ prefer: 'browser' }))
  ok(impossible.engine === 'inapp', 'and pinning one that cannot work here is ignored')

  const none = pickVoiceEngine(facts({ hasWasm: false, hasSpeechRecognition: false }))
  ok(none.engine === '', 'no engine is reported as none rather than guessed')
  ok(/wasm|available/i.test(none.why), 'and says why')

  ok(leavesDevice('browser') && !leavesDevice('inapp') && !leavesDevice('system'),
    'exactly one engine is marked as sending audio off the device')
}

// --- a real clip through the real worker -----------------------------------
const SENTENCE = 'the quick brown fox jumps over the lazy dog'

async function pages() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`)
  return await r.json()
}

let live = null
try {
  live = (await pages()).find((t) => t.type === 'page' && !(t.url ?? '').includes('shelf'))
} catch {
  live = null
}

if (process.platform !== 'darwin') {
  console.log('\nSKIP: the spoken half needs macOS `say` to make the clip.')
} else if (!live) {
  console.log(
    `\nSKIP: no window on port ${port}.\n` +
      '      npm run build && npm run try -- --keep --show --remote-debugging-port=9333'
  )
} else {
  const dir = mkdtempSync(join(tmpdir(), 'pf-voice-'))
  try {
    console.log('\nspoken clip')
    execFileSync('say', ['-o', join(dir, 'clip.aiff'), SENTENCE])
    // 16 kHz mono signed 16-bit LE, which is both what Whisper wants and the one
    // format the probe below can parse with a fixed 44-byte header.
    execFileSync('afconvert', [
      join(dir, 'clip.aiff'),
      '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1',
      join(dir, 'clip.wav')
    ])
    const wav = readFileSync(join(dir, 'clip.wav'))
    ok(wav.length > 16_000, `the clip has audio in it (${(wav.length / 1024) | 0} KB)`)

    const assets = join(root, 'out/renderer/assets')
    const workerFile = readdirSync(assets).find((f) => /^voiceWorker-.*\.js$/.test(f))
    ok(!!workerFile, 'the built renderer contains the dictation worker')
    if (!workerFile) throw new Error('no worker in out/renderer/assets - run npm run build')

    const script = `(async () => {
      const b64 = ${JSON.stringify(wav.toString('base64'))};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const n = (bytes.length - 44) / 2;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = view.getInt16(44 + i * 2, true) / 32768;

      const seconds = +(pcm.length / 16000).toFixed(2);
      const w = new Worker('./assets/${workerFile}', { type: 'module' });
      const t0 = performance.now();
      let progress = 0;
      const text = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out after 600s')), 600000);
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') progress = m.pct;
          else if (m.type === 'ready') {
            w.postMessage({ type: 'run', pcm, language: 'en' }, [pcm.buffer]);
          } else if (m.type === 'text') { clearTimeout(timer); resolve(m.text); }
          else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.error)); }
        };
        w.onerror = (e) => { clearTimeout(timer); reject(new Error('worker failed to load: ' + (e.message || e.type))); };
        w.postMessage({ type: 'load', wasmBase: new URL('ort/', location.href).href, size: 'tiny' });
      });
      w.terminate();
      // seconds is read BEFORE the run: posting the samples TRANSFERS the buffer,
      // after which pcm.length is 0 and the timing line reads "1708 ms for 0s".
      return { text, ms: Math.round(performance.now() - t0), progress, seconds };
    })()`

    const file = join(dir, 'probe.js')
    writeFileSync(file, script)
    const raw = execFileSync('node', [join(root, 'scripts/probe.mjs'), '--port', port, '--file', file], {
      encoding: 'utf8',
      // The first run downloads the model; every run after it is cached.
      timeout: 700_000,
      maxBuffer: 8 * 1024 * 1024
    })
    const res = JSON.parse(raw)
    const heard = String(res.text || '').toLowerCase().replace(/[^a-z ]/g, '')
    const want = SENTENCE.split(' ')
    const hits = want.filter((word) => heard.includes(word)).length
    console.log(`  heard: "${res.text}"  (${res.ms} ms for ${res.seconds}s of audio)`)
    ok(hits >= 6, `at least 6 of the ${want.length} words came back (got ${hits})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- the full-screen mic --------------------------------------------------
// A phone-sized window, driven through the real hook: the overlay has to cover the
// viewport, keep both actions above the fold and hit the 44 px touch minimum. And a
// desktop-sized window must NOT get it - the pane's own mic is the whole UI there.
if (live) {
  console.log('\nfull-screen mic')
  const probe = (w, h, expr) =>
    JSON.parse(
      execFileSync(
        'node',
        [join(root, 'scripts/probe.mjs'), '--port', port, '--width', String(w), '--height', String(h), expr],
        { encoding: 'utf8', timeout: 120_000 }
      )
    )

  const open = `(async () => {
    const v = window.__pfVoice; if (!v) return { err: 'no __pfVoice on the window' };
    await v.start('');
    await new Promise(r => setTimeout(r, 900));
    const el = document.querySelector('.voice-overlay');
    // window.__pfVoice is replaced on every render, so the live phase has to be
    // read off the window again - the object captured before start() is stale.
    if (!el) { const now = window.__pfVoice.phase; window.__pfVoice.cancel(); return { overlay: false, phase: now }; }
    const r = el.getBoundingClientRect();
    const send = document.querySelector('.voice-act.go').getBoundingClientRect();
    const cancel = document.querySelector('.voice-act.ghost').getBoundingClientRect();
    const sheet = document.querySelector('.voice-sheet').getBoundingClientRect();
    const out = {
      overlay: true,
      covers: r.width === innerWidth && r.height === innerHeight,
      sendH: Math.round(send.height), cancelH: Math.round(cancel.height),
      fits: send.bottom <= innerHeight && sheet.top >= 0,
      ring: !!document.querySelector('.voice-ring')
    };
    window.__pfVoice.cancel();
    return out;
  })()`

  const phone = probe(390, 844, open)
  ok(phone.overlay === true, 'a phone-sized window opens the full-screen mic')
  ok(phone.covers === true, 'and it covers the whole viewport')
  ok(phone.fits === true, 'with both actions on screen')
  ok(phone.sendH >= 44 && phone.cancelH >= 44, `and finger-sized (${phone.sendH}px / ${phone.cancelH}px)`)
  ok(phone.ring === true, 'the level ring is drawn')

  const desk = probe(1400, 900, open)
  ok(desk.overlay === false, 'a desktop-sized window keeps the pane mic and draws no overlay')
  ok(desk.phase === 'recording', 'and is recording all the same')
}

console.log(`\n${checks - failed}/${checks} checks passed`)
process.exit(failed ? 1 : 0)
