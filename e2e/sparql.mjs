// Drives the built app in a headless browser to check the SPARQL view and its choice of graph:
// the asserted graph, that graph with what the ontology imports, and the graph with what a
// reasoner infers (FR-M9-4).
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1250 }, acceptDownloads: true });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_|CORS/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
{ const proto = Object.getPrototypeOf(page.locator('body')); const orig = proto.selectOption; proto.selectOption = async function (...a) { await this.hover(); return orig.apply(this, a); }; }
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const panel = page.locator('.inspector');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const add = async (label, text) => {
  const f = field(label);
  await f.locator('.chip-add').click();
  await f.getByRole('combobox').fill(text);
  await f.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};
const status = () => page.locator('.sparql-editor [role=status]');
const statusText = async () => flat(await status().innerText());
const headers = async () => (await page.locator('.results thead th').allInnerTexts()).join(',');
const rows = async () => page.locator('.results tbody tr').count();
const waitRows = (n) => page.waitForFunction((n) => {
  const s = document.querySelector('.sparql-editor [role=status]')?.textContent ?? '';
  return new RegExp(`^${n} ${n === 1 ? 'row' : 'rows'} in `).test(s.trim());
}, n);
const graphChoice = () => page.getByLabel('What the query reads');
const run = async (text) => {
  await page.getByLabel('SPARQL query').fill(text);
  await page.getByRole('button', { name: 'Run query' }).click();
};
const rowsText = async () => (await page.locator('.results tbody tr').allInnerTexts()).map(flat);

const tmp = fs.mkdtempSync('/tmp/cw-sparql-');
fs.writeFileSync(tmp + '/people.ttl', `@prefix ppl: <http://example.org/people#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
<http://example.org/people> a owl:Ontology ; rdfs:label "People Ontology" ; owl:versionIRI <http://example.org/people/2.1> .
ppl:Agent a owl:Class ; rdfs:label "Agent" ; skos:definition "Something that acts." .
ppl:Person a owl:Class ; rdfs:label "Person" ; rdfs:subClassOf ppl:Agent ; skos:definition "A human being." .
ppl:Organisation a owl:Class ; rdfs:label "Organisation" ; skos:altLabel "Studio" ; rdfs:subClassOf ppl:Agent ; owl:disjointWith ppl:Person .
ppl:Performer a owl:Class ; rdfs:label "Performer" ; skos:altLabel "Actor" ; rdfs:subClassOf ppl:Person , [ a owl:Restriction ; owl:onProperty ppl:performsIn ; owl:someValuesFrom ppl:Work ] .
ppl:Work a owl:Class ; rdfs:label "Work" .
ppl:Director a owl:Class ; rdfs:label "Director" ; rdfs:subClassOf ppl:Person .
ppl:Prize a owl:Class ; rdfs:label "Prize" ; skos:altLabel "Award" .
ppl:performsIn a owl:ObjectProperty ; rdfs:label "performs in" ; rdfs:domain ppl:Performer ; rdfs:range ppl:Work .
ppl:ada a owl:NamedIndividual , ppl:Person ; rdfs:label "Ada" .
`);

const INSTANCES = `SELECT ?individual ?type
WHERE {
  ?individual a owl:NamedIndividual ;
              a ?type .
  FILTER(?type != owl:NamedIndividual)
}
ORDER BY ?individual ?type`;
const CLASSES = 'SELECT ?c WHERE { ?c a owl:Class } ORDER BY ?c';

await page.goto(base);
await page.evaluate(async () => { localStorage.clear(); await new Promise((r) => { const q = indexedDB.deleteDatabase('conceptweaver'); q.onsuccess = q.onerror = q.onblocked = r; }); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- a subclass the reasoner can use
// The mechanism instance-of.mjs pins: Parasite is a Film, and a Film is a Genre, so Parasite is a Genre by inference.
await node('Film').locator('.node-box').click();
await add('Asserted superclasses', 'Genre');
await tab('SPARQL');

// ---------------------------------------------------------------- asserted, then inferred
await run(INSTANCES);
await waitRows(1);
ok((await headers()) === '?individual,?type' && (await rowsText()).join(' | ') === ':Parasite :Film', 'the asserted graph has the one asserted class membership: ' + (await rowsText()).join(' | '));
ok((await statusText()).includes('read from the asserted graph'), 'and the header says which graph it was read from: ' + (await statusText()));
ok((await graphChoice().inputValue()) === 'asserted', 'the graph choice starts on the asserted graph');

await graphChoice().selectOption('inferred');
await waitRows(2);
ok((await statusText()).includes('read from the graph with inferred statements'), 'the inferred graph says so in the header: ' + (await statusText()));
ok((await rowsText()).join(' | ') === ':Parasite :Film | :Parasite :Genre', 'it adds the membership that follows from the subclass: ' + (await rowsText()).join(' | '));
await page.screenshot({ path: shots + 'sparql-inferred.png' });

// ---------------------------------------------------------------- the answer is about a revision
// The model's name can be edited in the model panel, which stays beside the query.
const modelName = field('Name').locator('input');
await modelName.fill('Film Knowledge Graph, renamed');
await modelName.press('Enter');
await page.waitForFunction(() => /the model has changed since/.test(document.querySelector('.sparql-editor [role=status]')?.textContent ?? ''));
ok((await statusText()).includes('the model has changed since; run again to refresh.'), 'an edit to the ontology makes the answer stale, and the header says so');
await page.getByRole('button', { name: 'Run query' }).click();
await waitRows(2);
ok(!(await statusText()).includes('the model has changed since'), 'running it again answers for the ontology as it now is');

// ---------------------------------------------------------------- CSV
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
await download.saveAs(tmp + '/results.csv');
const csv = fs.readFileSync(tmp + '/results.csv', 'utf8').replace(/^﻿/, '').trim().split('\r\n');
ok(csv[0] === 'individual,type' && csv.slice(1).join(' | ') === ':Parasite,:Film | :Parasite,:Genre', 'the result downloads as CSV, all rows included: ' + csv.join(' / '));

// ---------------------------------------------------------------- with imports
await tab('Align');
await page.locator('.alignment .add-ontology input[type=file]').setInputFiles(tmp + '/people.ttl');
await page.locator('.ext-preview').getByRole('button', { name: 'Reference ontology' }).click();
ok(flat(await page.locator('.alignment .ontologies li').innerText()).includes('People Ontology'), 'the People ontology is in the library as a dependency');
await tab('SPARQL');

// The remembered query and graph choice are back; the graph with imports reads ada as well.
await page.waitForSelector('.results tbody tr');
await graphChoice().selectOption('imports');
await waitRows(2);
ok((await statusText()).includes('read from the asserted graph with imports'), 'the graph with imports says so in the header: ' + (await statusText()));
ok((await rowsText()).includes(':ada :Person') || (await rowsText()).some((r) => r.endsWith(':Person') && r.includes('ada')), 'the instances of the imported ontology are read too: ' + (await rowsText()).join(' | '));

await run(CLASSES);
await graphChoice().selectOption('asserted');
await waitRows(8);
const own = await rows();
await graphChoice().selectOption('imports');
await waitRows(15);
ok((await rows()) === 15 && own === 8, `the classes of both ontologies are found: ${own} asserted, ${await rows()} with imports`);

// ---------------------------------------------------------------- an import the browser does not have
// Save, so that the model and its import survive the reload; then clear what the browser cached of it.
await page.getByRole('button', { name: 'Save', exact: true }).first().click();
await page.locator('.dialog.saveas input').fill('SPARQL films');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await run(INSTANCES);
await waitRows(2);
await page.evaluate(async () => { await new Promise((r) => { const q = indexedDB.open('conceptweaver'); q.onsuccess = () => { const t = q.result.transaction('externals', 'readwrite'); t.objectStore('externals').clear(); t.oncomplete = () => { q.result.close(); r(); }; }; }); });
await page.reload();
await page.waitForSelector('.node');
await tab('SPARQL');
await page.waitForFunction(() => /People Ontology/.test(document.querySelector('.table-wrap .muted.pad')?.textContent ?? ''), undefined, { timeout: 15_000 });
ok((await rows()) === 1 && (await rowsText()).join(' | ') === ':Parasite :Film', 'with the cached import gone, the query reads the ontology alone: ' + (await rowsText()).join(' | '));
ok(flat(await page.locator('.table-wrap .muted.pad').innerText()).includes('“People Ontology” is imported, but its content is not in this browser'), 'and a note names the ontology that was left out: ' + flat(await page.locator('.table-wrap .muted.pad').innerText()));
ok((await statusText()).includes('read from the asserted graph with imports'), 'the header still says which graph was meant');
await page.screenshot({ path: shots + 'sparql-missing-import.png' });

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
