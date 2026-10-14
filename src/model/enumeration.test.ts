import { dataProperty, XSD } from './expressions';
import { describe, expect, it } from 'vitest';
import { addEnumMember, createEnumMember, enumerationExpression, enumMembers, isEnumeration, removeEnumMember, setAllDifferent, setEnumeration } from './axioms';
import { edgeTypes, extractSubgraph } from './subgraph';
import { enumerationEdges } from './edgeKinds';
import { EDGE_TYPES, patchEdgeType, resolveEdge } from './graphStyle';
import { viewerData } from './htmlExport';
import { withIris } from './iri';
import { fromTurtle, toTurtle } from './rdf';
import { stable } from './stable';
import { useStore } from './store';
import { emptyModel, newTerm, normalizeModel, type Model } from './types';

const lights = (): Model => {
  const m = emptyModel('Traffic');
  m.baseIri = 'http://example.org/traffic#';
  m.terms = [
    newTerm({ id: 'color', name: 'Traffic light color', iri: m.baseIri + 'TrafficLightColor' }),
    newTerm({ id: 'red', name: 'Red', type: 'instance' }),
    newTerm({ id: 'yellow', name: 'Yellow', type: 'instance' }),
    newTerm({ id: 'green', name: 'Green', type: 'instance' }),
    newTerm({ id: 'signal', name: 'Signal' }),
  ];
  return withIris(m);
};
const ok = (e: { model?: Model; error?: string }): Model => {
  expect(e.error).toBeUndefined();
  return e.model!;
};
const enumerated = (): Model => ['red', 'yellow', 'green'].reduce((m, id) => ok(addEnumMember(m, 'color', id)), ok(setEnumeration(lights(), 'color', true)));
const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';
const term = (m: Model, name: string) => m.terms.find((t) => t.name === name)!;

describe('enumeration classes', () => {
  it('defines a class by listing its members, and leaves it a class', () => {
    let m = lights();
    expect(isEnumeration(term(m, 'Traffic light color'))).toBe(false);
    m = ok(setEnumeration(m, 'color', true));
    expect(term(m, 'Traffic light color')).toMatchObject({ type: 'concept', oneOf: [] });
    m = ok(addEnumMember(m, 'color', 'red'));
    m = ok(addEnumMember(m, 'color', 'green'));
    expect(enumMembers(m, term(m, 'Traffic light color')).map((t) => t.name)).toEqual(['Red', 'Green']);
    expect(enumerationExpression(m, term(m, 'Traffic light color'))).toBe('{ Red, Green }');
    // Only individuals, and each once.
    expect(addEnumMember(m, 'color', 'red').error).toMatch(/already a member/);
    expect(addEnumMember(m, 'color', 'signal').error).toMatch(/is a class/);
    expect(addEnumMember(m, 'signal', 'red').error).toMatch(/not defined as an enumeration/);
    // Two terms with one IRI are one individual: it is not listed twice under two names.
    const twin = { ...m, terms: [...m.terms, newTerm({ id: 'rouge', name: 'Rouge', type: 'instance', iri: term(m, 'Red').iri })] };
    expect(addEnumMember(twin, 'color', 'rouge').error).toMatch(/same IRI/);
    m = removeEnumMember(m, 'color', 'red');
    expect(term(m, 'Traffic light color').oneOf).toEqual(['green']);
    expect(term(m, 'Red')).toBeDefined();
  });

  it('makes a new individual straight into the enumeration, or takes the one of that name', () => {
    let m = ok(setEnumeration(lights(), 'color', true));
    const made = createEnumMember(m, 'color', 'Flashing amber');
    m = ok(made);
    expect(term(m, 'Flashing amber')).toMatchObject({ type: 'instance', id: made.id });
    expect(term(m, 'Traffic light color').oneOf).toEqual([made.id]);
    const reused = createEnumMember(m, 'color', 'red');
    expect(reused.id).toBe('red');
    expect(ok(reused).terms.filter((t) => t.name.toLowerCase() === 'red')).toHaveLength(1);
    expect(createEnumMember(ok(reused), 'color', 'Red').error).toMatch(/already a member/);
    expect(createEnumMember(m, 'color', '  ').error).toMatch(/needs a name/);
  });

  it('lets one individual be a member of several enumerations, and changes nothing else about the class', () => {
    let m = enumerated();
    m = { ...m, terms: m.terms.map((t) => (t.id === 'color' ? { ...t, description: 'The colours a signal shows.', fields: [{ key: 'adms:status', value: 'Approved' }], classAxioms: [{ id: 'x', kind: 'SubClassOf' as const, expression: { type: 'DataHasValue' as const, property: dataProperty('http://example.org/p'), value: { value: '1', datatype: XSD + 'integer' } } }] } : t)) };
    m = ok(setEnumeration(m, 'signal', true));
    m = ok(addEnumMember(m, 'signal', 'red'));
    expect(term(m, 'Signal').oneOf).toEqual(['red']);
    expect(term(m, 'Traffic light color').oneOf).toEqual(['red', 'yellow', 'green']);
    // Turning the definition off again keeps the class, its annotations and its other axioms, and the individuals.
    const off = setEnumeration(m, 'color', false);
    expect(off.note).toMatch(/3 former members are still in the model/);
    const c = term(off.model!, 'Traffic light color');
    expect(c.oneOf).toBeUndefined();
    expect(c).toMatchObject({ type: 'concept', description: 'The colours a signal shows.', fields: [{ key: 'adms:status', value: 'Approved' }] });
    expect(c.classAxioms).toHaveLength(1);
    expect(off.model!.terms.filter((t) => t.type === 'instance')).toHaveLength(3);
  });

  it('is written as an equivalent class that is a list, and never as a triple from the class to an individual', () => {
    const ttl = toTurtle(enumerated());
    expect(block(ttl, ':TrafficLightColor')).toContain('owl:equivalentClass [ a owl:Class ; owl:oneOf ( :Red :Yellow :Green ) ]');
    expect(block(ttl, ':TrafficLightColor')).toMatch(/^:TrafficLightColor a owl:Class ;/);
    // Being listed is not being typed: the individuals are not given the class as their rdf:type.
    expect(block(ttl, ':Red')).toMatch(/^:Red a owl:NamedIndividual ;/);
    expect(block(ttl, ':Red')).not.toContain('TrafficLightColor');
    // Nothing says they are different individuals unless it was asked for.
    expect(ttl).not.toContain('owl:AllDifferent');
    expect(ttl).not.toContain('owl:differentFrom');
    const different = toTurtle(setAllDifferent(enumerated(), 'color', true));
    expect(different).toContain('[] a owl:AllDifferent ;\n    owl:distinctMembers ( :Red :Yellow :Green ) .');
    // An enumeration with nobody in it yet says nothing: it would make the class equivalent to owl:Nothing.
    expect(toTurtle(ok(setEnumeration(lights(), 'color', true)))).not.toContain('owl:oneOf');
  });

  it('comes back from Turtle as the same enumeration, with the individuals it lists', () => {
    const m = setAllDifferent(enumerated(), 'color', true);
    const ttl = toTurtle(m);
    const back = fromTurtle(ttl);
    const c = term(back, 'Traffic light color');
    expect(c.type).toBe('concept');
    expect(enumMembers(back, c).map((t) => [t.name, t.type, t.iri])).toEqual(m.terms.filter((t) => t.type === 'instance').map((t) => [t.name, 'instance', t.iri]));
    expect(c.allDifferent).toBe(true);
    expect(c.classAxioms).toBeUndefined();
    // Kept as one statement on the enumeration, not as a relationship between every two members.
    expect(back.relations).toEqual([]);
    expect(toTurtle(back)).toBe(ttl);
  });

  it('reads the enumeration other tools write, and keeps what it cannot edit word for word', () => {
    const back = fromTurtle(`
      @prefix : <http://example.org/traffic#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      :TrafficLightColor a owl:Class ; rdfs:label "Traffic light color" ;
          owl:equivalentClass [ a owl:Class ; owl:oneOf ( :Red :Yellow :Green :Red ) ] .
      :Phase a owl:Class ; rdfs:subClassOf [ a owl:Class ; owl:oneOf ( :Red :Green ) ] .
      :Odd a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf ( :Red "amber" ) ] .
      :Both a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf ( :Red ) ] , [ a owl:Class ; owl:oneOf ( :Green ) ] .
      :Green a owl:NamedIndividual ; rdfs:label "Go" .
      [] a owl:AllDifferent ; owl:distinctMembers ( :Red :Green ) .`);
    const c = term(back, 'Traffic light color');
    // Listed twice in the file, a member once; :Red and :Yellow are individuals though the file never declares them.
    expect(enumMembers(back, c).map((t) => [t.name, t.type, t.iri])).toEqual([
      ['Red', 'instance', 'http://example.org/traffic#Red'],
      ['Yellow', 'instance', 'http://example.org/traffic#Yellow'],
      ['Go', 'instance', 'http://example.org/traffic#Green'],
    ]);
    expect(c.allDifferent).toBeUndefined();
    // A subclass of a list, and a list with a literal in it, are not this kind of definition: axioms of the class.
    const T = 'http://example.org/traffic#';
    expect(term(back, 'Phase').oneOf).toBeUndefined();
    expect(term(back, 'Phase').classAxioms).toMatchObject([{ kind: 'SubClassOf', expression: { type: 'ObjectOneOf', individuals: [{ iri: T + 'Red' }, { iri: T + 'Green' }] } }]);
    expect(term(back, 'Odd').oneOf).toBeUndefined();
    // A list of an individual and a literal is no class expression OWL has: kept as it was read.
    expect(term(back, 'Odd').classAxioms).toMatchObject([{ kind: 'EquivalentClasses', expression: { type: 'Unparsed', turtle: expect.stringContaining('"amber"') } }]);
    // Of two lists the first is the definition and the second is an axiom.
    expect(enumMembers(back, term(back, 'Both')).map((t) => t.name)).toEqual(['Red']);
    expect(term(back, 'Both').classAxioms).toMatchObject([{ kind: 'EquivalentClasses', expression: { type: 'ObjectOneOf', individuals: [{ iri: T + 'Green' }] } }]);
    // "All different" of two of them is a matter between those two, and stays a relationship.
    expect(back.relations.filter((r) => r.predicate === 'owl:differentFrom')).toHaveLength(1);
    // Written out again, every list is still a list and nothing was flattened into types.
    const again = toTurtle(back);
    expect(again.match(/owl:oneOf/g)).toHaveLength(5);
    expect(block(again, ':Red')).not.toMatch(/TrafficLightColor|Phase|Both/);
  });

  it('is kept in a saved model, is part of what the model means, and follows its members', () => {
    const m = setAllDifferent(enumerated(), 'color', true);
    const back = normalizeModel(JSON.parse(JSON.stringify(m)));
    expect(term(back, 'Traffic light color')).toMatchObject({ oneOf: ['red', 'yellow', 'green'], allDifferent: true });
    // A list that names a term that is gone, or the class itself, is tidied on the way in.
    const untidy = JSON.parse(JSON.stringify(m));
    untidy.terms[0].oneOf = ['red', 'gone', 'color', 'red'];
    expect(normalizeModel(untidy).terms[0].oneOf).toEqual(['red']);
    // Unlike moving a term, changing an enumeration changes the meaning: reasoning and validation start afresh.
    stable(m);
    expect(stable(removeEnumMember(m, 'color', 'red'))).not.toBe(m);
    // Deleting an individual takes it off every list it was on.
    useStore.getState().replaceModel(m);
    useStore.getState().remove(['yellow'], []);
    expect(term(useStore.getState().model, 'Traffic light color').oneOf).toEqual(['red', 'green']);
  });
});

describe('enumeration membership in the graph', () => {
  it('is a line from the class to each member that is drawn, not stored', () => {
    const m = enumerated();
    expect(enumerationEdges(m).map((e) => [e.id, e.from, e.to, e.kind])).toEqual([
      ['oneof:color|red', 'color', 'red', 'oneOf'],
      ['oneof:color|yellow', 'color', 'yellow', 'oneOf'],
      ['oneof:color|green', 'color', 'green', 'oneOf'],
    ]);
    // No relationship of the model stands for it, so none is written to RDF for it either.
    expect(m.relations).toEqual([]);
    expect(toTurtle(m).match(/owl:oneOf/g)).toHaveLength(1);
    // An ordinary class, and an enumeration nobody is in, have no such lines.
    expect(enumerationEdges(lights())).toEqual([]);
    expect(enumerationEdges(ok(setEnumeration(lights(), 'color', true)))).toEqual([]);
    // The style editor knows it as a kind of line of its own.
    expect(EDGE_TYPES).toContain('oneOf');
    expect(resolveEdge(patchEdgeType(m.style, 'oneOf', { color: 'purple' }), 'oneOf', '')).toEqual({ color: 'purple' });
    expect(resolveEdge(patchEdgeType(m.style, 'oneOf', { color: 'purple' }), 'type', '')).toEqual({});
  });

  it('is followed by a subgraph, and can be switched off there like any other kind of line', () => {
    const m = enumerated();
    expect(edgeTypes(m)).toContainEqual({ key: 'owl:oneOf', label: 'Enumeration membership (owl:oneOf)', count: 3 });
    const options = { roots: ['color'], depth: 1, direction: 'both' as const, off: [] as string[], expanded: [], hidden: [], maxNodes: 50 };
    const sub = extractSubgraph(m, options);
    expect(new Set(sub.terms)).toEqual(new Set(['color', 'red', 'yellow', 'green']));
    expect(sub.rels).toEqual(['oneof:color|red', 'oneof:color|yellow', 'oneof:color|green']);
    // From a member, the class that lists it is one step away.
    expect(extractSubgraph(m, { ...options, roots: ['red'] }).terms).toEqual(['red', 'color']);
    const without = extractSubgraph(m, { ...options, off: ['owl:oneOf'] });
    expect(without.terms).toEqual(['color']);
    expect(without.rels).toEqual([]);
  });

  it('is in the exported page with the class and with each member', () => {
    const m = enumerated();
    const d = viewerData(m, new Date('2026-10-12T09:00:00Z'));
    const lines = d.rels.filter((r) => r.hier === 'oneOf');
    expect(lines.map((r) => [r.from, r.to, r.label, r.kind, r.head])).toEqual([
      ['color', 'red', 'one of', 'enumeration membership (owl:oneOf)', 'filled'],
      ['color', 'yellow', 'one of', 'enumeration membership (owl:oneOf)', 'filled'],
      ['color', 'green', 'one of', 'enumeration membership (owl:oneOf)', 'filled'],
    ]);
  });
});

