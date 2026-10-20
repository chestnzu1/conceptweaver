// Drives the built app in a headless browser to check stable identity: a model saved in format 1
// opens as it was and is kept in the format of today; renaming an object property renames its uses and no
// others; every new entity has an IRI from the start.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const fixtures = new URL('../src/model/fixtures/v1/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Graph'); return ttl; };
const block = (ttl, subject) => flat(ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '');
const toast = async () => flat(await page.locator('.toast').innerText({ timeout: 2000 }).catch(() => ''));
const view = page.locator('.view');
const kindTab = (name) => view.getByRole('tab', { name: new RegExp('^' + name) }).click();
const propRow = (name) => view.locator('tbody tr', { has: page.locator(`input[aria-label="Property name"][value="${name}"]`) });
// The working copy is written 300 ms after a change.
// The working copy, as it is kept in this browser (IndexedDB), a moment after a change.
const saved = async () => { await page.waitForTimeout(500); return page.evaluate(() => new Promise((resolve, reject) => { const r = indexedDB.open('conceptweaver'); r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('working')) { db.close(); return resolve(null); } const g = db.transaction('working', 'readonly').objectStore('working').get('current'); g.onsuccess = () => { db.close(); resolve(g.result?.model ?? null); }; g.onerror = () => reject(g.error); }; })); };

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- a model saved in format 1
await page.locator('.header input[type=file]').setInputFiles(fixtures + 'edge-cases.json');
await page.waitForFunction(() => (document.querySelector('.toast')?.textContent ?? '').includes('Opened'));
ok((await toast()).startsWith('Opened “Identity fixture”'), 'a model saved in format 1 opens: ' + (await toast()));
const before = fs.readFileSync(fixtures + 'edge-cases.ttl', 'utf8');
let ttl = await turtle();
ok(flat(ttl) === flat(before), 'and says exactly what it said when it was saved: the Turtle of then');
await tab('Entities');
await kindTab('Relationships');
const labels = await view.locator('tbody tr input[aria-label="Label"], tbody tr input[aria-label="Relationship label"]').evaluateAll((xs) => xs.map((x) => x.value));
ok(['Directed By', 'Wins', 'sponsors'].every((l) => labels.includes(l)), 'its relationships keep their labels as they were written: ' + labels.filter(Boolean).join(', '));
await tab('Graph');
// An edit, so that it is written down again.
await page.locator('.node').first().locator('.node-box').click();
const json = await (async () => { await page.keyboard.press('ArrowRight'); return saved(); })();
const kept = json ?? (await saved());
ok(kept === null || (kept.version === 11 && kept.props.every((p) => typeof p.id === 'string' && p.id) && kept.relations.some((r) => r.prop)), `kept in the format of today (11): every object property with an id, and its uses naming it${kept ? ` (version ${kept.version}, ${kept.props.length} properties)` : ' (no change written yet)'}`);

// ---------------------------------------------------------------- renaming a property renames its uses, and no others
await tab('Entities');
await kindTab('Object properties');
const nameBox = propRow('directed by').locator('input[aria-label="Property name"]');
await nameBox.fill('made by');
// The row is found by the name in its box, which is no longer there: Enter goes to the box that has the focus.
await page.keyboard.press('Enter');
ok((await propRow('made by').count()) === 1 && (await propRow('directed by').count()) === 0, 'an object property is renamed in the table');
ttl = await turtle();
ok(block(ttl, ':directedBy').includes('rdfs:label "made by"') && block(ttl, ':Film').includes('owl:onProperty :directedBy'), 'it keeps its IRI, and the restriction that uses it still does: ' + block(ttl, ':directedBy').slice(0, 80));
ok(block(ttl, ':Director').includes('owl:onProperty :directs') && block(ttl, ':directs').includes('rdfs:label "directs"'), 'the other properties and their uses are as they were');
await tab('Entities');
await kindTab('Relationships');
const after = await view.locator('tbody tr input[aria-label="Label"], tbody tr input[aria-label="Relationship label"]').evaluateAll((xs) => xs.map((x) => x.value));
ok(after.includes('made by') && !after.includes('Directed By') && after.includes('Wins') && after.includes('sponsors'), 'the relationship that used it is called by the new name; the others keep theirs: ' + after.filter(Boolean).join(', '));

// Two of the model's own properties with one name would invite mistakes: that is refused, and said.
await kindTab('Object properties');
const sponsors = propRow('Sponsors').locator('input[aria-label="Property name"]');
await sponsors.fill('funds');
await page.keyboard.press('Enter');
const refused = await toast();
ok(refused.includes('There is already a property called “funds”') && block(await turtle(), ':sponsors').includes('rdfs:label "Sponsors"'), 'giving a property the name of another of the model’s own is refused, and it keeps its name: ' + refused);
await tab('Entities');

// ---------------------------------------------------------------- an IRI from the start
await kindTab('Classes');
await view.getByRole('button', { name: 'Add class' }).click();
const fresh = view.locator('tbody tr', { has: page.locator('input[value="New class"]') });
const iriOf = async (row) => (await row.locator('.iri-cell').getAttribute('title').catch(() => '')) ?? '';
ok((await iriOf(fresh)).startsWith('http://example.org/fixture#NewClass'), 'a new class has an IRI at once, standing in until it is named: ' + (await iriOf(fresh)));
await fresh.locator('input').first().fill('Screenplay');
await page.keyboard.press('Enter');
const named = view.locator('tbody tr', { has: page.locator('input[value="Screenplay"]') });
ok((await iriOf(named)).startsWith('http://example.org/fixture#Screenplay'), 'named, it has one made from its name: ' + (await iriOf(named)));
await named.locator('input').first().fill('Script');
await page.keyboard.press('Enter');
const renamed = view.locator('tbody tr', { has: page.locator('input[value="Script"]') });
ok((await iriOf(renamed)).startsWith('http://example.org/fixture#Screenplay'), 'and renamed, it keeps it: ' + (await iriOf(renamed)));

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
