import { propDatatype } from './domains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { readModelFile } from './files';
import { relChoice, restrictionsOf } from './props';
import { convertWithService } from './rdfFormats';
import type { Model } from './types';

/**
 * The syntaxes that are OWL's own and no RDF, read for real: these start the local OWL service,
 * which has the OWL API, and give it documents to turn into Turtle. They need Java and the
 * service's libraries, and are skipped, saying so, on a machine that has neither.
 */
const why = unavailable();
if (why) console.warn(`OWL syntax tests skipped: ${why}`);

const FUNCTIONAL = `Prefix(:=<http://example.org/pizza#>)
Prefix(owl:=<http://www.w3.org/2002/07/owl#>)
Prefix(rdfs:=<http://www.w3.org/2000/01/rdf-schema#>)
Prefix(xsd:=<http://www.w3.org/2001/XMLSchema#>)
Prefix(food:=<http://example.org/food#>)

Ontology(<http://example.org/pizza>
Import(<http://example.org/food>)
Annotation(rdfs:label "Pizza ontology"@en)

Declaration(Class(:Pizza))
Declaration(Class(:Topping))
Declaration(Class(:Tomato))
Declaration(Class(:Margherita))
Declaration(ObjectProperty(:hasTopping))
Declaration(DataProperty(:price))
Declaration(NamedIndividual(:MyLunch))

AnnotationAssertion(rdfs:label :Pizza "Pizza"@en)
AnnotationAssertion(rdfs:label :Topping "Topping"@en)
AnnotationAssertion(rdfs:label :Tomato "Tomato"@en)
AnnotationAssertion(rdfs:label :Margherita "Margherita"@en)
AnnotationAssertion(rdfs:label :hasTopping "has topping"@en)
AnnotationAssertion(rdfs:label :price "price"@en)
AnnotationAssertion(rdfs:label :MyLunch "My lunch"@en)
SubClassOf(:Tomato :Topping)
SubClassOf(:Margherita :Pizza)
SubClassOf(:Margherita ObjectSomeValuesFrom(:hasTopping :Tomato))
DisjointClasses(:Pizza :Topping)
TransitiveObjectProperty(:hasTopping)
ObjectPropertyDomain(:hasTopping :Pizza)
ObjectPropertyRange(:hasTopping :Topping)
FunctionalDataProperty(:price)
DataPropertyRange(:price xsd:decimal)
ClassAssertion(:Margherita :MyLunch)
DataPropertyAssertion(:price :MyLunch "9.50"^^xsd:decimal)
)`;

const MANCHESTER = `Prefix: : <http://example.org/pizza#>
Prefix: owl: <http://www.w3.org/2002/07/owl#>
Prefix: rdfs: <http://www.w3.org/2000/01/rdf-schema#>
Prefix: xsd: <http://www.w3.org/2001/XMLSchema#>

Ontology: <http://example.org/pizza>
Annotations: rdfs:label "Pizza ontology"@en

ObjectProperty: hasTopping
    Annotations: rdfs:label "has topping"@en
    Characteristics: Transitive
    Domain: Pizza
    Range: Topping

DataProperty: price
    Annotations: rdfs:label "price"@en
    Characteristics: Functional
    Range: xsd:decimal

Class: Pizza
    Annotations: rdfs:label "Pizza"@en

Class: Topping
    Annotations: rdfs:label "Topping"@en

Class: Tomato
    Annotations: rdfs:label "Tomato"@en
    SubClassOf: Topping

Class: Margherita
    Annotations: rdfs:label "Margherita"@en
    SubClassOf: Pizza, hasTopping some Tomato

Individual: MyLunch
    Annotations: rdfs:label "My lunch"@en
    Types: Margherita
    Facts: price "9.50"^^xsd:decimal
`;

const OWLXML = `<?xml version="1.0"?>
<Ontology xmlns="http://www.w3.org/2002/07/owl#" xml:base="http://example.org/pizza" ontologyIRI="http://example.org/pizza">
    <Prefix name="" IRI="http://example.org/pizza#"/>
    <Prefix name="rdfs" IRI="http://www.w3.org/2000/01/rdf-schema#"/>
    <Prefix name="xsd" IRI="http://www.w3.org/2001/XMLSchema#"/>
    <Annotation><AnnotationProperty abbreviatedIRI="rdfs:label"/><Literal xml:lang="en">Pizza ontology</Literal></Annotation>
    <Declaration><Class IRI="#Pizza"/></Declaration>
    <Declaration><Class IRI="#Topping"/></Declaration>
    <Declaration><Class IRI="#Tomato"/></Declaration>
    <Declaration><Class IRI="#Margherita"/></Declaration>
    <Declaration><ObjectProperty IRI="#hasTopping"/></Declaration>
    <Declaration><DataProperty IRI="#price"/></Declaration>
    <Declaration><NamedIndividual IRI="#MyLunch"/></Declaration>
    <SubClassOf><Class IRI="#Tomato"/><Class IRI="#Topping"/></SubClassOf>
    <SubClassOf><Class IRI="#Margherita"/><Class IRI="#Pizza"/></SubClassOf>
    <SubClassOf><Class IRI="#Margherita"/><ObjectSomeValuesFrom><ObjectProperty IRI="#hasTopping"/><Class IRI="#Tomato"/></ObjectSomeValuesFrom></SubClassOf>
    <TransitiveObjectProperty><ObjectProperty IRI="#hasTopping"/></TransitiveObjectProperty>
    <ObjectPropertyDomain><ObjectProperty IRI="#hasTopping"/><Class IRI="#Pizza"/></ObjectPropertyDomain>
    <ObjectPropertyRange><ObjectProperty IRI="#hasTopping"/><Class IRI="#Topping"/></ObjectPropertyRange>
    <FunctionalDataProperty><DataProperty IRI="#price"/></FunctionalDataProperty>
    <DataPropertyRange><DataProperty IRI="#price"/><Datatype abbreviatedIRI="xsd:decimal"/></DataPropertyRange>
    <ClassAssertion><Class IRI="#Margherita"/><NamedIndividual IRI="#MyLunch"/></ClassAssertion>
    <DataPropertyAssertion><DataProperty IRI="#price"/><NamedIndividual IRI="#MyLunch"/><Literal datatypeIRI="http://www.w3.org/2001/XMLSchema#decimal">9.50</Literal></DataPropertyAssertion>
    <AnnotationAssertion><AnnotationProperty abbreviatedIRI="rdfs:label"/><IRI>#Pizza</IRI><Literal xml:lang="en">Pizza</Literal></AnnotationAssertion>
    <AnnotationAssertion><AnnotationProperty abbreviatedIRI="rdfs:label"/><IRI>#Topping</IRI><Literal xml:lang="en">Topping</Literal></AnnotationAssertion>
    <AnnotationAssertion><AnnotationProperty abbreviatedIRI="rdfs:label"/><IRI>#Tomato</IRI><Literal xml:lang="en">Tomato</Literal></AnnotationAssertion>
    <AnnotationAssertion><AnnotationProperty abbreviatedIRI="rdfs:label"/><IRI>#Margherita</IRI><Literal xml:lang="en">Margherita</Literal></AnnotationAssertion>
    <AnnotationAssertion><AnnotationProperty abbreviatedIRI="rdfs:label"/><IRI>#hasTopping</IRI><Literal xml:lang="en">has topping</Literal></AnnotationAssertion>
    <AnnotationAssertion><AnnotationProperty abbreviatedIRI="rdfs:label"/><IRI>#price</IRI><Literal xml:lang="en">price</Literal></AnnotationAssertion>
    <AnnotationAssertion><AnnotationProperty abbreviatedIRI="rdfs:label"/><IRI>#MyLunch</IRI><Literal xml:lang="en">My lunch</Literal></AnnotationAssertion>
</Ontology>`;

const OBO = `format-version: 1.2
ontology: pizza

[Term]
id: PZ:0000001
name: pizza

[Term]
id: PZ:0000002
name: margherita
def: "A pizza with tomato and mozzarella." []
synonym: "pizza margherita" EXACT []
is_a: PZ:0000001 ! pizza
`;

const names = (m: Model) => m.terms.map((t) => t.name).sort();
const term = (m: Model, name: string) => m.terms.find((t) => t.name === name)!;

describe.skipIf(!!why)('ontologies in the syntaxes that are OWL\'s own', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  beforeAll(async () => {
    service = await startReasoner({ port: 5196, quiet: true, log: () => {} });
  }, 120_000);
  afterAll(async () => {
    await service?.stop();
  });
  const open = (text: string, name: string) => readModelFile(text, name, { serviceUrl: service.url });

  it('has a service that says it converts', () => {
    expect(service.health).toMatchObject({ service: 'conceptweaver-reasoner', converts: true });
  });

  for (const [format, name, text] of [
    ['functional', 'pizza.ofn', FUNCTIONAL],
    ['manchester', 'pizza.omn', MANCHESTER],
    ['owlxml', 'pizza.owx', OWLXML],
  ] as const) {
    it(`reads the same ontology from ${format} syntax`, async () => {
      const { model: m, format: read } = await open(text, name);
      expect(read).toBe(format);
      expect(m).toMatchObject({ name: 'Pizza ontology', mode: 'ontology', ontologyIri: 'http://example.org/pizza', baseIri: 'http://example.org/pizza#' });
      expect(names(m)).toEqual(['Margherita', 'My lunch', 'Pizza', 'Tomato', 'Topping', 'price']);
      expect(term(m, 'Margherita').iri).toBe('http://example.org/pizza#Margherita');
      expect(term(m, 'price')).toMatchObject({ type: 'property', functional: true });
      expect(propDatatype(term(m, 'price'))).toBe('xsd:decimal');
      expect(term(m, 'My lunch')).toMatchObject({ type: 'instance', values: [{ prop: term(m, 'price').id, value: '9.50' }] });
      expect(m.props).toMatchObject([{ name: 'has topping', chars: ['transitive'] }]);
      const said = m.relations.map((r) => `${m.terms.find((t) => t.id === r.from)!.name} ${relChoice(m, r)} ${m.terms.find((t) => t.id === r.to)!.name}`);
      expect(said).toEqual(expect.arrayContaining(['Margherita generalization Pizza', 'Tomato generalization Topping', 'My lunch instanceOf Margherita']));
      expect(restrictionsOf(m, term(m, 'Margherita').id).map((r) => `${r.property} ${r.quantifier} ${r.filler}`)).toEqual(['has topping some Tomato']);
    });
  }

  it('records what a document imports without fetching it', async () => {
    const t = performance.now();
    const { model } = await open(FUNCTIONAL, 'pizza.ofn');
    expect(model.externals.map((e) => e.iri)).toEqual(['http://example.org/food']);
    expect(model.prefixes).toEqual([{ prefix: 'food', iri: 'http://example.org/food#' }]);
    // An address nothing answers at would take long to give up on, were it asked.
    expect(performance.now() - t).toBeLessThan(5000);
  });

  it('reads the OBO format', async () => {
    const { model: m, format } = await open(OBO, 'pizza.obo');
    expect(format).toBe('obo');
    expect(names(m)).toEqual(['margherita', 'pizza']);
    expect(term(m, 'margherita').iri).toBe('http://purl.obolibrary.org/obo/PZ_0000002');
    expect(m.relations.map((r) => relChoice(m, r))).toEqual(['generalization']);
  });

  it('says what the OWL API objects to in a document that is not well-formed', async () => {
    await expect(open('Prefix(:=<http://example.org/p#>)\nOntology(<http://example.org/p>\nDeclaration(Class(:A)\n', 'cut.ofn')).rejects.toThrow(/^It could not be read as OWL Functional Syntax: Encountered "<EOF>" at line \d+/);
    await expect(convertWithService('Ontology: <http://example.org/p>\nClass: A\n  SubClassOf: has some', 'manchester', { serviceUrl: service.url })).rejects.toThrow(/^It could not be read as Manchester OWL Syntax: /);
  });
});
