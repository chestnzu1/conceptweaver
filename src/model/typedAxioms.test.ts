import { describe, expect, it } from 'vitest';
import { withoutEntities } from './domains';
import { setIriSuffix } from './iri';
import { fromTurtle, toTurtle } from './rdf';
import { normalizeModel, type Model } from './types';
import { statementsOf } from './unmapped';

/**
 * The axioms OWL states with a list or a blank node — property chains, keys, disjoint unions,
 * negative property assertions and annotations on axioms — are the model's now, not kept text
 * (format 8). What names an entity the ontology does not declare stays as it was read.
 */

const T = 'http://example.org/t#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const P = `@prefix : <${T}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <${RDFS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;
const TTL = `${P}
:Animal a owl:Class .
:Pet a owl:Class .
:Dog a owl:Class ; rdfs:subClassOf :Animal ; owl:disjointUnionOf ( :Animal :Pet ) .
:Dog owl:hasKey ( :name :owner ) .
:name a owl:DatatypeProperty .
:owner a owl:ObjectProperty .
:parentOf a owl:ObjectProperty .
:childOf a owl:ObjectProperty .
:grandparentOf a owl:ObjectProperty ; owl:propertyChainAxiom ( :parentOf [ owl:inverseOf :childOf ] ) .
:rex a owl:NamedIndividual .
:fido a owl:NamedIndividual .
[] a owl:NegativePropertyAssertion ; owl:sourceIndividual :rex ; owl:assertionProperty :parentOf ; owl:targetIndividual :fido .
[] a owl:NegativePropertyAssertion ; owl:sourceIndividual :rex ; owl:assertionProperty :name ; owl:targetValue "Rex" .
[] a owl:NegativePropertyAssertion ; owl:sourceIndividual :rex ; owl:assertionProperty :name ; owl:targetValue "Rex"@en .
[] a owl:Axiom ; owl:annotatedSource :Dog ; owl:annotatedProperty rdfs:subClassOf ; owl:annotatedTarget :Animal ; rdfs:comment "because"@en .
`;

const read = () => fromTurtle(TTL);
const term = (m: Model, local: string) => m.terms.find((t) => t.iri === T + local)!;
const prop = (m: Model, local: string) => m.props.find((p) => p.iri === T + local)!;

describe('axioms with a list or a blank node', () => {
  it('are read into the model, and written back as the statements they were', () => {
    const m = read();
    expect(m.unmapped).toBeUndefined();
    expect(term(m, 'Dog').disjointUnions).toEqual([
      {
        id: expect.any(String),
        classes: [
          { type: 'Class', iri: T + 'Animal' },
          { type: 'Class', iri: T + 'Pet' },
        ],
      },
    ]);
    expect(term(m, 'Dog').keys).toEqual([
      {
        id: expect.any(String),
        properties: [{ data: term(m, 'name').id }, { prop: prop(m, 'owner').id }],
      },
    ]);
    expect(prop(m, 'grandparentOf').chains).toEqual([
      {
        id: expect.any(String),
        properties: [{ prop: prop(m, 'parentOf').id }, { prop: prop(m, 'childOf').id, inverse: true }],
      },
    ]);
    expect(term(m, 'rex').negativeAssertions).toEqual([
      { id: expect.any(String), kind: 'object', prop: prop(m, 'parentOf').id, target: term(m, 'fido').id },
      { id: expect.any(String), kind: 'data', prop: term(m, 'name').id, value: 'Rex' },
      { id: expect.any(String), kind: 'data', prop: term(m, 'name').id, value: 'Rex', lang: 'en' },
    ]);
    expect(m.axiomAnnotations).toEqual([
      { id: expect.any(String), subject: T + 'Dog', property: RDFS + 'subClassOf', target: `<${T}Animal>`, fields: [{ key: 'rdfs:comment', value: 'because', lang: 'en' }] },
    ]);

    // Written back it states every statement of the file, and reading that again is the same model.
    const written = toTurtle(m);
    const back = new Set(statementsOf(written).map((s) => s.text));
    for (const s of statementsOf(TTL)) expect(back.has(s.text), s.text).toBe(true);
    const again = fromTurtle(written);
    expect(again.unmapped).toBeUndefined();
    expect(toTurtle(again)).toBe(written);
    // Saved and opened again, the same.
    expect(toTurtle(normalizeModel(JSON.parse(JSON.stringify(m))))).toBe(written);
  });

  it('stay as they were read where they name an entity the ontology does not declare', () => {
    const m = fromTurtle(`${P}:a a owl:NamedIndividual . [] a owl:NegativePropertyAssertion ; owl:sourceIndividual :a ; owl:assertionProperty :undeclared ; owl:targetValue "x" .`);
    expect(term(m, 'a').negativeAssertions).toBeUndefined();
    expect(m.unmapped).toContain('NegativePropertyAssertion');
    // A chain with a step that is not a declared object property stays whole, not in part.
    const chain = fromTurtle(`${P}:p a owl:ObjectProperty . :q a owl:ObjectProperty ; owl:propertyChainAxiom ( :p :missing ) .`);
    expect(prop(chain, 'q').chains).toBeUndefined();
    expect(chain.unmapped).toContain('propertyChainAxiom');
  });

  it('are only read into a model of format 8', () => {
    const raw = JSON.parse(JSON.stringify(read())) as Record<string, unknown>;
    const older = normalizeModel({ ...raw, version: 7 });
    expect(term(older, 'Dog').keys).toBeUndefined();
    expect(term(older, 'Dog').disjointUnions).toBeUndefined();
    expect(term(older, 'rex').negativeAssertions).toBeUndefined();
    expect(older.axiomAnnotations).toBeUndefined();
    const current = normalizeModel(raw);
    expect(term(current, 'Dog').keys).toHaveLength(1);
    expect(term(current, 'Dog').disjointUnions).toHaveLength(1);
    expect(term(current, 'rex').negativeAssertions).toHaveLength(3);
    expect(current.axiomAnnotations).toHaveLength(1);
  });

  it('go with an entity that is deleted', () => {
    const m = read();
    // The editor removes the entity first, then takes away what named it (see prepared).
    const gone = (model: Model, local: string) => ({
      ...model,
      terms: model.terms.filter((t) => t.iri !== T + local),
      props: model.props.filter((p) => p.iri !== T + local),
    });
    // A property that a chain and an assertion name takes them with it.
    const withoutParent = withoutEntities(gone(m, 'parentOf'), new Set([T + 'parentOf']));
    expect(prop(withoutParent, 'grandparentOf').chains).toBeUndefined();
    expect(term(withoutParent, 'rex').negativeAssertions?.some((n) => n.kind === 'object')).toBe(false);
    // A key naming a property gone is no key.
    const withoutName = withoutEntities(gone(m, 'name'), new Set([T + 'name']));
    expect(term(withoutName, 'Dog').keys).toBeUndefined();
    expect(term(withoutName, 'rex').negativeAssertions?.map((n) => n.kind)).toEqual(['object']);
    // An individual gone takes what is said of it and about it.
    const withoutFido = withoutEntities(gone(m, 'fido'), new Set([T + 'fido']));
    expect(term(withoutFido, 'rex').negativeAssertions?.map((n) => n.kind)).toEqual(['data', 'data']);
    // A class gone leaves a union of fewer than two classes, which is no union.
    const withoutAnimal = withoutEntities(gone(m, 'Animal'), new Set([T + 'Animal']));
    expect(term(withoutAnimal, 'Dog').disjointUnions).toBeUndefined();
    expect(withoutAnimal.axiomAnnotations).toBeUndefined();
    // Nothing named: the very model.
    expect(withoutEntities(m, new Set([T + 'nothing']))).toBe(m);
  });

  it('follow an entity that is given another IRI', () => {
    const m = read();
    const renamed = setIriSuffix(m, { term: term(m, 'Animal').id }, 'Creature').model!;
    expect(term(renamed, 'Dog').disjointUnions![0].classes).toContainEqual({ type: 'Class', iri: T + 'Creature' });
    // The annotation on the subclass statement names the same statement.
    expect(renamed.axiomAnnotations![0].target).toBe(`<${T}Creature>`);
    const dog = setIriSuffix(m, { term: term(m, 'Dog').id }, 'Hound').model!;
    expect(dog.axiomAnnotations![0].subject).toBe(T + 'Hound');
  });
});
