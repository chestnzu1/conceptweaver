// Measures how long the page's main thread is blocked while the app works on a large model:
// the longest task, from the browser's Long Tasks API, for opening the model, selecting a class,
// an edit, a reasoner run and a validation run. The Phase 1 target is under 100 ms for each.
//
//   node scripts/main-thread.mjs <model.json> [base URL]
//
// The model is a file the app opens; scripts/bench.mjs passes the 2,600-class stress model that
// src/model/bench.test.ts writes. Needs the built app served (default http://localhost:5181/).
// This is a measurement, not a check: it exits non-zero only when it could not measure.
import { chromium } from 'playwright-core';
import { globSync } from 'node:fs';
import path from 'node:path';

const [modelFile, base = 'http://localhost:5181/'] = process.argv.slice(2);
if (!modelFile) {
  console.error('Usage: node scripts/main-thread.mjs <model.json> [base URL]');
  process.exit(2);
}
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
// Every task over 50 ms, from the moment the page starts.
await page.addInitScript(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, end: e.startTime + e.duration });
  }).observe({ type: 'longtask', buffered: true });
});

const tab = (name) => page.locator('.header').getByRole('tab', { name }).click();
const side = page.locator('.term-list');
const runState = page.locator('.validation .run-state');
const button = (name) => page.locator('.validation .view-head').getByRole('button', { name, exact: true });
const settled = () =>
  // Until no long task has ended for 700 ms: what follows an action (a save of the working copy
  // 300 ms after an edit, a redraw) counts as part of it.
  page.waitForFunction(() => {
    const last = Math.max(0, ...window.__longTasks.map((t) => t.end));
    return performance.now() - last > 700;
  }, undefined, { timeout: 120_000, polling: 100 });

const rows = [];
/** Does `act`, waits for `done` and for the page to settle, and records the long tasks in between. */
const measure = async (label, act, done) => {
  await settled();
  const t0 = await page.evaluate(() => performance.now());
  await act();
  await done();
  const wall = (await page.evaluate(() => performance.now())) - t0;
  await settled();
  const tasks = await page.evaluate((t0) => window.__longTasks.filter((t) => t.end > t0).map((t) => t.end - Math.max(t.start, t0)), t0);
  rows.push({ label, longest: Math.max(0, ...tasks), count: tasks.length, blocking: tasks.reduce((s, d) => s + Math.max(0, d - 50), 0), wall });
};

await page.goto(base);
await page.waitForSelector('.node');

// ---- open the model
await measure(
  `open ${path.basename(modelFile)}`,
  () => page.locator('.header input[type=file]').setInputFiles(modelFile),
  () => side.locator('.list-count').filter({ hasText: /\d{3,}\s+classes/ }).waitFor({ timeout: 120_000 }),
);
const counted = (await side.locator('.list-count').innerText()).replace(/\s+/g, ' ').trim();

// ---- select a class, then rename it: the edit
const rowAt = side.locator('.tree-line button.label').nth(8);
await measure('select a class (sidebar)', () => rowAt.click(), () => page.locator('.inspector input').first().waitFor());
const name = page.locator('.inspector input').first();
const renamed = `Renamed ${Date.now()}`;
await measure(
  'edit: rename the class',
  async () => { await name.fill(renamed); await name.press('Enter'); },
  () => side.locator('.tree-line .name', { hasText: renamed }).first().waitFor(),
);

// ---- the Validation view: its first visit validates once; then a reasoner run and a full run
await tab('Validation');
await runState.filter({ hasText: /^Validated/ }).waitFor({ timeout: 300_000 });
const rerun = async (label, which) => {
  const before = await runState.innerText();
  // The run's time is shown to the second: a run in the same second would look like the last.
  await page.waitForTimeout(1100);
  await measure(label, () => button(which).click(), () => page.waitForFunction(([before]) => {
    const now = document.querySelector('.validation .run-state')?.textContent ?? '';
    return now.startsWith('Validated') && now !== before;
  }, [before], { timeout: 300_000, polling: 100 }));
};
await rerun('reasoner run (OWL checks, built-in reasoner)', 'OWL');
await rerun('validation run (all checks)', 'Run all checks');

const version = browser.version();
await browser.close();

const ms = (n) => `${n.toFixed(0)} ms`;
const width = Math.max(...rows.map((r) => r.label.length));
console.log(`Main thread, ${counted}, Chromium ${version}, ${new Date().toISOString()}`);
console.log(`${'operation'.padEnd(width)}  longest task  long tasks  blocking (>50 ms)  on screen after`);
for (const r of rows) console.log(`${r.label.padEnd(width)}  ${(r.count ? ms(r.longest) : '< 50 ms').padStart(12)}  ${String(r.count).padStart(10)}  ${ms(r.blocking).padStart(17)}  ${ms(r.wall).padStart(15)}`);
if (errors.length) console.log('page errors:', errors.slice(0, 3));
process.exit(errors.length ? 1 : 0);
