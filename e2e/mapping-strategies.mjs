// Drives the built app in a headless browser to check typed mapping strategies and the reviewed
// structural conversion they ask for (roadmap LM-4, FR-M18-8): a domain mapped by hand to a class,
// the strategy chooser offering only what can be made and saying why the rest cannot; a second
// mapping on the domain making the conversion refuse with its conflict and apply nothing; the
// preview of a domain becoming a reference entity, applied as one change set that makes the
// entity with its code, keys and values note, retypes the attributes and retargets the mapping;
// one undo taking both back and one redo putting both back; a second LDM left alone; a rationale
// saved as metadata only; and all of it kept across a reload, with the ontology never written.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
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
const preview = page.locator('.conversion-preview');
const rows = () => trace.locator('.trace-mappings li');
const rowFor = (text) => rows().filter({ hasText: text });
// The hand mapping on the domain, not the derived entity that happens to share a source's name.
const handRow = (source) => rows().filter({ hasText: 'Genre list' }).filter({ hasText: source });
const turtle = async () => {
  await view('RDF').click();
  const ttl = await page.locator('.rdf-code').innerText();
  await view('Graph').click();
  await page.waitForSelector('.node');
  return ttl;
};
const makeLdm = async (name) => {
  await page.getByRole('button', { name: 'Logical models…' }).click();
  await models.waitFor();
  await models.getByLabel('Name of the new logical model').fill(name);
  await models.getByRole('button', { name: 'Make a logical model' }).click();
  await models.locator('.logical-row').last().getByRole('button', { name: 'Open' }).click();
  await page.locator('.ldm-view .ldm-head').waitFor();
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
const pick = async (label, source, strategy) => {
  await page.getByLabel('Element to map').selectOption({ label });
  await page.getByLabel('Ontology entity', { exact: true }).fill(source);
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await form.getByLabel('Strategy').selectOption({ label: strategy });
  await form.getByLabel('Why it holds').fill('Kept for the people who read the model.');
};
const saveForm = async (name) => {
  await form.getByRole('button', { name }).click();
  await form.waitFor({ state: 'detached' });
};
const switchModel = async (name) => {
  await page.getByLabel('Logical model', { exact: true }).selectOption({ label: name });
};

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
const ontologyBefore = await turtle();

// ---------------------------------------------------------------- a domain mapped by hand
await view('LDM').click();
await page.getByRole('button', { name: /Make a logical model/ }).click();
await models.waitFor();
await models.getByLabel('Name of the new logical model').fill('Catalogue A');
await models.getByRole('button', { name: 'Make a logical model' }).click();
await models.getByRole('button', { name: 'Open', exact: true }).click();
await page.locator('.ldm-view .ldm-head').waitFor();
await derive();

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
ok((await page.locator('.ldm-list li').count()) === 1, 'a domain of two values is made by hand');

await part(/^Traceability/).click();
await trace.locator('.trace-mappings li').first().waitFor();
await page.getByRole('button', { name: /Map an element by hand/ }).click();
await form.waitFor();
await pick('Domain Genre list', 'Genre', 'enumerated class → domain');
await saveForm('Make the mapping');
await rowFor('Genre list').first().waitFor();
ok((await rowFor('Genre list').count()) === 1, 'the domain is mapped from the class Genre by hand');

// ---------------------------------------------------------------- only what can be made is offered
await rowFor('Genre list').first().click();
await page.getByRole('button', { name: 'Edit this mapping…' }).click();
await form.waitFor();
const offered = await form.getByLabel('Strategy').locator('option').allInnerTexts();
ok(offered.includes('enumerated class → domain'), 'the strategy that makes a domain is offered: ' + offered.join(' | '));
ok(!offered.includes('data property → attribute'), 'the strategy that makes an attribute is not');
ok(offered.includes('enumerated class → reference entity'), 'nor is the representation that would convert the domain hidden: it is offered as a conversion');
await form.locator('.strategy-reasons summary').click();
const reasons = flat(await form.locator('.strategy-reasons').innerText());
ok(reasons.includes('data property → attribute') && reasons.includes('It makes an attribute, not a domain.'), 'and the block says of each why it does not apply: ' + reasons.slice(0, 220));

// ---------------------------------------------------------------- a conflict stops the conversion
await form.getByLabel('Strategy').selectOption({ label: 'enumerated class → domain' });
await form.getByRole('button', { name: 'Cancel' }).click();
await form.waitFor({ state: 'detached' });
await page.getByRole('button', { name: /Map an element by hand/ }).click();
await form.waitFor();
await pick('Domain Genre list', 'Studio', 'enumerated class → domain');
await saveForm('Make the mapping');
await handRow('Studio').first().waitFor();
ok((await rowFor('Genre list').count()) === 2, 'a second mapping also targets the domain');

await handRow('Studio').first().click();
await page.getByRole('button', { name: 'Edit this mapping…' }).click();
await form.waitFor();
await form.getByLabel('Strategy').selectOption({ label: 'enumerated class → reference entity' });
await form.locator('.conversion-conflicts').waitFor();
ok(flat(await form.locator('.conversion-conflicts').innerText()).includes('Another mapping'), 'the conversion is refused, naming the mapping that still targets the domain');
ok(await form.getByRole('button', { name: 'Apply the Transformation' }).isDisabled(), 'with nothing to apply');
await page.screenshot({ path: shots + 'mapping-strategies-conflict.png' });
await form.getByRole('button', { name: 'Cancel' }).click();
await form.waitFor({ state: 'detached' });
await part(/^Domains/).click();
ok((await page.locator('.ldm-list li').count()) === 1, 'and nothing of the refused conversion was written');
await part(/^Traceability/).click();
await handRow('Studio').first().click();
await page.getByRole('button', { name: 'Remove the mapping…' }).click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-traceability .trace-mappings li').length === 18);
ok((await rowFor('Genre list').count()) === 1, 'the second mapping is removed again, leaving one');

// ---------------------------------------------------------------- the preview, applied as one step
await rowFor('Genre list').first().click();
await page.getByRole('button', { name: 'Edit this mapping…' }).click();
await form.waitFor();
await form.getByLabel('Strategy').selectOption({ label: 'enumerated class → reference entity' });
await preview.waitFor();
const previewText = flat(await preview.innerText());
ok(previewText.includes('Transformation preview') && previewText.includes('Now') && previewText.includes('After'), 'a preview says what the element is and what it would become');
ok(previewText.includes('Entity “Genre list”'), 'it creates the reference entity');
ok(previewText.includes('code') && previewText.includes('label'), 'with a code and a label attribute');
ok(previewText.includes('Primary key'), 'and a primary key');
ok(previewText.includes('Drama') && previewText.includes('Comedy'), 'the domain’s values are named');
ok((await preview.getByLabel('How the members are kept').count()) === 1, 'the value decision is offered, and chosen');
ok((await preview.locator('.conversion-conflicts').count()) === 0, 'and there is nothing to stop it');
ok(await form.getByRole('button', { name: 'Save the mapping' }).isDisabled(), 'the mapping cannot be saved as metadata while it would change the element');
ok(!(await form.getByRole('button', { name: 'Apply the Transformation' }).isDisabled()), 'the transformation can be applied');
await page.screenshot({ path: shots + 'mapping-strategies-preview.png' });

await form.getByRole('button', { name: 'Apply the Transformation' }).click();
await form.waitFor({ state: 'detached' });
await page.waitForFunction(() => document.querySelector('.ldm-traceability .trace-facts')?.textContent?.includes('Converted'));
ok(flat(await trace.locator('.ldm-editor').innerText()).includes('enumerated class → reference entity'), 'applied, the mapping says what it does now');
const facts = flat(await trace.locator('.trace-facts').innerText());
ok(facts.includes('Strategy id') && facts.includes('OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY'), 'and records the strategy id');
ok(facts.includes('Converted') && facts.includes('enumerated class → domain') && facts.includes('enumerated class → reference entity'), 'and the conversion it went through');
await page.waitForFunction(() => document.querySelector('.ldm-traceability .trace-summary')?.textContent?.includes('18 current'));
ok(flat(await trace.locator('.trace-summary').innerText()).includes('0 mismatched'), 'and every mapping is current, none mismatched');

await part(/^Entities/).click();
await page.locator('.ldm-list li button', { hasText: 'Genre list' }).click();
await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'Genre list');
const entityText = flat(await page.locator('.ldm-editor').innerText());
ok(entityText.includes('code') && entityText.includes('label'), 'the entity exists with its code and label');
const codeRow = page.locator('.ldm-attribute').filter({ has: page.getByLabel('Name of the attribute code') });
ok(!(await codeRow.locator('.check', { hasText: 'Optional' }).locator('input').isChecked()), 'the code is mandatory');
ok(flat(await codeRow.innerText()).includes('text'), 'of the domain’s base type');
ok((await page.locator('.ldm-key').count()) === 1, 'and the entity has its primary key');
await part(/^Domains/).click();
ok(flat(await page.locator('.ldm-list').innerText()).includes('No domain yet.'), 'the domain is gone');
await part(/^Diagram/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-node')].some((n) => n.textContent?.includes('Genre list')));
ok(true, 'the new entity is on the diagram');

// ---------------------------------------------------------------- one undo, one redo
await page.getByRole('button', { name: 'Undo' }).click();
await part(/^Domains/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Genre list'));
ok((await page.locator('.ldm-list li').count()) === 1, 'one undo brings the domain back');
await part(/^Entities/).click();
ok((await page.locator('.ldm-list li button', { hasText: 'Genre list' }).count()) === 0, 'and takes the entity away');
await part(/^Traceability/).click();
await handRow('Genre').first().click();
await page.waitForFunction(() => {
  const text = document.querySelector('.ldm-traceability .ldm-editor')?.textContent ?? '';
  return text.includes('enumerated class → domain') && !text.includes('Converted');
});
ok(true, 'with the mapping back as it was');
await page.getByRole('button', { name: 'Redo' }).click();
await part(/^Domains/).click();
await page.waitForFunction(() => ![...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Genre list'));
ok(flat(await page.locator('.ldm-list').innerText()).includes('No domain yet.'), 'one redo converts it again');

// ---------------------------------------------------------------- a rationale is metadata only
await part(/^Traceability/).click();
await rowFor('Genre list').first().click();
await page.getByRole('button', { name: 'Edit this mapping…' }).click();
await form.waitFor();
await form.getByLabel('Why it holds').fill('The categories are rows now, for a reader.');
ok((await form.locator('.conversion-preview').count()) === 0, 'changing the rationale asks for no conversion');
await saveForm('Save the mapping');
await page.waitForFunction(() => document.querySelector('.ldm-traceability .ldm-editor')?.textContent?.includes('The categories are rows now, for a reader.'));
const savedText = flat(await trace.locator('.ldm-editor').innerText());
ok(savedText.includes('The categories are rows now, for a reader.'), 'the words are saved');
ok(!flat(await rowFor('Genre list').first().innerText()).includes('changed by you'), 'and the element was not touched by the save');

// ---------------------------------------------------------------- another LDM is left alone
await makeLdm('Catalogue B');
await derive();
const otherEntities = await page.locator('.ldm-list li button > span').allInnerTexts();
switchModel('Catalogue A');
await part(/^Entities/).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Genre list'));
switchModel('Catalogue B');
await part(/^Entities/).click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 8);
ok(JSON.stringify(await page.locator('.ldm-list li button > span').allInnerTexts()) === JSON.stringify(otherEntities), 'a conversion in one LDM leaves another one exactly as it was');
ok((await page.locator('.ldm-list li button', { hasText: 'Genre list' }).count()) === 0, 'with no entity from it');

// ---------------------------------------------------------------- kept across a reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await view('LDM').click();
await switchModel('Catalogue A');
await part(/^Traceability/).click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-traceability .trace-mappings li').length === 18);
ok((await rowFor('Genre list').first().locator('.trace-dot.current').count()) === 1, 'after a reload the converted mapping is there and current');
await part(/^Entities/).click();
await page.locator('.ldm-list li button', { hasText: 'Genre list' }).click();
ok((await page.getByLabel('Name of the attribute code').count()) === 1, 'the entity the conversion made is there, with its code');

const ontologyAfter = await turtle();
ok(ontologyAfter === ontologyBefore, 'the ontology was never written');
console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
