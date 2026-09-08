// The runtime fetch/hash/cache logic behind dictation (src/renderer/src/voiceRuntime.ts),
// proved without a window: nothing downloads until asked, a bad hash refuses and leaves
// no cache entry to trip up the next attempt, and a cached runtime is never re-fetched.
//
// Compiled through esbuild like every other script here (voice-test.mjs, voicePick's
// own load) rather than run as TypeScript directly.

import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
let checks = 0
const ok = (cond, what) => {
  checks++
  if (!cond) {
    failed++
    console.error(`  FAIL  ${what}`)
  }
}

// Node has had a global Web Crypto object since v19; this repo's CI/dev machines are
// well past that, but fail loudly rather than silently skip if it is ever missing.
if (!globalThis.crypto?.subtle) throw new Error('globalThis.crypto.subtle is required to run this suite')
if (typeof globalThis.DecompressionStream !== 'function') {
  throw new Error('globalThis.DecompressionStream is required to run this suite')
}
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = (blob) => `blob:test/${Math.random()}`

// --- a tiny in-memory Cache Storage, since Node has no `caches` global -----------------
function fakeCaches() {
  const store = new Map()
  return {
    store,
    async open() {
      return {
        async match(key) {
          // Real Cache Storage hands back a fresh Response per match() call; a body
          // can only be read once, so returning the stored instance as-is broke the
          // second of two ensureRuntime() calls in this suite with "Body is unusable".
          const res = store.get(key)
          return res ? res.clone() : undefined
        },
        async put(key, res) {
          store.set(key, res)
        }
      }
    }
  }
}

// --- build a real gzip'd ustar tarball with exactly the two entries the module wants ---
function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write(data.length.toString(8).padStart(11, '0'), 124, 'ascii')
  header.write('0', 156, 'ascii') // typeflag: regular file
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  Buffer.from(data).copy(body)
  return Buffer.concat([header, body])
}

function tarball(entries) {
  const parts = entries.map(([name, data]) => tarEntry(name, data))
  parts.push(Buffer.alloc(1024)) // end-of-archive marker
  return gzipSync(Buffer.concat(parts))
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const MJS = new TextEncoder().encode('/* ort-wasm-simd-threaded.mjs stand-in */')
const WASM = new TextEncoder().encode('not really wasm bytes, just fixture content')
const NAMES = ['package/dist/ort-wasm-simd-threaded.mjs', 'package/dist/ort-wasm-simd-threaded.wasm']

const [mjsHash, wasmHash] = await Promise.all([sha256Hex(MJS), sha256Hex(WASM)])

async function loadModule() {
  const out = buildSync({
    entryPoints: [join(root, 'src/renderer/src/voiceRuntime.ts')],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'neutral',
    define: {
      // The module pins the real onnxruntime-web version/hashes; the fixture above
      // is deliberately different content, so the pinned hashes are swapped in here
      // rather than faked at the network layer, to prove the VERIFY step for real.
    }
  })
  let code = out.outputFiles[0].text
  code = code.replace(
    /5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d/,
    mjsHash
  )
  code = code.replace(
    /f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a/,
    wasmHash
  )
  return await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}

// --- case 1: nothing downloads until asked -----------------------------------------
{
  const src = readFileSync(join(root, 'src/renderer/src/voiceWorker.ts'), 'utf8')
  const fromImport = src.indexOf("from './voiceRuntime'")
  const insideLoad = src.slice(0, src.indexOf('async function load(')).includes('ensureRuntime(')
  ok(fromImport > -1, 'voiceWorker imports voiceRuntime')
  ok(!insideLoad, 'ensureRuntime is not called before the load() function is even defined')
  ok(/async function load\(msg[\s\S]*ensureRuntime\(/.test(src), 'ensureRuntime is called from inside load(), which only runs on a worker "load" message')
}

// --- case 2: good hash, first call fetches and caches -------------------------------
{
  const good = tarball([[NAMES[0], MJS], [NAMES[1], WASM]])
  let fetchCalls = 0
  globalThis.fetch = async (url) => {
    fetchCalls++
    ok(String(url).includes('registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-'), 'fetches the pinned npm registry tarball')
    return new Response(good, { status: 200, headers: { 'content-length': String(good.length) } })
  }
  globalThis.caches = fakeCaches()
  const { ensureRuntime } = await loadModule()

  const progressSeen = []
  const paths = await ensureRuntime((pct) => progressSeen.push(pct))
  ok(typeof paths.mjs === 'string' && typeof paths.wasm === 'string', 'resolves with mjs/wasm paths')
  ok(fetchCalls === 1, `fetched exactly once (got ${fetchCalls})`)
  ok(progressSeen.length > 0, 'progress was reported during the download')

  // --- case 3: a second call, same cache, must not touch the network --------------
  const paths2 = await ensureRuntime()
  ok(fetchCalls === 1, `a cached runtime is not re-fetched (still ${fetchCalls} call)`)
  ok(!!paths2.mjs && !!paths2.wasm, 'the cached call still resolves with real paths')
}

// --- case 4: a bad hash refuses, and leaves nothing behind to poison a retry --------
{
  const bad = tarball([[NAMES[0], new TextEncoder().encode('tampered')], [NAMES[1], WASM]])
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls++
    return new Response(bad, { status: 200, headers: { 'content-length': String(bad.length) } })
  }
  const fresh = fakeCaches()
  globalThis.caches = fresh
  const { ensureRuntime } = await loadModule()

  let threw = null
  try {
    await ensureRuntime()
  } catch (e) {
    threw = e
  }
  ok(!!threw, 'a tampered/mismatched file is refused, not silently accepted')
  ok(/hash mismatch/i.test(threw?.message || ''), `the refusal names the reason (got: ${threw?.message})`)
  ok(fresh.store.size === 0, 'nothing was written to the cache on a failed verify')
}

console.log(`\n${checks - failed}/${checks} checks passed`)
process.exit(failed ? 1 : 0)
