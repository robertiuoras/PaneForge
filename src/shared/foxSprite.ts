/**
 * The mascot, as PIXEL ART rather than as curves.
 *
 * The old sprite was eight bezier paths, and at the 46px it is actually drawn at, a curve
 * is resolved by the rasteriser rather than by us: the ears rounded off, the muzzle and the
 * head merged, and what was left read as a blob with two triangles on it. A pixel grid is
 * the opposite bargain - every cell is a decision that survives to the screen, at any size,
 * because `shape-rendering: crispEdges` refuses to interpolate. 24x24 at 2x is 48 device
 * pixels, so nothing here is ever drawn on a half pixel.
 *
 * It is LAYERS, not whole frames. A running fox differs from a standing one in its legs and
 * its tail and in nothing else, so the body is drawn once and only the moving parts have
 * variants - which is what makes six poses a page of art rather than six.
 *
 * Colours are the four `currentColor` mixes the vector version used, so the sprite still
 * re-tints with the accent and still keeps its light-to-dark reading on a light theme.
 */

/** One cell of art. `.` is transparent; the rest are the four fur shades plus the eye. */
export type Cell = '.' | 'd' | 'f' | 'l' | 'k'

/** Every layer is this wide and this tall, so one rect walker serves all of them. */
export const GRID = 24

export const CLASS_OF: Record<Exclude<Cell, '.'>, string> = {
  d: 'm-fur-d',
  f: 'm-fur',
  l: 'm-fur-l',
  k: 'm-eye'
}

const pad = (rows: string[]): string[] => {
  const out = rows.slice()
  while (out.length < GRID) out.push('.'.repeat(GRID))
  return out
}

/** Head, ears, chest and belly. Never moves, so it is drawn once under every pose. */
export const BODY = pad([
  '........................',
  '........................',
  '...............d..d.....',
  '..............dfd.dfd...',
  '..............dfd.dfd...',
  '.............dfffffffd..',
  '............dfffffffffd.',
  '............dffffkffffd.',
  '............dfffffffffd.',
  '...........dffffffffflld',
  '...........dffffffffllkd',
  '....dffffffffffffffffd..',
  '...dfffffffffffffffffd..',
  '...dfffffffffffffffffd..',
  '...dffffflllllllllfd....',
  '....dffffllllllllld.....',
  '....dfffffffffffffd.....'
])

/** The closed eye. Drawn over the body, so the open one underneath is covered rather than
 *  deleted - there is no second head to keep in step. */
export const BLINK = pad([
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '................ddd.....'
])

/** Tail. Two standing positions (this is the whole idle animation) and one streaming out
 *  behind while it runs. */
export const TAILS = {
  idleA: pad([
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '..dll...................',
    '.dllld..................',
    '.dlllfd.................',
    'dllfffd.................',
    'dlffffd.................',
    'dffffff.................',
    '.dfffff.................',
    '..dffff.................',
    '...dff..................'
  ]),
  idleB: pad([
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '..dll...................',
    '.dllld..................',
    '.dlllfd.................',
    'dllfffd.................',
    'dlffffd.................',
    'dffffff.................',
    '.dfffff.................',
    '..dffff.................',
    '...dff..................'
  ]),
  run: pad([
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '...dll..................',
    '.dllllfd................',
    'dllllffff...............',
    '.dddffff................'
  ])
} satisfies Record<string, string[]>

const legs = (r17: string, r18: string, r19: string, r20: string): string[] =>
  pad([
    ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
    r17,
    r18,
    r19,
    r20
  ])

/** Legs. One standing pair, and a four-beat gallop: reach, gather, push, float. */
export const LEGS = {
  stand: legs(
    '......ff.....ff.........',
    '......ff.....ff.........',
    '......dd.....dd.........',
    '......dd.....dd.........'
  ),
  run1: legs(
    '.....ff......ff.........',
    '....ff........ff........',
    '...dd..........dd.......',
    '...dd..........dd.......'
  ),
  run2: legs(
    '......ff.....ff.........',
    '.......ff.....ff........',
    '.......dd.....dd........',
    '........dd....dd........'
  ),
  run3: legs(
    '.......ff....ff.........',
    '........ff..ff..........',
    '.........dd.dd..........',
    '.........dd.dd..........'
  ),
  run4: legs(
    '......ff.....ff.........',
    '......ff.....ff.........',
    '.....dd.......dd........',
    '........................'
  )
} satisfies Record<string, string[]>

/** Kicked up behind a running fox. Two puffs, faded by CSS. */
export const DUST = pad([
  ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
  '..l.....................',
  '.l.l....................'
])

export type Rect = { x: number; y: number; w: number; cls: string }

/**
 * A layer as horizontal runs. One rect per run of the same colour rather than one per
 * cell: the whole sprite is ~90 rects instead of 576, and the runs are what a pixel row
 * actually is.
 */
export function runsOf(layer: string[]): Rect[] {
  const out: Rect[] = []
  layer.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const c = row[x] as Cell
      if (c === '.') {
        x += 1
        continue
      }
      let w = 1
      while (x + w < row.length && row[x + w] === c) w += 1
      out.push({ x, y, w, cls: CLASS_OF[c as Exclude<Cell, '.'>] })
      x += w
    }
  })
  return out
}

/** Every layer in one list, so a test can check the grid is square without naming them. */
export const ALL_LAYERS: string[][] = [
  BODY,
  BLINK,
  DUST,
  ...Object.values(TAILS),
  ...Object.values(LEGS)
]
