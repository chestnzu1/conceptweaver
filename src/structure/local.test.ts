import { beforeEach, describe, expect, it } from 'vitest';
import { withIris } from '../model/iri';
import type { DlReport, ReasoningResult } from '../model/reasoning';
import { stable } from '../model/stable';
import { useStore } from '../model/store';
import { stressModel } from '../model/stress';
import { newProp, emptyModel, newRelation, newTerm, type Model } from '../model/types';
import { OWL_NOTHING, StructureError, type HierarchyPage, type HierarchyQuery, type Iri, type StructureService } from './contracts';
import { classIriOf, createLocalStructureService, ontologyRef, revisionOf, termOfClass, WORKING_COPY, type LocalReasoning } from './local';
import { PAGE } from './service';

const NS = 'http://example.org/o#';

/** A small ontology with a term of every kind: only its classes and their stated superclasses belong in the hierarchy. */
function cast(): { m: Model; id: Record<string, string> } {
  const m = emptyModel('Cast');
  m.baseIri = NS;
  m.vocab.enabled = true;
  m.prefixes = [{ prefix: 'v', iri: 'http://vocab.org/v#' }];
  const id: Record<string, string> = {};
  const term = (name: string, patch: Parameters<typeof newTerm>[0] = {}) => {
    const t = newTerm({ name, ...patch });
    id[name] = t.id;
    m.terms.push(t);
    return t.id;
  };
  const isA = (a: string, b: string) => m.relations.push(newRelation({ from: id[a], to: id[b], kind: 'generalization' }));
  term('Agent', { iri: 'http://vocab.org/v#Agent', external: 'vocab' });
  term('Person', { synonyms: 'Human, Individual person' });
  // An anonymous superclass, kept as text: it is asserted of Actor, and it is not a class.
  term('Actor', { axioms: ['rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :actsIn ; owl:someValuesFrom :Film ]'], fields: [{ key: 'skos:altLabel', value: 'Performer' }] });
  term('Employee');
  term('WorkingActor');
  term('Performer');
  term('Film');
  term('Tom Hanks', { type: 'instance' });
  term('Stage name', { type: 'property', range: 'xsd:string' });
  isA('Person', 'Agent');
  isA('Actor', 'Person');
  isA('Employee', 'Person');
  isA('WorkingActor', 'Actor');
  isA('WorkingActor', 'Employee');
  // An individual's class and a class's data property are not subclass statements.
  isA('Tom Hanks', 'Actor');
  m.relations.push(newRelation({ from: id.Actor, to: id['Stage name'], kind: 'property' }));
  m.relations.push(newRelation({ from: id.Actor, to: id.Performer, predicate: 'owl:equivalentClass' }));
  return { m: withIris(m), id };
}

const serve = (model: () => Model, docId: string | null = null) => createLocalStructureService(() => ({ model: model(), docId }));
const ask = (m: Model, extra: Partial<HierarchyQuery> = {}): HierarchyQuery => ({ ...ontologyRef(m, null), mode: 'asserted', ...extra });
const labels = (page: HierarchyPage) => page.nodes.map((n) => n.class.label);

/** Every class the service lists, going into every branch and through every page, with how many places each was met in. */
async function everything(service: StructureService, m: Model): Promise<Map<Iri, number>> {
  const met = new Map<Iri, number>();
  const todo: (Iri | undefined)[] = [undefined];
  const gone = new Set<Iri>();
  while (todo.length) {
    const parentIri = todo.pop();
    let cursor: string | undefined;
    do {
      const page = await service.children(ask(m, { ...(parentIri ? { parentIri } : {}), ...(cursor ? { cursor } : {}) }));
      expect(page.nodes.length).toBeLessThanOrEqual(PAGE);
      for (const n of page.nodes) {
        met.set(n.class.iri, (met.get(n.class.iri) ?? 0) + 1);
        if (n.childCount && !gone.has(n.class.iri)) {
          gone.add(n.class.iri);
          todo.push(n.class.iri);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return met;
}

describe('the hierarchy of the model in the editor', () => {
  it('is its classes under their stated superclasses, named by IRI', async () => {
    const { m, id } = cast();
    const service = serve(() => m);
    const top = await service.children(ask(m));
    expect(labels(top)).toEqual(['Agent', 'Film', 'Performer']);
    expect(top.nodes[0].class).toEqual({ iri: 'http://vocab.org/v#Agent', label: 'Agent', external: true });
    const person = classIriOf(m, id.Person)!;
    expect(person).toBe(NS + 'Person');
    expect(labels(await service.children(ask(m, { parentIri: person })))).toEqual(['Actor', 'Employee']);
    expect(termOfClass(m, person)).toBe(id.Person);
    expect(termOfClass(m, NS + 'Nobody')).toBeUndefined();
  });

  it('does not take an individual, a data property or an anonymous superclass for a class', async () => {
    const { m, id } = cast();
    const service = serve(() => m);
    const met = await everything(service, m);
    expect([...met.keys()].map((iri) => m.terms.find((t) => t.iri === iri)!.name).sort()).toEqual(['Actor', 'Agent', 'Employee', 'Film', 'Performer', 'Person', 'WorkingActor']);
    expect(classIriOf(m, id['Tom Hanks'])).toBeUndefined();
    expect(classIriOf(m, id['Stage name'])).toBeUndefined();
    // Actor has one subclass. Its instance is not one, and the restriction it is a subclass of is not a class above it.
    const actor = (await service.children(ask(m, { parentIri: NS + 'Person' }))).nodes.find((n) => n.class.label === 'Actor')!;
    expect(actor.childCount).toBe(1);
    expect(actor.parentCount).toBe(1);
  });

  it('lists a class with two superclasses under both, as one class', async () => {
    const { m } = cast();
    const service = serve(() => m);
    const met = await everything(service, m);
    expect(met.get(NS + 'WorkingActor')).toBe(2);
    expect([...met.values()].filter((n) => n > 1)).toHaveLength(1);
    const paths = (await service.paths({ ...ontologyRef(m, null), mode: 'asserted', classIri: NS + 'WorkingActor' })).paths;
    expect(paths.map((p) => p.map((c) => c.label).join(' > '))).toEqual(['Agent > Person > Actor > WorkingActor', 'Agent > Person > Employee > WorkingActor']);
  });

  it('shows equivalence that is stated, while the standard properties are in force', async () => {
    const { m } = cast();
    const actor = async (model: Model) => (await serve(() => model).children(ask(model, { parentIri: NS + 'Person' }))).nodes.find((n) => n.class.label === 'Actor')!;
    expect((await actor(m)).equivalents).toEqual([{ iri: NS + 'Performer', label: 'Performer' }]);
    // With the standard properties switched off the statement is not in force, here as in the entity editor.
    const off = { ...m, vocab: { ...m.vocab, enabled: false } };
    expect((await actor(off)).equivalents).toEqual([]);
  });

  it('is searched by name, by other labels, and by IRI in full or with a prefix', async () => {
    const { m } = cast();
    const service = serve(() => m);
    const found = async (text: string) => (await service.children(ask(m, { filter: text }))).matched;
    expect(await found('working')).toBe(1);
    expect(await found('human')).toBe(1);
    // "Performer" is a class of its own and another label of Actor.
    expect(await found('performer')).toBe(2);
    expect(await found('v:agent')).toBe(1);
    expect(await found('vocab.org/v#')).toBe(1);
    expect(await found(':Film')).toBe(1);
    // An individual is not found: it is not in the hierarchy.
    expect(await found('hanks')).toBe(0);
  });

  it('gives a class without a name an identifier of its own, and takes two terms with one IRI for one class', async () => {
    const { m, id } = cast();
    const blank = newTerm({ name: '' });
    const twin = newTerm({ name: 'Movie', iri: NS + 'Film' });
    const more = { ...m, terms: [...m.terms, blank, twin] };
    expect(classIriOf(more, blank.id)).toBe(`urn:conceptweaver:term:${blank.id}`);
    expect(termOfClass(more, classIriOf(more, blank.id)!)).toBe(blank.id);
    expect(classIriOf(more, twin.id)).toBe(NS + 'Film');
    expect(termOfClass(more, NS + 'Film')).toBe(id.Film);
    const top = await serve(() => more).children(ask(more));
    expect(labels(top)).toEqual(['Agent', 'Film', 'Performer', 'Unnamed']);
  });

  it('reads a concept scheme as concepts under their broader concepts, whatever kind a term had', async () => {
    const m = emptyModel('Glossary');
    m.mode = 'skos';
    m.baseIri = 'http://example.org/glossary#';
    m.terms = [newTerm({ id: 'a', name: 'Animal' }), newTerm({ id: 'd', name: 'Dog' }), newTerm({ id: 'r', name: 'Rex', type: 'instance' }), newTerm({ id: 'b', name: 'Bone' })];
    m.relations = [newRelation({ from: 'd', to: 'a', kind: 'generalization' }), newRelation({ from: 'r', to: 'd', kind: 'generalization' }), newRelation({ from: 'd', to: 'b', label: 'chews' })];
    const model = withIris(m);
    const service = serve(() => model);
    expect(labels(await service.children(ask(model)))).toEqual(['Animal', 'Bone']);
    const dog = (await service.children(ask(model, { parentIri: classIriOf(model, 'a')! }))).nodes[0];
    expect(dog).toMatchObject({ class: { label: 'Dog' }, childCount: 1 });
    expect(labels(await service.children(ask(model, { parentIri: dog.class.iri })))).toEqual(['Rex']);
  });

  it('never changes the model it reads', async () => {
    const { m } = cast();
    const freeze = (x: unknown): void => {
      if (!x || typeof x !== 'object' || Object.isFrozen(x)) return;
      Object.freeze(x);
      Object.values(x).forEach(freeze);
    };
    const before = JSON.stringify(m);
    freeze(m);
    const service = serve(() => m);
    await everything(service, m);
    await service.children(ask(m, { filter: 'actor' }));
    await service.paths({ ...ontologyRef(m, null), mode: 'asserted', classIri: NS + 'WorkingActor' });
    expect(JSON.stringify(m)).toBe(before);
  });

  it('lists every class of a large generated ontology, a page at a time', async () => {
    const m = withIris(stressModel(1300));
    const classes = m.terms.filter((t) => t.type === 'concept');
    const met = await everything(serve(() => m), m);
    expect(met.size).toBe(classes.length);
    // Some classes of it have a second superclass, and are met in more than one place.
    expect([...met.values()].some((n) => n > 1)).toBe(true);
  });
});

describe('revisions of the model in the editor', () => {
  it('are told apart by what the model says, not by where its terms sit', () => {
    const { m, id } = cast();
    const first = revisionOf(m);
    const moved = { ...m, terms: m.terms.map((t) => (t.id === id.Actor ? { ...t, x: t.x + 40, y: t.y - 10 } : t)) };
    expect(revisionOf(moved)).toBe(first);
    const renamed = { ...m, terms: m.terms.map((t) => (t.id === id.Actor ? { ...t, name: 'Player' } : t)) };
    const second = revisionOf(renamed);
    expect(second).not.toBe(first);
    // Undo puts the earlier model back, and with it its revision.
    expect(revisionOf(m)).toBe(first);
    expect(revisionOf(renamed)).toBe(second);
    expect(ontologyRef(m, null)).toEqual({ ontologyId: WORKING_COPY, revisionId: first });
    expect(ontologyRef(m, 'saved-1').ontologyId).toBe('saved-1');
  });

  it('answer only for the model as it is: after an edit, what was asked of the earlier one is refused', async () => {
    const { m, id } = cast();
    let current = m;
    const service = serve(() => current);
    const before = ask(m, { parentIri: NS + 'Person' });
    expect(labels(await service.children(before))).toEqual(['Actor', 'Employee']);

    // Dragging a term about is not an edit of the ontology: the same question still stands.
    current = { ...m, terms: m.terms.map((t) => (t.id === id.Film ? { ...t, x: 500 } : t)) };
    expect(labels(await service.children(before))).toEqual(['Actor', 'Employee']);

    // Film is made a kind of Person.
    current = { ...m, relations: [...m.relations, newRelation({ from: id.Film, to: id.Person, kind: 'generalization' })] };
    await expect(service.children(before)).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(service.children(before)).rejects.toBeInstanceOf(StructureError);
    expect(labels(await service.children(ask(current, { parentIri: NS + 'Person' })))).toEqual(['Actor', 'Employee', 'Film']);

    // Undone: the first question is good again.
    current = m;
    expect(labels(await service.children(before))).toEqual(['Actor', 'Employee']);
  });
});

describe('what the reasoners entail of the model in the editor', () => {
  const FAST: LocalReasoning = { engine: 'fast', run: null };
  const reasoned = (model: () => Model, reasoning: () => LocalReasoning) => createLocalStructureService(() => ({ model: model(), docId: null, reasoning: reasoning() }));
  const inferredOf = (m: Model, extra: Partial<HierarchyQuery> = {}): HierarchyQuery => ({ ...ontologyRef(m, null), mode: 'inferred', ...extra });
  const under = async (service: StructureService, m: Model, name?: string) => labels(await service.children(inferredOf(m, name ? { parentIri: m.terms.find((t) => t.name === name)!.iri! } : {})));
  const add = (m: Model, build: (id: (name: string, patch?: Parameters<typeof newTerm>[0]) => string, m: Model) => void): Model => {
    const next: Model = { ...m, terms: [...m.terms], relations: [...m.relations] };
    const ids = new Map(next.terms.map((t) => [t.name, t.id]));
    build((name, patch = {}) => {
      if (!ids.has(name)) {
        const t = newTerm({ name, ...patch });
        ids.set(name, t.id);
        next.terms.push(t);
      }
      return ids.get(name)!;
    }, next);
    return withIris(next);
  };
  const isA = (m: Model, from: string, to: string) => m.relations.push(newRelation({ from, to, kind: 'generalization' }));

  it('builds the inferred hierarchy from the fast reasoner, and says that it may not find everything', async () => {
    const { m } = cast();
    const service = reasoned(() => m, () => FAST);
    const top = await service.children(inferredOf(m));
    // Actor and Performer are stated to be equivalent: in the inferred hierarchy they are one place.
    expect(labels(top)).toEqual(['Agent', 'Film']);
    expect(top.provenance).toMatchObject({ engine: { id: 'fast' }, status: 'current', completeness: 'incomplete', revisionId: revisionOf(m) });
    expect(top.provenance.notes.join(' ')).toMatch(/not a complete OWL 2 DL reasoner/);
    const person = await service.children(inferredOf(m, { parentIri: NS + 'Person' }));
    expect(labels(person)).toEqual(['Actor', 'Employee']);
    expect(person.nodes[0].equivalents.map((c) => c.label)).toEqual(['Performer']);
    // The asserted hierarchy is still what is stated: two classes, each in its own place.
    expect(labels(await service.children(ask(m)))).toEqual(['Agent', 'Film', 'Performer']);
  });

  it('keeps the direct superclasses apart from the ones further up, and a stated link apart from a direct one', async () => {
    // WorkingActor is also stated to be a Person, which it is anyway, through Actor and through Employee.
    const { m } = cast();
    const model = add(m, (id, next) => isA(next, id('WorkingActor'), id('Person')));
    const service = reasoned(() => model, () => FAST);
    expect(labels(await service.children(ask(model, { parentIri: NS + 'Person' })))).toEqual(['Actor', 'Employee', 'WorkingActor']);
    expect(await under(service, model, 'Person')).toEqual(['Actor', 'Employee']);
    const s = await service.summary({ ...ontologyRef(model, null), mode: 'inferred', classIri: NS + 'WorkingActor' });
    expect(s.asserted.superclasses.map((c) => c.label)).toEqual(['Actor', 'Employee', 'Person']);
    // Person and Agent are entailed superclasses too, and are not direct ones.
    expect(s.inferred.superclasses).toEqual([
      { class: { iri: NS + 'Actor', label: 'Actor' }, stated: true },
      { class: { iri: NS + 'Employee', label: 'Employee' }, stated: true },
    ]);
    expect(s.position).toMatchObject({ superclasses: 2, depth: { min: 4, max: 4 } });
    // Its place in the asserted hierarchy is by the shorter, stated way as well.
    expect((await service.summary({ ...ontologyRef(model, null), mode: 'asserted', classIri: NS + 'WorkingActor' })).position).toMatchObject({ superclasses: 3, depth: { min: 3, max: 4 } });
    // The anonymous superclass of Actor is counted, and is not a class above it.
    const actor = await service.summary({ ...ontologyRef(model, null), mode: 'asserted', classIri: NS + 'Actor' });
    expect(actor.asserted).toMatchObject({ anonymousSuperclasses: 1, equivalents: [{ label: 'Performer' }] });
    expect(actor.asserted.superclasses.map((c) => c.label)).toEqual(['Person']);
  });

  it('marks a place that is entailed and nowhere stated', async () => {
    // Every member of the enumeration is a Colour, so the enumeration is a kind of Colour. Nobody stated that.
    const { m } = cast();
    const model = add(m, (id, next) => {
      const light = id('TrafficLightColour');
      id('Colour');
      for (const name of ['Red', 'Green']) isA(next, id(name, { type: 'instance' }), id('Colour'));
      next.terms = next.terms.map((t) => (t.id === light ? { ...t, oneOf: [id('Red'), id('Green')] } : t));
    });
    const service = reasoned(() => model, () => FAST);
    expect(labels(await service.children(ask(model)))).toContain('TrafficLightColour');
    const colour = await service.children(inferredOf(model, { parentIri: NS + 'Colour' }));
    expect(colour.nodes).toHaveLength(1);
    expect(colour.nodes[0]).toMatchObject({ class: { label: 'TrafficLightColour' }, entailedOnly: true });
    expect(await under(service, model)).not.toContain('TrafficLightColour');
    const s = await service.summary({ ...ontologyRef(model, null), mode: 'inferred', classIri: NS + 'TrafficLightColour' });
    expect(s.asserted.superclasses).toEqual([]);
    expect(s.inferred.superclasses).toEqual([{ class: { iri: NS + 'Colour', label: 'Colour' }, stated: false }]);
  });

  it('sets a class that can have no instance apart, and gives no hierarchy for an ontology that contradicts itself', async () => {
    const { m } = cast();
    const model = add(m, (id, next) => {
      next.relations.push(newRelation({ from: id('Film'), to: id('Person'), predicate: 'owl:disjointWith' }));
      isA(next, id('Biopic subject'), id('Film'));
      isA(next, id('Biopic subject'), id('Person'));
    });
    const service = reasoned(() => model, () => FAST);
    expect(await under(service, model)).toEqual(['Agent', 'Film', 'owl:Nothing']);
    const nothing = await service.children(inferredOf(model, { parentIri: OWL_NOTHING }));
    expect(nothing.nodes).toHaveLength(1);
    expect(nothing.nodes[0]).toMatchObject({ class: { label: 'Biopic subject' }, unsatisfiable: true });
    expect(await under(service, model, 'Film')).toEqual([]);
    expect((await service.summary({ ...ontologyRef(model, null), mode: 'inferred', classIri: NS + 'BiopicSubject' })).inferred.unsatisfiable).toBe(true);
    // In the asserted hierarchy it is where it is stated to be.
    expect(labels(await service.children(ask(model, { parentIri: NS + 'Film' })))).toEqual(['Biopic subject']);

    // An individual in both of two disjoint classes: the ontology is inconsistent, and nothing is inferred from it.
    const broken = add(model, (id, next) => {
      isA(next, id('Tom Hanks'), id('Film'));
    });
    const refused = await reasoned(() => broken, () => FAST).children(inferredOf(broken));
    expect(refused).toMatchObject({ nodes: [], total: 0, provenance: { status: 'inconsistent', engine: { id: 'fast' } } });
  });

  /** An answer of the OWL 2 DL reasoner, as the validation workbench keeps it. Its report is not read here. */
  const dlRun = (m: Model, id: Record<string, string>, patch: Partial<ReasoningResult> = {}): LocalReasoning['run'] => {
    const link = (subclass: string, superclass: string, direct = true) => ({ subclass: id[subclass], superclass: id[superclass], asserted: true, direct });
    const result: ReasoningResult = {
      engine: { id: 'dl', name: 'HermiT', version: '1.4.5.456' },
      status: 'complete',
      consistency: 'consistent',
      proves: true,
      unsatisfiableClasses: [id.Film],
      // Each step up, as the workbench keeps it: the direct ones and the ones further up.
      subclasses: [link('Person', 'Agent'), link('Actor', 'Person'), link('Actor', 'Agent', false), link('Employee', 'Agent'), link('WorkingActor', 'Actor'), link('WorkingActor', 'Person', false), link('WorkingActor', 'Employee')],
      equivalentClasses: [[id.Actor, id.Performer]],
      types: [],
      relations: [],
      sameIndividuals: [],
      explanations: [],
      errors: [],
      warnings: [],
      ms: 12,
      ...patch,
    };
    return { model: stable(m), dl: { report: {} as DlReport, result } };
  };

  it('builds the inferred hierarchy from the OWL 2 DL reasoner’s answer, credited to it', async () => {
    const { m, id } = cast();
    const run = dlRun(m, id);
    const service = reasoned(() => m, () => ({ engine: 'dl', run }));
    const top = await service.children(inferredOf(m));
    expect(labels(top)).toEqual(['Agent', 'owl:Nothing']);
    expect(top.provenance).toEqual({ engine: { id: 'dl', name: 'HermiT', version: '1.4.5.456' }, revisionId: revisionOf(m), status: 'current', completeness: 'complete', notes: [] });
    // This reasoner puts Employee directly under Agent. That is its answer, and it is shown as it gave it.
    expect(await under(service, m, 'Agent')).toEqual(['Employee', 'Person']);
    expect(await under(service, m, 'Person')).toEqual(['Actor']);
    expect(await under(service, m, 'Actor')).toEqual(['WorkingActor']);
    expect((await service.children(inferredOf(m, { parentIri: OWL_NOTHING }))).nodes[0]).toMatchObject({ class: { label: 'Film' }, unsatisfiable: true });
    const employee = (await service.children(inferredOf(m, { parentIri: 'http://vocab.org/v#Agent' }))).nodes[0];
    expect(employee).toMatchObject({ class: { label: 'Employee' }, entailedOnly: true });
    // An answer that left something out says so.
    const partial = reasoned(() => m, () => ({ engine: 'dl', run: dlRun(m, id, { status: 'partial', warnings: ['xsd:date values were not compared.'] }) }));
    expect((await partial.children(inferredOf(m))).provenance).toMatchObject({ completeness: 'incomplete', notes: ['xsd:date values were not compared.'] });
  });

  it('withdraws that answer once the ontology has changed, and puts nothing in its place', async () => {
    const { m, id } = cast();
    const run = dlRun(m, id);
    let current = m;
    const service = reasoned(() => current, () => ({ engine: 'dl', run }));
    expect(labels(await service.children(inferredOf(m)))).toEqual(['Agent', 'owl:Nothing']);

    // Dragging a term about changes nothing the reasoner was asked: its answer stands.
    current = { ...m, terms: m.terms.map((t) => (t.id === id.Film ? { ...t, x: 300 } : t)) };
    expect(labels(await service.children(inferredOf(current)))).toEqual(['Agent', 'owl:Nothing']);

    // An edit: the answer is of an earlier revision.
    current = { ...m, terms: m.terms.map((t) => (t.id === id.Film ? { ...t, name: 'Motion picture' } : t)) };
    const after = await service.children(inferredOf(current));
    expect(after.nodes).toEqual([]);
    expect(after.provenance).toMatchObject({ status: 'stale', engine: { name: 'HermiT' }, revisionId: revisionOf(m) });
    expect(after.provenance.revisionId).not.toBe(after.revisionId);
    const s = await service.summary({ ...ontologyRef(current, null), mode: 'inferred', classIri: NS + 'Actor' });
    expect(s.inferred).toEqual({ provenance: after.provenance });
    expect(s.position).toBeUndefined();
    // The fast reasoner would have an answer for this revision. It is not the one that was chosen, and is not used.
    expect(s.inferred.provenance.engine?.id).toBe('dl');
    // What is stated is unaffected, and is read as it is now.
    expect(labels(await service.children(ask(current)))).toEqual(['Agent', 'Motion picture', 'Performer']);

    // Undone, the answer is of the ontology as it is again.
    current = m;
    expect(labels(await service.children(inferredOf(m)))).toEqual(['Agent', 'owl:Nothing']);
  });

  it('says why there is no answer: not asked, failed, or an inconsistent ontology', async () => {
    const { m, id } = cast();
    const statusOf = async (reasoning: LocalReasoning) => (await reasoned(() => m, () => reasoning).children(inferredOf(m))).provenance;
    expect(await statusOf({ engine: 'dl', run: null })).toMatchObject({ status: 'unavailable', engine: { id: 'dl', name: 'HermiT' } });
    expect(await statusOf({ engine: 'dl', run: { model: stable(m) } })).toMatchObject({ status: 'unavailable' });
    expect(await statusOf({ engine: 'dl', run: dlRun(m, id, { status: 'failed', consistency: 'unknown', errors: ['The reasoning service did not answer.'] }) })).toMatchObject({ status: 'failed', notes: ['The reasoning service did not answer.'] });
    expect(await statusOf({ engine: 'dl', run: dlRun(m, id, { consistency: 'inconsistent' }) })).toMatchObject({ status: 'inconsistent' });
  });

  it('uses the reasoner that is chosen and only that one', async () => {
    const { m, id } = cast();
    const run = dlRun(m, id);
    let reasoning: LocalReasoning = { engine: 'dl', run };
    const service = reasoned(() => m, () => reasoning);
    expect(await under(service, m, 'Agent')).toEqual(['Employee', 'Person']);
    expect((await service.children(inferredOf(m))).provenance.engine?.id).toBe('dl');
    // The fast reasoner is chosen: the hierarchy is its own, and nothing of the other's answer is in it.
    reasoning = { engine: 'fast', run };
    expect(await under(service, m, 'Agent')).toEqual(['Person']);
    expect(await under(service, m)).toEqual(['Agent', 'Film']);
    expect((await service.children(inferredOf(m))).provenance.engine?.id).toBe('fast');
    reasoning = { engine: 'dl', run };
    expect(await under(service, m)).toEqual(['Agent', 'owl:Nothing']);
  });

  it('has no inferred hierarchy for a type of model that is not reasoned over', async () => {
    const m = emptyModel('Glossary');
    m.mode = 'skos';
    m.terms = [newTerm({ id: 'a', name: 'Animal' }), newTerm({ id: 'd', name: 'Dog' })];
    m.relations = [newRelation({ from: 'd', to: 'a', kind: 'generalization' })];
    const model = withIris(m);
    const service = reasoned(() => model, () => FAST);
    await expect(service.children(inferredOf(model))).rejects.toMatchObject({ code: 'unsupported' });
    const s = await service.summary({ ...ontologyRef(model, null), mode: 'asserted', classIri: classIriOf(model, 'd')! });
    expect(s.inferred.provenance).toMatchObject({ engine: null, status: 'unavailable' });
    expect(s.position).toMatchObject({ superclasses: 1, depth: { min: 2, max: 2 } });
  });
});

describe('comparing two classes of the model in the editor', () => {
  /** Party and its subclass Organisation, each with a restriction on the same object property, as the ontology editor holds them. */
  function party(): { m: Model; id: Record<string, string> } {
    const m = emptyModel('Party');
    m.baseIri = NS;
    m.vocab.enabled = true;
    const id: Record<string, string> = {};
    const term = (name: string, patch: Parameters<typeof newTerm>[0] = {}) => {
      const t = newTerm({ name, ...patch });
      id[name] = t.id;
      m.terms.push(t);
      return t.id;
    };
    for (const name of ['Party', 'Organisation', 'Party local profile', 'Organisation local profile', 'Person']) term(name);
    term('global identifier', { type: 'property', range: 'xsd:string' });
    // The property is declared with Party as its domain. That is a statement about the property, not about Party.
    m.props = [newProp({ name: 'has local profile', description: '', chars: [], domain: [id.Party] })];
    const rel = (from: string, to: string, patch: Parameters<typeof newRelation>[0] extends infer P ? Partial<P> : never = {}) => m.relations.push(newRelation({ from: id[from], to: id[to], ...patch }));
    rel('Organisation', 'Party', { kind: 'generalization' });
    rel('Person', 'Party', { kind: 'generalization' });
    rel('Organisation local profile', 'Party local profile', { kind: 'generalization' });
    rel('Party', 'Party local profile', { label: 'has local profile' });
    rel('Organisation', 'Organisation local profile', { label: 'has local profile' });
    rel('Party', 'global identifier', { kind: 'property', restriction: 'max', restrictionN: 1 });
    rel('Person', 'Organisation', { predicate: 'owl:disjointWith' });
    return { m: withIris(m), id };
  }
  const iriOf = (m: Model, name: string) => m.terms.find((t) => t.name === name)!.iri!;
  const compare = (service: StructureService, m: Model, a: string, b: string) => service.compare({ ...ontologyRef(m, null), classAIri: iriOf(m, a), classBIri: iriOf(m, b) });

  it('reads the restrictions of each class, and tells own from inherited', async () => {
    const { m } = party();
    const c = await compare(serve(() => m), m, 'Party', 'Organisation');
    expect(c.relationship).toMatchObject({ kind: 'b-below-a', basis: 'asserted', verified: false });
    expect(c.axioms.map((r) => `${r.axiom.text}: ${r.a.state} / ${r.b.state}`)).toEqual([
      'global identifier max 1 xsd:string: own / inherited',
      'has local profile some Party local profile: own / inherited',
      'has local profile some Organisation local profile: absent / own',
    ]);
    const own = c.axioms[2];
    expect(own.axiom).toMatchObject({ kind: 'restriction', property: { iri: NS + 'hasLocalProfile', label: 'has local profile', type: 'object' }, quantifier: 'some', filler: { iri: NS + 'OrganisationLocalProfile', kind: 'class' } });
    expect(c.axioms[0].axiom).toMatchObject({ property: { type: 'data' }, quantifier: 'max', n: 1, filler: { label: 'xsd:string', kind: 'datatype' } });
    expect(c.axioms[1].b.from).toEqual([{ class: { iri: NS + 'Party', label: 'Party' }, basis: 'asserted' }]);
    // The restriction on Organisation is stronger because, and only because, its filler is stated to be a subclass of the other's.
    expect(own.relations).toEqual([{ kind: 'stronger', than: c.axioms[1].axiom.key, evidence: [{ sub: { iri: NS + 'OrganisationLocalProfile', label: 'Organisation local profile' }, sup: { iri: NS + 'PartyLocalProfile', label: 'Party local profile' }, basis: 'asserted' }] }]);
    // The domain of the property is not an axiom of Party and is not listed as one.
    expect(c.axioms).toHaveLength(3);
  });

  it('does not claim the stronger restriction once the filler’s superclass is withdrawn', async () => {
    const { m, id } = party();
    const cut = { ...m, relations: m.relations.filter((r) => !(r.from === id['Organisation local profile'] && r.kind === 'generalization')) };
    const unchecked = await compare(serve(() => cut), cut, 'Party', 'Organisation');
    expect(unchecked.axioms[2]).toMatchObject({ relations: [], unverified: [unchecked.axioms[1].axiom.key] });
    // With the fast reasoner asked, it is not left open: the reasoner does not relate the two fillers.
    const checked = await compare(createLocalStructureService(() => ({ model: cut, docId: null, reasoning: { engine: 'fast', run: null } })), cut, 'Party', 'Organisation');
    expect(checked.axioms[2]).toMatchObject({ relations: [], unverified: [] });
    expect(checked.reasoning).toMatchObject({ engine: { id: 'fast' }, status: 'current', completeness: 'incomplete' });
    expect(checked.relationship.verified).toBe(true);
  });

  it('includes class expressions that are kept as written, and the list of an enumeration', async () => {
    const { m, id } = party();
    const active = newTerm({ name: 'Active', type: 'instance' });
    const model = withIris({
      ...m,
      terms: [...m.terms.map((t) => (t.id === id.Party ? { ...t, axioms: ['rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :audits ; owl:hasValue :Registry ]'] } : t.id === id.Person ? { ...t, oneOf: [active.id] } : t)), active],
    });
    const c = await compare(serve(() => model), model, 'Organisation', 'Person');
    const text = c.axioms.filter((r) => r.axiom.kind === 'expression').map((r) => `${r.axiom.text}: ${r.a.state} / ${r.b.state}`);
    expect(text).toEqual(['[ a owl:Restriction ; owl:onProperty :audits ; owl:hasValue :Registry ]: inherited / inherited', '{ Active }: absent / own']);
    expect(c.relationship).toMatchObject({ kind: 'siblings', shared: [{ label: 'Party' }] });
  });

  it('finds stated disjointness, between the two or above them', async () => {
    const { m } = party();
    const c = await compare(serve(() => m), m, 'Person', 'Organisation');
    expect(c.disjointness).toMatchObject({ basis: 'asserted' });
    expect(c.stated.a.disjoints.map((x) => x.label)).toEqual(['Organisation']);
    // With the standard properties off the statement is not in force.
    const off = { ...m, vocab: { ...m.vocab, enabled: false } };
    expect((await compare(serve(() => off), off, 'Person', 'Organisation')).disjointness).toBeUndefined();
  });

  it('explains an entailed subclass relationship in the fast reasoner’s own words, and has none to give for the other reasoner', async () => {
    // The members of the enumeration are all Colours, so the enumeration is a kind of Colour: entailed, nowhere stated.
    const { m } = cast();
    const next: Model = { ...m, terms: [...m.terms], relations: [...m.relations] };
    const colour = newTerm({ name: 'Colour' });
    const red = newTerm({ name: 'Red', type: 'instance' });
    const light = newTerm({ name: 'Traffic light colour', oneOf: [red.id] });
    next.terms.push(colour, red, light);
    next.relations.push(newRelation({ from: red.id, to: colour.id, kind: 'generalization' }));
    const model = withIris(next);
    const query = { ...ontologyRef(model, null), subClassIri: iriOf(model, 'Traffic light colour'), superClassIri: iriOf(model, 'Colour') };
    const fast = await createLocalStructureService(() => ({ model, docId: null, reasoning: { engine: 'fast', run: null } })).explain(query);
    expect(fast).toMatchObject({ available: true, basis: 'entailed', provenance: { engine: { id: 'fast' } } });
    expect(fast.statements.join(' | ')).toBe('“Traffic light colour” is defined as the enumeration of “Red” | “Red” is an instance of “Colour”');
    // Asked of a reasoner that was not run: nothing is known beyond what is stated, and nothing is made up.
    const none = await createLocalStructureService(() => ({ model, docId: null, reasoning: { engine: 'dl', run: null } })).explain(query);
    expect(none).toMatchObject({ available: false, statements: [], provenance: { engine: { id: 'dl' }, status: 'unavailable' } });
    // A stated chain is explained by its links, whichever reasoner is in use.
    const stated = await createLocalStructureService(() => ({ model, docId: null, reasoning: { engine: 'dl', run: null } })).explain({ ...ontologyRef(model, null), subClassIri: NS + 'WorkingActor', superClassIri: NS + 'Person' });
    expect(stated).toMatchObject({ available: true, basis: 'asserted-chain', statements: ['WorkingActor SubClassOf Actor', 'Actor SubClassOf Person'] });
  });
});

describe('the explorer’s focus, in the store', () => {
  const st = useStore.getState;
  let id: Record<string, string>;
  beforeEach(() => {
    const made = cast();
    id = made.id;
    st().replaceModel(made.m);
    st().setStructure({ mode: 'explore' });
  });

  it('follows a class that is selected elsewhere, and nothing that is not one class', () => {
    expect(st().structure.focus).toBeNull();
    const at = st().structure.pointed;
    st().select([id.Actor]);
    expect(st().structure.focus).toBe(NS + 'Actor');
    expect(st().structure.pointed).toBe(at + 1);
    st().select([id['Tom Hanks']]);
    st().select([id.Person, id.Film]);
    st().select([]);
    st().select([], [st().model.relations[0].id]);
    expect(st().structure.focus).toBe(NS + 'Actor');
    expect(st().structure.pointed).toBe(at + 1);
    // Shown on the canvas from anywhere, it is in focus here too.
    st().focusTerm(id.Film);
    expect(st().structure.focus).toBe(NS + 'Film');
  });

  it('is its own: a class brought into focus in the explorer is not selected, so no editor opens', () => {
    st().select([id.Actor]);
    st().setStructure({ focus: NS + 'Film' });
    expect(st().structure.focus).toBe(NS + 'Film');
    expect(st().sel.terms).toEqual([id.Actor]);
    st().select([]);
    st().setStructure({ focus: NS + 'Person' });
    expect(st().sel).toEqual({ terms: [], rels: [] });
  });

  it('changes nothing in the model, and starts afresh with another model', () => {
    const model = st().model;
    const history = st().past.length;
    st().setStructure({ focus: NS + 'Actor', search: 'act', mode: 'compare' });
    expect(st().model).toBe(model);
    expect(st().past.length).toBe(history);
    st().setStructure({ hierarchy: 'inferred', markInferred: false });
    st().replaceModel(cast().m);
    expect(st().structure).toMatchObject({ focus: null, search: '', mode: 'compare', hierarchy: 'inferred', markInferred: false });
    st().setStructure({ hierarchy: 'asserted', markInferred: true });
  });
});
