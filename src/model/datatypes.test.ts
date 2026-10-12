import { describe, expect, it } from 'vitest';
import { addValue } from './axioms';
import { addDatatype, addEnumValue, datatypeTurtle, enumOf, enumRange, outsideEnumeration, rangeLabel, removeDatatype, removeEnumValue, updateDatatype } from './datatypes';
import { nodeLabel, setNodeLook } from './geometry';
import { nodeLookFor } from './graphStyle';
import { withIris } from './iri';
import { restrictionsOf } from './props';
import { fromTurtle, toTurtle } from './rdf';
import { stable } from './stable';
import { emptyModel, newRelation, newTerm, normalizeModel, type Model } from './types';

const base = (): Model => {
  const m = emptyModel('Orders');
  m.baseIri = 'http://example.org/orders#';
  m.terms = [newTerm({ id: 'order', name: 'Order' }), newTerm({ id: 'status', name: 'status', type: 'property' }), newTerm({ id: 'o1', name: 'Order 1', type: 'instance' })];
  m.relations = [newRelation({ id: 'has', from: 'order', to: 'status', kind: 'property' }), newRelation({ id: 't', from: 'o1', to: 'order', kind: 'generalization' })];
  return withIris(m);
};
const ok = (e: { model?: Model; error?: string }): Model => {
  expect(e.error).toBeUndefined();
  return e.model!;
};
/** A model with the datatype StatusCode = "active", "inactive", "pending", as the range of status. */
const coded = (): { m: Model; id: string } => {
  const made = addDatatype(base(), 'Status code');
  let m = ok(made);
  for (const value of ['active', 'inactive', 'pending']) m = ok(addEnumValue(m, made.id!, { value }));
  m = withIris({ ...m, terms: m.terms.map((t) => (t.id === 'status' ? { ...t, range: enumRange(made.id!) } : t)) });
  return { m, id: made.id! };
};
const block = (ttl: string, subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' ')) ?? '';

describe('enumerated datatypes', () => {
  it('is a named list of literals, each of the datatype it claims and there once', () => {
    const made = addDatatype(base(), 'Priority');
    let m = ok(made);
    const id = made.id!;
    m = ok(addEnumValue(m, id, { value: '1', dt: 'xsd:integer' }));
    m = ok(addEnumValue(m, id, { value: 'haut', lang: 'FR' }));
    m = ok(addEnumValue(m, id, { value: ' two words ' }));
    expect(m.datatypes[0].values).toEqual([{ value: '1', dt: 'xsd:integer' }, { value: 'haut', lang: 'fr' }, { value: ' two words ' }]);
    expect(addEnumValue(m, id, { value: '1', dt: 'xsd:integer' }).error).toMatch(/already one of the values/);
    // The same characters as text are another literal.
    expect(addEnumValue(m, id, { value: '1' }).error).toBeUndefined();
    expect(addEnumValue(m, id, { value: 'two', dt: 'xsd:integer' }).error).toMatch(/not a whole number/);
    expect(addEnumValue(m, id, { value: '2026-02-30', dt: 'xsd:date' }).error ?? addEnumValue(m, id, { value: 'soon', dt: 'xsd:date' }).error).toMatch(/not a date/);
    expect(addEnumValue(m, id, { value: '2', dt: 'xsd:integer', lang: 'en' }).error).toMatch(/language only goes with text/);
    expect(addEnumValue(m, id, { value: 'high', lang: 'not a tag' }).error).toMatch(/not a language code/);
    expect(addEnumValue(m, id, { value: '  ' }).error).toMatch(/Enter a value/);
    expect(addDatatype(m, 'priority').error).toMatch(/already a datatype/);
    expect(updateDatatype(m, id, { name: ' ' }).error).toMatch(/needs a name/);
    m = removeEnumValue(m, id, 0);
    expect(m.datatypes[0].values.map((v) => v.value)).toEqual(['haut', ' two words ']);
  });

  it('is a datatype of the model, and neither a class nor an individual', () => {
    const { m, id } = coded();
    expect(m.terms.map((t) => t.name)).toEqual(['Order', 'status', 'Order 1']);
    expect(m.datatypes).toHaveLength(1);
    expect(m.datatypes[0].iri).toBe('http://example.org/orders#StatusCode');
    expect(enumOf(m, enumRange(id))!.name).toBe('Status code');
    expect(enumOf(m, 'xsd:string')).toBeUndefined();
    expect(rangeLabel(m, enumRange(id))).toBe('Status code');
    expect(rangeLabel(m, 'xsd:date')).toBe('date');
    // The class that has the property is restricted to values of the datatype, by its name.
    expect(restrictionsOf(m, 'order').map((r) => r.filler)).toEqual(['Status code']);
    // On the canvas the property shows the datatype it takes its values from.
    setNodeLook(nodeLookFor(m));
    try {
      expect(nodeLabel(m.terms[1])).toBe('status : Status code');
    } finally {
      setNodeLook(null);
    }
  });

  it('is written as a datatype equivalent to a list of literals, and is the range of its property', () => {
    const { m } = coded();
    const ttl = toTurtle(m);
    expect(block(ttl, ':StatusCode')).toBe(':StatusCode a rdfs:Datatype ;\n    rdfs:label "Status code" ;\n    owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "active" "inactive" "pending" ) ] .');
    expect(block(ttl, ':status')).toContain('rdfs:range :StatusCode');
    expect(block(ttl, ':Order')).toContain('owl:someValuesFrom :StatusCode');
    // Not a class, not an individual, and its values are not things.
    expect(ttl).not.toMatch(/:StatusCode a owl:(Class|NamedIndividual)/);
    expect(ttl).not.toMatch(/owl:oneOf \( :/);
    expect(datatypeTurtle(m, m.datatypes[0])).toBe(':StatusCode a rdfs:Datatype ;\n    owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( "active" "inactive" "pending" ) ] .');
  });

  it('comes back from Turtle as the same datatype, still the range of the property', () => {
    let { m, id } = coded();
    m = ok(addEnumValue(m, id, { value: '3', dt: 'xsd:integer' }));
    m = ok(addEnumValue(m, id, { value: 'actif', lang: 'fr' }));
    m = ok(addValue(m, 'o1', { prop: 'status', value: 'pending' }));
    const ttl = toTurtle(m);
    const back = fromTurtle(ttl);
    expect(back.datatypes).toHaveLength(1);
    expect(back.datatypes[0]).toMatchObject({ name: 'Status code', iri: 'http://example.org/orders#StatusCode', values: m.datatypes[0].values });
    expect(back.datatypes[0].anonymous).toBeUndefined();
    const status = back.terms.find((t) => t.name === 'status')!;
    expect(enumOf(back, status.range)).toBe(back.datatypes[0]);
    // It did not turn into a class or an individual on the way.
    expect(Object.fromEntries(back.terms.map((t) => [t.name, t.type]))).toEqual({ Order: 'concept', 'Order 1': 'instance', status: 'property' });
    expect(back.terms.find((t) => t.name === 'Order 1')!.values).toEqual([{ prop: status.id, value: 'pending' }]);
    expect(toTurtle(back)).toBe(ttl);
  });

  it('reads a list of literals written in place as a range, and writes it back in place', () => {
    const ttl = `@prefix : <http://example.org/orders#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

:size a owl:DatatypeProperty ; rdfs:label "size" ;
    rdfs:range [ a rdfs:Datatype ; owl:oneOf ( "S" "M" "L" ) ] .
:level a owl:DatatypeProperty ; rdfs:label "level" ; rdfs:range :Level .
:Level a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:oneOf ( 1 2 3 ) ] .
:Age a rdfs:Datatype ; owl:equivalentClass [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive 0 ] ) ] .
:age a owl:DatatypeProperty ; rdfs:label "age" ; rdfs:range :Age .`;
    const back = fromTurtle(ttl);
    const of = (name: string) => enumOf(back, back.terms.find((t) => t.name === name)!.range);
    expect(of('size')).toMatchObject({ anonymous: true, values: [{ value: 'S' }, { value: 'M' }, { value: 'L' }] });
    expect(of('level')).toMatchObject({ name: 'Level', iri: 'http://example.org/orders#Level', values: [{ value: '1', dt: 'xsd:integer' }, { value: '2', dt: 'xsd:integer' }, { value: '3', dt: 'xsd:integer' }] });
    // A datatype defined by a restriction is not a list of values: there is no editor for it, and it is not taken for one.
    expect(of('age')).toBeUndefined();
    expect(back.datatypes).toHaveLength(2);
    expect(back.terms.every((t) => t.type === 'property')).toBe(true);
    const out = toTurtle(back);
    expect(block(out, ':size')).toContain('rdfs:range [ a rdfs:Datatype ; owl:oneOf ( "S" "M" "L" ) ]');
    expect(block(out, ':level')).toContain('rdfs:range :Level');
    expect(block(out, ':Level')).toContain('owl:oneOf ( "1"^^xsd:integer "2"^^xsd:integer "3"^^xsd:integer )');
    expect(toTurtle(fromTurtle(out))).toBe(out);
  });

  it('holds an individual to the values its property lists', () => {
    const { m } = coded();
    expect(addValue(m, 'o1', { prop: 'status', value: 'shipped' }).error).toMatch(/not one of the values of “Status code”: "active", "inactive", "pending"/);
    const stated = ok(addValue(m, 'o1', { prop: 'status', value: 'active' }));
    expect(stated.terms.find((t) => t.id === 'o1')!.values).toEqual([{ prop: 'status', value: 'active' }]);
    expect(outsideEnumeration(m, 'xsd:string', { value: 'anything' })).toBeUndefined();
  });

  it('is kept in a saved model, is part of what the model means, and leaves its properties in order when it goes', () => {
    const { m, id } = coded();
    const back = normalizeModel(JSON.parse(JSON.stringify(m)));
    expect(back.datatypes).toEqual(m.datatypes);
    expect(back.terms.find((t) => t.id === 'status')!.range).toBe(enumRange(id));
    // A range that names a datatype that is not there is dropped; a model from before has none.
    const dangling = JSON.parse(JSON.stringify(m));
    dangling.datatypes = [];
    expect(normalizeModel(dangling).terms.find((t) => t.id === 'status')!.range).toBeUndefined();
    const { datatypes: _, ...old } = JSON.parse(JSON.stringify(base()));
    expect(normalizeModel(old).datatypes).toEqual([]);
    stable(m);
    expect(stable(removeEnumValue(m, id, 0))).not.toBe(m);
    const removed = removeDatatype(m, id);
    expect(removed.note).toMatch(/“status” has no range now/);
    expect(removed.model!.datatypes).toEqual([]);
    expect(removed.model!.terms.find((t) => t.id === 'status')!.range).toBeUndefined();
  });
});
