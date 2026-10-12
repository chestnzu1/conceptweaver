// Drives the built app in a headless browser to check the Governance & Metadata page.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1900, height: 1300 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const rdf = async (subject) => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Entities'); return flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? ''); };
const view = page.locator('.view');
const form = page.locator('.gov-form');
const field = (id) => form.locator(`[data-field="${id}"]`);
const row = (name) => page.locator('.gov-list tbody tr', { has: page.locator('td:first-child', { hasText: new RegExp('^' + name + '$') }) });
const groups = async () => (await form.locator('.gov-group > summary').allInnerTexts()).map((s) => flat(s).replace(/ \d+ .*$/, ''));
const pick = async (id, text) => {
  await field(id).locator('.chip-add').click();
  await field(id).getByRole('combobox').fill(text);
  await field(id).locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};

await page.goto('http://localhost:5181/');
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- the page
await tab('Entities');
ok((await view.getByRole('tab').allInnerTexts()).map(flat).join('|').startsWith('Classes'), 'the Entities tabs are as they were');
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
ok((await page.locator('.gov-list tbody tr').count()) > 5, 'Governance & Metadata lists the entities of the model: ' + (await page.locator('.gov-list tbody tr').count()));
ok(flat(await page.locator('.gov-detail').innerText()).startsWith('Select an entity'), 'with nothing selected it asks for an entity');

await row('Film').click();
ok(flat(await form.locator('.gov-form-head h3').innerText()) === 'Film', 'selecting an entity shows its metadata');
ok((await groups()).join('|') === 'General metadata|Governance metadata|Technical metadata|Operational metadata|Data quality metadata|All annotations', 'in collapsible groups: ' + (await groups()).join(', '));
ok((await field('name').locator('input').inputValue()) === 'Film' && flat(await field('entityType').innerText()).includes('owl:Class'), 'its name and kind are the entity’s own');
ok((await field('database').count()) === 0 && (await field('owner').count()) === 1, 'a class has an owner but no database');
ok((await page.locator('.inspector').innerText()).includes('Film'), 'the side panel still edits the same entity');

// ---------------------------------------------------------------- editing typed values
await field('modified').locator('input').fill('2026-10-12');
await field('status').locator('select').selectOption('Approved');
await pick('owner', 'Parasite');
await pick('steward', 'Jane Doe');
await field('keywords').locator('input').fill('cinema');
await field('keywords').locator('input').press('Enter');
await field('keywords').locator('input').fill('catalogue');
await field('keywords').locator('input').press('Enter');
let film = await rdf(':Film');
ok(film.includes('dcterms:modified "2026-10-12"^^xsd:date'), 'a date is stored as a date: dcterms:modified "2026-10-12"^^xsd:date');
ok(film.includes('adms:status "Approved"'), 'a controlled value is stored with its standard property (adms:status)');
ok(film.includes('dcterms:rightsHolder :Parasite'), 'an owner chosen from the model is a reference to that entity');
ok(film.includes('dcat:contactPoint "Jane Doe"'), 'a typed name is text');
ok(film.includes('dcat:keyword "cinema" , "catalogue"'), 'a field can have several values');
ok(film.startsWith(':Film a owl:Class ;') && !/dcterms:\w+ \[/.test(film), 'the class itself is unchanged: ' + film.slice(0, 40));
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
ok(flat(await row('Film').innerText()).includes('Approved') && flat(await row('Film').innerText()).includes('Parasite'), 'the list shows the status and the owner: ' + flat(await row('Film').innerText()));

// the label changes, the metadata stays
await field('name').locator('input').fill('Motion picture');
await field('name').locator('input').press('Enter');
ok((await row('Motion picture').count()) === 1 && (await field('status').locator('select').inputValue()) === 'Approved', 'renaming the entity here renames it everywhere and keeps its metadata');
film = await rdf(':Film');
ok(film.includes('rdfs:label "Motion picture"') && film.includes('adms:status "Approved"'), 'and its IRI stays :Film');
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
await field('name').locator('input').fill('Film');
await field('name').locator('input').press('Enter');

// ---------------------------------------------------------------- the same values as the annotations
const annotations = page.locator('.inspector');
ok(flat(await annotations.innerText()).includes('adms:status') , 'the side panel’s annotations show the same values');
await form.locator('.gov-group', { hasText: 'All annotations' }).locator('summary').click();
const all = form.locator('.gov-group', { hasText: 'All annotations' });
ok(flat(await all.locator('.meta-list').innerText()).includes('dcterms:modified 2026-10-12'), 'and so does “All annotations” on the page');
await all.getByRole('button', { name: 'Remove adms:status' }).click();
ok((await field('status').locator('select').inputValue()) === '', 'removing the annotation empties the field');
await field('status').locator('select').selectOption('Draft');

// ---------------------------------------------------------------- validation of input
const data = page.locator('.gov-list tbody tr', { has: page.locator('td:nth-child(2)', { hasText: 'Data property' }) }).first();
const dataName = flat(await data.locator('td').first().innerText());
await data.click();
ok((await field('database').count()) === 1 && (await field('completeness').count()) === 1 && (await field('range').count()) === 1, `a data property (${dataName}) has technical and quality fields`);
await field('completeness').locator('input').fill('140');
await field('completeness').locator('input').press('Enter');
ok(flat(await field('completeness').innerText()).includes('cannot be more than 100'), 'a number out of range is refused, with the reason');
await field('completeness').locator('input').fill('97.5');
await field('completeness').locator('input').press('Enter');
await field('column').locator('input').fill('RELEASE_DT');
await field('column').locator('input').press('Enter');
await tab('RDF');
const ttl = await page.locator('.rdf-code').innerText();
await tab('Entities');
ok(/dqv:hasQualityMeasurement \[ a dqv:QualityMeasurement ; dqv:isMeasurementOf :completeness ; dqv:value "97.5"\^\^xsd:decimal \]/.test(ttl), 'a quality measurement is exported as DQV');
ok(ttl.includes(':column "RELEASE_DT"') && ttl.includes(':column a owl:AnnotationProperty'), 'a field without a standard property is an annotation property of the model');

// ---------------------------------------------------------------- profiles
await row('Parasite').click();
ok((await field('database').count()) === 0, 'an individual has no technical fields');
await form.getByLabel('Metadata profile').selectOption('technicalAsset');
ok((await field('database').count()) === 1 && (await field('location').count()) === 1 && (await field('upstream').count()) === 1, 'given the profile of a technical data asset, it has them');
await field('location').locator('input').fill('not a link');
await field('location').locator('input').press('Enter');
ok(flat(await field('location').innerText()).includes('not a link'), 'a storage location has to be a link');
await field('location').locator('input').fill('https://warehouse.example.org/parasite');
await field('location').locator('input').press('Enter');
const parasite = await rdf(':Parasite');
ok(parasite.includes('dcterms:type "Technical data asset"') && parasite.includes('dcat:accessURL <https://warehouse.example.org/parasite>') && parasite.includes('a owl:NamedIndividual , :Film'), 'it is still the individual it was, with its profile and location stated');
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
ok(flat(await row('Parasite').innerText()).includes('Technical data asset'), 'and is listed as a technical data asset');

// ---------------------------------------------------------------- configuring the registry
await view.getByRole('button', { name: 'Configure fields' }).click();
const config = page.locator('.gov-config');
ok((await config.locator('tbody tr').count()) > 30, 'the registry lists every field: ' + (await config.locator('tbody tr').count()));
await config.getByLabel('Name of the new field').fill('Retention period');
await config.getByLabel('Value type of the new field').selectOption('integer');
await config.getByLabel('Group of the new field').selectOption('Governance');
await config.getByRole('button', { name: 'Add field' }).click();
ok((await config.locator('tr.custom').count()) === 1, 'a field of the model’s own can be added');
await config.getByLabel('Name of the new field').fill('Audience');
await config.getByLabel('RDF property of the new field').fill('gov:audience');
await config.getByRole('button', { name: 'Add field' }).click();
ok(flat(await config.locator('.gov-error').innerText()).includes('prefix “gov” is not known'), 'a property with an unknown prefix is refused');
await config.getByLabel('Name of the new field').fill('');
await config.getByLabel('Data owner is required').check();
await config.getByLabel('Lifecycle status applies to Individual', { exact: true }).uncheck();
await view.getByRole('button', { name: 'Back to the entities' }).click();
ok(flat(await row('Film').innerText()).includes('✓ complete') && flat(await row('Genre').innerText()).includes('1 missing'), 'a required field shows which entities are complete and which are not');
await row('Film').click();
ok((await field((await form.locator('.gov-field', { hasText: 'Retention period' }).getAttribute('data-field'))).count()) === 1, 'the new field is on the form of a class');
await form.locator('.gov-field', { hasText: 'Retention period' }).locator('input').fill('seven');
await form.locator('.gov-field', { hasText: 'Retention period' }).locator('input').press('Enter');
ok(flat(await form.locator('.gov-field', { hasText: 'Retention period' }).innerText()).includes('not a whole number'), 'and takes whole numbers only');
await form.locator('.gov-field', { hasText: 'Retention period' }).locator('input').fill('7');
await form.locator('.gov-field', { hasText: 'Retention period' }).locator('input').press('Enter');
ok((await rdf(':Film')).includes(':retentionPeriod "7"^^xsd:integer'), 'its value is exported as :retentionPeriod "7"^^xsd:integer');
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
await row('Genre').click();
ok(flat(await field('owner').innerText()).includes('required'), 'the required field is marked on an entity that lacks it');
await page.screenshot({ path: shots + 'governance.png' });

// validation
await tab('Validation');
await page.locator('.view').getByRole('button', { name: 'Run all checks', exact: true }).click();
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
ok(flat(await page.locator('.view').innerText()).includes('has no data owner, which is required'), 'the missing owner is reported under Validation');
await tab('Entities');
ok(/\d+ findings? in the last validation run\./.test(flat(await field('validation').innerText())), 'and the entity’s page says what that run found about it: ' + flat(await field('validation').innerText()));
// Changing only which fields are required is a change the validation knows about.
await view.getByRole('button', { name: 'Configure fields' }).click();
await config.getByLabel('Lifecycle status is required').check();
await view.getByRole('button', { name: 'Back to the entities' }).click();
ok(flat(await field('validation').innerText()).includes('before the latest changes'), 'after a change to the field set-up alone, the page says the run is out of date');
await tab('Validation');
ok((await page.locator('.view .stale').count()) === 1, 'and so does Validation');
await page.locator('.view .stale').getByRole('button', { name: 'Run all checks again' }).click();
await page.waitForFunction(() => !document.querySelector('.view .stale') && /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
ok(flat(await page.locator('.view').innerText()).includes('has no lifecycle status, which is required'), 'which then reports the newly required field');
await tab('Entities');

// search
await page.locator('.sidebar input[type="search"], input[aria-label="Search terms"]').first().fill('catalogue');
ok((await page.locator('.gov-list tbody tr').count()) === 1 && (await row('Film').count()) === 1, 'the search box finds an entity by its metadata');
await page.locator('input[aria-label="Search terms"]').first().fill('');

// ---------------------------------------------------------------- persistence
await page.waitForTimeout(900);
await page.reload();
await page.waitForSelector('.node');
await tab('Entities');
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
await row('Film').click();
ok((await field('modified').locator('input').inputValue()) === '2026-10-12' && (await field('status').locator('select').inputValue()) === 'Draft' && flat(await field('owner').innerText()).includes('Parasite'), 'after a reload the values are as they were');
ok((await form.locator('.gov-field', { hasText: 'Retention period' }).locator('input').inputValue()) === '7', 'and so are the field of the model’s own and its value');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
