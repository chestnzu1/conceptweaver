// Drives the built app in a headless browser to check the graph layouts.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
const bar = page.locator('.subgraph');
const layout = page.getByLabel('Graph layout');
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const edge = (label) => page.locator('.edge', { has: page.locator('.edge-label', { hasText: new RegExp('^' + label + '$') }) });
/** Where every term is, in the graph's own coordinates: the middle of its box. */
const spots = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.node')].map((n) => {
  const [x, y] = n.getAttribute('transform').match(/-?[\d.]+/g).map(Number);
  const box = n.querySelector('.node-box').getBBox();
  return [n.querySelector('text').textContent, { x: Math.round(x + box.width / 2), y: Math.round(y + box.height / 2) }];
})));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Waits for a layout to be worked out and for the terms to have glided to their places. */
const settle = async () => {
  await page.waitForFunction(() => !document.querySelector('.layout-busy'));
  let last = '';
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(80);
    const now = JSON.stringify(await spots()) + (await page.locator('[data-world]').getAttribute('transform'));
    if (now === last) return;
    last = now;
  }
};
const choose = async (kind) => { await layout.selectOption(kind); await settle(); };
/** Whether every term is on screen, clear of the bar of buttons above the graph. */
const allInView = () => page.evaluate(() => {
  const c = document.querySelector('.canvas').getBoundingClientRect();
  const b = document.querySelector('.subgraph > .row').getBoundingClientRect();
  return [...document.querySelectorAll('.node .node-box')].every((n) => {
    const r = n.getBoundingClientRect();
    return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom && !(r.top < b.bottom && r.left < b.right);
  });
});
const pathOf = (label) => edge(label).first().locator('.edge-line').getAttribute('d');
const drag = async (name, dx, dy) => {
  const r = await node(name).locator('.node-box').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + dx / 2, r.y + r.height / 2 + dy / 2, { steps: 3 });
  await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, { steps: 3 });
  await page.mouse.up();
};
const options = bar.locator('.layout-options');

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
const before = await turtle();
const start = await spots();
const terms = Object.keys(start).length;

// ---------------------------------------------------------------- the selector
ok((await layout.locator('option').allInnerTexts()).join('|') === 'Hierarchical|Layered (Dagre)|Orthogonal|Radial tree|Circular|Force-directed network|Manual', 'the bar above the graph has a layout selector with all seven layouts');
ok((await layout.inputValue()) === 'hierarchy', 'a model that was laid out as a hierarchy says so');
await page.locator('.header').getByRole('button', { name: /Arrange/ }).click();
const menu = page.locator('.menu, .context-menu').last();
ok(flat(await menu.innerText()).includes('Hierarchical') && flat(await menu.innerText()).includes('Radial tree') && flat(await menu.innerText()).includes('Rearrange'), 'the Arrange menu offers the same layouts: ' + flat(await menu.innerText()));
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- each layout
await node('Film').locator('.node-box').click();
await bar.getByRole('button', { name: 'Style' }).click();
await page.locator('.style-panel').getByRole('button', { name: 'Shape: Hexagon', exact: true }).first().click();
await bar.getByRole('button', { name: 'Style' }).click();
const shape = () => node('Person').locator('.node-box').evaluate((el) => el.tagName.toLowerCase());
ok((await shape()) === 'polygon', 'classes are given a shape before the layouts are tried');
let last = await spots();
for (const [kind, label] of [['layered', 'Layered (Dagre)'], ['orthogonal', 'Orthogonal'], ['radial', 'Radial tree'], ['circular', 'Circular'], ['force', 'Force-directed network'], ['hierarchy', 'Hierarchical']]) {
  await choose(kind);
  const now = await spots();
  ok(!same(now, last) && Object.keys(now).length === terms, `${label}: every term is placed anew`);
  ok(await allInView(), `${label}: the view is fitted to the new arrangement, clear of the bar`);
  ok((await page.locator('.node.selected').count()) === 1 && (await node('Film').getAttribute('class')).includes('selected') && (await shape()) === 'polygon', `${label}: the selection and the styles are as they were`);
  last = now;
}
ok(same(last, await spots()) && (await turtle()) === before, 'six layouts later the ontology reads exactly as before');

// ---------------------------------------------------------------- gliding
await layout.selectOption('circular');
const mid = [];
for (let i = 0; i < 3; i++) { await page.waitForTimeout(70); mid.push(await spots()); }
await settle();
const end = await spots();
ok(mid.some((m) => !same(m, last) && !same(m, end)), 'the terms glide to their new places rather than jump');

// ---------------------------------------------------------------- lines
await choose('orthogonal');
const ortho = await pathOf('is a');
ok(/^M[-\d.,]+( [LQ][-\d., ]+)+$/.test(ortho) && !/C/.test(ortho), 'the orthogonal layout draws its lines with right angles: ' + ortho);
await bar.getByRole('button', { name: 'Layout options' }).click();
ok(flat(await options.innerText()).includes('A tree with each term over what is under it'), 'the options say what the layout does');
const placed = await spots();
await options.getByLabel('Edge routing').selectOption('direct');
ok(/^M[-\d.,]+ Q/.test(await pathOf('is a')) && same(placed, await spots()), 'lines can be made straight without moving a term');
await options.getByLabel('Edge routing').selectOption('curved');
ok(/^M[-\d.,]+ C/.test(await pathOf('is a')), 'or curved');
await options.getByLabel('Edge routing').selectOption('auto');
ok((await pathOf('is a')) === ortho, 'and go back to what the layout suggests');

// ---------------------------------------------------------------- options
await options.getByLabel('Layout direction').selectOption('LR');
await settle();
let now = await spots();
ok(now.Person.x < now.Actor.x && now.Actor.x < now.Film.x && Math.abs(now.Actor.x - now.Director.x) < 2, 'left to right puts the general term on the left and its subclasses in a column');
ok(await allInView(), 'and the view follows');
const slider = options.getByRole('slider', { name: 'Node spacing' });
await slider.focus();
for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
await settle();
const wide = await spots();
ok(Math.abs(wide.Actor.y - wide.Director.y) > Math.abs(now.Actor.y - now.Director.y) + 60 && flat(await options.locator('.layout-slider').first().innerText()).includes('116 px'), 'more node spacing sets the terms of a layer further apart');
await options.getByRole('slider', { name: 'Layer spacing' }).focus();
for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
await settle();
ok((await spots()).Actor.x - (await spots()).Person.x > wide.Actor.x - wide.Person.x + 80, 'more layer spacing sets the layers further apart');
ok((await options.getByRole('slider', { name: 'Repulsion' }).count()) === 0 && (await options.getByText('Root', { exact: true }).count()) === 0, 'settings a layout does not have are not shown');
await choose('force');
ok((await options.getByRole('slider', { name: 'Repulsion' }).count()) === 1 && (await options.getByLabel('Layout direction').count()) === 0, 'the network layout has repulsion and no direction');
const calm = await spots();
await options.getByRole('slider', { name: 'Repulsion' }).focus();
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
await settle();
const spread = (s) => Math.max(...Object.values(s).map((p) => p.x)) - Math.min(...Object.values(s).map((p) => p.x));
ok(spread(await spots()) > spread(calm) * 1.15, 'more repulsion spreads the network');

// ---------------------------------------------------------------- rearranging, and undo
await choose('hierarchy');
await options.getByLabel('Layout direction').selectOption('TB');
await settle();
const tidy = await spots();
await drag('Genre', 160, -120);
ok(!same(await spots(), tidy), 'a term can still be dragged under an automatic layout');
await bar.getByRole('button', { name: 'Rearrange', exact: true }).click();
await settle();
ok(same(await spots(), tidy), 'Rearrange runs the layout again and puts it back');
await choose('circular');
await page.keyboard.press('Control+z');
await settle();
ok(same(await spots(), tidy) && (await layout.inputValue()) === 'hierarchy', 'undo takes back the layout and the selector with it');

// ---------------------------------------------------------------- radial root
await node('Person').locator('.node-box').click({ button: 'right' });
await page.getByText('Arrange as a radial tree around it').click();
await settle();
now = await spots();
const far = (s, id) => Math.max(...Object.values(s).map((p) => Math.hypot(p.x - s[id].x, p.y - s[id].y)));
ok((await layout.inputValue()) === 'radial' && Object.keys(now).every((id) => far(now, 'Person') <= far(now, id) + 1), 'a radial tree is drawn around the term it was asked for');
ok(flat(await options.innerText()).includes('Root Person'), 'the options name its root');
await node('Film').locator('.node-box').click();
await options.getByRole('button', { name: 'Use “Film”' }).click();
await settle();
now = await spots();
ok(Object.keys(now).every((id) => far(now, 'Film') <= far(now, id) + 1), 'and around another once that is chosen as the root');

// ---------------------------------------------------------------- manual
await choose('manual');
ok(same(await spots(), now) && (await bar.getByRole('button', { name: 'Rearrange', exact: true }).isDisabled()), 'Manual moves nothing and has nothing to rearrange');
await drag('Genre', -220, 140);
await drag('Award', 180, 90);
const mine = await spots();
await choose('circular');
ok(!same(await spots(), mine) && flat(await options.innerText()).includes('Your manual arrangement is remembered'), 'another layout rearranges the graph and says the manual arrangement is kept');
await choose('manual');
ok(same(await spots(), mine), 'choosing Manual again brings the arrangement made by hand back');
await drag('Studio', 90, 60);
const kept = await spots();
await options.getByRole('button', { name: 'Save positions' }).click();
await drag('Studio', -300, 0);
await options.getByRole('button', { name: 'Restore saved positions' }).click();
await settle();
ok(same(await spots(), kept), 'positions can be saved and restored on request');
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await page.waitForTimeout(300);
ok((await layout.inputValue()) === 'manual' && same(await spots(), kept), 'after a reload the layout and every position are as they were left');
await choose('orthogonal');
await bar.getByRole('button', { name: 'Layout options' }).click();
const tree = await spots();
await options.getByRole('button', { name: 'Keep this as manual' }).click();
ok((await layout.inputValue()) === 'manual' && same(await spots(), tree), 'an automatic arrangement can be kept as the manual one');
ok((await turtle()) === before, 'after all of it the ontology still reads exactly as before');

// ---------------------------------------------------------------- exports
// The pictures are of the canvas, so they have the layout and its lines; the page that can be moved about redraws them the same way.
await choose('orthogonal');
const onCanvas = await pathOf('wins some');
await page.locator('.header').getByRole('button', { name: /File/ }).click();
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Interactive page/ }).click()]);
const file = shots + 'layout-export.html';
await download.saveAs(file);
const html = fs.readFileSync(file, 'utf8');
ok(html.includes('"route":{"how":"orthogonal","dir":"TB"}') && !/nodeSpacing|layerSpacing|"saved"/.test(html), 'the exported page is told how its lines run, and nothing else of the layout');
const out = await browser.newPage({ viewport: { width: 1500, height: 950 } });
out.on('pageerror', (e) => errors.push('EXPORT PAGEERROR ' + e.message));
await out.goto('file://' + file);
const outLine = (label) => out.locator('svg [data-rel]', { has: out.locator('[data-part="label"]', { hasText: new RegExp('^' + label + '$') }) }).first().locator('[data-part="line"]').getAttribute('d');
ok((await outLine('wins some')) === onCanvas, 'its picture has the lines the canvas had');
const award = out.locator('svg [data-term]', { has: out.locator('text', { hasText: /^Award$/ }) }).first();
const ab = await award.boundingBox();
await out.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
await out.mouse.down();
await out.mouse.move(ab.x + ab.width / 2 + 90, ab.y + ab.height / 2 + 40, { steps: 4 });
await out.mouse.up();
const moved = await outLine('wins some');
ok(moved !== onCanvas && /^M[-\d.,]+( [LQ][-\d., ]+)+$/.test(moved), 'a term moved there keeps its lines at right angles: ' + moved);
await out.close();

// ---------------------------------------------------------------- subgraph
await choose('circular');
const full = await spots();
await node('Film').locator('.node-box').click({ button: 'right' });
await page.getByText('Show as a subgraph').click();
await settle();
const part = Object.keys(await spots()).length;
ok(part > 3 && part < terms && (await layout.inputValue()) === 'hierarchy', `a subgraph of ${part} terms has a layout of its own, hierarchical to begin with`);
let sub = await spots();
for (const kind of ['layered', 'orthogonal', 'radial', 'circular', 'force']) {
  await choose(kind);
  const s = await spots();
  ok(!same(s, sub) && Object.keys(s).length === part && (await allInView()), `the subgraph can be arranged as ${kind}`);
  sub = s;
}
await bar.getByRole('button', { name: 'Full graph' }).click();
await settle();
ok((await layout.inputValue()) === 'circular' && same(await spots(), full), 'the full graph is as it was: its own layout, its own places');

// ---------------------------------------------------------------- a large graph
await page.locator('.header').getByRole('button', { name: /File/ }).click();
await page.getByText('Generate a stress-test model').click();
await page.waitForSelector('.node');
await page.waitForTimeout(500);
const count = await page.locator('.node').count();
for (const kind of ['orthogonal', 'radial', 'circular', 'hierarchy']) {
  const t = Date.now();
  await layout.selectOption(kind);
  await page.waitForFunction((k) => document.querySelector('.layout-select').value === k && !document.querySelector('.layout-busy'), kind);
  ok(Date.now() - t < 4000, `${count} terms are arranged as ${kind} in ${Date.now() - t} ms`);
}
let t = Date.now();
await layout.selectOption('force');
await bar.locator('.layout-busy').waitFor();
// While the worker is at it the page answers: a tab opens at once.
const t1 = Date.now();
await tab('Entities');
await page.locator('.entities, .view').first().waitFor();
const answered = Date.now() - t1;
await tab('Graph');
await page.waitForFunction(() => !document.querySelector('.layout-busy'), null, { timeout: 60000 });
ok(answered < 1500, `the network layout of ${count} terms runs off the page, which answers meanwhile (${answered} ms to open a tab); done in ${Date.now() - t} ms`);
const settledLarge = await page.evaluate(() => document.querySelector('.node').getAttribute('transform'));
// Cancelling: asked for again, and stopped while the worker is still at it.
await layout.selectOption('hierarchy');
await page.waitForFunction(() => document.querySelector('.layout-select').value === 'hierarchy' && !document.querySelector('.layout-busy'));
const laidOut = await page.evaluate(() => document.querySelector('.node').getAttribute('transform'));
await layout.selectOption('force');
await bar.getByRole('button', { name: 'Cancel' }).click();
await page.waitForTimeout(1500);
ok((await bar.locator('.layout-busy').count()) === 0 && (await page.evaluate(() => document.querySelector('.node').getAttribute('transform'))) === laidOut && laidOut !== settledLarge && (await layout.inputValue()) === 'hierarchy', 'a layout can be cancelled while it is worked out, and nothing has moved');
// Dagre is not given a graph it would take minutes over.
await layout.selectOption('layered');
await page.waitForFunction(() => document.querySelector('.layout-select').value === 'layered' && !document.querySelector('.layout-busy'), null, { timeout: 30000 });
const toast = flat(await page.locator('.toast').innerText());
ok(toast.includes('the built-in hierarchical layout was used instead'), 'on a graph too large for Dagre the built-in layout stands in, and says so: ' + toast);
await page.locator('.header').getByRole('button', { name: /File/ }).click();
await page.getByText('Load the large ontology example').click();
await page.waitForSelector('.node');
await page.waitForTimeout(400);
const uni = await spots();
t = Date.now();
await choose('layered');
ok(!same(await spots(), uni), `Dagre lays the large example (${Object.keys(uni).length} terms) out in a worker in under ${Date.now() - t} ms`);

ok(errors.length === 0, 'no errors in the console' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
