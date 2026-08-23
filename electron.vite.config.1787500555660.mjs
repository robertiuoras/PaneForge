// electron.vite.config.ts
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
var __electron_vite_injected_dirname = "/Users/robertiuoras/Projects/PaneForge";
var ORT_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
function ortWasm() {
  return {
    name: "paneforge-ort-wasm",
    // onnxruntime-web names its default binary with `new URL(..., import.meta.url)`,
    // which vite resolves and emits as an asset - 23.5 MB of asyncify build that the
    // worker never asks for, because it sets wasmPaths to the pair copied below.
    // Measured: without this the build carries both, 36 MB for a 12.9 MB job.
    generateBundle(_opts, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      }
    },
    writeBundle() {
      const from = resolve(__electron_vite_injected_dirname, "node_modules/onnxruntime-web/dist");
      const to = resolve(__electron_vite_injected_dirname, "out/renderer/ort");
      mkdirSync(to, { recursive: true });
      for (const f of ORT_FILES) copyFileSync(resolve(from, f), resolve(to, f));
    }
  };
}
var electron_vite_config_default = defineConfig({
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
          index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts"),
          shelf: resolve(__electron_vite_injected_dirname, "src/preload/shelf.ts")
        }
      }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    resolve: { alias: { "@shared": resolve(__electron_vite_injected_dirname, "src/shared") } },
    // index.html is the app; shelf.html is the always-on-top clipboard overlay.
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html"),
          shelf: resolve(__electron_vite_injected_dirname, "src/renderer/shelf.html")
        }
      }
    },
    // The dictation worker is an ES module: it imports transformers.js, which
    // imports onnxruntime-web, and the classic-worker format cannot.
    worker: { format: "es" },
    plugins: [react(), ortWasm()]
  }
});
export {
  electron_vite_config_default as default
};
