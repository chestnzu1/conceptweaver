// Drives the built app in a headless browser to check the sidebar class tree.
// Run with the preview server up:  pnpm build && pnpm exec vite preview --port 5181 &  node e2e/sidebar-tree.mjs
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const side = page.locator('.term-list');
// The tree as text: indentation from the row's level, a marker for open / closed / leaf.
const tree = () => side.locator('.tree-line').evaluateAll((rows) => rows.map((r) => `${'  '.repeat(Number(r.getAttribute('aria-level')) - 1)}${r.getAttribute('aria-expanded') === 'true' ? '▼ ' : r.getAttribute('aria-expanded') === 'false' ? '▶ ' : '  '}${r.querySelector('.name, .label.root').textContent}`).join('\n'));
const line = (name) => side.locator('.tree-line', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) });
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const file = async (item) => { await page.getByRole('button', { name: 'File', exact: true }).click(); await page.getByRole('menuitem', { name: item }).click(); };
const bulkRel = async (text) => { await page.getByRole('button', { name: 'Bulk add' }).click(); await page.getByRole('tab', { name: '2. Relationships' }).click(); await page.locator('.dialog textarea').fill(text); await page.getByRole('button', { name: 'Add relationships' }).click(); };

await page.goto('http://localhost:5181/');
await page.waitForSelector('.node');

// ---- the tree
ok((await tree()) === ['▼ owl:Thing', '    Award', '  ▼ Film', '      Documentary', '    Genre', '  ▼ Person', '      Actor', '      Director', '    Studio'].join('\n'), 'sidebar shows the class hierarchy under owl:Thing:\n' + (await tree()));
ok((await side.locator('.chips').innerText()).replace(/\s+/g, ' ') === 'Classes 8 Properties 2 Individuals 1', 'tabs: ' + (await side.locator('.chips').innerText()).replace(/\s+/g, ' '));
await page.screenshot({ path: shots + 'tree.png' });

// ---- collapse / expand a branch; select; selection keeps expansion
await side.getByRole('button', { name: 'Collapse Person' }).click();
ok(!(await tree()).includes('Actor') && (await tree()).includes('▶ Person'), 'collapsing Person hides its subclasses');
await line('Documentary').locator('.label').click();
ok((await page.locator('.inspector input').first().inputValue()) === 'Documentary' && (await line('Documentary').getAttribute('class')).includes(' on'), 'clicking a name selects the class, shows its details and highlights the row');
ok((await tree()).includes('▶ Person'), 'selecting another class leaves Person collapsed');
await side.getByRole('button', { name: 'Expand Person' }).click();
await side.getByRole('button', { name: 'Collapse all' }).click();
ok((await tree()) === '▼ owl:Thing\n    Award\n  ▶ Film\n    Genre\n  ▶ Person\n    Studio', 'Collapse all folds every branch below the top');
await side.getByRole('button', { name: 'Expand all' }).click();
ok((await side.locator('.tree-line').count()) === 9, 'Expand all opens everything');

// ---- selecting on the canvas reveals the class in the tree
await side.getByRole('button', { name: 'Collapse all' }).click();
await page.locator('.node', { has: page.locator('text', { hasText: /^Actor$/ }) }).locator('.node-box').click();
await line('Actor').waitFor({ timeout: 5000 }).catch(() => {});
ok((await line('Actor').count()) === 1 && (await line('Actor').getAttribute('class')).includes(' on'), 'selecting Actor on the canvas opens Person in the tree and highlights Actor');

// ---- multiple inheritance, live updates
await bulkRel('Employee -> is a -> Person\nWorkingActor -> is a -> Actor\nWorkingActor -> is a -> Employee');
await side.getByRole('button', { name: 'Expand all' }).click();
let t = await tree();
ok(t.includes('    ▼ Actor\n        WorkingActor') && t.includes('    ▼ Employee\n        WorkingActor'), 'a class with two superclasses appears under both:\n' + t.split('\n').slice(5, 12).join('\n'));
await line('WorkingActor').nth(1).locator('.label').click();
ok((await side.locator('.tree-line.on').count()) === 2 && (await page.locator('.node.selected').count()) === 1, 'selecting it in one branch highlights it in both: one entity, two places');
await tab('Entities');
ok((await page.locator('.view tbody tr', { has: page.locator('input[value="WorkingActor"]') }).count()) === 1, 'there is still only one WorkingActor in the model');
// remove one superclass: it leaves that branch only
await page.locator('.view tbody tr', { has: page.locator('input[value="WorkingActor"]') }).getByRole('button', { name: 'Remove superclass Employee' }).click();
ok((await line('WorkingActor').count()) === 1 && !(await tree()).includes('▼ Employee'), 'removing a superclass updates the tree at once');
// rename, add, delete
await page.locator('.view tbody tr', { has: page.locator('input[value="WorkingActor"]') }).locator('input').first().fill('Stage actor');
await page.keyboard.press('Enter');
ok((await line('Stage actor').count()) === 1 && (await line('WorkingActor').count()) === 0, 'renaming updates the tree');
await page.getByRole('button', { name: 'Add class' }).click();
ok((await tree()).includes('\n    New class'), 'a new class appears directly under owl:Thing');
await page.locator('.view tbody tr', { has: page.locator('input[value="New class"]') }).getByRole('button', { name: 'Delete New class' }).click();
ok(!(await tree()).includes('New class'), 'deleting removes it');
ok((await tree()).includes('▼ Actor'), 'expansion was kept through all of these edits');
ok(await page.locator('.view').isVisible(), 'choosing classes in the sidebar did not leave the Entities view');

// ---- search: reveals matches inside collapsed branches, by name and by IRI
await side.getByRole('button', { name: 'Collapse all' }).click();
await side.getByLabel('Search terms').fill('stage');
ok((await tree()) === '▼ owl:Thing\n  ▼ Person\n    ▼ Actor\n        Stage actor' && (await side.locator('.tree-line.match').count()) === 1, 'search opens the way to the match and highlights it:\n' + (await tree()));
await side.getByLabel('Search terms').fill('graph#Docu');
ok((await tree()) === '▼ owl:Thing\n  ▼ Film\n      Documentary', 'search by IRI works too');
await line('Documentary').locator('.label').click();
ok((await page.locator('.inspector input').first().inputValue()) === 'Documentary', 'a search result can be selected directly');
await side.getByLabel('Search terms').fill('zzz');
ok((await side.innerText()).includes('No class matches'), 'no match says so');
await side.getByLabel('Search terms').fill('');
await page.waitForTimeout(100);
t = await tree();
ok(t.includes('▼ Film\n      Documentary') && t.includes('▶ Person') && !t.includes('Stage actor'), 'clearing the search returns to the collapsed tree, with the selected class still revealed');

// ---- the other tabs keep the plain lists
await side.getByRole('tab', { name: /^Properties/ }).click();
ok((await side.locator('li .name').allInnerTexts()).join(', ') === 'Release date, Running time', 'Properties tab lists the data properties');
await side.getByRole('tab', { name: /^Individuals/ }).click();
ok((await side.locator('li .name').allInnerTexts()).join(', ') === 'Parasite', 'Individuals tab lists the individuals');
await side.getByRole('tab', { name: /^Classes/ }).click();

// ---- subgraph is not disturbed by browsing the tree
await tab('Graph');
await page.locator('.node', { has: page.locator('text', { hasText: /^Genre$/ }) }).locator('.node-box').click({ button: 'right' });
await page.getByRole('menuitem', { name: 'Show as a subgraph' }).click();
const before = await page.locator('.node').count();
await side.getByRole('button', { name: 'Expand all' }).click();
await line('Studio').locator('.label').click();
ok((await page.locator('.node').count()) === before && (await page.locator('.inspector input').first().inputValue()) === 'Studio', `in subgraph mode, picking a class in the tree shows its details without changing the subgraph (${before} terms)`);
await page.locator('.subgraph').getByRole('button', { name: 'Full graph' }).click();

// ---- cycles do not hang the tree
await bulkRel('Person -> is a -> Stage actor');
await side.getByRole('button', { name: 'Expand all' }).click();
ok((await side.locator('.tag.warn').count()) >= 1 && (await side.locator('.tree-line').count()) < 40, 'a cycle is marked and the tree stops there (' + (await side.locator('.tree-line').count()) + ' rows)');

// ---- a large ontology: opens two levels deep, stays quick
await file(/^Generate a stress-test model/);
await page.waitForFunction(() => document.querySelectorAll('.node').length > 900);
const big = await side.locator('.tree-line').count();
ok(big < 120 && (await side.locator('.list-count').innerText()).includes('650 classes'), `650-class model: the tree opens two levels deep (${big} rows drawn, not 650)`);
const time = async (label, selector) => page.evaluate(async ([label, selector]) => { const el = document.querySelector(selector); const t0 = performance.now(); el.click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); return `${label}: ${Math.round(performance.now() - t0)} ms`; }, [label, selector]);
const expandAll = await time('expand all 650 classes', '.term-list .mini[aria-label="Expand all"]');
const rowsOpen = await side.locator('.tree-line').count();
const pick = await time('select a class in the fully open tree', '.term-list .tree-line:nth-child(300) .label');
ok(rowsOpen > 650 && Number(expandAll.match(/(\d+) ms/)[1]) < 1500 && Number(pick.match(/(\d+) ms/)[1]) < 400, `${expandAll} (${rowsOpen} rows); ${pick}`);
await side.getByLabel('Search terms').fill('Class 64');
await page.waitForTimeout(150);
ok((await side.locator('.tree-line.match').count()) >= 11, `search in the large tree: ${await side.locator('.list-count').innerText()}`.replace(/\s+/g, ' '));
await page.screenshot({ path: shots + 'tree-large-search.png' });

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
