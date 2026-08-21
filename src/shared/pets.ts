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
 * `npm run test:pets` refuses a wonky grid, an unknown colour and a pose nothing draws.
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

/** The same drawing, moved down the grid. A settle is one part drawn at three heights. */
export const shift = (rows: string[], dy: number): string[] => {
  if (dy === 0) return art(rows)
  const blank = '.'.repeat(GRID)
  const moved = dy > 0 ? [...Array.from({ length: dy }, () => blank), ...rows] : rows.slice(-dy)
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

const BOT_BODY = art([
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

const BOT_ARM = art([
  '', '', '', '', '', '', '', '', '', '', '', '', '',
  '..dd..............dd....',
  '..df..............fd....',
  '..df..............fd....',
  '..dd..............dd....'
])

const bot: Pet = {
  id: 'bot',
  name: 'Bit',
  note: 'The robot. Beacon, scanning visor, treads.',
  art: {
    body: BOT_BODY,
    blink: art(['', '', '', '', '', '', '', '......dddddddddd........', '......dddddddddd........']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '.......llll.............', '.......llll.............']),
      look: art(['', '', '', '', '', '', '', '...........llll.........', '...........llll.........'])
    },
    beacon: {
      on: art(['', '..........aaaa..........']),
      off: art(['', '..........dddd..........'])
    },
    antenna: {
      mast: art(['', '', '...........dd...........', '...........dd...........', '...........dd...........']),
      tilt: art(['', '', '.............dd.........', '............dd..........', '...........dd...........'])
    },
    arms: settle(BOT_ARM),
    treads: {
      a: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '...dddddddddddddddd.....',
        '...dlldlldlldlldlld.....',
        '...dddddddddddddddd.....'
      ]),
      b: art([
        ...Array.from({ length: 19 }, () => '.'.repeat(GRID)),
        '...dddddddddddddddd.....',
        '...lldlldlldlldlldl.....',
        '...dddddddddddddddd.....'
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
      '', '', '',
      '.....dd..........dd.....',
      '.....dfd........dfd.....',
      '....dffd........dffd....',
      '....dddddddddddddddd....',
      '....dffffffffffffffd....',
      '....dffffffffffffffd....',
      '....dffffffffffffffd....',
      '....dffllllllllllffd....',
      '....dffllllllllllffd....',
      '....dffffllllllffffd....',
      '....dddddddddddddddd....',
      '.....aaaaaaaaaaaaaa.....',
      '.....dffffffffffd.......',
      '.....dffffffffffd.......',
      '.....dffllllllffd.......',
      '.....dffllllllffd.......',
      '.....dffffffffffd.......'
    ]),
    blink: art(['', '', '', '', '', '', '', '', '', '.......fff....fff.......']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '', '', '.......aaa....aaa.......']),
      look: art(['', '', '', '', '', '', '', '', '', '........aaa....aaa......'])
    },
    beacon: {
      on: art([...Array.from({ length: 15 }, () => '.'.repeat(GRID)), '..........ll............']),
      off: art([...Array.from({ length: 15 }, () => '.'.repeat(GRID)), '..........dd............'])
    },
    antenna: {
      mast: art(['', '', '', '.....dd..........dd.....']),
      tilt: art(['', '', '', '.....dd.........dd......'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '................ddd.....',
        '...............dfffd....',
        '...............dfllfd...',
        '...............dfffd....',
        '................ddd.....'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 20 }, () => '.'.repeat(GRID)),
        '.....dddd....dddd.......',
        '.....dlld....dlld.......',
        '.....dddd....dddd.......'
      ]),
      b: art([
        ...Array.from({ length: 20 }, () => '.'.repeat(GRID)),
        '.....dddd....dddd.......',
        '.....dldd....ddld.......',
        '.....dddd....dddd.......'
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
      '', '', '',
      '.....dd..........dd.....',
      '.....dfd........dfd.....',
      '.....dffdddddddddffd....',
      '.....dffffffffffffffd...',
      '.....dffffffffffffffd...',
      '.....dffffffffffffffd...',
      '.....dfflllllllllfffd...',
      '.....dfflllllllllfffd...',
      '.....dddddddddddddddd...',
      '......dffffffffffffd....',
      '......dffffffffffffd....',
      '......dfflllllllfffd....',
      '......dfflllllllfffd....',
      '......dffffffffffffd....',
      '......dffffffffffffd....'
    ]),
    blink: art(['', '', '', '', '', '', '', '', '.......fff.....fff......']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '', '.......aaa.....aaa......']),
      look: art(['', '', '', '', '', '', '', '', '........aaa.....aaa.....'])
    },
    beacon: {
      on: art([...Array.from({ length: 12 }, () => '.'.repeat(GRID)), '...........ll...........']),
      off: art([...Array.from({ length: 12 }, () => '.'.repeat(GRID)), '...........dd...........'])
    },
    antenna: {
      mast: art(['', '', '', '', '', '', '', '', '', '', '...ddd.........ddd......']),
      tilt: art(['', '', '', '', '', '', '', '', '', '', '..ddd...........ddd.....'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '..................dd....',
        '.................dfd....',
        '.................dfd....',
        '.................dfd....',
        '..................dd....'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '......dddddddddddd......',
        '......dllddffddlld......',
        '......dddddddddddd......'
      ]),
      b: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '......dddddddddddd......',
        '......dlddffffddld......',
        '......dddddddddddd......'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------- 4. the dog ---- */

const dog: Pet = {
  id: 'dog',
  name: 'Rook',
  note: 'A shiba with floppy ears. Tail wag, nose blink.',
  art: {
    body: art([
      '', '', '', '',
      '.....dddddddddddddd.....',
      '....dffffffffffffffd....',
      '...ddffffffffffffffdd...',
      '...dfdffffffffffffdfd...',
      '...dfdfflllllllfffdfd...',
      '...dfdfflllllllfffdfd...',
      '...dfdddddddddddddfd....',
      '...dfd.dffffffffd.dfd...',
      '....dd.dfflllllfd..dd...',
      '.......dddddddddd.......',
      '......dffffffffffd......',
      '......dfflllllllfd......',
      '......dfflllllllfd......',
      '......dffffffffffd......'
    ]),
    blink: art(['', '', '', '', '', '', '', '', '.......fff...fff........']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '', '.......aaa...aaa........']),
      look: art(['', '', '', '', '', '', '', '', '........aaa...aaa.......'])
    },
    beacon: {
      on: art([...Array.from({ length: 12 }, () => '.'.repeat(GRID)), '..........llll..........']),
      off: art([...Array.from({ length: 12 }, () => '.'.repeat(GRID)), '..........dddd..........'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '.................ddd....',
        '................dfffd...',
        '................dfffd...',
        '.................ddd....'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '......dddddddddddd......',
        '......dllddddddlld......',
        '......dddddddddddd......'
      ]),
      b: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '......dddddddddddd......',
        '......dlddddddddld......',
        '......dddddddddddd......'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------- 5. the owl ---- */

const owl: Pet = {
  id: 'owl',
  name: 'Hoot',
  note: 'An owl. Big eyes, slow wings, a rare crest flick.',
  art: {
    body: art([
      '', '', '',
      '.....dd..........dd.....',
      '....dffd........dffd....',
      '....dffddddddddddffd....',
      '....dffffffffffffffd....',
      '....dfkkkkffffkkkkfd....',
      '....dfkkkkffffkkkkfd....',
      '....dfkkkkffffkkkkfd....',
      '....dffffflllfffffd.....',
      '.....dffffflfffffd......',
      '.....dfflllllllffd......',
      '.....dfflllllllffd......',
      '.....dffllllllfffd......',
      '.....dffffffffffd.......',
      '......dddddddddd........'
    ]),
    blink: art(['', '', '', '', '', '', '', '....dffffffffffffffd....', '....dffffffffffffffd....']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '.....aaa......aaa.......', '.....aaa......aaa.......']),
      look: art(['', '', '', '', '', '', '', '......aaa......aaa......', '......aaa......aaa......'])
    },
    antenna: {
      mast: art(['', '', '', '.....dd..........dd.....']),
      tilt: art(['', '', '', '....dd............dd....'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '',
        '...dd................dd.',
        '...dfd..............dfd.',
        '...dfd..............dfd.',
        '...dfd..............dfd.',
        '....dd................dd'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '.......ddd..ddd.........',
        '.......dld..dld.........'
      ]),
      b: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '.......ddd..ddd.........',
        '.......dld..ddl.........'
      ])
    },
    shadow: SHADOW
  }
}

/* ------------------------------------------------------------------ 6. the crab ---- */

const crab: Pet = {
  id: 'crab',
  name: 'Nip',
  note: 'A crab. Clacking claws, stalk eyes, a scuttle.',
  art: {
    body: art([
      '', '', '', '', '', '',
      '.........dd....dd.......',
      '.........dd....dd.......',
      '......dddddddddddddd....',
      '.....dffffffffffffffd...',
      '....dfflllllllllllffd...',
      '....dffllllllllllllfd...',
      '....dffffffffffffffdd...',
      '....dddddddddddddddd....',
      '.....dffffffffffffd.....',
      '......dddddddddddd......'
    ]),
    blink: art(['', '', '', '', '', '.........dd....dd.......']),
    eyes: {
      ahead: art(['', '', '', '', '', '.........aa....aa.......']),
      look: art(['', '', '', '', '', '..........aa....aa......'])
    },
    beacon: {
      on: art([...Array.from({ length: 10 }, () => '.'.repeat(GRID)), '..........llll..........']),
      off: art([...Array.from({ length: 10 }, () => '.'.repeat(GRID)), '..........ffff..........'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '',
        '..ddd...............ddd.',
        '.dfffd.............dfffd',
        '.dffdd.............ddffd',
        '..ddd...............ddd.'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '...dd..dd....dd..dd.....',
        '...dd..dd....dd..dd.....'
      ]),
      b: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '..dd....dd..dd....dd....',
        '..dd....dd..dd....dd....'
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
      '', '', '', '', '',
      '..........dddd..........',
      '........ddffffdd........',
      '.......dffffffffd.......',
      '......dffffffffffd......',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '....dffffffffffffffd....',
      '....dffffffffffffffd....',
      '....dfflllllllllllfd....',
      '....dfflllllllllllfd....',
      '....dffffffffffffffd....',
      '.....dddddddddddddd.....'
    ]),
    blink: art(['', '', '', '', '', '', '', '', '', '.......ffff...ffff......']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '', '', '.......aaaa...aaaa......']),
      look: art(['', '', '', '', '', '', '', '', '', '........aaaa...aaaa.....'])
    },
    beacon: {
      on: art([...Array.from({ length: 6 }, () => '.'.repeat(GRID)), '..........aa............']),
      off: art([...Array.from({ length: 6 }, () => '.'.repeat(GRID)), '..........ff............'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '...dd..............dd...',
        '...df..............fd...'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '.....dffdffdffdffdffd...',
        '......dd.dd.dd.dd.dd....'
      ]),
      b: art([
        ...Array.from({ length: 18 }, () => '.'.repeat(GRID)),
        '.....ffdffdffdffdffdf...',
        '.....dd.dd.dd.dd.dd.....'
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
      '', '', '',
      '............dddddddd....',
      '...........dffffffffd...',
      '...........dfflllllfd...',
      '...........dffffffffd...',
      '...........ddddddddd....',
      '.........dddddd.........',
      '........dffffffd........',
      '.......dffffffffd.......',
      '.......dfflllllfd.......',
      '.......dfflllllfd.......',
      '.......dffffffffd.......',
      '.......dffffffffd.......',
      '........dddddddd........'
    ]),
    blink: art(['', '', '', '', '', '...........ffff.........']),
    eyes: {
      ahead: art(['', '', '', '', '', '...........aa...........']),
      look: art(['', '', '', '', '', '............aa..........'])
    },
    beacon: {
      on: art([...Array.from({ length: 5 }, () => '.'.repeat(GRID)), '..................ll....']),
      off: art([...Array.from({ length: 5 }, () => '.'.repeat(GRID)), '..................ff....'])
    },
    antenna: {
      mast: art(['', '', '', '', '', '', '', '...........ddddddddd....']),
      tilt: art(['', '', '', '', '', '', '', '...........dddddddd.....'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '',
        '...ddd..................',
        '..dfffd.................',
        '..dfffdd................',
        '...dddd.................'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '.......dddd..dddd.......',
        '.......dlld..dlld.......'
      ]),
      b: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '......dddd....dddd......',
        '......dlld....dlld......'
      ])
    },
    shadow: SHADOW
  }
}

/* ----------------------------------------------------------------- 9. the drone ---- */

const drone: Pet = {
  id: 'drone',
  name: 'Kite',
  note: 'A quadcopter. Rotor blur, a strobe, a low shadow.',
  art: {
    body: art([
      '', '', '', '', '', '',
      '...dd..............dd...',
      '...dd..............dd...',
      '....ddd..........ddd....',
      '......dddd....dddd......',
      '.........dddddd.........',
      '........dffffffd........',
      '.......dffffffffd.......',
      '.......dfkkkkkkfd.......',
      '.......dfkkkkkkfd.......',
      '.......dffffffffd.......',
      '........dddddddd........',
      '.........d....d.........'
    ]),
    blink: art(['', '', '', '', '', '', '', '', '', '', '', '', '', '.......dffffffd.........']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '', '', '', '', '', '', '........aaa.............']),
      look: art(['', '', '', '', '', '', '', '', '', '', '', '', '', '............aaa.........'])
    },
    beacon: {
      on: art([...Array.from({ length: 18 }, () => '.'.repeat(GRID)), '.........a....a.........']),
      off: art([...Array.from({ length: 18 }, () => '.'.repeat(GRID)), '.........d....d.........'])
    },
    arms: settle(
      art([
        '', '', '', '', '',
        '..dddd............dddd..',
        '...dd..............dd...'
      ])
    ),
    treads: {
      a: art([
        '', '', '', '', '',
        '.dddddd..........dddddd.',
        '..dddd............dddd..'
      ]),
      b: art([
        '', '', '', '', '',
        '..dddd............dddd..',
        '.dddddd..........dddddd.'
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
      '', '', '',
      '.........dddddd.........',
      '.......ddffffffdd.......',
      '......dffffffffffd......',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....',
      '.....dffffffffffffd.....'
    ]),
    blink: art(['', '', '', '', '', '', '', '.......ffff...ffff......', '.......ffff...ffff......']),
    eyes: {
      ahead: art(['', '', '', '', '', '', '', '.......kkkk...kkkk......', '.......kkkk...kkkk......']),
      look: art(['', '', '', '', '', '', '', '........kkkk...kkkk.....', '........kkkk...kkkk.....'])
    },
    beacon: {
      on: art([...Array.from({ length: 11 }, () => '.'.repeat(GRID)), '.........aaaaaa.........']),
      off: art([...Array.from({ length: 11 }, () => '.'.repeat(GRID)), '.........ffffff.........'])
    },
    arms: settle(
      art([
        '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        '....dd............dd....'
      ])
    ),
    treads: {
      a: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '.....dffdffddffdffdd....',
        '......dd.dd..dd.dd......'
      ]),
      b: art([
        ...Array.from({ length: 17 }, () => '.'.repeat(GRID)),
        '.....ddffddffddffddf....',
        '.....dd..dd..dd..dd.....'
      ])
    },
    shadow: { cx: 11.5, cy: 22.6, rx: 6, ry: 0.9, opacity: 0.07 }
  }
}

export const PETS: Pet[] = [bot, fox, cat, dog, owl, crab, slime, dino, drone, ghost]

export type PetId = string

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
