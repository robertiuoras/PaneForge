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
 * variants - which is what makes eleven poses a page of art rather than eleven drawings.
 * The parts that move are the ones an animal actually moves while it is standing still:
 * the tail sways, an ear flicks, the eye darts, the weight shifts from one pair of legs to
 * the other. None of them is a whole redraw, so an idle fox costs four opacity steps.
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

/**
 * Rows as written, squared off. Padding BOTH ways is the point: a row one cell short does
 * not draw a wonky fox, it shifts every colour after it on that row - and that is a typo
 * nothing in the drawing code can notice.
 */
const art = (rows: string[]): string[] => {
  const out = rows.map((r) => (r.length >= GRID ? r.slice(0, GRID) : r + '.'.repeat(GRID - r.length)))
  while (out.length < GRID) out.push('.'.repeat(GRID))
  return out.slice(0, GRID)
}

/** The same drawing, moved down the grid. A sway is one tail drawn at three heights. */
const shift = (rows: string[], dy: number): string[] => {
  if (dy === 0) return rows.slice()
  const blank = '.'.repeat(GRID)
  const moved = dy > 0 ? [...Array.from({ length: dy }, () => blank), ...rows] : rows.slice(-dy)
  return art(moved)
}

/**
 * Head, muzzle, chest and belly, facing right. No ear, no eye and no leg: each of those
 * moves on its own clock, and a part that moves cannot live in the drawing that does not.
 */
export const BODY = art([
  '',
  '',
  '',
  '............dfffffffffd.',
  '...........dffffffffffd.',
  '...........dffffffffffd.',
  '...........dffffffffffld',
  '...........dfffffffffllk',
  '...........dffffffffllld',
  '...........dfffffffflld.',
  '..........dfffffffffld..',
  '.....dffffffffffffffd...',
  '....dfffffffffffffffd...',
  '....dfffffffffffffffd...',
  '....dffffflllllllllld...',
  '.....dfffllllllllld.....',
  '.....ddddddddddddd......'
])

/**
 * Ears. Perked is the default; the flick is a beat of one, and they lie back while it
 * runs - which is the cheapest way to make a gallop read as effort rather than as legs.
 */
export const EARS = {
  perk: art([
    '..............d.....d...',
    '.............dld...dld..',
    '............dlld..dlld..'
  ]),
  flick: art([
    '...............d....d...',
    '..............dld..dld..',
    '.............dlld.dlld..'
  ]),
  back: art([
    '',
    '...........dld...dld....',
    '..........dlld..dlld....'
  ])
} satisfies Record<string, string[]>

/**
 * The eye, and the lid over it. The lid is drawn OVER the open eye rather than replacing
 * the head, so there is no second head to keep in step with this one.
 */
export const EYES = {
  ahead: art(['', '', '', '', '', '...............k........']),
  look: art(['', '', '', '', '', '................k.......'])
} satisfies Record<string, string[]>

export const BLINK = art(['', '', '', '', '', '..............dddd......'])

/**
 * Tail. One drawing at three heights is the whole idle sway, plus one streaming out
 * behind while it runs.
 */
const TAIL_IDLE = art([
  '',
  '',
  '',
  '',
  '',
  '',
  '...dll..................',
  '..dllld.................',
  '..dlllld................',
  '.dllllfd................',
  '.dlllfffd...............',
  '.dllffffd...............',
  '..dlffffff..............',
  '..dffffff...............',
  '...dfff.................',
  '....dd..................'
])
export const TAILS = {
  idleA: TAIL_IDLE,
  idleB: shift(TAIL_IDLE, -1),
  idleC: shift(TAIL_IDLE, -2),
  run: art([
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '....dll.................',
    '..dlllllfd..............',
    'dllllffffd..............',
    '.dddffff................'
  ])
} satisfies Record<string, string[]>

const legs = (...rows: string[]): string[] =>
  art([...Array.from({ length: 17 }, () => '.'.repeat(GRID)), ...rows])

/**
 * Legs. TWO standing poses - the weight shifts from one pair to the other, which is what
 * stops a standing animal reading as a sticker - and a four-beat gallop: reach, contact,
 * push, gather.
 */
export const LEGS = {
  stand: legs(
    '......ff.......ff.......',
    '......ff.......ff.......',
    '......ff.......ff.......',
    '......ff.......ff.......',
    '......dd.......dd.......'
  ),
  standB: legs(
    '......ff.......ff.......',
    '......ff.......ff.......',
    '......ff........ff......',
    '......ff........ff......',
    '......dd........dd......'
  ),
  run1: legs(
    '.....ff........ff.......',
    '....ff..........ff......',
    '...ff............ff.....',
    '...dd............dd.....'
  ),
  run2: legs(
    '......ff.......ff.......',
    '......ff........ff......',
    '.......ff.......ff......',
    '.......dd.......dd......'
  ),
  run3: legs(
    '.......ff.....ff........',
    '........ff...ff.........',
    '.........dd.dd..........',
    '.........dd.dd..........'
  ),
  run4: legs(
    '......ff.......ff.......',
    '.....ff.........ff......',
    '.....dd.........dd......'
  )
} satisfies Record<string, string[]>

/** Kicked up behind a running fox. Two puffs, faded by CSS. */
export const DUST = art([
  ...Array.from({ length: 20 }, () => '.'.repeat(GRID)),
  '...l....................',
  '..l..l..................'
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
  ...Object.values(EARS),
  ...Object.values(EYES),
  ...Object.values(TAILS),
  ...Object.values(LEGS)
]
