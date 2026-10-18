// Drives the built app in a headless browser to check the property hierarchy in the Structure
// Explorer (roadmap task 2.10, FR-M6-5): object and data properties browsed in one tree under
// what they are stated to be subproperties of (rdfs:subPropertyOf), badged by kind; branches
// opened and folded; searched by name and by IRI; moved through by the keyboard; what is said of
// the property in focus, and the way from there to where it is edited; and the class hierarchy
// untouched. A vocabulary has no properties of its own, so it has no such tree.
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
const view = page.locator('.view.structure');
const side = page.locator('.term-list');
const panel = page.locator('.inspector');
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const file = async (item) => { await page.getByRole('button', { name: 'File', exact: true }).click(); await page.getByRole('menuitem', { name: item }).click(); };
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const chips = async (label) => (await field(label).locator('.chip-x > .link').allInnerTexts()).map(flat);
// Opens a field's search, types, and picks the first match.
const add = async (label, text) => {
  const f = field(label);
  await f.locator('.chip-add').click();
  await f.getByRole('combobox').fill(text);
  await f.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
};
const pickTerm = async (name) => {
  await side.locator('.tree-line .label, .flat-list button, li button', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click();
  await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name);
};
// The property hierarchy as text: indentation from the line's level, a marker for open / closed / leaf, and the tags it carries.
const tree = () => view.locator('.tree-row').evaluateAll((rows) => rows.map((r) => `${'  '.repeat(Number(r.getAttribute('aria-level')) - 1)}${r.getAttribute('aria-expanded') === 'true' ? '▼ ' : r.getAttribute('aria-expanded') === 'false' ? '▶ ' : '  '}${r.querySelector('.tree-name, .st-root-name').textContent}${[...r.querySelectorAll('.tag')].map((t) => ` [${t.textContent.trim()}]`).join('')}`).join('\n'));
const settled = () => page.waitForFunction(() => document.querySelector('.view.structure .tree')?.getAttribute('aria-busy') === 'false' && !document.querySelector('.view.structure .st-wait'));
const line = (name) => view.locator('.tree-row', { has: page.locator('.tree-name', { hasText: new RegExp('^' + name + '$') }) });
const kind = (name) => view.locator('.st-kind').getByRole('button', { name, exact: true }).click();
const search = view.getByLabel('Search the properties');
const focusName = async () => ((await view.locator('.st-focus .name').count()) ? flat(await view.locator('.st-focus .name').innerText()) : null);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- the statements a property is under
// Two object properties above one: "wins" is stated to be a subproperty of both.
await tab('Entities');
await page.locator('.view').getByRole('tab', { name: /Object properties/ }).click();
await page.locator('.view tbody tr', { has: page.locator('input[value="wins"]') }).click();
await page.waitForFunction(() => document.querySelector('.inspector input')?.value === 'wins');
await add('Superproperties', 'belongs to');
await field('Superproperties').locator('.chip-x > .link').first().waitFor();
await add('Superproperties', 'produces');
await field('Superproperties').locator('.chip-x > .link').nth(1).waitFor();
ok((await chips('Superproperties')).join() === 'belongs to,produces', 'an object property is stated to be a subproperty of two others: ' + (await chips('Superproperties')).join());
// A data property is a term of another kind, and "is a" between data properties is a subproperty statement too.
await side.getByRole('tab', { name: /Properties/ }).click();
await pickTerm('Release date');
await add('Superproperties', 'Running time');
await field('Superproperties').locator('.chip-x > .link').first().waitFor();
ok((await chips('Superproperties')).join() === 'Running time', 'and so is a data property under another data property');

// ---------------------------------------------------------------- the two kinds in one explorer
await tab('Structure');
await view.locator('.st-kind').waitFor();
ok((await view.locator('.st-kind [aria-pressed=true]').innerText()) === 'Classes', 'the explorer offers the classes and the properties, and opens on the classes');
await kind('Properties');
await view.locator('.tree-row').first().waitFor();
await settled();
ok(flat(await view.locator('.st-basis').innerText()) === 'Stated property hierarchy rdfs:subPropertyOf' && (await view.locator('.st-which').count()) === 0, 'the property hierarchy is the stated one, and there is no inferred one to choose');
const ALL = ['▼ Properties', '    acts in [object]', '  ▼ belongs to [object]', '      wins [object] [2 superproperties]', '    directs [object]', '  ▼ produces [object]', '      wins [object] [2 superproperties]', '  ▼ Running time [data]', '      Release date [data]'].join('\n');
ok((await tree()) === ALL, 'object and data properties in one tree, each badged by kind, a property with two superproperties under both:\n' + (await tree()));
ok((await view.locator('.tree-row.on').count()) === 0 && (await focusName()) === null, 'nothing is in focus to begin with');
await page.screenshot({ path: shots + 'property-hierarchies.png' });

// ---------------------------------------------------------------- opening and closing
await view.getByRole('button', { name: 'Collapse all' }).click();
const FOLDED = ['▼ Properties', '    acts in [object]', '  ▶ belongs to [object]', '    directs [object]', '  ▶ produces [object]', '  ▶ Running time [data]'].join('\n');
ok((await tree()) === FOLDED, 'Collapse all folds every branch below the top:\n' + (await tree()));
await view.getByRole('button', { name: 'Expand belongs to' }).click();
await settled();
ok((await tree()).includes('▼ belongs to') && (await tree()).includes('      wins [object] [2 superproperties]') && (await tree()).includes('▶ produces'), 'one branch opens without the other');

// ---------------------------------------------------------------- the keyboard
await view.getByRole('button', { name: 'Collapse all' }).click();
await view.locator('.tree').focus();
await page.keyboard.press('Home');
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'acts in');
ok((await focusName()) === 'acts in' && (await view.locator('.tree-row.cursor .tree-name').innerText()) === 'acts in', 'the tree is one stop for the Tab key, and Home goes to its first property');
await page.keyboard.press('ArrowDown');
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'belongs to');
ok((await focusName()) === 'belongs to', 'the arrow keys move through it');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => document.querySelector('.view.structure .tree-row[aria-expanded="true"] .tree-name')?.textContent === 'belongs to');
ok((await tree()).includes('▼ belongs to'), 'Right opens a branch');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'wins');
ok((await focusName()) === 'wins', 'Right on an open property goes to its first subproperty');
await page.keyboard.press('ArrowLeft');
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'belongs to');
ok((await focusName()) === 'belongs to', 'Left on a subproperty goes to the property it is under');
await page.keyboard.press('ArrowLeft');
await settled();
ok((await tree()).includes('▶ belongs to') && (await focusName()) === 'belongs to', 'and Left on an open property folds it');

// ---------------------------------------------------------------- what is said of the property in focus
await view.getByRole('button', { name: 'Expand belongs to' }).click();
await line('wins').first().locator('.tree-name').click();
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'wins');
const summary = view.locator('.st-summary');
const said = async () => (await summary.locator('section').evaluateAll((els) => els.map((el) => [...el.children].map((c) => (c.tagName === 'H3' ? c.textContent : c.innerText)).join(' ')))).map(flat);
let about = await said();
ok(about[0] === 'Superproperties Stated belongs to, produces Kind Object property: its values are individuals', 'beside the hierarchy: the superproperties stated for it, and its kind:\n' + about[0]);
ok(about[1].startsWith('Subproperties Direct 0 Below it 0 at any depth 2 ways down to it from Properties') && about[1].includes('belongs to › wins') && about[1].includes('produces › wins'), 'how many are below it, and every way down to it from the top:\n' + about[1]);
ok((await summary.locator('input, textarea, select').count()) === 0 && (await summary.getByRole('button', { name: /add|delete|remove|save/i }).count()) === 0, 'none of it is an editor');
await summary.locator('section').first().getByRole('button', { name: 'belongs to', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'belongs to');
ok((await line('belongs to').getAttribute('class')).includes(' on'), 'pressing a superproperty brings that property into focus');

// ---------------------------------------------------------------- from the hierarchy to where it is edited
await line('wins').first().locator('.tree-name').click();
await page.waitForFunction(() => document.querySelector('.view.structure .st-focus .name')?.textContent === 'wins');
await summary.getByRole('button', { name: 'Open in Entities' }).click();
ok((await page.locator('.header [role=tab].on').innerText()) === 'Entities' && /^Object properties \(\d+\)$/.test(flat(await page.locator('.view .view-head [role=tab].on').innerText())), 'Open in Entities goes to the Entities view, on the object properties');
ok((await page.locator('.view tbody tr.sel input[value="wins"]').count()) === 1 && flat(await panel.locator('.editor-head h2').innerText()).toLowerCase() === 'object property', 'with the property selected, and its editor on it');

// ---------------------------------------------------------------- search
await tab('Structure');
await view.locator('.tree-row').first().waitFor();
await settled();
const beforeSearch = await tree();
await search.fill('wins');
await page.waitForFunction(() => /1 property matches/.test(document.querySelector('.view.structure .st-status')?.textContent ?? ''));
ok((await tree()) === ['▼ Properties', '  ▼ belongs to [object]', '      wins [object] [2 superproperties]', '  ▼ produces [object]', '      wins [object] [2 superproperties]'].join('\n'), 'the search narrows the tree to what it finds and what that is under:\n' + (await tree()));
ok((await view.locator('.tree-name.match').count()) === 2 && flat(await view.locator('.st-status').innerText()).startsWith('1 property matches “wins”'), 'one property, found in both of its places');
await search.fill(':actsIn');
await page.waitForFunction(() => document.querySelector('.view.structure .tree-name.match')?.textContent === 'acts in');
ok((await tree()) === ['▼ Properties', '    acts in [object]'].join('\n'), 'by IRI too, written with its prefix');
await search.fill('zebra');
await page.waitForFunction(() => /Nothing in the hierarchy matches/.test(document.querySelector('.view.structure .tree-wrap')?.textContent ?? ''));
ok((await view.locator('.tree-row').count()) === 1, 'a search that finds nothing says so');
await search.fill('');
await page.waitForFunction(() => document.querySelectorAll('.view.structure .tree-row').length >= 6);
await settled();
ok((await tree()) === beforeSearch && beforeSearch.includes('▼ belongs to'), 'and when it is cleared, what was open before is open again');

// ---------------------------------------------------------------- back to the classes, untouched
await kind('Classes');
await settled();
const CLASSES = ['▼ owl:Thing', '    Award', '  ▼ Film', '      Documentary', '    Genre', '  ▼ Person', '      Actor', '      Director', '    Studio'].join('\n');
ok((await tree()) === CLASSES && (await view.getByLabel('Search the hierarchy').count()) === 1, 'back at the classes, the class hierarchy is what it was:\n' + (await tree()));

// ---------------------------------------------------------------- a vocabulary has no property hierarchy
await file('Load the SKOS example');
await page.waitForSelector('.node', { state: 'attached' });
await tab('Structure');
await view.locator('.tree-row').first().waitFor();
await settled();
ok((await view.locator('.st-kind').count()) === 0 && flat(await view.locator('.st-basis').innerText()) === 'Asserted hierarchy skos:broader', 'a vocabulary has no properties of its own, so it is not offered a property hierarchy');

ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
