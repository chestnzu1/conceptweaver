import { describe, expect, it } from 'vitest';
import { classExpressionAxiomFrom, functionalSyntax, type ClassExpressionAxiom } from './expressions';
import { setIriSuffix } from './iri';
import { classText, namingFor, parseClass } from './manchester';
import { fromTurtle, toTurtle } from './rdf';
import { useStore } from './store';
import { normalizeModel, type Model, type Term } from './types';
import { statementsOf } from './unmapped';

/**
 * A class's superclasses, definitions and disjoint classes that are expressions (model format 4):
 * each an axiom of its own kind with a structured expression, read and written as the statement
 * it is, never merged with another, edited one at a time.
 */

const M = 'http://example.org/c#';
const SOURCE = `@prefix : <${M}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/c> a owl:Ontology .
:Person a owl:Class ; rdfs:label "Person" . :Student a owl:Class ; rdfs:label "Student" . :Organization a owl:Class ; rdfs:label "Organization" .
:hasChild a owl:ObjectProperty ; rdfs:label "hasChild" . :hasMember a owl:ObjectProperty ; rdfs:label "hasMember" .
:hasAge a owl:DatatypeProperty ; rdfs:label "hasAge" .
:Red a owl:NamedIndividual ; rdfs:label "Red" . :Green a owl:NamedIndividual ; rdfs:label "Green" .
:AdultPerson a owl:Class ; rdfs:label "AdultPerson" ;
    rdfs:subClassOf [ a owl:Class ; owl:intersectionOf ( :Person [ a owl:Restriction ; owl:onProperty :hasAge ; owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive 18 ] ) ] ] ) ] .
:Adult a owl:Class ; rdfs:label "Adult" ;
    owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( :Person [ a owl:Restriction ; owl:onProperty :hasAge ; owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:integer ; owl:withRestrictions ( [ xsd:minInclusive 18 ] ) ] ] ) ] .
:Member a owl:Class ; rdfs:label "Member" ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty [ owl:inverseOf :hasMember ] ; owl:someValuesFrom :Organization ] ,
        [ a owl:Restriction ; owl:onProperty :hasChild ; owl:qualifiedCardinality "2"^^xsd:nonNegativeInteger ; owl:onClass [ a owl:Class ; owl:complementOf :Student ] ] .
:Parent a owl:Class ; rdfs:label "Parent" ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasChild ; owl:allValuesFrom [ a owl:Class ; owl:unionOf ( :Person :Organization ) ] ] ,
        [ a owl:Restriction ; owl:onProperty :hasChild ; owl:someValuesFrom [ a owl:Class ; owl:unionOf ( :Student [ a owl:Class ; owl:intersectionOf ( :Person [ a owl:Restriction ; owl:onProperty :hasAge ; owl:hasValue 3 ] ) ] ) ] ] ;
    owl:disjointWith [ a owl:Class ; owl:oneOf ( :Red :Green ) ] .
:Hermit a owl:Class ; rdfs:label "Hermit" ; rdfs:subClassOf owl:Thing ;
    owl:disjointWith [ a owl:Restriction ; owl:onProperty :hasChild ; owl:someValuesFrom owl:Thing ] .
`;

const said = (m: Model, t: Term | undefined) => (t?.classAxioms ?? []).map((a) => `${a.kind}: ${classText(a.expression, namingFor(m))}`);
const term = (m: Model, local: string) => m.terms.find((t) => t.iri === M + local);
const statements = (ttl: string) => statementsOf(ttl).map((s) => s.text).sort();
const axiomStatements = (ttl: string) => statements(ttl).filter((s) => /#(subClassOf|equivalentClass|disjointWith)> /.test(s));

describe('reading class axioms', () => {
  const m = fromTurtle(SOURCE);

  it('reads each statement as an axiom of its kind, with its whole structure', () => {
    expect(said(m, term(m, 'AdultPerson'))).toEqual(['SubClassOf: Person and (hasAge some xsd:integer[>= 18])']);
    expect(said(m, term(m, 'Adult'))).toEqual(['EquivalentClasses: Person and (hasAge some xsd:integer[>= 18])']);
    expect(said(m, term(m, 'Member'))).toEqual(['SubClassOf: inverse hasMember some Organization', 'SubClassOf: hasChild exactly 2 (not Student)']);
    expect(said(m, term(m, 'Parent'))).toEqual(['SubClassOf: hasChild only (Person or Organization)', 'SubClassOf: hasChild some (Student or (Person and (hasAge value 3)))', 'DisjointClasses: {Red, Green}']);
    expect(said(m, term(m, 'Hermit'))).toEqual(['SubClassOf: owl:Thing', 'DisjointClasses: hasChild some owl:Thing']);
    // Nothing of it is left over as text kept as it was read.
    expect(m.unmapped).toBeUndefined();
  });

  it('keeps a SubClassOf and an EquivalentClasses of the same expression apart: they say different things', () => {
    const sub = term(m, 'AdultPerson')!.classAxioms![0];
    const eq = term(m, 'Adult')!.classAxioms![0];
    expect(sub.expression).toEqual(eq.expression);
    expect([sub.kind, eq.kind]).toEqual(['SubClassOf', 'EquivalentClasses']);
  });

  it('keeps two superclasses two axioms, never one intersection or union of them', () => {
    expect(term(m, 'Member')!.classAxioms).toHaveLength(2);
    expect(term(m, 'Parent')!.classAxioms!.filter((a) => a.kind === 'SubClassOf')).toHaveLength(2);
  });

  it('writes back the statements it read, and reads them back the same: import, export, import', () => {
    const ttl = toTurtle(m);
    expect(axiomStatements(ttl)).toEqual(axiomStatements(SOURCE));
    const back = fromTurtle(ttl);
    for (const local of ['AdultPerson', 'Adult', 'Member', 'Parent', 'Hermit']) expect(term(back, local)!.classAxioms!.map((a) => [a.kind, a.expression])).toEqual(term(m, local)!.classAxioms!.map((a) => [a.kind, a.expression]));
    expect(toTurtle(back)).toBe(ttl);
  });

  it('is saved and opened with every axiom, its id, kind and expression', () => {
    const back = normalizeModel(JSON.parse(JSON.stringify(m)));
    for (const local of ['Member', 'Parent']) expect(term(back, local)!.classAxioms).toEqual(term(m, local)!.classAxioms);
    // What is not well formed is not taken.
    expect(classExpressionAxiomFrom({ kind: 'SubClassOf', expression: { type: 'ObjectUnionOf', operands: [] } })).toBeUndefined();
    expect(classExpressionAxiomFrom({ kind: 'Subclass', expression: { type: 'Class', iri: M + 'A' } })).toBeUndefined();
  });

  it('is in OWL functional-style syntax what the OWL API makes of it', () => {
    expect(functionalSyntax(term(m, 'Member')!.classAxioms![0].expression)).toBe(`ObjectSomeValuesFrom(ObjectInverseOf(<${M}hasMember>) <${M}Organization>)`);
  });
});

describe('editing class axioms', () => {
  const st = useStore.getState;
  const open = () => st().replaceModel(fromTurtle(SOURCE));
  const axioms = (local: string) => term(st().model, local)!.classAxioms ?? [];

  it('adds, changes and removes one axiom at a time, and undo takes each back', () => {
    open();
    const member = term(st().model, 'Member')!;
    const n = namingFor(st().model);
    const [first, second] = member.classAxioms!;
    const added: ClassExpressionAxiom = { id: 'new', kind: 'EquivalentClasses', expression: parseClass('Person and (hasChild min 1)', n) };
    st().updateTerm(member.id, { classAxioms: [first, second, added] });
    st().updateTerm(member.id, { classAxioms: [first, { ...second, kind: 'DisjointClasses' }, added] });
    st().updateTerm(member.id, { classAxioms: [second, added].map((a) => (a.id === second.id ? { ...a, kind: 'DisjointClasses' as const } : a)) });
    expect(said(st().model, term(st().model, 'Member'))).toEqual(['DisjointClasses: hasChild exactly 2 (not Student)', 'EquivalentClasses: Person and (hasChild min 1)']);
    const ttl = toTurtle(st().model);
    expect(ttl).toContain(':Member a owl:Class ;');
    expect(axiomStatements(ttl).filter((s) => s.startsWith(`<${M}Member>`))).toHaveLength(2);
    st().undo();
    st().undo();
    st().undo();
    expect(axioms('Member')).toEqual([first, second]);
  });

  it('takes a deleted class out of the unions and intersections that name it, and an axiom it is part of otherwise goes', () => {
    open();
    const organization = term(st().model, 'Organization')!;
    const student = term(st().model, 'Student')!;
    st().remove([organization.id], []);
    // Inside a restriction it is not dropped from the union there, which would change what the
    // restriction says: the axiom goes, as the OWL API's entity remover has it.
    expect(said(st().model, term(st().model, 'Parent'))).toEqual(['SubClassOf: hasChild some (Student or (Person and (hasAge value 3)))', 'DisjointClasses: {Red, Green}']);
    expect(said(st().model, term(st().model, 'Member'))).toEqual(['SubClassOf: hasChild exactly 2 (not Student)']);
    st().remove([student.id], []);
    expect(said(st().model, term(st().model, 'Member'))).toEqual([]);
    expect(term(st().model, 'Member')!.classAxioms).toBeUndefined();
    st().undo();
    st().undo();
    expect(said(st().model, term(st().model, 'Member'))).toHaveLength(2);
  });

  it('follows a class or a property whose IRI is changed', () => {
    open();
    const moved = setIriSuffix(st().model, { prop: st().model.props.find((p) => p.iri === M + 'hasMember')!.id }, 'hasPart').model!;
    expect(functionalSyntax(term(moved, 'Member')!.classAxioms![0].expression)).toBe(`ObjectSomeValuesFrom(ObjectInverseOf(<${M}hasPart>) <${M}Organization>)`);
  });
});
