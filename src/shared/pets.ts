/**
 * Ten pets, one drawing machine.
 *
 * `botSprite.ts` drew ONE mascot: a robot, as pixel art, in layers, where the motion is
 * WHICH layer is showing rather than a transform on a curve. That decision is what makes
 * a second pet cheap - the animation lives entirely in the stylesheet, keyed on class
 * names, so a new pet is ART and nothing else. No new keyframes, no new timers, no new
 * cost: exactly one pet's layers are ever mounted, and each layer is walked into
 * horizontal runs ONCE per app run and cached by identity (`Mascot.tsx`).
 *
 * Every pet is on the SAME 24x24 grid as the robot, and that is a decision about pixels
 * rather than about taste. The sprite is drawn at 48 CSS pixels, so 24 cells is exactly 2
 * device pixels a cell on a 2x screen and `shape-rendering: crispEdges` never has a half
 * pixel to resolve. A "more detailed" 32x32 pet would be 1.5 device pixels a cell - which
 * is the blur the pixel grid replaced. Detail here comes from LAYERS and shades, not from
 * more cells.
 *
 * **An eye is not a lit rectangle.** The first ten pets drew every eye as two or three
 * cells of the accent colour, which is a lamp rather than a face: at 48px a flat block
 * has no direction, no roundness and nothing to blink, so nine of the ten read as a
 * coloured blob with two dots and the report was the plain version of that - "our pets
 * look terrible". An eye that reads is three colours in one shape: a light ring (`l`) so
 * the eye has a white to sit in, a near-black pupil (`k`) so it has somewhere to point,
 * and one cell of the ring left showing at the top as the glint. `EYE`, `EYE_S` and
 * `EYE_B` below are that shape at three sizes, stamped in one place by `both()` so the
 * pair can never drift a cell apart. The `look` frame moves the PUPIL inside the ring
 * rather than moving the whole eye sideways, which is the difference between a glance and
 * the whole face sliding.
 *
 * The same rule made the rest of the features: an ear is an outline with a warm inner
 * (`d` around `a`), a muzzle is a light patch with a dark nose in it, a chest is a lighter
 * shade of the body rather than a different colour. Three shades of one hue plus the
 * accent is the whole palette - there is no fifth colour to reach for, and that is what
 * keeps ten pets looking like one family.
 *
 * The slots are named for what the robot does with them, and every pet is free to mean
 * something else by the same slot - the stylesheet only knows the clock:
 *
 *   arms   (3 frames, 4.8s) - a settle. A tail sway, a wing, a claw, a drip.
 *   treads (2 frames, 7s)   - the slowest tick. Paws, feet, rotors, a wisp's hem.
 *   antenna(2 frames, 9s)   - a rare flick. An ear, a whisker, a crest.
 *   beacon (2 frames, 2.4s) - a pulse. A collar tag, a nose, a rotor light.
 *   eyes   (2 frames, 6.5s) - a glance. Both positions, so nothing stares.
 *   blink  (on the app's own 5.2s timer) - a shutter over the eye rows.
 *
 * A pet may leave any of them out and simply be stiller. What it may NOT do is move
 * vertically on a loop: the first mascot bobbed and floating is the one thing everybody
 * complained about. `npm run test:anim` refuses anything but transform and opacity, and
 * `npm run test:mascot` refuses a wonky grid, an unknown colour and a pose nothing draws.
 */

/** One cell of art. `.` is transparent; three shell shades, the dark glass, the accent. */
export type Cell = '.' | 'd' | 'f' | 'l' | 'k' | 'a'

/** Every layer of every pet is this wide and this tall, so one rect walker serves all. */
export const GRID = 24

export const CLASS_OF: Record<Exclude<Cell, '.'>, string> = {
  d: 'm-shell-d',
  f: 'm-shell',
  l: 'm-shell-l',
  k: 'm-visor',
  a: 'm-accent'
}

/**
 * Rows as written, squared off. Padding BOTH ways is the point: a row one cell short does
 * not draw a wonky pet, it shifts every colour after it on that row - and that is a typo
 * nothing in the drawing code can notice.
 */
export const art = (rows: string[]): string[] => {
  const out = rows.map((r) => (r.length >= GRID ? r.slice(0, GRID) : r + '.'.repeat(GRID - r.length)))
  while (out.length < GRID) out.push('.'.repeat(GRID))
  return out.slice(0, GRID)
}

/** An empty grid, for a layer built by stamping rather than by typing rows. */
const blank = (): string[] => art([])

/**
 * A block of cells written into a copy of `rows` at (x, y); `.` inside the block leaves
 * whatever was underneath.
 *
 * Counting dots is how an eye ends up one cell from its twin, and a pair of eyes half a
 * pixel apart is exactly the wrongness nobody can name when they say a face looks off. A
 * stamped block cannot drift: the same four rows go down at two x positions.
 */
export const stamp = (rows: string[], x: number, y: number, block: string[]): string[] => {
  const out = art(rows).map((r) => [...r])
  block.forEach((line, dy) => {
    const ry = y + dy
    if (ry < 0 || ry >= GRID) return
    ;[...line].forEach((c, dx) => {
      const rx = x + dx
      if (c === '.' || rx < 0 || rx >= GRID) return
      out[ry][rx] = c
    })
  })
  return out.map((r) => r.join(''))
}

/** The same block at two columns: a pair of eyes, a pair of ears, two paws. */
const both = (block: string[], x1: number, x2: number, y: number): string[] =>
  stamp(stamp(blank(), x1, y, block), x2, y, block)

/** A lid: a solid block of one colour, the size of the eye it has to cover. */
const lid = (w: number, h: number, c: Cell): string[] => Array.from({ length: h }, () => String(c).repeat(w))

// The eyes themselves. A ring, a pupil, and the top of the ring left showing as a glint -
// the only three things that make a pixel eye read as an eye rather than as a lamp.
const EYE = ['.ll.', 'lkkl', 'lkkl', '.ll.']
const EYE_LOOK = ['.ll.', 'llkk', 'llkk', '.ll.']
const EYE_S = ['ll.', 'lkk', '.kk']
const EYE_S_LOOK = ['.ll', 'kkl', 'kk.']
const EYE_B = ['.aaaa.', 'alllla', 'alkkla', 'alkkla', 'alllla', '.aaaa.']
const EYE_B_LOOK = ['.aaaa.', 'alllla', 'allkka', 'allkka', 'alllla', '.aaaa.']

/** The same drawing, moved down the grid. A settle is one part drawn at three heights. */
export const shift = (rows: string[], dy: number): string[] => {
  if (dy === 0) return art(rows)
  const blankRow = '.'.repeat(GRID)
  const moved = dy > 0 ? [...Array.from({ length: dy }, () => blankRow), ...rows] : rows.slice(-dy)
  return art(moved)
}

/** Three frames off one drawing: at rest, a cell down, two cells down. */
const settle = (rows: string[]): { a: string[]; b: string[]; c: string[] } => ({
  a: art(rows),
  b: shift(rows, 1),
  c: shift(rows, 2)
})

export interface PetArt {
  /** Drawn once and never moved. Everything that moves is a slot below. */
  body: string[]
  /** A shutter over the eye rows. Absent means the pet does not blink. */
  blink?: string[]
  eyes?: { ahead: string[]; look: string[] }
  beacon?: { on: string[]; off: string[] }
  antenna?: { mast: string[]; tilt: string[] }
  arms?: { a: string[]; b: string[]; c: string[] }
  treads?: { a: string[]; b: string[] }
  /** Where the ground shadow sits, in grid cells. A hovering pet puts it lower and fainter. */
  shadow?: { cx: number; cy: number; rx: number; ry: number; opacity?: number }
}

export interface Pet {
  id: string
  /** What the picker calls it. */
  name: string
  /** One line under the name, so the picker is readable without hovering every swatch. */
  note: string
  art: PetArt
}

const SHADOW = { cx: 11.5, cy: 22.6, rx: 8, ry: 1 }

/* ---------------------------------------------------------------- 1. the robot ---- */

const bot: Pet = {
  id: 'bot',
  name: 'Bit',
  note: 'The robot. Lit eyes behind glass, a chest lamp, treads.',
  art: {
    body: art([
      '',
      '',
      '......dddddddddddd',
      '......dffffffffffd',
      '......dfkkkkkkkkfd',
      '......dfkkkkkkkkfd',
      '......dfkkkkkkkkfd',
      '......dfkkkkkkkkfd',
      '......dffffffffffd',
      '......dddddddddddd',
      '.........dd..dd',
      '....dddddddddddddddd',
      '....dffffffffffffffd',
      '....dffddddddddddffd',
      '....dffdlllllllldffd',
      '....dffdlllllllldffd',
      '....dffddddddddddffd',
      '....dffffffffffffffd',
      '....dddddddddddddddd'
    ]),
    // The glass, not the shell: a robot shuts its eyes by going dark behind the visor.
    blink: both(lid(3, 3, 'k'), 8, 14, 5),
    eyes: {
      ahead: both(['la.', 'aa.', 'aa.'], 8, 14, 5),
      look: both(['.la', '.aa', '.aa'], 8, 14, 5)
    },
    beacon: {
      on: stamp(blank(), 10, 14, ['aa', 'aa']),
      off: stamp(blank(), 10, 14, ['ll', 'll'])
    },
    antenna: {
      mast: art(['..........dd', '..........dd', '..........dd']),
      tilt: art(['............dd', '...........dd', '..........dd'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '',
        '..dd..................dd',
        '..df..................fd',
        '..df..................fd',
        '..dd..................dd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '...dddddddddddddddd',
        '...dlldlldlldlldlld',
        '...dddddddddddddddd'
      ]),
      b: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '...dddddddddddddddd',
        '...lldlldlldlldlldl',
        '...dddddddddddddddd'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------- 2. the fox ---- */

const fox: Pet = {
  id: 'fox',
  name: 'Vix',
  note: 'A fox with a lit collar. Tail sway, ear flick.',
  art: {
    body: art([
      '',
      '',
      '.....d............d',
      '....dad..........dad',
      '....daad........daad',
      '....dddddddddddddddd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dfffllllllllfffd',
      '....dffflllkklllfffd',
      '....dfffllllllllfffd',
      '.....dddddddddddddd',
      '.....aaaaaaaaaaaaaa',
      '.....dffffffffffffd',
      '.....dfffllllllfffd',
      '.....dfffllllllfffd',
      '.....dfffllllllfffd',
      '.....dffffffffffffd',
      '.....dddddddddddddd'
    ]),
    blink: both(lid(4, 4, 'f'), 6, 14, 7),
    eyes: { ahead: both(EYE, 6, 14, 7), look: both(EYE_LOOK, 6, 14, 7) },
    beacon: {
      on: stamp(blank(), 10, 15, ['ll']),
      off: stamp(blank(), 10, 15, ['dd'])
    },
    antenna: {
      mast: art(['', '', '.....d............d', '....dad..........dad']),
      tilt: art(['', '', '....d..............d', '...dad............dad'])
    },
    // The tail, drawn behind the body - arms are mounted before it, so the hip covers
    // the root and only the sweep shows.
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '',
        '..................ddd',
        '.................dfffd',
        '................dfllfd',
        '................dfllfd',
        '.................dfffd',
        '..................ddd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 21 }, () => '.'.repeat(GRID)),
        '......dddd....dddd',
        '......dlld....dlld'
      ]),
      b: art([
        ...Array.from({ length: 21 }, () => '.'.repeat(GRID)),
        '.....dddd......dddd',
        '.....dlld......dlld'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------- 3. the cat ---- */

const cat: Pet = {
  id: 'cat',
  name: 'Pip',
  note: 'A sitting cat. Tail sway, whisker twitch.',
  art: {
    body: art([
      '',
      '......d..........d',
      '.....dad........dad',
      '.....daad......daad',
      '.....daaad....daaad',
      '.....dddddddddddddd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffllllllllffd',
      '.....dfflllkklllffd',
      '.....dffllllllllffd',
      '......dddddddddddd',
      '......dffffffffffd',
      '......dfffllllfffd',
      '......dfffllllfffd',
      '......dfffllllfffd',
      '......dffffffffffd',
      '......dddddddddddd'
    ]),
    blink: both(lid(4, 4, 'f'), 7, 13, 6),
    eyes: { ahead: both(EYE, 7, 13, 6), look: both(EYE_LOOK, 7, 13, 6) },
    beacon: {
      on: stamp(blank(), 11, 11, ['ll']),
      off: stamp(blank(), 11, 11, ['kk'])
    },
    // Whiskers: three cells each side, flicked up a row.
    antenna: {
      mast: art(['', '', '', '', '', '', '', '', '', '..ddd..............ddd']),
      tilt: art(['', '', '', '', '', '', '', '', '.ddd................ddd'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '.................ddd',
        '................dfffd',
        '................dffld',
        '.................dffd',
        '..................dd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '.....dddd......dddd',
        '.....dlld......dlld'
      ]),
      b: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '......dddd....dddd',
        '......dlld....dlld'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------- 4. the dog ---- */

const dog: Pet = {
  id: 'dog',
  name: 'Rook',
  note: 'A shiba with floppy ears. Tail wag, a wet nose.',
  art: {
    body: art([
      '',
      '',
      '',
      '.....dddddddddddddd',
      '...dddffffffffffffddd',
      '...dfdffffffffffffdfd',
      '...dfdffffffffffffdfd',
      '...dfdffffffffffffdfd',
      '...dfdffffffffffffdfd',
      '...dfddffffffffffddfd',
      '....ddfffllllllfffdd',
      '.....dfflllkkllfffd',
      '.....dffllllllllffd',
      '......dddddddddddd',
      '......dffffffffffd',
      '......dfffllllfffd',
      '......dfffllllfffd',
      '......dffffffffffd',
      '......dddddddddddd'
    ]),
    blink: both(lid(4, 4, 'f'), 7, 13, 5),
    eyes: { ahead: both(EYE, 7, 13, 5), look: both(EYE_LOOK, 7, 13, 5) },
    // The nose, which is the one thing on a dog that is worth a pulse.
    beacon: {
      on: stamp(blank(), 11, 11, ['aa']),
      off: stamp(blank(), 11, 11, ['kk'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '.................ddd',
        '................dfffd',
        '................dfllfd',
        '.................dffd',
        '..................dd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '.....dddd......dddd',
        '.....dlld......dlld'
      ]),
      b: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '......dddd....dddd',
        '......dlld....dlld'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------- 5. the owl ---- */

const owl: Pet = {
  id: 'owl',
  name: 'Hoot',
  note: 'An owl. Big ringed eyes, slow wings, a crest flick.',
  art: {
    body: art([
      '',
      '',
      '.....d............d',
      '....dfd..........dfd',
      '....dffddddddddddffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '.....dffffffffffffd',
      '.....dffllllllllffd',
      '.....dffllllllllffd',
      '.....dffllllllllffd',
      '.....dfffllllllfffd',
      '......dffffffffffd',
      '.......dddddddddd'
    ]),
    blink: both(lid(6, 6, 'f'), 5, 13, 5),
    eyes: { ahead: both(EYE_B, 5, 13, 5), look: both(EYE_B_LOOK, 5, 13, 5) },
    // The beak, between the two eye rings.
    beacon: {
      on: stamp(blank(), 11, 10, ['aa', 'aa', '.a']),
      off: stamp(blank(), 11, 10, ['dd', 'dd', '.d'])
    },
    antenna: {
      mast: art(['', '', '.....d............d', '....dfd..........dfd']),
      tilt: art(['', '', '....d..............d', '...dfd............dfd'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '',
        '...dd................dd',
        '..dffd..............dffd',
        '..dffd..............dffd',
        '..dffd..............dffd',
        '...dd................dd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '.......ddd..ddd',
        '.......dad..dad'
      ]),
      b: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '......ddd....ddd',
        '......dad....dad'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------ 6. the crab ---- */

const crab: Pet = {
  id: 'crab',
  name: 'Nip',
  note: 'A crab. Clacking claws, eyes on stalks, a scuttle.',
  art: {
    body: art([
      '',
      '',
      '',
      '',
      '',
      '',
      '.........dd....dd',
      '.........dd....dd',
      '.....dddddddddddddd',
      '....dffffffffffffffd',
      '...dffllllllllllllffd',
      '...dfflllllllllllllfd',
      '...dffllllllllllllffd',
      '...dffffffffffffffffd',
      '....dddddddddddddddd',
      '.....dffffffffffffd',
      '......dddddddddddd'
    ]),
    blink: both(lid(4, 4, 'f'), 8, 13, 2),
    eyes: { ahead: both(EYE, 8, 13, 2), look: both(EYE_LOOK, 8, 13, 2) },
    beacon: {
      on: stamp(blank(), 10, 12, ['aaaa']),
      off: stamp(blank(), 10, 12, ['llll'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '',
        '..ddd................ddd',
        '.dfffd..............dfffd',
        '.dfld..................dfd',
        '..ddd................ddd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '...dd..dd....dd..dd',
        '...dd..dd....dd..dd'
      ]),
      b: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '..dd....dd..dd....dd',
        '..dd....dd..dd....dd'
      ])
    },
    shadow: SHADOW
  }
}

/* ----------------------------------------------------------------- 7. the slime ---- */

const slime: Pet = {
  id: 'slime',
  name: 'Goo',
  note: 'A slime. Drips, a wobbling hem, a bright core.',
  art: {
    body: art([
      '',
      '',
      '',
      '..........dddd',
      '........ddffffdd',
      '.......dffffffffd',
      '......dffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dffffffffffffffd',
      '....dfflllllllllfffd',
      '....dfflllllllllfffd',
      '....dffffffffffffffd',
      '.....dddddddddddddd'
    ]),
    blink: both(lid(4, 4, 'f'), 6, 14, 8),
    eyes: { ahead: both(EYE, 6, 14, 8), look: both(EYE_LOOK, 6, 14, 8) },
    // The core, seen through the body.
    beacon: {
      on: stamp(blank(), 10, 12, ['aaaa', 'aaaa']),
      off: stamp(blank(), 10, 12, ['llll', 'llll'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '...dd..............dd',
        '...dl..............ld'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '.....dffdffdffdffdffd',
        '......dd.dd.dd.dd.dd'
      ]),
      b: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '.....ffdffdffdffdffdf',
        '.....dd.dd.dd.dd.dd'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------ 8. the dino ---- */

const dino: Pet = {
  id: 'dino',
  name: 'Rex',
  note: 'A small raptor. Tail counterweight, a jaw twitch.',
  art: {
    body: art([
      '',
      '',
      '',
      '....dddddd',
      '...dffffffd',
      '...dffffffd',
      '...dffffffd',
      '...dfffffffdd',
      '...dddddddddd',
      '....dddddddddddd',
      '....dffffffffffd',
      '....dfflllllfffd',
      '....dfflllllfffd',
      '....dfflllllfffd',
      '....dffffffffffd',
      '....dddddddddddd'
    ]),
    blink: stamp(blank(), 5, 5, lid(3, 3, 'f')),
    eyes: { ahead: stamp(blank(), 5, 5, EYE_S), look: stamp(blank(), 5, 5, EYE_S_LOOK) },
    // The jaw: one accent cell at the corner of the mouth, blinking like a breath.
    beacon: {
      on: stamp(blank(), 11, 7, ['a']),
      off: stamp(blank(), 11, 7, ['f'])
    },
    // The crest along the top of the skull.
    antenna: {
      mast: art(['', '', '', '....aaaaaa']),
      tilt: art(['', '', '', '.....aaaaaa'])
    },
    // The tail, counterweighting the head - drawn behind the body.
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '',
        '..............dddd',
        '.............dffffd',
        '.............dfllffd',
        '..............dfffd',
        '...............ddd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 16 }, () => '.'.repeat(GRID)),
        '.....dddd..dddd',
        '.....dlld..dlld'
      ]),
      b: art([
        ...Array.from({ length: 16 }, () => '.'.repeat(GRID)),
        '......dddd..dddd',
        '......dlld..dlld'
      ])
    },
    shadow: SHADOW
  }
}

/* ----------------------------------------------------------------- 9. the drone ---- */

const drone: Pet = {
  id: 'drone',
  name: 'Kite',
  note: 'A quadcopter. Rotor blur, one lens, a low shadow.',
  art: {
    body: art([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '.....dd..........dd',
      '.....dd..........dd',
      '.....dddddddddddddd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dddddddddddddd',
      '.......dd......dd'
    ]),
    // The lens shuts by going dark, the way the robot's visor does.
    blink: stamp(blank(), 9, 10, lid(6, 5, 'k')),
    eyes: {
      ahead: stamp(blank(), 9, 10, ['.aaaa.', 'akkkka', 'aklkka', 'akkkka', '.aaaa.']),
      look: stamp(blank(), 9, 10, ['.aaaa.', 'akkkka', 'akklka', 'akkkka', '.aaaa.'])
    },
    // The strobes under the skids.
    beacon: {
      on: both(['a'], 7, 16, 18),
      off: both(['d'], 7, 16, 18)
    },
    arms: settle(
      art([
        '', '', '', '',
        '..dddddd......dddddd',
        '....dd..........dd'
      ])
    ),
    treads: {
      a: art([
        '', '', '', '', '',
        '.dddddddd....dddddddd',
        '....dd..........dd'
      ]),
      b: art([
        '', '', '', '', '',
        '..dddddd......dddddd',
        '....dd..........dd'
      ])
    },
    shadow: { cx: 11.5, cy: 22.8, rx: 6, ry: 0.9, opacity: 0.08 }
  }
}

/* ---------------------------------------------------------------- 10. the ghost ---- */

const ghost: Pet = {
  id: 'ghost',
  name: 'Wisp',
  note: 'A wisp. A drifting hem and a very slow blink.',
  art: {
    body: art([
      '',
      '',
      '',
      '.........dddddd',
      '.......ddffffffdd',
      '......dffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd',
      '.....dffffffffffffd'
    ]),
    blink: both(lid(4, 4, 'f'), 6, 14, 7),
    eyes: { ahead: both(EYE, 6, 14, 7), look: both(EYE_LOOK, 6, 14, 7) },
    // The mouth, an o that fades in and out.
    beacon: {
      on: stamp(blank(), 10, 13, ['.kk.', 'kkkk', '.kk.']),
      off: stamp(blank(), 10, 13, ['....', '.ff.', '....'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '....dd............dd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '.....dffdffddffdffdd',
        '......dd.dd..dd.dd'
      ]),
      b: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '.....ddffddffddffddf',
        '.....dd..dd..dd..dd'
      ])
    },
    shadow: { cx: 11.5, cy: 22.6, rx: 6, ry: 0.9, opacity: 0.07 }
  }
}

export const PETS: Pet[] = [bot, fox, cat, dog, owl, crab, slime, dino, drone, ghost]

export type PetId = string

/**
 * No animal at all: the readings, with nothing drawn.
 *
 * A pet is decoration before it is a reading, and a desk that finds a sprite walking
 * around the corner of its window expensive used to have exactly one way to say so -
 * turning the mascot OFF, which also turned off the only thing that ever says the resource
 * ladder acted. Two different facts under one switch. This is the id that keeps the mouth
 * and drops the animal, and it is deliberately not a `Pet` with empty art: something has
 * to answer "is anything drawn" and an all-blank sprite still occupies its 48px and still
 * takes the drag.
 */
export const NO_PET = 'none'

/** Whether an id draws anything at all. */
export function hasPet(id: string | undefined): boolean {
  return id !== NO_PET
}

/** The pet a config names, or the robot - a config from before this existed still loads. */
export function petFor(id: string | undefined): Pet {
  return PETS.find((p) => p.id === id) ?? PETS[0]
}

/** Every layer of every pet, so a test can check the grid without naming them. */
export function layersOf(pet: Pet): string[][] {
  const a = pet.art
  return [
    a.body,
    ...(a.blink ? [a.blink] : []),
    ...(a.eyes ? [a.eyes.ahead, a.eyes.look] : []),
    ...(a.beacon ? [a.beacon.on, a.beacon.off] : []),
    ...(a.antenna ? [a.antenna.mast, a.antenna.tilt] : []),
    ...(a.arms ? [a.arms.a, a.arms.b, a.arms.c] : []),
    ...(a.treads ? [a.treads.a, a.treads.b] : [])
  ]
}

export type Rect = { x: number; y: number; w: number; cls: string }

/**
 * A layer as horizontal runs. One rect per run of the same colour rather than one per
 * cell: a whole pet is ~90 rects instead of 576, and the runs are what a pixel row
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
