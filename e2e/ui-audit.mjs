// Measures the built app against a few checkable UI rules, view by view and in both themes:
// text contrast (WCAG AA 4.5:1, 3:1 for large text), pointer target size (24 by 24 CSS px), text
// under 12px, and controls that stick out of the panel they belong to (a dialog being a panel of its own).
// Needs a server:  pnpm exec vite preview --port 5181   (or pass another base URL)
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
// A shape set and a data graph to validate it against, for the screens of SHACL findings.
const files = fs.mkdtempSync('/tmp/cw-ui-audit-');
fs.writeFileSync(`${files}/shapes.ttl`, '@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix : <http://example.org/film-knowledge-graph#> .\n:FilmShape a sh:NodeShape ; sh:targetClass :Film ;\n  sh:property [ sh:path :releaseDate ; sh:minCount 1 ] .\n');
fs.writeFileSync(`${files}/films.ttl`, '@prefix : <http://example.org/film-knowledge-graph#> .\n@prefix d: <http://data.example/> .\nd:f1 a :Film .\nd:f2 a :Film .\n');

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
    // Text that is not drawn has no contrast to measure: the marks behind a text box repeat its text unseen, to lie under the same letters.
    if (parse(s.color)[3] === 0 && el.closest('[aria-hidden="true"]')) continue;
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
  // A dialog is a panel of its own, wherever it sits in the page: what is in it belongs to it, not to the panel it opened from.
  for (const panel of document.querySelectorAll('.header, .sidebar, .stage, .inspector, .view-head, .dialog')) {
    const p = panel.getBoundingClientRect();
    const own = panel.matches('.dialog') ? panel : null;
    for (const el of panel.querySelectorAll('button, input, select, [role="tab"]')) {
      if (!visible(el) || el.closest('.table-wrap, .tree-wrap, .gov-detail, svg, table') || el.closest('.dialog') !== own) continue;
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
    page.on('dialog', (d) => d.accept());
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
    // A relationship selected: its two ends to take hold of, and its connection points in the panel.
    // Then one end held over a term that cannot take it, with the reason beside the pointer.
    await page.locator('.edge.association .edge-line').first().dispatchEvent('pointerdown', { button: 0 });
    await page.waitForSelector('.end-handle');
    report('Graph · a relationship selected', await page.evaluate(measure));
    {
      const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const from = mid(await page.locator('.end-handle[data-end="to"] .end-dot').boundingBox());
      const to = mid(await page.locator('.node.instance .node-box').first().boundingBox());
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await page.locator('.reconnect-why.refused').waitFor();
      report('Graph · an end held over a term that cannot take it', await page.evaluate(measure));
      await page.keyboard.press('Escape');
      await page.mouse.up();
    }
    await page.locator('.node').first().locator('.node-box').click();
    // The graph style editor, tab by tab, with a term selected so that every control is live.
    await page.locator('.subgraph').getByRole('button', { name: 'Style' }).click();
    for (const name of ['Nodes', 'Edges', 'Themes']) {
      await page.locator('.style-panel').getByRole('tab', { name }).click();
      report('Style · ' + name, await page.evaluate(measure));
    }
    await page.locator('.style-panel').getByRole('button', { name: 'Close the graph style panel' }).click();
    // The layout options, for a layout with every kind of setting between them.
    await page.locator('.subgraph').getByRole('button', { name: 'Layout options' }).click();
    for (const kind of ['orthogonal', 'radial', 'force', 'manual']) {
      await page.getByLabel('Graph layout').selectOption(kind);
      await page.waitForTimeout(500);
      report('Layout · ' + kind, await page.evaluate(measure));
    }
    await page.locator('.subgraph').getByRole('button', { name: 'Hide layout options' }).click();
    // The dialog a new model starts with.
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: /^New model/ }).click();
    report('New model', await page.evaluate(measure));
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    // Opening an ontology: from a URL, with what went wrong said under the address, and the message that stays when a file cannot be read.
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Open from a URL/ }).click();
    await page.getByRole('dialog').getByLabel('Ontology URL').fill('pizza.owl');
    await page.getByRole('dialog').getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    report('Open from a URL', await page.evaluate(measure));
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.locator('.header input[type=file]').setInputFiles({ name: 'cut-short.owl', mimeType: 'application/rdf+xml', buffer: Buffer.from('<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><x:y') });
    await page.getByRole('alertdialog').waitFor();
    report('A file that cannot be opened', await page.evaluate(measure));
    await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
    await tab('Entities');
    report('Entities', await page.evaluate(measure));
    await page.locator('.view').getByRole('tab', { name: 'Governance & Metadata' }).click();
    report('Governance', await page.evaluate(measure));
    await page.locator('.view').getByRole('tab', { name: /^Relationships/ }).click();
    report('Relationships', await page.evaluate(measure));
    // The search, the order and the filters of the Entities tables: what was found marked, the filters open with some on, and nothing found.
    const entities = page.locator('.view');
    const answered = () => page.waitForFunction(() => { const c = document.querySelector('.view .et-count'); return c && !c.classList.contains('pending') && document.querySelector('.view .table-wrap')?.getAttribute('aria-busy') !== 'true'; });
    await entities.getByRole('tab', { name: /^Classes/ }).click();
    await entities.getByRole('searchbox').fill('film');
    await entities.getByRole('button', { name: /^Filters/ }).click();
    await entities.locator('.et-filters').getByRole('button', { name: /^Leaf/ }).click();
    await entities.locator('thead').getByRole('button', { name: 'Name', exact: true }).click();
    await page.waitForTimeout(250);
    await answered();
    report('Entities · search, sort, filters', await page.evaluate(measure));
    await entities.getByRole('searchbox').fill('zzz');
    await page.waitForTimeout(250);
    await answered();
    report('Entities · nothing found', await page.evaluate(measure));
    await entities.getByRole('searchbox').fill('');
    await entities.locator('.et-active').getByRole('button', { name: 'Clear all filters' }).click();
    await entities.getByRole('tab', { name: /^Individuals/ }).click();
    await answered();
    await entities.locator('.et-filters').getByRole('button', { name: 'Choose an entity for the filter asserted class' }).click();
    await entities.locator('.et-filters .subgraph-found button').first().waitFor();
    report('Entities · choosing a class to filter by', await page.evaluate(measure));
    await page.keyboard.press('Escape');
    await entities.getByRole('button', { name: /^Filters/ }).click();
    // The Structure Explorer: its hierarchy with a class in focus and one searched for, and its other two modes.
    await tab('Structure');
    const structure = page.locator('.view.structure');
    await structure.locator('.tree-name', { hasText: /^Actor$/ }).click();
    report('Structure', await page.evaluate(measure));
    await structure.getByLabel('Search the hierarchy').fill('doc');
    await page.waitForFunction(() => document.querySelectorAll('.view.structure .tree-name.match').length === 1);
    report('Structure · search', await page.evaluate(measure));
    await structure.getByLabel('Search the hierarchy').fill('');
    // The inferred hierarchy: of the fast reasoner, with what it left out spelled out, and of a reasoner that has no answer.
    await structure.locator('.st-which').getByRole('button', { name: 'Inferred', exact: true }).click();
    await structure.locator('.st-reasoner').waitFor();
    await structure.locator('.st-prov').getByRole('button', { name: 'why' }).click();
    await structure.locator('.tree').focus();
    await page.keyboard.press('ArrowDown');
    report('Structure · inferred', await page.evaluate(measure));
    await structure.getByLabel('Reasoner').selectOption({ label: 'Advanced reasoner (OWL 2 DL)' });
    await structure.locator('.st-prov:not(:empty)').waitFor();
    await page.waitForFunction(() => !document.querySelector('.view.structure .st-reasoner select')?.disabled);
    report('Structure · inferred, OWL 2 DL', await page.evaluate(measure));
    await structure.getByLabel('Reasoner').selectOption({ label: 'Fast reasoner (RDFS / partial OWL RL)' });
    await page.waitForFunction(() => !document.querySelector('.view.structure .st-reasoner select')?.disabled);
    await structure.locator('.st-which').getByRole('button', { name: 'Asserted', exact: true }).click();
    for (const name of ['Compare', 'Analyze']) {
      await structure.getByRole('tab', { name }).click();
      report('Structure · ' + name, await page.evaluate(measure));
    }
    // Two classes side by side, with a search open, and then compared with an explanation shown.
    await structure.getByRole('tab', { name: 'Compare' }).click();
    const slot = (n) => structure.locator('.st-slot').nth(n);
    await slot(0).getByRole('combobox').fill('a');
    await slot(0).locator('.subgraph-found button').first().waitFor();
    report('Structure · Compare, choosing', await page.evaluate(measure));
    await slot(0).getByRole('combobox').fill('Documentary');
    await slot(0).locator('.subgraph-found button', { hasText: /^Documentary/ }).click();
    await slot(1).getByRole('combobox').fill('Film');
    await slot(1).locator('.subgraph-found button', { hasText: /^Film/ }).first().click();
    await structure.locator('.st-compared').waitFor();
    await structure.locator('.st-relation').getByRole('button', { name: 'View semantic explanation' }).click();
    await structure.locator('.st-why ol').waitFor();
    report('Structure · Compare, compared', await page.evaluate(measure));
    // The hierarchy in numbers, with the classes behind one of them listed, for both hierarchies.
    await structure.getByRole('tab', { name: 'Analyze' }).click();
    await structure.locator('.st-tiles').waitFor();
    await structure.locator('[data-metric="leaves"] button').click();
    await structure.locator('.st-member-list li').first().waitFor();
    report('Structure · Analyze, listing', await page.evaluate(measure));
    await structure.locator('.st-dash').evaluate((el) => (el.scrollTop = el.scrollHeight));
    report('Structure · Analyze, findings', await page.evaluate(measure));
    await structure.locator('.st-which').getByRole('button', { name: 'Inferred', exact: true }).click();
    await structure.locator('.st-prov-line').waitFor();
    report('Structure · Analyze, inferred', await page.evaluate(measure));
    await structure.locator('.st-which').getByRole('button', { name: 'Asserted', exact: true }).click();
    await structure.getByRole('tab', { name: 'Explore' }).click();
    // The Shapes view: with no shapes, then a set with a shape whose property shape and sh:or are
    // open in place, with a path that does not read. The set goes again, so the views after are as they were.
    await tab('Shapes');
    const shapes = page.locator('.view.shapes-view');
    report('Shapes · none yet', await page.evaluate(measure));
    await shapes.getByRole('button', { name: 'New shape set' }).click();
    await shapes.getByLabel('Shape set name').fill('Catalogue');
    await shapes.getByLabel('Shape set name').press('Enter');
    await shapes.getByRole('button', { name: 'New shape', exact: true }).click();
    const form = shapes.locator('.shape-editor .shape-form').first();
    await shapes.locator('.add-property .chip-add').first().click();
    await shapes.locator('.add-property input[type=search]').first().fill('Release');
    await shapes.locator('.add-property .subgraph-found button').first().dispatchEvent('pointerdown');
    const property = form.locator('.param-shape.property .shape-form.nested').first();
    await property.locator(':scope > .row select').first().selectOption({ label: 'Min count (sh:minCount)' });
    await form.locator(':scope > .row select').first().selectOption({ label: 'Or (sh:or)' });
    await property.getByLabel('Path').fill(':releaseDate / (');
    await property.getByLabel('Path').press('Enter');
    await property.locator('[data-param=path] [role=alert]').waitFor();
    report('Shapes · a shape, open in place', await page.evaluate(measure));
    // Shapes proposed from the ontology, a few chosen, and a shape accepted from them with the axiom it came from.
    await shapes.getByRole('button', { name: 'Propose from the ontology…' }).click();
    const proposals = page.locator('.dialog.proposals');
    await proposals.locator('.proposal').first().waitFor();
    for (const n of [0, 1]) await proposals.locator('.proposal').nth(n).getByRole('checkbox').check();
    report('Shapes · proposed from the ontology', await page.evaluate(measure));
    await proposals.getByRole('button', { name: 'Add 2 shapes' }).click();
    await proposals.waitFor({ state: 'detached' });
    await shapes.locator('.shape-list li button', { hasText: '(from the ontology)' }).first().click();
    await shapes.locator('.shape-origin').first().waitFor();
    report('Shapes · accepted from the ontology', await page.evaluate(measure));
    await shapes.getByRole('button', { name: 'Delete set' }).click();
    await tab('Validation');
    await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? ''));
    report('Validation', await page.evaluate(measure));
    // The same view with the OWL 2 DL reasoner chosen, and its service not there to answer.
    // Choosing it asks it at once; whether its service is there to answer or not, the card is measured as it then is.
    await page.locator('.owl-card').getByRole('radio', { name: /^Advanced reasoner/ }).check();
    await page.waitForFunction(() => /Not running|is running/.test(document.querySelector('.owl-card .health')?.textContent ?? ''));
    await page.waitForFunction(() => document.querySelector('.owl-card .reasoned')?.getAttribute('data-engine') === 'dl' && !document.querySelector('.owl-card fieldset')?.disabled);
    report('Validation · OWL 2 DL', await page.evaluate(measure));
    await page.locator('.owl-card').getByRole('radio', { name: /^Fast reasoner/ }).check();
    // A shape set and a data graph chosen, the data graphs listed, and a SHACL finding opened at the constraint it failed.
    // Both go again after, so the views after are as they were.
    await tab('Shapes');
    await shapes.getByRole('button', { name: 'New shape set' }).click();
    await shapes.locator('input[type=file]').first().setInputFiles(`${files}/shapes.ttl`);
    await shapes.locator('.shape-list li').first().waitFor();
    await tab('Validation');
    const validation = page.locator('.validation');
    await validation.locator(':scope > input[type=file]').setInputFiles(`${files}/films.ttl`);
    await page.waitForFunction(() => document.querySelector('[aria-label="Data to validate"]')?.value !== 'model');
    await validation.getByLabel('Shapes to validate with').selectOption({ index: 1 });
    await validation.getByRole('button', { name: 'SHACL', exact: true }).click();
    await page.waitForFunction(() => /^Validated /.test(document.querySelector('.run-state')?.textContent ?? '') && !document.querySelector('.validation .stale'));
    report('Validation · a data graph and a shape set', await page.evaluate(measure));
    await validation.locator('.tabs.sub').getByRole('tab', { name: /^Data graphs/ }).click();
    report('Validation · Data graphs', await page.evaluate(measure));
    await validation.locator('.tabs.sub').getByRole('tab', { name: /^Results/ }).click();
    await validation.locator('tr.result', { has: page.locator('.cat.shacl') }).first().click();
    await validation.getByRole('button', { name: 'Open the shape at this constraint' }).click();
    await shapes.locator('.shape-failed').waitFor();
    report('Shapes · opened from a finding', await page.evaluate(measure));
    await shapes.getByRole('button', { name: 'Delete set' }).click();
    await tab('Validation');
    await validation.locator('.tabs.sub').getByRole('tab', { name: /^Data graphs/ }).click();
    await validation.locator('.data-graphs').getByRole('button', { name: 'Delete' }).click();
    await validation.locator('.tabs.sub').getByRole('tab', { name: /^Results/ }).click();
    await tab('Align');
    report('Align', await page.evaluate(measure));
    await tab('RDF');
    report('RDF', await page.evaluate(measure));
    await tab('SPARQL');
    report('SPARQL', await page.evaluate(measure));
    await tab('Vocabulary');
    report('Vocabulary', await page.evaluate(measure));
    // The editors of an enumeration class and of an enumerated datatype, each with something in it.
    await tab('Graph');
    const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name) }) }).first();
    const inspector = page.locator('.inspector');
    await node('Genre').locator('.node-box').click();
    const definition = inspector.locator('[data-section="class-definition"]');
    await definition.getByLabel('Class definition').selectOption('oneOf');
    for (const name of ['Drama', 'Comedy']) {
      await definition.locator('.chip-add').click();
      await definition.locator('input[type=search]').fill(name);
      await definition.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
    }
    report('Enumeration class', await page.evaluate(measure));
    await node('Running time').locator('.node-box').click();
    await inspector.getByLabel('Datatype', { exact: true }).selectOption({ label: 'New enumerated datatype…' });
    const datatype = inspector.locator('.enum-datatype');
    for (const value of ['short', 'feature']) {
      await datatype.getByLabel('New value', { exact: true }).fill(value);
      await datatype.getByRole('button', { name: 'Add value' }).click();
    }
    await datatype.getByLabel('New value', { exact: true }).fill('short');
    await datatype.getByRole('button', { name: 'Add value' }).click();
    report('Enumerated datatype', await page.evaluate(measure));
    // The class expression editor: a definition with a name that is not there, then written out and
    // read in words, the same as blocks, and the class it makes a defined class.
    await node('Documentary').locator('.node-box').click();
    await inspector.locator('[data-section="class-expressions"]').getByRole('button', { name: 'Add a class axiom' }).click();
    const xe = page.locator('.xe-dialog');
    await xe.getByLabel(/^Equivalent To/).check();
    await xe.getByRole('tab', { name: 'Manchester syntax' }).click();
    await xe.locator('.cm-content').click();
    await page.keyboard.type('Film and (wins some Nobody');
    await xe.locator('.xe-text small.bad').waitFor();
    report('Class expression · an error in the text', await page.evaluate(measure));
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Film and (wins some Award');
    await xe.locator('.xe-words').waitFor();
    report('Class expression · written, and in words', await page.evaluate(measure));
    await xe.getByRole('tab', { name: 'Blocks' }).click();
    report('Class expression · as blocks', await page.evaluate(measure));
    await xe.getByRole('button', { name: 'Add the axiom' }).click();
    report('Class expression · a defined class', await page.evaluate(measure));
    // Versions: asked to be in My Models first, then saved, listed and compared with the model now.
    const versions = page.locator('.dialog.versions');
    const openVersions = async () => {
      await page.locator('.header').getByRole('button', { name: /^File/ }).click();
      await page.getByRole('menuitem', { name: /^Versions…/ }).click();
      await versions.waitFor();
    };
    await openVersions();
    report('Versions · not in My Models', await page.evaluate(measure));
    await versions.getByRole('button', { name: 'Save to My Models…' }).click();
    await page.locator('.dialog.saveas input').fill('Audit');
    await page.locator('.dialog.saveas').getByRole('button', { name: /^Save/ }).click();
    await page.waitForFunction(() => document.querySelector('.header .save-state')?.textContent === 'Saved');
    await openVersions();
    await versions.getByLabel('Name of the version').fill('Before the audit');
    await versions.getByRole('button', { name: 'Save a version' }).click();
    await versions.locator('.version').waitFor();
    await versions.getByRole('button', { name: 'Compare with now' }).click();
    await versions.locator('.difference').waitFor();
    report('Versions · compared with now', await page.evaluate(measure));
    await versions.getByRole('button', { name: 'Close' }).click();
    // The sidebar folded away to its strip, with and without a search on.
    await page.locator('.term-list').getByLabel('Search terms').fill('film');
    await page.locator('.term-list').getByRole('button', { name: 'Hide the sidebar' }).click();
    report('Sidebar folded', await page.evaluate(measure));
    await page.close();
  }
}
console.log('\nTOTALS', JSON.stringify(totals));
await browser.close();
fs.rmSync(files, { recursive: true, force: true });
process.exit(Object.values(totals).some((n) => n > 0) ? 1 : 0);
