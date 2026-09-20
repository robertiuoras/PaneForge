import { hostname } from "node:os";

export function requireRenderPc() {
  if (process.platform !== "win32" || hostname().toUpperCase() !== "DESKTOP-CMSUCM1") {
    throw new Error("Browser and video rendering belongs on DESKTOP-CMSUCM1. Run node scripts/remote-render.mjs review|workspace. No local rendering fallback is permitted.");
  }
}
