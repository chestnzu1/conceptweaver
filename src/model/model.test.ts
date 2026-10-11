import { describe, expect, it } from 'vitest';
import { parseOutline, parseRelations, parseTerms } from './bulk';
import { convertModel } from './convert';
import { findPath, runChecks } from './checks';
import { assertedSuperclasses, dataDomain, objectProperties, plainRelationships, relChoice, restrictionsOf, wouldCycle } from './props';
import { moveNamespace, withIris } from './iri';
import { compactIri, expandIri, validateSettings } from './prefixes';
import { searchTerms } from './subgraph';
import { reason } from './reasoner';
import { relationsCsv } from './files';
import { forceLayout, hierarchyLayout } from './layout';
import { fromTurtle, toJsonLd, toTurtle } from './rdf';
import { sampleModel, skosSample } from './sample';
import { universitySample } from './sampleUniversity';
import { stressModel } from './stress';
import { emptyModel, newRelation, newTerm, normalizeModel } from './types';

const names = (m: ReturnType<typeof sampleModel>) => new Map(m.terms.map((t) => [t.id, t.name]));
const triples = (m: ReturnType<typeof sampleModel>) => {
  const n = names(m);
  return m.relations.map((r) => `${n.get(r.from)} -[${r.kind}:${r.label}]-> ${n.get(r.to)}`).sort();
};

describe('rdf', () => {
  it('round-trips the sample model through Turtle', () => {
    const m = sampleModel();
    const back = fromTurtle(toTurtle(m));
    expect(back.name).toBe(m.name);
    expect(back.terms.map((t) => `${t.name}:${t.type}`).sort()).toEqual(m.terms.map((t) => `${t.name}:${t.type}`).sort());
    expect(triples(back)).toEqual(triples(m));
    expect(back.terms.find((t) => t.name === 'Film')!.description).toBe(m.terms.find((t) => t.name === 'Film')!.description);
  });

  it('writes an undeclared relationship as a plain property, exactly as drawn', () => {
    const m = emptyModel('Shared');
    const [a, b, c] = ['A', 'B', 'C'].map((name) => newTerm({ name }));
    m.terms.push(a, b, c);
    m.relations.push(newRelation({ from: a.id, to: b.id, label: 'uses' }), newRelation({ from: b.id, to: c.id, label: 'Uses' }));
    const ttl = toTurtle(m);
    expect(ttl).toContain(':uses a rdf:Property ;\n    rdfs:label "uses" .');
    expect(ttl).not.toContain('owl:ObjectProperty');
    expect(ttl.split('\n\n').find((x) => x.startsWith(':A '))).toContain(':uses :B');
    const back = fromTurtle(ttl);
    expect(back.props).toEqual([]);
    expect(triples(back)).toEqual(['A -[association:uses]-> B', 'B -[association:uses]-> C']);
  });

  it('writes a declared object property once, and each use between classes as a restriction', () => {
    const m = emptyModel('Shared');
    const [a, b, c] = ['A', 'B', 'C'].map((name) => newTerm({ name }));
    m.terms.push(a, b, c);
    m.props.push({ name: 'uses', description: '', chars: [] });
    m.relations.push(newRelation({ from: a.id, to: b.id, label: 'uses' }), newRelation({ from: b.id, to: c.id, label: 'Uses', restriction: 'only' }), newRelation({ from: a.id, to: c.id, label: 'uses', restriction: 'max', restrictionN: 2 }));
    const ttl = toTurtle(m);
    expect(ttl.match(/a owl:ObjectProperty/g)).toHaveLength(1);
    expect(ttl).toContain('rdfs:domain [ a owl:Class ; owl:unionOf ( :A :B ) ]');
    expect(ttl).toContain('rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :uses ; owl:someValuesFrom :B ]');
    expect(ttl).toContain('owl:allValuesFrom :C');
    expect(ttl).toContain('[ a owl:Restriction ; owl:onProperty :uses ; owl:maxQualifiedCardinality "2"^^xsd:nonNegativeInteger ; owl:onClass :C ]');
    const back = fromTurtle(ttl);
    expect(triples(back)).toEqual(triples(m).map((x) => x.replace('Uses', 'uses')));
    expect(back.relations.map((r) => `${r.restriction ?? 'some'}${r.restrictionN ?? ''}`).sort()).toEqual(['max2', 'only', 'some']);
    // The domain and range only repeated the uses, so they still follow them.
    expect(back.props).toEqual([{ name: 'uses', iri: 'http://example.org/shared#uses', description: '', chars: [] }]);
    expect(toTurtle(back)).toBe(ttl);
  });

  it('reads plain OWL written by other tools', () => {
    const m = fromTurtle(`
      @prefix ex: <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:Dog a owl:Class ; rdfs:subClassOf ex:Animal ; rdfs:comment "Barks." .
      ex:hasOwner a owl:ObjectProperty ; rdfs:domain ex:Dog ; rdfs:range [ owl:unionOf ( ex:Person ex:Shelter ) ] .
      ex:age a owl:DatatypeProperty ; rdfs:domain ex:Animal .
      ex:rex a ex:Dog .`);
    // The object property is declared with its domain and range; no restriction places it between classes, so none is drawn.
    expect(triples(m)).toEqual(['Dog -[generalization:]-> Animal', 'rex -[generalization:]-> Dog']);
    // The data property keeps its domain, but is not drawn onto Animal: that would restrict the class.
    expect(m.terms.find((t) => t.name === 'age')!.domain).toEqual([m.terms.find((t) => t.name === 'Animal')!.id]);
    const name = (id: string) => m.terms.find((t) => t.id === id)!.name;
    expect(m.props.map((p) => `${p.name}: ${p.domain!.map(name)} -> ${p.range!.map(name)}`)).toEqual(['has owner: Dog -> Person,Shelter']);
    expect(m.terms.find((t) => t.name === 'rex')!.type).toBe('instance');
    expect(m.baseIri).toBe('http://ex.org/');
    // Imported IRIs survive a re-export.
    expect(toTurtle(m)).toContain(':Dog a owl:Class');
  });

  it('produces parseable JSON-LD', () => {
    const doc = JSON.parse(toJsonLd(sampleModel()));
    expect(doc['@graph'].some((n: Record<string, unknown>) => n['@type'] === 'http://www.w3.org/2002/07/owl#Class' || n['@type'] === 'owl:Class')).toBe(true);
  });
});

describe('checks', () => {
  it('flags the problems in a broken model', () => {
    const m = emptyModel();
    const [a, b, c, d] = ['A', 'B', 'a', ''].map((name) => newTerm({ name }));
    m.terms.push(a, b, c, d);
    m.relations.push(
      newRelation({ from: a.id, to: b.id, kind: 'generalization' }),
      newRelation({ from: b.id, to: a.id, kind: 'generalization' }),
      newRelation({ from: a.id, to: b.id, fromCard: 'many' }),
    );
    const rules = new Set(runChecks(m).map((i) => i.rule));
    for (const r of ['Unnamed term', 'Duplicate name', 'Circular hierarchy', 'Unlabelled relation', 'Invalid cardinality', 'Isolated term', 'Missing description']) {
      expect(rules).toContain(r);
    }
  });

  it('finds no errors or warnings in the sample', () => {
    expect(runChecks(sampleModel()).filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('finds the shortest path', () => {
    const m = sampleModel();
    const id = (name: string) => m.terms.find((t) => t.name === name)!.id;
    const path = findPath(m, id('Actor'), id('Genre'))!;
    expect(path.terms.map((t) => names(m).get(t))).toEqual(['Actor', 'Film', 'Genre']);
    expect(path.rels).toHaveLength(2);
  });
});

describe('layout', () => {
  it('places parents above children and never stacks two terms', () => {
    const m = sampleModel();
    for (const layout of [hierarchyLayout, forceLayout]) {
      const pos = layout(m);
      expect(pos.size).toBe(m.terms.length);
      expect(new Set([...pos.values()].map((p) => `${p.x},${p.y}`)).size).toBe(m.terms.length);
    }
    const pos = hierarchyLayout(m);
    const y = (name: string) => pos.get(m.terms.find((t) => t.name === name)!.id)!.y;
    expect(y('Person')).toBeLessThan(y('Actor'));
    expect(y('Film')).toBeLessThan(y('Documentary'));
  });

  it('survives cycles', () => {
    const m = emptyModel();
    const [a, b] = [newTerm({ name: 'A' }), newTerm({ name: 'B' })];
    m.terms.push(a, b);
    m.relations.push(newRelation({ from: a.id, to: b.id }), newRelation({ from: b.id, to: a.id }), newRelation({ from: a.id, to: a.id }));
    expect(hierarchyLayout(m).size).toBe(2);
  });
});

describe('files', () => {
  it('parses bulk terms with metadata, by position or by header', () => {
    const r = parseTerms('Customer | concept | Buys things | Client, Buyer\nOrder date\tproperty\tWhen it was placed\n# note\nAcme | company\nVIP: a valued customer\n | concept');
    expect(r.items).toEqual([
      { name: 'Customer', type: 'concept', description: 'Buys things', synonyms: 'Client, Buyer', fields: [] },
      { name: 'Order date', type: 'property', description: 'When it was placed', synonyms: '', fields: [] },
      { name: 'Acme', description: '', synonyms: '', fields: [] },
      { name: 'VIP', description: 'a valued customer', synonyms: '', fields: [] },
    ]);
    expect(r.notes).toHaveLength(2);

    const h = parseTerms('Name | Owner | Definition | Colour | Type\nInvoice | Finance | A bill | blue | Class');
    expect(h.items).toEqual([{ name: 'Invoice', type: 'concept', description: 'A bill', synonyms: '', color: 'blue', fields: [{ key: 'Owner', value: 'Finance' }] }]);
  });

  it('parses bulk relationships as arrows or columns', () => {
    const r = parseRelations('From | Label | To\nCustomer -> places -> Order\nVIP -> is a -> Customer\nOrder | has property | Date\nA -> B\njunk');
    expect(r.items.map((x) => `${x.from}>${x.kind}:${x.label}>${x.to}`)).toEqual(['Customer>association:places>Order', 'VIP>generalization:>Customer', 'Order>property:>Date', 'A>association:>B']);
    expect(r.notes).toEqual(['Line 6: expected “From -> label -> To”, skipped.']);
  });

  it('rejects junk and drops dangling relations', () => {
    expect(() => normalizeModel({ foo: 1 })).toThrow();
    const m = normalizeModel({ terms: [{ id: 'a', name: 'A', type: 'weird' }], relations: [{ from: 'a', to: 'missing' }, { from: 'a', to: 'a' }] });
    expect(m.terms[0].type).toBe('concept');
    expect(m.relations).toHaveLength(1);
  });

  it('quotes CSV cells', () => {
    const m = sampleModel();
    m.relations[4].label = 'acts, "stars" in';
    expect(relationsCsv(m)).toContain('"acts, ""stars"" in"');
  });
});

describe('rdfs/owl vocabulary', () => {
  const build = () => {
    const m = emptyModel('Vocab');
    const [car, auto, vehicle, boat] = ['Car', 'Automobile', 'Vehicle', 'Boat'].map((name) => newTerm({ name }));
    m.terms.push(car, auto, vehicle, boat);
    m.relations.push(
      newRelation({ from: car.id, to: auto.id, label: 'same class as' }),
      newRelation({ from: car.id, to: vehicle.id, label: 'kind of' }),
      newRelation({ from: car.id, to: boat.id, predicate: 'owl:disjointWith' }),
    );
    m.vocab = { enabled: true, map: { 'same class as': 'owl:equivalentClass', 'kind of': 'rdfs:subClassOf' } };
    return m;
  };

  it('exports mapped and directly assigned relations as standard properties', () => {
    const ttl = toTurtle(build());
    expect(ttl).toContain('owl:equivalentClass :Automobile');
    expect(ttl).toContain('rdfs:subClassOf :Vehicle');
    expect(ttl).toContain('owl:disjointWith :Boat');
    expect(ttl).not.toContain('owl:ObjectProperty');
  });

  it('ignores the vocabulary when it is switched off', () => {
    const m = build();
    m.vocab.enabled = false;
    const ttl = toTurtle(m);
    expect(ttl).not.toContain('owl:equivalentClass');
    expect(ttl).toContain(':sameClassAs a rdf:Property');
  });

  it('treats a relation mapped to rdfs:subClassOf as hierarchy', () => {
    const m = build();
    const pos = hierarchyLayout(m);
    const y = (name: string) => pos.get(m.terms.find((t) => t.name === name)!.id)!.y;
    expect(y('Vehicle')).toBeLessThan(y('Car'));
  });

  it('warns when a standard property joins the wrong kinds of term', () => {
    const m = build();
    m.relations[2].predicate = 'owl:sameAs';
    expect(runChecks(m).map((i) => i.rule)).toContain('Property misuse');
    expect(runChecks(build()).filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('reads standard properties back from Turtle and from JSON', () => {
    const back = fromTurtle(toTurtle(build()));
    expect(back.vocab.enabled).toBe(true);
    expect(back.relations.map((r) => `${r.kind}:${r.predicate ?? ''}`).sort()).toEqual(['association:owl:disjointWith', 'association:owl:equivalentClass', 'generalization:']);
    const json = normalizeModel(JSON.parse(JSON.stringify(build())));
    expect(json.vocab).toEqual(build().vocab);
    expect(json.relations[2].predicate).toBe('owl:disjointWith');
    expect(normalizeModel({ terms: [], relations: [] }).vocab).toEqual({ enabled: false, map: {} });
  });
});

describe('reasoner', () => {
  const build = () => {
    const m = emptyModel('Zoo');
    m.vocab.enabled = true;
    const t: Record<string, string> = {};
    const term = (name: string, type: 'concept' | 'instance' | 'property' = 'concept') => {
      const x = newTerm({ name, type });
      t[name] = x.id;
      m.terms.push(x);
    };
    const rel = (from: string, to: string, p: Partial<ReturnType<typeof newRelation>> = {}) => m.relations.push(newRelation({ from: t[from], to: t[to], ...p }));
    return { m, t, term, rel };
  };

  it('infers transitive subclasses and instance types, with the reason', () => {
    const { m, term, rel } = build();
    ['Animal', 'Mammal', 'Dog'].forEach((n) => term(n));
    term('Rex', 'instance');
    rel('Dog', 'Mammal', { kind: 'generalization' });
    rel('Mammal', 'Animal', { kind: 'generalization' });
    rel('Rex', 'Dog', { kind: 'generalization' });
    const r = reason(structuredClone(m));
    expect(r.consistent).toBe(true);
    expect(r.inferences.map((i) => i.text)).toEqual(['“Rex” is an instance of “Animal”', '“Rex” is an instance of “Mammal”', '“Dog” is a kind of “Animal”']);
    expect(r.inferences[2].because).toBe('“Dog” is a kind of “Mammal”; “Mammal” is a kind of “Animal”.');
    expect(r.inferences[2].rels).toHaveLength(2);
    expect(r.inferences[0].add).toMatchObject({ kind: 'generalization' });
  });

  it('finds an individual in two disjoint classes, and unsatisfiable classes', () => {
    const { m, t, term, rel } = build();
    ['Animal', 'Plant', 'Dog', 'Venus flytrap dog'].forEach((n) => term(n));
    term('Rex', 'instance');
    rel('Dog', 'Animal', { kind: 'generalization' });
    rel('Animal', 'Plant', { predicate: 'owl:disjointWith' });
    rel('Rex', 'Dog', { kind: 'generalization' });
    expect(reason(structuredClone(m)).consistent).toBe(true);
    rel('Rex', 'Plant', { kind: 'generalization' });
    const r = reason(structuredClone(m));
    expect(r.consistent).toBe(false);
    expect(r.conflicts[0].message).toContain('“Rex” is an instance of both');
    expect(r.conflicts[0].rels).toHaveLength(4);

    m.relations.pop();
    rel('Venus flytrap dog', 'Dog', { kind: 'generalization' });
    rel('Venus flytrap dog', 'Plant', { kind: 'generalization' });
    const r2 = reason(structuredClone(m));
    expect(r2.consistent).toBe(true);
    expect(r2.conflicts).toHaveLength(1);
    expect(r2.conflicts[0]).toMatchObject({ severity: 'warning', rule: 'Unsatisfiable class', terms: [t['Venus flytrap dog']] });
  });

  it('handles equivalence, identity and domains', () => {
    const { m, term, rel } = build();
    ['Car', 'Automobile', 'Vehicle', 'Person', 'Company'].forEach((n) => term(n));
    ['Herbie', 'The Love Bug', 'Alice', 'Acme'].forEach((n) => term(n, 'instance'));
    rel('Car', 'Automobile', { predicate: 'owl:equivalentClass' });
    rel('Automobile', 'Vehicle', { kind: 'generalization' });
    rel('Herbie', 'Car', { kind: 'generalization' });
    rel('Herbie', 'The Love Bug', { predicate: 'owl:sameAs' });
    m.props.push({ name: 'works for', description: '', chars: [] });
    rel('Person', 'Company', { label: 'works for' });
    rel('Alice', 'Acme', { label: 'works for' });
    const texts = reason(structuredClone(m)).inferences.map((i) => i.text);
    expect(texts).toContain('“Car” is a kind of “Vehicle”');
    expect(texts).toContain('“The Love Bug” is an instance of “Vehicle”');
    expect(texts).toContain('“Alice” is an instance of “Person”');
    expect(texts).toContain('“Acme” is an instance of “Company”');
    expect(texts).not.toContain('“Car” is a kind of “Automobile”');

    rel('The Love Bug', 'Herbie', { predicate: 'owl:differentFrom' });
    expect(reason(structuredClone(m)).conflicts.map((c) => c.message)).toContain('“Herbie” and “The Love Bug” are said to be both the same and different.');
  });

  it('turns a subclass cycle into an equivalence and ignores OWL properties when the vocabulary is off', () => {
    const { m, term, rel } = build();
    ['A', 'B'].forEach((n) => term(n));
    rel('A', 'B', { kind: 'generalization' });
    rel('B', 'A', { kind: 'generalization' });
    expect(reason(structuredClone(m)).inferences.map((i) => i.text)).toEqual(['“A” is equivalent to “B”']);
    m.relations = [];
    rel('A', 'B', { predicate: 'owl:equivalentClass' });
    m.vocab.enabled = false;
    // Off, it is just an unlabelled relationship of the user's own: no equivalence, nothing inferred.
    expect(reason(structuredClone(m))).toMatchObject({ inferred: 0, inferences: [], conflicts: [] });
  });

  it('has nothing to complain about in the sample', () => {
    const r = reason(sampleModel());
    expect(r.conflicts).toEqual([]);
    expect(r.inferences).toEqual([]);
  });
});

describe('sparql', () => {
  it('answers SELECT, ASK and CONSTRUCT queries over the model', async () => {
    const { runSparql } = await import('./sparql');
    const m = sampleModel();
    const sel = await runSparql(m, 'SELECT ?label WHERE { ?c rdfs:subClassOf :Person ; rdfs:label ?label } ORDER BY ?label');
    expect(sel).toMatchObject({ type: 'select', vars: ['label'] });
    expect(sel.type === 'select' && sel.rows.map((r) => r[0]?.text)).toEqual(['Actor', 'Director']);

    const iri = await runSparql(m, 'SELECT ?c ?missing WHERE { ?c rdfs:subClassOf :Film }');
    expect(iri.type === 'select' && iri.rows[0]).toEqual([{ kind: 'iri', value: 'http://example.org/film-knowledge-graph#Documentary', text: ':Documentary' }, null]);

    expect(await runSparql(m, 'ASK { :Actor rdfs:subClassOf :Person }')).toEqual({ type: 'ask', value: true });
    const graph = await runSparql(m, '# only the hierarchy\nPREFIX ex: <http://example.org/film-knowledge-graph#>\nCONSTRUCT { ?a rdfs:subClassOf ?b } WHERE { ?a rdfs:subClassOf ?b . FILTER(isIRI(?b)) }');
    expect(graph.type === 'graph' && graph.rows.length).toBe(3);

    const empty = await runSparql(m, 'SELECT ?x ?y WHERE { ?x owl:sameAs ?y }');
    expect(empty).toEqual({ type: 'select', vars: ['x', 'y'], rows: [] });
  });

  it('rejects updates and reports syntax errors', async () => {
    const { runSparql } = await import('./sparql');
    await expect(runSparql(sampleModel(), 'INSERT DATA { :a :b :c }')).rejects.toThrow(/read-only/);
    await expect(runSparql(sampleModel(), 'SELECT ?x WHERE { ?x }')).rejects.toThrow();
  });
});

describe('term metadata', () => {
  it('exports fields as annotations and reads them back', () => {
    const m = emptyModel('Meta');
    const t = newTerm({
      name: 'Invoice',
      description: 'A bill.',
      fields: [
        { key: 'rdfs:comment', value: 'Sent "monthly".' },
        { key: 'RDFS:seeAlso', value: 'https://example.org/invoices' },
        { key: 'owl:deprecated', value: 'true' },
        { key: 'dcterms:creator', value: 'Finance team' },
        { key: 'Data owner', value: 'Alice' },
        { key: '', value: 'ignored' },
      ],
    });
    m.terms.push(t, newTerm({ name: 'Receipt', fields: [{ key: 'data owner', value: 'Bob' }] }));
    const ttl = toTurtle(m);
    expect(ttl).toContain('rdfs:comment "Sent \\"monthly\\"."');
    expect(ttl).toContain('rdfs:seeAlso <https://example.org/invoices>');
    expect(ttl).toContain('owl:deprecated true');
    expect(ttl).toContain('@prefix dcterms: <http://purl.org/dc/terms/>');
    expect(ttl).toContain(':dataOwner a owl:AnnotationProperty');
    expect(ttl.match(/owl:AnnotationProperty/g)).toHaveLength(1);
    expect(JSON.parse(toJsonLd(m))['@graph'].find((n: Record<string, unknown>) => n['rdfs:label'] === 'Invoice')['owl:deprecated']).toBe(true);

    const back = fromTurtle(ttl);
    expect(back.terms.map((x) => x.name).sort()).toEqual(['Invoice', 'Receipt']);
    expect(back.terms.find((x) => x.name === 'Invoice')!.fields).toEqual([
      { key: 'rdfs:comment', value: 'Sent "monthly".' },
      { key: 'rdfs:seeAlso', value: 'https://example.org/invoices' },
      { key: 'owl:deprecated', value: 'true' },
      { key: 'dcterms:creator', value: 'Finance team' },
      { key: 'Data owner', value: 'Alice' },
    ]);
    expect(toTurtle(sampleModel())).not.toContain('dcterms');
  });
});

describe('skos', () => {
  it('exports a concept scheme with languages, top concepts and SKOS relations', () => {
    const ttl = toTurtle(skosSample());
    expect(ttl).toContain('<http://example.org/musical-instruments> a skos:ConceptScheme');
    expect(ttl).toContain('skos:hasTopConcept :MusicalInstruments , :Musicians');
    expect(ttl).toContain(':Violin a skos:Concept ;\n    skos:prefLabel "Violin"@en , "Viool"@nl , "小提琴"@zh ;');
    expect(ttl).toContain('skos:altLabel "Fiddle"@en');
    expect(ttl).toContain('skos:notation "321.322-71"');
    expect(ttl).toContain('skos:exactMatch <http://www.wikidata.org/entity/Q8355>');
    expect(ttl).toContain('skos:broader :BowedStrings');
    expect(ttl).toContain(':Violinist a skos:Concept');
    const block = (subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' '))!;
    expect(block(':Violinist')).toContain('skos:related :Violin');
    expect(block(':MusicalInstruments')).toContain('skos:topConceptOf <http://example.org/musical-instruments>');
    expect(block(':Violin')).not.toContain('skos:topConceptOf');
    expect(ttl).not.toContain('owl:Class');
  });

  it('round-trips through Turtle, keeping the mode, language and other-language labels', () => {
    const m = skosSample();
    const back = fromTurtle(toTurtle(m));
    expect(back).toMatchObject({ mode: 'skos', lang: 'en', name: 'Musical instruments', description: m.description });
    expect(triples(back)).toEqual(triples(m));
    const violin = back.terms.find((t) => t.name === 'Violin')!;
    expect(violin.synonyms).toBe('Fiddle');
    expect(violin.fields).toEqual(m.terms.find((t) => t.name === 'Violin')!.fields);
    expect(back.relations.filter((r) => r.predicate === 'skos:related')).toHaveLength(2);
    expect(toTurtle(back)).toBe(toTurtle(m));
  });

  it('reads SKOS written by other tools: narrower, symmetric related, the dominant language', () => {
    const m = fromTurtle(`
      @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix ex: <http://ex.org/> .
      ex:s a skos:ConceptScheme ; skos:prefLabel "Dieren"@nl .
      ex:a a skos:Concept ; skos:prefLabel "Dier"@nl , "Animal"@en ; skos:narrower ex:b ; skos:altLabel "Beest"@nl , "Beast"@en .
      ex:b a skos:Concept ; skos:prefLabel "Hond"@nl ; skos:related ex:c ; skos:closeMatch <http://other.org/dog> .
      ex:c a skos:Concept ; skos:prefLabel "Kat"@nl ; skos:related ex:b .`);
    expect(m).toMatchObject({ mode: 'skos', lang: 'nl', name: 'Dieren' });
    expect(triples(m)).toEqual(['Hond -[association:]-> Kat', 'Hond -[generalization:]-> Dier']);
    expect(m.terms.find((t) => t.name === 'Dier')).toMatchObject({
      synonyms: 'Beest',
      fields: [
        { key: 'skos:prefLabel', value: 'Animal', lang: 'en' },
        { key: 'skos:altLabel', value: 'Beast', lang: 'en' },
      ],
    });
    expect(m.terms.find((t) => t.name === 'Hond')!.fields).toEqual([{ key: 'skos:closeMatch', value: 'http://other.org/dog' }]);
  });

  it('checks the SKOS integrity conditions', () => {
    const m = skosSample();
    expect(runChecks(m).filter((i) => i.severity !== 'info')).toEqual([]);
    const id = (name: string) => m.terms.find((t) => t.name === name)!.id;
    const bad = structuredClone(m);
    bad.terms.find((t) => t.name === 'Violin')!.fields.push({ key: 'skos:prefLabel', value: 'Altviool', lang: 'nl' }, { key: 'skos:hiddenLabel', value: 'fiddle', lang: 'en' });
    bad.relations.push(newRelation({ from: id('Violin'), to: id('String instruments'), predicate: 'skos:related' }));
    bad.relations.push(newRelation({ from: id('Flute'), to: id('Clarinet'), predicate: 'skos:exactMatch' }), newRelation({ from: id('Clarinet'), to: id('Flute'), predicate: 'skos:broadMatch' }));
    bad.terms.find((t) => t.name === 'Drum')!.type = 'property';
    const rules = runChecks(bad).map((i) => i.rule);
    for (const r of ['Preferred label clash', 'Label clash', 'Related and broader clash', 'Mapping clash', 'Not SKOS']) expect(rules).toContain(r);
  });

  it('converts a concept scheme to an ontology and back', () => {
    const m = skosSample();
    const id = (name: string) => m.terms.find((t) => t.name === name)!.id;
    m.relations.push(
      newRelation({ from: id('Flute'), to: id('Clarinet'), predicate: 'skos:exactMatch' }),
      newRelation({ from: id('Harp'), to: id('Guitar'), predicate: 'skos:narrowMatch' }),
      newRelation({ from: id('Drum'), to: id('Trumpet'), label: 'louder than' }),
    );
    m.vocab.map = { 'same as': 'skos:exactMatch' };
    const owl = convertModel(m, 'ontology');
    expect(owl).toMatchObject({ mode: 'ontology', vocab: { enabled: true, map: { 'same as': 'owl:equivalentClass' } } });
    expect(owl.terms).toBe(m.terms);
    const ttl = toTurtle(owl);
    expect(ttl).toContain(':Violin a owl:Class ;\n    rdfs:label "Violin"@en ;');
    expect(ttl).toContain('rdfs:subClassOf :BowedStrings');
    expect(ttl).toContain('owl:equivalentClass :Clarinet');
    expect(ttl.split('\n\n').find((b) => b.startsWith(':Guitar '))).toContain('rdfs:subClassOf :PluckedStrings , :Harp');
    // What was only "related" stays a relationship: nobody has decided it is an object property.
    expect(ttl).toContain(':relatedTo a rdf:Property');
    expect(ttl).toContain(':louderThan a rdf:Property');
    expect(ttl).toContain('skos:prefLabel "Viool"@nl');
    expect(ttl).not.toContain('skos:Concept');
    expect(reason(owl).consistent).toBe(true);

    const back = convertModel(owl, 'skos');
    expect(back.mode).toBe('skos');
    expect(back.relations.filter((r) => r.kind === 'generalization')).toHaveLength(m.relations.filter((r) => r.kind === 'generalization').length + 1);
    expect(back.relations.find((r) => r.predicate === 'skos:exactMatch')).toBeTruthy();
    expect(back.vocab.map).toEqual({ 'same as': 'skos:exactMatch' });
    expect(convertModel(m, 'skos')).toBe(m);
  });

  it('ignores properties from the other vocabulary', () => {
    const m = sampleModel();
    m.vocab.enabled = true;
    m.relations[4] = { ...m.relations[4], predicate: 'skos:related' };
    expect(toTurtle(structuredClone(m))).not.toContain('skos:related');
  });

  it('parses an indented outline into a hierarchy', () => {
    const o = parseOutline(['Animals', '  Mammals', '    - Dogs', '  Birds', 'Plants', '\tAnimals', '\tPlants'].join('\n'));
    expect(o.terms).toEqual(['Animals', 'Mammals', 'Dogs', 'Birds', 'Plants']);
    expect(o.rels.map((r) => `${r.from}<${r.to}`)).toEqual(['Mammals<Animals', 'Dogs<Mammals', 'Birds<Animals', 'Animals<Plants']);
    expect(o.notes).toHaveLength(1);
    expect(parseRelations('A -> narrower -> B\nC -> BT -> D').items.map((r) => `${r.from}>${r.kind}>${r.to}`)).toEqual(['B>generalization>A', 'C>generalization>D']);
  });
});

describe('data and object properties', () => {
  it('writes a data property with its domain and datatype, and the class restricted by it', () => {
    const ttl = toTurtle(sampleModel());
    const block = (subject: string, text = ttl) => text.split('\n\n').find((b) => b.startsWith(subject + ' '))!;
    expect(block(':releaseDate')).toContain(':releaseDate a owl:DatatypeProperty');
    expect(block(':releaseDate')).toContain('rdfs:domain :Film');
    expect(block(':releaseDate')).toContain('rdfs:range xsd:date');
    // A class that has a data property is restricted by it, as well as being in its domain.
    expect(block(':Film')).toContain('[ a owl:Restriction ; owl:onProperty :releaseDate ; owl:someValuesFrom xsd:date ]');
    expect(block(':Film')).toContain('[ a owl:Restriction ; owl:onProperty :belongsTo ; owl:someValuesFrom :Genre ]');
    // "wins" has not been made an object property, so it is only a relationship.
    expect(block(':Film')).toContain(':wins :Award');
    expect(block(':wins')).toContain('a rdf:Property');
    const back = fromTurtle(ttl);
    expect(back.terms.find((t) => t.name === 'Release date')).toMatchObject({ type: 'property', range: 'xsd:date' });
    expect(back.terms.find((t) => t.name === 'Release date')!.domain).toBeUndefined();
    expect(triples(back)).toEqual(triples(sampleModel()));
    expect(back.props.map((p) => p.name).sort()).toEqual(['acts in', 'belongs to', 'directs', 'produces']);
    expect(toTurtle(back)).toBe(ttl);
  });

  const family = () => {
    const m = emptyModel('Family');
    const t: Record<string, string> = {};
    const term = (name: string, type: 'concept' | 'instance' | 'property' = 'concept') => {
      const x = newTerm({ name, type });
      t[name] = x.id;
      m.terms.push(x);
      return x;
    };
    const rel = (from: string, to: string, p: Partial<ReturnType<typeof newRelation>> = {}) => m.relations.push(newRelation({ from: t[from], to: t[to], ...p }));
    ['Agent', 'Person', 'Parent', 'Company'].forEach((n) => term(n));
    ['Ann', 'Bob', 'Cy', 'Acme'].forEach((n) => term(n, 'instance'));
    rel('Parent', 'Person', { kind: 'generalization' });
    rel('Person', 'Agent', { kind: 'generalization' });
    return { m, t, term, rel };
  };

  it('keeps declared object properties apart from plain relationships', () => {
    const { m, t, rel } = family();
    m.props.push({ name: 'works for', description: '', chars: [] }, { name: 'has ancestor', description: '', chars: ['transitive'], domain: [t.Person], range: [t.Person] });
    rel('Person', 'Company', { label: 'works for' });
    rel('Parent', 'Company', { label: 'Works for' });
    rel('Person', 'Company', { label: 'likes' });
    rel('Ann', 'Bob');
    expect(objectProperties(m).map((p) => `${p.name}:${p.rels.length}`)).toEqual(['has ancestor:0', 'works for:2']);
    expect(objectProperties(m)[1]).toMatchObject({ domain: [t.Person, t.Parent], range: [t.Company], domainAuto: true, rangeAuto: true });
    expect(plainRelationships(m).map((p) => `${p.name}:${p.rels.length}`)).toEqual(['likes:1', 'related to:1']);
    expect(runChecks(m).filter((i) => i.rule === 'Undetermined relationship').map((i) => i.message)).toEqual([
      '"likes" is a plain relationship (1 use). Make it an object property to give it a domain, a range and characteristics.',
    ]);
  });

  it('describes a class by its restrictions, on object and on data properties', () => {
    const { m, t, term, rel } = family();
    m.props.push({ name: 'works for', description: '', chars: [] });
    Object.assign(term('Birth date', 'property'), { range: 'xsd:date' });
    Object.assign(term('Has name', 'property'), { range: 'xsd:string' });
    term('Nickname', 'property');
    rel('Person', 'Company', { label: 'works for', restriction: 'max', restrictionN: 3 });
    rel('Person', 'Company', { label: 'likes' });
    rel('Person', 'Birth date', { kind: 'property', restriction: 'exactly', restrictionN: 1 });
    rel('Person', 'Has name', { kind: 'property' });
    rel('Person', 'Nickname', { kind: 'property' });
    expect(restrictionsOf(m, t.Person).map((r) => r.text)).toEqual(['works for max 3 Company', 'Birth date exactly 1 xsd:date', 'Has name some xsd:string', 'Nickname some rdfs:Literal']);
    expect(restrictionsOf(m, t.Ann)).toEqual([]);
    const ttl = toTurtle(m);
    const block = (subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' '))!;
    // "Person has Has name" is a restriction on Person, with the datatype as its filler.
    expect(block(':Person')).toContain('[ a owl:Restriction ; owl:onProperty :hasName ; owl:someValuesFrom xsd:string ]');
    expect(block(':Person')).toContain('[ a owl:Restriction ; owl:onProperty :birthDate ; owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:date ]');
    expect(block(':Person')).toContain('owl:onProperty :nickname ; owl:someValuesFrom rdfs:Literal');
    expect(block(':hasName')).toBe(':hasName a owl:DatatypeProperty ;\n    rdfs:label "Has name" ;\n    rdfs:domain :Person ;\n    rdfs:range xsd:string .');
    const back = fromTurtle(ttl);
    expect(restrictionsOf(back, back.terms.find((x) => x.name === 'Person')!.id).map((r) => r.text).sort()).toEqual(['Birth date exactly 1 xsd:date', 'Has name some xsd:string', 'Nickname some rdfs:Literal', 'works for max 3 Company']);
    expect(toTurtle(back).split('\n\n').sort()).toEqual(ttl.split('\n\n').sort());
  });

  it('keeps a data property with only a domain unattached, since attaching it would restrict the class', () => {
    const m = fromTurtle(`
      @prefix ex: <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      ex:Person a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:age ; owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger ; owl:onDataRange xsd:integer ] .
      ex:age a owl:DatatypeProperty ; rdfs:range xsd:integer .
      ex:nick a owl:DatatypeProperty ; rdfs:domain ex:Person .`);
    expect(triples(m)).toEqual(['Person -[property:]-> age']);
    expect(m.relations[0]).toMatchObject({ restriction: 'max', restrictionN: 1 });
    expect(m.terms.find((t) => t.name === 'nick')!.domain).toEqual([m.terms.find((t) => t.name === 'Person')!.id]);
    expect(runChecks(m).map((i) => i.rule)).not.toContain('Isolated term');
    expect(toTurtle(m)).not.toContain('owl:onProperty <http://ex.org/nick>');
  });

  it('writes a declared object property with its characteristics, inverse and parent', () => {
    const { m, t } = family();
    m.props.push(
      { name: 'has ancestor', description: 'Any forebear.', chars: ['transitive'], domain: [t.Person], range: [t.Person] },
      { name: 'has parent', description: '', chars: ['asymmetric', 'irreflexive'], parents: ['has ancestor'], inverses: ['has child'], domain: [t.Person], range: [t.Parent] },
      { name: 'has child', description: '', chars: [] },
    );
    const ttl = toTurtle(m);
    const block = (subject: string) => ttl.split('\n\n').find((b) => b.startsWith(subject + ' '))!;
    expect(block(':hasAncestor')).toBe(':hasAncestor a owl:ObjectProperty , owl:TransitiveProperty ;\n    rdfs:label "has ancestor" ;\n    skos:definition "Any forebear." ;\n    rdfs:domain :Person ;\n    rdfs:range :Person .');
    expect(block(':hasParent')).toContain('a owl:ObjectProperty , owl:AsymmetricProperty , owl:IrreflexiveProperty');
    expect(block(':hasParent')).toContain('rdfs:subPropertyOf :hasAncestor');
    expect(block(':hasParent')).toContain('owl:inverseOf :hasChild');
    const back = fromTurtle(ttl);
    expect(back.props.find((p) => p.name === 'has parent')).toMatchObject({ chars: ['asymmetric', 'irreflexive'], parents: ['has ancestor'], inverses: ['has child'], range: [expect.any(String)] });
    // A domain and range alone put the property between no particular classes, so nothing is drawn.
    expect(back.relations.filter((r) => r.kind === 'association')).toEqual([]);
    expect(toTurtle(back)).toBe(ttl);
  });

  it('reasons with property characteristics', () => {
    const { m, t, rel } = family();
    m.props.push(
      { name: 'has ancestor', description: '', chars: ['transitive'] },
      { name: 'has parent', description: '', chars: [], parents: ['has ancestor'], inverses: ['has child'], range: [t.Parent] },
      { name: 'married to', description: '', chars: ['symmetric'] },
      { name: 'has employer', description: '', chars: ['functional'] },
    );
    rel('Ann', 'Bob', { label: 'has parent' });
    rel('Bob', 'Cy', { label: 'has parent' });
    rel('Ann', 'Cy', { label: 'married to' });
    rel('Ann', 'Acme', { label: 'admires' });
    const r = reason(structuredClone(m));
    const texts = r.inferences.map((i) => i.text);
    expect(texts).toContain('“Ann” has ancestor “Cy”');
    expect(texts).toContain('“Bob” has child “Ann”');
    expect(texts).toContain('“Cy” married to “Ann”');
    expect(texts).toContain('“Bob” is an instance of “Parent”');
    expect(texts).toContain('“Bob” is an instance of “Agent”');
    expect(texts.some((x) => x.includes('admires'))).toBe(false);
    expect(r.inferences.find((i) => i.text === '“Ann” has ancestor “Cy”')!.because).toContain('“has ancestor” is transitive');
    expect(r.inferences.find((i) => i.text === '“Bob” has child “Ann”')!.add).toMatchObject({ kind: 'association', label: 'has child' });
    expect(r.consistent).toBe(true);

    m.vocab.enabled = true;
    rel('Ann', 'Acme', { label: 'has employer' });
    rel('Ann', 'Cy', { label: 'has employer' });
    expect(reason(structuredClone(m)).inferences.map((i) => i.text)).toContain('“Acme” is the same as “Cy”');
    rel('Acme', 'Cy', { predicate: 'owl:differentFrom' });
    expect(reason(structuredClone(m)).consistent).toBe(false);
  });

  it('finds asymmetric and irreflexive properties used the wrong way', () => {
    const { m, rel } = family();
    m.props.push({ name: 'has parent', description: '', chars: ['asymmetric', 'irreflexive'] });
    rel('Ann', 'Bob', { label: 'has parent' });
    rel('Bob', 'Ann', { label: 'has parent' });
    rel('Cy', 'Cy', { label: 'has parent' });
    const msgs = reason(m).conflicts.map((c) => c.message);
    expect(msgs).toContain('“has parent” is asymmetric, but it holds both ways between “Ann” and “Bob”.');
    expect(msgs).toContain('“has parent” is irreflexive, but “Cy” is related to itself by it.');
  });

  it('judges each use against a domain or range set by hand, accepting kinds of the class', () => {
    const { m, t, rel, term } = family();
    // Domain widened to the general class: Person and Parent are kinds of Agent, so both uses fit.
    m.props.push({ name: 'works for', description: '', chars: [], domain: [t.Agent], range: [t.Company] });
    rel('Person', 'Company', { label: 'works for' });
    rel('Parent', 'Company', { label: 'works for' });
    expect(runChecks(structuredClone(m)).filter((i) => i.rule.startsWith('Outside'))).toEqual([]);
    // Narrowed to Parent: Person is not a kind of Parent.
    m.props[0].domain = [t.Parent];
    expect(runChecks(structuredClone(m)).filter((i) => i.rule.startsWith('Outside')).map((i) => i.message)).toEqual(['"Person" uses "works for", but is not Parent or a kind of it.']);
    rel('Company', 'Person', { label: 'works for' });
    expect(runChecks(structuredClone(m)).filter((i) => i.rule.startsWith('Outside')).map((i) => i.rule)).toEqual(['Outside domain', 'Outside domain', 'Outside range']);
    // Individuals are not held to it: their type is inferred instead.
    rel('Ann', 'Acme', { label: 'works for' });
    expect(runChecks(structuredClone(m)).filter((i) => i.rule.startsWith('Outside'))).toHaveLength(3);

    const age = term('Age', 'property');
    rel('Company', 'Age', { kind: 'property' });
    expect(dataDomainNames(m, age.id)).toEqual(['Company (auto)']);
    age.domain = [t.Agent];
    expect(runChecks(structuredClone(m)).map((i) => i.message)).toContain('"Company" has the data property "Age", but is not Agent or a kind of it.');
    expect(runChecks(structuredClone(m)).map((i) => i.message)).toContain('Data property "Age" has no datatype.');
    expect(toTurtle(structuredClone(m)).split('\n\n').find((b) => b.startsWith(':age '))).toContain('rdfs:domain :Agent');
  });

  it('turns an object property drawn as a term (older models) into a declared property', () => {
    const m = normalizeModel({
      terms: [{ id: 'f', name: 'Film' }, { id: 's', name: 'Studio' }, { id: 'p', name: 'Distributed by', type: 'property', propKind: 'object', description: 'Who releases it.' }],
      relations: [{ from: 'f', to: 'p', kind: 'property' }, { from: 'p', to: 's', kind: 'range' }],
    });
    expect(m.terms.map((t) => t.name)).toEqual(['Film', 'Studio']);
    expect(m.props).toEqual([{ name: 'Distributed by', description: 'Who releases it.', chars: [], domain: ['f'], range: ['s'] }]);
    expect(m.relations).toMatchObject([{ from: 'f', to: 's', kind: 'association', label: 'Distributed by' }]);
  });

  it('accepts datatypes in bulk terms and points object properties elsewhere', () => {
    const r = parseTerms('Name | Type | Range\nBirth date | data property | date\nEmployer | Object property\nAge | attribute | whole number\nBad | property | colour');
    expect(r.items.map((t) => `${t.name}:${t.type ?? ''}:${t.range ?? ''}`)).toEqual(['Birth date:property:xsd:date', 'Employer::', 'Age:property:xsd:integer', 'Bad:property:']);
    expect(r.notes).toHaveLength(2);
  });
});

const dataDomainNames = (m: ReturnType<typeof sampleModel>, id: string) => {
  const d = dataDomain(m, m.terms.find((t) => t.id === id)!);
  return d.ids.map((x) => m.terms.find((t) => t.id === x)!.name + (d.auto ? ' (auto)' : ''));
};

describe('university example', () => {
  const m = universitySample();

  it('is large and uses every kind of thing', () => {
    const count = (type: string) => m.terms.filter((t) => t.type === type).length;
    expect(count('concept')).toBeGreaterThan(80);
    expect(count('property')).toBe(21);
    expect(count('instance')).toBe(25);
    expect(m.props).toHaveLength(26);
    expect(m.relations.length).toBeGreaterThan(190);
    expect(plainRelationships(m).map((p) => p.name)).toEqual(['graduated from', 'hosted by', 'sponsors', 'works at']);
    expect(objectProperties(m).every((p) => p.inverses.every((k) => m.props.some((x) => x.name === k)))).toBe(true);
  });

  it('passes its checks apart from suggestions, and is consistent', () => {
    expect(runChecks(m).filter((i) => i.severity !== 'info').map((i) => `${i.rule}: ${i.message}`)).toEqual([]);
    const r = reason(m);
    expect(r.conflicts).toEqual([]);
    const texts = r.inferences.map((i) => i.text);
    for (const t of [
      '“Data Systems Group” part of “Northfield University”',
      '“Northfield University” has part “Data Systems Group”',
      '“Chloe Tan” supervised by “Ada Moreno”',
      '“Ada Moreno” member of “Department of Computer Science”',
      '“Ada Moreno” participates in “Project Atlas”',
      '“Elena Rossi” collaborates with “Ada Moreno”',
      '“Distributed Systems” has prerequisite “Databases”',
      '“Hall A1” located in “North Campus”',
      '“Gita Novak” is an instance of “Academic staff”',
      '“Chloe Tan” is an instance of “Employee”',
      '“Databases autumn 2026” taught by “Ben Okafor”',
    ]) {
      expect(texts).toContain(t);
    }
    expect(r.inferred).toBeGreaterThan(200);
  });

  it('round-trips through Turtle', () => {
    const ttl = toTurtle(m);
    const back = fromTurtle(ttl);
    expect(back.terms.length).toBe(m.terms.length);
    expect(triples(back)).toEqual(triples(m));
    // "Email" is had by Person and Organisation while its domain is set by hand to Agent; both survive.
    const email = back.terms.find((t) => t.name === 'Email')!;
    expect(email.domain).toEqual([back.terms.find((t) => t.name === 'Agent')!.id]);
    expect(back.props.map((p) => p.name).sort()).toEqual(m.props.map((p) => p.name).sort());
    // The same statements, though terms may come back in another order.
    const blocks = (text: string) => text.trim().split('\n\n').sort();
    expect(blocks(toTurtle(back))).toEqual(blocks(ttl));
    expect(restrictionsOf(m, m.terms.find((t) => t.name === 'Course edition')!.id).map((r) => r.text)).toEqual([
      'edition of exactly 1 Course',
      'takes place in some Room',
      'held during exactly 1 Semester',
      'Capacity exactly 1 xsd:integer',
    ]);
  });
});

describe('a relationship kept plain', () => {
  it('is not a use of the object property that shares its name', () => {
    const m = sampleModel();
    const rel = m.relations.find((r) => r.label === 'belongs to')!;
    expect(relChoice(m, rel)).toBe('object');
    const plain = { ...m, relations: m.relations.map((r) => (r.id === rel.id ? { ...r, plain: true } : r)) };
    expect(relChoice(plain, plain.relations.find((r) => r.id === rel.id)!)).toBe('plain');
    expect(objectProperties(plain).find((p) => p.name === 'belongs to')!.rels).toEqual([]);
    expect(plainRelationships(plain).map((p) => p.name)).toEqual(['belongs to', 'wins']);
    const ttl = toTurtle(plain);
    const film = ttl.split('\n\n').find((b) => b.startsWith(':Film '))!;
    expect(film).not.toContain('owl:onProperty :belongsTo');
    expect(film).toContain(':belongsTo_2 :Genre');
    expect(ttl).toContain(':belongsTo a owl:ObjectProperty');
    expect(ttl).toContain(':belongsTo_2 a rdf:Property');
    const back = fromTurtle(ttl);
    const again = back.relations.find((r) => r.label === 'belongs to')!;
    expect(again.plain).toBe(true);
    expect(relChoice(back, again)).toBe('plain');
  });
});

describe('a large model', () => {
  it('goes through every analysis and a Turtle round trip at 960 terms', () => {
    const m = stressModel(650);
    expect(m.terms.length).toBe(960);
    expect(m.relations.length).toBeGreaterThan(2500);
    const t0 = performance.now();
    const r = reason(m, true);
    expect(r.truncated).toBe(false);
    expect(r.conflicts).toEqual([]);
    expect(r.inferred).toBeGreaterThan(5000);
    expect(runChecks(m).filter((i) => i.severity === 'error')).toEqual([]);
    expect(objectProperties(m)).toHaveLength(72);
    const back = fromTurtle(toTurtle(m));
    expect(back.terms.length).toBe(960);
    expect(back.props.length).toBe(72);
    // Generous: all of this takes well under a second on an ordinary machine.
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('IRIs', () => {
  it('gives each named entity an IRI in the base namespace, once', () => {
    const m = emptyModel('Film ontology');
    m.baseIri = 'http://example.org/ontology#';
    m.terms.push(newTerm({ name: 'Person' }), newTerm({ name: 'Release date', type: 'property' }), newTerm({ name: '' }), newTerm({ name: 'New class' }), newTerm({ name: 'Person' }));
    m.props.push({ name: 'acts in', description: '', chars: [] });
    const a = withIris(m);
    expect(a.terms.map((t) => t.iri)).toEqual(['http://example.org/ontology#Person', 'http://example.org/ontology#releaseDate', undefined, undefined, 'http://example.org/ontology#Person_2']);
    expect(a.props[0].iri).toBe('http://example.org/ontology#actsIn');
    // Nothing more to do the second time, so the very same model comes back.
    expect(withIris(a)).toBe(a);
  });

  it('keeps an IRI when the entity is renamed or the base namespace changes', () => {
    let m = withIris({ ...emptyModel('X'), baseIri: 'http://example.org/ontology#', terms: [newTerm({ name: 'Actor' })], props: [{ name: 'acts in', description: '', chars: [] }] });
    m = withIris({ ...m, baseIri: 'http://other.org/v2#', terms: [{ ...m.terms[0], name: 'Performer' }, newTerm({ name: 'Stage' })], props: [{ ...m.props[0], name: 'performs in' }] });
    expect(m.terms.map((t) => `${t.name} ${t.iri}`)).toEqual(['Performer http://example.org/ontology#Actor', 'Stage http://other.org/v2#Stage']);
    expect(m.props[0]).toMatchObject({ name: 'performs in', iri: 'http://example.org/ontology#actsIn' });
    const ttl = toTurtle(m);
    // The label follows the rename; the identifier does not.
    expect(ttl).toContain('<http://example.org/ontology#Actor> a owl:Class ;\n    rdfs:label "Performer" .');
    expect(ttl).toContain('<http://example.org/ontology#actsIn> a owl:ObjectProperty ;\n    rdfs:label "performs in" .');
    expect(ttl).toContain(':Stage a owl:Class');
  });

  it('preserves the IRIs of an imported ontology, whatever their namespace or label', () => {
    const src = `
      @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      <http://a.org/onto#C_0001> a owl:Class ; rdfs:label "Actor" .
      <http://b.org/other/Actor> a owl:Class ; rdfs:label "Actor" ; rdfs:subClassOf <http://a.org/onto#C_0001> .
      <http://a.org/onto#P_7> a owl:ObjectProperty ; rdfs:label "acts in" ; rdfs:domain <http://a.org/onto#C_0001> .`;
    const m = withIris(fromTurtle(src));
    // Two entities with the same label stay two entities.
    expect(m.terms.map((t) => `${t.name} ${t.iri}`).sort()).toEqual(['Actor http://a.org/onto#C_0001', 'Actor http://b.org/other/Actor']);
    expect(m.props[0]).toMatchObject({ name: 'acts in', iri: 'http://a.org/onto#P_7' });
    const ttl = toTurtle(m);
    expect(ttl).toContain(':C_0001 a owl:Class');
    expect(ttl).toContain('<http://b.org/other/Actor> a owl:Class ;\n    rdfs:label "Actor" ;\n    rdfs:subClassOf :C_0001 .');
    expect(ttl).toContain(':P_7 a owl:ObjectProperty');
    expect(runChecks(m).find((i) => i.rule === 'Duplicate name')).toMatchObject({ severity: 'warning' });
    const again = fromTurtle(ttl);
    expect(again.terms.map((t) => t.iri).sort()).toEqual(m.terms.map((t) => t.iri).sort());
    expect(again.props[0].iri).toBe('http://a.org/onto#P_7');
  });
});

describe('asserted superclasses', () => {
  const build = () => {
    const m = emptyModel('Cast');
    const t: Record<string, string> = {};
    for (const name of ['Person', 'Actor', 'Director', 'Actress', 'Film', 'Documentary']) {
      const x = newTerm({ name });
      t[name] = x.id;
      m.terms.push(x);
    }
    const isA = (a: string, b: string) => m.relations.push(newRelation({ from: t[a], to: t[b], kind: 'generalization' }));
    isA('Actor', 'Person');
    isA('Director', 'Person');
    isA('Actress', 'Actor');
    isA('Documentary', 'Film');
    return { m, t, isA };
  };
  const names = (m: ReturnType<typeof build>['m'], id: string) => assertedSuperclasses(m, id).map((x) => m.terms.find((t) => t.id === x)!.name);

  it('lists what is stated and nothing that only follows from it', () => {
    const { m, t } = build();
    expect(names(m, t.Person)).toEqual([]);
    expect(names(m, t.Actor)).toEqual(['Person']);
    // Actress is an Actor, and an Actor is a Person: Person follows, but was not stated.
    expect(names(m, t.Actress)).toEqual(['Actor']);
  });

  it('lists every stated superclass, even a redundant one, each once', () => {
    const { m, t, isA } = build();
    isA('Actress', 'Person');
    expect(names(structuredClone(m), t.Actress)).toEqual(['Actor', 'Person']);
    // Stated twice: still shown once.
    isA('Actress', 'Person');
    expect(names(structuredClone(m), t.Actress)).toEqual(['Actor', 'Person']);
    const ttl = toTurtle(structuredClone(m));
    expect(ttl).toContain(':Actress a owl:Class ;\n    rdfs:label "Actress" ;\n    rdfs:subClassOf :Actor , :Person , :Person .');
    const back = fromTurtle(ttl);
    expect(names(back, back.terms.find((x) => x.name === 'Actress')!.id)).toEqual(['Actor', 'Person']);
  });

  it('counts a relation given the meaning rdfs:subClassOf, and recognises cycles before they are made', () => {
    const { m, t } = build();
    m.vocab.enabled = true;
    m.relations.push(newRelation({ from: t.Director, to: t.Film, predicate: 'rdfs:subClassOf' }), newRelation({ from: t.Director, to: t.Film, label: 'makes' }));
    expect(names(m, t.Director)).toEqual(['Person', 'Film']);
    expect(wouldCycle(m, t.Person, t.Actress)).toBe(true);
    expect(wouldCycle(m, t.Actress, t.Director)).toBe(false);
    expect(wouldCycle(m, t.Film, t.Film)).toBe(true);
  });

  it('keeps anonymous superclass expressions it cannot draw, word for word', () => {
    const src = `
      @prefix : <http://example.org/o#> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      :Person a owl:Class . :Film a owl:Class . :Award a owl:Class .
      :actsIn a owl:ObjectProperty . :wins a owl:ObjectProperty . :age a owl:DatatypeProperty .
      :Actor a owl:Class ;
        rdfs:subClassOf :Person ,
          [ a owl:Restriction ; owl:onProperty :actsIn ; owl:someValuesFrom :Film ] ,
          [ a owl:Restriction ; owl:onProperty :wins ; owl:someValuesFrom [ a owl:Class ; owl:unionOf ( :Award :Film ) ] ] ,
          [ a owl:Restriction ; owl:onProperty :age ; owl:minCardinality "1"^^xsd:nonNegativeInteger ] ,
          [ a owl:Class ; owl:intersectionOf ( :Person [ a owl:Class ; owl:complementOf :Film ] ) ] ;
        owl:equivalentClass [ a owl:Restriction ; owl:onProperty :actsIn ; owl:hasValue :Film ] .`;
    const m = fromTurtle(src);
    const actor = m.terms.find((t) => t.name === 'Actor')!;
    // The named superclass and the one restriction the app can draw are a relation each…
    expect(assertedSuperclasses(m, actor.id).map((x) => m.terms.find((t) => t.id === x)!.name)).toEqual(['Person']);
    expect(restrictionsOf(m, actor.id).map((r) => r.text)).toEqual(['acts in some Film']);
    // …and the other four expressions are kept as they are, not dropped and not flattened.
    expect(actor.axioms).toEqual([
      'rdfs:subClassOf [ a owl:Restriction ; owl:onProperty <http://example.org/o#wins> ; owl:someValuesFrom [ a owl:Class ; owl:unionOf ( <http://example.org/o#Award> <http://example.org/o#Film> ) ] ]',
      'rdfs:subClassOf [ a owl:Restriction ; owl:onProperty <http://example.org/o#age> ; owl:minCardinality "1"^^xsd:nonNegativeInteger ]',
      'rdfs:subClassOf [ a owl:Class ; owl:intersectionOf ( <http://example.org/o#Person> [ a owl:Class ; owl:complementOf <http://example.org/o#Film> ] ) ]',
      'owl:equivalentClass [ a owl:Restriction ; owl:onProperty <http://example.org/o#actsIn> ; owl:hasValue <http://example.org/o#Film> ]',
    ]);
    const ttl = toTurtle(m);
    expect(ttl).toContain('owl:unionOf ( <http://example.org/o#Award> <http://example.org/o#Film> )');
    expect(ttl).toContain('owl:hasValue <http://example.org/o#Film>');
    // A second round trip changes nothing, and they survive a JSON save.
    const again = fromTurtle(ttl);
    expect(again.terms.find((t) => t.name === 'Actor')!.axioms).toEqual(actor.axioms);
    expect(normalizeModel(JSON.parse(JSON.stringify(m))).terms.find((t) => t.name === 'Actor')!.axioms).toEqual(actor.axioms);
    expect(triples(again)).toEqual(triples(m));
  });
});

describe('ontology IRI and prefixes', () => {
  const build = () => {
    const m = withIris({
      ...emptyModel('Cast'),
      baseIri: 'http://example.org/ontology#',
      prefixes: [{ prefix: 'ex', iri: 'http://example.org/ontology#' }, { prefix: 'schema', iri: 'https://schema.org/' }],
      terms: [newTerm({ name: 'Actor' }), newTerm({ name: 'Person', iri: 'https://schema.org/Person' }), newTerm({ name: 'Odd', iri: 'http://elsewhere.org/x/Odd' })],
    });
    m.relations.push(newRelation({ from: m.terms[0].id, to: m.terms[1].id, kind: 'generalization' }));
    return m;
  };

  it('makes new IRIs in the default namespace and abbreviates with the prefixes', () => {
    const m = build();
    expect(m.terms[0].iri).toBe('http://example.org/ontology#Actor');
    // A named prefix for the default namespace is preferred to the bare colon.
    expect(compactIri(m, m.terms[0].iri!)).toBe('ex:Actor');
    expect(compactIri({ ...m, prefixes: [] }, m.terms[0].iri!)).toBe(':Actor');
    expect(compactIri(m, 'https://schema.org/Person')).toBe('schema:Person');
    expect(compactIri(m, 'http://www.w3.org/2002/07/owl#Class')).toBe('owl:Class');
    // No prefix covers it, or what follows the namespace is not a plain name.
    expect(compactIri(m, 'http://elsewhere.org/x/Thing')).toBeUndefined();
    expect(compactIri(m, 'https://schema.org/a/b')).toBeUndefined();
    expect(expandIri(m, 'schema:Person')).toBe('https://schema.org/Person');
    expect(searchTerms(m, 'schema:per').map((t) => t.name)).toEqual(['Person']);
  });

  it('changing prefixes or the default namespace leaves every IRI as it was', () => {
    const m = build();
    const iris = m.terms.map((t) => t.iri);
    const changed = withIris({ ...m, baseIri: 'http://new.org/v2#', ontologyIri: 'http://new.org/v2', prefixes: [{ prefix: 'old', iri: 'http://example.org/ontology#' }], terms: [...m.terms, newTerm({ name: 'Stage' })] });
    expect(changed.terms.slice(0, 3).map((t) => t.iri)).toEqual(iris);
    expect(changed.terms[3].iri).toBe('http://new.org/v2#Stage');
    const ttl = toTurtle(changed);
    expect(ttl).toContain('@prefix : <http://new.org/v2#> .\n@prefix old: <http://example.org/ontology#> .');
    expect(ttl).toContain('<http://new.org/v2> a owl:Ontology');
    expect(ttl).toContain('old:Actor a owl:Class ;\n    rdfs:label "Actor" ;\n    rdfs:subClassOf <https://schema.org/Person> .');
    expect(ttl).toContain(':Stage a owl:Class');
    // Read back, the same IRIs whatever they were written with.
    expect(fromTurtle(ttl).terms.map((t) => t.iri).sort()).toEqual([...iris, 'http://new.org/v2#Stage'].sort());
  });

  it('writes the prefixes out and reads them back, with the ontology IRI and default namespace', () => {
    const m = { ...build(), ontologyIri: 'http://example.org/ontology/1.0' };
    const ttl = toTurtle(m);
    expect(ttl.split('\n').filter((l) => l.startsWith('@prefix'))).toEqual([
      '@prefix : <http://example.org/ontology#> .',
      '@prefix ex: <http://example.org/ontology#> .',
      '@prefix schema: <https://schema.org/> .',
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    ]);
    expect(ttl).toContain('ex:Actor a owl:Class ;\n    rdfs:label "Actor" ;\n    rdfs:subClassOf schema:Person .');
    // An IRI no prefix covers is written in full.
    expect(ttl).toContain('<http://elsewhere.org/x/Odd> a owl:Class');
    const back = fromTurtle(toTurtle({ ...m, terms: m.terms.slice(0, 2) }));
    expect(back).toMatchObject({ baseIri: 'http://example.org/ontology#', ontologyIri: 'http://example.org/ontology/1.0', prefixes: m.prefixes });
    expect(JSON.parse(toJsonLd(m))['@context']).toMatchObject({ ex: 'http://example.org/ontology#', schema: 'https://schema.org/', owl: 'http://www.w3.org/2002/07/owl#' });
    expect(normalizeModel(JSON.parse(JSON.stringify(m)))).toMatchObject({ ontologyIri: m.ontologyIri, prefixes: m.prefixes });
    // A file written by another tool: its prefixes are kept as declared.
    const other = fromTurtle('@prefix foaf: <http://xmlns.com/foaf/0.1/> . @prefix : <http://my.org/ns#> . @prefix owl: <http://www.w3.org/2002/07/owl#> .\n<http://my.org/onto> a owl:Ontology . :A a owl:Class ; <http://www.w3.org/2000/01/rdf-schema#subClassOf> foaf:Agent . foaf:Agent a owl:Class .');
    expect(other).toMatchObject({ baseIri: 'http://my.org/ns#', ontologyIri: 'http://my.org/onto', prefixes: [{ prefix: 'foaf', iri: 'http://xmlns.com/foaf/0.1/' }] });
    expect(toTurtle(other)).toContain(':A a owl:Class ;\n    rdfs:label "A" ;\n    rdfs:subClassOf foaf:Agent .');
  });

  it('validates settings: bad IRIs, bad or reserved prefix names, and clashes', () => {
    const v = (prefixes: { prefix: string; iri: string }[], baseIri = 'http://example.org/o#', ontologyIri = '') => validateSettings({ ontologyIri, baseIri, prefixes });
    expect(v([{ prefix: 'ex', iri: 'http://example.org/o#' }, { prefix: 'schema', iri: 'https://schema.org/' }])).toMatchObject({ ok: true, rows: [undefined, undefined] });
    expect(v([], 'not an iri').baseIri).toMatch(/Not an IRI/);
    expect(v([], 'http://example.org/o').baseIri).toContain('ends with # or /');
    expect(v([], 'http://example.org/o#', 'ontology').ontologyIri).toMatch(/Not an IRI/);
    const rows = v([
      { prefix: '1x', iri: 'http://x.org/#' },
      { prefix: 'owl', iri: 'http://y.org/#' },
      { prefix: 'ex', iri: 'http://a.org/#' },
      { prefix: 'EX', iri: 'http://b.org/#' },
      { prefix: 'b', iri: 'b.org' },
      { prefix: 'c', iri: 'http://a.org/#' },
      { prefix: 'd', iri: 'http://www.w3.org/2002/07/owl#' },
      { prefix: 'e', iri: 'http://e.org/ns' },
    ]).rows;
    expect(rows.map((r) => r?.split(/[.:]/)[0])).toEqual([
      'A prefix is letters, digits, _ or -, starting with a letter',
      '“owl” is a standard prefix and always means http',
      undefined,
      '“EX” is defined twice',
      'The namespace is not an IRI',
      'Another prefix already stands for this namespace',
      'That namespace already has the standard prefix “owl”',
      'A namespace ends with # or /',
    ]);
  });
});

describe('moving entities to a new namespace', () => {
  it('re-homes the entities of one namespace and nothing else', () => {
    const m = withIris({
      ...emptyModel('Cast'),
      baseIri: 'http://old.org/ns#',
      terms: [newTerm({ name: 'Actor' }), newTerm({ name: 'Person', iri: 'https://schema.org/Person' }), newTerm({ name: 'Film', axioms: ['rdfs:subClassOf [ owl:unionOf ( <http://old.org/ns#Actor> <https://schema.org/Person> ) ]'] })],
      props: [{ name: 'acts in', description: '', chars: [] }],
    });
    const moved = moveNamespace({ ...m, baseIri: 'http://new.org/v2#' }, 'http://old.org/ns#', 'http://new.org/v2#');
    expect(moved.terms.map((t) => t.iri)).toEqual(['http://new.org/v2#Actor', 'https://schema.org/Person', 'http://new.org/v2#Film']);
    expect(moved.props[0].iri).toBe('http://new.org/v2#actsIn');
    // Kept class expressions mention IRIs in full, so they follow too.
    expect(moved.terms[2].axioms).toEqual(['rdfs:subClassOf [ owl:unionOf ( <http://new.org/v2#Actor> <https://schema.org/Person> ) ]']);
    expect(toTurtle(moved)).toContain(':Actor a owl:Class');
    expect(toTurtle(moved)).not.toContain('old.org');
    // Nothing to do when the namespace is the same; and a name already taken in the target is not overwritten.
    expect(moveNamespace(m, 'http://old.org/ns#', 'http://old.org/ns#')).toBe(m);
    const clash = moveNamespace({ ...m, terms: [...m.terms, newTerm({ name: 'Actor', iri: 'http://new.org/v2#Actor' })] }, 'http://old.org/ns#', 'http://new.org/v2#');
    expect(clash.terms.map((t) => t.iri)).toEqual(['http://new.org/v2#Actor_2', 'https://schema.org/Person', 'http://new.org/v2#Film', 'http://new.org/v2#Actor']);
  });
});
