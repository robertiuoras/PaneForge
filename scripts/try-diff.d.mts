// Hand-written declarations for the .mjs `src/main/tour.ts` imports; tsc does not read
// JSDoc out of an ESM file it is only told to allow.
export interface TryDiff {
  base: string | null
  installed: string | null
  guessed: boolean
  lines: string[]
}
export interface TryCommit {
  subject: string
  /** the Conventional Commit scope, lower-cased - `header` from `fix(header): ...` */
  scope: string
  body: string
  files: string[]
}
export function installedVersion(): string | null
export function diffLines(root: string): TryDiff
export function diffCommits(root: string): Omit<TryDiff, 'lines'> & { commits: TryCommit[] }
export function report(root: string): string
