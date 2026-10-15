// Drives the built app in a headless browser to check that reasoning and validation are jobs:
// they run in workers, away from the page, a run can be stopped, and what they find is shown once
// they have found it, for the model as it is.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
// Every worker the page starts, and every task over 50 ms, from the moment the page starts.
await page.addInitScript(() => {
  window.__workers = 0;
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(...a) {
      super(...a);
      window.__workers++;
    }
  };
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, end: e.startTime + e.duration });
  }).observe({ type: 'longtask', buffered: true });
});
const workers = () => page.evaluate(() => window.__workers);
const tab = (name) => page.locator('.header').getByRole('tab', { name }).click();
const v = page.locator('.validation');
const runState = () => v.locator('.run-state').innerText().then(flat);
const toast = async () => flat(await page.locator('.toast').innerText({ timeout: 3000 }).catch(() => ''));
const side = page.locator('.term-list');
const panel = page.locator('.inspector');

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');
await page.locator('.header').getByRole('button', { name: 'File' }).click();
await page.getByText('Generate a stress-test model').click();
await side.locator('.list-count').filter({ hasText: /650 classes/ }).waitFor({ timeout: 60_000 });

// ---------------------------------------------------------------- the checks run in a worker
let before = await workers();
await tab(/^Validation/);
await page.waitForFunction(() => /^Validated /.test(document.querySelector('.validation .run-state')?.textContent ?? ''), undefined, { timeout: 60_000 });
ok((await workers()) > before, `the first visit validates once, in a worker (${(await workers()) - before} started)`);
const validated = await runState();

// ---------------------------------------------------------------- a run can be stopped
await page.waitForTimeout(1100);
await v.getByRole('button', { name: 'Run all checks', exact: true }).click();
const stop = v.getByRole('button', { name: 'Stop', exact: true });
await stop.waitFor({ timeout: 5000 });
ok(/Starting|Reasoning|Checking|Validating/.test(await runState()), 'while it runs it says what it is doing: ' + (await runState()));
await stop.click();
await page.waitForFunction(() => !document.querySelector('.validation .view-head .btn:not(.primary)')?.textContent?.includes('Stop'), undefined, { timeout: 5000 }).catch(() => {});
ok((await toast()).startsWith('Validation stopped.'), 'stopped, it says so: ' + (await toast()));
ok((await runState()) === validated && (await stop.count()) === 0, 'and the results shown are still those of the last run');

// ---------------------------------------------------------------- the count in the header comes from checks in the background
await page.locator('.header .badge').waitFor({ timeout: 30_000 }).catch(() => {});
const badge = await page.locator('.header .badge').innerText().catch(() => '');
ok(/^\d+$/.test(badge) && Number(badge) > 0, 'the header counts the problems the checks found by themselves: ' + badge);

// ---------------------------------------------------------------- an edit: the reasoner works away from the page
await tab('Graph');
await side.locator('.tree-line button.label').nth(8).click();
const name = panel.locator('input').first();
await name.waitFor();
await panel.locator('[data-section=inferred-superclasses]').waitFor({ timeout: 30_000 });
await page.waitForFunction(() => !/Working out what follows/.test(document.querySelector('[data-section=inferred-superclasses]')?.textContent ?? 'Working'), undefined, { timeout: 30_000 });
before = await workers();
const t0 = await page.evaluate(() => performance.now());
await name.fill('Renamed class');
await name.press('Enter');
const working = flat(await panel.locator('[data-section=inferred-superclasses]').innerText());
await page.waitForFunction(() => !/Working out what follows/.test(document.querySelector('[data-section=inferred-superclasses]')?.textContent ?? 'Working'), undefined, { timeout: 30_000 });
ok((await workers()) > before, 'after an edit the reasoner is asked again, in a worker');
ok(/Inferred superclasses/.test(working), 'the inferred superclasses are there throughout, saying they are worked out while they are');
await page.waitForTimeout(800);
const longest = await page.evaluate((t0) => Math.max(0, ...window.__longTasks.filter((t) => t.end > t0).map((t) => t.end - Math.max(t.start, t0))), t0);
console.log(`(the longest main-thread task of the edit and what followed it: ${longest.toFixed(0)} ms, on 650 classes)`);

console.log('console errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
