// Drives the built app in a headless browser to check the validation workbench.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 }, acceptDownloads: true });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
{ const proto = Object.getPrototypeOf(page.locator('body')); const orig = proto.selectOption; proto.selectOption = async function (...a) { await this.hover(); return orig.apply(this, a); }; }
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const v = page.locator('.validation');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const sub = (name) => v.locator('.tabs.sub').getByRole('tab', { name }).click();
const pick = async (name) => { await side.locator('.tree-line .label, li button', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click(); await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name); };
const field = (label, root = panel) => root.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const add = async (label, text, root = panel) => { const f = field(label, root); await f.locator('.chip-add').click(); await f.getByRole('combobox').fill(text); await f.locator('.subgraph-found button').first().dispatchEvent('pointerdown'); };
// Runs checks and waits for the run to be over.
const run = async (name) => { await v.getByRole('button', { name, exact: true }).click(); await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? '')); };
const settled = () => page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
const card = (title) => v.locator('.card', { has: page.locator('h3', { hasText: title }) });
const rows = () => v.locator('tr.result');
const rowTexts = async () => (await rows().allInnerTexts()).map(flat);
const revision = async () => flat(await v.locator('.run-state').innerText()).match(/revision (\w+)/)?.[1];
const tmp = fs.mkdtempSync('/tmp/cw-validation-');

await page.goto('http://localhost:5181/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
await side.getByRole('button', { name: 'Expand all' }).click();

// ---------------------------------------------------------------- the dashboard
await tab(/^Validation/);
await settled();
ok(/^Validated \d.* · revision [0-9a-f]{8} · \d+ entities$/.test(flat(await v.locator('.run-state').innerText())), 'opening the tab runs the checks once and says when, which revision, and how much: ' + flat(await v.locator('.run-state').innerText()));
ok((await v.locator('.card h3').allInnerTexts()).map(flat).join(' | ').toUpperCase() === 'OWL CONSISTENCY | SHACL VALIDATION | ONTOLOGY QUALITY', 'three categories, each with a card of its own');
ok(flat(await card('OWL consistency').locator('.status').innerText()) === 'Status: Consistent' && flat(await card('OWL consistency').innerText()).includes('Unsatisfiable classes: 0'), 'OWL: consistent, 0 unsatisfiable classes');
ok(flat(await card('SHACL validation').innerText()).includes('No shapes yet'), 'SHACL: nothing to validate against until there are shapes');
ok(/Warnings: \d+/.test(flat(await card('Ontology quality').innerText())) && flat(await card('Ontology quality').innerText()).includes('not errors'), 'Quality: counts, and a reminder that these are not errors');
const first = await rowTexts();
ok(first.length > 0 && first.every((r) => / Quality /.test(r)), `the sample has ${first.length} results, all of them quality diagnostics`);
await page.screenshot({ path: shots + 'validation.png' });

// filter, search, navigate
await v.getByLabel('Search results').fill('Award');
ok((await rowTexts()).length >= 1 && (await rowTexts()).every((r) => r.includes('Award')), 'searching narrows the results: ' + (await rowTexts()).join(' / '));
await v.getByLabel('Severity').selectOption('info');
await rows().filter({ hasText: 'Missing definition' }).first().click();
ok((await panel.locator('input').first().inputValue()) === 'Award', 'clicking a result opens the entity in the editor');
const detail = flat(await v.locator('tr.detail').innerText());
ok(detail.includes('Ontology quality: a modelling diagnostic, not an error in the logic') && detail.includes('About this rule') && detail.includes('Not every entity needs one'), 'the result explains its category and its rule');
await v.locator('tr.detail').getByRole('button', { name: 'Show in the graph' }).click();
ok((await page.locator('.view').count()) === 0 && (await page.locator('.node.dim').count()) > 0, 'Show in the graph goes to the canvas and spotlights the entity');
await tab(/^Validation/);
await v.getByLabel('Search results').fill('');
await v.getByLabel('Severity').selectOption('');

// ---------------------------------------------------------------- quality rules are configurable
const before = (await rowTexts()).filter((r) => r.includes('Missing definition')).length;
await sub('Quality rules');
ok((await v.locator('.rules fieldset legend').allInnerTexts()).map(flat).join(' | ') === 'Documentation | Structure | IRIs and namespaces | Modelling practice | Governance | SKOS integrity', 'rules are grouped');
ok(!(await v.locator('.rule', { hasText: 'Multiple inheritance' }).locator('input').isChecked()), 'multiple inheritance is not reported unless asked for');
const rev0 = await revision();
await v.locator('.rule', { hasText: 'Missing definition' }).locator('input').uncheck();
ok((await v.locator('.stale').count()) === 1, 'changing the rules marks the results as stale');
await run('Quality');
await sub(/^Results/);
ok(before > 0 && (await rowTexts()).filter((r) => r.includes('Missing definition')).length === 0 && (await v.locator('.stale').count()) === 0, `switching a rule off removes its ${before} results after a rerun`);
ok((await revision()) !== rev0, 'and the revision that was validated is a different one');

// ---------------------------------------------------------------- a shape, made in the form
await pick('Film');
await sub(/^SHACL shapes/);
await v.getByRole('button', { name: 'New shape' }).click();
const ed = v.locator('.shape-editor');
ok((await ed.getByLabel('Shape name').inputValue()) === 'Film' && (await field('Target classes', ed).locator('.chip-x .link').allInnerTexts()).join() === 'Film', 'a new shape starts from the selected class: named Film, targeting Film');
await ed.getByRole('button', { name: 'Add a property constraint' }).click();
ok(flat(await ed.locator('.shape-prop [role=alert]').innerText()).includes('Choose the property'), 'a constraint without a property says what is missing');
const prop = ed.locator('.shape-prop').first();
await prop.locator('.chip-add').first().click();
await prop.getByLabel('Search for a property').fill('Release');
await prop.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await prop.getByLabel('Minimum count of Release date').fill('1');
await prop.getByLabel('Minimum count of Release date').blur();
await prop.getByLabel('Maximum count of Release date').fill('1');
await prop.getByLabel('Maximum count of Release date').blur();
await prop.getByLabel('Datatype of Release date').selectOption('xsd:date');
const shacl = await ed.locator('.shape-preview').innerText();
ok(shacl.includes(':FilmShape a sh:NodeShape') && shacl.includes('sh:targetClass :Film') && /sh:property \[\s+sh:path :releaseDate ;\s+sh:datatype xsd:date ;\s+sh:minCount 1 ;\s+sh:maxCount 1\s+\]/.test(shacl), 'the form writes the SHACL: ' + flat(shacl).slice(0, 200));
await page.screenshot({ path: shots + 'validation-shape.png' });
await tab('RDF');
ok(!(await page.locator('.rdf-code').innerText()).includes('sh:'), 'the shape is not part of the ontology’s RDF');
await tab(/^Validation/);

await run('SHACL');
ok(flat(await card('SHACL validation').innerText()).includes('Does not conform') && flat(await card('SHACL validation').innerText()).includes('Violations: 1'), 'SHACL: the data does not conform, 1 violation');
await sub(/^Results/);
await v.getByLabel('Category').selectOption('shacl');
const sh = await rowTexts();
ok(sh.length === 1 && sh[0].startsWith('Error SHACL Parasite individual MinCount'), 'the violation names the individual: ' + sh[0]);
await rows().first().click();
ok((await panel.locator('input').first().inputValue()) === 'Parasite', 'and clicking it opens that individual');
const d = flat(await v.locator('tr.detail').innerText());
ok(['sh:focusNode :Parasite', 'sh:resultPath :releaseDate', 'sh:sourceShape a property shape of :FilmShape', 'sh:sourceConstraintComponent sh:MinCountConstraintComponent', 'sh:resultSeverity sh:Violation'].every((x) => d.includes(x)) && d.includes('sh:value not given'), 'the standard report fields are shown, and a field the engine did not give is said to be absent');
await page.screenshot({ path: shots + 'validation-shacl.png' });

// fix the data; the results go stale; rerun
const values = panel.locator('[data-section=values]');
await values.locator('.chip-add').click();
await values.getByRole('combobox').fill('Release');
await values.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await values.getByLabel('Value', { exact: true }).fill('2019-05-30');
await values.getByRole('button', { name: 'Add value' }).click();
ok((await v.locator('.stale').count()) === 1 && (await v.locator('.results.is-stale').count()) === 1, 'editing the model marks the results stale instead of silently keeping them');
await run('SHACL');
ok(flat(await card('SHACL validation').locator('.status').innerText()) === 'Status: Conforms' && (await rowTexts()).length === 0, 'after giving Parasite a release date the data conforms');
ok(flat(await card('OWL consistency').innerText()).includes('Not run for this revision'), 'a category that was not rerun on the changed model is shown as not run, not as current');
await v.getByLabel('Category').selectOption('');

// ---------------------------------------------------------------- OWL: unsatisfiable, then inconsistent
await pick('Film');
await add('Disjoint classes', 'Person');
await pick('Documentary');
await add('Asserted superclasses', 'Person');
await run('Run all checks');
ok(flat(await card('OWL consistency').locator('.status').innerText()) === 'Status: Consistent' && flat(await card('OWL consistency').innerText()).includes('Unsatisfiable classes: 1'), 'a class under two disjoint classes: the ontology is still consistent, with 1 unsatisfiable class');
await v.getByLabel('Category').selectOption('owl');
ok((await rowTexts()).join(' / ').startsWith('Error OWL Documentary class Unsatisfiable class'), 'it is reported as an unsatisfiable class: ' + (await rowTexts()).join(' / '));
await tab('Entities');
await page.locator('.view').getByRole('tab', { name: /Individuals/ }).click();
await page.locator('.view tbody tr', { has: page.locator('input[value="Parasite"]') }).locator('.chip-add').click();
await page.locator('.view').getByRole('combobox').fill('Documentary');
await page.locator('.view .subgraph-found button').first().dispatchEvent('pointerdown');
await tab(/^Validation/);
ok((await v.locator('.stale').count()) === 1, 'coming back after an edit elsewhere, the results are marked stale');
await run('OWL');
ok(flat(await card('OWL consistency').locator('.status').innerText()).startsWith('Status: Inconsistent: 1 contradiction'), 'once an individual is put in that class the ontology is inconsistent: ' + flat(await card('OWL consistency').locator('.status').innerText()));
await rows().filter({ hasText: 'Inconsistent ontology' }).first().click();
const why = flat(await v.locator('tr.detail').innerText());
ok(why.includes('Justification The reasoner derives this from:') && why.includes('is disjoint with') && why.includes('“Parasite” is an instance of “Documentary”'), 'with the reasoner’s justification: ' + why.match(/derives this from: (.*?)\. /)?.[1]);
await page.screenshot({ path: shots + 'validation-owl.png' });
for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Undo' }).click();
await run('Run all checks');
ok(flat(await card('OWL consistency').innerText()).includes('Unsatisfiable classes: 0') && flat(await card('OWL consistency').locator('.status').innerText()) === 'Status: Consistent', 'undoing the three edits and rerunning: consistent again');
await v.getByLabel('Category').selectOption('');

// ---------------------------------------------------------------- a quick fix shows the change first
await pick('Award');
await panel.locator('input').first().fill('');
await panel.locator('input').first().blur();
await run('Quality');
await rows().filter({ hasText: 'Missing label' }).first().click();
ok((await v.locator('.fix-preview').count()) === 0, 'a fix is offered but nothing is changed or shown as changed yet');
await v.locator('tr.detail').getByRole('button', { name: /^Name it “Award”/ }).click();
ok(flat(await v.locator('.fix-preview').innerText()).includes('Sets the label (rdfs:label) to “Award”, taken from the last part of its IRI') && flat(await v.locator('.fix-preview').innerText()).includes('The IRI is not changed'), 'the proposed change is spelled out before it is made');
await v.locator('.fix-preview').getByRole('button', { name: 'Apply this change' }).click();
await settled();
ok((await rowTexts()).filter((r) => r.includes('Missing label')).length === 0 && (await side.locator('.name', { hasText: /^Award$/ }).count()) >= 1, 'applying it names the class and the results are brought up to date');
await page.getByRole('button', { name: 'Undo' }).click();
ok((await side.locator('.name', { hasText: /^Award$/ }).count()) === 0, 'the fix is one undo step');
await page.getByRole('button', { name: 'Redo' }).click();

// ---------------------------------------------------------------- import and export
fs.writeFileSync(tmp + '/more.ttl', `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix : <http://example.org/film-knowledge-graph#> .
:GenreShape a sh:NodeShape ; sh:targetClass :Genre ; sh:property [ sh:path :belongsTo ; sh:maxCount 0 ; sh:severity sh:Warning ] .
:EitherShape a sh:NodeShape ; sh:targetClass :Film ; sh:or ( [ sh:path :releaseDate ; sh:minCount 1 ] [ sh:path :runningTime ; sh:minCount 1 ] ) .`);
await sub(/^SHACL shapes/);
await v.locator('.shape-list input[type=file]').setInputFiles(tmp + '/more.ttl');
await page.waitForFunction(() => /Imported from/.test(document.querySelector('.toast')?.textContent ?? ''));
ok(flat(await page.locator('.toast').innerText()).includes('1 shape you can edit here, 1 kept as Turtle (:EitherShape: uses sh:or on a node shape)'), 'importing: what the form can show becomes editable, the rest is kept as Turtle, and it says which and why: ' + flat(await page.locator('.toast').innerText()));
ok((await v.locator('.shape-list li strong').allInnerTexts()).join(' | ') === 'Film | GenreShape | Shapes as Turtle', 'both editable shapes are listed');
await v.locator('.shape-list li button', { hasText: 'Shapes as Turtle' }).click();
ok((await v.locator('.shapes-text').inputValue()).includes('sh:or'), 'the kept shape is there as Turtle');
await v.locator('.shapes-text').fill('this is not turtle');
ok((await v.locator('.shape-editor [role=alert]').count()) === 1 && (await v.getByRole('button', { name: 'Save the Turtle' }).isDisabled()), 'Turtle that does not parse cannot be saved, and says why');
await v.getByRole('button', { name: 'Discard changes' }).click();
const [shapesFile] = await Promise.all([page.waitForEvent('download'), v.getByRole('button', { name: 'Export', exact: true }).click()]);
await shapesFile.saveAs(tmp + '/shapes.ttl');
const exported = fs.readFileSync(tmp + '/shapes.ttl', 'utf8');
ok(exported.includes(':FilmShape a sh:NodeShape') && exported.includes(':GenreShape a sh:NodeShape') && exported.includes('sh:or'), 'shapes export as one Turtle file with all three');

// imported data as the data graph
fs.writeFileSync(tmp + '/data.ttl', `@prefix : <http://example.org/film-knowledge-graph#> . @prefix d: <http://data.example/> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
d:f1 a :Documentary .
d:f2 a :Film ; :releaseDate "yesterday" .`);
await v.locator(':scope > input[type=file]').setInputFiles(tmp + '/data.ttl');
await page.waitForFunction(() => document.querySelector('.data-graph select')?.value === 'imported');
ok((await v.locator('.stale').count()) === 1, 'choosing other data to validate makes the results stale');
await run('SHACL');
await sub(/^Results/);
await v.getByLabel('Category').selectOption('shacl');
const ext = await rowTexts();
ok(ext.some((r) => r.includes('<http://data.example/f1> data') && r.includes('Or')) && ext.some((r) => r.includes('<http://data.example/f2> data') && r.includes('Datatype')), 'imported data is validated, a subclass instance included; its nodes are marked as data, not model entities: ' + ext.join(' / '));
ok(flat(await card('SHACL validation').innerText()).includes('from data.ttl'), 'the card says which data was validated');
await tab('Entities');
ok((await page.locator('.view tbody tr').count()) > 0 && !(await page.locator('.view').innerText()).includes('data.example'), 'the imported data is not added to the model');
await tab(/^Validation/);
await v.getByLabel('Data to validate').selectOption('model');
await run('Run all checks');
const [reportFile] = await Promise.all([page.waitForEvent('download'), v.getByRole('button', { name: 'Report (JSON)' }).click()]);
await reportFile.saveAs(tmp + '/report.json');
const report = JSON.parse(fs.readFileSync(tmp + '/report.json', 'utf8'));
ok(report.owl.status === 'consistent' && typeof report.revision === 'string' && Array.isArray(report.findings) && report.dataGraph.includesOntologyTriples === true, 'the report downloads as JSON with status, revision, data graph and findings');
const [rdfFile] = await Promise.all([page.waitForEvent('download'), v.getByRole('button', { name: 'Report (RDF)' }).click()]);
await rdfFile.saveAs(tmp + '/report.ttl');
ok(fs.readFileSync(tmp + '/report.ttl', 'utf8').includes('sh:ValidationReport') && fs.readFileSync(tmp + '/report.ttl', 'utf8').includes('cw:ValidationRun'), 'and as RDF, with the standard SHACL report');

// ---------------------------------------------------------------- shapes are saved with the model
await page.getByRole('button', { name: 'Save', exact: true }).first().click();
await page.locator('.dialog.saveas input').fill('Validation test');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await page.getByRole('button', { name: 'File', exact: true }).click();
await page.getByRole('menuitem', { name: 'Load the SKOS example' }).click();
await tab(/^Validation/);
await settled();
ok(flat(await card('OWL consistency').innerText()).includes('no OWL axioms to contradict') && flat(await v.locator('.tabs.sub').innerText()).includes('SHACL shapes (0)'), 'another model has its own validation: a concept scheme has no OWL consistency, and no shapes');
await page.getByRole('button', { name: 'My Models' }).click();
await page.locator('.dialog.library').getByRole('button', { name: /^Open/ }).first().click();
await page.waitForSelector('.node');
await tab(/^Validation/);
await settled();
await sub(/^SHACL shapes/);
ok((await v.locator('.shape-list li strong').allInnerTexts()).join(' | ') === 'Film | GenreShape | Shapes as Turtle' && flat(await v.locator('.shape-list').innerText()).includes('1 shape kept as written'), 'reopened from My Models, the shapes are all there');
await sub('Quality rules');
ok(!(await v.locator('.rule', { hasText: 'Missing definition' }).locator('input').isChecked()), 'and so is the choice of quality rules');
await sub('Inferred facts');
ok(flat(await v.locator('.issues .note').first().innerText()).startsWith('What the reasoner derives from the model'), 'the reasoner’s inferred facts have a tab of their own');
await tab('Entities');
await page.locator('.view').getByRole('tab', { name: /Individuals/ }).click();
await page.locator('.view tbody tr', { has: page.locator('input[value="Parasite"]') }).locator('.chip-add').click();
await page.locator('.view').getByRole('combobox').fill('Documentary');
await page.locator('.view .subgraph-found button').first().dispatchEvent('pointerdown');
await page.locator('.view tbody tr', { has: page.locator('input[value="Parasite"]') }).getByRole('button', { name: 'Remove type Film' }).click();
await tab(/^Validation/);
ok((await v.locator('.issue.inference', { hasText: '“Parasite” is an instance of “Film”' }).count()) === 1, 'and list what follows: a Documentary is inferred to be a Film');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
