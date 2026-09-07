// The ONNX Runtime wasm binary Whisper needs, fetched once instead of shipped.
//
// `node_modules/onnxruntime-web` alone is 130 MB and `onnxruntime-node` (a transitive
// dependency of `@huggingface/transformers` that this feature never touches - we run
// the `wasm` device, never `node`) is 210 MB; both used to ride into `app.asar` because
// `@huggingface/transformers` sat in `package.json`'s `dependencies`. It is a
// devDependency now (package.json, electron-builder ships only `dependencies`) and
// this file is what used to be a build-time `copyFileSync` into `out/renderer/ort/`
// (electron.vite.config.ts): the same two files, fetched from the npm registry the
// first time a clip needs them, hashed against what is pinned below, and kept in this
// window's Cache Storage so a second clip never asks the network again.
//
// Runs inside voiceWorker.ts, which is already a Worker with fetch/crypto.subtle/
// caches/DecompressionStream and no DOM - nothing here touches the page.

const CACHE_NAME = 'paneforge-voice-runtime-v1'

/**
 * The exact onnxruntime-web version this build's `@huggingface/transformers` resolves
 * to (package-lock.json), and the sha256 of the two files inside it this feature
 * loads - computed once, off the copies `npm install` already put on disk, and pinned
 * here so a compromised registry or a flipped bit in transit is a refusal, not a
 * silently different runtime.
 */
const RUNTIME = {
  pkg: 'onnxruntime-web',
  version: '1.26.0-dev.20260416-b7804b056c',
  files: {
    'package/dist/ort-wasm-simd-threaded.mjs':
      '5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d',
    'package/dist/ort-wasm-simd-threaded.wasm':
      'f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a'
  }
} as const

const CACHE_KEYS: Record<keyof typeof RUNTIME.files, string> = {
  'package/dist/ort-wasm-simd-threaded.mjs': `https://paneforge.local/voice-runtime/${RUNTIME.version}/ort-wasm-simd-threaded.mjs`,
  'package/dist/ort-wasm-simd-threaded.wasm': `https://paneforge.local/voice-runtime/${RUNTIME.version}/ort-wasm-simd-threaded.wasm`
}

export interface RuntimePaths {
  mjs: string
  wasm: string
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS's DOM lib types Uint8Array.slice()/subarray() results as Uint8Array<ArrayBufferLike>,
  // which SubtleCrypto's BufferSource does not accept - a fresh copy is a real ArrayBuffer.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Minimal ustar reader: only pulls the two entries named in `wanted`, ignores the rest. */
function extractTar(bytes: Uint8Array, wanted: Set<string>): Map<string, Uint8Array> {
  const found = new Map<string, Uint8Array>()
  const dec = new TextDecoder()
  let offset = 0
  while (offset + 512 <= bytes.length && found.size < wanted.size) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, '')
    const sizeStr = dec.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const typeFlag = String.fromCharCode(header[156])
    offset += 512
    if ((typeFlag === '0' || typeFlag === '\0') && wanted.has(name)) {
      found.set(name, bytes.slice(offset, offset + size))
    }
    offset += Math.ceil(size / 512) * 512
  }
  return found
}

async function fromCache(): Promise<RuntimePaths | null> {
  const cache = await caches.open(CACHE_NAME)
  const mjsRes = await cache.match(CACHE_KEYS['package/dist/ort-wasm-simd-threaded.mjs'])
  const wasmRes = await cache.match(CACHE_KEYS['package/dist/ort-wasm-simd-threaded.wasm'])
  if (!mjsRes || !wasmRes) return null
  return {
    mjs: URL.createObjectURL(await mjsRes.blob()),
    wasm: URL.createObjectURL(await wasmRes.blob())
  }
}

/**
 * Fetches the tarball once, verifies both files against the pinned hashes, caches
 * each individually, and returns object URLs for them. Throws (never returns a
 * partial/unverified result) on any network, decode or hash failure - the caller
 * falls back to another transcriber rather than run against a runtime nobody checked.
 */
export async function ensureRuntime(
  onProgress?: (pct: number) => void
): Promise<RuntimePaths> {
  const cached = await fromCache()
  if (cached) return cached

  const url = `https://registry.npmjs.org/${RUNTIME.pkg}/-/${RUNTIME.pkg}-${RUNTIME.version}.tgz`
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`voice runtime download failed: ${res.status} ${res.statusText}`)
  }

  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    if (total && onProgress) onProgress(Math.min(99, Math.round((loaded / total) * 100)))
  }
  const gz = new Uint8Array(loaded)
  let pos = 0
  for (const c of chunks) {
    gz.set(c, pos)
    pos += c.length
  }

  const ds = new DecompressionStream('gzip')
  const decompressed = new Response(new Blob([gz]).stream().pipeThrough(ds))
  const tar = new Uint8Array(await decompressed.arrayBuffer())

  const wanted = new Set(Object.keys(RUNTIME.files))
  const entries = extractTar(tar, wanted)
  if (entries.size !== wanted.size) {
    throw new Error('voice runtime download incomplete: expected files missing from the archive')
  }

  const cache = await caches.open(CACHE_NAME)
  for (const [name, want] of Object.entries(RUNTIME.files) as [keyof typeof RUNTIME.files, string][]) {
    const data = entries.get(name)!
    const got = await sha256Hex(data)
    if (got !== want) {
      throw new Error(`voice runtime hash mismatch for ${name}: expected ${want}, got ${got}`)
    }
    const contentType = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
    await cache.put(
      CACHE_KEYS[name],
      new Response(new Uint8Array(data), { headers: { 'content-type': contentType } })
    )
  }

  onProgress?.(99)
  const paths = await fromCache()
  if (!paths) throw new Error('voice runtime cache write failed')
  return paths
}
