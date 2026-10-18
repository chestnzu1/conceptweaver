import { describe, expect, it } from 'vitest';
import { StructureError, type HierarchyPage, type HierarchyQuery, type OntologyRef, type PathQuery, type PropertyHierarchyPage, type PropertyHierarchyQuery, type PropertyPathQuery, type StructureErrorCode } from './contracts';
import { graphOf, NS, wide } from './fixtures';
import type { ClassGraphInput } from './graph';
import type { PropertyGraphInput } from './propertyGraph';
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

// ---------------------------------------------------------------- the property hierarchy

const propLabels = (page: PropertyHierarchyPage) => page.nodes.map((n) => n.property.label);
const prop = (name: string, type: 'object' | 'data' = 'object', search?: string[]) => ({ ref: { iri: NS + name, label: name, type }, ...(search ? { search } : {}) });
const links = (...pairs: [string, string][]) => pairs.map(([sub, sup]) => ({ sub: NS + sub, sup: NS + sup }));

/** A property hierarchy of a few named properties: related to > works for > employed by, and age at the top. */
const PROPS: PropertyGraphInput = {
  properties: [prop('related to'), prop('works for', 'object', ['employment']), prop('employed by'), prop('age', 'data')],
  subPropertyOf: links(['works for', 'related to'], ['employed by', 'works for']),
};

/** A service over a property hierarchy that can be swapped for another, as an edit would. */
function servingProps(first: PropertyGraphInput) {
  const state = { ref: { ontologyId: 'onto', revisionId: 'r1' } as OntologyRef, props: first, built: 0 };
  const service = createGraphService(() => ({
    ...state.ref,
    graph: () => graphOf(''),
    properties: () => {
      state.built++;
      return state.props;
    },
  }));
  const ask = (extra: Partial<PropertyHierarchyQuery> = {}): PropertyHierarchyQuery => ({ ...state.ref, ...extra });
  const to = (name: string, limit?: number): PropertyPathQuery => ({ ...state.ref, propertyIri: NS + name, ...(limit ? { limit } : {}) });
  return { service, state, ask, to };
}

/** `Top` with `n` direct subproperties, numbered so that label order is number order. */
function wideProps(n: number): PropertyGraphInput {
  const input: PropertyGraphInput = { properties: [prop('Top')], subPropertyOf: [] };
  for (let i = 0; i < n; i++) {
    const iri = `${NS}P${String(i).padStart(6, '0')}`;
    input.properties.push({ ref: { iri, label: iri.slice(NS.length), type: 'object' } });
    input.subPropertyOf.push({ sub: iri, sup: NS + 'Top' });
  }
  return input;
}

describe('the property hierarchy of the structure service', () => {
  it('answers with the properties at the top, and with the subproperties of a property', async () => {
    const { service, ask } = servingProps(PROPS);
    const top = await service.propertyChildren(ask());
    expect(propLabels(top)).toEqual(['age', 'related to']);
    expect(top).toMatchObject({ total: 2, offset: 0 });
    expect(top.parentIri).toBeUndefined();
    expect(top.provenance).toEqual({ engine: null, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [] });
    const under = await service.propertyChildren(ask({ parentIri: NS + 'related to' }));
    expect(propLabels(under)).toEqual(['works for']);
    expect(under.parentIri).toBe(NS + 'related to');
    expect(under.nodes[0]).toEqual({ property: { iri: NS + 'works for', label: 'works for', type: 'object' }, childCount: 1, parentCount: 1 });
    // It is one hierarchy, of both object and data properties, and it is the stated one.
    expect((await service.propertyChildren(ask({ parentIri: NS + 'works for' }))).nodes[0]).toMatchObject({ property: { label: 'employed by', type: 'object' }, childCount: 0 });
    expect((await service.propertyChildren(ask())).nodes.some((n) => n.property.type === 'data')).toBe(true);
  });

  it('gives a large list a page at a time, and the page a wanted property is on', async () => {
    const { service, ask } = servingProps(wideProps(2500));
    const first = await service.propertyChildren(ask({ parentIri: NS + 'Top' }));
    expect(first.nodes).toHaveLength(PAGE);
    expect(first).toMatchObject({ total: 2500, nextCursor: `at:${PAGE}`, offset: 0 });
    const next = await service.propertyChildren(ask({ parentIri: NS + 'Top', cursor: first.nextCursor }));
    expect(next.offset).toBe(PAGE);
    expect(propLabels(next)[0]).toBe('P000200');
    expect((await service.propertyChildren(ask({ parentIri: NS + 'Top', limit: 1_000_000 }))).nodes).toHaveLength(MAX_PAGE);
    // The page the wanted property is on, without what comes before it.
    const wanted = `${NS}P001717`;
    const page = await service.propertyChildren(ask({ parentIri: NS + 'Top', through: wanted }));
    expect(page.offset).toBe(1600);
    expect(page.nodes.some((n) => n.property.iri === wanted)).toBe(true);
    expect((await service.propertyChildren(ask({ parentIri: NS + 'Top', through: `${NS}P000003` }))).offset).toBe(0);
    expect((await service.propertyChildren(ask({ parentIri: NS + 'Top', through: NS + 'Nobody' }))).offset).toBe(0);
    expect(await refused(service.propertyChildren(ask({ parentIri: NS + 'Top', cursor: 'somewhere' })))).toBe('invalid');
  });

  it('narrows to a search: what it finds, what leads to it, and how many it found', async () => {
    const { service, ask } = servingProps(PROPS);
    const top = await service.propertyChildren(ask({ filter: '  Employ ' }));
    expect(propLabels(top)).toEqual(['related to']);
    // "works for" is found by the other text it is known by, and "employed by" by its label.
    expect(top).toMatchObject({ matched: 2, total: 1 });
    const under = await service.propertyChildren(ask({ parentIri: NS + 'related to', filter: 'employed' }));
    expect(propLabels(under)).toEqual(['works for']);
    expect(under.nodes[0]).toMatchObject({ childCount: 1 });
    expect(under.nodes[0].match).toBeUndefined();
    expect((await service.propertyChildren(ask({ parentIri: NS + 'works for', filter: 'employ' }))).nodes[0]).toMatchObject({ match: true });
    // A search also finds a property by the other text it is known by.
    expect((await service.propertyChildren(ask({ filter: 'employment' }))).matched).toBe(1);
    expect(await service.propertyChildren(ask({ filter: 'zebra' }))).toMatchObject({ nodes: [], total: 0, matched: 0 });
    expect((await service.propertyChildren(ask())).matched).toBeUndefined();
  });

  it('answers for several properties in one question, a page for each in the order asked', async () => {
    const { service, state, ask } = servingProps(PROPS);
    const pages = await service.propertyBranches({ ...state.ref, parents: [{ parentIri: NS + 'works for' }, {}, { parentIri: NS + 'related to', limit: 1 }] });
    expect(pages.map(propLabels)).toEqual([['employed by'], ['age', 'related to'], ['works for']]);
    expect(pages.map((p) => p.parentIri)).toEqual([NS + 'works for', undefined, NS + 'related to']);
    expect(pages[0]).toEqual(await service.propertyChildren(ask({ parentIri: NS + 'works for' })));
    const narrowed = await service.propertyBranches({ ...state.ref, filter: 'employ', parents: [{}, { parentIri: NS + 'related to' }] });
    expect(narrowed.map(propLabels)).toEqual([['related to'], ['works for']]);
    expect(narrowed.every((p) => p.matched === 2)).toBe(true);
    expect(await refused(service.propertyBranches({ ...state.ref, parents: [{ parentIri: NS + 'Nobody' }] }))).toBe('not-found');
    expect(await service.propertyBranches({ ...state.ref, parents: [] })).toEqual([]);
  });

  it('gives the ways down to a property, and says where it stands', async () => {
    const { service, state, to } = servingProps({
      properties: [prop('top'), prop('left'), prop('right'), prop('leaf')],
      subPropertyOf: links(['left', 'top'], ['right', 'top'], ['leaf', 'left'], ['leaf', 'right']),
    });
    const all = await service.propertyPaths(to('leaf'));
    expect(all.paths.map((p) => p.map((x) => x.label).join(' > '))).toEqual(['top > left > leaf', 'top > right > leaf']);
    expect(all.provenance).toMatchObject({ engine: null, status: 'current', completeness: 'complete' });
    expect((await service.propertyPaths(to('leaf', 1))).truncated).toBe(true);
    const summary = await service.propertySummary({ ...state.ref, propertyIri: NS + 'leaf' });
    expect(summary).toEqual({
      ontologyId: 'onto',
      revisionId: 'r1',
      property: { iri: NS + 'leaf', label: 'leaf', type: 'object' },
      superproperties: [
        { iri: NS + 'left', label: 'left', type: 'object' },
        { iri: NS + 'right', label: 'right', type: 'object' },
      ],
      subpropertyCount: 0,
      descendantCount: 0,
      inCycle: false,
      provenance: { engine: null, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [] },
    });
    expect((await service.propertySummary({ ...state.ref, propertyIri: NS + 'top' })).descendantCount).toBe(3);
    // A property in the ring of a cycle says so, where it stands and as it is listed.
    const cycle = servingProps({ properties: [prop('a'), prop('b')], subPropertyOf: links(['a', 'b'], ['b', 'a']) });
    const a = await cycle.service.propertyChildren({ ...state.ref, parentIri: NS + 'a' });
    expect(a.nodes[0]).toMatchObject({ property: { label: 'b' }, inCycle: true });
    expect(await cycle.service.propertySummary({ ...state.ref, propertyIri: NS + 'a' })).toMatchObject({ inCycle: true, superproperties: [{ label: 'b' }], subpropertyCount: 1 });
  });

  it('refuses a property that is not there, a question given up, a source without properties, and another revision', async () => {
    const { service, state, ask, to } = servingProps(PROPS);
    expect(await refused(service.propertyChildren(ask({ parentIri: NS + 'Nobody' })))).toBe('not-found');
    expect(await refused(service.propertyPaths(to('Nobody')))).toBe('not-found');
    expect(await refused(service.propertySummary({ ...state.ref, propertyIri: NS + 'Nobody' }))).toBe('not-found');
    const abort = new AbortController();
    abort.abort();
    expect(await refused(service.propertyChildren(ask(), { signal: abort.signal }))).toBe('aborted');
    expect(await refused(service.propertyChildren({ ...ask(), revisionId: 'r0' }))).toBe('stale-revision');
    // A source that does not know the properties has no hierarchy to browse.
    const bare = createGraphService(() => ({ ...state.ref, graph: () => graphOf('Actor < Person') }));
    expect(await refused(bare.propertyChildren(ask()))).toBe('unsupported');
    expect(await refused(bare.propertySummary({ ...state.ref, propertyIri: NS + 'related to' }))).toBe('unsupported');
  });

  it('builds each revision of the hierarchy once, and answers for the revision it is at', async () => {
    const { service, state, ask } = servingProps(PROPS);
    const before = ask();
    expect(propLabels(await service.propertyChildren(before))).toEqual(['age', 'related to']);
    await service.propertyChildren(ask({ parentIri: NS + 'related to' }));
    await service.propertyPaths({ ...state.ref, propertyIri: NS + 'employed by' });
    expect(state.built).toBe(1);

    state.props = { properties: [...PROPS.properties, prop('new top')], subPropertyOf: PROPS.subPropertyOf };
    state.ref = { ontologyId: 'onto', revisionId: 'r2' };
    expect(await refused(service.propertyChildren(before))).toBe('stale-revision');
    expect(propLabels(await service.propertyChildren(ask()))).toEqual(['age', 'new top', 'related to']);
    expect(state.built).toBe(2);
  });
});
