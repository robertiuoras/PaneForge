// The seed catalogue.
//
// ## Every record here is `draft`, and that is not a placeholder
//
// The vault's contract is that `reviewed` means a human confirmed the note and `verified`
// means it was checked against reality. Nobody has done either for these. They were
// written from general knowledge to give retrieval something to rank, so calling any of
// them `reviewed` would be inventing the one signal the whole system is built on.
//
// The consequence is deliberate and is the honest one: with the default policy
// (`trusted` only) **none of these is ever offered as a recommendation**. Retrieval finds
// them, scores them and returns nothing, which is exactly what "no verified knowledge
// about this yet" should look like. `includeUntrusted` - the same escape hatch
// `vaultindex.py --include-untrusted` has - brings them back, labelled unverified
// everywhere they appear, and that is what the tests and the demonstration use.
//
// Real records arrive the way every other note does: `proposals.py propose` with real
// evidence, reviewed by a person, promoted into the vault. This file is scaffolding for
// the retrieval system, not knowledge.
//
// Bundled as a module rather than read as JSONL from disk so the feature works on first
// launch with nothing installed. User-supplied records are read from
// `userData/capabilities/*.jsonl` and merged over these by `main/knowledge/catalogue.ts`.

import type { Capability } from './capability'

/** Written 2026-07-31. `lastVerified` is the date the CLAIM was last true to the author. */
export const SEED: Capability[] = [
  {
    id: 'radix-primitives',
    name: '@radix-ui/react',
    category: 'ui-components',
    description:
      'Unstyled React primitives (dialog, popover, select, tabs) with focus management, keyboard interaction and ARIA wired in.',
    source: 'https://www.radix-ui.com/primitives',
    licence: 'MIT',
    cost: 'free',
    compatibility: ['react', 'next'],
    useCases: ['accessible dialog', 'combobox', 'menu', 'tabs', 'design system foundation'],
    limitations: ['brings no styling at all', 'per-component packages enlarge the dependency list'],
    performance: 'small per component; only the primitives imported are bundled',
    accessibility: 'the reason to use it - focus trap, roving tabindex and ARIA are built in',
    security: 'no network calls, no runtime eval',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['@headlessui/react', 'react-aria-components', '@mui/material', '@chakra-ui/react'],
    sensitivity: 'public'
  },
  {
    id: 'react-aria-components',
    name: 'react-aria-components',
    category: 'accessibility',
    description:
      "Adobe's accessible component layer over React Aria hooks; covers form controls, date pickers and drag-and-drop.",
    source: 'https://react-spectrum.adobe.com/react-aria/',
    licence: 'Apache-2.0',
    cost: 'free',
    compatibility: ['react', 'next'],
    useCases: ['accessible form controls', 'date picker', 'internationalised input', 'screen reader support'],
    limitations: ['larger API surface than Radix', 'opinionated about state shape'],
    performance: 'heavier than Radix for the same widget; tree-shakes per component',
    accessibility: 'strongest of the mainstream options, including locale-aware date and number input',
    security: 'no network calls',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['@radix-ui/react', '@headlessui/react'],
    sensitivity: 'public'
  },
  {
    id: 'motion-react',
    name: 'motion',
    category: 'animation',
    description:
      'Declarative animation for React (formerly Framer Motion): layout transitions, gesture springs and enter/exit animation.',
    source: 'https://motion.dev',
    licence: 'MIT',
    cost: 'freemium',
    compatibility: ['react', 'next'],
    useCases: ['page transition', 'layout animation', 'micro-interaction', 'enter and exit animation'],
    limitations: [
      'a large part of the bundle for one hero animation',
      'layout animation fights CSS grid in places'
    ],
    performance: 'tens of KB gzipped; the mini build is smaller but drops layout animation',
    accessibility: 'honours prefers-reduced-motion only if the code asks it to',
    security: 'no network calls',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['framer-motion', 'react-spring', 'gsap', '@react-spring/web'],
    sensitivity: 'public'
  },
  {
    id: 'css-view-transitions',
    name: 'CSS View Transitions',
    category: 'animation',
    description:
      'Browser-native transitions between DOM states via document.startViewTransition; no dependency and no bundle cost.',
    source: 'https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API',
    licence: 'n/a (platform)',
    cost: 'free',
    compatibility: [],
    useCases: ['page transition', 'list reorder', 'shared element transition'],
    limitations: ['browser support is uneven for the cross-document form', 'hard to orchestrate long sequences'],
    performance: 'zero bundle cost; compositor-driven',
    accessibility: 'respects prefers-reduced-motion when the transition is written in CSS',
    security: 'platform API',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: [],
    sensitivity: 'public'
  },
  {
    id: 'animejs',
    name: 'animejs',
    category: 'svg-2d',
    description: 'Small timeline-based engine for SVG path, morph and stagger animation without a framework.',
    source: 'https://animejs.com',
    licence: 'MIT',
    cost: 'free',
    compatibility: [],
    useCases: ['SVG path drawing', 'icon animation', 'staggered list', '2D motion graphic'],
    limitations: ['no layout animation', 'imperative API is awkward inside React render'],
    performance: 'a few KB gzipped',
    accessibility: 'none of its own; reduced-motion is the caller’s job',
    security: 'no network calls',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['gsap', 'motion', 'framer-motion'],
    sensitivity: 'public'
  },
  {
    id: 'gsap',
    name: 'gsap',
    category: 'svg-2d',
    description:
      'Timeline animation with ScrollTrigger and morphing plugins. Licence terms changed after the Webflow acquisition.',
    source: 'https://gsap.com',
    licence: 'check before use',
    cost: 'unknown',
    compatibility: [],
    useCases: ['scroll-driven animation', 'complex timeline', 'SVG morph'],
    limitations: ['licence position must be confirmed per project', 'large when plugins are included'],
    performance: 'core is moderate; each plugin adds',
    accessibility: 'none of its own',
    security: 'no network calls',
    // Deliberately old: this is the record the staleness rule is demonstrated on, and the
    // licence really is the thing that must be re-checked rather than assumed.
    status: 'draft',
    confidence: 'low',
    lastVerified: '2025-01-15',
    testedProjects: [],
    outcomes: [],
    overlaps: ['animejs', 'motion', 'framer-motion'],
    sensitivity: 'public'
  },
  {
    id: 'r3f',
    name: '@react-three/fiber',
    category: '3d',
    description: 'React renderer for three.js; scene graph as components, with drei for common helpers.',
    source: 'https://docs.pmnd.rs/react-three-fiber',
    licence: 'MIT',
    cost: 'free',
    compatibility: ['react', 'next'],
    useCases: ['3D hero', 'product viewer', 'WebGL background', 'shader effect'],
    limitations: [
      'three.js is a large dependency on its own',
      'needs a non-WebGL fallback and a loading state'
    ],
    performance: 'the heaviest option here; three.js dominates the bundle and the GPU budget',
    accessibility: 'canvas content is invisible to assistive tech unless described separately',
    security: 'shader and model assets are third-party content; host them yourself',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['three', 'babylonjs'],
    sensitivity: 'public'
  },
  {
    id: 'react-hook-form',
    name: 'react-hook-form',
    category: 'forms',
    description: 'Uncontrolled-first form state for React; validation via a resolver, few re-renders.',
    source: 'https://react-hook-form.com',
    licence: 'MIT',
    cost: 'free',
    compatibility: ['react', 'next'],
    useCases: ['signup form', 'multi-step form', 'validation', 'field array'],
    limitations: ['uncontrolled inputs surprise people used to controlled ones'],
    performance: 'small, and re-renders far less than controlled alternatives',
    accessibility: 'gives you the error wiring but not the markup; labels and aria-describedby are still yours',
    security: 'client-side validation only - it is not a substitute for server checks',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['formik', 'react-final-form', '@tanstack/react-form'],
    sensitivity: 'public'
  },
  {
    id: 'zod',
    name: 'zod',
    category: 'forms',
    description: 'TypeScript-first schema validation; one schema can validate a form and the API route behind it.',
    source: 'https://zod.dev',
    licence: 'MIT',
    cost: 'free',
    compatibility: [],
    useCases: ['form validation', 'API input validation', 'shared client and server schema'],
    limitations: ['schema objects are runtime values, so they are in the bundle'],
    performance: 'moderate; large schemas are measurable on cold start',
    accessibility: 'n/a',
    security: 'useful as the server-side check, which is the one that counts',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['yup', 'valibot', 'joi'],
    sensitivity: 'public'
  },
  {
    id: 'recharts',
    name: 'recharts',
    category: 'data-visualisation',
    description: 'Composable SVG charts for React over D3 scales; sensible defaults for dashboard work.',
    source: 'https://recharts.org',
    licence: 'MIT',
    cost: 'free',
    compatibility: ['react', 'next'],
    useCases: ['dashboard chart', 'time series', 'bar and line chart', 'KPI panel'],
    limitations: ['SVG struggles past a few thousand points', 'custom chart types mean dropping to D3'],
    performance: 'fine to a few thousand points; canvas libraries win beyond that',
    accessibility: 'no table fallback by default - supply one for screen readers',
    security: 'no network calls',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['@visx/visx', 'echarts', 'chart.js', 'nivo'],
    sensitivity: 'public'
  },
  {
    id: 'playwright',
    name: '@playwright/test',
    category: 'testing',
    description: 'Cross-browser end-to-end testing with tracing, auto-waiting and a built-in assertion library.',
    source: 'https://playwright.dev',
    licence: 'Apache-2.0',
    cost: 'free',
    compatibility: [],
    useCases: ['browser testing', 'end-to-end flow', 'visual regression', 'signup flow test'],
    limitations: ['downloads browser binaries', 'slower than a unit test by orders of magnitude'],
    performance: 'CI time, not bundle size - it never ships',
    accessibility: 'can drive axe-core in the same run',
    security: 'test credentials must not be committed with the specs',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['cypress', 'puppeteer', 'webdriverio'],
    sensitivity: 'public'
  },
  {
    id: 'axe-core',
    name: '@axe-core/playwright',
    category: 'testing',
    description: 'Automated accessibility assertions inside an existing browser test; catches the mechanical WCAG failures.',
    source: 'https://github.com/dequelabs/axe-core-npm',
    licence: 'MPL-2.0',
    cost: 'free',
    compatibility: [],
    useCases: ['accessibility testing', 'contrast check', 'label and role audit', 'CI gate'],
    limitations: [
      'finds roughly a third of real issues - keyboard and screen-reader passes are still manual'
    ],
    performance: 'seconds per page in CI',
    accessibility: 'the point of it',
    security: 'no network calls',
    status: 'draft',
    confidence: 'medium',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['pa11y', 'lighthouse'],
    sensitivity: 'public'
  },
  {
    id: 'enzyme',
    name: 'enzyme',
    category: 'testing',
    description: 'React component test utility built on shallow rendering and internal component state.',
    source: 'https://github.com/enzymejs/enzyme',
    licence: 'MIT',
    cost: 'free',
    compatibility: ['react'],
    useCases: ['component testing'],
    limitations: ['no adapter for current React versions'],
    performance: 'n/a',
    accessibility: 'encourages tests that assert on internals rather than on what a user can reach',
    security: 'n/a',
    // The catalogue's other job: answer the query that would otherwise make somebody
    // reconsider this, with the reason attached.
    status: 'superseded',
    confidence: 'high',
    lastVerified: '2026-07-31',
    testedProjects: [],
    outcomes: [],
    overlaps: ['@testing-library/react'],
    sensitivity: 'public',
    whyNot:
      'Unmaintained and without an adapter for current React. Its shallow-rendering model tests internals rather than behaviour.',
    supersededBy: '@testing-library/react'
  }
]
