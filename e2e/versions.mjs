// Drives the built app in a headless browser to check named versions and what changed between
// them (roadmap task 2.3, FR-M10-1 to FR-M10-3): versions kept for a model in My Models; saved
// with a name and a line, newest first; a term moved shows no change to the ontology; a
// superclass added and a restriction removed show as exactly two changes under the class;
// restoring makes a new version that undo takes back, and no version goes; all of it kept across
// a reload.
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
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const dialog = page.locator('.dialog.versions');
const pick = async (name) => { await side.locator('.tree-line .label', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click(); await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name); };
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const openVersions = async () => {
  await page.locator('.header').getByRole('button', { name: /^File/ }).click();
  await page.getByRole('menuitem', { name: /^Versions…/ }).click();
  await dialog.waitFor();
};
const listed = async () => (await dialog.locator('.version').allInnerTexts()).map(flat);
const saveVersion = async (name, summary) => {
  // Counting the list before the read that opening the dialog began has answered would wait for
  // the wrong number of versions.
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
const film = async () => (await dialog.locator('.difference li[data-entity$="#Film"] li').allInnerTexts()).map(flat);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- kept for a model in My Models
await openVersions();
ok(flat(await dialog.innerText()).includes('Versions are kept for a model in My Models'), 'a model not in My Models is asked to be saved there first');
await dialog.getByRole('button', { name: 'Save to My Models…' }).click();
await page.locator('.dialog.saveas input').fill('Versioned films');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await openVersions();
await dialog.getByText(/^No versions yet/).waitFor();
ok(flat(await dialog.innerText()).includes('No versions yet'), 'once saved, it has versions, none yet');

// ---------------------------------------------------------------- saved, newest first
await saveVersion('First', 'As it began');
await dialog.getByRole('button', { name: 'Close' }).click();

// A term moved on the canvas is no change to the ontology.
const box = await page.locator('.node', { has: page.locator('text', { hasText: /^Studio/ }) }).first().locator('.node-box').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + 160, box.y + 90, { steps: 6 });
await page.mouse.up();
await openVersions();
await dialog.locator('.version', { hasText: 'First' }).getByRole('button', { name: 'Compare with now' }).click();
await dialog.locator('.difference').waitFor();
ok(flat(await dialog.locator('.difference .nothing').innerText()) === 'No changes to the ontology. Only where terms sit, or how the graph is drawn, changed.', 'a term moved on the canvas shows no change to the ontology');
await dialog.getByRole('button', { name: 'Close' }).click();

// One superclass added, one restriction taken away: two changes, under Film.
await pick('Film');
const supers = field('Asserted superclasses');
await supers.locator('.chip-add').click();
await supers.getByRole('combobox').fill('Award');
await supers.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await page.locator('.edge', { has: page.locator('.edge-label', { hasText: /^wins/ }) }).first().locator('.edge-label-bg').click();
await page.keyboard.press('Delete');
await openVersions();
await saveVersion('Second', 'Film is an Award, and wins nothing');
ok((await listed())[0].startsWith('2 Second') && (await listed())[1].startsWith('1 First') && (await listed())[1].includes('As it began'), 'versions are listed newest first, each with its line: ' + (await listed()).join(' / '));
await dialog.getByLabel('Compare from').selectOption({ label: 'Version 1: First' });
await dialog.getByLabel('Compare with').selectOption({ label: 'Version 2: Second' });
await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
await dialog.locator('.difference li[data-entity$="#Film"]').waitFor();
ok(JSON.stringify(await film()) === JSON.stringify(['+ Film SubClassOf Award', '− Film SubClassOf wins some Award']), 'a superclass added and a restriction removed are exactly two changes under Film: ' + (await film()).join(' / '));
ok(flat(await dialog.locator('.difference h3').innerText()) === 'From version 1 to version 2', 'between the two versions chosen');
await page.screenshot({ path: shots + 'versions.png' });

// ---------------------------------------------------------------- restored as a new version
await dialog.locator('.version', { hasText: 'First' }).getByRole('button', { name: 'Restore…' }).click();
await page.waitForFunction(() => document.querySelectorAll('.dialog.versions .version').length === 3);
ok((await listed())[0].startsWith('3 Restored version 1') && (await listed()).length === 3, 'restoring version 1 of 2 makes version 3, and takes none away: ' + (await listed())[0]);
await dialog.locator('.version', { hasText: 'Restored version 1' }).getByRole('button', { name: 'Compare with now' }).click();
await dialog.locator('.difference .nothing').waitFor();
await dialog.getByLabel('Compare from').selectOption({ label: 'Version 1: First' });
await dialog.getByLabel('Compare with').selectOption({ label: 'Version 3: Restored version 1' });
await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
await dialog.locator('.difference .nothing').waitFor();
ok(flat(await dialog.locator('.difference .nothing').innerText()).startsWith('No changes to the ontology'), 'and version 3 is version 1');
await dialog.getByRole('button', { name: 'Close' }).click();
await pick('Film');
ok((await field('Asserted superclasses').locator('.chip-x > .link').count()) === 0, 'the model is what it was: Film has no superclass');
await page.getByRole('button', { name: 'Undo' }).click();
// Film is under Award again, folded away in the class tree.
await side.getByRole('button', { name: 'Expand all' }).click();
await pick('Film');
ok((await field('Asserted superclasses').locator('.chip-x > .link').allInnerTexts()).join() === 'Award', 'and one undo takes the restoring back');

// ---------------------------------------------------------------- kept across a reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await openVersions();
await page.waitForFunction(() => document.querySelectorAll('.dialog.versions .version').length === 3);
ok((await listed()).map((x) => x.split(' ').slice(0, 2).join(' ')).join(' | ') === '3 Restored | 2 Second | 1 First', 'after a reload the versions are there');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
