// Drives the built app in a headless browser to check the LDM workspace (roadmap LM-2,
// FR-M17-10 to FR-M17-12): the tab beside Graph, Entities, Structure and Shapes; entities made
// by keyboard and by button, with their attributes, types and domains, optionality, keys,
// specialization and rules; relationships with both ends, cardinality and identifying, and a
// many-to-many resolved into an associative entity; the ER diagram, where choosing an entity
// opens its editor and moving one changes only where the picture puts it, as one undoable step;
// and the LDM category of the validation view, whose findings open the element they are about.
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
const dialog = page.locator('.dialog.logical-models');
const listRows = page.locator('.ldm-list li');
const selectedRow = page.locator('.ldm-list li button.on');
// Keys reach the view's own shortcuts only when no field has the keyboard.
const press = async (key) => {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press(key);
};
const entityName = page.getByLabel('Entity name');
const names = async () => (await page.locator('.ldm-list li button > span').allInnerTexts()).map(flat);

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- the tab, and a model
await view('LDM').click();
ok(await page.locator('.ldm-empty').isVisible(), 'the LDM has a tab of its own, beside the others');
await page.getByRole('button', { name: /Make a logical model/ }).click();
await dialog.waitFor();
await dialog.getByLabel('Name of the new logical model').fill('Shop');
await dialog.getByRole('button', { name: 'Make a logical model' }).click();
await dialog.getByRole('button', { name: 'Open', exact: true }).click();
await page.locator('.ldm-view .ldm-head').waitFor();
ok((await page.locator('.ldm-head strong').innerText()) === 'Shop', 'a logical model is made and opens in the workspace');

// ---------------------------------------------------------------- entities, by keyboard
const entitiesTab = part(/^Entities/);
await entitiesTab.click();
ok(await page.getByText('No entity yet. Make one to begin.').isVisible(), 'the workspace starts empty');
await press('n');
await entityName.waitFor();
await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'Entity');
await entityName.fill('Customer');
await entityName.press('Enter');
ok((await entityName.inputValue()) === 'Customer', 'n makes an entity, and Enter renames it');

await page.getByRole('button', { name: 'Add attribute' }).click();
const attributeName = page.getByLabel('Name of the attribute Attribute');
await attributeName.waitFor();
await attributeName.fill('email');
await attributeName.press('Enter');
await page.getByLabel('Name of the attribute email').waitFor();
ok(await page.getByLabel('Name of the attribute email').isVisible(), 'an attribute is added, text and optional to begin with');
ok(await page.locator('.ldm-attribute .check', { hasText: 'Optional' }).locator('input').isChecked(), 'it is optional');

await page.getByRole('button', { name: 'Add primary key' }).click();
const key = page.locator('.ldm-key');
await key.waitFor();
ok((await page.getByLabel('Kind of the key Primary key').inputValue()) === 'primary', 'a primary key is made');
ok(flat(await key.innerText()).includes('email'), 'with the attribute as its member: ' + flat(await key.innerText()));

// A second and a third entity; the third is left unidentified, for the checks to find.
const makeEntity = async (name) => {
  await press('n');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'Entity');
  await entityName.fill(name);
  await entityName.press('Enter');
  await page.waitForFunction((n) => document.querySelector('input[aria-label="Entity name"]')?.value === n, name);
};
await makeEntity('Order');
await page.getByRole('button', { name: 'Add attribute' }).click();
await page.getByLabel('Name of the attribute Attribute').waitFor();
await page.getByLabel('Name of the attribute Attribute').fill('placed');
await page.getByLabel('Name of the attribute Attribute').press('Enter');
await page.getByRole('button', { name: 'Add primary key' }).click();
await page.locator('.ldm-key').waitFor();
await makeEntity('Note');

// The list, by keyboard and search.
await press('ArrowDown');
ok(flat(await selectedRow.innerText()).startsWith('Order'), 'arrow keys choose in the list, in order: ' + flat(await selectedRow.innerText()));
await press('ArrowUp');
ok(flat(await selectedRow.innerText()).startsWith('Note'), 'and back again');
await press('Delete');
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 2);
ok(!(await names()).includes('Note'), 'Delete takes an entity out, once confirmed');
await page.getByRole('button', { name: 'Undo' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button span')].some((x) => x.textContent === 'Note'));
ok((await listRows.count()) === 3, 'and one undo brings it back');

await page.getByLabel('Search entities').fill('Ord');
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 1);
ok(flat(await listRows.first().innerText()).startsWith('Order'), 'the search narrows the list');
await page.getByLabel('Search entities').press('Escape');
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 3);

// ---------------------------------------------------------------- a domain, and a type that names it
await part(/^Domains/).click();
await page.getByRole('button', { name: 'New domain' }).click();
const domainName = page.getByLabel('Domain name');
await domainName.waitFor();
await domainName.fill('Rating');
await domainName.press('Enter');
await page.getByLabel('Domain base type').selectOption('decimal');
await page.getByLabel('Domain precision').fill('3');
await page.getByLabel('Domain precision').press('Enter');
await page.getByLabel('Domain scale').fill('1');
await page.getByLabel('Domain scale').press('Enter');
await page.getByRole('button', { name: 'Add value' }).click();
await page.getByLabel('Code of value 1').fill('A');
await page.getByLabel('Code of value 1').press('Enter');
await page.getByLabel('Label of value 1').fill('Excellent');
await page.getByLabel('Label of value 1').press('Enter');
ok(flat(await page.locator('.ldm-list').innerText()).includes('Rating'), 'a domain is made: a base type narrowed by the checks of its values');
ok((await page.locator('.ldm-list li small').first().innerText()).startsWith('decimal'), 'with its base type');

await entitiesTab.click();
await page.locator('.ldm-list li button', { hasText: 'Customer' }).click();
await page.getByLabel('Attribute type').selectOption({ label: 'Rating' });
await page.waitForFunction(() => document.querySelector('select[aria-label="Attribute type"]')?.value.startsWith('domain:'));
ok((await page.getByLabel('Attribute type').inputValue()).startsWith('domain:'), 'an attribute takes the domain as its logical type');
await part(/^Domains/).click();
ok(await page.getByRole('button', { name: 'Delete domain…' }).isDisabled(), 'a domain in use cannot be deleted');
ok(flat(await page.locator('.ldm-editor').innerText()).includes('Used by Customer.email'), 'and says what uses it');

// ---------------------------------------------------------------- specialization
await entitiesTab.click();
await page.locator('.ldm-list li button', { hasText: 'Order' }).click();
await page.getByLabel('Add a supertype').selectOption({ label: 'Customer' });
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-editor .tag')].some((x) => x.textContent?.includes('Customer')));
ok(flat(await page.locator('.ldm-editor').innerText()).includes('Customer'), 'an entity is made a kind of another');
ok(await page.locator('.ldm-inherited').filter({ hasText: 'email' }).isVisible(), 'and inherits its attributes');
await page.locator('.ldm-list li button', { hasText: 'Customer' }).click();
const subtypeOptions = await page.getByLabel('Add a subtype').locator('option').allInnerTexts();
ok(!subtypeOptions.includes('Order'), 'the edge that would close a circle is not offered: ' + subtypeOptions.join(' | '));

// ---------------------------------------------------------------- relationships, and many-to-many
await part(/^Relationships/).click();
await page.getByRole('button', { name: 'New relationship' }).click();
const relationshipName = page.getByLabel('Relationship name');
await relationshipName.waitFor();
await relationshipName.fill('buys');
await relationshipName.press('Enter');
const end2 = page.getByRole('group', { name: /End 2/ });
await end2.getByRole('checkbox', { name: 'many' }).check();
await page.getByRole('button', { name: 'Make an associative entity' }).waitFor();
ok(flat(await page.locator('.ldm-editor').innerText()).includes('many-to-many'), 'a relationship many at both ends says so, and offers to resolve it');
await page.getByRole('button', { name: 'Make an associative entity' }).click();
await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'buys');
ok(await entityName.isVisible(), 'resolving it makes an associative entity, and opens it');
await page.locator('.ldm-key').waitFor();
const resolvedKey = flat(await page.locator('.ldm-key').innerText());
ok(resolvedKey.includes('the identity of Customer') && resolvedKey.includes('the identity of Order'), 'whose primary key borrows the identity of both ends: ' + resolvedKey);
await part(/^Relationships/).click();
const relNames = await names();
ok(relNames.length === 2 && relNames.every((n) => n.startsWith('buys of ')), 'the many-to-many is gone, replaced by two identifying relationships: ' + relNames.join(' | '));

// ---------------------------------------------------------------- rules
await part(/^Rules/).click();
await page.getByLabel('Name of the new rule').fill('One order per customer');
await page.getByLabel('Statement of the new rule').fill('A customer may place many orders, each for one customer.');
await page.getByRole('button', { name: 'Add rule' }).click();
await page.getByLabel('Rule name').waitFor();
await page.getByLabel('Rule kind').selectOption('derivation');
await page.getByLabel('Rule status').selectOption('proposed');
await page.getByLabel('What the rule applies to').selectOption([{ label: 'Customer (entity)' }, { label: 'buys (entity)' }]);
await page.waitForFunction(() => document.querySelectorAll('select[aria-label="What the rule applies to"] option:checked').length === 2);
ok((await page.getByLabel('Rule name').inputValue()) === 'One order per customer', 'a business rule is stated in words');
ok((await page.getByLabel('Rule kind').inputValue()) === 'derivation' && (await page.getByLabel('Rule status').inputValue()) === 'proposed', 'with its kind and status');
ok((await page.locator('select[aria-label="What the rule applies to"] option:checked').allInnerTexts()).join(' | ') === 'Customer (entity) | buys (entity)', 'and what it is about');

// ---------------------------------------------------------------- the ER diagram
await part('Diagram').click();
const nodes = page.locator('.ldm-node');
await page.waitForFunction(() => document.querySelectorAll('.ldm-node').length === 4);
ok((await nodes.count()) === 4, 'the diagram draws every entity');
ok((await page.locator('.ldm-rel').count()) === 2, 'and both relationships');
ok((await page.locator('.ldm-rel').first().getAttribute('stroke-dasharray')) === null, 'an identifying relationship is drawn solid');
const customerNode = nodes.filter({ hasText: 'Customer' });
const handle = await customerNode.elementHandle();
const transform = () => page.evaluate((el) => el.getAttribute('transform'), handle);
const before = await transform();
await customerNode.focus();
await page.keyboard.press('ArrowRight');
await page.waitForFunction(([el, prev]) => el.getAttribute('transform') !== prev, [handle, before]);
const nudged = await transform();
ok(nudged !== before, 'an arrow key moves an entity: ' + before + ' → ' + nudged);
await page.getByRole('button', { name: 'Undo' }).click();
await page.waitForFunction(([el, prev]) => el.getAttribute('transform') === prev, [handle, before]);
ok(true, 'one undo puts it back');
await page.getByRole('button', { name: 'Redo' }).click();
await page.waitForFunction(([el, prev]) => el.getAttribute('transform') === prev, [handle, nudged]);
ok(true, 'and one redo moves it again');

const box = await customerNode.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + 18);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 90, box.y + 58, { steps: 6 });
await page.mouse.up();
await page.waitForFunction(([el, prev]) => el.getAttribute('transform') !== prev, [handle, nudged]);
const dragged = await transform();
ok(dragged !== nudged, 'a drag moves it too, and is kept apart from what the model means: ' + dragged);
await page.getByRole('button', { name: 'Undo' }).click();
await page.waitForFunction(([el, prev]) => el.getAttribute('transform') === prev, [handle, nudged]);
ok(true, 'a drag is one undoable step');

await customerNode.focus();
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'Customer');
ok((await page.getByRole('tablist', { name: 'Part of the logical model' }).getByRole('tab', { name: /^Entities/ }).getAttribute('aria-selected')) === 'true', 'choosing an entity in the diagram opens the same editor');

// ---------------------------------------------------------------- validation, as a category
await view('Validation').click();
const card = page.locator('section.card', { hasText: 'Logical data models' });
await card.waitFor();
const said = flat(await card.innerText());
ok(/Models: 1/.test(said) && /Warnings: 1/.test(said), 'the validation view counts the LDM findings: ' + said);
await page.getByRole('tablist', { name: 'Validation' }).getByRole('tab', { name: /^Results/ }).click();
await page.getByLabel('Category').selectOption('ldm');
await page.waitForFunction(() => document.querySelectorAll('.result').length === 1);
const row = page.locator('tr.result').first();
ok(flat(await row.innerText()).includes('Entity without a primary key') && flat(await row.innerText()).includes('Note'), 'an entity nothing identifies is reported: ' + flat(await row.innerText()));
await row.click();
await page.getByRole('button', { name: 'Open in the LDM' }).click();
await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'Note');
ok((await page.getByLabel('Entity name').inputValue()) === 'Note', 'and the finding opens the element it is about');
await page.screenshot({ path: shots + 'logical-workspace.png' });

// ---------------------------------------------------------------- kept, with where things sit
const movedTransform = nudged;
await part('Diagram').click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-node').length === 4);
const customerAgain = page.locator('.ldm-node').filter({ hasText: 'Customer' });
ok((await customerAgain.getAttribute('transform')) === movedTransform, 'where the entities sit is kept with the model');
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('.node');
await view('LDM').click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-list li').length === 4);
ok((await listRows.count()) === 4, 'after a reload the logical model is there, with its entities');
await page.locator('.ldm-list li button', { hasText: 'Customer' }).click();
ok(flat(await page.locator('.ldm-key').innerText()).includes('email'), 'its keys too');
await part('Diagram').click();
await page.waitForFunction(() => document.querySelectorAll('.ldm-node').length === 4);
ok((await page.locator('.ldm-node').filter({ hasText: 'Customer' }).getAttribute('transform')) === movedTransform, 'and where the diagram put them');

// The diagram's own tools make the same change sets as the forms do.
await page.getByRole('button', { name: 'New entity' }).click();
await page.waitForFunction(() => document.querySelector('input[aria-label="Entity name"]')?.value === 'Entity');
ok((await names()).includes('Entity'), 'the diagram makes an entity as the Entities section does');
await part('Diagram').click();
await page.getByRole('button', { name: 'New relationship' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.ldm-list li button > span')].some((x) => x.textContent === 'Relationship'));
ok((await names()).includes('Relationship'), 'and a relationship as the Relationships section does');

console.log('console errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
