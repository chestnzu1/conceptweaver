import { describe, expect, it } from 'vitest';
import { OWL_NOTHING, type HierarchyQuery, type Provenance, type SummaryQuery } from './contracts';
import { graphOf, NS } from './fixtures';
import { ancestorsOf, buildHierarchy, buildInferredHierarchy, depthsOf, descendantsOf, nodeOf, pathsTo, type ClassGraphInput, type EntailedInput, type Hierarchy } from './graph';
import { createGraphService, type InferredInput } from './service';

const short = (iris: Iterable<string>) => [...iris].map((x) => (x === OWL_NOTHING ? 'owl:Nothing' : x.slice(NS.length)));
const children = (h: Hierarchy, name: string) => short(h.entries.get(NS + name)!.children);
const parents = (h: Hierarchy, name: string) => short(h.entries.get(NS + name)!.parents).sort();
const iris = (names: string) => names.split(',').map((n) => NS + n.trim());
/** What a reasoner entails, written as the stated hierarchy is: "C < B" is an entailed subclass link. */
const entails = (spec: string, more: Partial<EntailedInput> = {}): EntailedInput => ({ subClassOf: graphOf(spec).subClassOf, links: 'direct', equivalent: [], unsatisfiable: [], ...more });

describe('the inferred hierarchy', () => {
  it('lists each class under the classes directly above it, whichever links it is given', () => {
    const stated = graphOf('A; B < A; C < B; D < C');
    // A reasoner that gives every entailed link: C is under B and under A, D under all three.
    const all = buildInferredHierarchy(stated, entails('B < A; C < B, A; D < C, B, A', { links: 'all' }));
    expect(short(all.top)).toEqual(['A']);
    expect(parents(all, 'C')).toEqual(['B']);
    expect(parents(all, 'D')).toEqual(['C']);
    expect(children(all, 'A')).toEqual(['B']);
    // One that gives the direct links only comes to the same hierarchy.
    const direct = buildInferredHierarchy(stated, entails('B < A; C < B; D < C'));
    for (const name of ['A', 'B', 'C', 'D']) expect(children(direct, name)).toEqual(children(all, name));
  });

  it('keeps every direct superclass of a class that has several, and no superclass further up', () => {
    const stated = graphOf('A; B < A; C < A; D < B, C; E < D');
    const h = buildInferredHierarchy(stated, entails('B < A; C < A; D < B, C, A; E < D, B, C, A', { links: 'all' }));
    expect(parents(h, 'D')).toEqual(['B', 'C']);
    expect(parents(h, 'E')).toEqual(['D']);
    expect(nodeOf(h, NS + 'D').parentCount).toBe(2);
    expect(pathsTo(h, NS + 'E', 10).paths.map((p) => p.map((c) => c.label).join(' > '))).toEqual(['A > B > D > E', 'A > C > D > E']);
  });

  it('drops a stated link that is not a direct one: the class is under the nearer superclass only', () => {
    // WorkingActor is stated to be a Person directly, and an Actor, which is a Person.
    const stated = graphOf('Person; Actor < Person; WorkingActor < Actor, Person');
    const asserted = buildHierarchy(stated);
    expect(children(asserted, 'Person')).toEqual(['Actor', 'WorkingActor']);
    const h = buildInferredHierarchy(stated, entails('Actor < Person; WorkingActor < Actor, Person', { links: 'all' }));
    expect(children(h, 'Person')).toEqual(['Actor']);
    expect(children(h, 'Actor')).toEqual(['WorkingActor']);
  });

  it('gives classes that are entailed to be equivalent one place, under the name of the first of them', () => {
    const stated = graphOf('Party; Organisation < Party; Org; Company < Org; Firm < Organisation');
    const h = buildInferredHierarchy(stated, entails('Organisation < Party; Org < Party; Company < Org; Firm < Organisation', { equivalent: [iris('Organisation, Org')] }));
    expect(children(h, 'Party')).toEqual(['Org']);
    expect(h.entries.has(NS + 'Organisation')).toBe(false);
    expect(h.alias.get(NS + 'Organisation')).toBe(NS + 'Org');
    const node = nodeOf(h, NS + 'Organisation');
    expect(node.class.label).toBe('Org');
    expect(node.equivalents.map((c) => c.label)).toEqual(['Organisation']);
    // What is under either of them is under their place.
    expect(children(h, 'Org')).toEqual(['Company', 'Firm']);
    expect(h.cycles).toEqual([]);
    // Asked for by either name, the way down is to the place they share.
    expect(pathsTo(h, NS + 'Organisation', 5).paths.map((p) => p.map((c) => c.label).join(' > '))).toEqual(['Party > Org']);
  });

  it('takes classes that are entailed to be each other’s superclasses for what they are: equivalent', () => {
    const stated = graphOf('Animal; Cat < Feline, Animal; Feline < Cat; Lion < Feline');
    expect(buildHierarchy(stated).cycles).toHaveLength(1);
    const h = buildInferredHierarchy(stated, entails('Cat < Feline, Animal; Feline < Cat, Animal; Lion < Feline, Cat, Animal', { links: 'all' }));
    expect(h.cycles).toEqual([]);
    expect(children(h, 'Animal')).toEqual(['Cat']);
    expect(nodeOf(h, NS + 'Cat').equivalents.map((c) => c.label)).toEqual(['Feline']);
    expect(nodeOf(h, NS + 'Cat').inCycle).toBeUndefined();
    expect(children(h, 'Cat')).toEqual(['Lion']);
  });

  it('sets the classes that can have no instance apart under owl:Nothing, with everything below them', () => {
    const stated = graphOf('Person; Robot; Android < Person, Robot; Replicant < Android; Actor < Person');
    const h = buildInferredHierarchy(stated, entails('Android < Person, Robot; Replicant < Android; Actor < Person', { unsatisfiable: iris('Android') }));
    expect(short(h.top)).toEqual(['Person', 'Robot', 'owl:Nothing']);
    // Replicant is below Android, so it has no instances either, whether or not the reasoner said so.
    expect(short(h.entries.get(OWL_NOTHING)!.children)).toEqual(['Android', 'Replicant']);
    expect(children(h, 'Person')).toEqual(['Actor']);
    expect(children(h, 'Robot')).toEqual([]);
    expect(nodeOf(h, NS + 'Android')).toMatchObject({ unsatisfiable: true, parentCount: 1, childCount: 0 });
    expect(nodeOf(h, OWL_NOTHING).class).toEqual({ iri: OWL_NOTHING, label: 'owl:Nothing', builtin: true });
    expect(nodeOf(h, NS + 'Actor').unsatisfiable).toBeUndefined();
    expect(pathsTo(h, NS + 'Replicant', 5).paths.map((p) => p.map((c) => c.label).join(' > '))).toEqual(['owl:Nothing > Replicant']);
  });

  it('says of each place whether it is stated or only entailed', () => {
    // Stated: Lion is a Cat. Entailed besides: Cat is an Animal, and Lion is a Carnivore.
    const stated = graphOf('Animal; Carnivore; Cat; Lion < Cat');
    const h = buildInferredHierarchy(stated, entails('Cat < Animal; Lion < Cat, Carnivore'));
    expect(nodeOf(h, NS + 'Lion', undefined, NS + 'Cat').entailedOnly).toBeUndefined();
    expect(nodeOf(h, NS + 'Lion', undefined, NS + 'Carnivore').entailedOnly).toBe(true);
    expect(nodeOf(h, NS + 'Cat', undefined, NS + 'Animal').entailedOnly).toBe(true);
    // At the top nothing is entailed about where it is: there is nothing above it.
    expect(nodeOf(h, NS + 'Animal').entailedOnly).toBeUndefined();
    // A link stated between classes that share places with others is stated for the places.
    const merged = buildInferredHierarchy(graphOf('A; B; C < B'), entails('C < A', { equivalent: [iris('A, B')] }));
    expect(nodeOf(merged, NS + 'C', undefined, NS + 'A').entailedOnly).toBeUndefined();
  });
});

describe('how far down a class is, and what is below it', () => {
  it('gives the fewest and the most levels below owl:Thing', () => {
    // E is reached by a short way (A > E) and a long one (A > B > C > D > E).
    const h = buildHierarchy(graphOf('A; B < A; C < B; D < C; E < D, A; F'));
    const depths = depthsOf(h);
    expect(depths.get(NS + 'A')).toEqual({ min: 1, max: 1 });
    expect(depths.get(NS + 'D')).toEqual({ min: 4, max: 4 });
    expect(depths.get(NS + 'E')).toEqual({ min: 2, max: 5 });
    expect(depths.get(NS + 'F')).toEqual({ min: 1, max: 1 });
  });

  it('counts a ring of classes as one level', () => {
    const h = buildHierarchy(graphOf('Animal; Cat < Feline, Animal; Feline < Cat; Lion < Feline'));
    const depths = depthsOf(h);
    expect(depths.get(NS + 'Cat')).toEqual({ min: 2, max: 2 });
    expect(depths.get(NS + 'Feline')!.max).toBe(2);
    expect(depths.get(NS + 'Lion')!.max).toBe(3);
    // A ring with nothing above it is at the top, all of it.
    const loose = depthsOf(buildHierarchy(graphOf('Cat < Feline; Feline < Cat; Lion < Feline')));
    expect(loose.get(NS + 'Feline')!.max).toBe(1);
    expect(loose.get(NS + 'Lion')!.max).toBe(2);
  });

  it('counts each class below once, however many ways lead to it', () => {
    const h = buildHierarchy(graphOf('A; B < A; C < A; D < B, C; E < D'));
    expect(descendantsOf(h, NS + 'A')).toBe(4);
    expect(descendantsOf(h, NS + 'B')).toBe(2);
    expect(descendantsOf(h, NS + 'E')).toBe(0);
    expect(short(ancestorsOf(h, NS + 'E')).sort()).toEqual(['A', 'B', 'C', 'D']);
    // Classes that share a place in the inferred hierarchy are each of them a class below.
    const merged = buildInferredHierarchy(graphOf('A; B < A; C < A'), entails('B < A; C < A', { equivalent: [iris('B, C')] }));
    expect(descendantsOf(merged, NS + 'A')).toBe(2);
    // A ring ends: a class is not below itself.
    expect(descendantsOf(buildHierarchy(graphOf('Cat < Feline; Feline < Cat; Lion < Feline')), NS + 'Cat')).toBe(2);
  });

  it('works out depths for a hierarchy tens of thousands of levels deep', () => {
    const depth = 30_000;
    const input: ClassGraphInput = { classes: [], subClassOf: [], equivalent: [] };
    for (let i = 0; i < depth; i++) {
      input.classes.push({ iri: `${NS}C${i}`, label: `C${i}` });
      if (i) input.subClassOf.push({ sub: `${NS}C${i}`, sup: `${NS}C${i - 1}` });
    }
    const h = buildHierarchy(input);
    expect(depthsOf(h).get(`${NS}C${depth - 1}`)).toEqual({ min: depth, max: depth });
    expect(descendantsOf(h, `${NS}C0`)).toBe(depth - 1);
    expect(ancestorsOf(h, `${NS}C${depth - 1}`)).toHaveLength(depth - 1);
    // The same as an inferred hierarchy, from direct links.
    const inferred = buildInferredHierarchy(input, { subClassOf: input.subClassOf, links: 'direct', equivalent: [], unsatisfiable: [] });
    expect(depthsOf(inferred).get(`${NS}C${depth - 1}`)!.max).toBe(depth);
  });
});

describe('the structure service, with a reasoner', () => {
  const STATED = 'Animal; Carnivore; Cat; Lion < Cat; Tiger < Cat; Felis; Chimera < Cat';
  const engine = { id: 'test', name: 'Test reasoner', version: '1.0' };
  const current = (more: Partial<Provenance> = {}): Provenance => ({ engine, revisionId: 'r1', status: 'current', completeness: 'complete', notes: [], ...more });
  /** A service over one ontology whose reasoner's answer can be swapped for another, as running it again would. */
  function serving(first: InferredInput | undefined) {
    const state = { answer: first, input: graphOf(STATED) };
    const service = createGraphService(() => ({ ontologyId: 'onto', revisionId: 'r1', graph: () => state.input, ...(state.answer ? { inferred: () => state.answer! } : {}) }));
    const ask = (mode: 'asserted' | 'inferred', extra: Partial<HierarchyQuery> = {}): HierarchyQuery => ({ ontologyId: 'onto', revisionId: 'r1', mode, ...extra });
    const about = (name: string, mode: 'asserted' | 'inferred'): SummaryQuery => ({ ontologyId: 'onto', revisionId: 'r1', mode, classIri: NS + name });
    return { service, state, ask, about };
  }
  const ANSWER: InferredInput = { provenance: current(), entailed: entails('Cat < Animal; Lion < Cat, Carnivore; Tiger < Cat; Felis < Animal', { equivalent: [iris('Cat, Felis')], unsatisfiable: iris('Chimera') }) };
  const labels = (nodes: { class: { label: string } }[]) => nodes.map((n) => n.class.label);

  it('answers with the inferred hierarchy and says which reasoner it is from', async () => {
    const { service, ask } = serving(ANSWER);
    const top = await service.children(ask('inferred'));
    expect(labels(top.nodes)).toEqual(['Animal', 'Carnivore', 'owl:Nothing']);
    expect(top.provenance).toEqual(current());
    const cats = await service.children(ask('inferred', { parentIri: NS + 'Animal' }));
    expect(cats.nodes).toHaveLength(1);
    expect(cats.nodes[0]).toMatchObject({ class: { label: 'Cat' }, equivalents: [{ label: 'Felis' }], entailedOnly: true, childCount: 2 });
    // Asked for under either name, the place is the same.
    expect(labels((await service.children(ask('inferred', { parentIri: NS + 'Felis' }))).nodes)).toEqual(['Lion', 'Tiger']);
    const lion = (await service.children(ask('inferred', { parentIri: NS + 'Carnivore' }))).nodes[0];
    expect(lion).toMatchObject({ class: { label: 'Lion' }, entailedOnly: true, parentCount: 2 });
    expect((await service.children(ask('inferred', { parentIri: NS + 'Cat' }))).nodes[0].entailedOnly).toBeUndefined();
    expect((await service.children(ask('inferred', { parentIri: OWL_NOTHING }))).nodes[0]).toMatchObject({ class: { label: 'Chimera' }, unsatisfiable: true });
  });

  it('leaves the asserted hierarchy as it is stated, whatever the reasoner says', async () => {
    const { service, ask } = serving(ANSWER);
    const top = await service.children(ask('asserted'));
    expect(labels(top.nodes)).toEqual(['Animal', 'Carnivore', 'Cat', 'Felis']);
    expect(top.provenance.engine).toBeNull();
    expect(top.nodes.every((n) => !n.entailedOnly && !n.unsatisfiable)).toBe(true);
    expect(labels((await service.children(ask('asserted', { parentIri: NS + 'Cat' }))).nodes)).toEqual(['Chimera', 'Lion', 'Tiger']);
  });

  it('lists nothing where the reasoner has no current answer, and says why, without falling back on what is stated', async () => {
    for (const status of ['stale', 'unavailable', 'failed', 'inconsistent'] as const) {
      const provenance = current({ status, revisionId: status === 'stale' ? 'r0' : 'r1', completeness: 'incomplete', notes: ['why'] });
      const { service, ask, about } = serving({ provenance });
      const top = await service.children(ask('inferred'));
      expect(top).toMatchObject({ nodes: [], total: 0, offset: 0 });
      expect(top.provenance).toEqual(provenance);
      expect((await service.paths({ ...ask('inferred'), classIri: NS + 'Lion' })).paths).toEqual([]);
      // What is stated is still there to be asked for, as what is stated.
      expect((await service.children(ask('asserted'))).nodes).toHaveLength(4);
      const s = await service.summary(about('Lion', 'inferred'));
      expect(s.inferred).toEqual({ provenance });
      expect(s.position).toBeUndefined();
      expect(s.asserted.superclasses.map((c) => c.label)).toEqual(['Cat']);
    }
    // An answer that claims to be current and has nothing in it is not one either.
    const { service, ask } = serving({ provenance: current() });
    expect((await service.children(ask('inferred'))).nodes).toEqual([]);
  });

  it('builds the inferred hierarchy once for an answer, and again for another', async () => {
    const { service, state, ask } = serving(ANSWER);
    const one = (await service.children(ask('inferred'))).nodes[0].class;
    expect((await service.children(ask('inferred'))).nodes[0].class).toBe(one);
    // The reasoner is run again and answers differently: nothing is under Animal any more.
    state.answer = { provenance: current({ notes: ['second run'] }), entailed: entails('Lion < Cat') };
    const top = await service.children(ask('inferred'));
    expect(top.provenance.notes).toEqual(['second run']);
    expect(labels(top.nodes)).toEqual(['Animal', 'Carnivore', 'Cat', 'Chimera', 'Felis', 'Tiger']);
    expect(top.nodes[0].class).not.toBe(one);
  });

  it('sums up a class: what is stated, what is entailed, and where it stands', async () => {
    const { service, state, about } = serving(ANSWER);
    state.input.classes.find((c) => c.label === 'Lion')!.anonymousSuperclasses = 2;
    const lion = await service.summary(about('Lion', 'inferred'));
    expect(lion.class).toEqual({ iri: NS + 'Lion', label: 'Lion' });
    expect(lion.asserted).toEqual({ superclasses: [{ iri: NS + 'Cat', label: 'Cat' }], anonymousSuperclasses: 2, equivalents: [] });
    expect(lion.inferred.provenance.engine).toEqual(engine);
    // The direct ones only: Animal is above it, through Cat, and is not listed.
    expect(lion.inferred.superclasses).toEqual([
      { class: { iri: NS + 'Carnivore', label: 'Carnivore' }, stated: false },
      { class: { iri: NS + 'Cat', label: 'Cat' }, stated: true },
    ]);
    expect(lion.inferred.unsatisfiable).toBe(false);
    expect(lion.position).toMatchObject({ mode: 'inferred', superclasses: 2, subclasses: 0, descendants: 0, depth: { min: 2, max: 3 }, inCycle: false });
    expect(short(lion.position!.ancestors).sort()).toEqual(['Animal', 'Carnivore', 'Cat']);
    expect(lion.position!.provenance.engine).toEqual(engine);

    // The same class in the asserted hierarchy: one stated superclass, and nothing of the reasoner's in where it stands.
    const stated = await service.summary(about('Lion', 'asserted'));
    expect(stated.position).toMatchObject({ mode: 'asserted', superclasses: 1, depth: { min: 2, max: 2 } });
    expect(stated.position!.provenance.engine).toBeNull();
    expect(stated.inferred.superclasses).toHaveLength(2);

    const felis = await service.summary(about('Felis', 'inferred'));
    expect(felis.inferred.equivalents).toEqual([{ iri: NS + 'Cat', label: 'Cat' }]);
    expect(felis.asserted.equivalents).toEqual([]);
    expect(felis.position).toMatchObject({ subclasses: 2, descendants: 2 });
    const animal = await service.summary(about('Animal', 'inferred'));
    // Cat and Felis, which share a place, and Lion and Tiger below them.
    expect(animal.position).toMatchObject({ subclasses: 1, descendants: 4 });

    const chimera = await service.summary(about('Chimera', 'inferred'));
    expect(chimera.inferred).toMatchObject({ unsatisfiable: true, superclasses: [], equivalents: [] });
    expect(chimera.asserted.superclasses.map((c) => c.label)).toEqual(['Cat']);
  });

  it('has nothing inferred to say where there is no reasoner, and says so', async () => {
    const { service, ask, about } = serving(undefined);
    await expect(service.children(ask('inferred'))).rejects.toMatchObject({ code: 'unsupported' });
    const s = await service.summary(about('Lion', 'asserted'));
    expect(s.inferred).toEqual({ provenance: { engine: null, revisionId: 'r1', status: 'unavailable', completeness: 'incomplete', notes: [] } });
    expect(s.position?.depth).toEqual({ min: 2, max: 2 });
  });

  it('brings a class into view by a name it shares its place under', async () => {
    const { service, ask } = serving(ANSWER);
    const page = await service.children(ask('inferred', { parentIri: NS + 'Animal', through: NS + 'Felis' }));
    expect(labels(page.nodes)).toEqual(['Cat']);
    const ways = await service.paths({ ...ask('inferred'), classIri: NS + 'Felis' });
    expect(ways.paths.map((p) => p.map((c) => c.label).join(' > '))).toEqual(['Animal > Cat']);
  });
});
