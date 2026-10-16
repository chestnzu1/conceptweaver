import { describe, expect, it } from 'vitest';
import { withIris } from './iri';
import { toTurtle } from './rdf';
import { asTurtle } from './rdfFormats';
import { rdfXmlOf } from './rdfxml';
import { sampleModel } from './sample';
import { statementsOf } from './unmapped';

/** RDF/XML written in the page (roadmap task 2.5, FR-M11-2): the same statements as the Turtle it is written from. */

const same = async (turtle: string) => {
  const xml = rdfXmlOf(turtle);
  const { turtle: back, format } = await asTurtle(xml, { name: 'export.owl' });
  expect(format).toBe('rdfxml');
  const a = statementsOf(turtle).map((s) => s.text).sort();
  const b = statementsOf(back).map((s) => s.text).sort();
  return { xml, lost: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)) };
};

describe('RDF/XML', () => {
  it('states what the Turtle of a model states, statement for statement', async () => {
    const { xml, lost, added } = await same(toTurtle(withIris(sampleModel())));
    expect(lost).toEqual([]);
    expect(added).toEqual([]);
    // The Turtle's prefixes are its namespaces: the model's own is the default one.
    expect(xml).toContain('xmlns="http://example.org/film-knowledge-graph#"');
    expect(xml).toContain('xmlns:owl="http://www.w3.org/2002/07/owl#"');
    expect(xml).toMatch(/<rdf:Description rdf:about="http:\/\/example.org\/film-knowledge-graph#Film">\n {4}<rdf:type rdf:resource="http:\/\/www.w3.org\/2002\/07\/owl#Class"\/>/);
  });

  it('keeps literals as written, escapes what XML must, and names blank nodes and namespaces it was not given', async () => {
    const turtle = `@prefix : <http://example.org/x#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:A a owl:Class ; rdfs:label "A & B <c>"@en , "line\\nbreak \\"quoted\\"" ;
  rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :p ; owl:someValuesFrom [ owl:unionOf ( :B :C ) ] ] ;
  :price "9.50"^^xsd:decimal ;
  <http://other.example/vocab/term1> "x" ;
  <urn:x:p7> "y" .`;
    const { xml, lost, added } = await same(turtle);
    expect(lost).toEqual([]);
    expect(added).toEqual([]);
    expect(xml).toContain('<price rdf:datatype="http://www.w3.org/2001/XMLSchema#decimal">9.50</price>');
    expect(xml).toContain('<rdfs:label xml:lang="en">A &amp; B &lt;c&gt;</rdfs:label>');
    expect(xml).toMatch(/xmlns:ns1="http:\/\/other.example\/vocab\/"/);
    // A property whose IRI ends in a name XML does not allow is cut where one begins.
    expect(xml).toContain('xmlns:ns2="urn:x:"');
    expect(xml).toContain('<ns2:p7>y</ns2:p7>');
  });

  it('refuses a property it cannot name, and says why', () => {
    expect(() => rdfXmlOf('<http://e.org/a> <http://e.org/p/> "x" .')).toThrow(/cannot be written as RDF\/XML/);
  });
});
