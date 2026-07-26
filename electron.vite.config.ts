import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    plugins: [react()]
  }
})
