// Drives the built app in a headless browser to check "Is Instance Of" (class membership).
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const panel = page.locator('.inspector');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const rdf = async (subject) => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? ''); };
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const asserted = page.locator('.edge.instance-of:not(.inferred)');
const inferred = page.locator('.edge.inferred');
const toast = async () => flat(await page.locator('.toast').innerText().catch(() => ''));
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const add = async (label, text) => {
  const f = field(label);
  await f.locator('.chip-add').click();
  await f.getByRole('combobox').fill(text);
  await f.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
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
  // A name is asked for only where the line has one: between an individual and a class it has none.
  if (label === undefined || !(await page.locator('.inline-editor').count())) return;
  await page.locator('.inline-editor').fill(label);
  await page.keyboard.press('Enter');
};
const menu = async (edge) => {
  await edge.locator('.edge-label-bg').click({ button: 'right' });
  const items = page.locator('.menu .menu-item');
  const out = {};
  for (const it of await items.all()) out[flat(await it.locator('.menu-label').innerText())] = { disabled: await it.isDisabled(), checked: flat(await it.locator('.menu-check').innerText()) === '✓' };
  return out;
};

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- what is already there
ok((await asserted.count()) === 1 && flat(await asserted.locator('.edge-label').textContent()) === 'Is Instance Of', 'the sample’s membership (Parasite → Film) is drawn as an edge labelled “Is Instance Of”');
ok((await rdf(':Parasite')).startsWith(':Parasite a owl:NamedIndividual , :Film ;'), 'and exports as rdf:type: ' + (await rdf(':Parasite')).slice(0, 48));

// ---------------------------------------------------------------- creating, drawn the wrong way round
const edgesBefore = await page.locator('.edge').count();
await draw('Award', 'Parasite');
ok((await asserted.count()) === 2 && (await page.locator('.inline-editor').count()) === 0, 'a line drawn from a class to an individual is a membership at once: there is nothing else it could be, and no name to ask for');
ok((await toast()).includes('turned around'), 'the user is told it was turned around: ' + (await toast()).slice(0, 70));
ok((await rdf(':Parasite')).startsWith(':Parasite a owl:NamedIndividual , :Film , :Award ;'), 'it exports from the individual to the class, beside the first membership');
ok(!(await rdf(':Award')).includes('Parasite'), 'and nothing is stated on the class');
await page.screenshot({ path: shots + 'instance-of.png' });

// duplicates
await draw('Parasite', 'Award');
ok((await asserted.count()) === 2 && (await page.locator('.edge').count()) === edgesBefore + 1, 'the same membership is not stated twice: the second line is not kept');
ok((await toast()).includes('already stated to be an instance of'), 'with the reason shown: ' + (await toast()).slice(0, 70));

// ---------------------------------------------------------------- the kind selector
const classEdge = page.locator('.edge', { has: page.locator('.edge-label', { hasText: /^wins some$/ }) });
let m = await menu(classEdge);
ok(Object.keys(m).filter((k) => 'Relationship (plain)|Object property|Is a (generalization)|Is Instance Of|Has data property'.split('|').includes(k)).join() === 'Object property,Is a (generalization)', 'between two classes the kinds are object property and “is a”, and no plain relationship');
await page.keyboard.press('Escape');
m = await menu(asserted.first());
ok(m['Is Instance Of'].checked && !m['Relationship (plain)'] && !m['Is a (generalization)'] && !m['Object property'] && !m['Has data property'] && m['Reverse direction'].disabled, 'between an individual and a class the one kind is “Is Instance Of” (ticked), and it cannot be reversed');
await page.keyboard.press('Escape');

await asserted.first().locator('.edge-label-bg').click();
ok(flat(await panel.locator('h2').first().innerText()).toLowerCase() === 'class membership', 'the inspector heads it “Class membership”: ' + flat(await panel.locator('h2').first().innerText()));
const kind = panel.locator('.field', { has: page.locator(':scope > span:has-text("Kind")') }).locator('select');
ok((await kind.inputValue()) === 'instanceOf', 'with the kind selector on “Is Instance Of”');
ok(await panel.getByRole('button', { name: 'Reverse direction' }).isDisabled(), 'and no way to reverse it');
await classEdge.locator('.edge-label-bg').click();
ok((await kind.locator('option').evaluateAll((os) => os.map((o) => o.value))).join() === 'object,generalization', 'for a relationship between two classes the selector lists object property and “is a”');
await page.locator('.edge', { has: page.locator('.edge-label', { hasText: /^has some$/ }) }).first().locator('.edge-label-bg').click();
ok((await kind.locator('option').evaluateAll((os) => os.map((o) => o.value))).join() === 'property' && (await kind.isDisabled()), 'between a class and a data property it is “has data property”, with nothing else to choose');

// ---------------------------------------------------------------- asserted and inferred
await node('Film').locator('.node-box').click();
await add('Asserted superclasses', 'Genre');
const toggle = page.locator('.subgraph').getByRole('button', { name: /^Inferred facts/ });
ok((await inferred.count()) === 0, 'inferred memberships are not drawn until asked for');
await toggle.click();
ok((await inferred.count()) === 1 && flat(await inferred.locator('.edge-label').textContent()) === 'Is Instance Of (inferred)', 'asked for, the inferred membership (Parasite is a Film, a Film is a Genre) is drawn and labelled as inferred');
ok((await inferred.locator('.edge-line').evaluate((el) => getComputedStyle(el).strokeDasharray)) !== 'none' && (await asserted.first().locator('.edge-line').evaluate((el) => getComputedStyle(el).strokeDasharray)) === 'none', 'dotted, where asserted ones are solid');
ok(!(await rdf(':Parasite')).includes(':Genre'), 'it is not in the export');
await page.screenshot({ path: shots + 'instance-of-inferred.png' });
await node('Parasite').locator('.node-box').click();
await add('Asserted types', 'Genre');
ok((await inferred.count()) === 0 && (await asserted.count()) === 3, 'stating it makes it an asserted edge at once');
await field('Asserted types').locator('.chip-x', { hasText: 'Genre' }).locator('button').last().click();
// The reasoner answers about the model as it now is from a worker: the inferred line is back once it has.
await inferred.first().waitFor({ timeout: 15_000 }).catch(() => {});
ok((await inferred.count()) === 1 && (await asserted.count()) === 2, 'and withdrawing it brings the inferred one back, once the reasoner has answered');
await toggle.click();
ok((await inferred.count()) === 0, 'switched off, only asserted memberships are drawn');

// ---------------------------------------------------------------- deleting
const award = page.locator('.edge.instance-of', { has: page.locator('.edge-label') }).nth(1);
await award.locator('.edge-label-bg').click();
const to = await panel.locator('.field', { has: page.locator(':scope > span:has-text("To")') }).locator('select option:checked').innerText();
await page.keyboard.press('Delete');
const after = await rdf(':Parasite');
ok((await asserted.count()) === 1 && after.includes('owl:NamedIndividual') && !after.includes(':' + to + ' ') && (await rdf(':' + to)).startsWith(':' + to + ' a owl:Class'), `deleting the membership of ${to} removes that triple and leaves the individual and the class: ${after.slice(0, 48)}`);

// ---------------------------------------------------------------- persistence
await page.waitForTimeout(900);
await page.reload();
await page.waitForSelector('.node');
ok((await asserted.count()) === 1 && (await rdf(':Parasite')) === after, 'after a reload the membership is as it was');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
