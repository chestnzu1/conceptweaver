// Exports a model as an interactive page from the built app, then opens that page on its own
// (from the file, with the network off) and uses it.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const errors = [];
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const watch = (page) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('dialog', (d) => d.accept());
};

// ---------------------------------------------------------------- export it from the app
const app = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
watch(app);
await app.goto(base);
await app.evaluate(() => { localStorage.clear(); });
await app.reload();
await app.waitForSelector('.node');
// Something that would be markup or script if it were ever written into the page as such.
await app.locator('.inspector').getByLabel('Hide the model details').waitFor();
const description = app.locator('.inspector .field', { hasText: 'Description' }).locator('textarea');
await description.fill('Films & the people who make them. </script><img src=x onerror="document.title=\'pwned\'">');
await description.blur();
// A piece of governance metadata, to see that it travels.
await app.locator('.header').getByRole('tab', { name: 'Entities' }).click();
await app.locator('.view').getByRole('tab', { name: 'Governance & Metadata' }).click();
await app.locator('.gov-list tbody tr', { has: app.locator('td:first-child', { hasText: /^Film$/ }) }).click();
await app.locator('.gov-form [data-field="status"] select').selectOption('Approved');
const owner = app.locator('.gov-form [data-field="owner"]');
await owner.locator('.chip-add').click();
await owner.getByRole('combobox').fill('Studio');
await owner.locator('.subgraph-found button').first().dispatchEvent('pointerdown');

const exportPage = async (file) => {
  await app.getByRole('button', { name: 'File', exact: true }).click();
  const [download] = await Promise.all([app.waitForEvent('download'), app.getByRole('menuitem', { name: /^Interactive page/ }).click()]);
  await download.saveAs(shots + file);
  return { name: download.suggestedFilename(), html: fs.readFileSync(shots + file, 'utf8') };
};
const out = await exportPage('export.html');
ok(out.name === 'film-knowledge-graph.html', 'File → Export → Interactive page downloads one HTML file: ' + out.name);
ok(!/<link\b|<script\b[^>]*\bsrc=|@import|url\(\s*["']?https?:/i.test(out.html) && !/<(img|iframe)\b/i.test(out.html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')), `it is complete in itself: no stylesheet, script, image or frame is fetched (${Math.round(out.html.length / 1024)} KB)`);

// ---------------------------------------------------------------- open it on its own
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, offline: true });
const page = await context.newPage();
watch(page);
const requests = [];
page.on('request', (r) => requests.push(r.url()));
await page.goto('file://' + shots + 'export.html');
const nav = page.locator('#nav');
const detail = page.locator('#detail');
const node = (name) => page.locator('#graph [data-term]', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
ok((await page.title()) === 'Film knowledge graph' && flat(await page.locator('.top').innerText()).startsWith('Film knowledge graph OWL ontology'), 'opened from the file with the network off, it shows the model and its type');
ok(requests.filter((u) => !u.startsWith('file://')).length === 0, 'and asks the network for nothing');
ok((await page.locator('#graph [data-term]').count()) === 11 && (await page.locator('#graph [data-rel]').count()) === 11, 'the graph is there as it was drawn: 11 terms, 11 relationships');
ok(flat(await detail.innerText()).includes('</script><img src=x') && (await page.title()) !== 'pwned' && (await page.locator('#detail img').count()) === 0, 'a description that looks like markup is shown as the text it is');
const heads = (await nav.locator('h2').allInnerTexts()).map((s) => flat(s).toLowerCase()).join(', ');
ok(heads === 'classes (8), data properties (2), individuals (1), object properties (5)', 'the list has the classes as a hierarchy, and the other kinds: ' + heads);
ok((await nav.locator('ul ul .item', { hasText: /^Actor$/ }).count()) === 1, 'Actor sits under Person');

// clicking a term in the picture
await node('Film').click();
const text = flat(await detail.innerText());
ok(text.startsWith('Film') && text.includes('http://example.org/film-knowledge-graph#Film') && !/\bnull\b|\bundefined\b|\[object/.test(text), 'clicking a term shows its name and IRI, and nothing that is not there');
ok(text.includes('SUBCLASS Documentary') && /acts in some/.test(text) && /belongs to some Genre/.test(text), 'what it is above, and its relationships both ways');
ok(/Lifecycle status\s*Approved/.test(text) && /Data owner\s*Studio/.test(text), 'and its metadata: the status, and the owner as a link to that term');
ok((await node('Film').getAttribute('class')).includes('sel') && (await node('Actor').getAttribute('class')).includes('near') && (await node('Parasite').getAttribute('class')).includes('near') && !(await node('Person').getAttribute('class') ?? '').includes('near'), 'in the picture it is marked, its neighbours stay bright and the rest fades');
ok((await nav.locator('.item.on').innerText()) === 'Film' && page.url().includes('#term='), 'it is marked in the list, and the address names it');
await page.screenshot({ path: shots + 'html-export.png' });

// following a link, and an edge
await detail.locator('.link', { hasText: /^Studio$/ }).first().click();
ok(flat(await detail.locator('h2').innerText()) === 'Studio' && flat(await detail.innerText()).includes('produces some Film'), 'a term named in the details is a link to it');
await page.locator('#graph [data-rel]', { has: page.locator('text', { hasText: /^directs some$/ }) }).locator('text').click();
ok(flat(await detail.innerText()).startsWith('directs some restriction From Director To Film'), 'clicking a relationship shows what it relates: ' + flat(await detail.innerText()).slice(0, 60));
await nav.locator('.item', { hasText: /^directs$/ }).click();
ok(flat(await detail.innerText()).includes('Object property') && flat(await detail.innerText()).includes('Domain') && flat(await detail.innerText()).includes('Director directs some Film'), 'an object property shows its domain and range and where it is used');

// search, and the keyboard
await page.keyboard.press('Escape');
ok(flat(await detail.locator('h2').innerText()) === 'Film knowledge graph' && !(await page.locator('#graph svg').getAttribute('class') ?? '').includes('focused'), 'Escape goes back to the model as a whole');
await page.keyboard.press('/');
await page.keyboard.type('docu');
ok((await nav.locator('.item').allInnerTexts()).map(flat).join('|') === 'Documentary Class', 'the search narrows the list: ' + (await nav.locator('.item').allInnerTexts()).map(flat).join(', '));
await page.keyboard.press('Tab');
await page.keyboard.press('Enter');
ok(flat(await detail.locator('h2').innerText()) === 'Documentary', 'and what it finds can be opened from the keyboard');

// moving the picture
const box = () => page.locator('#graph svg').getAttribute('viewBox');
const before = await box();
await page.getByRole('button', { name: 'Zoom in' }).click();
const zoomed = await box();
// On the empty background, top left of the picture: a drag there moves the whole graph.
await page.mouse.move(330, 140);
await page.mouse.down();
await page.mouse.move(430, 200, { steps: 5 });
await page.mouse.up();
const moved = await box();
await page.getByRole('button', { name: 'Fit' }).click();
ok(zoomed !== before && moved !== zoomed && (await box()) === before && flat(await detail.locator('h2').innerText()) === 'Documentary', 'the graph zooms, is dragged about and fits again, and a drag is not a click');

// ---------------------------------------------------------------- moving terms and relationships
const edgeOf = (label) => page.locator('#graph [data-rel]', { has: page.locator('text', { hasText: new RegExp('^' + label + '$') }) });
const lineOf = (label) => edgeOf(label).locator('[data-part="line"]').getAttribute('d');
const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);
const close = (a, b, by = 0.35) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= by);
const centre = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const dragBy = async (loc, dx, dy) => {
  const c = await centre(loc);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 4 });
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 4 });
  await page.mouse.up();
};
await page.locator('#q').fill('');
const reset = page.getByRole('button', { name: 'Reset layout' });
ok(await reset.isHidden(), 'as exported, there is nothing to reset');
const exported = { studio: await node('Studio').getAttribute('transform'), produces: await lineOf('produces some'), acts: await lineOf('acts in some'), directs: await lineOf('directs some') };

// The page draws lines the way the app does: a term moved one step and back has its lines where the app drew them.
await nav.locator('.item', { hasText: /^Studio$/ }).click();
await page.keyboard.press('Shift+ArrowRight');
const stepped = await lineOf('produces some');
await page.keyboard.press('Shift+ArrowLeft');
ok(stepped !== exported.produces && close(nums(await lineOf('produces some')), nums(exported.produces)), 'Shift and an arrow key move the chosen term a step, and its line is redrawn exactly as the app draws it');

const from = await centre(node('Studio'));
await dragBy(node('Studio'), 150, -90);
const now = await centre(node('Studio'));
ok(Math.abs(now.x - from.x - 150) < 4 && Math.abs(now.y - from.y + 90) < 4 && (await node('Studio').getAttribute('transform')) !== exported.studio, 'a term can be dragged to another place');
const line = nums(await lineOf('produces some'));
// Where a term's box is, in the picture's own coordinates, and whether a point is on its edge or inside it.
const boxOf = (name) => page.evaluate((n) => { const t = [...document.querySelectorAll('#graph [data-term]')].find((g) => g.textContent.trim() === n); const m = /translate\(([-\d.]+),([-\d.]+)/.exec(t.getAttribute('transform')); const r = t.firstElementChild; return { x: +m[1], y: +m[2], w: r.width.baseVal.value, h: r.height.baseVal.value }; }, name);
const onBox = (b, x, y) => x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4;
ok(onBox(await boxOf('Studio'), line[0], line[1]), 'its relationship follows it: the line still starts at the term');
ok((await lineOf('acts in some')) === exported.acts && flat(await detail.locator('h2').innerText()) === 'Studio', 'lines that do not touch it stay put, and dragging did not change what is chosen');
ok(await reset.isVisible(), 'and there is now a layout to reset');

// a relationship: its line is pulled into a bow
const beforeBend = nums(await lineOf('directs some'));
await dragBy(edgeOf('directs some').locator('[data-part="label"]'), 70, 0);
const bent = nums(await lineOf('directs some'));
ok(Math.abs(bent[2] - beforeBend[2]) > 40 && onBox(await boxOf('Director'), bent[0], bent[1]), 'a relationship can be dragged too: its line bows towards where it was pulled, and still starts at its term');

// kept over a reload, in this browser
await page.reload();
ok((await node('Studio').getAttribute('transform')) !== exported.studio && close(nums(await lineOf('directs some')), bent) && (await reset.isVisible()), 'after a reload the arrangement is still there');
await reset.click();
ok((await node('Studio').getAttribute('transform')) === exported.studio && (await lineOf('produces some')) === exported.produces && (await lineOf('directs some')) === exported.directs && (await reset.isHidden()), 'Reset layout puts everything back as it was exported');
await page.reload();
ok((await node('Studio').getAttribute('transform')) === exported.studio, 'and it stays reset');

// ---------------------------------------------------------------- a vocabulary, in the dark
await app.getByRole('button', { name: 'File', exact: true }).click();
await app.getByRole('menuitem', { name: 'Load the SKOS example' }).click();
await app.waitForSelector('.node');
await app.getByRole('button', { name: 'Toggle theme' }).click();
await app.waitForTimeout(400);
const skos = await exportPage('export-skos.html');
await page.goto('file://' + shots + 'export-skos.html');
ok(flat(await page.locator('#type').innerText()) === 'SKOS-like vocabulary' && flat(await nav.locator('h2').first().innerText()).toLowerCase().startsWith('concepts') && (await nav.locator('h2').count()) === 1, 'a vocabulary is exported as one: concepts, and no other kind of entity');
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(bg === 'rgb(18, 20, 22)', 'exported from the dark theme, the page is dark like its picture: ' + bg);
await page.locator('#graph [data-term]').first().click();
ok(/Broader concept|Narrower concept/i.test(flat(await detail.innerText())), 'and its hierarchy is spoken of as broader and narrower');
ok(skos.html.length > 2000, 'done');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
