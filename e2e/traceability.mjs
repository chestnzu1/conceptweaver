// Drives the built app in a headless browser to check semantic traceability and change impact
// (roadmap LM-4, FR-M18-8 to FR-M18-14, NFR-19, ADR-025): two logical models derived from one
// ontology, one of their attributes changed by hand; a datatype property removed from the
// ontology; each model's traceability report naming exactly the attribute made from it, broken;
// the impact report, worked out in a worker, from each mapping's origin and between two saved
// versions; synchronization offering the removal, choosing an untouched one and never a changed
// one; applying it as one change set that one undo takes back, and the ontology never written.
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
// Count the impact jobs posted to workers, so that NFR-19 is checked and not assumed.
await page.addInitScript(() => {
  window.__impactJobs = [];
  const Real = window.Worker;
  window.Worker = new Proxy(Real, {
    construct(target, args) {
      const worker = Reflect.construct(target, args);
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (data, ...rest) => {
        try {
          if (data && data.kind === 'impact' && data.ontology && data.target) window.__impactJobs.push(String(args[0]));
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
const transform = page.locator('.dialog.transform');
const impact = page.locator('.dialog.impact-dialog');
const trace = page.locator('.ldm-traceability');
const versions = page.locator('.dialog.versions');
const jobs = () => page.evaluate(() => window.__impactJobs.length);
const menu = async (item) => {
  await page.locator('.header').getByRole('button', { name: /^File/ }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
const turtle = async () => {
  await view('RDF').click();
  const ttl = await page.locator('.rdf-code').innerText();
  await view('Graph').click();
  await page.waitForSelector('.node');
  return ttl;
};
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
const filmRow = () => page.locator('.ldm-list li button', { hasText: 'Film' }).first();
const releaseField = () => page.getByLabel('Name of the attribute Release date');
const optionalOfRelease = () => page.locator('.ldm-attribute').filter({ has: page.getByLabel('Name of the attribute Release date') }).locator('.check', { hasText: 'Optional' }).locator('input');

const makeLdm = async (name) => {
  if (!(await models.isVisible())) {
    const make = page.getByRole('button', { name: /Make a logical model/ });
    await make.click();
    await models.waitFor();
  }
  await models.getByLabel('Name of the new logical model').fill(name);
  await models.getByRole('button', { name: 'Make a logical model' }).click();
  await models.locator('.logical-row').last().getByRole('button', { name: 'Open' }).click();
  await page.locator('.ldm-view .ldm-head').waitFor();
};

const derive = async () => {
  await part(/^Entities/).click();
  await page.getByRole('button', { name: /Derive from the ontology/ }).click();
  await transform.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.dialog.transform .proposal').length === 17);
  await transform.getByRole('button', { name: 'Apply the chosen' }).click();
  await transform.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 8);
};

const openImpact = async () => {
  await page.getByRole('button', { name: /^Impact/ }).click();
  await impact.waitFor();
};

const synchronize = async () => {
  await impact.getByRole('button', { name: /Synchronize/ }).click();
  await impact.locator('.proposal').first().waitFor();
};

const closeImpact = async () => {
  await impact.getByRole('button', { name: 'Close', exact: true }).click();
  await impact.waitFor({ state: 'detached' });
};

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- two logical models from one ontology
await view('LDM').click();
await makeLdm('Catalogue A');
await derive();
ok((await page.locator('.ldm-list li').count()) === 8, 'one logical model is derived from the ontology');

await page.getByRole('button', { name: 'Logical models…' }).click();
await models.waitFor();
await makeLdm('Catalogue B');
await page.getByLabel('Logical model', { exact: true }).waitFor();
await derive();
ok((await page.locator('.ldm-list li').count()) === 8, 'a second, from the same ontology');
await page.getByLabel('Logical model', { exact: true }).selectOption({ label: 'Catalogue A' });
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 8);

// One attribute is changed by hand: it is what synchronization must never move unasked.
await filmRow().click();
await releaseField().waitFor();
await optionalOfRelease().uncheck();
await page.waitForFunction(() => {
  const row = document.querySelector('input[aria-label="Name of the attribute Release date"]')?.closest('.ldm-attribute');
  const box = [...(row?.querySelectorAll('label.check') ?? [])].find((l) => l.textContent?.trim() === 'Optional');
  return box?.querySelector('input')?.checked === false;
});
ok((await optionalOfRelease().isChecked()) === false, 'Release date is made mandatory in Catalogue A by hand');

// ---------------------------------------------------------------- a version to compare with
await menu(/^Versions…/);
await versions.waitFor();
await versions.getByRole('button', { name: 'Save to My Models…' }).click();
await page.locator('.dialog.saveas input').fill('Traceable films');
await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
await menu(/^Versions…/);
await versions.getByLabel('Name of the version').fill('With Release date');
await versions.getByRole('button', { name: 'Save a version' }).click();
await versions.locator('.version', { hasText: 'With Release date' }).waitFor();
await versions.getByRole('button', { name: 'Close' }).click();

// ---------------------------------------------------------------- the ontology loses a datatype property
const ontologyBefore = await turtle();
await node('Release date : date').locator('.node-box').click();
await page.keyboard.press('Delete');
await page.waitForFunction(() => ![...document.querySelectorAll('.node')].some((n) => n.textContent?.includes('Release date')));
const ontologyAfterRemoval = await turtle();
ok(!ontologyAfterRemoval.includes(':ReleaseDate'), 'Release date is removed from the ontology');
ok(ontologyAfterRemoval !== ontologyBefore, 'and the ontology has moved');

// ---------------------------------------------------------------- Catalogue B: the untouched one
await view('LDM').click();
await page.getByLabel('Logical model', { exact: true }).selectOption({ label: 'Catalogue B' });
await part(/^Traceability/).click();
await trace.locator('.trace-mappings li').first().waitFor();
await page.waitForFunction(() => document.querySelector('.ldm-traceability .trace-summary')?.textContent?.includes('1 broken'));
ok((await trace.locator('.trace-mappings li').count()) === 17, 'every mapping is listed');
const brokenB = trace.locator('.trace-mappings li', { hasText: 'Release date' });
ok((await brokenB.count()) === 1 && (await brokenB.locator('.trace-dot.broken').count()) === 1, 'the attribute mapped from the removed property is broken');
ok(flat(await trace.locator('.trace-summary').innerText()).includes('1 broken'), 'and the summary says one broken');
ok(!flat(await brokenB.innerText()).includes('changed by you'), 'nothing in it was changed by the user');

const beforeJobs = await jobs();
await openImpact();
const removedB = impact.locator('.impact-group[data-kind="source-removed"]');
await removedB.waitFor();
await page.waitForFunction((n) => window.__impactJobs.length > n, beforeJobs);
ok(true, 'the impact report is worked out off the page, in a worker (NFR-19)');
ok((await removedB.locator('.impact-item').count()) === 1, 'exactly the attribute mapped from the removed property is listed');
ok(/Release date is gone from the ontology/.test(flat(await removedB.innerText())), 'and says which source is gone');
ok(flat(await impact.locator('.impact-compared').innerText()).includes('each mapping’s origin'), 'compared with each mapping’s origin');
ok((await impact.locator('.impact-item.customised').count()) === 0, 'none of it is about an element the user changed');
await page.screenshot({ path: shots + 'impact.png' });

await synchronize();
const removalB = impact.locator('.proposal-group[data-kind="remove"] .proposal');
ok((await removalB.count()) === 1, 'synchronization offers exactly one removal');
ok((await impact.locator('.proposal').count()) === 1, 'and nothing else');
ok(flat(await removalB.innerText()).includes('Remove Film.Release date'), 'the removal of the attribute: ' + (await removalB.locator('strong').first().innerText()));
ok(await removalB.locator('input[type="checkbox"]').isChecked(), 'the untouched element is chosen to begin with');
ok(!(await impact.getByRole('button', { name: 'Apply the chosen' }).isDisabled()), 'and can be applied');

await impact.getByRole('button', { name: 'Apply the chosen' }).click();
await page.waitForFunction(() => document.querySelector('.dialog.impact-dialog')?.textContent?.includes('Applied 1 proposal'));
ok((await impact.locator('.proposal').count()) === 0, 'applying takes the proposals away');
await closeImpact();
await part(/^Entities/).click();
await filmRow().click();
await page.waitForFunction(() => !document.querySelector('input[aria-label="Name of the attribute Release date"]'));
ok((await page.locator('.ldm-attribute').count()) === 1, 'the attribute made from it is gone from Catalogue B');
ok((await page.getByLabel('Name of the attribute Running time').count()) === 1, 'and the other attribute stays');

await page.getByRole('button', { name: 'Undo' }).click();
await releaseField().waitFor();
ok((await optionalOfRelease().isChecked()) === true, 'one undo brings it back, as it was');
const ontologyAfterApply = await turtle();
ok(ontologyAfterApply === ontologyAfterRemoval, 'the synchronization wrote nothing to the ontology');

// ---------------------------------------------------------------- Catalogue A: the changed one
await view('LDM').click();
await page.getByLabel('Logical model', { exact: true }).selectOption({ label: 'Catalogue A' });
await part(/^Traceability/).click();
await page.waitForFunction(() => document.querySelector('.ldm-traceability .trace-summary')?.textContent?.includes('1 broken'));
const brokenA = trace.locator('.trace-mappings li', { hasText: 'Release date' });
ok((await brokenA.locator('.trace-dot.broken').count()) === 1 && flat(await brokenA.innerText()).includes('changed by you'), 'in Catalogue A the same mapping is broken and marked as changed by you');

await openImpact();
await impact.locator('.impact-group[data-kind="source-removed"]').waitFor();
ok((await impact.locator('.impact-group[data-kind="source-removed"] .impact-item.customised').count()) === 1, 'the impact report says the element was changed by you');
ok(flat(await impact.locator('.impact-item.customised').innerText()).includes('You changed this element'), 'and marks it so');

// The same removal seen between two saved versions, with no synchronization for the past.
await impact.getByLabel('What to compare the ontology with').selectOption('versions');
await page.waitForFunction(() => document.querySelector('.dialog.impact-dialog .impact-compared')?.textContent?.includes('With Release date'));
ok(flat(await impact.locator('.impact-compared').innerText()).includes('the current model'), 'two saved versions can be compared, named: ' + flat(await impact.locator('.impact-compared').innerText()));
ok((await impact.locator('.impact-group[data-kind="source-removed"] .impact-item').count()) === 1, 'the removal between them is still exactly the one attribute');
ok((await impact.getByRole('button', { name: /Synchronize/ }).count()) === 0, 'and the past is not something to synchronize to');
await impact.getByLabel('What to compare the ontology with').selectOption('now');
await page.waitForFunction(() => !!document.querySelector('.dialog.impact-dialog .impact-sync-actions'));

await synchronize();
const removalA = impact.locator('.proposal-group[data-kind="remove"] .proposal');
ok((await removalA.count()) === 1 && (await removalA.locator('.tag').count()) >= 1, 'the changed attribute is offered, and marked');
ok(flat(await removalA.innerText()).includes('Not chosen to begin with'), 'with why it is not chosen');
ok((await removalA.locator('input[type="checkbox"]').isChecked()) === false, 'never chosen for the user');
ok(await impact.getByRole('button', { name: 'Apply the chosen' }).isDisabled(), 'nothing is chosen to apply');
ok(flat(await impact.locator('.dialog-actions').innerText()).includes('Nothing chosen'), 'and the dialog says so');
await closeImpact();
await part(/^Entities/).click();
await filmRow().click();
await releaseField().waitFor();
ok((await optionalOfRelease().isChecked()) === false, 'the changed attribute is exactly where the user left it');
await page.screenshot({ path: shots + 'traceability.png' });

// Turned down, it is not offered again while the ontology says what it says.
await part(/^Traceability/).click();
await openImpact();
await synchronize();
await impact.getByRole('button', { name: 'Turn this down' }).click();
await page.waitForFunction(() => document.querySelectorAll('.dialog.impact-dialog .proposal').length === 0);
ok(true, 'a proposal can be turned down');
await closeImpact();
await openImpact();
await impact.getByRole('button', { name: /Synchronize/ }).click();
await page.waitForFunction(() => document.querySelector('.dialog.impact-dialog')?.textContent?.includes('Nothing is offered'));
ok((await impact.locator('.proposal').count()) === 0, 'turned down, it is not offered again while the ontology says what it says');
const bringBack = impact.getByRole('button', { name: /Bring back the 1 proposal turned down before/ });
ok(await bringBack.isVisible(), 'and the dialog says how to bring it back');
await bringBack.click();
await page.getByRole('button', { name: /Synchronize/ }).click();
await impact.locator('.proposal').first().waitFor();
ok((await impact.locator('.proposal input[type="checkbox"]').isChecked()) === false, 'brought back, it is still not chosen for the user');

// Accepted only when the user chooses it, as one undoable change set.
await impact.locator('.proposal input[type="checkbox"]').check();
ok(!(await impact.getByRole('button', { name: 'Apply the chosen' }).isDisabled()), 'chosen by the user, it can be applied');
await impact.getByRole('button', { name: 'Apply the chosen' }).click();
await page.waitForFunction(() => document.querySelector('.dialog.impact-dialog')?.textContent?.includes('Applied 1 proposal'));
await closeImpact();
await part(/^Entities/).click();
await filmRow().click();
await page.waitForFunction(() => !document.querySelector('input[aria-label="Name of the attribute Release date"]'));
ok((await page.locator('.ldm-attribute').count()) === 1, 'accepting it removes the changed attribute');
await page.getByRole('button', { name: 'Undo' }).click();
await releaseField().waitFor();
ok((await optionalOfRelease().isChecked()) === false, 'and one undo brings it back, still changed by hand');

await page.screenshot({ path: shots + 'traceability.png' });
console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
