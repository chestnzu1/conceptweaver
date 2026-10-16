// Drives the built app in a headless browser to check importing a table (roadmap task 2.4,
// FR-M7-2 to FR-M7-5): a 2,000-row CSV with parent references becomes the hierarchy it says, the
// row whose parent is missing reported with its row number and nothing made of it; the preview
// before anything is made; one undo for the whole import; an Excel sheet as individuals of a
// class, with values converted and what cannot be said; a mapping kept as a template and used
// again; and the same file imported again making nothing, and saying so.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const workbook = new URL('../src/import/fixtures/films.xlsx', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tmp = fs.mkdtempSync('/tmp/cw-import-');
const dialog = page.locator('.dialog.import-table');
const classes = async () => Number(/Classes (\d+)/.exec(await page.locator('.term-list').innerText())?.[1] ?? -1);
const open = async (file) => {
  await page.locator('.header').getByRole('button', { name: /^File/ }).click();
  await page.getByRole('menuitem', { name: /^Import a table…/ }).click();
  await dialog.waitFor();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dialog.getByRole('button', { name: /file…$/ }).click()]);
  await chooser.setFiles(file);
  await dialog.locator('.import-preview .counts').waitFor();
};
const counts = async () => flat(await dialog.locator('.import-preview .counts').innerText());

// 2,000 classes, each under the one whose code is half its own; one more row under a code no row has.
const lines = ['Code,Label,Parent,Definition'];
for (let i = 1; i <= 2000; i++) lines.push(`C${i},Class ${i},${i === 1 ? '' : `C${Math.floor(i / 2)}`},"The class number ${i}, as written"`);
lines.push('C2001,Orphan,C9999,Under nothing');
fs.writeFileSync(`${tmp}/classes.csv`, lines.join('\r\n'));

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
const before = await classes();

// ---------------------------------------------------------------- a 2,000-row hierarchy
await open(`${tmp}/classes.csv`);
ok((await dialog.getByLabel('IRI template').inputValue()) === 'http://example.org/film-knowledge-graph#{Code}', 'the IRI is made from the code column: ' + (await dialog.getByLabel('IRI template').inputValue()));
ok((await dialog.getByLabel('What Label becomes').inputValue()) === 'name' && (await dialog.getByLabel('What Parent becomes').inputValue()) === 'parent' && (await dialog.getByLabel('What Definition becomes').inputValue()) === 'description', 'the columns are given their uses by what they are called');
ok((await counts()) === '2000 to make · 0 already in the model · 1 skipped', 'the preview says what will be made, before anything is: ' + (await counts()));
await dialog.getByRole('button', { name: /^Skipped/ }).click();
const skipped = (await dialog.locator('.import-rows tr.import-row').allInnerTexts()).map(flat);
ok(skipped.length === 1 && skipped[0] === '2002 Orphan http://example.org/film-knowledge-graph#C2001 skipped Its Parent, “C9999”, is neither a row of the table nor a class of the model.', 'the row whose parent is missing is reported by its row number, with why: ' + skipped[0]);
ok(flat(await dialog.locator('.import-tree').innerText()).startsWith('As a hierarchy Class 1 Class 2 Class 4'), 'and the classes are shown as the hierarchy they will be');
await page.screenshot({ path: shots + 'import-table.png' });
await dialog.getByRole('button', { name: 'Import 2000' }).click();
await dialog.waitFor({ state: 'detached' });
ok((await classes()) === before + 2000, `2,000 classes are made: ${await classes()}`);
const rdf = async () => {
  await page.locator('.header').getByRole('tab', { name: 'RDF', exact: true }).click();
  const text = await page.locator('.rdf-code').innerText();
  await page.locator('.header').getByRole('tab', { name: 'Graph', exact: true }).click();
  return text;
};
const block = (text, subject) => text.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';
const c7 = block(await rdf(), ':C7');
ok(c7.includes('rdfs:subClassOf :C3') && c7.includes('skos:definition "The class number 7, as written"'), 'each under its parent, with its definition: ' + flat(c7));
await page.getByRole('button', { name: 'Undo' }).click();
ok((await classes()) === before, 'one undo takes the whole import back');

// ---------------------------------------------------------------- an Excel sheet, as individuals of a class
await open(workbook);
ok((await dialog.getByLabel('Sheet').locator('option').allInnerTexts()).join() === 'Films (4 rows),Genres (3 rows)', 'a workbook is read sheet by sheet');
await dialog.locator('input[type=radio]').nth(1).check();
await dialog.getByLabel('Class of the individuals').selectOption({ label: 'Film' });
// The IRI is made from the code, as the columns' names suggest; the example model has a Parasite already.
ok((await dialog.getByLabel('IRI template').inputValue()).endsWith('#{Code}') && (await dialog.getByLabel('What Title becomes').inputValue()) === 'name', 'the code makes the IRI, the title the name');
await dialog.getByLabel('What Released becomes').selectOption({ label: 'Release date' });
await dialog.getByLabel('What Minutes becomes').selectOption({ label: 'Running time' });
await dialog.getByLabel('What Genre becomes').selectOption({ label: 'belongs to' });
await page.waitForFunction(() => /3 to make/.test(document.querySelector('.import-preview .counts')?.textContent ?? ''));
ok((await counts()) === '3 to make · 0 already in the model · 0 skipped · 4 values left out', 'three films, with what cannot be said left out: ' + (await counts()));
await dialog.getByRole('button', { name: /^With values left out/ }).click();
const notes = (await dialog.locator('.import-rows tr.import-row').allInnerTexts()).map(flat);
ok(notes.some((n) => n.startsWith('3 Amélie & co') && n.includes('Released “2001-04-25T20:30:00” is left out') && n.includes('Minutes “122.5” is left out')), 'a date with a time is no date, and 122.5 minutes no whole number: ' + notes[1]);
ok(notes.some((n) => n.includes('The link by “belongs to” to “Drama” is left out: it is neither a row of the table nor in the model')), 'and a link to what is not there is left out');
await dialog.getByLabel('Name of the template').fill('Films sheet');
await dialog.getByRole('button', { name: 'Keep as a template' }).click();
await dialog.getByRole('button', { name: 'Import 3' }).click();
await dialog.waitFor({ state: 'detached' });
const f1 = block(await rdf(), ':F1');
ok(/^:F1 a owl:NamedIndividual ?, :Film/.test(f1) && f1.includes('rdfs:label "Parasite"') && f1.includes(':releaseDate "2019-05-30"^^xsd:date') && f1.includes(':runningTime "132"^^xsd:integer'), 'the films are individuals of Film, with their values converted from the workbook: ' + flat(f1));

// ---------------------------------------------------------------- the template, and the same file again
await open(workbook);
await dialog.getByLabel('Use a template').selectOption('Films sheet');
await page.waitForFunction(() => /already in the model/.test(document.querySelector('.import-preview .counts')?.textContent ?? '') && document.querySelector('[aria-label="What Minutes becomes"]')?.value?.startsWith('value:'));
ok((await dialog.getByLabel('What Minutes becomes').inputValue()).endsWith('#runningTime') && (await dialog.getByLabel('What Genre becomes').inputValue()).endsWith('#belongsTo'), 'a template gives the mapping back for the next file');
ok((await counts()).startsWith('0 to make · 3 already in the model') && (await dialog.getByRole('button', { name: 'Import', exact: true }).isDisabled()), 'and the same file again makes nothing, and says so: ' + (await counts()));
await dialog.getByRole('button', { name: 'Cancel' }).click();

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
