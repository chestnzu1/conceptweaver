// Drives the built app in a headless browser to check ontology reuse and alignment.
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
const side = page.locator('.term-list');
const v = page.locator('.alignment');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const sub = (name) => v.locator('.view-head .tabs').getByRole('tab', { name }).click();
const rdf = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Align'); return ttl; };
const block = (ttl, s) => ttl.split('\n\n').find((b) => b.startsWith(s + ' ')) ?? '';
const toast = async () => flat(await page.locator('.toast').innerText());
const mappingRows = async () => (await v.locator('.mappings tbody tr').evaluateAll((trs) => trs.map((tr) => `${tr.cells[0].querySelector('.link').textContent} ${tr.cells[1].querySelector('select').value} ${tr.cells[2].querySelector('.link').textContent}`)));
const rowOf = async (pred) => v.locator('.mappings tbody tr').nth((await mappingRows()).findIndex((r) => r.includes(' ' + pred + ' ')));
const tmp = fs.mkdtempSync('/tmp/cw-align-');
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

await page.goto(base);
await page.evaluate(async () => { localStorage.clear(); await new Promise((r) => { const q = indexedDB.deleteDatabase('conceptweaver'); q.onsuccess = q.onerror = q.onblocked = r; }); });
await page.reload();
await page.waitForSelector('.node');
await tab('Align');

// ---------------------------------------------------------------- phase 1: the library
ok(flat(await v.innerText()).includes('No other ontologies yet'), 'the library starts empty');
// a file that cannot be read is refused, saying why: RDF/XML is read (see e2e/open-owl.mjs), but this one is cut short, and the next has nothing in it
fs.writeFileSync(tmp + '/x.owl', '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><owl:Class');
await v.locator('.add-ontology input[type=file]').setInputFiles(tmp + '/x.owl');
await page.waitForFunction(() => /could not be read/.test(document.querySelector('.add-ontology [role=alert]')?.textContent ?? ''));
ok(flat(await v.locator('.add-ontology [role=alert]').innerText()).startsWith('x.owl could not be read. It is not well-formed RDF/XML:'), 'a file that is not well-formed is refused, saying what is wrong with it');
fs.writeFileSync(tmp + '/empty.owl', '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>');
await v.locator('.add-ontology input[type=file]').setInputFiles(tmp + '/empty.owl');
await page.waitForFunction(() => /No classes/.test(document.querySelector('.add-ontology [role=alert]')?.textContent ?? ''));
ok(flat(await v.locator('.add-ontology [role=alert]').innerText()).includes('No classes, properties or individuals were found in it'), 'and so is one with no ontology in it');
// a URL that cannot be fetched
await v.getByRole('button', { name: 'From a URL…' }).click();
await v.getByLabel('Ontology URL').fill('http://localhost:1/none.ttl');
await v.getByRole('button', { name: 'Fetch', exact: true }).click();
await page.waitForFunction(() => /could not be fetched/.test(document.querySelector('.add-ontology [role=alert]')?.textContent ?? ''));
ok(flat(await v.locator('.add-ontology [role=alert]').innerText()).includes('add it as a file instead'), 'a URL that cannot be fetched gives a clear error and points to file import');
await v.getByRole('button', { name: 'From a URL…' }).click();
// the preview before anything is added
await v.locator('.add-ontology input[type=file]').setInputFiles(tmp + '/people.ttl');
const dlg = page.locator('.ext-preview');
const summary = flat(await dlg.innerText());
ok(['People Ontology', 'Ontology IRI http://example.org/people', 'Version IRI http://example.org/people/2.1', 'Classes 7', 'Object properties 1', 'Individuals 1'].every((x) => summary.includes(x)), 'a summary is shown before anything is added: name, ontology IRI, version, counts');
ok((await dlg.getByRole('button').allInnerTexts()).map(flat).join(' | ') === 'Reference ontology | Import axioms… | Cancel' && (await v.locator('.ontologies li').count()) === 0, 'with the choice to reference it, import axioms, or cancel; nothing is added yet');
await page.screenshot({ path: shots + 'align-preview.png' });
await dlg.getByRole('button', { name: 'Reference ontology' }).click();
ok(flat(await v.locator('.ontologies li').innerText()).includes('People Ontology') && flat(await v.locator('.ontologies li').innerText()).includes('dependency · owl:imports'), 'referenced: it is in the library as a dependency');
const facts = flat(await v.locator('.ontology-facts').innerText());
ok(facts.includes('Namespace http://example.org/people#') && facts.includes('people.ttl (file)') && facts.includes('7 classes · 1 object properties') && facts.includes('Used here not yet'), 'the library shows IRI, version, namespace, source, date, entity counts and use: ' + facts.slice(0, 140));
let ttl = await rdf();
ok(block(ttl, '<http://example.org/film-knowledge-graph>').includes('owl:imports <http://example.org/people>') && !/ppl:[A-Za-z]/.test(ttl.split('\n\n').slice(1).join('\n')), 'the ontology now imports it by IRI, and none of its content is merged in');
ok((await side.locator('.tree-line').count()) === 9, 'the class hierarchy still has only the local classes');
// browse and search
const list = v.locator('.ontology-detail .entity-list');
ok((await list.locator('li .name').allInnerTexts()).join(',') === 'Agent,Organisation,Person,Director,Performer,Prize,Work', 'its classes are browsable as a hierarchy: ' + (await list.locator('li .name').allInnerTexts()).join(','));
await list.getByRole('searchbox').fill('human being');
ok((await list.locator('li .name').allInnerTexts()).join(',') === 'Person', 'search finds an entity by its definition');
await list.getByRole('searchbox').fill('people#Perf');
ok((await list.locator('li .name').allInnerTexts()).join(',') === 'Performer', 'and by its IRI');
await list.getByRole('searchbox').fill('');

// ---------------------------------------------------------------- phase 2: reuse
await v.getByRole('button', { name: 'Reuse Organisation' }).click();
ok((await toast()).includes('keeps its IRI http://example.org/people#Organisation'), 'reusing says the entity keeps its own IRI');
ok(flat(await list.locator('li', { hasText: 'Organisation' }).innerText()).includes('referred to'), 'and the library marks it as referred to');
await tab('Graph');
ok((await page.locator('.node.external').count()) === 1 && (await page.locator('.node.external .node-text').textContent()) === 'Organisation', 'on the canvas the external class is drawn differently from local ones');
await side.locator('.tree-line .label', { has: page.locator('.name', { hasText: /^Studio$/ }) }).click();
const supers = panel.locator('.field', { has: page.locator(':scope > span:has-text("Asserted superclasses")') });
await supers.locator('.chip-add').click();
await supers.getByRole('combobox').fill('Organis');
ok(flat(await supers.locator('.subgraph-found button').first().innerText()) === 'Organisation ppl:Organisation external', 'the superclass selector offers it, marked external, with its own IRI: ' + flat(await supers.locator('.subgraph-found button').first().innerText()));
await supers.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await page.locator('.node.external').click();
ok(flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'external class' && flat(await panel.locator('.external-note').innerText()).includes('Defined in People Ontology'), 'its editor says it is external and where it is defined');
ok(flat(await panel.locator('.iri-parts').innerText()).includes('ppl:Organisation') && flat(await panel.locator('.iri-parts').innerText()).includes('http://example.org/people#'), 'and shows its original IRI, not a local one');
await page.screenshot({ path: shots + 'align-reuse.png' });
await tab('Align');
ttl = await rdf();
ok(/rdfs:subClassOf .*ppl:Organisation/.test(block(ttl, ':Studio')) && block(ttl, 'ppl:Organisation').trim() === 'ppl:Organisation a owl:Class .', 'exported as a reference: the subclass axiom, and only a declaration of the external class');

// copy with definition
await v.getByLabel('Select Performer to copy').check();
await v.getByRole('button', { name: /^Copy selected \(1\)/ }).click();
ok((await toast()).includes('Copied 1 entity with their definitions; they are now yours to maintain') && (await toast()).includes('kept as references'), 'copying says the copy is now locally maintained: ' + (await toast()));
ttl = await rdf();
ok(block(ttl, 'ppl:Performer').includes('rdfs:label "Performer"') && block(ttl, 'ppl:Performer').includes('owl:onProperty ppl:performsIn') && block(ttl, 'ppl:Person').trim() === 'ppl:Person a owl:Class .', 'the copy has its definition under its original IRI; what it refers to stays a reference');
await page.getByRole('button', { name: 'Undo' }).click();
ok(!(await rdf()).includes('ppl:Performer'), 'undo takes the copy back out');

// ---------------------------------------------------------------- phase 3: mappings
await sub('Align');
const [mine, theirs] = [v.locator('.sides section').nth(0), v.locator('.sides section').nth(1)];
ok((await mine.locator('li .name').allInnerTexts()).includes('Person') && !(await mine.locator('li .name').allInnerTexts()).includes('Organisation') && (await theirs.locator('li .name').allInnerTexts()).join(',') === 'Agent,Organisation,Person,Director,Performer,Prize,Work', 'side by side: your classes on the left (without the external reference), theirs on the right');
await mine.getByRole('searchbox').fill('Person');
await mine.locator('li .pick', { hasText: 'Person' }).first().click();
await theirs.locator('li .pick', { has: page.locator('.name', { hasText: /^Person$/ }) }).click();
const form = v.locator('.mapping-form');
ok(flat(await form.locator('.pair').innerText()).includes('http://example.org/film-knowledge-graph#Person') && flat(await form.locator('.pair').innerText()).includes('http://example.org/people#Person') && flat(await form.locator('.pair').innerText()).includes('A human being.'), 'the selected pair is shown with IRIs and descriptions');
ok(await form.getByRole('button', { name: 'Create mapping' }).isDisabled(), 'no relationship is chosen by default, so nothing can be created yet');
const options = (await form.getByLabel('Mapping relationship').locator('option').allInnerTexts()).join(',');
ok(options === 'choose…,owl:equivalentClass,rdfs:subClassOf,owl:disjointWith,skos:exactMatch,skos:closeMatch,skos:broadMatch,skos:narrowMatch,skos:relatedMatch', 'for classes the class predicates are offered, not owl:sameAs: ' + options);
await form.getByLabel('Mapping relationship').selectOption('owl:equivalentClass');
ok(flat(await form.locator('.statement').innerText()) === ':Person owl:equivalentClass ppl:Person', 'the statement about to be made is spelled out: ' + flat(await form.locator('.statement').innerText()));
await page.screenshot({ path: shots + 'align-editor.png' });
await form.getByRole('button', { name: 'Create mapping' }).click();
await form.getByLabel('Mapping relationship').selectOption('owl:equivalentClass');
await form.getByRole('button', { name: 'Create mapping' }).click();
ok(flat(await form.locator('[role=alert]').innerText()).includes('already stated'), 'the same mapping a second time is refused');
// a directed one, the other way round
await mine.getByRole('searchbox').fill('Actor');
await mine.locator('li .pick', { hasText: 'Actor' }).first().click();
await theirs.locator('li .pick', { has: page.locator('.name', { hasText: /^Performer$/ }) }).click();
await form.getByLabel('Mapping relationship').selectOption('rdfs:subClassOf');
await form.getByRole('button', { name: /Swap direction/ }).click();
ok(flat(await form.locator('.statement').innerText()) === 'ppl:Performer rdfs:subClassOf :Actor', 'direction can be swapped for a directed relationship: ' + flat(await form.locator('.statement').innerText()));
await form.getByRole('button', { name: 'Create mapping' }).click();
await form.getByRole('button', { name: /Swap direction/ }).click();
// a second mapping for the same local entity, with a SKOS predicate
await form.getByLabel('Mapping relationship').selectOption('skos:closeMatch');
await form.getByRole('button', { name: 'Create mapping' }).click();
ok(flat(await mine.locator('li', { hasText: 'Actor' }).first().innerText()).includes('2 mapped'), 'mapped entities are marked in the lists, with how many mappings');

await sub(/^Mappings/);
let rows = await mappingRows();
ok(rows.join(' | ') === ':Studio rdfs:subClassOf ppl:Organisation | :Person owl:equivalentClass ppl:Person | ppl:Performer rdfs:subClassOf :Actor | :Actor skos:closeMatch ppl:Performer', 'all mappings are listed in the direction stated, the reuse as superclass included: ' + rows.join(' | '));
ok(flat(await v.locator('.check-result').innerText()).startsWith('No contradiction found by the fast reasoner.') && flat(await v.locator('.check-result').innerText()).includes('together with the 1 it imports'), 'the reasoner checks them together with the imported ontology: consistent');
// governance
const row = await rowOf('owl:equivalentClass');
await row.getByLabel(/^Status of/).selectOption('approved');
await row.getByLabel(/^Comment on/).fill('Both classes represent persons.');
await row.getByLabel(/^Comment on/).blur();
ttl = await rdf();
ok(block(ttl, ':Person').includes('owl:equivalentClass ppl:Person') && block(ttl, ':Actor').includes('skos:closeMatch ppl:Performer') && !ttl.includes('Both classes represent'), 'the mappings are axioms in the RDF; the review notes are kept apart from it');
await page.screenshot({ path: shots + 'align-mappings.png' });

// export, with and without metadata; then import into the same model: no duplicates
const save = async (name) => { const [d] = await Promise.all([page.waitForEvent('download'), v.getByRole('button', { name: 'Export mappings' }).click()]); await d.saveAs(tmp + '/' + name); return fs.readFileSync(tmp + '/' + name, 'utf8'); };
const plain = await save('m.ttl');
ok(plain.includes(':Person owl:equivalentClass ppl:Person .') && plain.includes('ppl:Performer rdfs:subClassOf :Actor .') && plain.includes(':Actor skos:closeMatch ppl:Performer .') && !plain.includes('owl:Class') && !plain.includes('rdfs:label'), 'mappings export by themselves: one triple each, original IRIs, direction kept, nothing else');
await v.getByLabel('with metadata').check();
const rich = await save('m-meta.ttl');
ok(rich.includes('owl:annotatedProperty owl:equivalentClass') && rich.includes('cw:status "approved"') && rich.includes('rdfs:comment "Both classes represent persons."'), 'with metadata: status and comment as annotations on the axiom');
await v.locator('.mappings > input[type=file]').setInputFiles(tmp + '/m-meta.ttl');
await page.waitForFunction(() => /already there/.test(document.querySelector('.toast')?.textContent ?? ''));
ok((await toast()).includes('0 mappings added, 4 already there'), 'importing them again adds no duplicates: ' + (await toast()));

// remove one, import brings it back with its notes
await v.getByRole('button', { name: 'Remove mapping Person owl:equivalentClass Person' }).click();
ok((await mappingRows()).length === 3, 'a mapping can be removed');
await v.locator('.mappings > input[type=file]').setInputFiles(tmp + '/m-meta.ttl');
await page.waitForFunction(() => document.querySelectorAll('.mappings tbody tr').length === 4);
rows = await mappingRows();
ok(rows.length === 4 && (await toast()).includes('1 mapping added, 3 already there') && (await (await rowOf('owl:equivalentClass')).getByLabel(/^Comment on/).inputValue()) === 'Both classes represent persons.', 'importing restores it, with its status and comment: ' + rows.length + ' / ' + (await toast()) + ' / ' + (await (await rowOf('owl:equivalentClass')).getByLabel(/^Comment on/).inputValue()));
// editing the relationship
await (await rowOf('skos:closeMatch')).getByLabel(/^Relationship of/).selectOption('skos:exactMatch');
ok((await mappingRows()).some((r) => r === ':Actor skos:exactMatch ppl:Performer'), 'the relationship of a mapping can be changed');

// ---------------------------------------------------------------- phase 4: validation of mappings, suggestions
// Studio is a kind of ppl:Organisation, which the imported ontology says is disjoint with ppl:Person, equivalent to Person.
await tab('Graph');
await side.getByRole('button', { name: 'Expand all' }).click();
await side.locator('.tree-line .label', { has: page.locator('.name', { hasText: /^Studio$/ }) }).click();
await supers.locator('.chip-add').click();
await supers.getByRole('combobox').fill('Person');
await supers.locator('.subgraph-found button', { hasText: ':Person' }).first().dispatchEvent('pointerdown');
await tab('Align');
const res = flat(await v.locator('.check-result').innerText());
ok(res.startsWith('No contradiction found, but 1 class can never have a member.') && res.includes('“Studio” can never have instances') && res.includes('“Organisation” is disjoint with “Person”'), 'a contradiction that only arises through the mappings and the imported ontology is found, with the reasoner’s justification');
await tab(/^Validation/);
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
await page.locator('.validation').getByRole('button', { name: 'OWL', exact: true }).click();
await page.waitForFunction(() => /Unsatisfiable classes: 1/.test(document.querySelector('.validation .card')?.textContent ?? ''));
ok(true, 'the Validation tab reasons over the imports too and reports the same unsatisfiable class');
await page.getByRole('button', { name: 'Undo' }).click();
await tab('Align');
ok(flat(await v.locator('.check-result').innerText()).startsWith('No contradiction found by the fast reasoner.'), 'undoing that statement makes it consistent again');

await sub('Suggestions');
ok((await v.locator('.suggestions table').count()) === 0, 'suggestions are only looked for when asked');
await v.getByRole('button', { name: 'Find candidates' }).click();
const sug = (await v.locator('.suggestions tbody tr').allInnerTexts()).map(flat);
ok(sug.some((r) => r.startsWith('Director class Director ppl:Director 0.9') && r.includes('same label “Director”')) && sug.some((r) => r.startsWith('Award class Prize ppl:Prize 0.85') && r.includes('“Award” is an alternative label of one and the label of the other')) && !sug.some((r) => r.startsWith('Person class Person') || r.startsWith('Studio')), 'candidates come with a score and the reason; pairs already mapped are not suggested: ' + sug.join(' / '));
const before = (await rdf());
await sub('Suggestions');
const cand = v.locator('.suggestions tbody tr', { hasText: /Director\s*class\s*Director/ }).first();
ok(await cand.getByRole('button', { name: 'Accept' }).isDisabled(), 'a suggestion cannot be accepted without choosing the relationship: nothing is assumed to be an equivalence');
await cand.getByLabel(/^Relationship for/).selectOption('skos:closeMatch');
await cand.getByRole('button', { name: 'Accept' }).click();
ok((await v.locator('.suggestions tbody tr', { hasText: /Director\s*class\s*Director/ }).count()) === 0, 'once accepted it leaves the suggestions');
const other = v.locator('.suggestions tbody tr').first();
const otherText = flat(await other.innerText());
await other.getByRole('button', { name: 'Reject' }).click();
await v.getByRole('button', { name: 'Find candidates' }).click();
ok(!(await v.locator('.suggestions tbody tr').allInnerTexts()).map(flat).includes(otherText) && (await v.getByRole('button', { name: /Bring back the 1 rejected/ }).count()) === 1, 'a rejected suggestion is not offered again, and can be brought back');
await sub(/^Mappings/);
const accepted = await rowOf('skos:closeMatch');
ok(flat(await accepted.locator('td').nth(3).innerText()).startsWith('suggested 0.9'), 'the accepted mapping records that it came from a suggestion, and its similarity: ' + flat(await accepted.locator('td').nth(3).innerText()));
ok(before !== (await rdf()), 'and only now is it in the RDF');

// ---------------------------------------------------------------- phase 5: graph
await sub(/^Mappings/);
await v.getByRole('button', { name: 'Show all in the graph' }).click();
const nodes = (await page.locator('.node .node-text').allTextContents()).sort().join(',');
ok(nodes === 'Actor,Director,Director,Organisation,Performer,Person,Person,Studio' && (await page.locator('.node.external').count()) === 4, 'the graph can show only the mappings: the mapped entities, local and external, and nothing else: ' + nodes);
ok((await page.locator('.edge-label').allTextContents()).some((t) => t.includes('owl:equivalentClass')) && (await page.locator('.edge-label').allTextContents()).some((t) => t.includes('skos:')), 'mapping edges are labelled with their relationship');
await page.screenshot({ path: shots + 'align-graph.png' });
await page.getByLabel('What the graph shows').selectOption('local');
ok((await page.locator('.node.external').count()) === 0 && (await page.locator('.node').count()) === 11, 'or only the local ontology');
await page.getByLabel('What the graph shows').selectOption('all');
ok((await page.locator('.node').count()) === 15, 'or everything: 11 local terms and the 4 external references, not the whole imported ontology');
await tab('Align');
await (await rowOf('owl:equivalentClass')).getByRole('button', { name: 'Graph' }).click();
ok((await page.locator('.subgraph .tabs .on').innerText()).trim() === 'Subgraph' && (await page.locator('.node.external .node-text').allTextContents()).includes('Person'), 'one mapping can be explored as a subgraph around its two entities');
await page.locator('.subgraph').getByRole('button', { name: 'Full graph' }).click();

// ---------------------------------------------------------------- persistence
await page.getByRole('button', { name: 'Save', exact: true }).first().click();
await page.locator('.dialog.saveas input').fill('Aligned films');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await page.reload();
await page.waitForSelector('.node');
await tab('Align');
await sub(/^Mappings/);
rows = await mappingRows();
ok(rows.length === 5 && (await (await rowOf('owl:equivalentClass')).getByLabel(/^Comment on/).inputValue()) === 'Both classes represent persons.', 'after a reload the mappings and their notes are there: ' + rows.length);
await sub(/^Ontology library/);
await page.waitForFunction(() => document.querySelectorAll('.ontology-detail .entity-list li .name').length === 7);
ok((await v.locator('.stale').count()) === 0, 'and the external ontology’s content comes back from the browser’s cache');
ok(flat(await v.locator('.ontology-facts').innerText()).includes('4 of its entities referred to'), 'the library counts how the ontology is used');
await v.getByRole('button', { name: 'Remove from the library' }).click();
ok(flat(await v.locator('.ontology-detail [role=alert]').innerText()).includes('still refer to entities of “People Ontology”'), 'a dependency that is in use cannot be removed, and it says why');
// the cache gone (another browser): nothing is lost, and it says so
await page.evaluate(async () => { await new Promise((r) => { const q = indexedDB.open('conceptweaver'); q.onsuccess = () => { const t = q.result.transaction('externals', 'readwrite'); t.objectStore('externals').clear(); t.oncomplete = () => { q.result.close(); r(); }; }; }); });
await page.reload();
await page.waitForSelector('.node');
await tab('Align');
await page.waitForSelector('.alignment .stale');
ok(flat(await v.locator('.stale').innerText()).includes('is not in this browser') && flat(await v.locator('.stale').innerText()).includes('The references and mappings are kept'), 'when the external ontology cannot be found, there is a warning');
await sub(/^Mappings/);
ok((await mappingRows()).length === 5, 'and no mapping is dropped');
await v.locator('.add-ontology input[type=file]').setInputFiles(tmp + '/people.ttl');
await page.locator('.ext-preview').getByRole('button', { name: 'Reference ontology' }).click();
await sub(/^Ontology library/);
ok((await v.locator('.ontologies li').count()) === 1 && (await v.locator('.stale').count()) === 0, 'adding the file again restores the same library entry rather than making a second');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
