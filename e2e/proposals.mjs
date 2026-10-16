// Drives the built app in a headless browser to check shapes proposed from the ontology (roadmap
// stage SH-3, ADR-020): proposed for a class from its editor, none chosen to begin with, each with
// its axiom, its shape, what the axiom means in OWL, what the shape checks and where they differ;
// nothing changed until some are chosen and added, as one step that undo takes back; chosen by
// kind or dismissed; an accepted shape that says which axiom it came from, already there when
// proposed again, validated like any other, and stale once that axiom is gone.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const sv = page.locator('.view.shapes-view');
const dialog = page.locator('.dialog.proposals');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: true }).click();
const pick = async (name) => { await side.locator('.tree-line .label', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click(); await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name); };
const proposal = (axiom) => dialog.locator('.proposal', { has: page.locator('code.axiom', { hasText: new RegExp('^' + axiom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
const group = (name) => dialog.locator('.proposal-group', { has: page.locator('h3', { hasText: new RegExp('^' + name) }) });
const undo = page.getByRole('button', { name: 'Undo' });

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- proposed for a class, from its editor
await pick('Film');
await panel.locator('[data-section=shapes]').getByRole('button', { name: 'Propose from its axioms…' }).click();
await dialog.waitFor();
ok((await page.locator('.header [role=tab].on').innerText()) === 'Shapes' && flat(await dialog.locator('.proposal-scope').innerText()).includes('Film'), 'proposed for Film, from its editor, in the Shapes view');
const genre = proposal("Film SubClassOf 'belongs to' some Genre");
ok((await genre.count()) === 1, 'each restriction of Film is a proposal');
const said = flat(await genre.locator('dl').innerText());
ok(said.includes("OWL Every Film has at least one value of 'belongs to' that is a Genre.") && said.includes('The shape Every Film in the data has') && said.includes('Differs SHACL counts the values the data states'), 'with what the axiom means, what the shape checks, and where they differ: ' + said.slice(0, 120));
ok(flat(await genre.locator('code.proposed').innerText()) === 'sh:targetClass :Film ; sh:property [ sh:path :belongsTo ; sh:qualifiedValueShape [ sh:class :Genre ] ; sh:qualifiedMinCount 1 ]', 'and the shape it would add');
ok((await dialog.locator('input[type=checkbox]:checked').count()) === 0 && (await dialog.locator('.dialog-actions .btn.primary').isDisabled()), 'none is chosen to begin with');
ok(!(await undo.isEnabled()), 'and proposing has changed nothing');

// ---------------------------------------------------------------- two chosen, into a new set, as one step
await genre.getByRole('checkbox').check();
await proposal("Film SubClassOf 'Release date' some xsd:date").getByRole('checkbox').check();
ok((await dialog.getByLabel('Shape set to add to').inputValue()) === 'new', 'with no shape set yet, they go into a new one');
await dialog.getByRole('button', { name: 'Add 2 shapes' }).click();
await dialog.waitFor({ state: 'detached' });
ok((await sv.locator('.shape-sets li strong').allInnerTexts()).join() === 'From the ontology', 'the set is made');
const item = sv.locator('.shape-list li button', { hasText: 'Film (from the ontology)' });
ok((await item.count()) === 1 && flat(await item.innerText()).includes('2 properties') && flat(await item.innerText()).includes('from the ontology'), 'with one shape for Film and a property shape for each: ' + flat(await item.innerText()));
await item.click();
const origins = (await sv.locator('.shape-origin').allInnerTexts()).map(flat);
ok(origins.length === 2 && origins[0].startsWith("From the ontology: Film SubClassOf 'belongs to' some Genre"), 'each says which axiom it came from: ' + origins.join(' / '));
ok((await sv.locator('.shape-preview').textContent()).includes('cw:fromAxiom "SubClassOf(<http://example.org/film-knowledge-graph#Film> ObjectSomeValuesFrom('), 'and says so in its Turtle, in OWL functional syntax');
await page.screenshot({ path: shots + 'proposals-accepted.png' });
await undo.click();
ok((await sv.locator('.shape-sets li').count()) === 0, 'one undo takes both shapes, and the set, back');
await page.getByRole('button', { name: 'Redo' }).click();
ok((await sv.locator('.shape-sets li strong').allInnerTexts()).join() === 'From the ontology', 'and redo brings them');

// ---------------------------------------------------------------- the whole ontology: what is there already, by kind, dismissed
await sv.getByRole('button', { name: 'Propose from the ontology…' }).click();
await dialog.waitFor();
ok(flat(await dialog.locator('.proposal-scope').innerText()).includes('the whole ontology'), 'proposed for the whole ontology');
ok((await genre.getByRole('checkbox').isDisabled()) && flat(await genre.innerText()).includes('in “From the ontology” already'), 'what the set has already is said, and cannot be added twice');
const ranges = group('Domains and ranges');
const n = (await ranges.locator('.proposal').count());
await ranges.getByRole('button', { name: /^Choose all/ }).click();
ok((await ranges.locator('input[type=checkbox]:checked').count()) === n && (await dialog.getByRole('button', { name: `Add ${n} shapes` }).count()) === 1, `a kind is chosen at once: ${n} domains and ranges`);
await page.screenshot({ path: shots + 'proposals-dialog.png' });
const restrictions = group('Restrictions');
const before = await restrictions.locator('.proposal').count();
await restrictions.locator('.proposal').first().getByRole('button', { name: /^Dismiss the proposal/ }).click();
ok((await restrictions.locator('.proposal').count()) === before - 1, 'a proposal is dismissed');
await restrictions.getByRole('button', { name: 'Dismiss these' }).click();
ok((await group('Restrictions').count()) === 0 && (await dialog.getByRole('button', { name: `Show the ${before} dismissed again` }).count()) === 1, 'and a kind of them');
await dialog.getByRole('button', { name: `Add ${n} shapes` }).click();
await dialog.waitFor({ state: 'detached' });
const listed = (await sv.locator('.shape-list li strong').allInnerTexts());
ok(listed.filter((x) => x === 'Subjects of belongs to (from the ontology)').length === 1 && listed.filter((x) => x === 'Domain of belongs to (from the ontology)').length === 1, 'a range becomes a shape for what uses the property, and a domain a shape of its own: ' + listed.join(' | '));

// ---------------------------------------------------------------- validated, then stale when the axiom goes
await tab('Validation');
const v = page.locator('.validation');
await v.getByRole('button', { name: 'SHACL', exact: true }).click();
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? '') && !document.querySelector('.validation .stale'));
const rows = (await v.locator('tr.result', { has: page.locator('.cat.shacl') }).allInnerTexts()).map(flat);
ok(rows.some((r) => r.startsWith('Error SHACL Parasite') && r.includes('QualifiedMinCount')), 'the accepted shapes are validated: Parasite has no genre stated: ' + rows.slice(0, 3).join(' / '));
await tab('Graph');
await page.locator('.edge', { has: page.locator('.edge-label', { hasText: /^belongs to/ }) }).first().locator('.edge-label-bg').click();
await page.keyboard.press('Delete');
await tab('Shapes');
await sv.locator('.shape-list li button', { hasText: 'Film (from the ontology)' }).click();
const stale = sv.locator('.shape-origin.stale');
// The axiom is no longer in the ontology to be read out in Manchester syntax: it is shown as it was kept.
ok((await stale.count()) === 1 && flat(await stale.innerText()).includes('Came from an axiom the ontology no longer states: SubClassOf(:Film ObjectSomeValuesFrom(:belongsTo :Genre))') && flat(await sv.locator('.shape-list li button', { hasText: 'Film (from the ontology)' }).innerText()).includes('stale'), 'once its axiom is gone, the shape says it is stale, in its form and in the list');
ok(flat(await sv.locator('.shape-origin:not(.stale)').innerText()).startsWith("From the ontology: Film SubClassOf 'Release date' some xsd:date"), 'and the one whose axiom is still stated does not');
await page.screenshot({ path: shots + 'proposals-stale.png' });
await stale.getByRole('button', { name: 'Forget which axiom it came from' }).click();
ok((await sv.locator('.shape-origin.stale').count()) === 0, 'and it can be kept as a shape of its own');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
