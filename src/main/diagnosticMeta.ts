import { app } from 'electron'

let sequence = 0

/** Shared ordering across diagnostic files, including startup faults before app ready. */
export function diagnosticMeta(): { pid: number; version: string; seq: number } {
  let version = 'unknown'
  try { version = app.getVersion() } catch { /* crash logging can run during startup */ }
  return { pid: process.pid, version, seq: ++sequence }
}
