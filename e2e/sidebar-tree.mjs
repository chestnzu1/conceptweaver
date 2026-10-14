// Drives the built app in a headless browser to check the sidebar class tree.
// Run with the preview server up:  pnpm build && pnpm exec vite preview --port 5181 &  node e2e/sidebar-tree.mjs
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
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

await page.goto(base);
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
// From the click to the second frame after it, when what it changed is drawn.
const time = (selector) => page.evaluate(async (selector) => { const el = document.querySelector(selector); const t0 = performance.now(); el.click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); return Math.round(performance.now() - t0); }, selector);
// Selecting is timed five times, on five rows, and judged by the median, so that one slow frame
// does not decide. It is judged against selecting in the tree as it opened, a hundred rows or so,
// as a measure of this machine at this moment: the fully open tree may take three times that, or
// 400 ms, whichever is more. What this guards against is selection costing in proportion to the rows.
// The first selection in a model just opened costs more than the rest; it falls among the five of
// the calibration, and all ten timings are shown.
const select = async (rows) => { const ms = []; for (const n of rows) ms.push(await time(`.term-list .tree-line:nth-child(${n}) .label`)); return ms; };
const median = (ms) => [...ms].sort((a, b) => a - b)[2];
const calm = await select([10, 20, 30, 40, 50]);
const calibration = median(calm);
const expandAll = await time('.term-list .mini[aria-label="Expand all"]');
const rowsOpen = await side.locator('.tree-line').count();
const picks = await select([300, 310, 320, 330, 340]);
const bound = Math.max(400, 3 * calibration);
ok(rowsOpen > 650 && expandAll < 1500 && median(picks) < bound, `expand all 650 classes: ${expandAll} ms (${rowsOpen} rows); select a class in the fully open tree: ${median(picks)} ms, the median of ${picks.join(', ')} (under ${bound} ms: 400, or three times the ${calibration} ms, the median of ${calm.join(', ')}, it takes in the tree as it opened)`);
await side.getByLabel('Search terms').fill('Class 64');
await page.waitForTimeout(150);
ok((await side.locator('.tree-line.match').count()) >= 11, `search in the large tree: ${await side.locator('.list-count').innerText()}`.replace(/\s+/g, ' '));
await page.screenshot({ path: shots + 'tree-large-search.png' });

// ---- the sidebar folds away to a strip, and comes back as it was
const squash = (t) => t.replace(/\s+/g, ' ').trim();
const width = (sel) => page.locator(sel).evaluate((el) => Math.round(el.getBoundingClientRect().width));
const nodeAt = () => page.locator('.node').first().evaluate((el) => Math.round(el.getBoundingClientRect().left));
const hide = side.getByRole('button', { name: 'Hide the sidebar' });
const show = side.getByRole('button', { name: 'Show the sidebar' });
const counted = squash(await side.locator('.list-count').innerText());
const [stageWide, sideWide, nodeWas] = [await width('.stage'), await width('.term-list'), await nodeAt()];
await hide.click();
ok((await side.locator('.class-tree').count()) === 0 && (await width('.term-list')) === 40 && (await width('.stage')) === stageWide + sideWide - 40, `the sidebar folds away to a strip, and its room goes to the canvas: ${stageWide} → ${await width('.stage')}`);
ok((await nodeAt()) === nodeWas, 'the graph stays where it was on the screen');
ok((await show.getAttribute('aria-expanded')) === 'false' && (await show.getAttribute('title')).includes('A search is on: “Class 64”') && (await side.locator('.rail-mark').count()) === 1, 'the strip says that a search is still on, though its box is out of sight');
await page.screenshot({ path: shots + 'sidebar-folded.png' });
await tab('Entities');
ok((await width('.view')) === stageWide + sideWide - 40, 'the other views get the room too');
await tab('Graph');
await show.click();
ok((await side.getByLabel('Search terms').inputValue()) === 'Class 64' && squash(await side.locator('.list-count').innerText()) === counted && (await nodeAt()) === nodeWas && (await width('.stage')) === stageWide, 'opened again it is as it was: the search, what it found, and the graph in its place');
await side.getByLabel('Search terms').fill('');
await side.getByRole('tab', { name: /^Properties/ }).click();
await hide.click();
ok((await side.locator('.rail-mark').count()) === 0 && !(await show.getAttribute('title')).includes('search'), 'without a search the strip has nothing to say about one');
await page.reload();
await page.waitForSelector('.node');
ok((await show.count()) === 1 && (await width('.term-list')) === 40, 'folded away, it stays so after a reload');
await show.focus();
await page.keyboard.press('Enter');
ok((await hide.count()) === 1 && (await width('.term-list')) === sideWide, 'the strip opens it again, from the keyboard as well');
await page.reload();
await page.waitForSelector('.node');
ok((await hide.count()) === 1, 'and open, it stays open after a reload');

// ---- the edge of the sidebar is dragged to make it wider or narrower
const handle = page.locator('.sidebar-resizer');
const edge = async () => { const b = await side.boundingBox(); return { x: b.x + b.width, y: b.y + 300 }; };
const dragBy = async (dx) => { const p = await edge(); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + dx / 2, p.y, { steps: 3 }); await page.mouse.move(p.x + dx, p.y, { steps: 3 }); await page.mouse.up(); };
const [stage0, node0] = [await width('.stage'), await nodeAt()];
ok((await handle.getAttribute('role')) === 'separator' && (await handle.getAttribute('aria-valuenow')) === String(sideWide), 'between the sidebar and the rest is an edge that says how wide the sidebar is');
await dragBy(100);
ok((await width('.term-list')) === sideWide + 100 && (await width('.stage')) === stage0 - 100 && (await handle.getAttribute('aria-valuenow')) === String(sideWide + 100), `dragging the edge makes the sidebar wider: ${sideWide} → ${await width('.term-list')}`);
ok((await nodeAt()) === node0, 'and the graph stays where it was on the screen meanwhile');
await dragBy(-2000);
const narrowest = await width('.term-list');
await dragBy(3000);
ok(narrowest === 180 && (await width('.term-list')) === 720, `it goes no narrower than 180 and no wider than 720, or half the window: ${narrowest}, ${await width('.term-list')}`);
await page.setViewportSize({ width: 1000, height: 940 });
ok((await width('.term-list')) === 500, 'in a smaller window it takes half at most, whatever it was set to');
await page.setViewportSize({ width: 1500, height: 940 });
let p = await edge();
await page.mouse.dblclick(p.x, p.y);
ok((await width('.term-list')) === 180 && (await side.locator('ul').evaluate((ul) => ul.scrollWidth <= ul.clientWidth)), 'double-clicking the edge makes it as wide as its names need, which for short names is as narrow as it goes');
// A class with a long name: cut off at first, shown whole once the edge is double-clicked.
const long = 'Basel II Counterparty Classification Code';
await side.locator('.tree-line button.label').first().click();
await page.locator('.inspector input').first().fill(long);
await page.locator('.inspector input').first().press('Enter');
const whole = () => side.locator('.tree-line .name', { hasText: long }).evaluate((n) => n.getBoundingClientRect().right <= n.closest('.term-list').getBoundingClientRect().right);
const cut = !(await whole());
p = await edge();
await page.mouse.dblclick(p.x, p.y);
const fitted = await width('.term-list');
ok(cut && (await whole()) && fitted > 232 && fitted < 720 && (await side.locator('ul').evaluate((ul) => ul.scrollWidth <= ul.clientWidth)), `a long name is cut off until the edge is double-clicked, which makes room for all of it: ${fitted}`);
await handle.focus();
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Shift+ArrowLeft');
ok((await width('.term-list')) === fitted + 16 - 64, 'with the keyboard the arrow keys move the edge, further with Shift');
await page.keyboard.press('Enter');
ok((await width('.term-list')) === fitted, 'and Enter fits it to the names again');
await page.reload();
await page.waitForSelector('.node');
ok((await width('.term-list')) === fitted, 'the width is remembered after a reload');
await hide.click();
await show.click();
ok((await width('.term-list')) === fitted, 'and folded away and opened again, the sidebar is as wide as it was');
await page.screenshot({ path: shots + 'sidebar-resized.png' });

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
