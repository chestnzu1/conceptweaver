// Drives the built app in a headless browser to check the class expression editor: an axiom of a
// class built as nested blocks, and one written in Manchester syntax with completion and errors
// in place; the two modes showing one expression; an operator changed without losing what it
// had; the kind of axiom chosen, never assumed; nothing unfinished or not allowed saved; the
// same editor for a property's domain; and all of it exported as OWL and kept after a reload.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
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
const select = async (name, kind) => {
  await kindTab(kind);
  await view.locator('tbody tr', { has: page.locator(`input[value="${name}"]`) }).locator('td').first().click();
  await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name);
};
const editor = panel.locator('.xe').first();
const preview = async () => flat(await editor.locator('.xe-preview code').innerText());
/** In the picker of a block (found by what its add button says), types and takes the first match. */
const choose = async (scope, addLabel, text) => {
  await scope.getByRole('button', { name: new RegExp('^' + addLabel) }).first().click();
  await scope.getByRole('combobox', { name: /^Search for/ }).first().fill(text);
  await scope.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};
/** The block that is a hole, or the n-th block, chosen by its label. */
const blocks = () => editor.locator('.xb');
const kindOf = (b, value) => b.locator(':scope > .xb-head > select').first().selectOption(value);

const tmp = fs.mkdtempSync('/tmp/cw-expressions-');
fs.writeFileSync(
  tmp + '/people.ttl',
  `@prefix : <http://example.org/people#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/people> a owl:Ontology ; rdfs:label "People" .
:Person a owl:Class ; rdfs:label "Person" .
:Student a owl:Class ; rdfs:label "Student" .
:Organization a owl:Class ; rdfs:label "Organization" .
:AdultPerson a owl:Class ; rdfs:label "AdultPerson" .
:Member a owl:Class ; rdfs:label "Member" ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty [ owl:inverseOf :hasMember ] ; owl:someValuesFrom :Organization ] .
:hasChild a owl:ObjectProperty ; rdfs:label "hasChild" .
:hasMember a owl:ObjectProperty ; rdfs:label "hasMember" .
:hasAge a owl:DatatypeProperty ; rdfs:label "hasAge" .
`,
);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
await page.locator('.header input[type=file]').setInputFiles(tmp + '/people.ttl');
await page.waitForFunction(() => (document.querySelector('.toast')?.textContent ?? '').includes('Opened'));
await tab('Entities');

// ---------------------------------------------------------------- read from the file
await select('Member', 'Classes');
const section = panel.locator('[data-section=class-expressions]');
ok(flat(await section.locator('pre.axiom').first().innerText()) === 'inverse hasMember some Organization', 'an imported expression with an inverse property is an axiom of the class, shown in Manchester syntax: ' + flat(await section.locator('pre.axiom').first().innerText()));
ok((await section.locator('[data-axiom-kind=SubClassOf]').count()) === 1, 'listed under SubClass Of');

// ---------------------------------------------------------------- built as blocks
await select('AdultPerson', 'Classes');
await section.getByRole('button', { name: 'Add a class axiom' }).click();
const save = editor.getByRole('button', { name: 'Add the axiom' });
ok(await save.isDisabled(), 'with no kind of axiom chosen yet, it cannot be added: SubClass Of and Equivalent To say different things');
await editor.getByLabel(/^SubClass Of/).check();
await editor.getByRole('tab', { name: 'Blocks' }).click();
await kindOf(blocks().first(), 'and');
ok((await blocks().count()) === 3 && (await preview()) === '? and ?', 'an AND block has two places to fill: ' + (await preview()));
await kindOf(blocks().nth(1), 'class');
await choose(blocks().nth(1), 'Choose a class', 'Person');
await kindOf(blocks().nth(2), 'some');
await choose(blocks().nth(2), 'Choose the property', 'hasAge');
// A data property: its filler is a data range, and nothing that is a class is on offer for it.
const fillerOptions = await blocks().nth(3).locator(':scope > .xb-head > select').first().locator('option').allInnerTexts();
ok(fillerOptions.includes('Datatype with facets') && !fillerOptions.includes('Class') && !fillerOptions.some((o) => o.startsWith('SOME')), 'the filler of a data property is a datatype, not a class: ' + fillerOptions.join(', '));
await kindOf(blocks().nth(3), 'facets');
await choose(blocks().nth(3), 'Choose a datatype', 'xsd:integer');
await blocks().nth(3).getByRole('button', { name: '+ Add a facet' }).click();
await blocks().nth(3).getByLabel('Value of >=').fill('18');
await blocks().nth(3).getByLabel('Value of >=').press('Enter');
ok((await preview()) === 'Person and (hasAge some xsd:integer[>= 18])', 'the blocks are the expression, shown in Manchester syntax: ' + (await preview()));
// Another operator keeps what the block had, and back again.
await kindOf(blocks().first(), 'or');
ok((await preview()) === 'Person or (hasAge some xsd:integer[>= 18])', 'AND changed to OR keeps both operands: ' + (await preview()));
await kindOf(blocks().first(), 'and');
await kindOf(blocks().nth(2), 'only');
ok((await preview()) === 'Person and (hasAge only xsd:integer[>= 18])', 'SOME changed to ONLY keeps the property and the filler: ' + (await preview()));
await kindOf(blocks().nth(2), 'some');
await page.screenshot({ path: shots + 'class-expression-blocks.png' });
await save.click();
ok(flat(await section.locator('[data-axiom-kind=SubClassOf] pre.axiom').innerText()) === 'Person and (hasAge some xsd:integer[>= 18])', 'it is added as a SubClass Of axiom of the class');
let ttl = await turtle();
ok(block(ttl, ':AdultPerson').includes('rdfs:subClassOf [ a owl:Class ; owl:intersectionOf ( :Person [ a owl:Restriction ; owl:onProperty :hasAge ; owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive "18"^^xsd:integer ] ) ] ] ) ]'), 'and written as the OWL it is: ' + block(ttl, ':AdultPerson'));

// ---------------------------------------------------------------- written as text
await select('AdultPerson', 'Classes');
await section.getByRole('button', { name: 'Add a class axiom' }).click();
await editor.getByLabel(/^Equivalent To/).check();
await editor.getByRole('tab', { name: 'Manchester syntax' }).click();
const text = editor.locator('.cm-content');
await text.waitFor();
await text.click();
await page.keyboard.type('Person and (hasCh');
await page.waitForSelector('.cm-tooltip-autocomplete');
const offered = (await page.locator('.cm-tooltip-autocomplete li').allInnerTexts()).map(flat);
ok(offered.some((o) => o.startsWith('hasChild')), 'names are completed as they are typed: ' + offered.join(' | '));
await page.keyboard.press('Escape');
await page.keyboard.type('ild some xsd:integer)');
await page.waitForTimeout(400);
const wrong = flat(await editor.locator('.xe-text small.bad').innerText());
ok(wrong === '“xsd:integer” is a datatype; hasChild is an object property, whose values are individuals of a class.', 'a datatype where a class has to be is refused, in the terms of the ontology: ' + wrong);
ok(await editor.getByRole('button', { name: 'Add the axiom' }).isDisabled(), 'and cannot be saved');
ok((await editor.locator('.mx-unknown, .cm-lintRange-error').count()) > 0 || (await editor.locator('.mx-object').count()) > 0, 'the text is highlighted as it reads');
await page.keyboard.press('Control+a');
await page.keyboard.type('Person and (hasChild some (Person and Student');
await page.waitForTimeout(300);
ok(flat(await editor.locator('.cm-content').innerText()) === 'Person and (hasChild some (Person and Student))' && (await editor.locator('.xe-text small.bad').count()) === 0, 'brackets are closed as they are opened: ' + flat(await editor.locator('.cm-content').innerText()));
ok((await editor.locator('.mx-class').allInnerTexts()).includes('Person') && (await editor.locator('.mx-object').allInnerTexts()).includes('hasChild') && (await editor.locator('.mx-keyword').allInnerTexts()).includes('some'), 'classes, properties and keywords are highlighted each as what they are');
// The same expression as blocks.
await editor.getByRole('tab', { name: 'Blocks' }).click();
ok((await preview()) === 'Person and (hasChild some (Person and Student))' && (await blocks().first().locator(':scope > .xb-head > select').first().inputValue()) === 'and', 'switched to blocks, it is the same expression: ' + (await preview()));
await editor.getByRole('tab', { name: 'Manchester syntax' }).click();
await editor.locator('.cm-content').waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: shots + 'class-expression-text.png' });
await editor.getByRole('button', { name: 'Add the axiom' }).click();
ok(flat(await section.locator('[data-axiom-kind=EquivalentClasses] pre.axiom').innerText()) === 'Person and (hasChild some (Person and Student))', 'it is added as an Equivalent To axiom, apart from the SubClass Of one');
ttl = await turtle();
ok(block(ttl, ':AdultPerson').includes('owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :Person [ a owl:Restriction ; owl:onProperty :hasChild ; owl:someValuesFrom [ a owl:Class ; owl:intersectionOf ( :Person :Student ) ] ] ) ]') && block(ttl, ':AdultPerson').includes('rdfs:subClassOf [ a owl:Class ; owl:intersectionOf'), 'both are in the RDF, each with its own predicate');

// ---------------------------------------------------------------- changed and removed
await select('AdultPerson', 'Classes');
await section.getByRole('button', { name: /^Change the Equivalent To axiom/ }).click();
await editor.getByRole('tab', { name: 'Blocks' }).click();
await kindOf(blocks().first(), 'or');
await editor.getByRole('button', { name: 'Save the axiom' }).click();
ok(flat(await section.locator('[data-axiom-kind=EquivalentClasses] pre.axiom').innerText()) === 'Person or (hasChild some (Person and Student))', 'an axiom is changed on its own');
await section.getByRole('button', { name: /^Remove the Equivalent To axiom/ }).click();
ok((await section.locator('[data-axiom-kind=EquivalentClasses]').count()) === 0 && (await section.locator('[data-axiom-kind=SubClassOf]').count()) === 1, 'and removed on its own, the other staying');

// ---------------------------------------------------------------- the same editor for a domain
await select('hasChild', 'Object properties');
const domain = panel.locator('.axioms[data-which=domain]');
await domain.getByRole('button', { name: 'Add a domain axiom' }).click();
await editor.getByRole('tab', { name: 'Manchester syntax' }).click();
await editor.locator('.cm-content').click();
await page.keyboard.type('Person or Organization');
await page.waitForTimeout(300);
await editor.getByRole('button', { name: 'Add' }).click();
ok(flat(await domain.locator('code.axiom').first().innerText()) === 'Person or Organization', 'a property’s domain is written in the same editor');
ttl = await turtle();
ok(block(ttl, ':hasChild').includes('rdfs:domain [ a owl:Class ; owl:unionOf ( :Person :Organization ) ]'), 'and exported as one union: ' + block(ttl, ':hasChild'));

// ---------------------------------------------------------------- kept
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node', { state: 'attached' });
await tab('Entities');
await select('AdultPerson', 'Classes');
ok(flat(await section.locator('[data-axiom-kind=SubClassOf] pre.axiom').innerText()) === 'Person and (hasAge some xsd:integer[>= 18])', 'after a reload the axiom is as it was');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
