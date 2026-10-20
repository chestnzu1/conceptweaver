// Drives the built app in a headless browser to check element type editing in the LDM Entities
// workspace (roadmap 2.12): an entity made a reference entity and back, its mapping following it;
// an incompatible conversion detected before anything is written; a domain made into a reference
// entity as a reviewed structural transformation, its mapping following; a mapped entity made into
// a domain with its mapping kept for review, never called compatible; an element with no mapping
// classified and converted; undo and redo taking the type, the structure and the mapping together;
// a second LDM derived from the same ontology left alone; and all of it kept across a reload, an
// export and an import, with the ontology never written.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync('/tmp/cw-element-types-');
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => {
  if (!c) failed++;
  console.log((c ? 'PASS ' : 'FAIL ') + m);
};
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const view = (name) => page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
const part = (name) => page.getByRole('tablist', { name: 'Part of the logical model' }).getByRole('tab', { name });
const models = page.locator('.dialog.logical-models');
const transform = page.locator('.dialog.transform');
const trace = page.locator('.ldm-traceability');
const form = page.locator('.trace-form');
const preview = page.locator('.element-type-preview');
const typeField = () => page.getByLabel('Element type', { exact: true });
const listRows = () => page.locator('.ldm-list li');
const rowFor = (name) => page.locator('.ldm-list li button', { hasText: name }).first();
const traceRow = (name) => trace.locator('.trace-mappings li').filter({ has: page.locator('.trace-name', { hasText: new RegExp(`^${name}$`) }) }).first();
const factsOf = async (name) => {
  await traceRow(name).locator('button').click();
  await trace.locator('.ldm-editor .trace-facts').waitFor();
  return flat(await trace.locator('.ldm-editor .trace-facts').innerText());
};
const turtle = async () => {
  await view('RDF').click();
  const ttl = await page.locator('.rdf-code').innerText();
  await view('Graph').click();
  await page.waitForSelector('.node');
  return ttl;
};
const derive = async () => {
  await part(/^Entities/).click();
  await page.getByRole('button', { name: /Derive from the ontology/ }).click();
  await transform.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.dialog.transform .proposal').length === 17);
  await transform.getByRole('button', { name: 'Apply the chosen' }).click();
  await transform.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 8);
};
const switchModel = async (name) => {
  await page.getByLabel('Logical model', { exact: true }).selectOption({ label: name });
};
const openModel = async (name) => {
  await page.getByRole('button', { name: 'Logical models…' }).click();
  await models.waitFor();
  await models.getByLabel('Name of the new logical model').fill(name);
  await models.getByRole('button', { name: 'Make a logical model' }).click();
  await models.locator('.logical-row').last().getByRole('button', { name: 'Open' }).click();
  await page.locator('.ldm-view .ldm-head').waitFor();
};
const newEntity = async (name) => {
  await page.getByRole('button', { name: 'New entity' }).click();
  const field = page.getByLabel('Entity name');
  await field.waitFor();
  await field.fill(name);
  await field.press('Enter');
  await page.waitForFunction((n) => document.querySelector('input[aria-label="Entity name"]')?.value === n, name);
};
const addAttribute = async (name) => {
  await page.getByRole('button', { name: 'Add attribute' }).click();
  const field = page.getByLabel('Name of the attribute Attribute');
  await field.waitFor();
  await field.fill(name);
  await field.press('Enter');
  await page.getByLabel(`Name of the attribute ${name}`).waitFor();
};
const addPrimaryKey = async () => {
  await page.getByRole('button', { name: 'Add primary key' }).click();
  await page.locator('.ldm-key').waitFor();
};
const mapByHand = async (label, source, strategy) => {
  await part(/^Traceability/).click();
  await page.getByRole('button', { name: /Map an element by hand/ }).click();
  await form.waitFor();
  await page.getByLabel('Element to map').selectOption({ label });
  await page.getByLabel('Ontology entity', { exact: true }).fill(source);
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await form.getByLabel('Strategy').selectOption({ label: strategy });
  await form.getByLabel('Why it holds').fill('Kept for the people who read the model.');
  await form.getByRole('button', { name: 'Make the mapping' }).click();
  await form.waitFor({ state: 'detached' });
};
const chooseType = async (value) => {
  await typeField().selectOption(value);
  await preview.waitFor();
  return flat(await preview.innerText());
};
const applyType = async () => {
  await preview.getByRole('button', { name: 'Apply the change' }).click();
  await preview.waitFor({ state: 'detached' });
};

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
const ontologyBefore = await turtle();

// ---------------------------------------------------------------- a model from the ontology
await view('LDM').click();
await page.getByRole('button', { name: /Make a logical model/ }).click();
await models.waitFor();
await models.getByLabel('Name of the new logical model').fill('Catalogue A');
await models.getByRole('button', { name: 'Make a logical model' }).click();
await models.getByRole('button', { name: 'Open', exact: true }).click();
await page.locator('.ldm-view .ldm-head').waitFor();
await derive();

// ---------------------------------------------------------------- A: entity → reference entity
await part(/^Entities/).click();
await rowFor('Film').click();
await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'Film');
ok((await typeField().inputValue()) === 'entity', 'the element type is shown, an entity to begin with');
ok(flat(await page.locator('.element-type').innerText()).includes('A thing the application keeps rows about'), 'with what that type means');
let text = await chooseType('reference');
ok(text.includes('Now') && text.includes('After') && text.includes('Reference Entity'), 'choosing another type opens a preview of the change: ' + text.slice(0, 160));
ok(text.includes('is a reference entity now'), 'saying what the entity becomes');
ok(text.includes('class → reference entity') && text.includes('follows'), 'and that its mapping follows it to the strategy that makes one');
ok(!flat(await rowFor('Film').innerText()).includes('Reference entity'), 'nothing is written merely by choosing the type');
await page.screenshot({ path: shots + 'element-types-entity-preview.png' });
await applyType();
await page.waitForFunction(() => document.querySelector('select[aria-label="Element type"]')?.value === 'reference');
ok(flat(await rowFor('Film').innerText()).includes('Reference entity'), 'applied, the entity is a reference entity in the list');
ok(flat(await page.locator('.element-type').innerText()).includes('whose rows are the codes'), 'and the editor says what it is now');

// The diagram and traceability read the same type.
await part(/^Diagram/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-node')].some((n) => n.textContent?.includes('Film')));
const filmNode = page.locator('.ldm-node[aria-label^="Film"]');
ok((await filmNode.locator('.ldm-node-kind').textContent()) === 'Reference', 'the diagram labels it a reference entity');
await part(/^Traceability/).click();
await traceRow('Film').waitFor();
ok((await traceRow('Film').locator('.trace-dot.current').count()) === 1, 'traceability calls the mapping current');
ok((await factsOf('Film')).includes('class → reference entity'), 'and records the strategy that followed it');
await page.screenshot({ path: shots + 'element-types-traceability.png' });

// E: one undo takes the type and the mapping back; one redo puts both back.
await page.getByRole('button', { name: 'Undo' }).click();
await part(/^Entities/).click();
await rowFor('Film').click();
await page.waitForFunction(() => document.querySelector('select[aria-label="Element type"]')?.value === 'entity');
ok(!flat(await rowFor('Film').innerText()).includes('Reference entity'), 'one undo makes it an ordinary entity again');
await part(/^Traceability/).click();
await traceRow('Film').waitFor();
ok((await traceRow('Film').locator('.trace-dot.current').count()) === 1 && (await factsOf('Film')).includes('class → entity'), 'with its mapping back, current, as it was');
await page.getByRole('button', { name: 'Redo' }).click();
await part(/^Entities/).click();
await rowFor('Film').click();
await page.waitForFunction(() => document.querySelector('select[aria-label="Element type"]')?.value === 'reference');
ok(flat(await rowFor('Film').innerText()).includes('Reference entity'), 'one redo makes it a reference entity again');

// ---------------------------------------------------------------- F: an unsafe conversion is refused before applying
text = await chooseType('domain');
ok(text.toLowerCase().includes('cannot be applied'), 'a conversion the element cannot take is marked as such');
ok(flat(await preview.locator('.conversion-conflicts').innerText()).includes('attributes besides its one value'), 'naming why: ' + flat(await preview.locator('.conversion-conflicts').innerText()));
ok(await preview.getByRole('button', { name: 'Apply the change' }).isDisabled(), 'and cannot be applied');
await preview.getByRole('button', { name: 'Cancel' }).click();
await preview.waitFor({ state: 'detached' });
ok((await typeField().inputValue()) === 'reference', 'cancel leaves the element as it was');
await part(/^Domains/).click();
ok((await page.getByText('No domain yet.', { exact: true }).isVisible()), 'and makes no domain');

// ---------------------------------------------------------------- D: an element with no mapping is classified and converted
await part(/^Entities/).click();
await newEntity('Loose end');
await addAttribute('Code');
await addPrimaryKey();
text = await chooseType('reference');
ok(text.includes('is a reference entity now'), 'an element no mapping targets can change type');
ok((await preview.locator('h4', { hasText: 'Mappings' }).count()) === 0, 'with no mapping to move');
await applyType();
ok(flat(await rowFor('Loose end').innerText()).includes('Reference entity'), 'and it is a reference entity');

// ---------------------------------------------------------------- B, C: a domain becomes a reference entity, its mapping following
await part(/^Domains/).click();
await page.getByRole('button', { name: 'New domain' }).click();
const domainName = page.getByLabel('Domain name');
await domainName.waitFor();
await domainName.fill('Genre list');
await domainName.press('Enter');
for (const [i, code] of ['Drama', 'Comedy'].entries()) {
  await page.getByRole('button', { name: 'Add value' }).click();
  await page.getByLabel(`Code of value ${i + 1}`).fill(code);
  await page.getByLabel(`Code of value ${i + 1}`).press('Enter');
  await page.getByLabel(`Label of value ${i + 1}`).fill(code);
  await page.getByLabel(`Label of value ${i + 1}`).press('Enter');
}
await mapByHand('Domain Genre list', 'Genre', 'enumerated class → domain');
ok((await traceRow('Genre list').locator('.trace-dot.current').count()) === 1, 'the domain is mapped from the class Genre');

await part(/^Domains/).click();
await rowFor('Genre list').click();
text = await chooseType('reference');
ok(text.includes('Entity “Genre list”') && text.includes('code') && text.includes('label'), 'a domain becomes a reference entity with a code and a label');
ok(text.includes('Primary key'), 'identified by a primary key on the code');
ok(text.includes('Drama') && text.includes('Comedy'), 'with its values as rows');
ok(text.includes('How the members are kept'), 'the value decision is reviewed');
ok(text.includes('enumerated class → reference entity') && text.includes('follows'), 'and the mapping follows it');
await page.screenshot({ path: shots + 'element-types-domain-preview.png' });
await applyType();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Genre list'));
await part(/^Domains/).click();
ok(flat(await page.locator('.ldm-list').innerText()).includes('No domain yet.'), 'the domain is gone');
await part(/^Entities/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Genre list'));
await rowFor('Genre list').click();
ok((await typeField().inputValue()) === 'reference', 'the entity that replaced it is a reference entity');
ok((await page.getByLabel('Name of the attribute code').count()) === 1, 'with its code');
await page.locator('.ldm-attribute').filter({ has: page.getByLabel('Name of the attribute label') }).waitFor();
ok(!(await page.locator('.ldm-attribute').filter({ has: page.getByLabel('Name of the attribute code') }).locator('.check', { hasText: 'Optional' }).locator('input').isChecked()), 'the code is mandatory');
await part(/^Traceability/).click();
await traceRow('Genre list').waitFor();
ok((await traceRow('Genre list').locator('.trace-dot.current').count()) === 1 && (await factsOf('Genre list')).includes('enumerated class → reference entity'), 'its mapping is current, following it');

// One undo brings the domain and its mapping back; one redo changes it again.
await page.getByRole('button', { name: 'Undo' }).click();
await part(/^Domains/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Genre list'));
await part(/^Entities/).click();
ok((await rowFor('Genre list').count()) === 0, 'one undo restores the domain and takes the entity away');
await part(/^Traceability/).click();
await traceRow('Genre list').waitFor();
const back = await factsOf('Genre list');
ok(back.includes('enumerated class → domain') && !back.includes('enumerated class → reference entity'), 'with its mapping back to the domain strategy');
await page.getByRole('button', { name: 'Redo' }).click();
await part(/^Entities/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Genre list'));
ok((await rowFor('Genre list').count()) === 1, 'one redo converts it again');

// ---------------------------------------------------------------- C: a mapped entity becomes a domain, its mapping kept for review
await newEntity('One value');
await addAttribute('Value');
await addPrimaryKey();
await mapByHand('One value', 'Genre', 'class → entity');
await part(/^Entities/).click();
await rowFor('One value').click();
text = await chooseType('domain');
ok(text.includes('kept, for review'), 'a mapping no strategy does the same for is kept for review, never called compatible');
ok(text.includes('Domain “One value”') || text.includes('Domain “One value”'), 'the entity becomes a domain');
await applyType();
await part(/^Domains/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'One value'));
ok((await page.locator('.ldm-list li button', { hasText: 'One value' }).count()) === 1, 'the domain exists');
await part(/^Entities/).click();
ok((await rowFor('One value').count()) === 0, 'the entity is gone');
await part(/^Traceability/).click();
await traceRow('One value').waitFor();
ok((await traceRow('One value').locator('.trace-dot.mismatched').count()) === 1, 'traceability marks the kept mapping mismatched, not compatible');

// ---------------------------------------------------------------- the list filter and search read the type
await part(/^Entities/).click();
await page.getByLabel('Filter entities by element type').selectOption('reference');
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 3);
ok((await listRows().count()) === 3, 'the list can show only reference entities');
await page.getByLabel('Filter entities by element type').selectOption('all');
await page.getByLabel('Search entities').fill('reference entity');
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 3);
ok((await listRows().count()) === 3, 'searching for the type finds them');
await page.getByLabel('Search entities').fill('');
await page.getByLabel('Search entities').press('Escape');

// ---------------------------------------------------------------- J: another LDM from the same ontology is untouched
await openModel('Catalogue B');
await derive();
await part(/^Entities/).click();
ok((await page.locator('.ldm-list li', { hasText: 'Film' }).locator('small', { hasText: 'Reference entity' }).count()) === 0, 'the other LDM’s Film is still an ordinary entity');
await switchModel('Catalogue A');
await part(/^Entities/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Film'));
ok((await page.locator('.ldm-list li', { hasText: 'Film' }).locator('small', { hasText: 'Reference entity' }).count()) === 1, 'while the first one keeps its reference entity');

// ---------------------------------------------------------------- G: kept across a reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await view('LDM').click();
await switchModel('Catalogue A');
await part(/^Entities/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Film'));
ok((await page.locator('.ldm-list li', { hasText: 'Film' }).locator('small', { hasText: 'Reference entity' }).count()) === 1, 'after a reload the reference entity is still one');
ok((await page.locator('.ldm-list li', { hasText: 'Genre list' }).locator('small', { hasText: 'Reference entity' }).count()) === 1, 'and so is the entity the domain became');
await part(/^Traceability/).click();
await traceRow('Film').waitFor();
ok((await traceRow('Film').locator('.trace-dot.current').count()) === 1 && (await factsOf('Film')).includes('class → reference entity'), 'and their mappings are there, current');

// ---------------------------------------------------------------- G: exported and imported with their types and mappings
await page.getByRole('button', { name: 'Logical models…' }).click();
await models.waitFor();
const modelRow = models.locator('.logical-row').first();
const [download] = await Promise.all([page.waitForEvent('download'), modelRow.getByRole('button', { name: 'Export' }).click()]);
const file = tmp + '/' + download.suggestedFilename();
await download.saveAs(file);
const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(exported.version === 2, 'the file records the format that knows reference entities');
const filmExported = exported.model.entities.find((e) => e.name === 'Film');
const genreExported = exported.model.entities.find((e) => e.name === 'Genre list');
ok(filmExported.reference === true && genreExported.reference === true, 'the reference entities are written as such');
ok(exported.model.mappings.some((m) => m.strategyId === 'OWL_CLASS_TO_LDM_REFERENCE_ENTITY'), 'and so are the mappings that followed them');
await models.locator('input[type=file]').setInputFiles(file);
await page.waitForFunction(() => document.querySelectorAll('.dialog.logical-models .logical-row').length === 3);
await models.locator('.logical-row').last().getByRole('button', { name: 'Open' }).click();
await page.locator('.ldm-view .ldm-head').waitFor();
await part(/^Entities/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Film'));
ok((await page.locator('.ldm-list li', { hasText: 'Film' }).locator('small', { hasText: 'Reference entity' }).count()) === 1, 'an imported file brings back the reference entity');
await part(/^Traceability/).click();
await traceRow('Film').waitFor();
ok((await traceRow('Film').locator('.trace-dot.current').count()) === 1 && (await factsOf('Film')).includes('class → reference entity'), 'with its mapping, still current');

// ---------------------------------------------------------------- I: the ontology was never written
const ontologyAfter = await turtle();
ok(ontologyAfter === ontologyBefore, 'the ontology was never written');
await page.screenshot({ path: shots + 'element-types.png' });
console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed || errors.length ? 1 : 0);
