import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_NODES, GraphError, MAX_DEPTH, MAX_NODES, type NeighbourhoodQuery } from './contracts';
import { MAX_SEARCH_LIMIT, SEARCH_LIMIT, createNeighbourhoodService, type NeighbourhoodPlan, type SearchPlan } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };

/** A source that answers with what it was asked, and keeps the plan it was given. */
function source(ref = REF) {
  const plans: { neighbourhood?: NeighbourhoodPlan; search?: SearchPlan } = {};
  return {
    plans,
    source: {
      ...ref,
      neighbourhood: (q: NeighbourhoodPlan) => {
        plans.neighbourhood = q;
        return { terms: q.roots.slice(0, q.maxNodes), rels: [], via: { [q.roots[1] ?? 'x']: q.roots[0] ?? 'y' }, more: {}, truncated: q.roots.length > q.maxNodes };
      },
      search: (q: SearchPlan) => {
        plans.search = q;
        return { matches: [{ id: 'a', name: 'A', type: 'concept' }] };
      },
      kinds: () => ({ kinds: [{ key: 'plain', label: 'Plain relationships', count: 2 }] }),
    },
  };
}

const ask = (over: Partial<NeighbourhoodQuery> = {}): NeighbourhoodQuery => ({ ...REF, roots: ['a', 'b'], depth: 1, direction: 'both', ...over });

describe('the graph service', () => {
  it('puts the revision asked about in every answer, and answers in plain data', async () => {
    const { source: s } = source();
    const service = createNeighbourhoodService(() => s);
    expect(await service.neighbourhood(ask())).toEqual({ ...REF, terms: ['a', 'b'], rels: [], via: { b: 'a' }, more: {}, truncated: false });
    expect(await service.search({ ...REF, text: 'a' })).toEqual({ ...REF, matches: [{ id: 'a', name: 'A', type: 'concept' }] });
    expect(await service.kinds(REF)).toEqual({ ...REF, kinds: [{ key: 'plain', label: 'Plain relationships', count: 2 }] });
  });

  it('fills in and clamps what a subgraph may ask for', async () => {
    const { source: s, plans } = source();
    const service = createNeighbourhoodService(() => s);
    await service.neighbourhood(ask({ roots: ['a', 'a', 'b'], depth: 99, maxNodes: 0 }));
    expect(plans.neighbourhood).toMatchObject({ roots: ['a', 'b'], depth: MAX_DEPTH, maxNodes: DEFAULT_MAX_NODES, off: [], expanded: [], hidden: [] });
    // 0 is a depth: the roots alone. Nothing asked for is an ordinary walk.
    await service.neighbourhood(ask({ depth: 0, maxNodes: 10_000 }));
    expect(plans.neighbourhood).toMatchObject({ depth: 0, maxNodes: MAX_NODES });
    await service.neighbourhood(ask({ depth: -3, maxNodes: -1 }));
    expect(plans.neighbourhood).toMatchObject({ depth: 0, maxNodes: 1 });
  });

  it('leaves a search its language, and clamps how much it gives', async () => {
    const { source: s, plans } = source();
    const service = createNeighbourhoodService(() => s);
    await service.search({ ...REF, text: 'par', lang: 'nl' });
    expect(plans.search).toEqual({ text: 'par', limit: SEARCH_LIMIT, lang: 'nl' });
    await service.search({ ...REF, text: 'par', limit: 500 });
    expect(plans.search?.limit).toBe(MAX_SEARCH_LIMIT);
    await service.search({ ...REF, text: 'par', limit: 0 });
    expect(plans.search?.limit).toBe(SEARCH_LIMIT);
  });

  it('refuses a revision the ontology has left, and a question given up', async () => {
    const { source: s } = source();
    const service = createNeighbourhoodService(() => s);
    await expect(service.neighbourhood(ask({ revisionId: 'r0' }))).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(service.search({ ...REF, text: 'a', ontologyId: 'other' })).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(service.kinds({ ...REF, revisionId: 'r2' })).rejects.toBeInstanceOf(GraphError);
    const gone = new AbortController();
    gone.abort();
    await expect(service.neighbourhood(ask(), { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('refuses a direction that is not one', async () => {
    const { source: s } = source();
    const service = createNeighbourhoodService(() => s);
    await expect(service.neighbourhood(ask({ direction: 'sideways' as NeighbourhoodQuery['direction'] }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('answers for the ontology as it is when each question is put', async () => {
    let now = source();
    const service = createNeighbourhoodService(() => now.source);
    const before = await service.neighbourhood(ask());
    now = source({ ontologyId: REF.ontologyId, revisionId: 'r2' });
    await expect(service.neighbourhood(ask({ revisionId: before.revisionId }))).rejects.toMatchObject({ code: 'stale-revision' });
    expect((await service.neighbourhood(ask({ revisionId: 'r2' }))).revisionId).toBe('r2');
  });
});
