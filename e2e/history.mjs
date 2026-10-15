// Drives the built app in a headless browser to check the history: every edit is one step of
// the edit service, which undo applies backwards and redo forwards. Undone back to what was
// saved, the model is saved again, and what was worked out for that revision holds again.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const state = async () => flat(await page.locator('.header .save-state').innerText());
const undo = () => page.locator('.header').getByRole('button', { name: 'Undo' }).click();
const redo = () => page.locator('.header').getByRole('button', { name: 'Redo' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
const where = async (name) => { const b = await node(name).locator('.node-box').boundingBox(); return { x: Math.round(b.x), y: Math.round(b.y) }; };
// The same place: a selected term is drawn with a wider outline, which moves its box by a pixel.
const at = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2;

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- saved, then changed, then undone back to saved
await page.locator('.header').getByRole('button', { name: /^Save/ }).first().click();
await page.locator('.dialog.saveas input').fill('History test');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
ok(true, 'saved to My Models, the header says Saved');
const saved = await turtle();

// A drag: one step, however many frames it took.
const from = await where('Film');
const box = await node('Film').locator('.node-box').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
await page.mouse.up();
const to = await where('Film');
ok(to.x !== from.x && (await state()) === 'Unsaved changes', 'a term dragged: unsaved changes, though the ontology says the same');
ok((await turtle()) === saved, 'the drag changed no statement');
await undo();
ok(at(await where('Film'), from) && (await state()) === 'Saved', 'one undo puts the term back, and the model is saved again');
await redo();
ok(at(await where('Film'), to) && (await state()) === 'Unsaved changes', 'redo moves it there again');
await undo();

// An edit of the ontology, undone and redone.
await node('Film').locator('.node-box').click();
const name = page.locator('.inspector input').first();
await name.fill('Movie');
await name.press('Enter');
ok((await turtle()).includes('rdfs:label "Movie"') && (await state()) === 'Unsaved changes', 'a rename is an edit of the ontology');
await undo();
ok((await turtle()) === saved && (await state()) === 'Saved', 'undone, the ontology is what was saved, and the model is saved again');
await redo();
ok((await turtle()).includes('rdfs:label "Movie"'), 'redone, it is renamed again');
await undo();

// ---------------------------------------------------------------- what was worked out for a revision holds again when undone back to it
const v = page.locator('.validation');
const settled = () => page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
await tab(/^Validation/);
await settled();
await v.getByRole('button', { name: 'Run all checks', exact: true }).click();
await settled();
ok((await v.locator('.stale').count()) === 0, 'the checks have been run on the model as it is');
await tab('Graph');
await node('Actor').locator('.node-box').click();
await name.fill('Performer');
await name.press('Enter');
await tab(/^Validation/);
ok((await v.locator('.stale').count()) === 1, 'after an edit the results are marked stale');
await tab('Graph');
await undo();
await tab(/^Validation/);
ok((await v.locator('.stale').count()) === 0, 'undone, the results are of the model as it is again: not stale');
await tab('Graph');

// ---------------------------------------------------------------- after a reload
await page.waitForTimeout(900);
await page.reload();
await page.waitForSelector('.node');
ok((await state()) === 'Saved' && (await turtle()) === saved, 'after a reload the model is the saved one, and says so');

console.log('console errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
