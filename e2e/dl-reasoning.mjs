// Drives the built app in a headless browser to check OWL 2 DL reasoning: the choice of reasoner,
// what HermiT finds, its explanations, and what is said when it cannot be asked.
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
const tmp = fs.mkdtempSync('/tmp/cw-dl-');
fs.writeFileSync(tmp + '/party.ttl', `@prefix : <http://example.org/party#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/party> a owl:Ontology ; rdfs:label "Party" .
:PartyLocalProfile a owl:Class ;
    rdfs:subClassOf
        [ a owl:Restriction ; owl:onProperty :hasPreferredAddress ; owl:allValuesFrom :PhysicalAddress ] ,
        [ a owl:Restriction ; owl:onProperty :hasPreferredAddress ; owl:someValuesFrom :OrganisationLocalProfile ] .
:OrganisationLocalProfile a owl:Class ; rdfs:subClassOf :PartyLocalProfile ; owl:disjointWith :PhysicalAddress .
:PhysicalAddress a owl:Class .
:hasPreferredAddress a owl:ObjectProperty .
:Person a owl:Class .
:Employed a owl:Class .
:Worker a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :Person :Employed ) ] .
:Clerk a owl:Class ; rdfs:subClassOf :Person , :Employed .
:Ann a owl:NamedIndividual , :Person , :Employed .
`);

const PORT = 5198;
let service = await startReasoner({ port: PORT, quiet: true, log: () => {} });
// Whatever happens below, the service started here is stopped again.
const stop = async () => { const s = service; service = undefined; await s?.stop(); };
process.on('uncaughtException', async (e) => { console.error(e); await stop(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error(e); await stop(); process.exit(1); });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
// A request to a service that is not running is reported by the browser itself; that one is expected here.
page.on('console', (m) => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const v = page.locator('.validation');
const card = v.locator('.owl-card');
const panel = page.locator('.inspector');
const settled = () => page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
const reasoned = () => card.locator('.reasoned');
const text = async () => flat(await reasoned().innerText());
// Runs the reasoning and waits for the run to be over.
const run = async () => { await card.getByRole('button', { name: 'Run reasoning' }).click(); await page.waitForFunction(() => !document.querySelector('.owl-card fieldset')?.disabled && /^Validated /.test(document.querySelector('.run-state')?.textContent ?? '')); };
// Choosing an engine asks it at once: the other one's answer is not left standing. Waits for the answer of the one chosen.
const choose = async (label) => {
  await card.getByRole('radio', { name: label }).check();
  const engine = /Advanced/.test(String(label)) ? 'dl' : 'fast';
  await page.waitForFunction((e) => document.querySelector('.owl-card .reasoned')?.getAttribute('data-engine') === e && !document.querySelector('.owl-card fieldset')?.disabled, engine);
};

await page.goto(base);
// The app starts out asking an address where nothing listens, whatever service may be running on this machine.
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('conceptweaver:reasoner-url', 'http://127.0.0.1:5189'); });
await page.reload();
await page.waitForSelector('.node');
await page.locator('.header input[type=file]').setInputFiles(tmp + '/party.ttl');
await page.waitForFunction(() => document.querySelectorAll('.node').length === 8);

// ---------------------------------------------------------------- the two engines
await tab(/^Validation/);
await settled();
ok((await card.getByRole('radio').count()) === 2 && (await card.getByRole('radio', { name: /^Fast reasoner/ }).isChecked()), 'the reasoning engine is chosen in the OWL card, and the fast reasoner is the one to start with');
ok(flat(await card.locator('.engine').innerText()) === 'Reasoning engine Fast reasoner (RDFS / partial OWL RL) Advanced reasoner (OWL 2 DL) Run reasoning', 'the two engines are named for what they are: ' + flat(await card.locator('.engine').innerText()));
let t = await text();
ok(t.includes('Reasoner: Fast reasoner') && t.includes('Status: No contradiction found') && t.includes('Unsatisfiable classes: 0'), 'the fast reasoner finds nothing wrong with this ontology: ' + t.slice(0, 90));
ok(t.includes('That is not a proof that the ontology is consistent') && !/Status: Consistent/.test(t), 'and does not pass that off as a proof of consistency');

await choose(/^Advanced reasoner/);
await page.waitForFunction(() => /is running|Not running/.test(document.querySelector('.owl-card .health')?.textContent ?? ''));
ok(flat(await card.locator('.health').innerText()) === 'Not running' && flat(await card.innerText()).includes('start it with “pnpm reasoner”') && (flat(await card.innerText()).match(/start it with “pnpm reasoner”/g) ?? []).length === 1, 'choosing the advanced reasoner looks for the reasoning service, and says how to start it, once, when it is not there');
t = await text();
ok(t.includes('Reasoner: HermiT') && t.includes('Status: Unknown: the reasoner gave no answer') && !t.includes('No contradiction found'), 'the reasoner chosen is asked at once, and the other one’s answer is not left standing as if it were its own: ' + t.slice(0, 70));
await card.getByLabel('Address of the reasoning service').fill(`http://127.0.0.1:${PORT}`);
await card.getByLabel('Address of the reasoning service').press('Enter');
await page.waitForFunction(() => /is running/.test(document.querySelector('.owl-card .health')?.textContent ?? ''));
ok(flat(await card.locator('.health').innerText()) === 'HermiT 1.4.5.456 is running', 'at the address of a running service it says which reasoner that is: ' + flat(await card.locator('.health').innerText()));

// ---------------------------------------------------------------- the PartyLocalProfile case
await run();
t = await text();
ok(t.includes('Reasoner: HermiT 1.4.5.456') && t.includes('Status: Consistent') && !t.includes('partial'), 'HermiT answers, under its own name, that the ontology is consistent: ' + t.slice(0, 60));
ok(t.includes('Unsatisfiable classes: 2') && (await card.locator('.unsat li').allInnerTexts()).map(flat).join(' | ') === 'Organisation Local Profile View explanation | Party Local Profile View explanation', 'and that two classes can have no instances: ' + (await card.locator('.unsat li').allInnerTexts()).map(flat).join(' | '));
ok(/\d+ logical axioms, \d+ inferred · \d+ ms/.test(t), 'with how much it reasoned over and how long it took: ' + t.match(/\d+ logical axioms.*$/)?.[0]);
ok((await card.getAttribute('class')).includes('is-warn'), 'the card is marked as something to look at, not as all well');
const rows = async () => (await v.locator('tr.result').allInnerTexts()).map(flat).filter((r) => / OWL /.test(r));
ok((await rows()).length === 2 && (await rows()).every((r) => r.startsWith('Error OWL') && r.includes('Unsatisfiable class') && r.includes('can never have an instance: it is a subclass of owl:Nothing')), 'both are findings in the results, as OWL errors: ' + (await rows())[1]);
await page.screenshot({ path: shots + 'dl-unsatisfiable.png' });

// the explanation
await card.locator('.unsat li', { hasText: 'Party Local Profile' }).getByRole('button', { name: 'View explanation' }).click();
const detail = v.locator('tr.detail');
const explanation = detail.locator('.explanation');
ok((await v.locator('tr.result.sel').count()) === 1 && flat(await v.locator('tr.result.sel').innerText()).includes('Party Local Profile'), 'View explanation opens the finding of that class in the results');
ok((await explanation.locator('li').allInnerTexts()).map(flat).join(' | ') === "'Organisation Local Profile' DisjointWith 'Physical Address' | 'Party Local Profile' SubClassOf 'has preferred address' only 'Physical Address' | 'Party Local Profile' SubClassOf 'has preferred address' some 'Organisation Local Profile'", 'the explanation is the reasoner’s justification: the three asserted axioms, in Manchester syntax');
ok(flat(await explanation.innerText()).includes('These 3 asserted axioms are enough for it, and no fewer of them are, according to HermiT 1.4.5.456') && flat(await explanation.locator('.conclusion').innerText()) === 'Conclusion: “Party Local Profile” cannot have any instances.', 'it says whose it is and what it comes to: ' + flat(await explanation.locator('.conclusion').innerText()));
ok(flat(await detail.innerText()).includes('OWL logical consistency: from HermiT 1.4.5.456, the OWL 2 DL reasoner'), 'the finding says which reasoner it is from');
await explanation.locator('li').nth(1).getByRole('button', { name: "'has preferred address'" }).click();
ok(/^object property/i.test(flat(await panel.innerText())) && (await panel.locator('input').first().inputValue()) === 'has preferred address', 'a property named in an axiom opens in the editor: ' + flat(await panel.innerText()).slice(0, 40));
await explanation.locator('li').first().getByRole('button', { name: "'Physical Address'" }).click();
ok((await panel.locator('input').first().inputValue()) === 'Physical Address', 'and so does a class');
await page.screenshot({ path: shots + 'dl-explanation.png' });
await card.locator('.unsat').getByRole('button', { name: 'Organisation Local Profile' }).click();
ok((await panel.locator('input').first().inputValue()) === 'Organisation Local Profile', 'an unsatisfiable class in the card opens in the editor');
await detail.getByRole('button', { name: 'Show in the graph' }).click();
ok((await page.locator('.view').count()) === 0 && (await page.locator('.node:not(.dim)').count()) === 3, 'Show in the graph spotlights the classes the explanation is about');
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- what it entails, in the editor, the results and the graph
const side = page.locator('.term-list');
const section = (id) => panel.locator(`[data-section="${id}"]`);
const listed = async (id) => (await section(id).locator('.inferred-list li').allInnerTexts()).map(flat);
await side.getByRole('button', { name: 'Clerk', exact: true }).first().click();
ok((await listed('inferred-superclasses')).join(' | ') === 'Worker Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).', 'a class shows the superclass only the OWL 2 DL reasoner finds, credited to it: ' + (await listed('inferred-superclasses')).join(' | '));
ok(flat(await panel.innerText()).includes('Inferred restrictions (1)') && flat(await panel.innerText()).includes('intersectionOf'), 'and what it inherits from that superclass is among its inferred restrictions');
await side.getByRole('button', { name: 'Worker', exact: true }).first().click();
ok((await listed('inferred-subclasses')).join(' | ') === 'Clerk Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).' && (await listed('inferred-instances')).join(' | ') === 'Ann Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).', 'a defined class shows what is entailed to be under it and in it: ' + [...(await listed('inferred-subclasses')), ...(await listed('inferred-instances'))].join(' | '));
await side.getByRole('tab', { name: /^Individuals/ }).click();
await side.locator('li button', { hasText: 'Ann' }).click();
ok((await listed('inferred-types')).join(' | ') === 'Worker Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).', 'an individual shows the class it is entailed to be an instance of: ' + (await listed('inferred-types')).join(' | '));
await side.getByRole('tab', { name: /^Classes/ }).click();
await side.getByRole('button', { name: 'Party Local Profile', exact: true }).first().click();
ok(flat(await section('inferred-superclasses').innerText()).includes('The OWL 2 DL reasoner finds that this class can never have an instance: it is a subclass of owl:Nothing.'), 'an unsatisfiable class says so in the editor');
await page.locator('.subgraph').getByRole('button', { name: /^Inferred facts/ }).click();
ok((await page.locator('.edge.inferred').count()) === 1 && flat(await page.locator('.edge.inferred title').first().textContent()).includes('according to HermiT 1.4.5.456'), 'the graph draws the class membership it entails, dotted like the others');
await page.locator('.subgraph').getByRole('button', { name: /^Inferred facts/ }).click();
await section('inferred-superclasses').getByRole('button', { name: 'View explanation' }).click();
ok((await v.locator('tr.result.sel').count()) === 1 && flat(await v.locator('tr.result.sel').innerText()).includes('Party Local Profile') && (await explanation.locator('li').count()) === 3, 'View explanation in the editor goes to the finding and its justification');
await v.locator('.tabs.sub').getByRole('tab', { name: 'Inferred facts' }).click();
const facts = (await v.locator('.issue.inference').allInnerTexts()).map(flat);
ok(facts.length === 4 && facts[0] === 'inferred “Ann” is an instance of “Worker” Entailed, according to HermiT 1.4.5.456 (OWL 2 DL). Add to model' && facts.some((f) => f.includes('“Clerk” is a kind of “Worker”')), 'Inferred facts lists what HermiT entails beyond what is stated: ' + facts.map((f) => f.slice(9, 46)).join(' / '));
await tab('RDF');
const stated = await page.locator('.rdf-code').innerText();
ok(!/:Clerk [^.]*:Worker/.test(stated) && !/:Ann [^.]*:Worker/.test(stated), 'none of it is in the ontology: inferred and asserted stay apart');
await tab(/^Validation/);
await v.locator('.tabs.sub').getByRole('tab', { name: /^Results/ }).click();

// ---------------------------------------------------------------- an instance makes it inconsistent, and the results stale first
await page.getByRole('button', { name: 'Bulk add' }).click();
await page.locator('.dialog textarea').fill('Acme | individual');
await page.locator('.dialog').getByRole('button', { name: 'Add terms' }).click();
if (await page.locator('.dialog').count()) await page.locator('.dialog').getByRole('button', { name: 'Close' }).click();
await tab('Graph');
await page.locator('.term-list').getByRole('tab', { name: /^Individuals/ }).click();
await page.locator('.term-list li button', { hasText: 'Acme' }).click();
const types = panel.locator('.field', { has: page.locator(':scope > span:has-text("Asserted types")') }).first();
await types.locator('.chip-add').click();
await types.getByRole('combobox').fill('Party Local');
await types.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await page.locator('.term-list').getByRole('tab', { name: /^Classes/ }).click();
await page.locator('.term-list').getByRole('button', { name: 'Clerk', exact: true }).first().click();
ok((await listed('inferred-superclasses')).length === 0, 'after an edit what the OWL 2 DL reasoner entailed of the old model is no longer shown in the editor');
await tab(/^Validation/);
ok(flat(await v.innerText()).includes('The model has changed since these results'), 'and its results are marked as no longer current');
await run();
t = await text();
ok(t.includes('Reasoner: HermiT 1.4.5.456') && t.includes('Status: Inconsistent') && !t.includes('Unsatisfiable classes') && !t.includes('inferred'), 'with an instance of the class the ontology is inconsistent, and nothing is given as inferred from it: ' + t.slice(0, 70));
ok((await card.getAttribute('class')).includes('is-bad'), 'the card says so');
await card.locator('.status').getByRole('button', { name: 'View explanation' }).click();
ok((await explanation.locator('li').allInnerTexts()).map(flat).includes("Acme Type 'Party Local Profile'") && (await explanation.locator('li').count()) === 4 && flat(await explanation.locator('.conclusion').innerText()) === 'Conclusion: these cannot all be true at once, so the ontology is inconsistent.', 'its explanation is the justification of the inconsistency, the instance among the axioms');
await page.screenshot({ path: shots + 'dl-inconsistent.png' });

// the fast reasoner, asked the same, sees none of it
await choose(/^Fast reasoner/);
await run();
t = await text();
ok(t.includes('Reasoner: Fast reasoner') && t.includes('Status: No contradiction found') && t.includes('Unsatisfiable classes: 0'), 'the fast reasoner is still there, and still does not see it: ' + t.slice(0, 70));

// ---------------------------------------------------------------- the choice is remembered; a service that is gone is a failure, not a result
await choose(/^Advanced reasoner/);
await page.waitForTimeout(900);
await page.reload();
await page.waitForSelector('.node');
await tab(/^Validation/);
await settled();
ok((await card.getByRole('radio', { name: /^Advanced reasoner/ }).isChecked()) && (await card.getByLabel('Address of the reasoning service').inputValue()) === `http://127.0.0.1:${PORT}`, 'the engine chosen and the address of the service are remembered');
ok((await text()).includes('Status: Inconsistent'), 'and opening the workbench reasons with the engine chosen');
await stop();
await run();
t = await text();
ok(t.includes('Status: Unknown: the reasoner gave no answer') && t.includes(`The reasoning service did not answer at http://127.0.0.1:${PORT}`) && t.includes('start it with “pnpm reasoner”'), 'when the service is gone the status is unknown, with what to do about it: ' + t.slice(0, 80));
ok(!/Consistent|No contradiction/.test(t) && !t.includes('Unsatisfiable classes') && (await card.getAttribute('class')).includes('is-warn'), 'nothing is reported as consistent, and no result of an earlier run is left standing');
ok((await rows()).length === 1 && (await rows())[0].includes('Reasoning did not finish'), 'the results say that the reasoning did not finish: ' + (await rows())[0]?.slice(0, 80));
await page.screenshot({ path: shots + 'dl-unreachable.png' });

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
await stop();
process.exit(failed || errors.length ? 1 : 0);
