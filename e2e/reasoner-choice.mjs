// Drives the built app in a headless browser to check the choice of reasoner the service uses
// (roadmap task 2.6, FR-M3-5): chosen automatically by the ontology's profile, ELK for an ontology
// in OWL 2 EL and HermiT otherwise, saying which and why; HermiT or ELK when chosen, the choice
// remembered; what ELK entails credited to it and to OWL 2 EL; and an ontology outside OWL 2 EL
// asked of ELK answered as partial, with what ELK left out.
// Needs the preview server (pnpm build && pnpm exec vite preview --port 5181), Java 11 or later,
// and the reasoner's libraries (pnpm reasoner fetches them once). It starts a reasoning service
// of its own, on a port of its own, and stops it again.
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';
import { startReasoner, unavailable } from '../reasoner/run.mjs';

const why = unavailable();
if (why) {
  console.log('SKIPPED: ' + why);
  process.exit(0);
}
const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync('/tmp/cw-elk-');
const PREFIXES = `@prefix : <http://example.org/anatomy#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/anatomy> a owl:Ontology ; rdfs:label "Anatomy" .
`;
// In OWL 2 EL: intersections, existential restrictions, a transitive property, a definition.
fs.writeFileSync(
  tmp + '/anatomy.ttl',
  PREFIXES +
    `:partOf a owl:ObjectProperty , owl:TransitiveProperty .
:Organ a owl:Class .
:Heart a owl:Class ; rdfs:subClassOf :Organ .
:HeartPart a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :Heart ] .
:Valve a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :Heart ] .
:Leaflet a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :Valve ] .
`,
);
// Outside OWL 2 EL: a universal restriction.
fs.writeFileSync(
  tmp + '/beyond.ttl',
  PREFIXES.replace('"Anatomy"', '"Beyond"') +
    `:hasPart a owl:ObjectProperty .
:Organ a owl:Class .
:Tissue a owl:Class .
:Heart a owl:Class ; rdfs:subClassOf :Organ , [ a owl:Restriction ; owl:onProperty :hasPart ; owl:allValuesFrom :Tissue ] .
`,
);

const PORT = 5163;
let service = await startReasoner({ port: PORT, quiet: true, log: () => {} });
const stop = async () => {
  const s = service;
  service = undefined;
  await s?.stop();
};
process.on('uncaughtException', async (e) => {
  console.error(e);
  await stop();
  process.exit(1);
});
process.on('unhandledRejection', async (e) => {
  console.error(e);
  await stop();
  process.exit(1);
});
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
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
const tab = (name) => page.locator('.header').getByRole('tab', { name }).click();
const v = page.locator('.validation');
const card = v.locator('.owl-card');
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const section = (id) => panel.locator(`[data-section="${id}"]`);
const listed = async (id) => (await section(id).locator('.inferred-list li').allInnerTexts()).map(flat);
/** What is listed under a section once an entry credited to this reasoner is there: the answer reaches the editor a moment after the card. */
const creditedTo = async (id, name) => {
  await page.waitForFunction(([sel, n]) => [...document.querySelectorAll(sel + ' .inferred-list li')].some((li) => li.textContent.includes('according to ' + n)), [`.inspector [data-section="${id}"]`, name]);
  return listed(id);
};
const reasoner = card.getByLabel('Which reasoner the service uses');
const text = async () => flat(await card.locator('.reasoned').innerText());
const settled = () => page.waitForFunction(() => !document.querySelector('.owl-card fieldset')?.disabled && /^Validated /.test(document.querySelector('.run-state')?.textContent ?? '') && document.querySelector('.owl-card .reasoned')?.getAttribute('data-engine') === 'dl');
/** Waits for the answer of a reasoner by its name. */
const answeredBy = (name) => page.waitForFunction((n) => (document.querySelector('.owl-card .reasoner')?.textContent ?? '').includes(n) && !document.querySelector('.owl-card fieldset')?.disabled, name);
const open = async (file, nodes) => {
  await page.locator('.header input[type=file]').setInputFiles(tmp + '/' + file);
  await page.waitForFunction((n) => document.querySelectorAll('.node').length === n, nodes);
};

await page.goto(base);
await page.evaluate((url) => {
  localStorage.clear();
  localStorage.setItem('conceptweaver:reasoner-url', url);
  localStorage.setItem('conceptweaver:reasoning-engine', 'dl');
}, service.url);
await page.reload();
await page.waitForSelector('.node');
await open('anatomy.ttl', 5);

// ---------------------------------------------------------------- chosen by the profile: ELK for OWL 2 EL
await tab(/^Validation/);
await settled();
ok((await reasoner.inputValue()) === 'auto', 'the reasoner is chosen automatically to begin with');
await answeredBy('ELK');
let t = await text();
ok(t.includes('Reasoner: ELK 0.6.0') && t.includes('Status: Consistent') && !t.includes('partial'), 'an ontology in OWL 2 EL is reasoned over by ELK, completely: ' + t.slice(0, 80));
ok(flat(await card.locator('.chosen').innerText()).startsWith('Chosen automatically: the ontology is in OWL 2 EL'), 'and the card says why ELK: ' + flat(await card.locator('.chosen').innerText()));
await page.screenshot({ path: shots + 'reasoner-choice.png' });
await tab('Graph');
await side.getByRole('button', { name: 'Leaflet', exact: true }).first().click();
const byElk = await creditedTo('inferred-superclasses', 'ELK');
ok(byElk.join(' | ') === 'Heart Part Entailed, according to ELK 0.6.0 (OWL 2 EL).', 'what ELK entails is credited to it, and to OWL 2 EL: ' + byElk.join(' | '));

// ---------------------------------------------------------------- chosen by hand, and remembered
await tab(/^Validation/);
await reasoner.selectOption('hermit');
await answeredBy('HermiT');
t = await text();
ok(t.includes('Reasoner: HermiT 1.4.5.456') && t.includes('Status: Consistent') && (await card.locator('.chosen').count()) === 0, 'HermiT chosen, HermiT answers at once, with no reason to give: ' + t.slice(0, 60));
await tab('Graph');
await side.getByRole('button', { name: 'Leaflet', exact: true }).first().click();
const byHermit = await creditedTo('inferred-superclasses', 'HermiT');
ok(byHermit.join(' | ') === 'Heart Part Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).', 'and the same entailment is credited to HermiT, never to ELK: ' + byHermit.join(' | '));
await tab(/^Validation/);
await reasoner.selectOption('elk');
await answeredBy('ELK');
await page.reload();
await page.waitForSelector('.node', { state: 'attached' });
await tab(/^Validation/);
await settled();
ok((await reasoner.inputValue()) === 'elk', 'the choice is remembered across a reload');

// ---------------------------------------------------------------- outside OWL 2 EL
await reasoner.selectOption('auto');
await tab('Graph');
await open('beyond.ttl', 3);
await tab(/^Validation/);
await settled();
await answeredBy('HermiT');
ok(flat(await card.locator('.chosen').innerText()).match(/^Chosen automatically: the ontology is not in OWL 2 EL \(1 axiom outside it, first: .*only/) !== null, 'an ontology outside OWL 2 EL goes to HermiT, and the card says which axiom puts it outside: ' + flat(await card.locator('.chosen').innerText()).slice(0, 120));
await reasoner.selectOption('elk');
await answeredBy('ELK');
t = await text();
ok(t.includes('Status: Consistent, for what could be reasoned over (partial)'), 'asked of ELK directly, it is answered as partial: ' + t.slice(0, 90));
ok(t.includes('ELK covers OWL 2 EL and left out what it does not support') && t.includes('ObjectAllValuesFrom'), 'with what ELK left out, in its words');
await page.screenshot({ path: shots + 'reasoner-choice-partial.png' });

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
await stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
