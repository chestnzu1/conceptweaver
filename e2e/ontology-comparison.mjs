// Drives the built app in a headless browser to check what differs between two versions of an
// ontology, and between two ontologies (roadmap task 2.10, FR-M6-6): two versions differing by one
// renamed class, one moved class and one removed restriction show exactly those three changes,
// grouped by entity, each told as one line; and a model saved in My Models can be compared with a
// version, chosen from the same list.
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
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const side = page.locator('.term-list');
const panel = page.locator('.inspector');
const dialog = page.locator('.dialog.versions');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const chips = async (label) => (await field(label).locator('.chip-x > .link').allInnerTexts()).map(flat);
const pick = async (name) => {
  await side.locator('.tree-line .label, .flat-list button, li button', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click();
  await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name);
};
const openVersions = async () => {
  await page.locator('.header').getByRole('button', { name: /^File/ }).click();
  await page.getByRole('menuitem', { name: /^Versions…/ }).click();
  await dialog.waitFor();
};
const saveVersion = async (name, summary) => {
  await page.waitForFunction(() => {
    const list = document.querySelector('.dialog.versions .version-list');
    return list !== null && !list.textContent.trim().startsWith('Reading the versions');
  });
  await dialog.getByLabel('Name of the version').fill(name);
  await dialog.getByLabel('What the version is').fill(summary);
  const before = await dialog.locator('.version').count();
  await dialog.getByRole('button', { name: 'Save a version' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.dialog.versions .version').length === n, before + 1);
};
const compare = async (from, to) => {
  await dialog.getByLabel('Compare from').selectOption({ label: from });
  await dialog.getByLabel('Compare with').selectOption({ label: to });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
};
const rowFor = (suffix) => dialog.locator(`.diff-entities > li[data-entity$="${suffix}"]`);
const linesOf = async (suffix) => (await rowFor(suffix).locator(':scope > ul > li').allInnerTexts()).map(flat);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- two restrictions on one relationship
// Film is restricted by "wins some Award". A second restriction on the same relationship keeps the
// relationship (and so the property's domain and range) in place when one of the two is taken away.
await tab('Entities');
await pick('Film');
const restrictionRows = panel.locator('ul.restrictions').first().locator('li');
// The rows that restrict by wins, and how each reads: property, quantifier, filler.
const winsRows = () => restrictionRows.filter({ has: page.locator('button.link', { hasText: /^wins$/ }) });
const restrictionText = async (r) => `${flat(await r.locator('button.link').innerText())} ${await r.getByLabel('Quantifier').inputValue()} ${flat(await r.locator('span.quant + span').innerText())}`;
const winsSaid = async () => {
  const all = winsRows();
  const out = [];
  for (let i = 0; i < (await all.count()); i++) out.push(await restrictionText(all.nth(i)));
  return out.join(' | ');
};
ok((await winsRows().count()) === 1 && (await winsSaid()) === 'wins some Award', 'Film begins with one restriction on wins: ' + (await winsSaid()));
await panel.getByLabel('Property to restrict by').focus();
await panel.getByLabel('Property to restrict by').locator('option', { hasText: 'wins' }).first().waitFor({ state: 'attached' });
await panel.getByLabel('Property to restrict by').selectOption({ label: 'wins' });
await panel.getByLabel('Class it points to').focus();
await panel.getByLabel('Class it points to').locator('option', { hasText: 'Award' }).first().waitFor({ state: 'attached' });
await panel.getByLabel('Class it points to').selectOption({ label: 'Award' });
await panel.locator('.restriction-add').getByRole('button', { name: 'Add' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.inspector ul.restrictions')[0].querySelectorAll('li')].filter((li) => li.querySelector('button.link')?.textContent === 'wins').length === 2);
ok((await winsRows().count()) === 2 && (await winsSaid()) === 'wins some Award | wins only Award', 'a second restriction joins the same relationship: ' + (await winsSaid()));

// ---------------------------------------------------------------- a version to compare with
await openVersions();
await dialog.getByRole('button', { name: 'Save to My Models…' }).click();
await page.locator('.dialog.saveas input').fill('Compare films');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await openVersions();
await dialog.getByText(/^No versions yet/).waitFor();
await saveVersion('Before', 'One renamed, one moved, one restriction gone');
await dialog.getByRole('button', { name: 'Close' }).click();

// ---------------------------------------------------------------- three changes, of three entities
// One class is given another name.
const row = (name) => page.locator('.view tbody tr', { has: page.locator(`input[value="${name}"]`) });
const nameBox = await row('Genre').getByLabel('Name').elementHandle();
await nameBox.fill('Category');
await nameBox.press('Enter');
await page.waitForFunction(() => !!document.querySelector('.view tbody input[value="Category"]'));
// One class is moved under another superclass.
await side.getByRole('button', { name: 'Expand all' }).click();
await pick('Documentary');
const supers = field('Asserted superclasses');
await supers.locator('.chip-add').click();
await supers.getByRole('combobox').fill('Award');
await supers.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await supers.getByRole('button', { name: 'Remove superclass Film' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Remove superclass Film"]') === null);
ok((await chips('Asserted superclasses')).join() === 'Award', 'Documentary is now under Award, and Film is no longer a superclass of it');
// One restriction is taken away from a class, leaving the relationship and the other restriction.
await pick('Film');
await winsRows().first().getByRole('button', { name: /^Remove/ }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.inspector ul.restrictions')[0].querySelectorAll('li')].filter((li) => li.querySelector('button.link')?.textContent === 'wins').length === 1);
ok((await winsSaid()) === 'wins only Award', 'Film no longer has to win an Award, and the relationship still says it must only win one');

// ---------------------------------------------------------------- the two versions compared
await openVersions();
await compare('Version 1: Before', 'The model now');
await rowFor('#Genre').waitFor();
const rows = dialog.locator('.diff-entities > li[data-entity]');
ok((await rows.count()) === 3, 'exactly the three entities that changed are listed: ' + (await rows.count()));
ok((await rows.evaluateAll((lis) => lis.map((li) => li.querySelectorAll(':scope > ul > li').length))).join() === '1,1,1', 'and each of them with exactly one line');
ok(flat(await rowFor('#Genre').locator('.diff-head').innerText()) === 'Category class changed', 'the renamed class is listed under its new name');
ok((await linesOf('#Genre')).join(' | ') === '~ renamed from “Genre” to “Category”', 'a class given another name is told as a rename, not as a label taken away and another added: ' + (await linesOf('#Genre')).join(' | '));
ok((await linesOf('#Documentary')).join(' | ') === '~ no longer under Film; now under Award', 'a class put under another superclass is told as a move, not as two subclass statements: ' + (await linesOf('#Documentary')).join(' | '));
ok((await linesOf('#Film')).join(' | ') === '− Film SubClassOf wins some Award', 'and a restriction taken away is told as one line: ' + (await linesOf('#Film')).join(' | '));
ok(flat(await dialog.locator('.difference > p.muted').innerText()) === '3 entities changed, 1 renamed, 1 moved · 2 axioms added, 3 removed', 'the summary counts the entities, the renames and the moves, and every statement: ' + flat(await dialog.locator('.difference > p.muted').innerText()));
await page.screenshot({ path: shots + 'ontology-comparison.png' });

// ---------------------------------------------------------------- two ontologies
// My Models holds the model as it was saved, before these edits; its copy is another ontology.
await dialog.getByRole('button', { name: 'Close' }).click();
await page.locator('.header').getByRole('button', { name: /^File/ }).click();
await page.getByRole('menuitem', { name: /^My Models…/ }).click();
const library = page.locator('.dialog.library');
await library.locator('.library-list tbody tr').first().waitFor();
await library.locator('tbody tr').filter({ hasText: 'Compare films' }).first().getByRole('button', { name: 'Duplicate' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.dialog.library tbody tr')].some((r) => r.textContent.includes('Compare films copy')));
await library.getByRole('button', { name: 'Close', exact: true }).click();

await openVersions();
await page.waitForFunction(() => {
  const list = document.querySelector('.dialog.versions .version-list');
  return list !== null && !list.textContent.trim().startsWith('Reading the versions');
});
const offered = (await dialog.getByLabel('Compare with').locator('optgroup[label="My Models"] option').allInnerTexts()).map(flat);
ok(offered.includes('Compare films') && offered.includes('Compare films copy'), 'the models of My Models are offered beside the versions to compare with: ' + offered.join(' | '));
await compare('Version 1: Before', 'Compare films copy');
await page.waitForFunction(() => /Compare films copy/.test(document.querySelector('.dialog.versions .difference h3')?.textContent ?? ''));
ok(flat(await dialog.locator('.difference h3').innerText()) === 'From version 1 to the model “Compare films copy”', 'a version can be compared with a saved model: ' + flat(await dialog.locator('.difference h3').innerText()));
const one = dialog.locator('.diff-entities > li[data-entity=""]');
await one.waitFor();
const its = (await one.locator(':scope > ul > li').allInnerTexts()).map(flat);
ok((await dialog.locator('.diff-entities > li[data-entity]').count()) === 1 && its.join(' | ') === '~ renamed from “Compare films” to “Compare films copy”', 'the copy differs from it in its own name alone, and that is told as a rename: ' + its.join(' | '));
ok(flat(await dialog.locator('.difference > p.muted').innerText()) === '1 entity changed, 1 renamed · 1 axiom added, 1 removed', 'all of it a change to the ontology, and none of it the drawing');

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed || errors.length ? 1 : 0);
