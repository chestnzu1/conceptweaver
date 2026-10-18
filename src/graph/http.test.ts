import { describe, expect, it } from 'vitest';
import { GraphError, MAX_DEPTH, type GraphService, type NeighbourhoodQuery } from './contracts';
import { answerGraphRequest, createHttpGraphService, QUESTIONS } from './http';
import { createNeighbourhoodService } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };
const ask = (over: Partial<NeighbourhoodQuery> = {}): NeighbourhoodQuery => ({ ...REF, roots: ['a', 'b'], depth: 1, direction: 'both', ...over });

/** A service held in memory, and the same service asked over HTTP: every question and answer goes through JSON, as it would to a backend. */
function services() {
  const local = createNeighbourhoodService(() => ({
    ...REF,
    neighbourhood: (q) => ({ terms: q.roots.slice(0, q.maxNodes), rels: [], via: { b: 'a' }, more: { a: 4 }, truncated: q.roots.length > q.maxNodes }),
    search: (q) => ({ matches: [{ id: 'a', name: (q.text || 'a').toUpperCase(), type: 'concept' }] }),
    kinds: () => ({ kinds: [{ key: 'plain', label: 'Plain relationships', count: 1 }] }),
  }));
  const sent: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url, body });
    const answer = await answerGraphRequest(local, url.slice(url.lastIndexOf('/') + 1), body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { local, remote: createHttpGraphService('http://backend.example/api/', send), sent };
}

describe('the graph service over HTTP', () => {
  it('gives the same answer to every question as the service it is put in front of', async () => {
    const { local, remote, sent } = services();
    const both = async <T>(ask: (s: GraphService) => Promise<T>) => {
      const [here, there] = [await ask(local), await ask(remote)];
      expect(there).toEqual(here);
      return there;
    };
    const walked = await both((s) => s.neighbourhood(ask()));
    expect(walked).toMatchObject({ terms: ['a', 'b'], via: { b: 'a' }, more: { a: 4 } });
    await both((s) => s.search({ ...REF, text: 'film', lang: 'nl' }));
    await both((s) => s.kinds(REF));
    expect(sent.map((x) => x.url)).toEqual(['http://backend.example/api/graph/neighbourhood', 'http://backend.example/api/graph/search', 'http://backend.example/api/graph/kinds']);
    // The whole of a question is in what is sent: nothing is narrowed on this side.
    expect(sent[0].body).toEqual(ask());
    expect(sent[1].body).toEqual({ ...REF, text: 'film', lang: 'nl' });
    expect(QUESTIONS).toEqual(['neighbourhood', 'search', 'kinds']);
  });

  it('refuses over the wire what the service refuses, by the same code', async () => {
    const { local, remote } = services();
    const code = async (run: (s: GraphService) => Promise<unknown>) => {
      const of = (s: GraphService) => run(s).then(() => 'answered', (e) => (e instanceof GraphError ? e.code : 'other: ' + e));
      const [here, there] = [await of(local), await of(remote)];
      expect(there).toBe(here);
      return there;
    };
    expect(await code((s) => s.neighbourhood(ask({ revisionId: 'r0' })))).toBe('stale-revision');
    expect(await code((s) => s.neighbourhood(ask({ direction: 'sideways' as NeighbourhoodQuery['direction'] })))).toBe('invalid');
    expect(await answerGraphRequest(local, 'delete', {})).toMatchObject({ status: 404 });
    expect(await answerGraphRequest(local, 'neighbourhood', ask({ revisionId: 'r0' }))).toEqual({ status: 409, body: { code: 'stale-revision', message: 'The ontology has changed since this was asked about.' } });
    const gone = new AbortController();
    gone.abort();
    await expect(remote.neighbourhood(ask(), { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
    // A depth is clamped on the way, so both ends answer the same walk.
    expect((await local.neighbourhood(ask({ depth: 99 }))).terms).toEqual((await remote.neighbourhood(ask({ depth: MAX_DEPTH }))).terms);
  });
});
