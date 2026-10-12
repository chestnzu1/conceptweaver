// Drives the built app in a headless browser to check the two types of model: what each offers,
// and that a model keeps its type through saving, reopening and reloading.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const views = async () => (await page.locator('.header').getByRole('tab').allInnerTexts()).map((s) => flat(s).replace(/ \d+$/, '')).join('|');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const file = async (item) => { await page.getByRole('button', { name: 'File', exact: true }).click(); await page.getByRole('menuitem', { name: item }).click(); };
const panel = page.locator('.inspector');
const view = page.locator('.view');
const dialog = page.getByRole('dialog');
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const ALL = 'Graph|Entities|Hierarchy|Validation|Align|RDF|SPARQL|Vocabulary';
// Adds a term by double-clicking the canvas and typing its name.
const addTerm = async (name, x, y) => {
  await page.locator('#graph-svg').dblclick({ position: { x, y } });
  await page.locator('.inline-editor').fill(name);
  await page.keyboard.press('Enter');
};
// Drags the ⊕ handle of one term onto another and types the label of the new line.
const draw = async (from, to, label) => {
  await node(from).locator('.node-box').hover();
  const h = await node(from).locator('.handle-dot').boundingBox();
  const t = await node(to).locator('.node-box').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator('.inline-editor').fill(label);
  await page.keyboard.press('Enter');
};

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
ok((await views()) === ALL, 'the ontology example has every function: ' + (await views()));

// ---------------------------------------------------------------- a new model starts with its type
await file(/^New model/);
ok(flat(await dialog.locator('h2').innerText()).toLowerCase() === 'create new model' && (await dialog.getByRole('radio').count()) === 2, 'New model asks what to create, with the two types of model');
ok(flat(await dialog.locator('.model-types').innerText()).includes('OWL ontology') && flat(await dialog.locator('.model-types').innerText()).includes('SKOS-like vocabulary'), 'each with what it is for');
await dialog.getByLabel('Model name').fill('Glossary');
ok(await dialog.getByRole('button', { name: 'Create model' }).isDisabled(), 'nothing is created until a type is chosen');
await dialog.getByRole('radio', { name: /SKOS-like vocabulary/ }).check();
await dialog.getByLabel('Default namespace').fill('http://example.org/glossary');
ok((await dialog.getByRole('button', { name: 'Create model' }).isDisabled()) && flat(await dialog.innerText()).includes('A namespace ends with # or /'), 'a namespace that cannot hold names is refused, with the reason');
await dialog.getByLabel('Default namespace').fill('http://example.org/glossary#');
await dialog.getByRole('button', { name: 'Create model' }).click();
await page.waitForFunction(() => document.querySelector('.model-name')?.value === 'Glossary', null, { timeout: 3000 }).catch(() => {});
ok((await dialog.count()) === 0 && (await page.locator('.model-name').inputValue()) === 'Glossary', 'the model is created under its name');

// ---------------------------------------------------------------- what a vocabulary has
ok((await views()) === 'Graph|Entities|Hierarchy', 'a vocabulary has three functions: ' + (await views()));
ok(flat(await panel.locator('.model-type-shown').innerText()) === 'Model type SKOS-like vocabulary' && (await panel.locator('.model-type-shown select').count()) === 0, 'its type is shown in the model details, and is not a choice there');
ok(flat(await panel.locator('.ns-summary').innerText()) === 'http://example.org/glossary#', 'with the namespace it was given');
ok((await page.locator('.subgraph').getByRole('button', { name: /^Inferred facts/ }).count()) === 0 && (await page.locator('.subgraph').getByRole('button', { name: 'Style' }).count()) === 1, 'there is no reasoner to ask for inferred facts, so no button for them');

await addTerm('Animal', 700, 300);
await addTerm('Dog', 600, 480);
await addTerm('Bone', 900, 480);
await node('Dog').locator('.node-box').click({ button: 'right' });
const menu = (await page.locator('.menu').innerText()).split('\n').map(flat);
ok(!menu.includes('Type') && !menu.includes('Individual') && menu.includes('Rename'), 'a concept’s menu on the canvas offers no other kind of term');
await page.keyboard.press('Escape');

// the side panel for a concept
await node('Dog').locator('.node-box').click();
const labels = (await panel.locator('.field > span:first-child, .iri-suffix > span:first-child').allInnerTexts()).map((s) => flat(s).replace(/ (skos|rdfs):\w+$/, ''));
ok(labels.join('|') === 'Name|IRI|IRI suffix|Type', 'the editor of a concept has its name, IRI, IRI suffix and type, and nothing else: ' + labels.join(', '));
ok(flat(await panel.locator('.type-fixed').innerText()) === 'Concept skos:Concept' && (await panel.locator('h3').count()) === 0, 'its type is skos:Concept, and there are no axioms, restrictions or annotations sections');

// relationships
await draw('Dog', 'Animal', 'is a');
await draw('Dog', 'Bone', 'chews');
await page.locator('.edge', { has: page.locator('.edge-label', { hasText: /^chews$/ }) }).locator('.edge-label-bg').click({ button: 'right' });
const kinds = (await page.locator('.menu .menu-item .menu-label').allInnerTexts()).map(flat);
ok(kinds.includes('Relationship (plain)') && kinds.includes('Is a (broader)') && !kinds.some((k) => /Object property|Instance|data property/.test(k)), 'a relationship is plain or “is a”: ' + kinds.filter((k) => /plain|Is a|Object|Instance|data/.test(k)).join(', '));
await page.keyboard.press('Escape');
await page.locator('.edge', { has: page.locator('.edge-label', { hasText: /^chews$/ }) }).locator('.edge-label-bg').click();
const kindSelect = panel.locator('.field', { has: page.locator(':scope > span:has-text("Kind")') }).locator('select');
ok((await kindSelect.locator('option').allInnerTexts()).join('|') === 'Relationship (plain)|Is a (broader)' && (await panel.getByText('Restriction').count()) === 0, 'the relationship editor offers the same two kinds, and no restrictions');

// ---------------------------------------------------------------- entities
await tab('Entities');
ok((await view.getByRole('tab').allInnerTexts()).map((s) => flat(s).replace(/ \(\d+\)$/, '')).join('|') === 'Concepts|Relationships|Governance & Metadata', 'Entities has three sections: concepts, relationships, governance and metadata');
ok((await view.locator('thead th').allInnerTexts()).map(flat).filter(Boolean).join('|') === 'Name|IRI|IRI suffix|Type', 'concepts are listed by name, IRI, IRI suffix and type');
const row = (name) => view.locator('tbody tr', { has: page.locator(`input[value="${name}"]`) });
const iriOf = async (name) => (await row(name).locator('td').nth(1).innerText()).replace(/\s/g, '');
ok((await iriOf('Dog')) === ':Dog' && flat(await row('Dog').locator('td').nth(3).innerText()) === 'Concept skos:Concept', 'each a skos:Concept with an IRI in the namespace');
await row('Dog').getByLabel('Name').fill('Domestic dog');
await row('Dog').getByLabel('Name').press('Enter');
ok((await iriOf('Domestic dog')) === ':Dog', 'renaming a concept leaves its IRI as it was');
await row('Domestic dog').getByLabel('IRI suffix').fill('CanisFamiliaris');
await row('Domestic dog').getByLabel('IRI suffix').press('Enter');
ok((await iriOf('Domestic dog')) === ':CanisFamiliaris' && (await row('Domestic dog').getByLabel('Name').inputValue()) === 'Domestic dog', 'and its IRI suffix is changed apart from its name');
await view.getByRole('tab', { name: /^Relationships/ }).click();
ok((await view.locator('tbody tr').first().getByLabel('Kind').locator('option').allInnerTexts()).join('|') === 'Relationship (plain)|Is a (broader)', 'the relationships table offers plain and “is a”');
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
await page.locator('.gov-list tbody tr', { hasText: 'Domestic dog' }).click();
const form = page.locator('.gov-form');
ok(flat(await form.locator('[data-field="name"]').innerText()).includes('skos:prefLabel') && flat(await form.locator('[data-field="entityType"]').innerText()).includes('skos:Concept'), 'governance and metadata reads the name as skos:prefLabel and the type as skos:Concept');
await form.locator('[data-field="definition"] textarea').fill('A domesticated canine.');
await form.locator('[data-field="definition"] textarea').blur();
await form.locator('[data-field="status"] select').selectOption('Approved');
ok((await form.locator('[data-field="note"]').count()) === 1 && (await form.locator('[data-field="owner"]').count()) === 1 && (await form.locator('[data-field="sensitivity"]').count()) === 1, 'with notes, ownership and classification among its fields');

// ---------------------------------------------------------------- hierarchy
await tab('Hierarchy');
const tree = page.locator('.tree');
ok(flat(await tree.innerText()).startsWith('Animal') && (await tree.locator('li li', { hasText: 'Domestic dog' }).count()) === 1, 'the hierarchy is built from “is a”: Domestic dog under Animal');
await page.locator('input[aria-label="Search terms"]').fill('dog');
ok((await tree.locator('.tree-name').allInnerTexts()).map(flat).join('|') === 'Animal|Domestic dog' && (await tree.locator('.tree-name.match').count()) === 1, 'the search narrows it to what was found and what that is under');
await page.locator('input[aria-label="Search terms"]').fill('');
// A ring: Animal is also a Domestic dog. Every concept is still shown, once, and nothing hangs.
await tab('Graph');
await draw('Animal', 'Domestic dog', 'is a');
await tab('Hierarchy');
ok((await tree.locator('.tag.warn', { hasText: 'cycle' }).count()) >= 1 && flat(await tree.innerText()).includes('Animal') && flat(await tree.innerText()).includes('Bone'), 'two concepts that are each other’s broader concept are shown as a cycle, and the rest stays');
await page.locator('.header').getByRole('button', { name: 'Undo' }).click();
await page.screenshot({ path: shots + 'model-types.png' });

// ---------------------------------------------------------------- saved, reopened, reloaded
await page.locator('.header-doc').getByRole('button', { name: 'Save', exact: true }).click();
if (await dialog.count()) await dialog.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await file('Load the ontology example');
ok((await views()) === ALL, 'another model, an ontology, has every function again');
await tab('Validation');
await file('My Models…');
await dialog.locator('li, tr', { hasText: 'Glossary' }).getByRole('button', { name: /^Open/ }).first().click();
await page.waitForFunction(() => document.querySelector('.model-name')?.value === 'Glossary');
ok((await views()) === 'Graph|Entities|Hierarchy' && (await page.locator('.header [role=tab].on').innerText()) === 'Graph', 'reopened from My Models, the vocabulary is a vocabulary again, and the Validation view it does not have is left');
await page.waitForTimeout(900);
await page.reload();
await page.waitForSelector('.node');
ok((await views()) === 'Graph|Entities|Hierarchy' && (await node('Domestic dog').count()) === 1, 'and after a reload too');
await tab('Entities');
await view.getByRole('tab', { name: 'Governance & Metadata' }).click();
await page.locator('.gov-list tbody tr', { hasText: 'Domestic dog' }).click();
ok((await form.locator('[data-field="definition"] textarea').inputValue()) === 'A domesticated canine.' && (await form.locator('[data-field="status"] select').inputValue()) === 'Approved', 'with its metadata');

// ---------------------------------------------------------------- an ontology, made the same way
await file(/^New model/);
await dialog.getByLabel('Model name').fill('Pets');
await dialog.getByRole('radio', { name: /OWL ontology/ }).check();
await dialog.getByRole('button', { name: 'Create model' }).click();
ok((await views()) === ALL && flat(await panel.locator('.model-type-shown').innerText()) === 'Model type OWL ontology', 'a new OWL ontology has every function');
await addTerm('Pet', 700, 300);
await node('Pet').locator('.node-box').click({ button: 'right' });
ok((await page.locator('.menu').innerText()).includes('Individual'), 'and every kind of term');
await page.keyboard.press('Escape');
await tab('Entities');
ok((await view.getByRole('tab').count()) === 6, 'and all six sections of Entities');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
