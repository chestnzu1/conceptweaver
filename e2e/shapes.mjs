// Drives the built app in a headless browser to check the Shapes view (roadmap stage SH-1): shape
// sets as constraint models of their own, beside the ontology; two sets with a different shape
// for one class, kept and exported apart; a shape edited as what is said of it, a path in SPARQL
// syntax, sh:or with a shape in place and a named one from the other set; the class's editor
// listing the shapes about it in every set; all of it kept across a reload and an undo, and
// validated together.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
// Dropdowns of terms fill in when the pointer reaches them, so hover before choosing.
{ const proto = Object.getPrototypeOf(page.locator('body')); const orig = proto.selectOption; proto.selectOption = async function (...a) { await this.hover(); return orig.apply(this, a); }; }
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const sv = page.locator('.view.shapes-view');
const ed = sv.locator('.shape-editor');
const tmp = fs.mkdtempSync('/tmp/cw-shapes-');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: true }).click();
const pick = async (name) => { await side.locator('.tree-line .label', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click(); await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name); };
const sets = () => sv.locator('.shape-sets li strong').allInnerTexts();
const openSet = (name) => sv.locator('.shape-sets li button', { has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) }).click();
const named = async (label, value) => { const f = sv.getByLabel(label); await f.fill(value); await f.press('Enter'); };
const preview = () => ed.locator('.shape-preview').first().textContent();
/** Picks in the picker of a scope: types and takes the first match. */
const choose = async (scope, text) => {
  await scope.locator('.chip-add').first().click();
  await scope.locator('input[type=search]').first().fill(text);
  await scope.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};
const addPropertyShape = async (text) => choose(ed.locator('.add-property').first(), text);
const constrain = (scope, what) => scope.locator(':scope > .row select').first().selectOption({ label: what });
const exportSet = async (name) => {
  const [file] = await Promise.all([page.waitForEvent('download'), sv.getByRole('button', { name: 'Export', exact: true }).click()]);
  await file.saveAs(`${tmp}/${name}.ttl`);
  return { name: file.suggestedFilename(), text: fs.readFileSync(`${tmp}/${name}.ttl`, 'utf8') };
};

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- shape sets
await tab('Shapes');
ok(flat(await sv.innerText()).includes('No shapes yet'), 'the Shapes view is a tab of its own, and says there are no shapes yet');
await sv.getByRole('button', { name: 'New shape set' }).click();
await named('Shape set name', 'Catalogue');
await named('What the shape set is for', 'The catalogue application');
await sv.getByRole('button', { name: 'New shape set' }).click();
await named('Shape set name', 'Archive');
ok((await sets()).join(' | ') === 'Catalogue | Archive', 'two shape sets, each named, one with what it is for: ' + (await sets()).join(' | '));

// ---------------------------------------------------------------- a shape for Film in each, made from the class and in the view
await pick('Film');
const about = panel.locator('[data-section=shapes]');
ok(flat(await about.innerText()).includes('No shape targets this class'), 'the class’s editor says no shape targets it yet');
await about.getByRole('button', { name: 'Add a shape for this class' }).click();
ok((await ed.getByLabel('Shape name').inputValue()) === 'Film' && flat(await sv.locator('.shape-sets li button.on').innerText()).startsWith('Archive'), 'added from the class, the shape is named after it, in the set open (Archive)');
await addPropertyShape('Running');
await constrain(ed.locator('.param-shape.property .shape-form.nested').first(), 'Max count (sh:maxCount)');
ok(/sh:path :runningTime ;\s+sh:maxCount 1/.test(await preview()), 'Archive: at most one running time');

await openSet('Catalogue');
await sv.getByRole('button', { name: 'New shape', exact: true }).click();
ok((await ed.getByLabel('Shape name').inputValue()) === 'Film' && /sh:targetClass :Film/.test(await preview()), 'Catalogue: a new shape starts from the class selected, Film');
const catalogueShape = /^(:FilmShape\S*)$/m.exec(await preview())?.[1];
ok(catalogueShape === ':FilmShape_2', 'with an IRI of its own, not that of Archive’s Film shape: ' + catalogueShape);
await addPropertyShape('Release');
const release = ed.locator('.param-shape.property .shape-form.nested').first();
await constrain(release, 'Min count (sh:minCount)');
ok(/sh:path :releaseDate ;\s+sh:minCount 1/.test(await preview()), 'Catalogue: a release date is required');

// ---------------------------------------------------------------- a path in SPARQL syntax
const path = release.getByLabel('Path');
await path.fill(':releaseDate | :runningTime');
await path.press('Enter');
ok((await preview()).includes('sh:path [ sh:alternativePath ( :releaseDate :runningTime ) ]'), 'a path is written as SPARQL writes it, and stored as the SHACL path it is');
await path.fill(':releaseDate / (');
await path.press('Enter');
ok(flat(await release.locator('[data-param=path] [role=alert]').innerText()) === 'The path ends where a property was expected.', 'a path that does not read says why, and is not taken');
await path.fill(':releaseDate');
await path.press('Enter');
ok(/sh:path :releaseDate ;/.test(await preview()) && (await release.locator('[data-param=path] [role=alert]').count()) === 0, 'and the path is back');

// ---------------------------------------------------------------- sh:or: a shape in place, and a named one from the other set
await constrain(ed.locator('.shape-form').first(), 'Or (sh:or)');
const or = ed.locator('[data-param=or]');
ok((await or.locator('.param-member').count()) === 2, 'sh:or starts with two shapes, each in place');
const first = or.locator('.param-member').nth(0).locator('.shape-form.nested').first();
await constrain(first, 'Class (sh:class)');
await choose(first.locator('.adding'), 'Documentary');
// The Film shape being edited is not offered inside itself; Archive's is, marked as of that set.
await or.locator('.param-member').nth(1).locator('.member-body > .picker .chip-add').click();
await or.locator('.param-member').nth(1).locator('.member-body > .picker input[type=search]').fill('Film');
const offered = (await or.locator('.param-member').nth(1).locator('.subgraph-found button').allInnerTexts()).map(flat);
ok(offered.length === 1 && offered[0].includes('Archive'), 'a named shape is chosen from every set, the shape being edited left out: ' + offered.join(' / '));
await or.locator('.param-member').nth(1).locator('.subgraph-found button').first().dispatchEvent('pointerdown');
const text = await preview();
ok(/sh:or \( \[\s+sh:class :Documentary\s+\] :FilmShape \)/.test(text), 'one alternative in place, the other Archive’s Film shape, by its IRI: ' + flat(text).slice(flat(text).indexOf('sh:or'), flat(text).indexOf('sh:or') + 80));
await page.screenshot({ path: shots + 'shapes.png' });

// ---------------------------------------------------------------- the class’s editor lists both, in their sets
await pick('Film');
const listed = (await about.locator('li').allInnerTexts()).map(flat);
ok(listed.length === 2 && listed.some((x) => x.includes('in “Catalogue”')) && listed.some((x) => x.includes('in “Archive”')), 'the class’s editor lists its shapes in every set: ' + listed.join(' / '));
await about.locator('li', { hasText: 'Archive' }).getByRole('button').click();
ok(flat(await sv.locator('.shape-sets li button.on').innerText()).startsWith('Archive') && (await ed.getByLabel('Shape name').inputValue()) === 'Film', 'and opens each where it is');

// ---------------------------------------------------------------- exported apart
const archive = await exportSet('archive');
await openSet('Catalogue');
const catalogue = await exportSet('catalogue');
ok(archive.name === 'film-knowledge-graph-archive.ttl' && archive.text.includes(':runningTime') && !archive.text.includes(':releaseDate'), 'each set exports as a file of its own: ' + archive.name);
ok(catalogue.text.includes(':releaseDate') && catalogue.text.includes('sh:or') && !catalogue.text.includes(':runningTime'), 'with its own shapes only');

// ---------------------------------------------------------------- kept across a reload and an undo
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node', { state: 'attached' });
await tab('Shapes');
ok((await sets()).join(' | ') === 'Catalogue | Archive', 'after a reload the sets are there');
await openSet('Catalogue');
await sv.locator('.shape-list li button', { hasText: 'Film' }).first().click();
ok((await preview()).includes('sh:or'), 'and their shapes, as they were');
await openSet('Archive');
await sv.getByRole('button', { name: 'Delete set' }).click();
ok((await sets()).join(' | ') === 'Catalogue', 'a set is deleted');
await page.getByRole('button', { name: 'Undo' }).click();
ok((await sets()).join(' | ') === 'Catalogue | Archive', 'and one undo brings it back, with its shape');
await page.getByRole('button', { name: 'Redo' }).click();
ok((await sets()).join(' | ') === 'Catalogue', 'redo deletes it again');
await page.getByRole('button', { name: 'Undo' }).click();
await openSet('Archive');
ok((await sv.locator('.shape-list li strong').allInnerTexts()).includes('Film'), 'its shape too');

// ---------------------------------------------------------------- validated together
await tab('Validation');
const v = page.locator('.validation');
await v.getByRole('button', { name: 'SHACL', exact: true }).click();
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
const card = flat(await v.locator('.card', { has: page.locator('h3', { hasText: 'SHACL validation' }) }).innerText());
ok(card.includes('Violations: 1'), 'the shapes of every set are validated: Parasite has no release date, as Catalogue requires: ' + card.slice(0, 120));
await v.locator('tr.result').first().click();
await v.locator('tr.detail').getByRole('button', { name: 'Open the shape' }).click();
ok((await ed.getByLabel('Shape name').inputValue()) === 'Film' && flat(await sv.locator('.shape-sets li button.on').innerText()).startsWith('Catalogue'), 'a finding opens its shape, in its set');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
