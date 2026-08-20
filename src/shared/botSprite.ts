/**
 * The mascot, as PIXEL ART rather than as curves.
 *
 * The old sprite was eight bezier paths, and at the 46px it is actually drawn at, a curve
 * is resolved by the rasteriser rather than by us: what was left read as a blob with two
 * triangles on it. A pixel grid is the opposite bargain - every cell is a decision that
 * survives to the screen, at any size, because `shape-rendering: crispEdges` refuses to
 * interpolate. 24x24 at 2x is 48 device pixels, so nothing here is ever drawn on a half
 * pixel.
 *
 * It is a ROBOT rather than an animal, and that is a decision about what the thing IS. It
 * is the face on three resource sweeps: it reads memory, it counts idle minutes and it
 * offers to close panes. A pet asks to be liked; a machine asks to be trusted with the
 * button it is holding, and the drawing should say which one is on screen.
 *
 * It is LAYERS, not whole frames. The chassis is drawn once and only the moving parts have
 * variants, which is what makes seven poses a page of art rather than seven drawings. And
 * nothing here MOVES vertically: the old fox bobbed on a 4.2s loop, which reads as floating
 * and was the first thing anybody complained about. What moves is what a machine moves
 * while it is standing still - a beacon pulses, a visor scans, the treads tick over, the
 * arms settle - and every one of those is an opacity step, which is what `npm run
 * test:anim` allows a looping animation to cost.
 */

/** One cell of art. `.` is transparent; the rest are the three shell shades plus the visor. */
export type Cell = '.' | 'd' | 'f' | 'l' | 'k'

/** Every layer is this wide and this tall, so one rect walker serves all of them. */
export const GRID = 24

export const CLASS_OF: Record<Exclude<Cell, '.'>, string> = {
  d: 'm-shell-d',
  f: 'm-shell',
  l: 'm-shell-l',
  k: 'm-visor'
}

/**
 * Rows as written, squared off. Padding BOTH ways is the point: a row one cell short does
 * not draw a wonky robot, it shifts every colour after it on that row - and that is a typo
 * nothing in the drawing code can notice.
 */
const art = (rows: string[]): string[] => {
  const out = rows.map((r) => (r.length >= GRID ? r.slice(0, GRID) : r + '.'.repeat(GRID - r.length)))
  while (out.length < GRID) out.push('.'.repeat(GRID))
  return out.slice(0, GRID)
}

/** The same drawing, moved down the grid. A settle is one arm drawn at three heights. */
const shift = (rows: string[], dy: number): string[] => {
  if (dy === 0) return rows.slice()
  const blank = '.'.repeat(GRID)
  const moved = dy > 0 ? [...Array.from({ length: dy }, () => blank), ...rows] : rows.slice(-dy)
  return art(moved)
}

/**
 * Head, visor recess, neck and chassis. No antenna, no pupil, no arm and no tread: each of
 * those moves on its own clock, and a part that moves cannot live in the drawing that does
 * not, or there is a second chassis to keep in step with this one.
 */
export const BODY = art([
  '',
  '',
  '',
  '',
  '',
  '.....dddddddddddd.......',
  '.....dffffffffffd.......',
  '.....dkkkkkkkkkkd.......',
  '.....dkkkkkkkkkkd.......',
  '.....dffffffffffd.......',
  '.....dddddddddddd.......',
  '.........dffffd.........',
  '....dddddddddddddd......',
  '....dffffffffffffd......',
  '....dffllllllllffd......',
  '....dffllllllllffd......',
  '....dffffffffffffd......',
  '....dffffffffffffd......',
  '....dddddddddddddd......'
])

/**
 * The antenna, at rest and knocked sideways.
 *
 * Same job the fox's ear flick had: a beat rather than a state. A pose held half the time
 * reads as a broken antenna, so the tilt is on for a few percent of its cycle.
 */
export const ANTENNA = {
  mast: art(['', '', '...........dd...........', '...........dd...........', '...........dd...........']),
  tilt: art(['', '', '.............dd.........', '............dd..........', '...........dd...........'])
} satisfies Record<string, string[]>

/** The light on top of it, pulsing. The one thing on the sprite that says it is powered. */
export const BEACON = {
  on: art(['', '..........llll..........']),
  off: art(['', '..........dddd..........'])
} satisfies Record<string, string[]>

/** Where it is looking. Two positions, so the visor scans rather than stares. */
export const EYES = {
  ahead: art(['', '', '', '', '', '', '', '.......llll.............', '.......llll.............']),
  look: art(['', '', '', '', '', '', '', '...........llll.........', '...........llll.........'])
} satisfies Record<string, string[]>

/** The visor going dark for a beat - a blink, drawn as a shutter over the whole screen. */
export const BLINK = art([
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '......dddddddddd........',
  '......dddddddddd........'
])

/**
 * The arms, at three heights.
 *
 * A machine standing still is not perfectly rigid: the arms settle a cell and come back.
 * Three drawings on one clock, exactly as the fox's tail sway was, and for the same reason
 * - the motion is WHICH drawing is showing, because a pixel grid cannot be rotated without
 * resampling and an opacity step is the only free move.
 */
const ARM_A = art([
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
  '',
  '',
  '',
  '..dd..............dd....',
  '..df..............fd....',
  '..df..............fd....',
  '..dd..............dd....'
])
export const ARMS = {
  idleA: ARM_A,
  idleB: shift(ARM_A, 1),
  idleC: shift(ARM_A, 2)
} satisfies Record<string, string[]>

/**
 * The treads, and the same treads with the cleats moved one cell.
 *
 * The fox shifted its weight between two standing poses; this ticks over. It is the
 * slowest clock on the sprite (7s) so it never lines up with the arms or the beacon into a
 * loop anybody can count.
 */
export const TREADS = {
  stand: art([
    ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
    '...dddddddddddddddd.....',
    '...dlldlldlldlldlld.....',
    '...dddddddddddddddd.....'
  ]),
  standB: art([
    ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
    '...dddddddddddddddd.....',
    '...lldlldlldlldlldl.....',
    '...dddddddddddddddd.....'
  ])
} satisfies Record<string, string[]>

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
  ...Object.values(ANTENNA),
  ...Object.values(BEACON),
  ...Object.values(EYES),
  ...Object.values(ARMS),
  ...Object.values(TREADS)
]
