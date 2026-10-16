import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withIris } from '../model/iri';
import { toTurtle } from '../model/rdf';
import { sampleModel } from '../model/sample';
import { useStore } from '../model/store';
import type { Model } from '../model/types';
import { bounded, DECLINED, respond, selectionLine, SYSTEM } from './conversation';
import type { ChatRequest, ChatResult, ProviderAdapter } from './providers/contracts';
import { forgetKey } from './providers/http';
import { storedConversation } from '../model/library';
import { ontologyKey, proposalKey, useAssistant } from './state';

/** The assistant's loop over a scripted model: tools, a proposal, and nothing changed until the user accepts. */

const NS = 'http://example.org/film-knowledge-graph#';

// What the browser keeps, for these tests: a plain store with the Storage interface.
const kept = new Map<string, string>();
globalThis.localStorage ??= { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, String(v)), removeItem: (k: string) => void kept.delete(k), clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null, get length() { return kept.size; } } as Storage;
const everythingKept = () => JSON.stringify([...kept.entries()]);

/** A model that answers from a script: each call takes the next answer, and every request is kept. */
function scripted(answers: ChatResult[]) {
  const asked: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    async chat(request, options) {
      asked.push(JSON.parse(JSON.stringify(request)));
      const a = answers.shift() ?? { text: 'Done.', toolCalls: [], stop: 'end' };
      if (a.text) options?.onEvent?.({ type: 'text', text: a.text });
      return a;
    },
    async test() {
      return { detail: 'ok' };
    },
  };
  return { adapter, asked };
}

const st = useStore.getState;
beforeEach(() => {
  st().replaceModel(withIris(sampleModel()));
  forgetKey();
});

describe('an answer', () => {
  it('looks the ontology up through the tools, and is told the selection', async () => {
    const film = st().model.terms.find((t) => t.name === 'Film')!;
    st().select([film.id]);
    const { adapter, asked } = scripted([
      { text: '', toolCalls: [{ id: 'a', name: 'getSelectedEntity', arguments: {} }], stop: 'tool' },
      { text: 'Film is a class: [Film](' + NS + 'Film).', toolCalls: [], stop: 'end' },
    ]);
    const { ontologyContext } = await import('./state');
    const messages = await respond(adapter, [], 'Explain the selected class.', { context: ontologyContext, propose: async () => ({ id: 'x', review: { errors: [], refusals: [], notes: [], lines: [], affected: [] } }) });
    expect(asked[0].system).toBe(SYSTEM);
    expect(asked[0].tools.map((t) => t.name)).toEqual(['getOntologySummary', 'searchEntities', 'getEntityDetails', 'getClassHierarchy', 'getPropertyAxioms', 'getSelectedEntity', 'getRestrictions', 'getImports', 'getValidationResults', 'proposeChanges']);
    expect((asked[0].messages[0] as { text: string }).text).toContain(`the user has selected "Film" <${NS}Film>`);
    const result = JSON.parse((messages[2] as { result: string }).result);
    expect(result.selected).toMatchObject({ name: 'Film', iri: NS + 'Film', kind: 'class' });
    expect(messages[3]).toMatchObject({ role: 'assistant', text: expect.stringContaining('[Film](') });
  });

  it('sends a bounded part of a large ontology, never the whole of it', async () => {
    const m = st().model;
    const big: Model = { ...m, terms: [...m.terms, ...Array.from({ length: 6000 }, (_x, i) => ({ ...m.terms[0], id: `b${i}`, name: `Class ${i}`, iri: `${NS}C${i}`, description: 'x'.repeat(200) }))] };
    st().replaceModel(big);
    const { adapter, asked } = scripted([
      { text: '', toolCalls: [{ id: 'a', name: 'getOntologySummary', arguments: {} }, { id: 'b', name: 'searchEntities', arguments: { query: 'class' } }], stop: 'tool' },
      { text: 'It has 6,008 classes.', toolCalls: [], stop: 'end' },
    ]);
    const { ontologyContext } = await import('./state');
    await respond(adapter, [], 'How big is it?', { context: ontologyContext, propose: async () => ({ id: 'x', review: { errors: [], refusals: [], notes: [], lines: [], affected: [] } }) });
    const sent = JSON.stringify(asked[1]).length;
    expect(toTurtle(big).length).toBeGreaterThan(1_000_000);
    expect(sent).toBeLessThan(40_000);
  });

  it('sends a lookup only once the user says so, where they asked to see each first', async () => {
    const film = st().model.terms.find((t) => t.name === 'Film')!;
    const { adapter, asked } = scripted([
      { text: '', toolCalls: [{ id: 'a', name: 'getEntityDetails', arguments: { iri: NS + 'Film' } }, { id: 'b', name: 'getEntityDetails', arguments: { iri: NS + 'Person' } }], stop: 'tool' },
      { text: 'Done.', toolCalls: [], stop: 'end' },
    ]);
    const { ontologyContext } = await import('./state');
    const shown: string[] = [];
    await respond(adapter, [], 'Compare Film and Person.', { context: ontologyContext, propose: async () => ({ id: 'x', review: { errors: [], refusals: [], notes: [], lines: [], affected: [] } }) }, {
      // The first is declined, the second sent.
      approve: async (call, result) => {
        shown.push(result);
        return (call.arguments as { iri: string }).iri.endsWith('#Person');
      },
    });
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain(film.description);
    const sent = JSON.stringify(asked[1]);
    expect(sent).not.toContain(film.description);
    expect(sent).toContain(JSON.stringify(DECLINED).slice(1, 40));
    expect(sent).toContain('A human being involved in making films.');
  });

  it('shortens the results of tools of earlier questions, and never sends a result without its call', () => {
    const long = 'y'.repeat(2000);
    const kept = bounded([
      { role: 'user', text: 'one' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 't', arguments: {} }] },
      { role: 'tool', callId: 'a', name: 't', result: long },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'two' },
    ]);
    expect((kept[2] as { result: string }).result.length).toBeLessThan(500);
    expect(selectionLine({ model: st().model, loadedImports: [] })).toBe('');
  });
});

describe('a change asked for', () => {
  it('becomes a proposal that changes nothing until it is accepted; accepted, it is one edit that undo takes back', async () => {
    useAssistant.getState().configure({ provider: 'openai', model: 'm', transport: 'direct' }, 'sk-secret-key-1234');
    const before = toTurtle(st().model);
    const { adapter } = scripted([
      {
        text: '',
        toolCalls: [{ id: 'p', name: 'proposeChanges', arguments: { summary: 'Short films', explanation: 'A film under 40 minutes.', impact: 'Short films are films.', concerns: [], operations: [{ action: 'add', type: 'declare', entityKind: 'class', name: 'Short film' }, { action: 'add', type: 'subClassOf', subject: "'Short film'", expression: 'Film' }] } }],
        stop: 'tool',
      },
      { text: 'I proposed P1 for your review.', toolCalls: [], stop: 'end' },
    ]);
    const { ontologyContext } = await import('./state');
    let id = '';
    const host = {
      context: ontologyContext,
      propose: async (input: Parameters<Parameters<typeof respond>[3]['propose']>[0]) => {
        const r = await import('./proposals').then((m) => m.review(st().model, input));
        id = 'P-test';
        useAssistant.setState((s) => ({ proposals: { ...s.proposals, [proposalKey(id)]: { id, input, review: r, status: 'pending', ontology: ontologyKey(), revision: r.changeSet?.baseRevision ?? '', created: 0 } } }));
        return { id, review: r };
      },
    };
    const messages = await respond(adapter, [], 'Add short films.', host);
    expect(JSON.parse((messages[2] as { result: string }).result)).toMatchObject({ proposal: 'P-test', status: expect.stringMatching(/^ready for the user to review/) });
    // Nothing is changed by proposing.
    expect(toTurtle(st().model)).toBe(before);
    expect(await useAssistant.getState().accept(id)).toBeUndefined();
    expect(st().model.terms.some((t) => t.name === 'Short film')).toBe(true);
    expect(useAssistant.getState().proposals[proposalKey(id)].status).toBe('applied');
    st().undo();
    expect(toTurtle(st().model)).toBe(before);
    // The key is in memory only: not in what is kept in the browser, nor in the model.
    expect(everythingKept()).not.toContain('sk-secret-key-1234');
    expect(JSON.stringify(st().model)).not.toContain('sk-secret-key-1234');
    expect(localStorage.getItem('conceptweaver:assistant')).toContain('"provider":"openai"');
  });

  it('is refused once the ontology has changed since it was checked', async () => {
    const { review } = await import('./proposals');
    const r = await review(st().model, { summary: 'x', operations: [{ action: 'add', type: 'subClassOf', subject: 'Genre', expression: 'Award' }] });
    useAssistant.setState((s) => ({ proposals: { ...s.proposals, [proposalKey('Pstale')]: { id: 'Pstale', input: { summary: 'x', explanation: '', impact: '', concerns: [], operations: [] }, review: r, status: 'pending', ontology: ontologyKey(), revision: r.changeSet!.baseRevision, created: 0 } } }));
    st().updateTerm(st().model.terms[0].id, { description: 'Changed meanwhile.' });
    expect(await useAssistant.getState().accept('Pstale')).toMatch(/has changed since this proposal was checked/);
    expect(useAssistant.getState().proposals[proposalKey('Pstale')].status).toBe('stale');
  });
});

describe('a conversation', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A provider speaking OpenAI's API, answering from a script, in place of the network. */
  const provider = (answers: object[][]) =>
    vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-kept-test-77');
      const chunks = answers.shift() ?? [{ choices: [{ delta: { content: 'Done.' } }] }];
      const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(new Blob([body]).stream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

  it('is kept for its ontology with its proposals, read again in a later session, its proposals checked again before they are accepted', async () => {
    const a = useAssistant.getState;
    a().configure({ provider: 'custom', model: 'm', baseUrl: 'http://127.0.0.1:9/v1', transport: 'direct' }, 'sk-kept-test-77');
    const operations = [{ action: 'add', type: 'declare', entityKind: 'class', name: 'Short film' }, { action: 'add', type: 'subClassOf', subject: "'Short film'", expression: 'Film' }];
    vi.stubGlobal('fetch', provider([[{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'p', function: { name: 'proposeChanges', arguments: JSON.stringify({ summary: 'Short films', explanation: 'e', impact: 'i', operations }) } }] }, finish_reason: 'tool_calls' }] }], [{ choices: [{ delta: { content: 'I proposed P1.' } }] }]]));
    await a().load();
    a().clear();
    await a().ask('Add short films.');
    const key = ontologyKey();
    expect(a().conversations[key].turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(a().proposals[proposalKey('P1')]).toMatchObject({ id: 'P1', status: 'pending' });
    await vi.waitFor(async () => expect((await storedConversation(key))?.proposals).toHaveLength(1));
    const kept = JSON.stringify(await storedConversation(key));
    expect(kept).toContain('I proposed P1.');
    expect(kept).not.toContain('sk-kept-test-77');

    // A later session: nothing in memory, the conversation read from what was kept.
    useAssistant.setState({ conversations: {}, proposals: {} });
    await a().load();
    expect(a().conversations[key].turns[1].text).toBe('I proposed P1.');
    expect(a().proposals[proposalKey('P1')].status).toBe('stale');
    expect(await a().accept('P1')).toMatch(/cannot be applied as it is/);
    await a().recheck('P1');
    expect(a().proposals[proposalKey('P1')].status).toBe('pending');
    expect(await a().accept('P1')).toBeUndefined();
    expect(st().model.terms.some((t) => t.name === 'Short film')).toBe(true);

    // Cleared, it is gone, kept or not.
    a().clear();
    await vi.waitFor(async () => expect(await storedConversation(key)).toBeUndefined());
    expect(Object.keys(a().proposals).filter((k) => k.startsWith(key + ' '))).toEqual([]);
  });
});
