// Measures the Graph view on a large model: how long opening it blocks the page, how many SVG
// elements are drawn, and how many frames a second panning gets, with some 300 terms in view and
// with the whole model fitted on screen. FR-M5-4 asks for 30 frames a second
// with 10,000 terms loaded and 300 in view, and for the number of SVG elements to follow what is
// in view.
//
//   node scripts/canvas.mjs <model.json> [base URL]
//
// The model is a file the app opens (a stress model that src/model/bench.test.ts writes, for
// example). Needs the built app served (default http://localhost:5181/). This is a measurement,
// not a check: it exits non-zero only when it could not measure.
import { chromium } from 'playwright-core';
import { globSync } from 'node:fs';
import path from 'node:path';

const [modelFile, base = 'http://localhost:5181/'] = process.argv.slice(2);
if (!modelFile) {
  console.error('Usage: node scripts/canvas.mjs <model.json> [base URL]');
  process.exit(2);
}
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.addInitScript(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, end: e.startTime + e.duration });
  }).observe({ type: 'longtask', buffered: true });
});
/** Until no long task has ended for 700 ms. */
const settled = () =>
  page.waitForFunction(() => {
    const last = window.__longTasks.at(-1);
    return !last || performance.now() - last.end > 700;
  }, undefined, { timeout: 180_000, polling: 100 });
const longest = (t0) => page.evaluate((t0) => Math.max(0, ...window.__longTasks.filter((t) => t.end > t0).map((t) => t.end - Math.max(t.start, t0))), t0);
const now = () => page.evaluate(() => performance.now());

/** What the canvas draws: SVG elements, terms and lines, and the terms whose boxes are in view. */
const drawn = () =>
  page.evaluate(() => {
    const svg = document.querySelector('#graph-svg');
    // The view is the canvas: the drawing may be larger, to be moved under it.
    const r = document.querySelector('.canvas').getBoundingClientRect();
    const nodes = [...svg.querySelectorAll('.node')];
    const inView = nodes.filter((n) => {
      const b = n.getBoundingClientRect();
      return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
    }).length;
    return { elements: svg.querySelectorAll('*').length, terms: nodes.length, lines: svg.querySelectorAll('.edge').length, inView };
  });

/** Pans by dragging the background, one move each frame, for `ms`: frames a second, and the longest frame. */
const pan = (ms, dx, dy) =>
  page.evaluate(
    ({ ms, dx, dy }) =>
      new Promise((resolve) => {
        const svg = document.querySelector('#graph-svg');
        const r = document.querySelector('.canvas').getBoundingClientRect();
        let x = r.left + 40;
        let y = r.top + 40;
        // A point of the background: a term or a line under it would be dragged instead.
        const opts = () => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
        svg.dispatchEvent(new PointerEvent('pointerdown', opts()));
        const frames = [];
        const start = performance.now();
        const step = (t) => {
          frames.push(t);
          if (t - start > ms) {
            window.dispatchEvent(new PointerEvent('pointerup', opts()));
            const gaps = frames.slice(1).map((f, i) => f - frames[i]);
            resolve({ fps: (frames.length - 1) / ((frames.at(-1) - frames[0]) / 1000), worst: Math.max(...gaps) });
            return;
          }
          x += dx;
          y += dy;
          window.dispatchEvent(new PointerEvent('pointermove', opts()));
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { ms, dx, dy },
  );

const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
await settled();
let t0 = await now();
await page.locator('.header input[type=file]').first().setInputFiles(modelFile);
await page.waitForFunction(() => /^Opened/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 180_000 });
await settled();
const opened = (await now()) - t0 - 700;
say(`Model: ${path.basename(modelFile)}`);
say(`Open: on screen after ${opened.toFixed(0)} ms; longest task ${(await longest(t0)).toFixed(0)} ms`);

// The whole model, fitted.
await page.locator('.zoom').getByRole('button', { name: 'Fit' }).click();
await settled();
let d = await drawn();
let k = await page.locator('.zoom-level').innerText();
say(`Fitted (${k}): ${d.elements} SVG elements, ${d.terms} terms and ${d.lines} lines drawn, ${d.inView} terms in view`);
t0 = await now();
let p = await pan(2000, 3, 2);
await settled();
say(`  panning: ${p.fps.toFixed(1)} frames a second, longest frame ${p.worst.toFixed(0)} ms; longest task ${(await longest(t0)).toFixed(0)} ms`);

// Centred on a class (from the class tree), zoomed out from 100 % until some 300 terms are in view.
await page.locator('.zoom-level').click();
await page.locator('.term-list .tree-line button.label').nth(3).click();
await settled();
d = await drawn();
for (let i = 0; i < 20 && d.inView < 300; i++) {
  await page.locator('.zoom').getByRole('button', { name: 'Zoom out' }).click();
  await page.waitForTimeout(150);
  d = await drawn();
}
await settled();
d = await drawn();
k = await page.locator('.zoom-level').innerText();
say(`At ${k}: ${d.elements} SVG elements, ${d.terms} terms and ${d.lines} lines drawn, ${d.inView} terms in view`);
t0 = await now();
p = await pan(3000, 6, 3);
await settled();
say(`  panning: ${p.fps.toFixed(1)} frames a second, longest frame ${p.worst.toFixed(0)} ms; longest task ${(await longest(t0)).toFixed(0)} ms`);
d = await drawn();
say(`  after panning: ${d.elements} SVG elements, ${d.terms} terms drawn, ${d.inView} in view`);

if (errors.length) say(`Page errors: ${errors.join(' | ')}`);
await browser.close();
process.exit(errors.length ? 1 : 0);
