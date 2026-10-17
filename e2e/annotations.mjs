// Drives the built app in a headless browser to check annotation properties as entities of their
// own — declared, listed, arranged under one another, with a domain and a range, and used by an
// entity — and labels in several languages with a display language for the whole interface.
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
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const view = page.locator('.view');
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const kindTab = (name) => view.getByRole('tab', { name: new RegExp('^' + name) }).click();
const row = (name) => view.locator('tbody tr', { has: page.locator(`input[value="${name}"]`) });
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const chips = async (label) => (await field(label).locator('.chip-x > .link').allInnerTexts()).map(flat);
const add = async (label, text) => {
  const f = field(label);
  await f.locator('.chip-add').click();
  await f.getByRole('combobox').fill(text);
  await f.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};
const block = (ttl, subject) => flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '');
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Entities'); return ttl; };
const dialog = page.locator('.xe-dialog');
const writeIn = async (text) => {
  await dialog.getByRole('tab', { name: 'Manchester syntax' }).click();
  const cm = dialog.locator('.cm-content');
  await cm.waitFor();
  await cm.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
};
const pick = async (name) => {
  await side.locator('.tree-line .label, .flat-list button, li button', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click();
  await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name);
};

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
await side.getByRole('button', { name: 'Expand all' }).click();

// ---------------------------------------------------------------- declared and listed
await tab('Entities');
await kindTab('Annotation properties');
ok((await view.locator('tbody tr').count()) === 0, 'an ontology with no annotation properties of its own lists none');
await view.getByRole('button', { name: 'Add annotation property' }).click();
await panel.locator('input').first().fill('source note');
await panel.locator('input').first().blur();
ok(flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'annotation property', 'the new one opens as an entity of its own, with an editor');
ok((await view.locator('tbody tr').count()) === 1 && (await view.locator('tbody tr input[value="source note"]').count()) === 1, 'and is listed among the annotation properties');
ok(flat(await panel.locator('.iri-parts').innerText()).includes(':sourceNote'), 'with an IRI made from its name: ' + flat(await panel.locator('.iri-parts').innerText()));

// ---------------------------------------------------------------- arranged under another
await view.getByRole('button', { name: 'Add annotation property' }).click();
await panel.locator('input').first().fill('provenance note');
await panel.locator('input').first().blur();
await add('Superproperties', 'source note');
ok((await chips('Superproperties')).join() === 'source note', 'one annotation property is arranged under another (rdfs:subPropertyOf)');
await row('source note').locator('td').first().click();
ok(flat(await field('Superproperties').locator(':scope > small').innerText()).includes('Specialised by provenance note'), 'the superproperty says what specialises it');
ok(flat(await view.locator('tbody tr', { has: page.locator('input[value="provenance note"]') }).locator('td').nth(2).innerText()) === 'source note', 'and the list shows it under its superproperty');

// ---------------------------------------------------------------- what it may annotate, and with what
const domain = panel.locator('.axioms[data-which=domain]');
await domain.getByRole('button', { name: 'Add a domain axiom' }).click();
await writeIn('Film');
await dialog.getByRole('button', { name: 'Add', exact: true }).click();
ok(flat(await domain.locator('code.axiom').first().innerText()) === 'Film', 'an annotation property has a domain: what it may annotate');
const range = panel.locator('.axioms[data-which=range]');
await range.getByRole('button', { name: 'Add a range axiom' }).click();
await writeIn('Award');
await dialog.getByRole('button', { name: 'Add', exact: true }).click();
ok(flat(await range.locator('code.axiom').first().innerText()) === 'Award', 'and a range: what its values may be');

let ttl = await turtle();
ok(block(ttl, ':sourceNote').includes('a owl:AnnotationProperty') && block(ttl, ':sourceNote').includes('rdfs:domain :Film') && block(ttl, ':sourceNote').includes('rdfs:range :Award'), 'both are written as RDF: ' + block(ttl, ':sourceNote'));
ok(block(ttl, ':provenanceNote').includes('rdfs:subPropertyOf :sourceNote'), 'so is the superproperty: ' + block(ttl, ':provenanceNote'));

// ---------------------------------------------------------------- used as an annotation
await kindTab('Classes');
await pick('Film');
await panel.getByRole('button', { name: 'Add field' }).click();
await panel.getByLabel('Property', { exact: true }).fill('provenance note');
await panel.getByLabel('Value', { exact: true }).fill('From the archive');
await panel.getByRole('button', { name: 'Confirm' }).click();
ok((await panel.locator('.meta-row .meta-key', { hasText: 'provenance note' }).count()) === 1, 'an entity carries an annotation with it');
ttl = await turtle();
ok(block(ttl, ':Film').includes(':provenanceNote "From the archive"'), 'written with the property of the model: ' + block(ttl, ':Film'));
await kindTab('Annotation properties');
ok(flat(await row('provenance note').locator('td.num').innerText()) === '1', 'the list counts the annotation it makes');
await row('provenance note').locator('td').first().click();
ok((await panel.locator('.rel-list li').count()) === 1 && flat(await panel.locator('.rel-list li').innerText()).includes('Film'), 'and the editor says who uses it, with a way to open them');

// ---------------------------------------------------------------- names in several languages
await kindTab('Classes');
await pick('Film');
await panel.getByRole('button', { name: 'Add field' }).click();
await panel.getByLabel('Property', { exact: true }).fill('rdfs:label');
await panel.getByLabel('Value', { exact: true }).fill('Filmwerk');
await panel.getByLabel('Language', { exact: true }).fill('de');
await panel.getByRole('button', { name: 'Confirm' }).click();
// A second language is what makes a choice of display language meaningful.
await panel.getByRole('button', { name: 'Add field' }).click();
await panel.getByLabel('Property', { exact: true }).fill('rdfs:label');
await panel.getByLabel('Value', { exact: true }).fill('Film');
await panel.getByLabel('Language', { exact: true }).fill('en');
await panel.getByRole('button', { name: 'Confirm' }).click();
const lang = page.locator('.header').getByLabel('Display language');
await lang.waitFor();
ok((await lang.count()) === 1, 'with a name in another language, the header offers a display language');
await lang.selectOption('de');
await page.waitForFunction(() => [...document.querySelectorAll('.view tbody input')].some((i) => i.value === 'Filmwerk'));
ok((await row('Filmwerk').count()) === 1, 'the list is named in the language chosen');
await page.waitForFunction(() => [...document.querySelectorAll('.term-list .name')].some((n) => n.textContent?.trim() === 'Filmwerk'));
ok((await side.locator('.name', { hasText: /^Filmwerk$/ }).count()) >= 1, 'so is the tree beside the canvas');
ok(flat(await field('Name').locator(':scope > small').innerText()).includes('“Filmwerk” in de'), 'the editor says the name it shows in that language, and which name it edits');
await lang.selectOption('');
await page.waitForFunction(() => [...document.querySelectorAll('.view tbody input')].some((i) => i.value === 'Film'));
ok((await row('Film').count()) === 1, 'back to the model language, the name is as it was');
await lang.selectOption('de');
await page.waitForFunction(() => [...document.querySelectorAll('.view tbody input')].some((i) => i.value === 'Filmwerk'));
await tab('Graph');
await page.waitForFunction(() => [...document.querySelectorAll('.node-text')].some((n) => n.textContent?.trim() === 'Filmwerk'));
ok((await page.locator('.node-text', { hasText: /^Filmwerk$/ }).count()) >= 1, 'and the node on the canvas');
await tab('Entities');
await page.screenshot({ path: shots + 'annotations-display-language.png' });

// ---------------------------------------------------------------- kept
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await tab('Entities');
await kindTab('Annotation properties');
await page.waitForFunction(() => document.querySelectorAll('.view tbody tr').length === 2);
ok((await view.locator('tbody tr').count()) === 2, 'after a reload the annotation properties are there');
ok(flat(await row('provenance note').locator('td').nth(2).innerText()) === 'source note', 'with what stands above them');
ok((await page.locator('.header').getByLabel('Display language').inputValue()) === 'de', 'and the display language is remembered');
await kindTab('Classes');
await page.waitForFunction(() => [...document.querySelectorAll('.view tbody input')].some((i) => i.value === 'Filmwerk'));
ok((await row('Filmwerk').count()) === 1, 'so the class is still named in it');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
