import assert from 'node:assert/strict'
import { externalWorkArea } from './dev-layout.mjs'

const display = (frame, builtin, visible = frame) => ({ frame, visible, builtin })
const laptop = display({ x: 0, y: 0, w: 1512, h: 982 }, true, { x: 0, y: 24, w: 1512, h: 925 })
const external = display({ x: 1512, y: 0, w: 2560, h: 1440 }, false, { x: 1512, y: 24, w: 2560, h: 1376 })

assert.equal(externalWorkArea([laptop], { x: 20, y: 20, w: 900, h: 700 }), null, 'a single built-in display never splits')
assert.equal(externalWorkArea([laptop, external], { x: 20, y: 20, w: 900, h: 700 }), null, 'an external connection does not split a window on the laptop')
assert.equal(externalWorkArea([laptop, external], { x: 1600, y: 40, w: 1200, h: 900 }), external.visible, 'an external window selects its visible work area')
assert.equal(externalWorkArea([laptop, external], null), null, 'an absent installed window never splits')
assert.equal(externalWorkArea([laptop, external], { x: 5000, y: 4000, w: 700, h: 500 }), null, 'an offscreen installed window never splits')
assert.equal(externalWorkArea([laptop, external], { x: 1200, y: 40, w: 900, h: 800 }), external.visible, 'the display with most window overlap wins')

const externalPrimary = display({ x: 0, y: 0, w: 2560, h: 1440 }, false, { x: 0, y: 24, w: 2560, h: 1376 })
const laptopSecondary = display({ x: -1512, y: 0, w: 1512, h: 982 }, true)
assert.equal(externalWorkArea([externalPrimary, laptopSecondary], { x: 100, y: 100, w: 1200, h: 900 }), externalPrimary.visible, 'an external primary display is still eligible')
assert.equal(externalWorkArea([externalPrimary], { x: 100, y: 100, w: 1200, h: 900 }), externalPrimary.visible, 'clamshell external-only use is eligible')

console.log('dev-layout-test: ok')
