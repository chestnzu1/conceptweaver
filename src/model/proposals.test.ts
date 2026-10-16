import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORPUS, corpusFile } from '../../corpus/corpus.mjs';
import { axiomFunctionalSyntax } from './expressions';
import { readModelFile } from './files';
import { FROM_AXIOM, originsOf, proposalsFor, proposalText, proposeShapes, withProposals, type Proposal } from './proposals';
import { fromTurtle, toTurtle } from './rdf';
import { decodeDocument } from './rdfFormats';
import { readShapes, renamedSets, SH, shapeSetTurtle } from './shacl';
import { newSetFor, topShapes } from './shapes';
import type { Model } from './types';
import { shaclFindings } from './validation';

/**
 * Shapes proposed from the ontology (roadmap stage SH-3, ADR-020): what each kind of axiom gives,
 * said with what it means and where it differs; nothing added until accepted; an accepted shape
 * that names its axiom, and is stale once the ontology no longer states it.
 */

const X = 'http://example.org/x#';
const ONTOLOGY = `@prefix : <${X}> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/x> a owl:Ontology .
:Film a owl:Class ; rdfs:subClassOf
  [ a owl:Restriction ; owl:onProperty :genre ; owl:someValuesFrom :Genre ] ,
  [ a owl:Restriction ; owl:onProperty :director ; owl:maxCardinality 2 ] ,
  [ a owl:Restriction ; owl:onProperty :genre ; owl:allValuesFrom [ owl:unionOf ( :Genre :Mood ) ] ] ,
  [ a owl:Restriction ; owl:onProperty :title ; owl:cardinality 1 ] .
:Genre a owl:Class ; owl:equivalentClass [ owl:oneOf ( :Drama :Comedy ) ] .
:Mood a owl:Class .
:Drama a owl:NamedIndividual . :Comedy a owl:NamedIndividual .
:genre a owl:ObjectProperty ; rdfs:domain :Film ; rdfs:range :Genre .
:director a owl:ObjectProperty , owl:InverseFunctionalProperty .
:title a owl:DatatypeProperty , owl:FunctionalProperty ; rdfs:range xsd:string .
:Film owl:hasKey ( :title ) .`;

const sorted = (m: Model) => proposeShapes(m).proposals.map((p) => `${p.group}: ${p.axiom}`).sort();
const named = (m: Model, axiom: string) => proposeShapes(m).proposals.find((p) => p.axiom === axiom)!;

describe('shapes proposed from the ontology', () => {
  it('reads each kind of axiom, and proposes a shape for what SHACL Core can check', () => {
    const m = fromTurtle(ONTOLOGY);
    expect(sorted(m)).toEqual([
      'Characteristics: director Characteristics: InverseFunctional',
      'Characteristics: title Characteristics: Functional',
      'Domains and ranges: genre Domain Film',
      'Domains and ranges: genre Range Genre',
      'Domains and ranges: title Range xsd:string',
      'Enumerations: Genre EquivalentTo {Drama, Comedy}',
      'Restrictions: Film SubClassOf director max 2',
      'Restrictions: Film SubClassOf genre only (Genre or Mood)',
      'Restrictions: Film SubClassOf genre some Genre',
      'Restrictions: Film SubClassOf title exactly 1',
    ]);
    const name = (iri: string) => iri.replace(X, ':').replace('http://www.w3.org/2001/XMLSchema#', 'xsd:');
    const text = (axiom: string) => proposalText(named(m, axiom), name);
    expect(text('Film SubClassOf genre some Genre')).toBe('sh:targetClass :Film ; sh:property [ sh:path :genre ; sh:qualifiedValueShape [ sh:class :Genre ] ; sh:qualifiedMinCount 1 ]');
    expect(text('Film SubClassOf director max 2')).toBe('sh:targetClass :Film ; sh:property [ sh:path :director ; sh:maxCount 2 ]');
    expect(text('Film SubClassOf title exactly 1')).toBe('sh:targetClass :Film ; sh:property [ sh:path :title ; sh:minCount 1 ; sh:maxCount 1 ]');
    expect(text('Film SubClassOf genre only (Genre or Mood)')).toBe('sh:targetClass :Film ; sh:property [ sh:path :genre ; sh:or ( [ sh:class :Genre ] [ sh:class :Mood ] ) ]');
    expect(text('genre Domain Film')).toBe('sh:targetSubjectsOf :genre ; sh:class :Film');
    expect(text('title Range xsd:string')).toBe('sh:targetSubjectsOf :title ; sh:property [ sh:path :title ; sh:datatype xsd:string ]');
    expect(text('director Characteristics: InverseFunctional')).toBe('sh:targetObjectsOf :director ; sh:property [ sh:path ^:director ; sh:maxCount 1 ]');
    expect(text('Genre EquivalentTo {Drama, Comedy}')).toBe('sh:targetClass :Genre ; sh:in ( :Drama :Comedy )');
    // A key is read, and said why it gives no shape.
    expect(proposeShapes(m).notProposed).toEqual([expect.objectContaining({ axiom: 'Film HasKey title', why: expect.stringContaining('SHACL-SPARQL') })]);
  });

  it('says what the axiom means, what the shape checks, and where they differ', () => {
    const m = fromTurtle(ONTOLOGY);
    const some = named(m, 'Film SubClassOf genre some Genre');
    expect(some.origin).toBe(`SubClassOf(<${X}Film> ObjectSomeValuesFrom(<${X}genre> <${X}Genre>))`);
    expect(some.owl).toBe('Every Film has at least one value of genre that is a Genre. Where the data names too few, OWL concludes the others exist, unnamed: nothing is wrong.');
    expect(some.shacl).toBe('Every Film in the data has at least one value of genre that is a Genre.');
    expect(some.differ).toContain('OWL concludes the values that are missing');
    expect(named(m, 'genre Domain Film').differ).toContain('a domain classifies what uses the property; in SHACL it constrains it');
    expect(named(m, 'director Characteristics: InverseFunctional').differ).toContain('OWL concludes that they name one individual');
    // For a class or a few: what is said of their members, and of the properties they are the domain or range of.
    expect(proposalsFor(proposeShapes(m), [X + 'Genre']).proposals.map((p) => p.axiom).sort()).toEqual(['Genre EquivalentTo {Drama, Comedy}', 'genre Range Genre']);
  });

  it('changes nothing until accepted, and then adds the shapes, each naming its axiom, as one change', async () => {
    const m = fromTurtle(ONTOLOGY);
    const before = toTurtle(m);
    const all = proposeShapes(m).proposals;
    expect(toTurtle(m)).toBe(before);
    expect(m.shapeSets).toEqual([]);
    const set = newSetFor('From the ontology');
    const accepted = all.filter((p) => p.group === 'Restrictions' || p.axiom === 'genre Domain Film');
    const { set: next, shapes } = withProposals({ ...m, shapeSets: [set] }, set, accepted);
    expect(shapes).toBe(5);
    // One node shape for Film, with a property shape for each restriction; the domain a node shape of its own.
    const tops = topShapes(next);
    expect(tops.map((s) => s.props.find((x) => x.p === SH + 'targetClass' || x.p === SH + 'targetSubjectsOf')!.v)).toEqual([{ iri: X + 'Film' }, { iri: X + 'genre' }]);
    const film = tops[0];
    expect(film.props.filter((x) => x.p === SH + 'property')).toHaveLength(4);
    expect(next.shapes.flatMap(originsOf).sort()).toEqual([...new Set(accepted.map((p) => p.origin))].sort().flatMap((o) => accepted.filter((p) => p.origin === o).map(() => o)));
    // Accepted again, nothing is added twice.
    expect(withProposals({ ...m, shapeSets: [next] }, next, accepted).shapes).toBe(0);
    // Its origin is written with it, and read back.
    const back = readShapes(shapeSetTurtle(next));
    expect(back.shapes.flatMap(originsOf).sort()).toEqual(next.shapes.flatMap(originsOf).sort());
    expect(shapeSetTurtle(next)).toContain('cw:fromAxiom "SubClassOf(');

    // The shapes check what they say: a Film of the data without a genre, with three directors, and two titles.
    const withSet = { ...m, shapeSets: [next] };
    const data = `@prefix : <${X}> . :f a :Film ; :director :a , :b , :c ; :title "One" , "Two" . :x :genre :Drama .`;
    const { findings } = await shaclFindings(withSet, { source: 'graph', id: 'd', name: 'd', fingerprint: 'd', text: data, includeOntology: true });
    expect(findings.map((f) => `${f.shacl!.focusNode} ${f.rule}`).sort()).toEqual([':f MaxCount', ':f MaxCount', ':f QualifiedMinCount', ':x Class']);
  });

  it('marks an accepted shape stale once its axiom is gone, and follows the axiom when an IRI changes', () => {
    const m = fromTurtle(ONTOLOGY);
    const set = withProposals({ ...m, shapeSets: [newSetFor('S')] }, newSetFor('S'), proposeShapes(m).proposals).set;
    const origins = set.shapes.flatMap(originsOf);
    expect(origins.every((o) => proposeShapes(m).origins.has(o))).toBe(true);
    // Film no longer needs a genre: that shape is stale, the others are not.
    const gone = proposeShapes(m).proposals.find((p) => p.axiom === 'Film SubClassOf genre some Genre')!;
    const edited = fromTurtle(ONTOLOGY.replace('[ a owl:Restriction ; owl:onProperty :genre ; owl:someValuesFrom :Genre ] ,', ''));
    const now = proposeShapes(edited).origins;
    expect(origins.filter((o) => !now.has(o))).toEqual([gone.origin]);
    // A class given another IRI: the shapes follow it, and the axioms they came from are the same axioms.
    const [renamed] = renamedSets([set], new Map([[X + 'Film', X + 'Movie']]));
    const moved = proposeShapes(fromTurtle(ONTOLOGY.replaceAll(':Film', ':Movie'))).origins;
    expect(renamed.shapes.flatMap(originsOf).filter((o) => !moved.has(o))).toEqual([]);
    expect(renamed.shapes.flatMap(originsOf).some((o) => o.includes(X + 'Movie'))).toBe(true);
  });

  it('proposes for Pizza, and the proposals for one of its classes, without changing it', async () => {
    const pizza = CORPUS.find((c: { id: string }) => c.id === 'pizza')!;
    if (!fs.existsSync(corpusFile(pizza))) return;
    const { model } = await readModelFile(decodeDocument(new Uint8Array(fs.readFileSync(corpusFile(pizza)))), pizza.file);
    const before = toTurtle(model);
    const found = proposeShapes(model);
    expect(toTurtle(model)).toBe(before);
    expect(found.proposals.length).toBeGreaterThan(150);
    // Its closure axioms, "has topping only (A or B or C)", are proposed with sh:or.
    const american = proposalsFor(found, [found.proposals.find((p) => p.axiom.startsWith('American SubClassOf'))!.classes[0]]);
    const closure = american.proposals.find((p) => p.axiom.includes(' only '))!;
    expect(closure.constraints.map((x) => x.p)).toEqual([SH + 'or']);
    expect(closure.inline).toHaveLength(3);
    // What cannot be said in SHACL Core is said, with why.
    expect(found.notProposed.length).toBeGreaterThan(0);
    expect(found.notProposed.every((x) => x.why.length > 20)).toBe(true);
    // Accepted, a proposal names its axiom; the axiom gone, it is stale.
    const set = newSetFor('Pizza');
    const accepted: Proposal = american.proposals[0];
    const made = withProposals({ ...model, shapeSets: [set] }, set, [accepted]).set;
    expect(made.shapes.some((s) => s.props.some((x) => x.p === FROM_AXIOM && 'lit' in x.v && x.v.lit === accepted.origin))).toBe(true);
    const term = model.terms.find((t) => (t.classAxioms ?? []).some((a) => axiomFunctionalSyntax(t.iri!, a) === accepted.origin));
    if (term) {
      const without = { ...model, terms: model.terms.map((t) => (t.id === term.id ? { ...t, classAxioms: t.classAxioms!.filter((a) => axiomFunctionalSyntax(t.iri!, a) !== accepted.origin) } : t)) };
      expect(proposeShapes(without).origins.has(accepted.origin)).toBe(false);
    }
  }, 60_000);
});
