import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dictation runs Whisper in the window (src/renderer/src/voiceWorker.ts). ONNX
 * Runtime's wasm is no longer copied into `out/renderer/ort/` at build time - it is
 * fetched once from the npm registry on first use and hash-verified
 * (src/renderer/src/voiceRuntime.ts), which is why `onnxruntime-web` (130 MB) moved
 * out of `dependencies` and stopped riding into every install regardless of whether
 * dictation was ever pressed.
 */
function ortWasm(): Plugin {
  return {
    name: 'paneforge-ort-wasm',
    // onnxruntime-web names its default binary with `new URL(..., import.meta.url)`,
    // which vite resolves and emits as an asset - 23.5 MB of asyncify build the
    // worker never asks for, because voiceRuntime.ts sets wasmPaths to the fetched
    // pair instead. Without this the build still carries it for nothing.
    generateBundle(_opts, bundle): void {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name]
      }
    }
  }
}

export default defineConfig({
  // node-pty is a native module: it must stay external (required from node_modules
  // at runtime) or the bundler will try to inline a .node binary and the app dies
  // on launch with "Cannot find module ... pty.node".
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'watchdog-child': resolve(__dirname, 'src/main/watchdog-child.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    // The dictation worker is an ES module: it imports transformers.js, which
    // imports onnxruntime-web, and the classic-worker format cannot.
    worker: { format: 'es' },
    plugins: [react(), ortWasm()]
  }
})
