// Drives the built app in a headless browser to check the ontology-to-LDM transformation
// (roadmap LM-3, FR-M18-1 to FR-M18-6, NFR-17 and NFR-18, ADR-024): the proposals read from the
// example ontology, grouped by what they would make and chosen one by one or by kind; nothing is
// written while they are only proposed, and closing with nothing chosen leaves the LDM as it was;
// the configuration (here: lower-case names joined by underscores) is read from the LDM's saved
// derivation and a change to it has to be proposed again; accepted proposals go in as one change
// set, which one undo takes back and one redo puts back; the whole run is worked out in a worker;
// the ontology is not touched; and running it again after a rename and a hand-made attribute
// mandatory proposes nothing over either.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
// Count the proposal jobs posted to workers, so that "in a worker" is checked and not assumed.
await page.addInitScript(() => {
  window.__workerJobs = [];
  const Real = window.Worker;
  window.Worker = new Proxy(Real, {
    construct(target, args) {
      const worker = Reflect.construct(target, args);
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (data, ...rest) => {
        try {
          if (data && data.ontology && data.target && data.config) window.__workerJobs.push(String(args[0]));
        } catch {
          // Not a job we can read: let it go.
        }
        return post(data, ...rest);
      };
      return worker;
    },
  });
});
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => {
  if (!c) failed++;
  console.log((c ? 'PASS ' : 'FAIL ') + m);
};
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const view = (name) => page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
const part = (name) => page.getByRole('tablist', { name: 'Part of the logical model' }).getByRole('tab', { name });
const models = page.locator('.dialog.logical-models');
const dialog = page.locator('.dialog.transform');
const rows = page.locator('.ldm-list li');
const names = async () => (await page.locator('.ldm-list li button > span').allInnerTexts()).map(flat);
const graph = async () => (await page.locator('.node').allTextContents()).map(flat).sort();
const jobs = () => page.evaluate(() => window.__workerJobs.length);
const proposals = (n) => page.waitForFunction((count) => document.querySelectorAll('.dialog.transform .proposal').length === count, n);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
const graphBefore = await graph();

// ---------------------------------------------------------------- a logical model to derive into
await view('LDM').click();
await page.getByRole('button', { name: /Make a logical model/ }).click();
await models.waitFor();
await models.getByLabel('Name of the new logical model').fill('Catalogue');
await models.getByRole('button', { name: 'Make a logical model' }).click();
await models.getByRole('button', { name: 'Open', exact: true }).click();
await page.locator('.ldm-view .ldm-head').waitFor();

// ---------------------------------------------------------------- proposals, with nothing chosen
const startedAt = await jobs();
await page.getByRole('button', { name: /Derive from the ontology/ }).click();
await dialog.waitFor();
await proposals(17);
ok((await jobs()) > startedAt, 'the proposals are worked out off the page, in a worker');
const heading = async (kind) => flat(await dialog.locator(`.proposal-group[data-kind="${kind}"] h3`).innerText());
ok((await heading('entity')) === 'Entities (8)', 'a class becomes an entity: ' + (await heading('entity')));
ok((await heading('attribute')) === 'Attributes (2)', 'a datatype property becomes an attribute: ' + (await heading('attribute')));
ok((await heading('relationship')) === 'Relationships (5)', 'an object property becomes a relationship: ' + (await heading('relationship')));
ok((await heading('specialization')) === 'Specializations (2)', 'a subclass edge becomes a specialization: ' + (await heading('specialization')));
ok((await dialog.locator('.proposal[data-candidate="true"]').count()) === 0, 'nothing here is a candidate constraint');
const checked = await dialog.locator('.proposal input[type="checkbox"]').evaluateAll((xs) => xs.map((x) => x.checked));
ok(checked.length === 17 && checked.every(Boolean), 'structure for the scope comes chosen to begin with');
ok(!(await dialog.getByRole('button', { name: 'Apply the chosen' }).isDisabled()), 'and can be applied as offered');
const entityGroup = dialog.locator('.proposal-group[data-kind="entity"]');
await entityGroup.getByRole('button', { name: 'Choose none of these' }).click();
const uncheckedByKind = await entityGroup.locator('.proposal input[type="checkbox"]').evaluateAll((xs) => xs.map((x) => x.checked));
ok(uncheckedByKind.length === 8 && uncheckedByKind.every((c) => !c), 'proposals can be chosen or not by kind');
await entityGroup.getByRole('button', { name: 'Choose all 8' }).click();
const rechecked = await entityGroup.locator('.proposal input[type="checkbox"]').evaluateAll((xs) => xs.map((x) => x.checked));
ok(rechecked.every(Boolean), 'and chosen by kind again');

const first = dialog.locator('.proposal-group[data-kind="entity"] .proposal').first();
const card = flat(await first.innerText());
ok(/Strategy/.test(card) && /Why/.test(card) && /Differs/.test(card), 'each proposal says its strategy, why, and where OWL and the LDM differ');
const axiom = flat(await first.locator('code.axiom').first().innerText());
ok(axiom.includes('Declaration') || axiom.includes('SubClassOf'), 'shows the axiom it was read from: ' + axiom);
ok(card.includes('Entity '), 'and the element it would make: ' + card.split('Strategy')[0].slice(0, 160));
await page.screenshot({ path: shots + 'transformation-proposals.png' });

await dialog.getByRole('button', { name: 'Choose none', exact: true }).click();
ok(await dialog.getByRole('button', { name: 'Apply the chosen' }).isDisabled(), 'choosing none disables applying them');
await dialog.getByRole('button', { name: 'Close', exact: true }).click();
await dialog.waitFor({ state: 'detached' });
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 0);
ok((await rows.count()) === 0, 'closing with nothing chosen leaves the logical model as it was');

// ---------------------------------------------------------------- the configuration, and applying
await page.getByRole('button', { name: /Derive from the ontology/ }).click();
await dialog.waitFor();
await proposals(17);
await dialog.getByLabel('How names are cased').selectOption('lower');
await dialog.getByLabel('What joins the words of a name').selectOption('_');
ok(await dialog.getByRole('button', { name: 'Apply the chosen' }).isDisabled(), 'a changed configuration has to be proposed again before it is applied');
await dialog.getByRole('button', { name: 'Propose again' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.dialog.transform .proposal')].some((el) => el.textContent?.includes('Entity film')));
await proposals(17);
ok(await dialog.getByText('Attribute film.release_date', { exact: true }).isVisible(), 'the naming chosen is what the proposals would make');
ok(flat(await dialog.locator('.dialog-actions').innerText()).includes('17 chosen'), 'structure comes chosen again for the new configuration');
await page.getByRole('button', { name: 'Apply the chosen' }).click();
await dialog.waitFor({ state: 'detached' });
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 8);

const made = (await names()).map((n) => n.toLowerCase()).sort();
ok(made.join(' | ') === ['actor', 'award', 'director', 'documentary', 'film', 'genre', 'person', 'studio'].join(' | '), 'an entity per class, named as the configuration says: ' + made.join(' | '));
await page.locator('.ldm-list li button', { hasText: 'film' }).click();
await page.getByLabel('Name of the attribute release_date').waitFor();
ok(await page.getByLabel('Name of the attribute running_time').isVisible(), 'an attribute per datatype property');
const optional = await page.locator('.ldm-attribute .check', { hasText: 'Optional' }).locator('input').evaluateAll((xs) => xs.map((x) => x.checked));
ok(optional.length === 2 && optional.every(Boolean), 'every attribute is optional: nothing is made mandatory from an axiom');
ok((await page.locator('.ldm-key').count()) === 0, 'and no key is made');
await part(/^Relationships/).click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 5);
ok((await rows.count()) === 5, 'a relationship per object property');
await part(/^Rules/).click();
ok(await page.getByText('No rule yet.').isVisible(), 'and no business rule');
await part(/^Domains/).click();
ok(await page.getByText('No domain yet.', { exact: true }).isVisible(), 'nor a domain: the ontology states no enumeration');

// The ontology itself was only read.
await view('Graph').click();
await page.waitForSelector('.node');
ok((await graph()).join(' | ') === graphBefore.join(' | '), 'the ontology is as it was: ' + graphBefore.length + ' nodes');
await view('LDM').click();
await part(/^Entities/).click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 8);

// ---------------------------------------------------------------- one change set: one undo, one redo
await page.getByRole('button', { name: 'Undo' }).click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 0);
ok(await page.getByText('No entity yet. Make one to begin.').isVisible(), 'one undo takes the whole derivation back');
await page.getByRole('button', { name: 'Redo' }).click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 8);
ok((await rows.count()) === 8, 'and one redo puts it back');

// ---------------------------------------------------------------- running it again, over hand edits
await page.locator('.ldm-list li button', { hasText: 'actor' }).click();
const entityName = page.getByLabel('Entity name');
await entityName.waitFor();
await entityName.fill('performer');
await entityName.press('Enter');
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button > span')].some((x) => x.textContent === 'performer'));
await page.locator('.ldm-list li button', { hasText: 'film' }).click();
const release = page.locator('.ldm-attribute').filter({ has: page.getByLabel('Name of the attribute release_date') });
await release.locator('.check', { hasText: 'Optional' }).locator('input').uncheck();
await page.waitForFunction(() => {
  const row = document.querySelector('input[aria-label="Name of the attribute release_date"]')?.closest('.ldm-attribute');
  const box = [...(row?.querySelectorAll('label.check') ?? [])].find((l) => l.textContent?.trim() === 'Optional');
  return box?.querySelector('input')?.checked === false;
});

const againFrom = await jobs();
await page.getByRole('button', { name: /Derive from the ontology/ }).click();
await dialog.waitFor();
await dialog.getByText('Nothing is proposed').waitFor();
ok((await dialog.locator('.proposal').count()) === 0, 'run again over the user’s rename and mandatory attribute, it proposes nothing');
ok(await dialog.locator('.not-proposed').isVisible(), 'and says what it left alone, and why');
ok(/already represented by an entity/.test(await dialog.locator('.not-proposed').evaluate((el) => el.textContent ?? '')), 'the classes are already represented by their entities');
ok((await jobs()) > againFrom, 'this run too is worked out in a worker');
ok((await dialog.getByLabel('How names are cased').inputValue()) === 'lower', 'the configuration saved with the model is read back');
ok((await dialog.getByLabel('What joins the words of a name').inputValue()) === '_', 'so another run works from the same choices');
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button > span')].length === 8);
ok((await names()).includes('performer'), 'the logical model keeps the user’s edits');

await page.screenshot({ path: shots + 'transformation.png' });
console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
