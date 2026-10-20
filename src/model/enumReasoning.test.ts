import { withDatatype } from './domains';
import { XSD } from './expressions';
import { describe, expect, it } from 'vitest';
import { addEnumMember, addLink, declareAllDifferent, setAllDifferent, setEnumeration } from './axioms';
import { addDatatype, addEnumValue, enumRange } from './datatypes';
import { beyondEnumerations, enumerationEdges } from './edgeKinds';
import { inferredMemberships } from './inferred';
import { withIris } from './iri';
import { QUALITY_RULES, qualityDiagnostics } from './quality';
import { fromTurtle, toJsonLd, toTurtle } from './rdf';
import { reason } from './reasoner';
import { emptyModel, newRelation, newTerm, type Model, type Term } from './types';
import { owlFindings, qualityFindings } from './validation';
import { REASONER_LIMITS } from '../validation/report';

/** Colours of a traffic light, a class "Signal", and a lamp that is not on any list. */
const lights = (): Model => {
  const m = emptyModel('Traffic');
  m.baseIri = 'http://example.org/traffic#';
  m.terms = [
    newTerm({ id: 'color', name: 'Traffic light color' }),
    newTerm({ id: 'red', name: 'Red', type: 'instance' }),
    newTerm({ id: 'yellow', name: 'Yellow', type: 'instance' }),
    newTerm({ id: 'green', name: 'Green', type: 'instance' }),
    newTerm({ id: 'signal', name: 'Signal' }),
    newTerm({ id: 'lamp', name: 'Lamp', type: 'instance' }),
  ];
  return withIris(m);
};
const ok = (e: { model?: Model; error?: string }): Model => {
  expect(e.error).toBeUndefined();
  return e.model!;
};
const listing = (m: Model, classId: string, ids: string[]): Model => ids.reduce((x, id) => ok(addEnumMember(x, classId, id)), ok(setEnumeration(m, classId, true)));
const enumerated = (ids = ['red', 'yellow', 'green']): Model => listing(lights(), 'color', ids);
const isA = (m: Model, from: string, to: string): Model => ({ ...m, relations: [...m.relations, newRelation({ from, to, kind: 'generalization' })] });
const differ = (m: Model, a: string, b: string): Model => ok(addLink(m, a, b, 'differentFrom'));
const term = (m: Model, name: string): Term => m.terms.find((t) => t.name === name)!;
const patch = (m: Model, id: string, p: Partial<Term>): Model => ({ ...m, terms: m.terms.map((t) => (t.id === id ? { ...t, ...p } : t)) });
const texts = (m: Model) => reason(m, true).inferences.map((i) => i.text);
const rules = (m: Model, config = m.quality) => qualityDiagnostics(m, config).filter((d) => d.rule.startsWith('enumeration-'));

describe('reasoning with enumeration classes', () => {
  it('takes what a class lists to be instances of it', () => {
    const m = enumerated();
    const r = reason(m, true);
    expect(r.consistent).toBe(true);
    expect(r.types('red')).toMatchObject([{ id: 'color', asserted: false }]);
    expect(r.types('red')[0].because).toBe('“Traffic light color” is defined as the enumeration of “Red”, “Yellow”, “Green”.');
    expect(texts(m)).toContain('“Yellow” is an instance of “Traffic light color”');
    // Nothing is concluded of what is not on the list.
    expect(r.types('lamp')).toEqual([]);
    // On the canvas the line of the enumeration says it already: the inferred membership is not drawn beside it.
    const { memberships } = inferredMemberships(m, reason(m));
    expect(memberships.map((x) => x.from).sort()).toEqual(['green', 'red', 'yellow']);
    expect(beyondEnumerations(memberships, enumerationEdges(m))).toEqual([]);
    expect(beyondEnumerations(memberships, [])).toHaveLength(3);
  });

  it('sees a change of the list, though no relationship changed', () => {
    const m = enumerated(['red']);
    expect(reason(m).types('green')).toEqual([]);
    const more = ok(addEnumMember(m, 'color', 'green'));
    expect(more.relations).toBe(m.relations);
    expect(reason(more).types('green')).toHaveLength(1);
    expect(reason(setAllDifferent(more, 'color', true))).not.toBe(reason(more));
  });

  it('does not take two members to be different unless that is declared', () => {
    const same = ok(addLink(enumerated(), 'red', 'yellow', 'sameAs'));
    expect(reason(same, true).consistent).toBe(true);
    // Declared all different, two members that are stated to be the same contradict it.
    const r = reason(setAllDifferent(same, 'color', true), true);
    expect(r.consistent).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].message).toBe('“Red” and “Yellow” are said to be both the same and different.');
    expect(r.conflicts[0].because).toContain('the members of “Traffic light color” are declared to be all different');
    // With one member there is nothing to be different from.
    expect(reason(setAllDifferent(enumerated(['red']), 'color', true), true).consistent).toBe(true);
  });

  it('is not led into that contradiction by the editor', () => {
    // Stated the same, two members cannot then be declared different,
    expect(declareAllDifferent(ok(addLink(enumerated(), 'red', 'yellow', 'sameAs')), 'color', true).error).toBe('“Red” and “Yellow” are stated to be the same individual, so the members of “Traffic light color” cannot all be different. Remove that statement first.');
    // declared different, two members cannot be stated the same,
    const apart = ok(declareAllDifferent(enumerated(), 'color', true));
    expect(apart.terms.find((t) => t.id === 'color')!.allDifferent).toBe(true);
    expect(addLink(apart, 'red', 'yellow', 'sameAs').error).toBe('“Red” and “Yellow” are members of “Traffic light color”, whose members are declared all different. Both cannot hold; take that declaration off the class first.');
    // and what is the same as a member cannot be listed beside it.
    const two = ok(addLink(ok(declareAllDifferent(enumerated(['red', 'green']), 'color', true)), 'yellow', 'red', 'sameAs'));
    expect(addEnumMember(two, 'color', 'yellow').error).toBe('“Yellow” is stated to be the same as “Red”, a member already, and the members of “Traffic light color” are declared all different.');
    // Something outside the list can be the same as a member, and the declaration can always be taken off.
    expect(addLink(apart, 'lamp', 'red', 'sameAs').error).toBeUndefined();
    expect(ok(declareAllDifferent(apart, 'color', false)).terms.find((t) => t.id === 'color')!.allDifferent).toBeUndefined();
  });

  it('says which member an instance is only once the others are ruled out', () => {
    // An instance of a class that lists one individual is that individual.
    const one = isA(enumerated(['green']), 'lamp', 'color');
    expect(texts(one)).toContain('“Green” is the same as “Lamp”');
    // Of two, it is not said which: no cases are tried.
    let m = isA(enumerated(['red', 'green']), 'lamp', 'color');
    expect(texts(m).filter((t) => t.includes('is the same as'))).toEqual([]);
    expect(reason(m, true).consistent).toBe(true);
    m = differ(m, 'lamp', 'red');
    const r = reason(m, true);
    const same = r.inferences.find((i) => i.text === '“Green” is the same as “Lamp”')!;
    expect(same.because).toContain('“Traffic light color” is defined as the enumeration of “Red”, “Green”');
    expect(same.because).toContain('“Lamp” is different from “Red”');
    expect(same.rels).toHaveLength(2);
    // A member itself is not narrowed down to another member.
    expect(texts(isA(enumerated(['red', 'green']), 'red', 'color')).filter((t) => t.includes('is the same as'))).toEqual([]);
  });

  it('finds an instance that can be none of the members', () => {
    const m = differ(differ(isA(enumerated(['red', 'green']), 'lamp', 'color'), 'lamp', 'red'), 'lamp', 'green');
    const r = reason(m, true);
    expect(r.consistent).toBe(false);
    const c = r.conflicts.find((x) => x.message.includes('no members other than'))!;
    expect(c.message).toBe('“Lamp” is an instance of “Traffic light color”, which has no members other than “Red”, “Green”, but it is said to be different from each of them.');
    expect(c.terms).toEqual(['lamp', 'color', 'red', 'green']);
    expect(c.rels).toHaveLength(3);
    // The validation view reports it as a contradiction of the ontology, with the reasoner's grounds.
    const found = owlFindings(m, true);
    expect(found.summary.status).toBe('inconsistent');
    expect(found.findings.find((f) => f.message === c.message)).toMatchObject({ category: 'owl', severity: 'error', ruleId: 'owl-inconsistent', entity: { name: 'Lamp', type: 'individual' } });
  });

  it('makes an enumeration a kind of whatever all its members are', () => {
    let m = isA(isA(enumerated(), 'red', 'signal'), 'yellow', 'signal');
    expect(reason(m, true).superclasses('color')).toEqual([]);
    m = isA(m, 'green', 'signal');
    const up = reason(m, true).superclasses('color');
    expect(up).toMatchObject([{ id: 'signal', asserted: false, equivalent: false }]);
    expect(up[0].because).toContain('“Green” is an instance of “Signal”');
    // An enumeration whose members are all on another one's list is a kind of it, and two with one list are equivalent.
    const m2 = { ...enumerated(), terms: [...enumerated().terms, newTerm({ id: 'go', name: 'Stop or go' }), newTerm({ id: 'all', name: 'Every color' })] };
    const three = listing(listing(m2, 'go', ['red', 'green']), 'all', ['green', 'yellow', 'red']);
    const r = reason(three, true);
    expect(r.superclasses('go').map((x) => x.id).sort()).toEqual(['all', 'color']);
    expect(r.superclasses('color')).toMatchObject([{ id: 'all', equivalent: true }]);
    expect(r.superclasses('all')).toMatchObject([{ id: 'color', equivalent: true }]);
  });

  it('finds a member of an enumeration that cannot be in it', () => {
    // The enumeration is disjoint with a class one of its members is an instance of.
    const m = ok(addLink(isA(enumerated(), 'red', 'signal'), 'color', 'signal', 'disjointWith'));
    const r = reason(m, true);
    expect(r.consistent).toBe(false);
    expect(r.conflicts[0].message).toMatch(/“Red” is an instance of both “Signal” and “Traffic light color”/);
    expect(r.conflicts[0].because).toContain('“Traffic light color” is defined as the enumeration of');
  });

  it('leaves alone an enumeration that lists something other than an individual, and says so', () => {
    const m = patch(enumerated(['red']), 'color', { oneOf: ['red', 'signal'] });
    expect(reason(m, true).types('red')).toEqual([]);
    const found = rules(m);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: 'enumeration-member', severity: 'warning', message: '“Traffic light color” lists “Signal”, which is a class, not an individual.', terms: ['color', 'signal'] });
    const fixed = found[0].fix!.apply(m);
    expect(term(fixed, 'Traffic light color').oneOf).toEqual(['red']);
    expect(term(fixed, 'Signal')).toBeDefined();
    expect(rules(fixed)).toEqual([]);
    expect(reason(fixed, true).types('red')).toHaveLength(1);
  });

  it('reasons the same way with what comes back from Turtle', () => {
    const m = differ(differ(isA(setAllDifferent(enumerated(), 'color', true), 'lamp', 'color'), 'lamp', 'red'), 'lamp', 'yellow');
    expect(texts(m)).toContain('“Green” is the same as “Lamp”');
    const back = fromTurtle(toTurtle(m));
    expect(term(back, 'Traffic light color')).toMatchObject({ allDifferent: true });
    // One individual each, with the IRI it had: the list names them, it does not copy them.
    expect(back.terms.filter((t) => t.type === 'instance').map((t) => t.iri).sort()).toEqual(m.terms.filter((t) => t.type === 'instance').map((t) => t.iri).sort());
    expect(texts(back).sort()).toEqual(texts(m).sort());
    expect(reason(back, true).consistent).toBe(true);
    // And a contradiction is one after the round trip too.
    const clash = fromTurtle(toTurtle(setAllDifferent(ok(addLink(enumerated(), 'red', 'green', 'sameAs')), 'color', true)));
    expect(reason(clash, true).conflicts.map((c) => c.message)).toEqual(['“Green” and “Red” are said to be both the same and different.']);
  });

  it('says what it does not work out', () => {
    expect(REASONER_LIMITS.some((x) => x.includes('not reasoned with by cases'))).toBe(true);
    expect(REASONER_LIMITS.some((x) => x.includes('enumerated datatype'))).toBe(true);
    // An instance of { Red, Green }, both of which are signals, is a signal: that needs the two cases, and is not concluded
    // for the instance itself. It follows here another way, through the class: the enumeration is a kind of Signal.
    const m = isA(isA(isA(enumerated(['red', 'green']), 'red', 'signal'), 'green', 'signal'), 'lamp', 'color');
    expect(reason(m, true).types('lamp').map((x) => x.id).sort()).toEqual(['color', 'signal']);
  });
});

describe('reasoning with enumerated datatypes', () => {
  /** A lamp with a state that is "on" or "off", and a mode that is a kind of state. */
  const switched = (value: string, prop = 'state'): Model => {
    let m = lights();
    m = { ...m, terms: [...m.terms, newTerm({ id: 'state', name: 'state', type: 'property' }), newTerm({ id: 'mode', name: 'mode', type: 'property' })] };
    const made = addDatatype(m, 'Switch state');
    m = ok(addEnumValue(ok(addEnumValue(ok(made), made.id!, { value: 'on' })), made.id!, { value: 'off' }));
    m = patch(m, 'state', { ranges: withDatatype({}, enumRange(made.id!)) });
    m = isA(m, 'mode', 'state');
    return patch(m, 'lamp', { values: [{ prop, value }] });
  };

  it('holds the values of a property to the list of its range', () => {
    expect(reason(switched('on'), true).consistent).toBe(true);
    const r = reason(switched('blinking'), true);
    expect(r.consistent).toBe(false);
    expect(r.conflicts[0].message).toBe('“Lamp” has the value "blinking" for “state”, but the values of that property are those of “Switch state”: "on", "off".');
    expect(r.conflicts[0].because).toBe('“Lamp” has state "blinking"; “state” takes its values from “Switch state”.');
    expect(r.conflicts[0].terms).toEqual(['lamp', 'state']);
  });

  it('holds the values of a sub-property to it as well', () => {
    expect(reason(switched('off', 'mode'), true).consistent).toBe(true);
    const r = reason(switched('dimmed', 'mode'), true);
    expect(r.consistent).toBe(false);
    expect(r.conflicts[0].message).toContain('has the value "dimmed" for “state”');
    expect(r.conflicts[0].because).toContain('“mode” is a sub-property of “state”');
  });

  it('takes a number for what it is, however it is written', () => {
    const numbered = (value: string, listed: { value: string; dt: string }): Model => {
      const m = switched('on');
      return patch({ ...m, datatypes: m.datatypes.map((d) => ({ ...d, values: [listed] })) }, 'lamp', { values: [{ prop: 'state', value }] });
    };
    const one = { value: '1', dt: 'xsd:integer' };
    expect(reason(numbered('1', one), true).consistent).toBe(true);
    // "01" and "1.0" are the number 1: OWL has no contradiction there, and none is reported.
    expect(reason(numbered('01', one), true).consistent).toBe(true);
    expect(reason(numbered('1.0', one), true).consistent).toBe(true);
    expect(reason(numbered('2', one), true).consistent).toBe(false);
    expect(reason(numbered('one', one), true).consistent).toBe(false);
    expect(reason(numbered('', one), true).consistent).toBe(false);
    expect(reason(numbered('1', { value: 'true', dt: 'xsd:boolean' }), true).consistent).toBe(true);
    expect(reason(numbered('0', { value: 'true', dt: 'xsd:boolean' }), true).consistent).toBe(false);
    // Text is the text it is.
    expect(reason(numbered('01', { value: '1', dt: 'xsd:gYear' }), true).consistent).toBe(false);
  });

  it('sees a change of the list of values, and says nothing of a list that is empty', () => {
    const m = switched('blinking');
    expect(reason(m).consistent).toBe(false);
    const d = m.datatypes[0];
    const more = ok(addEnumValue(m, d.id, { value: 'blinking' }));
    expect(more.relations).toBe(m.relations);
    expect(reason(more).consistent).toBe(true);
    expect(reason({ ...m, datatypes: [{ ...d, values: [] }] }).consistent).toBe(true);
  });
});

describe('validation of enumerations', () => {
  it('has a group of rules of its own', () => {
    expect(QUALITY_RULES.filter((r) => r.group === 'Enumerations').map((r) => [r.id, r.default])).toEqual([
      ['enumeration-empty', true],
      ['enumeration-member', true],
      ['enumeration-value', true],
      ['enumeration-unsupported', true],
      ['enumeration-distinct', false],
    ]);
    expect(rules(enumerated())).toEqual([]);
    expect(rules(lights())).toEqual([]);
  });

  it('flags an enumeration that lists nothing, of individuals or of values', async () => {
    let m = ok(setEnumeration(lights(), 'color', true));
    const made = addDatatype(m, 'Switch state');
    m = ok(made);
    expect(rules(m).map((d) => [d.rule, d.message])).toEqual([
      ['enumeration-empty', '“Traffic light color” is defined as an enumeration but lists no individual yet. Until it does, it is exported as an ordinary class.'],
      ['enumeration-empty', 'The enumerated datatype “Switch state” has no values yet. Until it has one, it is exported as a datatype without a definition.'],
    ]);
    // In the validation view each is a finding about the class, or about the model when no property uses the datatype.
    const found = (await qualityFindings(m)).findings.filter((f) => f.ruleId === 'enumeration-empty');
    expect(found.map((f) => [f.rule, f.entity?.name, f.entity?.type])).toEqual([
      ['Enumeration without members', 'Traffic light color', 'class'],
      ['Enumeration without members', 'Traffic', 'ontology'],
    ]);
  });

  it('flags two members that are one individual, and a member that is gone', () => {
    const twin = newTerm({ id: 'rouge', name: 'Rouge', type: 'instance', iri: 'http://example.org/traffic#Red' });
    const m = patch({ ...enumerated(['red']), terms: [...enumerated(['red']).terms, twin] }, 'color', { oneOf: ['red', 'rouge', 'nowhere'] });
    const found = rules(m);
    expect(found.map((d) => d.message)).toEqual([
      '“Traffic light color” lists an individual that is no longer in the model.',
      '“Traffic light color” lists “Red” and “Rouge”, which share the IRI <http://example.org/traffic#Red>. In RDF that is one individual, listed twice.',
    ]);
    const tidy = found.reduce((x, d) => d.fix!.apply(x), m);
    expect(term(tidy, 'Traffic light color').oneOf).toEqual(['red']);
    expect(rules(tidy)).toEqual([]);
  });

  it('flags a value that is not a literal of the datatype it claims, and one listed twice', () => {
    const made = addDatatype(lights(), 'Speed limit');
    let m = ok(addEnumValue(ok(made), made.id!, { value: '30', dt: 'xsd:integer' }));
    expect(addEnumValue(m, made.id!, { value: 'thirty', dt: 'xsd:integer' }).error).toMatch(/not a whole number/);
    // What the editor refuses can still come in from a file.
    m = { ...m, datatypes: m.datatypes.map((d) => ({ ...d, values: [...d.values, { value: 'thirty', dt: 'xsd:integer' }, { value: '30', dt: 'xsd:integer' }, { value: 'x', dt: 'http://example.org/other' }] })) };
    const found = rules(m);
    expect(found.map((d) => [d.rule, d.message])).toEqual([
      ['enumeration-value', '"thirty"^^xsd:integer, one of the values of “Speed limit”, is not a literal that can be written: “thirty” is not a whole number (xsd:integer). It should look like 42.'],
      ['enumeration-value', '“Speed limit” lists "30"^^xsd:integer more than once.'],
    ]);
    const fixed = found[1].fix!.apply(m);
    expect(fixed.datatypes[0].values.map((v) => v.value)).toEqual(['30', 'thirty', 'x']);
  });

  it('can ask for members to be declared different, and does so only when asked', () => {
    const m = enumerated();
    const on = { ...m.quality, on: [...m.quality.on, 'enumeration-distinct'] };
    const found = rules(m, on);
    expect(found.map((d) => [d.rule, d.severity, d.message])).toEqual([['enumeration-distinct', 'info', 'The 3 members of “Traffic light color” are not declared different, so two of them may be one and the same individual.']]);
    const fixed = found[0].fix!.apply(m);
    expect(term(fixed, 'Traffic light color').allDifferent).toBe(true);
    expect(rules(fixed, on)).toEqual([]);
    expect(toTurtle(fixed)).toContain('[] a owl:AllDifferent ;');
  });
});

describe('enumerations in JSON-LD', () => {
  it('writes the same lists, of individuals and of literals', () => {
    let m = setAllDifferent(enumerated(), 'color', true);
    m = { ...m, terms: [...m.terms, newTerm({ id: 'state', name: 'state', type: 'property' })] };
    const made = addDatatype(m, 'Switch state');
    m = withIris(patch(ok(addEnumValue(ok(addEnumValue(ok(made), made.id!, { value: 'on' })), made.id!, { value: '2', dt: 'xsd:integer' })), 'state', { ranges: withDatatype({}, enumRange(made.id!)) }));
    const graph = JSON.parse(toJsonLd(m))['@graph'] as Record<string, unknown>[];
    const node = (id: string) => graph.find((n) => n['@id'] === 'http://example.org/traffic#' + id)!;
    const iri = (id: string) => ({ '@id': 'http://example.org/traffic#' + id });
    expect(node('TrafficLightColor')['http://www.w3.org/2002/07/owl#equivalentClass'] ?? node('TrafficLightColor')['owl:equivalentClass']).toEqual({ '@type': 'owl:Class', 'owl:oneOf': { '@list': [iri('Red'), iri('Yellow'), iri('Green')] } });
    expect(node('SwitchState')).toMatchObject({ '@type': 'rdfs:Datatype', 'owl:equivalentClass': { '@type': 'rdfs:Datatype', 'owl:oneOf': { '@list': ['on', { '@value': '2', '@type': 'xsd:integer' }] } } });
    expect(node('state')['rdfs:range']).toEqual(iri('SwitchState'));
    // The statement that the members differ has no name of its own.
    expect(graph.find((n) => n['@type'] === 'owl:AllDifferent')).toEqual({ '@type': 'owl:AllDifferent', 'owl:distinctMembers': { '@list': [iri('Red'), iri('Yellow'), iri('Green')] } });
    // A member is not given the class as its type, here either.
    expect(node('Red')['@type']).toBe('owl:NamedIndividual');
  });
});

describe('lists the editor does not take', () => {
  const PREFIXES = `
    @prefix : <http://example.org/traffic#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`;

  it('keeps a list that is not well formed as far as it can be followed, and never as an enumeration', () => {
    const back = fromTurtle(`${PREFIXES}
      :Loop a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf _:l1 ] .
      _:l1 rdf:first :Red ; rdf:rest _:l2 .
      _:l2 rdf:first :Green ; rdf:rest _:l1 .
      :Open a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf _:o1 ] .
      _:o1 rdf:first :Red .
      :Fork a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf _:f1 ] .
      _:f1 rdf:first :Red , :Green ; rdf:rest rdf:nil .
      :Nobody a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf () ] .
      :Unnamed a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf ( [ a :Loop ] ) ] .
      :Fine a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:oneOf ( :Red ) ] .`);
    // None is an enumeration, or any class expression OWL has: each is an axiom of its class, kept as it was read.
    const kept = (name: string) => {
      const c = term(back, name);
      expect([name, c.type, c.oneOf, c.classAxioms?.length, c.classAxioms?.[0].kind, c.classAxioms?.[0].expression.type]).toEqual([name, 'concept', undefined, 1, 'EquivalentClasses', 'Unparsed']);
      return (c.classAxioms![0].expression as { turtle: string }).turtle;
    };
    const [O, R, T] = ['http://www.w3.org/2002/07/owl#', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'http://example.org/traffic#'];
    // A broken list is written cell by cell, as broken as it was, so that it is not mended into an enumeration on the way.
    expect(kept('Loop')).toContain(`<${O}oneOf> [ <${R}first> <${T}Red> ; <${R}rest> [ <${R}first> <${T}Green> ; <${R}rest> [] ] ]`);
    expect(kept('Open')).toContain(`<${O}oneOf> [ <${R}first> <${T}Red> ]`);
    expect(kept('Fork')).toContain(`<${O}oneOf> [ <${R}first> <${T}Green> ; <${R}first> <${T}Red> ; <${R}rest> () ]`);
    expect(kept('Nobody')).toContain(`<${O}oneOf> ()`);
    expect(kept('Unnamed')).toContain(`<${O}oneOf> ( [ <${R}type> <${T}Loop> ] )`);
    expect(term(back, 'Fine').oneOf).toHaveLength(1);
    // Each is pointed out, as something kept and not read.
    const found = rules(back);
    expect(found.map((d) => d.rule)).toEqual(Array(5).fill('enumeration-unsupported'));
    expect(found.every((d) => d.severity === 'info')).toBe(true);
    // The reasoner reads only the one it was given as an enumeration.
    expect(reason(back, true).inferences.map((i) => i.text)).toEqual(['“Red” is an instance of “Fine”']);
    // What is written out is Turtle that reads back to the same thing.
    const again = fromTurtle(toTurtle(back));
    const stated = (m: Model) => m.terms.filter((t) => t.classAxioms).map((t) => [t.name, t.classAxioms!.map((a) => [a.kind, a.expression])]);
    expect(stated(again)).toEqual(stated(back));
  });

  it('keeps a data range that is not a plain list of literals with its property', () => {
    const back = fromTurtle(`${PREFIXES}
      :age a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive 0 ] ) ] .
      :grade a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:unionOf ( xsd:integer [ a rdfs:Datatype ; owl:oneOf ( "pass" "fail" ) ] ) ] .
      :state a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:oneOf ( "on" "off" ) ] .
      :none a owl:DatatypeProperty ; rdfs:range [ a rdfs:Datatype ; owl:oneOf () ] .`);
    // Each range is the data range it states: a datatype narrowed by a facet, a union with a list in it.
    const ranges = (m: Model, name: string) => term(m, name).ranges?.map((a) => a.range);
    expect(term(back, 'age')).toMatchObject({ type: 'property' });
    expect('axioms' in term(back, 'age')).toBe(false);
    expect(ranges(back, 'age')).toEqual([{ type: 'DatatypeRestriction', datatype: XSD + 'integer', facets: [{ facet: XSD + 'minInclusive', value: { value: '0', datatype: XSD + 'integer' } }] }]);
    expect(ranges(back, 'grade')).toEqual([{ type: 'DataUnionOf', operands: [{ type: 'Datatype', iri: XSD + 'integer' }, { type: 'DataOneOf', literals: [{ value: 'pass' }, { value: 'fail' }] }] }]);
    // An empty list is no data range OWL has: it is kept as it was read.
    expect(ranges(back, 'none')).toEqual([{ type: 'Unparsed', turtle: '[ <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2000/01/rdf-schema#Datatype> ; <http://www.w3.org/2002/07/owl#oneOf> () ]' }]);
    // The one that is a plain list is the enumerated datatype of the property.
    expect('axioms' in term(back, 'state')).toBe(false);
    expect(back.datatypes.map((d) => [d.anonymous, d.values.map((v) => v.value)])).toEqual([[true, ['on', 'off']]]);
    expect(ranges(back, 'state')).toEqual([{ type: 'Enumeration', datatype: back.datatypes[0].id }]);
    expect(rules(back).map((d) => [d.rule, d.terms.map((id) => back.terms.find((t) => t.id === id)!.name)])).toEqual([['enumeration-unsupported', ['none']]]);
    const ttl = toTurtle(back);
    expect(ttl).toContain('owl:withRestrictions ( [ xsd:minInclusive "0"^^xsd:integer ] )');
    const again = fromTurtle(ttl);
    for (const name of ['age', 'grade', 'none']) expect(ranges(again, name)).toEqual(ranges(back, name));
    expect(again.datatypes.map((d) => d.values)).toEqual(back.datatypes.map((d) => d.values));
  });
});
