// The fetch and the remembering behind `shared/whatsNew.ts`.
//
// One request, once, on the first launch of a build that is newer than the one this
// machine last spoke about. Everything about it is arranged so that it can only ever be
// silent or right: a refusal, a 404, no network, a body with no bullets in it and a
// rollback all produce NO CARD rather than an empty one or an error.

import { app, net } from 'electron'
import { getConfig, setConfig } from './config'
import { bulletsFrom, shouldSpeak, type WhatsNew } from '../shared/whatsNew'

const TAG_API = 'https://api.github.com/repos/robertiuoras/PaneForge/releases/tags/'
const PAGE = 'https://github.com/robertiuoras/PaneForge/releases/tag/'

/**
 * Short, because nothing waits on it.
 *
 * This runs on a launch that has panes to restore, and a card about the last release is
 * the least urgent thing the app does. A slow answer is simply not worth having: the
 * version is left unremembered, so the next launch asks again.
 */
const TIMEOUT_MS = Math.max(1000, Number(process.env.PF_WHATSNEW_TIMEOUT_MS) || 6000)

async function body(version: string): Promise<string | null> {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), TIMEOUT_MS)
  try {
    // `net.fetch` rather than global fetch: it goes through Chromium's own stack, which
    // is the one that already knows this machine's proxy and its certificates.
    const r = await net.fetch(TAG_API + 'v' + version, {
      signal: c.signal,
      headers: { accept: 'application/vnd.github+json' }
    })
    if (!r.ok) return null
    const j = (await r.json()) as { body?: string } | null
    return typeof j?.body === 'string' ? j.body : null
  } catch {
    // No network, a timeout, an error page where JSON was promised. All the same fact
    // from here: nobody can be told what changed, so nobody is told anything.
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * What to draw on this launch, or null.
 *
 * The version is remembered ONLY when a card is actually produced, and that asymmetry is
 * the point: a launch with no network leaves `seenVersion` where it was, so the card
 * appears on the next launch that can reach GitHub instead of being lost. The two silent
 * paths that DO remember are the ones where there is nothing to come back for - a fresh
 * install (no previous build to have changed from) and a rollback.
 */
export async function whatsNew(): Promise<WhatsNew | null> {
  const version = app.getVersion()
  const seen = getConfig().seenVersion
  if (!shouldSpeak(version, seen)) {
    if (seen !== version) setConfig({ seenVersion: version })
    return null
  }
  const raw = await body(version)
  const bullets = bulletsFrom(raw)
  // A release with no readable bullets - hand-written, or the commit-history fallback -
  // has nothing to summarise. Say nothing, and do NOT remember: the notes may be edited.
  if (!bullets.length) return null
  setConfig({ seenVersion: version })
  const all = bulletsFrom(raw ?? '')
  return {
    version,
    bullets,
    more: Math.max(0, countBullets(raw) - all.length),
    url: PAGE + 'v' + version
  }
}

/** Every list item in the body, so the card can honestly say how many it left out. */
function countBullets(raw: string | null): number {
  if (!raw) return 0
  return raw.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).length
}
