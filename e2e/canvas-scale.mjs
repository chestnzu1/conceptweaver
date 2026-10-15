// Drives the built app in a headless browser to check the graph at scale (TD-10, FR-M5-4, FR-M5-5):
// only the terms and lines around the view are drawn, and a line from far away only where it may be
// seen; zoomed out, the words and handles are left out and many lines are drawn as a few paths;
// panning moves the drawing without losing a term; a picture is of the whole graph all the same;
// and a model too large to draw whole opens on the Structure Explorer, its graph drawn around a
// class that is chosen, never whole.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tmp = fs.mkdtempSync('/tmp/cw-scale-');
const side = page.locator('.term-list');
const toast = async () => flat(await page.locator('.toast').innerText({ timeout: 3000 }).catch(() => ''));
const zoom = () => page.locator('.zoom-level').innerText().then((t) => parseInt(t, 10));

/** Classes on a grid, each joined to the one before it in its row and the one above it, and the first to some far away. */
const grid = (n, cols, name) => {
  const terms = Array.from({ length: n }, (_, i) => ({ id: 'c' + i, name: 'Class ' + i, type: 'concept', x: (i % cols) * 220, y: Math.floor(i / cols) * 130 }));
  const relations = [];
  for (let i = 0; i < n; i++) {
    if (i % cols) relations.push({ id: `h${i}`, from: 'c' + i, to: 'c' + (i - 1), kind: 'association', label: 'next to' });
    if (i >= cols) relations.push({ id: `v${i}`, from: 'c' + i, to: 'c' + (i - cols), kind: 'generalization' });
  }
  // Long lines, from one corner to classes all over the grid.
  for (let i = 97; i < n; i += 97) relations.push({ id: `l${i}`, from: 'c0', to: 'c' + i, kind: 'association', label: 'far' });
  return { name, baseIri: 'http://example.org/grid#', terms, relations };
};
const open = async (model, file) => {
  fs.writeFileSync(`${tmp}/${file}`, JSON.stringify(model));
  await page.locator('.header input[type=file]').first().setInputFiles(`${tmp}/${file}`);
  await page.waitForFunction(() => /^Opened/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 120_000 });
  await page.waitForTimeout(800);
};
/** What the canvas draws, and how many of the terms drawn are in view. */
const drawn = () =>
  page.evaluate(() => {
    const view = document.querySelector('.canvas').getBoundingClientRect();
    const nodes = [...document.querySelectorAll('#graph-svg .node')];
    const inView = nodes.filter((n) => {
      const b = n.getBoundingClientRect();
      return b.right > view.left && b.left < view.right && b.bottom > view.top && b.top < view.bottom;
    });
    const svg = document.querySelector('#graph-svg').getBoundingClientRect();
    const longest = Math.max(0, ...[...document.querySelectorAll('#graph-svg .edge-line')].map((l) => Math.max(l.getBBox().width, l.getBBox().height) * (svg.width / Math.max(1, document.querySelector('#graph-svg').viewBox.baseVal?.width || svg.width))));
    return { terms: nodes.length, inView: inView.length, lines: document.querySelectorAll('#graph-svg .edge').length, batches: document.querySelectorAll('#graph-svg .edge.batch').length, words: document.querySelectorAll('#graph-svg .node-text').length, handles: document.querySelectorAll('#graph-svg .handle').length, svg: { w: svg.width, h: svg.height }, longest };
  });
/** Pans by dragging the background, as a hand would, `dx` and `dy` in all. */
const pan = (dx, dy) =>
  page.evaluate(
    ({ dx, dy }) =>
      new Promise((resolve) => {
        const svg = document.querySelector('#graph-svg');
        const r = document.querySelector('.canvas').getBoundingClientRect();
        let x = r.left + r.width / 2;
        let y = r.top + r.height / 2;
        const o = () => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
        svg.dispatchEvent(new PointerEvent('pointerdown', o()));
        let i = 0;
        const step = () => {
          if (i++ === 40) {
            window.dispatchEvent(new PointerEvent('pointerup', o()));
            resolve();
            return;
          }
          x += dx / 40;
          y += dy / 40;
          window.dispatchEvent(new PointerEvent('pointermove', o()));
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { dx, dy },
  );
const centreOf = (name) =>
  page.evaluate((name) => {
    const n = [...document.querySelectorAll('#graph-svg .node')].find((g) => g.querySelector('text')?.textContent === name);
    if (!n) return null;
    // The term's own shape: its group also holds the handle that sticks out to the right.
    const b = n.querySelector('.node-box').getBoundingClientRect();
    const v = document.querySelector('.canvas').getBoundingClientRect();
    return { dx: Math.round(b.left + b.width / 2 - (v.left + v.width / 2)), dy: Math.round(b.top + b.height / 2 - (v.top + v.height / 2)) };
  }, name);
const showClass = async (name) => {
  await side.getByLabel('Search terms').fill(name);
  await side.locator('.term-list-items button, .tree-line button.label', { hasText: new RegExp(`^${name}$`) }).first().click();
  await side.getByLabel('Search terms').fill('');
  await page.waitForTimeout(400);
};

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- only what is around the view is drawn
const N = 3000;
const small = grid(N, 60, 'Grid of 3,000');
await open(small, 'grid.json');
await page.locator('.zoom-level').click();
await showClass('Class 1530');
let d = await drawn();
ok(d.terms < N / 4 && d.inView > 20, `at ${await zoom()} % only the terms around the view are drawn: ${d.terms} of ${N}, ${d.inView} of them in view`);
ok(JSON.stringify(await centreOf('Class 1530')) === JSON.stringify({ dx: 0, dy: 0 }), 'the class shown is drawn, in the middle of the view');
ok(d.longest < Math.max(d.svg.w, d.svg.h) * 2, `a line from far away is drawn only where it may be seen: the longest drawn is ${Math.round(d.longest)} px, the drawing ${Math.round(d.svg.w)} by ${Math.round(d.svg.h)}`);

// ---------------------------------------------------------------- panning loses nothing
const before = await centreOf('Class 1530');
await pan(-500, -260);
let after = await centreOf('Class 1530');
ok(after && after.dx === before.dx - 500 && after.dy === before.dy - 260, 'a pan within the drawn area moves the drawing as far as the pointer: ' + JSON.stringify(after));
for (let i = 0; i < 5; i++) await pan(-700, -400);
d = await drawn();
ok(d.terms < N / 4 && d.inView > 20, `panned far beyond it, what is around the view is drawn instead: ${d.terms} terms, ${d.inView} in view`);
await showClass('Class 1530');
ok(JSON.stringify(await centreOf('Class 1530')) === JSON.stringify({ dx: 0, dy: 0 }), 'and the class is drawn again where it was, when the view comes back to it');

// ---------------------------------------------------------------- less detail zoomed out
for (let i = 0; i < 12 && (await zoom()) >= 20; i++) await page.locator('.zoom').getByRole('button', { name: 'Zoom out' }).click();
await page.waitForTimeout(400);
d = await drawn();
ok(d.words === 0 && d.handles === 0 && d.terms > 0, `zoomed out to ${await zoom()} %, the terms are drawn without their words or handles: ${d.terms} terms`);
ok(d.batches > 0 && d.lines === d.batches, `and their many lines as a few paths: ${d.batches} paths`);
await page.locator('.zoom-level').click();
await showClass('Class 1530');
d = await drawn();
ok(d.words === d.terms && d.batches === 0 && d.handles === d.terms, 'at 100 % again each term has its words and its handle, and each line is its own');

// ---------------------------------------------------------------- the picture is of the whole graph
await page.getByRole('button', { name: 'File', exact: true }).click();
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Image \(SVG\)/ }).click()]);
await download.saveAs(`${tmp}/grid.svg`);
const svg = fs.readFileSync(`${tmp}/grid.svg`, 'utf8');
const inPicture = { terms: (svg.match(/data-term="/g) ?? []).length, lines: (svg.match(/data-rel="/g) ?? []).length };
ok(inPicture.terms === N && inPicture.lines === small.relations.length, `an SVG picture has every term and line, though the canvas draws some: ${inPicture.terms} terms and ${inPicture.lines} lines`);
d = await drawn();
ok(d.terms < N / 4, 'and after it the canvas draws what is around the view again: ' + d.terms);

// ---------------------------------------------------------------- a model too large to draw whole
const BIG = 12_500;
await open(grid(BIG, 125, 'Grid of 12,500'), 'big.json');
ok(flat(await page.locator('.header [role=tab][aria-selected=true]').innerText()) === 'Structure', `a model of ${BIG.toLocaleString('en')} terms opens on the Structure Explorer`);
await page.locator('.header').getByRole('tab', { name: 'Graph' }).click();
const chooser = page.locator('.graph-chooser');
ok((await chooser.count()) === 1 && (await page.locator('#graph-svg').count()) === 0, 'its Graph view draws nothing of the graph, and asks for a class to draw it around: ' + flat(await chooser.locator('strong').innerText()));
await chooser.getByRole('button', { name: 'Choose a class to draw the graph around' }).click();
await chooser.getByRole('combobox').fill('Class 6250');
await chooser.locator('.subgraph-found button', { hasText: /^Class 6250/ }).first().dispatchEvent('pointerdown');
await page.waitForSelector('#graph-svg .node');
d = await drawn();
ok(d.terms > 1 && d.terms < 50 && (await centreOf('Class 6250')) !== null, `a class chosen, the graph is drawn around it: ${d.terms} terms`);
ok((await page.locator('.inspector input').first().inputValue()) === 'Class 6250', 'and the class is open in the side panel');
await page.locator('.subgraph').getByRole('button', { name: 'Full graph' }).click();
ok(/too many to draw at once/.test(await toast()) && (await chooser.count()) === 1 && (await page.locator('#graph-svg').count()) === 0, 'asked for the full graph, it is not drawn: the app says why, and asks for a class again');
await chooser.getByRole('button', { name: 'Back to the subgraph' }).click();
ok((await drawn()).terms === d.terms, 'and goes back to the subgraph as it was');
await page.locator('.subgraph').getByRole('button', { name: 'Settings' }).click();
await page.locator('.subgraph').getByRole('button', { name: 'Clear' }).click();
ok((await chooser.count()) === 1 && (await chooser.getByRole('button', { name: 'Back to the subgraph' }).count()) === 0, 'the subgraph cleared, it asks for a class again');
await page.getByRole('button', { name: 'File', exact: true }).click();
await page.getByRole('menuitem', { name: /^Image \(SVG\)/ }).click();
ok(/too large to draw whole/.test(await toast()), 'and a picture of the whole graph is not made: ' + (await toast()));
// From the class tree, a class is shown in the graph drawn around it.
await showClass('Class 12345');
ok((await centreOf('Class 12345')) !== null && (await chooser.count()) === 0, 'a class clicked in the class tree is drawn, with its neighbours');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
