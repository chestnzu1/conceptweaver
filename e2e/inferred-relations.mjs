// Drives the built app in a headless browser to check inferred relationships between individuals:
// that both reasoners' are drawn and listed, that switching reasoners replaces them, and that an
// export has them only when asked.
// Needs the preview server (pnpm build && pnpm exec vite preview --port 5181), Java 11 or later,
// and the reasoner's libraries. It starts a reasoning service of its own and stops it again.
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
const tmp = fs.mkdtempSync('/tmp/cw-inferred-');
// The example the missing inferences were reported with, and one relationship that only a
// complete reasoner finds: every member of the staff works for Company A, and Zoe is one.
fs.writeFileSync(tmp + '/members.ttl', `@prefix : <http://example.org/test#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/test> a owl:Ontology ; rdfs:label "Members" .
:hasMember a owl:ObjectProperty .
:isMemberOf a owl:ObjectProperty ; owl:inverseOf :hasMember .
:John a owl:NamedIndividual ; :isMemberOf :CompanyA .
:CompanyA a owl:NamedIndividual .
:worksFor a owl:ObjectProperty .
:Staff a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :worksFor ; owl:hasValue :CompanyA ] .
:Zoe a owl:NamedIndividual , :Staff .
`);

const PORT = 5196;
let service = await startReasoner({ port: PORT, quiet: true, log: () => {} });
const stop = async () => { const s = service; service = undefined; await s?.stop(); };
process.on('uncaughtException', async (e) => { console.error(e); await stop(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error(e); await stop(); process.exit(1); });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
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
const side = page.locator('.term-list');
const toggle = page.locator('.subgraph').getByRole('button', { name: /^Inferred facts/ });
const toast = async () => flat(await page.locator('.toast').innerText().catch(() => ''));
// The inferred relationships on the canvas: what each says, and between which two it is drawn.
const dottedFacts = async () => (await page.locator('.edge.inferred-fact .edge-label').allTextContents()).map(flat).sort();
const solid = async () => (await page.locator('.edge.association:not(.inferred) .edge-label').allTextContents()).map(flat).sort();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
// Chooses an engine in the Validation view and waits for its answer, then comes back to the graph.
const engine = async (label) => {
  await tab(/^Validation/);
  await card.getByRole('radio', { name: label }).check();
  const id = /Advanced/.test(String(label)) ? 'dl' : 'fast';
  await page.waitForFunction((e) => document.querySelector('.owl-card .reasoned')?.getAttribute('data-engine') === e && !document.querySelector('.owl-card fieldset')?.disabled, id);
};
const facts = async () => { await v.locator('.tabs.sub').getByRole('tab', { name: 'Inferred facts' }).click(); return (await v.locator('.issue.inference .issue-rule').allInnerTexts()).map(flat).sort(); };
let downloads = 0;
const exported = async (item) => {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item }).click()]);
  // Each download in a file of its own: two exports of one model have the same name.
  const file = `${tmp}/${++downloads}-${download.suggestedFilename()}`;
  await download.saveAs(file);
  return { name: download.suggestedFilename(), text: fs.readFileSync(file, 'utf8'), file };
};
const inferredOf = async (name) => { await side.getByRole('tab', { name: /^Individuals/ }).click(); await side.locator('li button', { hasText: name }).click(); return (await panel.locator('[data-section="inferred-relations"] .inferred-list li').allInnerTexts()).map(flat); };

await page.goto(base);
await page.evaluate((url) => { localStorage.clear(); localStorage.setItem('conceptweaver:reasoner-url', url); }, `http://127.0.0.1:${PORT}`);
await page.reload();
await page.waitForSelector('.node');
await page.locator('.header input[type=file]').setInputFiles(tmp + '/members.ttl');
await page.waitForFunction(() => document.querySelectorAll('.node').length === 4);
const asserted = await turtle();
ok(asserted.includes('owl:inverseOf :hasMember') && asserted.includes(':isMemberOf :CompanyA') && !asserted.includes(':hasMember :John'), 'the ontology has the inverse and the stated relationship, and not the one that follows from them');

// ---------------------------------------------------------------- the fast reasoner
ok((await solid()).join(' | ') === 'is member of' && (await page.locator('.edge.inferred-fact').count()) === 0, 'the graph draws what is stated; nothing inferred until asked for');
// The layout selector sits in the same bar; its options are not buttons.
const barButtons = (await page.locator('.subgraph .row').first().getByRole('button').allInnerTexts()).map(flat).join(' ');
ok(barButtons === 'Full graph Subgraph Settings Style Rearrange Layout options Inferred facts' && (await toggle.getAttribute('aria-pressed')) === 'false', 'the bar at the top of the graph has a button for the inferred facts, off to begin with: ' + barButtons);
await toggle.click();
ok((await toggle.getAttribute('aria-pressed')) === 'true', 'pressed, it stays on');
// The reasoner answers from a worker: its lines are waited for.
await page.locator('.edge.inferred-fact').first().waitFor({ timeout: 15_000 }).catch(() => {});
ok((await dottedFacts()).join(' | ') === 'has member (inferred)' && flat(await toggle.innerText()) === 'Inferred facts (1)', 'asked for, the relationship that follows from the inverse property is drawn: ' + (await dottedFacts()).join(' | '));
const line = page.locator('.edge.inferred-fact').first();
ok((await line.locator('.edge-line').evaluate((el) => getComputedStyle(el).strokeDasharray)) !== 'none' && (await page.locator('.edge.association:not(.inferred) .edge-line').first().evaluate((el) => getComputedStyle(el).strokeDasharray)) === 'none', 'dotted, where the stated one is solid');
ok(flat(await line.locator('title').textContent()).startsWith('Inferred, not asserted.') && flat(await line.locator('title').textContent()).includes('is the inverse of'), 'and it says what it rests on');
await page.screenshot({ path: shots + 'inferred-relations-fast.png' });
ok((await inferredOf('Company A')).join(' | ').startsWith('has member John'), 'the editor of the individual lists it under Inferred relationships: ' + (await inferredOf('Company A')).join(' | ').slice(0, 60));
await tab(/^Validation/);
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
ok((await facts()).join(' | ') === '“Company A” has member “John”', 'Inferred facts lists it, from the fast reasoner: ' + (await facts()).join(' | '));
// From the list to the graph: the button there switches the inferred facts on and goes to them.
await tab('Graph');
await toggle.click();
ok((await page.locator('.edge.inferred-fact').count()) === 0 && flat(await toggle.innerText()) === 'Inferred facts', 'switched off, they are gone from the graph');
await tab(/^Validation/);
await v.getByRole('button', { name: 'Show inferred facts in the graph' }).click();
ok((await page.locator('.view').count()) === 0 && (await dottedFacts()).join(' | ') === 'has member (inferred)' && (await toggle.getAttribute('aria-pressed')) === 'true', '“Show inferred facts in the graph” goes to the graph with them switched on');
await page.waitForTimeout(400);
await page.reload();
await page.waitForSelector('.node');
// The reasoner answers from a worker, a moment after the graph is drawn.
await page.locator('.edge.inferred-fact').first().waitFor({ timeout: 15_000 }).catch(() => {});
ok((await toggle.getAttribute('aria-pressed')) === 'true' && (await dottedFacts()).join(' | ') === 'has member (inferred)', 'and the choice is remembered after a reload');

// ---------------------------------------------------------------- the OWL 2 DL reasoner
await engine(/^Advanced reasoner/);
ok(flat(await card.locator('.reasoned').innerText()).includes('Reasoner: HermiT 1.4.5.456') && flat(await card.locator('.reasoned').innerText()).includes('Status: Consistent'), 'choosing the advanced reasoner asks HermiT at once');
ok((await facts()).join(' | ') === '“Company A” has member “John” | “Zoe” works for “Company A”', 'Inferred facts now lists the same relationship and one that only HermiT finds: ' + (await facts()).join(' | '));
await tab('Graph');
ok((await dottedFacts()).join(' | ') === 'has member (inferred) | works for (inferred)' && flat(await toggle.innerText()) === 'Inferred facts (2)', 'the graph draws both, the one both reasoners find once: ' + (await dottedFacts()).join(' | '));
ok((await solid()).join(' | ') === 'is member of', 'and what is stated is not drawn a second time as inferred');
const zoe = await inferredOf('Zoe');
ok(zoe.length === 1 && zoe[0] === 'works for Company A Entailed, according to HermiT 1.4.5.456 (OWL 2 DL).', 'what only HermiT finds is credited to it in the editor: ' + zoe.join(' | '));
await page.screenshot({ path: shots + 'inferred-relations-dl.png' });

// ---------------------------------------------------------------- the export has them only when asked
ok((await turtle()) === asserted, 'none of it is in the ontology: what is drawn as inferred is not stated');
const plain = await exported(/^OWL \(Turtle\)/);
ok(!plain.text.includes(':hasMember :John') && !plain.text.includes(':worksFor :CompanyA') && !plain.text.includes('Inferred'), 'the ordinary export writes what is asserted, as before');
const full = await exported(/^OWL with inferred assertions/);
ok(full.name.endsWith('-with-inferred.ttl') && full.text.startsWith(plain.text.trimEnd()), 'the export with inferred assertions is the same ontology with something after it: ' + full.name);
ok(full.text.includes('# Inferred assertions, materialized on export: 0 class memberships and 2 relationships') && full.text.includes('Worked out by HermiT 1.4.5.456 (OWL 2 DL)') && full.text.includes('\n:CompanyA :hasMember :John .') && full.text.includes('\n:Zoe :worksFor :CompanyA .'), 'under a heading that says what they are and who worked them out, the two inferred relationships');
ok((await toast()).includes('2 inferred assertions') && (await turtle()) === asserted, 'and the model itself is unchanged: ' + (await toast()).slice(0, 60));

// the page exported from this picture knows every line in it
await page.getByRole('button', { name: 'File', exact: true }).click();
const [htmlDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Interactive page/ }).click()]);
await htmlDownload.saveAs(tmp + '/page.html');
const html = fs.readFileSync(tmp + '/page.html', 'utf8');
const data = JSON.parse(html.match(/<script type="application\/json" id="model-data">([\s\S]*?)<\/script>/)[1]);
const drawn = [...html.matchAll(/data-rel="([^"]+)"/g)].map((x) => x[1]);
ok(drawn.every((id) => data.rels.some((r) => r.id === id)) && data.rels.filter((r) => r.kind === 'inferred relationship').map((r) => r.label).sort().join(' | ') === 'has member (inferred) | works for (inferred)', 'the interactive page has the same inferred lines, and lists them as inferred');

// ---------------------------------------------------------------- switching back replaces what was inferred
await engine(/^Fast reasoner/);
ok((await facts()).join(' | ') === '“Company A” has member “John”', 'back on the fast reasoner, Inferred facts is its own again');
await tab('Graph');
ok((await dottedFacts()).join(' | ') === 'has member (inferred)' && flat(await toggle.innerText()) === 'Inferred facts (1)', 'and what only HermiT found is gone from the graph at once: ' + (await dottedFacts()).join(' | '));
const byFast = await exported(/^OWL with inferred assertions/);
ok(byFast.text.includes('Worked out by the fast reasoner (RDFS / partial OWL RL)') && byFast.text.includes('\n:CompanyA :hasMember :John .') && !byFast.text.includes(':Zoe :worksFor'), 'an export with inferred assertions is of the reasoner chosen');

// ---------------------------------------------------------------- read back, the materialized assertions are assertions
await page.locator('.header input[type=file]').setInputFiles(full.file);
await page.waitForFunction(() => document.querySelectorAll('.edge.association:not(.inferred)').length === 3);
ok((await solid()).join(' | ') === 'has member | is member of | works for', 'opened again, what was materialized is stated: ' + (await solid()).join(' | '));
// The inferred lines are still switched on: with the fast reasoner, and then with HermiT, there is nothing to add.
ok(/^Inferred facts \(\d+\)$/.test(flat(await toggle.innerText())) && (await page.locator('.edge.inferred-fact').count()) === 0, 'so nothing is inferred beside it: no relationship is there twice');
await engine(/^Advanced reasoner/);
await tab('Graph');
ok((await page.locator('.edge.inferred-fact').count()) === 0 && (await solid()).length === 3, 'nor does HermiT find anything to add to what is now stated');

// ---------------------------------------------------------------- no answer, no export
// The service is gone, and the model has changed since it last answered.
await stop();
await engine(/^Fast reasoner/);
await engine(/^Advanced reasoner/);
ok(flat(await card.locator('.reasoned').innerText()).includes('Status: Unknown'), 'with the service gone the advanced reasoner has no answer');
await page.getByRole('button', { name: 'File', exact: true }).click();
let downloaded = false;
page.once('download', () => (downloaded = true));
await page.getByRole('menuitem', { name: /^OWL with inferred assertions/ }).click();
await page.waitForFunction(() => /gave no answer/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
ok(!downloaded && (await toast()).startsWith('The OWL 2 DL reasoner gave no answer, so there are no inferred assertions to export.'), 'when the reasoner chosen cannot be asked, nothing is exported as inferred, and the reason is given: ' + (await toast()).slice(0, 80));

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
await stop();
process.exit(failed || errors.length ? 1 : 0);
