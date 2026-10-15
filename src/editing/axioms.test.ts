import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toTurtle } from '../model/rdf';
import { sampleModel, skosSample } from '../model/sample';
import { universitySample } from '../model/sampleUniversity';
import { stressModel } from '../model/stress';
import { normalizeModel, type Model } from '../model/types';
import { statementsOf } from '../model/unmapped';
import { axiomOf, brief, kindsOf, statementOf } from './axioms';
import type { Axiom, ClassExpression as ContractClass, DataRange as ContractRange } from './contracts';
import type { ClassExpression as ModelClass, DataRange as ModelRange } from '../model/expressions';

const fixtures = (dir: string) => readdirSync(new URL(`../model/fixtures/${dir}/`, import.meta.url)).filter((f) => f.endsWith('.json') && !f.includes('reading'));
const fixture = (dir: string, f: string) => normalizeModel(JSON.parse(readFileSync(new URL(`../model/fixtures/${dir}/${f}`, import.meta.url), 'utf8')));

/** The app's own models and the frozen fixtures of every model format. */
const models = (): [string, Model][] => [
  ['sample', sampleModel()],
  ['skos', skosSample()],
  ['university', universitySample()],
  ['stress', stressModel(60)],
  ...['v1', 'v2', 'v3'].flatMap((v) => fixtures(v).map((f): [string, Model] => [`${v}/${f}`, fixture(v, f)])),
];

/** The ontologies of the round-trip corpus, where they have been fetched (pnpm corpus). */
const corpus = (): [string, string][] => {
  const dir = new URL('../../corpus/files/', import.meta.url);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ttl'))
    .map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]);
};

describe('a statement as an axiom', () => {
  it('writes back as the very statement it was read from, typed or not', () => {
    const typed = new Map<string, number>();
    let all = 0;
    for (const [name, m] of models()) {
      const stmts = statementsOf(toTurtle(m));
      const kinds = kindsOf(stmts);
      for (const s of stmts) {
        const a = axiomOf(s, kinds);
        expect(statementOf(a), `${name}: ${s.text}`).toBe(s.text);
        all++;
        if (a.type !== 'Unmapped') typed.set(a.type, (typed.get(a.type) ?? 0) + 1);
      }
    }
    // Everything the app writes of these models has a typed form, but for plain relationships
    // (an rdf:Property and the triples that use it), which OWL has no axiom for.
    const untyped = all - [...typed.values()].reduce((n, x) => n + x, 0);
    expect(untyped / all).toBeLessThan(0.05);
    expect([...typed.keys()]).toEqual(expect.arrayContaining(['AnnotationAssertion', 'ClassAssertion', 'DataPropertyDomain', 'DataPropertyRange', 'DatatypeDefinition', 'Declaration', 'DisjointClasses', 'EquivalentClasses', 'InverseObjectProperties', 'ObjectPropertyAssertion', 'ObjectPropertyDomain', 'ObjectPropertyRange', 'Ontology', 'OntologyAnnotation', 'SameIndividual', 'SubClassOf', 'SubObjectPropertyOf', 'TransitiveObjectProperty']));
  });

  it('does the same for every statement of the ontologies of the corpus', () => {
    for (const [name, ttl] of corpus()) {
      const stmts = statementsOf(ttl);
      const kinds = kindsOf(stmts);
      for (const s of stmts) expect(statementOf(axiomOf(s, kinds)), `${name}: ${s.text}`).toBe(s.text);
    }
  });

  it('reads what a property is from the ontology: a triple with it is an assertion of its kind', () => {
    const ttl = `@prefix : <http://e.org/#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      :o a owl:Ontology ; rdfs:label "O" ; owl:imports <http://e.org/other> .
      :knows a owl:ObjectProperty . :age a owl:DatatypeProperty . :note a owl:AnnotationProperty .
      :a :knows :b . :a :age 42 . :a :note "hi"@en . :a :unknown :b .
      :Film rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :knows ; owl:someValuesFrom :Person ] .`;
    const stmts = statementsOf(ttl);
    const kinds = kindsOf(stmts);
    const read = Object.fromEntries(stmts.map((s) => [s.text, axiomOf(s, kinds)]));
    const of = (part: string): Axiom => Object.entries(read).find(([t]) => t.includes(part))![1];
    expect(of('<http://e.org/#knows> <http://e.org/#b>')).toEqual({ type: 'ObjectPropertyAssertion', property: 'http://e.org/#knows', source: 'http://e.org/#a', target: 'http://e.org/#b' });
    expect(of('#age> "42"')).toEqual({ type: 'DataPropertyAssertion', property: 'http://e.org/#age', source: 'http://e.org/#a', value: { value: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } });
    expect(of('#note> "hi"@en')).toEqual({ type: 'AnnotationAssertion', property: 'http://e.org/#note', subject: 'http://e.org/#a', value: { value: 'hi', lang: 'en' } });
    // A property the ontology says nothing about has no typed form: it stays the statement it is.
    expect(of('#unknown>').type).toBe('Unmapped');
    expect(of('#o> <http://www.w3.org/2000/01/rdf-schema#label>')).toEqual({ type: 'OntologyAnnotation', ontology: 'http://e.org/#o', property: 'http://www.w3.org/2000/01/rdf-schema#label', value: { value: 'O' } });
    expect(of('owl#imports>')).toEqual({ type: 'Import', ontology: 'http://e.org/#o', iri: 'http://e.org/other' });
    expect(of('#Film>')).toEqual({ type: 'SubClassOf', sub: { type: 'Class', iri: 'http://e.org/#Film' }, sup: { type: 'ObjectSomeValuesFrom', property: { type: 'ObjectProperty', iri: 'http://e.org/#knows' }, filler: { type: 'Class', iri: 'http://e.org/#Person' } } });
    expect(brief(of('#Film>'))).toBe('SubClassOf(Film knows Person)');
  });

  it('has nothing for an axiom that is not one statement', () => {
    expect(statementOf({ type: 'EquivalentClasses', classes: [{ type: 'Class', iri: 'urn:a' }, { type: 'Class', iri: 'urn:b' }, { type: 'Class', iri: 'urn:c' }] })).toBeUndefined();
    expect(statementOf({ type: 'Unmapped', turtle: '<urn:a> <urn:p> <urn:b> . <urn:c> <urn:p> <urn:d> .' })).toBeUndefined();
    expect(statementOf({ type: 'Unmapped', turtle: 'not turtle' })).toBeUndefined();
    // n-ary disjointness of more than two is one statement of its own.
    expect(statementOf({ type: 'DisjointClasses', classes: ['urn:a', 'urn:b', 'urn:c'].map((iri): ContractClass => ({ type: 'Class', iri })) })).toContain('AllDisjointClasses');
  });

  it('has expressions that the model takes as they are', () => {
    // The contract's expressions are the model's, less the model's own enumerated datatypes.
    const asModel = (e: ContractClass): ModelClass => e;
    const rangeAsModel = (r: ContractRange): ModelRange => r;
    expect(asModel({ type: 'Class', iri: 'urn:a' })).toBeTruthy();
    expect(rangeAsModel({ type: 'Datatype', iri: 'urn:d' })).toBeTruthy();
  });
});
