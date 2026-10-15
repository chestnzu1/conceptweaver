// Drives the built app in a headless browser to check the ends of a relationship: moving where a
// line meets its term (a matter of the picture), and reconnecting it to another term (an edit).
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 }, acceptDownloads: true });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
// A data property is drawn with its datatype after its name.
const node = (name) => page.locator('.node', { has: page.locator('.node-text', { hasText: new RegExp('^' + name + '( : .+)?$') }) });
const edge = (label) => page.locator('.edge', { has: page.locator('.edge-label', { hasText: new RegExp('^' + label + '$') }) });
const handle = (end) => page.locator(`.end-handle[data-end="${end}"]`);
const boxOf = (name) => node(name).locator('.node-box').boundingBox();
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const lineOf = (label) => edge(label).first().locator('.edge-line').getAttribute('d');
const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);
/** Where a point of the graph's own coordinates is on the screen. */
const onScreen = (p) => page.evaluate(([x, y]) => {
  const svg = document.querySelector('#graph-svg');
  const m = document.querySelector('[data-world]').getScreenCTM();
  const at = Object.assign(svg.createSVGPoint(), { x, y }).matrixTransform(m);
  return { x: at.x, y: at.y };
}, [p.x, p.y]);
/** Where a line starts and where it ends, on the screen. */
const endsOf = async (label) => {
  const n = nums(await lineOf(label));
  return [await onScreen({ x: n[0], y: n[1] }), await onScreen({ x: n[n.length - 2], y: n[n.length - 1] })];
};
// Selecting is asked of the line itself, so that it does not matter what else lies across its label.
const select = async (label) => { await edge(label).first().locator('.edge-line').dispatchEvent('pointerdown', { button: 0 }); await page.waitForSelector('.end-handle'); };
const menuOf = async (label) => {
  const b = await edge(label).first().locator('.edge-label-bg').boundingBox();
  const id = await edge(label).first().getAttribute('data-rel');
  await page.evaluate(([rel, x, y]) => document.querySelector(`[data-rel="${rel}"] .edge-line`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y })), [id, b.x + 4, b.y + 4]);
  await page.waitForSelector('.menu');
};
/** Takes hold of an end of the selected line and moves it to a point, in steps, without letting go. */
const take = async (end, to, steps = 8) => {
  const h = centre(await handle(end).locator('.end-dot').boundingBox());
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x + (to.x - h.x) / 3, h.y + (to.y - h.y) / 3, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps });
};
const drop = async (end, to) => { await take(end, to); await page.mouse.up(); };
const within = (b, p, slack = 6) => p.x >= b.x - slack && p.x <= b.x + b.width + slack && p.y >= b.y - slack && p.y <= b.y + b.height + slack;
const toast = () => page.locator('.toast');
/** The model as the browser keeps it, once it has been written there (a little after each change). */
// The working copy, as it is kept in this browser (IndexedDB), a moment after a change.
const kept = async () => { await page.waitForTimeout(450); return page.evaluate(() => new Promise((resolve, reject) => { const r = indexedDB.open('conceptweaver'); r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('working')) { db.close(); return resolve(null); } const g = db.transaction('working', 'readonly').objectStore('working').get('current'); g.onsuccess = () => { db.close(); resolve(g.result?.model ?? null); }; g.onerror = () => reject(g.error); }; })); };
const anchors = async () => (await kept())?.style?.anchors ?? null;
/** The relationship between two terms, by their names, as the model has it. */
const relOf = async (from, to) => {
  const m = await kept();
  const id = (name) => m.terms.find((t) => t.name === name)?.id;
  return m.relations.find((r) => r.from === id(from) && r.to === id(to));
};
const menuItem = (text) => page.locator('.menu-item', { hasText: new RegExp('^' + text) });
const undo = () => page.keyboard.press('Control+z');
const redo = () => page.keyboard.press('Control+Shift+z');

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
const before = await turtle();

// ---------------------------------------------------------------- the ends of the selected line
ok((await page.locator('.end-handle').count()) === 0, 'nothing is selected: no line shows its ends');
await select('directs some');
ok((await page.locator('.end-handle').count()) === 2 && (await handle('from').count()) === 1 && (await handle('to').count()) === 1, 'the selected relationship shows a handle at each of its two ends');
{
  const [a, b] = await endsOf('directs some');
  const from = centre(await handle('from').locator('.end-dot').boundingBox());
  const to = centre(await handle('to').locator('.end-dot').boundingBox());
  ok(Math.hypot(a.x - from.x, a.y - from.y) < 3 && Math.hypot(b.x - to.x, b.y - to.y) < 16, 'the handles are where the line leaves its first term and arrives at its second');
  const hit = await handle('to').locator('.end-hit').boundingBox();
  ok(hit.width >= 24 && hit.height >= 24, `a handle is at least 24 pixels to take hold of (${Math.round(hit.width)})`);
  ok(!(await handle('from').getAttribute('class')).includes('set'), 'an end that is placed automatically is drawn hollow');
  ok(/Drag it along the term.*or onto another term to reconnect/.test(await handle('to').locator('title').textContent()), 'a handle says what dragging it does');
}

// ---------------------------------------------------------------- moving where the line meets its term
const director = await boxOf('Director');
const film = await boxOf('Film');
const straight = await lineOf('directs some');
// Along the bottom of Director, a quarter of the way in.
await take('from', { x: director.x + director.width * 0.25, y: director.y + director.height + 8 });
ok((await lineOf('directs some')) !== straight, 'while it is dragged along its term the line is drawn from where it is held');
ok((await page.locator('.node.cannot-take, .node.can-take').count()) === 0 && (await page.locator('.reconnect-why').count()) === 0, 'sliding along its own term asks nothing of the other terms');
ok(await anchors().then((a) => !a || !Object.keys(a).length), 'nothing is kept until it is let go');
await page.mouse.up();
{
  const [a] = await endsOf('directs some');
  ok(Math.abs(a.y - (director.y + director.height)) < 8 && Math.abs(a.x - (director.x + director.width * 0.25)) < 6, 'let go, the line leaves the bottom of the term where it was put');
  const kept = await anchors();
  const pin = Object.values(kept)[0];
  ok(Object.keys(kept).length === 1 && pin.from.side === 'bottom' && Math.abs(pin.from.at - 0.25) < 0.04 && !pin.to, `the place is kept as a side of the term and how far along it (${JSON.stringify(pin)})`);
  ok((await handle('from').getAttribute('class')).includes('set') && !(await handle('to').getAttribute('class')).includes('set'), 'the end that was put by hand is drawn filled, the other still hollow');
  ok((await turtle()) === before, 'the ontology says exactly what it said: no axiom changed');
}
await select('directs some');
// Any side: the left of Film, which faces away from nothing here, then its top.
await drop('to', { x: film.x - 8, y: film.y + film.height * 0.5 });
{
  const [, b] = await endsOf('directs some');
  ok(Math.abs(b.x - film.x) < 16 && within(film, b, 16), 'the other end can be put on another side of its term');
  await drop('to', { x: film.x + film.width * 0.8, y: film.y - 8 });
  const pin = Object.values(await anchors())[0];
  ok(pin.to.side === 'top' && Math.abs(pin.to.at - 0.8) < 0.05 && pin.from.side === 'bottom', 'and moved again, to the top, with the first end left where it was');
}

// It stays attached when its term moves.
{
  const [a0] = await endsOf('directs some');
  const d = centre(director);
  await page.mouse.move(d.x, d.y);
  await page.mouse.down();
  await page.mouse.move(d.x - 40, d.y - 30, { steps: 4 });
  await page.mouse.move(d.x - 90, d.y - 60, { steps: 4 });
  await page.mouse.up();
  await select('directs some');
  const moved = await boxOf('Director');
  const [a1] = await endsOf('directs some');
  ok(Math.abs(a1.x - a0.x - (moved.x - director.x)) < 2 && Math.abs(a1.y - a0.y - (moved.y - director.y)) < 2 && Math.abs(moved.x - director.x + 90) < 4, 'when the term is moved the end goes with it, at the same place on its outline');
  await undo();
  await page.waitForTimeout(80);
}

// Undo and redo.
await select('directs some');
await undo();
ok(await anchors().then((a) => Object.values(a)[0].to.side === 'left'), 'undo takes back the last move of an end, and only that');
await redo();
ok(await anchors().then((a) => Object.values(a)[0].to.side === 'top'), 'and redo makes it again');

// Esc while sliding.
{
  const d = await boxOf('Director');
  const kept = JSON.stringify(await anchors());
  const line = await lineOf('directs some');
  await take('from', { x: d.x + d.width + 8, y: d.y + d.height * 0.5 });
  ok((await lineOf('directs some')) !== line, 'held on another side the line is shown there');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  ok((await lineOf('directs some')) === line && JSON.stringify(await anchors()) === kept, 'Esc puts it back where it was, and nothing was kept');
  ok((await page.locator('.edge.selected').count()) === 1, 'and the relationship is still selected');
}

// ---------------------------------------------------------------- other layouts, other shapes
{
  const layout = page.getByLabel('Graph layout');
  const settle = async () => {
    await page.waitForFunction(() => !document.querySelector('.layout-busy'));
    let last = '';
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(80);
      const now = await page.evaluate(() => [...document.querySelectorAll('.node')].map((n) => n.getAttribute('transform')).join());
      if (now === last) return;
      last = now;
    }
  };
  const pinsBefore = JSON.stringify(await anchors());
  for (const kind of ['layered', 'orthogonal', 'circular']) {
    await layout.selectOption(kind);
    await settle();
    const [a, b] = await endsOf('directs some');
    const d = await boxOf('Director');
    const f = await boxOf('Film');
    ok(Math.abs(a.y - (d.y + d.height)) < 8 && Math.abs(b.y - f.y) < 16 && within(d, a, 8) && within(f, b, 16), `under the ${kind} layout the line still leaves the bottom of one term and arrives at the top of the other`);
  }
  ok(JSON.stringify(await anchors()) === pinsBefore, 'changing the layout keeps where the ends were put');
  await layout.selectOption('manual');
  await settle();
  await page.locator('.zoom').getByRole('button', { name: 'Fit' }).click();
  await settle();
}

// ---------------------------------------------------------------- reset to automatic
await select('directs some');
await handle('to').dblclick();
ok(await anchors().then((a) => !Object.values(a)[0].to && Object.values(a)[0].from.side === 'bottom'), 'a double-click on an end has it placed automatically again, the other end as it was');
await menuOf('directs some');
ok(await menuItem('Reset connection points').isEnabled(), 'the menu of a relationship offers to reset its connection points');
await menuItem('Reset connection points').click();
ok(await anchors().then((a) => !Object.keys(a).length) && (await lineOf('directs some')) !== null, 'which puts both ends back');
await menuOf('acts in some');
ok(await menuItem('Reset connection points').isDisabled(), 'and is not on offer for a relationship whose ends were never moved');
await page.keyboard.press('Escape');

// The same from the panel, without dragging.
await select('directs some');
{
  const panel = page.locator('.field.pins');
  ok((await panel.count()) === 1 && flat(await panel.locator('> span').innerText()).toLowerCase() === 'connection points', 'the panel of a relationship has its connection points');
  const side = panel.getByLabel('Side of “Director” the line starts on');
  const along = panel.getByLabel('How far along that side of “Director”, in percent');
  ok((await side.inputValue()) === '' && (await along.isDisabled()) && (await panel.getByRole('button', { name: 'Reset to automatic' }).isDisabled()), 'both ends are automatic to begin with, and there is nothing to reset');
  await side.selectOption('right');
  ok(await anchors().then((a) => Object.values(a)[0].from.side === 'right' && Object.values(a)[0].from.at === 0.5), 'choosing a side puts the end in the middle of it');
  await along.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  ok(await anchors().then((a) => Object.values(a)[0].from.at === 0.6), 'and the slider moves it along the side, from the keyboard too');
  const d = await boxOf('Director');
  const [a] = await endsOf('directs some');
  ok(Math.abs(a.x - (d.x + d.width)) < 8 && Math.abs(a.y - (d.y + d.height * 0.6)) < 4, 'the canvas draws the line from there');
  await panel.getByRole('button', { name: 'Reset to automatic' }).click();
  ok(await anchors().then((a) => !Object.keys(a).length) && (await side.inputValue()) === '', 'Reset to automatic puts both ends back');
  ok((await turtle()) === before, 'none of this changed what the ontology says');
}

// ---------------------------------------------------------------- reconnecting
await select('directs some');
const award = await boxOf('Award');
await take('to', centre(award));
ok((await page.locator('.graph.reconnecting').count()) === 1 && (await page.locator('.reconnect-line').count()) === 1, 'dragged away from its term an end looks for another one, and a line follows it');
ok((await page.locator('.edge.moving').count()) === 1 && (await handle('to').count()) === 0, 'the relationship itself steps back while its end is away');
{
  const can = await page.locator('.node.can-take .node-text').allTextContents();
  const cannot = await page.locator('.node.cannot-take .node-text').allTextContents();
  ok(['Person', 'Actor', 'Director', 'Documentary', 'Studio', 'Genre', 'Award', 'Film'].every((n) => can.includes(n)), `every class can take the end of an object property between classes (${can.join(', ')})`);
  ok(['Parasite', 'Release date : date', 'Running time : integer'].every((n) => cannot.some((c) => c.startsWith(n.split(' :')[0]))) && cannot.length === 3, `an individual and the data properties cannot, and are faded (${cannot.join(', ')})`);
  ok((await node('Award').getAttribute('class')).includes('target') && flat(await page.locator('.reconnect-why').innerText()) === 'Let go to move this end to “Award”.', 'over a term that can take it, the term is ringed and what letting go does is said');
  ok(await page.locator('.reconnect-line.ok').count() === 1, 'and the line reaches for that term');
  await page.screenshot({ path: shots + 'reconnect-valid.png' });
}
await page.mouse.up();
await page.waitForTimeout(60);
{
  const [, b] = await endsOf('directs some');
  ok(within(await boxOf('Award'), b, 16), 'let go there, the line now ends at the other term');
  const r = await relOf('Director', 'Award');
  ok(r && r.label === 'directs' && r.kind === 'association' && !(await relOf('Director', 'Film')), 'the relationship is the one it was, with its name and its kind, between the new pair of terms');
  ok((await page.locator('.edge.selected').count()) === 1 && (await page.locator('.end-handle').count()) === 2 && (await page.locator('.node.can-take, .node.cannot-take, .reconnect-line, .reconnect-why').count()) === 0, 'it is still selected, and nothing of the dragging is left on the canvas');
  const ttl = await turtle();
  ok(/owl:onProperty :directs ;\s*owl:someValuesFrom :Award/.test(ttl) && !/owl:onProperty :directs ;\s*owl:someValuesFrom :Film/.test(ttl), 'the axiom follows: Director is restricted to some Award, and no longer to some Film');
  const lines = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  const [added, gone] = [lines(ttl).filter((l) => !lines(before).includes(l)), lines(before).filter((l) => !lines(ttl).includes(l))];
  ok(added.length === 1 && gone.length === 1 && added[0].replace(':Award', ':Film') === gone[0], 'and that one line is all that is different in the ontology');
  await undo();
  ok((await turtle()) === before && !!(await relOf('Director', 'Film')), 'one undo puts the relationship back as it was');
  await redo();
  ok(!!(await relOf('Director', 'Award')), 'and redo reconnects it again');
  await undo();
}

// A term that cannot take the end.
await select('directs some');
{
  const line = await lineOf('directs some');
  await take('to', centre(await boxOf('Parasite')));
  const cls = await node('Parasite').getAttribute('class');
  ok(cls.includes('refused') && cls.includes('cannot-take') && !cls.includes('target'), 'over a term that cannot take it, the term is marked as refusing');
  ok(flat(await page.locator('.reconnect-why').innerText()) === 'The object property “directs” needs a class at this end: “Parasite” is an individual.' && (await page.locator('.reconnect-why.refused, .reconnect-line.refused').count()) === 2, 'and the reason is said beside the pointer, before anything is let go');
  await page.screenshot({ path: shots + 'reconnect-refused.png' });
  await page.mouse.up();
  ok(flat(await toast().innerText()) === 'The object property “directs” needs a class at this end: “Parasite” is an individual.', 'let go there, the reason is shown');
  ok((await lineOf('directs some')) === line && !!(await relOf('Director', 'Film')) && (await turtle()) === before, 'and the relationship is where it was: no axiom changed');
}

// Let go on nothing, and Esc.
await select('directs some');
{
  const line = await lineOf('directs some');
  const f = await boxOf('Film');
  await drop('to', { x: f.x + f.width + 150, y: f.y - 130 });
  ok((await lineOf('directs some')) === line && !!(await relOf('Director', 'Film')), 'let go on no term at all, it goes back to the term it was on');
  await select('directs some');
  await take('to', centre(await boxOf('Award')));
  ok((await node('Award').getAttribute('class')).includes('target'), 'held over a term that would take it');
  await page.keyboard.press('Escape');
  ok((await page.locator('.reconnect-line, .node.can-take').count()) === 0, 'Esc gives the drag up at once');
  await page.mouse.up();
  ok((await lineOf('directs some')) === line && !!(await relOf('Director', 'Film')) && (await page.locator('.edge.selected').count()) === 1, 'and letting go afterwards changes nothing: the relationship is as it was, and still selected');
}

// The start of a line, and the other kinds of relationship.
await select('directs some');
await drop('from', centre(await boxOf('Studio')));
ok(!!(await relOf('Studio', 'Film')) && (await kept()).relations.filter((r) => r.label === 'directs').length === 1, 'the start of a line can be moved to another term as well: Studio directs some Film');
await undo();

const selectRel = async (from, to) => {
  const r = await relOf(from, to);
  await page.locator(`[data-rel="${r.id}"] .edge-line`).dispatchEvent('pointerdown', { button: 0 });
  await page.waitForSelector('.end-handle');
  return r;
};
{
  // Is a: between two classes, and only that.
  await selectRel('Documentary', 'Film');
  await take('to', centre(await boxOf('Award')));
  const cannot = await page.locator('.node.cannot-take .node-text').allTextContents();
  ok(cannot.length === 4 && cannot.some((c) => c === 'Parasite') && cannot.some((c) => c === 'Documentary'), `“is a” can end on any class but its own: not on an individual, a data property or itself (${cannot.join(', ')})`);
  await page.mouse.up();
  ok(!!(await relOf('Documentary', 'Award')) && (await relOf('Documentary', 'Award')).kind === 'generalization', 'moved to another class it is still “is a”');
  const doc = (await turtle()).split('\n\n').find((b) => b.startsWith(':Documentary '));
  ok(/rdfs:subClassOf :Award/.test(doc) && !/rdfs:subClassOf :Film/.test(doc), 'and the superclass is the new one');
  await undo();
  await selectRel('Documentary', 'Film');
  await drop('to', centre(await boxOf('Release date')));
  ok(/“is a” needs a class at this end: “Release date” is a data property\./.test(flat(await toast().innerText())) && (await relOf('Documentary', 'Film')).kind === 'generalization', 'dropped on a data property it is refused: it does not become “has data property” to fit');
  ok((await turtle()) === before, 'and nothing changed');

  // Is an instance of: from an individual to a class.
  await selectRel('Parasite', 'Film');
  await take('to', centre(await boxOf('Documentary')));
  const can = await page.locator('.node.can-take .node-text').allTextContents();
  ok(can.length === 8 && !can.includes('Parasite'), 'a class membership can end on any class');
  await page.mouse.up();
  ok(/:Parasite a owl:NamedIndividual , :Documentary/.test(await turtle()) || /:Parasite a [^.]*:Documentary/.test(await turtle()), 'moved, the individual is an instance of the other class');
  await undo();
  await selectRel('Parasite', 'Film');
  await drop('from', centre(await boxOf('Actor')));
  ok(/“is an instance of” needs an individual at this end: “Actor” is a class\./.test(flat(await toast().innerText())) && !!(await relOf('Parasite', 'Film')), 'its start cannot be put on a class: that would make it a superclass');

  // Has data property: from a class to a data property.
  await selectRel('Film', 'Release date');
  await drop('from', centre(await boxOf('Award')));
  ok(!!(await relOf('Award', 'Release date')) && (await relOf('Award', 'Release date')).kind === 'property', 'a “has data property” can be given to another class');
  await undo();
  await selectRel('Film', 'Release date');
  await drop('to', centre(await boxOf('Genre')));
  ok(/“has data property” needs a data property at this end: “Genre” is a class\./.test(flat(await toast().innerText())), 'but its end stays on a data property');

  // The same statement is not made twice.
  await selectRel('Actor', 'Person');
  await drop('from', centre(await boxOf('Director')));
  ok(flat(await toast().innerText()) === 'It is already stated that “Director” is a kind of “Person”.' && (await turtle()) === before, 'an end is not moved to where the same thing is stated already');
}

// ---------------------------------------------------------------- the other views follow a reconnection
{
  const side = page.locator('.term-list');
  const line = (name) => side.locator('.tree-line', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) });
  ok((await line('Film').getAttribute('aria-expanded')) !== null && (await line('Award').getAttribute('aria-expanded')) === null, 'to begin with Film has a subclass in the hierarchy beside the graph, and Award has none');
  // Documentary becomes a kind of Award, and Parasite an instance of Documentary.
  await selectRel('Documentary', 'Film');
  await drop('to', centre(await boxOf('Award')));
  await selectRel('Parasite', 'Film');
  await drop('to', centre(await boxOf('Documentary')));
  ok((await line('Film').getAttribute('aria-expanded')) === null && (await line('Award').getAttribute('aria-expanded')) !== null, 'the class hierarchy beside the graph has Documentary under Award now, and no longer under Film');

  await tab('Entities');
  await page.locator('.view').getByRole('tab', { name: /^Classes/ }).click();
  const row = page.locator('.view tbody tr', { has: page.locator('input[value="Documentary"]') }).first();
  const supers = flat(await row.locator('.supers, .cell-edit').first().innerText());
  ok(/Award/.test(supers) && !/Film/.test(supers), `Entities lists Award as the asserted superclass of Documentary (${supers})`);

  await tab('Structure');
  await page.waitForFunction(() => document.querySelector('.view.structure .tree')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.view.structure .st-wait'));
  const tree = await page.locator('.view.structure .tree-row').evaluateAll((rows) => rows.map((r) => `${'  '.repeat(Number(r.getAttribute('aria-level')) - 1)}${r.querySelector('.tree-name')?.textContent ?? 'owl:Thing'}`).join('\n'));
  ok(/\n {2}Award\n {4}Documentary/.test(tree) && !/\n {2}Film\n {4}Documentary/.test(tree), 'the Structure Explorer has Documentary under Award');

  // What the reasoner works out is worked out from the ontology as it now is.
  await tab('Graph');
  const tool = page.locator('.inferred-toggle');
  await tool.click();
  await page.waitForFunction(() => document.querySelectorAll('.edge.inferred').length > 0);
  const because = flat(await page.locator('.edge.inferred title').first().textContent());
  ok((await page.locator('.edge.inferred').count()) === 1 && /Award/.test(because), `the reasoner now infers that Parasite is an instance of Award (${because})`);
  await tool.click();

  // A circular hierarchy made by two reconnections is said at once, and found by the validation when it is run again.
  await selectRel('Director', 'Person');
  await drop('to', centre(await boxOf('Actor')));
  await selectRel('Actor', 'Person');
  await drop('to', centre(await boxOf('Director')));
  ok(/each other's superclass\. Validation lists this as a circular hierarchy\./.test(flat(await toast().innerText())) && !!(await relOf('Actor', 'Director')), 'a reconnection that closes a ring in the hierarchy is allowed, as adding a superclass allows it, and said');
  await tab('Validation');
  const v = page.locator('.validation');
  await v.getByRole('button', { name: 'Run all checks', exact: true }).click();
  await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
  const found = (await v.locator('tr.result').allInnerTexts()).map(flat).filter((t) => /Subclass cycle/.test(t));
  ok(found.length === 1 && /Director, Actor|Actor, Director/.test(found[0]), 'the validation, run again, reports the ring: ' + (found[0] ?? 'nothing found'));
  await tab('Graph');
  for (let i = 0; i < 4; i++) await undo();
  ok((await turtle()) === before, 'four undos later the ontology is what it was');
}

// ---------------------------------------------------------------- what is worked out has no ends to move
{
  const tool = page.locator('.inferred-toggle');
  if (await tool.count()) {
    await tool.click();
    await page.waitForTimeout(150);
    const inferred = page.locator('.edge.inferred');
    if (await inferred.count()) {
      const at = await inferred.first().locator('.edge-line').evaluate((path) => {
        const p = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM());
        return { x: p.x, y: p.y };
      });
      await page.mouse.click(at.x, at.y);
      ok((await page.locator('.end-handle').count()) === 0, 'an inferred relationship has no handles: there is nothing stored to reconnect');
    } else ok(true, 'no inferred relationship is drawn in this model');
    await tool.click();
  }
}

// ---------------------------------------------------------------- kept in the browser, and in a subgraph
await select('directs some');
{
  const d = await boxOf('Director');
  await drop('from', { x: d.x + d.width * 0.75, y: d.y - 8 });
  const pin = Object.values(await anchors())[0];
  ok(pin.from.side === 'top', 'an end is put on the top of its term');
  const line = await lineOf('directs some');
  await page.reload();
  await page.waitForSelector('.node');
  ok((await lineOf('directs some')) === line && JSON.stringify(Object.values(await anchors())[0]) === JSON.stringify(pin), 'after a reload the line is drawn from the same place');
  await node('Director').click({ button: 'right' });
  await menuItem('Show as a subgraph').click();
  await page.waitForFunction(() => document.querySelectorAll('.node').length > 0 && document.querySelectorAll('.node').length < 11);
  await page.waitForTimeout(500);
  const [a] = await endsOf('directs some');
  const sub = await boxOf('Director');
  ok(Math.abs(a.y - sub.y) < 8 && Math.abs(a.x - (sub.x + sub.width * 0.75)) < 8, 'in a subgraph the same relationship leaves its term at the same place');
  await select('directs some');
  ok((await page.locator('.end-handle.set').count()) === 1, 'and its ends can be taken hold of there too');
  const others = await page.locator('.node .node-text').allTextContents();
  const target = others.find((n) => n === 'Person') ?? others.find((n) => !['Director', 'Film'].includes(n) && !n.includes(':'));
  await drop('to', centre(await boxOf(target)));
  ok(!!(await relOf('Director', target)), `a relationship is reconnected in a subgraph as in the full graph (to ${target})`);
  await undo();
  ok(!!(await relOf('Director', 'Film')), 'and undone');
}

// ---------------------------------------------------------------- the picture, and the page that is exported
{
  // Back in the full graph, with one end put by hand on each of two lines, one of them on a side that faces away.
  await page.locator('.subgraph').getByRole('button', { name: 'Full graph' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.node').length === 11);
  await page.waitForTimeout(400);
  await select('produces some');
  const studio = await boxOf('Studio');
  await drop('from', { x: studio.x - 8, y: studio.y + studio.height * 0.5 });
  ok((await page.locator('#graph-svg .end-handle').count()) === 2 && (await page.locator('#graph-svg [data-noexport] .end-dot, #graph-svg .end-handle[data-noexport]').count()) >= 2, 'the handles are marked as no part of the picture');
  const check = async (how) => {
    await page.getByLabel('Edge routing').selectOption(how);
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'File', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Interactive page/ }).click()]);
    const file = shots + `pinned-${how}.html`;
    await download.saveAs(file);
    const html = fs.readFileSync(file, 'utf8');
    const out = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    out.on('pageerror', (e) => errors.push('EXPORTED PAGE ' + e.message));
    await out.goto('file://' + file);
    const lineIn = (label) => out.locator('#graph [data-rel]', { has: out.locator('text', { hasText: new RegExp('^' + label + '$') }) }).locator('[data-part="line"]').getAttribute('d');
    const exported = { produces: await lineIn('produces some'), directs: await lineIn('directs some') };
    const close = (a, b, by = 0.35) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= by);
    let same = !html.includes('end-handle') && exported.produces === (await lineOf('produces some'));
    for (const [term, label] of [['Studio', 'produces'], ['Director', 'directs']]) {
      await out.locator('#nav .item', { hasText: new RegExp('^' + term + '$') }).click();
      await out.keyboard.press('Shift+ArrowRight');
      const stepped = await lineIn(label + ' some');
      await out.keyboard.press('Shift+ArrowLeft');
      same &&= stepped !== exported[label] && close(nums(await lineIn(label + ' some')), nums(exported[label]));
    }
    ok(same, `${how}: the exported page has the picture without its handles, and when a term is moved there it draws the line from the same place on the term, as the app does`);
    await out.close();
  };
  await page.locator('.subgraph').getByRole('button', { name: 'Layout options' }).click();
  await check('direct');
  await check('curved');
  await check('orthogonal');
  await page.locator('.subgraph').getByRole('button', { name: 'Hide layout options' }).click();
}

await page.screenshot({ path: shots + 'edge-endpoints.png' });

// ---------------------------------------------------------------- what is another ontology's, or kept as a mapping
{
  // The model with a class of another ontology in it, and Person stated to be a kind of that class: a mapping.
  const m = await kept();
  const person = m.terms.find((t) => t.name === 'Person');
  const actor = m.relations.find((r) => r.kind === 'generalization' && r.to === person.id);
  m.externals = [{ id: 'org', name: 'Organization Ontology', iri: 'http://example.org/org', namespace: 'http://example.org/org#', source: 'org.ttl', sourceKind: 'file', addedAt: 1, classes: 1, objectProperties: 0, dataProperties: 0, individuals: 0 }];
  m.terms.push({ ...person, id: 'ext-agent', name: 'Agent', iri: 'http://example.org/org#Agent', external: 'org', x: person.x + 40, y: person.y - 170, description: '', color: '' });
  m.relations.push({ ...actor, id: 'map-1', from: person.id, to: 'ext-agent' });
  m.style.anchors = {};
  await page.locator('.header input[type=file]').setInputFiles({ name: 'with-mapping.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(m)) });
  await page.waitForFunction(() => [...document.querySelectorAll('.node .node-text')].some((t) => t.textContent === 'Agent'));
  await page.locator('.zoom').getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(300);
  const ttl = await turtle();
  await page.locator('[data-rel="map-1"] .edge-line').dispatchEvent('pointerdown', { button: 0 });
  await page.waitForSelector('.end-handle');
  ok((await page.locator('.end-handle').count()) === 2, 'a mapping to another ontology shows its ends like any relationship');
  await take('to', centre(await boxOf('Award')));
  const why = flat(await page.locator('.reconnect-why').innerText());
  ok((await page.locator('.node.can-take').count()) === 0 && (await page.locator('.node.cannot-take').count()) === 12 && /^This is a mapping to another ontology \(Person rdfs:subClassOf Agent\)\. Mappings are kept under Align/.test(why), 'but no term will take them, and why is said: ' + why);
  await page.mouse.up();
  ok(/Mappings are kept under Align/.test(flat(await toast().innerText())) && (await turtle()) === ttl, 'let go on a term, it is refused and nothing changes');
  // Where it meets its terms is still the picture's.
  await page.locator('[data-rel="map-1"] .edge-line').dispatchEvent('pointerdown', { button: 0 });
  await page.waitForSelector('.end-handle');
  const agent = await boxOf('Agent');
  await drop('to', { x: agent.x + agent.width + 8, y: agent.y + agent.height * 0.5 });
  ok((await page.locator('.end-handle.set').count()) === 1 && (await anchors())['map-1'].to.side === 'right' && (await turtle()) === ttl, 'where its line meets its terms can still be changed, which says nothing');
}

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
