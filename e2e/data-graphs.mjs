// Drives the built app in a headless browser to check validation one can act on (roadmap stage
// SH-2): data graphs kept with the model, across a reload; a chosen shape set validated against a
// chosen data graph, two sets giving one graph different results; a finding that says on which
// line of its file the focus node is, and opens the property shape at the constraint it failed;
// a graph replaced, renamed, deleted and brought back; and one whose content is not in this
// browser, said to be so.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tmp = fs.mkdtempSync('/tmp/cw-data-graphs-');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: true }).click();
const sv = page.locator('.view.shapes-view');
const v = page.locator('.validation');
const sub = (name) => v.locator('.tabs.sub').getByRole('tab', { name }).click();
const card = () => v.locator('.card', { has: page.locator('h3', { hasText: 'SHACL validation' }) });
const validated = () => page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
const runShacl = async () => {
  await v.getByRole('button', { name: 'SHACL', exact: true }).click();
  await validated();
};
const rows = async () => (await v.locator('tr.result', { has: page.locator('.cat.shacl') }).allInnerTexts()).map(flat);
const chosenData = () => v.getByLabel('Data to validate').evaluate((s) => s.selectedOptions[0]?.textContent ?? '');

const P = '@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix : <http://example.org/film-knowledge-graph#> .\n';
fs.writeFileSync(`${tmp}/catalogue.ttl`, `${P}:CatalogueFilm a sh:NodeShape ; sh:targetClass :Film ;\n  sh:property [ sh:path :releaseDate ; sh:minCount 1 ] .\n`);
fs.writeFileSync(`${tmp}/archive.ttl`, `${P}:ArchiveFilm a sh:NodeShape ; sh:targetClass :Film ;\n  sh:property [ sh:path :runningTime ; sh:maxCount 1 ] .\n`);
// d:f1 has no release date (line 5); d:f2 has two running times (line 7).
fs.writeFileSync(
  `${tmp}/films.ttl`,
  `@prefix : <http://example.org/film-knowledge-graph#> .
@prefix d: <http://data.example/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

d:f1 a :Film ;
  :runningTime 90 .
d:f2 a :Film ;
  :releaseDate "2020-01-01"^^xsd:date ;
  :runningTime 100 , 120 .
`,
);
fs.writeFileSync(`${tmp}/films-fixed.ttl`, `@prefix : <http://example.org/film-knowledge-graph#> .\n@prefix d: <http://data.example/> .\nd:f1 a :Film ; :releaseDate "2021" ; :runningTime 90 .\nd:f2 a :Film ; :releaseDate "2020" ; :runningTime 100 .\nd:f3 a :Film ; :releaseDate "2019" .\n`);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- two shape sets, from Turtle
await tab('Shapes');
for (const name of ['Catalogue', 'Archive']) {
  await sv.getByRole('button', { name: 'New shape set' }).click();
  await sv.getByLabel('Shape set name').fill(name);
  await sv.getByLabel('Shape set name').press('Enter');
  await sv.locator('input[type=file]').first().setInputFiles(`${tmp}/${name.toLowerCase()}.ttl`);
  await page.waitForFunction((n) => [...document.querySelectorAll('.shape-sets li button.on')].some((b) => b.textContent.startsWith(n) && b.textContent.includes('1 shape')), name);
}
ok((await sv.locator('.shape-sets li strong').allInnerTexts()).join(' | ') === 'Catalogue | Archive', 'two shape sets, each with a shape for Film');

// ---------------------------------------------------------------- a data graph, read from a file
await tab('Validation');
await validated();
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), v.getByLabel('Data to validate').selectOption('add')]);
await chooser.setFiles(`${tmp}/films.ttl`);
await page.waitForFunction(() => document.querySelector('[aria-label="Data to validate"]')?.value !== 'model');
ok((await chosenData()) === 'films (6 triples)' && (await v.locator('.stale').count()) === 1, 'a file is read into a data graph of the model, which is then the data validated: ' + (await chosenData()));
// Without the ontology's triples only the graph's own films are validated, not the model's individuals.
await card().getByLabel('with the ontology’s triples').uncheck();

// ---------------------------------------------------------------- one graph, two sets, two results
await v.getByLabel('Shapes to validate with').selectOption({ label: 'Catalogue' });
await runShacl();
const catalogue = await rows();
ok(catalogue.length === 1 && catalogue[0].includes('<http://data.example/f1>') && catalogue[0].includes('MinCount'), 'validated with Catalogue: f1 has no release date: ' + catalogue.join(' / '));
ok(flat(await card().innerText()).includes('of “Catalogue”') && flat(await card().innerText()).includes('triples from films'), 'the card says which set and which data');
await v.getByLabel('Shapes to validate with').selectOption({ label: 'Archive' });
ok((await v.locator('.stale').count()) === 1, 'another shape set makes the results stale');
await runShacl();
const archive = await rows();
ok(archive.length === 1 && archive[0].includes('<http://data.example/f2>') && archive[0].includes('MaxCount'), 'validated with Archive, the same data gives another result: f2 has two running times: ' + archive.join(' / '));

// ---------------------------------------------------------------- the finding: where in the file, and the constraint
await v.locator('tr.result').first().click();
const detail = v.locator('tr.detail');
ok(flat(await detail.locator('.line').innerText()) === '· line 7 of films', 'the finding says on which line of the file its focus node is: ' + flat(await detail.locator('.line').innerText()));
await detail.getByRole('button', { name: 'Open the shape at this constraint' }).click();
const banner = sv.locator('.shape-failed');
await banner.waitFor();
ok(flat(await sv.locator('.shape-sets li button.on').innerText()).startsWith('Archive'), 'it opens the shape in its set');
ok(/Not met at sh:maxCount by <http:\/\/data\.example\/f2>, line 7 of films/.test(flat(await banner.innerText())) && flat(await banner.innerText()).includes('Path :runningTime'), 'the property shape says what failed it, where, and on which path: ' + flat(await banner.innerText()));
ok((await sv.locator('.param-row.failed[data-param=maxCount]').count()) === 1 && (await sv.locator('.param-row.failed').count()) === 1, 'and the constraint that failed is marked, and only it');
ok((await sv.locator('.param-row.failed').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })), 'and in view');
await banner.getByRole('button', { name: 'Back to the finding' }).click();
await v.locator('tr.result.sel').waitFor();
ok((await v.locator('tr.detail').count()) === 1, 'back to the finding, open where it was');

// ---------------------------------------------------------------- kept with the model, across a reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node', { state: 'attached' });
await tab('Validation');
await validated();
await sub(/^Data graphs/);
const list = v.locator('.data-graphs');
ok((await list.locator('tbody tr').count()) === 1 && (await list.locator('.tag.warn').count()) === 0, 'after a reload the data graph is there, with its content in this browser');
await list.locator('tbody tr').first().getByRole('button', { name: 'Validate' }).click();
await validated();
ok((await rows()).length === 2 && (await chosenData()) === 'films (6 triples)', 'and validates from what was kept, with every set: ' + (await rows()).length + ' SHACL findings');

// ---------------------------------------------------------------- replaced, renamed, deleted and back
await sub(/^Data graphs/);
const [again] = await Promise.all([page.waitForEvent('filechooser'), list.getByRole('button', { name: 'Replace…' }).click()]);
await again.setFiles(`${tmp}/films-fixed.ttl`);
await page.waitForFunction(() => document.querySelector('[aria-label="Data to validate"]')?.selectedOptions[0]?.textContent === 'films (8 triples)');
ok((await v.locator('.stale').count()) === 1, 'replaced by another file, the graph is other data: the results are stale');
await list.locator('tbody tr').first().getByRole('button', { name: 'Validate' }).click();
await validated();
ok(flat(await card().innerText()).includes('Conforms') && (await list.locator('td', { hasText: 'films-fixed.ttl' }).count()) === 0, 'and validated again, it conforms');
await sub(/^Data graphs/);
await list.getByLabel('Name of the data graph films').fill('Films of 2026');
await list.getByLabel('Name of the data graph films').press('Enter');
ok((await chosenData()) === 'Films of 2026 (8 triples)', 'a data graph is renamed');
await list.getByRole('button', { name: 'Delete' }).click();
ok((await list.locator('tbody tr').count()) === 0 && (await chosenData()) === 'This model', 'deleted, it is no longer chosen');
await page.getByRole('button', { name: 'Undo' }).click();
// Whether its content is here is looked up in the database: the answer is waited for.
await page.waitForTimeout(400);
ok((await list.locator('tbody tr').count()) === 1 && (await list.locator('.tag.warn').count()) === 0, 'and one undo brings it back, with its content');

// ---------------------------------------------------------------- content not in this browser
await page.waitForTimeout(500);
await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('conceptweaver');
      req.onsuccess = () => {
        const t = req.result.transaction(['datagraphs'], 'readwrite');
        t.objectStore('datagraphs').clear();
        t.oncomplete = () => resolve(req.result.close());
        t.onerror = () => reject(t.error);
      };
      req.onerror = () => reject(req.error);
    }),
);
await page.reload();
await page.waitForSelector('.node', { state: 'attached' });
await tab('Validation');
await validated();
await sub(/^Data graphs/);
await list.locator('.tag.warn').waitFor();
ok(flat(await list.locator('.tag.warn').innerText()) === 'not in this browser', 'a graph whose content this browser does not have says so');
await list.getByRole('button', { name: 'Validate' }).click();
await validated();
ok(flat(await card().innerText()).includes('is not in this browser'), 'and validating it says why it cannot be, not that it conforms');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
