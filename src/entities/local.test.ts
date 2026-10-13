import { beforeEach, describe, expect, it } from 'vitest';
import { withIris } from '../model/iri';
import { toTurtle } from '../model/rdf';
import type { ReasoningResult } from '../model/reasoning';
import { skosSample } from '../model/sample';
import { stressModel } from '../model/stress';
import { useStore } from '../model/store';
import { emptyModel, newTerm, type Model } from '../model/types';
import { ontologyRef } from '../structure/local';
import { EntityQueryError, ON, type ListKind, type EntityQuery, type EntityQueryService } from './contracts';
import { createLocalEntityService } from './local';

const st = useStore.getState;

/** A small ontology with one of everything the filters ask about. */
function office(): Model {
  const m = emptyModel('Office');
  m.baseIri = 'http://example.org/office#';
  m.prefixes = [{ prefix: 'foaf', iri: 'http://xmlns.com/foaf/0.1/' }];
  // With the RDFS/OWL layer on, a line can stand for a standard property such as owl:disjointWith.
  m.vocab = { enabled: true, map: {} };
  m.terms = [
    newTerm({ id: 'agent', name: 'Agent' }),
    newTerm({
      id: 'person',
      name: 'Person',
      synonyms: 'Human, Natural person',
      description: 'A human being.',
      fields: [
        { key: 'rdfs:label', value: 'Persona', lang: 'es' },
        { key: 'skos:hiddenLabel', value: 'Persn' },
        { key: 'dcterms:creator', value: 'Zebedee' },
      ],
    }),
    newTerm({ id: 'org', name: 'Organisation' }),
    newTerm({ id: 'staff', name: 'Staff' }),
    newTerm({ id: 'employee', name: 'Employee' }),
    newTerm({ id: 'chimera', name: 'Chimera' }),
    newTerm({ id: 'ghost', name: 'Ghost' }),
    newTerm({ id: 'foaf', name: 'Agent (FOAF)', iri: 'http://xmlns.com/foaf/0.1/Agent' }),
    newTerm({ id: 'age', name: 'age', type: 'property', range: 'xsd:integer', functional: true }),
    newTerm({ id: 'nickname', name: 'nickname', type: 'property' }),
    newTerm({ id: 'since', name: 'since', type: 'property', range: 'xsd:date' }),
    newTerm({ id: 'alice', name: 'Alice', type: 'instance' }),
    newTerm({ id: 'acme', name: 'Acme', type: 'instance' }),
    newTerm({ id: 'nobody', name: 'Nobody', type: 'instance' }),
  ];
  m.props = [
    { name: 'works for', description: 'Whom someone is employed by.', chars: ['functional'] },
    { name: 'employs', description: '', chars: ['inverseFunctional', 'asymmetric'], inverses: ['works for'] },
    { name: 'knows', description: '', chars: ['symmetric', 'transitive'] },
  ];
  return withIris(m);
}

let service: EntityQueryService;
let dl: ReasoningResult | undefined;
const ref = () => ontologyRef(st().model, null);
const ask = (kind: ListKind, query: Partial<EntityQuery> = {}) => service.query({ ...ref(), kind, ...query });
const found = async (kind: ListKind, query: Partial<EntityQuery> = {}) => (await ask(kind, query)).rows.map((r) => r.label);
const describeKind = (kind: ListKind) => service.describe({ ...ref(), kind });
const line = (from: string, to: string, more: Record<string, unknown> = {}) => st().addRelation({ from, to, ...more });

beforeEach(() => {
  dl = undefined;
  st().replaceModel(office());
  for (const [sub, sup] of [['person', 'agent'], ['org', 'agent'], ['employee', 'person'], ['employee', 'staff'], ['chimera', 'person'], ['chimera', 'org']]) line(sub, sup, { kind: 'generalization' });
  line('person', 'org', { predicate: 'owl:disjointWith' });
  line('employee', 'org', { label: 'works for' });
  line('org', 'employee', { label: 'employs' });
  line('person', 'age');
  line('employee', 'since');
  line('alice', 'employee');
  line('acme', 'org');
  line('alice', 'acme', { label: 'works for' });
  service = createLocalEntityService(() => ({ model: st().model, docId: null, dl }));
});

describe('classes', () => {
  it('are found by name, synonym, a label in another language, the IRI in full or with a prefix, and the definition', async () => {
    expect(await found('class', { search: 'natural' })).toEqual(['Person']);
    expect(await found('class', { search: 'PERSONA' })).toEqual(['Person']);
    expect(await found('class', { search: 'persn' })).toEqual(['Person']);
    expect(await found('class', { search: 'human being' })).toEqual(['Person']);
    expect(await found('class', { search: 'xmlns.com/foaf' })).toEqual(['Agent (FOAF)']);
    expect(await found('class', { search: 'foaf:agent' })).toEqual(['Agent (FOAF)']);
    expect(await found('class', { search: ':Agent' })).toEqual(['Agent', 'Agent (FOAF)']);
    expect(await found('class', { search: 'office#Gho' })).toEqual(['Ghost']);
    // An annotation that is no name of the class is not what a search for the class goes by.
    expect(await found('class', { search: 'zebedee' })).toEqual([]);
    const [row] = (await ask('class', { search: 'persona' })).rows;
    expect(row).toMatchObject({ key: 'person', iri: 'http://example.org/office#Person', matches: [{ field: 'label', property: 'rdfs:label', text: 'Persona', ranges: [[0, 7]] }] });
  });

  it('are sorted by name, IRI, and how many superclasses, subclasses, restrictions and relationships they have', async () => {
    const d = await describeKind('class');
    expect(d.sorts.map((s) => `${s.id}:${s.label}${s.numeric ? '#' : ''}`)).toEqual(['name:Name', 'iri:IRI', 'superclasses:Asserted superclasses#', 'subclasses:Subclasses#', 'restrictions:Asserted restrictions#', 'relations:Relationships#']);
    expect(d.total).toBe(8);
    expect(await found('class', { sort: { by: 'name', dir: 'desc' } })).toEqual(['Staff', 'Person', 'Organisation', 'Ghost', 'Employee', 'Chimera', 'Agent (FOAF)', 'Agent']);
    expect((await found('class', { sort: { by: 'superclasses', dir: 'desc' } })).slice(0, 4)).toEqual(['Employee', 'Chimera', 'Person', 'Organisation']);
    expect((await found('class', { sort: { by: 'subclasses', dir: 'desc' } })).slice(0, 3)).toEqual(['Agent', 'Person', 'Organisation']);
    expect((await found('class', { sort: { by: 'iri', dir: 'asc' } })).slice(0, 2)).toEqual(['Agent', 'Chimera']);
    expect((await found('class', { sort: { by: 'iri', dir: 'asc' } })).at(-1)).toBe('Agent (FOAF)');
    expect((await found('class', { sort: { by: 'relations', dir: 'desc' } }))[0]).toBe('Organisation');
  });

  it('are filtered by where they stand in the hierarchy and by what is asserted of them', async () => {
    expect(await found('class', { filters: { position: ['root'] } })).toEqual(['Agent', 'Staff', 'Ghost', 'Agent (FOAF)']);
    expect(await found('class', { filters: { position: ['leaf'] } })).toEqual(['Employee', 'Chimera', 'Ghost', 'Agent (FOAF)']);
    expect(await found('class', { filters: { position: ['root', 'leaf'] } })).toEqual(['Ghost', 'Agent (FOAF)']);
    expect(await found('class', { filters: { multipleInheritance: [ON] } })).toEqual(['Employee', 'Chimera']);
    expect(await found('class', { filters: { assertedRestrictions: [ON] } })).toEqual(['Person', 'Organisation', 'Employee']);
    expect((await found('class', { sort: { by: 'restrictions', dir: 'desc' } }))[0]).toBe('Employee');
    const d = await describeKind('class');
    expect(d.filters.map((f) => `${f.id}:${f.type}`)).toEqual(['position:all', 'multipleInheritance:flag', 'assertedRestrictions:flag', 'inferredRestrictions:flag', 'unsatisfiable:flag']);
    expect(d.filters[0].options).toEqual([
      { value: 'root', label: 'Root', count: 4 },
      { value: 'leaf', label: 'Leaf', count: 4 },
    ]);
    expect(d.filters[1].options).toEqual([{ value: ON, label: 'Yes', count: 2 }]);
    expect(d.filters.every((f) => f.unavailable === undefined && f.about.length > 10)).toBe(true);
  });

  it('are filtered by what a reasoner works out, and the answer says whose work that is', async () => {
    const unsat = await ask('class', { filters: { unsatisfiable: [ON] } });
    expect(unsat.rows.map((r) => r.label)).toEqual(['Chimera']);
    expect(unsat.notes).toEqual(['Unsatisfiable classes are as found by the fast reasoner (RDFS / partial OWL RL), which does not find everything an OWL 2 DL reasoner would.']);
    const inherited = await ask('class', { filters: { inferredRestrictions: [ON] } });
    // Employee inherits what is said of Person; Chimera what is said of Person and of Organisation.
    expect(inherited.rows.map((r) => r.label)).toEqual(['Employee', 'Chimera']);
    expect(inherited.notes[0]).toMatch(/^Inferred restrictions are those inherited through what the fast reasoner/);
    // What an OWL 2 DL reasoner found about this very model is taken in beside it.
    dl = { engine: { id: 'dl', name: 'HermiT', version: '1.4' }, status: 'complete', consistency: 'consistent', unsatisfiableClasses: ['ghost'], types: [{ individual: 'nobody', class: 'staff', asserted: false, direct: true }] } as unknown as ReasoningResult;
    const both = await ask('class', { filters: { unsatisfiable: [ON] } });
    expect(both.rows.map((r) => r.label)).toEqual(['Chimera', 'Ghost']);
    expect(both.notes).toEqual(['Unsatisfiable classes are as found by HermiT 1.4 (OWL 2 DL).']);
    expect(await found('individual', { filters: { inferredType: ['staff'] } })).toEqual(['Alice', 'Nobody']);
  });

  it('cannot be asked what a reasoner works out while the ontology contradicts itself', async () => {
    // An instance of a class that can have none.
    line('nobody', 'chimera');
    const d = await describeKind('class');
    const unsat = d.filters.find((f) => f.id === 'unsatisfiable')!;
    expect(unsat.unavailable).toMatch(/inconsistent/);
    expect(d.filters.find((f) => f.id === 'position')!.unavailable).toBeUndefined();
    const page = await ask('class', { filters: { unsatisfiable: [ON], multipleInheritance: [ON] } });
    expect(page.rows.map((r) => r.label)).toEqual(['Employee', 'Chimera']);
    expect(page.notes).toEqual([`“Unsatisfiable” is not applied: ${unsat.unavailable}`]);
    expect((await describeKind('individual')).filters.find((f) => f.id === 'inferredType')!.unavailable).toMatch(/inconsistent/);
  });
});

describe('object properties', () => {
  it('are found, sorted and filtered by what is declared about them', async () => {
    expect(await found('objectProperty')).toEqual(['employs', 'knows', 'works for']);
    expect(await found('objectProperty', { search: 'employed by' })).toEqual(['works for']);
    expect(await found('objectProperty', { search: 'office#emp' })).toEqual(['employs']);
    expect(await found('objectProperty', { sort: { by: 'relations', dir: 'desc' } })).toEqual(['works for', 'employs', 'knows']);
    expect(await found('objectProperty', { sort: { by: 'name', dir: 'desc' } })).toEqual(['works for', 'knows', 'employs']);
    // A domain that follows where the property is used is a domain; a property used nowhere has none.
    expect(await found('objectProperty', { filters: { domain: ['with'] } })).toEqual(['employs', 'works for']);
    expect(await found('objectProperty', { filters: { domain: ['without'], range: ['without'] } })).toEqual(['knows']);
    expect(await found('objectProperty', { filters: { characteristics: ['symmetric', 'transitive'] } })).toEqual(['knows']);
    expect(await found('objectProperty', { filters: { characteristics: ['symmetric', 'functional'] } })).toEqual([]);
    expect(await found('objectProperty', { filters: { characteristics: ['functional'] } })).toEqual(['works for']);
    // Stated on one of the two, it holds for both.
    expect(await found('objectProperty', { filters: { inverse: [ON] } })).toEqual(['employs', 'works for']);
    const d = await describeKind('objectProperty');
    expect(d.filters.map((f) => `${f.id}:${f.type}`)).toEqual(['domain:one', 'range:one', 'characteristics:all', 'inverse:flag']);
    expect(d.filters[2].options.find((o) => o.value === 'transitive')).toEqual({ value: 'transitive', label: 'Transitive', count: 1 });
    expect(d.filters[0].options).toEqual([
      { value: 'with', label: 'Set', count: 2 },
      { value: 'without', label: 'Not set', count: 1 },
    ]);
  });
});

describe('data properties', () => {
  it('are found, sorted and filtered by domain, range, datatype and being functional', async () => {
    expect(await found('dataProperty')).toEqual(['age', 'nickname', 'since']);
    expect(await found('dataProperty', { search: 'office#nick' })).toEqual(['nickname']);
    expect(await found('dataProperty', { sort: { by: 'range', dir: 'asc' } })).toEqual(['since', 'age', 'nickname']);
    expect(await found('dataProperty', { sort: { by: 'relations', dir: 'desc' } })).toEqual(['age', 'since', 'nickname']);
    expect(await found('dataProperty', { filters: { functional: [ON] } })).toEqual(['age']);
    expect(await found('dataProperty', { filters: { range: ['without'] } })).toEqual(['nickname']);
    expect(await found('dataProperty', { filters: { domain: ['with'] } })).toEqual(['age', 'since']);
    expect(await found('dataProperty', { filters: { datatype: ['xsd:date', 'xsd:integer'] } })).toEqual(['age', 'since']);
    expect(await found('dataProperty', { filters: { datatype: ['xsd:date'], functional: [ON] } })).toEqual([]);
    const d = await describeKind('dataProperty');
    expect(d.filters.find((f) => f.id === 'datatype')!.options).toEqual([
      { value: 'xsd:date', label: 'date', count: 1 },
      { value: 'xsd:integer', label: 'integer', count: 1 },
    ]);
  });
});

describe('individuals', () => {
  it('are filtered by the classes they are stated to be instances of, and by the ones that follow', async () => {
    expect(await found('individual')).toEqual(['Alice', 'Acme', 'Nobody']);
    expect(await found('individual', { filters: { assertedType: ['employee'] } })).toEqual(['Alice']);
    expect(await found('individual', { filters: { assertedType: ['person'] } })).toEqual([]);
    expect(await found('individual', { filters: { assertedType: ['employee', 'org'] } })).toEqual(['Alice', 'Acme']);
    // An employee is a person and an agent, though neither is stated of Alice.
    expect(await found('individual', { filters: { inferredType: ['person'] } })).toEqual(['Alice']);
    expect(await found('individual', { filters: { inferredType: ['agent'] } })).toEqual(['Alice', 'Acme']);
    expect(await found('individual', { filters: { inferredType: ['employee'] } })).toEqual(['Alice']);
    expect(await found('individual', { sort: { by: 'type', dir: 'asc' } })).toEqual(['Alice', 'Acme', 'Nobody']);
    expect(await found('individual', { sort: { by: 'type', dir: 'desc' } })).toEqual(['Acme', 'Alice', 'Nobody']);
    // A class that is gone is a class nothing is an instance of.
    expect(await found('individual', { filters: { assertedType: ['gone'] } })).toEqual([]);
  });

  it('offers the classes there are to choose from: the ones with instances first, by what is typed', async () => {
    const options = async (filter: string, search?: string) => (await service.options({ ...ref(), kind: 'individual', filter, search })).options;
    expect(await options('assertedType')).toEqual([
      { value: 'employee', label: 'Employee', count: 1 },
      { value: 'org', label: 'Organisation', count: 1 },
    ]);
    expect((await options('inferredType', 'agent')).map((o) => o.label)).toEqual(['Agent', 'Agent (FOAF)']);
    expect((await options('inferredType', 'foaf:')).map((o) => o.label)).toEqual(['Agent (FOAF)']);
    expect((await describeKind('individual')).filters.map((f) => `${f.id}:${f.type}:${f.entities}`)).toEqual(['assertedType:any:true', 'inferredType:any:true']);
  });
});

describe('relationships', () => {
  it('are found by their name, their ends and their kind, and filtered by each of those', async () => {
    const all = await ask('relationship');
    expect(all.total).toBe(14);
    expect((await ask('relationship', { search: 'alice' })).matched).toBe(2);
    expect((await ask('relationship', { search: 'works acme' })).matched).toBe(1);
    expect((await ask('relationship', { search: 'disjoint' })).matched).toBe(1);
    expect((await ask('relationship', { filters: { kind: ['generalization'] } })).matched).toBe(6);
    expect((await ask('relationship', { filters: { kind: ['instanceOf', 'property'] } })).matched).toBe(4);
    expect((await ask('relationship', { filters: { kind: ['standard'] } })).matched).toBe(1);
    expect((await ask('relationship', { filters: { from: ['employee'] } })).matched).toBe(4);
    expect((await ask('relationship', { filters: { from: ['employee'], to: ['org', 'staff'] } })).matched).toBe(2);
    expect((await ask('relationship', { filters: { from: ['employee'], kind: ['object'] } })).rows.map((r) => r.label)).toEqual(['works for']);
    const d = await describeKind('relationship');
    expect(d.filters.map((f) => `${f.id}:${f.type}`)).toEqual(['kind:any', 'from:any', 'to:any']);
    expect(d.filters[0].options).toEqual([
      { value: 'generalization', label: 'Is a (generalization)', count: 6 },
      { value: 'standard', label: 'Standard property', count: 1 },
      { value: 'object', label: 'Object property', count: 3 },
      { value: 'property', label: 'Has data property', count: 2 },
      { value: 'instanceOf', label: 'Is Instance Of', count: 2 },
    ]);
    expect((await service.options({ ...ref(), kind: 'relationship', filter: 'from', search: 'e' })).options.map((o) => `${o.label} ${o.count}`)).toEqual(['Employee 4', 'Person 3', 'Alice 2', 'Chimera 2', 'Acme 1']);
  });

  it('are sorted by either end, by name and by kind, and otherwise stay as they were drawn', async () => {
    const ends = async (query: Partial<EntityQuery>) => {
      const m = st().model;
      const name = (id: string) => m.terms.find((t) => t.id === id)!.name;
      return (await ask('relationship', query)).rows.map((r) => m.relations.find((x) => x.id === r.key)!).map((r) => `${name(r.from)}>${name(r.to)}`);
    };
    expect((await ends({})).slice(0, 3)).toEqual(['Person>Agent', 'Organisation>Agent', 'Employee>Person']);
    expect((await ends({ sort: { by: 'from', dir: 'asc' } })).slice(0, 4)).toEqual(['Acme>Organisation', 'Alice>Employee', 'Alice>Acme', 'Chimera>Person']);
    expect((await ends({ sort: { by: 'to', dir: 'desc' } }))[0]).toBe('Employee>Staff');
    expect((await ask('relationship', { sort: { by: 'kind', dir: 'asc' } })).rows[0].label).toBe('Has data property');
    expect((await ask('relationship', { sort: { by: 'label', dir: 'asc' } })).rows.slice(0, 3).map((r) => r.label)).toEqual(['employs', 'works for', 'works for']);
  });
});

describe('the model that is asked about', () => {
  it('is never changed by a question, whatever is asked', async () => {
    const model = st().model;
    const ttl = toTurtle(model);
    const order = model.terms.map((t) => t.id);
    for (const kind of ['class', 'objectProperty', 'dataProperty', 'individual', 'relationship'] as const) {
      const d = await describeKind(kind);
      for (const s of d.sorts) await ask(kind, { sort: { by: s.id, dir: 'desc' }, search: 'a' });
      for (const f of d.filters) await ask(kind, { filters: { [f.id]: f.entities ? ['person'] : [f.options[0]?.value ?? ON] } });
    }
    expect(st().model).toBe(model);
    expect(st().model.terms.map((t) => t.id)).toEqual(order);
    expect(toTurtle(st().model)).toBe(ttl);
    expect(st().past.length).toBe(useStore.getState().past.length);
  });

  it('is asked about by revision: an edit makes what was asked before out of date, moving a term does not', async () => {
    const before = ref();
    st().updateTerm('ghost', { name: 'Spectre' });
    const edited = ref();
    expect(edited.revisionId).not.toBe(before.revisionId);
    await expect(service.query({ ...before, kind: 'class' })).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(service.query({ ...before, kind: 'class' })).rejects.toBeInstanceOf(EntityQueryError);
    expect(await found('class', { search: 'spectre' })).toEqual(['Spectre']);
    // Where a term sits is no part of what the ontology says.
    st().moveTerms(['agent'], 40, 40);
    expect(ref()).toEqual(edited);
    expect((await service.query({ ...edited, kind: 'class' })).total).toBe(8);
    st().undo();
    // Back at the model it was: the same revision again.
    expect(ref()).toEqual(before);
  });

  it('has for a vocabulary what a vocabulary has: concepts and relationships, in its own words', async () => {
    st().replaceModel(skosSample());
    const d = await describeKind('class');
    expect(d.total).toBe(st().model.terms.length);
    expect(d.sorts.map((s) => s.label)).toEqual(['Name', 'IRI', 'Asserted broader concepts', 'Narrower concepts', 'Relationships']);
    expect(d.filters.map((f) => f.id)).toEqual(['position', 'multipleInheritance']);
    expect(d.filters[0].about).toBe('Root: a concept with no asserted broader concept. Leaf: one with no narrower concept. Both together: one that stands alone.');
    expect((await describeKind('dataProperty')).total).toBe(0);
    expect((await describeKind('individual')).total).toBe(0);
    // “Related” in the sample is skos:related, a standard property.
    expect((await describeKind('relationship')).filters[0].options.map((o) => o.label).sort()).toEqual(['Is a (broader)', 'Standard property']);
    const roots = await ask('class', { filters: { position: ['root'] } });
    expect(roots.matched).toBeGreaterThan(0);
    expect(roots.matched).toBeLessThan(d.total);
  });

  it('answers quickly for a model of a thousand terms, and makes its records once for a revision', async () => {
    st().replaceModel(stressModel());
    const first = performance.now();
    await ask('class');
    await ask('relationship');
    const made = performance.now() - first;
    const t = performance.now();
    for (let i = 0; i < 20; i++) {
      await ask('class', { search: 'class ' + i, sort: { by: 'subclasses', dir: 'desc' }, filters: { position: ['leaf'] } });
      await ask('relationship', { search: 'attribute ' + i, sort: { by: 'from', dir: 'asc' } });
    }
    const each = (performance.now() - t) / 40;
    expect(made).toBeLessThan(2000);
    expect(each).toBeLessThan(25);
    expect((await ask('relationship')).total).toBe(st().model.relations.length);
  });
});

describe('what the page keeps of each list', () => {
  it('is a search, an order and filters of its own for each list, apart from the model', () => {
    const model = st().model;
    const steps = st().past.length;
    st().setEntityView('class', { search: 'person', sort: { by: 'subclasses', dir: 'desc' }, filters: { position: ['leaf'] } });
    st().setEntityView('individual', { search: 'alice' });
    expect(st().entityViews.class).toEqual({ search: 'person', sort: { by: 'subclasses', dir: 'desc' }, filters: { position: ['leaf'] } });
    expect(st().entityViews.individual).toEqual({ search: 'alice', sort: null, filters: {} });
    expect(st().entityViews.relationship).toEqual({ search: '', sort: null, filters: {} });
    // Each is put back on its own.
    st().setEntityView('class', { search: '' });
    expect(st().entityViews.class).toMatchObject({ search: '', sort: { by: 'subclasses', dir: 'desc' }, filters: { position: ['leaf'] } });
    st().setEntityView('class', { filters: {} });
    expect(st().entityViews.class).toMatchObject({ sort: { by: 'subclasses', dir: 'desc' }, filters: {} });
    // None of it is the model's: nothing to save, nothing to undo.
    expect(st().model).toBe(model);
    expect(st().past.length).toBe(steps);
    expect(JSON.stringify(st().model)).not.toMatch(/entityViews|"search"/);
  });

  it('starts afresh with another model, whose entities the filters could not name', () => {
    st().setEntityView('individual', { search: 'alice', filters: { assertedType: ['employee'] } });
    st().setEntityFiltersOpen(true);
    st().replaceModel(skosSample());
    expect(st().entityViews.individual).toEqual({ search: '', sort: null, filters: {} });
    // Whether the filters are open is how the page is used, not something about a model.
    expect(st().entityFiltersOpen).toBe(true);
    st().setEntityFiltersOpen(false);
  });
});
