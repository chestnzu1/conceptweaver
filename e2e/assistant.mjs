// Drives the built app in a headless browser to check the assistant (FR-M12): set up with a
// provider, a model and a key, and the connection tested; an answer about the selected class that
// it looked up through the tools, its entities links that open them; proposals that change
// nothing until they are accepted, reviewed with their axioms, before and after, and what the
// reasoner finds; one that does not read is not accepted, is edited and checked again; one
// accepted is one edit, in the graph, that undo takes back and redo puts back; one checked before
// the ontology changed is out of date until checked again; an answer stopped; a lookup shown
// before it is sent, and not sent when declined; the key in no storage, file or export, gone after
// a reload while the rest of the settings stay, and the conversation with its proposals kept. Then,
// where Java is there, through the local service: the key held by it, so a reload keeps it while
// this tab keeps only a handle; given again once the service has restarted; and a proposal checked
// by HermiT, which finds what the fast reasoner does not.
// A fake provider that speaks OpenAI's API stands in for one, on this machine.
// Needs the preview server:  pnpm build && pnpm exec vite preview --port 5181
import { chromium } from 'playwright-core';
import fs, { globSync } from 'node:fs';
import http from 'node:http';
import { startReasoner, unavailable } from '../reasoner/run.mjs';

const base = process.argv[2] ?? 'http://localhost:5181/';
const exe = globSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')[0];
const shots = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const KEY = 'sk-e2e-never-stored-31337';

// ---------------------------------------------------------------- the fake provider
const seen = [];
let streamClosedEarly = false;
const sse = (res, chunks, gap = 0) =>
  (async () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', ...cors });
    for (const c of chunks) {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      if (gap) await new Promise((r) => setTimeout(r, gap));
    }
    res.end('data: [DONE]\n\n');
  })();
const text = (t) => ({ choices: [{ delta: { content: t } }] });
const calls = (...cs) => [{ choices: [{ delta: { tool_calls: cs.map(([name, args], index) => ({ index, id: `call_${name}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
const propose = (summary, operations, extra = {}) => ['proposeChanges', { summary, explanation: `Because ${summary.toLowerCase()} was asked for.`, impact: 'As stated in the axioms.', concerns: [], operations, ...extra }];
let cors = {};

/** What the fake model says: by the question, and by whether the tools have answered yet. */
function answer(request) {
  const msgs = request.messages;
  const question = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
  const last = msgs[msgs.length - 1];
  const answered = last.role === 'tool';
  if (question.includes('Explain the selected class')) {
    if (!answered) return calls(['getSelectedEntity', {}]);
    if (JSON.parse(last.content).declined) return [text('You chose not to send what I looked up, so I can say nothing of it.')];
    const { selected } = JSON.parse(last.content);
    const ns = selected.iri.replace(/[^#/]*$/, '');
    return [text(`**${selected.name}** is a class.`), text(` See [${selected.name}](${selected.iri}), and [a class it does not have](${ns}NoSuchThing).`), { choices: [{ delta: {}, finish_reason: 'stop' }] }];
  }
  if (question.includes('Add short films')) {
    if (!answered) return calls(propose('Short films', [{ action: 'add', type: 'declare', entityKind: 'class', name: 'Short film' }, { action: 'add', type: 'subClassOf', subject: "'Short film'", expression: 'Film' }]), propose('Feature films', [{ action: 'add', type: 'declare', entityKind: 'class', name: 'Feature film' }, { action: 'add', type: 'subClassOf', subject: "'Feature film'", expression: 'Film' }]));
    return [text('I proposed P1 and P2 for your review.')];
  }
  if (question.includes('documentaries disjoint')) {
    if (!answered) return calls(propose('Documentaries are not films', [{ action: 'add', type: 'disjointClasses', subject: 'Documentary', expression: 'Film' }], { concerns: ['Documentary is a subclass of Film.'] }));
    return [text('I proposed P3, but see its concern.')];
  }
  if (question.includes('directors')) {
    if (!answered) return calls(propose('Directors are filmmakers', [{ action: 'add', type: 'subClassOf', subject: 'Director', expression: 'Filmmaker' }]));
    return [text('I proposed P4.')];
  }
  if (question.includes('win nothing')) {
    if (!answered) return calls(propose('Documentaries win nothing', [{ action: 'add', type: 'subClassOf', subject: 'Documentary', expression: 'wins max 0 Award' }]));
    return [text('I proposed P5.')];
  }
  if (question.includes('slowly')) return Array.from({ length: 60 }, (_, i) => text(`word${i} `));
  return [text('I cannot help with that.')];
}

const provider = http.createServer((req, res) => {
  cors = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
    if (req.url !== '/v1/chat/completions') return res.writeHead(404, cors).end();
    const request = JSON.parse(body);
    const slow = JSON.stringify(request.messages.at(-1)).includes('slowly');
    res.on('close', () => {
      if (slow && !res.writableEnded) streamClosedEarly = true;
    });
    void sse(res, answer(request), slow ? 200 : 15);
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;

// ---------------------------------------------------------------- the page
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
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
const panel = page.locator('aside.assistant');
const side = page.locator('.term-list');
const node = (name) => page.locator('.node', { has: page.locator('text', { hasText: new RegExp('^' + name + '$') }) });
const pick = async (name) => {
  await side.locator('.tree-line .label', { has: page.locator('.name', { hasText: new RegExp('^' + name + '$') }) }).first().click();
  await page.waitForFunction((n) => document.querySelector('.inspector input')?.value === n, name);
};
const settings = page.locator('.dialog.assistant-settings');
const review = page.locator('.dialog.proposal-review');
const card = (id) => panel.locator(`.proposal-card[data-proposal="${id}"]`);
const lastTurn = () => panel.locator('.assistant-turn').last();
const ask = async (q) => {
  await panel.getByLabel('Ask the assistant').fill(q);
  await panel.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(() => document.querySelector('aside.assistant .assistant-turn:last-of-type')?.getAttribute('data-streaming') === 'no' || [...document.querySelectorAll('aside.assistant .assistant-turn')].at(-1)?.getAttribute('data-streaming') === 'no');
};
const ttl = async () => flat(await page.locator('.rdf-code').innerText());

await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.node');

// ---------------------------------------------------------------- the panel, before it is set up
await page.locator('.header').getByRole('button', { name: 'Assistant' }).click();
await panel.waitFor();
ok(flat(await panel.locator('.assistant-notice').innerText()).includes('are sent to the provider you choose') && flat(await panel.locator('.assistant-notice').innerText()).includes('changes nothing without your approval'), 'the panel says what is sent, and that nothing is changed without approval');
ok((await panel.locator('.assistant-status .tag').innerText()) === 'not set up', 'it says it is not set up');
await ask('Hello?');
ok(flat(await lastTurn().innerText()).includes('The assistant is not set up: choose a provider and enter your API key'), 'asked before it is set up, it says what is missing, and sends nothing');
ok(seen.length === 0, 'nothing was sent anywhere');

// Wider and narrower from the keyboard, within its limits.
const width0 = await panel.evaluate((e) => e.getBoundingClientRect().width);
await panel.getByRole('separator', { name: 'Width of the assistant' }).focus();
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
const width1 = await panel.evaluate((e) => e.getBoundingClientRect().width);
ok(width1 === width0 + 48, `the panel is widened from the keyboard (${width0} to ${width1})`);
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
ok((await panel.evaluate((e) => e.getBoundingClientRect().width)) === 300, 'and narrowed, no narrower than 300 pixels');

// ---------------------------------------------------------------- set up, and the connection tested
await panel.getByRole('button', { name: 'Settings' }).click();
await settings.waitFor();
await settings.getByLabel('Provider', { exact: true }).selectOption({ label: 'OpenAI-compatible endpoint' });
await settings.getByLabel('Base URL').fill('http://example.org/v1');
ok(flat(await settings.innerText()).includes('https'), 'a custom endpoint over plain http elsewhere than this machine is refused: ' + flat(await settings.locator('.field small.bad').innerText()));
ok(await settings.getByRole('button', { name: 'Save' }).isDisabled(), 'and cannot be saved');
await settings.getByLabel('Base URL').fill(endpoint);
await settings.getByLabel('Model', { exact: true }).fill('fake-model');
await settings.getByLabel('API key').fill(KEY);
await settings.getByRole('button', { name: 'Test connection' }).click();
await settings.locator('[role=status]').waitFor();
ok(flat(await settings.locator('[role=status]').innerText()) === 'Connected. The provider has the model fake-model.', 'the connection is tested: ' + flat(await settings.locator('[role=status]').innerText()));
ok(seen.at(-1).auth === `Bearer ${KEY}`, 'with the key, sent to the endpoint chosen');
await page.screenshot({ path: shots + 'assistant-settings.png' });
await settings.getByRole('button', { name: 'Save' }).click();
await settings.waitFor({ state: 'detached' });
ok((await panel.locator('.assistant-status .tag').innerText()) === 'OpenAI-compatible endpoint · fake-model', 'it says the provider and model it uses: ' + (await panel.locator('.assistant-status .tag').innerText()));

// ---------------------------------------------------------------- an answer about the selection
await pick('Film');
ok(flat(await panel.locator('.assistant-compose .context').innerText()) === 'About the selection: Film', 'the composer says what the question will be about');
await ask('Explain the selected class.');
const explained = flat(await lastTurn().innerText());
ok(explained.includes('Looked at the selection') && !explained.includes('done') && explained.includes('Film is a class.'), 'it looked the selection up, and says what it found: ' + explained);
const asked = JSON.parse(seen.filter((s) => s.path === '/v1/chat/completions')[0].body);
ok(asked.messages[1].content.includes('[Editor context, not part of the question: the user has selected "Film"'), 'it was told what is selected, apart from the question');
ok(asked.tools.length === 10 && asked.tools.every((t) => t.type === 'function'), 'it was given the ten tools');
ok(JSON.stringify(asked).length < 20_000, `and not the ontology: the request is ${JSON.stringify(asked).length} characters`);
await lastTurn().locator('button.entity-ref', { hasText: 'Film' }).waitFor();
ok((await lastTurn().locator('.entity-ref.missing').innerText()).includes('not in the ontology'), 'a link to an IRI the ontology does not have is marked so, and opens nothing');
await pick('Person');
await lastTurn().locator('button.entity-ref', { hasText: 'Film' }).click();
await page.waitForFunction(() => document.querySelector('.inspector input')?.value === 'Film');
ok(true, 'an entity it names opens in the editor');

// ---------------------------------------------------------------- proposals: nothing changed until accepted
await page.getByRole('tab', { name: 'RDF' }).click();
const before = await ttl();
await ask('Add short films and feature films.');
await card('P2').waitFor();
ok((await panel.locator('.proposal-card').count()) === 2 && flat(await card('P1').innerText()).includes('Short films') && flat(await card('P1').innerText()).includes('to review'), 'two proposals, each to review: ' + flat(await card('P1').innerText()));
ok((await ttl()) === before && !(await ttl()).includes('Short'), 'proposing changes nothing');
await card('P1').getByRole('button', { name: 'Review…' }).click();
await review.waitFor();
const lines = (await review.locator('.review-lines li').allInnerTexts()).map(flat);
ok(lines.includes("+ Declaration(Class('Short film'))") || lines.some((l) => l.startsWith('+') && l.includes('Short film') && l.includes('SubClassOf Film')), 'the review lists the axioms it adds: ' + lines.join(' / '));
ok(flat(await review.innerText()).includes('No contradiction found before or after'), 'and what the reasoner finds');
await review.locator('.review-affected summary').first().click();
ok(flat(await review.locator('.before-after').first().innerText()).includes('Not in the ontology'), 'before and after, for each entity it touches');
await page.screenshot({ path: shots + 'assistant-review.png' });
await review.getByRole('button', { name: 'Accept' }).click();
await review.waitFor({ state: 'detached' });
ok(flat(await page.locator('.toast').innerText()).includes('Applied P1: Short films. Undo takes it back.'), 'accepted, it is applied, and says that undo takes it back');
ok(flat(await card('P1').innerText()).includes('applied'), 'its card says it is applied');
ok((await ttl()).includes('Short film') && (await ttl()).includes('rdfs:subClassOf'), 'the ontology has it');
await page.getByRole('tab', { name: 'Graph' }).click();
await node('Short film').waitFor();
ok(true, 'and so has the graph');
await page.getByRole('button', { name: 'Undo' }).click();
await node('Short film').waitFor({ state: 'detached' });
ok(true, 'one undo takes the whole of it back');
await page.getByRole('button', { name: 'Redo' }).click();
await node('Short film').waitFor();
ok(true, 'and redo puts it back');

// ---------------------------------------------------------------- out of date once the ontology has moved on
ok(flat(await card('P2').innerText()).includes('out of date') && (await card('P2').getByRole('button', { name: 'Accept' }).isDisabled()), 'the other proposal, checked before, is out of date and cannot be accepted');
await card('P2').getByRole('button', { name: 'Review…' }).click();
await page.keyboard.press('Escape');
await review.waitFor({ state: 'detached' });
ok(true, 'a review takes the focus as it opens, and Escape closes it');
await card('P2').getByRole('button', { name: 'Review…' }).click();
await review.getByRole('button', { name: 'Check again' }).click();
await review.locator('.tag', { hasText: 'to review' }).waitFor();
ok(!(await review.getByRole('button', { name: 'Accept' }).isDisabled()), 'checked again against the ontology as it is, it can be');
await review.getByRole('button', { name: 'Accept' }).click();
await node('Feature film').waitFor();
ok(true, 'and is applied');

// ---------------------------------------------------------------- what the reasoner finds, said before it is accepted
await ask('Make documentaries disjoint from films.');
await card('P3').waitFor();
ok(flat(await card('P3').innerText()).includes('makes 1 class unsatisfiable'), 'a proposal that makes a class unsatisfiable says so on its card: ' + flat(await card('P3').innerText()));
await card('P3').getByRole('button', { name: 'Review…' }).click();
ok(flat(await review.innerText()).includes('It makes unsatisfiable: Documentary.') && flat(await review.innerText()).includes('Documentary is a subclass of Film.'), 'and in its review, with the concern the assistant raised');
await review.getByRole('button', { name: 'Reject' }).click();
ok(flat(await card('P3').innerText()).includes('rejected'), 'rejected, it says so');
await page.getByRole('tab', { name: 'RDF' }).click();
ok(!(await ttl()).includes('disjointWith'), 'and changes nothing');

// ---------------------------------------------------------------- one that does not read: edited and checked again
await ask('Make directors filmmakers.');
await card('P4').waitFor();
ok(flat(await card('P4').innerText()).includes('does not read') && (await card('P4').getByRole('button', { name: 'Accept' }).isDisabled()), 'a proposal naming what the ontology does not have does not read, and cannot be accepted');
await card('P4').getByRole('button', { name: 'Review…' }).click();
ok(flat(await review.locator('.problems').innerText()).includes('Filmmaker'), 'its review says what does not read: ' + flat(await review.locator('.problems').innerText()));
await review.getByRole('button', { name: 'Edit' }).click();
await review.getByLabel('expression of operation 1').fill('directs min 1 Film');
await review.getByRole('button', { name: 'Check the edited proposal' }).click();
await review.locator('.tag', { hasText: 'to review' }).waitFor();
ok((await review.locator('.review-lines li').allInnerTexts()).map(flat).some((l) => l.includes('Director SubClassOf directs min 1 Film')), 'edited, it is checked again: ' + (await review.locator('.review-lines li').allInnerTexts()).map(flat).join(' / '));
await review.getByRole('button', { name: 'Accept' }).click();
await review.waitFor({ state: 'detached' });
ok(/owl:min(Qualified)?Cardinality/.test(await ttl()), 'and applied as edited');

// ---------------------------------------------------------------- stopped
await panel.getByLabel('Ask the assistant').fill('Tell me slowly about the model.');
await panel.getByRole('button', { name: 'Send' }).click();
await lastTurn().getByText('word3').waitFor();
await panel.getByRole('button', { name: 'Stop' }).click();
await lastTurn().getByText('Stopped.').waitFor();
await page.waitForTimeout(300);
ok(streamClosedEarly, 'stopped, the answer is cut off, and the request to the provider is closed');
await page.screenshot({ path: shots + 'assistant.png' });

// ---------------------------------------------------------------- each lookup shown first, and sent only when the user says so
await panel.getByRole('button', { name: 'Settings' }).click();
await settings.getByLabel('Show me each lookup, and send it only if I say so').check();
await settings.getByRole('button', { name: 'Save' }).click();
await settings.waitFor({ state: 'detached' });
ok(flat(await panel.locator('.assistant-notice').innerText()).includes('each lookup only once you have seen it and said so'), 'the panel says that each lookup is shown before it is sent');
await pick('Film');
const sentBefore = seen.length;
await panel.getByLabel('Ask the assistant').fill('Explain the selected class.');
await panel.getByRole('button', { name: 'Send' }).click();
const asking = panel.locator('.lookup-ask');
await asking.waitFor();
await asking.locator('summary').click();
ok(flat(await asking.innerText()).startsWith('Send to OpenAI-compatible endpoint? Looked at the selection') && (await asking.locator('pre').innerText()).includes('"selected"'), 'a lookup is shown, with what would be sent, before it is sent: ' + flat(await asking.innerText()).slice(0, 80));
await page.screenshot({ path: shots + 'assistant-lookup.png' });
await asking.getByRole('button', { name: 'Don’t send' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('aside.assistant .assistant-turn')].at(-1)?.getAttribute('data-streaming') === 'no');
const declined = JSON.parse(seen.slice(sentBefore).at(-1).body).messages.at(-1);
ok(declined.role === 'tool' && declined.content.includes('chose not to send') && !declined.content.includes('Film'), 'declined, the provider is told only that it was not sent, and nothing of the class: ' + declined.content.slice(0, 80));
ok(flat(await lastTurn().innerText()).includes('Looked at the selection · not sent') && flat(await lastTurn().innerText()).includes('You chose not to send'), 'and the answer says so');
await panel.getByLabel('Ask the assistant').fill('Explain the selected class.');
await panel.getByRole('button', { name: 'Send' }).click();
await asking.waitFor();
await asking.getByRole('button', { name: 'Send', exact: true }).click();
await page.waitForFunction(() => [...document.querySelectorAll('aside.assistant .assistant-turn')].at(-1)?.getAttribute('data-streaming') === 'no');
ok(flat(await lastTurn().innerText()).includes('Film is a class.'), 'sent, it is answered from');
await panel.getByRole('button', { name: 'Settings' }).click();
await settings.getByLabel('Show me each lookup, and send it only if I say so').uncheck();
await settings.getByRole('button', { name: 'Save' }).click();

// ---------------------------------------------------------------- the key: in no storage, file or export
const stored = await page.evaluate(async () => {
  const all = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.documentElement.outerHTML];
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((r) => {
      const q = indexedDB.open(name);
      q.onsuccess = () => r(q.result);
    });
    for (const s of db.objectStoreNames) all.push(JSON.stringify(await new Promise((r) => (db.transaction(s).objectStore(s).getAll().onsuccess = (e) => r(e.target.result)))));
    db.close();
  }
  return all.join('\n');
});
ok(stored.length > 1000 && !stored.includes(KEY), 'the key is in no storage of the browser, nor in the page');
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('conceptweaver:assistant')));
ok(JSON.stringify(kept) === JSON.stringify({ provider: 'custom', model: 'fake-model', transport: 'direct', baseUrl: endpoint }), 'the rest of the settings are kept, and only they: ' + JSON.stringify(kept));
const exported = [];
for (const item of [/^Download as JSON/, /^OWL \(Turtle\)/]) {
  await page.locator('.header').getByRole('button', { name: /^File/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item }).click()]);
  exported.push(fs.readFileSync(await download.path(), 'utf8'));
}
ok(exported.every((t) => t.length > 1000 && !t.includes(KEY) && !t.includes('fake-model')), 'nor in a file exported');

await page.reload();
await page.waitForSelector('.node');
ok((await panel.locator('.assistant-status .tag').innerText()) === 'OpenAI-compatible endpoint: no key yet', 'after a reload the panel is still open, the settings kept, and the key gone: ' + (await panel.locator('.assistant-status .tag').innerText()));
await panel.locator('.turn.user', { hasText: 'Make directors filmmakers.' }).waitFor();
ok((await panel.locator('.turn.user').count()) >= 6 && flat(await card('P4').innerText()).includes('applied') && flat(await card('P3').innerText()).includes('rejected'), 'and the conversation about this ontology is still there, with its proposals as they were left');

// ---------------------------------------------------------------- through the local service: the key held by it, and HermiT
const noJava = unavailable();
if (noJava) console.log('SKIP the local service: ' + noJava);
else {
  const PORT = 5166;
  let service = await startReasoner({ port: PORT, quiet: true, log: () => {}, allowLocalAi: true });
  await page.evaluate((u) => localStorage.setItem('conceptweaver:reasoner-url', u), service.url);
  await page.reload();
  await page.waitForSelector('.node');
  await panel.getByRole('button', { name: 'Settings' }).click();
  await settings.getByRole('radio', { name: /through the local service/ }).check();
  ok((await settings.getByLabel('Address of the local service').inputValue()) === service.url, 'requests through the local service go to the address the reasoner is asked at');
  await settings.getByLabel(/Let the local service hold the key/).check();
  await settings.getByLabel('API key').fill(KEY);
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.waitFor({ state: 'detached' });
  const where = await page.evaluate(() => ({ session: JSON.stringify({ ...sessionStorage }), local: JSON.stringify({ ...localStorage }) }));
  ok(!where.session.includes(KEY) && !where.local.includes(KEY) && /handle\\":\\"[A-Za-z0-9_-]{43}/.test(where.session), 'the service holds the key; this tab keeps only a handle to it');
  await page.reload();
  await page.waitForSelector('.node');
  ok((await panel.locator('.assistant-status .tag').innerText()) === 'OpenAI-compatible endpoint · fake-model', 'after a reload, the key the service holds is there still: ' + (await panel.locator('.assistant-status .tag').innerText()));
  const through = seen.length;
  await ask('Make documentaries win nothing.');
  await card('P5').waitFor();
  ok(seen.length > through && seen.slice(through).every((x) => x.auth === `Bearer ${KEY}`), 'asked through the service, the key it holds is set on each request it makes');
  ok(!flat(await card('P5').innerText()).includes('unsatisfiable'), 'the fast reasoner finds nothing wrong with a proposal that empties a class by a cardinality');
  await card('P5').getByRole('button', { name: 'Review…' }).click();
  await review.getByRole('button', { name: 'Check with HermiT' }).click();
  await review.locator('.logic.dl li.bad').waitFor({ timeout: 60_000 });
  ok(flat(await review.locator('.logic.dl').innerText()).includes('It makes unsatisfiable: Documentary.') && flat(await review.locator('.logic.dl').innerText()).includes('HermiT'), 'HermiT, asked about the ontology before and after, finds the class it makes unsatisfiable: ' + flat(await review.locator('.logic.dl').innerText()).slice(0, 120));
  await page.screenshot({ path: shots + 'assistant-hermit.png' });
  await review.getByRole('button', { name: 'Reject' }).click();
  ok(flat(await card('P5').innerText()).includes('HermiT: makes 1 class unsatisfiable'), 'and the card says so');

  // Restarted, the service holds no key: the handle is let go of, and the key asked for again.
  await service.stop();
  service = await startReasoner({ port: PORT, quiet: true, log: () => {}, allowLocalAi: true });
  await ask('Make documentaries win nothing.');
  ok(flat(await lastTurn().innerText()).includes('The local service: The key is no longer held') && (await panel.locator('.assistant-status .tag').innerText()) === 'OpenAI-compatible endpoint: no key yet', 'once the service has restarted, the key is asked for again: ' + flat(await lastTurn().innerText()).slice(0, 120));
  ok(!(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).includes('handle'), 'and the handle is let go of');
  await service.stop();
}
await panel.getByRole('button', { name: 'Hide the assistant' }).click();
ok((await panel.count()) === 0, 'it can be put away');

// The one refusal asked for above (a key the restarted service no longer holds) is logged by the browser as a failed load.
const unexpected = errors.filter((e) => !/Failed to load resource: the server responded with a status of 410/.test(e));
ok(unexpected.length === 0, 'no console errors' + (unexpected.length ? ': ' + unexpected.join(' | ') : ''));
await browser.close();
provider.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
