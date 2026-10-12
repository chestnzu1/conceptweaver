// Drives the built app in a headless browser to check the entity editor.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
{ const proto = Object.getPrototypeOf(page.locator('body')); const orig = proto.selectOption; proto.selectOption = async function (...a) { await this.hover(); return orig.apply(this, a); }; }
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const sideTab = (name) => side.getByRole('tab', { name }).click();
const pick = async (name) => { await side.locator('.tree-line .label, .flat-list button, li button', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click(); await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name); };
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const chips = async (label) => (await field(label).locator('.chip-x > .link').allInnerTexts()).map(flat);
// Opens a field's search, types, and picks the first match (or reports the refusal shown).
const add = async (label, text) => {
  const f = field(label);
  await f.locator('.chip-add').click();
  await f.getByRole('combobox').fill(text);
  await f.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};
const rdf = async (subject) => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? ''; };

await page.goto('http://localhost:5181/');
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
await side.getByRole('button', { name: 'Expand all' }).click();

// ---------------------------------------------------------------- a class
await pick('Film');
ok(flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'class', 'the editor is headed by the kind of entity: Class');
const sections = (await panel.locator('.editor-section > h3 .section-toggle').allInnerTexts()).map(flat).map((s) => s.replace(/^[▾▸] /, '').replace(/ \(.*\)$/, ''));
ok(['Class axioms', 'Properties with this domain', 'Inferred superclasses', 'Annotations'].every((s) => sections.includes(s)) && !sections.some((s) => /assertion|Individual|Property axioms/.test(s)), 'a class shows class sections only: ' + sections.join(', '));
ok(flat(await panel.locator('.iri-parts').innerText()).includes(':Film') && flat(await panel.locator('.iri-parts').innerText()).includes('(default)'), 'IRI shown in full with its prefixed name and namespace: ' + flat(await panel.locator('.iri-parts').innerText()));
await page.screenshot({ path: shots + 'editor-class.png' });

// equivalent and disjoint classes, picked by searching; the search knows IRIs
await field('Disjoint classes').locator('.chip-add').click();
await field('Disjoint classes').getByRole('combobox').fill('#Studio');
const found = (await field('Disjoint classes').locator('.subgraph-found button').allInnerTexts()).map(flat);
ok(found.length === 1 && found[0] === 'Studio :Studio', 'the search finds an entity by its IRI and shows the IRI beside the name: ' + found.join(' | '));
await field('Disjoint classes').locator('.subgraph-found button').first().dispatchEvent('pointerdown');
ok((await chips('Disjoint classes')).join() === 'Studio', 'a disjoint class is added as a chip');
ok(flat(await page.locator('.toast').innerText()).includes('switched on'), 'the user is told that RDFS & OWL properties were switched on for it');
ok((await page.locator('.edge-label', { hasText: 'owl:disjointWith' }).count()) === 1, 'the graph draws the new statement');
await add('Disjoint classes', 'Genre');
ok((await chips('Disjoint classes')).join() === 'Studio,Genre', 'several values can stand side by side');
// validation: contradiction refused, with the reason beside the field
await add('Equivalent classes', 'Studio');
ok(flat(await field('Equivalent classes').locator('[role=alert]').innerText()).includes('stated to be disjoint with “Studio”. Both cannot hold'), 'a contradicting statement is refused with the reason shown at the field');
await field('Equivalent classes').getByRole('button', { name: 'Dismiss' }).click();
ok((await chips('Equivalent classes')).length === 0, 'and nothing was changed');
// the other side sees it, and removing there removes exactly it
await pick('Studio');
ok((await chips('Disjoint classes')).join() === 'Film', 'the statement is shown on the other class too');
await field('Disjoint classes').getByRole('button', { name: 'Remove disjoint class Film' }).click();
await pick('Film');
ok((await chips('Disjoint classes')).join() === 'Genre', 'removing it there removes that statement and leaves the other');

// multiple asserted superclasses
await pick('Documentary');
await add('Asserted superclasses', 'Award');
ok((await chips('Asserted superclasses')).join() === 'Film,Award', 'a second asserted superclass: ' + (await chips('Asserted superclasses')).join());
await side.getByRole('button', { name: 'Expand all' }).click();
ok((await side.locator('.tree-line .name', { hasText: /^Documentary$/ }).count()) === 2, 'the class hierarchy now lists Documentary under both parents');
ok((await rdf(':Documentary')).includes('rdfs:subClassOf :Film , :Award'), 'and the RDF states both');

// properties by domain; inferred kept apart
await pick('Film');
ok((await chips('Object properties')).length >= 1 && (await field('Object properties').locator('.tag.auto', { hasText: 'from use' }).count()) >= 1, 'properties with this class as domain are listed, marked when the domain follows use: ' + (await chips('Object properties')).join());
ok(flat(await panel.locator('[data-section=domain] .muted').first().innerText()).includes('does not make the property required'), 'the editor says a domain is not a requirement');
await pick('Documentary');
const inferredSupers = panel.locator('[data-section=inferred-superclasses]');
ok((await inferredSupers.locator('select, input, .chip-add, .btn').count()) === 0 && (await inferredSupers.locator('.tag', { hasText: 'read-only' }).count()) === 1, 'inferred superclasses are in a section of their own, marked inferred, with no controls');
ok((await panel.locator('[data-section=inferred-domain] li').count()) >= 1, 'properties that apply through a superclass domain are listed as inferred, not as the class\'s own');
await page.screenshot({ path: shots + 'editor-class-inferred.png', fullPage: false });

// annotations in several languages
await panel.getByRole('button', { name: 'Add field' }).click();
await panel.getByLabel('Property', { exact: true }).fill('rdfs:label');
await panel.getByLabel('Value', { exact: true }).fill('Documentaire');
await panel.getByLabel('Language', { exact: true }).fill('nl');
await panel.getByRole('button', { name: 'Confirm' }).click();
await panel.getByRole('button', { name: 'Add field' }).click();
await panel.getByLabel('Property', { exact: true }).fill('rdfs:label');
await panel.getByLabel('Value', { exact: true }).fill('纪录片');
await panel.getByLabel('Language', { exact: true }).fill('zh');
await panel.getByRole('button', { name: 'Confirm' }).click();
ok((await panel.locator('.meta-row').count()) === 2, 'two labels in two languages are kept as two annotations');
const doc = await rdf(':Documentary');
ok(doc.includes('"Documentaire"@nl') && doc.includes('"纪录片"@zh'), 'and exported with their language tags');

// ---------------------------------------------------------------- an object property
await tab('Entities');
await page.locator('.view').getByRole('tab', { name: /Object properties/ }).click();
await page.locator('.view tbody tr', { has: page.locator('input[value="acts in"]') }).click();
ok(flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'object property', 'selecting an object property opens its editor');
const propSections = (await panel.locator('.field > span').allInnerTexts()).map(flat);
ok(['Superproperties', 'Inverse properties', 'Equivalent properties', 'Disjoint properties'].every((l) => propSections.some((s) => s.startsWith(l))) && !propSections.some((s) => s.startsWith('Asserted superclasses')), 'an object property has property fields only');
await add('Superproperties', 'belongs');
await add('Superproperties', 'produces');
ok((await chips('Superproperties')).length === 2, 'two superproperties: ' + (await chips('Superproperties')).join());
await field('Inverse properties').locator('.chip-add').click();
await field('Inverse properties').getByRole('combobox').fill('acts in');
ok((await field('Inverse properties').locator('.subgraph-found button').count()) === 0 && flat(await field('Inverse properties').locator('.subgraph-found').innerText()) === 'Nothing else matches.', 'a property is not offered as its own inverse');
await field('Inverse properties').getByRole('combobox').fill('directs');
await field('Inverse properties').locator('.subgraph-found button').first().dispatchEvent('pointerdown');
ok((await chips('Inverse properties')).join() === 'directs', 'an inverse property is added');
for (const c of ['Symmetric', 'Asymmetric']) await panel.getByLabel(c, { exact: true }).check();
ok(flat(await panel.locator('.checks [role=alert]').first().innerText()).includes('Symmetric and asymmetric together'), 'contradicting characteristics are pointed out');
await panel.getByLabel('Symmetric', { exact: true }).uncheck();
ok((await panel.locator('.checks [role=alert]').count()) === 0, 'and the warning goes when one is unticked');
await page.screenshot({ path: shots + 'editor-object-property.png' });
const acts = await rdf(':actsIn');
ok(acts.includes('owl:AsymmetricProperty') && /rdfs:subPropertyOf :belongsTo , :produces|rdfs:subPropertyOf :produces , :belongsTo/.test(acts), 'characteristics and superproperties are in the RDF');

// ---------------------------------------------------------------- a data property
await sideTab(/Properties/);
await pick('Release date');
ok(flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'data property', 'a data property is headed Data property');
await panel.getByLabel('Functional', { exact: true }).check();
await add('Disjoint properties', 'Running');
ok((await chips('Disjoint properties')).join() === 'Running time', 'a disjoint data property');
ok((await panel.getByLabel('Transitive').count()) === 0 && (await panel.getByLabel('Datatype').count()) === 1, 'it offers Functional and a datatype range, not the object-property characteristics');
const rd = await rdf(':releaseDate');
ok(rd.includes('owl:DatatypeProperty , owl:FunctionalProperty') && rd.includes('owl:propertyDisjointWith :runningTime'), 'functional and disjoint are in the RDF');

// ---------------------------------------------------------------- an individual
await tab('Entities');
await page.locator('.view').getByRole('tab', { name: /Individuals/ }).click();
await page.getByRole('button', { name: 'Add individual' }).click();
await panel.locator('input').first().fill('Parasite 2019');
await panel.locator('input').first().blur();
ok(flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'individual', 'an individual is headed Individual');
await add('Asserted types', 'Film');
ok((await chips('Asserted types')).join() === 'Film', 'a type is added');
// a value that does not fit the datatype is refused
const values = panel.locator('[data-section=values]');
await values.locator('.chip-add').click();
await values.getByRole('combobox').fill('Release');
await values.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await values.getByLabel('Value', { exact: true }).fill('May 2019');
await values.getByRole('button', { name: 'Add value' }).click();
ok(flat(await values.locator('[role=alert]').innerText()).includes('is not a date (xsd:date). It should look like 2024-05-17'), 'a value that is not a date is refused with an example of what is expected');
await values.getByLabel('Value', { exact: true }).fill('2019-05-30');
await values.getByRole('button', { name: 'Add value' }).click();
ok(flat(await values.locator('.assertions li').first().innerText()).startsWith('Release date 2019-05-30'), 'a valid value is added: ' + flat(await values.locator('.assertions li').first().innerText()));
// second value of a functional property: allowed, warned, and the reasoner reports it
await values.getByLabel('Value', { exact: true }).fill('2019-05-21');
await values.getByRole('button', { name: 'Add value' }).click();
ok(flat(await page.locator('.toast').innerText()).includes('functional'), 'a second value of a functional property brings a warning');
ok((await panel.locator('[data-section=inferred-types] .bad').count()) === 1, 'and the editor then says the ontology is inconsistent rather than inferring from it');
await values.getByRole('button', { name: 'Remove Release date 2019-05-21' }).click();
ok((await panel.locator('[data-section=inferred-types] .bad').count()) === 0, 'removing the value clears it');
await page.screenshot({ path: shots + 'editor-individual.png' });
const ind = await rdf(':Parasite2019');
ok(ind.includes('a owl:NamedIndividual') && ind.includes(':releaseDate "2019-05-30"^^xsd:date'), 'the individual, its type and its value are in the RDF: ' + flat(ind));

// ---------------------------------------------------------------- unsaved changes, save, widen
await tab('Graph');
ok(flat(await panel.locator('.editor-head .save-state').innerText()) === 'Working copy', 'a model not in My Models says so in the editor');
await panel.locator('.editor-head').getByRole('button', { name: 'Save' }).click();
await page.locator('.dialog.saveas input').fill('Editor test');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.editor-head .save-state')?.textContent === 'Saved');
ok(true, 'saving through the editor uses My Models and the editor then says Saved');
await sideTab(/Classes/);
await pick('Award');
// ---------------------------------------------------------------- the IRI suffix, apart from the label
const suffix = panel.locator('.iri-suffix input');
ok((await suffix.inputValue()) === 'Award', 'the last part of the IRI has a field of its own: ' + (await suffix.inputValue()));
await suffix.fill('C0001');
await suffix.press('Enter');
ok((await rdf(':C0001')).startsWith(':C0001 a owl:Class ;\n    rdfs:label "Award"'), 'changing it changes the IRI and leaves the label: ' + flat(await rdf(':C0001')).slice(0, 44));
ok((await panel.locator('input').first().inputValue()) === 'Award' && flat(await panel.locator('.iri-parts').innerText()).includes(':C0001'), 'the name is still Award, the prefixed name is :C0001');
ok((await rdf(':Film')).includes('owl:onProperty :wins ; owl:someValuesFrom :C0001'), 'what refers to the entity follows the new IRI');
await suffix.fill('Film');
await suffix.press('Enter');
ok(flat(await panel.locator('.iri-suffix .bad').innerText()).includes('already has the IRI'), 'a suffix that is taken is refused, with the reason: ' + flat(await panel.locator('.iri-suffix .bad').innerText()));
await suffix.fill('Award');
await suffix.press('Enter');
ok((await panel.locator('.iri-suffix .bad').count()) === 0 && (await rdf(':Award')).startsWith(':Award a owl:Class'), 'and it can be put back');
await page.getByRole('button', { name: 'Save', exact: true }).first().click();
await page.waitForFunction(() => document.querySelector('.editor-head .save-state')?.textContent === 'Saved');
await add('Disjoint classes', 'Person');
ok(flat(await panel.locator('.editor-head .save-state').innerText()) === 'Unsaved changes', 'an edit shows Unsaved changes in the editor');
await page.getByRole('button', { name: 'Undo' }).click();
ok(flat(await panel.locator('.editor-head .save-state').innerText()) === 'Saved' && (await chips('Disjoint classes')).length === 0, 'undo takes the edit back and the model is saved again');
const w0 = (await panel.boundingBox()).width;
await panel.getByRole('button', { name: 'Widen the editor' }).click();
ok((await panel.boundingBox()).width > w0 + 150, 'the editor can be widened');
await page.screenshot({ path: shots + 'editor-wide.png' });

// ---------------------------------------------------------------- everything survives a reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await side.getByRole('button', { name: 'Expand all' }).click();
await pick('Film');
ok((await chips('Disjoint classes')).join() === 'Genre', 'after a reload the class axioms are still there');

// ---------------------------------------------------------------- the model details can be folded away
await page.locator('#graph-svg').click({ position: { x: 30, y: 600 } });
ok(flat(await panel.locator('h2').first().innerText()).toLowerCase() === 'model' && (await panel.boundingBox()).width > 250, 'with nothing selected the side panel shows the model details');
const stageWidth = (await page.locator('.stage').boundingBox()).width;
await panel.getByRole('button', { name: 'Hide the model details' }).click();
ok((await panel.boundingBox()).width < 60 && (await panel.locator('.field').count()) === 0 && (await page.locator('.stage').boundingBox()).width > stageWidth + 200, 'they can be hidden, which leaves a strip at the edge and gives the room to the canvas');
await pick('Film');
ok(flat(await panel.locator('h2').first().innerText()).toLowerCase() === 'class' && (await field('Name').locator('input').inputValue()) === 'Film', 'selecting a term still opens its editor');
await page.locator('#graph-svg').click({ position: { x: 30, y: 600 } });
ok((await panel.boundingBox()).width < 60, 'and with nothing selected the details are hidden again');
await page.reload();
await page.waitForSelector('.node');
ok((await panel.boundingBox()).width < 60, 'the choice is remembered over a reload');
await panel.getByRole('button', { name: 'Show the model details' }).click();
ok((await field('Name').locator('input').count()) === 1 && (await panel.boundingBox()).width > 250, 'the strip brings them back');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
