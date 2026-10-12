// Measures the built app against a few checkable UI rules, view by view and in both themes:
// text contrast (WCAG AA 4.5:1, 3:1 for large text), pointer target size (24 by 24 CSS px), text
// under 12px, and controls that stick out of the panel they belong to.
// Needs a server:  pnpm exec vite preview --port 5181   (or pass another base URL)
import { chromium } from 'playwright-core';
import { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });

const measure = () => {
  const lum = ([r, g, b]) => {
    const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  // Any CSS colour (rgb, color-mix, oklch) as [r, g, b, a], by letting the browser paint it.
  const parse = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3]));
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] === 1) break;
    }
    let bg = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    for (const layer of layers.reverse()) bg = over(layer, bg);
    return bg;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const up = el.parentElement;
    const upCls = up && typeof up.className === 'string' && up.className.trim() ? '.' + up.className.trim().split(/\s+/)[0] : (up?.tagName.toLowerCase() ?? '');
    return `${upCls} > ${el.tagName.toLowerCase()}${cls}`;
  };
  const out = { contrast: {}, small: {}, target: {}, overflow: {} };
  const add = (kind, key, detail) => ((out[kind][key] ??= { n: 0, detail }).n++);

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.nodeValue.trim() || !el || el.closest('svg') || !visible(el)) continue;
    const s = getComputedStyle(el);
    if (el.closest('[disabled], [aria-disabled="true"]') || s.opacity < 1) continue;
    const size = parseFloat(s.fontSize);
    const fg = parse(s.color);
    const bg = backdrop(el);
    const [l1, l2] = [lum(over(fg, bg)), lum(bg)];
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) add('contrast', name(el), `${ratio.toFixed(2)}:1 at ${size}px “${n.nodeValue.trim().slice(0, 24)}”`);
    if (size < 12) add('small', name(el), `${size}px “${n.nodeValue.trim().slice(0, 24)}”`);
  }
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], summary, [tabindex="0"]')) {
    if (!visible(el) || el.closest('svg') || el.disabled) continue;
    const r = el.getBoundingClientRect();
    // Inline links in a sentence are exempt from the target size rule.
    if (el.matches('button.link, a') && getComputedStyle(el).display.startsWith('inline')) continue;
    // A tick box in a label is hit through the label, and one alone in a table cell has the cell as its margin.
    if (el.matches('input[type="checkbox"], input[type="radio"]') && (el.closest('label') || el.parentElement?.tagName === 'TD')) continue;
    if (r.width < 23.5 || r.height < 23.5) add('target', name(el), `${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  for (const panel of document.querySelectorAll('.header, .sidebar, .stage, .inspector, .view-head')) {
    const p = panel.getBoundingClientRect();
    for (const el of panel.querySelectorAll('button, input, select, [role="tab"]')) {
      if (!visible(el) || el.closest('.table-wrap, .tree-wrap, .gov-detail, svg, table')) continue;
      const r = el.getBoundingClientRect();
      if (r.right > p.right + 1 || r.left < p.left - 1) add('overflow', name(el), `sticks out of .${panel.className.split(' ')[0]} by ${Math.round(Math.max(r.right - p.right, p.left - r.left))}px`);
    }
  }
  return out;
};

const totals = {};
const report = (label, found) => {
  for (const [kind, items] of Object.entries(found)) {
    const list = Object.entries(items).sort((a, b) => b[1].n - a[1].n);
    const n = list.reduce((sum, [, v]) => sum + v.n, 0);
    totals[kind] = (totals[kind] ?? 0) + n;
    if (n) console.log(`  ${label} · ${kind}: ${n}\n` + list.slice(0, 7).map(([k, v]) => `      ${String(v.n).padStart(3)} × ${k}   (${v.detail})`).join('\n'));
  }
};

for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }]) {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: size });
    await page.goto(base);
    await page.evaluate((t) => { localStorage.clear(); localStorage.setItem('conceptweaver:theme', t); }, theme);
    await page.reload();
    await page.waitForSelector('.node');
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) await page.locator('.header').getByRole('button', { name: /theme/i }).click();
    // Colours ease from one theme to the other; measure once they have arrived.
    await page.waitForTimeout(400);
    console.log(`\n=== ${size.width}×${size.height} ${await page.evaluate(() => document.documentElement.dataset.theme)}`);
    const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
    await page.locator('.node').first().locator('.node-box').click();
    report('Graph', await page.evaluate(measure));
    // The graph style editor, tab by tab, with a term selected so that every control is live.
    await page.locator('.subgraph').getByRole('button', { name: 'Style' }).click();
    for (const name of ['Nodes', 'Edges', 'Themes']) {
      await page.locator('.style-panel').getByRole('tab', { name }).click();
      report('Style · ' + name, await page.evaluate(measure));
    }
    await page.locator('.style-panel').getByRole('button', { name: 'Close the graph style panel' }).click();
    await tab('Entities');
    report('Entities', await page.evaluate(measure));
    await page.locator('.view').getByRole('tab', { name: 'Governance & Metadata' }).click();
    report('Governance', await page.evaluate(measure));
    await page.locator('.view').getByRole('tab', { name: /^Relationships/ }).click();
    report('Relationships', await page.evaluate(measure));
    await tab('Hierarchy');
    report('Hierarchy', await page.evaluate(measure));
    await tab('Validation');
    await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
    report('Validation', await page.evaluate(measure));
    await tab('Align');
    report('Align', await page.evaluate(measure));
    await tab('RDF');
    report('RDF', await page.evaluate(measure));
    await tab('SPARQL');
    report('SPARQL', await page.evaluate(measure));
    await tab('Vocabulary');
    report('Vocabulary', await page.evaluate(measure));
    await page.close();
  }
}
console.log('\nTOTALS', JSON.stringify(totals));
await browser.close();
process.exit(Object.values(totals).some((n) => n > 0) ? 1 : 0);
