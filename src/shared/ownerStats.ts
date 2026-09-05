/**
 * Aggregate release-download figures available to the repository owner. These are GitHub
 * asset downloads, not people: one person may fetch several files or repeat a download.
 */
export interface OwnerStats {
  login: string
  fetchedAt: number
  /** Newest first, bounded to the latest 100 GitHub releases. */
  releases: Array<{
    version: string
    publishedAt: string
    windows: number
    mac: number
  }>
}
