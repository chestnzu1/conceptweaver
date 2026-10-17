// Drives the built app in a headless browser to check the axioms OWL states with a list or a blank
// node: property chains, keys, disjoint unions, negative assertions and annotations on axioms.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
{ const proto = Object.getPrototypeOf(page.locator('body')); const orig = proto.selectOption; proto.selectOption = async function (...a) { await this.hover(); return orig.apply(this, a); }; }
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const panel = page.locator('.inspector');
const view = page.locator('.view');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const section = (name) => view.getByRole('tab', { name: name instanceof RegExp ? name : new RegExp('^' + name) }).click();
const flatTab = section;
const rdf = async (subject) => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? ''; };
const ttl = async () => { await tab('RDF'); const text = await page.locator('.rdf-code').innerText(); await tab('Graph'); return text; };
const pick = async (name, kind = 'Classes') => {
  await tab('Entities');
  await section(kind);
  await view.locator('tbody tr', { has: page.locator(`input[value="${name}"]`) }).click();
  await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name);
};
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
// Opens a picker in `scope`, types, and chooses the first match.
const choose = async (scope, text) => {
  await scope.locator('.chip-add').first().click();
  await scope.getByRole('combobox').first().fill(text);
  await scope.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- a property chain, with an inverse step
await pick('acts in', /Object properties/);
ok(flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'object property', 'the object property opens: ' + flat(await panel.locator('.editor-head h2').innerText()));
const chains = field('Property chains');
await chains.getByRole('button', { name: 'Add a chain' }).click();
const step = chains.getByLabel('Add a step to the chain');
await step.selectOption({ label: 'directs' });
await step.selectOption({ label: 'acts in' });
ok((await chains.locator('.chain-steps li').count()) === 2, 'a chain of two properties: ' + flat(await chains.innerText()).slice(0, 80));
await chains.locator('.chain-steps li').nth(1).getByRole('checkbox').check();
const withChain = await rdf(':actsIn');
ok(withChain.includes('owl:propertyChainAxiom') && withChain.includes('owl:inverseOf :actsIn'), 'the chain is written with its inverse step: ' + (withChain.match(/owl:propertyChainAxiom[^;]*/) ?? [''])[0]);
await page.screenshot({ path: shots + 'axioms-chain.png' });
await chains.getByRole('button', { name: 'Remove this chain' }).click();
ok(!(await rdf(':actsIn')).includes('propertyChainAxiom'), 'removing the chain takes the statement away');

// ---------------------------------------------------------------- a class's key and disjoint union
await pick('Film');
const more = panel.locator('[data-section=class-axioms-more]');
ok(await more.count() === 1, 'a class has a section for keys and disjoint unions');
const keys = more.locator('.field', { has: page.locator(':scope > span:has-text("Keys")') });
await keys.getByRole('button', { name: 'Add a key' }).click();
await choose(keys, 'Release date');
await choose(keys, 'Running time');
ok((await keys.locator('.chip-x').count()) === 2, 'the key names two properties: ' + (await keys.locator('.chip-x .link').allInnerTexts()).map(flat).join(', '));
const unions = more.locator('.field', { has: page.locator(':scope > span:has-text("Disjoint unions")') });
await unions.getByRole('button', { name: 'Add a disjoint union' }).click();
await choose(unions, 'Documentary');
await choose(unions, 'Genre');
const film = await rdf(':Film');
ok(film.includes('owl:hasKey ( :releaseDate :runningTime )'), 'the key is one statement, in the order it was chosen: ' + (film.match(/owl:hasKey[^;]*/) ?? [''])[0]);
ok(film.includes('owl:disjointUnionOf ( :Documentary :Genre )'), 'so is the disjoint union: ' + (film.match(/owl:disjointUnionOf[^;]*/) ?? [''])[0]);
await page.screenshot({ path: shots + 'axioms-key-union.png' });

// ---------------------------------------------------------------- an individual's negative assertions
await tab('Entities');
await flatTab('Individuals');
await view.getByRole('button', { name: 'Add individual' }).click();
await panel.locator('input').first().fill('Bong Joon-ho');
await panel.locator('input').first().blur();
const negatives = field('Negative assertions');
await negatives.getByLabel('Property of the negative assertion').selectOption({ label: 'directs' });
await negatives.getByLabel('Individual it is not related to').selectOption({ label: 'Parasite' });
await negatives.getByRole('button', { name: 'Add', exact: true }).click();
await negatives.getByLabel('Property of the negative assertion').selectOption({ label: 'Running time' });
await negatives.getByLabel('Value it does not have').fill('132');
await negatives.getByRole('button', { name: 'Add', exact: true }).click();
const said = (await negatives.locator('li').allInnerTexts()).map(flat).map((s) => s.replace(/\s*×$/, ''));
ok(said.length === 2 && said[0] === 'not directs Parasite' && said[1] === 'not Running time “132”', 'both kinds of negative assertion are listed: ' + said.join(' | '));
const all = await ttl();
ok((all.match(/owl:NegativePropertyAssertion/g) ?? []).length === 2 && all.includes('owl:targetIndividual :Parasite') && all.includes('owl:targetValue "132"'), 'they are written as the blank nodes OWL states them with');
await page.screenshot({ path: shots + 'axioms-negative.png' });

// ---------------------------------------------------------------- an annotation on an axiom
await pick('Film');
// The statement "Film belongs to Genre" is what the annotation is about; its target is Turtle.
const axioms = panel.locator('[data-section=axiom-annotations]');
await axioms.getByLabel('Annotation property').selectOption({ label: 'belongs to' });
await axioms.getByLabel("The statement target, as Turtle").fill('<http://example.org/film-knowledge-graph#Genre>');
await axioms.getByRole('button', { name: 'Add field' }).click();
await axioms.getByLabel('Property', { exact: true }).fill('rdfs:comment');
await axioms.getByLabel('Value', { exact: true }).fill('annotated by the e2e');
await axioms.getByRole('button', { name: 'Confirm' }).click();
await axioms.getByRole('button', { name: 'Add annotation' }).click();
ok((await axioms.locator('.axiom-card').count()) === 1, 'the annotation is listed with the statement it is about: ' + flat(await axioms.locator('.axiom-card').first().innerText()).slice(0, 60));
const annotated = await ttl();
ok(annotated.includes('owl:Axiom') && annotated.includes('owl:annotatedSource :Film') && annotated.includes('"annotated by the e2e"'), 'and written as owl:Axiom, with what it says');
await page.screenshot({ path: shots + 'axioms-annotation.png' });

// ---------------------------------------------------------------- all of it survives a reload
await page.waitForTimeout(900);
const before = await ttl();
await page.reload();
await page.waitForSelector('.node');
await pick('Film');
const persisted = (await panel.locator('[data-section=class-axioms-more]').innerText()) + (await panel.locator('[data-section=axiom-annotations]').innerText());
ok(/owl:hasKey|Release date/.test(persisted) && flat(persisted).includes('annotated by the e2e'), 'after a reload the key and the annotation are still there');
ok((await ttl()) === before, 'the saved statements are the same as before the reload');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
