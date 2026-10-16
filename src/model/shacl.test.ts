import fs from 'node:fs';
import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';
import { shaclBase, shaclFile, shaclFiles, shaclTests } from '../../corpus/shacl.mjs';
import { isPropertyShape, pathToSparql, readShapes, SH, shapeSetTurtle, sparqlToPath, termFromText, termToText, type ShaclValue, type Shape } from './shacl';
import { statements, type Quad } from './unmapped';

/**
 * Shapes held as structure (roadmap stage SH-1): every construct of SHACL 1.0 Core read as what it
 * is, and written back with nothing lost, checked statement for statement.
 */

const P = `@prefix ex: <http://example.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;
const texts = (ttl: string, base?: string) => statements(new Parser(base ? { baseIRI: base } : {}).parse(ttl) as unknown as Quad[]).map((s) => s.text).sort();
/** Read and written back: the statements that are not there any more, and those that were not there. */
const roundTrip = (ttl: string, base?: string) => {
  const read = readShapes(ttl, base);
  const back = shapeSetTurtle(read);
  const a = texts(ttl, base);
  const b = texts(back);
  return { read, back, lost: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)) };
};
const shapeNamed = (shapes: Shape[], iri: string) => shapes.find((s) => s.iri === 'http://example.org/' + iri)!;

describe('a shapes graph read as structure', () => {
  it('holds each shape, named or not, with what is said of it', () => {
    const { read, lost, added } = roundTrip(`${P}
ex:PersonShape a sh:NodeShape ; rdfs:label "Person" ; sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ; sh:datatype xsd:string ; sh:message "A name"@en ] ;
  sh:property ex:AgeShape .
ex:AgeShape a sh:PropertyShape ; sh:path ex:age ; sh:maxCount 1 ; sh:minInclusive 0 .`);
    expect(lost).toEqual([]);
    expect(added).toEqual([]);
    // Two named shapes, and the property shape inside the first.
    expect(read.shapes).toHaveLength(3);
    const person = shapeNamed(read.shapes, 'PersonShape');
    const inline = person.props.find((x) => x.p === SH + 'property' && 'shape' in x.v)!.v as { shape: string };
    expect(isPropertyShape(read.shapes.find((s) => s.id === inline.shape)!)).toBe(true);
    // A named shape is referred to by its IRI.
    expect(person.props.some((x) => x.p === SH + 'property' && 'iri' in x.v && x.v.iri === 'http://example.org/AgeShape')).toBe(true);
    expect(read.extra).toBe('');
  });

  it('holds the logical constraints, qualified value shapes, property pairs and closed shapes as structure', () => {
    const { read, lost, added } = roundTrip(`${P}
ex:S a sh:NodeShape ; sh:targetNode ex:a , "lit" ;
  sh:or ( [ sh:path ex:p ; sh:minCount 1 ] ex:Named [ sh:class ex:C ] ) ;
  sh:xone ( [ sh:datatype xsd:integer ] [ sh:datatype xsd:string ] ) ;
  sh:not [ sh:hasValue ex:b ] ;
  sh:closed true ; sh:ignoredProperties ( rdf:type ex:q ) ;
  sh:property [ sh:path ex:start ; sh:lessThan ex:end ; sh:disjoint ex:other ;
    sh:qualifiedValueShape [ sh:class ex:D ] ; sh:qualifiedMinCount 1 ; sh:qualifiedValueShapesDisjoint true ] ;
  sh:in ( ex:x "y" 3 ) ; sh:languageIn ( "en" "nl" ) .`);
    expect(lost).toEqual([]);
    expect(added).toEqual([]);
    const s = shapeNamed(read.shapes, 'S');
    const or = s.props.find((x) => x.p === SH + 'or')!.v as { list: ShaclValue[] };
    expect(or.list.map((v) => Object.keys(v)[0])).toEqual(['shape', 'iri', 'shape']);
    expect(s.props.find((x) => x.p === SH + 'in')!.v).toEqual({ list: [{ iri: 'http://example.org/x' }, { lit: 'y' }, { lit: '3', dt: 'http://www.w3.org/2001/XMLSchema#integer' }] });
    // Nothing is kept as text: all of it is SHACL Core.
    expect(read.shapes.every((x) => x.props.every((p) => !('ttl' in p.v) && !('blank' in p.v)))).toBe(true);
    expect(read.extra).toBe('');
  });

  it('holds every kind of property path, and writes it as SPARQL does for the form', () => {
    const { read, lost, added } = roundTrip(`${P}
ex:S sh:targetClass ex:C ;
  sh:property [ sh:path ( ex:a [ sh:inversePath ex:b ] ) ] ;
  sh:property [ sh:path [ sh:alternativePath ( ex:a ex:b ) ] ] ;
  sh:property [ sh:path [ sh:zeroOrMorePath [ sh:inversePath ex:a ] ] ] ;
  sh:property [ sh:path [ sh:oneOrMorePath ex:a ] ] ;
  sh:property [ sh:path [ sh:zeroOrOnePath ( ex:a ex:b ) ] ] .`);
    expect(lost).toEqual([]);
    expect(added).toEqual([]);
    const name = (iri: string) => 'ex:' + iri.slice('http://example.org/'.length);
    const paths = read.shapes.filter(isPropertyShape).map((s) => pathToSparql((s.props[0].v as { path: never }).path, name));
    expect(paths).toEqual(['ex:a / ^ex:b', 'ex:a | ex:b', '(^ex:a)*', 'ex:a+', '(ex:a / ex:b)?']);
    // And read back from SPARQL as the same paths.
    const resolve = (n: string) => (n.startsWith('ex:') ? 'http://example.org/' + n.slice(3) : undefined);
    for (const s of read.shapes.filter(isPropertyShape)) {
      const p = (s.props[0].v as { path: never }).path;
      expect(sparqlToPath(pathToSparql(p, name), resolve)).toEqual(p);
    }
    expect(() => sparqlToPath('ex:a / (ex:b', resolve)).toThrow('A closing ) is missing.');
    expect(() => sparqlToPath('ex:a nope', resolve)).toThrow(/Nothing more was expected/);
  });

  it('keeps what is about no shape as written, and a shape it points at stays the same node', () => {
    const { read, lost, added } = roundTrip(`${P}
ex:Group a sh:PropertyGroup ; rdfs:label "Details" ; sh:order 1 .
ex:alice a ex:Person ; ex:name "Alice" .
ex:S a sh:NodeShape ; sh:property _:p .
_:p sh:path ex:name ; sh:group ex:Group .
ex:report sh:sourceShape _:p .`);
    expect(lost).toEqual([]);
    expect(added).toEqual([]);
    expect(read.extra).toContain('ex:Group');
    expect(read.extra).toContain('ex:alice');
    // The anonymous property shape is pointed at from what is kept: it is written with the label it is known by there.
    const p = read.shapes.find((s) => !s.iri)!;
    expect(read.extra).toContain('_:' + p.id);
  });

  it('keeps a structure of its own that is no shape as written, in place', () => {
    const { read, lost, added } = roundTrip(`${P}
ex:S sh:targetClass ex:C ; sh:sparql [ sh:select "SELECT $this WHERE { }" ; sh:message "x" ] ; rdfs:seeAlso [ ex:a ex:b ] .`);
    expect(lost).toEqual([]);
    expect(added).toEqual([]);
    expect(shapeNamed(read.shapes, 'S').props.filter((x) => 'ttl' in x.v)).toHaveLength(2);
  });
});

describe('a term as the form writes it', () => {
  const resolve = (n: string) => (n === 'xsd:date' ? 'http://www.w3.org/2001/XMLSchema#date' : n === 'Person' ? 'http://example.org/Person' : undefined);
  const name = (iri: string) => (iri.endsWith('#date') ? 'xsd:date' : iri.endsWith('Person') ? 'Person' : `<${iri}>`);
  it('reads names, IRIs and literals, and writes them back the same', () => {
    for (const text of ['Person', '<http://example.org/x>', '"text"', '"chat"@fr', '"2020-01-01"^^xsd:date', '18', '-1.5', 'true', '"a \\"quote\\""']) expect(termToText(termFromText(text, resolve), name)).toBe(text);
    expect(() => termFromText('Nobody', resolve)).toThrow(/neither a name this model knows/);
  });
});

/** The W3C SHACL 1.0 Core test suite (corpus/shacl.mjs, fetched by pnpm corpus): its shapes, held without loss. */
describe.skipIf(!shaclFiles().length)('the W3C SHACL Core test suite', () => {
  // Each test's shapes graph: the file itself, or the file it names.
  const graphs = [...new Set(shaclTests().map((f) => {
    const text = fs.readFileSync(shaclFile(f), 'utf8');
    const named = /sht:shapesGraph\s+<([^>]+)>/.exec(text)?.[1];
    return named ? f.replace(/[^/]*$/, named) : f;
  }))];

  it('is here: the tests and the graphs they name', () => {
    expect(shaclTests().length).toBeGreaterThan(100);
    expect(graphs.length).toBeGreaterThan(90);
  });

  it('reads every shapes graph, each shape as structure, and writes it back statement for statement', () => {
    const problems: string[] = [];
    let shapes = 0;
    for (const file of graphs) {
      const text = fs.readFileSync(shaclFile(file), 'utf8');
      const { read, lost, added } = roundTrip(text, shaclBase(file));
      shapes += read.shapes.length;
      if (lost.length || added.length) problems.push(`${file}: ${lost.length} lost, ${added.length} added: ${(lost[0] ?? added[0]).slice(0, 200)}`);
      // Nothing of SHACL Core is kept as text: only what is about no shape, SHACL-SPARQL, and the
      // two paths the suite makes ill-formed on purpose (a list that is also an inverse path).
      for (const s of read.shapes) for (const x of s.props) if (('ttl' in x.v || 'blank' in x.v) && x.p !== SH + 'sparql' && !(x.p === SH + 'path' && /path-strange-00[12]/.test(file))) problems.push(`${file}: <${x.p}> of ${s.iri ?? 'a blank shape'} kept as text`);
    }
    expect(problems).toEqual([]);
    expect(shapes).toBeGreaterThan(300);
  });
});
