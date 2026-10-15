import fs from 'node:fs';
import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';
import { linkProps } from './identity';
import { setIriSuffix, withIris } from './iri';
import { loadOxigraph } from './oxigraph';
import { fromTurtle, toJsonLd, toTurtle } from './rdf';
import { sampleModel, skosSample } from './sample';
import { universitySample } from './sampleUniversity';
import { useStore } from './store';
import { stressModel } from './stress';
import { newRelation, normalizeModel, type Model } from './types';
import { keptSummary, renameIris, statementsOf, withoutIris } from './unmapped';

/**
 * What the reader has no place for is kept as it was and written back (TD-01, step 1): whole
 * statements, never one the model also holds, following the model when it changes.
 */

const P = `@prefix : <http://example.org/o#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;
// A class defined on itself as an intersection (OWL 1 style), a chain, a version IRI and an
// axiom annotation: none has a place in the model. The restriction and the subclass do.
const ONTOLOGY = `${P}
<http://example.org/o> a owl:Ontology ; rdfs:label "O"@en ; owl:versionIRI <http://example.org/o/1.0> .
:A a owl:Class ; rdfs:label "A"@en .
:B a owl:Class ; rdfs:label "B"@en ; rdfs:subClassOf :A , [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom :A ] .
:C a owl:Class ; rdfs:label "C"@en ; owl:intersectionOf ( :A :B ) .
:p a owl:ObjectProperty ; rdfs:label "p"@en .
:q a owl:ObjectProperty ; rdfs:label "q"@en ; owl:propertyChainAxiom ( :p :p ) .
[] a owl:Axiom ; owl:annotatedSource :B ; owl:annotatedProperty rdfs:subClassOf ; owl:annotatedTarget :A ; rdfs:comment "because"@en .
`;
const lines = (m: Model) => (m.unmapped ?? '').split('\n').filter(Boolean);

describe('statements', () => {
  it('are the same statement whatever the blank nodes are called and whatever order the triples came in', () => {
    const one = statementsOf(`${P}:B rdfs:subClassOf [ owl:someValuesFrom :A ; owl:onProperty :p ; a owl:Restriction ] .`);
    const two = statementsOf(`${P}_:x owl:onProperty :p . :B rdfs:subClassOf _:x . _:x a owl:Restriction . _:x owl:someValuesFrom :A .`);
    expect(one.map((s) => s.text)).toEqual(two.map((s) => s.text));
    expect(one).toHaveLength(1);
    expect(one[0].quads).toHaveLength(4);
  });

  it('write a list in place, and keep what shares a blank node as one', () => {
    const [chain] = statementsOf(`${P}:q owl:propertyChainAxiom ( :p :p ) .`);
    expect(chain.text).toBe('<http://example.org/o#q> <http://www.w3.org/2002/07/owl#propertyChainAxiom> ( <http://example.org/o#p> <http://example.org/o#p> ) .');
    const shared = statementsOf(`${P}:p rdfs:domain _:u . _:u owl:unionOf ( :A :B ) . [] a owl:Axiom ; owl:annotatedSource :p ; owl:annotatedTarget _:u .`);
    expect(shared).toHaveLength(1);
    // And the text reads back as the same statement.
    expect(statementsOf(shared[0].text).map((s) => s.text)).toEqual([shared[0].text]);
  });
});

describe('reading an ontology', () => {
  const m = fromTurtle(ONTOLOGY);

  it('keeps what it has no place for, and nothing it has', () => {
    const kept = lines(m).join('\n');
    expect(kept).toContain('#intersectionOf> ( <http://example.org/o#A> <http://example.org/o#B> )');
    expect(kept).toContain('#propertyChainAxiom>');
    expect(kept).toContain('#versionIRI> <http://example.org/o/1.0>');
    expect(kept).toContain('"because"@en');
    // The subclass, the restriction, the declarations and the labels are the model's.
    expect(kept).not.toMatch(/someValuesFrom|#Class>|"A"@en/);
    expect(m.relations).toHaveLength(2);
    expect(keptSummary(m.unmapped)).toEqual(['1 property chain', '1 annotation on an axiom', '2 other statements']);
  });

  it('writes it back with the ontology, and reads the same back again', () => {
    const ttl = toTurtle(m);
    expect(ttl).toContain('# Kept as they were read');
    const again = fromTurtle(ttl);
    expect(again.unmapped).toBe(m.unmapped);
    expect(toTurtle(again)).toBe(ttl);
  });

  it('keeps nothing of what the app writes itself', () => {
    for (const model of [sampleModel(), universitySample(), skosSample(), stressModel(350)]) expect(fromTurtle(toTurtle(withIris(model))).unmapped).toBeUndefined();
    const dir = new URL('./fixtures/v1/', import.meta.url).pathname;
    for (const name of ['sample', 'university', 'edge-cases']) {
      const saved = linkProps(withIris(normalizeModel(JSON.parse(fs.readFileSync(dir + name + '.json', 'utf8')))));
      expect(fromTurtle(toTurtle(saved)).unmapped).toBeUndefined();
    }
  });

  it('is saved with the model, and in JSON-LD as well as Turtle', async () => {
    expect(normalizeModel(JSON.parse(JSON.stringify(m))).unmapped).toBe(m.unmapped);
    const ox = await loadOxigraph();
    const store = new ox.Store();
    store.load(toJsonLd(m), { format: 'application/ld+json' });
    const triples = store.dump({ format: 'application/n-triples', from_graph_name: ox.defaultGraph() });
    expect(triples).toContain('<http://example.org/o> <http://www.w3.org/2002/07/owl#versionIRI> <http://example.org/o/1.0> .');
    expect(triples).toContain('owl#propertyChainAxiom');
  });

  it('writes a description and a name with the property and in the language they were read in', () => {
    const ttl = `${P}<http://example.org/o> a owl:Ontology ; <http://purl.org/dc/terms/title> "Old" ; rdfs:comment "An ontology" .
:A a owl:Class ; rdfs:label "A"@en ; rdfs:comment "untagged" . :B a owl:Class ; rdfs:label "Bee" ; rdfs:comment "said"@en ; <http://www.w3.org/2004/02/skos/core#definition> "said"@en .`;
    const read = fromTurtle(ttl);
    expect(read.lang).toBe('en');
    const a = read.terms.find((t) => t.name === 'A')!;
    expect(a).toMatchObject({ description: 'untagged', describedBy: 'rdfs:comment', descriptionLang: '' });
    expect(read.terms.find((t) => t.name === 'Bee')).toMatchObject({ nameLang: '' });
    expect(read).toMatchObject({ name: 'Old', namedBy: 'dcterms:title', nameLang: '', description: 'An ontology', descriptionLang: '' });
    const quads = (text: string) => new Set((new Parser().parse(text) as { subject: { value: string }; predicate: { value: string }; object: { value: string; language?: string } }[]).map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}@${q.object.language ?? ''}`));
    // Every statement of the file is in what is written back.
    const back = quads(toTurtle(read));
    expect([...quads(ttl)].filter((x) => !back.has(x))).toEqual([]);
  });
});

describe('kept statements follow the model', () => {
  const st = useStore.getState;

  it('take an entity’s new IRI along', () => {
    const m = withIris(fromTurtle(ONTOLOGY));
    const c = m.terms.find((t) => t.name === 'C')!;
    const moved = setIriSuffix(m, { term: c.id }, 'Cee').model!;
    expect(moved.unmapped).toContain('<http://example.org/o#Cee> <http://www.w3.org/2002/07/owl#intersectionOf>');
    expect(moved.unmapped).not.toContain('<http://example.org/o#C> ');
    expect(renameIris('<a> <b> <c> .', new Map([['c', 'd']]))).toBe('<a> <b> <d> .');
  });

  it('go with an entity that is deleted, and come back with it on undo', () => {
    st().replaceModel(fromTurtle(ONTOLOGY));
    const before = lines(st().model);
    const c = st().model.terms.find((t) => t.name === 'C')!;
    st().remove([c.id], []);
    const after = lines(st().model);
    expect(after).toHaveLength(before.length - 1);
    expect(after.join('\n')).not.toContain('#C>');
    // What else was kept is untouched, and an edit that deletes nothing leaves all of it.
    st().updateTerm(st().model.terms[0].id, { description: 'changed' });
    expect(lines(st().model)).toEqual(after);
    st().undo();
    st().undo();
    expect(lines(st().model)).toEqual(before);
    expect(withoutIris('<http://x/a> <http://x/p> <http://x/b> .\n', new Set(['http://x/b']))).toBeUndefined();
  });
});

describe('what the model holds is written back as it was read', () => {
  const O = 'http://example.org/o#';
  const texts = (ttl: string) => new Set(statementsOf(ttl).map((s) => s.text));
  /** The statements of a file that are not in what the model read from it writes back. */
  const lost = (ttl: string, m = fromTurtle(ttl)) => {
    const back = texts(toTurtle(m));
    return [...texts(ttl)].filter((t) => !back.has(t));
  };
  const id = (m: Model, name: string) => m.terms.find((t) => t.name === name)!.id;
  const disjoint = (a: string, b: string) => `<${O}${a}> <http://www.w3.org/2002/07/owl#disjointWith> <${O}${b}> .`;

  it('disjointness among many classes: drawn as its pairs, written as the one axiom while every pair is stated', () => {
    const ttl = `${P}:A a owl:Class . :B a owl:Class . :C a owl:Class . :A owl:disjointWith :B . [] a owl:AllDisjointClasses ; owl:members ( :A :B :C ) .`;
    const m = fromTurtle(ttl);
    const pairs = m.relations.filter((r) => r.predicate === 'owl:disjointWith');
    expect(pairs).toHaveLength(3);
    expect(new Set(pairs.map((r) => r.group)).size).toBe(1);
    // The pair that was also stated on its own is written on its own too.
    expect(pairs.filter((r) => r.statedAlone).map((r) => [r.from, r.to])).toEqual([[id(m, 'A'), id(m, 'B')]]);
    expect(lost(ttl, m)).toEqual([]);
    expect([...texts(toTurtle(m))].filter((t) => t.includes('disjointWith'))).toEqual([disjoint('A', 'B')]);
    // Saved and opened again it is the same.
    expect(lost(ttl, normalizeModel(JSON.parse(JSON.stringify(m))))).toEqual([]);

    // A pair taken away, what is left is no longer the axiom: it is written as the pairs it is.
    const less = { ...m, relations: m.relations.filter((r) => !(r.from === id(m, 'B') && r.to === id(m, 'C'))) };
    const written = [...texts(toTurtle(less))];
    expect(written.some((t) => t.includes('AllDisjointClasses'))).toBe(false);
    expect(written.filter((t) => t.includes('disjointWith')).sort()).toEqual([disjoint('A', 'B'), disjoint('A', 'C')]);
    // And stated again by hand, it is the axiom again.
    const again = { ...less, relations: [...less.relations, newRelation({ from: id(m, 'C'), to: id(m, 'B'), predicate: 'owl:disjointWith' })] };
    expect(lost(ttl, again)).toEqual([]);
  });

  it('that individuals are all different, as one axiom', () => {
    const ttl = `${P}:C a owl:Class . :a a owl:NamedIndividual , :C . :b a owl:NamedIndividual , :C . :c a owl:NamedIndividual , :C . :d a owl:NamedIndividual , :C .
[] a owl:AllDifferent ; owl:members ( :a :b :c ) .`;
    const m = fromTurtle(ttl);
    expect(m.relations.filter((r) => r.predicate === 'owl:differentFrom')).toHaveLength(3);
    expect(lost(ttl, m)).toEqual([]);
  });

  it('text that looks like a link is text, and a link a link', () => {
    const ttl = `${P}:A a owl:Class ; rdfs:seeAlso "http://example.org/text" , <http://example.org/link> .`;
    expect(lost(ttl)).toEqual([]);
    expect(lost(ttl, normalizeModel(JSON.parse(JSON.stringify(fromTurtle(ttl)))))).toEqual([]);
  });

  it('a restriction to another datatype than the property’s range stays an axiom of the class, with its datatype', () => {
    const ttl = `${P}:A a owl:Class . :d a owl:DatatypeProperty ; rdfs:range xsd:integer . :e a owl:DatatypeProperty ; rdfs:range xsd:integer .
:A rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :d ; owl:someValuesFrom xsd:string ] , [ a owl:Restriction ; owl:onProperty :e ; owl:someValuesFrom xsd:integer ] .`;
    const m = fromTurtle(ttl);
    expect(m.terms.find((t) => t.name === 'A')!.classAxioms?.map((x) => x.expression)).toEqual([
      { type: 'DataSomeValuesFrom', property: { type: 'DataProperty', iri: O + 'd' }, filler: { type: 'Datatype', iri: 'http://www.w3.org/2001/XMLSchema#string' } },
    ]);
    // The one to the range is drawn.
    expect(m.relations.filter((r) => r.kind === 'property').map((r) => r.to)).toEqual([id(m, 'e')]);
    expect(lost(ttl, m)).toEqual([]);
  });
});
