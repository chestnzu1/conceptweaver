// Drives the built app in a headless browser to check inferred restrictions.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 980 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
// Dropdowns of terms fill in when the pointer reaches them, so hover before choosing.
{ const proto = Object.getPrototypeOf(page.locator('body')); const orig = proto.selectOption; proto.selectOption = async function (...a) { await this.hover(); return orig.apply(this, a); }; }
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const pick = async (name) => { await side.locator('.tree-line .label', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click(); await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name); };
// The reasoner answers from a worker: what the panel says of it is read once it has.
const settled = () => page.waitForFunction(() => !/Working out what follows|Inferred restrictions \(…\)/.test(document.querySelector('.inspector')?.textContent ?? ''), undefined, { timeout: 15_000 }).catch(() => {});
const inferred = async () => {
  await settled();
  return (await panel.locator('.restrictions.inferred li').allInnerTexts()).map(flat);
};
const asserted = async () => (await panel.locator('.restrictions:not(.inferred) li').evaluateAll((els) => els.map((li) => `${li.querySelector('.link').textContent} ${li.querySelector('select').value}${li.querySelector('input') ? ' ' + li.querySelector('input').value : ''} ${li.querySelector('span:last-of-type').textContent}`)));
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const row = (name) => page.locator('.view tbody tr', { has: page.locator(`input[value="${name}"]`) });
const bulkRel = async (text) => { await page.getByRole('button', { name: 'Bulk add' }).click(); await page.getByRole('tab', { name: '2. Relationships' }).click(); await page.locator('.dialog textarea').fill(text); await page.getByRole('button', { name: 'Add relationships' }).click(); };

await page.goto(base);
await page.waitForSelector('.node');
await side.getByRole('button', { name: 'Expand all' }).click();

// ---- a subclass shows what its superclass asserts
await pick('Documentary');
ok((await panel.locator('h3', { hasText: 'Asserted restrictions (0)' }).count()) === 1 && (await panel.locator('h3', { hasText: 'Inferred restrictions (4)' }).count()) === 1, 'Documentary: no asserted restrictions, four inferred');
let got = await inferred();
ok(got.join(' | ') === 'belongs to some Genre Inherited from Film | wins some Award Inherited from Film | Release date some xsd:date Inherited from Film | Running time some xsd:integer Inherited from Film', 'inherited from Film, object and data properties: ' + got.join(' | '));
ok((await panel.locator('.restrictions.inferred').locator('select, input, .btn').count()) === 0, 'inferred restrictions have no controls: they are read-only');
await page.screenshot({ path: shots + 'inferred.png' });
// the source is a link to that class
await panel.locator('.restrictions.inferred .sources .link').first().click();
ok((await page.locator('.inspector input').first().inputValue()) === 'Film', 'the source class is a link that opens it');
ok((await asserted()).join(' | ') === 'belongs to some Genre | wins some Award | Release date some xsd:date | Running time some xsd:integer' && (await inferred()).length === 0, 'on Film itself the same four are asserted (and editable), none inferred');

// ---- it follows edits: a new restriction on Person reaches Actor and Director
await pick('Person');
await panel.getByLabel('Property to restrict by').selectOption({ label: 'produces' });
await panel.getByLabel('Class it points to').selectOption({ label: 'Film' });
await panel.getByRole('button', { name: 'Add', exact: true }).click();
await pick('Actor');
ok((await asserted()).join(' | ') === 'acts in some Film' && (await inferred()).join(' | ') === 'produces some Film Inherited from Person', 'Actor: its own restriction asserted, Person\'s new one inferred: ' + (await inferred()).join(' | '));
// change it at the source: quantifier and number carry through
await pick('Person');
await panel.locator('.restrictions:not(.inferred) li').getByLabel('Quantifier').selectOption('min');
await panel.locator('.restrictions:not(.inferred) li').getByLabel('Number').fill('2');
await pick('Actor');
ok((await inferred()).join(' | ') === 'produces min 2 Film Inherited from Person', 'changing it on Person changes what Actor infers: ' + (await inferred()).join(' | '));

// ---- several levels and two parents: once, naming both sources
await bulkRel('Employee -> is a -> Person\nWorking actor -> is a -> Actor\nWorking actor -> is a -> Employee');
await side.getByRole('button', { name: 'Expand all' }).click();
await pick('Employee');
await panel.getByLabel('Property to restrict by').selectOption({ label: 'acts in' });
await panel.getByLabel('Class it points to').selectOption({ label: 'Film' });
await panel.getByRole('button', { name: 'Add', exact: true }).click();
await pick('Working actor');
got = await inferred();
ok(got.length === 2 && got.includes('acts in some Film Inherited from Actor, Employee') && got.includes('produces min 2 Film Inherited from Person'), 'two parents and a grandparent: each restriction once, with every source: ' + got.join(' | '));
ok((await panel.locator('.restrictions.inferred .sources .link', { hasText: 'Person' }).getAttribute('title')).includes('“Working actor” is a kind of'), 'hovering a source gives the reasoner\'s justification');

// ---- stated on the class itself too: no longer listed as inferred
await panel.getByLabel('Property to restrict by').selectOption({ label: 'acts in' });
await panel.getByLabel('Class it points to').selectOption({ label: 'Film' });
await panel.getByRole('button', { name: 'Add', exact: true }).click();
ok((await inferred()).join(' | ') === 'produces min 2 Film Inherited from Person' && (await asserted()).join(' | ') === 'acts in some Film', 'asserting the same restriction on the class moves it from inferred to asserted');

// ---- removing the superclass removes what was inherited through it
await tab('Entities');
ok(flat(await row('Working actor').locator('.restrictions-cell.inferred').innerText()) === 'produces min 2 Film ← Person', 'Classes table has a separate Inferred Restrictions column: ' + flat(await row('Working actor').locator('.restrictions-cell.inferred').innerText()));
ok((await page.locator('.view thead th').allInnerTexts()).map(flat).join(' | ').includes('Asserted Superclasses | Asserted Restrictions | Inferred Restrictions'), 'column headings: Asserted Restrictions and Inferred Restrictions side by side');
await page.screenshot({ path: shots + 'inferred-table.png' });
await row('Working actor').getByRole('button', { name: 'Remove superclass Actor' }).click();
await row('Working actor').getByRole('button', { name: 'Remove superclass Employee' }).click();
await page.waitForFunction(() => !/Working out what follows/.test(document.querySelector('.view tbody')?.textContent ?? ''), undefined, { timeout: 15_000 }).catch(() => {});
ok(flat(await row('Working actor').locator('.restrictions-cell.inferred').innerText()) === '', 'with both superclasses removed nothing is inferred any more');
await page.getByRole('button', { name: 'Undo' }).click();
ok(flat(await row('Working actor').locator('.restrictions-cell.inferred').innerText()) === 'produces min 2 Film ← Person', 'undo brings the inference back');

// ---- equivalent classes (needs RDFS & OWL properties on)
await tab('Vocabulary');
await page.getByRole('checkbox').check();
await bulkRel('Performer -> same class as -> Actor');
await tab('Vocabulary');
await page.locator('.vocab tbody tr', { hasText: 'same class as' }).locator('select').selectOption('owl:equivalentClass');
await tab('Graph');
await side.getByRole('button', { name: 'Expand all' }).click();
await pick('Performer');
got = await inferred();
ok(got.includes('acts in some Film From equivalent class Actor') && got.some((x) => x.startsWith('produces min 2 Film Inherited from Person')), 'a class equivalent to Actor gets Actor\'s restrictions and Person\'s: ' + got.join(' | '));

// ---- collapse; the note on what is not inferred
await panel.getByRole('button', { name: /Inferred restrictions/ }).click();
ok((await panel.locator('.restrictions.inferred').count()) === 0, 'the section collapses');
await panel.getByRole('button', { name: /Inferred restrictions/ }).click();
await panel.locator('.not-inferred summary').click();
ok((await panel.locator('.not-inferred li').count()) === 5, 'a note lists the five kinds of inference the reasoner does not make');

// ---- nothing was written into the model, and an inconsistent ontology is not reasoned from
await tab('RDF');
const ttl = await page.locator('.rdf-code').innerText();
const doc = ttl.split('\n\n').find((b) => b.startsWith(':Documentary '));
ok(!doc.includes('owl:Restriction'), 'the RDF for Documentary has no restriction: inferred ones are not stored');
await bulkRel('Parasite -> is a -> Studio');
await tab('Vocabulary');
await bulkRel('Film -> excludes -> Studio');
await tab('Vocabulary');
await page.locator('.vocab tbody tr', { hasText: 'excludes' }).locator('select').selectOption('owl:disjointWith');
await tab('Graph');
await pick('Documentary');
await settled();
ok((await panel.locator('h3', { hasText: 'Inferred restrictions (—)' }).count()) === 1 && (await panel.locator('.bad', { hasText: 'inconsistent' }).count()) >= 1 && (await inferred()).length === 0, 'when the ontology is inconsistent, no inferred restrictions are listed and the panel says why');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
