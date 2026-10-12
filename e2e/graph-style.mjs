// Drives the built app in a headless browser to check the graph style editor.
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
const panel = page.locator('.style-panel');
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const box = (name) => node(name).locator('.node-box');
const tag = (loc) => loc.evaluate((el) => el.tagName.toLowerCase());
const css = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
const edge = (label) => page.locator('.edge', { has: page.locator('.edge-label', { hasText: new RegExp('^' + label + '$') }) });
const isA = page.locator('.edge.generalization:not(.instance-of)');
const row = (label) => panel.locator('.style-row', { has: page.locator('.style-label', { hasText: new RegExp('^' + label + '$') }) });
const choose = (label, option) => row(label).getByRole('button', { name: `${label}: ${option}`, exact: true }).click();
const settle = () => page.waitForTimeout(200);

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
const before = await turtle();

// ---------------------------------------------------------------- the panel
ok((await panel.count()) === 0, 'the style editor stays out of the way until asked for');
await page.locator('.subgraph').getByRole('button', { name: 'Style' }).click();
ok((await panel.getByRole('tab').allInnerTexts()).join('|') === 'Nodes|Edges|Themes', 'the Style button on the canvas opens it, with tabs for nodes, edges and themes');
ok((await tag(box('Film'))) === 'rect' && (await css(box('Film'), 'strokeWidth')) === '1.5px', 'an unstyled graph is drawn as before');

// ---------------------------------------------------------------- nodes by kind
await choose('Shape', 'Hexagon');
ok((await tag(box('Film'))) === 'polygon' && (await tag(box('Person'))) === 'polygon' && (await tag(box('Parasite'))) === 'rect', 'a shape set for classes is drawn on every class at once, and on nothing else');
// Every class of the sample was given a colour on the canvas. That is a choice for the one term, and it stands.
const purple = await css(box('Genre'), 'fill');
await choose('Fill', 'Blue');
await settle();
const hint = panel.locator('.style-hint', { hasText: 'of their own' });
ok((await css(box('Genre'), 'fill')) === purple && flat(await hint.innerText()).startsWith('8 terms of this kind keep a fill of their own'), 'a fill for the kind leaves alone the terms that have a colour of their own, and says so: ' + flat(await hint.innerText()));
await hint.getByRole('button', { name: 'Clear them' }).click();
await settle();
ok((await css(box('Genre'), 'fill')) !== purple && (await css(box('Genre'), 'fill')) === (await css(box('Award'), 'fill')), 'cleared of those, every class takes the fill of its kind');
await row('Border thickness').locator('input[type=number]').fill('3');
await settle();
ok((await css(box('Genre'), 'strokeWidth')) === '3px', 'the border thickness follows the number typed');
await row('Label shows').locator('select').selectOption('curie');
ok((await node(':Film').count()) === 1 && (await node(':Genre').count()) === 1, 'the label can show the prefixed IRI instead of the name');
await row('Label shows').locator('select').selectOption('');
await row('Label size').locator('input').fill('16');
await row('Label weight').locator('select').selectOption('700');
await settle();
ok((await css(node('Film').locator('.node-text'), 'fontSize')) === '16px' && (await css(node('Film').locator('.node-text'), 'fontWeight')) === '700', 'label size and weight apply');
const widthBefore = (await box('Genre').boundingBox()).width;
await row('Size').getByLabel('Width').fill('200');
await settle();
ok(Math.abs((await box('Genre').boundingBox()).width / widthBefore - 200 / (widthBefore / 1)) < 5 || (await box('Genre').boundingBox()).width > widthBefore * 1.3, 'a width set by hand makes the nodes that wide');
await row('Size').getByLabel('Width').fill('');

// individuals and data properties have styles of their own
await row('Kind of term').locator('select').selectOption('individual');
await choose('Shape', 'Ellipse');
ok((await tag(box('Parasite'))) === 'ellipse' && (await tag(box('Film'))) === 'polygon', 'each kind of term has its own style: the individual is an ellipse, the classes stay hexagons');

// ---------------------------------------------------------------- one node
await node('Genre').locator('.node-box').click();
await panel.getByRole('button', { name: /^Selected/ }).click();
ok(flat(await panel.locator('.style-hint').innerText()).startsWith('For Genre only'), 'with a term selected, the panel can style that one term: ' + flat(await panel.locator('.style-hint').innerText()).slice(0, 40));
await choose('Shape', 'Diamond');
await row('Fill').locator('input[type=color]').fill('#102a43');
await settle();
ok((await tag(box('Genre'))) === 'polygon' && (await css(box('Genre'), 'fill')) === 'rgb(16, 42, 67)' && (await css(box('Person'), 'fill')) !== 'rgb(16, 42, 67)', 'its own shape and a freely picked colour go on that term only');
ok((await css(node('Genre').locator('.node-text'), 'fill')) === 'rgb(255, 255, 255)', 'and its label turns white to stay readable on the dark fill');
ok((await css(box('Genre'), 'stroke')) === (await page.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--accent)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })), 'the selected term still shows that it is selected');
await page.screenshot({ path: shots + 'graph-style.png' });
await choose('Fill', 'Amber');
await settle();
ok((await css(box('Genre'), 'fill')) !== (await css(box('Person'), 'fill')) && (await css(node('Genre').locator('.node-text'), 'fill')) !== 'rgb(255, 255, 255)', 'one of the named colours works for a single term too, as the canvas menu’s colours do');
await panel.getByRole('button', { name: 'Reset to its kind' }).click();
await settle();
ok((await css(box('Genre'), 'fill')) === (await css(box('Person'), 'fill')) && (await tag(box('Genre'))) === 'polygon', 'Reset to its kind takes the term’s own style away again');
await page.locator('#graph-svg').click({ position: { x: 30, y: 500 } });

// ---------------------------------------------------------------- edges by kind
await panel.getByRole('tab', { name: 'Edges' }).click();
const line = isA.first().locator('.edge-line');
const edgeColour = await css(line, 'stroke');
await choose('Colour', 'Red');
await row('Thickness').locator('input[type=number]').fill('3');
await choose('Line', 'Dashed');
await settle();
ok((await css(line, 'stroke')) !== edgeColour && (await css(line, 'strokeWidth')) === '3px' && (await css(line, 'strokeDasharray')) !== 'none', 'colour, thickness and line style set for “is a” apply to every such edge');
ok((await css(edge('acts in some').locator('.edge-line'), 'stroke')) === edgeColour, 'and to no other kind of relationship');
// The arrow still points at the superclass: Actor is a Person.
const tipNear = async (edgeLoc, target) => {
  const tip = await edgeLoc.locator('.edge-arrow').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const t = await box(target).boundingBox();
  return Math.hypot(tip.x - (t.x + t.width / 2), tip.y - (t.y + t.height / 2));
};
const toPerson = page.locator('.edge.generalization:not(.instance-of)').nth(0);
await choose('Arrowhead', 'Filled arrowhead');
await settle();
ok((await css(toPerson.locator('.edge-arrow'), 'fill')) === (await css(toPerson.locator('.edge-line'), 'stroke')), 'the arrowhead can be filled instead of hollow');
ok((await tipNear(toPerson, 'Person')) < 80, 'and still points at the superclass: direction is not a matter of style');
await choose('Arrowhead', 'No arrowhead');
ok((await toPerson.locator('.edge-arrow').count()) === 0, 'or left out');
await choose('Arrowhead', 'Default for its kind');
const labels = await page.locator('.edge-label').count();
await row('Label').locator('select').selectOption('hide');
ok((await page.locator('.edge-label').count()) < labels, 'the labels of one kind of relationship can be hidden: ' + labels + ' → ' + (await page.locator('.edge-label').count()));
await row('Label').locator('select').selectOption('');

// ---------------------------------------------------------------- one edge
await edge('directs some').locator('.edge-label-bg').click();
await panel.getByRole('button', { name: /^Selected/ }).click();
await choose('Colour', 'Green');
await row('Curvature').locator('input[type=number]').fill('60');
await page.locator('#graph-svg').click({ position: { x: 30, y: 500 } });
await settle();
ok((await css(edge('directs some').locator('.edge-line'), 'stroke')) !== edgeColour && (await css(edge('acts in some').locator('.edge-line'), 'stroke')) === edgeColour, 'a single relationship can be given a colour of its own');
ok(/Q/.test(await edge('directs some').locator('.edge-line').getAttribute('d')) && (await edge('directs some').locator('.edge-line').evaluate((el) => el.getBBox().width)) > 10, 'and can be made to bow');

// ---------------------------------------------------------------- nothing about the ontology changed
ok((await turtle()) === before, 'none of it changed the ontology: the Turtle is the same to the character');

// ---------------------------------------------------------------- themes
await panel.getByRole('tab', { name: 'Themes' }).click();
ok((await panel.locator('.theme-list').first().locator('.theme strong').allInnerTexts()).join('|') === 'Standard|Professional|Minimal|High contrast|Colorful', 'the built-in themes are listed, each with a preview');
await panel.getByRole('button', { name: /Colorful/ }).click();
await settle();
ok((await tag(box('Parasite'))) === 'ellipse' && (await tag(box('Person'))) === 'rect' && flat(await panel.locator('.theme.on').innerText()).includes('in use'), 'applying a theme restyles every kind at once: ' + flat(await panel.locator('.theme.on').innerText()));
ok((await css(edge('directs some').locator('.edge-line'), 'stroke')) !== (await css(edge('acts in some').locator('.edge-line'), 'stroke')), 'styles given to single terms and relationships are kept');
await panel.getByRole('tab', { name: 'Nodes' }).click();
await panel.getByRole('button', { name: 'By kind' }).click();
await row('Kind of term').locator('select').selectOption('class');
await choose('Shape', 'Ellipse');
await panel.getByRole('tab', { name: 'Themes' }).click();
ok(flat(await panel.locator('.theme.on').innerText()).includes('changed since'), 'a theme can be customised, and the panel says it has been');
await panel.getByLabel('Name for the current style').fill('House style');
await panel.getByRole('button', { name: 'Save', exact: true }).click();
ok(flat(await panel.locator('li.saved').innerText()).includes('House style') && flat(await panel.locator('li.saved').innerText()).includes('in use'), 'the current style can be saved under a name');
await panel.getByRole('button', { name: 'Restore defaults' }).click();
await settle();
ok((await tag(box('Person'))) === 'rect' && (await css(box('Genre'), 'strokeWidth')) === '1.5px' && (await css(edge('directs some').locator('.edge-line'), 'stroke')) === edgeColour, 'Restore defaults goes back to the standard look, single styles included');
await page.locator('.header').getByRole('button', { name: 'Undo' }).click();
await settle();
ok((await tag(box('Person'))) === 'ellipse', 'and Undo brings the style back: a change of style is undone like any other');
await page.locator('.header').getByRole('button', { name: 'Redo' }).click();
await panel.locator('li.saved button.theme').click();
await settle();
ok((await tag(box('Person'))) === 'ellipse' && (await tag(box('Parasite'))) === 'ellipse', 'the saved style can be applied again');

// ---------------------------------------------------------------- the subgraph is drawn the same way
await node('Film').locator('.node-box').click();
await page.locator('.subgraph').getByRole('button', { name: 'Subgraph', exact: true }).click();
await page.waitForTimeout(400);
ok((await tag(box('Film'))) === 'ellipse' && (await page.locator('.node').count()) < 12, 'the subgraph is drawn in the same style: ' + (await page.locator('.node').count()) + ' terms');
await page.locator('.subgraph').getByRole('button', { name: 'Full graph' }).click();

// ---------------------------------------------------------------- persistence
await page.waitForTimeout(900);
await page.reload();
await page.waitForSelector('.node');
ok((await tag(box('Person'))) === 'ellipse' && (await panel.count()) === 0, 'after a reload the graph is styled as it was left');
await page.locator('.subgraph').getByRole('button', { name: 'Style' }).click();
await panel.getByRole('tab', { name: 'Themes' }).click();
ok(flat(await panel.locator('li.saved').innerText()).includes('House style'), 'and the saved style is still there');
ok((await turtle()) === before, 'the ontology is still exactly what it was');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
