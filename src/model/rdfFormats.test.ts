import { describe, expect, it } from 'vitest';
import { readExternal } from './external';
import { readModelFile } from './files';
import { loadOxigraph } from './oxigraph';
import { relChoice, restrictionsOf } from './props';
import { fromTurtle, leftOut, toJsonLd, toTurtle } from './rdf';
import { ACCEPT, asTurtle, convertWithService, decodeDocument, detectFormat, fetchDocument, fileText } from './rdfFormats';
import { sampleModel, skosSample } from './sample';
import { universitySample } from './sampleUniversity';
import { withIris } from './iri';
import type { Model } from './types';

/** An ontology the way Protégé writes RDF/XML: entities for the namespaces, a base, rdf:about and rdf:ID, nested restrictions, a list. */
const PIZZA = `<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [
    <!ENTITY owl "http://www.w3.org/2002/07/owl#" >
    <!ENTITY xsd "http://www.w3.org/2001/XMLSchema#" >
    <!ENTITY pizza "http://example.org/pizza#" >
]>
<!-- A small pizza ontology -->
<rdf:RDF xmlns="http://example.org/pizza#"
     xml:base="http://example.org/pizza"
     xmlns:owl="&owl;"
     xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
     xmlns:skos="http://www.w3.org/2004/02/skos/core#"
     xmlns:food="http://example.org/food#">
    <owl:Ontology rdf:about="http://example.org/pizza">
        <rdfs:label xml:lang="en">Pizza ontology</rdfs:label>
        <rdfs:comment>What goes on a pizza.</rdfs:comment>
        <owl:imports rdf:resource="http://example.org/food"/>
    </owl:Ontology>
    <owl:ObjectProperty rdf:about="&pizza;hasTopping">
        <rdfs:label xml:lang="en">has topping</rdfs:label>
        <rdfs:domain rdf:resource="#Pizza"/>
        <rdfs:range rdf:resource="#Topping"/>
        <rdf:type rdf:resource="&owl;TransitiveProperty"/>
    </owl:ObjectProperty>
    <owl:DatatypeProperty rdf:about="#price">
        <rdfs:label xml:lang="en">price</rdfs:label>
        <rdfs:range rdf:resource="&xsd;decimal"/>
        <rdf:type rdf:resource="&owl;FunctionalProperty"/>
    </owl:DatatypeProperty>
    <owl:Class rdf:about="#Pizza">
        <rdfs:label xml:lang="en">Pizza</rdfs:label>
        <rdfs:label xml:lang="it">Pizza italiana</rdfs:label>
        <skos:altLabel xml:lang="en">Pie</skos:altLabel>
        <skos:definition xml:lang="en">A baked flat bread with toppings &amp; cheese.</skos:definition>
    </owl:Class>
    <owl:Class rdf:about="#Topping"><rdfs:label xml:lang="en">Topping</rdfs:label></owl:Class>
    <owl:Class rdf:about="#Tomato"><rdfs:label xml:lang="en">Tomato</rdfs:label><rdfs:subClassOf rdf:resource="#Topping"/></owl:Class>
    <owl:Class rdf:ID="Margherita">
        <rdfs:label xml:lang="en">Margherita</rdfs:label>
        <rdfs:subClassOf rdf:resource="#Pizza"/>
        <rdfs:subClassOf>
            <owl:Restriction>
                <owl:onProperty rdf:resource="#hasTopping"/>
                <owl:someValuesFrom rdf:resource="#Tomato"/>
            </owl:Restriction>
        </rdfs:subClassOf>
        <owl:disjointWith rdf:resource="#Topping"/>
    </owl:Class>
    <owl:Class rdf:about="#Vegetarian">
        <rdfs:label xml:lang="en">Vegetarian pizza</rdfs:label>
        <owl:equivalentClass>
            <owl:Class>
                <owl:intersectionOf rdf:parseType="Collection">
                    <rdf:Description rdf:about="#Pizza"/>
                    <owl:Restriction>
                        <owl:onProperty rdf:resource="#hasTopping"/>
                        <owl:allValuesFrom rdf:resource="#Tomato"/>
                    </owl:Restriction>
                </owl:intersectionOf>
            </owl:Class>
        </owl:equivalentClass>
    </owl:Class>
    <owl:NamedIndividual rdf:about="#MyLunch">
        <rdf:type rdf:resource="#Margherita"/>
        <rdfs:label xml:lang="en">My lunch</rdfs:label>
        <price rdf:datatype="&xsd;decimal">9.50</price>
    </owl:NamedIndividual>
</rdf:RDF>`;

const term = (m: Model, name: string) => m.terms.find((t) => t.name === name)!;
/** What a model says, apart from the order it says it in and from where its terms sit. */
function shape(m: Model) {
  const name = new Map(m.terms.map((t) => [t.id, t.iri ?? t.name]));
  const named = (ids: string[] = []) => ids.map((id) => name.get(id) ?? id).sort();
  return {
    mode: m.mode,
    ontologyIri: m.ontologyIri,
    terms: m.terms
      .map((t) => ({ iri: t.iri, name: t.name, type: t.type, description: t.description, synonyms: t.synonyms.split(',').map((x) => x.trim()).sort(), range: t.range, functional: !!t.functional, domain: named(t.domain), fields: [...t.fields].map((f) => JSON.stringify(f)).sort(), axioms: (t.axioms ?? []).length, values: (t.values ?? []).map((v) => `${name.get(v.prop)}=${v.value}`).sort(), oneOf: t.oneOf ? named(t.oneOf) : null }))
      .sort((a, b) => (a.iri ?? '').localeCompare(b.iri ?? '')),
    relations: m.relations.map((r) => [name.get(r.from), r.kind, r.label, r.predicate ?? '', r.restriction ?? '', r.restrictionN ?? '', JSON.stringify(r.more ?? []), name.get(r.to)].join(' | ')).sort(),
    props: m.props.map((p) => ({ name: p.name, iri: p.iri, chars: [...p.chars].sort(), domain: named(p.domain), range: named(p.range), parents: [...(p.parents ?? [])].sort(), inverses: [...(p.inverses ?? [])].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    externals: m.externals.map((e) => e.iri).sort(),
  };
}
const names = (m: Model) => m.terms.map((t) => t.name).sort();

describe('telling the syntaxes apart', () => {
  it('goes by how a document starts', () => {
    expect(detectFormat(PIZZA)).toBe('rdfxml');
    expect(detectFormat('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>')).toBe('rdfxml');
    expect(detectFormat('﻿  <?xml version="1.0"?>\n<rdf:RDF/>')).toBe('rdfxml');
    expect(detectFormat('<?xml version="1.0"?>\n<Ontology xmlns="http://www.w3.org/2002/07/owl#" ontologyIRI="http://example.org/o">\n<Declaration><Class IRI="#A"/></Declaration></Ontology>')).toBe('owlxml');
    // An Ontology element of OWL's namespace is RDF/XML too, when it is a node of a graph and no OWL/XML document.
    expect(detectFormat('<Ontology xmlns="http://www.w3.org/2002/07/owl#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" rdf:about="http://example.org/o"/>')).toBe('rdfxml');
    expect(detectFormat('Prefix(:=<http://example.org/o#>)\nOntology(<http://example.org/o>)')).toBe('functional');
    expect(detectFormat('# a comment first\nOntology(<http://example.org/o>)')).toBe('functional');
    expect(detectFormat('Prefix: : <http://example.org/o#>\nOntology: <http://example.org/o>')).toBe('manchester');
    expect(detectFormat('format-version: 1.2\nontology: go')).toBe('obo');
    expect(detectFormat('{ "@context": { "ex": "http://example.org/" }, "@id": "ex:a" }')).toBe('jsonld');
    expect(detectFormat('[{ "@id": "http://example.org/a", "@type": ["http://www.w3.org/2002/07/owl#Class"] }]')).toBe('jsonld');
    expect(detectFormat(JSON.stringify(sampleModel()))).toBe('model');
    expect(detectFormat('@prefix : <http://example.org/o#> .\n:A a :B .')).toBe('turtle');
    expect(detectFormat('<http://example.org/a> <http://example.org/p> <http://example.org/b> .')).toBe('turtle');
    // A Turtle file that begins with an IRI in angle brackets is no XML, though it begins like a tag.
    expect(detectFormat('<urn:a> a <urn:B> .')).toBe('turtle');
    expect(detectFormat('<Pizza> a <Food> .')).toBe('turtle');
    expect(detectFormat('')).toBe('turtle');
  });

  it('lets the name and what a server said settle only what the content leaves open', () => {
    expect(detectFormat('Ontology(<http://example.org/o>)', 'pizza.owl', 'application/rdf+xml')).toBe('functional');
    expect(detectFormat(PIZZA, 'pizza.ttl')).toBe('turtle');
    expect(detectFormat(PIZZA, 'pizza.owl', 'text/plain')).toBe('rdfxml');
    expect(detectFormat('{}', 'context.jsonld')).toBe('jsonld');
    expect(detectFormat('whatever this is', 'o.ofn')).toBe('functional');
    expect(detectFormat('whatever this is', 'o.omn')).toBe('manchester');
    expect(detectFormat('whatever this is', '', 'application/owl+xml; charset=utf-8')).toBe('owlxml');
    expect(detectFormat(':A a :B .', 'https://example.org/o', 'text/turtle;charset=utf-8')).toBe('turtle');
    // A document never closed has no root to go by: it is still XML, and its reader says what is wrong.
    expect(detectFormat('<?xml version="1.0"?><!-- never closed')).toBe('rdfxml');
  });
});

describe('an ontology in RDF/XML', () => {
  it('is read as the same ontology would be from Turtle', async () => {
    const { model: m, format } = await readModelFile(PIZZA, 'pizza.owl');
    expect(format).toBe('rdfxml');
    expect(m).toMatchObject({ name: 'Pizza ontology', description: 'What goes on a pizza.', mode: 'ontology', lang: 'en', ontologyIri: 'http://example.org/pizza', baseIri: 'http://example.org/pizza#' });
    expect(names(m)).toEqual(['Margherita', 'My lunch', 'Pizza', 'Tomato', 'Topping', 'Vegetarian pizza', 'price']);
    // Entities, a base and rdf:ID all come to the same IRIs.
    expect(term(m, 'Margherita').iri).toBe('http://example.org/pizza#Margherita');
    expect(term(m, 'Pizza')).toMatchObject({ type: 'concept', synonyms: 'Pie', description: 'A baked flat bread with toppings & cheese.' });
    // A label in another language is kept as an annotation.
    expect(term(m, 'Pizza').fields).toEqual([{ key: 'rdfs:label', value: 'Pizza italiana', lang: 'it' }]);
    expect(term(m, 'price')).toMatchObject({ type: 'property', range: 'xsd:decimal', functional: true });
    expect(term(m, 'My lunch')).toMatchObject({ type: 'instance', values: [{ prop: term(m, 'price').id, value: '9.50' }] });
    expect(m.props).toMatchObject([{ name: 'has topping', chars: ['transitive'], iri: 'http://example.org/pizza#hasTopping' }]);
    // The hierarchy, a restriction in a nested element, a membership.
    const kinds = m.relations.map((r) => `${m.terms.find((t) => t.id === r.from)!.name} ${relChoice(m, r)} ${m.terms.find((t) => t.id === r.to)!.name}`).sort();
    expect(kinds).toContain('Margherita generalization Pizza');
    expect(kinds).toContain('Tomato generalization Topping');
    expect(kinds).toContain('My lunch instanceOf Margherita');
    expect(restrictionsOf(m, term(m, 'Margherita').id).map((r) => `${r.property} ${r.quantifier} ${r.filler}`)).toEqual(['has topping some Tomato']);
    // A class expression there is no drawing for is kept as it was stated, read from the list in the file.
    expect(term(m, 'Vegetarian pizza').axioms).toEqual(['owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( <http://example.org/pizza#Pizza> [ a owl:Restriction ; owl:onProperty <http://example.org/pizza#hasTopping> ; owl:allValuesFrom <http://example.org/pizza#Tomato> ] ) ]']);
    // What it imports is recorded by its IRI, and its own prefixes are kept.
    expect(m.externals.map((e) => e.iri)).toEqual(['http://example.org/food']);
    expect(m.prefixes).toEqual([{ prefix: 'food', iri: 'http://example.org/food#' }]);
  });

  it('gives what the Turtle of the same ontology gives, for each of the examples', async () => {
    const ox = await loadOxigraph();
    for (const sample of [sampleModel(), universitySample(), skosSample()]) {
      const turtle = toTurtle(withIris(sample));
      const store = new ox.Store();
      store.load(turtle, { format: 'text/turtle' });
      const xml = store.dump({ format: 'application/rdf+xml', from_graph_name: ox.defaultGraph() });
      expect(detectFormat(xml)).toBe('rdfxml');
      const fromXml = (await readModelFile(xml, 'sample.owl')).model;
      const fromTtl = fromTurtle(turtle, 'sample');
      // The same ontology, whichever way it was written down and in whatever order its statements came.
      expect(shape(fromXml)).toEqual(shape(fromTtl));
    }
  });

  it('does not take a standard vocabulary for the ontology\'s namespace when that is the default namespace of the file', async () => {
    const xml = `<rdf:RDF xmlns="http://www.w3.org/2002/07/owl#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
      <Ontology rdf:about="http://example.org/zoo"/>
      <Class rdf:about="http://example.org/zoo#Animal"/>
      <Class rdf:about="http://example.org/zoo#Lion"><rdfs:subClassOf rdf:resource="http://example.org/zoo#Animal"/></Class>
    </rdf:RDF>`;
    const { model } = await readModelFile(xml, 'zoo.rdf');
    expect(model.baseIri).toBe('http://example.org/zoo#');
    expect(names(model)).toEqual(['Animal', 'Lion']);
  });

  it('resolves relative IRIs against the address it was fetched from, or a name of its own, where it states no base', async () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="#Thing1"/><owl:Class rdf:ID="Thing2"/></rdf:RDF>`;
    expect((await readModelFile(xml, 'My things.owl')).model.terms.map((t) => t.iri)).toEqual(['http://example.org/My-things#Thing1', 'http://example.org/My-things#Thing2']);
    expect((await readModelFile(xml, 'https://data.example/onto/things.owl', { url: 'https://data.example/onto/things.owl' })).model.terms.map((t) => t.iri)).toEqual(['https://data.example/onto/things.owl#Thing1', 'https://data.example/onto/things.owl#Thing2']);
  });

  it('says what is wrong with a file that is not well-formed, or holds no ontology', async () => {
    await expect(readModelFile('<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><owl:Class', 'broken.owl')).rejects.toThrow(/^It is not well-formed RDF\/XML: /);
    await expect(readModelFile('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>', 'empty.owl')).rejects.toThrow('No classes, concepts, properties or individuals were found in it (it was read as RDF/XML).');
    await expect(readModelFile(':A a owl:Class', 'broken.ttl')).rejects.toThrow(/^It is not well-formed Turtle: /);
  });

  it('does not open a file that was cut short as a smaller ontology', async () => {
    // Cut where one class ends and the next has not begun: what is there parses, and the rest is simply missing.
    const cut = PIZZA.slice(0, PIZZA.indexOf('<owl:Class rdf:about="#Topping">'));
    await expect(readModelFile(cut, 'pizza.owl')).rejects.toThrow('It is not well-formed RDF/XML: the file ends before its root element <rdf:RDF> is closed, so the end of it is missing.');
    // What follows the root does not matter, nor does a root with nothing in it.
    expect((await readModelFile(PIZZA + '\n<!-- saved by an editor -->\n', 'pizza.owl')).model.terms).toHaveLength(7);
    await expect(readModelFile('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>', 'empty.owl')).rejects.toThrow(/No classes, concepts, properties or individuals were found/);
    await expect(readModelFile('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="http://example.org/A"/>', 'cut.owl')).rejects.toThrow(/ends before its root element <rdf:RDF> is closed/);
  });
});

describe('a file in another encoding than UTF-8', () => {
  const doc = (encoding: string) =>
    `<?xml version="1.0" encoding="${encoding}"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#">\n<owl:Class rdf:about="http://example.org/cafe#Cafe"><rdfs:label>Café Zürich</rdfs:label></owl:Class>\n</rdf:RDF>`;
  const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
  const utf16 = (text: string) => {
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) bytes.set([text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8], 2 + i * 2);
    return bytes;
  };

  it('is read in the encoding it declares, so that its labels come out as written', async () => {
    for (const [bytes, encoding] of [
      [latin1(doc('ISO-8859-1')), 'ISO-8859-1'],
      [utf16(doc('UTF-16')), 'UTF-16'],
      [new TextEncoder().encode(doc('UTF-8')), 'UTF-8'],
      [new TextEncoder().encode('\uFEFF' + doc('utf-8')), 'UTF-8 with a mark'],
    ] as const) {
      const { model } = await readModelFile(await fileText(new Blob([bytes])), 'cafe.owl');
      expect(model.terms.map((t) => t.name), encoding).toEqual(['Café Zürich']);
    }
    // What a server says about the encoding is taken where the document itself says nothing.
    expect(decodeDocument(latin1(':A <http://example.org/label> "Zürich" .'), 'iso-8859-1')).toContain('Zürich');
    expect(decodeDocument(new TextEncoder().encode('"Zürich"'), 'no-such-encoding')).toBe('"Zürich"');
  });
});

describe('an ontology in JSON-LD', () => {
  it('is read, with the prefixes of its context', async () => {
    const doc = {
      '@context': { '@vocab': 'http://example.org/zoo#', owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', zoo: 'http://example.org/zoo-terms/' },
      '@graph': [
        { '@id': 'http://example.org/zoo', '@type': 'owl:Ontology', 'rdfs:label': 'Zoo' },
        { '@id': 'http://example.org/zoo#Animal', '@type': 'owl:Class', 'rdfs:label': { '@value': 'Animal', '@language': 'en' } },
        { '@id': 'http://example.org/zoo#Lion', '@type': 'owl:Class', 'rdfs:label': { '@value': 'Lion', '@language': 'en' }, 'rdfs:subClassOf': { '@id': 'http://example.org/zoo#Animal' } },
      ],
    };
    const { model, format } = await readModelFile(JSON.stringify(doc), 'zoo.jsonld');
    expect(format).toBe('jsonld');
    expect(model).toMatchObject({ name: 'Zoo', baseIri: 'http://example.org/zoo#', ontologyIri: 'http://example.org/zoo' });
    expect(names(model)).toEqual(['Animal', 'Lion']);
    expect(model.relations).toMatchObject([{ kind: 'generalization' }]);
    expect(model.prefixes).toEqual([{ prefix: 'zoo', iri: 'http://example.org/zoo-terms/' }]);
  });

  it('reads back what the app itself exports as JSON-LD', async () => {
    const sample = withIris(sampleModel());
    const back = (await readModelFile(toJsonLd(sample), 'film.jsonld')).model;
    expect(names(back)).toEqual(names(fromTurtle(toTurtle(sample))));
    expect(back.relations.length).toBe(fromTurtle(toTurtle(sample)).relations.length);
  });

  it('does not fetch a context from elsewhere, and says so', async () => {
    await expect(readModelFile('{ "@context": "https://schema.org/", "@id": "http://example.org/a" }', 'remote.jsonld')).rejects.toThrow('It takes its context from https://schema.org/, which is not fetched.');
    await expect(readModelFile('{ "@context": {', 'cut.jsonld')).rejects.toThrow(/^It is not well-formed JSON: /);
  });
});

describe('the syntaxes that are OWL\'s own', () => {
  const FUNCTIONAL = 'Prefix(:=<http://example.org/o#>)\nOntology(<http://example.org/o>\nDeclaration(Class(:A))\n)';
  const answering = (status: number, body: unknown) => {
    const calls: { url: string; body: { document: string; name: string } }[] = [];
    const ask = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { ask, calls };
  };

  it('are converted by the local OWL service, which is sent the document and nothing else', async () => {
    const turtle = '@prefix : <http://example.org/o#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<http://example.org/o> a owl:Ontology .\n:A a owl:Class .\n:B a owl:Class ; <http://www.w3.org/2000/01/rdf-schema#subClassOf> :A .';
    const { ask, calls } = answering(200, { turtle, format: 'OWL Functional Syntax', errors: [] });
    const { model, format } = await readModelFile(FUNCTIONAL, 'o.ofn', { serviceUrl: 'http://localhost:5190/', fetch: ask });
    expect(format).toBe('functional');
    expect(names(model)).toEqual(['A', 'B']);
    expect(model.baseIri).toBe('http://example.org/o#');
    expect(calls).toEqual([{ url: 'http://localhost:5190/convert', body: { document: FUNCTIONAL, name: 'o.ofn' } }]);
  });

  it('are refused without the service, saying how to start it and what to save the ontology as instead', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(readModelFile(FUNCTIONAL, 'o.owl', { serviceUrl: 'http://localhost:5190', fetch: down })).rejects.toThrow(
      'It is in OWL functional syntax, which is not RDF: the app reads it through its local OWL service, and none answers at http://localhost:5190. Start it with “pnpm reasoner” and open the file again, or save the ontology as RDF/XML or Turtle (in Protégé: File → Save as…) and open that.',
    );
    await expect(asTurtle('Prefix: : <http://example.org/o#>\nOntology: <http://example.org/o>', { fetch: down })).rejects.toThrow(/^It is in OWL Manchester syntax, which is not RDF.*none answers at http:\/\/localhost:5190\./);
  });

  it('pass on what the service says is wrong with the document, and know a service too old to convert', async () => {
    await expect(convertWithService(FUNCTIONAL, 'functional', { fetch: answering(422, { errors: ['It could not be read as OWL Functional Syntax: Encountered "<EOF>" at line 3.'] }).ask })).rejects.toThrow('It could not be read as OWL Functional Syntax: Encountered "<EOF>" at line 3.');
    await expect(convertWithService(FUNCTIONAL, 'functional', { fetch: answering(404, '<h1>404 Not Found</h1>').ask })).rejects.toThrow('The OWL service at http://localhost:5190 is an older one that cannot convert files. Stop it and start it again with “pnpm reasoner”.');
    await expect(convertWithService(FUNCTIONAL, 'functional', { serviceUrl: 'http://localhost:9', fetch: answering(200, 'hello').ask })).rejects.toThrow('What answered at http://localhost:9 is not the OWL service (HTTP 200).');
  });
});

describe('what a file states that the model has no place for', () => {
  const EXTRAS = `@prefix : <http://example.org/o#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix swrl: <http://www.w3.org/2003/11/swrl#> .
<http://example.org/o> a owl:Ontology .
:A a owl:Class . :B a owl:Class ; rdfs:subClassOf :A . :C a owl:Class ; owl:hasKey ( :p ) .
:p a owl:ObjectProperty . :q a owl:ObjectProperty ; owl:propertyChainAxiom ( :p :p ) . :r a owl:ObjectProperty ; owl:propertyChainAxiom ( :q :p ) .
[] a owl:Axiom ; owl:annotatedSource :B ; owl:annotatedProperty rdfs:subClassOf ; owl:annotatedTarget :A ; rdfs:comment "because" .
[] a swrl:Imp ; swrl:body rdf:nil ; swrl:head rdf:nil .
[] a owl:AllDisjointClasses ; owl:members ( :A :C ) .
`;

  it('is counted, so that whoever opens the file is told what was left out', async () => {
    expect(leftOut(EXTRAS)).toEqual(['1 key', '2 property chains', '1 annotation on an axiom', '1 SWRL rule']);
    const { model, leftOut: said } = await readModelFile(EXTRAS, 'extras.ttl');
    expect(said).toEqual(['1 key', '2 property chains', '1 annotation on an axiom', '1 SWRL rule']);
    // And they are indeed not in what the model writes, while what it does have a place for is.
    const written = toTurtle(model);
    expect(written).not.toMatch(/hasKey|propertyChainAxiom|"because"|swrl:Imp/);
    expect(written).toContain('owl:disjointWith');
    expect(written).toContain('rdfs:subClassOf :A');
  });

  it('is nothing for an ontology the model holds all of', async () => {
    expect(leftOut(toTurtle(withIris(universitySample())))).toEqual([]);
    expect((await readModelFile(PIZZA, 'pizza.owl')).leftOut).toEqual([]);
    expect(leftOut('this is not Turtle {')).toEqual([]);
  });
});

describe('what else reads an ontology', () => {
  it('takes any syntax as Turtle, and refuses the app\'s own JSON, which is no RDF', async () => {
    expect(await asTurtle(':A a :B .', { name: 'x.ttl' })).toEqual({ turtle: ':A a :B .', format: 'turtle' });
    const { turtle, format } = await asTurtle(PIZZA, { name: 'pizza.owl' });
    expect(format).toBe('rdfxml');
    expect(turtle.startsWith('@prefix : <http://example.org/pizza#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .')).toBe(true);
    // An ontology added for reuse is kept as that Turtle, and read from it.
    const summary = readExternal(turtle, 'pizza.owl', 'file');
    expect(summary.ref).toMatchObject({ name: 'Pizza ontology', iri: 'http://example.org/pizza', namespace: 'http://example.org/pizza#', classes: 5, objectProperties: 1, dataProperties: 1, individuals: 1 });
    expect(() => readExternal(PIZZA, 'pizza.owl', 'file')).toThrow('This is RDF/XML, which has to be converted to Turtle before it is read here.');
    await expect(asTurtle(JSON.stringify(sampleModel()), { name: 'film.json' })).rejects.toThrow('It is a ConceptWeaver model (JSON), not an ontology in RDF.');
  });

  it('opens the app\'s own JSON as it always did', async () => {
    const sample = sampleModel();
    const { model, format } = await readModelFile(JSON.stringify(sample), 'film.json');
    expect(format).toBe('model');
    expect(model.terms.map((t) => t.name)).toEqual(sample.terms.map((t) => t.name));
  });

  it('fetches an ontology asking for the syntaxes it reads, and says why when it cannot', async () => {
    const seen: RequestInit[] = [];
    const ok = (async (_url: string, init?: RequestInit) => {
      seen.push(init!);
      return new Response(PIZZA, { status: 200, headers: { 'Content-Type': 'application/rdf+xml' } });
    }) as typeof fetch;
    expect(await fetchDocument(' https://example.org/pizza.owl ', ok)).toEqual({ text: PIZZA, contentType: 'application/rdf+xml' });
    expect((seen[0].headers as Record<string, string>).Accept).toBe(ACCEPT);
    expect(ACCEPT.startsWith('text/turtle, application/rdf+xml')).toBe(true);
    // Short and plain enough for a browser to send to another site without asking it first.
    expect(ACCEPT.length).toBeLessThanOrEqual(128);
    expect(ACCEPT).not.toMatch(/["():<>?@[\\\]{}]/);
    await expect(fetchDocument('https://example.org/gone', (async () => new Response('', { status: 404, statusText: 'Not Found' })) as typeof fetch)).rejects.toThrow('The server answered 404 Not Found.');
    await expect(
      fetchDocument('https://example.org/blocked', (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch),
    ).rejects.toThrow(/could not be fetched from the browser. The server may not allow requests from other sites \(CORS\)/);
    await expect(fetchDocument('pizza.owl', ok)).rejects.toThrow('An address starts with http:// or https://.');
  });
});
