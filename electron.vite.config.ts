import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dictation runs Whisper in the window (src/renderer/src/voiceWorker.ts) so that
 * nothing has to be pip-installed. ONNX Runtime's wasm ships with us rather than
 * being fetched from a CDN at run time: the model download is already the one
 * network call this feature makes, and an engine that needs the network EVERY
 * launch is not the offline promise the feature is sold on.
 *
 * The non-asyncify build is the one transformers.js itself uses on Safari - 12.9 MB
 * against the 23.5 MB default, doing the same CPU inference.
 */
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']

function ortWasm(): Plugin {
  return {
    name: 'paneforge-ort-wasm',
    // onnxruntime-web names its default binary with `new URL(..., import.meta.url)`,
    // which vite resolves and emits as an asset - 23.5 MB of asyncify build that the
    // worker never asks for, because it sets wasmPaths to the pair copied below.
    // Measured: without this the build carries both, 36 MB for a 12.9 MB job.
    generateBundle(_opts, bundle): void {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name]
      }
    },
    writeBundle(): void {
      const from = resolve(__dirname, 'node_modules/onnxruntime-web/dist')
      const to = resolve(__dirname, 'out/renderer/ort')
      mkdirSync(to, { recursive: true })
      for (const f of ORT_FILES) copyFileSync(resolve(from, f), resolve(to, f))
    }
  }
}

export default defineConfig({
  // node-pty is a native module: it must stay external (required from node_modules
  // at runtime) or the bundler will try to inline a .node binary and the app dies
  // on launch with "Cannot find module ... pty.node".
  main: { plugins: [externalizeDepsPlugin()] },
  // Two preloads: the app window's full bridge, and the floating clipboard overlay's
  // much smaller one (src/preload/shelf.ts).
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          shelf: resolve(__dirname, 'src/preload/shelf.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    // index.html is the app; shelf.html is the always-on-top clipboard overlay.
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          shelf: resolve(__dirname, 'src/renderer/shelf.html')
        }
      }
    },
    // The dictation worker is an ES module: it imports transformers.js, which
    // imports onnxruntime-web, and the classic-worker format cannot.
    worker: { format: 'es' },
    plugins: [react(), ortWasm()]
  }
})
