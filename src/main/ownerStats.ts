import { execFile } from 'node:child_process'
import type { OwnerStats } from '../shared/ownerStats'

const OWNER_ID = 100823588
const REPO = 'robertiuoras/PaneForge'
const TIMEOUT_MS = 15_000
// One hundred releases carry every asset's metadata. The current public history is about
// 2.8 MiB, so leave headroom while retaining a hard bound against a runaway CLI response.
const MAX_BUFFER = 8 * 1024 * 1024

type GitHubRelease = {
  tag_name?: unknown
  published_at?: unknown
  assets?: Array<{ name?: unknown; download_count?: unknown }>
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile('gh', args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    } catch (error) {
      reject(error)
    }
  })
}

async function ownerLogin(): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await gh(['api', 'user']))
    if (!raw || typeof raw !== 'object') return null
    const user = raw as { id?: unknown; login?: unknown }
    return user.id === OWNER_ID && typeof user.login === 'string' && user.login ? user.login : null
  } catch {
    return null
  }
}

/** True only for this repository owner's authenticated GitHub CLI account. */
export async function ownerAccess(): Promise<boolean> {
  return Boolean(await ownerLogin())
}

function count(release: GitHubRelease): OwnerStats['releases'][number] {
  let windows = 0
  let mac = 0
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const name = typeof asset?.name === 'string' ? asset.name : ''
    const downloads = typeof asset?.download_count === 'number' && asset.download_count >= 0
      ? asset.download_count
      : 0
    if (/^PaneForge.*\.exe$/i.test(name)) windows += downloads
    if (/^PaneForge.*\.dmg$/i.test(name)) mac += downloads
  }
  return {
    version: typeof release.tag_name === 'string' ? release.tag_name : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    windows,
    mac
  }
}

/**
 * Owner-only aggregate download data. GitHub's API reports asset fetches, not unique
 * users or IP addresses; no application telemetry is collected or inferred here.
 */
export async function ownerStats(): Promise<OwnerStats> {
  const login = await ownerLogin()
  if (!login) throw new Error('Owner access required')
  let releases: unknown
  try {
    releases = JSON.parse(await gh(['api', '-X', 'GET', `repos/${REPO}/releases`, '-f', 'per_page=100']))
  } catch {
    throw new Error('Could not read GitHub release statistics')
  }
  if (!Array.isArray(releases)) throw new Error('Could not read GitHub release statistics')
  return { login, fetchedAt: Date.now(), releases: releases.slice(0, 100).map((release) => count(release as GitHubRelease)) }
}
