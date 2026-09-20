import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4318,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4321", ws: true } },
  },
  build: { target: "es2022" },
});
