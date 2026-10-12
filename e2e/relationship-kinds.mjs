// Drives the built app in a headless browser to check how an ontology works out what a
// relationship is: from what the line joins and what it is called, with no plain relationships.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const panel = page.locator('.inspector');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
const block = (ttl, subject) => flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '');
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const edges = () => page.locator('.edge').count();
const toast = async () => flat(await page.locator('.toast').innerText().catch(() => ''));
const editor = page.locator('.inline-editor');
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const kind = field('Kind').locator('select');
// The name of the selected line: the one text box of its panel.
const label = panel.locator('input').first();
const kinds = () => kind.locator('option').evaluateAll((os) => os.map((o) => o.textContent));
const chosen = async () => flat(await kind.locator('option:checked').innerText());
const properties = async () => flat(await page.locator('.term-list .chips').innerText());
// Drags the ⊕ handle of one term onto another. Says whether a name is then asked for.
const drag = async (from, to) => {
  await node(from).locator('.node-box').hover();
  const h = await node(from).locator('.handle-dot').boundingBox();
  const t = await node(to).locator('.node-box').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
  return (await editor.count()) > 0;
};
const name = async (text) => { await editor.fill(text); await page.keyboard.press('Enter'); };
const objectProperties = async () => { await tab('Entities'); await page.locator('.view').getByRole('tab', { name: /^Object properties/ }).click(); const n = flat(await page.locator('.view').getByRole('tab', { name: /^Object properties/ }).innerText()); await tab('Graph'); return Number(n.match(/\d+/)?.[0]); };

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
const before = await edges();
const declared = await objectProperties();

// ---------------------------------------------------------------- two classes: "is a", or an object property
ok(await drag('Studio', 'Person'), 'a line between two classes asks what it is called');
ok((await editor.inputValue()) === 'related to', 'starting from “related to”, the name it has until it is given one');
await name('Is A');
await page.locator('.edge.sel .edge-label-bg, .edge.sel .edge-line').first().click({ force: true }).catch(() => {});
ok((await chosen()) === 'Is a (generalization)' && (await kinds()).join(' | ') === 'Object property | Is a (generalization)', 'called “Is A”, it is “Is a (generalization)”; a plain relationship is not among the kinds: ' + (await kinds()).join(' | '));
let ttl = await turtle();
ok(/rdfs:subClassOf [^.]*:Person/.test(block(ttl, ':Studio')) && !/:isA\b|:is_a\b|rdf:Property/.test(ttl), 'it is written rdfs:subClassOf, from the subclass to the superclass, and no property was made of the words: ' + block(ttl, ':Studio').slice(-90));
ok((await objectProperties()) === declared, 'the name it started from left no object property behind');

ok(await drag('Studio', 'Award'), 'another line between two classes');
await name('sponsors');
ok((await chosen()) === 'Object property' && flat(await panel.locator('h2').first().innerText()).toLowerCase() === 'restriction', 'called anything else, it is a use of the object property of that name: ' + (await chosen()));
ttl = await turtle();
ok(block(ttl, ':sponsors').startsWith(':sponsors a owl:ObjectProperty') && block(ttl, ':Studio').includes('[ a owl:Restriction ; owl:onProperty :sponsors ; owl:someValuesFrom :Award ]') && !ttl.includes('rdf:Property'), 'the property is declared, and the class is restricted by it: OWL, not a triple from one class to the other');
ok((await objectProperties()) === declared + 1, 'a name that is new makes a new object property');
await drag('Director', 'Award');
await name('Wins');
ok((await objectProperties()) === declared + 1 && block(await turtle(), ':Director').includes('owl:onProperty :wins ; owl:someValuesFrom :Award'), 'a name that an object property has already is a use of that one, however it is capitalised');
await page.screenshot({ path: shots + 'relationship-kinds.png' });

// a new name changes what it is
const sponsors = page.locator('.edge', { has: page.locator('.edge-label', { hasText: /^sponsors some$/ }) });
await sponsors.locator('.edge-label-bg').click();
await label.fill('is a');
await label.press('Enter');
ok((await chosen()) === 'Is a (generalization)' && /rdfs:subClassOf [^.]*:Award/.test(block(await turtle(), ':Studio')) && !block(await turtle(), ':Studio').includes(':sponsors'), 'renamed “is a”, the same line is a superclass');
ok((await objectProperties()) === declared, 'and the object property that was there for it alone is gone with its name');
await label.fill('funds');
await label.press('Enter');
ok((await chosen()) === 'Object property' && block(await turtle(), ':Studio').includes('owl:onProperty :funds ; owl:someValuesFrom :Award'), 'renamed again, it is an object property again');
await kind.selectOption({ label: 'Is a (generalization)' });
await page.waitForFunction(() => document.querySelector('.inspector input')?.value === '');
ok((await label.inputValue()) === '' && (await chosen()) === 'Is a (generalization)', 'the kind can also be chosen, and then the name follows it: ' + JSON.stringify([await label.inputValue(), await chosen()]));
await page.getByRole('button', { name: 'Undo' }).click();

// ---------------------------------------------------------------- a class and a data property
let count = await edges();
ok(!(await drag('Studio', 'Release date : date')) && (await edges()) === count + 1, 'a line from a class to a data property asks for nothing');
ok((await chosen()) === 'Has data property' && (await kinds()).join() === 'Has data property' && (await kind.isDisabled()), 'it is “Has data property”, and there is nothing else to choose');
ok(await panel.getByRole('button', { name: 'Reverse direction' }).isDisabled(), 'nor can it be turned around');
ttl = await turtle();
ok(block(ttl, ':Studio').includes('[ a owl:Restriction ; owl:onProperty :releaseDate ; owl:someValuesFrom xsd:date ]') && /rdfs:domain \[ a owl:Class ; owl:unionOf \( :Film :Studio \) \]|rdfs:domain[^.]*:Studio/.test(block(ttl, ':releaseDate')) && !/hasDataProperty/i.test(ttl), 'the class is restricted by the property and is in its domain; no predicate of the app’s own is written');
count = await edges();
ok(!(await drag('Running time : integer', 'Award')) && (await edges()) === count + 1 && flat(await field('From').locator('select option:checked').innerText()) === 'Award', 'drawn from the data property, it is the same statement: the class has the property');

// ---------------------------------------------------------------- an individual and a data property
count = await edges();
ok(!(await drag('Parasite', 'Running time : integer')) && (await edges()) === count, 'a line from an individual to a data property is not made');
ok((await toast()) === '“Parasite” is an individual and “Running time” is a data property: the two are not joined by a line. An individual has a value for a data property. Open “Parasite” and add it under Data property assertions.', 'and the reason is given, with what to do instead: ' + (await toast()).slice(0, 60));
await drag('Release date : date', 'Parasite');
ok((await edges()) === count, 'nor the other way round');
// by moving the end of a line that is there
await page.locator('.edge.instance-of .edge-label-bg').first().click();
await field('To').locator('select').selectOption({ label: 'Running time' });
ok(flat(await field('To').locator('select option:checked').innerText()) === 'Film' && (await toast()).includes('the two are not joined by a line'), 'nor by moving the end of another line onto a data property');
// what an individual has for a data property is a value
await node('Parasite').locator('.node-box').click();
const values = panel.locator('[data-section="values"]');
await values.locator('.chip-add').click();
await values.getByRole('combobox').fill('Running time');
await values.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await values.getByLabel('Value', { exact: true }).fill('132');
await values.getByRole('button', { name: 'Add value' }).click();
ok(block(await turtle(), ':Parasite').includes(':runningTime 132') || block(await turtle(), ':Parasite').includes(':runningTime "132"^^xsd:integer'), 'the value is given in the editor of the individual, and written as a literal');

// ---------------------------------------------------------------- an individual and a class; two individuals
count = await edges();
ok(!(await drag('Genre', 'Parasite')) && (await edges()) === count + 1 && (await chosen()) === 'Is Instance Of' && (await kinds()).join() === 'Is Instance Of', 'a line between a class and an individual is a class membership, with nothing else to choose');
ok(block(await turtle(), ':Parasite').startsWith(':Parasite a owl:NamedIndividual , :Film , :Genre'), 'written rdf:type, from the individual');

// ---------------------------------------------------------------- relationships added in bulk
await page.getByRole('button', { name: 'Bulk add' }).click();
await page.getByRole('tab', { name: '2. Relationships' }).click();
await page.locator('.dialog textarea').fill('Genre | is a | Award\nGenre | rates | Film\nParasite | Running time');
await page.getByRole('button', { name: 'Add relationships' }).click();
ttl = await turtle();
ok(block(ttl, ':Genre').includes('rdfs:subClassOf :Award') && block(ttl, ':Genre').includes('owl:onProperty :rates ; owl:someValuesFrom :Film') && !ttl.includes('rdf:Property'), 'lines added in bulk become what their ends and names make them');

// ---------------------------------------------------------------- it is all still there after a reload
await page.waitForTimeout(900);
const saved = await turtle();
await page.reload();
await page.waitForSelector('.node');
ok((await turtle()) === saved, 'after a reload the model is as it was');

// ---------------------------------------------------------------- a vocabulary is as it was
await page.getByRole('button', { name: 'File', exact: true }).click();
await page.getByRole('menuitem', { name: /^Load the SKOS example/ }).click();
await page.waitForSelector('.node');
const [a, b] = (await page.locator('.node text').allTextContents()).map(flat).filter(Boolean);
count = await edges();
ok(await drag(a, b), 'in a vocabulary a line still asks for its label');
ok((await editor.inputValue()) === '', 'and starts without one');
await name('goes with');
ok((await edges()) === count + 1 && (await kinds()).join(' | ') === 'Relationship (plain) | Is a (broader)' && (await chosen()) === 'Relationship (plain)', 'a vocabulary still has plain relationships, and a labelled line is one: ' + (await kinds()).join(' | '));

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
