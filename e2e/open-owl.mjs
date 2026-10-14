// Drives the built app in a headless browser to check that ontologies are opened from files in
// the syntaxes of RDF and OWL, by the File menu, by dropping them and from a URL.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
// The syntaxes that are OWL's own need the local OWL service, which is started here (on 5195)
// where Java and its libraries are there; without them those checks are skipped, saying so.
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';
import http from 'node:http';
import { startReasoner, unavailable } from '../reasoner/run.mjs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const tmp = new URL('./shots/open-owl/', import.meta.url).pathname;
fs.mkdirSync(tmp, { recursive: true });

// ---------------------------------------------------------------- the files
const PIZZA_XML = `<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [
    <!ENTITY owl "http://www.w3.org/2002/07/owl#" >
    <!ENTITY xsd "http://www.w3.org/2001/XMLSchema#" >
]>
<rdf:RDF xmlns="http://example.org/pizza#" xml:base="http://example.org/pizza"
     xmlns:owl="&owl;" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
    <owl:Ontology rdf:about="http://example.org/pizza">
        <rdfs:label xml:lang="en">Pizza ontology</rdfs:label>
        <owl:imports rdf:resource="http://example.org/food"/>
    </owl:Ontology>
    <owl:ObjectProperty rdf:about="#hasTopping"><rdfs:label xml:lang="en">has topping</rdfs:label></owl:ObjectProperty>
    <owl:DatatypeProperty rdf:about="#price"><rdfs:label xml:lang="en">price</rdfs:label><rdfs:range rdf:resource="&xsd;decimal"/></owl:DatatypeProperty>
    <owl:Class rdf:about="#Pizza"><rdfs:label xml:lang="en">Pizza</rdfs:label></owl:Class>
    <owl:Class rdf:about="#Topping"><rdfs:label xml:lang="en">Topping</rdfs:label></owl:Class>
    <owl:Class rdf:about="#Tomato"><rdfs:label xml:lang="en">Tomato</rdfs:label><rdfs:subClassOf rdf:resource="#Topping"/></owl:Class>
    <owl:Class rdf:ID="Margherita">
        <rdfs:label xml:lang="en">Margherita</rdfs:label>
        <rdfs:subClassOf rdf:resource="#Pizza"/>
        <rdfs:subClassOf><owl:Restriction><owl:onProperty rdf:resource="#hasTopping"/><owl:someValuesFrom rdf:resource="#Tomato"/></owl:Restriction></rdfs:subClassOf>
    </owl:Class>
    <owl:NamedIndividual rdf:about="#MyLunch"><rdf:type rdf:resource="#Margherita"/><rdfs:label xml:lang="en">My lunch</rdfs:label></owl:NamedIndividual>
</rdf:RDF>`;
const ZOO_JSONLD = JSON.stringify({
  '@context': { '@vocab': 'http://example.org/zoo#', owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' },
  '@graph': [
    { '@id': 'http://example.org/zoo', '@type': 'owl:Ontology', 'rdfs:label': 'Zoo' },
    { '@id': 'http://example.org/zoo#Animal', '@type': 'owl:Class', 'rdfs:label': 'Animal' },
    { '@id': 'http://example.org/zoo#Lion', '@type': 'owl:Class', 'rdfs:label': 'Lion', 'rdfs:subClassOf': { '@id': 'http://example.org/zoo#Animal' } },
  ],
});
const SHOP_FUNCTIONAL = `Prefix(:=<http://example.org/shop#>)
Prefix(rdfs:=<http://www.w3.org/2000/01/rdf-schema#>)
Ontology(<http://example.org/shop>
Annotation(rdfs:label "Shop ontology")
Declaration(Class(:Product))
Declaration(Class(:Book))
Declaration(Class(:Customer))
Declaration(ObjectProperty(:buys))
AnnotationAssertion(rdfs:label :Product "Product")
AnnotationAssertion(rdfs:label :Book "Book")
AnnotationAssertion(rdfs:label :Customer "Customer")
AnnotationAssertion(rdfs:label :buys "buys")
SubClassOf(:Book :Product)
SubClassOf(:Customer ObjectSomeValuesFrom(:buys :Product))
)`;
const CHAINS = `<?xml version="1.0"?>
<rdf:RDF xmlns="http://example.org/kin#" xml:base="http://example.org/kin" xmlns:owl="http://www.w3.org/2002/07/owl#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
    <owl:Ontology rdf:about="http://example.org/kin"><rdfs:label>Kinship</rdfs:label></owl:Ontology>
    <owl:Class rdf:about="#Person"><rdfs:label>Person</rdfs:label></owl:Class>
    <owl:ObjectProperty rdf:about="#hasParent"><rdfs:label>has parent</rdfs:label></owl:ObjectProperty>
    <owl:ObjectProperty rdf:about="#hasGrandparent">
        <rdfs:label>has grandparent</rdfs:label>
        <owl:propertyChainAxiom rdf:parseType="Collection"><rdf:Description rdf:about="#hasParent"/><rdf:Description rdf:about="#hasParent"/></owl:propertyChainAxiom>
    </owl:ObjectProperty>
</rdf:RDF>`;
const files = { 'kin.owl': CHAINS, 'pizza.owl': PIZZA_XML, 'zoo.jsonld': ZOO_JSONLD, 'shop.owl': SHOP_FUNCTIONAL, 'broken.owl': PIZZA_XML.slice(0, PIZZA_XML.indexOf('<owl:Class rdf:about="#Topping">')), 'people.ttl': '@prefix : <http://example.org/people#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n:Person a owl:Class ; rdfs:label "Person" .\n:Clerk a owl:Class ; rdfs:label "Clerk" ; rdfs:subClassOf :Person .\n' };
for (const [name, text] of Object.entries(files)) fs.writeFileSync(tmp + name, text);

// A server that has the pizza ontology: for other sites to fetch, for this site only, and not at all.
const server = http.createServer((req, res) => {
  if (req.url === '/open/pizza.owl') res.writeHead(200, { 'Content-Type': 'application/rdf+xml', 'Access-Control-Allow-Origin': '*' }).end(PIZZA_XML);
  else if (req.url === '/closed/pizza.owl') res.writeHead(200, { 'Content-Type': 'application/rdf+xml' }).end(PIZZA_XML);
  else res.writeHead(404, 'Not Found', { 'Access-Control-Allow-Origin': '*' }).end('nothing here');
});
await new Promise((r) => server.listen(5184, '127.0.0.1', r));
const HOST = 'http://127.0.0.1:5184';

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
// What the browser itself says about a request it was not allowed to make is no fault of the app.
page.on('console', (m) => m.type() === 'error' && !/CORS|Failed to load resource|net::ERR/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
const toast = async () => flat(await page.locator('.toast').innerText().catch(() => ''));
const name = () => page.getByLabel('Model name').inputValue();
const nodes = async () => (await page.locator('.node text').allTextContents()).map(flat).filter(Boolean).sort();
const fileInput = page.locator('.header input[type=file]');
const openFile = async (file) => { await fileInput.setInputFiles(tmp + file); };
const opened = (text) => page.waitForFunction((t) => (document.querySelector('.toast')?.textContent ?? '').includes(t), text);
const message = page.getByRole('alertdialog');
const fileMenu = async (item) => { await page.locator('.header').getByRole('button', { name: /File/ }).click(); await page.getByRole('menuitem', { name: item }).click(); };

await page.goto(base);
// The OWL service is looked for where nothing answers, until it is started below.
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('conceptweaver:reasoner-url', 'http://127.0.0.1:5195'); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- RDF/XML, from the File menu
await page.locator('.header').getByRole('button', { name: /File/ }).click();
ok(flat(await page.getByRole('menuitem', { name: /^Open a file/ }).innerText()).includes('OWL, RDF, JSON') && (await page.getByRole('menuitem', { name: /^Open from a URL/ }).count()) === 1, 'the File menu opens a file in OWL, RDF or JSON, and an ontology from a URL');
await page.keyboard.press('Escape');
const accepted = (await fileInput.getAttribute('accept')).split(',');
ok(['.owl', '.rdf', '.ttl', '.jsonld', '.ofn', '.json'].every((x) => accepted.includes(x)), 'the file dialog offers .owl, .rdf and the other syntaxes: ' + (await fileInput.getAttribute('accept')));
await openFile('pizza.owl');
await opened('Opened “Pizza ontology” from RDF/XML');
ok((await toast()) === 'Opened “Pizza ontology” from RDF/XML: 6 terms, 4 relations.' && (await name()) === 'Pizza ontology', 'an RDF/XML file (.owl) is opened as the model: ' + (await toast()));
ok((await nodes()).join('|') === 'Margherita|My lunch|Pizza|Tomato|Topping|price : decimal', 'its classes, data property and individual are on the canvas: ' + (await nodes()).join(', '));
let ttl = await turtle();
ok(ttl.includes(':Margherita a owl:Class') && /rdfs:subClassOf :Pizza/.test(ttl) && /owl:onProperty :hasTopping ;\s*owl:someValuesFrom :Tomato/.test(ttl) && ttl.includes(':MyLunch a owl:NamedIndividual , :Margherita') && ttl.includes('owl:imports <http://example.org/food>'), 'the hierarchy, a restriction, a membership and the import are what the file states, with its namespace as the default one');
await tab('Entities');
ok(flat(await page.locator('.view .view-head').innerText()).startsWith('Classes (4) Object properties (1) Data properties (1) Individuals (1) Relationships (4)'), 'and it is listed by kind in Entities: ' + flat(await page.locator('.view .view-head').innerText()).slice(0, 96));
await tab('Graph');

// ---------------------------------------------------------------- JSON-LD, dropped on the window
const drop = await page.evaluateHandle(([text]) => { const d = new DataTransfer(); d.items.add(new File([text], 'zoo.jsonld', { type: 'application/ld+json' })); return d; }, [ZOO_JSONLD]);
await page.dispatchEvent('.app', 'dragover', { dataTransfer: drop });
await page.dispatchEvent('.app', 'drop', { dataTransfer: drop });
await opened('Opened “Zoo” from JSON-LD');
ok((await toast()) === 'Opened “Zoo” from JSON-LD: 2 terms, 1 relations.' && (await nodes()).join('|') === 'Animal|Lion', 'a JSON-LD file dropped on the window is opened the same way: ' + (await toast()));

// ---------------------------------------------------------------- what cannot be read
await openFile('broken.owl');
await message.waitFor();
ok(/^the file could not be opened$/i.test(flat(await message.locator('h2').innerText())) && flat(await message.locator('p').innerText()) === '“broken.owl” was not opened, and the model in the editor is as it was. It is not well-formed RDF/XML: the file ends before its root element <rdf:RDF> is closed, so the end of it is missing.' && (await name()) === 'Zoo', 'a file that was cut short is refused, not opened as a smaller ontology, in a message that stays; the model is left as it was: ' + flat(await message.locator('p').innerText()).slice(0, 90));
await page.waitForTimeout(4500);
ok((await message.count()) === 1, 'the message is still there when a notice would have gone');
await message.getByRole('button', { name: 'OK' }).click();
ok((await message.count()) === 0, 'until it is dismissed');
// A syntax that is not RDF, with no OWL service to convert it.
await openFile('shop.owl');
await message.waitFor();
const hint = flat(await message.locator('p').innerText());
ok(hint.startsWith('“shop.owl” was not opened, and the model in the editor is as it was. It is in OWL functional syntax, which is not RDF: the app reads it through its local OWL service, and none answers at http://127.0.0.1:5195.') && hint.includes('pnpm reasoner') && hint.includes('save the ontology as RDF/XML or Turtle') && (await name()) === 'Zoo', 'OWL functional syntax without the OWL service is refused, saying how to start it and what to save the ontology as instead');
await message.getByRole('button', { name: 'OK' }).click();

// ---------------------------------------------------------------- from a URL
await fileMenu(/^Open from a URL/);
const dialog = page.getByRole('dialog');
ok(/^open an ontology from a url$/i.test(flat(await dialog.locator('h2').innerText())) && (await dialog.getByLabel('Ontology URL').evaluate((el) => el === document.activeElement)), 'Open from a URL asks for the address');
await dialog.getByLabel('Ontology URL').fill(HOST + '/missing.owl');
await dialog.getByRole('button', { name: 'Open', exact: true }).click();
await dialog.getByRole('alert').waitFor();
ok(flat(await dialog.getByRole('alert').innerText()) === 'The server answered 404 Not Found.' && (await name()) === 'Zoo', 'an address with nothing at it says so: ' + flat(await dialog.getByRole('alert').innerText()));
await dialog.getByLabel('Ontology URL').fill(HOST + '/closed/pizza.owl');
await dialog.getByRole('button', { name: 'Open', exact: true }).click();
await page.waitForFunction(() => /could not be fetched/.test(document.querySelector('[role=dialog] [role=alert]')?.textContent ?? ''));
ok(flat(await dialog.getByRole('alert').innerText()).includes('The server may not allow requests from other sites (CORS), or it may be unreachable. Download the ontology and open it as a file instead.'), 'a server that does not let other sites fetch from it is explained, with the way round it');
await dialog.getByLabel('Ontology URL').fill(HOST + '/open/pizza.owl');
await dialog.getByLabel('Ontology URL').press('Enter');
await opened('Opened “Pizza ontology” from RDF/XML');
ok((await dialog.count()) === 0 && (await name()) === 'Pizza ontology' && (await nodes()).length === 6, 'an ontology a server gives as RDF/XML is opened from its address');

// ---------------------------------------------------------------- an ontology added for reuse, and data to validate
await tab('Align');
const align = page.locator('.alignment');
await align.locator('.add-ontology input[type=file]').setInputFiles(tmp + 'pizza.owl');
const preview = page.locator('.ext-preview');
await preview.waitFor();
const summary = flat(await preview.innerText());
ok(['Pizza ontology', 'Ontology IRI http://example.org/pizza', 'Classes 4', 'Object properties 1', 'Individuals 1'].every((x) => summary.includes(x)), 'an RDF/XML ontology can be added for reuse: its summary is shown before anything is added');
await preview.getByRole('button', { name: 'Cancel' }).click();
await align.getByRole('button', { name: 'From a URL…' }).click();
await align.getByLabel('Ontology URL').fill(HOST + '/open/pizza.owl');
await align.getByRole('button', { name: 'Fetch', exact: true }).click();
await preview.waitFor();
ok(flat(await preview.innerText()).includes('Pizza ontology'), 'and so can one fetched from a URL as RDF/XML');
await preview.getByRole('button', { name: 'Cancel' }).click();
await tab(/^Validation/);
const validation = page.locator('.validation');
await validation.locator('input[type=file]').last().setInputFiles(tmp + 'pizza.owl');
await page.waitForFunction(() => /triples/.test(document.querySelector('.toast')?.textContent ?? ''));
ok(/^pizza\.owl: \d+ triples, read from RDF\/XML, now the data SHACL validates\./.test(await toast()), 'data to validate is read from RDF/XML as well: ' + (await toast()));
await tab('Graph');

// ---------------------------------------------------------------- the syntaxes that are OWL's own, through the OWL service
const why = unavailable();
if (why) console.log(`SKIP OWL functional syntax through the OWL service: ${why}`);
else {
  const service = await startReasoner({ port: 5195, quiet: true, log: () => {} });
  try {
    await openFile('shop.owl');
    await opened('Opened “Shop ontology” from OWL functional syntax');
    ok((await toast()) === 'Opened “Shop ontology” from OWL functional syntax: 3 terms, 2 relations.' && (await nodes()).join('|') === 'Book|Customer|Product', 'with the OWL service running, a file in OWL functional syntax is opened: ' + (await toast()));
    ttl = await turtle();
    ok(ttl.includes(':Book a owl:Class') && /rdfs:subClassOf :Product/.test(ttl) && /owl:onProperty :buys ;\s*owl:someValuesFrom :Product/.test(ttl), 'with its subclass and its restriction');
  } finally {
    await service.stop();
  }
}

// ---------------------------------------------------------------- what the model has no place for
await openFile('kin.owl');
await message.waitFor();
const left = flat(await message.locator('p').innerText());
ok(/^opened, with statements kept that cannot be edited here$/i.test(flat(await message.locator('h2').innerText())) && left.startsWith('Opened “Kinship” from RDF/XML: 1 terms, 0 relations. The file also has 1 property chain, which the editor has no place for. It is kept as it was and written back whenever the ontology is saved or exported, but it is not shown or edited here.') && (await name()) === 'Kinship', 'an ontology with something the model has no place for opens, saying that it is kept: ' + left.slice(0, 160));
await message.getByRole('button', { name: 'OK' }).click();
ttl = await turtle();
ok(/#propertyChainAxiom> \( <http:\/\/example\.org\/kin#hasParent> <http:\/\/example\.org\/kin#hasParent> \)/.test(ttl), 'and it is written back with the ontology, as it was read');

// ---------------------------------------------------------------- the formats there were
await openFile('people.ttl');
await opened('Opened “people” from Turtle');
ok((await nodes()).join('|') === 'Clerk|Person', 'a Turtle file is opened as before: ' + (await toast()));
await fileMenu(/^Download as JSON/).catch(() => {});

ok(errors.length === 0, 'no errors in the console' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
