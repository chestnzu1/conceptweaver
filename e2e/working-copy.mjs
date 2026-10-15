// Drives the built app in a headless browser to check the working copy: what is in the editor is
// kept in this browser (IndexedDB) as it is edited, with no limit but the browser's space, a
// working copy an earlier version kept in localStorage is moved over, and the browser is asked
// to keep it when space runs low.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const side = page.locator('.term-list');
const panel = page.locator('.inspector');
const toast = async () => flat(await page.locator('.toast').innerText({ timeout: 1500 }).catch(() => ''));
const count = () => side.locator('.list-count span').first().innerText().then(flat);
/** The working copy as it is kept in this browser, a moment after the last change. */
const workingCopy = async () => {
  await page.waitForTimeout(700);
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('conceptweaver');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('working')) return (db.close(), resolve(null));
          const g = db.transaction('working', 'readonly').objectStore('working').get('current');
          g.onsuccess = () => (db.close(), resolve(g.result ?? null));
          g.onerror = () => reject(g.error);
        };
      }),
  );
};
const rename = async (to) => {
  const name = panel.locator('input').first();
  await name.fill(to);
  await name.press('Enter');
};

await page.goto(base);
await page.waitForSelector('.node');

// ---------------------------------------------------------------- kept as it is edited, and there after a reload
await side.locator('.tree-line button.label').first().click();
await rename('Kept across a reload');
let copy = await workingCopy();
ok(copy?.model.terms.some((t) => t.name === 'Kept across a reload') && copy.doc.id === null && copy.doc.dirty === true, 'an edit is kept as the working copy in this browser, a moment after it is made');
ok((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('model')))).length === 0, 'and not in localStorage');
await page.reload();
await page.waitForSelector('.node');
ok((await side.locator('.tree-line .name', { hasText: /^Kept across a reload$/ }).count()) === 1, 'after a reload the edit is there');

// ---------------------------------------------------------------- a working copy an earlier version kept in localStorage
await page.evaluate(
  (model) =>
    new Promise((resolve, reject) => {
      localStorage.setItem('conceptweaver:model:v1', JSON.stringify({ ...model, name: 'Kept by an earlier version' }));
      localStorage.setItem('conceptweaver:doc', JSON.stringify({ id: null, dirty: true }));
      const r = indexedDB.open('conceptweaver');
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result;
        const t = db.transaction('working', 'readwrite');
        t.objectStore('working').delete('current');
        t.oncomplete = () => (db.close(), resolve(undefined));
      };
    }),
  copy.model,
);
await page.reload();
await page.waitForSelector('.node');
const modelName = () => page.locator('.header .model-name').evaluate((el) => (el instanceof HTMLInputElement ? el.value : el.textContent ?? '')).then(flat);
ok((await modelName()) === 'Kept by an earlier version', 'a working copy kept in localStorage by an earlier version is opened: ' + (await modelName()));
copy = await workingCopy();
ok(copy?.model.name === 'Kept by an earlier version' && (await page.evaluate(() => localStorage.getItem('conceptweaver:model:v1'))) === null, 'and moved over: it is kept in IndexedDB now, and taken out of localStorage');

// ---------------------------------------------------------------- a model larger than localStorage could ever hold
const N = 5200;
const words = 'A class of the generated model, with a definition long enough to make the whole of it larger than localStorage can hold. '.repeat(9);
const big = {
  name: 'Five thousand two hundred classes',
  baseIri: 'http://example.org/big#',
  terms: Array.from({ length: N }, (_, i) => ({ id: 'c' + i, name: 'Class ' + i, type: 'concept', description: words, x: (i % 80) * 160, y: Math.floor(i / 80) * 80 })),
  relations: Array.from({ length: N - 1 }, (_, k) => ({ id: 'r' + (k + 1), from: 'c' + (k + 1), to: 'c' + Math.floor((k + 1) / 10), kind: 'generalization' })),
};
const json = JSON.stringify(big);
const refused = await page.evaluate((text) => {
  try {
    localStorage.setItem('conceptweaver:probe', text);
    localStorage.removeItem('conceptweaver:probe');
    return false;
  } catch {
    return true;
  }
}, json);
ok(refused, `the model (${(json.length / 1e6).toFixed(1)} million characters) is more than localStorage takes`);
await page.locator('.header input[type=file]').first().setInputFiles({ name: 'big.json', mimeType: 'application/json', buffer: Buffer.from(json) });
await side.locator('.list-count').filter({ hasText: /5200 classes/ }).waitFor({ timeout: 120_000 });
await side.locator('.tree-line button.label').first().click();
await rename('Class 0, renamed');
copy = await workingCopy();
await page.waitForTimeout(1500);
ok(!/could not be kept/.test(await toast()), 'edited, it is kept without a warning: ' + ((await toast()) || 'nothing said'));
copy = await workingCopy();
ok(copy?.model.terms.length === N && copy.model.terms.some((t) => t.name === 'Class 0, renamed'), `the working copy has all ${N} classes and the edit`);
await page.reload();
await side.locator('.list-count').filter({ hasText: /5200 classes/ }).waitFor({ timeout: 120_000 });
ok((await count()) === '5200 classes' && (await side.locator('.tree-line .name', { hasText: /^Class 0, renamed$/ }).count()) === 1, 'after a reload it is all there: ' + (await count()));

// ---------------------------------------------------------------- what the site keeps, and whether the browser keeps it
// Once something has been edited in a session (and kept), the browser is asked to keep the site's data.
await side.locator('.tree-line button.label').first().click();
await rename('Class 0, renamed again');
await workingCopy();
await page.locator('.header').getByRole('button', { name: 'My Models', exact: true }).click();
const use = page.locator('.dialog.library .storage-use');
await use.waitFor({ timeout: 5000 }).catch(() => {});
ok(/^In this browser now: [\d.]+ (KB|MB|GB)/.test(flat(await use.innerText().catch(() => ''))), 'My Models says how much the site keeps in this browser: ' + flat(await use.innerText().catch(() => '')));
ok(/has agreed to keep it|has not agreed/.test(flat(await use.innerText().catch(() => ''))), 'and, having been asked after an edit, whether the browser keeps it when space runs low');
ok((await page.evaluate(() => navigator.storage.persisted())) === /has agreed/.test(flat(await use.innerText().catch(() => ''))), 'which is what the browser says');

console.log('console errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
