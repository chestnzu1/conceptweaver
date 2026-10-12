// Drives the built app in a headless browser to check OWL enumerations: classes defined by
// listing their members (ObjectOneOf) and datatypes defined by listing their values (DataOneOf).
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
const block = (ttl, subject) => flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '');
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const definition = panel.locator('[data-section="class-definition"]');
const members = async () => (await definition.locator('.enum-members li').allInnerTexts()).map((s) => flat(s).replace(/ ?×$/, ''));
// Opens the search of the enumeration editor, types, and takes the first thing offered.
const addMember = async (text) => {
  await definition.locator('.chip-add').click();
  await definition.locator('input[type=search]').fill(text);
  await definition.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};
const toast = async () => flat(await page.locator('.toast').innerText().catch(() => ''));

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- a class defined as an enumeration
await node('Genre').locator('.node-box').click();
ok(flat(await definition.innerText()).includes('No definition (an ordinary class)') && (await definition.locator('.enum-members').count()) === 0, 'a class has a Class definition section, and is an ordinary class until told otherwise');
const genreBefore = block(await turtle(), ':Genre');
await definition.getByLabel('Class definition').selectOption('oneOf');
ok(flat(await definition.innerText()).includes('{ }') && !block(await turtle(), ':Genre').includes('owl:oneOf'), 'chosen as an enumeration, it has no members yet and nothing is exported for it');

await addMember('Drama');
await addMember('Comedy');
ok((await members()).join(' | ') === 'Drama :Drama | Comedy :Comedy', 'individuals can be created straight from the enumeration editor, and are listed with their names and IRIs: ' + (await members()).join(' | '));
await addMember('Parasite');
ok((await members()).length === 3 && (await members())[2] === 'Parasite :Parasite', 'an individual that exists already is found by the search and added');
ok(flat(await definition.locator('code.expression').first().innerText()) === 'Genre EquivalentTo: { Drama, Comedy, Parasite }', 'the OWL expression is shown: ' + flat(await definition.locator('code.expression').first().innerText()));
await definition.locator('.chip-add').click();
await definition.locator('input[type=search]').fill('Drama');
ok(flat(await definition.locator('.subgraph-found').innerText()) === 'Nothing else matches.', 'a member cannot be added a second time: it is no longer on offer');
await page.keyboard.press('Escape');

let ttl = await turtle();
ok(block(ttl, ':Genre').includes('owl:equivalentClass [ a owl:Class ; owl:oneOf ( :Drama :Comedy :Parasite ) ]') && block(ttl, ':Genre').startsWith(genreBefore.replace(/ \.$/, '')), 'it is exported as owl:equivalentClass with owl:oneOf, after everything the class said before: ' + block(ttl, ':Genre').slice(-78));
ok(block(ttl, ':Drama').startsWith(':Drama a owl:NamedIndividual ;') && !block(ttl, ':Drama').includes('Genre') && !ttl.includes('owl:AllDifferent'), 'the members are individuals, not typed by the class, and not said to be different');

await definition.getByLabel(/Declare all members different/).check();
ttl = await turtle();
ok(/\[\] a owl:AllDifferent ;\s+owl:distinctMembers \( :Drama :Comedy :Parasite \) \./.test(ttl), 'asked for, owl:AllDifferent is stated of the members');

await definition.getByRole('button', { name: 'Remove Comedy from the enumeration' }).click();
ttl = await turtle();
ok(block(ttl, ':Genre').includes('owl:oneOf ( :Drama :Parasite )') && block(ttl, ':Comedy').startsWith(':Comedy a owl:NamedIndividual'), 'a member can be taken off the list; the individual stays in the model');
await definition.locator('.enum-members .link', { hasText: 'Drama' }).click();
ok(flat(await panel.locator('h2').first().innerText()).toLowerCase() === 'individual' && (await panel.locator('.field input').first().inputValue()) === 'Drama', 'clicking a member opens that individual');
await page.screenshot({ path: shots + 'enumerations.png' });

// ---------------------------------------------------------------- in the graph
const css = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
const oneOf = page.locator('.edge.one-of');
const typeEdge = page.locator('.edge.instance-of:not(.inferred)').first();
await page.locator('.zoom').getByRole('button', { name: 'Fit' }).click();
ok((await oneOf.count()) === 2 && (await oneOf.locator('.edge-label').allTextContents()).join() === 'one of,one of', 'the graph joins the enumeration class to each individual it lists, by a line labelled “one of”');
ok((await css(oneOf.first().locator('.edge-line'), 'strokeDasharray')) !== 'none' && (await css(typeEdge.locator('.edge-line'), 'strokeDasharray')) === 'none' && (await css(oneOf.first().locator('.edge-line'), 'stroke')) !== (await css(typeEdge.locator('.edge-line'), 'stroke')), 'drawn unlike class membership (rdf:type): dash-dotted and in another colour');
ttl = await turtle();
ok(ttl.match(/owl:oneOf \(/g).length === 1 && !/owl:oneOf :/.test(ttl) && !block(ttl, ':Drama').includes('Genre'), 'the lines are a picture of the definition: no triple from the class to an individual is written for them');
await oneOf.first().locator('.edge-label-bg').click();
ok(flat(await panel.locator('h2').first().innerText()).toLowerCase() === 'class' && (await panel.locator('.field input').first().inputValue()) === 'Genre', 'clicking such a line opens the class, where the list is');
await node('Drama').locator('.node-box').click();
ok(flat(await panel.locator('h2').first().innerText()).toLowerCase() === 'individual', 'and clicking a member in the graph opens its individual editor');
const toggle = page.locator('.zoom').getByRole('button', { name: 'Enumerations' });
await toggle.click();
ok((await oneOf.count()) === 0 && (await toggle.getAttribute('aria-pressed')) === 'false' && (await turtle()).includes('owl:oneOf ( :Drama :Parasite )'), 'the lines can be hidden; the enumeration itself is untouched');
await toggle.click();
ok((await oneOf.count()) === 2, 'and shown again');

// the style editor knows them as a kind of line
await page.locator('.subgraph').getByRole('button', { name: 'Style' }).click();
const style = page.locator('.style-panel');
await style.getByRole('tab', { name: 'Edges' }).click();
await style.getByLabel('Kind of relationship').selectOption('oneOf');
const lineColour = await css(oneOf.first().locator('.edge-line'), 'stroke');
await style.getByRole('button', { name: 'Colour: Red', exact: true }).click();
await page.waitForTimeout(250);
ok((await css(oneOf.first().locator('.edge-line'), 'stroke')) !== lineColour && (await css(typeEdge.locator('.edge-line'), 'stroke')) !== (await css(oneOf.first().locator('.edge-line'), 'stroke')), 'the graph style editor has “Enumeration membership (owl:oneOf)” as a kind of line to style');
await style.getByRole('button', { name: 'Reset to default' }).click();
await style.getByRole('button', { name: 'Close the graph style panel' }).click();

// a subgraph follows them
await node('Genre').locator('.node-box').click();
await page.locator('.subgraph').getByRole('button', { name: 'Subgraph', exact: true }).click();
await page.waitForTimeout(400);
ok((await node('Drama').count()) === 1 && (await node('Parasite').count()) === 1 && (await oneOf.count()) === 2, 'a subgraph from the class reaches its members along those lines, and draws them');
await page.locator('.subgraph').getByRole('button', { name: 'Full graph' }).click();

// ---------------------------------------------------------------- an enumerated datatype
const editor = panel.locator('.enum-datatype');
const values = async () => (await editor.locator('.enum-members li code').allInnerTexts()).map(flat);
const addValue = async (value, dt = '', lang = '') => {
  await editor.getByLabel('New value', { exact: true }).fill(value);
  await editor.getByLabel('Datatype of the new value').selectOption(dt);
  if (!dt) await editor.getByLabel('Language of the new value').fill(lang);
  await editor.getByRole('button', { name: 'Add value' }).click();
};
await node('Running time : integer').locator('.node-box').click();
const range = panel.getByLabel('Datatype', { exact: true });
ok((await range.locator('optgroup').evaluateAll((gs) => gs.map((g) => g.label))).join(' | ') === 'Standard datatypes | Enumerated datatypes', 'the range of a data property is a standard datatype or an enumerated one');
await range.selectOption({ label: 'New enumerated datatype…' });
ok((await editor.count()) === 1 && (await editor.getByLabel('Name of the datatype').inputValue()) === 'New datatype', 'a new enumerated datatype is made from there, becomes the range, and is edited in place');
await editor.getByLabel('Name of the datatype').fill('Length class');
await editor.getByLabel('Name of the datatype').press('Enter');
await addValue('short');
await addValue('feature');
await addValue('90', 'xsd:integer');
await addValue('court', '', 'fr');
ok((await values()).join(' | ') === '"short" | "feature" | "90"^^xsd:integer | "court"@fr', 'its values are literals: text, typed, or with a language: ' + (await values()).join(' | '));
await addValue('ninety', 'xsd:integer');
ok(flat(await editor.locator('small.bad').innerText()).includes('is not a whole number'), 'a value that is not of the datatype it claims is refused, with the reason');
await addValue('short');
ok(flat(await editor.locator('small.bad').innerText()).includes('already one of the values') && (await values()).length === 4, 'and so is one that is there already');
ok(flat(await editor.locator('code.expression').innerText()).includes(':LengthClass a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "short" "feature" "90"^^xsd:integer "court"@fr ) ]'), 'the editor shows how it is written to RDF');
ok((await node('Running time : Length class').count()) === 1, 'the property on the canvas shows the datatype it takes its values from');
ttl = await turtle();
ok(block(ttl, ':LengthClass') === ':LengthClass a rdfs:Datatype ; rdfs:label "Length class" ; owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "short" "feature" "90"^^xsd:integer "court"@fr ) ] .' && block(ttl, ':runningTime').includes('rdfs:range :LengthClass'), 'it is exported as a datatype equivalent to a list of literals, and is the range of the property');
ok(!/:LengthClass a owl:(Class|NamedIndividual)/.test(ttl) && (await side.innerText()).includes('Classes 8'), 'it is a datatype: not a class, and not among the terms');
// another property can have the same datatype
await node('Release date : date').locator('.node-box').click();
ok((await range.locator('option').allInnerTexts()).some((o) => flat(o) === 'Length class (4 values)'), 'it is on offer as the range of other data properties too');
// an individual's value has to be one of them
await node('Parasite').locator('.node-box').click();
const values_ = panel.locator('[data-section="values"]');
const give = async (value) => {
  await values_.locator('.chip-add').click();
  await values_.getByRole('combobox').fill('Running time');
  await values_.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
  await values_.getByLabel('Value', { exact: true }).fill(value);
  await values_.getByRole('button', { name: 'Add value' }).click();
};
await give('epic');
ok(flat(await values_.locator('small.bad').innerText()).includes('is not one of the values of “Length class”'), 'an individual cannot be given a value the datatype does not list: ' + flat(await values_.locator('small.bad').innerText()).slice(0, 60));
await values_.getByLabel('Value', { exact: true }).fill('feature');
await values_.getByRole('button', { name: 'Add value' }).click();
ok(block(await turtle(), ':Parasite').includes(':runningTime "feature"'), 'one of its values is accepted, and exported as that literal');

await page.waitForTimeout(900);
await page.reload();
await page.waitForSelector('.node');
await node('Running time : Length class').locator('.node-box').click();
ok((await values()).length === 4 && (await editor.getByLabel('Name of the datatype').inputValue()) === 'Length class', 'after a reload the datatype and its values are as they were');
await node('Genre').locator('.node-box').click();
ok((await members()).join(' | ') === 'Drama :Drama | Parasite :Parasite' && (await definition.getByLabel(/Declare all members different/).isChecked()), 'after a reload the enumeration is as it was left');

// ---------------------------------------------------------------- reasoning and validation
const v = page.locator('.validation');
const settled = () => page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
// Opening the tab validates once; after a change the checks are run again by hand.
const validation = async () => { await tab(/^Validation/); await settled(); await v.getByRole('button', { name: 'Run all checks', exact: true }).click(); await settled(); };
const owl = async () => flat(await v.locator('.card', { has: page.locator('h3', { hasText: 'OWL consistency' }) }).locator('.status').innerText());
const rowTexts = async () => (await v.locator('tr.result').allInnerTexts()).map(flat);
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const zoom = page.locator('.zoom');
const dotted = async () => Number(flat(await zoom.getByRole('button', { name: /^Inferred types/ }).innerText()).match(/\((\d+)\)/)?.[1]);

await validation();
ok((await owl()) === 'Status: No contradiction found', 'with an enumeration and an enumerated datatype in it, the ontology is consistent: ' + (await owl()));
await tab('Graph');

// What a class lists are its instances. The reasoner says so; the canvas does not draw it twice.
await node('Drama').locator('.node-box').click();
const inferredTypes = flat(await panel.locator('.editor-section.inferred').first().innerText());
ok(inferredTypes.includes('Genre') && !flat(await field('Asserted types').innerText()).includes('Genre'), 'a member is an instance of its enumeration by inference, without that being stated: ' + inferredTypes.slice(0, 90));
await zoom.getByRole('button', { name: /^Inferred types/ }).click();
const withLines = await dotted();
ok((await page.locator('.edge.inferred').count()) === withLines, `inferred class memberships are drawn dotted (${withLines})`);
await zoom.getByRole('button', { name: 'Enumerations', exact: true }).click();
ok((await dotted()) === withLines + 2 && (await page.locator('.edge.one-of').count()) === 0, 'where the line of an enumeration is drawn, the membership it implies is not drawn beside it; hidden, the two memberships are dotted like the rest: ' + (await dotted()));
await zoom.getByRole('button', { name: 'Enumerations', exact: true }).click();
// The exported page is of the same picture: every line in it is a relationship the page knows, each once.
await page.locator('.header').getByRole('button', { name: 'File', exact: true }).click();
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^Interactive page/ }).click()]);
await download.saveAs(shots + 'enumerations.html');
const html = fs.readFileSync(shots + 'enumerations.html', 'utf8');
const data = JSON.parse(html.match(/<script type="application\/json" id="model-data">([\s\S]*?)<\/script>/)[1]);
const drawn = [...html.matchAll(/data-rel="([^"]+)"/g)].map((x) => x[1]);
const known = new Set(data.rels.map((r) => r.id));
const pairs = data.rels.filter((r) => r.id.startsWith('inferred:')).map((r) => `${r.to}|${r.from}`);
ok(drawn.length > 0 && drawn.every((id) => known.has(id)) && drawn.filter((id) => id.startsWith('inferred:')).length === withLines && !data.rels.some((r) => r.id.startsWith('oneof:') && pairs.includes(`${r.from}|${r.to}`)), 'the exported page has the same lines as the canvas: the enumeration’s own, and no inferred membership doubling one of them');
await zoom.getByRole('button', { name: /^Inferred types/ }).click();

// Declared all different, two members cannot be stated to be the same individual.
await node('Drama').locator('.node-box').click();
const sameAs = field('Same individuals');
await sameAs.locator('.chip-add').click();
await sameAs.getByRole('combobox').fill('Parasite');
await sameAs.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
const refusal = flat(await sameAs.innerText());
ok(refusal.includes('are members of “Genre”, whose members are declared all different') && !block(await turtle(), ':Drama').includes('owl:sameAs'), 'two members of an enumeration declared all different cannot be stated to be the same: the reason is given');
await page.keyboard.press('Escape');

// A value an individual has must be one its property's datatype lists.
await node('Running time : Length class').locator('.node-box').click();
await editor.getByRole('button', { name: 'Remove the value feature' }).click();
await validation();
const clash = (await rowTexts()).find((r) => r.includes('has the value "feature"')) ?? '';
ok((await owl()) === 'Status: Inconsistent: 1 contradiction' && clash.includes('“Parasite” has the value "feature" for “Running time”, but the values of that property are those of “Length class”'), 'a value that is no longer one of those its datatype lists is a contradiction, reported with what it rests on: ' + (await owl()));
await tab('Graph');
await node('Running time : Length class').locator('.node-box').click();
await addValue('feature');
await validation();
ok((await owl()) === 'Status: No contradiction found', 'with the value back on the list the ontology is consistent again');

// An enumeration that lists nothing is worth a look, and the rules about enumerations can be switched like the others.
await tab('Graph');
await node('Award').locator('.node-box').click();
await definition.getByLabel('Class definition').selectOption('oneOf');
await validation();
const empty = (await rowTexts()).find((r) => r.includes('Enumeration without members')) ?? '';
ok(empty.includes('“Award” is defined as an enumeration but lists no individual yet') && / Quality /.test(empty), 'an enumeration without members is a quality finding, not a contradiction: ' + empty.slice(0, 120));
await v.locator('.tabs.sub').getByRole('tab', { name: 'Quality rules' }).click();
const group = v.locator('.rules fieldset', { has: page.locator('legend', { hasText: 'Enumerations' }) });
ok((await group.locator('input[type=checkbox]').count()) === 5 && (await group.locator('input[type=checkbox]:checked').count()) === 4, 'the rules about enumerations are a group of their own: five, one of them off until asked for');
await page.screenshot({ path: shots + 'enumeration-rules.png' });
await tab('Graph');
await node('Award').locator('.node-box').click();
await definition.getByLabel('Class definition').selectOption('');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
