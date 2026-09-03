// Type declarations for try-diff.mjs, so a TypeScript caller (src/main/tour.ts) can
// import it without pulling `allowJs` on for the whole program. Keep in sync by hand -
// there is no build step here to generate it from the .mjs.

export interface DiffLines {
  base: string | null
  installed: string | null
  guessed: boolean
  lines: string[]
}

export function installedVersion(): string | null
export function diffLines(root: string): DiffLines
export function report(root: string): string
