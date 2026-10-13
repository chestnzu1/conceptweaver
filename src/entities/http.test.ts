import { describe, expect, it } from 'vitest';
import { EntityQueryError, ON, type EntityQueryService } from './contracts';
import { answerEntityRequest, createHttpEntityService, QUESTIONS } from './http';
import { createRecordService, type EntityRecord } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };
const RECORDS: EntityRecord[] = ['Party', 'Person', 'Organisation', 'Clerk'].map((label, i) => ({
  key: label.toLowerCase(),
  iri: 'http://example.org/onto#' + label,
  label,
  texts: [{ field: 'name', text: label }, { field: 'iri', text: 'http://example.org/onto#' + label }],
  sort: { name: label, subclasses: 3 - i },
  facts: { leaf: i === 3 ? [ON] : [], member: i % 2 ? ['party'] : [] },
}));

/** A service held in memory, and the same service asked over HTTP: every question and answer goes through JSON, as it would to a backend. */
function services() {
  const local = createRecordService(() => ({
    ...REF,
    records: () => RECORDS,
    sorts: () => [{ id: 'name', label: 'Name' }, { id: 'subclasses', label: 'Subclasses', numeric: true }],
    filters: () => [
      { id: 'leaf', label: 'Leaf', about: 'No subclass.', type: 'flag', options: [{ value: ON, label: 'Yes', count: 1 }] },
      { id: 'member', label: 'Member of', about: 'A member.', type: 'any', options: [], entities: true },
    ],
    costly: (_kind, filter) => (filter === 'leaf' ? { facts: new Map([['clerk', [ON]]]), note: 'As a reasoner has it.' } : undefined),
    candidates: () => [{ value: 'party', label: 'Party', count: 2, text: 'party' }],
  }));
  const sent: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url, body });
    const answer = await answerEntityRequest(local, url.slice(url.lastIndexOf('/') + 1), body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { local, remote: createHttpEntityService('http://backend.example/api/', send), sent };
}

describe('the entity query service over HTTP', () => {
  it('gives the same answer to every question as the service it is put in front of', async () => {
    const { local, remote, sent } = services();
    const both = async <T>(ask: (s: EntityQueryService) => Promise<T>) => {
      const [here, there] = [await ask(local), await ask(remote)];
      expect(there).toEqual(here);
      return there;
    };
    await both((s) => s.describe({ ...REF, kind: 'class' }));
    const page = await both((s) => s.query({ ...REF, kind: 'class', search: 'p', sort: { by: 'subclasses', dir: 'desc' }, filters: { member: ['party'] }, offset: 0, limit: 10 }));
    expect(page.rows.map((r) => r.label)).toEqual(['Person']);
    expect((await both((s) => s.query({ ...REF, kind: 'class', filters: { leaf: [ON] } }))).notes).toEqual(['As a reasoner has it.']);
    await both((s) => s.options({ ...REF, kind: 'class', filter: 'member', search: 'par' }));
    expect(sent.map((x) => x.url)).toEqual(['http://backend.example/api/entities/describe', 'http://backend.example/api/entities/query', 'http://backend.example/api/entities/query', 'http://backend.example/api/entities/options']);
    // The whole of a question is in what is sent: nothing is narrowed or put in order on this side.
    expect(sent[1].body).toEqual({ ...REF, kind: 'class', search: 'p', sort: { by: 'subclasses', dir: 'desc' }, filters: { member: ['party'] }, offset: 0, limit: 10 });
    expect(QUESTIONS).toEqual(['describe', 'query', 'options']);
  });

  it('refuses over the wire what the service refuses, by the same code', async () => {
    const { local, remote } = services();
    const code = async (run: (s: EntityQueryService) => Promise<unknown>) => {
      const of = (s: EntityQueryService) => run(s).then(() => 'answered', (e) => (e instanceof EntityQueryError ? e.code : 'other: ' + e));
      const [here, there] = [await of(local), await of(remote)];
      expect(there).toBe(here);
      return there;
    };
    expect(await code((s) => s.query({ ...REF, revisionId: 'r0', kind: 'class' }))).toBe('stale-revision');
    expect(await code((s) => s.query({ ...REF, kind: 'class', sort: { by: 'colour', dir: 'asc' } }))).toBe('invalid');
    expect(await code((s) => s.options({ ...REF, kind: 'class', filter: 'leaf' }))).toBe('invalid');
    expect(await answerEntityRequest(local, 'delete', {})).toMatchObject({ status: 404 });
    expect(await answerEntityRequest(local, 'query', { ...REF, revisionId: 'r0', kind: 'class' })).toEqual({ status: 409, body: { code: 'stale-revision', message: 'The ontology has changed since this was asked about.' } });
    const gone = new AbortController();
    gone.abort();
    await expect(remote.query({ ...REF, kind: 'class' }, { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});
