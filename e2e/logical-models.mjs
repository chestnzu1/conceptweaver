// Drives the built app in a headless browser to check the project's logical data models (roadmap
// LM-1, FR-M17-1, FR-M17-15): made with a name and a purpose, one name to a project; renamed,
// duplicated, exported to a file of their own, imported from one (a file that is not one is
// refused), deleted; each change one step that undo takes back; listed apart from the ontology
// in what changed since a version; and kept across a reload.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync('/tmp/cw-ldm-');
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => {
  if (!c) failed++;
  console.log((c ? 'PASS ' : 'FAIL ') + m);
};
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const dialog = page.locator('.dialog.logical-models');
const rows = dialog.locator('.logical-row');
const versions = page.locator('.dialog.versions');
const menu = async (item) => {
  await page.locator('.header').getByRole('button', { name: /^File/ }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
const openLogical = async () => {
  await menu(/^Logical models…/);
  await dialog.waitFor();
};
const names = async () => Promise.all((await rows.all()).map((r) => r.locator('input').first().inputValue()));
const rowsAre = (n) => page.waitForFunction((k) => document.querySelectorAll('.dialog.logical-models .logical-row').length === k, n);
const close = () => dialog.getByRole('button', { name: 'Close' }).click();

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// A version to compare with, of the project in My Models.
await menu(/^Versions…/);
await versions.waitFor();
await versions.getByRole('button', { name: 'Save to My Models…' }).click();
await page.locator('.dialog.saveas input').fill('Films with an LDM');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await menu(/^Versions…/);
await versions.getByLabel('Name of the version').fill('Before');
await versions.getByRole('button', { name: 'Save a version' }).click();
await versions.locator('.version', { hasText: 'Before' }).waitFor();
await versions.getByRole('button', { name: 'Close' }).click();

// ---------------------------------------------------------------- made, one name to a project
await openLogical();
ok(flat(await dialog.innerText()).includes('No logical models yet.'), 'a project starts with no logical model');
ok(await dialog.getByRole('button', { name: 'Make a logical model' }).isDisabled(), 'one is not made without a name');
await dialog.getByLabel('Name of the new logical model').fill('Film catalogue');
await dialog.getByLabel('What the new logical model is for').fill('The catalogue application');
await dialog.getByRole('button', { name: 'Make a logical model' }).click();
await rowsAre(1);
ok(flat(await rows.first().innerText()).includes('0 entities, 0 attributes, 0 relationships, 0 keys'), 'it is made, empty: ' + flat(await rows.first().locator('.counts').innerText()));
ok((await rows.first().locator('input').nth(1).inputValue()) === 'The catalogue application', 'with what it is for');
await dialog.getByLabel('Name of the new logical model').fill('film catalogue');
await dialog.getByRole('button', { name: 'Make a logical model' }).click();
await dialog.getByRole('alert').waitFor();
ok(flat(await dialog.getByRole('alert').innerText()) === 'The project has a logical model called “film catalogue” already.', 'a second of the same name is refused, whatever its case');
ok((await rows.count()) === 1, 'and not made');
await dialog.getByLabel('Name of the new logical model').fill('');

// ---------------------------------------------------------------- renamed, duplicated
await dialog.getByLabel('Name of the logical model Film catalogue').fill('Films');
await dialog.getByLabel('Name of the logical model Film catalogue').press('Enter');
await dialog.getByLabel('Name of the logical model Films').waitFor();
ok((await names()).join() === 'Films', 'it is renamed');
await rows.first().getByRole('button', { name: 'Duplicate' }).click();
await rowsAre(2);
ok((await names()).join(' | ') === 'Films | Films (copy)', 'and copied under a name of its own: ' + (await names()).join(' | '));

// ---------------------------------------------------------------- exported, deleted, imported
const [download] = await Promise.all([page.waitForEvent('download'), rows.first().getByRole('button', { name: 'Export' }).click()]);
const file = tmp + '/' + download.suggestedFilename();
await download.saveAs(file);
const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(download.suggestedFilename() === 'films.ldm.json' && exported.format === 'conceptweaver-ldm' && exported.version === 1 && exported.model.name === 'Films', 'it is exported to a file of its own: ' + download.suggestedFilename());
await rows.nth(1).getByRole('button', { name: 'Delete…' }).click();
await rowsAre(1);
ok((await names()).join() === 'Films', 'the copy is deleted, once the deletion is confirmed');
await dialog.locator('input[type=file]').setInputFiles(file);
await rowsAre(2);
ok((await names()).join(' | ') === 'Films | Films (2)', 'the file is imported, under a name the project does not have: ' + (await names()).join(' | '));
fs.writeFileSync(tmp + '/not.json', JSON.stringify({ format: 'conceptweaver', version: 6 }));
await dialog.locator('input[type=file]').setInputFiles(tmp + '/not.json');
await dialog.getByRole('alert').waitFor();
ok(/not a logical data model/.test(await dialog.getByRole('alert').innerText()), 'a file that is not a logical model is refused: ' + flat(await dialog.getByRole('alert').innerText()));
ok((await rows.count()) === 2, 'and nothing is imported');
await page.screenshot({ path: shots + 'logical-models.png' });
await close();

// ---------------------------------------------------------------- one step each
await page.getByRole('button', { name: 'Undo' }).click();
await openLogical();
ok((await names()).join() === 'Films', 'one undo takes the import back');
await close();
await page.getByRole('button', { name: 'Redo' }).click();
await openLogical();
ok((await names()).join(' | ') === 'Films | Films (2)', 'and one redo makes it again');
await close();

// ---------------------------------------------------------------- apart from the ontology
await menu(/^Versions…/);
await versions.locator('.version', { hasText: 'Before' }).getByRole('button', { name: 'Compare with now' }).click();
await versions.locator('.difference').waitFor();
const summary = flat(await versions.locator('.difference > p').first().innerText());
ok(summary === 'No entity changed · 0 axioms added, 0 removed · 2 logical models', 'what changed since the version is two logical models and nothing of the ontology: ' + summary);
const listed = (await versions.locator('.difference .diff-logical > li').allInnerTexts()).map(flat);
ok(listed.join(' | ') === 'Films logical model added | Films (2) logical model added', 'each listed by name: ' + listed.join(' | '));
await versions.getByRole('button', { name: 'Close' }).click();

// ---------------------------------------------------------------- kept across a reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await openLogical();
ok((await names()).join(' | ') === 'Films | Films (2)', 'after a reload the logical models are there');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
