// Drives the built app in a headless browser to check domains and ranges as axioms: two
// rdfs:domain statements stay two (PROV-O's prov:hadActivity), each axiom is changed, added and
// taken away on its own, an expression the editor has no structure for is shown and not edited,
// a data property's range is its datatype and the axioms beside it, and all of it is kept.
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
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Entities'); return ttl; };
const block = (ttl, subject) => flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '');
const view = page.locator('.view');
const panel = page.locator('.inspector');
const kindTab = (name) => view.getByRole('tab', { name: new RegExp('^' + name) }).click();
const row = (name) => view.locator('tbody tr', { has: page.locator(`input[value="${name}"]`) });
const axioms = (which) => panel.locator(`.axioms[data-which=${which}]`).first();
// Selecting a row opens the entity in the panel; what is read there is read once it is drawn.
const select = async (name) => {
  await row(name).locator('td').first().click();
  await axioms('domain').or(axioms('range')).first().waitFor();
};
// An axiom is written in the expression editor, in a dialog: here as Manchester syntax.
const dialog = page.locator('.xe-dialog');
const write = async (text) => {
  await dialog.getByRole('tab', { name: 'Manchester syntax' }).click();
  const cm = dialog.locator('.cm-content');
  await cm.waitFor();
  await cm.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
};
const saveIn = (label) => dialog.getByRole('button', { name: label, exact: true }).click();
const texts = async (which) => (await axioms(which).locator('.axiom-list code.axiom').allInnerTexts()).map(flat);

const tmp = fs.mkdtempSync('/tmp/cw-domains-');
fs.writeFileSync(
  tmp + '/prov.ttl',
  `@prefix : <http://www.w3.org/ns/prov#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://www.w3.org/ns/prov-o#> a owl:Ontology ; rdfs:label "PROV-O excerpt" .
:Influence a owl:Class .
:Delegation a owl:Class ; rdfs:subClassOf :Influence .
:Derivation a owl:Class ; rdfs:subClassOf :Influence .
:End a owl:Class ; rdfs:subClassOf :Influence .
:Start a owl:Class ; rdfs:subClassOf :Influence .
:Activity a owl:Class .
:hadActivity a owl:ObjectProperty ;
    rdfs:domain :Influence , [ a owl:Class ; owl:unionOf ( :Delegation :Derivation :End :Start ) ] ;
    rdfs:range :Activity .
:wasInverse a owl:ObjectProperty ;
    rdfs:domain [ a owl:Restriction ; owl:onProperty :hadActivity ; owl:someValuesFrom :Influence ; owl:allValuesFrom :Influence ] .
:code a owl:DatatypeProperty ;
    rdfs:range [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:length 4 ] ) ] , xsd:string .
`,
);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
await page.locator('.header input[type=file]').setInputFiles(tmp + '/prov.ttl');
await page.waitForFunction(() => (document.querySelector('.toast')?.textContent ?? '').includes('Opened'));

// ---------------------------------------------------------------- two domains stay two
await tab('Entities');
await kindTab('Object properties');
const cell = flat(await row('had activity').locator('td').nth(2).innerText());
ok(cell.startsWith('Influence and (Delegation or Derivation or End or Start)'), 'in the table, the domain is two axioms that both hold, not one union: ' + cell);
await select('had activity');
ok((await texts('domain')).join(' | ') === 'Influence | Delegation or Derivation or End or Start', 'the property editor lists each rdfs:domain as an axiom of its own: ' + (await texts('domain')).join(' | '));
ok((await axioms('domain').locator('.axiom-and').allTextContents()).map(flat).join() === 'and' && flat(await axioms('domain').locator(':scope > small').innerText()).startsWith('All of these hold'), 'and says that all of them hold (their intersection)');
let ttl = await turtle();
ok(block(ttl, ':hadActivity').includes('rdfs:domain :Influence , [ a owl:Class ; owl:unionOf ( :Delegation :Derivation :End :Start ) ]'), 'the RDF has both statements as they were: ' + block(ttl, ':hadActivity'));
await page.screenshot({ path: shots + 'domains-two-axioms.png' });

// ---------------------------------------------------------------- one axiom at a time
await kindTab('Object properties');
await select('had activity');
await axioms('domain').getByRole('button', { name: 'Change the domain axiom Delegation or Derivation or End or Start' }).click();
await write('Delegation or Start');
await saveIn('Save');
ok((await texts('domain')).join(' | ') === 'Influence | Delegation or Start', 'one axiom is changed, the other stays: ' + (await texts('domain')).join(' | '));
await axioms('domain').getByRole('button', { name: 'Add a domain axiom' }).click();
await write('Influence or Nobody');
const refusal = flat(await dialog.locator('.xe-text small.bad').innerText());
ok(refusal === 'There is no class called “Nobody”.' && (await dialog.getByRole('button', { name: 'Add', exact: true }).isDisabled()), 'an expression that names nothing is refused, with the reason: ' + refusal);
await write('Influence');
await saveIn('Add');
ok(flat(await dialog.locator('[role=alert]').innerText()).startsWith('That is stated already'), 'an axiom stated already is not stated twice');
await write('not End');
await saveIn('Add');
ok((await texts('domain')).join(' | ') === 'Influence | Delegation or Start | not End', 'an axiom is added: ' + (await texts('domain')).join(' | '));
await axioms('domain').getByRole('button', { name: 'Remove the domain axiom Influence' }).click();
ok((await texts('domain')).join(' | ') === 'Delegation or Start | not End', 'and one is taken away');
ttl = await turtle();
ok(block(ttl, ':hadActivity').includes('rdfs:domain [ a owl:Class ; owl:unionOf ( :Delegation :Start ) ] , [ a owl:Class ; owl:complementOf :End ]') && !block(ttl, ':hadActivity').includes('rdfs:domain :Influence'), 'the RDF says what the axioms say: ' + block(ttl, ':hadActivity'));

// ---------------------------------------------------------------- kept as read
await kindTab('Object properties');
await select('was inverse');
const kept = axioms('domain').locator('.axiom-list li');
ok((await kept.count()) === 1 && (await kept.locator('.tag', { hasText: 'kept as read' }).count()) === 1 && (await kept.getByRole('button', { name: /^Change/ }).count()) === 0, 'a restriction that is no OWL class expression (two quantifiers on one node) is shown as it was read, and cannot be changed here');
ttl = await turtle();
ok(block(ttl, ':wasInverse').includes('rdfs:domain [ rdf:type owl:Restriction ; owl:allValuesFrom :Influence ; owl:onProperty :hadActivity ; owl:someValuesFrom :Influence ]'), 'and is written back as it was: ' + block(ttl, ':wasInverse'));

// ---------------------------------------------------------------- a data property's range
await kindTab('Data properties');
await select('code');
ok((await panel.getByLabel('Datatype', { exact: true }).inputValue()) === 'xsd:string', 'a data property’s datatype is the range axiom that names one alone');
ok((await texts('range')).join(' | ') === 'xsd:string[length 4]', 'the facets stated beside it are listed as a further axiom: ' + (await texts('range')).join(' | '));
await axioms('range').getByRole('button', { name: /^Change the range axiom/ }).click();
await write('xsd:string[minLength 2, maxLength 6]');
await saveIn('Save');
await panel.getByLabel('Datatype', { exact: true }).selectOption('xsd:anyURI');
ttl = await turtle();
ok(block(ttl, ':code').includes('rdfs:range [ a rdfs:Datatype ; owl:onDatatype xsd:string ; owl:withRestrictions ( [ xsd:minLength "2"^^xsd:integer ] [ xsd:maxLength "6"^^xsd:integer ] ) ] , xsd:anyURI'), 'the facets and the datatype are changed each on its own: ' + block(ttl, ':code'));

// ---------------------------------------------------------------- kept in the browser
await page.waitForTimeout(500);
// The working copy, as it is kept in this browser (IndexedDB).
const saved = await page.evaluate(() => new Promise((resolve, reject) => { const r = indexedDB.open('conceptweaver'); r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('working')) { db.close(); return resolve(null); } const g = db.transaction('working', 'readonly').objectStore('working').get('current'); g.onsuccess = () => { db.close(); resolve(g.result?.model ?? null); }; g.onerror = () => reject(g.error); }; }));
ok(saved?.version === 6 && saved.props.find((p) => p.name === 'had activity')?.domains?.length === 2, 'the working copy is saved in the format of today (6), with the axioms');
await page.reload();
await page.waitForSelector('.node', { state: 'attached' });
await tab('Entities');
await kindTab('Object properties');
await select('had activity');
ok((await texts('domain')).join(' | ') === 'Delegation or Start | not End', 'and after a reload they are as they were: ' + (await texts('domain')).join(' | '));
await page.screenshot({ path: shots + 'domains-after-reload.png' });

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
