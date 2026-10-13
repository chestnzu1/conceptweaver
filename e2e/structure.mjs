// Drives the built app in a headless browser to check the Structure Explorer: its three modes, the
// asserted and the inferred hierarchy read through the structure service, what it says of the class
// in focus, two classes set side by side, the hierarchy in numbers, and the ways from it to the rest
// of the app. The OWL 2 DL reasoner's part in it is checked in dl-reasoning.mjs, which has a
// reasoning service to ask.
// Needs a server:  pnpm build && pnpm exec vite preview --port 5181   (or pass another base URL)
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
// A request to a reasoning service that is not running is reported by the browser itself; that one is expected here.
page.on('console', (m) => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const view = page.locator('.view.structure');
const side = page.locator('.term-list');
const inspector = page.locator('.inspector');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const file = async (item) => { await page.getByRole('button', { name: 'File', exact: true }).click(); await page.getByRole('menuitem', { name: item }).click(); };
const bulkRel = async (text) => { await page.getByRole('button', { name: 'Bulk add' }).click(); await page.getByRole('tab', { name: '2. Relationships' }).click(); await page.locator('.dialog textarea').fill(text); await page.getByRole('button', { name: 'Add relationships' }).click(); };
// The hierarchy as text: indentation from the line's level, a marker for open / closed / leaf, and the tags it carries.
const tree = () => view.locator('.tree-row').evaluateAll((rows) => rows.map((r) => `${'  '.repeat(Number(r.getAttribute('aria-level')) - 1)}${r.getAttribute('aria-expanded') === 'true' ? '▼ ' : r.getAttribute('aria-expanded') === 'false' ? '▶ ' : '  '}${r.querySelector('.tree-name, .st-root-name').textContent}${[...r.querySelectorAll('.tag')].map((t) => ` [${t.textContent.trim()}]`).join('')}`).join('\n'));
const line = (name) => view.locator('.tree-row', { has: page.locator('.tree-name', { hasText: new RegExp('^' + name + '$') }) });
const settled = () => page.waitForFunction(() => document.querySelector('.view.structure .tree')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.view.structure .st-wait'));
const focusName = async () => ((await view.locator('.st-focus .name').count()) ? flat(await view.locator('.st-focus .name').innerText()) : null);
const summary = view.locator('.st-summary');
// What is said of the class in focus, section by section: "Superclasses: Asserted Actor, Employee | Inferred …".
const said = async () => {
  await page.waitForFunction(() => document.querySelector('.view.structure .st-summary section'));
  // The headings are set in capitals by the style sheet; they are read as they are written.
  return (await summary.locator('section').evaluateAll((els) => els.map((el) => [...el.children].map((c) => (c.tagName === 'H3' ? c.textContent : c.innerText)).join(' ')))).map(flat);
};
const lines = () => view.locator('.tree').evaluate((el) => Number(el.dataset.lines));
const hierarchy = (name) => view.locator('.st-which').getByRole('button', { name, exact: true }).click();
const marked = (cls) => view.locator('.tree-row.' + cls + ' .tree-name').allInnerTexts().then((x) => x.map(flat));

await page.goto(base);
// The OWL 2 DL reasoner is asked at an address where nothing listens, whatever service may be running on this machine.
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('conceptweaver:reasoner-url', 'http://127.0.0.1:5189'); });
await page.reload();
await page.waitForSelector('.node');

// ---- the tab and its three modes
const tabs = (await page.locator('.header [role=tab]').allInnerTexts()).map(flat).join('|');
ok(tabs.includes('|Structure|') && !tabs.includes('Hierarchy'), 'the Hierarchy tab is now Structure: ' + tabs);
await tab('Structure');
await view.locator('.tree-row').first().waitFor();
await settled();
ok((await view.locator('.view-head [role=tab]').allInnerTexts()).map(flat).join('|') === 'Explore|Compare|Analyze' && (await view.locator('.view-head [role=tab].on').innerText()) === 'Explore', 'it has three modes and opens on Explore');
ok(flat(await view.locator('.st-which').innerText()) === 'Hierarchy Asserted Inferred' && (await view.locator('.st-which [aria-pressed=true]').innerText()) === 'Asserted', 'and shows the asserted hierarchy, with the inferred one to choose beside it');

// ---- the asserted hierarchy
const FILM = ['▼ owl:Thing', '    Award', '  ▼ Film', '      Documentary', '    Genre', '  ▼ Person', '      Actor', '      Director', '    Studio'].join('\n');
ok((await tree()) === FILM, 'the classes under their stated superclasses, under owl:Thing:\n' + (await tree()));
ok(!(await tree()).includes('Tom') && (await view.locator('.tree-row').count()) === 9, 'an individual and the data properties are not in the hierarchy: 8 classes and the top');
await page.screenshot({ path: shots + 'structure.png' });

// ---- read-only, and a focus of its own
ok((await view.locator('input:not([type=search]), textarea, select').count()) === 0 && (await view.getByRole('button', { name: /add|delete|remove|save/i }).count()) === 0, 'nothing in it edits the ontology');
ok((await focusName()) === null, 'no class is in focus to begin with');
await line('Actor').locator('.tree-name').click();
ok((await focusName()) === 'Actor' && (await view.locator('.st-focus .iri-cell').textContent()) === ':Actor', 'choosing a class brings it into focus, with its IRI');
ok((await line('Actor').getAttribute('class')).includes(' on') && (await line('Actor').getAttribute('aria-selected')) === 'true', 'and marks its line');
ok((await inspector.locator('input').first().inputValue()) !== 'Actor' && (await side.locator('.tree-line.on').count()) === 0, 'without selecting it: the side panel does not open its editor');

// ---- from the hierarchy to where a class is edited and drawn
await view.getByRole('button', { name: 'Open in Entities' }).click();
ok((await page.locator('.header [role=tab].on').innerText()) === 'Entities' && (await page.locator('.view tbody tr.sel input').first().inputValue()) === 'Actor' && (await inspector.locator('input').first().inputValue()) === 'Actor', 'Open in Entities goes to the class in the Entities view, selected, with the editor on it');
await tab('Structure');
await settled();
ok((await focusName()) === 'Actor' && (await tree()) === FILM, 'back in Structure the focus and what was open are as they were');
await view.getByRole('button', { name: 'View in Graph' }).click();
ok((await page.locator('.header [role=tab].on').innerText()) === 'Graph' && (await page.locator('.node.selected').count()) === 1 && (await page.locator('.node.selected').textContent()).startsWith('Actor'), 'View in Graph shows it on the canvas, selected');

// ---- opening and closing
await tab('Structure');
await settled();
await view.getByRole('button', { name: 'Collapse Person' }).click();
ok(!(await tree()).includes('Actor') && (await tree()).includes('▶ Person'), 'a branch folds');
await view.getByRole('button', { name: 'Collapse all' }).click();
ok((await tree()) === ['▼ owl:Thing', '    Award', '  ▶ Film', '    Genre', '  ▶ Person', '    Studio'].join('\n'), 'Collapse all folds every branch below the top');
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
ok((await tree()) === FILM, 'Expand all opens them again');

// ---- the sidebar leads into it
await view.getByRole('button', { name: 'Collapse all' }).click();
await side.locator('.tree-line', { has: page.locator('.name', { hasText: /^Director$/ }) }).locator('.label').click();
await line('Director').waitFor();
ok((await focusName()) === 'Director' && (await line('Director').getAttribute('class')).includes(' on') && (await tree()).includes('▼ Person') && (await tree()).includes('▶ Film'), 'a class chosen in the sidebar is brought into focus and into view, opening only what leads to it');
ok((await inspector.locator('input').first().inputValue()) === 'Director', 'and, chosen there, is selected as it always was');
await page.locator('.header').getByRole('tab', { name: 'Graph' }).click();
await page.locator('.node', { has: page.locator('text', { hasText: /^Documentary$/ }) }).locator('.node-box').click();
await tab('Structure');
await settled();
ok((await focusName()) === 'Documentary' && (await line('Documentary').count()) === 1, 'a class selected on the canvas is the one in focus on coming here');

// ---- search
const search = view.getByLabel('Search the hierarchy');
const beforeSearch = await tree();
await search.fill('doc');
await page.waitForFunction(() => /1 class matches/.test(document.querySelector('.view.structure .st-status')?.textContent ?? ''));
ok((await tree()) === ['▼ owl:Thing', '  ▼ Film', '      Documentary'].join('\n') && (await view.locator('.tree-name.match').innerText()) === 'Documentary', 'the search narrows the hierarchy to what it finds and what that is under:\n' + (await tree()));
await search.fill(':actor');
await page.waitForFunction(() => document.querySelector('.view.structure .tree-name.match')?.textContent === 'Actor');
ok((await tree()) === ['▼ owl:Thing', '  ▼ Person', '      Actor'].join('\n'), 'by IRI too, written with its prefix');
await search.fill('zebra');
await page.waitForFunction(() => /Nothing in the hierarchy matches/.test(document.querySelector('.view.structure .tree-wrap')?.textContent ?? ''));
ok((await view.locator('.tree-row').count()) === 1, 'a search that finds nothing says so');
await search.fill('');
await page.waitForFunction(() => document.querySelectorAll('.view.structure .tree-row').length >= 6);
await settled();
ok((await tree()) === beforeSearch && beforeSearch.includes('▼ Person') && beforeSearch.includes('▼ Film'), 'and when it is cleared, what was open before is open again:\n' + (await tree()));

// ---- multiple inheritance: one class, several places
await bulkRel('Employee -> is a -> Person\nWorkingActor -> is a -> Actor\nWorkingActor -> is a -> Employee');
await tab('Structure');
await settled();
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
let t = await tree();
ok(t.includes('    ▼ Actor\n        WorkingActor [2 superclasses]') && t.includes('    ▼ Employee\n        WorkingActor [2 superclasses]'), 'a class with two superclasses is listed under both, and says so:\n' + t.split('\n').slice(5, 11).join('\n'));
await line('WorkingActor').first().locator('.tree-name').click();
ok((await view.locator('.tree-row.on').count()) === 2 && (await focusName()) === 'WorkingActor', 'in focus in one place it is in focus in both: one entity');
await view.getByRole('button', { name: 'Collapse Actor' }).click();
ok((await line('WorkingActor').count()) === 1 && (await tree()).includes('▼ Employee'), 'and one of its places folds without the other');
await view.getByRole('button', { name: 'Open in Entities' }).click();
ok((await page.locator('.view tbody tr', { has: page.locator('input[value="WorkingActor"]') }).count()) === 1, 'there is one WorkingActor in the ontology');

// ---- an edit elsewhere is read at once
await page.locator('.view tbody tr', { has: page.locator('input[value="WorkingActor"]') }).getByRole('button', { name: 'Remove superclass Employee' }).click();
await tab('Structure');
await settled();
t = await tree();
ok((await line('WorkingActor').count()) === 1 && t.includes('    ▼ Actor\n        WorkingActor\n') && !t.includes('2 superclasses') && t.includes('\n      Employee\n'), 'a superclass removed in Entities is gone from the hierarchy, which is read again for the ontology as it is now:\n' + t);

// ---- a ring of classes
await bulkRel('Person -> is a -> Actor');
await tab('Structure');
await settled();
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
t = await tree();
ok(t.includes('[cycle]') && t.includes('Award') && t.includes('Studio') && (await view.locator('.tree-row').count()) < 30, 'classes that are each other’s superclasses are marked as a cycle, followed once, and everything else is still there:\n' + t);
await page.locator('.header').getByRole('button', { name: 'Undo' }).click();
await settled();
ok(!(await tree()).includes('[cycle]'), 'undone, the cycle is gone');

// ---- what is said of the class in focus
await bulkRel('WorkingActor -> is a -> Employee\nWorkingActor -> is a -> Person');
await tab('Structure');
await settled();
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
await line('WorkingActor').first().locator('.tree-name').click();
let about = await said();
ok(about[0].startsWith('Superclasses Asserted Actor, Employee, Person Inferred Actor, Employee') && /according to Fast reasoner/.test(about[0]), 'beside the hierarchy: its asserted superclasses, and apart from them the direct ones the reasoner entails, credited to it:\n' + about[0]);
ok(about[1] === 'In the asserted hierarchy Subclasses none Depth levels 2 to 3 below owl:Thing Inheritance Multiple: 3 superclasses directly above it 3 ways down to it from owl:Thing Person › WorkingActor Person › Actor › WorkingActor Person › Employee › WorkingActor', 'and where it stands: how deep, under how many, and by which ways down:\n' + about[1]);
ok((await summary.locator('input, textarea, select').count()) === 0 && (await summary.getByRole('button', { name: /add|delete|remove|save/i }).count()) === 0, 'none of it is an editor');
ok((await marked('above')).join('|') === 'Person|Actor|Employee' && (await view.locator('.tree-row.on').count()) === 3, 'its superclasses, by every way up, are marked in the hierarchy, and it is in focus in each of its three places');
await line('Person').locator('.tree-name').click();
ok((await marked('below')).sort().join('|') === 'Actor|Director|Employee|WorkingActor|WorkingActor|WorkingActor' && (await marked('above')).length === 0, 'with Person in focus, what is on show below it is marked instead');
about = await said();
ok(about[about.length - 1].includes('Subclasses 4 direct, 4 in all') && about[about.length - 1].includes('None: directly under owl:Thing'), 'each class below is counted once, however many places it has: ' + about[about.length - 1]);

// from what is said, to the hierarchy
await line('WorkingActor').first().locator('.tree-name').click();
await view.getByRole('button', { name: 'Collapse all' }).click();
await summary.locator('.st-ways button', { hasText: 'Employee' }).click();
await line('WorkingActor').first().waitFor();
let t2 = await tree();
ok(t2.includes('    ▼ Employee\n        WorkingActor') && t2.includes('▶ Actor') && (await focusName()) === 'WorkingActor', 'pressing one of the ways down opens that way and no other:\n' + t2);
await summary.locator('section').first().getByRole('button', { name: 'Actor', exact: true }).first().click();
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'Actor');
ok((await line('Actor').getAttribute('class')).includes(' on'), 'and pressing a superclass brings that class into focus');

// ---- the keyboard
await view.getByRole('button', { name: 'Collapse all' }).click();
await view.locator('.tree').focus();
await page.keyboard.press('Home');
ok((await focusName()) === 'Award' && (await view.locator('.tree-row.cursor .tree-name').innerText()) === 'Award', 'the hierarchy is one stop for the Tab key, and Home goes to its first class');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowRight');
await line('Documentary').waitFor();
ok((await focusName()) === 'Film' && (await tree()).includes('▼ Film\n      Documentary'), 'the arrow keys move through it and open a branch');
await page.keyboard.press('ArrowRight');
ok((await focusName()) === 'Documentary', 'Right on an open class goes to its first subclass');
await page.keyboard.press('ArrowLeft');
ok((await focusName()) === 'Film', 'Left on a subclass goes to the class it is under');
await page.keyboard.press('ArrowLeft');
ok((await tree()).includes('▶ Film') && (await focusName()) === 'Film', 'and Left on an open class folds it');
await page.keyboard.press('End');
ok((await focusName()) === 'Studio' && (await view.locator('.tree').getAttribute('aria-activedescendant')) === (await line('Studio').getAttribute('id')), 'End goes to the last line, which the hierarchy names as the active one');

// ---- the inferred hierarchy, from the fast reasoner
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
ok((await tree()).includes('      Studio\n    WorkingActor [3 superclasses]') || (await tree()).includes('    WorkingActor [3 superclasses]'), 'in the asserted hierarchy WorkingActor is under Person as well, because that is stated');
await hierarchy('Inferred');
await view.locator('.st-reasoner').waitFor();
await settled();
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
t2 = await tree();
ok(flat(await view.locator('.st-prov').innerText()).startsWith('Fast reasoner (RDFS / partial OWL RL) · may be incomplete · of the ontology as it is now'), 'the inferred hierarchy says which reasoner it is from, that it may be incomplete, and that it is of the ontology as it is: ' + flat(await view.locator('.st-prov').innerText()));
ok(t2.includes('    ▼ Actor\n        WorkingActor [2 superclasses]') && t2.includes('    ▼ Employee\n        WorkingActor [2 superclasses]') && (await line('WorkingActor').count()) === 2, 'in it WorkingActor is under its direct superclasses only: Person is above it, and not directly:\n' + t2);
await view.locator('.st-prov').getByRole('button', { name: 'why' }).click();
ok(/not a complete OWL 2 DL reasoner/.test(await view.locator('.st-notes').innerText()), 'why it may be incomplete is said in the reasoner’s own terms');
await line('WorkingActor').first().locator('.tree-name').click();
about = await said();
ok(about[about.length - 1].startsWith('In the inferred hierarchy') && about[about.length - 1].includes('level 3 below owl:Thing') && about[about.length - 1].includes('2 ways down'), 'and where a class stands is said of the hierarchy on show: ' + about[about.length - 1]);

// classes that are each other's superclasses are equivalent, and share a place
await bulkRel('Person -> is a -> Actor');
await tab('Structure');
await settled();
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
t2 = await tree();
ok(t2.includes('Actor [≡ Person]') && !t2.includes('[cycle]') && (await line('Actor').count()) === 1, 'two classes that are each other’s superclasses are one place in the inferred hierarchy, as equivalent classes:\n' + t2);
await hierarchy('Asserted');
await settled();
ok((await tree()).includes('[cycle]'), 'where the asserted hierarchy shows them as the cycle that was stated');
await page.locator('.header').getByRole('button', { name: 'Undo' }).click();
await hierarchy('Inferred');
await settled();

// a class that can have no instance
await side.locator('.tree-line', { has: page.locator('.name', { hasText: /^Film$/ }) }).locator('.label').click();
const disjoint = inspector.locator('.field', { has: page.locator(':scope > span:has-text("Disjoint classes")') }).first();
await disjoint.locator('.chip-add').click();
await disjoint.getByRole('combobox').fill('Person');
await disjoint.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
await bulkRel('Biopic -> is a -> Film\nBiopic -> is a -> Person');
await tab('Structure');
await settled();
await view.getByRole('button', { name: 'Expand all' }).click();
await settled();
t2 = await tree();
ok(t2.includes('  ▼ owl:Nothing\n      Biopic [unsatisfiable]') && (await line('Biopic').count()) === 1 && t2.trimEnd().endsWith('Biopic [unsatisfiable]'), 'a class under two disjoint classes is set apart under owl:Nothing, last, and listed nowhere else:\n' + t2);
await line('Biopic').locator('.tree-name').click();
ok(/^Unsatisfiable\. It can never have an instance.*according to Fast reasoner/.test(flat(await summary.locator('.st-unsat').innerText())), 'what is said of it says so first, and who says it: ' + flat(await summary.locator('.st-unsat').innerText()));
await summary.getByRole('button', { name: 'See why in Validation' }).click();
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
ok((await page.locator('.header [role=tab].on').innerText()).startsWith('Validation') && flat(await page.locator('.validation').innerText()).includes('Biopic'), 'and leads to Validation, where the finding is');
await tab('Structure');
await settled();
await hierarchy('Asserted');
await settled();
ok((await tree()).includes('  ▼ Film\n      Biopic') && !(await tree()).includes('owl:Nothing'), 'in the asserted hierarchy it is where it was stated to be');

// ---- a reasoner without an answer
await hierarchy('Inferred');
await settled();
await view.getByLabel('Reasoner').selectOption({ label: 'Advanced reasoner (OWL 2 DL)' });
await view.locator('.st-none').waitFor();
await page.waitForFunction(() => /gave no answer/.test(document.querySelector('.view.structure .st-none')?.textContent ?? ''));
const none = flat(await view.locator('.st-none').innerText());
ok(none.startsWith('There is no inferred hierarchy to show. HermiT gave no answer.') && none.includes('Nothing is put in its place') && (await view.locator('.tree').count()) === 0, 'when the reasoner chosen has no answer there is no inferred hierarchy, and the other reasoner’s is not shown in its place: ' + none.slice(0, 110));
ok(flat(await view.locator('.st-prov').innerText()).startsWith('HermiT · no answer') && (await view.locator('.st-none').getByRole('button', { name: 'Run reasoning' }).count()) === 1, 'it says which reasoner that is, and offers to ask it again');
await line('Biopic').count();
about = await said();
ok(/Inferred HermiT gave no answer\./.test(about[0]) && about[0].startsWith('Superclasses Asserted Film, Person'), 'what is said of the class in focus keeps what is asserted and says the same of what is inferred: ' + about[0]);
await view.locator('.st-none').getByRole('button', { name: 'Show the asserted hierarchy' }).click();
await settled();
ok((await view.locator('.st-which [aria-pressed=true]').innerText()) === 'Asserted' && (await tree()).includes('Biopic'), 'the asserted hierarchy is one press away');
await hierarchy('Inferred');
await view.getByLabel('Reasoner').selectOption({ label: 'Fast reasoner (RDFS / partial OWL RL)' });
await page.waitForFunction(() => /^Fast reasoner/.test(document.querySelector('.view.structure .st-prov')?.textContent ?? '') && document.querySelector('.view.structure .tree'));
await settled();
ok((await tree()).includes('owl:Nothing'), 'and with the fast reasoner chosen again, its hierarchy is back');
await hierarchy('Asserted');
await settled();

// ---- two classes side by side
const tmp = fs.mkdtempSync('/tmp/cw-structure-');
fs.writeFileSync(tmp + '/party.ttl', `@prefix : <http://example.org/party#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/party> a owl:Ontology ; rdfs:label "Party" .
:Party a owl:Class ; rdfs:label "Party" ;
    rdfs:subClassOf
        [ a owl:Restriction ; owl:onProperty :hasLocalProfile ; owl:someValuesFrom :PartyLocalProfile ] ,
        [ a owl:Restriction ; owl:onProperty :globalIdentifier ; owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:string ] .
:Organisation a owl:Class ; rdfs:label "Organisation" ; rdfs:subClassOf :Party ,
        [ a owl:Restriction ; owl:onProperty :hasLocalProfile ; owl:someValuesFrom :OrganisationLocalProfile ] .
:Person a owl:Class ; rdfs:label "Person" ; rdfs:subClassOf :Party ; owl:disjointWith :Organisation .
:PartyLocalProfile a owl:Class ; rdfs:label "PartyLocalProfile" .
:OrganisationLocalProfile a owl:Class ; rdfs:label "OrganisationLocalProfile" ; rdfs:subClassOf :PartyLocalProfile .
:hasLocalProfile a owl:ObjectProperty ; rdfs:label "hasLocalProfile" .
:globalIdentifier a owl:DatatypeProperty ; rdfs:label "globalIdentifier" ; rdfs:range xsd:string .
`);
await page.locator('.header input[type=file]').setInputFiles(tmp + '/party.ttl');
await page.waitForFunction(() => document.querySelector('.model-name')?.value === 'Party');
await tab('Structure');
await settled();
const compared = view.locator('.st-compared');
// The restrictions as a table: what the line says, and how it stands to each of the two.
const restrictions = () => compared.locator('section[aria-label="Restrictions and class expressions"] tbody tr').evaluateAll((rows) => rows.map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')));
const headline = async () => flat(await compared.locator('.st-headline').innerText());
const relation = async () => flat(await compared.locator('.st-relation').innerText());
const slot = (n) => view.locator('.st-slot').nth(n);
const pick = async (n, text, name) => {
  if (await slot(n).getByRole('button', { name: /^Choose another/ }).count()) await slot(n).getByRole('button', { name: /^Choose another/ }).click();
  await slot(n).getByRole('combobox').fill(text);
  await slot(n).locator('.subgraph-found button', { hasText: new RegExp('^' + name + '\\b') }).first().click();
};

await line('Organisation').locator('.tree-name').click();
await summary.getByRole('button', { name: 'Compare…' }).click();
ok((await view.locator('.view-head [role=tab].on').innerText()) === 'Compare' && /^class a organisation/i.test(flat(await slot(0).innerText())) && (await compared.count()) === 0, 'Compare… beside a class in Explore puts it in the first of the two places');
ok(/Set it against one of its superclasses: Party/.test(flat(await view.locator('.st-compare-empty').innerText())), 'and offers its superclasses to set it against first');
await view.locator('.st-compare-empty').getByRole('button', { name: 'Party', exact: true }).click();
await compared.waitFor();
ok((await headline()) === 'Organisation SubClassOf Party' && (await relation()).includes('Stated outright.'), 'a class and its superclass: the relationship, and that it is stated: ' + (await headline()));
await view.getByRole('button', { name: 'Swap' }).click();
await page.waitForFunction(() => document.querySelector('.view.structure .st-slot .name')?.textContent === 'Party');
ok(/^class a party/i.test(flat(await slot(0).innerText())) && /^class b organisation/i.test(flat(await slot(1).innerText())) && (await headline()) === 'Organisation SubClassOf Party', 'Swap puts each in the other’s place, and the relationship reads the same');
let rows = await restrictions();
ok(rows.length === 3 && rows[0] === 'globalIdentifier max 1 xsd:string | Own | Inherited from Party' && rows[1] === 'hasLocalProfile some PartyLocalProfile | Own | Inherited from Party', 'what Party asserts, Organisation inherits, and from where:\n' + rows.slice(0, 2).join('\n'));
ok(rows[2] === 'hasLocalProfile some OrganisationLocalProfile stronger than “hasLocalProfile some PartyLocalProfile”, because OrganisationLocalProfile is under PartyLocalProfile (stated) View semantic explanation | — | Own', 'what Organisation adds is its own, and is called stronger with the reason for it:\n' + rows[2]);
ok(flat(await compared.locator('.st-counts').innerText()) === '2 in both 0 only in Party 1 only in Organisation Party: 2 own, 0 inherited Organisation: 1 own, 2 inherited', 'the differences are counted: ' + flat(await compared.locator('.st-counts').innerText()));
ok(/What is marked entailed is from Fast reasoner .*may be incomplete/.test(await relation()), 'and it says which reasoner stands behind what is marked as entailed');
await compared.locator('tbody').first().getByRole('button', { name: 'View semantic explanation' }).click();
await compared.locator('.st-why ol').waitFor();
ok(flat(await compared.locator('.st-why').innerText()) === 'It follows from this stated axiom: OrganisationLocalProfile SubClassOf PartyLocalProfile', 'the explanation of that reason is the stated axiom it rests on: ' + flat(await compared.locator('.st-why').innerText()));
ok((await view.locator('input:not([type=search]), textarea, select').count()) === 0 && (await page.locator('.header').getByRole('button', { name: 'Undo' }).isDisabled()), 'comparing changes nothing in the ontology');
await page.screenshot({ path: shots + 'structure-compare.png' });

// what a line names can be opened
await compared.locator('tbody').first().getByRole('button', { name: 'hasLocalProfile', exact: true }).first().click();
ok(/^object property/i.test(flat(await inspector.innerText())) && (await inspector.locator('input').first().inputValue()) === 'hasLocalProfile' && (await page.locator('.header [role=tab].on').innerText()) === 'Structure', 'a property named in a restriction opens in the side panel, without leaving the comparison');
await compared.locator('tbody').first().getByRole('button', { name: 'OrganisationLocalProfile', exact: true }).first().click();
ok((await inspector.locator('input').first().inputValue()) === 'OrganisationLocalProfile', 'and so does a class');

// siblings, and classes that can share no instance
await pick(0, 'pers', 'Person');
await page.waitForFunction(() => /Neither is a subclass/.test(document.querySelector('.view.structure .st-headline')?.textContent ?? ''));
let said2 = await relation();
ok(said2.includes('Neither is a subclass of the other, as far as Fast reasoner (RDFS / partial OWL RL) finds.') && said2.includes('Both are directly under Party.'), 'two classes under one superclass are siblings, and it says how far that was checked: ' + said2.slice(13, 150));
ok(said2.includes('Disjoint. The two are stated to share no instance.'), 'that they are stated to be disjoint is said with it');
rows = await restrictions();
ok(rows.length === 3 && rows[0] === 'globalIdentifier max 1 xsd:string | Inherited from Party | Inherited from Party' && rows[2] === 'hasLocalProfile some OrganisationLocalProfile stronger than “hasLocalProfile some PartyLocalProfile”, because OrganisationLocalProfile is under PartyLocalProfile (stated) View semantic explanation | — | Own', 'both inherit what Party asserts, and only one has a restriction of its own:\n' + rows.join('\n'));
const supers = await compared.locator('section[aria-label="The superclasses of the two"] tbody tr').evaluateAll((trs) => trs.map((r) => [...r.cells].map((c) => c.innerText.trim()).join(' | ')));
ok(supers.join('\n') === 'Party | Stated | Stated', 'and their superclasses are set side by side: ' + supers.join('; '));

// the stronger restriction is not claimed once its reason is gone
await compared.getByRole('button', { name: 'Open Organisation in Entities' }).click();
ok((await page.locator('.header [role=tab].on').innerText()) === 'Entities' && (await page.locator('.view tbody tr.sel input').first().inputValue()) === 'Organisation', 'Open in Entities goes to the class, selected');
await page.locator('.view tbody tr', { has: page.locator('input[value="OrganisationLocalProfile"]') }).getByRole('button', { name: 'Remove superclass PartyLocalProfile' }).click();
await tab('Structure');
await pick(0, 'party', 'Party');
await page.waitForFunction(() => /SubClassOf/.test(document.querySelector('.view.structure .st-headline')?.textContent ?? ''));
rows = await restrictions();
ok(rows[2] === 'hasLocalProfile some OrganisationLocalProfile | — | Own' && !(await compared.innerText()).includes('stronger than'), 'with the filler no longer a subclass of the other, the restriction is an additional one and is not called stronger:\n' + rows[2]);

// without a reasoner's answer, what could not be checked is said to be unverified
await view.getByRole('tab', { name: 'Explore' }).click();
await hierarchy('Inferred');
await view.locator('.st-reasoner').waitFor();
await view.getByLabel('Reasoner').selectOption({ label: 'Advanced reasoner (OWL 2 DL)' });
await page.waitForFunction(() => /gave no answer/.test(document.querySelector('.view.structure .st-none')?.textContent ?? ''));
await view.getByRole('tab', { name: 'Compare' }).click();
await compared.locator('.st-checked.unverified').waitFor();
said2 = await relation();
ok(said2.includes('unverified Only what is stated was read. HermiT gave no answer. More may hold between the two than is said here.') && (await compared.locator('.st-checked').getByRole('button', { name: 'Run reasoning' }).count()) === 1, 'when the reasoner chosen has no answer, the comparison says that only what is stated was read: ' + said2.slice(said2.indexOf('unverified')));
rows = await restrictions();
ok(rows[2].startsWith('hasLocalProfile some OrganisationLocalProfile unverified Whether it is stronger than “hasLocalProfile some PartyLocalProfile” was not checked') && !rows[2].includes('stronger than “hasLocalProfile some PartyLocalProfile”,'), 'and whether one restriction implies the other is left open, not decided either way:\n' + rows[2]);
await view.getByRole('tab', { name: 'Explore' }).click();
await view.getByLabel('Reasoner').selectOption({ label: 'Fast reasoner (RDFS / partial OWL RL)' });
await page.waitForFunction(() => /^Fast reasoner/.test(document.querySelector('.view.structure .st-prov')?.textContent ?? ''));
await hierarchy('Asserted');
await settled();
await view.getByRole('tab', { name: 'Compare' }).click();
await compared.locator('.st-checked:not(.unverified)').waitFor();
ok((await restrictions())[2] === 'hasLocalProfile some OrganisationLocalProfile | — | Own', 'asked again of the fast reasoner, nothing is left open');

// out to the graph
await compared.getByRole('button', { name: 'View in Graph' }).click();
ok((await page.locator('.header [role=tab].on').innerText()) === 'Graph' && (await page.locator('.node.selected').count()) === 2, 'View in Graph shows the two on the canvas, both selected');
await page.keyboard.press('Escape');
await tab('Structure');
await view.getByRole('tab', { name: 'Explore' }).click();
await settled();

// ---- a large hierarchy
await file('Generate a stress-test model');
await page.waitForFunction(() => /Stress test/.test(document.querySelector('.model-name')?.value ?? ''));
await tab('Structure');
await view.locator('.tree-row').nth(1).waitFor();
await settled();
const opened = await lines();
ok(opened > 8 && opened < 330, `a hierarchy of 650 classes opens on a part of it: ${opened} lines`);
ok((await focusName()) === null && (await search.inputValue()) === '', 'another model starts the explorer afresh');
const t0 = Date.now();
await view.getByRole('button', { name: 'Expand all' }).click();
await page.waitForFunction((n) => Number(document.querySelector('.view.structure .tree')?.dataset.lines) > n, opened);
await settled();
const all = await lines();
ok(all >= 651 && Date.now() - t0 < 4000, `Expand all opens the rest: ${all} lines for 650 classes, some in two places (${Date.now() - t0} ms)`);
const drawn = await view.locator('.tree-row').count();
ok(drawn < 90, `of which only the ones in view are drawn: ${drawn}`);
await view.locator('.tree-wrap').evaluate((el) => (el.scrollTop = el.scrollHeight));
await page.waitForFunction(() => document.querySelector('.view.structure .tree-row:first-of-type .st-root-name') === null);
ok((await view.locator('.tree-row').count()) < 90 && (await view.locator('.tree-row').last().innerText()).length > 0, 'scrolled to the end, the last lines are drawn and the first are not');
// A class that is out of sight is brought into view by pointing at it elsewhere.
await side.getByLabel('Search terms').fill('Class 333');
await side.locator('.tree-line .label', { hasText: /^Class 333$/ }).first().click();
await page.waitForFunction(() => document.querySelector('.view.structure .tree-row.on .tree-name')?.textContent === 'Class 333');
ok(await view.locator('.tree-row.on').first().evaluate((el) => { const r = el.getBoundingClientRect(); const w = el.closest('.tree-wrap').getBoundingClientRect(); return r.top >= w.top && r.bottom <= w.bottom; }), 'a class chosen in the sidebar is scrolled to, wherever in the list it is');
await side.getByLabel('Search terms').fill('');
await search.fill('Class 42');
await page.waitForFunction(() => /11 classes match/.test(document.querySelector('.view.structure .st-status')?.textContent ?? ''));
ok((await view.locator('.tree-name.match').count()) >= 1, 'and it is searched like any other: Class 42 and Class 420 to 429');
await search.fill('');

// ---- the other two modes, and a vocabulary
await view.getByRole('tab', { name: 'Compare' }).click();
ok(/Choose two classes to set side by side/.test(await view.innerText()) && (await view.locator('.st-slot').count()) === 2 && (await view.locator('.st-compared').count()) === 0, 'for another model the comparison starts with both places empty');

// ---- the hierarchy in numbers
await view.getByRole('tab', { name: 'Analyze' }).click();
await view.locator('.st-tiles').waitFor();
const tile = (id) => view.locator(`[data-metric="${id}"] .st-tile`);
const tileText = async (id) => flat(await tile(id).innerText());
const chart = (title) => view.locator('.st-chart', { has: page.locator('h3', { hasText: new RegExp('^' + title + '$', 'i') }) });
const bars = async (title) => (await chart(title).locator('.st-bar-row').allInnerTexts()).map(flat);
const members = view.locator('.st-members');
const listed = async () => { await members.locator('.st-member-list li').first().waitFor(); return { title: flat(await members.locator('.st-focus .name').innerText()), count: flat(await members.locator('.st-focus .muted').innerText()), first: flat(await members.locator('.st-member-list li').first().innerText()), shown: await members.locator('.st-member-list li').count() }; };
ok((await tileText('classes')) === 'Classes 650 named' && (await tileText('top')) === 'At the top 8 directly under owl:Thing' && (await tileText('leaves')) === 'Leaves 270 with no subclass', 'the hierarchy is summed up in numbers: ' + [await tileText('classes'), await tileText('top'), await tileText('leaves')].join(' · '));
ok((await tileText('maxDepth')).startsWith('Deepest level 27') && (await tileText('averageDepth')).startsWith('Average depth 12.44') && (await tileText('multipleInheritance')).startsWith('Multiple inheritance 33') && (await tileText('inCycles')).startsWith('In cycles 0'), 'how deep it goes, on average too, and how many classes have several superclasses: ' + [await tileText('maxDepth'), await tileText('averageDepth'), await tileText('multipleInheritance')].join(' · '));
ok((await tileText('unsatisfiable')) === 'Unsatisfiable 0 according to Fast reasoner (RDFS / partial OWL RL)', 'the number of unsatisfiable classes says whose it is: ' + (await tileText('unsatisfiable')));
ok((await bars('Direct superclasses')).join(' | ') === 'None (at the top) 8 | 1 609 | 2 33' && (await bars('Depth')).length === 9 && (await bars('Branches'))[0] === 'Class 4 547', 'and how its classes are spread, as bars with their numbers written out: ' + (await bars('Direct superclasses')).join(' | '));
ok((await chart('Direct subclasses').locator('.st-bar-fill').count()) >= 5 && (await chart('Direct subclasses').locator('.st-bar-fill').first().evaluate((el) => el.getBoundingClientRect().height)) <= 24, 'the bars are thin marks from a common baseline');
ok((await view.locator('input, textarea, select').count()) === 0 && (await view.getByRole('button', { name: /add|delete|remove|save/i }).count()) === 0, 'nothing in it edits the ontology');

// every number, bar and finding leads to the classes behind it
await tile('multipleInheritance').click();
let got = await listed();
ok(got.title === 'Multiple inheritance' && got.count === '33 classes' && got.first === 'Class 109 2 superclasses: Class 4, Class 95' && (await tile('multipleInheritance').getAttribute('aria-pressed')) === 'true', 'a number lists the classes behind it, each with what puts it there: ' + got.first);
await chart('Direct subclasses').getByRole('button', { name: /^None \(leaves\)/ }).click();
await page.waitForFunction(() => /^No direct subclasses/.test(document.querySelector('.view.structure .st-members .name')?.textContent ?? ''));
got = await listed();
ok(got.count === '270 classes' && got.shown === 200 && flat(await members.locator('.st-more').innerText()) === 'Show more 200 of 270', 'a bar does the same, a page at a time: ' + got.count + ', ' + got.shown + ' shown');
await members.getByRole('button', { name: 'Show more' }).click();
await page.waitForFunction(() => document.querySelectorAll('.view.structure .st-member-list li').length === 270);
ok((await members.locator('.st-more').count()) === 0, 'Show more brings the rest');
await chart('Branches').getByRole('button', { name: /^Class 7:/ }).click();
await page.waitForFunction(() => /branch of Class 7/.test(document.querySelector('.view.structure .st-members .name')?.textContent ?? ''));
got = await listed();
ok(got.count === '79 classes', 'a branch lists everything in it: ' + got.title + ', ' + got.count);
const findings = (await view.locator('.st-findings li').evaluateAll((items) => items.map((li) => `${li.dataset.finding}: ${li.querySelector('strong').textContent}`)));
ok(findings.join(' | ') === 'redundant-superclass: 33 potentially redundant superclass statements | multiple-inheritance: 33 classes with several superclasses | wide: 1 class with unusually many direct subclasses | connected: 1 highly connected class', 'what stands out is listed as findings to look over, not as errors:\n' + findings.join('\n'));
ok(/none of it is an error/.test(await view.locator('section[aria-label="Structural findings"]').innerText()) && /A valid and common pattern/.test(await view.locator('[data-finding="multiple-inheritance"]').innerText()), 'and multiple inheritance is said to be valid');
await view.locator('[data-finding="redundant-superclass"]').getByRole('button', { name: 'List' }).click();
await page.waitForFunction(() => /redundant/.test(document.querySelector('.view.structure .st-members .name')?.textContent ?? ''));
got = await listed();
ok(got.count === '33 classes' && /^Class \d+ Class \d+ is also reached through another superclass$/.test(got.first), 'a finding lists what it is about: ' + got.first);
ok(flat(await view.locator('section[aria-label="The longest ways down"] li').first().innerText()).startsWith('27 levels Class 4 › Class 10'), 'the longest ways down are given, each from the top');

// from the numbers to the rest of the app
await members.getByRole('button', { name: 'View in Graph' }).click();
ok((await page.locator('.header [role=tab].on').innerText()) === 'Graph' && /^\d+ of 960 terms$/.test(flat(await page.locator('.subgraph-count').innerText())), 'View in Graph draws them as a subgraph on the canvas: ' + flat(await page.locator('.subgraph-count').innerText()));
await page.locator('.subgraph').getByRole('button', { name: 'Full graph' }).click();
await tab('Structure');
await view.locator('.st-tiles').waitFor();
await view.locator('[data-finding="redundant-superclass"]').getByRole('button', { name: 'Open Validation' }).click();
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
ok((await page.locator('.header [role=tab].on').innerText()).startsWith('Validation'), 'Open Validation goes to what Validation has to say of it');
await tab('Structure');
await view.locator('.st-tiles').waitFor();
await tile('top').click();
await members.locator('.st-member-list button', { hasText: 'Class 7' }).click();
await page.waitForFunction(() => document.querySelector('.view.structure .view-head [role=tab].on')?.textContent === 'Explore');
await settled();
ok((await focusName()) === 'Class 7' && (await line('Class 7').getAttribute('class')).includes(' on'), 'a class in a list opens in Explore, in focus');

// the inferred hierarchy, measured
await view.getByRole('tab', { name: 'Analyze' }).click();
await hierarchy('Inferred');
await view.locator('.st-prov-line').waitFor();
await page.waitForFunction(() => /^Multiple inheritance 0/.test((document.querySelector('.view.structure [data-metric="multipleInheritance"]')?.textContent ?? '').replace(/\s+/g, ' ')) || /Multiple inheritance0/.test(document.querySelector('.view.structure [data-metric="multipleInheritance"]')?.textContent ?? ''));
ok(flat(await view.locator('.st-prov-line').innerText()) === 'The inferred hierarchy, from Fast reasoner (RDFS / partial OWL RL), whose answer may be incomplete, of the ontology as it is now.', 'measured for the inferred hierarchy, it says which reasoner that is from: ' + flat(await view.locator('.st-prov-line').innerText()));
ok((await tileText('multipleInheritance')).startsWith('Multiple inheritance 0') && (await tileText('classes')) === 'Classes 650 named' && (await tileText('maxDepth')).startsWith('Deepest level 27'), 'in it no class has two direct superclasses: each second one was further up the same branch');
ok((await view.locator('[data-finding="redundant-superclass"] strong').innerText()) === '33 potentially redundant superclass statements', 'which is what the stated hierarchy’s redundant superclasses are, counted from what is stated either way');
await hierarchy('Asserted');
await view.locator('[data-metric="multipleInheritance"] button').waitFor();
await page.screenshot({ path: shots + 'structure-analyze.png' });
await tab('Graph');
await tab('Structure');
ok((await view.locator('.view-head [role=tab].on').innerText()) === 'Analyze', 'the mode is remembered across views');
await view.getByRole('tab', { name: 'Explore' }).click();
await file('Load the SKOS example');
// Loaded under this view, where the canvas is there but is not drawn.
await page.waitForSelector('.node', { state: 'attached' });
ok((await page.locator('.canvas').evaluate((el) => getComputedStyle(el).contentVisibility)) === 'hidden' && (await page.locator('.canvas').evaluate((el) => el.getBoundingClientRect().width)) > 300, 'under a view the canvas keeps its place and is not drawn, so that a large graph does not slow every other view down');
ok((await page.locator('.header [role=tab]').allInnerTexts()).map(flat).join('|') === 'Graph|Entities|Structure', 'a vocabulary has Structure too');
await tab('Structure');
await view.getByRole('tab', { name: 'Analyze' }).click();
await view.locator('.st-tiles').waitFor();
const skosTiles = await view.locator('.st-tiles li').evaluateAll((items) => items.map((li) => li.dataset.metric));
ok(skosTiles.join(' ') === 'classes top leaves maxDepth averageDepth multipleInheritance noStatedSuperclass inCycles' && (await tileText('classes')).startsWith('Concepts') && /Concept scheme/.test(await tileText('top')) && (await view.locator('.st-which').count()) === 0, 'its hierarchy is measured in its own words, without what only a reasoner could say: ' + (await tileText('top')));
await view.getByRole('tab', { name: 'Explore' }).click();
await tab('Structure');
await view.locator('.tree-row').nth(1).waitFor();
await settled();
t = await tree();
ok(t.startsWith('▼ Concept scheme') && flat(await view.locator('.st-basis').innerText()) === 'Asserted hierarchy skos:broader' && /concept/.test(await view.locator('.st-status').innerText()), 'where it is the concepts under their broader concepts:\n' + t.split('\n').slice(0, 6).join('\n'));
await page.screenshot({ path: shots + 'structure-skos.png' });

// ---- a class that was in focus and is gone: the hierarchy is shown all the same
// A term added elsewhere is selected, which brings it into focus here; undoing the adding takes it away again.
await file(/^Load the ontology example/);
await page.waitForSelector('.node', { state: 'attached' });
await tab('Structure');
await view.locator('.tree-row').nth(1).waitFor();
const shownBefore = await view.locator('.tree-row').count();
await tab('Entities');
await page.locator('.view').getByRole('button', { name: 'Add class' }).click();
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.locator('.header').getByRole('button', { name: /Undo/ }).click();
await tab('Structure');
await page.waitForTimeout(600);
ok((await view.locator('.tree-row').count()) === shownBefore && shownBefore > 3 && (await view.locator('.tree-row.on').count()) === 0, `after a class that was in focus is gone (added, then undone) the hierarchy is still shown, with nothing in focus (${await view.locator('.tree-row').count()} lines)`);

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
