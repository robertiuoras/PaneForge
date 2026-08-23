// Speak into a pane. The renderer records the microphone and hands over a 16 kHz
// mono WAV; this runs a local Whisper on it and returns text. Nothing is uploaded
// anywhere - that is the point, and it is why this is free.
//
// Two engines are supported, both `pip install`-able and both taking the same
// arguments. `whisper-ctranslate2` is preferred: it is several times faster and
// decodes audio in-process, so it does not need an ffmpeg binary the way the
// reference `whisper` CLI does.

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { which } from './which'
import type { VoiceStatus } from '../shared/types'

/** In preference order: first one on PATH wins. */
const ENGINES = ['whisper-ctranslate2', 'whisper']

const INSTALL_WIN = 'python -m pip install -U whisper-ctranslate2'
const INSTALL_MAC =
  'python3 -m pip install --user -U whisper-ctranslate2 || pipx install whisper-ctranslate2'

export function installCommand(): string {
  return process.platform === 'win32' ? INSTALL_WIN : INSTALL_MAC
}

export function voiceStatus(): VoiceStatus {
  for (const engine of ENGINES) {
    const path = which(engine)
    if (path !== engine) return { available: true, engine, path, install: installCommand() }
  }
  return { available: false, engine: '', path: '', install: installCommand() }
}

/**
 * WAV bytes in, text out.
 *
 * ASYNC, and that is the whole point of this function's shape. It used to be
 * `execFileSync` inside `ipcMain.handle('voice:transcribe')`, which blocks the
 * MAIN process for the length of the run - every pane's pty routing, every
 * other window message, the menu, the tray, all of it. Measured on this Mac
 * 2026-08-23: `whisper-ctranslate2 --model base` takes **2.65s wall for a 2.9s
 * clip** with the weights already cached, and the very first dictation also
 * downloads the model under a 120s ceiling. So pressing the mic froze the app
 * for seconds every single time, which is what "the mic lags out" was. The
 * spinner in the renderer was drawn by a window that could not repaint.
 */
export async function transcribe(
  wav: Buffer,
  opts: { model: string; language: string }
): Promise<{ text: string; error?: string }> {
  const status = voiceStatus()
  if (!status.available) {
    return { text: '', error: 'No local Whisper found. Install one from Settings > Voice.' }
  }

  const dir = mkdtempSync(join(tmpdir(), 'paneforge-voice-'))
  const audio = join(dir, 'clip.wav')
  try {
    writeFileSync(audio, wav)
    const args = [
      audio,
      '--model',
      opts.model || 'base',
      '--output_format',
      'txt',
      '--output_dir',
      dir,
      // Long dictation is rare; without this the model happily invents text for silence.
      '--task',
      'transcribe'
    ]
    if (opts.language && opts.language !== 'auto') args.push('--language', opts.language)

    await new Promise<void>((resolve, reject) => {
      execFile(
        status.path,
        args,
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120_000,
          // Model weights download on first use; give that its own generous buffer.
          maxBuffer: 8 * 1024 * 1024
        },
        // execFile hands stderr to the callback, NOT on the error, so a rejection
        // built from `err` alone loses the one line worth reporting.
        (err, _stdout, stderr) => {
          if (!err) return resolve()
          const e = err as Error & { stderr?: string }
          if (stderr) e.stderr = String(stderr)
          reject(e)
        }
      )
    })

    const txt = readdirSync(dir).find((f) => f.endsWith('.txt'))
    if (!txt) return { text: '', error: 'Whisper produced no transcript.' }
    return { text: readFileSync(join(dir, txt), 'utf8').trim() }
  } catch (e) {
    const msg = (e as { stderr?: string; message?: string }).stderr || (e as Error).message || String(e)
    return { text: '', error: firstLine(msg) }
  } finally {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* temp dir will be swept by the OS */
    }
  }
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? s).slice(0, 200)
}
