// Drives the built app in a headless browser to check quality rules of one's own, written as SPARQL
// (roadmap task 2.12, FR-M4-7): a SELECT returning ?entity and ?message appears in the results
// table with the severity the rule gives it, and can be switched off and on again.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const v = page.locator('.validation');
const sub = (name) => v.locator('.tabs.sub').getByRole('tab', { name }).click();
const settled = () => page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''), null, { timeout: 60000 });
const card = (title) => v.locator('.card', { has: page.locator('h3', { hasText: title }) });
const rows = () => v.locator('tr.result');
const rowTexts = async () => (await rows().allInnerTexts()).map(flat);
const customRows = async () => (await rowTexts()).filter((r) => r.includes('Classes without a definition'));
const rulesOn = async () => /(\d+) of (\d+) rules on/.exec(flat(await card('Ontology quality').innerText()))?.slice(1).map(Number);
const rule = () => v.locator('.custom-rule', { hasText: 'Classes without a definition' });

const query = `SELECT ?entity ?message
WHERE {
  ?entity a owl:Class .
  FILTER NOT EXISTS { ?entity skos:definition ?definition }
  BIND(CONCAT("No definition: ", STR(?entity)) AS ?message)
}`;

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

await tab(/^Validation/);
await settled();
const before = await rulesOn();

// ---------------------------------------------------------------- writing a rule
await sub('Quality rules');
ok((await v.locator('.custom-rules legend').innerText()) === 'Your own rules' && (await v.getByRole('button', { name: 'Add a rule' }).count()) === 1, 'the quality rules have a place for rules of one’s own');
await v.getByRole('button', { name: 'Add a rule' }).click();
const editor = v.locator('.custom-rule-editor');
ok((await editor.getByLabel('SPARQL query of the rule').inputValue()).startsWith('SELECT ?entity ?message'), 'a new rule starts from a query that returns ?entity and ?message');
ok((await editor.getByLabel('Severity of the rule').inputValue()) === 'warning', 'and a severity of its own, warning until changed');
await editor.getByLabel('Name of the rule').fill('Classes without a definition');
await editor.getByLabel('Severity of the rule').selectOption('error');
await editor.getByLabel('SPARQL query of the rule').fill(query);
ok((await editor.getByRole('button', { name: 'Add the rule' }).isEnabled()), 'the rule can be added once it has a query');
await editor.getByRole('button', { name: 'Add the rule' }).click();
ok((await rule().count()) === 1 && flat(await rule().innerText()).includes('error'), 'the rule is listed with its name and severity');
ok((await v.locator('.stale').count()) === 1, 'adding a rule marks the results stale');
await page.screenshot({ path: shots + 'custom-rules.png' });

// ---------------------------------------------------------------- it appears in the results
await v.getByRole('button', { name: 'Quality', exact: true }).click();
await settled();
await sub(/^Results/);
const found = await customRows();
ok(found.length > 0, `the rule’s ${found.length} rows are in the results table`);
ok(found.every((r) => r.startsWith('Error Quality')), 'each with the severity the rule gives it: ' + (found[0] ?? ''));
ok(found[0].includes('No definition: http://'), 'and with the message the query binds: ' + (found[0] ?? ''));
const after = await rulesOn();
ok(after[1] === before[1] + 1 && after[0] === before[0] + 1, `the summary counts it: ${before.join(' of ')} before, ${after.join(' of ')} after`);
await rows().filter({ hasText: 'Classes without a definition' }).first().click();
const detail = flat(await v.locator('tr.detail').innerText());
ok(detail.includes('A rule of your own, written as SPARQL over this ontology') && detail.includes('SELECT ?entity ?message'), 'the result explains that it is a rule of one’s own, and shows the query');
await page.screenshot({ path: shots + 'custom-rule-results.png' });

// ---------------------------------------------------------------- switched off, and on again
await v.locator('tr.detail').getByRole('button', { name: 'Switch this rule off' }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('.validation tr.result')].some((r) => r.textContent.includes('Classes without a definition')), null, { timeout: 60000 });
await settled();
ok((await customRows()).length === 0, 'switching the rule off removes its results after the rerun');
await sub('Quality rules');
ok(!(await rule().locator('input[type=checkbox]').isChecked()), 'and the rule is listed as switched off');
await rule().locator('input[type=checkbox]').check();
await sub(/^Results/);
await v.getByRole('button', { name: 'Quality', exact: true }).click();
await settled();
ok((await customRows()).length > 0, 'switching it on again brings them back');

// ---------------------------------------------------------------- it is part of the model
await sub('Quality rules');
await rule().getByRole('button', { name: 'Edit' }).click();
await v.locator('.custom-rule-editor').getByLabel('Name of the rule').fill('Classes with no definition at all');
await v.locator('.custom-rule-editor').getByRole('button', { name: 'Save the rule' }).click();
const renamed = v.locator('.custom-rule', { hasText: 'Classes with no definition at all' });
ok((await renamed.count()) === 1, 'a rule can be renamed and its query edited');
await renamed.getByRole('button', { name: 'Delete' }).click();
ok((await v.locator('.custom-rule').count()) === 0 && (await v.getByRole('button', { name: 'Add a rule' }).count()) === 1, 'and a rule can be deleted, leaving the built-in ones');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
