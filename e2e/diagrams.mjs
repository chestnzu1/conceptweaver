// Drives the built app in a headless browser to check the diagrams of an ontology (roadmap task
// 2.12, FR-M5-7): a second diagram starts as the first; leaving a term out of it leaves it in the
// ontology and in the other diagram; each diagram keeps its own arrangement; a diagram can be
// renamed and deleted; and none of it changes a statement of the ontology.
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
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
const nodes = () => page.locator('.node').count();
const classes = async () => Number(/Classes (\d+)/.exec(await page.locator('.term-list').innerText())?.[1] ?? -1);
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const bar = () => page.locator('.subgraph');
const panels = page.locator('.diagram-options');
const pick = (name) => panels.locator('select[aria-label="Diagram"]').selectOption({ label: name });
const layout = () => page.locator('[aria-label="Graph layout"]').inputValue();
const waitLayout = (kind) => page.waitForFunction((k) => document.querySelector('[aria-label="Graph layout"]')?.value === k, kind);
const waitNodes = (n) => page.waitForFunction((count) => document.querySelectorAll('.node').length === count, n);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
const before = await nodes();
const classesBefore = await classes();
const rdfBefore = await turtle();

// ---------------------------------------------------------------- a second diagram
await bar().getByRole('button', { name: 'Diagram 1', exact: true }).click();
await panels.waitFor();
ok((await panels.locator('select[aria-label="Diagram"] option').allInnerTexts()).join() === 'Diagram 1', 'a model has one diagram until another is made');
ok(flat(await panels.locator('.muted').first().innerText()) === `${before} of ${before} terms shown.`, 'it shows every term: ' + flat(await panels.locator('.muted').first().innerText()));
await panels.getByRole('button', { name: 'New diagram' }).click();
ok((await panels.locator('select[aria-label="Diagram"] option').allInnerTexts()).join() === 'Diagram 1,Diagram 2', 'a second diagram is made');
ok((await bar().getByRole('button', { name: 'Diagram 2', exact: true }).count()) === 1, 'the canvas says which diagram it draws');
await waitNodes(before);
ok((await nodes()) === before, 'the new diagram starts as the first: every term is in it');

// ---------------------------------------------------------------- leaving a term out
await node('Genre').locator('.node-box').click();
await panels.getByRole('button', { name: 'Remove the selected term from this diagram' }).click();
await waitNodes(before - 1);
ok((await nodes()) === before - 1, 'a term left out of the diagram is not drawn');
ok((await classes()) === classesBefore, 'the ontology still has it: the same classes as before');
ok(flat(await panels.locator('.muted').first().innerText()) === `${before - 1} of ${before} terms shown, 1 left out.`, 'the diagram says what it leaves out: ' + flat(await panels.locator('.muted').first().innerText()));
await page.screenshot({ path: shots + 'diagrams.png' });

await pick('Diagram 1');
await waitNodes(before);
ok((await node('Genre').count()) === 1, 'the other diagram still shows the term');
await pick('Diagram 2');
await waitNodes(before - 1);
ok((await node('Genre').count()) === 0, 'and the term is still left out of the one that left it out');

// ---------------------------------------------------------------- its own name and arrangement
await panels.getByLabel('Name of the diagram').fill('Detail');
await panels.getByLabel('Name of the diagram').press('Enter');
ok((await bar().getByRole('button', { name: 'Detail', exact: true }).count()) === 1, 'a diagram can be given a name of its own');
await page.locator('[aria-label="Graph layout"]').selectOption('circular');
await waitLayout('circular');
await pick('Diagram 1');
await waitLayout('hierarchy');
ok((await layout()) === 'hierarchy', 'the first diagram keeps its own arrangement');
await pick('Detail');
await waitLayout('circular');
ok((await layout()) === 'circular', 'and the second keeps its own');

// ---------------------------------------------------------------- deleting a diagram
await panels.getByRole('button', { name: 'Delete this diagram' }).click();
await waitNodes(before);
ok((await panels.locator('select[aria-label="Diagram"] option').allInnerTexts()).join() === 'Diagram 1', 'deleting a diagram goes back to the one that is left');
ok((await nodes()) === before && (await classes()) === classesBefore, 'its terms are all still there, on the canvas and in the ontology');
ok((await bar().getByRole('button', { name: 'Diagram 1', exact: true }).count()) === 1 && (await panels.getByRole('button', { name: 'Delete this diagram' }).isDisabled()), 'the last diagram cannot be deleted');

// ---------------------------------------------------------------- the ontology is untouched
await bar().getByRole('button', { name: 'Diagram 1', exact: true }).click();
const rdfAfter = await turtle();
ok(rdfAfter === rdfBefore, 'none of it changed a statement of the ontology: the RDF is what it was');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
