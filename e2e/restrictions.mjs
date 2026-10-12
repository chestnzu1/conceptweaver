// Drives the built app in a headless browser to check restrictions and cardinalities on relationships.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const panel = page.locator('.inspector');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const rdf = async (subject) => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? ''); };
const edge = (label) => page.locator('.edge', { has: page.locator('.edge-label', { hasText: label }) });
const open = (label) => edge(label).first().locator('.edge-label-bg').click();
const fields = async () => (await panel.locator('.field > span, .field label > span').allInnerTexts()).map(flat);
const restriction = panel.locator('.field', { has: page.locator('ul.restrictions') });

await page.goto('http://localhost:5181/');
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- cardinalities: plain relationships only
ok((await page.locator('.edge-card').count()) === 2 && (await edge(/^wins$/).locator('.edge-card').count()) === 2, 'on the canvas only the plain relationship (wins) shows cardinalities');
await open(/^wins$/);
ok((await fields()).includes('From cardinality') && (await fields()).includes('To cardinality'), 'a plain relationship has the cardinality fields');
for (const [label, what] of [[/^directs some$/, 'an object property'], [/^is a$/, '“is a”'], [/^Is Instance Of$/, '“is instance of”'], [/^has some$/, 'a data property']]) {
  await open(label);
  const f = await fields();
  ok(!f.includes('From cardinality') && !f.includes('To cardinality'), `${what} has no cardinality fields`);
}
// Turning the plain relationship into an object property takes them away, there and on the canvas.
await open(/^wins$/);
await panel.locator('.field', { has: page.locator(':scope > span:has-text("Kind")') }).locator('select').selectOption('object');
ok(!(await fields()).includes('From cardinality') && (await page.locator('.edge-card').count()) === 0, 'made an object property, it loses them');
await page.getByRole('button', { name: 'Undo' }).click();
ok((await page.locator('.edge-card').count()) === 2, 'undo brings them back');

// ---------------------------------------------------------------- what a restriction is on
await open(/^has some$/);
const dataProp = await panel.locator('.field', { has: page.locator(':scope > span:has-text("To")') }).first().locator('select option:checked').innerText();
ok(flat(await restriction.locator(':scope > span').innerText()) === 'Restriction on ' + dataProp, 'for “has data property” the restriction is on the data property: ' + flat(await restriction.locator(':scope > span').innerText()));
await open(/^directs some$/);
ok(flat(await restriction.locator(':scope > span').innerText()) === 'Restriction on directs', 'for an object property it is on that property');

// ---------------------------------------------------------------- several restrictions on one relationship
const edges = await page.locator('.edge').count();
await panel.getByRole('button', { name: 'Add another restriction' }).click();
ok((await restriction.locator('li').count()) === 2 && (await edge(/^directs some, only$/).count()) === 1 && (await page.locator('.edge').count()) === edges, 'a second restriction is added to the same relationship: the line reads “directs some, only”');
ok(flat(await restriction.locator(':scope > span').innerText()) === 'Restrictions on directs', 'the field is headed “Restrictions on directs”');
await restriction.locator('li').nth(1).getByLabel('Quantifier').selectOption('max');
await restriction.locator('li').nth(1).getByLabel('Number').fill('3');
const director = await rdf(':Director');
ok(director.includes('owl:onProperty :directs ; owl:someValuesFrom :Film ] , [ a owl:Restriction ; owl:onProperty :directs ; owl:maxQualifiedCardinality "3"^^xsd:nonNegativeInteger ; owl:onClass :Film ]'), 'both are exported as restrictions on the class');
await page.screenshot({ path: shots + 'restrictions-several.png' });
// the class editor lists each, and removing one leaves the other and the relationship
await page.locator('.node', { has: page.locator('text', { hasText: /^Director$/ }) }).locator('.node-box').click();
const rows = panel.locator('ul.restrictions').first().locator('li');
ok((await rows.count()) === 2, 'the class lists both restrictions');
await rows.nth(0).getByRole('button', { name: /^Remove/ }).click();
ok((await rows.count()) === 1 && (await edge(/^directs max 3$/).count()) === 1 && (await page.locator('.edge').count()) === edges, 'removing one leaves the other, and the relationship');
// adding the same property and target again in the class editor joins the relationship
await panel.getByLabel('Property to restrict by').selectOption({ label: 'directs' });
await panel.getByLabel('Class it points to').selectOption({ label: 'Film' });
await panel.locator('.restriction-add').getByRole('button', { name: 'Add' }).click();
ok((await rows.count()) === 2 && (await page.locator('.edge').count()) === edges, 'adding the same property and class again adds a restriction, not a second line: ' + (await edge(/^directs /).locator('.edge-label').textContent()));

// ---------------------------------------------------------------- persistence
await page.waitForTimeout(900);
const before = await rdf(':Director');
await page.reload();
await page.waitForSelector('.node');
ok((await rdf(':Director')) === before && before.split('owl:Restriction').length === 3, 'after a reload both restrictions are still there');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
