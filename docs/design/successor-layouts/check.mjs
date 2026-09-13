// Headless check for the three successor layout prototypes.
// Proves, without a window: the shared task completes by click and by keyboard in every layout
// with zero wrong turns on the intended path; every control has a name and is focusable;
// phone width has no horizontal scroll and 44px controls; reduced motion kills transitions;
// text tokens meet 4.5:1 (body) and 3:1 (secondary) in both colour schemes.
// Writes validation.json and one screenshot per layout and width beside this file.
//
//   node docs/design/successor-layouts/check.mjs
//
// Uses the isolated Chrome Automation bundle (never the signed-in Chrome) with a throwaway profile.
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire('/Users/robertiuoras/Projects/toolstash/node_modules/');
const puppeteer = require('puppeteer-core');
const CHROME = '/Users/robertiuoras/Applications/Chrome Automation.app/Contents/MacOS/Google Chrome';
const GUARD = '/Applications/GuardDeck.app/Contents/MacOS/GuardDeck';
const LAYOUTS = ['a', 'b', 'c'];

function guard(args) { if (existsSync(GUARD)) spawnSync(GUARD, args, { stdio: 'ignore', timeout: 5000 }); }

function lum([r, g, b]) { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
function ratio(a, b) { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); }

const report = { at: new Date().toISOString(), chrome: CHROME, layouts: {}, failures: [] };
const fail = (l, what) => report.failures.push(`${l}: ${what}`);

guard(['--notify', 'Headless layout check (Chrome Automation, no window), about 40s', '--state', 'browser', '--agent', 'product-session', '--app', 'Chrome Automation']);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'pf-layout-check-')),
  args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--allow-file-access-from-files'],
});
try {
  for (const l of LAYOUTS) {
    const url = 'file://' + join(here, `layout-${l}.html`);
    const out = report.layouts[l] = {};
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    // desktop, dark
    await page.setViewport({ width: 1280, height: 800 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.goto(url, { waitUntil: 'load' });
    out.title = await page.title();
    out.click = await page.evaluate(() => window.__pfProto.runScript('click'));
    if (!out.click.done || out.click.wrongTurns !== 0) fail(l, `click path: done=${out.click.done} wrongTurns=${out.click.wrongTurns}`);
    await page.screenshot({ path: join(here, `shot-${l}-desktop.png`) });

    // keyboard / palette path
    await page.reload({ waitUntil: 'load' });
    out.keyboard = await page.evaluate(() => window.__pfProto.runScript('kbd'));
    if (!out.keyboard.done || out.keyboard.wrongTurns !== 0) fail(l, `keyboard path: done=${out.keyboard.done} wrongTurns=${out.keyboard.wrongTurns}`);

    // real key events: ⌘2 then ⌘1 then ⌘K + Escape
    await page.reload({ waitUntil: 'load' });
    await page.keyboard.down('Meta'); await page.keyboard.press('2'); await page.keyboard.up('Meta');
    const modeAfter = await page.evaluate(() => window.__pfProto.state.mode);
    await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
    const paletteOpen = await page.evaluate(() => !!document.querySelector('.palette'));
    await page.keyboard.press('Escape');
    const paletteClosed = await page.evaluate(() => !document.querySelector('.palette'));
    out.keys = { cmd2: modeAfter, cmdK: paletteOpen, escape: paletteClosed };
    if (modeAfter !== 'work' || !paletteOpen || !paletteClosed) fail(l, `real keys: ${JSON.stringify(out.keys)}`);

    // accessibility: names and focusability on every action control, in every view
    out.a11y = await page.evaluate(() => {
      const views = ['chat', 'work', 'code']; const bad = [];
      for (const v of views) {
        window.__pfProto.act('mode:' + v, 'check');
        for (const el of document.querySelectorAll('[data-action]')) {
          if (el.closest('[hidden]')) continue;
          const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
          const focusable = el.matches('button,a[href],input,textarea,[tabindex]');
          if (!name) bad.push(`${v}: no name on ${el.dataset.action}`);
          if (!focusable) bad.push(`${v}: not focusable ${el.dataset.action}`);
        }
      }
      const imgs = [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).length;
      return { controlsWithoutName: bad.filter(b => b.includes('no name')).length, notFocusable: bad.filter(b => b.includes('not focusable')).length, imgsWithoutAlt: imgs, detail: bad.slice(0, 10) };
    });
    if (out.a11y.controlsWithoutName || out.a11y.notFocusable || out.a11y.imgsWithoutAlt) fail(l, `a11y ${JSON.stringify(out.a11y)}`);

    // contrast, both schemes, on the actual tokens
    out.contrast = {};
    for (const scheme of ['dark', 'light']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.reload({ waitUntil: 'load' });
      const c = await page.evaluate(() => {
        const rgb = s => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const cs = getComputedStyle(document.documentElement);
        const v = n => rgb(getComputedStyle(document.body).getPropertyValue('color') && (() => { const d = document.createElement('div'); d.style.color = cs.getPropertyValue(n); document.body.appendChild(d); const r = getComputedStyle(d).color; d.remove(); return r; })());
        return { bg: v('--bg'), panel: v('--panel'), text: v('--text'), muted: v('--muted'), dim: v('--dim'), accentInk: v('--accent-ink') };
      });
      out.contrast[scheme] = {
        textOnBg: +ratio(c.text, c.bg).toFixed(2), textOnPanel: +ratio(c.text, c.panel).toFixed(2),
        mutedOnBg: +ratio(c.muted, c.bg).toFixed(2), mutedOnPanel: +ratio(c.muted, c.panel).toFixed(2),
        dimOnPanel: +ratio(c.dim, c.panel).toFixed(2), accentInkOnPanel: +ratio(c.accentInk, c.panel).toFixed(2),
      };
      const r = out.contrast[scheme];
      if (r.textOnBg < 4.5 || r.textOnPanel < 4.5) fail(l, `${scheme} body text under 4.5:1 ${JSON.stringify(r)}`);
      if (r.mutedOnBg < 4.5 || r.mutedOnPanel < 4.5) fail(l, `${scheme} muted text under 4.5:1 ${JSON.stringify(r)}`);
      if (r.dimOnPanel < 3) fail(l, `${scheme} dim labels under 3:1 ${JSON.stringify(r)}`);
    }
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

    // reduced motion
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.reload({ waitUntil: 'load' });
    out.reducedMotion = await page.evaluate(() => ({
      navTransition: getComputedStyle(document.querySelector('.nav-btn,.seg button,.tabs-in button')).transitionDuration,
      animations: document.getAnimations().length,
    }));
    if (out.reducedMotion.navTransition !== '0s' || out.reducedMotion.animations) fail(l, `reduced motion ${JSON.stringify(out.reducedMotion)}`);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'no-preference' }]);

    // phone width: one column, 44px controls, Taskdriver link present, task still completes
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.reload({ waitUntil: 'load' });
    out.phone = await page.evaluate(() => {
      window.__pfProto.act('mode:work', 'check');
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[hidden]'); };
      const small = [...document.querySelectorAll('button,a[href],input,[role=radio]')].filter(vis).filter(el => el.getBoundingClientRect().height < 44 || el.getBoundingClientRect().width < 44).map(el => `${el.dataset.action || el.tagName} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
      const scrollX = document.scrollingElement.scrollWidth > innerWidth;
      const sidebarHidden = getComputedStyle(document.querySelector('.sidebar')).transform !== 'none';
      const taskdriver = !!document.querySelector('[data-view="work"]:not([hidden]) [data-action="taskdriver-link"]');
      return { under44: small, horizontalScroll: scrollX, sidebarIsDrawer: sidebarHidden, taskdriverLinkInWork: taskdriver };
    });
    if (out.phone.under44.length || out.phone.horizontalScroll || !out.phone.sidebarIsDrawer || !out.phone.taskdriverLinkInWork) fail(l, `phone ${JSON.stringify(out.phone)}`);
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => document.querySelector('.sidebar').classList.add('open'));
    await page.screenshot({ path: join(here, `shot-${l}-phone.png`) });
    await page.evaluate(() => document.querySelector('.sidebar').classList.remove('open'));
    out.phoneTask = await page.evaluate(() => window.__pfProto.runScript('click'));
    if (!out.phoneTask.done) fail(l, `phone task did not complete: ${JSON.stringify(out.phoneTask.log.slice(-3))}`);

    out.pageErrors = errors;
    if (errors.length) fail(l, `page errors ${errors.join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  guard(['--notify', '--clear']);
}

writeFileSync(join(here, 'validation.json'), JSON.stringify(report, null, 2));
const summary = LAYOUTS.map(l => { const o = report.layouts[l]; return `${l}: click ${o.click?.actions} actions/${o.click?.wrongTurns} wrong · keys ${o.keyboard?.actions}/${o.keyboard?.wrongTurns} · phone under44=${o.phone?.under44.length} · dark muted ${o.contrast?.dark.mutedOnPanel}:1 light muted ${o.contrast?.light.mutedOnPanel}:1`; }).join('\n');
console.log(summary);
console.log(report.failures.length ? `FAIL ${report.failures.length}\n${report.failures.join('\n')}` : 'OK: all three layouts pass every check');
process.exit(report.failures.length ? 1 : 0);
