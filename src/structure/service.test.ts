import { describe, expect, it } from 'vitest';
import { StructureError, type HierarchyPage, type HierarchyQuery, type OntologyRef, type PathQuery, type StructureErrorCode } from './contracts';
import { graphOf, NS, wide } from './fixtures';
import type { ClassGraphInput } from './graph';
import { createGraphService, MAX_PAGE, PAGE } from './service';

const labels = (page: HierarchyPage) => page.nodes.map((n) => n.class.label);

/** A service over a graph that can be swapped for another, as an edit would. */
function serving(first: ClassGraphInput) {
  const state = { ref: { ontologyId: 'onto', revisionId: 'r1' } as OntologyRef, graph: first, built: 0 };
  const service = createGraphService(() => ({
    ...state.ref,
    graph: () => {
      state.built++;
      return state.graph;
    },
  }));
  const ask = (extra: Partial<HierarchyQuery> = {}): HierarchyQuery => ({ ...state.ref, mode: 'asserted', ...extra });
  const to = (name: string, limit?: number): PathQuery => ({ ...state.ref, mode: 'asserted', classIri: NS + name, ...(limit ? { limit } : {}) });
  return { service, state, ask, to };
}

const refused = async (p: Promise<unknown>): Promise<StructureErrorCode | 'answered'> => {
  try {
    await p;
    return 'answered';
  } catch (e) {
    if (e instanceof StructureError) return e.code;
    throw e;
  }
};

describe('the structure service', () => {
  it('answers with the classes at the top, and with the subclasses of a class', async () => {
    const { service, ask } = serving(graphOf('Person; Actor < Person; Employee < Person; WorkingActor < Actor, Employee; Film'));
    const top = await service.children(ask());
    expect(labels(top)).toEqual(['Film', 'Person']);
    expect(top.total).toBe(2);
    expect(top.nextCursor).toBeUndefined();
    expect(top.parentIri).toBeUndefined();
    const under = await service.children(ask({ parentIri: NS + 'Person' }));
    expect(labels(under)).toEqual(['Actor', 'Employee']);
    expect(under.parentIri).toBe(NS + 'Person');
    expect(under.nodes[0]).toEqual({ class: { iri: NS + 'Actor', label: 'Actor' }, equivalents: [], childCount: 1, parentCount: 1 });
    expect(under.offset).toBe(0);
  });

  it('says of everything asserted that no reasoner had a part in it and none of it is missing', async () => {
    const { service, ask, to } = serving(graphOf('Actor < Person'));
    const page = await service.children(ask());
    expect(page.provenance).toEqual({ engine: null, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [] });
    expect({ ontologyId: page.ontologyId, revisionId: page.revisionId, mode: page.mode }).toEqual({ ontologyId: 'onto', revisionId: 'r1', mode: 'asserted' });
    expect((await service.paths(to('Actor'))).provenance.engine).toBeNull();
  });

  it('gives a large list a page at a time, each class once, without ever giving all of it', async () => {
    const { service, ask } = serving(wide(5000));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.children(ask({ parentIri: NS + 'Top', ...(cursor ? { cursor } : {}) }));
      expect(page.nodes.length).toBeLessThanOrEqual(PAGE);
      expect(page.total).toBe(5000);
      seen.push(...labels(page));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(5000 / PAGE);
    expect(seen).toHaveLength(5000);
    expect(new Set(seen).size).toBe(5000);
    expect(seen).toEqual([...seen].sort());
  });

  it('holds a page to the size asked for, and to its own limit whatever is asked', async () => {
    const { service, ask } = serving(wide(5000));
    const small = await service.children(ask({ parentIri: NS + 'Top', limit: 7 }));
    expect(small.nodes).toHaveLength(7);
    const next = await service.children(ask({ parentIri: NS + 'Top', limit: 7, cursor: small.nextCursor }));
    expect(labels(next)[0]).toBe('K000007');
    expect((await service.children(ask({ parentIri: NS + 'Top', limit: 1_000_000 }))).nodes).toHaveLength(MAX_PAGE);
    expect(await refused(service.children(ask({ parentIri: NS + 'Top', cursor: 'somewhere' })))).toBe('invalid');
  });

  it('gives the page a wanted subclass is on, without what comes before it', async () => {
    const { service, ask } = serving(wide(5000));
    const wanted = `${NS}K003417`;
    const page = await service.children(ask({ parentIri: NS + 'Top', through: wanted }));
    expect(page.nodes.some((n) => n.class.iri === wanted)).toBe(true);
    expect(page.nodes).toHaveLength(PAGE);
    expect(page.offset).toBe(3400);
    expect(page.total).toBe(5000);
    expect(labels(await service.children(ask({ parentIri: NS + 'Top', cursor: page.nextCursor })))[0]).toBe('K003600');
    // One on the first page, or one that is not in the list at all, gives the first page.
    expect((await service.children(ask({ parentIri: NS + 'Top', through: `${NS}K000003` }))).offset).toBe(0);
    expect((await service.children(ask({ parentIri: NS + 'Top', through: NS + 'Nobody' }))).offset).toBe(0);
    // A page that is gone on from says where it starts.
    expect((await service.children(ask({ parentIri: NS + 'Top', cursor: page.nextCursor }))).offset).toBe(3600);
  });

  it('narrows to a search: what it finds, what leads to it, and how many it found', async () => {
    const { service, ask } = serving(graphOf('Person; Actor < Person; Employee < Person; WorkingActor < Actor, Employee; Film; Documentary < Film'));
    const top = await service.children(ask({ filter: '  Working ' }));
    expect(labels(top)).toEqual(['Person']);
    expect(top.matched).toBe(1);
    expect(top.total).toBe(1);
    const under = await service.children(ask({ parentIri: NS + 'Person', filter: 'working' }));
    expect(labels(under)).toEqual(['Actor', 'Employee']);
    expect(under.nodes.every((n) => n.childCount === 1 && !n.match)).toBe(true);
    expect((await service.children(ask({ parentIri: NS + 'Actor', filter: 'working' }))).nodes[0].match).toBe(true);
    const none = await service.children(ask({ filter: 'zebra' }));
    expect(none).toMatchObject({ nodes: [], total: 0, matched: 0 });
    // Without a filter nothing is said about matches.
    expect((await service.children(ask())).matched).toBeUndefined();
  });

  it('answers for several classes in one question, a page for each in the order asked', async () => {
    const { service, state, ask } = serving(graphOf('Person; Actor < Person; Employee < Person; WorkingActor < Actor, Employee; Film; Documentary < Film'));
    const pages = await service.branches({ ...state.ref, mode: 'asserted', parents: [{ parentIri: NS + 'Film' }, {}, { parentIri: NS + 'Person', limit: 1 }, { parentIri: NS + 'Actor' }] });
    expect(pages.map(labels)).toEqual([['Documentary'], ['Film', 'Person'], ['Actor'], ['WorkingActor']]);
    expect(pages.map((p) => p.parentIri)).toEqual([NS + 'Film', undefined, NS + 'Person', NS + 'Actor']);
    expect(pages[2]).toMatchObject({ total: 2, nextCursor: 'at:1' });
    // Each is what the single question would have given.
    expect(pages[0]).toEqual(await service.children(ask({ parentIri: NS + 'Film' })));
    // A search narrows all of them alike, and a wanted subclass is reached by its page.
    const narrowed = await service.branches({ ...state.ref, mode: 'asserted', filter: 'working', parents: [{}, { parentIri: NS + 'Person' }] });
    expect(narrowed.map(labels)).toEqual([['Person'], ['Actor', 'Employee']]);
    expect(narrowed.every((p) => p.matched === 1)).toBe(true);
    expect(await refused(service.branches({ ...state.ref, mode: 'asserted', parents: [{ parentIri: NS + 'Nobody' }] }))).toBe('not-found');
    expect(await refused(service.branches({ ...state.ref, revisionId: 'r0', mode: 'asserted', parents: [{}] }))).toBe('stale-revision');
    expect(await service.branches({ ...state.ref, mode: 'asserted', parents: [] })).toEqual([]);
  });

  it('gives the ways down to a class', async () => {
    const { service, to } = serving(graphOf('Person; Actor < Person; Employee < Person; WorkingActor < Actor, Employee'));
    const all = await service.paths(to('WorkingActor'));
    expect(all.paths.map((p) => p.map((x) => x.label).join(' > '))).toEqual(['Person > Actor > WorkingActor', 'Person > Employee > WorkingActor']);
    // Each step is a class as it is listed, by IRI, so that the way can be followed down the hierarchy.
    expect(all.paths[0][0]).toEqual({ iri: NS + 'Person', label: 'Person' });
    expect(all.truncated).toBe(false);
    expect((await service.paths(to('WorkingActor', 1))).truncated).toBe(true);
  });

  it('refuses a class that is not there, a question that was given up, and a hierarchy it does not have', async () => {
    const { service, ask, to } = serving(graphOf('Actor < Person'));
    expect(await refused(service.children(ask({ parentIri: NS + 'Nobody' })))).toBe('not-found');
    expect(await refused(service.paths(to('Nobody')))).toBe('not-found');
    const abort = new AbortController();
    abort.abort();
    expect(await refused(service.children(ask(), { signal: abort.signal }))).toBe('aborted');
    // The inferred hierarchy is not built yet: asking for it is refused, never answered with the asserted one.
    expect(await refused(service.children({ ...ask(), mode: 'inferred' }))).toBe('unsupported');
  });

  it('answers only for the revision the ontology is at, and builds each revision once', async () => {
    const { service, state, ask, to } = serving(graphOf('Actor < Person'));
    const before = ask();
    expect(labels(await service.children(before))).toEqual(['Person']);
    await service.children(ask({ parentIri: NS + 'Person' }));
    await service.paths(to('Actor'));
    expect(state.built).toBe(1);

    // An edit: Person now has a superclass.
    state.graph = graphOf('Actor < Person; Person < Agent');
    state.ref = { ontologyId: 'onto', revisionId: 'r2' };
    expect(await refused(service.children(before))).toBe('stale-revision');
    expect(labels(await service.children(ask()))).toEqual(['Agent']);
    expect(state.built).toBe(2);

    // Undo: back at the first revision, which is still there to answer from.
    state.graph = graphOf('Actor < Person');
    state.ref = { ontologyId: 'onto', revisionId: 'r1' };
    expect(labels(await service.children(before))).toEqual(['Person']);
    expect(state.built).toBe(2);
    // Another ontology altogether is another question, whatever its revision is called.
    expect(await refused(service.children({ ...before, ontologyId: 'other' }))).toBe('stale-revision');
  });
});
