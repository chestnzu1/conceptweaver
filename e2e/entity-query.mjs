// Drives the built app in a headless browser to check the search, the sorting and the filters of
// the Entities page.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import { globSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const tab = (name) => page.locator('.header').getByRole('tab', { name, exact: name === 'RDF' }).click();
const turtle = async () => { await tab('RDF'); const ttl = await page.locator('.rdf-code').innerText(); await tab('Entities'); return ttl; };
const file = async (item) => { await page.locator('.header').getByRole('button', { name: /File/ }).click(); await page.getByRole('menuitem', { name: item }).click(); await page.waitForSelector('.node', { state: 'attached' }); await page.waitForTimeout(500); };
const view = page.locator('.view');
const panel = page.locator('.inspector');
const side = page.locator('.term-list');
const section = async (name) => { await view.getByRole('tab', { name: new RegExp('^' + name) }).click(); await settle(); };
const search = view.getByRole('searchbox');
const sortBy = view.locator('.et-sort select');
const direction = view.locator('.et-dir');
const filtersButton = view.getByRole('button', { name: /^Filters/ });
const filters = view.locator('.et-filters');
const openFilters = async () => { if ((await filtersButton.getAttribute('aria-expanded')) !== 'true') await filtersButton.click(); };
const active = view.locator('.et-active');
const count = async () => flat(await view.locator('.et-count').innerText());
const rows = view.locator('tbody tr');
/** Waits until the list on show is the answer to what is asked now. */
const settle = async () => {
  await page.waitForTimeout(60);
  await page.waitForFunction(() => {
    const c = document.querySelector('.view .et-count');
    return !c || (!c.classList.contains('pending') && c.textContent !== '' && document.querySelector('.view .table-wrap')?.getAttribute('aria-busy') !== 'true');
  });
};
const find = async (text) => { await search.fill(text); await settle(); };
/** What each row shows, read off the page: the name, the IRI as written, and the cells by their heading. */
const table = () => view.locator('table').evaluate((t) => {
  const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  return [...t.querySelectorAll('tbody tr')].map((tr) => {
    const cells = [...tr.children];
    const cell = (h) => cells[heads.indexOf(h)];
    const text = (h) => { const c = cell(h); if (!c) return ''; const box = c.querySelector('input:not([type=checkbox]), select'); return (box ? (box.tagName === 'SELECT' ? box.selectedOptions[0]?.textContent ?? '' : box.value) : c.textContent).trim(); };
    return {
      name: (tr.querySelector('input[aria-label="Name"], input[aria-label="Property name"]') ?? {}).value ?? '',
      iri: (tr.querySelector('.iri-cell') ?? {}).textContent?.trim() ?? '',
      fullIri: (tr.querySelector('.iri-cell') ?? {}).title ?? '',
      description: text('Description'),
      synonyms: text('Synonyms'),
      supers: [...(cell('Asserted Superclasses') ?? cell('Type') ?? document.createElement('i')).querySelectorAll('.chip-x')].map((c) => c.textContent.replace('×', '').trim()),
      restrictions: (cell('Asserted Restrictions')?.textContent ?? '').trim(),
      inferred: (cell('Inferred Restrictions')?.textContent ?? '').trim(),
      relations: Number((cell('Relations') ?? cell('Uses'))?.textContent ?? 0),
      from: text('From'), label: text('Property / label'), to: text('To'), kind: text('Kind'),
      range: text('Range (datatype)'), characteristics: text('Characteristics'), inverse: text('Inverse of'), domain: (cell('Domain')?.textContent ?? '').trim(),
      functional: !!cell('Functional')?.querySelector('input:checked'),
      selected: tr.classList.contains('sel'), pinned: tr.classList.contains('pinned'),
      marks: [...tr.querySelectorAll('mark')].map((m) => m.textContent),
    };
  });
});
const names = async () => (await table()).map((r) => r.name);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Whether texts are in order as people read them, with whatever has none after everything that has. */
const inOrder = (texts) => texts.every((x, i) => i === 0 || (texts[i - 1] !== '' && (x === '' || collator.compare(texts[i - 1], x) <= 0)) || (texts[i - 1] === '' && x === ''));
const heading = (name) => view.locator('thead').getByRole('button', { name, exact: true });
const ariaSort = (name) => view.locator('thead th', { has: page.getByRole('button', { name, exact: true }) }).getAttribute('aria-sort');
const option = (name) => filters.getByRole('button', { name: new RegExp('^' + name + '( \\d+)?$') });
const toggle = async (name) => { await option(name).click(); await settle(); };
/** Chooses an entity for a filter by typing into its search and taking the first that is offered. */
const choose = async (filter, text) => {
  await filters.getByRole('button', { name: `Choose an entity for the filter ${filter.toLowerCase()}` }).click();
  await filters.getByRole('combobox').fill(text);
  await filters.locator('.subgraph-found button').first().waitFor();
  const offered = (await filters.locator('.subgraph-found button').allInnerTexts()).map(flat);
  await filters.locator('.subgraph-found button').first().dispatchEvent('pointerdown');
  await settle();
  return offered;
};

await page.goto(base);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.waitForSelector('.node');
await file(/^Load the large ontology example/);
await tab('Entities');
await settle();
const before = await turtle();
await settle();

// ---------------------------------------------------------------- the bar
ok((await view.locator('.entity-tools').count()) === 1 && (await search.getAttribute('placeholder')) === 'Search classes…' && (await sortBy.locator('option').allInnerTexts()).join('|') === 'Model order|Name|IRI|Asserted superclasses|Subclasses|Asserted restrictions|Relationships', 'under the tabs is a bar with a search, an order and filters for the classes: ' + (await sortBy.locator('option').allInnerTexts()).join('|'));
const all = await table();
ok((await count()) === `${all.length} classes` && all.length === 84 && (await filters.count()) === 0 && (await active.count()) === 0, `it says how many there are (${await count()}), with the filters folded away`);
const order = await page.evaluate(() => { const bar = document.querySelector('.entity-tools').getBoundingClientRect(); const tabs = document.querySelector('.view-head').getBoundingClientRect(); const table = document.querySelector('.view .table-wrap').getBoundingClientRect(); return tabs.bottom <= bar.top + 1 && bar.bottom <= table.top + 1; });
ok(order, 'the bar is directly below the tabs and above the table');
await section('Governance');
ok((await view.locator('.entity-tools').count()) === 0, 'the governance tab, which is no list of entities, has none');
await section('Classes');

// ---------------------------------------------------------------- search
const has = (r, q) => [r.name, r.description, r.synonyms, r.iri].some((t) => t.toLowerCase().includes(q));
await find('course');
let found = await table();
const expected = all.filter((r) => has(r, 'course')).map((r) => r.name);
ok(same(found.map((r) => r.name), expected) && expected.length > 3, `typing narrows the table as it is typed, to the classes with the text in their name, IRI, definition or synonyms (${expected.length})`);
ok((await count()) === `${expected.length} of 84 classes`, 'the bar says how many match: ' + (await count()));
ok(found.every((r) => r.marks.length > 0 && r.marks.every((m) => m.toLowerCase() === 'course')), 'what was found is marked in each row: ' + [...new Set(found.flatMap((r) => r.marks))].join(', '));
// The marks behind a text box lie exactly under the letters they mark.
const aligned = await rows.first().evaluate((tr) => {
  const input = tr.querySelector('input[aria-label="Name"]');
  const mark = tr.querySelector('.hl-back mark');
  const at = input.value.toLowerCase().indexOf(mark.textContent.toLowerCase());
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(input).font}`;
  probe.textContent = input.value.slice(0, at);
  document.body.append(probe);
  const before = probe.getBoundingClientRect().width;
  probe.remove();
  const left = input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft) + parseFloat(getComputedStyle(input).borderLeftWidth) + before;
  return Math.abs(mark.getBoundingClientRect().left - left);
});
ok(aligned < 1.5, `the mark in a name lies under the letters it marks (off by ${aligned.toFixed(2)} px)`);
await find('COUR');
ok(same(await names(), all.filter((r) => has(r, 'cour')).map((r) => r.name)), 'part of a word is enough, whatever the case');
await find(':LectureCourse');
ok(same(await names(), ['Lecture course']) && (await table())[0].marks.join('') === ':LectureCourse', 'a class is found by its prefixed IRI, marked across its prefix and its local name');
await find('university-ontology#LectureC');
found = await table();
ok(same(found.map((r) => r.name), ['Lecture course']) && flat(await rows.first().locator('.hl-note').innerText()).startsWith('IRI http://example.org/university-ontology#LectureCourse') && same(found[0].marks, ['university-ontology#LectureC']), 'and by its full IRI, which is shown with the find marked where the row has only the prefixed one');
await find('org');
ok(same(await names(), all.filter((r) => has(r, 'org')).map((r) => r.name)) && (await names()).length < 10, 'a plain word is not looked for in the full IRI, where every class under example.org would have it: ' + (await names()).join(', '));
await find('lecture cour');
ok(same(await names(), ['Lecture course']), 'every word has to be found, each wherever it is');
// A synonym is another label (skos:altLabel).
await find('');
const course = rows.filter({ has: page.locator('input[aria-label="Name"][value="Course"]') });
await course.getByLabel('Synonyms').fill('Module, Lesson series');
await course.getByLabel('Synonyms').press('Enter');
await find('lesson');
found = await table();
ok(same(found.map((r) => r.name), ['Course']) && same(found[0].marks, ['Lesson']), 'a class is found by another label of it, marked where that label is shown');
// A label in another language is an annotation: the row has no place for it, so it is shown where it was found.
await find(':LectureCourse');
await rows.first().locator('td').nth(1).click();
await panel.getByRole('button', { name: 'Add field' }).click();
await panel.getByLabel('Property', { exact: true }).fill('rdfs:label');
await panel.getByLabel('Value', { exact: true }).fill('Vorlesung');
await panel.getByLabel('Language', { exact: true }).fill('de');
await panel.getByRole('button', { name: 'Confirm' }).click();
await find('vorles');
found = await table();
ok(same(found.map((r) => r.name), ['Lecture course']) && flat(await rows.first().locator('.hl-note').innerText()) === 'rdfs:label Vorlesung' && same(found[0].marks, ['Vorles']), 'and by a label in another language (rdfs:label), which is shown with the find marked, the row having no place for it');
// From here on nothing is edited for a while: what the ontology says now is what it has to say after all the searching, sorting and filtering.
const baseline = await turtle();
await settle();
ok(baseline !== before && baseline.includes('skos:altLabel "Module"') && baseline.includes('"Vorlesung"@de'), 'the two labels just given are in the ontology');
await find('zzz');
ok((await rows.count()) === 0 && flat(await view.locator('.empty-result').innerText()).startsWith('No class matches “zzz”. There are 84 classes in all.') && (await count()) === '0 of 84 classes', 'a search that finds nothing says so, and how many there are: ' + flat(await view.locator('.empty-result strong').innerText()));
await view.locator('.empty-result').getByRole('button', { name: 'Clear the search' }).click();
await settle();
ok((await search.inputValue()) === '' && (await rows.count()) === 84, 'and offers the way back');
await find('course');
await view.getByRole('button', { name: 'Clear the search' }).click();
await settle();
ok((await search.inputValue()) === '' && (await rows.count()) === 84 && (await view.getByRole('button', { name: 'Clear the search' }).count()) === 0, 'the × in the search clears it');
await search.fill('exam');
await search.press('Escape');
await settle();
ok((await search.inputValue()) === '' && (await rows.count()) === 84, 'and so does Escape');

// Each tab keeps its own search.
await find('course');
await section('Individuals');
ok((await search.inputValue()) === '' && (await count()) === '25 individuals' && (await search.getAttribute('placeholder')) === 'Search individuals…', 'another tab has a search of its own, empty to begin with');
await find('ada');
ok((await count()) === '1 of 25 individuals' && same(await names(), ['Ada Moreno']), 'which narrows that tab');
await section('Classes');
ok((await search.inputValue()) === 'course' && (await count()) === `${expected.length} of 84 classes`, 'the first tab still has its own search and what it found');
await tab('Graph');
await tab('Entities');
await settle();
ok((await search.inputValue()) === 'course' && (await rows.count()) === expected.length, 'and has it still after a look at another view');
// The sidebar's search is the sidebar's.
await find('');
await side.getByLabel('Search terms').fill('course');
await settle();
ok((await rows.count()) === 84 && (await count()) === '84 classes', 'the search box of the sidebar no longer narrows the table');
await side.getByLabel('Search terms').fill('');

// ---------------------------------------------------------------- sort
ok((await ariaSort('Name')) === 'none' && (await sortBy.inputValue()) === '' && (await direction.isDisabled()), 'the table starts in the order of the model');
await heading('Name').click();
await settle();
const az = [...all.map((r) => r.name)].sort(collator.compare);
ok(same(await names(), az) && (await ariaSort('Name')) === 'ascending' && (await sortBy.inputValue()) === 'name', 'a click on the Name heading sorts A to Z, and the heading and the selector say so');
await heading('Name').click();
await settle();
ok(same(await names(), [...az].reverse()) && (await ariaSort('Name')) === 'descending', 'a second click sorts Z to A');
await heading('Name').click();
await settle();
ok(same(await names(), all.map((r) => r.name)) && (await ariaSort('Name')) === 'none' && (await sortBy.inputValue()) === '', 'a third puts the model\'s own order back');
await heading('IRI').click();
await settle();
ok(same((await table()).map((r) => r.fullIri), [...all.map((r) => r.fullIri)].sort(collator.compare)), 'the IRI heading sorts by IRI');
// By how many superclasses: the most first, and classes with as many stay in the order they had.
await heading('Asserted Superclasses').click();
await settle();
found = await table();
const stable = (list, key) => list.every((r, i) => i === 0 || key(list[i - 1]) > key(r) || (key(list[i - 1]) === key(r) && all.findIndex((x) => x.name === list[i - 1].name) < all.findIndex((x) => x.name === r.name)));
ok(stable(found, (r) => r.supers.length) && found[0].supers.length > 1 && (await ariaSort('Asserted Superclasses')) === 'descending', `the Asserted Superclasses heading sorts by how many there are, most first (${found[0].name}: ${found[0].supers.length}), and classes with as many keep their order`);
await sortBy.selectOption({ label: 'Subclasses' });
await settle();
found = await table();
const subs = (name) => all.filter((r) => r.supers.includes(name)).length;
ok(stable(found, (r) => subs(r.name)) && subs(found[0].name) > 2 && (await direction.getAttribute('aria-label')).startsWith('Descending'), `the selector sorts by what has no column too: by subclasses, ${found[0].name} (${subs(found[0].name)}) first`);
await direction.click();
await settle();
ok(subs((await table())[0].name) === 0 && subs((await table()).at(-1).name) === subs(found[0].name), 'and the button beside it turns the order round');
await sortBy.selectOption({ label: 'Asserted restrictions' });
await settle();
found = await table();
ok(found[0].restrictions.length > 0 && found.at(-1).restrictions === '' && (await ariaSort('Asserted Restrictions')) === 'descending', 'by how many restrictions are asserted: ' + found[0].name + ' first');
// The selected class stays selected, in sight and open in the side panel when the order changes.
await sortBy.selectOption('');
await settle();
await rows.nth(70).locator('td').nth(1).click();
const chosen = (await table())[70].name;
await heading('Name').click();
await settle();
const selectedRow = view.locator('tbody tr.sel');
const inSight = await selectedRow.evaluate((tr) => { const a = tr.getBoundingClientRect(); const b = tr.closest('.table-wrap').getBoundingClientRect(); const head = tr.closest('table').querySelector('thead').getBoundingClientRect(); return a.top >= head.bottom - 1 && a.bottom <= b.bottom + 1; });
ok((await selectedRow.count()) === 1 && (await selectedRow.locator('input[aria-label="Name"]').inputValue()) === chosen && inSight && (await panel.locator('input').first().inputValue()) === chosen, `in a new order the selected class (${chosen}) is still selected, in sight, and open in the side panel`);
await sortBy.selectOption('');
await settle();

// ---------------------------------------------------------------- filters: classes
await filtersButton.click();
ok(same((await filters.locator('.ef').allInnerTexts()).map((t) => flat(t).replace(/ \d+/g, '')), ['Hierarchy Root Leaf', 'Multiple inheritance', 'Asserted restrictions', 'Inferred restrictions', 'Unsatisfiable']) && (await filtersButton.getAttribute('aria-expanded')) === 'true', 'the Filters button opens the filters of the classes: ' + (await filters.locator('.ef').allInnerTexts()).map(flat).join(' / '));
const roots = all.filter((r) => !r.supers.length).map((r) => r.name);
const leaves = all.filter((r) => !subs(r.name)).map((r) => r.name);
ok(flat(await option('Root').innerText()) === `Root ${roots.length}` && flat(await option('Leaf').innerText()) === `Leaf ${leaves.length}`, `each says how many classes have it: ${flat(await option('Root').innerText())}, ${flat(await option('Leaf').innerText())}`);
await toggle('Root');
ok(same(await names(), roots) && (await count()) === `${roots.length} of 84 classes` && (await option('Root').getAttribute('aria-pressed')) === 'true', 'Root leaves the classes with no asserted superclass');
ok(flat(await active.innerText()) === 'Filtered by Hierarchy: Root × Clear all filters' && flat(await filtersButton.innerText()) === 'Filters (1)', 'what is on is shown under the bar, and counted on the button: ' + flat(await active.innerText()));
await toggle('Leaf');
ok(same(await names(), roots.filter((n) => leaves.includes(n))), 'Root and Leaf together leave the classes that stand alone');
await toggle('Root');
ok(same(await names(), leaves), 'Leaf alone leaves the classes with no subclass');
await toggle('Leaf');
await toggle('Multiple inheritance');
found = await table();
ok(found.length > 0 && same(found.map((r) => r.name), all.filter((r) => r.supers.length > 1).map((r) => r.name)), `Multiple inheritance leaves the classes with more than one asserted superclass (${found.map((r) => r.name).join(', ')})`);
await toggle('Multiple inheritance');
await toggle('Asserted restrictions');
ok(same(await names(), all.filter((r) => r.restrictions).map((r) => r.name)), 'Asserted restrictions leaves the classes that have some stated on them');
await toggle('Asserted restrictions');
await toggle('Inferred restrictions');
found = await table();
ok(same(found.map((r) => r.name), all.filter((r) => r.inferred).map((r) => r.name)) && found.length > 5 && flat(await active.locator('.et-note').innerText()).startsWith('Inferred restrictions are those inherited through what the fast reasoner'), 'Inferred restrictions leaves the classes that inherit some, and says which reasoner that rests on');
// Search, filter and order together.
await toggle('Leaf');
await find('student');
await heading('Name').click();
await heading('Name').click();
await settle();
found = await table();
const combined = all.filter((r) => r.inferred && !subs(r.name) && has(r, 'student')).map((r) => r.name).sort(collator.compare).reverse();
ok(same(found.map((r) => r.name), combined) && combined.length > 1 && (await count()) === `${combined.length} of 84 classes` && flat(await filtersButton.innerText()) === 'Filters (2)', `a search, two filters and an order work together (${combined.join(', ')})`);
await active.getByRole('button', { name: 'Remove the filter Hierarchy: Leaf' }).click();
await settle();
ok((await option('Leaf').getAttribute('aria-pressed')) === 'false' && flat(await filtersButton.innerText()) === 'Filters (1)' && (await search.inputValue()) === 'student', 'a filter is taken off by its ×, and the search stays');
await toggle('Leaf');
await active.getByRole('button', { name: 'Clear all filters' }).click();
await settle();
ok((await active.count()) === 0 && flat(await filtersButton.innerText()) === 'Filters' && (await search.inputValue()) === 'student' && (await ariaSort('Name')) === 'descending', 'Clear all filters takes them all off, and leaves the search and the order as they are');
await find('zzz');
await toggle('Root');
ok(flat(await view.locator('.empty-result strong').innerText()) === 'No class matches “zzz” with the filter that is on.' && (await view.locator('.empty-result').getByRole('button').allInnerTexts()).join('|') === 'Clear the search|Clear all filters', 'with nothing left, the search and the filters can each be put back from where it says so');
await view.locator('.empty-result').getByRole('button', { name: 'Clear all filters' }).click();
await find('');
await sortBy.selectOption('');
await settle();
await filtersButton.click();
ok((await filters.count()) === 0 && (await rows.count()) === 84, 'the filters fold away again');

// ---------------------------------------------------------------- object properties
await section('Object properties');
const props = await table();
ok((await count()) === `${props.length} object properties` && (await sortBy.locator('option').allInnerTexts()).join('|') === 'Model order|Name|IRI|Relationships that use it', 'object properties have their own order: ' + (await sortBy.locator('option').allInnerTexts()).join('|'));
await heading('Uses').click();
await settle();
found = await table();
ok(found.every((r, i) => i === 0 || found[i - 1].relations >= r.relations) && found[0].relations > found.at(-1).relations, `the Uses heading sorts by how many relationships use each, most first (${found[0].name}: ${found[0].relations})`);
await sortBy.selectOption('');
await openFilters();
await settle();
ok(same((await filters.locator('.ef').allInnerTexts()).map((t) => flat(t).replace(/ \d+/g, '')), ['Domain Set Not set', 'Range Set Not set', 'Characteristics Functional Inverse functional Transitive Symmetric Asymmetric Reflexive Irreflexive', 'Has an inverse']), 'and their own filters: ' + (await filters.locator('.ef').allInnerTexts()).map((t) => flat(t).replace(/ \d+/g, '')).join(' / '));
const fn = props.filter((r) => /(^|, )Functional/.test(r.characteristics)).map((r) => r.name);
await toggle('Functional');
ok(same(await names(), fn) && fn.length > 0, `Functional leaves the functional ones (${fn.join(', ')})`);
await toggle('Functional');
await toggle('Transitive');
ok(same(await names(), props.filter((r) => r.characteristics.includes('Transitive')).map((r) => r.name)), 'Transitive the transitive ones: ' + (await names()).join(', '));
await toggle('Transitive');
await toggle('Has an inverse');
ok(same(await names(), props.filter((r) => r.inverse !== '—').map((r) => r.name)) && (await names()).length > 0, 'Has an inverse the ones with an inverse: ' + (await names()).join(', '));
await toggle('Has an inverse');
const domain = filters.locator('.ef', { hasText: /^Domain/ });
await domain.getByRole('button', { name: /^Not set/ }).click();
await settle();
ok(same(await names(), props.filter((r) => r.domain.startsWith('anything')).map((r) => r.name)), 'Domain: Not set the ones with no domain: ' + ((await names()).join(', ') || 'none'));
await domain.getByRole('button', { name: /^Set/ }).click();
await settle();
ok((await domain.getByRole('button', { name: /^Not set/ }).getAttribute('aria-pressed')) === 'false' && same(await names(), props.filter((r) => !r.domain.startsWith('anything')).map((r) => r.name)), 'choosing Set instead takes Not set off: one or the other');
await active.getByRole('button', { name: 'Clear all filters' }).click();

// ---------------------------------------------------------------- data properties
await section('Data properties');
const data = await table();
ok((await filtersButton.getAttribute('aria-expanded')) === 'true' && same((await filters.locator('.ef .ef-label').allInnerTexts()).map(flat), ['Domain', 'Range', 'Datatype']) && (await option('Functional').count()) === 1, 'opened once, the filters stay open from tab to tab; data properties are filtered by domain, range, being functional, and datatype');
await rows.nth(2).locator('input[type=checkbox]').check();
await toggle('Functional');
ok(same(await names(), [data[2].name, ...data.filter((r) => r.functional).map((r) => r.name)].filter((n, i, l) => l.indexOf(n) === i).sort((a, b) => data.findIndex((r) => r.name === a) - data.findIndex((r) => r.name === b))), 'Functional leaves the functional ones, here the one just made so: ' + (await names()).join(', '));
await toggle('Functional');
await page.keyboard.press('Control+z');
await settle();
const datatype = filters.locator('.ef', { hasText: /^Datatype/ });
const types = (await datatype.getByRole('button').allInnerTexts()).map(flat);
await datatype.getByRole('button', { name: /^integer/ }).click();
await datatype.getByRole('button', { name: /^date \d/ }).click();
await settle();
found = await table();
ok(same(found.map((r) => r.name), data.filter((r) => /^xsd:(integer|date) /.test(r.range)).map((r) => r.name)) && found.some((r) => r.range.startsWith('xsd:integer')) && found.some((r) => r.range.startsWith('xsd:date ')), `Datatype leaves the ones whose range is any of those chosen, from ${types.join(', ')}`);
await heading('Range (datatype)').click();
await settle();
ok(inOrder((await table()).map((r) => r.range.split(' ')[0].split(':').pop())), 'and the Range heading sorts them by datatype: ' + (await table()).map((r) => r.range.split(' ')[0]).join(', '));
await active.getByRole('button', { name: 'Clear all filters' }).click();
await sortBy.selectOption('');

// ---------------------------------------------------------------- individuals
await section('Individuals');
await find('');
const people = await table();
await openFilters();
ok(same((await filters.locator('.ef .ef-label').allInnerTexts()).map(flat), ['Asserted class', 'Inferred class']), 'individuals are filtered by the class they are stated to be in, and by the classes that follow');
let offered = await choose('Asserted class', 'prof');
ok(offered.length > 1 && offered.every((o) => /prof/i.test(o)) && same(await names(), people.filter((r) => r.supers.some((s) => s === offered[0].replace(/ \d+$/, ''))).map((r) => r.name)), `a class is chosen by searching for it (${offered.join(', ')}); it leaves the individuals stated to be instances of it: ${(await names()).join(', ')}`);
ok(flat(await active.innerText()).startsWith(`Filtered by Asserted class: ${offered[0].replace(/ \d+$/, '')}`), 'and is named in what is on: ' + flat(await active.innerText()));
await active.getByRole('button', { name: 'Clear all filters' }).click();
offered = await choose('Inferred class', 'Person');
found = await table();
const stated = people.filter((r) => r.supers.includes('Person')).length;
ok(offered[0] === 'Person' && found.length > 5 && found.length > stated && flat(await active.locator('.et-note').innerText()).startsWith('Inferred class memberships are as entailed by the fast reasoner'), `Inferred class: Person leaves every individual entailed to be a person (${found.length}), of which ${stated} are stated to be one, and says which reasoner that rests on`);
await heading('Type').click();
await settle();
ok(inOrder((await table()).map((r) => r.supers.join(', '))), 'the Type heading sorts individuals by their asserted classes');
await active.getByRole('button', { name: 'Clear all filters' }).click();
await sortBy.selectOption('');

// ---------------------------------------------------------------- relationships
await section('Relationships');
ok((await count()) === '195 relationships' && (await rows.count()) === 150 && flat(await view.locator('.pager').innerText()).startsWith('Showing 150 of 195.'), 'a long table shows its first rows and says how many there are: ' + flat(await view.locator('.pager').innerText()).slice(0, 44));
await view.locator('.pager').getByRole('button', { name: 'Show all' }).click();
await settle();
const rels = await table();
ok(rels.length === 195 && (await view.locator('.pager').count()) === 0 && (await sortBy.locator('option').allInnerTexts()).join('|') === 'Model order|From|Property / label|To|Kind', 'Show all shows the rest; relationships are sorted by either end, by name and by kind');
await openFilters();
ok(same((await filters.locator('.ef .ef-label').allInnerTexts()).map(flat), ['Kind', 'From', 'To']), 'and filtered by kind, by where they start and by where they end');
await toggle('Is Instance Of');
ok(same((await table()).map((r) => r.from + '>' + r.to), rels.filter((r) => r.kind === 'Is Instance Of').map((r) => r.from + '>' + r.to)) && (await rows.count()) > 10, `Kind: Is Instance Of leaves the class memberships (${await rows.count()})`);
await toggle('Has data property');
ok((await table()).every((r) => /Instance|data property/.test(r.kind)) && (await rows.count()) === rels.filter((r) => /Instance|data property/.test(r.kind)).length, 'a second kind adds the relationships of that kind');
await active.getByRole('button', { name: 'Clear all filters' }).click();
offered = await choose('From', 'Ada');
ok(offered[0].startsWith('Ada Moreno') && (await table()).every((r) => r.from === 'Ada Moreno') && (await rows.count()) === rels.filter((r) => r.from === 'Ada Moreno').length, `From: Ada Moreno leaves the relationships that start there (${await rows.count()})`);
await choose('To', 'Full prof');
ok((await rows.count()) === 1 && (await table())[0].to === 'Full professor', 'with To as well, the one from there to there');
await active.getByRole('button', { name: 'Clear all filters' }).click();
await find('ada supervis');
found = await table();
ok(found.length > 0 && found.every((r) => /ada/i.test(r.from + r.to) && /supervis/i.test(r.label + r.from + r.to)), `a search looks in the name and in both ends (${found.map((r) => `${r.from} ${r.label} ${r.to}`).join('; ')})`);
ok((await rows.first().locator('td.hit').count()) > 0 && found[0].marks.length > 0, 'and marks the cells it was found in');
await find('');
await heading('From').click();
await settle();
ok(inOrder((await table()).map((r) => r.from)), 'the From heading sorts by where each starts');
await sortBy.selectOption('');
await settle();
ok((await turtle()) === baseline, 'after all the searching, sorting and filtering of five tables the ontology reads exactly as it did');
await settle();

// ---------------------------------------------------------------- editing and adding while narrowed
await section('Classes');
await find('course');
await sortBy.selectOption('name');
await settle();
const editing = (await names())[0];
const box = rows.first().getByLabel('Name');
await box.fill(editing + ' (renamed)');
await box.press('Enter');
await settle();
ok((await names()).includes(editing + ' (renamed)') && (await panel.locator('input').first().inputValue()) === editing + ' (renamed)', 'a row is still edited in place while the table is searched and sorted');
await page.keyboard.press('Control+z');
await settle();
await view.getByRole('button', { name: 'Add class' }).click();
await settle();
found = await table();
ok(found.at(-1).name === 'New class' && found.at(-1).pinned && found.at(-1).selected && (await search.inputValue()) === 'course' && (await count()) === `${expected.length} of 85 classes`, 'a class added while the table is narrowed is listed all the same, marked as just added, with the search left as it was');
ok(await view.locator('tbody tr.pinned input[aria-label="Name"]').evaluate((el) => el === document.activeElement), 'and its name is ready to be typed');
await page.keyboard.type('Evening course');
await page.keyboard.press('Enter');
await settle();
ok((await names()).includes('Evening course') && (await count()) === `${expected.length + 1} of 85 classes` && (await view.locator('tbody tr.pinned').count()) === 0, 'named so that it matches, it takes its place in the list');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await settle();
await find('');
await sortBy.selectOption('');
await settle();

// ---------------------------------------------------------------- come to from elsewhere
// Open in Entities, from the Structure Explorer, lands on the class whatever the table is narrowed to.
await find('course');
await tab('Structure');
// Whichever class the hierarchy has in view that the search for "course" leaves out.
await page.locator('.view.structure .tree-name').first().waitFor();
const elsewhere = (await page.locator('.view.structure .tree-name').allInnerTexts()).map(flat).find((n) => !/course/i.test(n));
await page.locator('.view.structure .tree-name', { hasText: new RegExp('^' + elsewhere + '$') }).first().click();
await page.locator('.view.structure').getByRole('button', { name: 'Open in Entities' }).click();
await settle();
found = await table();
const opened = view.locator('tbody tr.sel');
ok((await search.inputValue()) === 'course' && found.at(-1).name === elsewhere && found.at(-1).pinned && found.at(-1).selected && (await opened.evaluate((tr) => { const a = tr.getBoundingClientRect(); const b = tr.closest('.table-wrap').getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom + 1; })) && (await panel.locator('input').first().inputValue()) === elsewhere, `a class opened from the Structure Explorer (${elsewhere}) is listed and in sight although the search would leave it out, and the search is left alone`);
ok(!(await opened.locator('input[aria-label="Name"]').evaluate((el) => el === document.activeElement)), 'without the keyboard being put into its name');
await find('');
await settle();
ok((await view.locator('tbody tr.pinned').count()) === 0 && (await view.locator('tbody tr.sel').count()) === 1, 'with the search cleared it is in its own place in the list, still selected');

// ---------------------------------------------------------------- an unsatisfiable class
await file(/^Load the ontology example/);
const pick = async (name) => { await side.locator('.tree-line .label, li button', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click(); await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name); };
const field = (label) => panel.locator('.field', { has: page.locator(`:scope > span:has-text("${label}")`) }).first();
const state = async (label, text) => { const f = field(label); await f.locator('.chip-add').click(); await f.getByRole('combobox').fill(text); await f.locator('.subgraph-found button').first().dispatchEvent('pointerdown'); };
await tab('Entities');
await settle();
ok((await search.inputValue()) === '' && (await count()) === '8 classes', 'another model starts with nothing searched for, sorted or filtered');
await pick('Film');
await state('Disjoint classes', 'Person');
await pick('Documentary');
await state('Asserted superclasses', 'Person');
await settle();
await openFilters();
await toggle('Unsatisfiable');
ok(same(await names(), ['Documentary']) && flat(await active.locator('.et-note').innerText()) === 'Unsatisfiable classes are as found by the fast reasoner (RDFS / partial OWL RL), which does not find everything an OWL 2 DL reasoner would.', 'Unsatisfiable leaves the class that can have no instance, and says whose finding that is');
// An instance of it makes the ontology contradict itself: nothing reliable follows, and the filter says so.
await section('Individuals');
await rows.first().locator('.chip-add').click();
await view.locator('.table-wrap').getByRole('combobox').fill('Documentary');
await view.locator('.table-wrap .subgraph-found button').first().dispatchEvent('pointerdown');
await section('Classes');
ok((await option('Unsatisfiable').count()) === 1 && flat(await filters.locator('.ef.off').first().innerText()).includes('not available') && (await rows.count()) === 8 && flat(await active.locator('.et-note').innerText()).startsWith('“Unsatisfiable” is not applied: the reasoner finds the ontology inconsistent'), 'while the ontology is inconsistent a filter that rests on the reasoner is not applied, and says why');
await page.keyboard.press('Control+z');
await settle();
ok(same(await names(), ['Documentary']), 'consistent again, it is applied again');

// ---------------------------------------------------------------- a vocabulary
await file(/^Load the SKOS example/);
await tab('Entities');
await settle();
await openFilters();
ok((await search.getAttribute('placeholder')) === 'Search concepts…' && same((await filters.locator('.ef').allInnerTexts()).map((t) => flat(t).replace(/ \d+/g, '')), ['Hierarchy Root Leaf', 'Multiple inheritance']) && (await sortBy.locator('option').allInnerTexts()).join('|') === 'Model order|Name|IRI|Asserted broader concepts|Narrower concepts|Relationships', 'a vocabulary has the search, the orders and the filters that fit concepts: ' + (await sortBy.locator('option').allInnerTexts()).join('|'));
await toggle('Root');
ok((await rows.count()) > 0 && (await count()).endsWith('concepts') && (await count()).includes(' of '), 'its top concepts: ' + (await count()));
await filtersButton.click();

// ---------------------------------------------------------------- a long list
await file(/^Generate a stress-test model/);
await tab('Entities');
await settle();
await section('Relationships');
const total = Number((await count()).replace(/\D/g, ''));
ok(total > 2000 && (await rows.count()) === 150 && flat(await view.locator('.pager').innerText()).startsWith(`Showing 150 of ${total.toLocaleString('en')}.`), `of ${total} relationships the first 150 are shown: ${flat(await view.locator('.pager').innerText()).slice(0, 60)}`);
let t = Date.now();
await search.fill('attribute 12');
await settle();
const typed = Date.now() - t;
ok((await count()).includes(' of ') && (await rows.count()) > 0 && (await rows.count()) <= 150 && typed < 1500, `a search over ${total} relationships answers in ${typed} ms: ${await count()}`);
await find('');
t = Date.now();
await heading('From').click();
await settle();
ok(Date.now() - t < 1500 && (await rows.count()) === 150 && (await table()).every((r, i, list) => i === 0 || collator.compare(list[i - 1].from, r.from) <= 0), `sorting them takes ${Date.now() - t} ms, and the first 150 in the new order are shown`);
await view.locator('.pager').getByRole('button', { name: /^Show 300 more/ }).click();
await settle();
ok((await rows.count()) === 450 && flat(await view.locator('.pager').innerText()).startsWith('Showing 450 of'), 'Show more shows more of them, in the same order');
await view.locator('.pager').getByRole('button', { name: 'Show all' }).click();
await page.waitForFunction((n) => document.querySelectorAll('.view tbody tr').length === n, total, { timeout: 60000 });
ok((await view.locator('.pager').count()) === 0 && (await table()).every((r, i, list) => i === 0 || collator.compare(list[i - 1].from, r.from) <= 0), `Show all shows all ${total}, fetched a page after a page and still in order`);
await sortBy.selectOption('');
await section('Classes');
t = Date.now();
await search.fill('class 6');
await settle();
ok(Date.now() - t < 1500 && (await count()).includes(' of 650 classes'), `a search over 650 classes answers in ${Date.now() - t} ms: ${await count()}`);

ok(errors.length === 0, 'no errors in the console' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
